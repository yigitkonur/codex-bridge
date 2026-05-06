import fs from "node:fs";
import path from "node:path";

import { CliError } from "./cli-errors.mjs";
import { getSessionRuntimeStatus } from "../adapters/codex/codex.mjs";
import { getBridgeConfig } from "./bridge-config.mjs";
import { getConfig, listJobs, readJobFile, resolveJobFile } from "./state.mjs";
import { readEvents, resolveSessionDir, TERMINAL_TAGS } from "./session-log.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function filterJobsForGroup(jobs, group) {
  if (!group) {
    return jobs;
  }
  return jobs.filter((job) => job.group === group);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    // Pre-1.2.5 this returned "rescue" for every task (user-launched or
    // stop-gate). Current callers set `kindLabel` explicitly ("task" or
    // "rescue-review") in buildTaskRunMetadata, so this fallback is only
    // reached for legacy state-file records that predate the rename.
    // Defaulting legacy task records to "task" is safer — it matches what
    // a user-launched task should have read all along.
    return "task";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "task";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  try {
    return readJobFile(jobFile);
  } catch (error) {
    if (error?.code === "JOB_DETAIL_CORRUPT") {
      throw new CliError(`Job detail for ${jobId} is corrupt.`, {
        class: "conflict",
        code: "JOB_DETAIL_CORRUPT",
        retryable: false,
        suggestion: "Run `status` to inspect the state index; relaunch the task if the detail artifact is required.",
        details: {
          jobId,
          jobFile,
          corruptPath: error.corruptPath ?? null,
          cause: error.cause?.message ?? null,
        },
        nextAction: {
          kind: "inspect-status",
          command: `status ${jobId}`,
          description: "Inspect the state-index record that survived the corrupt detail file.",
        },
      });
    }
    throw error;
  }
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  // Thread-id resolution (exact only — thread ids are UUIDs, prefix matching
  // is meaningless and dangerous).
  const byThread = filtered.find((job) => job.threadId && job.threadId === reference);
  if (byThread) {
    return byThread;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new CliError(`Job reference "${reference}" is ambiguous. Use a longer job id.`, {
      class: "validation",
      code: "AMBIGUOUS_JOB_REFERENCE",
      retryable: false
    });
  }

  throw new CliError(`No job found for "${reference}".`, {
    class: "not_found",
    code: "JOB_NOT_FOUND",
    retryable: false,
    suggestion: "Run `status` to list known jobs."
  });
}

function isResultTerminalJob(job) {
  return (
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled" ||
    job.status === "orphaned"
  );
}

function isActiveStatus(status) {
  return status === "queued" || status === "running";
}

function firstEventLine(block) {
  return String(block ?? "").split(/\r?\n/, 1)[0] ?? "";
}

function eventTagForBlock(block) {
  return /^\[([^\]]+)\]/.exec(firstEventLine(block))?.[1] ?? null;
}

function readStoredJobForStatus(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  try {
    return readJobFile(jobFile);
  } catch {
    return null;
  }
}

function resolveStatusEventsPath(job, storedJob, workspaceRoot, config = {}) {
  const candidates = [
    storedJob?.result?.eventsPath,
    storedJob?.result?.artifacts?.eventsPath,
    storedJob?.eventsPath,
    job.eventsPath,
    job.result?.eventsPath,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  const threadId = job.threadId ?? storedJob?.threadId ?? null;
  if (!threadId) {
    return null;
  }
  const eventsDir = [
    storedJob?.result?.eventsDir,
    storedJob?.result?.artifacts?.eventsDir,
    storedJob?.eventsDir,
    job.eventsDir,
    job.result?.eventsDir,
  ].find((candidate) => typeof candidate === "string" && candidate.trim());
  const sessionDir = eventsDir || config.session_dir;
  return sessionDir ? path.join(resolveSessionDir(sessionDir, workspaceRoot), `${threadId}.events`) : null;
}

function readStatusEventState(eventsPath) {
  if (!eventsPath || !fs.existsSync(eventsPath)) {
    return { eventsPath: eventsPath ?? null, terminal: null, attention: null };
  }

  const events = readEvents(eventsPath);
  let pipelineFailed = null;
  let attention = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const block = events[index];
    const tag = eventTagForBlock(block);
    if (!tag) {
      continue;
    }
    if (!attention && (tag === "QUESTION" || tag === "PLAN")) {
      attention = { tag, line: firstEventLine(block), eventsPath };
    }
    if (tag === "PIPELINE:failed") {
      pipelineFailed = { tag, line: firstEventLine(block), eventsPath };
      continue;
    }
    if (TERMINAL_TAGS.includes(tag)) {
      if (pipelineFailed && tag !== "ERROR") {
        return { eventsPath, terminal: pipelineFailed, attention };
      }
      return { eventsPath, terminal: { tag, line: firstEventLine(block), eventsPath }, attention };
    }
  }

  return { eventsPath, terminal: pipelineFailed, attention };
}

function msSince(job, asOfMs) {
  const since = Date.parse(job.completedAt ?? job.updatedAt ?? job.createdAt ?? "");
  return Number.isFinite(since) ? Math.max(0, asOfMs - since) : null;
}

