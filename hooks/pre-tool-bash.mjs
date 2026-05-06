#!/usr/bin/env node
// PreToolUse hook on `Bash` for codex-bridge task dispatches.
//
// Pre-approves the bundled bridge task invocation after safety gates pass.
// This covers thin runner subagents whose only Bash call is the bridge script,
// without granting arbitrary Bash or arbitrary codex-bridge-looking paths.
//
// Guards worktree-isolation footguns before a bridge job is created:
//   1. `task --write` defaults to worktree isolation, so bare write tasks are
//      checked as isolated runs.
//   2. Isolated write prompts must not name absolute paths inside the launch
//      workspace, which would resolve back to the main checkout.
//
// Opt-out: --worktree-auto=false or CODEX_BRIDGE_DISABLE_WORKTREE_AUTO=1 falls
// back to Claude's normal Bash permission flow instead of plugin auto-approval.
//
// Kill switch: CODEX_BRIDGE_HOOK_DISABLE=pre-tool-bash (or =all).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const HOOK_NAME = "pre-tool-bash";
const PLUGIN_ROOT_TOKEN = "${CLAUDE_PLUGIN_ROOT}";
const BUNDLED_SCRIPT_PATH = "scripts/codex-bridge.mjs";
const BRIDGE_TASK_PATTERN =
  /(?:^|[\s;&|])(?:node\s+)?["']?(?:[^\s"'`]*\bcodex-bridge(?:\.mjs)?)["']?\s+task\b/;
