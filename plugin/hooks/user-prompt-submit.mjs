#!/usr/bin/env node
// UserPromptSubmit hook for codex-bridge plugin.
//
// Two responsibilities, both forward-looking:
//
// 1. Rewake-signal delivery: scan the bridge state directory for the
//    current cwd/session, then atomically claim matching
//    jobs/<task_id>/rewake.signal files written by long-running
//    background tasks (the asyncRewake-equivalent pattern that T22
//    wires up). Prepend a brief "while you were away" block to
//    additionalContext so the orchestrator sees the completion before
//    its next reasoning step.
//
// 2. Resume-intent detection: match the user prompt against patterns
//    like /^(continue|keep going|resume|that codex one)/i. If matched
//    AND a recent codex-bridge thread exists for this workspace, emit
//    additionalContext suggesting `/codex-bridge:task --resume-last
//    <prompt>`. Helps the orchestrator route follow-ups without the
//    user having to type the slash command.
//
// Both responsibilities are no-ops in v2.0.0 until T15 lands the
// artifact registry (jobs/) and T22 wires the rewake-signal write path.
// The hook ships now so the registration is in place; the behavior
// activates as the dependencies land.
//
// Failure mode: any error logs to ~/.codex-bridge/hook-errors and the
// hook emits {"continue": true} — UserPromptSubmit on a clean exit
// always allows the prompt through unless we explicitly block.
//
// Kill switch: CODEX_BRIDGE_HOOK_DISABLE=user-prompt-submit (or =all).

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

const HOOK_NAME = "user-prompt-submit";
const RESUME_INTENT_PATTERN =
  /^\s*(continue|keep going|resume|continue codex|that codex one|dig deeper)\b/i;

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

function claimRewakeSignal(signalPath) {
  const claimedPath = `${signalPath}.claimed-${process.pid}-${Date.now()}`;
  fs.renameSync(signalPath, claimedPath);
  return claimedPath;
}

function consumePendingRewakeSignals(input) {
  const cwd = resolveHookCwd(input);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = currentSessionId(input);
  const root = resolveJobsDir(cwd);
  if (!fs.existsSync(root)) return [];
  const messages = [];
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const signalPath = path.join(root, entry, "rewake.signal");
    if (!fs.existsSync(signalPath)) continue;
    const job = readJobMetadata(root, entry);
    if (!jobMatchesHookContext(job, { workspaceRoot, sessionId })) continue;
    try {
      const claimedPath = claimRewakeSignal(signalPath);
      const text = fs.readFileSync(claimedPath, "utf8").trim();
      if (text) messages.push(`- ${entry}: ${text}`);
    } catch (err) {
      logHookError(err);
    }
  }
  return messages;
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

  const blocks = [];

  // 1. Rewake-signal delivery.
  try {
    const messages = consumePendingRewakeSignals(input);
    if (messages.length > 0) {
      blocks.push(
        ["## Codex-Bridge: while you were away", ...messages].join("\n"),
      );
    }
  } catch (err) {
    logHookError(err);
  }

  // 2. Resume-intent detection.
  // The actual "recent thread for this workspace" check requires the
  // artifact registry (T15). For now we only emit the suggestion when
  // the prompt clearly matches resume intent; the orchestrator can
  // verify a recent thread exists before acting.
  try {
    const prompt = (input.prompt ?? input.user_prompt ?? "").trim();
    if (RESUME_INTENT_PATTERN.test(prompt)) {
      blocks.push(
        [
          "## Codex-Bridge: resume-intent detected",
          'If a recent codex-bridge thread exists for this workspace, consider routing this as `/codex-bridge:task --resume-last "<prompt>"` rather than starting a fresh dispatch.',
        ].join("\n"),
      );
    }
  } catch (err) {
    logHookError(err);
  }

  if (blocks.length === 0) {
    process.stdout.write('{"continue":true}');
    return;
  }

  process.stdout.write(
    JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: blocks.join("\n\n"),
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
