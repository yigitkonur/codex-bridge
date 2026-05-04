import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Single source of truth for the bridge version: package.json. esbuild inlines
// the JSON content into the bundled distributable at build time, so the
// installed skill/scripts/bundle stays in sync with the published version
// without a manual string sweep. Pre-1.2.5 the version was hard-coded here at
// line ~620 and drifted (package.json bumped to 1.2.4 while the const still
// read "1.2.3"), causing `version --json` and the update checker to report a
// stale number.
import packageJson from "../package.json" with { type: "json" };

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { guardCapability, resolveAdapterForRuntime } from "./adapters/index.mjs";
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
  loadConfig,
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
  formatTailCommand,
  formatPartialEvent,
  formatRetryingEvent,
  formatHandoffEvent,
  TERMINAL_TAGS,
  TERMINAL_TAG_REGEX,
  DEFAULT_MONITOR_EXCLUDE,
  writeReview as writeSessionReview
} from "./lib/session-log.mjs";
import {
  readPendingRequestById,
  writePendingRequest,
  waitForResponse,
  clearPendingRequest,
} from "./lib/pending-requests.mjs";
import { runAutoPipeline } from "./adapters/codex/pipeline.mjs";
import { checkForUpdate, formatUpdateNotice, shouldAttemptApply, markApplyAttempted } from "./lib/update-check.mjs";
import {
  mapReviewVerdictToTaskVerdict,
  normalizeAdversarialReviewResult,
  normalizeNativeReviewResult
} from "./lib/review-result.mjs";
import { runIterateLoop } from "./lib/iterate-loop.mjs";

function buildRecovery({ reason, retryable, nextActions = [], artifacts = {}, details = {} }) {
  return {
    schema_version: "1.0",
    reason,
    retryable: Boolean(retryable),
    next_actions: nextActions,
    artifacts,
    details,
  };
}

function mirrorDiffToRegistry(taskId, diffPath) {
  if (!taskId || !diffPath) return null;
  try {
    if (!fs.existsSync(diffPath)) return null;
    return writeDiffArtifact(taskId, fs.readFileSync(diffPath, "utf8"));
  } catch {
    return null;
  }
}

// Hot-path auto-apply. On every non-json, non-update/version invocation the
// bridge:
//   1. Triggers a cache-backed (1 h TTL) release probe — cost: one HTTPS
//      call at most once per hour per workspace, anonymous, non-blocking.
//   2. If a newer version exists AND no apply attempt has landed in the
//      last hour, spawns `npx -y skills@latest add yigitkonur/codex-bridge
//      -a claude-code -g -y` detached, with stdio routed to
//      `~/.codex-bridge/auto-update.log` so the caller's stdio is never
//      touched. Installer completes in the background; the NEXT invocation
//      of the bridge picks up the new files.
//
// Guards (any one → no-op):
//   - `CODEX_BRIDGE_NO_UPDATE_CHECK=1` env         → user disabled
//   - `--json` mode                                 → would corrupt envelope
//   - `update` / `version` subcommands              → own the update UX
//   - help / no-subcommand                          → keep usage clean
//   - `shouldAttemptApply()` returns false          → rate-limited (1 h)
//
// Never blocks, never throws, never writes to the caller's stdio.
function maybeTriggerAutoApply(rawArgv, subcommand) {
  try {
    if (process.env.CODEX_BRIDGE_NO_UPDATE_CHECK === "1") return;
    if (detectJsonFlag(rawArgv)) return;
    if (detectHelpFlag(rawArgv)) return;
    if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") return;
    if (subcommand === "version" || subcommand === "update") return;

    void checkForUpdate({ currentVersion: BRIDGE_VERSION })
      .then((result) => {
        if (!result || !result.hasUpdate || !result.latestVersion) return;
        if (!shouldAttemptApply()) return;
        // Claim the 1 h slot BEFORE spawning so concurrent invocations
        // don't all race to install the same release.
        markApplyAttempted(result.latestVersion);
        spawnDetachedAutoApply(result.latestVersion);
      })
      .catch(() => {
        // Anything thrown here is the update-check path's problem, not
        // the caller's. Swallow and let the next invocation retry.
      });
  } catch {
    // Must never fail the caller.
  }
}

// Spawns `npx -y skills@latest add …` detached with stdio routed to a
// log file in `~/.codex-bridge/auto-update.log`. Fire-and-forget: parent
// calls `.unref()` so the caller's exit isn't delayed, and the child's
// outcome is visible only via the log file (readable by `bridge update
// --force` next time, or directly).
function spawnDetachedAutoApply(targetVersion) {
  try {
    const logDir = path.join(os.homedir(), ".codex-bridge");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "auto-update.log");

    // Crude rotation: if the log crosses ~2 MB, truncate. Failed installs
    // on a loop could otherwise grow it unboundedly over months.
    try {
      const stat = fs.statSync(logFile);
      if (stat.size > 2 * 1024 * 1024) fs.truncateSync(logFile, 0);
    } catch { /* file doesn't exist yet — fine */ }

    const fd = fs.openSync(logFile, "a");
    try {
      const banner = `\n[${new Date().toISOString()}] auto-apply triggered for v${targetVersion} (from ${BRIDGE_VERSION})\n`;
      fs.writeSync(fd, banner);

      const child = spawn(
        "npx",
        ["-y", "skills@latest", "add", "yigitkonur/codex-bridge", "-a", "claude-code", "-g", "-y"],
        {
          detached: true,
          stdio: ["ignore", fd, fd],
          env: process.env,
        }
      );
      // Spawn can still fail asynchronously after the constructor returns
      // (e.g. ENOENT when npx isn't on PATH). The parent closes `fd` after
      // unref, so reopen by path for the late diagnostic.
      child.on("error", () => {
        try {
          fs.appendFileSync(logFile, `[${new Date().toISOString()}] spawn failed (npx not on PATH?)\n`, "utf8");
        } catch { /* log unavailable */ }
      });
      child.unref();
    } finally {
      try { fs.closeSync(fd); } catch { /* already dup'd into child */ }
    }
  } catch {
    // Best-effort. Any failure here (mkdir, open, spawn constructor)
    // just means this invocation doesn't auto-apply; next one will.
  }
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(SCRIPT_DIR, "codex-bridge.mjs");
// In dev: src/ → schemas are at src/schemas/
// After bundle: skill/scripts/ → schemas are at skill/schemas/ (one level up)
const ROOT_DIR = fs.existsSync(path.join(SCRIPT_DIR, "schemas"))
  ? SCRIPT_DIR
  : path.resolve(SCRIPT_DIR, "..");
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const EXECUTE_INSTRUCTIONS_PATH = path.join(ROOT_DIR, "templates", "execute-instructions.md");
const PLAN_ENFORCEMENT_PATH = path.join(ROOT_DIR, "templates", "plan-enforcement.md");

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function bridgeCommand(subcommand, cwd = null) {
  return `node ${shellQuote(SCRIPT_PATH)} ${subcommand}${cwd ? ` --cwd ${shellQuote(cwd)}` : ""}`;
}

