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
import { createSubagentWorktree, ensureGitRepository, mergeSubagentBranch, pruneWorktreeOnCancel, resolveReviewTarget } from "../lib/git.mjs";
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
  findWorktreePromptAbsolutePathConflicts,
  filterJobsForCurrentClaudeSession,
  findLatestResumableTaskJob,
  formatWorktreePromptAbsolutePathConflict,
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

export async function handleTask(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [
      "model", "effort", "cwd", "prompt-file", "mode", "backend",
      "idle-timeout-ms",
      "turn-plan-ms", "turn-default-ms",
      "pipeline-stage-timeout-ms", "pipeline-total-timeout-ms",
      "question-timeout-ms",
      "brief", "intercepted-from"
    ],
    booleanOptions: ["json", "write", "read-only", "resume-last", "resume", "fresh", "background", "no-pipeline", "quiet", "worktree-auto", "rewake-on-terminal", "legacy-envelope"],
    aliasMap: {
      m: "model"
    }
  });

  const VALID_MODES = new Set(["plan", "default"]);
  if (options.mode != null && !VALID_MODES.has(options.mode)) {
    throw usageError(`mode must be plan or default, got ${JSON.stringify(options.mode)}`);
  }

  // Resolve every timeout-flag up front so callers see usage errors for
  // malformed values instead of silent fallback. Every unset flag is null,
  // letting runBridgeTask / runAutoPipeline fall through to config.yaml →
  // built-in default.
  const idleTimeoutOverride = parsePositiveMsOption("--idle-timeout-ms", options["idle-timeout-ms"]);
  const turnPlanOverride = parsePositiveMsOption("--turn-plan-ms", options["turn-plan-ms"]);
  const turnDefaultOverride = parsePositiveMsOption("--turn-default-ms", options["turn-default-ms"]);
  const pipelineStageOverride = parsePositiveMsOption("--pipeline-stage-timeout-ms", options["pipeline-stage-timeout-ms"]);
  const pipelineTotalOverride = parsePositiveMsOption("--pipeline-total-timeout-ms", options["pipeline-total-timeout-ms"]);
  const questionTimeoutOverride = parsePositiveMsOption("--question-timeout-ms", options["question-timeout-ms"]);
  const noPipeline = Boolean(options["no-pipeline"]);
  // `--json` implies `--quiet` unless the caller explicitly passes `--quiet=false`.
  // Rationale: `--json` signals machine consumption; the stderr `[codex] Thread
  // ready (<uuid>)` progress line is a UUID-trap that agents regex-match out
  // and then target with `send/respond`, confusing the returned threadId.
  // Explicit `--quiet=false` preserves a human-watching-json flow if anyone
  // actually wants it.
  const quietMode = Boolean(options.quiet) || (Boolean(options.json) && options.quiet !== false);

  let cwd = resolveCommandCwd(options);
  const stateCwd = cwd;
  const workspaceRoot = resolveCommandWorkspace(options);

  // --brief @path.json | <inline-json> loads + validates the structured
  // brief (T16) and persists it verbatim (brief.json + brief.md) into
  // the per-task registry directory alongside meta.json. Persisting the
  // brief is the v2 mechanism by which the original intent is recovered
  // by review / iterate even if the prompt template later changes.
  //
  // Both --brief and --intercepted-from currently require --worktree-auto
  // because the registry directory is only created when a worktree is
  // dispatched (T15 wiring). Passing them without --worktree-auto would
  // silently discard the value, so we fail loudly instead. The validated
  // brief is also appended to the worker prompt before dispatch, so Codex
  // sees the structured assignment instead of only an on-disk artifact.
  let brief = null;
  let briefHash = null;
  let briefSource = null;
  if (options.brief || options["intercepted-from"]) {
    if (!options["worktree-auto"]) {
      throw conflictError(
        "--brief and --intercepted-from require --worktree-auto (the registry slot that stores brief.json / intercepted_from is created by the worktree path).",
        "BRIEF_REQUIRES_WORKTREE_AUTO",
      );
    }
  }
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
    briefHash = result.briefHash;
    briefSource = result.source ?? options.brief;
  }

  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw conflictError(
      "Choose either --resume/--resume-last or --fresh.",
      "RESUME_FRESH_CONFLICT"
    );
  }
  if (resumeLast && options["worktree-auto"]) {
    throw conflictError(
      "--resume/--resume-last resumes a Codex thread only and cannot safely create a fresh worktree. Use `iterate <task_id>` to continue task worktree state, or start a fresh `task --write --worktree-auto` from the current branch.",
      "RESUME_WORKTREE_CONFLICT",
      "Use `codex-bridge iterate <task_id>` for follow-up fixes, or drop --resume-last and dispatch a fresh worktree task."
    );
  }
  // Fail fast before `runBridgeTask` can append `prompt_footer` to an empty prompt
  // and spend a billed Codex turn. Mirrors the check the --background path already does.
  requireTaskRequest(prompt, resumeLast);
  const write = Boolean(options.write);
  if (write && options["worktree-auto"]) {
    const launchConfig = getBridgeConfig(cwd, workspaceRoot);
    const executionConfig = getBridgeConfig(workspaceRoot, workspaceRoot);
    const promptFooters = [
      launchConfig.prompt_footer || null,
      executionConfig.prompt_footer || null,
    ].filter((value, index, values) => value && values.indexOf(value) === index);
    const guardText = [
      prompt,
      brief ? renderBriefAsMarkdown(brief) : null,
      ...promptFooters,
    ].filter(Boolean).join("\n\n");
    const pathConflicts = findWorktreePromptAbsolutePathConflicts(guardText, workspaceRoot, [cwd, stateCwd]);
    if (pathConflicts.length > 0) {
      throw validationError(
        formatWorktreePromptAbsolutePathConflict(pathConflicts, workspaceRoot),
        "WORKTREE_ABSOLUTE_PATH_CONFLICT",
        "Use repo-relative paths before dispatching with --worktree-auto.",
      );
    }
  }
  // `--read-only` forces sandboxPolicy: { type: "readOnly" } regardless of
  // `config.sandbox_policy` (including `danger-full-access`). Mutually
  // exclusive with `--write` — that combination is incoherent. Used by the
  // stop-time review-gate hook to ensure stop-hook reviews never mutate the
  // repo even when the user has opted into a wide-open default policy.
  const readOnly = Boolean(options["read-only"]);
  if (write && readOnly) {
    throw conflictError(
      "Choose either --write or --read-only, not both.",
      "WRITE_READ_ONLY_CONFLICT"
    );
  }
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });
  const adapter = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    backend: options.backend ?? null,
    taskMetadata,
  });
  ensureCodexRuntimeAdapter(adapter);

  const job = buildTaskJob(workspaceRoot, taskMetadata, write, {
    backend: adapter.name,
    adapterCapabilities: adapter.capabilities(),
  });

  // --worktree-auto isolates write-mode tasks inside a per-task worktree
  // at <repoRoot>/../.codex-bridge-worktrees/<job_id> on a branch named
  // subagent/codex/<job_id>. Validate the full task request before creating
  // git state; after this point, cwd is execution-only and state stays anchored
  // to stateCwd/workspaceRoot so result/status/events keep finding the job.
  let worktreeInfo = null;
  if (options["worktree-auto"]) {
    if (!write) {
      throw conflictError(
        "--worktree-auto requires --write.",
        "WORKTREE_WRITE_REQUIRED",
      );
    }
    ensureCodexAvailable(cwd);
    try {
      worktreeInfo = createSubagentWorktree({
        cwd,
        taskId: job.id,
        backend: adapter.name,
        allowBranchFallback: false,
      });
      if (worktreeInfo.isolation_mode !== "worktree") {
        throw new Error(`expected isolated worktree, got ${worktreeInfo.isolation_mode}`);
      }
      job.registryTaskId = job.id;
      job.worktree = worktreeInfo;
      job.isolation_mode = worktreeInfo.isolation_mode;
      try {
        writeMeta(job.id, {
          backend: adapter.name,
          capabilities: adapter.capabilities(),
          worktree: worktreeInfo,
          isolation_mode: worktreeInfo.isolation_mode,
          base_ref: worktreeInfo.base_ref,
          base_sha: worktreeInfo.base_sha,
          phase: "queued",
          brief_hash: briefHash,
          brief_source: briefSource,
        });
        if (brief) {
          writeBriefArtifacts(job.id, {
            brief,
            rendered: renderBriefAsMarkdown(brief),
            hash: briefHash,
            source: briefSource,
          });
        }
      } catch {
        // Registry writes are best-effort — never block dispatch.
      }
      cwd = worktreeInfo.path;
    } catch (err) {
      if (err instanceof CliError) {
        throw err;
      }
      throw new CliError(
        `failed to create subagent worktree for ${job.id}: ${err.message ?? err}`,
        {
          code: "WORKTREE_CREATE_FAILED",
          class: "internal",
          suggestion: "Check that cwd is a Git repository with at least one commit, the base ref exists, and the worktree branch/path are available."
        },
      );
    }
  }

  if (options.background) {
    ensureCodexAvailable(cwd);

    const request = buildTaskRequest({
      cwd,
      stateCwd,
      model,
      effort,
      prompt,
      brief,
      write,
      readOnly,
      resumeLast,
      jobId: job.id,
      mode: options.mode ?? null,
      idleTimeoutMs: idleTimeoutOverride,
      turnPlanMs: turnPlanOverride,
      turnDefaultMs: turnDefaultOverride,
      pipelineStageMs: pipelineStageOverride,
      pipelineTotalMs: pipelineTotalOverride,
      questionAnswerMs: questionTimeoutOverride,
      noPipeline,
      backend: adapter.name
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    emitSuccess("task", payload, renderQueuedTaskLaunch(payload), {
      json: options.json,
      startedAt
    });
    return;
  }

  await runForegroundCommand(
    job,
    (progress) =>
      runBridgeTask({
        cwd,
        stateCwd,
        model,
        effort,
        prompt,
        brief,
        write,
        readOnly,
        resumeLast,
        jobId: job.id,
        mode: options.mode ?? null,
        idleTimeoutMs: idleTimeoutOverride,
        turnPlanMs: turnPlanOverride,
        turnDefaultMs: turnDefaultOverride,
        pipelineStageMs: pipelineStageOverride,
        pipelineTotalMs: pipelineTotalOverride,
        questionAnswerMs: questionTimeoutOverride,
        noPipeline,
        backend: adapter.name,
        // `--quiet` suppresses the stderr `[codex] …` progress stream so
        // agents don't pattern-match a thread UUID out of it. Monitor /
        // `events --follow` remain the canonical in-run observation surface.
        onProgress: quietMode ? null : progress
      }),
    { json: options.json, startedAt, command: "task" }
  );
}

export async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "workspace-root", "job-id"]
  });

  if (!options["job-id"]) {
    throw usageError("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = options["workspace-root"]
    ? path.resolve(process.cwd(), options["workspace-root"])
    : resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw notFoundError(
      `No stored job found for ${options["job-id"]}.`,
      "JOB_NOT_FOUND"
    );
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new CliError(
      `Stored job ${options["job-id"]} is missing its task request payload.`,
      { class: "internal", code: "JOB_CORRUPT", retryable: false }
    );
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    async () =>
      // Go through `runBridgeTask` (not `executeTaskRun` directly) so the
      // detached worker builds the same session-logging hooks, prompt
      // decorations (`skip_meta_skills`, `prompt_footer`), sandbox-policy
      // resolution, `[QUESTION]` handler, and auto-pipeline that the
      // foreground path uses. Pre-v1.2.1 this line called `executeTaskRun`
      // directly, so `task --background` ran the turn but produced ZERO
      // session artifacts (`.events`, `.ndjson`, `.diff`) — breaking every
      // `wait` / `events --follow` caller. See `gherkin-tests-v2/
      // 07-orchestration/08-background-path-produces-session-files.md`.
      persistFailureErrorInPayload(
        await runBridgeTask({
          ...request,
          onProgress: progress
        }),
        "task"
      ),
    { logFile }
  );
}

