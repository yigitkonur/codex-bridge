#!/usr/bin/env node
// PreToolUse hook on the `Agent` tool — selectively intercepts native
// Claude Code subagent spawns and reroutes them through codex-bridge.
//
// The orchestrator (Opus) calls Agent({subagent_type, prompt, ...}). For
// subagent_types in the routing matrix (config: ~/.codex-bridge/config.yaml
// or built-in defaults), we deny the native dispatch and instead spawn
// `codex-bridge task --background` with the prompt; we return the bridge's
// jobId + Monitor.tool_hint as additionalContext so Claude immediately
// arms a Monitor on the codex-bridge events stream.
//
// Default routing (built-in fallback when no config):
//   Explore           → reroute to codex (cheap-fast read-heavy work)
//   Plan              → pass-through (Opus is good at planning)
//   general-purpose   → pass-through (caller hasn't expressed an opinion)
//   codex-bridge:*    → pass-through (already going to us)
//   <anything else>   → pass-through
//
// Failure mode: any error logs to ~/.codex-bridge/hook-errors and emits
// {"continue": true} so the original Agent call proceeds. The hook is a
// performance/cost optimization, not a correctness gate.
//
// Kill switch: CODEX_BRIDGE_HOOK_DISABLE=pre-tool-agent (or =all).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const HOOK_NAME = "pre-tool-agent";
const DISPATCH_TIMEOUT_MS = 8000;
const PREFLIGHT_TIMEOUT_MS = 5000;
const JOB_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const MONITOR_BOOLEAN_FLAGS = new Set(["--follow", "--json"]);
const MONITOR_VALUE_FLAGS = new Set([
  "--exclude",
  "--include",
  "--timeout-ms",
  "--since",
  "--max-events",
]);

const DEFAULT_ROUTING = {
  Explore: { backend: "codex", mode: "read-only" },
  Plan: "pass-through",
  "general-purpose": "pass-through",
};