function buildTurnErrorNextAction({ origin, errorCode, threadId, jobId = null, cwd = null, stateCwd = null }) {
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

const DEVELOPER_INSTRUCTIONS_FALLBACK = {
  plan: "Produce one concrete plan using the plan tool. Do not write code, do not ask questions, do not brainstorm alternatives.",
  default: "Execute the task autonomously. Do not ask questions. Make reasonable assumptions and proceed."
};

function loadDeveloperInstructions(mode) {
  const templatePath = mode === "plan" ? PLAN_ENFORCEMENT_PATH : EXECUTE_INSTRUCTIONS_PATH;
  try {
    return fs.readFileSync(templatePath, "utf8");
  } catch {
    return DEVELOPER_INSTRUCTIONS_FALLBACK[mode] ?? DEVELOPER_INSTRUCTIONS_FALLBACK.default;
  }
}

function appendRenderedBriefToPrompt(prompt, brief) {
  if (!brief) return prompt ?? "";
  const rendered = renderBriefAsMarkdown(brief);
  return [
    prompt ?? "",
    "[CODEX-BRIDGE STRUCTURED BRIEF]",
    "The following brief is part of the worker instructions. Follow the worker_assignment and verify the acceptance_criteria before finishing.",
    rendered,
    "[/CODEX-BRIDGE STRUCTURED BRIEF]",
  ].filter((part) => String(part).trim()).join("\n\n");
}

function prepareRuntimeSession(session, config, jobId) {
  if (!session) return session;
  session.redactSecrets = Boolean(config?.redact_secrets);
  writeSessionAliases(session, jobId);
  return session;
}
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
const STOP_REVIEW_GATE_LOCK_FILE = ".codex-bridge-stop-review-gate.lock";

// Bridge config: skill-dir defaults + optional workspace-root + cwd overrides.
//
// The skill-dir layer is read once and reused (it ships with the skill; it
// doesn't change during a process's lifetime). The workspaceRoot and cwd
// layers are re-read on every call because different subcommands may run
// in different workspaces within one process (e.g. `-C ...`), and each
// invocation's directory context is authoritative.
//
// Call sites with a meaningful cwd (task, send, review, steer, wait,
// events) pass it through; those that ALSO derive a workspaceRoot (task,
// review) pass that too so users running from a subdir of a git repo pick
// up the repo-root config.yaml. Call sites without (help, version) fall
// back to the skill-dir layer only, which is harmless — those commands
// don't consume the knobs the override layers are meant to flip.
let BRIDGE_CONFIG_SKILL_LAYER = null;
function getBridgeConfig(cwd = null, workspaceRoot = null) {
  if (!cwd && !workspaceRoot) {
    if (!BRIDGE_CONFIG_SKILL_LAYER) {
      BRIDGE_CONFIG_SKILL_LAYER = loadConfig(ROOT_DIR);
    }
    return BRIDGE_CONFIG_SKILL_LAYER;
  }
  return loadConfig(ROOT_DIR, cwd, workspaceRoot);
}

async function resolveCommandAdapter({
  cwd = null,
  workspaceRoot = null,
  backend = null,
  metaBackend = null,
  taskMetadata = null,
  subagentType = null,
} = {}) {
  const resolvedWorkspaceRoot = workspaceRoot ?? (cwd ? resolveWorkspaceRoot(cwd) : null);
  return resolveAdapterForRuntime({
    skillDir: ROOT_DIR,
    cwd,
    workspaceRoot: resolvedWorkspaceRoot,
    backend,
    metaBackend,
    taskMetadata,
    subagentType,
    env: process.env,
  });
}

function ensureCodexRuntimeAdapter(adapter) {
  if (adapter?.name === "codex") return;
  throw validationError(
    `Backend '${adapter?.name ?? "unknown"}' is selected but this CLI path is not wired to that adapter yet.`,
    "BACKEND_INCAPABLE",
    "Use --backend codex, unset CODEX_BRIDGE_BACKEND, or choose a config default_backend supported by this build."
  );
}

// Pending requests are persisted to disk by the worker process.
// The respond command reads from disk and writes a response file.
// See lib/pending-requests.mjs for the file-based IPC protocol.

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function rejectServerRequest(message, code, detail) {
  message._client?.rejectServerRequest?.(
    message.id,
    buildJsonRpcError(code, detail)
  );
}

function createBridgeServerRequestHandler({ sessionDir, config, questionAnswerMs = null, cwd = null }) {
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

// Produces a ready-to-paste Monitor hint so agents don't have to assemble one
// from eventsPath + terminal tags. Prefers our `events --follow` subcommand
// (stable, filtered) over raw `tail -f`. `eventsPath` may be null when the
// thread id isn't known yet (background launches); in that case the shell
// fallback is omitted but the CLI command still works via the job id.
// Appends a single-line handle footer to a rendered task result. Non-JSON
// foreground output previously surfaced only Codex's finalMessage, which gave
// orchestrators no visible jobId / events path — agents often grabbed the
// thread UUID from stderr `[codex] Thread ready (…)` progress lines because
// that was the most distinctive token they could see. The footer prints the
// canonical ids + a ready-to-paste `events` command so orchestrators can
// pick up the right handle without a `--json` + `jq` dance.
function appendTaskFooter(rendered, { jobId, eventsPath, eventsDir, monitorCommand }) {
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

function buildMonitorHint({ eventsPath, jobId, threadId, cwd = null }) {
  const identifier = jobId ?? threadId;
  if (!identifier) return null;
  // v1.4.0 filter contract: exclusion-based, not inclusion-based. Every
  // tag the bridge emits passes through Monitor by default except those
  // in the exclude list — so new tags added in future versions reach
  // existing orchestrators without a filter update.
  // - HEARTBEAT excluded by default: 60-s liveness pulse is pure signal
  //   for the .events file (and the 90-s liveness heuristic), but
  //   floods an LLM's context in a long run.
  // - CHECKPOINT stays in the stream: it's the primary LLM-facing
  //   summary (every ~5 min, content-rich).
  // - All interrupt tags (DONE/ERROR/INCOMPLETE/PLAN/QUESTION) pass
  //   through unconditionally.
  // Callers who specifically want the old inclusion model can pass
  // `--filter <tags>` explicitly; the two flags are mutually exclusive.
  const cliCommand = formatTailCommand({
    scriptPath: SCRIPT_PATH,
    jobId: identifier,
    timeoutMs: 1800000,
    exclude: DEFAULT_MONITOR_EXCLUDE,
    cwd,
  });
  const shellFallback = eventsPath
    ? `tail -f ${JSON.stringify(eventsPath)} | while IFS= read -r line; do ` +
      `echo "$line"; case "$line" in "[DONE]"*|"[ERROR]"*|"[INCOMPLETE]"*|"[PLAN]"*) break ;; esac; done`
    : null;
  return {
    command: cliCommand,
    shell_fallback: shellFallback,
    terminal_tags: [...TERMINAL_TAGS],
    exclude_tags: [...DEFAULT_MONITOR_EXCLUDE],
    timeout_ms: 1800000,
    tool_hint: {
      description: "codex-bridge task events (excludes heartbeat noise; passes interrupts + checkpoints through)",
      command: cliCommand,
      timeout_ms: 3600000,
      persistent: false
    }
  };
}

// Extracts a small, retrospective-replay-friendly text preview from an
// `item/completed` payload. Keep the slices tight — NDJSON is a transcript
// replay store, not a verbatim mirror of the wire protocol.
function extractItemText(item) {
  if (!item || typeof item !== "object") return null;
  switch (item.type) {
    case "agentMessage":
      return typeof item.text === "string" ? item.text.slice(0, 500) : null;
    case "commandExecution":
      return typeof item.command === "string" ? item.command.slice(0, 200) : null;
    case "fileChange": {
      // item.changes[] carries per-path details; summarize first change.
      const changes = Array.isArray(item.changes) ? item.changes : [];
      if (changes.length === 0) {
        return typeof item.path === "string" ? item.path : null;
      }
      const first = changes[0] ?? {};
      const kind = first.kind ?? first.change ?? first.op ?? "";
      const path = first.path ?? "";
      const summary = `${kind ? kind + " " : ""}${path}`.trim();
      if (!summary) return null;
      const suffix = changes.length > 1 ? ` (+${changes.length - 1} more)` : "";
      return `${summary}${suffix}`.slice(0, 200);
    }
    case "plan":
      if (typeof item.title === "string" && item.title.trim()) {
        return item.title.slice(0, 200);
      }
      if (typeof item.text === "string") {
        const firstLine = item.text.split("\n").find((line) => line.trim()) ?? "";
        return firstLine ? firstLine.slice(0, 200) : null;
      }
      return null;
    case "reasoning":
      // Reasoning summaries are arrays of blocks; pick the first textual one.
      if (typeof item.summary === "string") {
        return item.summary.slice(0, 200);
      }
      if (Array.isArray(item.summary)) {
        for (const section of item.summary) {
          if (typeof section === "string" && section.trim()) {
            return section.slice(0, 200);
          }
          if (section && typeof section === "object" && typeof section.text === "string" && section.text.trim()) {
            return section.text.slice(0, 200);
          }
        }
      }
      return null;
    case "mcpToolCall":
      if (item.server || item.tool) {
        return `${item.server ?? ""}/${item.tool ?? ""}`.slice(0, 200);
      }
      return null;
    case "commandExecutionOutput":
    case "webSearch":
      if (typeof item.query === "string") return item.query.slice(0, 200);
      return null;
    default:
      return null;
  }
}

// Single source of truth for subcommand synopses. Every entry must match the
// actual `booleanOptions` / `valueOptions` list in its handler; treat this
// table as the CLI contract and update it in the same commit as any flag move.
const COMMANDS = Object.freeze({
  task: {
    synopsis: "task [--write] [--read-only] [--worktree-auto] [--brief @<path>.json|<inline-json>] [--mode plan|default] [--effort <level>] [-m <model>] [--prompt-file <path>] [--resume|--resume-last] [--fresh] [--background] [--no-pipeline] [--quiet] [--idle-timeout-ms <ms>] [--turn-plan-ms <ms>] [--turn-default-ms <ms>] [--pipeline-stage-timeout-ms <ms>] [--pipeline-total-timeout-ms <ms>] [--question-timeout-ms <ms>] [--legacy-envelope] [--json] [prompt or file.md]",
    summary: "Start a new Codex task. Defaults: plan mode, configured sandbox, foreground. Use --mode default to skip planning and execute directly. --worktree-auto isolates write-mode work in a per-task git worktree. --brief @path.json appends a structured brief to the worker prompt and persists it under the artifact registry.",
    examples: [
      'codex-bridge task --write "Fix the auth bug in src/auth.ts"',
      'codex-bridge task --mode default --write "Trivial typo fix"',
      "codex-bridge task --prompt-file prompt.md --effort high --write",
      'codex-bridge task --resume-last "Continue the previous thread"',
      'codex-bridge task --background --write "Rewrite tests" --json',
      'codex-bridge task --background --write --worktree-auto --brief @brief.json --json "Implement the task described in the structured brief"'
    ]
  },
  send: {
    synopsis: "send <thread-id> [--backend <name>] [--mode plan|default] [--effort <level>] [--quiet] [--idle-timeout-ms <ms>] [--turn-timeout-ms <ms>] [--question-timeout-ms <ms>] [--json] [prompt or file.md]",
    summary: "Resume a thread with a new prompt. Use for plan approval, revisions, and follow-ups. <thread-id> is a UUID returned by task.",
    examples: [
      'codex-bridge send 019d9a86-1c8a-7f41-8032-6c76bbe730a1 --mode default "Implement the plan."',
      'codex-bridge send 019d9a86-1c8a-7f41-8032-6c76bbe730a1 "Revise step 2: use token bucket instead"'
    ]
  },
  steer: {
    synopsis: "steer <thread-id> <turn-id> [--backend <name>] [prompt or file.md]",
    summary: "Send mid-turn guidance to an active Codex turn. Not valid for review/compaction turns. Both ids are UUIDs.",
    examples: ['codex-bridge steer 019d9a86-1c8a-7f41-8032-6c76bbe730a1 019d9a86-2012-7152-bcc9-228a263d286a "Focus on auth first"']
  },
  respond: {
    synopsis: "respond <request-id> [--backend <name>] (--question-id <qid> --answer <answer> | --json-payload <json>) [--json]",
    summary: "Answer a [QUESTION] emitted by Codex (requestUserInput).",
    examples: [
      'codex-bridge respond req-xyz --question-id q1 --answer "jwt"',
      "codex-bridge respond req-xyz --json-payload '{\"answers\":{\"q1\":{\"answers\":[\"jwt\"]}}}'"
    ]
  },
  review: {
    synopsis: "review [--backend <name>] [--task <task_id>] [--scope auto|working-tree|branch] [--base <ref>] [-m <model>] [--json]",
    summary: "Run a standalone code review using Codex's built-in reviewer. With --task, review the task worktree and bind the JSON review_result to the reviewed branch HEAD.",
    examples: [
      "codex-bridge review --scope working-tree",
      "codex-bridge review --scope branch --base main",
      "codex-bridge review --task task-mo5xxx --json"
    ]
  },
  "adversarial-review": {
    synopsis: "adversarial-review [--backend <name>] [--task <task_id>] [--scope auto|working-tree|branch] [--base <ref>] [-m <model>] [--brief @<path>.json] [--concern <text>]... [--json] [focus text...]",
    summary: "Run an adversarial review with a structured JSON result. With --task, review the task worktree and bind the JSON review_result to the reviewed branch HEAD. --brief and --concern populate the {{OPUS_CONCERNS}} channel in the prompt — the orchestrator's privileged focus signal. Brief items precede flag items and are de-duped while preserving order.",
    examples: [
      'codex-bridge adversarial-review "focus on SQL injection risks"',
      "codex-bridge adversarial-review --scope branch --base main",
      "codex-bridge adversarial-review --brief @review-brief.json",
      'codex-bridge adversarial-review --concern "Don\'t swallow non-retryable 4xx" --concern "Make timeout configurable"',
      "codex-bridge adversarial-review --task task-mo5xxx --json"
    ]
  },
  iterate: {
    synopsis: "iterate <task_id_or_prompt> [--max <n>] [--brief <path>] [--backend <name>] [--write] [--json]",
    summary: "Run task -> adversarial review -> verdict -> follow-up until approved or the iteration limit is reached.",
    examples: [
      'codex-bridge iterate "Implement the brief" --max 3 --json',
      "codex-bridge iterate task-abc --max 2"
    ]
  },
  summary: {
    synopsis: "summary <thread-id> [--tail <n>] [--json]",
    summary: "Generate a readable transcript from the NDJSON session log (default tail=200).",
    examples: ["codex-bridge summary 019d9a86-1c8a-7f41-8032-6c76bbe730a1 --tail 400"]
  },
  status: {
    synopsis: "status [job-id] [--all] [--wait] [--watch [--interval 10s] [--watch-timeout-ms <ms>]] [--prune-orphans|--cleanup [--dry-run] [--retention-days <n>] [--retention-jobs <n>]] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]",
    summary: "List jobs, or inspect one by id. With --wait, poll one job to terminal. With --watch, repeatedly render the multi-job table and exit when all tracked jobs reach terminal state (Ctrl-C-safe). Use --watch for N-job orchestration.",
    examples: [
      "codex-bridge status",
      "codex-bridge status task-abc --wait --timeout-ms 600000",
      "codex-bridge status --all --json",
      "codex-bridge status --watch --interval 5s",
      "codex-bridge status --watch --all --json"
    ]
  },
  result: {
    synopsis: "result [job-id] [--json]",
    summary: "Get the full result of a completed job. Omit job-id for the latest in this session.",
    examples: ["codex-bridge result task-abc --json"]
  },
  wait: {
    synopsis: "wait [--any] <job-id-or-thread-id...> [--timeout-ms <ms>] [--json]",
    summary: "Block until target job events emit [DONE], [ERROR], [INCOMPLETE], or [PLAN]. With --any, return the first terminal job from N targets.",
    examples: [
      "codex-bridge wait task-abc --timeout-ms 600000 --json",
      "codex-bridge wait --any task-a task-b task-c --json",
      "codex-bridge wait 019d9a86-1c8a-7f41-8032-6c76bbe730a1"
    ]
  },
  events: {
    synopsis: "events <job-id-or-thread-id> [--follow] [--filter <tags> | --exclude <tags>] [--timeout-ms <ms>] [--json]",
    summary: "Stream the target's events file. `--filter` keeps only listed tags (inclusion); `--exclude` drops listed tags and shows everything else (exclusion — forward-compatible default for Monitor). Flags are mutually exclusive.",
    examples: [
      "codex-bridge events task-abc --follow --exclude HEARTBEAT  # default Monitor shape",
      "codex-bridge events task-abc --filter DONE,ERROR,INCOMPLETE,PLAN  # narrow inclusion view",
      "codex-bridge events 019d9a86-1c8a-7f41-8032-6c76bbe730a1 --follow --exclude HEARTBEAT,CHECKPOINT --timeout-ms 600000"
    ]
  },
  cancel: {
    synopsis: "cancel [job-id] [--json]",
    summary: "Cancel a running job. Attempts `turn/interrupt` before terminating the worker tree.",
    examples: ["codex-bridge cancel task-abc"]
  },
  merge: {
    synopsis: "merge <task_id> [--no-tests] [--pr] [--json]",
    summary: "Fast-forward merge an approved worktree task branch back into its recorded base ref.",
    examples: [
      "codex-bridge merge task-abc --json",
      "codex-bridge merge task-abc --no-tests"
    ]
  },
  "await-artifact": {
    synopsis: "await-artifact <job-id> <path> [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]",
    summary: "Block until <path> exists and is stable (size unchanged across consecutive polls), or the target job reaches a terminal state, or timeout. Primitive for multi-job orchestration when success = 'artifact exists at path'. Exit 7 on timeout or job-terminal-without-artifact.",
    examples: [
      "codex-bridge await-artifact task-abc report.md --timeout-ms 600000",
      "codex-bridge await-artifact 019d9a86-1c8a-7f41-8032-6c76bbe730a1 ./out/summary.json --json"
    ]
  },
  setup: {
    synopsis: "setup [--json] [--enable-review-gate | --disable-review-gate]",
    summary: "Health check: Node/npm/Codex install, auth, broker runtime; toggle stop-gate review.",
    examples: ["codex-bridge setup --json"]
  },
  version: {
    synopsis: "version [--backend <name>] [--check-update] [--json]",
    summary: "Print bridge version, schema version, Node version, Codex version, active backend, capability list, and cached update status. `--check-update` forces a fresh GitHub round-trip.",
    examples: ["codex-bridge version --json", "codex-bridge version --backend codex --json", "codex-bridge version --check-update --json"]
  },
  update: {
    synopsis: "update [--force] [--apply|--yes] [--json]",
    summary: "Check GitHub releases for a newer codex-bridge and print the install recipe. Does not self-modify the skill — run the printed command yourself when you want to upgrade.",
    examples: ["codex-bridge update --json", "codex-bridge update --force"]
  },
  config: {
    synopsis: "config show [--json]",
    summary: "Show effective merged config + which files the values came from (defaults < skill-dir < workspace-root < cwd). Use when a config knob seems to have no effect.",
    examples: ["codex-bridge config show", "codex-bridge config show --json"]
  },
  "auth-status": {
    synopsis: "auth-status [--json]",
    summary: "Report Codex auth state (thin wrapper; `setup` is the heavyweight equivalent).",
    examples: ["codex-bridge auth-status --json"]
  },
  "task-resume-candidate": {
    synopsis: "task-resume-candidate [--json]",
    summary: "Report the latest resumable task for this Claude session (useful before `task --resume`).",
    examples: ["codex-bridge task-resume-candidate --json"]
  },
  verdict: {
    synopsis: "verdict <task-id> [--set approved|needs-attention|must-fix --summary <text> [--finding <text>]... | --payload-stdin | --discard] [--json]",
    summary: "Read or write a task's verdict.json. Read mode (no flags) prints the current verdict. Write mode (--set) persists; stdin mode (--payload-stdin) reads a JSON object without putting review text in argv. --discard removes the artifact directory and clears the Stop gate's pending list. The Stop hook blocks while approved verdicts are unmerged.",
    examples: [
      "codex-bridge verdict task-mo5xxx",
      'codex-bridge verdict task-mo5xxx --set approved --summary "Tests green; concerns dismissed."',
      'codex-bridge verdict task-mo5xxx --set must-fix --finding "Drops 4xx errors silently" --json',
      "codex-bridge verdict task-mo5xxx --payload-stdin --json",
      "codex-bridge verdict task-mo5xxx --discard"
    ]
  },
  verdicts: {
    synopsis: "verdicts --pending [--json]",
    summary: "Flat list of approved-but-unmerged or needs-attention verdicts. Used by the Stop gate hook to decide whether to block session exit. Idempotent.",
    examples: ["codex-bridge verdicts --pending --json"]
  }
});

const EXIT_CODE_DOC = [
  "Exit codes:",
  "  0  success",
  "  1  crash / unhandled internal error",
  "  2  usage error (unknown subcommand, unknown flag, missing argument)",
  "  3  not found (job, thread, or resource)",
  "  4  auth failure (run `codex login`)",
  "  5  conflict (already running, state mismatch)",
  "  6  validation error (bad input)",
  "  7  transient error (timeout, network, rate-limit)  — retry with backoff",
  "  8  partial success (check result details)"
].join("\n");

const GLOBAL_FLAGS_DOC = [
  "Global flags (every subcommand):",
  "  --json            Machine-readable output (error envelope under failures).",
  "  -C, --cwd <dir>   Override the working directory.",
  "  -h, --help        Show help for the subcommand and exit."
].join("\n");

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

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw validationError(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`,
      "INVALID_EFFORT"
    );
  }
  return normalized;
}

// Re-split argv elements that the shell didn't tokenize for us. Two shapes
// fall through here:
//
//   1. Slash-command wrappers (commands/*.md) that expand `$ARGUMENTS`
//      INTO ONE quoted argv element — the legacy single-element form.
//   2. Round-6 mixed-up form: a wrapper hard-codes some flags AND quotes
//      `$ARGUMENTS`, e.g. `setup --json "$ARGUMENTS"`. With user input
//      `--enable-review-gate --json`, the shell yields two argv elements
//      `["--json", "--enable-review-gate --json"]` — the second is a
//      collapsed flag bag that strict parseArgs would reject as an unknown
//      single flag named `"--enable-review-gate --json"`.
//
// We must NOT re-split task/adversarial-review prompt content, where a
// quoted prompt like `"write the plan"` arrives as one whitespace-bearing
// element by design. Heuristic: only re-split when the element clearly
// looks like a flag bag — its first non-whitespace character is `-`.
// Prompts almost never start with `-`; if a user really wants a leading-
// hyphen prompt they pass it after `--`. This keeps prompt fidelity for
// `task`/`adversarial-review`/`send` while fixing the flag-collapse case.
function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  const out = [];
  for (const element of argv) {
    if (typeof element === "string" && /\s/.test(element) && element.trimStart().startsWith("-")) {
      const tokens = splitRawArgumentString(element);
      if (tokens.length > 1) {
        out.push(...tokens);
        continue;
      }
    }
    out.push(element);
  }
  return out;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function resolveStopReviewGateLockPath(workspaceRoot) {
  return path.join(workspaceRoot, STOP_REVIEW_GATE_LOCK_FILE);
}

function readStopReviewGate(workspaceRoot, officialPlugin = detectOfficialOpenAICodexPlugin({ cwd: workspaceRoot })) {
  const lockPath = resolveStopReviewGateLockPath(workspaceRoot);
  let lockExists = fs.existsSync(lockPath);
  // Legacy migration: workspaces that enabled the gate before the lock-file
  // change only have `config.stopReviewGate: true` persisted in state.json.
  // Honor that intent and write the lock once so subsequent reads are
  // canonical without forcing the user to rerun setup --enable-review-gate.
  let migratedFromLegacyConfig = false;
  if (!lockExists) {
    let legacyEnabled = false;
    try {
      legacyEnabled = getConfig(workspaceRoot)?.stopReviewGate === true;
    } catch {
      legacyEnabled = false;
    }
    if (legacyEnabled) {
      try {
        fs.writeFileSync(
          lockPath,
          [
            "# Codex Bridge stop-time review gate",
            "# Presence of this file enables the Claude Code Stop hook for this project.",
            "# Migrated from legacy state.json config.stopReviewGate=true.",
            ""
          ].join("\n"),
          "utf8"
        );
        lockExists = true;
        migratedFromLegacyConfig = true;
      } catch {
        // Best-effort migration; even if the lock cannot be written we still
        // honor the user's recorded intent for this read.
        lockExists = true;
        migratedFromLegacyConfig = true;
      }
    }
  }
  const reviewGateSuppressionReason =
    officialPlugin.status === OFFICIAL_PLUGIN_STATUS.ACTIVE
      ? "official-openai-codex-plugin-active"
      : officialPlugin.status === OFFICIAL_PLUGIN_STATUS.UNKNOWN
        ? "official-openai-codex-plugin-status-unknown"
        : null;
  return {
    enabled: lockExists && reviewGateSuppressionReason == null,
    lockPath,
    lockExists,
    migratedFromLegacyConfig,
    officialOpenAICodexPluginStatus: officialPlugin.status,
    officialOpenAICodexPlugin: officialPlugin.plugin ?? null,
    officialOpenAICodexPluginDetail: officialPlugin.detail ?? null,
    reviewGateSuppressedByOfficialPlugin: officialPlugin.status === OFFICIAL_PLUGIN_STATUS.ACTIVE,
    reviewGateLockIgnored: lockExists && reviewGateSuppressionReason != null,
    reviewGateSuppressionReason
  };
}

function setStopReviewGate(workspaceRoot, enabled, officialPlugin = detectOfficialOpenAICodexPlugin({ cwd: workspaceRoot })) {
  const lockPath = resolveStopReviewGateLockPath(workspaceRoot);
  if (enabled) {
    try {
      fs.writeFileSync(
        lockPath,
        [
          "# Codex Bridge stop-time review gate",
          "# Presence of this file enables the Claude Code Stop hook for this project.",
          ""
        ].join("\n"),
        "utf8"
      );
    } catch {
      // Setup reports the lock absence; a failed gate write must not crash the
      // otherwise-useful setup health check.
    }
  } else {
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // Setup reports if the lock remains present after the removal attempt.
    }
    // Clear any legacy `config.stopReviewGate: true` persisted before the
    // lock-file rollout. Without this, readStopReviewGate's migration path
    // (lines 763-792) sees the stale flag, recreates the lock, and turns
    // disable into a no-op for users on migrated state.
    try {
      setConfig(workspaceRoot, "stopReviewGate", false);
    } catch {
      // Best-effort: if state can't be written, the lock is already gone
      // and the next read will still report the gate as disabled — only
      // workspaces that re-trigger the migration would see the flag flip
      // back. Don't fail the disable command.
    }
  }
  return readStopReviewGate(workspaceRoot, officialPlugin);
}

function applyStopReviewGateSnapshot(snapshot) {
  const gate = readStopReviewGate(snapshot.workspaceRoot);
  return {
    ...snapshot,
    officialOpenAICodexPluginStatus: gate.officialOpenAICodexPluginStatus,
    officialOpenAICodexPlugin: gate.officialOpenAICodexPlugin,
    officialOpenAICodexPluginDetail: gate.officialOpenAICodexPluginDetail,
    reviewGateSuppressedByOfficialPlugin: gate.reviewGateSuppressedByOfficialPlugin,
    reviewGateLockIgnored: gate.reviewGateLockIgnored,
    reviewGateSuppressionReason: gate.reviewGateSuppressionReason,
    config: {
      ...snapshot.config,
      stopReviewGate: gate.enabled,
      stopReviewGateLockPath: gate.lockPath,
      stopReviewGateLockExists: gate.lockExists,
      officialOpenAICodexPluginStatus: gate.officialOpenAICodexPluginStatus,
      reviewGateSuppressedByOfficialPlugin: gate.reviewGateSuppressedByOfficialPlugin,
      reviewGateLockIgnored: gate.reviewGateLockIgnored,
      reviewGateSuppressionReason: gate.reviewGateSuppressionReason
    },
    needsReview: gate.enabled
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = [], options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const officialPlugin = options.officialPlugin ?? detectOfficialOpenAICodexPlugin({ cwd });
  const reviewGate = readStopReviewGate(workspaceRoot, officialPlugin);
  const adapter = await resolveCommandAdapter({ cwd, workspaceRoot });

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (reviewGate.reviewGateSuppressedByOfficialPlugin) {
    nextSteps.push("Use the official OpenAI Codex plugin for stop-time review; Codex Bridge review gate is disabled while it is enabled.");
  } else if (reviewGate.reviewGateSuppressionReason === "official-openai-codex-plugin-status-unknown") {
    nextSteps.push("Codex Bridge could not verify whether the official OpenAI Codex plugin is active, so it will not enable a duplicate stop-time review gate.");
  } else if (!reviewGate.enabled) {
    nextSteps.push("Optional: run `codex-bridge setup --enable-review-gate` to create a project lock file for stop-time review.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    active_backend: adapter.name,
    adapter_capabilities: adapter.capabilities(),
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: reviewGate.enabled,
    reviewGateLockPath: reviewGate.lockPath,
    reviewGateLockExists: reviewGate.lockExists,
    officialOpenAICodexPluginStatus: reviewGate.officialOpenAICodexPluginStatus,
    officialOpenAICodexPlugin: reviewGate.officialOpenAICodexPlugin,
    officialOpenAICodexPluginDetail: reviewGate.officialOpenAICodexPluginDetail,
    reviewGateSuppressedByOfficialPlugin: reviewGate.reviewGateSuppressedByOfficialPlugin,
    reviewGateLockIgnored: reviewGate.reviewGateLockIgnored,
    reviewGateSuppressionReason: reviewGate.reviewGateSuppressionReason,
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw conflictError(
      "Choose either --enable-review-gate or --disable-review-gate.",
      "REVIEW_GATE_CONFLICT"
    );
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];
  const officialPlugin = detectOfficialOpenAICodexPlugin({ cwd, maxAgeMs: 0 });

  if (options["enable-review-gate"]) {
    if (officialPlugin.status === OFFICIAL_PLUGIN_STATUS.ABSENT) {
      const reviewGate = setStopReviewGate(workspaceRoot, true, officialPlugin);
      if (reviewGate.enabled && reviewGate.lockExists) {
        actionsTaken.push(`Enabled the project stop-time review gate via ${reviewGate.lockPath}.`);
      } else {
        actionsTaken.push(
          `Failed to create the stop-time review gate lock at ${reviewGate.lockPath}; the gate is NOT enabled. Check write permissions on the git project root, then rerun \`codex-bridge setup --enable-review-gate\`.`
        );
      }
    } else if (officialPlugin.status === OFFICIAL_PLUGIN_STATUS.ACTIVE) {
      actionsTaken.push("Skipped enabling the Codex Bridge stop-time review gate because the official OpenAI Codex plugin is enabled.");
    } else {
      actionsTaken.push("Skipped enabling the Codex Bridge stop-time review gate because the official OpenAI Codex plugin status could not be verified.");
    }
  } else if (options["disable-review-gate"]) {
    const reviewGate = setStopReviewGate(workspaceRoot, false, officialPlugin);
    if (reviewGate.lockExists) {
      actionsTaken.push(
        `Failed to remove the stop-time review gate lock at ${reviewGate.lockPath}; the gate is still active. Please remove the lock file manually.`
      );
    } else {
      actionsTaken.push(
        `Disabled the project stop-time review gate by removing ${reviewGate.lockPath}.`
      );
    }
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken, { officialPlugin });
  emitSuccess("setup", finalReport, renderSetupReport(finalReport), {
    json: options.json,
    startedAt
  });
}

