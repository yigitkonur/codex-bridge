#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const REVIEW_GATE_LOCK_FILE = ".codex-bridge-stop-review-gate.lock";
const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.resolve(SCRIPT_DIR, "..", "scripts", "codex-bridge.mjs");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function runBridge(cwd, input, args, options = {}) {
  return spawnSync(process.execPath, [BRIDGE_SCRIPT, ...args], {
    cwd,
    env: {
      ...process.env,
      ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
    },
    encoding: "utf8",
    timeout: options.timeoutMs ?? 15000
  });
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function stderrLine(message) {
  if (message) process.stderr.write(`${message}\n`);
}

function emitBlock(reason) {
  process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
}

function resolveProjectRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: 5000
  });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : cwd;
}

function reviewGateActivation(cwd) {
  const projectRoot = resolveProjectRoot(cwd);
  const lockPath = path.join(projectRoot, REVIEW_GATE_LOCK_FILE);
  if (fs.existsSync(lockPath)) {
    return { active: true, lockPath };
  }

  return { active: false, lockPath };
}

function runningJobNote(cwd, input) {
  const result = runBridge(cwd, input, ["status", "--json"], { timeoutMs: 10000 });
  const payload = parseJson(result.stdout);
  const running = Array.isArray(payload?.result?.running) ? payload.result.running : [];
  if (running.length === 0) return null;
  const first = running[0];
  return `Codex Bridge job ${first.id ?? "unknown"} is still running. Check /codex-bridge:status and use /codex-bridge:cancel ${first.id ?? ""} if you want to stop it before ending the session.`;
}

function extractLastAssistantText(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") return "";
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch (error) {
    stderrLine(
      `codex-bridge stop hook: could not read transcript_path (${transcriptPath}): ${
        error instanceof Error ? error.message : String(error)
      }. Review will run without prior-turn grounding.`
    );
    return "";
  }

  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "assistant") continue;
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    const texts = [];
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      }
    }
    const joined = texts.join("\n").trim();
    if (joined) return joined;
  }

  stderrLine(
    `codex-bridge stop hook: transcript_path (${transcriptPath}) had no readable assistant turn. Review will run without prior-turn grounding.`
  );
  return "";
}

function buildStopReviewPrompt(input) {
  const fromPayload = String(input.last_assistant_message ?? "").trim();
  const fromTranscript = fromPayload || extractLastAssistantText(input?.transcript_path);
  const claudeResponseBlock = fromTranscript
    ? `\n\n<previous_assistant_message>\n${fromTranscript}\n</previous_assistant_message>`
    : "";
  return `${STOP_REVIEW_TASK_MARKER}

You are reviewing Claude Code's just-finished response before the session stops.
Return exactly one first line:
ALLOW: <short reason>
BLOCK: <short reason>

Block only for concrete correctness, safety, or verification issues that Claude should address before stopping. Do not block for style preferences, optional follow-ups, or broad improvement ideas.${claudeResponseBlock}`;
}

function parseStopReview(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason: "The stop-time Codex Bridge review returned no final output. Run /codex-bridge:review --wait manually or disable the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) return { ok: true, reason: null };
  if (firstLine.startsWith("BLOCK:")) {
    return {
      ok: false,
      reason: firstLine.slice("BLOCK:".length).trim() || text
    };
  }

  return {
    ok: false,
    reason: "The stop-time Codex Bridge review returned an unexpected answer. Run /codex-bridge:review --wait manually or disable the gate."
  };
}

function main() {
  const input = readHookInput();
  if (input.stop_hook_active === true) {
    return;
  }

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const runningNote = runningJobNote(cwd, input);
  const activation = reviewGateActivation(cwd);

  if (!activation.active) {
    stderrLine(runningNote);
    return;
  }

  const setup = runBridge(cwd, input, ["setup", "--json"], { timeoutMs: 15000 });
  const setupPayload = parseJson(setup.stdout);

  if (!setupPayload?.ok) {
    stderrLine(runningNote);
    return;
  }

  if (setupPayload.result?.reviewGateEnabled !== true) {
    if (setupPayload.result?.reviewGateLockIgnored) {
      stderrLine(
        `Codex Bridge stop-time review gate lock is present but ignored: ${
          setupPayload.result?.reviewGateSuppressionReason ?? "review-gate-suppressed"
        }.`
      );
    }
    stderrLine(runningNote);
    return;
  }

  if (!setupPayload.result?.ready) {
    stderrLine(`Codex Bridge stop-time review gate is enabled (${activation.lockPath}), but Codex is not ready. Run /codex-bridge:setup.`);
    stderrLine(runningNote);
    return;
  }

  const promptFile = path.join(
    os.tmpdir(),
    `codex-bridge-stop-review-${randomBytes(16).toString("hex")}.prompt.md`
  );
  let review;
  try {
    fs.writeFileSync(promptFile, buildStopReviewPrompt(input), { encoding: "utf8", mode: 0o600 });
    review = runBridge(
      cwd,
      input,
      ["task", "--json", "--mode", "default", "--read-only", "--no-pipeline", "--prompt-file", promptFile],
      { timeoutMs: STOP_REVIEW_TIMEOUT_MS }
    );
  } finally {
    try {
      fs.rmSync(promptFile, { force: true });
    } catch {
      // Best-effort cleanup; tmpdir entries are reaped by the OS.
    }
  }

  if (review.error?.code === "ETIMEDOUT") {
    emitBlock("The stop-time Codex Bridge review timed out after 15 minutes. Run /codex-bridge:review --wait manually or disable the gate.");
    return;
  }

  if (review.status !== 0) {
    const detail = String(review.stderr || review.stdout || "").trim();
    emitBlock(detail ? `The stop-time Codex Bridge review failed: ${detail}` : "The stop-time Codex Bridge review failed.");
    return;
  }

  const reviewPayload = parseJson(review.stdout);
  const parsed = parseStopReview(reviewPayload?.result?.rawOutput);
  if (!parsed.ok) {
    emitBlock(runningNote ? `${runningNote} ${parsed.reason}` : parsed.reason);
    return;
  }

  stderrLine(runningNote);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
