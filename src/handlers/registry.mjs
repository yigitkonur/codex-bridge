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
  createTrackedProgress,
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

function readReviewedBranchHeadSha(verdict) {
  const candidates = [
    verdict?.branch_head_sha,
    verdict?.reviewed_branch_head_sha,
    verdict?.branchHeadSha,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim().toLowerCase();
    if (/^[a-f0-9]{40}$/.test(normalized)) {
      return normalized;
    }
  }
  return null;
}

function readCurrentTaskBranchHeadSha(meta, cwd) {
  const branch = meta?.worktree?.branch;
  if (!branch) return null;
  const candidates = [
    meta?.worktree?.path,
    cwd,
  ].filter((candidate, index, all) =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    fs.existsSync(candidate) &&
    all.indexOf(candidate) === index
  );
  for (const candidateCwd of candidates) {
    const result = runCommand("git", ["rev-parse", "--verify", branch], {
      cwd: candidateCwd,
      timeout: 10_000,
    });
    if (result.status !== 0 || result.error) continue;
    const sha = result.stdout.trim().toLowerCase();
    if (/^[a-f0-9]{40}$/.test(sha)) return sha;
  }
  return null;
}

function describeMergeBlocker(blocker) {
  if (blocker === "missing_approval") return "verdict is not approved";
  if (blocker === "missing_branch_sha") return "approved verdict is missing branch_head_sha";
  if (blocker === "missing_branch") return "task metadata is missing worktree.branch";
  if (blocker === "branch_head_unavailable") return "current branch head could not be resolved";
  if (blocker === "head_drift") return "current branch head differs from the approved reviewed head";
  return "merge readiness could not be determined";
}

function nextActionForMergeReadiness(taskId, blocker) {
  if (!blocker) {
    return {
      kind: "merge",
      argv: ["merge", taskId],
      description: "Merge the approved unchanged reviewed branch head.",
    };
  }
  if (blocker === "missing_approval") {
    return {
      kind: "review-or-iterate",
      argv: ["iterate", taskId],
      description: "Continue review or iterate until the task has an approved verdict.",
    };
  }
  if (blocker === "missing_branch_sha" || blocker === "head_drift" || blocker === "branch_head_unavailable") {
    return {
      kind: "rerun-review",
      argv: ["adversarial-review", "--task", taskId, "--json"],
      description: "Rerun task-bound review and record a fresh verdict for the current branch head.",
    };
  }
  return {
    kind: "inspect-task-metadata",
    argv: ["verdict", taskId, "--json"],
    description: "Inspect task metadata before attempting merge.",
  };
}

function buildVerdictMergeReadiness(taskId, verdict, meta, cwd) {
  const reviewedBranchHeadSha = readReviewedBranchHeadSha(verdict);
  const currentBranchHeadSha = readCurrentTaskBranchHeadSha(meta, cwd);
  const blockers = [];
  if (verdict?.verdict !== "approved") {
    blockers.push("missing_approval");
  } else if (!reviewedBranchHeadSha) {
    blockers.push("missing_branch_sha");
  } else if (!meta?.worktree?.branch) {
    blockers.push("missing_branch");
  } else if (!currentBranchHeadSha) {
    blockers.push("branch_head_unavailable");
  } else if (currentBranchHeadSha !== reviewedBranchHeadSha) {
    blockers.push("head_drift");
  }
  const primaryBlocker = blockers[0] ?? null;
  return {
    merge_ready: blockers.length === 0,
    merge_blocked_by: primaryBlocker,
    merge_blockers: blockers,
    merge_block_reason: primaryBlocker ? describeMergeBlocker(primaryBlocker) : null,
    branch: meta?.worktree?.branch ?? null,
    branch_head_sha: reviewedBranchHeadSha,
    reviewed_branch_head_sha: reviewedBranchHeadSha,
    current_branch_head_sha: currentBranchHeadSha,
    next_action: nextActionForMergeReadiness(taskId, primaryBlocker),
  };
}

