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

const HOOK_NAME = "pre-tool-agent";
const DISPATCH_TIMEOUT_MS = 8000;
const PREFLIGHT_TIMEOUT_MS = 5000;

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
  // --intercepted-from <subagent_type>` with the prompt on argv. The
  // bridge returns immediately with a jobId + monitor.tool_hint envelope.
  const args = [
    bundle,
    "task",
    "--background",
    "--json",
    "--intercepted-from",
    subagentType,
  ];
  if (mode === "read-only") {
    args.push("--read-only");
  } else {
    args.push("--write");
    args.push("--worktree-auto");
  }
  args.push(prompt);

  const result = spawnSync(process.execPath, args, {
    cwd,
    timeout: DISPATCH_TIMEOUT_MS,
    encoding: "utf8",
    env: process.env,
  });
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

function formatTrackerContext(envelope) {
  const r = envelope?.result ?? {};
  const taskId = r.task_id ?? r.jobId ?? "<unknown>";
  const jobId = r.jobId ?? r.job_id ?? "<unknown>";
  const monitor = r.monitor ?? r.monitor_hint ?? null;
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
  if (monitor && (monitor.tool_hint || monitor.command)) {
    lines.push(
      "Next step (REQUIRED): immediately arm the Monitor tool with the EXACT payload below. The Monitor will surface progress (CHECKPOINT, PLAN, QUESTION) and self-terminate on [DONE]/[ERROR]/[INCOMPLETE]:",
    );
    lines.push("");
    lines.push("Monitor input:");
    lines.push(JSON.stringify(monitor.tool_hint ?? monitor, null, 2));
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
