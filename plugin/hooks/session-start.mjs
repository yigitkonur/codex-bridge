#!/usr/bin/env node
// SessionStart hook for codex-bridge plugin.
//
// On every Claude Code session boot, this hook calls
// `codex-bridge status --json` and injects a brief summary of running
// jobs, the most recent verdict, backend capabilities, and suggested
// next actions into Claude's context as `additionalContext`. The
// orchestrator boots oriented without having to poll status itself.
//
// Behavior preservation: also sets CODEX_COMPANION_SESSION_ID and
// CODEX_BRIDGE_PLUGIN_DATA env vars via $CLAUDE_ENV_FILE so subsequent
// Bash commands in the session see them, matching the legacy
// session-lifecycle-hook.mjs SessionStart half.
//
// Failure mode: any error (status spawn timeout, JSON parse, etc.) is
// logged to ~/.codex-bridge/hook-errors/<ts>.log and the hook emits
// {"continue": true} with no additionalContext. The hook MUST NOT
// block session boot under any circumstance.
//
// Kill switch: if CODEX_BRIDGE_HOOK_DISABLE includes "session-start",
// the hook short-circuits to {"continue": true} without spawning
// status. Useful for triage when the bridge is in a broken state.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const HOOK_NAME = "session-start";
const STATUS_TIMEOUT_MS = 5000;
const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CODEX_BRIDGE_PLUGIN_DATA";

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

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function appendEnvVar(name, value) {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile || value == null || value === "") return;
  try {
    fs.appendFileSync(envFile, `export ${name}=${shellEscape(value)}\n`);
  } catch {
    // Non-fatal — env-file persistence is best-effort.
  }
}

function resolveBundlePath() {
  // Three install layouts to probe (see broker-lifecycle.mjs for the
  // canonical version of this logic):
  //   plugin/scripts/codex-bridge.mjs (canonical from v2.0)
  //   skill/scripts/codex-bridge.mjs (legacy)
  //   src/codex-bridge.mjs (source-mode, dev only)
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

function fetchStatus(bundlePath, cwd) {
  const result = spawnSync(
    process.execPath,
    [bundlePath, "status", "--json"],
    {
      cwd,
      timeout: STATUS_TIMEOUT_MS,
      encoding: "utf8",
      env: process.env,
    },
  );
  if (result.error || result.status !== 0) {
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function formatContext(envelope) {
  if (!envelope?.ok || !envelope.result) return null;

  const r = envelope.result;
  const lines = ["## Codex-Bridge runtime status (auto-injected)\n"];

  const running = Array.isArray(r.running) ? r.running : [];
  if (running.length > 0) {
    lines.push("### Running jobs (this workspace)");
    for (const job of running.slice(0, 5)) {
      const id = job.jobId ?? job.id ?? "<unknown>";
      const phase = job.phase ?? "running";
      const elapsed = job.elapsedMs
        ? `elapsed=${Math.round(job.elapsedMs / 1000)}s`
        : "";
      lines.push(`- ${id}  phase=${phase}  ${elapsed}`.trim());
    }
    lines.push("");
  }

  const last = r.latestFinished;
  if (last) {
    const verdict = last.verdict ?? last.phase ?? "completed";
    lines.push("### Last finished job");
    lines.push(
      `- ${last.jobId ?? last.id ?? "<unknown>"}  ${verdict}` +
        (last.summary ? `  -- ${last.summary}` : ""),
    );
    lines.push("");
  }

  const caps = r.capabilities;
  if (Array.isArray(caps) && caps.length > 0) {
    lines.push("### Bridge capabilities");
    lines.push(caps.join(", "));
    lines.push("");
  }

  if (running.length === 0 && !last) {
    return null;
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

  // Preserve legacy env-var behavior (matches session-lifecycle-hook.mjs).
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env.CLAUDE_PLUGIN_DATA);

  // Best-effort context injection.
  let additionalContext = null;
  try {
    const bundle = resolveBundlePath();
    if (bundle) {
      const env = fetchStatus(bundle, input.cwd ?? process.cwd());
      if (env) additionalContext = formatContext(env);
    }
  } catch (err) {
    logHookError(err);
  }

  const out = additionalContext
    ? {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext,
        },
      }
    : { continue: true };

  process.stdout.write(JSON.stringify(out));
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
