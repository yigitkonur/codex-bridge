#!/usr/bin/env node
// SessionEnd hook for codex-bridge plugin.
//
// On Claude Code session termination, run `codex-bridge status
// --prune-orphans --json` to clean up stale job records (jobs whose
// owner pid is dead). This matches the legacy session-lifecycle-hook.mjs
// SessionEnd half — pure cleanup, no behavior change visible to the user.
//
// Failure mode: any error logs to ~/.codex-bridge/hook-errors and the
// hook exits 0. SessionEnd hooks have a default 1.5s budget; ours
// allows up to 10s for the spawn (matches legacy timeout).
//
// Kill switch: CODEX_BRIDGE_HOOK_DISABLE=session-end (or "all") skips
// the prune. Useful when the bridge state is corrupted and the prune
// itself would error.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const HOOK_NAME = "session-end";
const PRUNE_TIMEOUT_MS = 10000;

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

function formatPruneFailure(result) {
  const parts = [];
  if (result?.error) {
    parts.push(`error=${result.error.stack ?? result.error.message ?? result.error}`);
  }
  if (result?.status !== 0) {
    parts.push(`status=${result?.status ?? "null"}`);
  }
  if (result?.signal) {
    parts.push(`signal=${result.signal}`);
  }
  const stderr = String(result?.stderr ?? "").trim();
  if (stderr) {
    parts.push(`stderr:\n${stderr}`);
  }
  return new Error(`SessionEnd prune failed: ${parts.join("\n")}`);
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

  try {
    const bundle = resolveBundlePath();
    if (bundle) {
      const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
      const result = spawnSync(
        process.execPath,
        [bundle, "status", "--prune-orphans", "--json"],
        {
          cwd,
          env: process.env,
          encoding: "utf8",
          timeout: PRUNE_TIMEOUT_MS,
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      if (result.error || result.status !== 0 || result.signal) {
        logHookError(formatPruneFailure(result));
      }
    }
  } catch (err) {
    logHookError(err);
  }

  // SessionEnd doesn't have decision control, but emit clean JSON anyway.
  process.stdout.write('{"continue":true}');
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