function readCancelMeta(taskId) {
  if (!taskId) return { meta: null, warning: null };
  try {
    return { meta: readMeta(taskId), warning: null };
  } catch (error) {
    return {
      meta: null,
      warning: `could not read task registry metadata: ${error?.message ?? error}`,
    };
  }
}

function resolveCancelWorktree(job, existing, meta) {
  const rawWorktree = [meta?.worktree, existing?.worktree, job?.worktree]
    .find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)) ?? {};
  const value = (...candidates) => {
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
    return null;
  };
  return {
    isolation_mode: value(rawWorktree.isolation_mode, meta?.isolation_mode, existing?.isolation_mode, job?.isolation_mode),
    path: value(rawWorktree.path, meta?.worktree_path, existing?.worktree?.path, job?.worktree?.path),
    branch: value(rawWorktree.branch, meta?.branch, meta?.worktree_branch, existing?.worktree?.branch, job?.worktree?.branch),
    previous_ref: value(rawWorktree.previous_ref, meta?.previous_ref, existing?.worktree?.previous_ref, job?.worktree?.previous_ref),
  };
}

function cleanupCancelledWorktree({ workspaceRoot, job, existing, meta, keepWorktree, keepBranch }) {
  const registryTaskId = existing?.registryTaskId ?? job?.registryTaskId ?? meta?.task_id ?? job?.id;
  const worktree = resolveCancelWorktree(job, existing, meta);
  const cleanup = {
    attempted: false,
    succeeded: false,
    reason: "no-worktree",
    worktreePath: worktree.path ?? null,
    branchName: worktree.branch ?? null,
    worktreeRemoved: false,
    branchDeleted: false,
    preservedWorktree: false,
    preservedBranch: false,
    failures: [],
  };

  const branchLooksOwned = typeof worktree.branch === "string" && worktree.branch.startsWith("subagent/");
  const pathLooksOwned = typeof worktree.path === "string" && worktree.path.includes(".codex-bridge-worktrees/");
  const modeLooksOwned = worktree.isolation_mode === "worktree";
  if (!modeLooksOwned && !branchLooksOwned && !pathLooksOwned) {
    return cleanup;
  }

  if (keepWorktree) {
    cleanup.reason = "preserved-by-user";
    cleanup.preservedWorktree = Boolean(worktree.path);
    cleanup.preservedBranch = Boolean(worktree.branch);
    return cleanup;
  }

  cleanup.attempted = true;
  const branchForCleanup = branchLooksOwned ? worktree.branch : null;
  const effectiveKeepBranch = Boolean(keepBranch);
  cleanup.preservedBranch = Boolean(worktree.branch && (effectiveKeepBranch || !branchForCleanup));

  try {
    const pruned = pruneWorktreeOnCancel({
      cwd: workspaceRoot,
      taskId: registryTaskId,
      branch: branchForCleanup,
      previousRef: worktree.previous_ref,
      path: worktree.path,
      keepBranch: effectiveKeepBranch,
    });
    cleanup.worktreeRemoved = Boolean(pruned.pruned);
    cleanup.branchDeleted = Boolean(pruned.branchDeleted);
    cleanup.succeeded = Boolean(pruned.pruned) && (effectiveKeepBranch || !branchForCleanup || Boolean(pruned.branchDeleted));
    cleanup.reason = cleanup.succeeded ? "cleaned" : "cleanup-incomplete";
  } catch (error) {
    cleanup.reason = "cleanup-failed";
    cleanup.failures.push(error instanceof Error ? error.message : String(error));
  }
  return cleanup;
}