const BRIDGE_VERSION = packageJson.version;
const BRIDGE_SCHEMA_VERSION = "1.0";
const BRIDGE_CAPABILITIES = Object.freeze([
  "plan-mode",
  "background-jobs",
  "auto-pipeline",
  "adversarial-review",
  "stop-gate-review",
  "structured-errors",
  "per-subcommand-help",
  "machine-readable-help",
  "workspace-config-override",
  "update-check",
  "backend-adapter"
]);

async function handleVersion(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "backend"],
    booleanOptions: ["json", "check-update"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const adapter = await resolveCommandAdapter({ cwd, workspaceRoot, backend: options.backend });
  const codex = getCodexAvailability(cwd);

  // `version --check-update` forces a fresh GitHub round-trip; the bare
  // `version` call reads the cached result so it stays cheap (no network).
  const update = await checkForUpdate({
    currentVersion: BRIDGE_VERSION,
    force: Boolean(options["check-update"]),
  });

  const payload = {
    version: BRIDGE_VERSION,
    schema_version: BRIDGE_SCHEMA_VERSION,
    node_version: process.version,
    codex: {
      available: codex.available,
      detail: codex.detail ?? null
    },
    capabilities: [...BRIDGE_CAPABILITIES],
    active_backend: adapter.name,
    adapter_capabilities: adapter.capabilities(),
    update: {
      latest_version: update.latestVersion ?? null,
      has_update: Boolean(update.hasUpdate),
      checked_at_age_ms: update.cacheAgeMs ?? null,
      check_skipped: Boolean(update.skipped),
      check_skip_reason: update.reason ?? null,
    }
  };

  const updateLine = formatUpdateNotice(update);
  const rendered = [
    `codex-bridge ${payload.version} (schema ${payload.schema_version})`,
    `  node:  ${payload.node_version}`,
    `  codex: ${codex.available ? (codex.detail ?? "available") : "not installed"}`,
    `  backend: ${payload.active_backend}`,
    `  caps:  ${payload.capabilities.join(", ")}`,
    updateLine ? `  update: ${updateLine}` : `  update: up to date${update.latestVersion ? ` (latest ${update.latestVersion})` : ""}`
  ].join("\n") + "\n";

  emitSuccess("version", payload, rendered, { json: options.json, startedAt });
}