function buildIterateArtifacts(taskId, execution = null, logFile = null) {
  const dir = jobDir(taskId);
  return {
    registry_dir: dir,
    meta_path: path.join(dir, "meta.json"),
    review_path: path.join(dir, "review.json"),
    verdict_path: path.join(dir, "verdict.json"),
    events_path: execution?.payload?.eventsPath ?? null,
    events_dir: execution?.payload?.eventsDir ?? null,
    log_file: logFile,
  };
}

function isSafeTaskId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    return false;
  }
  return true;
}

function resolveIterateInput(options, positionals, cwd) {
  if (positionals.length === 1) {
    const taskId = positionals[0];
    if (isSafeTaskId(taskId) && existsTask(taskId)) {
      let meta;
      try {
        meta = readMeta(taskId);
      } catch (err) {
        throw validationError(
          `task ${taskId} metadata is unreadable: ${err.message ?? err}`,
          "TASK_META_UNREADABLE",
        );
      }
      if (!meta) {
        throw validationError(
          `task ${taskId} exists but is missing meta.json; restore the task metadata or discard the task before iterating`,
          "TASK_META_MISSING",
        );
      }
      return { taskId, prompt: null, meta };
    }
  }
  return {
    taskId: null,
    prompt: resolvePromptInput(options, positionals, cwd),
    meta: null,
  };
}

function loadIterateBrief(options, cwd) {
  if (!options.brief) return { brief: null, briefHash: null, source: null };
  const result = loadBrief(options.brief, { baseDir: cwd });
  if (!result.ok) {
    throw new CliError(result.message, {
      code: result.code,
      class: result.code === "BRIEF_FILE_NOT_FOUND" ? "not_found" : "validation",
    });
  }
  return {
    brief: result.brief,
    briefHash: result.briefHash,
    source: result.source ?? options.brief,
  };
}

function buildIteratePrompt(prompt, brief) {
  const text = String(prompt ?? "").trim();
  if (!brief?.brief) return text;
  const renderedBrief = renderBriefAsMarkdown(brief.brief);
  return [renderedBrief, text].filter(Boolean).join("\n\n");
}

async function runIterateTaskJob({
  prompt,
  cwd,
  stateCwd,
  workspaceRoot,
  model,
  effort,
  adapter,
  parentTaskId = null,
  iteration = 1,
  worktree = null,
  brief = null,
}) {
  const taskMetadata = buildTaskRunMetadata({ prompt });
  const job = buildTaskJob(workspaceRoot, taskMetadata, true, {
    backend: adapter.name,
    adapterCapabilities: adapter.capabilities(),
  });
  let worktreeInfo = worktree;
  if (!worktreeInfo) {
    worktreeInfo = createSubagentWorktree({
      cwd,
      taskId: job.id,
      backend: adapter.name,
      allowBranchFallback: false,
    });
  }
  if (worktreeInfo.isolation_mode !== "worktree") {
    throw new Error(`iterate requires an isolated worktree, got ${worktreeInfo.isolation_mode}`);
  }
  job.registryTaskId = job.id;
  job.worktree = worktreeInfo;
  job.isolation_mode = worktreeInfo.isolation_mode;
  writeMeta(job.id, {
    backend: adapter.name,
    capabilities: adapter.capabilities(),
    worktree: worktreeInfo,
    isolation_mode: worktreeInfo.isolation_mode,
    base_ref: worktreeInfo.base_ref,
    base_sha: worktreeInfo.base_sha,
    phase: "iterate-running",
    parent_task_id: parentTaskId,
    iteration_index: iteration,
    brief_hash: brief?.briefHash ?? null,
    brief_source: brief?.source ?? null,
  });
  if (brief?.brief) {
    writeBriefArtifacts(job.id, {
      brief: brief.brief,
      rendered: renderBriefAsMarkdown(brief.brief),
      hash: brief.briefHash,
      source: brief.source,
    });
  }

  const taskCwd = worktreeInfo.path;
  const request = buildTaskRequest({
    cwd: taskCwd,
    stateCwd,
    model,
    effort,
    prompt,
    brief: brief?.brief ?? null,
    write: true,
    readOnly: false,
    resumeLast: false,
    jobId: job.id,
    mode: "default",
    noPipeline: true,
    backend: adapter.name,
  });
  const { logFile } = createTrackedProgress(job, { stderr: false });
  const execution = await runTrackedJob(
    job,
    async () =>
      persistFailureErrorInPayload(
        await runBridgeTask({
          ...request,
          onProgress: null,
        }),
        "task",
      ),
    { logFile },
  );

  return {
    task_id: job.id,
    execution,
    worktree: worktreeInfo,
    artifacts: buildIterateArtifacts(job.id, execution, logFile),
  };
}

