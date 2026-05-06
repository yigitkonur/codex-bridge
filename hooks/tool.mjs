#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function isDisabled() {
  const list = (process.env.CODEX_BRIDGE_HOOK_DISABLE ?? "")
    .split(",")
    .map((entry) => entry.trim());
  return list.includes("tool") || list.includes("all");
}

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8");
  return raw.trim() ? JSON.parse(raw) : {};
}

function runLegacy(scriptName, input) {
  const result = spawnSync(process.execPath, [path.join(SCRIPT_DIR, "lib", scriptName)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: process.env,
    cwd: input.cwd || process.cwd(),
    timeout: 8000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

try {
  if (isDisabled()) process.exit(0);
  const eventName = process.argv[2] || "";
  const input = readHookInput();
  if (eventName === "PreToolUse" && input.tool_name === "Bash") {
    runLegacy("feature-gate.mjs", input);
  } else if (eventName === "PreToolUse" && input.tool_name === "Agent") {
    runLegacy("hook-format.mjs", input);
  } else if (eventName === "PostToolUse") {
    runLegacy("env-propagate.mjs", input);
  }
} catch {
  process.stdout.write('{"continue":true}');
}

process.exit(0);