// `bridge config show` — surfaces the effective merged config and every
// source it was built from. Invaluable for debugging "I set X in my
// config.yaml, why isn't it taking effect?" situations. The layered
// resolution (DEFAULT_CONFIG < skill-dir < workspaceRoot < cwd) is
// otherwise opaque.
async function handleConfigShow(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const action = positionals[0] ?? "show";
  if (action !== "show") {
    throw usageError(
      `config: unknown action '${action}'. Supported: show.`
    );
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sources = resolveConfigSources(ROOT_DIR, cwd, workspaceRoot);
  const effective = getBridgeConfig(cwd, workspaceRoot);
  const diagnostics = validateConfigLayers(ROOT_DIR, cwd, workspaceRoot);

  // Diff against defaults so the caller can see which keys were overridden
  // (useful for a human-eyeballing the output).
  const overrides = {};
  for (const [k, v] of Object.entries(effective)) {
    if (JSON.stringify(DEFAULT_CONFIG[k]) !== JSON.stringify(v)) {
      overrides[k] = v;
    }
  }

  const payload = {
    sources: {
      defaults: "(built into src/lib/config.mjs::DEFAULT_CONFIG)",
      skill_config_path: sources.skillConfigPath,
      skill_config_exists: sources.skillConfigExists,
      workspace_config_path: sources.workspaceConfigPath,
      workspace_config_exists: sources.workspaceConfigExists,
      override_config_path: sources.overrideConfigPath,
      override_config_exists: sources.overrideConfigExists,
    },
    effective_config: effective,
    overrides_vs_defaults: overrides,
    diagnostics,
    warnings: diagnostics.filter((d) => d.severity === "warning"),
    errors: diagnostics.filter((d) => d.severity === "error"),
    precedence_order_low_to_high: [
      "DEFAULT_CONFIG",
      "skill-dir config.yaml",
      "workspace-root config.yaml",
      "cwd config.yaml",
    ],
  };

  const linePresence = (p, ok) =>
    p ? `${p} (${ok ? "present" : "not found"})` : "(n/a — cwd == workspace root)";
  const lines = [
    "Config resolution (lowest → highest precedence):",
    `  1. built-in defaults — src/lib/config.mjs::DEFAULT_CONFIG`,
    `  2. skill-dir         — ${linePresence(sources.skillConfigPath, sources.skillConfigExists)}`,
    `  3. workspace-root    — ${linePresence(sources.workspaceConfigPath, sources.workspaceConfigExists)}`,
    `  4. cwd               — ${linePresence(sources.overrideConfigPath, sources.overrideConfigExists)}`,
    "",
    "Effective config:",
  ];
  for (const [k, v] of Object.entries(effective)) {
    const marker = Object.prototype.hasOwnProperty.call(overrides, k) ? "*" : " ";
    const preview = typeof v === "string" && v.length > 70 ? `${v.slice(0, 67)}...` : JSON.stringify(v);
    lines.push(`  ${marker} ${k}: ${preview}`);
  }
  if (Object.keys(overrides).length > 0) {
    lines.push("", "* = differs from DEFAULT_CONFIG");
  }
  if (diagnostics.length > 0) {
    lines.push("", "Diagnostics:");
    for (const diagnostic of diagnostics) {
      lines.push(`  ${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.source}:${diagnostic.key ?? "(file)"} — ${diagnostic.message}`);
    }
  }
  const rendered = `${lines.join("\n")}\n`;

  emitSuccess("config", payload, rendered, { json: options.json, startedAt });
}

// Check for updates and print a human-readable verdict plus the one-command
// install recipe. Pass --force to bypass the cache. Never mutates the
// installed skill itself —
// updates land via `npx skills …` from the user's shell, not from inside
// the bridge. This keeps the bridge's blast radius tight (no self-modify)
// and means a failed update check is always recoverable: try again later.
async function handleUpdate(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "force", "apply", "yes"]
  });

  const update = await checkForUpdate({
    currentVersion: BRIDGE_VERSION,
    force: Boolean(options.force),
  });

  const installCommand = "npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y";
  const wantApply = Boolean(options.apply || options.yes);

  // --apply path: detect newer → actually install via npx skills-add.
  // Default behavior (no flag) remains detect-only, so callers that
  // depend on the envelope shape don't see install side-effects they
  // didn't ask for.
  if (wantApply && update.hasUpdate && update.latestVersion) {
    const applyResult = runSkillsAddForApply(options.json);
    const payload = {
      current_version: BRIDGE_VERSION,
      latest_version: update.latestVersion ?? null,
      has_update: true,
      update_check: {
        cached: Boolean(update.cached),
        skipped: Boolean(update.skipped),
        reason: update.reason ?? null,
        fetch_reason: update.fetchReason ?? null,
        fetch_status: update.fetchStatus ?? null,
        cache_age_ms: update.cacheAgeMs ?? null,
      },
      apply: {
        requested: true,
        command: applyResult.command,
        ok: applyResult.ok,
        exit_code: applyResult.exitCode,
        error: applyResult.error,
        timed_out: Boolean(applyResult.timedOut),
      },
      applied: applyResult.ok,
      apply_exit_code: applyResult.exitCode,
      apply_error: applyResult.error,
      install_command: installCommand,
    };
    const rendered = applyResult.ok
      ? `Installed codex-bridge ${update.latestVersion} (was ${BRIDGE_VERSION}). Re-invoke the skill to pick up the new files.\n`
      : `Attempted to install ${update.latestVersion} (from ${BRIDGE_VERSION}) but the installer exited ${applyResult.exitCode}.\n` +
        (applyResult.error ? `  ${applyResult.error}\n` : "") +
        `Re-run manually: ${installCommand}\n`;
    if (applyResult.ok) {
      emitSuccess("update", payload, rendered, { json: options.json, startedAt });
    } else {
      // Non-zero install exit surfaces as a dependency_failed error so
      // callers can branch on $? without parsing stdout.
      const err = new CliError(
        applyResult.timedOut ? "skills installer timed out" : `skills installer exited ${applyResult.exitCode}`,
        {
          class: "dependency_failed",
          code: "UPDATE_APPLY_FAILED",
          retryable: true,
          suggestion: `Re-run manually: ${installCommand}`,
          details: {
            command: applyResult.command,
            exitCode: applyResult.exitCode,
            error: applyResult.error,
            timedOut: Boolean(applyResult.timedOut),
          },
          nextAction: {
            kind: "manual-update",
            command: installCommand,
            description: "Run the installer manually after checking npm/network availability.",
          },
        }
      );
      emitError(err, { json: options.json, command: "update" });
    }
    return;
  }

  const payload = {
    current_version: BRIDGE_VERSION,
    latest_version: update.latestVersion ?? null,
    has_update: Boolean(update.hasUpdate),
    update_check: {
      cached: Boolean(update.cached),
      skipped: Boolean(update.skipped),
      reason: update.reason ?? null,
      fetch_reason: update.fetchReason ?? null,
      fetch_status: update.fetchStatus ?? null,
      cache_age_ms: update.cacheAgeMs ?? null,
    },
    apply: {
      requested: wantApply,
      skipped: wantApply ? (update.hasUpdate ? null : "no-update") : "not-requested",
      command: installCommand,
    },
    check_skipped: Boolean(update.skipped),
    check_skip_reason: update.reason ?? null,
    fetch_reason: update.fetchReason ?? null,
    fetch_status: update.fetchStatus ?? null,
    install_command: installCommand,
    // --apply was requested but nothing to install: echo back the intent
    // so scripted callers can tell "no action taken" from "skipped".
    applied: wantApply && !update.hasUpdate ? false : null,
  };

  let rendered;
  if (update.skipped && !update.latestVersion) {
    rendered = renderUpdateFailureHint(update, BRIDGE_VERSION);
  } else if (update.hasUpdate) {
    rendered =
      `codex-bridge ${update.latestVersion} available (you have ${BRIDGE_VERSION}).\n` +
      `To update, run:\n  ${installCommand}\n` +
      `Or rerun with --apply to install automatically.\n`;
  } else {
    rendered = `codex-bridge is up to date (${BRIDGE_VERSION}${update.latestVersion ? `, latest ${update.latestVersion}` : ""}).\n`;
  }

  emitSuccess("update", payload, rendered, { json: options.json, startedAt });
}

