#!/usr/bin/env node
// PostToolUse hook on the `Bash` tool — when a codex-bridge task that
// returned with a Monitor.tool_hint just completed, surface the literal
// Monitor invocation as additionalContext so Claude arms it on the
// next turn. Removes the "always remember to arm the Monitor" rule
// from SKILL.md and turns it into a deterministic auto-arm.
//
// Idempotence: each jobId gets armed at most once per session — track
// in ~/.codex-bridge/hook-state/<workspace>/seen-jobs.txt.
//
// Failure mode: any error logs to ~/.codex-bridge/hook-errors and the
// hook exits 0 with no additionalContext. PostToolUse hooks can't
// block, so we just degrade gracefully.
//
// Kill switch: CODEX_BRIDGE_HOOK_DISABLE=post-tool-bash (or =all).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

const HOOK_NAME = "post-tool-bash";

const BRIDGE_TASK_PATTERN =
  /(?:^|[\s;&|])(?:node\s+)?["']?(?:[^\s"'`]*\bcodex-bridge(?:\.mjs)?)["']?\s+task\b/;

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

function workspaceKey(cwd) {
  if (!cwd) return "default";
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function seenJobsFile(cwd) {
  const dir = path.join(os.homedir(), ".codex-bridge", "hook-state", workspaceKey(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "seen-jobs.txt");
}

function isJobAlreadyArmed(cwd, jobId) {
  try {
    const f = seenJobsFile(cwd);
    if (!fs.existsSync(f)) return false;
    const text = fs.readFileSync(f, "utf8");
    return text.split("\n").includes(jobId);
  } catch {
    return false;
  }
}

function markJobArmed(cwd, jobId) {
  try {
    const f = seenJobsFile(cwd);
    fs.appendFileSync(f, `${jobId}\n`);
  } catch (err) {
    logHookError(err);
  }
}

function isCodexBridgeTaskInvocation(input) {
  const command = input.tool_input?.command;
  if (!command || typeof command !== "string") return false;
  if (!BRIDGE_TASK_PATTERN.test(command)) return false;
  // Only auto-arm for --background; foreground tasks return text inline
  // and don't need a Monitor.
  const isBackground =
    /(?:^|\s)--background(?:\s|$)/.test(command) ||
    input.tool_input?.run_in_background === true;
  if (!isBackground) return false;
  // The task must have requested --json so the envelope is parseable.
  if (!/(?:^|\s)--json(?:\s|$)/.test(command)) return false;
  return true;
}

function parseEnvelope(stdout) {
  if (!stdout || typeof stdout !== "string") return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

function extractMonitorHint(envelope) {
  const r = envelope?.result;
  if (!r) return null;
  const phase = r.phase;
  if (phase && !["queued", "running"].includes(phase)) return null;
  const jobId = r.jobId ?? r.job_id;
  if (!jobId) return null;
  const monitor = r.monitor ?? r.monitor_hint;
  if (!monitor) return null;
  return { jobId, hint: monitor.tool_hint ?? monitor };
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

  if (input.tool_name !== "Bash") {
    process.stdout.write('{"continue":true}');
    return;
  }

  if (!isCodexBridgeTaskInvocation(input)) {
    process.stdout.write('{"continue":true}');
    return;
  }

  const envelope = parseEnvelope(input.tool_response?.stdout);
  if (!envelope || envelope.ok === false) {
    process.stdout.write('{"continue":true}');
    return;
  }

  const monitor = extractMonitorHint(envelope);
  if (!monitor) {
    process.stdout.write('{"continue":true}');
    return;
  }

  const cwd = input.cwd ?? process.cwd();
  if (isJobAlreadyArmed(cwd, monitor.jobId)) {
    process.stdout.write('{"continue":true}');
    return;
  }

  markJobArmed(cwd, monitor.jobId);

  const block = [
    "## Codex-Bridge: arm the Monitor for this background job",
    "",
    `A background codex-bridge task just dispatched (jobId=${monitor.jobId}). Arm the Monitor tool now with the EXACT payload below — do not modify it. The Monitor will surface progress (CHECKPOINT, PLAN, QUESTION) and self-terminate on [DONE]/[ERROR]/[INCOMPLETE].`,
    "",
    "Monitor input:",
    JSON.stringify(monitor.hint, null, 2),
  ].join("\n");

  process.stdout.write(
    JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: block,
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