function reasonForAttention(job, terminal) {
  return terminal?.line || job.errorMessage || job.summary || `${job.status ?? "unknown"} job needs attention`;
}

function classifyStatusJob(job, { storedJob, workspaceRoot, config, asOfMs }) {
  const eventsPath = resolveStatusEventsPath(job, storedJob, workspaceRoot, config);
  const eventState = readStatusEventState(eventsPath);
  const terminalTag = eventState.terminal?.tag ?? null;
  const base = {
    terminalTag,
    eventsPath: eventState.eventsPath ?? eventsPath,
    reason: eventState.terminal?.line ?? null,
  };
  const attention = [];
  const active = isActiveStatus(job.status);

  if (eventState.attention?.tag === "QUESTION") {
    attention.push({
      jobId: job.id,
      state: "QUESTION",
      reason: eventState.attention.line,
      since_ms: msSince(job, asOfMs),
      threadId: job.threadId ?? storedJob?.threadId ?? null,
      eventsPath: eventState.attention.eventsPath,
    });
  }
  if (eventState.attention?.tag === "PLAN" || (!active && terminalTag === "PLAN")) {
    attention.push({
      jobId: job.id,
      state: "PLAN",
      reason: eventState.attention?.line ?? eventState.terminal?.line ?? "Plan awaiting approval",
      since_ms: msSince(job, asOfMs),
      threadId: job.threadId ?? storedJob?.threadId ?? null,
      eventsPath: eventState.attention?.eventsPath ?? eventState.terminal?.eventsPath ?? eventsPath,
    });
  }

  if (active) {
    return { ...base, bucket: "running", attention };
  }

  if (job.status === "cancelled") {
    return { ...base, bucket: "cancelled", attention };
  }

  if (terminalTag === "PIPELINE:failed" || terminalTag === "ERROR") {
    attention.push({
      jobId: job.id,
      state: terminalTag === "PIPELINE:failed" ? "PIPELINE_FAILED" : "ERROR",
      reason: reasonForAttention(job, eventState.terminal),
      since_ms: msSince(job, asOfMs),
      threadId: job.threadId ?? storedJob?.threadId ?? null,
      eventsPath: eventState.terminal?.eventsPath ?? eventsPath,
    });
    return { ...base, bucket: "completed_fail", attention };
  }

  if (terminalTag === "INCOMPLETE") {
    attention.push({
      jobId: job.id,
      state: "INCOMPLETE",
      reason: reasonForAttention(job, eventState.terminal),
      since_ms: msSince(job, asOfMs),
      threadId: job.threadId ?? storedJob?.threadId ?? null,
      eventsPath: eventState.terminal?.eventsPath ?? eventsPath,
    });
    return { ...base, bucket: "completed_incomplete", attention };
  }

  if (terminalTag === "PLAN") {
    return { ...base, bucket: "awaiting_plan", attention };
  }

  if (terminalTag === "DONE") {
    return { ...base, bucket: "completed_success", attention };
  }

  if (job.status === "failed" || job.status === "orphaned") {
    attention.push({
      jobId: job.id,
      state: job.status === "orphaned" ? "ORPHANED" : "FAILED",
      reason: reasonForAttention(job, eventState.terminal),
      since_ms: msSince(job, asOfMs),
      threadId: job.threadId ?? storedJob?.threadId ?? null,
      eventsPath,
    });
    return { ...base, bucket: "completed_fail", attention };
  }

  if (job.status === "completed") {
    return { ...base, bucket: "completed_success", attention };
  }

  return { ...base, bucket: "other_terminal", attention };
}

function statusStateEntry(job, storedJob, classification) {
  return {
    id: job.id,
    jobId: job.id,
    state: classification.bucket,
    status: job.status ?? null,
    phase: job.phase ?? null,
    terminalTag: classification.terminalTag ?? null,
    reason: classification.reason ?? job.errorMessage ?? null,
    threadId: job.threadId ?? storedJob?.threadId ?? null,
    summary: job.summary ?? storedJob?.summary ?? null,
    updatedAt: job.updatedAt ?? null,
    completedAt: job.completedAt ?? null,
    eventsPath: classification.eventsPath ?? null,
  };
}