const ABSOLUTE_PATH_PATTERN = /\/[^\s'"`<>]+/g;
const TASK_VALUE_FLAGS = new Set([
  "--mode",
  "--effort",
  "-m",
  "--model",
  "--prompt-file",
  "--idle-timeout-ms",
  "--turn-plan-ms",
  "--turn-default-ms",
  "--pipeline-stage-timeout-ms",
  "--pipeline-total-timeout-ms",
  "--question-timeout-ms",
  "--intercepted-from",
  "--cwd",
  "--brief",
  "--backend",
  "--base-ref",
  "--on-branch",
]);

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

function configTextEnforcesSandbox(text) {
  if (!text) return null;
  const flat = text.match(/^\s*(?:sandbox_enforce|enforce_sandbox)\s*:\s*(true|false)\s*(?:#.*)?$/m);
  if (flat) return flat[1] === "true";
  const sandboxBlock = text.match(/^\s*sandbox\s*:\s*(?:#.*)?\n((?:\s{2,}[^\n]*\n?)*)/m);
  const nested = sandboxBlock?.[1]?.match(/^\s+enforce\s*:\s*(true|false)\s*(?:#.*)?$/m);
  return nested ? nested[1] === "true" : null;
}

function fileEnforcesSandbox(file) {
  try {
    return configTextEnforcesSandbox(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function sandboxEnforced(cwd) {
  const base = cwd ? path.resolve(cwd) : process.cwd();
  const workspaceRoot = findGitRepoRoot(base);
  const candidates = [
    path.join(workspaceRoot, "config.yaml"),
    path.join(workspaceRoot, ".claude", "codex-bridge.local.md"),
    path.join(base, "config.yaml"),
    path.join(base, ".claude", "codex-bridge.local.md"),
  ];
  let enforced = false;
  for (const file of [...new Set(candidates)]) {
    const value = fileEnforcesSandbox(file);
    if (value !== null) enforced = value;
  }
  return enforced;
}

function readStdinJson() {
  const raw = fs.readFileSync(0, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function splitCommandWords(raw) {
  const tokens = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "\\" && i + 1 < raw.length) {
        current += raw[i + 1];
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < raw.length) {
      current += raw[i + 1];
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function stripQuotedSegments(command) {
  if (typeof command !== "string" || command.length === 0) return command;
  let out = "";
  let quote = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "\\" && i + 1 < command.length) i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

function hasUnsafeShellSyntax(command) {
  return /[$][(]|[`]/.test(command) || /[;&|<>\r\n]/.test(stripQuotedSegments(command));
}

function isEnvAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function isNodeToken(token) {
  if (!token) return false;
  const base = path.basename(token).toLowerCase();
  return base === "node" || base === "node.exe";
}

function isBridgeScriptToken(token) {
  if (!token) return false;
  const base = path.basename(token);
  return base === "codex-bridge.mjs" || base === "codex-bridge";
}

function isShellSeparator(token) {
  return token === "&&" || token === "||" || token === ";";
}

function segmentStarts(tokens) {
  const starts = [0];
  for (let index = 0; index < tokens.length; index += 1) {
    if (isShellSeparator(tokens[index]) && index + 1 < tokens.length) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function bridgeInvocationFrom(tokens, startIndex) {
  let index = startIndex;
  while (index < tokens.length && isEnvAssignment(tokens[index])) index += 1;
  if (tokens[index] === "command") index += 1;

  if (isNodeToken(tokens[index]) && isBridgeScriptToken(tokens[index + 1]) && tokens[index + 2] === "task") {
    return { taskIndex: index + 2, scriptToken: tokens[index + 1], viaNode: true };
  }
  if (isBridgeScriptToken(tokens[index]) && tokens[index + 1] === "task") {
    return { taskIndex: index + 1, scriptToken: tokens[index], viaNode: false };
  }
  return null;
}

function bridgeInvocation(tokens) {
  for (const start of segmentStarts(tokens)) {
    const invocation = bridgeInvocationFrom(tokens, start);
    if (invocation) return invocation;
  }
  return null;
}

function bridgeTaskIndex(tokens) {
  return bridgeInvocation(tokens)?.taskIndex ?? -1;
}

function tokenMatchesBundledBridgeScript(token) {
  if (!token) return false;
  const normalized = token.replaceAll("\\", "/");
  if (normalized === `${PLUGIN_ROOT_TOKEN}/${BUNDLED_SCRIPT_PATH}`) return true;

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  return Boolean(
    pluginRoot &&
      path.isAbsolute(token) &&
      path.resolve(token) === path.resolve(pluginRoot, BUNDLED_SCRIPT_PATH),
  );
}

function isAutoApprovableBridgeTask(input) {
  const command = input.tool_input?.command;
  if (!command || typeof command !== "string") return false;
  if (hasUnsafeShellSyntax(command)) return false;

  const tokens = splitCommandWords(command);
  const invocation = bridgeInvocationFrom(tokens, 0);
  return Boolean(
    invocation?.viaNode &&
      invocation.taskIndex === 2 &&
      tokenMatchesBundledBridgeScript(invocation.scriptToken),
  );
}

function continueOrAllowBundledBridgeTask(input) {
  if (!isAutoApprovableBridgeTask(input)) return { continue: true };
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason:
        "codex-bridge bundled task invocation auto-approved after bridge safety gates passed.",
    },
  };
}

function isValueFlagToken(token) {
  const key = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
  return TASK_VALUE_FLAGS.has(key);
}

function inlineValue(token, flag) {
  return token.startsWith(`${flag}=`) ? token.slice(flag.length + 1) : null;
}

function booleanFlagEnabled(tokens, taskIndex, flag) {
  return booleanFlagValue(tokens, taskIndex, flag) === true;
}

function booleanFlagValue(tokens, taskIndex, flag) {
  const noFlag = `--no-${flag.slice(2)}`;
  for (let i = taskIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") break;
    if (token === flag) return true;
    if (token === noFlag) return false;
    const value = inlineValue(token, flag);
    if (value !== null) {
      const normalized = value.toLowerCase();
      return normalized !== "false";
    }
    if (inlineValue(token, noFlag) !== null) {
      return false;
    }
    if (isValueFlagToken(token) && !token.includes("=")) {
      i += 1;
    }
  }
  return null;
}

function flagValue(tokens, taskIndex, flag) {
  for (let i = taskIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") return null;
    const value = inlineValue(token, flag);
    if (value !== null) return value;
    if (token === flag) return tokens[i + 1] ?? null;
    if (isValueFlagToken(token) && !token.includes("=")) {
      i += 1;
    }
  }
  return null;
}

function readPromptFile(cwd, rawFile) {
  if (!rawFile) return "";
  try {
    return fs.readFileSync(path.resolve(cwd, rawFile), "utf8");
  } catch {
    return "";
  }
}

function collectPromptText(tokens, taskIndex, cwd) {
  const parts = [];
  for (let i = taskIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") {
      parts.push(...tokens.slice(i + 1));
      break;
    }
    // Stop at pipe — anything after a bare pipe is a shell command, not a Codex prompt argument.
    if (token === "|") break;
    const promptFileInline = inlineValue(token, "--prompt-file");
    if (promptFileInline !== null) {
      parts.push(readPromptFile(cwd, promptFileInline));
      continue;
    }
    if (token === "--prompt-file") {
      parts.push(readPromptFile(cwd, tokens[i + 1]));
      i += 1;
      continue;
    }
    if (isValueFlagToken(token)) {
      if (!token.includes("=")) i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    parts.push(token);
  }
  return parts.filter(Boolean).join("\n");
}

function resolveInvocationCwd(input, tokens, taskIndex) {
  const base = input.cwd ? path.resolve(input.cwd) : process.cwd();
  const cwdFlag = flagValue(tokens, taskIndex, "--cwd");
  if (cwdFlag) return path.resolve(base, cwdFlag);

  const separatorIndex = tokens.findIndex((token, index) => index < taskIndex && isShellSeparator(token));
  if (separatorIndex >= 0) {
    let start = 0;
    while (start < separatorIndex && isEnvAssignment(tokens[start])) start += 1;
    if (tokens[start] === "command") start += 1;
    if (tokens[start] === "cd" && tokens[start + 1] && start + 2 === separatorIndex) {
      return path.resolve(base, tokens[start + 1]);
    }
  }
  return base;
}

function findGitRepoRoot(cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status === 0 && result.stdout.trim()) {
    return path.resolve(result.stdout.trim());
  }
  return path.resolve(cwd);
}

function normalizeAbsolutePathCandidate(candidate) {
  let text = String(candidate ?? "").trim();
  while (/[),.;!?]$/.test(text)) {
    text = text.slice(0, -1);
  }
  const lineRef = text.match(/^(.+):\d+(?::\d+)?$/);
  if (lineRef) {
    text = lineRef[1];
  }
  return text;
}

function uniquePathRoots(roots) {
  const out = [];
  for (const root of roots) {
    if (typeof root !== "string" || !root.trim()) continue;
    const resolved = path.resolve(root);
    if (!out.includes(resolved)) out.push(resolved);
    try {
      const real = fs.realpathSync.native(resolved);
      if (!out.includes(real)) out.push(real);
    } catch {
      // Best-effort alias.
    }
  }
  return out;
}

function pathIsInsideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function collectSpaceRootCandidates(text, roots) {
  const candidates = [];
  for (const root of roots) {
    if (!/\s/.test(root)) continue;
    let start = text.indexOf(root);
    while (start !== -1) {
      const next = text[start + root.length];
      if (!next || next === path.sep || /[\s),.;:\]]/.test(next)) {
        let end = start + root.length;
        while (end < text.length && !/[\s'"`<>]/.test(text[end])) end += 1;
        candidates.push(text.slice(start, end));
      }
      start = text.indexOf(root, start + 1);
    }
  }
  return candidates;
}

function findWorkspaceAbsolutePathConflicts(promptText, workspaceRoot, aliases = []) {
  const roots = uniquePathRoots([workspaceRoot, ...aliases]);
  const text = String(promptText ?? "");
  const conflicts = [];
  const seen = new Set();
  const addConflict = (candidate) => {
    if (!seen.has(candidate)) { seen.add(candidate); conflicts.push(candidate); }
  };
  for (const match of text.matchAll(ABSOLUTE_PATH_PATTERN)) {
    const candidate = normalizeAbsolutePathCandidate(match[0]);
    if (!path.isAbsolute(candidate)) continue;
    const resolved = path.resolve(candidate);
    if (roots.some((root) => pathIsInsideRoot(resolved, root))) addConflict(candidate);
  }
  // For workspace roots containing spaces, the regex stops at the space;
  // use string search to catch the full path.
  for (const candidate of collectSpaceRootCandidates(text, roots)) {
    const normalized = normalizeAbsolutePathCandidate(candidate);
    if (roots.some((root) => pathIsInsideRoot(normalized, root))) addConflict(normalized);
  }
  return conflicts;
}

function classifyCommand(input) {
  const command = input.tool_input?.command;
  if (!command || typeof command !== "string") return null;
  if (!BRIDGE_TASK_PATTERN.test(command)) return null;

  const tokens = splitCommandWords(command);
  const taskIndex = bridgeTaskIndex(tokens);
  if (taskIndex === -1) return null;

  const isWrite = booleanFlagEnabled(tokens, taskIndex, "--write");
  const isReadOnly = booleanFlagEnabled(tokens, taskIndex, "--read-only");
  const worktreeAutoValue = booleanFlagValue(tokens, taskIndex, "--worktree-auto");
  const cwd = resolveInvocationCwd(input, tokens, taskIndex);

  if (isWrite && isReadOnly) {
    return { decision: "conflict" };
  }
  if (isReadOnly && sandboxEnforced(cwd)) {
    return { decision: "sandbox-read-only-denied" };
  }
  if (!isWrite) {
    return { decision: "pass-through" };
  }
  // Worktree isolation is required for write tasks. Accept only when the
  // flag is explicitly enabled (--worktree-auto or --worktree-auto=true).
  // When the env opt-out is active, fall back to Claude's normal Bash
  // permission flow (manual-permission). Otherwise deny with a suggestion.
  if (worktreeAutoValue !== true) {
    if (isWorktreeOptOut()) {
      return { decision: "manual-permission" };
    }
    return { decision: "worktree-required", command };
  }

  const workspaceRoot = findGitRepoRoot(cwd);
  const promptText = collectPromptText(tokens, taskIndex, cwd);
  const conflicts = findWorkspaceAbsolutePathConflicts(promptText, workspaceRoot, [cwd]);
  if (conflicts.length > 0) {
    return { decision: "absolute-path-conflict", conflicts, workspaceRoot };
  }
  return { decision: "pass-through" };
}

function buildRewriteSuggestion(command) {
  const m = BRIDGE_TASK_PATTERN.exec(command);
  if (!m) return command;
  const insertAt = m.index + m[0].length;
  return `${command.slice(0, insertAt)} --worktree-auto${command.slice(insertAt)}`;
}

function denyWorktreeRequired(command) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "codex-bridge task --write requires worktree isolation. Add --worktree-auto to run in an isolated worktree.",
      additionalContext: buildRewriteSuggestion(command),
    },
  };
}

function denyConflict() {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "codex-bridge task: --write and --read-only are mutually exclusive. Choose one and re-run.",
    },
  };
}

function denySandboxReadOnly() {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "sandbox.enforce: true (workspace policy). --read-only is forbidden. Re-run with --write or omit the flag.",
      additionalContext:
        "To opt out, set codex_bridge.sandbox_enforce: false in config.yaml or remove sandbox.enforce: true from .claude/codex-bridge.local.md.",
    },
  };
}

function denyAbsolutePathConflict(classification) {
  const listed = classification.conflicts.slice(0, 8).map((p) => `  - ${p}`).join("\n");
  const more = classification.conflicts.length > 8
    ? `\n  ...and ${classification.conflicts.length - 8} more`
    : "";
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "codex-bridge task --worktree-auto prompt contains absolute workspace paths that would write to the main checkout instead of the isolated worktree.",
      additionalContext: [
        "## Codex-Bridge: worktree path rewrite required",
        "",
        "This dispatch uses `--worktree-auto`, but the prompt contains absolute paths inside the launch workspace:",
        `${listed}${more}`,
        "",
        `Workspace: ${classification.workspaceRoot}`,
        "",
        "Use repo-relative paths in the prompt before dispatching. If you intentionally want to target the main checkout, pass `--no-worktree-auto`.",
      ].join("\n"),
    },
  };
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

  const classification = classifyCommand(input);
  if (!classification || classification.decision === "pass-through") {
    process.stdout.write(JSON.stringify(continueOrAllowBundledBridgeTask(input)));
    return;
  }

  if (classification.decision === "manual-permission") {
    process.stdout.write('{"continue":true}');
    return;
  }

  if (classification.decision === "worktree-required") {
    process.stdout.write(JSON.stringify(denyWorktreeRequired(classification.command)));
    return;
  }

  if (classification.decision === "conflict") {
    process.stdout.write(JSON.stringify(denyConflict()));
    return;
  }

  if (classification.decision === "sandbox-read-only-denied") {
    process.stdout.write(JSON.stringify(denySandboxReadOnly()));
    return;
  }

  if (classification.decision === "absolute-path-conflict") {
    process.stdout.write(JSON.stringify(denyAbsolutePathConflict(classification)));
    return;
  }

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
