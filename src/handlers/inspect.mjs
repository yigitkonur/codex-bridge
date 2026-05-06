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
  readNdjson,
  resolveSessionDir,
  TERMINAL_TAGS,
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

export async function handleStatus(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms", "interval", "watch-timeout-ms", "retention-days", "retention-jobs", "filter", "session", "since"],
    booleanOptions: ["json", "all", "wait", "prune-orphans", "cleanup", "watch", "dry-run"]
  });

  const cwd = resolveCommandCwd(options);

  // `--watch`: repeatedly render the multi-job status table until every
  // tracked job reaches a terminal state (or the overall timeout expires, or
  // Ctrl-C). The primitive the critique author had to hand-roll as `poll.sh`
  // — ships it in-bridge so N-job orchestration doesn't require shell glue.
  // JSON mode emits one NDJSON snapshot per tick (forward-compatible: new
  // keys in a future bridge version pass through unchanged).
  if (options.watch) {
    if (positionals[0]) {
      throw usageError("`status --watch` does not take a job-id argument; it watches ALL tracked jobs.");
    }
    if (options["prune-orphans"] || options.cleanup || options.wait) {
      throw usageError("`--watch` is mutually exclusive with `--prune-orphans`/`--cleanup`/`--wait`.");
    }
    if (options.filter) {
      throw usageError("`--filter` is mutually exclusive with `--watch`.");
    }
    const intervalMs = parseDurationOption("--interval", options.interval, { defaultMs: 10_000 });
    const overallTimeoutMs = parseDurationOption("--watch-timeout-ms", options["watch-timeout-ms"], { defaultMs: null });
    await runStatusWatch(cwd, {
      intervalMs,
      overallTimeoutMs,
      all: options.all,
      session: options.session,
      since: options.since,
      json: options.json,
      startedAt,
    });
    return;
  }

  // --prune-orphans / --cleanup: reap state-file ghosts (status:"running" or
  // "queued" with a dead PID). Rescue rings accumulated in the stop-gate era
  // required manual SQL-style edits; this subcommand drains them idempotently.
  // See unexpected-bridge-observations/06-stop-gate-review-accumulates-orphaned-running-tasks.md
  // for the original observation. Uses `process.kill(pid, 0)` as the liveness
  // probe — throws ESRCH when the pid no longer resolves, EPERM when it
  // does but we can't signal. Either outcome means "pid exists (or did)";
  // only ESRCH is a clear reap signal.
  if (options["prune-orphans"] || options.cleanup) {
    if (options.filter) {
      throw usageError("`--filter` is mutually exclusive with `--prune-orphans`/`--cleanup`.");
    }
    const report = options.cleanup
      ? cleanupTerminalJobs(cwd, {
          dryRun: Boolean(options["dry-run"]),
          retentionDays: Number(options["retention-days"]) > 0 ? Number(options["retention-days"]) : null,
          retentionJobs: Number(options["retention-jobs"]) > 0 ? Number(options["retention-jobs"]) : null,
        })
      : pruneOrphanedJobs(cwd);
    emitSuccess("status", report, options.cleanup ? renderCleanupReport(report) : renderPruneOrphansReport(report), {
      json: options.json,
      startedAt
    });
    return;
  }

  const reference = positionals[0] ?? "";
  if (reference) {
    if (options.filter) {
      throw usageError("`status --filter` does not take a job-id argument.");
    }
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    emitSuccess("status", snapshot, renderJobStatusReport(snapshot.job), {
      json: options.json,
      startedAt
    });
    return;
  }

  if (options.wait) {
    throw usageError("`status --wait` requires a job id.");
  }

  const report = applyStopReviewGateSnapshot(buildStatusSnapshot(cwd, {
    all: options.all,
    session: options.session,
    since: options.since,
  }));
  const filtered = options.filter ? filterStatusReport(report, options.filter) : report;
  emitSuccess("status", filtered, renderStatusReport(filtered), {
    json: options.json,
    startedAt
  });
}

const STATUS_FILTERS = new Set([
  "running",
  "completed_success",
  "completed_fail",
  "completed_incomplete",
  "cancelled",
  "needs_attention",
]);

function filterStatusReport(report, filter) {
  if (!STATUS_FILTERS.has(filter)) {
    throw usageError(`Unknown status --filter value: ${filter}`);
  }

  if (filter === "needs_attention") {
    return {
      ...report,
      filter,
      filtered_jobs: report.needs_attention ?? [],
      running: [],
      latestFinished: null,
      recent: [],
    };
  }

  const jobs = report.by_state?.[filter] ?? [];
  const attentionJobIds = new Set(jobs.map((job) => job.jobId ?? job.id));
  return {
    ...report,
    filter,
    filtered_jobs: jobs,
    running: filter === "running" ? report.running : [],
    latestFinished: null,
    recent: [],
    needs_attention: (report.needs_attention ?? []).filter((entry) => attentionJobIds.has(entry.jobId)),
  };
}

