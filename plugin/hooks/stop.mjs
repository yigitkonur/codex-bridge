#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  currentSessionId,
  jobMatchesHookContext,
  readJobMetadata,
  resolveJobsDir,
  resolveWorkspaceRoot,
} from "./lib/workspace-state.mjs";

const HOOK_NAME = "stop";
const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const REVIEW_GATE_LOCK_FILE = ".codex-bridge-stop-review-gate.lock";
const DEFAULT_STOP_REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STOP_REVIEW_CONFIG = {
  enabled: false,
  timeout_ms: DEFAULT_STOP_REVIEW_TIMEOUT_MS,
  fast_scan_only: true
};
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// Kill switch + structured error trail, matching every other plugin hook
// (session-start, session-end, user-prompt-submit, subagent-stop). The Stop
// hook is the highest-blast-radius hook in this set — it can hold a Claude
// Code session at shutdown for up to 15 minutes — so an emergency disable
// path is mandatory:
//   CODEX_BRIDGE_HOOK_DISABLE=stop          → disable just this hook
//   CODEX_BRIDGE_HOOK_DISABLE=all           → disable every codex-bridge hook
// When disabled, the hook returns silently (no decision JSON), which Claude
// Code interprets as "allow" — the safest default if the gate itself is
// broken or the user is debugging a stuck session.
function isDisabled() {
  const list = (process.env.CODEX_BRIDGE_HOOK_DISABLE ?? "")
    .split(",")
    .map((entry) => entry.trim());
  return list.includes(HOOK_NAME) ||
    list.includes("subagent-stop") ||
    list.includes("stop-gate") ||
    list.includes("stop-review-gate-hook") ||
    list.includes("all");
}

function logHookError(err) {
  try {
    const dir = path.join(os.homedir(), ".codex-bridge", "hook-errors");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${HOOK_NAME}.log`);
    fs.writeFileSync(file, `${err?.stack ?? err}\n`);
  } catch {
    // Last-resort silent: the hook must never throw out of process.
  }
}
// Probe both install layouts so this hook works whether the user
// installed via the v2 plugin (plugin/scripts/codex-bridge.mjs) or
// the legacy skill (skill/scripts/codex-bridge.mjs).
function resolveBridgeScript() {
  const candidates = [
    path.resolve(SCRIPT_DIR, "..", "scripts", "codex-bridge.mjs"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}
const BRIDGE_SCRIPT = resolveBridgeScript();
// Mirrors src/lib/state.mjs — kept inline so the cheap legacy-intent probe
// (see hasLegacyStopReviewGateIntent) can read state.json without spawning
// the bundled bridge. Update both files in lockstep if the layout changes.
const BRIDGE_PLUGIN_DATA_ENV = "CODEX_BRIDGE_PLUGIN_DATA";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const REGISTRY_ENV = "CODEX_BRIDGE_REGISTRY";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const BRIDGE_AGENT_TYPES = new Set([
  "codex-bridge:codex-bridge-runner",
  "codex-bridge:codex-bridge-reviewer",
]);
const TERMINAL_TAG_PATTERN = /\[(?:DONE|ERROR|INCOMPLETE|PLAN|CANCELLED)[^\]]*\]/;
const JOB_ID_PATTERN = /\b(?:task|review)-[a-z0-9]+-[a-z0-9]+\b/i;
const JOB_ID_PATTERN_GLOBAL = /\b(?:task|review)-[a-z0-9]+-[a-z0-9]+\b/gi;
const BASH_DENIED_PATTERN = /\b(?:bash permission|permission denied|denied|not allowed|requires permission|need bash)\b/i;

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function extractJobId(value, { latest = false } = {}) {
  if (value == null) return null;
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (latest) {
    let lastMatch = null;
    JOB_ID_PATTERN_GLOBAL.lastIndex = 0;
    let match;
    while ((match = JOB_ID_PATTERN_GLOBAL.exec(text)) !== null) {
      lastMatch = match[0];
    }
    return lastMatch;
  }
  const match = JOB_ID_PATTERN.exec(text);
  return match ? match[0] : null;
}

function extractJobIdFromTranscript(filePath) {
  if (!filePath) return null;
  try {
    const stat = fs.statSync(filePath);
    const maxBytes = 256 * 1024;
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return extractJobId(buffer.toString("utf8"), { latest: true });
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    logHookError(err);
  }
  return null;
}

function resolveJobId(input) {
  const directFields = [
    input.job_id,
    input.jobId,
    input.last_assistant_message,
    input.assistant_message,
    input.subagent_result,
    input.output,
  ];
  for (const field of directFields) {
    const jobId = extractJobId(field);
    if (jobId) return jobId;
  }

  return extractJobIdFromTranscript(
    input.agent_transcript_path ?? input.transcript_path,
  );
}

function extractSubagentText(input) {
  const fields = [
    input.last_assistant_message,
    input.assistant_message,
    input.subagent_result,
    input.output,
  ];
  for (const field of fields) {
    if (typeof field === "string" && field.trim()) return field.trim();
    if (field && typeof field === "object") {
      const text = JSON.stringify(field);
      if (text.trim()) return text;
    }
  }
  return null;
}

function formatNoDispatchBlock(agentType, reason, text) {
  const preview = text
    ? text.replace(/\s+/g, " ").slice(0, 500)
    : "No bridge job id was present in the subagent result.";
  return [
    `## Codex-Bridge subagent did not dispatch (${agentType})`,
    `reason: ${reason}`,
    "",
    "No `task-*` or `review-*` job id was found, so treat this subagent result as failed even if Claude Code labeled the Agent turn completed.",
    "",
    `Subagent output: ${preview}`,
  ].join("\n");
}

