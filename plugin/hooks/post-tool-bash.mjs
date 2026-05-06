#!/usr/bin/env node
// PostToolUse hook on `Bash` and parent `Agent` calls — when a
// codex-bridge task that returned with a Monitor.tool_hint just
// completed, surface the literal Monitor invocation as additionalContext
// so Claude arms it on the next turn. Removes the "always remember to
// arm the Monitor" rule from SKILL.md and turns it into a deterministic
// auto-arm.
//
// Idempotence: each jobId gets armed at most once per hook surface per
// session — track in ~/.codex-bridge/hook-state/<workspace>/seen-*.txt.
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
const RUNNER_AGENT_TYPES = new Set([
  "codex-bridge:codex-bridge-runner",
  "codex-bridge-runner",
]);
const JOB_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
// Cap the per-(workspace,surface) seen-jobs file so it stays bounded across
// long-lived sessions. We never need to keep more than the most-recent
// armed jobIds — the file exists only to suppress duplicate auto-arm on the
// same envelope being replayed by Claude. Pruning truncates to the most
// recent SEEN_JOBS_TRIM_TO entries when the file exceeds SEEN_JOBS_MAX.
const SEEN_JOBS_MAX = 1000;
const SEEN_JOBS_TRIM_TO = 500;
// Value-consuming flags accepted by `codex-bridge task`. Used to walk the
// argv-after-`task` and stop at the first positional (the prompt) so that
// flags like `--background` mentioned inside the prompt text — even after
// shell quoting has been stripped — cannot be mistaken for real CLI flags.
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
// Allowed flags / value-consuming flags inside the Monitor command after
// `events <jobId>`. Anything else means the hint was tampered with.
const MONITOR_BOOLEAN_FLAGS = new Set(["--follow", "--json"]);
const MONITOR_VALUE_FLAGS = new Set([
  "--exclude",
  "--include",
  "--timeout-ms",
  "--since",
  "--max-events",
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

function readStdinJson() {
  const raw = fs.readFileSync(0, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function workspaceKey(cwd) {
  if (!cwd) return "default";
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function seenJobsFile(cwd, surface) {
  const dir = path.join(os.homedir(), ".codex-bridge", "hook-state", workspaceKey(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `seen-${surface}-jobs.txt`);
}

function isJobAlreadyArmed(cwd, surface, jobId) {
  try {
    const f = seenJobsFile(cwd, surface);
    if (!fs.existsSync(f)) return false;
    const text = fs.readFileSync(f, "utf8");
    return text.split("\n").includes(jobId);
  } catch {
    return false;
  }
}

function markJobArmed(cwd, surface, jobId) {
  try {
    const f = seenJobsFile(cwd, surface);
    fs.appendFileSync(f, `${jobId}\n`);
    pruneSeenJobsFile(f);
  } catch (err) {
    logHookError(err);
  }
}

// Bound the seen-jobs file so it can't grow without limit across long
// sessions. Triggered after every append; only does I/O when over cap.
function pruneSeenJobsFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n").filter((line) => line.length > 0);
    if (lines.length <= SEEN_JOBS_MAX) return;
    const trimmed = lines.slice(-SEEN_JOBS_TRIM_TO).join("\n") + "\n";
    fs.writeFileSync(file, trimmed);
  } catch {
    // Best-effort; file may have just been pruned by a concurrent hook.
  }
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

function bridgeTaskIndex(tokens) {
  let index = 0;
  while (index < tokens.length && isEnvAssignment(tokens[index])) index += 1;
  if (tokens[index] === "command") index += 1;

  if (isNodeToken(tokens[index]) && isBridgeScriptToken(tokens[index + 1]) && tokens[index + 2] === "task") {
    return index + 2;
  }
  if (isBridgeScriptToken(tokens[index]) && tokens[index + 1] === "task") {
    return index + 1;
  }
  return -1;
}

function flagEnabled(tokens, startIndex, flag) {
  // Walk argv after `task`, recognising value-consuming flags so we can
  // stop at the first positional (the prompt). Without this stop, a prompt
  // like "deploy --background" would be tokenised by splitCommandWords
  // into a single token "deploy --background" — but if the prompt token
  // happens to *equal* a flag string, the previous loop would falsely
  // detect it as a real flag. The walk below only inspects tokens that
  // structurally precede the prompt argument.
  for (let i = startIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    // First positional terminates flag scanning.
    if (!token.startsWith("-")) return false;
    if (token === flag) return true;
    if (token.startsWith(`${flag}=`)) {
      const value = token.slice(flag.length + 1).toLowerCase();
      return value !== "false" && value !== "0";
    }
    // Consume the value of a known value-flag without inspecting it as a
    // boolean flag candidate.
    if (TASK_VALUE_FLAGS.has(token)) {
      i += 1;
    }
  }
  return false;
}

function agentType(input) {
  return input.agent_type ?? input.subagent_type ?? input.tool_input?.agent_type ?? input.tool_input?.subagent_type ?? "";
}

function isCodexBridgeTaskInvocation(input) {
  if (RUNNER_AGENT_TYPES.has(agentType(input))) return false;

  const command = input.tool_input?.command;
  if (!command || typeof command !== "string") return false;
  const tokens = splitCommandWords(command);
  const taskIndex = bridgeTaskIndex(tokens);
  if (taskIndex === -1) return false;
  // Only auto-arm for --background; foreground tasks return text inline
  // and don't need a Monitor.
  const isBackground =
    flagEnabled(tokens, taskIndex, "--background") ||
    input.tool_input?.run_in_background === true;
  if (!isBackground) return false;
  // The task must have requested --json so the envelope is parseable.
  if (!flagEnabled(tokens, taskIndex, "--json")) return false;
  return true;
}

function isCodexBridgeAgentInvocation(input) {
  return input.tool_name === "Agent" && RUNNER_AGENT_TYPES.has(input.tool_input?.subagent_type);
}

function extractResponseText(input) {
  const response = input.tool_response;
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return null;
  for (const key of ["stdout", "content", "text", "result", "output"]) {
    if (typeof response[key] === "string") return response[key];
  }
  if (Array.isArray(response.content)) {
    return response.content
      .map((block) => (typeof block === "string" ? block : block?.text))
      .filter((text) => typeof text === "string")
      .join("\n");
  }
  return null;
}

function parseEnvelope(stdout) {
  if (!stdout || typeof stdout !== "string") return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

function hasShellControl(command) {
  // Reject any character that could split the command, spawn a subshell,
  // expand a variable, or comment out trailing safeguards. Newlines and
  // carriage returns count as POSIX command separators when commands are
  // executed through a shell, so they MUST be in this set even though
  // splitCommandWords treats them as whitespace.
  return /[;&|`<>()$#\r\n]/.test(command);
}

function isSafeMonitorCommand(command, jobId) {
  if (!command || typeof command !== "string") return false;
  if (command.length > 1000 || hasShellControl(command)) return false;
  const tokens = splitCommandWords(command);
  let eventsIndex = -1;
  if (isNodeToken(tokens[0]) && isBridgeScriptToken(tokens[1]) && tokens[2] === "events") {
    eventsIndex = 2;
  } else if (isBridgeScriptToken(tokens[0]) && tokens[1] === "events") {
    eventsIndex = 1;
  }
  if (eventsIndex === -1) return false;
  if (tokens[eventsIndex + 1] !== jobId) return false;
  // Strict allowlist after `events <jobId>`. --follow MUST be present and
  // every other token must be either a known boolean flag, a known
  // value-consuming flag (whose value is the immediately-following token),
  // or the value of such a flag. Unknown flags or stray positionals are
  // rejected — this is the structural counterpart to hasShellControl: even
  // if a future regression misses a metacharacter, tampered hints still
  // can't smuggle extra argv tokens into the Monitor invocation.
  const trailing = tokens.slice(eventsIndex + 2);
  if (!trailing.includes("--follow")) return false;
  for (let i = 0; i < trailing.length; i += 1) {
    const token = trailing[i];
    if (MONITOR_BOOLEAN_FLAGS.has(token)) continue;
    if (MONITOR_VALUE_FLAGS.has(token)) {
      const value = trailing[i + 1];
      if (value === undefined || value.startsWith("-")) return false;
      i += 1;
      continue;
    }
    // Allow `--flag=value` shorthand for known value flags.
    const eq = token.indexOf("=");
    if (eq > 2 && token.startsWith("--")) {
      const flagName = token.slice(0, eq);
      if (MONITOR_VALUE_FLAGS.has(flagName)) continue;
    }
    return false;
  }
  return true;
}

function sanitizeMonitorHint(hint, jobId) {
  if (!hint || typeof hint !== "object" || Array.isArray(hint)) return null;
  if (!isSafeMonitorCommand(hint.command, jobId)) return null;
  const timeout = Number.isSafeInteger(hint.timeout_ms) && hint.timeout_ms > 0
    ? Math.min(hint.timeout_ms, 3_600_000)
    : 3_600_000;
  return {
    description: typeof hint.description === "string" && hint.description
      ? hint.description.slice(0, 300)
      : "codex-bridge task events",
    command: hint.command,
    timeout_ms: timeout,
    persistent: hint.persistent === true,
  };
}

function extractMonitorHint(envelope) {
  if (envelope?.ok !== true || envelope?.command !== "task") return null;
  const r = envelope?.result;
  if (!r) return null;
  // The actual task envelope (enqueueBackgroundTask) emits `status`; older
  // call sites used `phase`. Accept either so the guard is not silently
  // inert when the canonical field is present.
  const state = r.status ?? r.phase;
  if (state && !["queued", "running"].includes(state)) return null;
  const jobId = r.jobId ?? r.job_id;
  if (!jobId || typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) return null;
  const monitor = r.monitor ?? r.monitor_hint;
  if (!monitor) return null;
  const hint = sanitizeMonitorHint(monitor.tool_hint ?? monitor, jobId);
  if (!hint) return null;
  return { jobId, hint };
}

function main() {
  if (isDisabled()) {
    process.exit(0);
  }

  let input = {};
  try {
    input = readStdinJson();
  } catch (err) {
    logHookError(err);
    process.stdout.write('{"continue":true}');
    return;
  }

  if (input.tool_name !== "Bash" && input.tool_name !== "Agent") {
    process.stdout.write('{"continue":true}');
    return;
  }

  const surface = input.tool_name === "Agent" ? "agent" : "bash";
  const shouldInspect =
    input.tool_name === "Agent"
      ? isCodexBridgeAgentInvocation(input)
      : isCodexBridgeTaskInvocation(input);
  if (!shouldInspect) {
    process.stdout.write('{"continue":true}');
    return;
  }

  const envelope = parseEnvelope(extractResponseText(input));
  if (!envelope) {
    process.stdout.write('{"continue":true}');
    return;
  }

  const monitor = extractMonitorHint(envelope);
  if (!monitor) {
    process.stdout.write('{"continue":true}');
    return;
  }

  const cwd = input.cwd ?? process.cwd();
  if (isJobAlreadyArmed(cwd, surface, monitor.jobId)) {
    process.stdout.write('{"continue":true}');
    return;
  }

  markJobArmed(cwd, surface, monitor.jobId);

  const block = [
    "## Codex-Bridge: arm the Monitor for this background job",
    "",
    `A background codex-bridge task just dispatched (jobId=${monitor.jobId}). Arm the Monitor tool now with the EXACT payload below — do not modify it. The Monitor will surface progress (CHECKPOINT, PLAN, QUESTION) and self-terminate on [DONE]/[ERROR]/[INCOMPLETE]/[PLAN].`,
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
