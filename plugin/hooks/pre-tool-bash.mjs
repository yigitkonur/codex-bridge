#!/usr/bin/env node
// PreToolUse hook on the `Bash` tool — auto-rejects codex-bridge
// `task --write` invocations that omit --worktree-auto, suggesting
// a rewrite. Prevents half-baked diffs from landing in the user's
// main checkout when an orchestrator forgets the isolation flag.
//
// The hook is opt-out, not opt-in: the canonical write-mode workflow
// requires worktree isolation, and the failure mode of skipping it
// (touching the user's main branch with worker-generated changes) is
// expensive enough that we'd rather force a re-run with the right
// flag than allow a lazy bypass.
//
// Opt-out: CODEX_BRIDGE_DISABLE_WORKTREE_AUTO=1 lets `task --write`
// without --worktree-auto pass through. Useful for users who run
// codex-bridge inside an existing worktree they manage themselves.
//
// Kill switch: CODEX_BRIDGE_HOOK_DISABLE=pre-tool-bash (or =all).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const HOOK_NAME = "pre-tool-bash";

// Match codex-bridge task invocations:
//   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task ...
//   node "/abs/path/to/codex-bridge.mjs" task ...
//   codex-bridge task ...
// Order is roughly: optional `node`, optional quoted path containing
// codex-bridge.mjs OR the bare `codex-bridge` binary, then `task`.
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

function isWorktreeOptOut() {
  const v = process.env.CODEX_BRIDGE_DISABLE_WORKTREE_AUTO;
  return v === "1" || v === "true" || v === "yes";
}

function readStdinJson() {
  const raw = fs.readFileSync(0, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function unquoteInlineValue(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

// Detect enabled boolean flags using the same important convention as the
// bridge parser: --flag=false is false; bare --flag and other inline values
// are enabled. This is intentionally not a full shell parser.
function booleanFlagEnabled(command, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\s)${escaped}(?:=([^\\s]+)|\\s|$)`, "g");
  let match;
  while ((match = re.exec(command)) !== null) {
    const inlineValue = match[1];
    if (inlineValue === undefined) return true;
    if (unquoteInlineValue(inlineValue).toLowerCase() === "false") continue;
    return true;
  }
  return false;
}

function classifyCommand(command) {
  if (!command || typeof command !== "string") return null;
  if (!BRIDGE_TASK_PATTERN.test(command)) return null;

  const isWrite = booleanFlagEnabled(command, "--write");
  const isReadOnly = booleanFlagEnabled(command, "--read-only");
  const hasWorktreeAuto = booleanFlagEnabled(command, "--worktree-auto");

  if (isWrite && isReadOnly) {
    return { decision: "conflict" };
  }
  if (!isWrite) {
    // Read-only or default tasks don't need a worktree.
    return { decision: "pass-through" };
  }
  if (hasWorktreeAuto) {
    return { decision: "pass-through" };
  }
  return { decision: "rewrite-needed" };
}

function buildRewriteSuggestion(command) {
  // Insert --worktree-auto right after `task`. Best-effort string surgery.
  const insertion = " --worktree-auto";
  return command.replace(/\btask\b/, `task${insertion}`);
}

function main() {
  if (isDisabled()) {
    process.stdout.write('{"continue":true}');
    return;
  }
  if (isWorktreeOptOut()) {
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

  const command = input.tool_input?.command;
  const classification = classifyCommand(command);
  if (!classification || classification.decision === "pass-through") {
    process.stdout.write('{"continue":true}');
    return;
  }

  if (classification.decision === "conflict") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "codex-bridge task: --write and --read-only are mutually exclusive. Choose one and re-run.",
        },
      }),
    );
    return;
  }

  // rewrite-needed: deny with suggestion in additionalContext.
  const suggested = buildRewriteSuggestion(command);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "codex-bridge task --write requires worktree isolation. Re-run with --worktree-auto so changes land in <repo>/../.codex-bridge-worktrees/<task_id> instead of the main checkout.",
        additionalContext: [
          "## Codex-Bridge: rewrite required",
          "Suggested invocation:",
          "",
          `\`\`\`bash`,
          suggested,
          `\`\`\``,
          "",
          "The bridge will allocate a worktree at <repo>/../.codex-bridge-worktrees/<task_id> on a fresh `subagent/codex/<task_id>` branch and capture the base SHA in meta.json.",
          "",
          "Set `CODEX_BRIDGE_DISABLE_WORKTREE_AUTO=1` to opt out for this session if you're managing isolation yourself.",
        ].join("\n"),
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