function logHookError(err) {
  try {
    const dir = path.join(os.homedir(), ".codex-bridge", "hook-errors");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${HOOK_NAME}.log`);
    fs.writeFileSync(file, `${err?.stack ?? err}\n`);
  } catch {
    // Last-resort silent.
  }
}

function isDisabled() {
  const list = (process.env.CODEX_BRIDGE_HOOK_DISABLE ?? "")
    .split(",")
    .map((s) => s.trim());
  return list.includes(HOOK_NAME) || list.includes("all");
}

function readStdinJson() {
  const raw = fs.readFileSync(0, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function resolveBundlePath() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (root) {
    const candidates = [
      path.join(root, "scripts", "codex-bridge.mjs"),
      path.join(root, "skill", "scripts", "codex-bridge.mjs"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function loadRouting() {
  // For v2.0.0, return the built-in defaults. Wiring config.yaml YAML
  // parsing is staged for a follow-up; the hook is functional with the
  // default routing today.
  return DEFAULT_ROUTING;
}

function classifyRoute(routing, subagentType) {
  if (!subagentType) return null;
  // codex-bridge:* always pass through (already going to us).
  if (subagentType.startsWith("codex-bridge:")) return null;
  const entry = routing[subagentType];
  if (!entry || entry === "pass-through") return null;
  if (typeof entry === "object" && entry.backend) {
    return { backend: entry.backend, mode: entry.mode ?? "default" };
  }
  return null;
}

function preflightCodexBridge(bundle, cwd) {
  const result = spawnSync(process.execPath, [bundle, "auth-status", "--json"], {
    cwd,
    timeout: PREFLIGHT_TIMEOUT_MS,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, stderr: result.stderr, status: result.status };
  }
  try {
    const envelope = JSON.parse(result.stdout);
    return envelope?.ok === true && envelope?.result?.loggedIn === true
      ? { ok: true }
      : { ok: false, status: result.status, stderr: result.stdout };
  } catch (err) {
    return { ok: false, parseError: err.message };
  }
}

function dispatchToCodexBridge(bundle, cwd, prompt, subagentType, mode) {
  // Spawn `codex-bridge task --background --json --worktree-auto
  // --intercepted-from <subagent_type>` with the prompt forwarded via
  // `--prompt-file`. The bridge returns immediately with a jobId +
  // monitor.tool_hint envelope.
  //
  // The prompt is written to a tempfile (mode 0600) and forwarded via
  // `--prompt-file` because Unix argv has a hard cap (~256 KiB on macOS,
  // ~2 MiB on Linux). Agent subagent prompts can embed full instructions,
  // context and code — passing them as a single spawnSync argv item could
  // fail with E2BIG before the bridge even runs, silently defeating the
  // intercept. Bounding by the filesystem instead of argv removes that
  // failure mode (mirrors plugin/hooks/stop-gate.mjs:346-362).
  const promptFile = path.join(
    os.tmpdir(),
    `codex-bridge-pre-tool-agent-${randomBytes(16).toString("hex")}.prompt.md`,
  );
  try {
    fs.writeFileSync(promptFile, String(prompt ?? ""), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    return { ok: false, parseError: `failed to write prompt tempfile: ${err.message}` };
  }

  const args = [
    bundle,
    "task",
    "--background",
    "--json",
    "--intercepted-from",
    subagentType,
  ];
  if (mode === "read-only") {
    // Explore-class subagents are described as "cheap-fast read-heavy
    // work"; skip the plan stage so the intercepted task runs the same
    // single-shot shape as a native Explore call.
    args.push("--read-only", "--mode", "default");
  } else {
    args.push("--write");
    args.push("--worktree-auto");
  }
  args.push("--prompt-file", promptFile);

  let result;
  try {
    result = spawnSync(process.execPath, args, {
      cwd,
      timeout: DISPATCH_TIMEOUT_MS,
      encoding: "utf8",
      env: process.env,
    });
  } finally {
    try {
      fs.rmSync(promptFile, { force: true });
    } catch {
      // Best-effort cleanup; tmpdir entries are reaped by the OS.
    }
  }
  if (result.error || result.status !== 0) {
    return { ok: false, stderr: result.stderr, status: result.status };
  }
  try {
    const envelope = JSON.parse(result.stdout);
    return { ok: true, envelope };
  } catch (err) {
    return { ok: false, parseError: err.message };
  }
}

function splitCommandWords(raw) {
  const tokens = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "\\" && i + 1 < raw.length) {
        current += raw[i + 1];
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < raw.length) {
      current += raw[i + 1];
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function isNodeToken(token) {
  if (!token) return false;
  const base = path.basename(token).toLowerCase();
  return base === "node" || base === "node.exe";
}

function isBridgeScriptToken(token) {
  if (!token) return false;
  const base = path.basename(token);
  return base === "codex-bridge.mjs" || base === "codex-bridge";
}

function hasShellControl(command) {
  return /[;&|`<>()$#\r\n]/.test(command);
}

function isSafeMonitorCommand(command, jobId) {
  if (!command || typeof command !== "string") return false;
  if (command.length > 1000 || hasShellControl(command)) return false;
  const tokens = splitCommandWords(command);
  let eventsIndex = -1;
  if (isNodeToken(tokens[0]) && isBridgeScriptToken(tokens[1]) && tokens[2] === "events") {
    eventsIndex = 2;
  } else if (isBridgeScriptToken(tokens[0]) && tokens[1] === "events") {
    eventsIndex = 1;
  }
  if (eventsIndex === -1) return false;
  if (tokens[eventsIndex + 1] !== jobId) return false;
  const trailing = tokens.slice(eventsIndex + 2);
  if (!trailing.includes("--follow")) return false;
  for (let i = 0; i < trailing.length; i += 1) {
    const token = trailing[i];
    if (MONITOR_BOOLEAN_FLAGS.has(token)) continue;
    if (MONITOR_VALUE_FLAGS.has(token)) {
      const value = trailing[i + 1];
      if (value === undefined || value.startsWith("-")) return false;
      i += 1;
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 2 && token.startsWith("--") && MONITOR_VALUE_FLAGS.has(token.slice(0, eq))) continue;
    return false;
  }
  return true;
}

function sanitizeMonitorHint(hint, jobId) {
  if (!hint || typeof hint !== "object" || Array.isArray(hint)) return null;
  if (!jobId || typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) return null;
  if (!isSafeMonitorCommand(hint.command, jobId)) return null;
  return {
    description: typeof hint.description === "string" && hint.description
      ? hint.description.slice(0, 300)
      : "codex-bridge task events",
    command: hint.command,
    timeout_ms: Number.isSafeInteger(hint.timeout_ms) && hint.timeout_ms > 0
      ? Math.min(hint.timeout_ms, 3_600_000)
      : 3_600_000,
    persistent: hint.persistent === true,
  };
}

function formatTrackerContext(envelope) {
  const r = envelope?.result ?? {};
  const taskId = r.task_id ?? r.jobId ?? "<unknown>";
  const jobId = r.jobId ?? r.job_id ?? "<unknown>";
  const monitor = r.monitor ?? r.monitor_hint ?? null;
  const monitorHint = sanitizeMonitorHint(monitor?.tool_hint ?? monitor, jobId);
  const lines = [
    "## Codex-Bridge intercepted this Agent dispatch",
    `task_id: ${taskId}`,
    `jobId:   ${jobId}`,
  ];
  if (r.worktree?.path) {
    lines.push(`worktree: ${r.worktree.path}`);
  }
  if (r.worktree?.branch) {
    lines.push(`branch:   ${r.worktree.branch}`);
  }
  if (r.worktree?.base_sha) {
    lines.push(`base_sha: ${r.worktree.base_sha}`);
  }
  lines.push("");
  if (monitorHint) {
    lines.push(
      "Next step (REQUIRED): immediately arm the Monitor tool with the EXACT payload below. The Monitor will surface progress (CHECKPOINT, PLAN, QUESTION) and self-terminate on [DONE]/[ERROR]/[INCOMPLETE]:",
    );
    lines.push("");
    lines.push("Monitor input:");
    lines.push(JSON.stringify(monitorHint, null, 2));
  } else {
    lines.push(
      `Track via /codex-bridge:status ${taskId} or /codex-bridge:result ${taskId}.`,
    );
  }
  return lines.join("\n");
}

function main() {
  if (isDisabled()) {
    process.stdout.write('{"continue":true}');
    return;
  }

  let input = {};
  try {
    input = readStdinJson();
  } catch (err) {
    logHookError(err);
    process.stdout.write('{"continue":true}');
    return;
  }

  if (input.tool_name !== "Agent") {
    process.stdout.write('{"continue":true}');
    return;
  }

  const subagentType = input.tool_input?.subagent_type;
  const prompt = input.tool_input?.prompt;
  const route = classifyRoute(loadRouting(), subagentType);
  if (!route) {
    process.stdout.write('{"continue":true}');
    return;
  }

  const bundle = resolveBundlePath();
  if (!bundle) {
    // Can't find the bridge — let the native Agent call proceed.
    process.stdout.write('{"continue":true}');
    return;
  }
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const preflight = preflightCodexBridge(bundle, cwd);
  if (!preflight.ok) {
    logHookError(
      new Error(
        `preflight failed for subagent_type=${subagentType}: status=${preflight.status ?? "?"} stderr=${preflight.stderr ?? "?"} parseError=${preflight.parseError ?? "?"}`,
      ),
    );
    process.stdout.write('{"continue":true}');
    return;
  }

  let dispatch;
  try {
    dispatch = dispatchToCodexBridge(bundle, cwd, prompt ?? "", subagentType, route.mode);
  } catch (err) {
    logHookError(err);
    process.stdout.write('{"continue":true}');
    return;
  }

  if (!dispatch.ok) {
    logHookError(
      new Error(
        `dispatch failed for subagent_type=${subagentType}: status=${dispatch.status} stderr=${dispatch.stderr ?? "?"} parseError=${dispatch.parseError ?? "?"}`,
      ),
    );
    // Bridge dispatch failed — fall back to the native Agent call.
    process.stdout.write('{"continue":true}');
    return;
  }

  const additionalContext = formatTrackerContext(dispatch.envelope);
  const taskId =
    dispatch.envelope?.result?.task_id ?? dispatch.envelope?.result?.jobId ?? "?";

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `subagent_type=${subagentType} rerouted to codex-bridge (task_id=${taskId}). Track via Monitor; do NOT retry the Agent call.`,
        additionalContext,
      },
    }),
  );
}

try {
  main();
} catch (err) {
  logHookError(err);
  try {
    process.stdout.write('{"continue":true}');
  } catch {
    // Nothing left to do.
  }
}
process.exit(0);