// Spawns `npx -y skills@latest add yigitkonur/codex-bridge -a claude-code
// -g -y` to install the latest release. Blocks until exit. stdout/stderr
// inherit the current terminal unless --json was requested, in which case
// they're captured and any progress is discarded (installer chatter would
// corrupt the JSON envelope). Returns the exit-code shape the caller
// branches on.
function runSkillsAddForApply(jsonMode) {
  const command = "npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y";
  const timeoutMs = 600_000;
  try {
    const result = spawnSync(
      "npx",
      ["-y", "skills@latest", "add", "yigitkonur/codex-bridge", "-a", "claude-code", "-g", "-y"],
      {
        stdio: jsonMode ? ["ignore", "pipe", "pipe"] : "inherit",
        encoding: "utf8",
        timeout: timeoutMs,
      }
    );
    if (result.error) {
      return {
        ok: false,
        exitCode: null,
        error: result.error.code === "ENOENT"
          ? "npx not found on PATH; install Node.js to get npx"
          : result.error.code === "ETIMEDOUT"
            ? `skills installer timed out after ${Math.round(timeoutMs / 1000)}s`
            : result.error.message,
        command,
        timedOut: result.error.code === "ETIMEDOUT",
      };
    }
    if (result.status !== 0) {
      const stderrTail = typeof result.stderr === "string" ? result.stderr.trim().split("\n").slice(-3).join("\n") : null;
      return { ok: false, exitCode: result.status, error: stderrTail || null, command, timedOut: false };
    }
    return { ok: true, exitCode: 0, error: null, command, timedOut: false };
  } catch (err) {
    return { ok: false, exitCode: null, error: err?.message ?? String(err), command, timedOut: false };
  }
}

