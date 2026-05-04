#!/usr/bin/env node
// SubagentStop hook for codex-bridge plugin.
//
// When a Claude Code subagent finishes its turn, this hook checks
// whether the subagent was one of the codex-bridge agents (the runner
// from T10, the future reviewer from T21). If so, it surfaces the last
// terminal event from the bridge's artifact registry into the parent
// transcript as additionalContext, so the parent thread sees
// [DONE: ...] / [ERROR: ...] / [INCOMPLETE: ...] / [PLAN: ...] without having to
// run /codex-bridge:result.
//
// In v2.0.0 the artifact registry lands in T15. Until then, this hook
// is a no-op for codex-bridge subagents unless it can correlate the
// subagent's output to a bridge job id. The structure ships now so the
// registration is in place; the behavior activates as T15 wires the
// events.jsonl writer.
//
// Failure mode: any error logs to ~/.codex-bridge/hook-errors and the
// hook emits {"continue": true}.
//
// Kill switch: CODEX_BRIDGE_HOOK_DISABLE=subagent-stop (or =all).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  currentSessionId,
  jobMatchesHookContext,
  readJobMetadata,
  resolveHookCwd,
  resolveJobsDir,
  resolveWorkspaceRoot,
} from "./hook-state.mjs";

const HOOK_NAME = "subagent-stop";
const BRIDGE_AGENT_TYPES = new Set([
  "codex-bridge:codex-bridge-runner",
  "codex-bridge:codex-bridge-reviewer",
]);
const TERMINAL_TAG_PATTERN = /\[(?:DONE|ERROR|INCOMPLETE|PLAN)[^\]]*\]/;
const JOB_ID_PATTERN = /\b(?:task|review)-[a-z0-9]+-[a-z0-9]+\b/i;
const JOB_ID_PATTERN_GLOBAL = /\b(?:task|review)-[a-z0-9]+-[a-z0-9]+\b/gi;

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

function extractJobId(value, { latest = false } = {}) {
  if (value == null) return null;
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (latest) {
    let lastMatch = null;
    JOB_ID_PATTERN_GLOBAL.lastIndex = 0;
    let m;
    while ((m = JOB_ID_PATTERN_GLOBAL.exec(text)) !== null) {
      lastMatch = m[0];
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
      // Latest match wins: a transcript may reference an earlier task id
      // before mentioning the one the subagent actually just finished.
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

function findTerminalTagForJob(input, jobId) {
  const cwd = resolveHookCwd(input);
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
      const m = TERMINAL_TAG_PATTERN.exec(lines[i]);
      if (m) return { taskId: jobId, tag: m[0], rawLine: lines[i] };
    }
  } catch (err) {
    if (err?.code !== "ENOENT") logHookError(err);
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

  const agentType = input.agent_type ?? "";
  if (!BRIDGE_AGENT_TYPES.has(agentType)) {
    process.stdout.write('{"continue":true}');
    return;
  }

  let block = null;
  try {
    const jobId = resolveJobId(input);
    const terminal = jobId ? findTerminalTagForJob(input, jobId) : null;
    if (terminal) {
      block = `## Codex-Bridge subagent finished (${agentType})\nTask ${terminal.taskId} -> ${terminal.tag}\nFull output: \`/codex-bridge:result ${terminal.taskId}\``;
    }
  } catch (err) {
    logHookError(err);
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