function findTerminalTagForJob(input, jobId) {
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = currentSessionId(input);
  const jobsRoot = resolveJobsDir(cwd);
  const job = readJobMetadata(jobsRoot, jobId);
  if (!jobMatchesHookContext(job, { workspaceRoot, sessionId })) return null;

  const eventsPath = path.join(jobsRoot, jobId, "events.jsonl");
  try {
    const text = fs.readFileSync(eventsPath, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = TERMINAL_TAG_PATTERN.exec(lines[i]);
      if (match) return { taskId: jobId, tag: match[0] };
    }
  } catch (err) {
    if (err?.code !== "ENOENT") logHookError(err);
  }
  return null;
}

function handleSubagentStop(input) {
  const agentType = input.agent_type ?? "";
  if (!BRIDGE_AGENT_TYPES.has(agentType)) {
    process.stdout.write('{"continue":true}');
    return;
  }

  let block = null;
  const jobId = resolveJobId(input);
  if (!jobId) {
    const text = extractSubagentText(input);
    if (BASH_DENIED_PATTERN.test(text ?? "")) {
      block = formatNoDispatchBlock(agentType, "BASH_DENIED", text);
    }
  } else {
    const terminal = findTerminalTagForJob(input, jobId);
    if (terminal) {
      block = `## Codex-Bridge subagent finished (${agentType})\nTask ${terminal.taskId} -> ${terminal.tag}\nFull output: \`/codex-bridge:result ${terminal.taskId}\``;
    }
  }

  if (!block) {
    process.stdout.write('{"continue":true}');
    return;
  }

  process.stdout.write(
    JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SubagentStop",
        additionalContext: block,
      },
    }),
  );
}

function runBridge(cwd, input, args, options = {}) {
  return spawnSync(process.execPath, [BRIDGE_SCRIPT, ...args], {
    cwd,
    env: {
      ...process.env,
      ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
    },
    encoding: "utf8",
    timeout: options.timeoutMs ?? 15000,
    // The long-running `task` spawn passes killSignal: "SIGKILL" explicitly
    // so an opt-in stop review has deterministic cleanup under its internal
    // timeout. Cheap calls keep SIGTERM since they should finish quickly and
    // graceful shutdown is preferred.
    ...(options.killSignal ? { killSignal: options.killSignal } : {})
  });
}

function extractBooleanConfig(raw, key) {
  const match = raw.match(new RegExp(`^\\s*${key}\\s*:\\s*(true|false)\\s*(?:#.*)?$`, "mi"));
  return match ? match[1] === "true" : undefined;
}

function extractNumberConfig(raw, key) {
  const match = raw.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\d+)\\s*(?:#.*)?$`, "mi"));
  return match ? Number(match[1]) : undefined;
}

function parseStopReviewGateConfig(raw) {
  if (!raw || !/stop_review_gate\s*:/.test(raw)) return {};
  const enabled = extractBooleanConfig(raw, "enabled");
  const timeoutMs = extractNumberConfig(raw, "timeout_ms");
  const fastScanOnly = extractBooleanConfig(raw, "fast_scan_only");
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeout_ms: timeoutMs } : {}),
    ...(fastScanOnly === undefined ? {} : { fast_scan_only: fastScanOnly })
  };
}