function createIterateDependencies({ cwd, workspaceRoot, model, effort, adapter, brief }) {
  const stateCwd = cwd;
  const readTaskCompletion = async ({ taskId, startedTask }) => {
    if (startedTask?.execution?.exitStatus && startedTask.execution.exitStatus !== 0) {
      const err = new Error(startedTask.execution.error?.message ?? `task ${taskId} failed`);
      err.code = "ITERATE_TASK_FAILED";
      throw err;
    }
    const storedJob = readStoredJob(workspaceRoot, taskId);
    if (storedJob?.status === "queued" || storedJob?.status === "running") {
      const err = new Error(`task ${taskId} is still ${storedJob.status}; wait for task completion before reviewing`);
      err.code = "ITERATE_TASK_STILL_RUNNING";
      throw err;
    }
    if (storedJob?.status === "failed") {
      const err = new Error(storedJob.errorMessage ?? `task ${taskId} failed`);
      err.code = "ITERATE_TASK_FAILED";
      throw err;
    }
    const meta = readMeta(taskId);
    if (!meta) {
      const err = new Error(`no meta.json found for ${taskId}`);
      err.code = "ITERATE_TASK_META_MISSING";
      throw err;
    }
    return {
      task_id: taskId,
      meta,
      artifacts: buildIterateArtifacts(taskId, startedTask?.execution ?? null, startedTask?.artifacts?.log_file ?? null),
    };
  };

  const runReview = async ({ taskId }) => {
    const taskReview = requireTaskReviewContext(taskId, {});
    const reviewRun = await executeReviewRun({
      cwd: taskReview.cwd,
      base: taskReview.base,
      scope: taskReview.scope,
      model,
      backend: adapter.name,
      reviewName: "Adversarial Review",
      taskId,
      reviewedBranchHeadSha: taskReview.reviewedBranchHeadSha,
    });
    const reviewResult = reviewRun.payload?.review_result ?? null;
    if (reviewRun.exitStatus !== 0 || !reviewResult) {
      const err = new Error(reviewRun.error?.message ?? reviewRun.payload?.parseError ?? `review failed for ${taskId}`);
      err.code = "ITERATE_REVIEW_FAILED";
      throw err;
    }
    return {
      review_result: reviewResult,
      thread_id: reviewRun.threadId ?? null,
      artifacts: buildIterateArtifacts(taskId),
    };
  };

  const writeIterateVerdict = async ({ taskId, reviewResult }) => {
    const verdict = mapReviewVerdictToTaskVerdict(reviewResult);
    const reviewedHead = reviewResult?.reviewed_branch_head_sha ?? reviewResult?.branch_head_sha ?? null;
    writeVerdict(taskId, {
      ...reviewResult,
      verdict,
      reviewer: "codex-bridge-iterate",
      ...(reviewedHead ? { branch_head_sha: reviewedHead, reviewed_branch_head_sha: reviewedHead } : {}),
    });
    return {
      verdict: readVerdict(taskId),
      artifacts: buildIterateArtifacts(taskId),
    };
  };

  const startFollowup = async ({ previousTaskId, iteration, prompt }) => {
    const meta = readMeta(previousTaskId);
    if (!meta?.worktree?.path || !meta?.worktree?.branch) {
      const err = new Error(`task ${previousTaskId} is missing worktree metadata for follow-up`);
      err.code = "ITERATE_FOLLOWUP_META_MISSING";
      throw err;
    }
    return runIterateTaskJob({
      prompt,
      cwd: meta.worktree.path,
      stateCwd,
      workspaceRoot,
      model,
      effort,
      adapter,
      parentTaskId: previousTaskId,
      iteration,
      worktree: meta.worktree,
      brief,
    });
  };

  const markSuperseded = async ({ taskId, nextTaskId, iteration, verdict }) => {
    const supersededAt = nowIso();
    const reason = "iterate-followup";
    const existingVerdict = readVerdict(taskId);
    if (existingVerdict) {
      writeVerdict(taskId, {
        ...existingVerdict,
        superseded_by: nextTaskId,
        superseded_at: supersededAt,
        superseded_reason: reason,
        superseded_iteration: iteration + 1,
      });
    }
    const meta = readMeta(taskId);
    if (meta) {
      writeMeta(taskId, {
        ...meta,
        phase: "superseded",
        superseded_by: nextTaskId,
        superseded_at: supersededAt,
        superseded_reason: reason,
        superseded_verdict: verdict,
      });
    }
    return {
      superseded_by: nextTaskId,
      artifacts: buildIterateArtifacts(taskId),
    };
  };

  return {
    startTask: ({ prompt, iteration }) =>
      runIterateTaskJob({
        prompt,
        cwd,
        stateCwd,
        workspaceRoot,
        model,
        effort,
        adapter,
        iteration,
        brief,
      }),
    readTaskCompletion,
    runReview,
    writeVerdict: writeIterateVerdict,
    startFollowup,
    markSuperseded,
  };
}

