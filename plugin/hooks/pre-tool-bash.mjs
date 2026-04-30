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

// Strip shell-quoted segments (single + double quotes) before flag
// detection so a prompt argument like `"Fix the --worktree-auto check"`
// cannot impersonate a real CLI flag and bypass the safety gate. Each
// stripped segment is replaced with a single space so adjacent tokens
// stay separated. Single quotes are taken literally per POSIX; double
// quotes honor backslash-escapes for the closing quote. Unterminated
// quoted segments are stripped to end-of-string — the safe direction
// of failure here is "deny" (treat the rest as opaque), not "allow".
function stripQuotedSegments(command) {
  if (typeof command !== "string" || command.length === 0) return command;
  let out = "";
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) {
        out += " ";
        break;
      }
      out += " ";
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (command[j] === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (command[j] === '"') {
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) {
        out += " ";
        break;
      }
      out += " ";
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
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

  // Detect flags only on the unquoted portion of the command so prompt
  // arguments like `"add --worktree-auto"` cannot impersonate real CLI
  // flags and silently bypass the worktree-isolation gate.
  const scannable = stripQuotedSegments(command);

  const isWrite = booleanFlagEnabled(scannable, "--write");
  const isReadOnly = booleanFlagEnabled(scannable, "--read-only");
  const hasWorktreeAuto = booleanFlagEnabled(scannable, "--worktree-auto");

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
  // Insert --worktree-auto right after the `task` subcommand of the
  // matched codex-bridge invocation. Anchor on BRIDGE_TASK_PATTERN so we
  // don't corrupt unrelated occurrences of "task" inside file paths
  // (e.g. `node /opt/task-runner/codex-bridge.mjs task --write ...`).
  const m = BRIDGE_TASK_PATTERN.exec(command);
  if (!m) return command;
  const insertAt = m.index + m[0].length;
  return `${command.slice(0, insertAt)} --worktree-auto${command.slice(insertAt)}`;
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
