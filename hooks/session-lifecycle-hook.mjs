#!/usr/bin/env node
// Kill switch: CODEX_BRIDGE_HOOK_DISABLE=session-lifecycle-hook (or =all).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isDisabled } from "./lib/feature-gate.mjs";
import { appendEnvVars } from "./lib/env-propagate.mjs";
import { computeWorkspaceHash, resolveHookCwd } from "./lib/workspace-state.mjs";

if (isDisabled("session-lifecycle-hook")) process.exit(0);

const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const BRIDGE_SESSION_ID_ENV = "CODEX_BRIDGE_SESSION_ID";
const BRIDGE_WORKSPACE_HASH_ENV = "CODEX_BRIDGE_WORKSPACE_HASH";
const BRIDGE_PLUGIN_DATA_ENV = "CODEX_BRIDGE_PLUGIN_DATA";
const CLAUDE_PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.resolve(SCRIPT_DIR, "..", "skill", "scripts", "codex-bridge.mjs");

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

function handleSessionStart(input) {
  const cwd = resolveHookCwd(input);
  appendEnvVars({
    [BRIDGE_SESSION_ID_ENV]: input.session_id,
    [SESSION_ID_ENV]: input.session_id,
    [BRIDGE_WORKSPACE_HASH_ENV]: computeWorkspaceHash(cwd),
    [BRIDGE_PLUGIN_DATA_ENV]: resolveBridgePluginData(),
  });
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  spawnSync(process.execPath, [BRIDGE_SCRIPT, "status", "--prune-orphans", "--json"], {
    cwd,
    env: sessionEnv(input),
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "ignore", "ignore"]
  });
}

const input = readHookInput();
const eventName = process.argv[2] || input.hook_event_name || "";

if (eventName === "SessionStart") {
  handleSessionStart(input);
} else if (eventName === "SessionEnd") {
  handleSessionEnd(input);
}
