import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { guardCapability } from "./adapters/index.mjs";
import {
  CliError,
  emitError,
  emitSuccess,
  detectJsonFlag,
  detectHelpFlag,
  usageError,
  validationError,
  notFoundError,
  conflictError,
  invalidThreadIdError,
  classifyTurnErrorOrigin,
  classifyError,
  normalizeCodexErrorInfo,
  getUpstreamRetryPolicy,
  buildHandoffEnvelope,
  buildErrorEnvelope,
  extractUpstreamRequestId
} from "./lib/cli-errors.mjs";
import { isThreadId } from "./lib/thread-id.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./adapters/codex/codex.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, createSubagentWorktree, ensureGitRepository, getWorkingTreeState, mergeSubagentBranch, resolveReviewTarget } from "./lib/git.mjs";
import {
  existsTask,
  jobDir,
  listTasks,
  readMeta,
  readVerdict,
  writeMeta,
  writeVerdict,
  writeReview as writeRegistryReview,
  writeBriefArtifacts,
  writeDiffArtifact
} from "./lib/registry.mjs";
import { loadBrief, renderBriefAsMarkdown } from "./lib/brief.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "./lib/process.mjs";
import { buildAdversarialReviewPrompt } from "./lib/adversarial-review-prompt.mjs";
import {
  detectOfficialOpenAICodexPlugin,
  OFFICIAL_PLUGIN_STATUS
} from "./lib/official-plugin.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  resolveJobFile,
  setConfig,
  updateState,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";
import {
  buildCollaborationMode,
  buildSandboxPolicy,
  COMPLETION_CHECK_SCHEMA,
  DEFAULT_CONFIG,
  resolveConfigLayers,
  resolveConfigSources,
  validateConfigLayers
} from "./lib/config.mjs";
import {
  resolveSessionDir,
  initSession,
  findSession,
  writeSessionAliases,
  logNdjson,
  logEvent,
  captureGitDiff,
  captureGitSnapshot,
  diffGitSnapshot,
  writePlan,
  formatDoneEvent,
  formatErrorEvent,
  formatIncompleteEvent,
  formatQuestionEvent,
  formatPlanEvent,
  formatConfirmedEvent,
  formatPipelineEvent,
  formatHeartbeatEvent,
  formatCheckpointEvent,
  formatPhaseEvent,
  formatReviewEvent,
  formatWarningEvent,
  formatDirectivesEvent,
  formatPartialEvent,
  formatRetryingEvent,
  formatHandoffEvent,
  TERMINAL_TAG_REGEX,
  writeReview as writeSessionReview
} from "./lib/session-log.mjs";
import {
  readPendingRequestById,
  writePendingRequest,
  waitForResponse,
  clearPendingRequest,
} from "./lib/pending-requests.mjs";
import { runAutoPipeline } from "./adapters/codex/pipeline.mjs";
import { checkForUpdate, formatUpdateNotice, maybeTriggerAutoApply } from "./lib/update-check.mjs";
import {
  mapReviewVerdictToTaskVerdict,
  normalizeAdversarialReviewResult,
  normalizeNativeReviewResult
} from "./lib/review-result.mjs";
import { runIterateLoop } from "./lib/iterate-loop.mjs";
import {
  BRIDGE_CAPABILITIES,
  BRIDGE_SCHEMA_VERSION,
  BRIDGE_VERSION,
  DEFAULT_STATUS_POLL_INTERVAL_MS,
  DEFAULT_STATUS_WAIT_TIMEOUT_MS,
  EXECUTE_INSTRUCTIONS_PATH,
  MODEL_ALIASES,
  PLAN_ENFORCEMENT_PATH,
  REVIEW_SCHEMA,
  ROOT_DIR,
  SCRIPT_DIR,
  SCRIPT_PATH,
  STOP_REVIEW_GATE_LOCK_FILE,
  STOP_REVIEW_TASK_MARKER,
  VALID_REASONING_EFFORTS,
} from "./lib/runtime-paths.mjs";
import {
  ensureCodexRuntimeAdapter,
  getBridgeConfig,
  loadDeveloperInstructions,
  resolveCommandAdapter,
} from "./lib/bridge-config.mjs";
import {
  appendRenderedBriefToPrompt,
  bridgeCommand,
  buildMonitorHint,
  buildRecovery,
  extractItemText,
} from "./lib/envelope-helpers.mjs";
import { COMMANDS, EXIT_CODE_DOC, GLOBAL_FLAGS_DOC } from "./commands-meta.mjs";
import { buildMachineReadableHelp, handleAuthStatus, handleConfigShow, handleSetup, handleUpdate, handleVersion } from "./handlers/meta.mjs";
import { handleAdversarialReview, handleReview } from "./handlers/review.mjs";
import { handleCancel, handleRespond, handleSend, handleSteer, handleTask, handleTaskWorker } from "./handlers/task.mjs";
import { handleAwaitArtifact, handleEvents, handleResult, handleStatus, handleSummary, handleTaskResumeCandidate, handleWait } from "./handlers/inspect.mjs";
import { handleIterate, handleMerge, handleVerdict, handleVerdictsPending } from "./handlers/registry.mjs";
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
} from "./lib/task-runtime.mjs";
function printUsage() {
  const lines = ["Usage:"];
  for (const name of Object.keys(COMMANDS)) {
    lines.push(`  codex-bridge ${COMMANDS[name].synopsis}`);
  }
  lines.push("", GLOBAL_FLAGS_DOC, "", EXIT_CODE_DOC, "", "Run `codex-bridge <subcommand> --help` for per-command details.");
  console.log(lines.join("\n"));
}

