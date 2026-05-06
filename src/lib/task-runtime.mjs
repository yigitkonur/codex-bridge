import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  buildPersistentTaskThreadName,
  DEFAULT_CONTINUE_PROMPT,
  findLatestTaskThread,
  getCodexAvailability,
  parseStructuredOutput,
  readOutputSchema,
  runAppServerReview,
  runAppServerTurn,
} from "../adapters/codex/codex.mjs";
import { runAutoPipeline } from "../adapters/codex/pipeline.mjs";
import { buildAdversarialReviewPrompt } from "./adversarial-review-prompt.mjs";
import { loadBrief } from "./brief.mjs";
import {
  buildErrorEnvelope,
  buildHandoffEnvelope,
  classifyError,
  classifyTurnErrorOrigin,
  CliError,
  conflictError,
  emitError,
  emitSuccess,
  extractUpstreamRequestId,
  getUpstreamRetryPolicy,
  normalizeCodexErrorInfo,
  notFoundError,
  usageError,
  validationError,
} from "./cli-errors.mjs";
import {
  buildCollaborationMode,
  buildSandboxPolicy,
  COMPLETION_CHECK_SCHEMA,
  DEFAULT_CONFIG,
} from "./config.mjs";
import {
  ensureCodexRuntimeAdapter,
  getBridgeConfig,
  loadDeveloperInstructions,
  resolveCommandAdapter,
} from "./bridge-config.mjs";
import {
  appendRenderedBriefToPrompt,
  bridgeCommand,
  buildMonitorHint,
  extractItemText,
} from "./envelope-helpers.mjs";
import { readStdinIfPiped } from "./fs.mjs";
import {
  captureGitDiff,
  captureGitSnapshot,
  diffGitSnapshot,
  findSession,
  formatCheckpointEvent,
  formatConfirmedEvent,
  formatDirectivesEvent,
  formatDoneEvent,
  formatErrorEvent,
  formatHandoffEvent,
  formatHeartbeatEvent,
  formatIncompleteEvent,
  formatPartialEvent,
  formatPhaseEvent,
  formatPlanEvent,
  formatPipelineEvent,
  formatQuestionEvent,
  formatRetryingEvent,
  formatReviewEvent,
  formatWarningEvent,
  initSession,
  logEvent,
  logNdjson,
  resolveSessionDir,
  writePlan,
  writeReview as writeSessionReview,
  writeSessionAliases,
} from "./session-log.mjs";
import {
  collectReviewContext,
  ensureGitRepository,
  getWorkingTreeState,
  resolveReviewTarget,
} from "./git.mjs";
import { buildSingleJobSnapshot, readStoredJob, sortJobsNewestFirst } from "./job-control.mjs";
import { waitForResponse, clearPendingRequest, writePendingRequest } from "./pending-requests.mjs";
import { runCommand } from "./process.mjs";
import { readMeta, writeDiffArtifact, writeReview as writeRegistryReview } from "./registry.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderTaskResult,
} from "./render.mjs";
import {
  BRIDGE_VERSION,
  DEFAULT_STATUS_POLL_INTERVAL_MS,
  DEFAULT_STATUS_WAIT_TIMEOUT_MS,
  REVIEW_SCHEMA,
  ROOT_DIR,
  SCRIPT_PATH,
  STOP_REVIEW_TASK_MARKER,
} from "./runtime-paths.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV,
} from "./tracked-jobs.mjs";
import {
  mapReviewVerdictToTaskVerdict,
  normalizeAdversarialReviewResult,
  normalizeNativeReviewResult,
} from "./review-result.mjs";
import { generateJobId, listJobs, upsertJob, writeJobFile } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export function mirrorDiffToRegistry(taskId, diffPath) {
  if (!taskId || !diffPath) return null;
  try {
    if (!fs.existsSync(diffPath)) return null;
    return writeDiffArtifact(taskId, fs.readFileSync(diffPath, "utf8"));
  } catch {
    return null;
  }
}

export function buildTurnErrorNextAction({ origin, errorCode, threadId, jobId = null, cwd = null, stateCwd = null }) {
  const target = jobId ?? threadId;
  const jobCwd = stateCwd ?? cwd;
  if (origin === "upstream:response-chain-lost") {
    return {
      kind: "new-task",
      command: `${bridgeCommand("task", cwd)} --json --mode default "<prompt rebased on last good sha>"`,
      description: "The upstream response chain is dead; start a fresh task from committed state instead of sending on the same thread."
    };
  }
  if (origin === "upstream:auth" || errorCode === "Unauthorized") {
    return {
      kind: "reauth",
      command: "codex login",
      description: "Refresh Codex authentication, then relaunch the task; retrying the same thread will repeat the auth failure."
    };
  }
  if (origin === "upstream:transport") {
    return {
      kind: "retry-same-thread",
      command: threadId
        ? `${bridgeCommand("send", cwd)} ${threadId} "<same prompt>"`
        : `${bridgeCommand("task", cwd)} --json --mode default "<same prompt>"`,
      description: "The upstream stream dropped before completion; workspace state is unchanged, so retry the same thread once."
    };
  }
  if (origin === "idle" || errorCode === "ClientTimeout" || errorCode === "TurnTimeout") {
    return {
      kind: "relaunch-with-longer-timeouts",
      command: `${bridgeCommand("task", cwd)} --idle-timeout-ms 900000 --turn-default-ms 3600000 "<same prompt>"`,
      description: "A timeout budget expired; relaunch with a larger budget after confirming the original job is not still progressing."
    };
  }
  if (origin === "upstream:invalid-request") {
    return {
      kind: "new-task",
      command: `${bridgeCommand("task", cwd)} --json --mode default "<fixed prompt>"`,
      description: "Inspect the upstream validation error, fix the prompt/input shape, and launch a fresh task."
    };
  }
  if (target) {
    return {
      kind: "inspect-result",
      command: `${bridgeCommand("result", jobCwd)} ${target}`,
      description: "Inspect the persisted result and session log before deciding whether to retry or start fresh."
    };
  }
  return {
    kind: threadId ? "retry-with-revised-prompt" : "new-task",
    command: threadId
      ? `${bridgeCommand("send", cwd)} ${threadId} "<revised prompt>"`
      : `${bridgeCommand("task", cwd)} --json --mode default "<revised prompt>"`,
    description: threadId
      ? "Retry with an adjusted prompt, or cancel and start fresh."
      : "Start a fresh task with a revised prompt."
  };
}

export function prepareRuntimeSession(session, config, jobId) {
  if (!session) return session;
  session.redactSecrets = Boolean(config?.redact_secrets);
  writeSessionAliases(session, jobId);
  return session;
}

// Pending requests are persisted to disk by the worker process.
// The respond command reads from disk and writes a response file.
// See lib/pending-requests.mjs for the file-based IPC protocol.

export function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

export function rejectServerRequest(message, code, detail) {
  message._client?.rejectServerRequest?.(
    message.id,
    buildJsonRpcError(code, detail)
  );
}

export function createBridgeServerRequestHandler({ sessionDir, config, questionAnswerMs = null, cwd = null }) {
  return (message) => {
    const params = message.params ?? {};
    const threadId = params.threadId ?? "unknown";
    const session = findSession(sessionDir, threadId) ?? initSession(sessionDir, threadId);

    if (message.method !== "item/tool/requestUserInput") {
      logNdjson(session, "SERVER_REQUEST_UNSUPPORTED", message.method, {
        rpcRequestId: message.id,
        params
      });
      rejectServerRequest(message, -32601, `Unsupported server request: ${message.method}`);
      return;
    }

    const internalId = `req-${threadId.slice(-6)}-${Date.now().toString(36)}`;
    const entry = {
      internalId,
      rpcRequestId: message.id,
      method: message.method,
      threadId,
      firstQuestionId: params.questions?.[0]?.id ?? "q1",
      params,
      createdAt: Date.now(),
    };

    writePendingRequest(sessionDir, threadId, entry);
    logEvent(session, formatQuestionEvent(session, {
      requestId: internalId,
      questions: params.questions ?? [],
      scriptPath: SCRIPT_PATH,
      cwd,
    }));
    logNdjson(session, "QUESTION", message.method, { requestId: internalId, questions: params.questions });

    const timeoutMs =
      questionAnswerMs ??
      (Number(config.question_answer_ms) > 0 ? Number(config.question_answer_ms) : DEFAULT_CONFIG.question_answer_ms);
    return waitForResponse(sessionDir, threadId, timeoutMs, internalId).then((response) => {
      clearPendingRequest(sessionDir, threadId);
      if (response?.payload) {
        message._client?.resolveServerRequest?.(message.id, response.payload);
        logEvent(session, formatConfirmedEvent(session, { requestId: internalId }));
        logNdjson(session, "CONFIRMED", "serverRequest/resolved", { requestId: internalId });
        return;
      }
      rejectServerRequest(
        message,
        -32000,
        `requestUserInput timed out after ${timeoutMs}ms without an answer.`
      );
      logNdjson(session, "QUESTION_TIMEOUT", null, { requestId: internalId, timeoutMs });
    }).catch((error) => {
      clearPendingRequest(sessionDir, threadId);
      rejectServerRequest(message, -32000, error?.message ?? "requestUserInput response handling failed.");
    });
  };
}

// Appends a single-line handle footer to a rendered task result. Non-JSON
// foreground output previously surfaced only Codex's finalMessage, which gave
// orchestrators no visible jobId / events path — agents often grabbed the
// thread UUID from stderr `[codex] Thread ready (…)` progress lines because
// that was the most distinctive token they could see. The footer prints the
// canonical ids + a ready-to-paste `events` command so orchestrators can
// pick up the right handle without a `--json` + `jq` dance.

export function appendTaskFooter(rendered, { jobId, eventsPath, eventsDir, monitorCommand }) {
  if (!jobId) return rendered;
  const base = rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  // v1.3.0: the `.events` folder is now a first-class endpoint. Even if the
  // bridge CLI itself breaks, `tail -f` on the file path still streams the
  // heartbeat + terminal-tag record. Publishing the folder alongside the
  // file gives the caller one canonical place to find every running job's
  // observability stream.
  const parts = [`Job: ${jobId}`];
  if (eventsDir) parts.push(`Events dir: ${eventsDir}`);
  if (eventsPath) parts.push(`Events file: ${eventsPath}`);
  if (monitorCommand) parts.push(`Monitor: ${monitorCommand}`);
  return `${base}\n${parts.join(" · ")}\n`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

export function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

export function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new CliError(
      "Codex CLI is not installed or is missing required runtime support.",
      {
        class: "dependency_failed",
        code: "CODEX_UNAVAILABLE",
        retryable: false,
        suggestion: "Install Codex with `npm install -g @openai/codex`, then rerun `setup`."
      }
    );
  }
}

export function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