function workspaceConfigPaths(cwd) {
  const projectRoot = resolveProjectRoot(cwd);
  const paths = [
    path.join(projectRoot, "config.yaml"),
    path.join(cwd, "config.yaml"),
    path.join(projectRoot, ".claude", "codex-bridge.local.md"),
    path.join(cwd, ".claude", "codex-bridge.local.md")
  ];
  return [...new Set(paths)];
}

function loadStopReviewGateConfig(cwd) {
  let config = { ...DEFAULT_STOP_REVIEW_CONFIG };
  for (const configPath of workspaceConfigPaths(cwd)) {
    if (!fs.existsSync(configPath)) continue;
    try {
      config = {
        ...config,
        ...parseStopReviewGateConfig(fs.readFileSync(configPath, "utf8"))
      };
    } catch {
      // Ignore unreadable local config in the Stop hook. The hook should
      // stay fail-open unless it can positively prove it must block.
    }
  }
  return config;
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function stderrLine(message) {
  if (message) process.stderr.write(`${message}\n`);
}

function emitBlock(reason) {
  process.stdout.write(
    `${JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "Stop",
        decision: "block",
        reason,
      },
    })}\n`,
  );
}

function blockReason(reason, runningNote) {
  return runningNote ? `${runningNote} ${reason}` : reason;
}

function formatCommandArg(value) {
  const text = String(value ?? "");
  return text.replace(/[\r\n\t]+/g, " ").replace(/[^\w./:@=-]+/g, "_").slice(0, 120) || "_";
}

function formatPendingVerdict(entry) {
  const taskId = typeof entry?.task_id === "string" && entry.task_id ? entry.task_id : "unknown-task";
  const verdict = typeof entry?.verdict === "string" && entry.verdict ? entry.verdict : "unknown-verdict";
  const action = Array.isArray(entry?.next_action?.argv) && entry.next_action.argv.length > 0
    ? `next: codex-bridge ${entry.next_action.argv.map(formatCommandArg).join(" ")}`
    : "next: inspect or discard the verdict";
  return `${taskId} (${verdict}; ${action})`;
}

function buildPendingVerdictsBlockReason(pending, count) {
  const total = Number.isInteger(count) && count >= 0 ? count : pending.length;
  const shownRows = pending.slice(0, 10);
  const shown = shownRows.map(formatPendingVerdict).join("; ") || "details unavailable";
  const extraCount = Math.max(0, total - shownRows.length);
  const suffix = extraCount > 0 ? `; and ${extraCount} more` : "";
  return `Codex Bridge has ${total} pending review verdict${total === 1 ? "" : "s"} blocking session stop: ${shown}${suffix}. Resolve them with merge, iterate, or verdict --discard before ending the session.`;
}

function registryRoot() {
  const override = process.env[REGISTRY_ENV];
  return override && override.length > 0
    ? override
    : path.join(os.homedir(), ".codex-bridge", "jobs");
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listPendingVerdicts() {
  const root = registryRoot();
  if (!fs.existsSync(root)) return [];
  const pendingVerdicts = new Set(["approved", "needs-attention", "must-fix"]);
  const taskIds = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "." && entry.name !== ".." && /^[A-Za-z0-9._-]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const pending = [];
  for (const taskId of taskIds) {
    const taskDir = path.join(root, taskId);
    const verdict = readJsonFile(path.join(taskDir, "verdict.json"));
    if (!verdict || !pendingVerdicts.has(verdict.verdict)) continue;
    const meta = readJsonFile(path.join(taskDir, "meta.json"));
    if (verdict.merged_at || meta?.merged_at || meta?.phase === "merged") continue;
    if (verdict.superseded_by || meta?.superseded_by || meta?.phase === "superseded") continue;
    pending.push({
      task_id: taskId,
      verdict: verdict.verdict,
      summary: verdict.summary ?? null,
      decided_at: verdict.decided_at,
      next_action: verdict.next_action ?? null
    });
  }
  return pending;
}

function pendingVerdictsBlockReason() {
  try {
    const pending = listPendingVerdicts();
    if (pending.length === 0) return null;
    return buildPendingVerdictsBlockReason(pending, pending.length);
  } catch (error) {
    return `Codex Bridge stop-time review gate could not check pending verdicts: ${
      error instanceof Error ? error.message : String(error)
    }. Run /codex-bridge:verdicts --pending manually or remove the gate lock to disable the gate.`;
  }
}

function resolveProjectRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: 5000
  });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : cwd;
}