// iterate <prompt|task_id> — closed-loop dispatcher that runs task →
// review → verdict and re-dispatches on needs-attention/must-fix until either
// approved or iteration_max is hit.
export async function handleIterate(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["max", "brief", "backend", "cwd", "prompt-file", "model", "effort"],
    booleanOptions: ["json", "write"],
    aliasMap: { m: "model" },
  });
  const max = options.max ? Number.parseInt(options.max, 10) : 3;
  if (!Number.isInteger(max) || max < 1 || max > 10) {
    throw usageError(`--max must be an integer between 1 and 10 (got ${JSON.stringify(options.max)})`);
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const input = resolveIterateInput(options, positionals, cwd);
  const brief = loadIterateBrief(options, cwd);
  const prompt = input.taskId ? null : buildIteratePrompt(input.prompt, brief);
  if (!input.taskId && !prompt) {
    throw validationError("iterate requires a task_id, prompt, prompt file, or piped stdin", "MISSING_PROMPT");
  }
  const adapter = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    backend: options.backend ?? null,
  });
  ensureCodexRuntimeAdapter(adapter);
  guardCapability(adapter, "supports_worktree");
  guardCapability(adapter, "supports_artifact_registry");
  guardCapability(adapter, "supports_adversarial_review");
  ensureCodexAvailable(cwd);
  if (!input.taskId) ensureGitRepository(cwd);
  const config = getBridgeConfig(cwd, workspaceRoot);
  const model = normalizeRequestedModel(options.model ?? config.model);
  const effort = normalizeReasoningEffort(options.effort ?? config.effort);
  const payload = await runIterateLoop({
    max,
    taskId: input.taskId,
    prompt,
    deps: createIterateDependencies({
      cwd,
      workspaceRoot,
      model,
      effort,
      adapter,
      brief,
    }),
  });
  emitSuccess(
    "iterate",
    payload,
    `iterate ${payload.status} after ${payload.iterations?.length ?? 0}/${max} iteration(s).\n`,
    { json: options.json, startedAt },
  );
}

const VERDICT_VALUES = new Set(["approved", "needs-attention", "must-fix"]);

function validateVerdictValue(verdict, optionName = "--set") {
  if (!VERDICT_VALUES.has(verdict)) {
    throw usageError(
      `${optionName} must be one of approved | needs-attention | must-fix (got ${JSON.stringify(verdict)})`,
    );
  }
}

