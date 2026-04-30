#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
// Mirrors src/lib/state.mjs — kept inline so the cheap legacy-intent probe
// (see hasLegacyStopReviewGateIntent) can read state.json without spawning
// the bundled bridge. Update both files in lockstep if the layout changes.
const BRIDGE_PLUGIN_DATA_ENV = "CODEX_BRIDGE_PLUGIN_DATA";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";

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

// Read the last assistant turn out of Claude Code's transcript JSONL. Stop-hook
// payload shape (per Claude Code docs) is `{ session_id, transcript_path, cwd,
// reason, stop_hook_active }` — there is NO `last_assistant_message` field, so
// the review must hydrate the transcript itself or it asks Codex to ALLOW/BLOCK
// an unspecified previous turn. Best-effort: any read/parse failure falls back
// to an empty string and we log a stderr warning so the operator knows the
// review prompt was un-grounded for this turn.
//
// Transcript format: each line is one JSON record. Records carrying a final
// assistant turn look like `{type:"assistant", message:{role:"assistant",
// content:[{type:"text", text:"..."}, ...]}}`. We only want the most recent
// such record (so we ignore mid-session assistant tool-use turns prior to it
// — those still appear, but the LAST one is the user-facing final answer
// that triggered Stop). Content blocks other than `text` (tool_use,
// thinking, etc.) are skipped; we only join the `text` blocks.
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
  // `last_assistant_message` is NOT a Claude Code Stop-hook payload field. We
  // keep the (defensive) read for any future shape change but the real source
  // is `transcript_path` — see extractLastAssistantText.
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

// Resolve the workspace's state.json path the same way src/lib/state.mjs
// does, without importing bridge code (this hook ships separately and
// must stay zero-dep on the bundle for the cheap path). Returns null when
// we can't resolve a workspace root — in that case there's no state file
// to read, so callers should treat it as "no legacy intent".
function resolveStateFilePath(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: 5000
  });
  const workspaceRoot =
    result.status === 0 && typeof result.stdout === "string" && result.stdout.trim()
      ? result.stdout.trim()
      : cwd;
  if (!workspaceRoot) return null;

  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[BRIDGE_PLUGIN_DATA_ENV] || process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`, STATE_FILE_NAME);
}

// Cheap, best-effort probe for "this workspace previously enabled the
// stop-time review gate via the legacy boolean-only setup". Reads
// state.json directly. Returns true ONLY when the file exists AND
// `config.stopReviewGate === true`. Anything else (no file, parse error,
// missing config, false) means there is nothing to migrate, so the
// hook's caller can skip the expensive `setup --json` spawn.
function hasLegacyStopReviewGateIntent(cwd) {
  const stateFile = resolveStateFilePath(cwd);
  if (!stateFile) return false;
  if (!fs.existsSync(stateFile)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return parsed?.config?.stopReviewGate === true;
  } catch {
    return false;
  }
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
//
// Cheap path: the vast majority of Stop-hook invocations land in
// workspaces that never enabled the gate (the documented disabled
// default). We short-circuit those by reading state.json directly first
// — no `setup --json` spawn, no Codex availability/auth probe, no
// app-server contact. We only fall through to the full setup probe when
// state.json actually carries `config.stopReviewGate: true`, which is
// the genuine legacy → migration case.
function maybeMigrateLegacyGate(cwd, input, activation) {
  if (activation.active) return activation;
  if (!hasLegacyStopReviewGateIntent(cwd)) return activation;
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
  //
  // The prompt is written to a tempfile and forwarded via `--prompt-file`
  // because Unix argv has a hard cap (~256 KiB on macOS, ~2 MiB on Linux).
  // The Stop-hook prompt embeds the previous assistant turn extracted from
  // `transcript_path` — when that turn contains generated code or long
  // logs, passing the prompt as a single spawnSync argv item could fail
  // with E2BIG before Codex even runs and leave the gate blocking. Bounding
  // the size by the filesystem instead of argv removes that failure mode.
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
      // Best-effort cleanup; tmpdir entries are reaped by the OS. We
      // never want a cleanup error to mask the real review outcome.
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