function reviewGateActivation(cwd) {
  const projectRoot = resolveProjectRoot(cwd);
  const lockPath = path.join(projectRoot, REVIEW_GATE_LOCK_FILE);
  if (fs.existsSync(lockPath)) {
    return { active: true, source: "lock-file", lockPath };
  }

  return { active: false, source: "disabled", lockPath };
}

function runningJobNote(cwd, input) {
  const result = runBridge(cwd, input, ["status", "--json"], { timeoutMs: 10000 });
  const payload = parseJson(result.stdout);
  const running = Array.isArray(payload?.result?.running) ? payload.result.running : [];
  if (running.length === 0) return null;
  const first = running[0];
  return `Codex Bridge job ${first.id ?? "unknown"} is still running. Check /codex-bridge:status and use /codex-bridge:cancel ${first.id ?? ""} if you want to stop it before ending the session.`;
}

// Read the last assistant turn out of Claude Code's transcript JSONL. Stop-hook
// payload shape (per Claude Code docs) is `{ session_id, transcript_path, cwd,
// reason, stop_hook_active }` — there is NO `last_assistant_message` field, so
// the review must hydrate the transcript itself or it asks Codex to ALLOW/BLOCK
// an unspecified previous turn. Best-effort: any read/parse failure falls back
// to an empty string and we log a stderr warning so the operator knows the
// review prompt was un-grounded for this turn.
//
// Transcript format: each line is one JSON record. Records carrying a final
// assistant turn look like `{type:"assistant", message:{role:"assistant",
// content:[{type:"text", text:"..."}, ...]}}`. We only want the most recent
// such record (so we ignore mid-session assistant tool-use turns prior to it
// — those still appear, but the LAST one is the user-facing final answer
// that triggered Stop). Content blocks other than `text` (tool_use,
// thinking, etc.) are skipped; we only join the `text` blocks.
function extractLastAssistantText(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") return "";
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch (error) {
    stderrLine(
      `codex-bridge stop hook: could not read transcript_path (${transcriptPath}): ${
        error instanceof Error ? error.message : String(error)
      }. Review will run without prior-turn grounding.`
    );
    return "";
  }

  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "assistant") continue;
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    const texts = [];
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      }
    }
    const joined = texts.join("\n").trim();
    if (joined) return joined;
  }

  stderrLine(
    `codex-bridge stop hook: transcript_path (${transcriptPath}) had no readable assistant turn. Review will run without prior-turn grounding.`
  );
  return "";
}

function buildStopReviewPrompt(input) {
  // `last_assistant_message` is NOT a Claude Code Stop-hook payload field. We
  // keep the (defensive) read for any future shape change but the real source
  // is `transcript_path` — see extractLastAssistantText.
  const fromPayload = String(input.last_assistant_message ?? "").trim();
  const fromTranscript = fromPayload || extractLastAssistantText(input?.transcript_path);
  const claudeResponseBlock = fromTranscript
    ? `\n\n<previous_assistant_message>\n${fromTranscript}\n</previous_assistant_message>`
    : "";
  return `${STOP_REVIEW_TASK_MARKER}

You are reviewing Claude Code's just-finished response before the session stops.
Return exactly one first line:
ALLOW: <short reason>
BLOCK: <short reason>

Block only for concrete correctness, safety, or verification issues that Claude should address before stopping. Do not block for style preferences, optional follow-ups, or broad improvement ideas.${claudeResponseBlock}`;
}

function hasReviewableTranscript(input) {
  const fromPayload = String(input.last_assistant_message ?? "").trim();
  if (fromPayload) return true;
  return Boolean(extractLastAssistantText(input?.transcript_path));
}

function stopReviewTurnTimeoutMs(timeoutMs) {
  const normalized = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_STOP_REVIEW_TIMEOUT_MS;
  return Math.max(1000, normalized - 60_000);
}