function printSubcommandUsage(name) {
  const entry = COMMANDS[name];
  if (!entry) {
    printUsage();
    return;
  }
  const lines = [
    `codex-bridge ${entry.synopsis}`,
    "",
    entry.summary
  ];
  if (entry.examples?.length) {
    lines.push("", "Examples:");
    for (const example of entry.examples) {
      lines.push(`  ${example}`);
    }
  }
  lines.push("", GLOBAL_FLAGS_DOC, "", EXIT_CODE_DOC);
  console.log(lines.join("\n"));
}

// Success output is funneled through `emitSuccess` from ./lib/cli-errors.mjs.
// Every handler captures `startedAt = Date.now()` at entry and passes it so the
// envelope can carry `meta.duration_ms`. Raw stdout writes are only for the
// human banners of send/steer/respond/version/auth-status.
const SUBCOMMAND_DISPATCH = Object.freeze({
  setup: handleSetup,
  version: handleVersion,
  update: handleUpdate,
  config: handleConfigShow,
  "auth-status": handleAuthStatus,
  review: handleReview,
  "adversarial-review": handleAdversarialReview,
  task: handleTask,
  "task-worker": handleTaskWorker,
  send: handleSend,
  steer: handleSteer,
  respond: handleRespond,
  summary: handleSummary,
  status: handleStatus,
  result: handleResult,
  wait: handleWait,
  events: handleEvents,
  "task-resume-candidate": handleTaskResumeCandidate,
  cancel: handleCancel,
  "await-artifact": handleAwaitArtifact,
  merge: handleMerge,
  verdict: handleVerdict,
  verdicts: handleVerdictsPending,
  iterate: handleIterate
});

// Node's default SIGPIPE handling terminates the process when a downstream
// reader closes the pipe (e.g. `codex-bridge task | head -10`). For the
// foreground `task` / `send` / `review` paths that emit streaming progress to
// stdout, this kills the wrapper mid-turn and orphans the Codex thread — the
// app-server keeps running but our supervisor process is gone, leaving jobs
// stuck in `orphaned` state. Background workers are immune (they use
// `stdio:"ignore"`); this guard makes every foreground command path equally
// tolerant of downstream pipe closure. See `fix/three-live-bugs` plan.
process.on("SIGPIPE", () => {});
process.stdout.on("error", (err) => {
  if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) return;
  throw err;
});
process.stderr.on("error", (err) => {
  if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) return;
  throw err;
});