export function validateNativeReviewRequest(target, focusText, extras = {}) {
  if (focusText.trim()) {
    throw validationError(
      "`review` maps to the built-in reviewer and does not support custom focus text.",
      "REVIEW_FOCUS_UNSUPPORTED",
      `Retry with \`adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  // Native review uses Codex's app-server review prompt, which does not
  // accept the {{OPUS_CONCERNS}} placeholder. Reject --brief/--concern
  // explicitly so the orchestrator gets a clear redirect to
  // adversarial-review where those channels are honored.
  if (extras.brief) {
    throw validationError(
      "`review` does not accept --brief. The orchestrator-concerns channel is only honored by adversarial-review.",
      "REVIEW_BRIEF_UNSUPPORTED",
      "Retry with `adversarial-review --brief @<path>.json` to surface the brief's specific_concerns to the reviewer."
    );
  }
  if (Array.isArray(extras.opusConcerns) && extras.opusConcerns.length > 0) {
    throw validationError(
      "`review` does not accept --concern. The orchestrator-concerns channel is only honored by adversarial-review.",
      "REVIEW_CONCERN_UNSUPPORTED",
      "Retry with `adversarial-review --concern \"...\"` (repeatable) to surface focus areas to the reviewer."
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw validationError(
      "This `review` target is not supported by the built-in reviewer.",
      "REVIEW_TARGET_UNSUPPORTED",
      "Retry with `adversarial-review` for custom targeting."
    );
  }

  return nativeTarget;
}

export function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

export function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

export function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

export function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status === "completed"
    ) ?? null
  );
}

export async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

export async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw conflictError(
      `Task ${activeTask.id} is still running.`,
      "TASK_ALREADY_RUNNING",
      `Run \`status ${activeTask.id}\` (or \`cancel ${activeTask.id}\`) before continuing.`
    );
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

export async function executeReviewRun(request) {
  const adapter = await resolveCommandAdapter({
    cwd: request.cwd,
    workspaceRoot: resolveWorkspaceRoot(request.cwd),
    backend: request.backend ?? null,
  });
  ensureCodexRuntimeAdapter(adapter);
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);
  const startedAt = Date.now();

  // Pre-resolve sessionDir so we can initSession the moment Codex gives us
  // a threadId — addresses `unexpected-bridge-observations/08` which
  // documented that `review` / `adversarial-review` produced ZERO session
  // artifacts (`.events`, `.ndjson`, `.plan.md`, `.review.json`), leaving
  // `bridge summary <review-tid>` and the Monitor tooling completely
  // blind to review threads.
  const reviewConfig = getBridgeConfig(request.cwd, resolveWorkspaceRoot(request.cwd));
  const reviewSessionDir = resolveSessionDir(reviewConfig.session_dir, resolveWorkspaceRoot(request.cwd));
  const logReviewTerminalEvent = (session, result, { reviewKind, targetLabel }) => {
    if (result.status === 0) {
      logEvent(session, formatDoneEvent(session, {
        duration: Math.round((Date.now() - startedAt) / 1000),
        diffStat: `${reviewKind} review completed: ${targetLabel}`,
        files: [],
        config: {
          model: request.model ?? reviewConfig.model,
          effort: reviewConfig.effort,
          modeFlow: reviewKind
        },
        diffPath: "not captured for review",
        scriptPath: SCRIPT_PATH,
        jobId: request.jobId ?? null,
        cwd: request.cwd
      }));
      return;
    }

    const classified = classifyError(result.error ?? { message: result.stderr || `${reviewKind} review failed.` });
    logEvent(session, formatErrorEvent(session, {
      errorCode: classified.code,
      message: classified.message,
      phase: classified.class,
      origin: "review",
      scriptPath: SCRIPT_PATH,
      jobId: request.jobId ?? null,
      cwd: request.cwd
    }));
  };

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });

  // Short-circuit: if the resolved target is the working tree and there are
  // actually no staged, unstaged, or untracked changes, refuse before spending
  // a Codex turn.
  // Only fires for working-tree targets (explicit --scope working-tree, or
  // --scope auto that fell through to working-tree). Branch-scope reviews can
  // legitimately have empty diffs and should run.
  if (target.mode === "working-tree") {
    const diffCheck = runCommand("git", ["diff", "--quiet"], { cwd: request.cwd });
    const stagedCheck = runCommand("git", ["diff", "--cached", "--quiet"], { cwd: request.cwd });
    const untrackedCheck = runCommand("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: request.cwd
    });
    if (
      diffCheck.status === 0 &&
      stagedCheck.status === 0 &&
      untrackedCheck.status === 0 &&
      untrackedCheck.stdout.trim() === ""
    ) {
      throw new CliError("No working-tree changes to review.", {
        class: "validation",
        code: "REVIEW_EMPTY_DIFF",
        retryable: false,
        suggestion:
          "Make a change (working tree or staged) before invoking `review`, or use --scope branch to review a branch vs base."
      });
    }
  }

  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText, {
      brief: request.brief,
      opusConcerns: request.opusConcerns,
    });
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      idleTimeoutMs: Number(reviewConfig.idle_timeout_ms) > 0 ? Number(reviewConfig.idle_timeout_ms) : DEFAULT_CONFIG.idle_timeout_ms,
      turnTimeoutMs: Number(reviewConfig.turn_default_ms) > 0 ? Number(reviewConfig.turn_default_ms) : DEFAULT_CONFIG.turn_default_ms,
      onProgress: request.onProgress
    });
    // Materialize session files for the review thread so `bridge summary`
    // and the Monitor tool can inspect it (fixes obs 08).
    if (result.threadId) {
      const reviewSession =
        findSession(reviewSessionDir, result.threadId) ??
        initSession(reviewSessionDir, result.threadId);
      logNdjson(reviewSession, "TURN_COMPLETED", "turn/completed", {
        turnId: result.turnId,
        status: result.status,
        reviewKind: "native",
        target,
      });
      logReviewTerminalEvent(reviewSession, result, {
        reviewKind: "native",
        targetLabel: target.label
      });
    }
    const reviewResult = result.status === 0
      ? normalizeNativeReviewResult({
          reviewText: result.reviewText,
          target,
          task_id: request.taskId ?? null,
          reviewed_branch_head_sha: request.reviewedBranchHeadSha ?? null,
        })
      : null;
    if (request.taskId && reviewResult) {
      writeRegistryReview(request.taskId, reviewResult);
    }
    const payload = {
      review: reviewName,
      target,
      review_result: reviewResult,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: payload.review_result?.summary ?? firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label,
      error: result.error ?? null
    };
  }

  const context = collectReviewContext(request.cwd, target);
  // Orchestrator concerns flow in via either:
  //  - request.opusConcerns: parsed from --concern <text> (repeatable) flags
  //    in handleReviewCommand, or
  //  - request.brief.specific_concerns: from --brief @path.json (T16/T26),
  //    which is the canonical channel when an outer orchestrator (Opus) is
  //    driving the loop and already has a structured brief on hand.
  const briefConcerns = Array.isArray(request.brief?.specific_concerns)
    ? request.brief.specific_concerns
    : [];
  const flagConcerns = Array.isArray(request.opusConcerns)
    ? request.opusConcerns
    : [];
  // De-dupe while preserving order. Brief concerns first (canonical), then
  // any extra ad-hoc concerns appended via --concern flags.
  const seen = new Set();
  const opusConcerns = [...briefConcerns, ...flagConcerns]
    .filter((c) => typeof c === "string" && c.trim().length > 0)
    .filter((c) => {
      const key = c.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const prompt = buildAdversarialReviewPrompt(ROOT_DIR, context, focusText, opusConcerns);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    idleTimeoutMs: Number(reviewConfig.idle_timeout_ms) > 0 ? Number(reviewConfig.idle_timeout_ms) : DEFAULT_CONFIG.idle_timeout_ms,
    turnTimeoutMs: Number(reviewConfig.turn_default_ms) > 0 ? Number(reviewConfig.turn_default_ms) : DEFAULT_CONFIG.turn_default_ms,
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const normalizedReviewResult = result.status === 0 && parsed.parsed && !parsed.parseError
    ? normalizeAdversarialReviewResult({
        payload: parsed.parsed,
        raw_output: parsed.rawOutput,
        target,
        task_id: request.taskId ?? null,
        reviewed_branch_head_sha: request.reviewedBranchHeadSha ?? null,
      })
    : null;
  if (request.taskId && normalizedReviewResult) {
    writeRegistryReview(request.taskId, normalizedReviewResult);
  }
  // Materialize session artifacts for the adversarial-review thread (obs 08):
  // .events + .ndjson for replay, .review.json for the structured findings
  // (finally gives `writeReview` a real caller — was phantom per obs 03).
  if (result.threadId) {
    const advSession =
      findSession(reviewSessionDir, result.threadId) ??
      initSession(reviewSessionDir, result.threadId);
    logNdjson(advSession, "TURN_COMPLETED", "turn/completed", {
      turnId: result.turnId,
      status: result.status,
      reviewKind: "adversarial",
      target,
      findingCount: Array.isArray(parsed.parsed?.findings)
        ? parsed.parsed.findings.length
        : null,
    });
    logReviewTerminalEvent(advSession, result, {
      reviewKind: "adversarial",
      targetLabel: context.target.label
    });
    if (parsed.parsed && !parsed.parseError) {
      try {
        writeSessionReview(advSession, parsed.parsed);
      } catch {
        // Review JSON persistence failures must not fail the command.
      }
    }
  }
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    review_result: normalizedReviewResult,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label,
    error: result.error ?? null
  };
}

export async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.stateCwd ?? request.cwd);
  const adapter = request.adapter ?? await resolveCommandAdapter({
    cwd: request.cwd,
    workspaceRoot,
    backend: request.backend ?? null,
    metaBackend: request.metaBackend ?? null,
    taskMetadata: request.taskMetadata ?? null,
    subagentType: request.subagentType ?? null,
  });
  ensureCodexRuntimeAdapter(adapter);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = request.resumeThreadId ?? null;
  if (!resumeThreadId && request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw notFoundError(
        "No previous Codex task thread was found for this repository.",
        "NO_RESUMABLE_THREAD",
        "Start a fresh task without --resume-last."
      );
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw validationError(
      "Provide a prompt, a prompt file, piped stdin, or use --resume-last.",
      "MISSING_PROMPT"
    );
  }

  // Forward every bridge-level field onto runAppServerTurn. Historically this
  // call only passed a small subset (`resumeThreadId, prompt, model, effort,
  // sandbox, onProgress, persistThread, threadName`) which silently dropped
  // `sandboxPolicy`, `collaborationMode`, `turnTimeoutMs`, `idleTimeoutMs`,
  // `onTurnStart`, `onItemCompleted`, `onServerRequest` whenever
  // `runBridgeTask` populated them — meaning `config.sandbox_policy`, the
  // plan-mode developer instructions, the 120 s idle watchdog, and the
  // `[QUESTION]` event pipeline were all inert on the `task` path. Forward
  // explicitly so the runBridgeTask → executeTaskRun contract is real.
  const dispatch = await adapter.dispatch(request.prompt, {
    cwd: request.cwd,
    jobId: request.jobId ?? null,
    sessionDir: request.sessionDir ?? null,
    model: request.model,
    effort: request.effort,
    mode: request.write ? "default" : "read-only",
    adapterOptions: {
      turnOptions: {
        resumeThreadId,
        defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
        model: request.model,
        effort: request.effort,
        sandbox: request.write ? "workspace-write" : "read-only",
        sandboxPolicy: request.sandboxPolicy ?? null,
        collaborationMode: request.collaborationMode ?? null,
        turnTimeoutMs: request.turnTimeoutMs ?? null,
        idleTimeoutMs: request.idleTimeoutMs ?? null,
        onTurnStart: request.onTurnStart ?? null,
        onItemCompleted: request.onItemCompleted ?? null,
        onServerRequest: request.onServerRequest ?? null,
        onProgress: request.onProgress,
        persistThread: true,
        threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
      }
    }
  });
  const result = dispatch.rawResult ?? dispatch;

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write),
    // V3.2: expose Codex error info so runForegroundCommand can map to exit codes
    // (Unauthorized → 4, ContextWindowExceeded → 6, ClientTimeout/Http → 7, ...).
    // result.error carries `codexErrorInfo` directly when Codex reports one.
    error: result.error ?? null,
    planDetected: result.planDetected,
    planText: result.planText
  };
}