function parseStopReview(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason: "The stop-time Codex Bridge review returned no final output. Run /codex-bridge:review --wait manually or disable the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) return { ok: true, reason: null };
  if (firstLine.startsWith("BLOCK:")) {
    return {
      ok: false,
      reason: firstLine.slice("BLOCK:".length).trim() || text
    };
  }

  return {
    ok: false,
    reason: "The stop-time Codex Bridge review returned an unexpected answer. Run /codex-bridge:review --wait manually or disable the gate."
  };
}

// Resolve the workspace's state.json path the same way src/lib/state.mjs
// does, without importing bridge code (this hook ships separately and
// must stay zero-dep on the bundle for the cheap path). Returns null when
// we can't resolve a workspace root — in that case there's no state file
// to read, so callers should treat it as "no legacy intent".
function resolveStateFilePath(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: 5000
  });
  const workspaceRoot =
    result.status === 0 && typeof result.stdout === "string" && result.stdout.trim()
      ? result.stdout.trim()
      : cwd;
  if (!workspaceRoot) return null;

  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[BRIDGE_PLUGIN_DATA_ENV] || process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`, STATE_FILE_NAME);
}

// Cheap, best-effort probe for "this workspace previously enabled the
// stop-time review gate via the legacy boolean-only setup". Reads
// state.json directly. Returns true ONLY when the file exists AND
// `config.stopReviewGate === true`. Anything else (no file, parse error,
// missing config, false) means there is nothing to migrate, so the
// hook's caller can skip the expensive `setup --json` spawn.
function hasLegacyStopReviewGateIntent(cwd) {
  const stateFile = resolveStateFilePath(cwd);
  if (!stateFile) return false;
  if (!fs.existsSync(stateFile)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return parsed?.config?.stopReviewGate === true;
  } catch {
    return false;
  }
}

// Self-migrate workspaces that enabled the gate before lock-file activation
// landed: `setup --enable-review-gate` used to persist only
// `config.stopReviewGate: true` in state.json, but this branch made the
// hook gate on the project-root lock file. Without migration the hook
// would return at the activation check below and silently disable an
// already-enabled gate on upgrade. We mint the lock inline here when
// setup reports legacy intent and no on-disk lock, then re-evaluate so
// the rest of the hook proceeds with the migrated state. Suppressed-by-
// official-plugin workspaces are honored — we don't create a lock the
// bridge would refuse to honor anyway.
//
// Cheap path: the vast majority of Stop-hook invocations land in
// workspaces that never enabled the gate (the documented disabled
// default). We short-circuit those by reading state.json directly first
// — no `setup --json` spawn, no Codex availability/auth probe, no
// app-server contact. We only fall through to the full setup probe when
// state.json actually carries `config.stopReviewGate: true`, which is
// the genuine legacy → migration case.
function maybeMigrateLegacyGate(cwd, input, activation) {
  if (activation.active) return activation;
  if (!hasLegacyStopReviewGateIntent(cwd)) return activation;
  const probe = runBridge(cwd, input, ["setup", "--json"], { timeoutMs: 15000 });
  const probePayload = parseJson(probe.stdout);
  const result = probePayload?.result;
  if (!probePayload?.ok || !result) return activation;
  if (
    result.reviewGateSuppressedByOfficialPlugin === true ||
    result.reviewGateLockIgnored === true ||
    result.reviewGateSuppressionReason
  ) {
    return activation;
  }
  if (result.reviewGateLockExists === true || result.reviewGateEnabled === true) {
    // Bridge already migrated the lock during its own readStopReviewGate
    // (src/codex-bridge.mjs:790-823). Re-read activation from disk so the
    // hook sees the freshly-minted lock file as authoritative.
    const migrated = reviewGateActivation(cwd);
    if (migrated.active) return migrated;
  }

  // No hook-side fallback writer. The bridge's readStopReviewGate is the
  // single source of truth for migrating legacy `config.stopReviewGate:
  // true` to the lock file (src/codex-bridge.mjs:790-823). Letting the
  // hook also write the lock independently created a TOCTOU race against
  // a concurrent `setup --disable-review-gate`: the cheap state.json
  // probe could observe legacy intent, the user could disable the gate
  // (clearing both state and the lock), the bridge probe would correctly
  // report `reviewGateLockExists:false / reviewGateEnabled:false`, and
  // the hook's manual write would resurrect the lock the user just
  // deleted. If the bridge's own migration write throws (rare, e.g.
  // EACCES on the project root), the gate stays disabled until the user
  // reruns `codex-bridge setup --enable-review-gate`; that is the
  // correct fail-safe outcome over silently re-enabling a gate the user
  // may have deliberately turned off.
  return activation;
}

