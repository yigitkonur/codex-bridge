#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const REVIEW_GATE_LOCK_FILE = ".codex-bridge-stop-review-gate.lock";
const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.resolve(SCRIPT_DIR, "..", "skill", "scripts", "codex-bridge.mjs");

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
    return { active: true, source: "lock-file", lockPath };
  }

  return { active: false, source: "disabled", lockPath };
}

function runningJobNote(cwd, input) {
  const result = runBridge(cwd, input, ["status", "--json"], { timeoutMs: 10000 });
  const payload = parseJson(result.stdout);
  const running = Array.isArray(payload?.result?.running) ? payload.result.running : [];
  if (running.length === 0) return null;
  const first = running[0];
  return `Codex Bridge job ${first.id ?? "unknown"} is still running. Check /codex-bridge:status and use /codex-bridge:cancel ${first.id ?? ""} if you want to stop it before ending the session.`;
}

function buildStopReviewPrompt(input) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const claudeResponseBlock = lastAssistantMessage
    ? `\n\nPrevious Claude response:\n${lastAssistantMessage}`
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

// Self-migrate workspaces that enabled the gate before lock-file activation
// landed: `setup --enable-review-gate` used to persist only
// `config.stopReviewGate: true` in state.json, but this branch made the
// hook gate on the project-root lock file. Without migration the hook
// would return at the activation check below and silently disable an
// already-enabled gate on upgrade. We mint the lock inline here when
// setup reports legacy intent and no on-disk lock, then re-evaluate so
// the rest of the hook proceeds with the migrated state. Suppressed-by-
// official-plugin workspaces are honored — we don't create a lock the
// bridge would refuse to honor anyway.
function maybeMigrateLegacyGate(cwd, input, activation) {
  if (activation.active) return activation;
  const probe = runBridge(cwd, input, ["setup", "--json"], { timeoutMs: 15000 });
  const probePayload = parseJson(probe.stdout);
  const result = probePayload?.result;
  if (!probePayload?.ok || !result) return activation;
  if (result.stopReviewGateConfig !== true) return activation;
  if (result.reviewGateSuppressedByOfficialPlugin === true) return activation;
  if (result.reviewGateLockExists === true) return activation;

  try {
    fs.mkdirSync(path.dirname(activation.lockPath), { recursive: true });
    const payload = {
      enabledAt: new Date().toISOString(),
      enabledBy: "codex-bridge-stop-hook-legacy-migration"
    };
    fs.writeFileSync(activation.lockPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // Lock-write failure is non-fatal: the next setup --json call will
    // surface the gate as inactive and the hook returns inert. The user
    // can rerun `codex-bridge setup --enable-review-gate` to retry.
    return activation;
  }

  return reviewGateActivation(cwd);
}

function main() {
  const input = readHookInput();
  if (input.stop_hook_active === true) {
    return;
  }

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const runningNote = runningJobNote(cwd, input);
  let activation = reviewGateActivation(cwd);
  activation = maybeMigrateLegacyGate(cwd, input, activation);

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

  // `--read-only` forces the gate-time review onto a read-only sandbox even
  // when the workspace `config.sandbox_policy` is `danger-full-access`. The
  // Stop hook only ALLOWs/BLOCKs the previous Claude turn — it must not
  // mutate the repo at session shutdown. Without `--read-only`, omitting
  // `--write` is insufficient because `buildSandboxPolicy` still honors the
  // config override (see src/lib/config.mjs::buildSandboxPolicy).
  const review = runBridge(
    cwd,
    input,
    ["task", "--json", "--mode", "default", "--read-only", "--no-pipeline", buildStopReviewPrompt(input)],
    { timeoutMs: STOP_REVIEW_TIMEOUT_MS }
  );

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
