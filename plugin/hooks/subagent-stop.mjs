#!/usr/bin/env node
// SubagentStop hook for codex-bridge plugin.
//
// When a Claude Code subagent finishes its turn, this hook checks
// whether the subagent was one of the codex-bridge agents (the runner
// from T10, the future reviewer from T21). If so, it surfaces the last
// terminal event from the bridge's artifact registry into the parent
// transcript as additionalContext, so the parent thread sees
// [DONE: ...] / [ERROR: ...] / [INCOMPLETE: ...] without having to
// run /codex-bridge:result.
//
// In v2.0.0 the artifact registry lands in T15. Until then, this hook
// is a no-op for codex-bridge subagents (it can't read events that
// don't exist yet). The structure ships now so the registration is in
// place; the behavior activates as T15 wires the events.jsonl writer.
//
// Failure mode: any error logs to ~/.codex-bridge/hook-errors and the
// hook emits {"continue": true}.
//
// Kill switch: CODEX_BRIDGE_HOOK_DISABLE=subagent-stop (or =all).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const HOOK_NAME = "subagent-stop";
const BRIDGE_AGENT_TYPES = new Set([
  "codex-bridge:codex-bridge-runner",
  "codex-bridge:codex-bridge-reviewer",
]);
const TERMINAL_TAG_PATTERN = /\[(?:DONE|ERROR|INCOMPLETE)[^\]]*\]/;

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

function findLatestTerminalTag() {
  // The artifact registry layout (T15) places one events.jsonl per task
  // at ~/.codex-bridge/jobs/<task_id>/events.jsonl. Without a task_id
  // in the SubagentStop input, the best we can do is scan for the most
  // recently-modified events.jsonl and extract its last terminal tag.
  const jobsRoot = path.join(os.homedir(), ".codex-bridge", "jobs");
  if (!fs.existsSync(jobsRoot)) return null;
  let entries;
  try {
    entries = fs.readdirSync(jobsRoot);
  } catch {
    return null;
  }
  let bestPath = null;
  let bestMtime = 0;
  for (const entry of entries) {
    const eventsPath = path.join(jobsRoot, entry, "events.jsonl");
    try {
      const stat = fs.statSync(eventsPath);
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        bestPath = eventsPath;
      }
    } catch {
      // Skip missing/unreadable.
    }
  }
  if (!bestPath) return null;
  try {
    const text = fs.readFileSync(bestPath, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = TERMINAL_TAG_PATTERN.exec(lines[i]);
      if (m) {
        const taskId = path.basename(path.dirname(bestPath));
        return { taskId, tag: m[0], rawLine: lines[i] };
      }
    }
  } catch (err) {
    logHookError(err);
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
    const terminal = findLatestTerminalTag();
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
