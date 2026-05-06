#!/usr/bin/env node
// Kill switch: CODEX_BRIDGE_HOOK_DISABLE=session-lifecycle-hook (or =all).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { appendEnvVars } from "./lib/env-propagate.mjs";
import { computeWorkspaceHash, resolveHookCwd } from "./lib/workspace-state.mjs";

const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const BRIDGE_SESSION_ID_ENV = "CODEX_BRIDGE_SESSION_ID";
const BRIDGE_WORKSPACE_HASH_ENV = "CODEX_BRIDGE_WORKSPACE_HASH";
const BRIDGE_PLUGIN_DATA_ENV = "CODEX_BRIDGE_PLUGIN_DATA";
const CLAUDE_PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// Resolve bridge script: prefer CLAUDE_PLUGIN_ROOT (set by Claude Code plugin runtime)
// then fall back to the relative path from this hook's directory.
const BRIDGE_SCRIPT = process.env.CLAUDE_PLUGIN_ROOT
  ? path.join(process.env.CLAUDE_PLUGIN_ROOT, "scripts", "codex-bridge.mjs")
  : path.resolve(SCRIPT_DIR, "..", "scripts", "codex-bridge.mjs");
const DEFAULT_SESSION_BRIEF_CONFIG = {
  mode: "plan",
  effort: "xhigh",
  sandbox_policy: "danger-full-access",
};

function isDisabled() {
  const list = (process.env.CODEX_BRIDGE_HOOK_DISABLE ?? "")
    .split(",")
    .map((entry) => entry.trim());
  return list.includes("lifecycle") ||
    list.includes("session-lifecycle-hook") ||
    list.includes("all");
}

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function resolveBridgePluginData() {
  return process.env[BRIDGE_PLUGIN_DATA_ENV] || process.env[CLAUDE_PLUGIN_DATA_ENV];
}

function sessionEnv(input) {
  return {
    ...process.env,
    ...(resolveBridgePluginData() ? { [BRIDGE_PLUGIN_DATA_ENV]: resolveBridgePluginData() } : {}),
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
}

function readConfig(cwd, env) {
  const result = spawnSync(process.execPath, [BRIDGE_SCRIPT, "config", "show", "--json"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.error || result.status !== 0) return DEFAULT_SESSION_BRIEF_CONFIG;
  try {
    const envelope = JSON.parse(result.stdout);
    return envelope?.result?.effective_config ?? envelope?.result?.config ?? envelope?.result?.effective ?? DEFAULT_SESSION_BRIEF_CONFIG;
  } catch {
    return DEFAULT_SESSION_BRIEF_CONFIG;
  }
}

function formatSessionBrief(config) {
  const mode = config.mode ?? DEFAULT_SESSION_BRIEF_CONFIG.mode;
  const effort = config.effort ?? DEFAULT_SESSION_BRIEF_CONFIG.effort;
  const sandbox = config.sandbox_policy ?? DEFAULT_SESSION_BRIEF_CONFIG.sandbox_policy;
  return [
    "codex-bridge is configured. The user has set:",
    `- autonomy mode: ${mode}`,
    `- sandbox: ${sandbox} (enforced — read-only requests will be auto-upgraded)`,
    '- plan-mode: triggers on user prompt containing "plan", "planning", "plana", or related words',
    "",
    "To delegate substantial implementation, review, or audit work to codex, use:",
    "- /codex-bridge:task <prompt> — background work; Monitor arms automatically",
    "- /codex-bridge:review — adversarial review of current branch",
    "- /codex-bridge:status — list active jobs",
    "- /codex-bridge:respond <req-id> <answer> — answer a [QUESTION] event",
    "",
    `Effort flag: --effort {low|medium|high|xhigh} (default ${effort} per config).`,
    "",
    "Decision principles for when to use codex-bridge vs native subagents:",
    "- Substantial implementation (multi-file, scaffolding, migrations) → /codex-bridge:task --effort high",
    "- Adversarial review of current branch → /codex-bridge:review",
    "- Read-only investigation that doesn't need a fresh context → native Explore subagent",
    "- Quick lookups and single-symbol greps → just do it inline",
    "",
    'When the user\'s prompt mentions "plan", "planning", "plana", or related words, the dispatch will run in plan-mode (review-before-execute). Trust this default; override only when the user explicitly asks for direct execution.',
    "",
    "When you are blocked or genuinely stuck, the user has authorized one clarifying question via the request_user_input tool. Use it sparingly; prefer to make defensible defaults explicit in the dispatch prompt and proceed."
  ].join("\n");
}

function handleSessionStart(input) {
  const cwd = resolveHookCwd(input);
  appendEnvVars({
    [BRIDGE_SESSION_ID_ENV]: input.session_id,
    [SESSION_ID_ENV]: input.session_id,
    [BRIDGE_WORKSPACE_HASH_ENV]: computeWorkspaceHash(cwd),
    [BRIDGE_PLUGIN_DATA_ENV]: resolveBridgePluginData(),
  });
  const config = readConfig(cwd, sessionEnv(input));
  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: formatSessionBrief(config)
    }
  }));
}

function logHookError(label, err, detail = "") {
  try {
    const dir = path.join(os.homedir(), ".codex-bridge", "hook-errors");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-lifecycle.log`);
    fs.writeFileSync(file, `${label}: ${err?.message ?? err}${detail ? "\n" + detail : ""}\n`);
  } catch {
    // Ignore logging failures — the hook must never throw.
  }
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const pruneResult = spawnSync(process.execPath, [BRIDGE_SCRIPT, "status", "--prune-orphans", "--json"], {
    cwd,
    env: sessionEnv(input),
    encoding: "utf8",
    timeout: 10000,
  });
  if (pruneResult.status !== 0) {
    logHookError(
      "SessionEnd prune failed",
      `status=${pruneResult.status}`,
      pruneResult.stderr ?? ""
    );
  }
  // SessionEnd doesn't have decision control, but emit clean JSON anyway.
  process.stdout.write('{"continue":true}');
}

if (isDisabled()) process.exit(0);

try {
  const input = readHookInput();
  const eventName = process.argv[2] || input.hook_event_name || "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
  } else if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
} catch (err) {
  logHookError("lifecycle hook unhandled error", err);
  process.stdout.write('{"continue":true}');
}
process.exit(0);
