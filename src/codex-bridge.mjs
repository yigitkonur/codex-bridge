import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
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
  invalidThreadIdError
} from "./lib/cli-errors.mjs";
import { isThreadId } from "./lib/thread-id.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn,
    withAppServer
  } from "./lib/codex.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
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
  resolveConfigSources
} from "./lib/config.mjs";
import {
  resolveSessionDir,
  initSession,
  findSession,
  logNdjson,
  logEvent,
  captureGitDiff,
  writePlan,
  formatDoneEvent,
  formatErrorEvent,
  formatIncompleteEvent,
  formatQuestionEvent,
  formatPlanEvent,
  formatConfirmedEvent,
  formatPipelineEvent,
  formatPhaseEvent,
  formatReviewEvent,
  formatWarningEvent,
  writeReview
} from "./lib/session-log.mjs";
import {
  readPendingRequestById,
  writeResponseFile,
  writePendingRequest,
  waitForResponse,
  clearPendingRequest,
} from "./lib/pending-requests.mjs";
import { runAutoPipeline } from "./lib/auto-pipeline.mjs";
import { checkForUpdate, formatUpdateNotice } from "./lib/update-check.mjs";

// Read the update cache synchronously (no network) and print a one-line
// stdout notice if a newer version is known. Opt-out via `--json` flag,
// `CODEX_BRIDGE_NO_UPDATE_CHECK=1` env, or the two subcommands that render
// update status themselves. Also silent for subcommand-less / help runs so
// `codex-bridge` (no args) keeps printing clean usage. Fires an async cache
// refresh so the NEXT invocation sees newly-published releases.
function maybeEmitUpdateNotice(rawArgv, subcommand) {
  try {
    if (process.env.CODEX_BRIDGE_NO_UPDATE_CHECK === "1") return;
    if (detectJsonFlag(rawArgv)) return;
    if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") return;
    if (subcommand === "version" || subcommand === "update") return;

    // Sync cache read; no network on the hot path.
    void checkForUpdate({ currentVersion: BRIDGE_VERSION })
      .then((result) => {
        if (!result || !result.hasUpdate) return;
        if (result.cached === false && result.cacheAgeMs === 0) {
          // Fresh fetch produced new data, but we don't want to block the
          // subcommand that's already running. The notice will appear on
          // the next invocation via the now-warm cache.
          return;
        }
        const line = formatUpdateNotice(result);
        if (line) process.stdout.write(`${line}\n`);
      })
      .catch(() => {});
  } catch {
    // Update-check must never fail the caller.
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
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

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

// Pending requests are persisted to disk by the worker process.
// The respond command reads from disk and writes a response file.
// See lib/pending-requests.mjs for the file-based IPC protocol.

// Produces a ready-to-paste Monitor hint so agents don't have to assemble one
// from eventsPath + terminal tags. Prefers our `events --follow` subcommand
// (stable, filtered) over raw `tail -f`. `eventsPath` may be null when the
// thread id isn't known yet (background launches); in that case the shell
// fallback is omitted but the CLI command still works via the job id.
function buildMonitorHint({ eventsPath, jobId, threadId }) {
  const identifier = jobId ?? threadId;
  if (!identifier) return null;
  const cliCommand = `node ${SCRIPT_PATH} events ${identifier} --follow --filter DONE,ERROR,INCOMPLETE,PLAN,QUESTION --timeout-ms 600000`;
  const shellFallback = eventsPath
    ? `tail -f ${JSON.stringify(eventsPath)} | while IFS= read -r line; do ` +
      `echo "$line"; case "$line" in *"[DONE]"*|*"[ERROR]"*|*"[INCOMPLETE]"*) break ;; esac; done`
    : null;
  return {
    command: cliCommand,
    shell_fallback: shellFallback,
    terminal_tags: ["DONE", "ERROR", "INCOMPLETE"],
    timeout_ms: 600000,
    tool_hint: {
      description: "codex-bridge task terminal events",
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
    synopsis: "task [--write] [--mode plan|default] [--effort <level>] [-m <model>] [--prompt-file <path>] [--resume|--resume-last] [--fresh] [--background] [--json] [prompt or file.md]",
    summary: "Start a new Codex task. Defaults: plan mode, read-only sandbox, foreground. Use --mode default to skip planning and execute directly.",
    examples: [
      'codex-bridge task --write "Fix the auth bug in src/auth.ts"',
      'codex-bridge task --mode default --write "Trivial typo fix"',
      "codex-bridge task --prompt-file prompt.md --effort high --write",
      "codex-bridge task --resume-last --write",
      'codex-bridge task --background --write "Rewrite tests" --json'
    ]
  },
  send: {
    synopsis: "send <thread-id> [--mode plan|default] [--effort <level>] [--json] [prompt or file.md]",
    summary: "Resume a thread with a new prompt. Use for plan approval, revisions, and follow-ups. <thread-id> is a UUID returned by task.",
    examples: [
      'codex-bridge send 019d9a86-1c8a-7f41-8032-6c76bbe730a1 --mode default "Implement the plan."',
      'codex-bridge send 019d9a86-1c8a-7f41-8032-6c76bbe730a1 "Revise step 2: use token bucket instead"'
    ]
  },
  steer: {
    synopsis: "steer <thread-id> <turn-id> [prompt or file.md]",
    summary: "Send mid-turn guidance to an active Codex turn. Not valid for review/compaction turns. Both ids are UUIDs.",
    examples: ['codex-bridge steer 019d9a86-1c8a-7f41-8032-6c76bbe730a1 019d9a86-2012-7152-bcc9-228a263d286a "Focus on auth first"']
  },
  respond: {
    synopsis: "respond <request-id> (--question-id <qid> --answer <answer> | --json-payload <json>) [--json]",
    summary: "Answer a [QUESTION] emitted by Codex (requestUserInput).",
    examples: [
      'codex-bridge respond req-xyz --question-id q1 --answer "jwt"',
      "codex-bridge respond req-xyz --json-payload '{\"answers\":{\"q1\":{\"answers\":[\"jwt\"]}}}'"
    ]
  },
  review: {
    synopsis: "review [--scope auto|working-tree|branch] [--base <ref>] [-m <model>] [--json]",
    summary: "Run a standalone code review using Codex's built-in reviewer.",
    examples: [
      "codex-bridge review --scope working-tree",
      "codex-bridge review --scope branch --base main"
    ]
  },
  "adversarial-review": {
    synopsis: "adversarial-review [--scope auto|working-tree|branch] [--base <ref>] [-m <model>] [--json] [focus text...]",
    summary: "Run an adversarial review with a structured JSON result.",
    examples: [
      'codex-bridge adversarial-review "focus on SQL injection risks"',
      "codex-bridge adversarial-review --scope branch --base main"
    ]
  },
  summary: {
    synopsis: "summary <thread-id> [--tail <n>] [--json]",
    summary: "Generate a readable transcript from the NDJSON session log (default tail=200).",
    examples: ["codex-bridge summary 019d9a86-1c8a-7f41-8032-6c76bbe730a1 --tail 400"]
  },
  status: {
    synopsis: "status [job-id] [--all] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]",
    summary: "List jobs, or inspect one by id. With --wait, poll until the job reaches a terminal state.",
    examples: [
      "codex-bridge status",
      "codex-bridge status task-abc --wait --timeout-ms 600000",
      "codex-bridge status --all --json"
    ]
  },
  result: {
    synopsis: "result [job-id] [--json]",
    summary: "Get the full result of a completed job. Omit job-id for the latest in this session.",
    examples: ["codex-bridge result task-abc --json"]
  },
  wait: {
    synopsis: "wait <job-id-or-thread-id> [--timeout-ms <ms>] [--json]",
    summary: "Block until the target job's events file emits [DONE], [ERROR], or [INCOMPLETE].",
    examples: [
      "codex-bridge wait task-abc --timeout-ms 600000 --json",
      "codex-bridge wait 019d9a86-1c8a-7f41-8032-6c76bbe730a1"
    ]
  },
  events: {
    synopsis: "events <job-id-or-thread-id> [--follow] [--filter <tags>] [--timeout-ms <ms>] [--json]",
    summary: "Stream the target's events file; optional tag filter and follow mode. Lines go to stdout; --json adds a trailing envelope (both with and without --follow).",
    examples: [
      "codex-bridge events task-abc --filter DONE,ERROR,INCOMPLETE",
      "codex-bridge events 019d9a86-1c8a-7f41-8032-6c76bbe730a1 --follow --filter PIPELINE,DONE,ERROR --timeout-ms 600000"
    ]
  },
  cancel: {
    synopsis: "cancel [job-id] [--json]",
    summary: "Cancel a running job. Attempts `turn/interrupt` before terminating the worker tree.",
    examples: ["codex-bridge cancel task-abc"]
  },
  setup: {
    synopsis: "setup [--json] [--enable-review-gate | --disable-review-gate]",
    summary: "Health check: Node/npm/Codex install, auth, broker runtime; toggle stop-gate review.",
    examples: ["codex-bridge setup --json"]
  },
  version: {
    synopsis: "version [--check-update] [--json]",
    summary: "Print bridge version, schema version, Node version, Codex version, capability list, and cached update status. `--check-update` forces a fresh GitHub round-trip.",
    examples: ["codex-bridge version --json", "codex-bridge version --check-update --json"]
  },
  update: {
    synopsis: "update [--force] [--json]",
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

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
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

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `codex-bridge setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
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

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  emitSuccess("setup", finalReport, renderSetupReport(finalReport), {
    json: options.json,
    startedAt
  });
}

const BRIDGE_VERSION = "1.2.3";
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
  "update-check"
]);

async function handleVersion(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "check-update"]
  });

  const cwd = resolveCommandCwd(options);
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
  const rendered = `${lines.join("\n")}\n`;

  emitSuccess("config", payload, rendered, { json: options.json, startedAt });
}

// Force a fresh update check and print a human-readable verdict plus the
// one-command install recipe. Never mutates the installed skill itself —
// updates land via `npx skills …` from the user's shell, not from inside
// the bridge. This keeps the bridge's blast radius tight (no self-modify)
// and means a failed update check is always recoverable: try again later.
async function handleUpdate(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "force"]
  });

  const update = await checkForUpdate({
    currentVersion: BRIDGE_VERSION,
    force: options.force !== false,
  });

  const installCommand = "npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y";

  const payload = {
    current_version: BRIDGE_VERSION,
    latest_version: update.latestVersion ?? null,
    has_update: Boolean(update.hasUpdate),
    check_skipped: Boolean(update.skipped),
    check_skip_reason: update.reason ?? null,
    install_command: installCommand,
  };

  let rendered;
  if (update.skipped && !update.latestVersion) {
    rendered = `Update check skipped (${update.reason}). Try again in a moment.\n`;
  } else if (update.hasUpdate) {
    rendered =
      `codex-bridge ${update.latestVersion} available (you have ${BRIDGE_VERSION}).\n` +
      `To update, run:\n  ${installCommand}\n`;
  } else {
    rendered = `codex-bridge is up to date (${BRIDGE_VERSION}${update.latestVersion ? `, latest ${update.latestVersion}` : ""}).\n`;
  }

  emitSuccess("update", payload, rendered, { json: options.json, startedAt });
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

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
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

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw validationError(
      "`review` maps to the built-in reviewer and does not support custom focus text.",
      "REVIEW_FOCUS_UNSUPPORTED",
      `Retry with \`adversarial-review ${focusText.trim()}\` for focused review instructions.`
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
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  // Pre-resolve sessionDir so we can initSession the moment Codex gives us
  // a threadId — addresses `unexpected-bridge-observations/08` which
  // documented that `review` / `adversarial-review` produced ZERO session
  // artifacts (`.events`, `.ndjson`, `.plan.md`, `.review.json`), leaving
  // `bridge summary <review-tid>` and the Monitor tooling completely
  // blind to review threads.
  const reviewConfig = getBridgeConfig(request.cwd, resolveWorkspaceRoot(request.cwd));
  const reviewSessionDir = resolveSessionDir(reviewConfig.session_dir);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });

  // Short-circuit: if the resolved target is the working tree and there are
  // actually no staged or unstaged changes, refuse before spending a Codex turn.
  // Only fires for working-tree targets (explicit --scope working-tree, or
  // --scope auto that fell through to working-tree). Branch-scope reviews can
  // legitimately have empty diffs and should run.
  if (target.mode === "working-tree") {
    const diffCheck = runCommand("git", ["diff", "--quiet"], { cwd: request.cwd });
    const stagedCheck = runCommand("git", ["diff", "--cached", "--quiet"], { cwd: request.cwd });
    if (diffCheck.status === 0 && stagedCheck.status === 0) {
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
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
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
    }
    const payload = {
      review: reviewName,
      target,
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
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label,
      error: result.error ?? null
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
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
    if (parsed.parsed && !parsed.parseError) {
      try {
        writeReview(advSession, parsed.parsed);
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
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
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
  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
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
  });

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

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
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
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
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

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId, mode }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    mode: mode ?? null
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

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });

  // V3.2: Map Codex turn-level failures to semantic exit codes. The error object
  // from runAppServerTurn carries `codexErrorInfo` (Unauthorized,
  // ContextWindowExceeded, ...) which classifyError recognizes. If the turn
  // failed without typed info, classifyError falls through to internal/1.
  if (execution.exitStatus !== 0) {
    const errLike = execution.error ?? { message: `Codex turn failed (status ${execution.exitStatus}).` };

    if (options.json) {
      // Emit the error envelope on stdout; exit code is set by emitError.
      emitError(errLike, { json: true, command: options.command ?? null });
    } else {
      // Non-JSON path: render the job output (captures reasoning + diagnostics),
      // then set the mapped exit code via emitError's classifier.
      if (execution.rendered) {
        process.stdout.write(execution.rendered);
      }
      emitError(errLike, { json: false, command: options.command ?? null });
    }
    return execution;
  }

  emitSuccess(options.command ?? null, execution.payload, execution.rendered, {
    json: options.json,
    startedAt: options.startedAt
  });
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId, logFile = null) {
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
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
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

  const child = spawnDetachedTaskWorker(cwd, job.id, logFile);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      threadId: null,
      eventsPath: null,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile,
      monitor: buildMonitorHint({ eventsPath: null, jobId: job.id, threadId: null })
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
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
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
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
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  const config = getBridgeConfig(request.cwd ?? null, workspaceRoot);
  const sessionDir = resolveSessionDir(config.session_dir);

  // Override params based on config. Request-level `mode` (from --mode) wins over config.yaml.
  const effectiveMode = request.mode ?? config.mode ?? "plan";
  const isPlanMode = effectiveMode === "plan" && !request.resumeLast;

  // When `skip_meta_skills` is on, prepend a directive instructing Codex to
  // bypass its internal planning/ceremony skills (using-superpowers,
  // brainstorming, writing-plans, using-git-worktrees). These routinely
  // burn token budget producing docs/superpowers/specs/*.md and plans/*.md
  // files that are not part of the deliverable. Mode-aware: plan-mode
  // turns keep the "produce a concise plan" intent (the directive must not
  // contradict it); execute turns get the full "execute directly" wording.
  // Advisory only — Codex may still invoke the skills.
  const metaSkillsPreamble =
    "[ORCHESTRATOR DIRECTIVE] Do not invoke your own meta-skills — specifically " +
    "`using-superpowers`, `brainstorming`, `writing-plans`, `using-git-worktrees`, " +
    "or any equivalent planning/ceremony skill. Do not create " +
    "docs/superpowers/specs/*.md or docs/superpowers/plans/*.md files unless " +
    "the task explicitly asks for them.";
  const metaSkillsPrefix = config.skip_meta_skills
    ? (isPlanMode
        ? `${metaSkillsPreamble} The calling orchestrator is already driving the plan/execute loop; produce a concise inline [PLAN] and stop — the orchestrator approves before execution.\n\n`
        : `${metaSkillsPreamble} The calling orchestrator has already planned this task; your job is to execute it directly.\n\n`)
    : "";

  // Append prompt footer from config (instructs Codex to use requestUserInput tool)
  const promptWithFooter = config.prompt_footer
    ? `${metaSkillsPrefix}${request.prompt}\n\n${config.prompt_footer}`
    : `${metaSkillsPrefix}${request.prompt}`;

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
    sandboxPolicy: buildSandboxPolicy(
      isPlanMode || !request.write ? "plan" : "default",
      config
    ),
    effort: isPlanMode ? "xhigh" : (request.effort ?? config.effort ?? "high"),
    turnTimeoutMs: isPlanMode ? 300_000 : 600_000,
    idleTimeoutMs: 120_000,
    onTurnStart: (info) => {
      const s = findSession(sessionDir, info.threadId) ?? initSession(sessionDir, info.threadId);
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
    },
    onItemCompleted: (item, { threadId }) => {
      // Persist a minimal record per completed item so `summary` can replay
      // a per-turn transcript. Slices are intentionally tight; see
      // `references/ndjson-guide.md`.
      const effectiveThreadId = threadId ?? null;
      if (!effectiveThreadId) return;
      const s = findSession(sessionDir, effectiveThreadId) ?? initSession(sessionDir, effectiveThreadId);
      logNdjson(s, "ITEM_COMPLETED", "item/completed", {
        itemId: item?.id ?? null,
        itemType: item?.type ?? null,
        text: extractItemText(item)
      });

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

  // Set up server request handler for questions (runs on the SAME connection)
  bridgeRequest.onServerRequest = (message) => {
    const params = message.params ?? {};
    const threadId = params.threadId ?? "unknown";
    const session = findSession(sessionDir, threadId) ?? initSession(sessionDir, threadId);

    if (message.method === "item/tool/requestUserInput") {
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

      // Persist to disk so respond CLI can find it
      writePendingRequest(sessionDir, threadId, entry);

      // Write [QUESTION] to events
      logEvent(session, formatQuestionEvent(session, {
        requestId: internalId,
        questions: params.questions ?? [],
        scriptPath: SCRIPT_PATH,
      }));
      logNdjson(session, "QUESTION", message.method, { requestId: internalId, questions: params.questions });

      // Poll for response file (blocks until respond CLI writes it or timeout).
      // Pass `internalId` so stale responses from a previous question on this
      // thread are discarded instead of delivered to the new RPC request.
      waitForResponse(sessionDir, threadId, 300_000, internalId).then((response) => {
        clearPendingRequest(sessionDir, threadId);
        if (response && response.payload) {
          // Send response on the SAME connection that received the request
          message._client?.sendMessage?.({ id: message.id, result: response.payload });
          logEvent(session, formatConfirmedEvent(session, { requestId: internalId }));
          logNdjson(session, "CONFIRMED", "serverRequest/resolved", { requestId: internalId });
        } else {
          // Timeout — send empty answers
          message._client?.sendMessage?.({ id: message.id, result: { answers: {} } });
          logNdjson(session, "QUESTION_TIMEOUT", null, { requestId: internalId });
        }
      });
    }
  };

  // Run the task
  const result = await executeTaskRun(bridgeRequest);

  // Create session for post-processing
  const session = initSession(sessionDir, result.threadId);

  // Ready-to-paste Monitor hint — computed once, attached to every setPhase
  // branch below so synchronous callers never have to assemble one.
  const monitor = buildMonitorHint({
    eventsPath: result.threadId ? path.join(sessionDir, `${result.threadId}.events`) : null,
    jobId: request.jobId ?? null,
    threadId: result.threadId ?? null
  });

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
  const setPhase = (phase, nextAction, extras = {}) => {
    result.payload = {
      ...result.payload,
      phase,
      next_action: nextAction,
      ...extras
    };
  };

  if (result.exitStatus !== 0 && result.error) {
    const errorMessage = String(result.error.message ?? result.error);
    const isIdleTimeout = errorMessage.includes("No events received for");
    const codexErrorInfo =
      result.error.codexErrorInfo ?? result.error.codex_error_info ?? null;
    const errorCode = isIdleTimeout ? "ClientTimeout" : (codexErrorInfo ?? "CodexError");
    const touchedFiles = result.payload?.touchedFiles ?? [];
    logEvent(session, formatErrorEvent(session, {
      errorCode,
      message: errorMessage,
      phase: isPlanMode ? "plan" : "execution",
      origin: "turn",
      scriptPath: SCRIPT_PATH,
      jobId: request.jobId ?? null,
    }));
    logNdjson(session, "ERROR", null, { errorCode, message: errorMessage, origin: "turn" });

    // `workspace-dirty` phase: Codex produced a diff but the sandbox blocked
    // the final step (e.g. `workspace-write` refuses `.git/` writes so the
    // commit fails). Surface a distinct phase so the orchestrator can commit
    // the diff on Codex's behalf, rather than interpreting the run as total
    // failure. Triggered by `codexErrorInfo: "SandboxError"` with a non-empty
    // touched-files list. We flip `exitStatus` to 0 so `runForegroundCommand`
    // emits a success envelope carrying the phase — a sandbox-blocked commit
    // is actionable state, not a terminal failure.
    if (codexErrorInfo === "SandboxError" && touchedFiles.length > 0) {
      // JSON.stringify for shell-safe quoting of the cwd path (matches the
      // pattern used in buildMonitorHint). Paths with spaces would otherwise
      // break the suggested command.
      const cwdArg = JSON.stringify(request.cwd);
      setPhase("workspace-dirty", {
        command: `git -C ${cwdArg} add -A && git -C ${cwdArg} commit -m "<subject>"`,
        description:
          "Codex produced a diff but the sandbox blocked the commit. Commit on Codex's behalf, or re-run with config.sandbox_policy: danger-full-access."
      }, { errorCode, touchedFiles, monitor, sandboxError: errorMessage });
      return { ...result, session, exitStatus: 0, error: null };
    }

    setPhase("error", {
      command: `node ${SCRIPT_PATH} send ${result.threadId} "<revised prompt>"`,
      description: "Retry with an adjusted prompt, or cancel and start fresh."
    }, { errorCode, monitor });
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
    }));
    setPhase("plan-pending", {
      command: `node ${SCRIPT_PATH} send ${result.threadId} --mode default "Implement the plan."`,
      description: "Approve the plan and switch to execution mode. To revise instead, drop --mode and send revision text."
    }, { planPath, planSteps: steps, monitor });
    return { ...result, session, planPath };
  }

  // If execution completed (not plan), run auto-pipeline
  if (result.exitStatus === 0 && (config.auto_review || config.post_task_prompt)) {
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
        pipelineResult.completedStages?.length
          ? pipelineResult.completedStages[pipelineResult.completedStages.length - 1]
          : "diff";
      const nextAction = pipelineErrored
        ? {
            command: `node ${SCRIPT_PATH} result ${request.jobId ?? result.threadId}`,
            description: `Pipeline stalled after stage '${failedStage}' (${pipelineResult.error}). Read result for partial state. If this keeps happening, set auto_review: false in config.yaml.`,
          }
        : {
            command: `node ${SCRIPT_PATH} send ${result.threadId} "Complete the missing items"`,
            description: "Codex's completion check flagged gaps. Read [INCOMPLETE] in events for specifics.",
          };
      setPhase("incomplete", nextAction, { pipeline: pipelineResult, monitor });
    } else {
      setPhase("done", {
        command: `node ${SCRIPT_PATH} result ${request.jobId ?? result.threadId}`,
        description: "Task finished and passed completion check. Inspect full result or send a follow-up."
      }, { pipeline: pipelineResult, monitor });
    }
    return { ...result, session, pipeline: pipelineResult };
  }

  // No pipeline — write [DONE] directly
  const diff = captureGitDiff(request.cwd, session);
  logEvent(session, formatDoneEvent(session, {
    duration: 0,
    diffStat: diff.diffStat,
    files: diff.files,
    config: { model: config.model, effort: config.effort, modeFlow: isPlanMode ? "plan→default" : "default" },
    diffPath: diff.diffPath,
    scriptPath: SCRIPT_PATH,
    jobId: request.jobId ?? null,
  }));
  setPhase("done", {
    command: `node ${SCRIPT_PATH} result ${request.jobId ?? result.threadId}`,
    description: "Task finished. Inspect full result or send a follow-up."
  }, { diffPath: diff.diffPath, monitor });

  return { ...result, session, diff };
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
    valueOptions: ["model", "effort", "cwd", "prompt-file", "mode"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const VALID_MODES = new Set(["plan", "default"]);
  if (options.mode != null && !VALID_MODES.has(options.mode)) {
    throw usageError(`mode must be plan or default, got ${JSON.stringify(options.mode)}`);
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
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
  // Fail fast before `runBridgeTask` can append `prompt_footer` to an empty prompt
  // and spend a billed Codex turn. Mirrors the check the --background path already does.
  requireTaskRequest(prompt, resumeLast);
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureCodexAvailable(cwd);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id,
      mode: options.mode ?? null
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    emitSuccess("task", payload, renderQueuedTaskLaunch(payload), {
      json: options.json,
      startedAt
    });
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      runBridgeTask({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        mode: options.mode ?? null,
        onProgress: progress
      }),
    { json: options.json, startedAt, command: "task" }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw usageError("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
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
    () =>
      // Go through `runBridgeTask` (not `executeTaskRun` directly) so the
      // detached worker builds the same session-logging hooks, prompt
      // decorations (`skip_meta_skills`, `prompt_footer`), sandbox-policy
      // resolution, `[QUESTION]` handler, and auto-pipeline that the
      // foreground path uses. Pre-v1.2.1 this line called `executeTaskRun`
      // directly, so `task --background` ran the turn but produced ZERO
      // session artifacts (`.events`, `.ndjson`, `.diff`) — breaking every
      // `wait` / `events --follow` caller. See `gherkin-tests-v2/
      // 07-orchestration/08-background-path-produces-session-files.md`.
      runBridgeTask({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
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

  const report = buildStatusSnapshot(cwd, { all: options.all });
  emitSuccess("status", report, renderStatusReport(report), {
    json: options.json,
    startedAt
  });
}

function handleResult(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
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
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
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

  const config = getBridgeConfig(cwd);
  const sessionDir = resolveSessionDir(config.session_dir);
  const eventsPath = path.join(sessionDir, `${job.threadId}.events`);
  const timeoutMs = Math.max(1000, Number(options["timeout-ms"]) || 600_000);
  const TERMINAL = /\[(DONE|ERROR|INCOMPLETE)\]/;

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

async function handleEvents(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "filter"],
    booleanOptions: ["json", "follow"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (!reference) {
    throw usageError("events requires <job-id-or-thread-id>");
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

  const config = getBridgeConfig(cwd);
  const sessionDir = resolveSessionDir(config.session_dir);
  const eventsPath = path.join(sessionDir, `${job.threadId}.events`);

  const filter = options.filter
    ? new Set(
        options.filter
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
      )
    : null;
  const tagOf = (line) => {
    // Match the leading bracketed tag. Tags use uppercase for the head but may
    // carry a lowercase subtype after ":" (e.g. "[PIPELINE:review]"), so the
    // inner class must permit lowercase too — filter scoping is head-only.
    const m = /^\[([A-Za-z:]+)\]/.exec(line);
    return m ? m[1].split(":")[0].toUpperCase() : null;
  };
  const passes = (line) => {
    if (!filter) return true;
    const tag = tagOf(line);
    return tag != null && filter.has(tag);
  };

  const TERMINAL = /^\[(DONE|ERROR|INCOMPLETE)\]/;

  // Dump existing content (filtered). Track whether a terminal tag is already
  // present so --follow can short-circuit on already-completed events files.
  let initial = "";
  let alreadyTerminal = false;
  if (fs.existsSync(eventsPath)) {
    initial = fs.readFileSync(eventsPath, "utf8");
    for (const line of initial.split("\n")) {
      if (!line) continue;
      if (passes(line)) process.stdout.write(line + "\n");
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
        filter: options.filter ?? null
      },
      "",
      { json: options.json, startedAt }
    );
    return;
  }

  // Tail mode — follow appends until a terminal tag or the timeout.
  let timedOut = false;
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
        if (passes(line)) process.stdout.write(line + "\n");
        if (TERMINAL.test(line)) return finish("terminal");
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
      timedOut
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

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

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

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  emitSuccess("cancel", payload, renderCancelReport(nextJob), {
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

async function handleSend(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["mode", "effort", "cwd"],
    booleanOptions: ["json", "wait"],
    aliasMap: { m: "mode" }
  });

  const VALID_MODES = new Set(["plan", "default"]);
  if (options.mode != null && !VALID_MODES.has(options.mode)) {
    throw usageError(`mode must be plan or default, got ${JSON.stringify(options.mode)}`);
  }

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

  const config = getBridgeConfig(cwd);
  const modeOverride = options.mode;

  const sessionDir = resolveSessionDir(config.session_dir);

  const turnOptions = {
    resumeThreadId: threadId,
    prompt,
    model: config.model,
    effort: normalizeReasoningEffort(options.effort ?? config.effort),
    sandbox: modeOverride === "default" ? "workspace-write" : modeOverride === "plan" ? "read-only" : undefined,
    onProgress: null,
    idleTimeoutMs: 120_000,
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
    }
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
  const workspaceRoot = resolveCommandWorkspace(options);
  const result = await runAppServerTurn(workspaceRoot, turnOptions);

  // Route failed Codex turns through emitError so exit code reflects the
  // failure class. Previously `send` emitted success + exit 0 even when the
  // turn failed with Unauthorized/ContextWindowExceeded/etc.
  if (result.status !== 0) {
    const errLike = result.error ?? { message: `send failed on thread ${threadId} (status ${result.status}).` };
    emitError(errLike, { json: options.json, command: "send" });
    return;
  }

  const session = findSession(sessionDir, threadId);
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
    valueOptions: ["cwd"],
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

  ensureCodexAvailable(cwd);

  await withAppServer(cwd, async (client) => {
    await client.request("turn/steer", {
      threadId,
      input: [{ type: "text", text: prompt }],
      expectedTurnId: turnId,
    });
  });

  const config = getBridgeConfig(cwd);
  const sessionDir = resolveSessionDir(config.session_dir);
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
    valueOptions: ["question-id", "answer", "json-payload", "cwd"],
    booleanOptions: ["json"]
  });

  const requestId = positionals[0];
  if (!requestId) {
    throw usageError("respond requires <request-id>");
  }

  const config = getBridgeConfig(cwd);
  const sessionDir = resolveSessionDir(config.session_dir);

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
    payload = JSON.parse(options["json-payload"]);
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

  // Write response file — the worker process polls for this and sends
  // the response on its own connection (which holds the original request)
  writeResponseFile(sessionDir, pending.threadId, {
    requestId: pending.internalId,
    rpcRequestId: pending.rpcRequestId,
    payload,
  });

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

  const config = getBridgeConfig(cwd);
  const sessionDir = resolveSessionDir(config.session_dir);
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
  cancel: handleCancel
});

async function main() {
  const startedAt = Date.now();
  const rawArgv = process.argv.slice(2);
  const [subcommand, ...argv] = rawArgv;

  // Silent per-launch update notice. Reads the cached latest-version result
  // only (no network on the hot path) — the cache is warmed asynchronously
  // in the background after dispatch so the NEXT invocation sees a new
  // upstream release. Never runs under `--json` (would pollute envelopes),
  // never runs for `version`/`update` (they have their own render), and
  // never runs for the hook-spawned "Stop Gate Review" rescue paths.
  maybeEmitUpdateNotice(rawArgv, subcommand);

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    if (detectJsonFlag(rawArgv)) {
      emitSuccess("help", buildMachineReadableHelp(), null, { json: true, startedAt });
      return;
    }
    printUsage();
    return;
  }

  // Per-subcommand --help / -h short-circuits before the handler runs so we
  // never fire a Codex turn just to answer a discovery query.
  if (COMMANDS[subcommand] && detectHelpFlag(argv)) {
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
