#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const BRIDGE_PLUGIN_DATA_ENV = "CODEX_BRIDGE_PLUGIN_DATA";
const CLAUDE_PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.resolve(SCRIPT_DIR, "..", "scripts", "codex-bridge.mjs");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") return;
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
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
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(BRIDGE_PLUGIN_DATA_ENV, resolveBridgePluginData());
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
