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
// 2. Plan-mode keyword detection: match the user prompt against patterns
//    like "plan mode", "plan first", "planla", "plana", "planlama" (Turkish),
//    or "think hard" and remind the orchestrator that codex-bridge task
//    dispatch defaults to plan mode.
//
// 3. Resume-intent detection: match the user prompt against patterns
//    like /^(continue|keep going|resume|that codex one)/i. If matched,
//    emit additionalContext suggesting `iterate <task_id>` for task
//    worktree follow-up, or `task --resume-last` only for thread-only
//    conversational continuation.
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
  /^\s*(continue codex|that codex one|keep going|dig deeper|continue|resume)\b/i;
const PLAN_MODE_KEYWORD_PATTERN =
  /\b(plan mode|planning mode|plan first|plan me|make a plan|draft a plan|planlama|planla|plana|do not (?:code|implement|edit|change) yet|don't (?:code|implement|edit|change) yet|think hard|think deeply|think through|ultrathink)\b/i;

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
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    // Skip symlinks so a corrupted or hostile state directory cannot
    // redirect the unlink/rename below to an arbitrary path outside
    // the jobs root.
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const signalPath = path.join(root, entry.name, "rewake.signal");
    let signalLstat;
    try {
      signalLstat = fs.lstatSync(signalPath);
    } catch {
      continue;
    }
    if (!signalLstat.isFile()) continue;
    const job = readJobMetadata(root, entry.name);
    if (!jobMatchesHookContext(job, { workspaceRoot, sessionId })) continue;
    let claimedPath = null;
    try {
      claimedPath = claimRewakeSignal(signalPath);
      const text = fs.readFileSync(claimedPath, "utf8").trim();
      if (text) messages.push(`- ${entry.name}: ${text}`);
    } catch (err) {
      logHookError(err);
    }
    // Note: we intentionally leave the .claimed-* file in place as an
    // audit breadcrumb that the signal was consumed by this hook (and
    // by which pid). Cleanup is the registry writer's responsibility
    // when it lands in T15/T22.
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

  // 2. Plan-mode keyword detection.
  try {
    const prompt = (input.prompt ?? input.user_prompt ?? "").trim();
    if (PLAN_MODE_KEYWORD_PATTERN.test(prompt)) {
      blocks.push(
        [
          "## Codex-Bridge: plan-mode keyword detected",
          "The user prompt asks for planning-first behavior. If delegating to codex-bridge, keep the task in plan mode (`/codex-bridge:task --mode plan ...`, or omit `--mode` because plan mode is the default) and do not switch to `--mode default` until the plan is approved.",
        ].join("\n"),
      );
    }
  } catch (err) {
    logHookError(err);
  }

  // 3. Resume-intent detection.
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
          'If a recent codex-bridge task exists for this workspace, use `/codex-bridge:iterate <task_id>` for follow-up fixes that must preserve worktree state. Use `/codex-bridge:task --resume-last "<prompt>"` only for thread-only continuation with no new auto-worktree.',
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
