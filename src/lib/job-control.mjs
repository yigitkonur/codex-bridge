import fs from "node:fs";

import { CliError } from "./cli-errors.mjs";
import { getSessionRuntimeStatus } from "../adapters/codex/codex.mjs";
import { getConfig, listJobs, readJobFile, resolveJobFile } from "./state.mjs";
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

function normalizeGroupFilter(value) {
  if (value == null) {
    return null;
  }
  const group = String(value).trim();
  if (!group) {
    throw new CliError("--group requires a non-empty group name.", {
      class: "validation",
      code: "GROUP_EMPTY",
      retryable: false,
    });
  }
  return group;
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const allJobs = listJobs(workspaceRoot);
  const visibleJobs = options.group
    ? filterJobsForGroup(allJobs, options.group)
    : options.all
      ? allJobs
      : filterJobsForCurrentSession(allJobs, options);
  const jobs = sortJobsNewestFirst(visibleJobs);
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const group = normalizeGroupFilter(options.group);
  if (group) {
    jobs = jobs.filter((job) => job.group === group);
  }

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    group: options.group ?? null,
    running,
    latestFinished,
    recent,
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