function main() {
  const eventName = process.argv[2] || "";
  if (eventName === "SubagentStart") {
    return;
  }
  if (eventName === "SubagentStop") {
    const input = readHookInput();
    handleSubagentStop(input);
    return;
  }
  if (eventName && eventName !== "Stop") {
    return;
  }
  // The plugin-hook kill switch (CODEX_BRIDGE_HOOK_DISABLE) is honored
  // before any bridge spawn so an operator with a broken bridge has an
  // escape hatch without editing the lock file. But silently failing
  // open on inherited env (a leaked dotfile export, a parent-shell
  // override) on a workspace where the gate is actually active would
  // bypass the security promise the lock makes. Cheap fix: read the
  // lock state first; when the kill switch suppresses an *active* gate,
  // emit a stderr diagnostic so the user sees the override in their
  // session log. The gate still fails open (Claude Code interprets no
  // stdout decision as "allow") — the diagnostic just makes the
  // disable visible.
  const disabled = isDisabled();
  if (disabled) {
    let lockSnapshot;
    try {
      lockSnapshot = reviewGateActivation(process.cwd());
    } catch {
      lockSnapshot = null;
    }
    if (lockSnapshot?.active) {
      stderrLine(
        `Codex Bridge stop-time review gate lock is present (${lockSnapshot.lockPath}), but CODEX_BRIDGE_HOOK_DISABLE is set — the gate is being skipped for this session. Unset CODEX_BRIDGE_HOOK_DISABLE (or remove "stop"/"all" from it) to re-enable.`
      );
    }
    return;
  }
  const input = readHookInput();
  if (!eventName && input.hook_event_name === "SubagentStop") {
    handleSubagentStop(input);
    return;
  }
  if (input.stop_hook_active === true) {
    return;
  }

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const stopReviewConfig = loadStopReviewGateConfig(cwd);
  const pendingReason = pendingVerdictsBlockReason();
  if (pendingReason && !stopReviewConfig.enabled) {
    emitBlock(blockReason(pendingReason, null));
    return;
  }
  if (!pendingReason) {
    return;
  }
  if (stopReviewConfig.fast_scan_only) {
    emitBlock(blockReason(pendingReason, null));
    return;
  }

  if (!hasReviewableTranscript(input)) {
    stderrLine("Codex Bridge stop-time review gate is enabled, but the Stop transcript has no reviewable assistant message; skipping review.");
    return;
  }

  const runningNote = runningJobNote(cwd, input);
  let activation = reviewGateActivation(cwd);
  activation = maybeMigrateLegacyGate(cwd, input, activation);

  if (!activation.active && stopReviewConfig.enabled) {
    activation = {
      active: true,
      source: "config",
      lockPath: path.join(resolveProjectRoot(cwd), REVIEW_GATE_LOCK_FILE)
    };
  }

  const setup = runBridge(cwd, input, ["setup", "--json"], { timeoutMs: 15000 });
  const setupPayload = parseJson(setup.stdout);
  const setupResult = setupPayload?.result;

  if (!setupPayload?.ok || !setupResult) {
    emitBlock(
      blockReason(
        `Codex Bridge stop-time review gate is enabled (${activation.lockPath}), but setup could not verify the bridge runtime. Run /codex-bridge:setup or remove the lock file to disable the gate.`,
        runningNote
      )
    );
    return;
  }

  if (setupResult.reviewGateEnabled !== true) {
    if (
      setupResult.reviewGateLockIgnored ||
      setupResult.reviewGateSuppressedByOfficialPlugin ||
      setupResult.reviewGateSuppressionReason
    ) {
      stderrLine(
        `Codex Bridge stop-time review gate lock is present but ignored: ${
          setupResult.reviewGateSuppressionReason ?? "review-gate-suppressed"
        }.`
      );
      stderrLine(runningNote);
      return;
    }
    if (activation.source !== "config") {
      emitBlock(
        blockReason(
          `Codex Bridge stop-time review gate lock is present (${activation.lockPath}), but setup did not confirm the gate is enabled. Run /codex-bridge:setup or remove the lock file to disable the gate.`,
          runningNote
        )
      );
      return;
    }
    // Local config is the new opt-in path. It does not need the legacy
    // project lock, but setup still has a chance above to suppress duplicate
    // stop-review behavior when the official OpenAI Codex plugin owns it.
  }

  if (!setupResult.ready) {
    emitBlock(
      blockReason(
        `Codex Bridge stop-time review gate is enabled (${activation.lockPath}), but Codex is not ready. Run /codex-bridge:setup or remove the lock file to disable the gate.`,
        runningNote
      )
    );
    return;
  }

  if (runningNote) {
    stderrLine(`${runningNote} The stop-time Codex Bridge review will still run before allowing this session to stop.`);
  }

  // `--read-only` forces the gate-time review onto a read-only sandbox even
  // when the workspace `config.sandbox_policy` is `danger-full-access`. The
  // Stop hook only ALLOWs/BLOCKs the previous Claude turn — it must not
  // mutate the repo at session shutdown. Without `--read-only`, omitting
  // `--write` is insufficient because `buildSandboxPolicy` still honors the
  // config override (see src/lib/config.mjs::buildSandboxPolicy).
  //
  // The prompt is written to a tempfile and forwarded via `--prompt-file`
  // because Unix argv has a hard cap (~256 KiB on macOS, ~2 MiB on Linux).
  // The Stop-hook prompt embeds the previous assistant turn extracted from
  // `transcript_path` — when that turn contains generated code or long
  // logs, passing the prompt as a single spawnSync argv item could fail
  // with E2BIG before Codex even runs and leave the gate blocking. Bounding
  // the size by the filesystem instead of argv removes that failure mode.
  const promptFile = path.join(
    os.tmpdir(),
    `codex-bridge-stop-review-${randomBytes(16).toString("hex")}.prompt.md`
  );
  let review;
  try {
    fs.writeFileSync(promptFile, buildStopReviewPrompt(input), { encoding: "utf8", mode: 0o600 });
    review = runBridge(
      cwd,
      input,
      [
        "task",
        "--json",
        "--mode",
        "default",
        "--read-only",
        "--no-pipeline",
        "--turn-default-ms",
        String(stopReviewTurnTimeoutMs(stopReviewConfig.timeout_ms)),
        "--prompt-file",
        promptFile
      ],
      { timeoutMs: stopReviewConfig.timeout_ms, killSignal: "SIGKILL" }
    );
  } finally {
    try {
      fs.rmSync(promptFile, { force: true });
    } catch {
      // Best-effort cleanup; tmpdir entries are reaped by the OS. We
      // never want a cleanup error to mask the real review outcome.
    }
  }

  if (review.error?.code === "ETIMEDOUT") {
    emitBlock(`The stop-time Codex Bridge review timed out after ${Math.round(stopReviewConfig.timeout_ms / 60000)} minutes. Run /codex-bridge:review --wait manually or disable the gate.`);
    return;
  }

  if (review.status !== 0) {
    const detail = String(review.stderr || review.stdout || "").trim();
    emitBlock(detail ? `The stop-time Codex Bridge review failed: ${detail}` : "The stop-time Codex Bridge review failed.");
    return;
  }

  const reviewPayload = parseJson(review.stdout);
  const parsed = parseStopReview(reviewPayload?.result?.rawOutput);
  if (!parsed.ok) {
    emitBlock(runningNote ? `${runningNote} ${parsed.reason}` : parsed.reason);
    return;
  }

  stderrLine(runningNote);
}

try {
  main();
} catch (error) {
  // Persist a structured error trail under ~/.codex-bridge/hook-errors/ so
  // operators can diagnose hook crashes after the session ends. Mirrors the
  // failure-mode contract documented in the sibling plugin/hooks (see
  // session-start.mjs:35-43, user-prompt-submit.mjs:40-48).
  logHookError(error);
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
}
// Always exit 0, matching every other plugin hook (session-start.mjs:213,
// session-end.mjs, user-prompt-submit.mjs:166, subagent-stop.mjs:159).
// Rationale: Claude Code interprets a Stop hook crash as "allow" only if
// stdout did not contain a blocking decision; emitting a non-zero exit
// code is unnecessary and would only complicate downstream tooling that
// classifies hook outcomes by exit status. The deliberate choice NOT to
// emitBlock("hook crashed") here is a security stance: failing open is
// the right posture for a stop-gate whose own runtime is broken — a
// crashed hook should never hold the session hostage. Operators get the
// diagnostic via the hook-errors log and stderr trail.
process.exit(0);
