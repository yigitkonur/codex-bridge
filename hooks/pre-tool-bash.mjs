#!/usr/bin/env node
// PreToolUse hook on the `Bash` tool for codex-bridge task dispatches.
//
// The runtime guard is authoritative; this hook gives Claude Code an earlier
// denial before it creates a bridge job for common Bash invocations.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const HOOK_NAME = "pre-tool-bash";
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
  "-C",
  "--brief",
  "--backend",
]);
const COMMAND_SEPARATORS = new Set(["&&", "||", ";", "|", "&"]);

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

function splitCommandWords(raw) {
  const tokens = [];
  let current = "";
  let quote = null;

  const pushCurrent = () => {
    if (current) {
      tokens.push(current);
      current = "";
    }
  };

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
      pushCurrent();
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|") {
      pushCurrent();
      if ((ch === "&" || ch === "|") && raw[i + 1] === ch) {
        tokens.push(`${ch}${ch}`);
        i += 1;
      } else {
        tokens.push(ch);
      }
      continue;
    }
    current += ch;
  }

  pushCurrent();
  return tokens;
}

function basenameLooksLikeBridge(token) {
  const base = path.basename(token);
  return base === "codex-bridge" || base === "codex-bridge.mjs";
}

function findBridgeTaskIndex(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "task") continue;
    if (index > 0 && basenameLooksLikeBridge(tokens[index - 1])) return index;
    if (index > 1 && tokens[index - 2] === "node" && basenameLooksLikeBridge(tokens[index - 1])) return index;
  }
  return -1;
}

function normalizeBooleanValue(value) {
  return String(value ?? "").trim().toLowerCase();
}

function booleanFlagEnabled(tokens, taskIndex, flag) {
  for (let i = taskIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (COMMAND_SEPARATORS.has(token)) break;
    if (token === flag) return true;
    if (token.startsWith(`${flag}=`)) {
      return normalizeBooleanValue(token.slice(flag.length + 1)) !== "false";
    }
  }
  return false;
}

function readPromptFile(invocationCwd, value) {
  try {
    return fs.readFileSync(path.resolve(invocationCwd, value), "utf8");
  } catch {
    return "";
  }
}

function collectPromptText(tokens, taskIndex, invocationCwd) {
  const chunks = [];
  for (let i = taskIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (COMMAND_SEPARATORS.has(token)) break;
    if (token === "--") {
      chunks.push(tokens.slice(i + 1).join(" "));
      break;
    }
    if (token.startsWith("--prompt-file=")) {
      chunks.push(readPromptFile(invocationCwd, token.slice("--prompt-file=".length)));
      continue;
    }
    if (token === "--prompt-file") {
      if (tokens[i + 1]) chunks.push(readPromptFile(invocationCwd, tokens[i + 1]));
      i += 1;
      continue;
    }
    const inlineEquals = token.indexOf("=");
    const flagName = inlineEquals === -1 ? token : token.slice(0, inlineEquals);
    if (TASK_VALUE_FLAGS.has(flagName)) {
      if (inlineEquals === -1) i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    chunks.push(token);
  }
  return chunks.join("\n");
}

function resolveInvocationCwd(tokens, taskIndex, fallbackCwd) {
  let cwd = fallbackCwd || process.cwd();
  for (let i = 0; i < taskIndex - 2; i += 1) {
    if (tokens[i] === "cd" && COMMAND_SEPARATORS.has(tokens[i + 2])) {
      cwd = path.resolve(cwd, tokens[i + 1]);
      i += 2;
    }
  }
  for (let i = taskIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (COMMAND_SEPARATORS.has(token)) break;
    if (token.startsWith("--cwd=")) {
      return path.resolve(cwd, token.slice("--cwd=".length));
    }
    if (token === "--cwd" || token === "-C") {
      if (tokens[i + 1]) return path.resolve(cwd, tokens[i + 1]);
      break;
    }
  }
  return cwd;
}

function normalizeAbsolutePathCandidate(raw) {
  let value = String(raw ?? "");
  while (/[),.;:\]]$/.test(value)) value = value.slice(0, -1);
  value = value.replace(/:\d+(?::\d+)?$/, "");
  return path.normalize(value);
}