// Renders a diagnostic hint for "couldn't reach upstream" failures. With
// a public repo and anonymous-only fetch, the remaining failure modes
// are network hiccups and GitHub rate-limit blips — both transient.
function renderUpdateFailureHint(update, currentVersion) {
  const reason = update.fetchReason ?? update.reason ?? "unknown";
  const lines = [`Update check failed (current: ${currentVersion}, reason: ${reason}).`];
  if (reason === "timeout" || reason === "network") {
    lines.push("Network error reaching api.github.com. Retry in a moment.");
  } else if (update.fetchStatus === 403) {
    lines.push("GitHub returned 403 — likely the anonymous 60/hr rate limit. Wait an hour or re-run from a different IP.");
  } else if (update.fetchStatus === 404) {
    lines.push("GitHub returned 404. Re-run with --force; if it persists, the release endpoint may be temporarily unreachable.");
  } else {
    lines.push("Retry with --force; if it persists, check network connectivity to api.github.com.");
  }
  return lines.join("\n") + "\n";
}

async function handleAuthStatus(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const auth = await getCodexAuthStatus(cwd);

  const status = auth.loggedIn ? "logged in" : "not logged in";
  const provider = auth.provider ? ` via ${auth.provider}` : "";
  const lines = [`Auth: ${status}${provider}.`];
  if (auth.detail) lines.push(`  ${auth.detail}`);
  if (!auth.loggedIn && auth.requiresOpenaiAuth) {
    lines.push("  → Run `codex login` (or `codex login --device-auth`).");
  }
  emitSuccess("auth-status", auth, `${lines.join("\n")}\n`, {
    json: options.json,
    startedAt
  });
}