export function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

export function safeRealPath(filePath) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function samePath(left, right) {
  return safeRealPath(left) === safeRealPath(right);
}

export function summarizeWorkingTreeState(state) {
  const files = [
    ...state.staged.map((file) => `staged:${file}`),
    ...state.unstaged.map((file) => `unstaged:${file}`),
    ...state.untracked.map((file) => `untracked:${file}`),
  ];
  const shown = files.slice(0, 20).join(", ");
  return files.length > 20 ? `${shown}, ... and ${files.length - 20} more` : shown;
}

export function requireTaskReviewContext(taskId, options = {}) {
  const meta = readMeta(taskId);
  if (!meta) {
    throw notFoundError(
      `no meta.json found for ${taskId}; run task --worktree-auto before reviewing with --task`,
      "TASK_NOT_FOUND",
    );
  }

  const worktree = meta.worktree && typeof meta.worktree === "object" && !Array.isArray(meta.worktree)
    ? meta.worktree
    : {};
  const worktreePath = worktree.path ?? meta.worktree_path ?? null;
  if (typeof worktreePath !== "string" || worktreePath.trim() === "") {
    throw validationError(
      `meta.json for ${taskId} is missing worktree.path; refusing to review the caller cwd`,
      "TASK_WORKTREE_PATH_MISSING",
    );
  }
  const branch = worktree.branch ?? meta.branch ?? meta.worktree_branch ?? null;
  if (typeof branch !== "string" || branch.trim() === "") {
    throw validationError(
      `meta.json for ${taskId} is missing worktree.branch; refusing to review an unbound target`,
      "TASK_WORKTREE_BRANCH_MISSING",
    );
  }

  const reviewCwd = path.resolve(worktreePath);
  if (options.cwd && !samePath(path.resolve(process.cwd(), options.cwd), reviewCwd)) {
    throw validationError(
      `--task ${taskId} resolves to ${reviewCwd}, but --cwd points to ${path.resolve(process.cwd(), options.cwd)}`,
      "TASK_CWD_CONFLICT",
      "Omit --cwd with --task, or pass the task worktree path recorded in meta.json.",
    );
  }

  const head = runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd: reviewCwd });
  if (head.error || head.status !== 0 || !head.stdout.trim()) {
    const detail = head.error?.message ?? head.stderr.trim() ?? `git exited with status ${head.status}`;
    throw validationError(
      `could not resolve reviewed branch HEAD for ${taskId} in ${reviewCwd}: ${detail}`,
      "TASK_REVIEW_HEAD_UNRESOLVED",
    );
  }
  const state = getWorkingTreeState(reviewCwd);
  if (state.isDirty) {
    throw validationError(
      `task worktree for ${taskId} is dirty; commit, discard, or rerun the task before task-bound review. Status: ${summarizeWorkingTreeState(state)}`,
      "TASK_WORKTREE_DIRTY",
      "Task-bound review binds verdicts to the reviewed branch HEAD, so staged, unstaged, or untracked worktree changes must not be left outside that commit.",
    );
  }

  return {
    taskId,
    meta,
    cwd: reviewCwd,
    base: options.base ?? worktree.base_ref ?? meta.base_ref ?? null,
    scope: options.scope ?? "branch",
    branch: branch.trim(),
    reviewedBranchHeadSha: head.stdout.trim(),
  };
}

export function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    // The stop-gate-review job is the only "rescue" surface: it's spawned by
    // the session-stop hook to verify the prior Claude turn before exit.
    // Pre-1.2.5 this label was applied to every user task as well, which
    // misled agents reading `status` into thinking the job was auto-created
    // to recover from something. Post-1.2.5 only stop-gate jobs carry
    // `kindLabel: "rescue-review"`; normal user tasks carry "task".
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn",
      kindLabel: "rescue-review"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    kindLabel: "task",
    summary: shorten(prompt || fallbackSummary)
  };
}

export function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check \`codex-bridge status ${payload.jobId}\` for progress.\n`;
}

export function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (jobClass === "review") return "review";
  if (jobClass === "task") return "task";
  // Historical fallthrough — callers pass a kindLabel explicitly now. This
  // only triggers for legacy job records that predate 1.2.5.
  return "job";
}

export function createCompanionJob({
  id = null,
  prefix,
  kind,
  title,
  workspaceRoot,
  jobClass,
  kindLabel,
  summary,
  write = false,
  ...extra
}) {
  return createJobRecord({
    id: id ?? generateJobId(prefix),
    kind,
    kindLabel: kindLabel ?? getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    ...extra
  });
}

export function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  // Progress is operator-channel: always stderr unless caller explicitly disables.
  // Keeps stdout clean for both JSON envelopes and rendered markdown.
  const stderr = options.stderr === false ? false : true;
  return {
    logFile,
    progress: createProgressReporter({
      stderr,
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

export function buildTaskJob(workspaceRoot, taskMetadata, write, options = {}) {
  return createCompanionJob({
    id: options.id ?? null,
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    kindLabel: taskMetadata.kindLabel ?? "task",
    summary: taskMetadata.summary,
    write,
    backend: options.backend ?? null,
    adapter_capabilities: options.adapterCapabilities ?? null,
    ...(options.worktree ? {
      registryTaskId: options.id ?? null,
      worktree: options.worktree,
      isolation_mode: options.worktree.isolation_mode,
    } : {})
  });
}

export function buildTaskRequest({
  cwd, stateCwd, model, effort, prompt, brief, write, readOnly, resumeLast, jobId, mode,
  idleTimeoutMs, noPipeline,
  turnPlanMs, turnDefaultMs, pipelineStageMs, pipelineTotalMs, questionAnswerMs,
  backend = null,
}) {
  const opt = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null);
  return {
    cwd,
    stateCwd: stateCwd ?? cwd,
    model,
    effort,
    prompt,
    brief: brief ?? null,
    write,
    readOnly: Boolean(readOnly),
    resumeLast,
    jobId,
    mode: mode ?? null,
    idleTimeoutMs: opt(idleTimeoutMs),
    turnPlanMs: opt(turnPlanMs),
    turnDefaultMs: opt(turnDefaultMs),
    pipelineStageMs: opt(pipelineStageMs),
    pipelineTotalMs: opt(pipelineTotalMs),
    questionAnswerMs: opt(questionAnswerMs),
    noPipeline: Boolean(noPipeline),
    backend: backend ?? null
  };
}

export function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return readPromptFileOrThrow(path.resolve(cwd, options["prompt-file"]));
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

export function readPromptFileOrThrow(absPath) {
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw notFoundError(`Prompt file not found: ${absPath}`, "PROMPT_FILE_NOT_FOUND");
    }
    if (err?.code === "EACCES" || err?.code === "EPERM") {
      throw new CliError(`Cannot read prompt file (permission denied): ${absPath}`, {
        class: "auth",
        code: "PROMPT_FILE_PERMISSION",
        retryable: false
      });
    }
    if (err?.code === "EISDIR") {
      throw validationError(`Prompt file path is a directory: ${absPath}`, "PROMPT_FILE_IS_DIRECTORY");
    }
    throw err;
  }
}

export function requireTaskRequest(prompt, resumeLast) {
  if (!String(prompt ?? "").trim() && !resumeLast) {
    throw validationError(
      "Provide a prompt, a prompt file, piped stdin, or use --resume-last.",
      "MISSING_PROMPT",
      "Example: `codex-bridge task --write \"Fix the auth bug\"`"
    );
  }
}

// Parse a positive-milliseconds CLI flag. Returns null when unset (so callers
// fall through to config → built-in default). Throws `usage` (exit 2) on a
// malformed value rather than silently ignoring it, so users notice typos
// immediately. The flag name is baked into the error message for grep-ability.

export function parsePositiveMsOption(flagName, raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw usageError(
      `${flagName} must be a positive number of milliseconds, got ${JSON.stringify(raw)}`
    );
  }
  return n;
}

// Back-compat shim so callers that still reference the old helper keep
// working. Delete in a future version once all call sites migrate.

export function parseIdleTimeoutMsOption(raw) {
  return parsePositiveMsOption("--idle-timeout-ms", raw);
}

// Accept either a bare millisecond integer (e.g. `5000`) or a human-friendly
// duration suffix (`5s`, `1500ms`, `2m`). Returns milliseconds. Used by the
// `--interval` flag on `status --watch` and the `--timeout-ms` flag on
// `await-artifact` so operators don't have to mentally convert "10 seconds"
// to "10000" every time. Bare integers are treated as milliseconds for
// backward compatibility with the rest of the CLI.

export function parseDurationOption(flagName, raw, { defaultMs = null } = {}) {
  if (raw == null || raw === "") return defaultMs;
  const str = String(raw).trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(str);
  if (!match) {
    throw usageError(
      `${flagName} must be a positive duration (e.g. "500ms", "10s", "2m"), got ${JSON.stringify(raw)}`
    );
  }
  const n = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  const multiplier = unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  const ms = n * multiplier;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw usageError(
      `${flagName} must be a positive duration, got ${JSON.stringify(raw)}`
    );
  }
  return ms;
}

export function persistFailureErrorInPayload(execution, command = null) {
  if (!execution || execution.exitStatus === 0) {
    return execution;
  }

  const errLike = execution.error ?? { message: `Codex turn failed (status ${execution.exitStatus}).` };
  const partial = errLike?.partial ?? null;
  const handoff = errLike?.handoff ?? null;
  const origin = errLike?.origin ?? null;
  const nextAction = errLike?.nextAction ?? null;
  const { error } = buildErrorEnvelope(classifyError(errLike), { command, partial, handoff, origin, nextAction });
  const payload =
    execution.payload && typeof execution.payload === "object" && !Array.isArray(execution.payload)
      ? execution.payload
      : {};

  return {
    ...execution,
    payload: {
      ...payload,
      error
    }
  };
}

export async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile
  });
  const command = options.command ?? null;
  const execution = await runTrackedJob(
    job,
    async () => persistFailureErrorInPayload(await runner(progress), command),
    { logFile }
  );

  // V3.2: Map Codex turn-level failures to semantic exit codes. The error object
  // from runAppServerTurn carries `codexErrorInfo` (Unauthorized,
  // ContextWindowExceeded, ...) which classifyError recognizes. If the turn
  // failed without typed info, classifyError falls through to internal/1.
  if (execution.exitStatus !== 0) {
    const errLike = execution.error ?? { message: `Codex turn failed (status ${execution.exitStatus}).` };

    if (options.json) {
      // Emit the error envelope on stdout; exit code is set by emitError.
      emitError(errLike, { json: true, command });
    } else {
      // Non-JSON path: render the job output (captures reasoning + diagnostics),
      // then set the mapped exit code via emitError's classifier.
      if (execution.rendered) {
        process.stdout.write(execution.rendered);
      }
      emitError(errLike, { json: false, command });
    }
    return execution;
  }

  emitSuccess(command, execution.payload, execution.rendered, {
    json: options.json,
    startedAt: options.startedAt
  });
  return execution;
}