function uniquePathRoots(paths) {
  const roots = [];
  for (const input of paths) {
    if (!input || !path.isAbsolute(input)) continue;
    const normalized = path.resolve(input);
    roots.push(normalized);
    try {
      const real = fs.realpathSync.native(normalized);
      if (real !== normalized) roots.push(real);
    } catch {
      // Best effort.
    }
  }
  return [...new Set(roots)];
}

function pathIsInsideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

function resolveWorkspaceRoot(cwd) {
  try {
    const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // Fall back below.
  }
  return cwd;
}

function findWorkspaceAbsolutePaths(text, workspaceRoot) {
  const roots = uniquePathRoots([workspaceRoot]);
  if (!text || roots.length === 0) return [];
  const conflicts = new Set();
  const stringText = String(text);
  const candidates = [
    ...stringText.matchAll(ABSOLUTE_PATH_PATTERN),
    ...collectSpaceRootCandidates(stringText, roots),
  ];
  for (const raw of candidates) {
    const candidate = normalizeAbsolutePathCandidate(Array.isArray(raw) ? raw[0] : raw);
    if (roots.some((root) => pathIsInsideRoot(candidate, root))) conflicts.add(candidate);
  }
  return [...conflicts].sort();
}

function classifyCommand(command, fallbackCwd) {
  if (!command || typeof command !== "string") return null;
  if (!BRIDGE_TASK_PATTERN.test(command)) return null;

  const tokens = splitCommandWords(command);
  const taskIndex = findBridgeTaskIndex(tokens);
  if (taskIndex === -1) return null;

  const isWrite = booleanFlagEnabled(tokens, taskIndex, "--write");
  const isReadOnly = booleanFlagEnabled(tokens, taskIndex, "--read-only");
  const hasWorktreeAuto = booleanFlagEnabled(tokens, taskIndex, "--worktree-auto");
  if (isWrite && isReadOnly) return { decision: "conflict" };
  if (!isWrite) return { decision: "pass-through" };
  if (!hasWorktreeAuto) return { decision: "rewrite-needed" };

  const invocationCwd = resolveInvocationCwd(tokens, taskIndex, fallbackCwd);
  const promptText = collectPromptText(tokens, taskIndex, invocationCwd);
  const workspaceRoot = resolveWorkspaceRoot(invocationCwd);
  const conflicts = findWorkspaceAbsolutePaths(promptText, workspaceRoot);
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

function outputDeny(permissionDecisionReason, additionalContext = null) {
  const hookSpecificOutput = {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason,
  };
  if (additionalContext) hookSpecificOutput.additionalContext = additionalContext;
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

function main() {
  if (isDisabled() || isWorktreeOptOut()) {
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
  const classification = classifyCommand(command, input.tool_input?.cwd);
  if (!classification || classification.decision === "pass-through") {
    process.stdout.write('{"continue":true}');
    return;
  }

  if (classification.decision === "conflict") {
    outputDeny("codex-bridge task: --write and --read-only are mutually exclusive. Choose one and re-run.");
    return;
  }

  if (classification.decision === "absolute-path-conflict") {
    outputDeny(
      "codex-bridge task --worktree-auto prompt contains absolute workspace paths that would bypass the isolated task worktree.",
      [
        "## Codex-Bridge: absolute path rejected",
        "",
        `Launch workspace: ${classification.workspaceRoot}`,
        "Conflicting paths:",
        ...classification.conflicts.map((entry) => `- ${entry}`),
        "",
        "Use repo-relative paths in the prompt before dispatching with --worktree-auto.",
      ].join("\n"),
    );
    return;
  }

  const suggested = buildRewriteSuggestion(command);
  outputDeny(
    "codex-bridge task --write requires worktree isolation. Re-run with --worktree-auto so changes land in <repo>/../.codex-bridge-worktrees/<task_id> instead of the main checkout.",
    [
      "## Codex-Bridge: rewrite required",
      "Suggested invocation:",
      "",
      "```bash",
      suggested,
      "```",
      "",
      "The bridge will allocate a worktree at <repo>/../.codex-bridge-worktrees/<task_id> on a fresh `subagent/codex/<task_id>` branch and capture the base SHA in meta.json.",
      "",
      "Set `CODEX_BRIDGE_DISABLE_WORKTREE_AUTO=1` to opt out for this session if you're managing isolation yourself.",
    ].join("\n"),
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