// v1.4.1 — live multi-job status view. The sync fan-in primitive for N>1
// orchestration. Exits when every tracked job is terminal
// (status !== "queued" && !== "running"), on overall timeout, or on
// Ctrl-C. Returns a summary envelope via emitSuccess once stable.
async function runStatusWatch(cwd, { intervalMs, overallTimeoutMs, all, session, since, json, startedAt }) {
  const deadline = overallTimeoutMs ? Date.now() + overallTimeoutMs : null;
  let ticks = 0;
  let interrupted = false;
  const onSigint = () => { interrupted = true; };
  process.on("SIGINT", onSigint);

  try {
    while (true) {
      ticks += 1;
      const snapshot = applyStopReviewGateSnapshot(buildStatusSnapshot(cwd, { all, session, since }));
      const activeCount = snapshot.running?.length ?? 0;
      const tickEntry = {
        schema_version: "1.0",
        tick: ticks,
        ts: new Date().toISOString(),
        activeCount,
        summary: snapshot.summary ?? null,
        needsAttentionCount: snapshot.summary?.awaiting_attention ?? 0,
        running: (snapshot.running ?? []).map((j) => ({
          id: j.id,
          status: j.status,
          phase: j.phase ?? null,
          threadId: j.threadId ?? null,
          kind: j.kindLabel ?? j.kind ?? null,
          progress: j.progress ?? null,
        })),
      };
      if (json) {
        process.stdout.write(`${JSON.stringify(tickEntry)}\n`);
      } else {
        process.stdout.write(`\x1b[2J\x1b[H`); // clear + home
        process.stdout.write(`watch tick #${ticks} · ${tickEntry.ts} · active=${activeCount}\n\n`);
        process.stdout.write(renderStatusReport(snapshot));
      }

      if (activeCount === 0) {
        const summary = {
          terminated: true,
          reason: "all-terminal",
          ticks,
          final: snapshot,
        };
        // On the final tick the rendered view is already on screen; emit the
        // structured envelope only in --json mode (else it would clobber the
        // table).
        if (json) {
          emitSuccess("status", summary, null, { json: true, startedAt });
        }
        return;
      }
      if (interrupted) {
        const summary = { terminated: false, reason: "sigint", ticks, final: snapshot };
        if (json) emitSuccess("status", summary, null, { json: true, startedAt });
        return;
      }
      if (deadline && Date.now() >= deadline) {
        const summary = { terminated: false, reason: "watch-timeout", ticks, final: snapshot };
        if (json) emitSuccess("status", summary, null, { json: true, startedAt });
        else process.stdout.write(`\nwatch timed out after ${ticks} ticks with ${activeCount} active job(s).\n`);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

// v1.4.1 — block on a file produced by a Codex job. The success-gate primitive
// for the most common multi-job pattern ("success = an artifact at <path>").
// Three terminal conditions:
//   1. The file exists and its size is stable across one poll interval.
//   2. The job itself reaches a terminal state (completed/failed/cancelled/
//      orphaned). Returns `{exists:false, terminated:true, reason:"<status>"}`.
//   3. The overall timeout expires. Returns `{exists:false, terminated:false,
//      reason:"timeout"}`.
export async function handleAwaitArtifact(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json"],
  });

  const jobRef = positionals[0];
  const artifactPath = positionals[1];
  if (!jobRef || !artifactPath) {
    throw usageError("`await-artifact <job-id> <path>` requires both a job reference and a file path.");
  }

  const cwd = resolveCommandCwd(options);
  const timeoutMs = parseDurationOption("--timeout-ms", options["timeout-ms"], { defaultMs: 900_000 });
  const pollIntervalMs = parseDurationOption("--poll-interval-ms", options["poll-interval-ms"], { defaultMs: 2_000 });

  const resolvedPath = path.isAbsolute(artifactPath)
    ? artifactPath
    : path.resolve(cwd, artifactPath);

  const deadline = Date.now() + timeoutMs;
  let prevSize = null;

  while (true) {
    // Job-terminal check first — if the job died without producing the
    // artifact, fail-fast rather than waiting the full timeout.
    let jobSnapshot;
    try {
      jobSnapshot = buildSingleJobSnapshot(cwd, jobRef);
    } catch (e) {
      if (e && e.code === "JOB_NOT_FOUND") {
        throw e;
      }
      throw e;
    }
    const jobStatus = jobSnapshot.job?.status ?? "unknown";
    const jobTerminal = jobStatus !== "queued" && jobStatus !== "running";

    let statInfo = null;
    try {
      statInfo = fs.statSync(resolvedPath);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }

    if (statInfo) {
      if (prevSize != null && prevSize === statInfo.size) {
        const payload = {
          exists: true,
          path: resolvedPath,
          size: statInfo.size,
          terminated: jobTerminal,
          jobStatus,
          elapsedMs: Date.now() - startedAt,
          recovery: buildRecovery({
            reason: "artifact-ready",
            retryable: false,
            artifacts: { artifactPath: resolvedPath },
          }),
        };
        emitSuccess("await-artifact", payload, `artifact ready: ${resolvedPath} (${statInfo.size} bytes)\n`, {
          json: options.json,
          startedAt,
        });
        return;
      }
      prevSize = statInfo.size;
    }

    if (jobTerminal) {
      // Job finished but artifact never appeared — one last chance on the
      // next loop iteration is redundant (job can't write after terminal),
      // so exit with `exists:false`.
      const payload = {
        exists: Boolean(statInfo),
        path: resolvedPath,
        size: statInfo?.size ?? null,
        terminated: true,
        reason: `job-${jobStatus}`,
        jobStatus,
        elapsedMs: Date.now() - startedAt,
        recovery: buildRecovery({
          reason: `job-${jobStatus}`,
          retryable: true,
          nextActions: [
            `Run result ${jobSnapshot.job?.id ?? jobRef} to inspect the terminal job output.`,
            "Verify the producer writes the expected artifact path, then rerun or resume the task.",
          ],
          artifacts: {
            expectedArtifactPath: resolvedPath,
            logFile: jobSnapshot.job?.logFile ?? null,
          },
          details: { jobId: jobSnapshot.job?.id ?? null, jobStatus },
        }),
      };
      // Exit 7 (transient) when artifact missing after job ended — matches
      // `wait` semantics for WAIT_TIMEOUT.
      if (!statInfo) {
        process.exitCode = 7;
        emitSuccess("await-artifact", payload, `job reached ${jobStatus} without producing ${resolvedPath}\n`, {
          json: options.json,
          startedAt,
        });
        return;
      }
      emitSuccess("await-artifact", payload, `artifact present: ${resolvedPath} (${statInfo.size} bytes, job ${jobStatus})\n`, {
        json: options.json,
        startedAt,
      });
      return;
    }

    if (Date.now() >= deadline) {
      const payload = {
        exists: false,
        path: resolvedPath,
        terminated: false,
        reason: "timeout",
        jobStatus,
        elapsedMs: Date.now() - startedAt,
        recovery: buildRecovery({
          reason: "timeout",
          retryable: true,
          nextActions: [
            `Run status ${jobSnapshot.job?.id ?? jobRef} to confirm whether the producer is still active.`,
            "Retry await-artifact with a larger --timeout-ms or inspect events for stalled output.",
          ],
          artifacts: {
            expectedArtifactPath: resolvedPath,
            logFile: jobSnapshot.job?.logFile ?? null,
          },
          details: { jobId: jobSnapshot.job?.id ?? null, jobStatus },
        }),
      };
      process.exitCode = 7;
      emitSuccess("await-artifact", payload, `timeout waiting for ${resolvedPath} (job ${jobStatus})\n`, {
        json: options.json,
        startedAt,
      });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

// Reaps state-file ghost jobs (status:"running" or "queued" with a pid that
// no longer resolves). Marks each with status:"orphaned" and an explanatory
// errorMessage. Idempotent; safe to call repeatedly. Returns a summary
// suitable for both JSON and rendered output.
function pruneOrphanedJobs(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // The default `listJobs` view reaps stale-PID `running`/`queued` jobs to
  // `orphaned` in-memory so read-only consumers see crashes promptly. The
  // prune-orphans writer is the one that must actually persist that
  // transition, so it asks for the raw on-disk view; otherwise the entries
  // it's meant to reap arrive already labelled `orphaned` and slip past
  // the active-status filter below.
  const jobs = listJobs(workspaceRoot, { raw: true });
  const reaped = [];
  const skipped = [];
  const ts = new Date().toISOString();
  for (const job of jobs) {
    const isActive = job.status === "running" || job.status === "queued";
    if (!isActive) continue;
    const pid = Number(job.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      // Active status with no recorded PID — almost certainly a ghost.
      reaped.push(finalizeOrphan(workspaceRoot, job, ts, "no-pid"));
      continue;
    }
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (err) {
      if (err && err.code === "EPERM") {
        // PID exists, signal denied — treat as alive. Conservative: don't
        // reap something we merely can't signal.
        alive = true;
      }
    }
    if (alive) {
      skipped.push({ id: job.id, pid, reason: "pid-alive" });
    } else {
      reaped.push(finalizeOrphan(workspaceRoot, job, ts, "dead-pid"));
    }
  }
  return {
    workspaceRoot,
    reaped,
    skipped,
    reapedCount: reaped.length,
    skippedCount: skipped.length,
    ts,
    recovery: buildRecovery({
      reason: reaped.length > 0 ? "orphans-reaped" : "state-clean",
      retryable: reaped.length > 0,
      nextActions: reaped.length > 0
        ? [
            "Inspect result/events for reaped jobs before retrying any interrupted work.",
            "Rerun the original task only after confirming no generated artifacts were left half-written.",
          ]
        : [],
      details: { reapedCount: reaped.length, skippedCount: skipped.length },
    }),
  };
}

function finalizeOrphan(workspaceRoot, job, ts, reason) {
  const record = {
    ...job,
    status: "orphaned",
    phase: "orphaned",
    pid: null,
    completedAt: ts,
    errorMessage: `Reaped by status --prune-orphans at ${ts} (${reason}).`
  };
  writeJobFile(workspaceRoot, job.id, record);
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "orphaned",
    phase: "orphaned",
    pid: null,
    completedAt: ts,
    errorMessage: record.errorMessage
  });
  return { id: job.id, previousStatus: job.status, reason, pid: job.pid ?? null };
}

function renderPruneOrphansReport(report) {
  if (report.reapedCount === 0 && report.skippedCount === 0) {
    return "No active jobs to inspect — state is clean.\n";
  }
  const lines = [];
  if (report.reapedCount === 0) {
    lines.push(`No orphans: ${report.skippedCount} active job(s), all backed by live PIDs.`);
  } else {
    lines.push(`Reaped ${report.reapedCount} orphan(s) (status:"running"/"queued" with dead PIDs):`);
    for (const entry of report.reaped) {
      lines.push(`  - ${entry.id} (was ${entry.previousStatus}, ${entry.reason}, pid=${entry.pid ?? "null"})`);
    }
    if (report.skippedCount > 0) {
      lines.push(`Kept ${report.skippedCount} active job(s) backed by live PIDs.`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function cleanupTerminalJobs(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getBridgeConfig(cwd, workspaceRoot);
  const retentionDays = options.retentionDays ?? (Number(config.artifact_retention_days) || 30);
  const retentionJobs = options.retentionJobs ?? (Number(config.artifact_retention_jobs) || 50);
  const dryRun = Boolean(options.dryRun);
  const jobs = listJobs(workspaceRoot, { raw: true });
  const terminal = sortJobsNewestFirst(jobs.filter((job) => !isActiveStatus(job.status)));
  const cutoffMs = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  const removable = terminal.filter((job, index) => {
    const ts = Date.parse(job.completedAt ?? job.updatedAt ?? job.createdAt ?? "");
    return index >= retentionJobs || (Number.isFinite(ts) && ts < cutoffMs);
  });
  const removed = [];
  if (!dryRun && removable.length > 0) {
    const removeIds = new Set(removable.map((job) => job.id));
    updateState(workspaceRoot, (state) => {
      state.jobs = (state.jobs ?? []).filter((job) => !removeIds.has(job.id));
    });
    for (const job of removable) {
      for (const filePath of [resolveJobFile(workspaceRoot, job.id), job.logFile, `${job.logFile}.worker.err`]) {
        if (!filePath) continue;
        try { fs.rmSync(filePath, { force: true }); } catch { /* best effort */ }
      }
      removed.push({ id: job.id, status: job.status, completedAt: job.completedAt ?? null });
    }
  }
  return {
    workspaceRoot,
    dryRun,
    retentionDays,
    retentionJobs,
    candidates: removable.map((job) => ({ id: job.id, status: job.status, completedAt: job.completedAt ?? null })),
    removed,
    removedCount: removed.length,
    candidateCount: removable.length,
  };
}

function isActiveStatus(status) {
  return status === "queued" || status === "running";
}

function renderCleanupReport(report) {
  if (report.candidateCount === 0) {
    return `No terminal jobs exceed retention (${report.retentionJobs} jobs / ${report.retentionDays} days).\n`;
  }
  const verb = report.dryRun ? "Would remove" : "Removed";
  const lines = [`${verb} ${report.dryRun ? report.candidateCount : report.removedCount} terminal job(s):`];
  const entries = report.dryRun ? report.candidates : report.removed;
  for (const entry of entries) {
    lines.push(`  - ${entry.id} (${entry.status}, completed=${entry.completedAt ?? "unknown"})`);
  }
  return `${lines.join("\n")}\n`;
}

export async function handleResult(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "format"],
    booleanOptions: ["json", "transcript", "final-only"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const adapter = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    metaBackend: storedJob?.backend ?? job.backend ?? null,
  });
  ensureCodexRuntimeAdapter(adapter);
  const adapterResult = await adapter.getResult(job.id, { cwd });
  const payload = {
    job,
    storedJob,
    adapterResult
  };

  if (options.transcript) {
    const transcript = buildResultTranscript({
      job,
      storedJob,
      adapterResult,
      cwd,
      workspaceRoot,
      format: options.format,
      finalOnly: Boolean(options["final-only"]),
    });
    emitSuccess("result", { ...payload, transcript: transcript.payload }, transcript.rendered, {
      json: options.json,
      startedAt
    });
    return;
  }

  emitSuccess("result", payload, renderStoredJobResult(job, storedJob), {
    json: options.json,
    startedAt
  });
}

function normalizeTranscriptFormat(format) {
  const normalized = String(format ?? "markdown").trim().toLowerCase();
  if (["markdown", "text", "json"].includes(normalized)) {
    return normalized;
  }
  throw validationError(
    `Unsupported transcript format "${format}". Use markdown, text, or json.`,
    "INVALID_TRANSCRIPT_FORMAT"
  );
}

function normalizeCompletedItem(entry) {
  if (entry?.method !== "item/completed") return null;
  const raw = entry.data?.item ?? entry.data ?? {};
  const type = raw.type ?? raw.itemType ?? null;
  if (!type) return null;
  return { ...raw, type };
}

function collectAgentTranscriptMessages(entries) {
  const messages = [];
  for (const entry of entries) {
    const item = normalizeCompletedItem(entry);
    if (item?.type !== "agentMessage" || typeof item.text !== "string" || !item.text) {
      continue;
    }
    messages.push({
      role: "assistant",
      text: item.text,
      timestamp: entry.ts ?? null,
      itemId: item.itemId ?? item.id ?? null,
      final: item.phase === "final_answer" ? true : null,
      source: "ndjson",
    });
  }
  return messages;
}

function readJobNdjsonEntries(cwd, workspaceRoot, threadId) {
  if (!threadId) return [];
  const config = getBridgeConfig(cwd, workspaceRoot);
  const sessionDir = resolveSessionDir(config.session_dir, workspaceRoot);
  const session = findSession(sessionDir, threadId);
  return session ? readNdjson(session) : [];
}

function buildResultTranscript({ job, storedJob, adapterResult, cwd, workspaceRoot, format, finalOnly }) {
  const normalizedFormat = normalizeTranscriptFormat(format);
  const threadId = adapterResult.threadId ?? job.threadId ?? storedJob?.threadId ?? null;
  const finalMessage = typeof adapterResult.finalMessage === "string" && adapterResult.finalMessage.length > 0
    ? adapterResult.finalMessage
    : null;
  const ndjsonMessages = collectAgentTranscriptMessages(readJobNdjsonEntries(cwd, workspaceRoot, threadId));
  const fallbackFinalMessage = finalMessage
    ? [{
        role: "assistant",
        text: finalMessage,
        timestamp: null,
        itemId: null,
        final: true,
        source: "stored-result",
      }]
    : [];
  const messages = finalOnly
    ? (fallbackFinalMessage.length > 0 ? fallbackFinalMessage : ndjsonMessages.slice(-1))
    : (ndjsonMessages.length > 0 ? ndjsonMessages : fallbackFinalMessage);

  const payload = {
    jobId: job.id,
    threadId,
    finalOnly,
    format: normalizedFormat,
    messageCount: messages.length,
    messages,
  };
  return {
    payload,
    rendered: renderResultTranscript(payload),
  };
}

function renderResultTranscript(payload) {
  if (payload.format === "json") {
    return `${JSON.stringify(payload.messages, null, 2)}\n`;
  }
  if (payload.format === "text") {
    const text = payload.messages.map((message) => message.text).join("\n\n---\n\n");
    return text && !text.endsWith("\n") ? `${text}\n` : text;
  }

  const lines = [
    "# Codex Result Transcript",
    "",
    `Job: ${payload.jobId}`,
    `Thread: ${payload.threadId ?? "unknown"}`,
  ];
  if (payload.messages.length === 0) {
    lines.push("", "No assistant messages captured.");
    return `${lines.join("\n")}\n`;
  }
  payload.messages.forEach((message, index) => {
    const suffix = message.final === true ? " (final)" : "";
    const timestamp = message.timestamp ? ` - ${message.timestamp}` : "";
    lines.push("", `## Assistant Message ${index + 1}${suffix}${timestamp}`, "", message.text);
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

const WAIT_PREDICATE_ALIASES = Object.freeze({
  terminal: "terminal",
  interrupt: "interrupt",
  error: "error",
  both: "both",
  "terminal+interrupt": "both",
  "interrupt+terminal": "both",
  "terminal|interrupt": "both",
  "interrupt|terminal": "both",
});

const INTERRUPT_TAGS = Object.freeze(["PLAN", "QUESTION"]);
const ERROR_TAGS = Object.freeze(["ERROR", "INCOMPLETE"]);

function normalizeWaitPredicate(value) {
  if (value == null || String(value).trim() === "") return "terminal";
  const key = String(value).trim().toLowerCase().replaceAll(",", "+").replace(/\s+/g, "");
  const normalized = WAIT_PREDICATE_ALIASES[key];
  if (!normalized) {
    throw usageError(
      `Unsupported wait predicate "${value}".`,
      "Use one of: terminal, interrupt, error, both, interrupt+terminal."
    );
  }
  return normalized;
}

function waitPredicateTags(predicate) {
  if (predicate === "terminal") return new Set(TERMINAL_TAGS);
  if (predicate === "interrupt") return new Set(INTERRUPT_TAGS);
  if (predicate === "error") return new Set(ERROR_TAGS);
  return new Set([...TERMINAL_TAGS, ...INTERRUPT_TAGS]);
}

function collectWaitReferences(positionals, jobsOption) {
  const raw = [
    ...(Array.isArray(jobsOption) ? jobsOption : jobsOption == null ? [] : [jobsOption]),
    ...positionals,
  ];
  const refs = [];
  const seen = new Set();
  for (const value of raw) {
    for (const ref of String(value).split(/[\s,]+/)) {
      if (!ref || seen.has(ref)) continue;
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}

function resolveWaitTargets(cwd, references) {
  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  return references.map((reference) => {
    let job;
    try {
      job = resolveResultJob(cwd, reference).job;
    } catch (err) {
      if (err?.code === "JOB_NOT_FINISHED") {
        job = buildSingleJobSnapshot(cwd, reference).job;
      } else {
        throw err;
      }
    }
    if (!job?.threadId) {
      throw notFoundError(`Job ${job?.id ?? reference} has no thread id yet.`, "JOB_HAS_NO_THREAD");
    }
    return {
      reference,
      job,
      eventsPath: path.join(sessionDir, `${job.threadId}.events`),
    };
  });
}

function matchWaitLine(line, tags) {
  const m = /^\[([^\]]+)\]/.exec(line);
  if (!m) return null;
  const rawTag = m[1];
  const tag = rawTag.split(":")[0].toUpperCase();
  if (!tags.has(tag)) return null;
  return { tag, rawTag, line };
}

function createWaitWatcher(target, tags, onMatch) {
  let closed = false;
  let offset = 0;
  let watcher = null;
  let pollTimer = null;

  const close = () => {
    closed = true;
    if (watcher) {
      try { watcher.close(); } catch { /* noop */ }
    }
    if (pollTimer) clearInterval(pollTimer);
  };

  const scan = () => {
    if (closed) return false;
    try {
      const data = fs.readFileSync(target.eventsPath, "utf8");
      if (data.length < offset) offset = 0;
      const tail = data.slice(offset);
      offset = data.length;
      for (const line of tail.split("\n")) {
        const event = matchWaitLine(line, tags);
        if (event) {
          onMatch(target, event);
          return true;
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return false;
  };

  const attachWatcher = () => {
    if (closed) return;
    try {
      watcher = fs.watch(target.eventsPath, { persistent: false }, scan);
      scan();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (!pollTimer) {
        pollTimer = setInterval(() => {
          if (fs.existsSync(target.eventsPath)) {
            clearInterval(pollTimer);
            pollTimer = null;
            attachWatcher();
          }
        }, 500);
      }
    }
  };

  if (!scan()) attachWatcher();
  return { close };
}

function waitForTargetMatches(targets, tags, { mode, timeoutMs }) {
  return new Promise((resolve) => {
    let resolved = false;
    const watchers = [];
    const matches = new Map();
    let timer = null;

    const closeAll = () => {
      for (const watcher of watchers) watcher.close();
      if (timer) clearTimeout(timer);
    };

    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      closeAll();
      resolve(payload);
    };

    const onMatch = (target, event) => {
      if (resolved || matches.has(target.job.id)) return;
      const match = {
        reference: target.reference,
        jobId: target.job.id,
        threadId: target.job.threadId,
        state: event.tag,
        rawTag: event.rawTag,
        terminalTag: TERMINAL_TAGS.includes(event.tag) ? event.tag : null,
        interruptTag: INTERRUPT_TAGS.includes(event.tag) ? event.tag : null,
        lastEventLine: event.line,
        eventsPath: target.eventsPath,
        matchedAtMs: Date.now(),
      };
      matches.set(target.job.id, match);
      if (mode === "any") {
        finish({ timedOut: false, winner: match, matches: [...matches.values()] });
      } else if (matches.size === targets.length) {
        finish({ timedOut: false, matches: [...matches.values()] });
      }
    };

    for (const target of targets) {
      const watcher = createWaitWatcher(target, tags, onMatch);
      watchers.push(watcher);
      if (resolved) {
        watcher.close();
        return;
      }
    }

    timer = setTimeout(() => {
      finish({ timedOut: true, matches: [...matches.values()] });
    }, timeoutMs);
  });
}

function summarizeWaitMatches(matches, total) {
  const summary = {
    total,
    matched: matches.length,
    pending: total - matches.length,
    completed: 0,
    plan: 0,
    failed: 0,
    cancelled: 0,
    errors: 0,
    incomplete: 0,
    questions: 0,
    interrupts: 0,
    terminal: 0,
  };
  for (const match of matches) {
    if (match.state === "DONE") summary.completed += 1;
    if (match.state === "PLAN") summary.plan += 1;
    if (match.state === "CANCELLED") summary.cancelled += 1;
    if (match.state === "ERROR") summary.errors += 1;
    if (match.state === "INCOMPLETE") summary.incomplete += 1;
    if (match.state === "QUESTION") summary.questions += 1;
    if (match.terminalTag) summary.terminal += 1;
    if (match.interruptTag) summary.interrupts += 1;
  }
  summary.failed = summary.errors + summary.incomplete;
  return summary;
}

export async function handleWait(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "predicate"],
    repeatableValueOptions: ["jobs"],
    booleanOptions: ["json", "any", "all"]
  });

  const cwd = resolveCommandCwd(options);
  if (options.any && options.all) {
    throw usageError("Pass either --any OR --all, not both.");
  }
  const references = collectWaitReferences(positionals, options.jobs);
  if (references.length === 0) {
    throw usageError("wait requires at least one job id or thread id.");
  }
  const mode = options.any ? "any" : "all";
  const predicate = normalizeWaitPredicate(options.predicate);
  const timeoutMs = Math.max(1000, Number(options["timeout-ms"]) || 600_000);
  const targets = resolveWaitTargets(cwd, references);
  const tags = waitPredicateTags(predicate);

  if (mode === "any" && targets.length < 2) {
    throw usageError("wait --any requires at least two job ids or thread ids.");
  }
  const result = await waitForTargetMatches(targets, tags, { mode, timeoutMs });
  if (result.timedOut) {
    const partial = result.matches ?? [];
    throw new CliError(
      `No ${predicate} event matched ${mode === "any" ? "any target" : "all targets"} within ${Math.round(timeoutMs / 1000)}s.`,
      {
        class: "timeout",
        code: "WAIT_TIMEOUT",
        retryable: true,
        suggestion: mode === "any"
          ? "Run `status --watch --all` to inspect live multi-job state."
          : "Run `status <job-id>` for pending jobs, or increase --timeout-ms.",
        details: {
          mode,
          predicate,
          summary: summarizeWaitMatches(partial, targets.length),
          jobs: partial,
          pending: targets
            .filter((target) => !partial.some((match) => match.jobId === target.job.id))
            .map((target) => ({
              reference: target.reference,
              jobId: target.job.id,
              threadId: target.job.threadId,
              eventsPath: target.eventsPath,
            })),
        }
      }
    );
  }

  const elapsedMs = Date.now() - startedAt;
  const matches = result.matches ?? [];
  if (mode === "any") {
    const winner = result.winner;
    emitSuccess(
      "wait",
      {
        mode,
        predicate,
        jobId: winner.jobId,
        threadId: winner.threadId,
        state: winner.state,
        terminalTag: winner.terminalTag,
        interruptTag: winner.interruptTag,
        lastEventLine: winner.lastEventLine,
        eventsPath: winner.eventsPath,
        elapsedMs,
        winner,
        targets: targets.map((target) => ({
          reference: target.reference,
          jobId: target.job.id,
          threadId: target.job.threadId,
          eventsPath: target.eventsPath,
        })),
      },
      `${winner.state} ${winner.jobId} after ${Math.round(elapsedMs / 1000)}s\n`,
      { json: options.json, startedAt }
    );
    return;
  }

  if (!options.all && targets.length === 1 && predicate === "terminal") {
    const [match] = matches;
    emitSuccess(
      "wait",
      {
        jobId: match.jobId,
        threadId: match.threadId,
        terminalTag: match.terminalTag,
        lastEventLine: match.lastEventLine,
        eventsPath: match.eventsPath,
        elapsedMs
      },
      `${match.terminalTag} ${match.threadId} after ${Math.round(elapsedMs / 1000)}s\n`,
      { json: options.json, startedAt }
    );
    return;
  }

  const matchedAt = matches.map((match) => match.matchedAtMs);
  emitSuccess(
    "wait",
    {
      mode,
      predicate,
      summary: summarizeWaitMatches(matches, targets.length),
      jobs: matches,
      firstMatchedAtMs: matchedAt.length ? Math.min(...matchedAt) - startedAt : null,
      lastMatchedAtMs: matchedAt.length ? Math.max(...matchedAt) - startedAt : null,
      elapsedMs
    },
    `all ${targets.length} jobs matched ${predicate} after ${Math.round(elapsedMs / 1000)}s\n`,
    { json: options.json, startedAt }
  );
}

export async function handleEvents(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "filter", "exclude"],
    booleanOptions: ["json", "follow"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (!reference) {
    throw usageError("events requires <job-id-or-thread-id>");
  }
  // --filter (inclusion-list) and --exclude (exclusion-list) are mutually
  // exclusive. Forward-compatible callers should prefer --exclude so new
  // tags emitted by future bridge versions pass through by default instead
  // of being silently dropped at an out-of-date inclusion list. See
  // v1.4.0 plan "Change 1 — Exclusion-based filter semantics".
  if (options.filter != null && options.exclude != null) {
    throw usageError(
      "Pass either --filter OR --exclude, not both. --filter shows only listed tags (inclusion); --exclude shows everything except listed tags (forward-compatible)."
    );
  }

  let job;
  try {
    job = resolveResultJob(cwd, reference).job;
  } catch (err) {
    if (err?.code === "JOB_NOT_FINISHED") {
      job = buildSingleJobSnapshot(cwd, reference).job;
    } else {
      throw err;
    }
  }
  if (!job?.threadId) {
    throw notFoundError(
      `Job ${job?.id ?? reference} has no thread id yet.`,
      "JOB_HAS_NO_THREAD"
    );
  }

  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const eventsPath = path.join(sessionDir, `${job.threadId}.events`);

  // Build filter sets. `filter` drops everything NOT in the set; `exclude`
  // drops everything IN the set. Empty strings collapse to null (show-all).
  const parseTagList = (raw) => {
    if (raw == null || raw === "") return null;
    const tags = raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    return tags.length > 0 ? new Set(tags) : null;
  };
  const filter = parseTagList(options.filter);
  const exclude = parseTagList(options.exclude);
  const writeEventLine = (line) => {
    if (!options.json) process.stdout.write(line + "\n");
  };
  const tagOf = (line) => {
    // Match any leading bracketed tag. Character class is deliberately broad
    // (anything but a closing bracket) so future tag names — including
    // ones with digits (`FUTURE_TAG_V15`), underscores, or hyphens
    // (`NETWORK-STALL`) — are recognized and routed through the filter.
    // Pre-1.4.0 this was `[A-Za-z:]+` and silently dropped unknown-shape
    // tags; forward-compat depends on tagOf recognizing them as tags
    // rather than treating them as continuation lines. Head-only scoping
    // unchanged: we split on ":" so `[PIPELINE:review]` maps to PIPELINE.
    const m = /^\[([^\]]+)\]/.exec(line);
    return m ? m[1].split(":")[0].toUpperCase() : null;
  };
  // Predicate order: --filter (inclusion) wins if set; else --exclude drops
  // listed tags; else show-all. Multi-line blocks (HEARTBEAT, CHECKPOINT,
  // PLAN, DONE, ERROR, INCOMPLETE, WARNING, QUESTION) have a header line
  // with a bracketed tag followed by indented continuation lines with no
  // tag. Continuation lines *inherit* the header's inclusion decision —
  // otherwise an included `[CHECKPOINT]` header would show without its
  // `assistant:`, `tools:`, `diff-since-last-checkpoint:` body. This is a
  // real pre-1.4.0 bug: per-line filter dropped every continuation line
  // because `tagOf` returned null.
  let lastBlockIncluded = true;
  const passes = (line) => {
    const tag = tagOf(line);
    if (tag == null) {
      // Continuation or blank line — inherit whatever decision the most
      // recent header got. If no header has been seen yet (preamble), show.
      return lastBlockIncluded;
    }
    // Header line — compute fresh decision and remember it for subsequent
    // continuation lines in this block.
    let included;
    if (filter) included = filter.has(tag);
    else if (exclude) included = !exclude.has(tag);
    else included = true;
    lastBlockIncluded = included;
    return included;
  };

  const TERMINAL = TERMINAL_TAG_REGEX;

  // Dump existing content (filtered). Track whether a terminal tag is already
  // present so --follow can short-circuit on already-completed events files.
  let initial = "";
  let alreadyTerminal = false;
  let initialTerminalTag = null;
  let initialTerminalLine = null;
  if (fs.existsSync(eventsPath)) {
    initial = fs.readFileSync(eventsPath, "utf8");
    for (const line of initial.split("\n")) {
      if (!line) continue;
      if (passes(line)) writeEventLine(line);
      const terminal = TERMINAL.exec(line);
      if (terminal && !alreadyTerminal) {
        alreadyTerminal = true;
        initialTerminalTag = terminal[1];
        initialTerminalLine = line;
      }
    }
  }

  const timeoutMs = Math.max(1000, Number(options["timeout-ms"]) || 600_000);

  if (!options.follow || alreadyTerminal) {
    const resultPayload = {
      jobId: job.id,
      threadId: job.threadId,
      eventsPath,
      followed: Boolean(options.follow),
      filter: options.filter ?? null,
      exclude: options.exclude ?? null
    };
    if (options.follow && alreadyTerminal) {
      resultPayload.timedOut = false;
      resultPayload.terminalTag = initialTerminalTag;
      resultPayload.terminalLine = initialTerminalLine;
      resultPayload.elapsedMs = 0;
    }
    emitSuccess(
      "events",
      resultPayload,
      "",
      { json: options.json, startedAt }
    );
    return;
  }

  // Tail mode — follow appends until a terminal tag or the timeout.
  let timedOut = false;
  // Capture the terminal tag line so the end-of-stream envelope can report
  // which event actually closed the stream (DONE / ERROR / INCOMPLETE / PLAN / CANCELLED).
  // Pre-1.2.5 the envelope only said `timedOut: true/false`, which
  // under-determined Monitor's "stream ended" signal — callers couldn't
  // tell happy-path [DONE] from an error-closure without re-reading the
  // file. The terminalTag field closes that gap.
  let terminalTag = null;
  let terminalLine = null;
  const followStartMs = Date.now();

  await new Promise((resolve) => {
    let offset = initial.length;
    let watcher = null;
    let pollTimer = null;
    let timer = null;
    let done = false;

    const finish = (reason) => {
      if (done) return;
      done = true;
      if (reason === "timeout") timedOut = true;
      if (watcher) watcher.close();
      if (pollTimer) clearInterval(pollTimer);
      if (timer) clearTimeout(timer);
      resolve();
    };

    const scanAppended = () => {
      let data;
      try {
        data = fs.readFileSync(eventsPath, "utf8");
      } catch (e) {
        if (e.code === "ENOENT") return;
        throw e;
      }
      if (data.length < offset) offset = 0;
      const tail = data.slice(offset);
      offset = data.length;
      const lines = tail.split("\n");
      // The last element is either "" (trailing newline) or a partial line.
      // Including partial lines would duplicate on the next scan; skip the
      // final element to defer partials until a newline arrives.
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (!line) continue;
        if (passes(line)) writeEventLine(line);
        if (TERMINAL.test(line)) {
          terminalTag = TERMINAL.exec(line)[1];
          terminalLine = line;
          return finish("terminal");
        }
      }
    };

    const attachWatcher = () => {
      try {
        watcher = fs.watch(eventsPath, { persistent: false }, scanAppended);
        scanAppended();
      } catch (e) {
        if (e.code === "ENOENT") {
          if (!pollTimer)
            pollTimer = setInterval(() => {
              if (fs.existsSync(eventsPath)) {
                clearInterval(pollTimer);
                pollTimer = null;
                attachWatcher();
              }
            }, 500);
        } else {
          throw e;
        }
      }
    };

    if (fs.existsSync(eventsPath)) {
      attachWatcher();
    } else {
      pollTimer = setInterval(() => {
        if (fs.existsSync(eventsPath)) {
          clearInterval(pollTimer);
          pollTimer = null;
          attachWatcher();
        }
      }, 500);
    }

    timer = setTimeout(() => finish("timeout"), timeoutMs);
  });

  if (timedOut && !options.json) {
    throw new CliError(
      `No terminal event in ${eventsPath} within ${Math.round(timeoutMs / 1000)}s.`,
      {
        class: "timeout",
        code: "WAIT_TIMEOUT",
        retryable: true,
        suggestion: "Run `status <job-id>` to inspect live state."
      }
    );
  }

  emitSuccess(
    "events",
    {
      jobId: job.id,
      threadId: job.threadId,
      eventsPath,
      followed: true,
      filter: options.filter ?? null,
      exclude: options.exclude ?? null,
      timedOut,
      // Final-envelope fields added in 1.2.5 so Monitor / orchestrators can
      // distinguish happy-path closure from timeout without re-reading the
      // file. terminalTag is one of DONE / ERROR / INCOMPLETE / PLAN / CANCELLED on success,
      // or null when the stream ended via timeout. elapsedMs measures
      // follow duration only (not total job elapsed time).
      terminalTag,
      terminalLine,
      elapsedMs: Date.now() - followStartMs
    },
    "",
    { json: options.json, startedAt }
  );
}

export function handleTaskResumeCandidate(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  emitSuccess("task-resume-candidate", payload, rendered, {
    json: options.json,
    startedAt
  });
}

export async function handleSummary(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["tail", "cwd"],
    booleanOptions: ["json"]
  });

  const threadId = positionals[0];
  if (!threadId) {
    throw usageError("summary requires <thread-id>");
  }

  const cwd = resolveCommandCwd(options);
  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const session = findSession(sessionDir, threadId);
  if (!session) {
    throw notFoundError(
      `No session found for thread ${threadId}`,
      "SESSION_NOT_FOUND"
    );
  }

  const tailLines = parseInt(options.tail) || 200;
  let content;
  try {
    content = fs.readFileSync(session.ndjsonPath, "utf8");
  } catch {
    throw new CliError(
      `Cannot read session log: ${session.ndjsonPath}`,
      { class: "internal", code: "SESSION_LOG_UNREADABLE", retryable: false }
    );
  }

  const allLines = content.split("\n").filter(Boolean);
  const lines = allLines.slice(-tailLines);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  const transcript = buildTranscript(entries, threadId);
  emitSuccess("summary", { threadId, entries }, `${transcript}\n`, {
    json: options.json,
    startedAt
  });
}

function buildTranscript(entries, threadId) {
  const lines = [`## Thread ${threadId}`];
  let currentTurnId = null;
  let turnIndex = 0;

  for (const entry of entries) {
    if (entry.tag === "TURN_STARTED" || (entry.method === "turn/started" && entry.data?.turn?.id)) {
      turnIndex += 1;
      currentTurnId = entry.data?.turn?.id ?? entry.data?.turnId ?? `turn-${turnIndex}`;
      const ts = entry.ts ? entry.ts.slice(11, 19) : "";
      lines.push("", `### Turn ${turnIndex} — ${ts}`);
      continue;
    }

    if (entry.method === "item/completed") {
      const item = normalizeCompletedItem(entry) ?? {};
      if (item.type === "userMessage") {
        const text = item.content?.map((c) => c.text).join(" ") ?? "";
        lines.push(`> ${text}`);
      } else if (item.type === "agentMessage") {
        lines.push("", `**Assistant:** ${item.text ?? ""}`);
      } else if (item.type === "plan") {
        lines.push("", `**Plan proposed:**`, item.text ?? "");
      } else if (item.type === "commandExecution") {
        const cmd = (item.command ?? "").slice(0, 200);
        lines.push(`tool: shell ${cmd}`);
      } else if (item.type === "fileChange") {
        const files = (item.changes ?? []).map((c) => c.path).join(", ");
        lines.push(`tool: apply_patch ${files.slice(0, 200)}`);
      } else if (item.type === "exitedReviewMode") {
        lines.push("", `**Review:** ${item.review ?? ""}`);
      }
      continue;
    }

    if (entry.tag === "ERROR") {
      lines.push("", `**Error:** ${entry.data?.message ?? JSON.stringify(entry.data)}`);
    }
  }

  return lines.join("\n");
}

// ── MAIN ──────────────────────────────────────────────────────────────────