function buildStatusSummary(jobs, workspaceRoot, config = {}, asOf = new Date()) {
  const asOfMs = asOf.getTime();
  const summary = {
    total: jobs.length,
    running: 0,
    completed_success: 0,
    completed_fail: 0,
    completed_incomplete: 0,
    cancelled: 0,
    other_terminal: 0,
    interrupts: {
      awaiting_plan: 0,
      awaiting_question: 0,
    },
    by_state: {
      running: 0,
      completed_success: 0,
      completed_fail: 0,
      completed_incomplete: 0,
      cancelled: 0,
      other_terminal: 0,
    },
    awaiting_attention: 0,
    as_of: asOf.toISOString(),
  };
  const byState = {
    running: [],
    completed_success: [],
    completed_fail: [],
    completed_incomplete: [],
    cancelled: [],
    other_terminal: [],
    awaiting_plan: [],
  };
  const needsAttention = [];

  for (const job of jobs) {
    const storedJob = readStoredJobForStatus(workspaceRoot, job.id);
    const classification = classifyStatusJob(job, { storedJob, workspaceRoot, config, asOfMs });
    const entry = statusStateEntry(job, storedJob, classification);
    if (byState[classification.bucket]) {
      byState[classification.bucket].push(entry);
    }
    switch (classification.bucket) {
      case "running":
        summary.running += 1;
        summary.by_state.running += 1;
        break;
      case "completed_success":
        summary.completed_success += 1;
        summary.by_state.completed_success += 1;
        break;
      case "completed_fail":
        summary.completed_fail += 1;
        summary.by_state.completed_fail += 1;
        break;
      case "completed_incomplete":
        summary.completed_incomplete += 1;
        summary.by_state.completed_incomplete += 1;
        break;
      case "cancelled":
        summary.cancelled += 1;
        summary.by_state.cancelled += 1;
        break;
      case "awaiting_plan":
        summary.interrupts.awaiting_plan += 1;
        break;
      default:
        summary.other_terminal += 1;
        summary.by_state.other_terminal += 1;
        break;
    }

    for (const entry of classification.attention) {
      if (entry.state === "PLAN") {
        summary.interrupts.awaiting_plan += classification.bucket === "awaiting_plan" ? 0 : 1;
      } else if (entry.state === "QUESTION") {
        summary.interrupts.awaiting_question += 1;
      }
      needsAttention.push(entry);
    }
  }

  summary.awaiting_attention = needsAttention.length;
  return { summary, needsAttention, byState };
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const runtimeConfig = getBridgeConfig(cwd, workspaceRoot);
  const allJobs = listJobs(workspaceRoot);
  const visibleJobs = options.group
    ? filterJobsForGroup(allJobs, options.group)
    : options.all
      ? allJobs
      : filterJobsForCurrentSession(allJobs, options);
  const jobs = sortJobsNewestFirst(visibleJobs);
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const asOf = new Date();

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));
  const statusSummary = buildStatusSummary(jobs, workspaceRoot, runtimeConfig, asOf);

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    group: options.group ?? null,
    as_of: statusSummary.summary.as_of,
    summary: statusSummary.summary,
    running,
    latestFinished,
    recent,
    needs_attention: statusSummary.needsAttention,
    by_state: statusSummary.byState,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new CliError(`No job found for "${reference}".`, {
      class: "not_found",
      code: "JOB_NOT_FOUND",
      retryable: false,
      suggestion: "Run `status` to inspect known jobs."
    });
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));

  // Check active jobs FIRST when a reference was given, so a running job
  // matching the reference returns JOB_NOT_FINISHED (conflict/5) instead of
  // falling through to JOB_NOT_FOUND via the terminal-only lookup.
  //
  // Thread-id equality is included alongside job-id matching because
  // SKILL.md advertises "`status`/`result`/`cancel` accept either a job id
  // or the thread UUID" and callers (including `events`) rely on that
  // contract for running jobs. Without the `job.threadId === reference`
  // branch, a thread UUID for a still-running task falls through to the
  // terminal-only `matchJobReference` below and dead-ends at JOB_NOT_FOUND.
  // Exact-equality only (no prefix matching) for thread ids — see
  // matchJobReference comment.
  if (reference) {
    const activeMatch = jobs.find(
      (job) =>
        (job.status === "queued" || job.status === "running") &&
        (job.id === reference || job.id.startsWith(reference) || job.threadId === reference)
    );
    if (activeMatch) {
      throw new CliError(`Job ${activeMatch.id} is still ${activeMatch.status}.`, {
        class: "conflict",
        code: "JOB_NOT_FINISHED",
        retryable: false,
        suggestion: `Check \`status ${activeMatch.id} --wait\` and try again once it finishes.`
      });
    }
  }

  const selected = matchJobReference(
    jobs,
    reference,
    isResultTerminalJob
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  if (reference) {
    throw new CliError(`No finished job found for "${reference}".`, {
      class: "not_found",
      code: "JOB_NOT_FOUND",
      retryable: false,
      suggestion: "Run `status` to inspect active jobs."
    });
  }

  throw new CliError("No finished Codex jobs found for this repository yet.", {
    class: "not_found",
    code: "NO_FINISHED_JOBS",
    retryable: false
  });
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new CliError(`No active job found for "${reference}".`, {
        class: "not_found",
        code: "ACTIVE_JOB_NOT_FOUND",
        retryable: false
      });
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new CliError("Multiple Codex jobs are active.", {
      class: "validation",
      code: "AMBIGUOUS_CANCEL",
      retryable: false,
      suggestion: "Pass a job id to `cancel`."
    });
  }

  if (getCurrentSessionId(options)) {
    throw new CliError("No active Codex jobs to cancel for this session.", {
      class: "not_found",
      code: "NO_ACTIVE_JOBS",
      retryable: false
    });
  }

  throw new CliError("No active Codex jobs to cancel.", {
    class: "not_found",
    code: "NO_ACTIVE_JOBS",
    retryable: false
  });
}