export function spawnDetachedTaskWorker(cwd, workspaceRoot, jobId, logFile = null) {
  const scriptPath = SCRIPT_PATH;
  // Capture the detached child's stderr to a sibling of the per-job `.log`
  // so silent crashes (e.g. an uncaught exception before the first progress
  // message) leave a readable trail. Pre-v1.2.1 `stdio: "ignore"` swallowed
  // everything, which is what let the background-path session-file bug
  // ship undetected. The fd is dup'd into the child; we close our copy.
  let stdioConfig = "ignore";
  if (logFile) {
    try {
      const stderrPath = `${logFile}.worker.err`;
      const stderrFd = fs.openSync(stderrPath, "a");
      stdioConfig = ["ignore", "ignore", stderrFd];
    } catch {
      // Fall back to silent if the stderr file can't be opened — the spawn
      // itself must never fail because observability couldn't.
    }
  }
  const child = spawn(process.execPath, [
    scriptPath,
    "task-worker",
    "--cwd",
    cwd,
    "--workspace-root",
    workspaceRoot,
    "--job-id",
    jobId
  ], {
    cwd,
    env: process.env,
    detached: true,
    stdio: stdioConfig,
    windowsHide: true
  });
  child.unref();
  if (Array.isArray(stdioConfig) && typeof stdioConfig[2] === "number") {
    try { fs.closeSync(stdioConfig[2]); } catch { /* already dup'd */ }
  }
  return child;
}

export function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  // The worker reads this job record during startup; persist it before spawn
  // so a fast child cannot fail with JOB_NOT_FOUND.
  let child;
  try {
    child = spawnDetachedTaskWorker(cwd, job.workspaceRoot, job.id, logFile);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    const existingRecord = readStoredJob(job.workspaceRoot, job.id) ?? queuedRecord;
    const failedRecord = {
      ...existingRecord,
      status: "failed",
      phase: "failed",
      pid: null,
      logFile: existingRecord.logFile ?? logFile,
      request: existingRecord.request ?? request,
      completedAt,
      errorMessage
    };
    writeJobFile(job.workspaceRoot, job.id, failedRecord);
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      logFile: failedRecord.logFile,
      request: failedRecord.request,
      completedAt,
      errorMessage
    });
    throw error;
  }

  const spawnedPid = child.pid ?? null;
  const existingRecord = readStoredJob(job.workspaceRoot, job.id) ?? queuedRecord;
  if (existingRecord.status === "queued") {
    const spawnedRecord = {
      ...existingRecord,
      pid: spawnedPid,
      logFile: existingRecord.logFile ?? logFile,
      request: existingRecord.request ?? request
    };
    writeJobFile(job.workspaceRoot, job.id, spawnedRecord);
    upsertJob(job.workspaceRoot, {
      id: job.id,
      pid: spawnedRecord.pid,
      logFile: spawnedRecord.logFile,
      request: spawnedRecord.request
    });
  }

  // v1.3.0: surface the events directory in every launch payload so callers
  // have a canonical tail-able path even before the threadId-named file
  // exists. The raw `tail -f "$EVENTS_DIR"/<threadId>.events` works without
  // the bridge CLI being alive, which is the last-resort escape hatch when
  // the bridge itself is the thing that's broken.
  const resolvedSessionDir = resolveSessionDir(getBridgeConfig(cwd ?? null, job.workspaceRoot).session_dir, job.workspaceRoot);
  return {
    payload: {
      jobId: job.id,
      threadId: null,
      eventsPath: null,
      eventsDir: resolvedSessionDir,
      status: "queued",
      title: job.title,
      summary: job.summary,
      registryTaskId: job.registryTaskId ?? null,
      worktree: job.worktree ?? null,
      logFile,
      monitor: buildMonitorHint({ eventsPath: null, jobId: job.id, threadId: null, cwd: request.stateCwd ?? job.workspaceRoot })
    },
    logFile
  };
}

