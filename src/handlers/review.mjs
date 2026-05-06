import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { guardCapability } from "../adapters/index.mjs";
import {
  getCodexAuthStatus,
  getCodexAvailability,
  getSessionRuntimeStatus,
} from "../adapters/codex/codex.mjs";
import { buildCollaborationMode, buildSandboxPolicy, COMPLETION_CHECK_SCHEMA, DEFAULT_CONFIG, resolveConfigLayers, resolveConfigSources, validateConfigLayers } from "../lib/config.mjs";
import { CliError, conflictError, emitError, emitSuccess, invalidThreadIdError, notFoundError, usageError, validationError, classifyError } from "../lib/cli-errors.mjs";
import { detectOfficialOpenAICodexPlugin, OFFICIAL_PLUGIN_STATUS } from "../lib/official-plugin.mjs";
import { applyStopReviewGateSnapshot } from "../lib/stop-review-gate.mjs";
import { existsTask, jobDir, listTasks, readMeta, readVerdict, writeBriefArtifacts, writeMeta, writeVerdict } from "../lib/registry.mjs";
import { loadBrief, renderBriefAsMarkdown } from "../lib/brief.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "../lib/process.mjs";
import { getConfig, listJobs, resolveJobFile, setConfig, updateState, upsertJob, writeJobFile } from "../lib/state.mjs";
import { buildSingleJobSnapshot, buildStatusSnapshot, readStoredJob, resolveCancelableJob, resolveResultJob, sortJobsNewestFirst } from "../lib/job-control.mjs";
import { appendLogLine, createJobLogFile, createJobProgressUpdater, nowIso, runTrackedJob } from "../lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { renderCancelReport, renderJobStatusReport, renderSetupReport, renderStatusReport, renderStoredJobResult } from "../lib/render.mjs";
import {
  captureGitDiff,
  findSession,
  formatDoneEvent,
  formatErrorEvent,
  formatIncompleteEvent,
  formatPlanEvent,
  initSession,
  logEvent,
  logNdjson,
  resolveSessionDir,
  TERMINAL_TAG_REGEX,
  writePlan,
} from "../lib/session-log.mjs";
import { readPendingRequestById } from "../lib/pending-requests.mjs";
import { readStdinIfPiped } from "../lib/fs.mjs";
import { mapReviewVerdictToTaskVerdict } from "../lib/review-result.mjs";
import { checkForUpdate, formatUpdateNotice } from "../lib/update-check.mjs";
import { runIterateLoop } from "../lib/iterate-loop.mjs";
import { createSubagentWorktree, ensureGitRepository, mergeSubagentBranch, resolveReviewTarget } from "../lib/git.mjs";
import { isThreadId } from "../lib/thread-id.mjs";
import {
  BRIDGE_CAPABILITIES,
  BRIDGE_SCHEMA_VERSION,
  BRIDGE_VERSION,
  DEFAULT_STATUS_POLL_INTERVAL_MS,
  DEFAULT_STATUS_WAIT_TIMEOUT_MS,
  ROOT_DIR,
  SCRIPT_PATH,
  STOP_REVIEW_GATE_LOCK_FILE,
} from "../lib/runtime-paths.mjs";
import { ensureCodexRuntimeAdapter, getBridgeConfig, loadDeveloperInstructions, resolveCommandAdapter } from "../lib/bridge-config.mjs";
import { bridgeCommand, buildMonitorHint, buildRecovery, extractItemText } from "../lib/envelope-helpers.mjs";
import { COMMANDS, EXIT_CODE_DOC, GLOBAL_FLAGS_DOC } from "../commands-meta.mjs";
import {
  buildReviewJobMetadata,
  buildTaskJob,
  buildTaskRequest,
  buildTaskRunMetadata,
  createBridgeServerRequestHandler,
  createCompanionJob,
  enqueueBackgroundTask,
  ensureCodexAvailable,
  executeReviewRun,
  extractPlanSteps,
  filterJobsForCurrentClaudeSession,
  findLatestResumableTaskJob,
  getCurrentClaudeSessionId,
  parseDurationOption,
  parsePositiveMsOption,
  persistFailureErrorInPayload,
  readTaskPrompt,
  renderQueuedTaskLaunch,
  requireTaskRequest,
  requireTaskReviewContext,
  runBridgeTask,
  runForegroundCommand,
  validateNativeReviewRequest,
  waitForSingleJobSnapshot,
} from "../lib/task-runtime.mjs";
import {
  normalizeReasoningEffort,
  normalizeRequestedModel,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace,
  resolvePromptInput,
} from "../lib/handler-utils.mjs";

export function handleAdversarialReview(argv) {
  return handleReviewCommand(argv, { reviewName: "Adversarial Review" });
}

export async function handleReviewCommand(argv, config) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd", "backend", "brief", "task"],
    repeatableValueOptions: ["concern"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const taskReview = options.task ? requireTaskReviewContext(options.task, options) : null;
  const cwd = taskReview?.cwd ?? resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const adapter = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    backend: options.backend ?? null,
  });
  ensureCodexRuntimeAdapter(adapter);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: taskReview?.base ?? options.base,
    scope: taskReview?.scope ?? options.scope
  });

  // --brief and --concern populate the {{OPUS_CONCERNS}} channel in the
  // adversarial-review prompt (T26). Native `review` ignores them — its
  // prompt is built by the Codex app-server. validateRequest will reject
  // the flags for native review below if the orchestrator passes them.
  let brief = null;
  if (options.brief) {
    const result = loadBrief(options.brief, { baseDir: cwd });
    if (!result.ok) {
      throw new CliError(result.message, {
        code: result.code,
        class: result.code === "BRIEF_FILE_NOT_FOUND" ? "not_found" : "validation",
        details: result.details,
        suggestion: result.code === "BRIEF_SCHEMA_VIOLATION"
          ? "Fix the brief JSON to match the schema. Common valid top-level keys are goal, worker_assignment, specific_concerns, acceptance_criteria, behavior_digest_seed, parent_task_id, backend_hint, iteration_max, and trust_budget_override."
          : undefined,
      });
    }
    brief = result.brief;
  }
  const opusConcerns = Array.isArray(options.concern)
    ? options.concern
    : options.concern
      ? [options.concern]
      : [];

  config.validateRequest?.(target, focusText, { brief, opusConcerns });
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: taskReview?.base ?? options.base,
        scope: taskReview?.scope ?? options.scope,
        model: options.model,
        backend: options.backend ?? null,
        focusText,
        brief,
        opusConcerns,
        reviewName: config.reviewName,
        taskId: taskReview?.taskId ?? null,
        reviewedBranchHeadSha: taskReview?.reviewedBranchHeadSha ?? null,
        onProgress: progress
      }),
    {
      json: options.json,
      startedAt,
      command: config.reviewName === "Adversarial Review" ? "adversarial-review" : "review"
    }
  );
}

export async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

// ── BRIDGE ORCHESTRATION ──────────────────────────────────────────────────
// This is the integration layer that connects all building blocks.
// It wraps executeTaskRun with: config, session logging, question handling,
// timeout, and auto-pipeline.