function writeCancelledMeta(taskId, meta, completedAt, cleanup) {
  if (!taskId || !meta) return null;
  const {
    schema_version: _schemaVersion,
    task_id: _taskId,
    written_at: _writtenAt,
    ...metaBody
  } = meta;
  writeMeta(taskId, {
    ...metaBody,
    phase: "cancelled",
    cancelled_at: completedAt,
    cleanup,
  });
  return taskId;
}

export async function handleCancel(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "keep-worktree", "keep-branch", "keep-all"]
  });

  const cwd = resolveCommandCwd(options);
  const keepAll = Boolean(options["keep-all"]);
  const keepWorktree = keepAll || Boolean(options["keep-worktree"]);
  const keepBranch = keepAll || keepWorktree || Boolean(options["keep-branch"]);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const registryTaskId = existing.registryTaskId ?? job.registryTaskId ?? job.id;
  const { meta: registryMeta, warning: registryWarning } = readCancelMeta(registryTaskId);
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;
  const adapter = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    metaBackend: existing.backend ?? job.backend ?? null,
  });
  ensureCodexRuntimeAdapter(adapter);

  const interrupt = await adapter.cancel(job.id, { cwd, threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.reason ? `: ${interrupt.reason}` : "."}`
    );
  }

  // Capture the terminate result so the envelope can report whether the
  // backing process was actually reaped vs. already gone vs. never had a
  // pid. Field-report P1-10: cancel envelopes were ambiguous about which
  // sub-step succeeded; normalize to explicit booleans plus a warnings list.
  const terminate = terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const warnings = [];
  if (interrupt.attempted && !interrupt.interrupted) {
    warnings.push(
      interrupt.reason
        ? `turn interrupt failed: ${interrupt.reason}`
        : "turn interrupt failed (no reason returned)"
    );
  }
  if (terminate.attempted && !terminate.delivered) {
    warnings.push(`process ${job.pid} was already gone (method=${terminate.method ?? "unknown"})`);
  }
  // No `!terminate.attempted && Number.isFinite(job.pid)` branch: terminateProcessTree
  // returns attempted=false only for a non-finite pid, so finite pids always
  // attempt. Earlier draft included that branch — review-bot Devin and codex
  // exec review both flagged it as dead code; removed for clarity.

  if (registryWarning) {
    warnings.push(registryWarning);
  }
  if (keepWorktree && !options["keep-branch"] && !options["keep-all"]) {
    warnings.push("preserving worktree also preserves its checked-out branch");
  }

  const cleanup = cleanupCancelledWorktree({
    workspaceRoot,
    job,
    existing,
    meta: registryMeta,
    keepWorktree,
    keepBranch,
  });
  if (cleanup.attempted && cleanup.succeeded) {
    appendLogLine(job.logFile, `Removed cancelled worktree artifacts for ${job.id}.`);
  } else if (cleanup.reason === "preserved-by-user") {
    appendLogLine(job.logFile, `Preserved cancelled worktree artifacts for ${job.id}.`);
  } else if (cleanup.failures.length > 0) {
    appendLogLine(job.logFile, `Worktree cleanup failed for ${job.id}: ${cleanup.failures.join("; ")}`);
  }
  for (const failure of cleanup.failures) {
    warnings.push(`worktree cleanup failed: ${failure}`);
  }
  if (cleanup.preservedBranch && cleanup.branchName && !keepBranch) {
    warnings.push(`skipped branch deletion for non-bridge branch: ${cleanup.branchName}`);
  }

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user.",
    cleanup,
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt,
    cleanup,
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt,
    cleanup,
  });
  if (registryMeta) {
    try {
      writeCancelledMeta(registryTaskId, registryMeta, completedAt, cleanup);
    } catch (error) {
      warnings.push(`could not update task registry metadata: ${error?.message ?? error}`);
    }
  }

  // Resolve a stable display title from the registry kind, not the job's
  // dispatch-time "Codex Resume" / "Codex Task" label which mismatched
  // `kindLabel` and confused agents during forensics. `job.title` is kept
  // under `dispatchTitle` for backward compat.
  // Known kindLabel values come from `getJobTypeLabel` in src/lib/job-control.mjs:
  //   "task" | "review" | "adversarial-review" | "rescue-review"
  // Default falls back to a generic "Codex Job" so a future kindLabel that
  // hasn't reached this map yet doesn't get silently labelled "Codex Task".
  const kindLabel = existing.kindLabel ?? job.kindLabel ?? job.jobClass ?? "task";
  const KIND_TITLE = {
    "task": "Codex Task",
    "review": "Codex Review",
    "adversarial-review": "Codex Adversarial Review",
    "rescue-review": "Codex Stop Gate Review",
  };
  const normalizedTitle = KIND_TITLE[kindLabel] ?? "Codex Job";

  const payload = {
    jobId: job.id,
    status: "cancelled",
    cancelled: true,
    processTerminated: Boolean(terminate.delivered),
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted,
    cleanup,
    reason: "cancelled-by-user",
    cleanup,
    warnings,
    title: normalizedTitle,
    dispatchTitle: job.title ?? null,
    kindLabel,
    recovery: buildRecovery({
      reason: "cancelled-by-user",
      retryable: false,
      nextActions: [
        `Run result ${job.id} to inspect any partial output.`,
        "Start a fresh task if the cancelled work is still required.",
      ],
      artifacts: {
        logFile: job.logFile ?? null,
        threadId,
        turnId,
      },
      details: {
        interruptAttempted: interrupt.attempted,
        interrupted: interrupt.interrupted,
        interruptReason: interrupt.reason ?? null,
        terminateAttempted: terminate.attempted,
        terminateDelivered: Boolean(terminate.delivered),
        terminateMethod: terminate.method ?? null,
        cleanup,
      },
    }),
  };

  // Pass the normalized title into the human-readable render so JSON and
  // text consumers see the same "Title:" line. Without this, --json reports
  // "Codex Task" while the rendered report would still print the raw
  // dispatch label ("Codex Resume", etc.) from the spread `nextJob`.
  emitSuccess("cancel", payload, renderCancelReport({ ...nextJob, title: normalizedTitle }), {
    json: options.json,
    startedAt
  });
}

// ── NEW COMMANDS ──────────────────────────────────────────────────────────

export async function handleSend(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [
      "mode", "effort", "cwd", "backend",
      "idle-timeout-ms",
      "turn-timeout-ms",
      "question-timeout-ms"
    ],
    booleanOptions: ["json", "wait", "quiet"],
    aliasMap: { m: "mode" }
  });

  const VALID_MODES = new Set(["plan", "default"]);
  if (options.mode != null && !VALID_MODES.has(options.mode)) {
    throw usageError(`mode must be plan or default, got ${JSON.stringify(options.mode)}`);
  }

  const idleTimeoutOverride = parsePositiveMsOption("--idle-timeout-ms", options["idle-timeout-ms"]);
  // `send` doesn't distinguish plan vs default (the mode is already fixed by
  // the resumed thread), so one --turn-timeout-ms flag covers it. It maps
  // onto whichever of turn_plan_ms / turn_default_ms the resolved mode picks.
  const turnTimeoutOverride = parsePositiveMsOption("--turn-timeout-ms", options["turn-timeout-ms"]);
  const questionTimeoutOverride = parsePositiveMsOption("--question-timeout-ms", options["question-timeout-ms"]);
  // See handleTask: --json implies --quiet so orchestrators consuming the
  // envelope don't also have to filter the stderr UUID trap.
  const quietMode = Boolean(options.quiet) || (Boolean(options.json) && options.quiet !== false);

  const startedAt = Date.now();
  const rawThreadId = positionals[0];
  if (!rawThreadId) {
    throw usageError("send requires <thread-id>");
  }
  if (!isThreadId(rawThreadId)) {
    throw invalidThreadIdError(rawThreadId, "thread-id");
  }
  const threadId = rawThreadId.trim();

  const promptParts = positionals.slice(1);
  const cwd = resolveCommandCwd(options);
  const prompt = resolvePromptInput(options, promptParts, cwd);
  if (!prompt) {
    throw validationError("send requires a prompt (text or file)", "MISSING_PROMPT");
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getBridgeConfig(cwd, workspaceRoot);
  const adapter = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    backend: options.backend ?? null,
  });
  ensureCodexRuntimeAdapter(adapter);
  guardCapability(adapter, "supports_resume");
  const modeOverride = options.mode;

  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));

  const sendIsPlanMode = modeOverride === "plan";
  const turnOptions = {
    resumeThreadId: threadId,
    prompt,
    model: config.model,
    effort: normalizeReasoningEffort(options.effort ?? config.effort),
    sandbox: modeOverride === "default" ? "workspace-write" : modeOverride === "plan" ? "read-only" : undefined,
    onProgress: null,
    // Resolution order: --idle-timeout-ms flag → config.yaml `idle_timeout_ms`
    // → 300_000 fallback. Mirrors the `task` path; see runBridgeTask.
    idleTimeoutMs: idleTimeoutOverride != null
      ? idleTimeoutOverride
        : (Number(config.idle_timeout_ms) > 0 ? Number(config.idle_timeout_ms) : DEFAULT_CONFIG.idle_timeout_ms),
    // Turn timeout: per-invocation override > the mode-appropriate config key
    // (turn_plan_ms for plan-mode sends, turn_default_ms otherwise) > built-in
    // default. `send` gets a single --turn-timeout-ms flag that maps onto the
    // right budget based on the resolved mode.
    turnTimeoutMs: turnTimeoutOverride
      ?? (sendIsPlanMode
        ? (Number(config.turn_plan_ms) > 0 ? Number(config.turn_plan_ms) : DEFAULT_CONFIG.turn_plan_ms)
        : (Number(config.turn_default_ms) > 0 ? Number(config.turn_default_ms) : DEFAULT_CONFIG.turn_default_ms)),
    onTurnStart: (info) => {
      const s = findSession(sessionDir, info.threadId) ?? initSession(sessionDir, info.threadId);
      logNdjson(s, "TURN_PARAMS", "turn/start", {
        model: info.turnParams.model,
        effort: info.turnParams.effort,
        collaborationMode: info.turnParams.collaborationMode,
        sandboxPolicy: info.turnParams.sandboxPolicy,
        hasOutputSchema: Boolean(info.turnParams.outputSchema),
        promptLength: info.promptLength,
        promptPreview: info.promptPreview
      });
    },
    onItemCompleted: (item, { threadId: itemThreadId }) => {
      const effectiveThreadId = itemThreadId ?? null;
      if (!effectiveThreadId) return;
      const s = findSession(sessionDir, effectiveThreadId) ?? initSession(sessionDir, effectiveThreadId);
      logNdjson(s, "ITEM_COMPLETED", "item/completed", {
        itemId: item?.id ?? null,
        itemType: item?.type ?? null,
        text: extractItemText(item)
      });
    },
    onServerRequest: createBridgeServerRequestHandler({
      sessionDir,
      config,
      questionAnswerMs: questionTimeoutOverride ?? null,
      cwd
    })
  };

  // `sandboxPolicy` must honor `config.sandbox_policy` regardless of whether
  // the caller passed `--mode`. Previously the override only applied inside
  // the `if (modeOverride)` block, so a plain `send <tid> "prompt"` silently
  // dropped `sandbox_policy: danger-full-access` and inherited the thread's
  // original (read-only) sandbox — defeating the user's explicit config.
  // Resolve through `buildSandboxPolicy` with a mode derived from the
  // override (if set) or from the turn's thread semantics (read-only when
  // nothing narrows it, widened only if the config explicitly says so).
  const resolvedSandboxMode = modeOverride === "default" ? "default" : "plan";
  turnOptions.sandboxPolicy = buildSandboxPolicy(resolvedSandboxMode, config);
  if (modeOverride) {
    turnOptions.collaborationMode = buildCollaborationMode(modeOverride, config, {
      effort: options.effort,
      developerInstructions: loadDeveloperInstructions(modeOverride),
    });
  }

  ensureCodexAvailable(cwd);
  const dispatch = await adapter.resume(threadId, prompt, {
    cwd,
    sessionDir,
    model: config.model,
    effort: turnOptions.effort,
    mode: modeOverride ?? "default",
    adapterOptions: {
      turnOptions,
    },
  });
  const result = dispatch.rawResult ?? dispatch;

  // Route failed Codex turns through emitError so exit code reflects the
  // failure class. Previously `send` emitted success + exit 0 even when the
  // turn failed with Unauthorized/ContextWindowExceeded/etc.
  if (result.status !== 0) {
    const errLike = result.error ?? { message: `send failed on thread ${threadId} (status ${result.status}).` };
    const session = findSession(sessionDir, threadId) ?? initSession(sessionDir, threadId);
    const classified = classifyError(errLike);
    logEvent(session, formatErrorEvent(session, {
      errorCode: classified.code,
      message: classified.message,
      phase: classified.class,
      origin: "send",
      scriptPath: SCRIPT_PATH,
      cwd
    }));
    logNdjson(session, "ERROR", "turn/completed", { error: classified });
    emitError(errLike, { json: options.json, command: "send" });
    return;
  }

  const session = findSession(sessionDir, threadId) ?? initSession(sessionDir, threadId);
  if (result.planDetected && result.planText) {
    const planPath = writePlan(session, result.planText);
    const steps = extractPlanSteps(result.planText);
    logEvent(session, formatPlanEvent(session, {
      turnId: result.turnId,
      planTitle: result.planText.split("\n")[0]?.slice(0, 80) ?? "Plan",
      steps,
      planPath,
      scriptPath: SCRIPT_PATH,
      cwd
    }));
    logNdjson(session, "PLAN", "item/completed", {
      turnId: result.turnId ?? null,
      planPath,
      planDetected: true
    });
    const eventsPath = session?.eventsPath ?? null;
    const renderedLines = [`Plan updated for ${threadId}.`];
    if (eventsPath) renderedLines.push(`  events: ${eventsPath}`);
    emitSuccess(
      "send",
      {
        threadId,
        status: result.status,
        turnId: result.turnId ?? null,
        eventsPath,
        phase: "plan-pending",
        planPath,
        planSteps: steps,
        finalMessage: result.finalMessage ?? null
      },
      `${renderedLines.join("\n")}\n`,
      { json: options.json, startedAt }
    );
    return;
  }
  logEvent(session, formatDoneEvent(session, {
    duration: Math.round((Date.now() - startedAt) / 1000),
    diffStat: "send follow-up",
    files: [],
    config: {
      model: config.model,
      effort: turnOptions.effort,
      modeFlow: modeOverride ?? "resume"
    },
    diffPath: "not captured for send",
    scriptPath: SCRIPT_PATH,
    cwd
  }));
  logNdjson(session, "DONE", "turn/completed", {
    turnId: result.turnId ?? null,
    status: result.status
  });
  const eventsPath = session?.eventsPath ?? null;
  const renderedLines = [`Sent to ${threadId}. Status: ${result.status}`];
  if (eventsPath) renderedLines.push(`  events: ${eventsPath}`);
  const payload = {
    threadId,
    status: result.status,
    turnId: result.turnId ?? null,
    eventsPath,
    finalMessage: result.finalMessage ?? null
  };
  emitSuccess("send", payload, `${renderedLines.join("\n")}\n`, {
    json: options.json,
    startedAt
  });
}

export async function handleSteer(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "backend"],
    booleanOptions: ["json"]
  });

  const [rawThreadId, turnId, ...promptParts] = positionals;
  if (!rawThreadId || !turnId) {
    throw usageError("steer requires <thread-id> <turn-id> <prompt...>");
  }
  if (!isThreadId(rawThreadId)) {
    throw invalidThreadIdError(rawThreadId, "thread-id");
  }
  const threadId = rawThreadId.trim();

  const cwd = resolveCommandCwd(options);
  const prompt = resolvePromptInput(options, promptParts, cwd);
  if (!prompt) {
    throw validationError("steer requires a prompt", "MISSING_PROMPT");
  }

  const adapter = await resolveCommandAdapter({
    cwd,
    workspaceRoot: resolveWorkspaceRoot(cwd),
    backend: options.backend ?? null,
  });
  ensureCodexRuntimeAdapter(adapter);
  guardCapability(adapter, "supports_steering");
  ensureCodexAvailable(cwd);
  await adapter.steer(threadId, turnId, prompt, { cwd });

  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const session = findSession(sessionDir, threadId);
  if (session) {
    logNdjson(session, "STEER", "turn/steer", { turnId, prompt: prompt.slice(0, 120) });
  }

  emitSuccess("steer", { threadId, turnId, steered: true }, `Steered turn ${turnId} on thread ${threadId}\n`, {
    json: options.json,
    startedAt
  });
}

export async function handleRespond(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["question-id", "answer", "json-payload", "cwd", "backend"],
    booleanOptions: ["json"]
  });

  const requestId = positionals[0];
  if (!requestId) {
    throw usageError("respond requires <request-id>");
  }

  const cwd = resolveCommandCwd(options);
  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const adapter = await resolveCommandAdapter({
    cwd,
    workspaceRoot: resolveWorkspaceRoot(cwd),
    backend: options.backend ?? null,
  });
  ensureCodexRuntimeAdapter(adapter);
  guardCapability(adapter, "supports_questions");

  // Look up the pending request from disk (written by the worker process)
  const pending = readPendingRequestById(sessionDir, requestId);
  if (!pending) {
    throw notFoundError(
      `No pending request found: ${requestId}.`,
      "PENDING_REQUEST_NOT_FOUND",
      "It may have timed out or already been answered."
    );
  }

  let payload;
  if (options["json-payload"]) {
    try {
      payload = JSON.parse(options["json-payload"]);
    } catch (error) {
      throw usageError(
        `respond --json-payload must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    const answer = options.answer;
    if (!answer) {
      throw usageError("respond requires --answer");
    }
    if (pending.method === "item/tool/requestUserInput") {
      const qId = options["question-id"] ?? pending.firstQuestionId ?? "q1";
      payload = { answers: { [qId]: { answers: [answer] } } };
    } else {
      payload = { decision: answer };
    }
  }

  // The adapter writes the response file — the worker process polls for this
  // and sends the response on its own connection, which holds the original
  // app-server request.
  await adapter.respond(pending.threadId, requestId, payload, { sessionDir });

  const session = findSession(sessionDir, pending.threadId);
  if (session) {
    logNdjson(session, "SERVER_RESPONSE", null, { requestId, payload });
  }

  emitSuccess(
    "respond",
    { status: "responded", requestId, threadId: pending.threadId },
    `Response written for ${requestId}. Worker will deliver it.\n`,
    { json: options.json, startedAt }
  );
}