function readVerdictPayloadFromStdin() {
  const raw = readStdinIfPiped().trim();
  if (!raw) {
    throw usageError("--payload-stdin requires a JSON object on stdin");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw usageError(`--payload-stdin must be valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError("--payload-stdin must be a JSON object");
  }
  validateVerdictValue(parsed.verdict, "payload.verdict");
  if (parsed.findings != null && !Array.isArray(parsed.findings)) {
    throw usageError("payload.findings must be an array when provided");
  }
  const reviewedBranchHeadSha =
    parsed.branch_head_sha ??
    parsed.reviewed_branch_head_sha ??
    parsed.branchHeadSha ??
    null;
  if (
    reviewedBranchHeadSha != null &&
    (typeof reviewedBranchHeadSha !== "string" || !/^[0-9a-f]{40}$/i.test(reviewedBranchHeadSha.trim()))
  ) {
    throw usageError("payload.reviewed_branch_head_sha must be a 40-character hex SHA when provided");
  }
  const normalizedBranchHeadSha =
    typeof reviewedBranchHeadSha === "string" ? reviewedBranchHeadSha.trim().toLowerCase() : null;
  return {
    ...parsed,
    verdict: parsed.verdict,
    summary: typeof parsed.summary === "string" ? parsed.summary : null,
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    reviewer: typeof parsed.reviewer === "string" ? parsed.reviewer : null,
    ...(normalizedBranchHeadSha
      ? {
          branch_head_sha: normalizedBranchHeadSha,
          reviewed_branch_head_sha: normalizedBranchHeadSha,
        }
      : {}),
  };
}

// verdict <task_id> — read or write the post-review verdict.
//   read mode  (no flags):           prints current verdict.json
//   write mode (--set <verdict>):    persists { verdict, summary?, finding?, reviewer? }
//   stdin mode (--payload-stdin):     persists a JSON payload without shell-arg interpolation
//   --discard:                       removes the registry directory
export async function handleVerdict(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["set", "summary", "reviewer", "cwd"],
    repeatableValueOptions: ["finding"],
    booleanOptions: ["json", "discard", "payload-stdin"],
  });
  const taskId = positionals[0];
  if (!taskId) {
    throw usageError("verdict requires a task_id positional argument");
  }
  const modeCount = [Boolean(options.discard), Boolean(options.set), Boolean(options["payload-stdin"])]
    .filter(Boolean).length;
  if (modeCount > 1) {
    throw usageError("verdict modes are mutually exclusive: choose one of --set, --payload-stdin, or --discard");
  }

  // discard mode: remove only verdict.json so the rest of the registry
  // entry (meta.json, session-log.jsonl, etc.) is preserved for audit.
  if (options.discard) {
    const target = path.join(jobDir(taskId), "verdict.json");
    let removed = false;
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      removed = true;
    }
    emitSuccess(
      "verdict",
      { task_id: taskId, action: "discarded", removed },
      `Discarded verdict for ${taskId}\n`,
      { json: options.json, startedAt },
    );
    return;
  }

  if (options["payload-stdin"]) {
    if (options.summary || options.reviewer || options.finding) {
      throw usageError("--payload-stdin cannot be combined with --summary, --reviewer, or --finding");
    }
    const payload = readVerdictPayloadFromStdin();
    writeVerdict(taskId, payload);
    const stored = readVerdict(taskId);
    emitSuccess(
      "verdict",
      { task_id: taskId, action: "set", verdict: stored },
      `Verdict for ${taskId}: ${payload.verdict}\n`,
      { json: options.json, startedAt },
    );
    return;
  }

  // write mode: persist a new verdict
  if (options.set) {
    const verdict = options.set;
    validateVerdictValue(verdict);
    const payload = {
      verdict,
      summary: options.summary ?? null,
      findings: Array.isArray(options.finding)
        ? options.finding
        : options.finding
          ? [options.finding]
          : [],
      reviewer: options.reviewer ?? null,
    };
    writeVerdict(taskId, payload);
    const stored = readVerdict(taskId);
    emitSuccess(
      "verdict",
      { task_id: taskId, action: "set", verdict: stored },
      `Verdict for ${taskId}: ${verdict}\n`,
      { json: options.json, startedAt },
    );
    return;
  }

  // read mode
  const stored = readVerdict(taskId);
  if (!stored) {
    throw notFoundError(
      `no verdict found for ${taskId}; use --set to create one`,
    );
  }
  const cwd = resolveCommandCwd(options);
  const meta = readMeta(taskId);
  const mergeReadiness = buildVerdictMergeReadiness(taskId, stored, meta, cwd);
  const result = {
    task_id: taskId,
    verdict: {
      ...stored,
      summary: stored.summary ?? null,
      branch: mergeReadiness.branch,
      branch_head_sha: mergeReadiness.branch_head_sha,
      reviewed_branch_head_sha: mergeReadiness.reviewed_branch_head_sha,
    },
    merge_readiness: mergeReadiness,
  };
  emitSuccess(
    "verdict",
    result,
    JSON.stringify(result, null, 2) + "\n",
    { json: options.json, startedAt },
  );
}

// verdicts --pending — flat list of tasks with verdict=approved (not yet
// merged), verdict=needs-attention, or verdict=must-fix. All three states
// are unresolved work and block the Stop gate (T14) until merged or
// explicitly discarded with `verdict --discard`.
export async function handleVerdictsPending(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "pending"],
  });

  // --pending is the only mode currently supported. Require it explicitly
  // so the CLI contract leaves room for future modes (e.g. --resolved)
  // without silently changing default behavior.
  if (!options.pending) {
    throw usageError(
      "verdicts requires --pending (only mode currently supported)",
    );
  }

  const cwd = resolveCommandCwd(options);
  const pendingVerdicts = new Set(["approved", "needs-attention", "must-fix"]);
  const tasks = listTasks();
  const pending = [];
  for (const taskId of tasks) {
    const verdict = readVerdict(taskId);
    if (!verdict) continue;
    const meta = readMeta(taskId);
    if (verdict.merged_at || meta?.merged_at || meta?.phase === "merged") {
      continue;
    }
    if (verdict.superseded_by || meta?.superseded_by || meta?.phase === "superseded") {
      continue;
    }
    if (pendingVerdicts.has(verdict.verdict)) {
      const mergeReadiness = buildVerdictMergeReadiness(taskId, verdict, meta, cwd);
      pending.push({
        task_id: taskId,
        verdict: verdict.verdict,
        summary: verdict.summary ?? null,
        decided_at: verdict.decided_at,
        branch: mergeReadiness.branch,
        branch_head_sha: mergeReadiness.branch_head_sha,
        reviewed_branch_head_sha: mergeReadiness.reviewed_branch_head_sha,
        current_branch_head_sha: mergeReadiness.current_branch_head_sha,
        merge_ready: mergeReadiness.merge_ready,
        merge_blocked_by: mergeReadiness.merge_blocked_by,
        merge_blockers: mergeReadiness.merge_blockers,
        merge_block_reason: mergeReadiness.merge_block_reason,
        next_action: mergeReadiness.next_action,
      });
    }
  }

  const rendered =
    pending.length === 0
      ? "No pending verdicts.\n"
      : pending
          .map(
            (p) =>
              `${p.task_id}  ${p.verdict}  ${p.branch ?? "(no branch)"}  ${p.merge_ready ? "merge-ready" : `blocked:${p.merge_blocked_by ?? "unknown"}`}  ${p.summary ?? ""}`,
          )
          .join("\n") + "\n";

  emitSuccess(
    "verdicts",
    { count: pending.length, pending },
    rendered,
    { json: options.json, startedAt },
  );
}

// merge <task_id> — gated merge of a worktree branch back into its base.
// Refuses to proceed unless verdict.json is approved for this exact branch SHA.
// Performs a fast-forward merge (no merge commit, no rebase). On conflict
// or if the merge isn't ff-eligible, leaves the worktree intact and returns
// MERGE_CONFLICT so the orchestrator can re-run /codex-bridge:iterate.
export async function handleMerge(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "no-tests", "pr"],
  });
  const taskId = positionals[0];
  if (!taskId) {
    throw usageError("merge requires a task_id positional argument");
  }
  const cwd = resolveCommandCwd(options);

  const verdict = readVerdict(taskId);
  if (!verdict) {
    throw notFoundError(
      `no verdict found for ${taskId}; run review and record an approved verdict before merging`,
    );
  }
  if (verdict.verdict !== "approved") {
    throw new CliError(
      `verdict for ${taskId} is ${verdict.verdict}, not approved; refusing to merge. Re-run review or iterate before approving this task.`,
      { code: "VERDICT_NOT_APPROVED", class: "conflict" },
    );
  }
  const reviewedBranchHeadSha = readReviewedBranchHeadSha(verdict);
  if (!reviewedBranchHeadSha) {
    throw new CliError(
      `approved verdict for ${taskId} is missing branch_head_sha; rerun review so the approval is bound to the reviewed branch head`,
      { code: "VERDICT_HEAD_SHA_MISSING", class: "conflict" },
    );
  }

  const meta = readMeta(taskId);
  if (!meta) {
    throw notFoundError(
      `no meta.json found for ${taskId}; the task was not dispatched via --worktree-auto`,
    );
  }
  const branch = meta.worktree?.branch;
  const baseRef = meta.worktree?.base_ref ?? "main";
  if (!branch) {
    throw new CliError(
      `meta.json for ${taskId} missing worktree.branch — task may not have been dispatched via --worktree-auto`,
      { code: "MERGE_META_INVALID", class: "internal" },
    );
  }

  if (options.pr) {
    // --pr (push + gh pr create) deferred — needs additional plumbing for
    // PR body composition from brief + verdict. Track in a follow-up.
    throw new CliError(
      "--pr mode not yet implemented; ff-merge into the base ref is the only supported strategy in v2.0. Drop --pr or wait for the follow-up.",
      { code: "MERGE_PR_NOT_IMPLEMENTED", class: "internal" },
    );
  }

  let mergeResult;
  try {
    mergeResult = mergeSubagentBranch({
      cwd,
      taskId,
      branch,
      baseRef,
      expectedBranchSha: reviewedBranchHeadSha,
      worktreePath: meta.worktree?.path,
      runTests: !options["no-tests"],
    });
  } catch (err) {
    const kind = err?.kind;
    if (kind === "conflict") {
      throw new CliError(
        `merge failed: ${err.message ?? err}. The worktree was left intact; resolve conflicts manually or rerun /codex-bridge:iterate.`,
        { code: "MERGE_CONFLICT", class: "conflict" },
      );
    }
    if (kind === "sha_drift") {
      throw new CliError(
        `merge refused: ${err.message ?? err}`,
        { code: "MERGE_SHA_DRIFT", class: "conflict" },
      );
    }
    if (kind === "precondition") {
      throw new CliError(
        `merge precondition failed: ${err.message ?? err}`,
        { code: "MERGE_PRECONDITION", class: "usage" },
      );
    }
    throw new CliError(
      `merge failed: ${err.message ?? err}`,
      { code: "MERGE_INTERNAL", class: "internal" },
    );
  }

  const mergedAt = nowIso();
  const {
    schema_version: _verdictSchemaVersion,
    task_id: _verdictTaskId,
    decided_at: _verdictDecidedAt,
    ...verdictBody
  } = verdict;
  writeVerdict(taskId, {
    ...verdictBody,
    merged_at: mergedAt,
    merge: mergeResult,
  });
  const {
    schema_version: _schemaVersion,
    task_id: _taskId,
    written_at: _writtenAt,
    ...metaBody
  } = meta;
  writeMeta(taskId, {
    ...metaBody,
    phase: "merged",
    merged_at: mergedAt,
    merge: mergeResult,
  });

  const payload = {
    task_id: taskId,
    merge: mergeResult,
    verdict: verdict.verdict,
    reviewed_branch_head_sha: reviewedBranchHeadSha,
  };
  emitSuccess(
    "merge",
    payload,
    `Merged ${branch} into ${baseRef} (${mergeResult.commit_sha?.slice(0, 8) ?? "?"})\n`,
    { json: options.json, startedAt },
  );
}