export async function runBridgeTask(request) {
  const stateCwd = request.stateCwd ?? request.cwd;
  const workspaceRoot = resolveWorkspaceRoot(stateCwd);
  const config = getBridgeConfig(request.cwd ?? null, workspaceRoot);
  const adapter = await resolveCommandAdapter({
    cwd: request.cwd ?? null,
    workspaceRoot,
    backend: request.backend ?? null,
    metaBackend: request.metaBackend ?? null,
    taskMetadata: request.taskMetadata ?? null,
    subagentType: request.subagentType ?? null,
  });
  ensureCodexRuntimeAdapter(adapter);
  const sessionDir = resolveSessionDir(config.session_dir, workspaceRoot);

  // Override params based on config. Request-level `mode` (from --mode) wins over config.yaml.
  const effectiveMode = request.mode ?? config.mode ?? "plan";
  const isPlanMode = effectiveMode === "plan" && !request.resumeLast;

  // When `skip_meta_skills` is on, prepend a directive instructing Codex to
  // bypass any internal planning / ceremony / meta-skill chain it would
  // normally walk before execution. Framework-agnostic — covers any skill
  // chain that produces spec or plan scaffolding (under paths like `docs/`,
  // `plans/`, `specs/`, or similar) before touching the deliverable. These
  // routinely burn token budget on artifacts that aren't part of the task
  // when an orchestrator is already driving the plan/execute loop. Mode-
  // aware: plan-mode turns keep the "produce a concise plan" intent (the
  // directive must not contradict it); execute turns get the full "execute
  // directly" wording. Advisory only — Codex may still invoke its own
  // skills, and users who run without an orchestrator should set
  // `skip_meta_skills: false`.
  const metaSkillsPreamble =
    "[ORCHESTRATOR DIRECTIVE] Do not invoke your own planning, brainstorming, " +
    "ceremony, or meta-skill chains before execution. Do not create scaffold " +
    "files (spec documents, plan documents, design memos) under paths like " +
    "`docs/`, `plans/`, `specs/`, or similar before touching the deliverable — " +
    "unless the task explicitly asks for such an artifact as its output.";
  const metaSkillsPrefix = config.skip_meta_skills
    ? (isPlanMode
        ? `${metaSkillsPreamble} The calling orchestrator is already driving the plan/execute loop; produce a concise inline [PLAN] and stop — the orchestrator approves before execution.\n\n`
        : `${metaSkillsPreamble} The calling orchestrator has already planned this task; your job is to execute it directly.\n\n`)
    : "";
  const baseTaskPrompt = request.resumeLast && !String(request.prompt ?? "").trim()
    ? DEFAULT_CONTINUE_PROMPT
    : (request.prompt ?? "");
  const taskPrompt = appendRenderedBriefToPrompt(baseTaskPrompt, request.brief ?? null);

  // Append prompt footer from config (instructs Codex to use requestUserInput tool)
  const promptWithFooter = config.prompt_footer
    ? `${metaSkillsPrefix}${taskPrompt}\n\n${config.prompt_footer}`
    : `${metaSkillsPrefix}${taskPrompt}`;

  const activeMode = isPlanMode ? "plan" : "default";
  const developerInstructions = loadDeveloperInstructions(activeMode);

  // Circuit-breaker state for headless-environment probe loops. The user's
  // swift-vibescroll session captured 24 osascript/display-dialog attempts
  // before manual kill; bridge-side convergence is the only observation
  // point outside the Codex ReAct loop. Config-gated via
  // `command_failure_circuit_breaker`.
  //
  // v1.2.2: sliding-window + wrapper-detection. Pre-1.2.2 "3 consecutive
  // same-family failures" missed real Codex flailing because Codex wraps
  // failing commands in `& sleep N; kill -TERM $!` constructs that exit 0
  // — the consecutive counter reset on every wrapper and never reached
  // the threshold (see `07-orchestration/07` scenario 7+). The fix:
  //   A. Sliding window — count fails of the current family within the
  //      last WINDOW_SIZE commandExecutions (same or different family).
  //   B. Wrapper detector — if the command matches a monitored family AND
  //      the shell text contains a known failure-hiding construct
  //      (`& kill`, `|| true`, `|| exit 0`, `; true` at end), count it as
  //      failed regardless of exit code.
  const CIRCUIT_BREAKER_THRESHOLD = 3;
  const CIRCUIT_BREAKER_WINDOW = 5;
  const breakerState = {
    recent: [],  // [{family, failed}] ring, trimmed to WINDOW entries
    tripped: false,
  };
  const detectCommandFamily = (command) => {
    if (typeof command !== "string") return null;
    const trimmed = command.trim();
    if (!trimmed) return null;
    // Order-sensitive: **content-based** patterns first so that a payload
    // like `osascript -e 'display dialog "…"'` is recognized as its most
    // specific family (`applescript-dialog`) rather than the broader
    // `osascript` umbrella. AppleScript is almost always run *via*
    // `osascript -e`, so without this ordering the subfamilies would be
    // unreachable.
    if (/\bdisplay dialog\b|\bdisplay notification\b/i.test(trimmed)) return "applescript-dialog";
    if (/\bSystem Events\b|\btell application\b/i.test(trimmed)) return "applescript-system";
    if (/^computer-use\/|^tool:\s*computer-use/i.test(trimmed)) return "computer-use";
    if (/^\s*open\s+-a\b/i.test(trimmed)) return "open-app";
    if (/^\/bin\/zsh.*osascript\b|^osascript\b|\bosascript\s+-[eJl]\b/i.test(trimmed)) return "osascript";
    return null;
  };
  // True if the command looks like it's hiding a failure in the underlying
  // invocation. Scoped tight so ordinary `cp foo bar || true` (unmonitored
  // family) doesn't trigger — this is only consulted after `detectCommand-
  // Family` returns a monitored family, so false positives on unrelated
  // commands are impossible.
  const isFailureHidingWrapper = (command) => {
    if (typeof command !== "string") return false;
    // `& ... kill` widened: real Codex wrapper forms include
    // `... & pid="$!"; sleep 2; kill -TERM $pid; wait $pid` — there can
    // be a `pid=...;` assignment between the `&` and the `kill`. Regex:
    // single `&` (not `&&`), then up to 200 chars of anything, then a
    // `kill` word. Excludes `foo && kill bar` (double-ampersand means
    // "after success" — `kill` is intentional, not hiding a failure).
    return (
      /(?:^|[^&])&(?![&])[\s\S]{0,200}?\bkill\b/.test(command) ||
      /\|\|\s*(true|exit\s+0)\b/.test(command) ||
      /;\s*true\s*['"]?\s*$/.test(command)
    );
  };

  const bridgeRequest = {
    ...request,
    adapter,
    sessionDir,
    prompt: promptWithFooter,
    collaborationMode: isPlanMode
      ? buildCollaborationMode("plan", config, { developerInstructions })
      : request.write
        ? buildCollaborationMode("default", config, { developerInstructions, effort: request.effort })
        : null,
    // Always resolve through buildSandboxPolicy so `config.sandbox_policy`
    // wins regardless of plan/write flags. When no override is set, the
    // mode-derived default applies (plan → readOnly, --write → workspaceWrite,
    // plain exec → readOnly).
    //
    // `request.readOnly` is the one explicit override that bypasses
    // `config.sandbox_policy` entirely. Used by the stop-time review-gate
    // hook to guarantee the gate-time review can never mutate the repo even
    // when the user has set `sandbox_policy: danger-full-access`. The Stop
    // hook only ALLOWs/BLOCKs the previous turn — it must not double as a
    // license to write at session shutdown.
    sandboxPolicy: request.readOnly
      ? { type: "readOnly" }
      : buildSandboxPolicy(
          isPlanMode || !request.write ? "plan" : "default",
          config
        ),
    effort: isPlanMode ? "xhigh" : (request.effort ?? config.effort ?? "high"),
    // Turn timeout resolution (most specific wins): CLI flag → config.yaml
    // key → built-in default. Plan and execute turns use separate budgets
    // because plan is a bounded reasoning exercise while execute spans the
    // actual code changes. Pre-1.2.5 these were hard-coded (300 000 / 600 000);
    // large scaffolds legitimately needed more than 10 min of execute time
    // and were getting interrupted.
    turnTimeoutMs: isPlanMode
      ? (request.turnPlanMs ?? (Number(config.turn_plan_ms) > 0 ? Number(config.turn_plan_ms) : 1_800_000))
      : (request.turnDefaultMs ?? (Number(config.turn_default_ms) > 0 ? Number(config.turn_default_ms) : 1_800_000)),
    // Resolution order: --idle-timeout-ms flag → config.yaml `idle_timeout_ms`
    // → 300_000 fallback. 300s default covers reasoning-heavy turns between
    // `item.completed` notifications; see config.mjs DEFAULT_CONFIG comment.
    idleTimeoutMs: Number(request.idleTimeoutMs) > 0
      ? Number(request.idleTimeoutMs)
      : (Number(config.idle_timeout_ms) > 0 ? Number(config.idle_timeout_ms) : 300_000),
    onTurnStart: (info) => {
      // Heartbeat wiring (v1.3.0). Once we know the threadId we can write
      // [HEARTBEAT] blocks to `.events` on a fixed cadence regardless of
      // Codex activity. This guarantees the observability channel is never
      // silent longer than the heartbeat interval — even during long quiet
      // reasoning, and even if a downstream error path forgets to emit an
      // [ERROR] tag on exit (the top-level try/finally below is the
      // ultimate backstop). Interval is 60s by default, overridable via
      // CODEX_BRIDGE_HEARTBEAT_MS (milliseconds, positive integer).
      heartbeatState.session = prepareRuntimeSession(
        findSession(sessionDir, info.threadId) ?? initSession(sessionDir, info.threadId),
        config,
        request.jobId ?? null,
      );
      heartbeatState.phase = isPlanMode ? "plan" : "execute";
      heartbeatState.turnTimeoutMs = info.turnParams?.turnTimeoutMs ?? heartbeatState.turnTimeoutMs;
      startHeartbeat();
      startCheckpoint();
      // Reuse the session the heartbeat wiring just resolved — one
      // findSession/initSession call per turn, not two, so we don't re-init
      // the session file + ndjson stream under the heartbeat's nose.
      const s = heartbeatState.session;
      // Reset per-turn circuit-breaker state. A fresh turn starts with no
      // failure history; a previous turn's tripped state should not carry
      // across (e.g. a plan turn that tripped then an execute turn).
      breakerState.recent.length = 0;
      breakerState.tripped = false;
      logNdjson(s, "TURN_PARAMS", "turn/start", {
        model: info.turnParams.model,
        effort: info.turnParams.effort,
        collaborationMode: info.turnParams.collaborationMode,
        sandboxPolicy: info.turnParams.sandboxPolicy,
        hasOutputSchema: Boolean(info.turnParams.outputSchema),
        promptLength: info.promptLength,
        promptPreview: info.promptPreview
      });
      // First-event surface for the *effective* runtime config — lets a
      // reviewer answer "what config did this run actually use?" from the
      // events file alone, without tailing ndjson. Critical for invisible
      // directives like `skip_meta_skills` that shape the prompt but
      // otherwise emit nothing.
      try {
        const sandboxType = info.turnParams.sandboxPolicy?.type ?? "unknown";
        const pipelineEnabled = [];
        if (config.auto_review) pipelineEnabled.push("review");
        if (config.post_task_prompt) pipelineEnabled.push("check");
        if (request.noPipeline) pipelineEnabled.length = 0;
        logEvent(s, formatDirectivesEvent(s, {
          mode: isPlanMode ? "plan" : "default",
          effort: info.turnParams.effort ?? "?",
          sandbox: sandboxType,
          quiet: request.onProgress == null,
          skipMetaSkills: Boolean(config.skip_meta_skills),
          pipelineEnabled,
          model: info.turnParams.model ?? null,
        }));
      } catch {
        // Never let an observability event kill the turn.
      }
    },
    onItemCompleted: (item, { threadId }) => {
      // Persist a minimal record per completed item so `summary` can replay
      // a per-turn transcript. Slices are intentionally tight; see
      // `references/ndjson-guide.md`.
      const effectiveThreadId = threadId ?? null;
      if (!effectiveThreadId) return;
      const s = prepareRuntimeSession(
        findSession(sessionDir, effectiveThreadId) ?? initSession(sessionDir, effectiveThreadId),
        config,
        request.jobId ?? null,
      );
      logNdjson(s, "ITEM_COMPLETED", "item/completed", {
        itemId: item?.id ?? null,
        itemType: item?.type ?? null,
        text: extractItemText(item)
      });
      // Heartbeat metadata — next pulse will report which item type Codex
      // last finished, and how long ago, so silence on the wire still has
      // useful context.
      heartbeatState.lastItem = item?.type ?? null;
      heartbeatState.lastItemAt = Date.now();

      // Checkpoint accumulators (v1.3.0). The 5-min CHECKPOINT block
      // consolidates the last assistant message, the list of tool calls,
      // and the git delta so an orchestrator can catch up from one block
      // instead of scrolling every item. `actionable` means Codex DID
      // something (ran a command, changed a file, emitted a plan); pure
      // reasoning or empty assistant messages don't count. The stall
      // detector uses the actionable-count to find runs of 3 consecutive
      // barren checkpoints = 15 min with no measurable progress.
      try {
        const itemType = item?.type ?? null;
        if (itemType === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
          checkpointState.lastAssistantMessage = item.text;
        }
        // Summaries piggyback on extractItemText where the format already
        // matches — same slicing + file-change kind derivation, so checkpoint
        // output matches the NDJSON replay log.
        if (itemType === "commandExecution") {
          checkpointState.tools.push({
            type: "commandExecution",
            summary: extractItemText(item) ?? "",
          });
          checkpointState.actionableCount += 1;
          checkpointState.seenFirstActionable = true;
        } else if (itemType === "fileChange") {
          checkpointState.tools.push({
            type: "fileChange",
            summary: extractItemText(item) ?? "(unknown)",
          });
          checkpointState.actionableCount += 1;
          checkpointState.seenFirstActionable = true;
        } else if (itemType === "plan") {
          checkpointState.tools.push({
            type: "plan",
            summary: extractItemText(item) ?? "(plan)",
          });
          checkpointState.actionableCount += 1;
          checkpointState.seenFirstActionable = true;
        }
      } catch {
        // Accumulator failures must not kill the turn.
      }

      // Circuit breaker — detect repeated same-family command failures that
      // indicate the environment is structurally incapable of the probe
      // (e.g. headless box attempting `osascript` to drive Terminal.app).
      if (
        !config.command_failure_circuit_breaker ||
        breakerState.tripped ||
        item?.type !== "commandExecution"
      ) {
        return;
      }
      // Only monitored families enter the sliding window. An unmonitored
      // failure (e.g. `npm test` between two osascript probes) neither
      // resets nor shields the breaker — it's simply ignored.
      const family = detectCommandFamily(item.command);
      if (!family) return;

      const rawFailed = item.status !== "completed" || (typeof item.exitCode === "number" && item.exitCode !== 0);
      // Wrapper detection: a monitored-family command that exits 0 but
      // contains a failure-hiding construct is treated as failed. This
      // catches Codex's `osascript ... & sleep 2; kill -TERM $!` pattern
      // observed live — the shell exits 0 because the `kill` succeeds,
      // but the underlying AppleScript still failed.
      const wrappedFailed = !rawFailed && isFailureHidingWrapper(item.command);
      const failed = rawFailed || wrappedFailed;

      breakerState.recent.push({ family, failed });
      if (breakerState.recent.length > CIRCUIT_BREAKER_WINDOW) {
        breakerState.recent.shift();
      }

      const familyFails = breakerState.recent.filter(r => r.family === family && r.failed).length;
      if (familyFails < CIRCUIT_BREAKER_THRESHOLD) return;

      breakerState.tripped = true;
      logEvent(s, formatWarningEvent(s, {
        reason: "command-family-circuit-breaker-tripped",
        family,
        threshold: CIRCUIT_BREAKER_THRESHOLD,
        sampleCommand: item.command,
        turnInterrupted: false
      }));
      logNdjson(s, "CIRCUIT_BREAKER", null, {
        family,
        threshold: CIRCUIT_BREAKER_THRESHOLD,
        windowSize: CIRCUIT_BREAKER_WINDOW,
        failsInWindow: familyFails,
        wrapperDetected: wrappedFailed,
        turnInterrupted: false
      });
    }
  };

  bridgeRequest.onServerRequest = createBridgeServerRequestHandler({
    sessionDir,
    config,
    questionAnswerMs: request.questionAnswerMs ?? null,
    cwd: request.cwd
  });

  // v1.3.0 — unconditional observability. The `.events` file is the contract
  // between the bridge and every caller (Monitor / events --follow / wait /
  // raw tail -f). Pre-1.3.0 the file was only written on "notable" events
  // (plan, done, error, pipeline stages) — silence on the wire meant either
  // "Codex is reasoning quietly" or "the bridge died without emitting a
  // terminal tag," and callers couldn't tell the difference. The heartbeat
  // interval below eliminates that ambiguity: any silence on `.events`
  // longer than ~90 s is now, by construction, a bug.
  //
  // The finally-backstop that follows the try-block is the ultimate safety
  // net — it verifies a terminal tag landed before runBridgeTask returns or
  // throws, and synthesizes an [ERROR] | UnhandledExit block otherwise.
  // This means every future error branch (existing or newly added) is
  // covered without having to instrument it explicitly.
  const heartbeatState = {
    session: null,
    startTime: Date.now(),
    phase: isPlanMode ? "plan" : "execute",
    lastItem: null,
    lastItemAt: null,
    turnTimeoutMs: null,
  };
  let heartbeatTimer = null;
  const HEARTBEAT_INTERVAL_MS =
    Number(process.env.CODEX_BRIDGE_HEARTBEAT_MS) > 0
      ? Number(process.env.CODEX_BRIDGE_HEARTBEAT_MS)
      : 60_000;

  // v1.3.0 — 5-min CHECKPOINT digest and 15-min stall detector.
  // The orchestrator's only channel back is the Monitor tool stream over
  // `.events`. Heartbeat (60 s) proves liveness; checkpoint (5 min) is the
  // semantic summary an orchestrator needs to stay oriented. Three
  // consecutive barren checkpoints (15 min with zero "actionable" items —
  // no commands, no file changes, no plans) fires a terminal
  // `[ERROR] | StallDetected` so the Monitor self-terminates and the
  // orchestrator gets the signal.
  const CHECKPOINT_INTERVAL_MS =
    Number(process.env.CODEX_BRIDGE_CHECKPOINT_MS) > 0
      ? Number(process.env.CODEX_BRIDGE_CHECKPOINT_MS)
      : 5 * 60 * 1000;
  const STALL_CHECKPOINT_THRESHOLD =
    Number(process.env.CODEX_BRIDGE_STALL_CHECKPOINTS) > 0
      ? Number(process.env.CODEX_BRIDGE_STALL_CHECKPOINTS)
      : 3;
  let checkpointTimer = null;
  let checkpointInFlight = false;
  // `terminalEmitted` is flipped by every explicit terminal-tag write
  // (stall, PLAN, DONE, ERROR, INCOMPLETE) and handled non-error exits that
  // intentionally skip terminal error emission (workspace-dirty). The
  // finally-backstop reads this flag instead of scanning the events file —
  // O(1) vs reading a multi-MB log.
  let terminalEmitted = false;
  const markTerminalEmitted = () => { terminalEmitted = true; };
  const checkpointState = {
    startTime: Date.now(),
    lastCheckpointAt: Date.now(),
    intervalMs: CHECKPOINT_INTERVAL_MS,
    lastHead: null,           // git HEAD at last checkpoint (or turn start)
    startHead: null,          // git HEAD at turn start (for since-start diff)
    lastAssistantMessage: null,
    tools: [],                // pushed by onItemCompleted
    actionableCount: 0,       // reset every checkpoint
    barrenCheckpoints: 0,     // consecutive checkpoints with actionableCount == 0
    seenFirstActionable: false, // gate for barren-counter start (prevents false stall on slow-to-start turns)
  };
  // Checkpoint git helpers. Always run in the task's cwd; refuse to run if
  // no cwd was passed (otherwise spawnSync falls back to the bridge's own
  // cwd and reports git info for the wrong repo — silent miscoloring of
  // checkpoint output).
  const gitCwd = request.cwd && typeof request.cwd === "string" ? request.cwd : null;
  const readGitHead = () => {
    if (!gitCwd) return null;
    try {
      const r = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: gitCwd,
        encoding: "utf8",
        timeout: 5_000,
      });
      return r.status === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  };
  const readGitLogRange = (from, to) => {
    if (!gitCwd || !from || !to || from === to) return [];
    try {
      // Bound output at 50 commits — a range spanning thousands of commits
      // would otherwise return a multi-MB buffer through spawnSync. 50 is
      // enough for a checkpoint digest; the full log is always reachable
      // via `git log` directly in the cwd.
      const r = spawnSync(
        "git",
        ["log", "--no-color", "--no-decorate", "-n", "50", "--pretty=%h %s", `${from}..${to}`],
        { cwd: gitCwd, encoding: "utf8", timeout: 5_000 }
      );
      if (r.status !== 0) return [];
      return r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const sp = l.indexOf(" ");
          return sp < 0
            ? { sha: l, subject: "" }
            : { sha: l.slice(0, sp), subject: l.slice(sp + 1) };
        });
    } catch {
      return [];
    }
  };
  const readGitDiffStat = (from, to) => {
    if (!gitCwd || !from || !to || from === to) return null;
    try {
      const r = spawnSync("git", ["diff", "--shortstat", `${from}..${to}`], {
        cwd: gitCwd,
        encoding: "utf8",
        timeout: 5_000,
      });
      return r.status === 0 ? (r.stdout.trim() || null) : null;
    } catch {
      return null;
    }
  };
  const startHeartbeat = () => {
    if (heartbeatTimer || !heartbeatState.session) return;
    heartbeatTimer = setInterval(() => {
      try {
        const now = Date.now();
        const elapsed = now - heartbeatState.startTime;
        const budgetRemaining =
          Number.isFinite(heartbeatState.turnTimeoutMs) && heartbeatState.turnTimeoutMs > 0
            ? heartbeatState.turnTimeoutMs - elapsed
            : null;
        logEvent(
          heartbeatState.session,
          formatHeartbeatEvent(heartbeatState.session, {
            elapsedMs: elapsed,
            phase: heartbeatState.phase,
            lastItem: heartbeatState.lastItem,
            lastItemAgeMs: heartbeatState.lastItemAt ? now - heartbeatState.lastItemAt : null,
            pid: process.pid,
            jobId: request.jobId ?? null,
            budgetRemainingMs: budgetRemaining,
            scriptPath: SCRIPT_PATH,
            cwd: stateCwd,
            assistantPreview: checkpointState.lastAssistantMessage,
          })
        );
      } catch {
        // A logging failure must not kill the turn. If the events file
        // is gone or unwritable, the caller will notice via their own
        // Monitor timeout.
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
  };
  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const runCheckpoint = () => {
    if (!heartbeatState.session) return;
    if (checkpointInFlight) return;  // re-entrancy guard across slow git shell-outs
    checkpointInFlight = true;
    try {
      const now = Date.now();
      const elapsedMs = now - heartbeatState.startTime;
      const intervalMs = now - checkpointState.lastCheckpointAt;
      const currentHead = readGitHead();
      const fromHead = checkpointState.lastHead ?? checkpointState.startHead;
      const commits = fromHead && currentHead ? readGitLogRange(fromHead, currentHead) : [];
      const diffStat =
        fromHead && currentHead ? readGitDiffStat(fromHead, currentHead) : null;
      const filesChangedSinceStart =
        checkpointState.startHead && currentHead
          ? readGitDiffStat(checkpointState.startHead, currentHead)
          : null;

      // Skip emission when the interval was fully empty AND no git delta —
      // a [CHECKPOINT] block with only "(none)" placeholders adds noise and
      // still costs a git log / diff spawn. Heartbeat already proves
      // liveness at 60s; checkpoint's value is the *content*. Keep
      // accumulators fresh and still advance the barren counter so stall
      // detection works.
      const hasContent =
        checkpointState.actionableCount > 0 ||
        Boolean(checkpointState.lastAssistantMessage) ||
        commits.length > 0 ||
        Boolean(diffStat);

      if (hasContent) {
        try {
          // Transfer ownership of the tools buffer instead of slice() —
          // saves an allocation and copy per checkpoint on long runs.
          const toolsSnapshot = checkpointState.tools;
          checkpointState.tools = [];
          logEvent(
            heartbeatState.session,
            formatCheckpointEvent(heartbeatState.session, {
              elapsedMs,
              phase: heartbeatState.phase,
              intervalMs,
              pid: process.pid,
              jobId: request.jobId ?? null,
              lastAssistantMessage: checkpointState.lastAssistantMessage,
              tools: toolsSnapshot,
              commits,
              diffStat,
              filesChangedSinceStart,
              scriptPath: SCRIPT_PATH,
              cwd: stateCwd,
            })
          );
          logNdjson(heartbeatState.session, "CHECKPOINT", null, {
            elapsedMs,
            intervalMs,
            actionableCount: checkpointState.actionableCount,
            barrenCheckpoints: checkpointState.barrenCheckpoints,
            toolCount: toolsSnapshot.length,
            commitsInInterval: commits.length,
          });
        } catch {
          // Logging failure must not kill the turn.
        }
      }

      // Stall detector: a checkpoint window with zero actionable items means
      // Codex did no commands, no file changes, and no plans. Heartbeats
      // guarantee liveness (so Codex isn't crashed — just reasoning without
      // acting), but several consecutive such windows means no measurable
      // progress and the orchestrator should step in.
      //
      // Grace period: don't count barren windows before the first actionable
      // item has ever landed. Otherwise a slow-to-start turn (long plan-mode
      // reasoning before a single plan item) fires StallDetected at 15 min
      // even though everything is fine.
      if (checkpointState.seenFirstActionable) {
        if (checkpointState.actionableCount === 0) {
          checkpointState.barrenCheckpoints += 1;
        } else {
          checkpointState.barrenCheckpoints = 0;
        }
      }
      if (
        checkpointState.barrenCheckpoints >= STALL_CHECKPOINT_THRESHOLD &&
        !terminalEmitted
      ) {
        try {
          const stallWindowMs = CHECKPOINT_INTERVAL_MS * STALL_CHECKPOINT_THRESHOLD;
          logEvent(
            heartbeatState.session,
            formatErrorEvent(heartbeatState.session, {
              errorCode: "StallDetected",
              message:
                `No actionable items (commandExecution / fileChange / plan) in ${STALL_CHECKPOINT_THRESHOLD} consecutive ` +
                `${Math.round(CHECKPOINT_INTERVAL_MS / 60000)}-minute checkpoints ` +
                `(${Math.round(stallWindowMs / 60000)} min total). Codex is alive (heartbeats present) but not making ` +
                `measurable progress. Cancel with \`cancel ${request.jobId ?? heartbeatState.session.threadId}\`, ` +
                `or steer the thread. Note: the Codex turn is still running — this terminal tag signals the orchestrator; ` +
                `the turn itself will not stop until you cancel it or hit the turn budget.`,
              phase: heartbeatState.phase ?? "execute",
              origin: "bridge",
              scriptPath: SCRIPT_PATH,
              jobId: request.jobId ?? null,
              cwd: request.cwd,
              stateCwd,
            })
          );
          logNdjson(heartbeatState.session, "ERROR", null, {
            errorCode: "StallDetected",
            origin: "bridge",
            barrenCheckpoints: checkpointState.barrenCheckpoints,
            windowMs: stallWindowMs,
          });
          terminalEmitted = true;
          // Stop the timers after emission — no point re-running git shell-
          // outs and re-checking a now-settled stall. Heartbeat stops too
          // because a stalled-but-still-running turn generates no new signal
          // worth sending. The Codex turn continues until the orchestrator
          // cancels (or the turn budget hits); the finally block handles
          // final cleanup either way.
          stopCheckpoint();
          stopHeartbeat();
        } catch {
          // Even a stall emission that fails silently is better than a crash.
        }
      }

      // Reset per-interval accumulators; preserve `startHead` (used for the
      // since-start diff summary in subsequent checkpoints). `tools` was
      // already cleared on snapshot when we emitted; clear it here too so
      // skipped-empty windows don't retain stale entries.
      checkpointState.lastCheckpointAt = now;
      checkpointState.lastHead = currentHead ?? checkpointState.lastHead;
      checkpointState.lastAssistantMessage = null;
      if (!hasContent) checkpointState.tools = [];
      checkpointState.actionableCount = 0;
    } finally {
      checkpointInFlight = false;
    }
  };
  const startCheckpoint = () => {
    if (checkpointTimer) return;
    // Capture the starting git HEAD once, when the turn begins. Subsequent
    // checkpoints diff from this (for since-start stats) and from the
    // previous checkpoint (for since-last-checkpoint stats).
    if (checkpointState.startHead == null) {
      checkpointState.startHead = readGitHead();
      checkpointState.lastHead = checkpointState.startHead;
    }
    checkpointTimer = setInterval(() => {
      try {
        runCheckpoint();
      } catch {
        // Interval failures must not kill the turn.
      }
    }, CHECKPOINT_INTERVAL_MS);
    checkpointTimer.unref?.();
  };
  const stopCheckpoint = () => {
    if (checkpointTimer) {
      clearInterval(checkpointTimer);
      checkpointTimer = null;
    }
  };

  let result;
  let session;
  // v1.5.0 — snapshot HEAD before the turn so the terminal-failure path can
  // report "commits landed before the error" via [PARTIAL]. Cheap (two git
  // spawns, 10s timeouts); silently returns an empty snapshot off a repo.
  const turnStartSnapshot = captureGitSnapshot(request.cwd);
  // v1.5.0 — retries recorded for the handoff envelope when the retry budget
  // is exhausted. Each entry: { attemptIso, origin, errorCode, backoffMs, outcome }.
  const retryHistory = [];
  try {
    // Run the task
    result = await executeTaskRun(bridgeRequest);

    // v1.5.0 — upstream-failure retry loop. See UPSTREAM_RETRY_POLICY in
    // cli-errors.mjs. Only `same-thread` strategies auto-retry in-place;
    // `new-thread` + `none` skip directly to handoff emission (the former
    // because an automated prompt rebase is unsafe; the latter because auth
    // failures are deterministic).
    while (result.exitStatus !== 0 && result.error) {
      const origin = classifyTurnErrorOrigin(result.error);
      const policy = getUpstreamRetryPolicy(origin);
      if (!policy || policy.strategy !== "same-thread" || retryHistory.length >= policy.maxAttempts) break;

      const attempt = retryHistory.length + 1;
      const backoffMs = policy.backoffMs[attempt - 1] ?? 2000;
      const errorCode = result.error?.codexErrorInfo ?? result.error?.code ?? classifyError(result.error).code;

      // [RETRYING] must surface on the events file for the thread that failed.
      // If we have a threadId, initialize or find its session and log there.
      if (result.threadId) {
        const retrySession = prepareRuntimeSession(initSession(sessionDir, result.threadId), config, request.jobId ?? null);
        logEvent(retrySession, formatRetryingEvent(retrySession, {
          attempt,
          maxAttempts: policy.maxAttempts,
          backoffMs,
          origin,
          strategy: policy.strategy,
          errorCode,
          reason: String(result.error?.message ?? result.error).slice(0, 200)
        }));
        logNdjson(retrySession, "RETRYING", null, { attempt, maxAttempts: policy.maxAttempts, backoffMs, origin, errorCode });
      }

      retryHistory.push({
        attemptIso: new Date().toISOString(),
        origin,
        errorCode,
        backoffMs,
        outcome: "pending"
      });

      if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));

      const retryResult = await executeTaskRun({
        ...bridgeRequest,
        resumeThreadId: result.threadId ?? bridgeRequest.resumeThreadId ?? null
      });
      if (retryResult.exitStatus === 0 || !retryResult.error) {
        retryHistory[retryHistory.length - 1].outcome = "success";
        result = retryResult;
        break;
      }
      retryHistory[retryHistory.length - 1].outcome = "failed";
      result = retryResult;
    }

    // Create session for post-processing
    session = prepareRuntimeSession(initSession(sessionDir, result.threadId), config, request.jobId ?? null);

  // Ready-to-paste Monitor hint — computed once, attached to every setPhase
  // branch below so synchronous callers never have to assemble one.
  const computedEventsPath = result.threadId ? path.join(sessionDir, `${result.threadId}.events`) : null;
  const monitor = buildMonitorHint({
    eventsPath: computedEventsPath,
    jobId: request.jobId ?? null,
    threadId: result.threadId ?? null,
    cwd: stateCwd
  });

  // Non-JSON foreground footer. Append a single handle-advertising line so
  // agents reading the rendered output in stdout see the canonical jobId +
  // events path + ready-to-paste Monitor command, instead of reaching for the
  // threadId pattern-matched from `[codex] Thread ready (…)` stderr lines.
  // Pre-1.2.5 the rendered output was just Codex's finalMessage, with no
  // handle surfaced — round-1 and round-2 delegations both showed agents
  // grabbing the thread UUID from stderr progress because nothing else stood
  // out. Prepending a trailing footer gives the orchestrator the right id
  // without having to run `--json` + `jq`.
  if (request.jobId && result.rendered && typeof result.rendered === "string") {
    result.rendered = appendTaskFooter(result.rendered, {
      jobId: request.jobId,
      eventsPath: computedEventsPath,
      eventsDir: sessionDir,
      monitorCommand: monitor?.command ?? null
    });
  }

  // Log turn completion. Note: `result` here is executeTaskRun's return, which
  // exposes the upstream turn status as `exitStatus` and puts `touchedFiles`
  // inside `payload`.
  logNdjson(session, "TURN_COMPLETED", "turn/completed", {
    turnId: result.turnId,
    status: result.exitStatus,
    planDetected: result.planDetected,
    touchedFiles: result.payload?.touchedFiles ?? [],
  });

  // V10.1: every return branch decorates `result.payload` with `phase` and
  // `next_action` so a synchronous `task --json` caller knows what to do next
  // without tailing `.events`.
  //
  // 1.2.5 additionally promotes `eventsPath` and `jobId` to payload
  // top-level. Previously the events file location was only reachable by
  // regex-parsing `payload.monitor.command`, which forced scripts to
  // string-slice CLI strings to find their own session-log file. Promoting
  // saves every caller the regex (see D6 in plan).
  const setPhase = (phase, nextAction, extras = {}) => {
    result.payload = {
      ...result.payload,
      phase,
      next_action: nextAction,
      eventsPath: computedEventsPath,
      eventsDir: sessionDir,
      jobId: request.jobId ?? null,
      ...extras
    };
  };

  if (result.exitStatus !== 0 && result.error) {
    const errorMessage = String(result.error.message ?? result.error);
    const origin = classifyTurnErrorOrigin(result.error);
    const codexErrorInfo = normalizeCodexErrorInfo(
      result.error.codexErrorInfo ?? result.error.codex_error_info ?? null
    );
    const classifiedTurnError = classifyError(result.error);
    // ClientTimeout stays the error code for the idle-watchdog branch so
    // downstream classifiers/exit-code mapping keep working; codexErrorInfo
    // still wins when the upstream classifier tagged the failure.
    const errorCode = origin === "idle" ? "ClientTimeout" : (codexErrorInfo?.code ?? classifiedTurnError.code ?? "CodexError");
    const touchedFiles = result.payload?.touchedFiles ?? [];

    // v1.5.0 — partial / handoff envelope assembly. Happens BEFORE the
    // `[ERROR]` block so readers see `[PARTIAL] … [HANDOFF] … [ERROR]` in
    // emission order. `[ERROR]` stays the terminal tag that trips Monitor.
    const upstreamRequestId = extractUpstreamRequestId(errorMessage);
    const partialDiff = diffGitSnapshot(request.cwd, turnStartSnapshot);
    let partialForEnvelope = null;
    if (partialDiff.commits.length > 0) {
      partialForEnvelope = {
        commits: partialDiff.commits,
        currentHeadSha: partialDiff.currentHeadSha,
        lastOkHeadSha: partialDiff.lastOkHeadSha,
        dirtyFiles: partialDiff.dirtyFiles,
        launchedAtIso: partialDiff.launchedAtIso,
      };
      logEvent(session, formatPartialEvent(session, {
        commits: partialDiff.commits,
        currentHeadSha: partialDiff.currentHeadSha,
        lastOkHeadSha: partialDiff.lastOkHeadSha,
        launchedAtIso: partialDiff.launchedAtIso,
        dirtyFiles: partialDiff.dirtyFiles,
        scriptPath: SCRIPT_PATH,
        jobId: request.jobId ?? null,
        cwd: request.cwd,
        stateCwd,
      }));
      logNdjson(session, "PARTIAL", null, {
        commits: partialDiff.commits,
        currentHeadSha: partialDiff.currentHeadSha,
        lastOkHeadSha: partialDiff.lastOkHeadSha,
        launchedAtIso: partialDiff.launchedAtIso,
      });
    }

    // Handoff envelope: emit when the failure is an upstream origin that
    // either exhausted its retry budget or has `strategy: "none"` (auth).
    // For non-upstream origins (idle, turn, pipeline:*, bridge:*), skip —
    // the existing cause-aware actions block already guides recovery.
    let handoffForEnvelope = null;
    const policyForOrigin = getUpstreamRetryPolicy(origin);
    const isUpstreamTerminal = Boolean(policyForOrigin);
    if (isUpstreamTerminal) {
      const eventsPath = path.join(sessionDir, `${session.threadId}.events`);
      const diffPath = path.join(sessionDir, `${session.threadId}.diff`);
      const planPath = path.join(sessionDir, `${session.threadId}.plan.md`);
      const reviewPath = path.join(sessionDir, `${session.threadId}.review.json`);
      const reason = policyForOrigin.strategy === "none"
        ? (origin === "upstream:auth" ? "upstream-auth-requires-reauth" : "upstream-no-retry-policy")
        : "upstream-retry-exhausted";
      handoffForEnvelope = buildHandoffEnvelope({
        classified: { origin, code: errorCode, message: errorMessage },
        reason,
        session: {
          jobId: request.jobId ?? null,
          threadId: session.threadId,
          sessionId: session.threadId,
        },
        artifacts: {
          eventsPath,
          workerErrPath: request.logFile ? `${request.logFile}.worker.err` : null,
          diffPath,
          planPath,
          reviewPath,
        },
        partial: partialForEnvelope,
        prompt: {
          original: request.prompt ?? null,
          promptFilePath: request.promptFilePath ?? null,
          resumeSuggestion: "Read eventsPath + diffPath; `git log --oneline <lastOkHeadSha>..HEAD`; relaunch with `task --json --mode default --prompt-file <rebuilt>` seeded with the last commit sha and remaining scope.",
        },
        retries: retryHistory,
        upstreamRequestId,
      });
      logEvent(session, formatHandoffEvent(session, {
        reason: handoffForEnvelope.reason,
        origin,
        errorCode,
        upstreamRequestId,
        session: { jobId: request.jobId ?? null, threadId: session.threadId },
        artifacts: handoffForEnvelope.artifacts,
        partial: partialForEnvelope,
        prompt: handoffForEnvelope.prompt,
        retries: retryHistory,
        scriptPath: SCRIPT_PATH,
        cwd: request.cwd,
        stateCwd,
      }));
      logNdjson(session, "HANDOFF", null, {
        reason: handoffForEnvelope.reason,
        origin,
        errorCode,
        upstreamRequestId,
      });
    }

    // Attach partial + handoff to the thrown-error surface so
    // `runForegroundCommand`'s `emitError` → `buildErrorEnvelope` can
    // propagate them into the JSON envelope under `error.partial` /
    // `error.handoff`. This is the single artifact orchestrators read to
    // continue work without tailing the events file.
    if (result.error && typeof result.error === "object") {
      if (partialForEnvelope) result.error.partial = partialForEnvelope;
      if (handoffForEnvelope) result.error.handoff = handoffForEnvelope;
    }

    // `workspace-dirty` phase: Codex produced a diff but the sandbox blocked
    // the final step (e.g. `workspace-write` refuses `.git/` writes so the
    // commit fails). Surface a distinct phase so the orchestrator can commit
    // the diff on Codex's behalf, rather than interpreting the run as total
    // failure. Triggered by `codexErrorInfo: "SandboxError"` with a non-empty
    // touched-files list. We flip `exitStatus` to 0 so `runForegroundCommand`
    // emits a success envelope carrying the phase — a sandbox-blocked commit
    // is actionable state, not a terminal failure.
    if (codexErrorInfo?.code === "SandboxError" && touchedFiles.length > 0) {
      // JSON.stringify for shell-safe quoting of the cwd path (matches the
      // pattern used in buildMonitorHint). Paths with spaces would otherwise
      // break the suggested command.
      const cwdArg = JSON.stringify(request.cwd);
      setPhase("workspace-dirty", {
        command: `git -C ${cwdArg} add -A && git -C ${cwdArg} commit -m "<subject>"`,
        description:
          "Codex produced a diff but the sandbox blocked the commit. Commit on Codex's behalf, or re-run with config.sandbox_policy: danger-full-access."
      }, { errorCode, touchedFiles, monitor, sandboxError: errorMessage });
      let dirtyDiff;
      try {
        dirtyDiff = captureGitDiff(request.cwd, session);
        mirrorDiffToRegistry(request.jobId ?? request.taskId ?? null, dirtyDiff.diffPath);
      } catch {
        dirtyDiff = { diffStat: `${touchedFiles.length} touched files`, diffPath: "" };
      }
      logEvent(session, formatIncompleteEvent(session, {
        diffStat: dirtyDiff.diffStat,
        diffPath: dirtyDiff.diffPath,
        verdict: "workspace-dirty",
        findingCount: touchedFiles.length,
        missingItems: [
          "Codex produced workspace changes, but the sandbox blocked the final commit. Commit the generated diff outside the sandbox."
        ],
        scriptPath: SCRIPT_PATH,
        jobId: request.jobId ?? null,
        cwd: request.cwd,
      }));
      markTerminalEmitted();
      return { ...result, session, exitStatus: 0, error: null };
    }

    logEvent(session, formatErrorEvent(session, {
      errorCode,
      message: errorMessage,
      phase: isPlanMode ? "plan" : "execution",
      origin,
      scriptPath: SCRIPT_PATH,
      jobId: request.jobId ?? null,
      upstreamRequestId,
      cwd: request.cwd,
    }));
    logNdjson(session, "ERROR", null, { errorCode, message: errorMessage, origin, upstreamRequestId });
    markTerminalEmitted();

    const nextAction = buildTurnErrorNextAction({
      origin,
      errorCode,
      threadId: result.threadId,
      jobId: request.jobId ?? null,
      cwd: request.cwd,
      stateCwd,
    });
    if (result.error && typeof result.error === "object") {
      result.error.origin = origin;
      result.error.nextAction = nextAction;
    }
    setPhase("error", nextAction, { errorCode, monitor });
    return { ...result, session };
  }

  // If plan was detected, write [PLAN] and plan file, then RETURN
  // (Claude Code will approve via send --mode default)
  if (result.planDetected && result.planText) {
    const planPath = writePlan(session, result.planText);
    const steps = extractPlanSteps(result.planText);
    logEvent(session, formatPlanEvent(session, {
      turnId: result.turnId,
      planTitle: result.planText.split("\n")[0]?.slice(0, 80) ?? "Plan",
      steps,
      planPath,
      scriptPath: SCRIPT_PATH,
      cwd: request.cwd,
    }));
    markTerminalEmitted();
    setPhase("plan-pending", {
      command: `${bridgeCommand("send", request.cwd)} ${result.threadId} --mode default "Implement the plan."`,
      description: "Approve the plan and switch to execution mode. To revise instead, drop --mode and send revision text."
    }, { planPath, planSteps: steps, monitor });
    return { ...result, session, planPath };
  }

  // If execution completed (not plan), run auto-pipeline. `--no-pipeline`
  // from the caller short-circuits the pipeline entirely — useful when the
  // orchestrator owns completion checking or simply wants a single-turn
  // execute with no silent review/fix passes behind it. Equivalent to
  // setting auto_review:false AND post_task_prompt:"" for this one run,
  // without requiring a config.yaml edit.
  if (request.noPipeline) {
    logNdjson(session, "PIPELINE_SKIPPED", null, { reason: "--no-pipeline flag" });
  }
  if (result.exitStatus === 0 && !request.noPipeline && (config.auto_review || config.post_task_prompt)) {
    const pipelineResult = await runAutoPipeline({
      session,
      threadId: result.threadId,
      cwd: request.cwd,
      config,
      scriptPath: SCRIPT_PATH,
      rootDir: ROOT_DIR,
      runAppServerTurn,
      runAppServerReview,
      jobId: request.jobId ?? null,
      stateCwd,
      // Timeouts: CLI flag → config.yaml → built-in default, same pattern as
      // the turn/idle budgets. runAutoPipeline treats `null` as "use your own
      // resolution order" so we only pass resolved numbers when we have
      // them.
      stageTimeoutMs: request.pipelineStageMs
        ?? (Number(config.pipeline_stage_ms) > 0 ? Number(config.pipeline_stage_ms) : null),
      totalTimeoutMs: request.pipelineTotalMs
        ?? (Number(config.pipeline_total_ms) > 0 ? Number(config.pipeline_total_ms) : null),
    });
    if (pipelineResult?.complete === false) {
      // Branch on whether the pipeline FINISHED incomplete (Codex's check
      // stage returned `complete:false` with real missing items) or FAILED
      // (a stage threw, e.g. timeout / transport error). Both paths carry
      // `complete:false` but the right next-action differs — telling a
      // caller to `send … "Complete the missing items"` when the pipeline
      // actually timed out in the diff stage is actively misleading, per
      // `unexpected-bridge-observations/03-pipeline-incomplete-next-action-misleads-orchestrator.md`.
      const pipelineErrored = Boolean(pipelineResult.error);
      const failedStage =
        pipelineResult.failing_stage
        ?? (pipelineResult.completedStages?.length
          ? pipelineResult.completedStages[pipelineResult.completedStages.length - 1]
          : "diff");
      const nextAction = pipelineErrored
        ? {
            command: `${bridgeCommand("result", stateCwd)} ${request.jobId ?? result.threadId}`,
            description: `Pipeline stalled after stage '${failedStage}' (${pipelineResult.error}). Read result for partial state. If this keeps happening, set auto_review: false in config.yaml.`,
          }
        : {
            command: `${bridgeCommand("send", request.cwd)} ${result.threadId} "Complete the missing items"`,
            description: "Codex's completion check flagged gaps. Read [INCOMPLETE] in events for specifics.",
          };
      setPhase("incomplete", nextAction, { pipeline: pipelineResult, monitor });
    } else {
      setPhase("done", {
        command: `${bridgeCommand("result", stateCwd)} ${request.jobId ?? result.threadId}`,
        description: "Task finished and passed completion check. Inspect full result or send a follow-up."
      }, { pipeline: pipelineResult, monitor });
    }
    // `runAutoPipeline` emits one of [DONE] / [INCOMPLETE] / [ERROR] before
    // returning, regardless of which branch above we take — mark terminal
    // so the finally-backstop doesn't duplicate.
    markTerminalEmitted();
    return { ...result, session, pipeline: pipelineResult };
  }

  // No pipeline — write [DONE] directly
  const diff = captureGitDiff(request.cwd, session);
  mirrorDiffToRegistry(request.jobId ?? request.taskId ?? null, diff.diffPath);
  logEvent(session, formatDoneEvent(session, {
    duration: 0,
    diffStat: diff.diffStat,
    files: diff.files,
    config: { model: config.model, effort: config.effort, modeFlow: isPlanMode ? "plan→default" : "default" },
    diffPath: diff.diffPath,
    scriptPath: SCRIPT_PATH,
    jobId: request.jobId ?? null,
    cwd: request.cwd,
    stateCwd,
  }));
  markTerminalEmitted();
  setPhase("done", {
    command: `${bridgeCommand("result", stateCwd)} ${request.jobId ?? result.threadId}`,
    description: "Task finished. Inspect full result or send a follow-up."
  }, { diffPath: diff.diffPath, monitor });

    return { ...result, session, diff };
  } finally {
    // v1.3.0 — unconditional observability guarantees.
    //   1. The heartbeat pulse stops so we don't leak intervals or race
    //      future writes to a closed events file.
    //   2. If the turn exited without anything writing a terminal tag to
    //      `.events` — which can happen when an error throws past every
    //      existing branch (e.g. turn-timeout rejects `executeTaskRun`
    //      before any `logEvent(formatErrorEvent(...))` gets to run, which
    //      is exactly what left a live Phase-2 run with a 0-byte events
    //      file on 1.2.8) — we synthesize one here. The `[ERROR] |
    //      UnhandledExit` marker tells the caller the bridge exited
    //      ungracefully *and* identifies the class of bug so the fix
    //      lands on the missing branch instead of another patch round.
    stopHeartbeat();
    stopCheckpoint();
    // Backstop uses the in-process `terminalEmitted` flag instead of
    // reading the events file — O(1) vs potentially several MB of heartbeat
    // + checkpoint history on long runs. Every terminal-tag write site
    // (turn error, plan-pending, no-pipeline done, auto-pipeline done/incomplete/error,
    // stall-detector emission), plus handled non-error terminal exits such
    // as workspace-dirty, calls `markTerminalEmitted()`. Anything that
    // reaches the `finally` without flipping the flag is, by definition, an
    // un-instrumented exit path — the synthesized `UnhandledExit` marker
    // tells the caller exactly which run and serves as a standing request
    // to add the missing emit.
    //
    // Pre-threadId failures (executeTaskRun rejects before `onTurnStart`
    // fires) can't be rescued here — we don't know which threadId's events
    // file to write to. In that case `backstopSession` is null and we let
    // the original error propagate; the `~/.codex-bridge/crashes/` handler
    // (installed at process startup) catches the underlying exception.
    const backstopSession = heartbeatState.session ?? session ?? null;
    if (!terminalEmitted && backstopSession && backstopSession.eventsPath) {
      try {
        logEvent(
          backstopSession,
          formatErrorEvent(backstopSession, {
            errorCode: "UnhandledExit",
            message:
              "Turn exited without emitting a terminal tag. Likely a crash, SIGKILL, or an un-instrumented error path. " +
              "If this reproduces, check `~/.codex-bridge/crashes/` for a crash dump and open an issue — this marker is " +
              "itself the bug report.",
            phase: heartbeatState.phase ?? "unknown",
            origin: "bridge",
            scriptPath: SCRIPT_PATH,
            jobId: request.jobId ?? null,
            cwd: request.cwd,
            stateCwd,
          })
        );
        logNdjson(backstopSession, "ERROR", null, {
          errorCode: "UnhandledExit",
          origin: "bridge",
          message: "finally-backstop synthesized terminal tag",
        });
      } catch {
        // finally must never throw — even if the events file is gone or
        // unreadable, we've already stopped the heartbeat and letting the
        // original error propagate is the right call.
      }
    }
  }
}

export function extractPlanSteps(planText) {
  const steps = [];
  for (const line of (planText || "").split("\n")) {
    const match = line.match(/^\s*(\d+)\.\s+(.+)/);
    if (match) {
      steps.push({ number: parseInt(match[1]), text: match[2].trim(), status: "pending" });
    }
  }
  return steps.length > 0 ? steps : [{ number: 1, text: planText?.split("\n")[0] ?? "Plan", status: "pending" }];
}