function buildMachineReadableHelp() {
  return {
    version: BRIDGE_VERSION,
    schema_version: BRIDGE_SCHEMA_VERSION,
    commands: Object.entries(COMMANDS).map(([name, entry]) => ({
      name,
      synopsis: `codex-bridge ${entry.synopsis}`,
      summary: entry.summary,
      examples: entry.examples ?? []
    })),
    global_flags: [
      { flag: "--json", alias: "-j", description: "Machine-readable output (error envelope on failure)." },
      { flag: "--cwd <dir>", alias: "-C", description: "Override the working directory." },
      { flag: "--help", alias: "-h", description: "Show per-subcommand help and exit." }
    ],
    exit_codes: {
      0: "success",
      1: "crash / unhandled internal error",
      2: "usage (unknown subcommand, unknown flag, missing argument)",
      3: "not_found (job, thread, resource)",
      4: "auth (run `codex login`)",
      5: "conflict (already running, state mismatch)",
      6: "validation (bad input)",
      7: "transient (timeout, network, rate-limit) — retry with backoff",
      8: "partial_success (check result details)"
    }
  };
}

function ensureCodexAvailable(cwd) {
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

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText, extras = {}) {
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

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status === "completed"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
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

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
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

async function executeReviewRun(request) {
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


async function executeTaskRun(request) {
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

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function safeRealPath(filePath) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function samePath(left, right) {
  return safeRealPath(left) === safeRealPath(right);
}

function summarizeWorkingTreeState(state) {
  const files = [
    ...state.staged.map((file) => `staged:${file}`),
    ...state.unstaged.map((file) => `unstaged:${file}`),
    ...state.untracked.map((file) => `untracked:${file}`),
  ];
  const shown = files.slice(0, 20).join(", ");
  return files.length > 20 ? `${shown}, ... and ${files.length - 20} more` : shown;
}

function requireTaskReviewContext(taskId, options = {}) {
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

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
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

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check \`codex-bridge status ${payload.jobId}\` for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (jobClass === "review") return "review";
  if (jobClass === "task") return "task";
  // Historical fallthrough — callers pass a kindLabel explicitly now. This
  // only triggers for legacy job records that predate 1.2.5.
  return "job";
}

function createCompanionJob({
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

function createTrackedProgress(job, options = {}) {
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

function buildTaskJob(workspaceRoot, taskMetadata, write, options = {}) {
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

function buildTaskRequest({
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

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return readPromptFileOrThrow(path.resolve(cwd, options["prompt-file"]));
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function readPromptFileOrThrow(absPath) {
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

function requireTaskRequest(prompt, resumeLast) {
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
function parsePositiveMsOption(flagName, raw) {
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
function parseIdleTimeoutMsOption(raw) {
  return parsePositiveMsOption("--idle-timeout-ms", raw);
}

// Accept either a bare millisecond integer (e.g. `5000`) or a human-friendly
// duration suffix (`5s`, `1500ms`, `2m`). Returns milliseconds. Used by the
// `--interval` flag on `status --watch` and the `--timeout-ms` flag on
// `await-artifact` so operators don't have to mentally convert "10 seconds"
// to "10000" every time. Bare integers are treated as milliseconds for
// backward compatibility with the rest of the CLI.
function parseDurationOption(flagName, raw, { defaultMs = null } = {}) {
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

function persistFailureErrorInPayload(execution, command = null) {
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

async function runForegroundCommand(job, runner, options = {}) {
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

function spawnDetachedTaskWorker(cwd, workspaceRoot, jobId, logFile = null) {
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

function enqueueBackgroundTask(cwd, job, request) {
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

async function handleReviewCommand(argv, config) {
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

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

// ── BRIDGE ORCHESTRATION ──────────────────────────────────────────────────
// This is the integration layer that connects all building blocks.
// It wraps executeTaskRun with: config, session logging, question handling,
// timeout, and auto-pipeline.

async function runBridgeTask(request) {
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

function extractPlanSteps(planText) {
  const steps = [];
  for (const line of (planText || "").split("\n")) {
    const match = line.match(/^\s*(\d+)\.\s+(.+)/);
    if (match) {
      steps.push({ number: parseInt(match[1]), text: match[2].trim(), status: "pending" });
    }
  }
  return steps.length > 0 ? steps : [{ number: 1, text: planText?.split("\n")[0] ?? "Plan", status: "pending" }];
}

async function handleTask(argv) {
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

async function handleTaskWorker(argv) {
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

async function handleStatus(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms", "interval", "watch-timeout-ms", "retention-days", "retention-jobs"],
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
    const intervalMs = parseDurationOption("--interval", options.interval, { defaultMs: 10_000 });
    const overallTimeoutMs = parseDurationOption("--watch-timeout-ms", options["watch-timeout-ms"], { defaultMs: null });
    await runStatusWatch(cwd, {
      intervalMs,
      overallTimeoutMs,
      all: options.all,
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

  const report = applyStopReviewGateSnapshot(buildStatusSnapshot(cwd, { all: options.all }));
  emitSuccess("status", report, renderStatusReport(report), {
    json: options.json,
    startedAt
  });
}

// v1.4.1 — live multi-job status view. The sync fan-in primitive for N>1
// orchestration. Exits when every tracked job is terminal
// (status !== "queued" && !== "running"), on overall timeout, or on
// Ctrl-C. Returns a summary envelope via emitSuccess once stable.
async function runStatusWatch(cwd, { intervalMs, overallTimeoutMs, all, json, startedAt }) {
  const deadline = overallTimeoutMs ? Date.now() + overallTimeoutMs : null;
  let ticks = 0;
  let interrupted = false;
  const onSigint = () => { interrupted = true; };
  process.on("SIGINT", onSigint);

  try {
    while (true) {
      ticks += 1;
      const snapshot = applyStopReviewGateSnapshot(buildStatusSnapshot(cwd, { all }));
      const activeCount = snapshot.running?.length ?? 0;
      const tickEntry = {
        schema_version: "1.0",
        tick: ticks,
        ts: new Date().toISOString(),
        activeCount,
        running: (snapshot.running ?? []).map((j) => ({
          id: j.id,
          status: j.status,
          phase: j.phase ?? null,
          threadId: j.threadId ?? null,
          kind: j.kindLabel ?? j.kind ?? null,
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
async function handleAwaitArtifact(argv) {
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

async function handleResult(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
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

  emitSuccess("result", payload, renderStoredJobResult(job, storedJob), {
    json: options.json,
    startedAt
  });
}

function waitForTerminalEvent(eventsPath, pattern, timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;
    let offset = 0;
    let watcher = null;
    let pollTimer = null;
    let timer = null;

    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      if (watcher) {
        try { watcher.close(); } catch { /* noop */ }
      }
      if (pollTimer) clearInterval(pollTimer);
      if (timer) clearTimeout(timer);
      resolve(payload);
    };

    const scan = () => {
      try {
        const data = fs.readFileSync(eventsPath, "utf8");
        if (data.length < offset) offset = 0; // truncated / rotated
        const tail = data.slice(offset);
        offset = data.length;
        for (const line of tail.split("\n")) {
          const m = pattern.exec(line);
          if (m) {
            finish({ timedOut: false, tag: m[1], line });
            return;
          }
        }
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    };

    const attachWatcher = () => {
      try {
        watcher = fs.watch(eventsPath, { persistent: false }, scan);
        // Catch the case where lines landed between existence check and watch attach.
        scan();
      } catch (e) {
        if (e.code === "ENOENT") {
          if (!pollTimer) {
            pollTimer = setInterval(() => {
              if (fs.existsSync(eventsPath)) {
                clearInterval(pollTimer);
                pollTimer = null;
                attachWatcher();
              }
            }, 500);
          }
        } else {
          throw e;
        }
      }
    };

    if (fs.existsSync(eventsPath)) {
      scan();
      if (!resolved) attachWatcher();
    } else {
      pollTimer = setInterval(() => {
        if (fs.existsSync(eventsPath)) {
          clearInterval(pollTimer);
          pollTimer = null;
          attachWatcher();
        }
      }, 500);
    }

    timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
  });
}

async function handleWait(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms"],
    booleanOptions: ["json", "any"]
  });

  const cwd = resolveCommandCwd(options);
  if (options.any) {
    await handleWaitAny(cwd, positionals, options, startedAt);
    return;
  }
  const reference = positionals[0] ?? "";
  if (!reference) {
    throw usageError("wait requires <job-id-or-thread-id>");
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
  const timeoutMs = Math.max(1000, Number(options["timeout-ms"]) || 600_000);
  const TERMINAL = TERMINAL_TAG_REGEX;

  const result = await waitForTerminalEvent(eventsPath, TERMINAL, timeoutMs);
  if (result.timedOut) {
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

  const elapsedMs = Date.now() - startedAt;
  emitSuccess(
    "wait",
    {
      jobId: job.id,
      threadId: job.threadId,
      terminalTag: result.tag,
      lastEventLine: result.line,
      eventsPath,
      elapsedMs
    },
    `${result.tag} ${job.threadId} after ${Math.round(elapsedMs / 1000)}s\n`,
    { json: options.json, startedAt }
  );
}

async function handleWaitAny(cwd, references, options, startedAt) {
  const refs = references.filter(Boolean);
  if (refs.length < 2) {
    throw usageError("wait --any requires at least two job ids or thread ids.");
  }
  const timeoutMs = Math.max(1000, Number(options["timeout-ms"]) || 600_000);
  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const TERMINAL = TERMINAL_TAG_REGEX;

  const targets = refs.map((reference) => {
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

  const deadline = Date.now() + timeoutMs;
  let winner = null;
  while (!winner && Date.now() < deadline) {
    for (const target of targets) {
      const result = scanTerminalEvent(target.eventsPath, TERMINAL);
      if (result) {
        winner = { target, result };
        break;
      }
    }
    if (!winner) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!winner) {
    throw new CliError(`No terminal event for any target within ${Math.round(timeoutMs / 1000)}s.`, {
      class: "timeout",
      code: "WAIT_TIMEOUT",
      retryable: true,
      suggestion: "Run `status --watch --all` to inspect live multi-job state.",
    });
  }

  const elapsedMs = Date.now() - startedAt;
  emitSuccess(
    "wait",
    {
      mode: "any",
      winner: {
        reference: winner.target.reference,
        jobId: winner.target.job.id,
        threadId: winner.target.job.threadId,
        terminalTag: winner.result.tag,
        lastEventLine: winner.result.line,
        eventsPath: winner.target.eventsPath,
      },
      targets: targets.map((target) => ({
        reference: target.reference,
        jobId: target.job.id,
        threadId: target.job.threadId,
        eventsPath: target.eventsPath,
      })),
      elapsedMs,
    },
    `${winner.result.tag} ${winner.target.job.id} after ${Math.round(elapsedMs / 1000)}s\n`,
    { json: options.json, startedAt }
  );
}

function scanTerminalEvent(eventsPath, pattern) {
  try {
    const data = fs.readFileSync(eventsPath, "utf8");
    for (const line of data.split("\n")) {
      const m = pattern.exec(line);
      if (m) return { timedOut: false, tag: m[1], line };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return null;
}

async function handleEvents(argv) {
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
  if (fs.existsSync(eventsPath)) {
    initial = fs.readFileSync(eventsPath, "utf8");
    for (const line of initial.split("\n")) {
      if (!line) continue;
      if (passes(line)) writeEventLine(line);
      if (TERMINAL.test(line)) alreadyTerminal = true;
    }
  }

  const timeoutMs = Math.max(1000, Number(options["timeout-ms"]) || 600_000);

  if (!options.follow || alreadyTerminal) {
    emitSuccess(
      "events",
      {
        jobId: job.id,
        threadId: job.threadId,
        eventsPath,
        followed: Boolean(options.follow),
        filter: options.filter ?? null,
        exclude: options.exclude ?? null
      },
      "",
      { json: options.json, startedAt }
    );
    return;
  }

  // Tail mode — follow appends until a terminal tag or the timeout.
  let timedOut = false;
  // Capture the terminal tag line so the end-of-stream envelope can report
  // which event actually closed the stream (DONE / ERROR / INCOMPLETE / PLAN).
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
      // file. terminalTag is one of DONE / ERROR / INCOMPLETE / PLAN on success,
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

function handleTaskResumeCandidate(argv) {
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

async function handleCancel(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
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

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

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
    reason: "cancelled-by-user",
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

function resolvePromptInput(options, positionals, cwd) {
  if (options["prompt-file"]) {
    return readPromptFileOrThrow(path.resolve(cwd, options["prompt-file"]));
  }
  if (positionals.length === 1) {
    const candidate = path.resolve(cwd, positionals[0]);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return fs.readFileSync(candidate, "utf8");
      }
    } catch {
      // Not a file — treat as inline text
    }
  }
  const text = positionals.join(" ");
  if (text) return text;
  return readStdinIfPiped();
}

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
async function handleIterate(argv) {
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
async function handleVerdict(argv) {
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
async function handleVerdictsPending(argv) {
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
async function handleMerge(argv) {
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

async function handleSend(argv) {
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

async function handleSteer(argv) {
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

async function handleRespond(argv) {
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

async function handleSummary(argv) {
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
      const item = entry.data?.item ?? entry.data ?? {};
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

const SUBCOMMAND_DISPATCH = Object.freeze({
  setup: handleSetup,
  version: handleVersion,
  update: handleUpdate,
  config: handleConfigShow,
  "auth-status": handleAuthStatus,
  review: handleReview,
  "adversarial-review": (argv) => handleReviewCommand(argv, { reviewName: "Adversarial Review" }),
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
      bridgeVersion: packageJson.version,
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