// Crash-report trap. Prior to v1.2.5 an unhandled rejection or uncaught
// exception between "detached worker spawned" and "envelope emitted" could
// silently exit the wrapper with status 1 while the worker kept running —
// the user saw "launcher exit 1, detached job healthy" with no diagnostic.
// Any such event now writes a JSON dump to ~/.codex-bridge/crashes/<ts>-<pid>.log
// and emits a single stderr line pointing at it. We still propagate the
// process exit (not going to swallow real crashes), but the trail closes the
// "exit 1 without explanation" observability gap.
function writeCrashLog(kind, error) {
  try {
    const crashDir = path.join(os.homedir(), ".codex-bridge", "crashes");
    fs.mkdirSync(crashDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(crashDir, `${ts}-${process.pid}.log`);
    const payload = {
      kind,
      ts,
      pid: process.pid,
      argv: process.argv,
      cwd: process.cwd(),
      nodeVersion: process.version,
      bridgeVersion: BRIDGE_VERSION,
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack, code: error.code }
        : { raw: String(error) }
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    try {
      process.stderr.write(
        `[codex-bridge] internal ${kind}: ${error?.message ?? error} — crash report at ${file}\n`
      );
    } catch { /* stderr already closed; file is enough */ }
  } catch { /* best-effort; never throw from the trap */ }
}
process.on("unhandledRejection", (reason) => {
  writeCrashLog("unhandledRejection", reason);
  process.exitCode = process.exitCode || 1;
});
process.on("uncaughtException", (err) => {
  writeCrashLog("uncaughtException", err);
  process.exit(process.exitCode || 1);
});

async function main() {
  const startedAt = Date.now();
  const rawArgv = process.argv.slice(2);
  const [subcommand, ...argv] = rawArgv;

  // Hot-path auto-apply. Non-blocking fire-and-forget: cache-backed
  // release probe (1 h TTL, anonymous) + detached `npx skills@latest add
  // …` when a newer version lands. Rate-limited to one apply attempt per
  // hour so concurrent invocations don't thrash. Stdio routed to
  // `~/.codex-bridge/auto-update.log` so the caller's output is never
  // touched. Opt out via `CODEX_BRIDGE_NO_UPDATE_CHECK=1`.
  maybeTriggerAutoApply(rawArgv, subcommand);

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    if (detectJsonFlag(rawArgv)) {
      emitSuccess("help", buildMachineReadableHelp(), null, { json: true, startedAt });
      return;
    }
    printUsage();
    return;
  }

  // Per-subcommand --help / -h short-circuits before the handler runs so we
  // never fire a Codex turn just to answer a discovery query. Pass the full
  // rawArgv so the per-subcommand prompt-skipping in detectHelpFlag sees the
  // subcommand at index 0.
  if (COMMANDS[subcommand] && detectHelpFlag(rawArgv)) {
    printSubcommandUsage(subcommand);
    return;
  }

  const handler = SUBCOMMAND_DISPATCH[subcommand];
  if (!handler) {
    throw new CliError(`Unknown subcommand: ${subcommand}`, {
      class: "usage",
      code: "UNKNOWN_SUBCOMMAND",
      retryable: false,
      suggestion: "Run `help --json` to list available subcommands."
    });
  }

  await handler(argv);
}

main().catch((error) => {
  const rawArgv = process.argv.slice(2);
  const json = detectJsonFlag(rawArgv);
  const command = rawArgv[0] && COMMANDS[rawArgv[0]] ? rawArgv[0] : null;
  emitError(error, { json, command });
});
