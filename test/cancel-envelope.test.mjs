import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { upsertJob } from "../src/lib/state.mjs";

const bridgePath = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));

function spawnSacrificialChild() {
  // Long-running, ignores SIGTERM nothing fancy — just stays alive long
  // enough for `cancel` to hit it. setInterval keeps the event loop busy;
  // the parent will SIGTERM us via terminateProcessTree.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000);"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

function ensureChildKilled(child) {
  if (!child || child.killed) return;
  try {
    process.kill(child.pid, "SIGKILL");
  } catch {
    // Already gone — fine.
  }
}

// Field-report P1-10 / P2-08: cancel envelope normalization.
// Asserts the documented field shape so future refactors don't quietly drop
// `cancelled`, `processTerminated`, `reason`, `warnings`, or the kind-derived
// `title` that replaces the dispatch-time "Codex Resume" / "Codex Task" label.
test("cancel emits a normalized envelope with explicit step booleans", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-cancel-envelope-"));
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  const sessionDir = path.join(root, "sessions");
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;

  process.env.CODEX_BRIDGE_PLUGIN_DATA = pluginData;
  delete process.env.CLAUDE_PLUGIN_DATA;

  let child = null;
  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "config.yaml"),
      `session_dir: ${JSON.stringify(sessionDir)}\n`,
      "utf8"
    );

    // Spawn a sacrificial alive process so resolveCancelableJob can see this
    // job as "running" instead of being reaped to "orphaned" on load. The
    // cancel handler will SIGTERM this pid via terminateProcessTree.
    child = spawnSacrificialChild();
    const job = {
      id: "task-cancel-envelope",
      sessionId: "test-session",
      jobClass: "task",
      kindLabel: "task",
      title: "Codex Resume", // simulates a --resume-last dispatch label
      status: "running",
      phase: "running",
      pid: child.pid,
      threadId: "thread-cancel-envelope",
      backend: "codex",
      createdAt: "2026-04-29T12:00:00.000Z",
      updatedAt: "2026-04-29T12:01:00.000Z",
    };
    upsertJob(workspace, job);

    const env = {
      ...process.env,
      CODEX_BRIDGE_PLUGIN_DATA: pluginData,
      CODEX_BRIDGE_NO_UPDATE_CHECK: "1"
    };
    delete env.CLAUDE_PLUGIN_DATA;

    const result = spawnSync(
      process.execPath,
      [bridgePath, "cancel", job.id, "--json", "--cwd", workspace],
      { cwd: workspace, env, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, "cancel");

    const r = envelope.result;
    assert.equal(r.jobId, job.id);
    assert.equal(r.status, "cancelled");
    assert.equal(r.cancelled, true, "cancelled bool must be present");
    assert.equal(r.processTerminated, true, "live pid → SIGTERM delivered");
    assert.equal(typeof r.turnInterruptAttempted, "boolean");
    assert.equal(typeof r.turnInterrupted, "boolean");
    assert.equal(r.reason, "cancelled-by-user");
    assert.ok(Array.isArray(r.warnings), "warnings must be an array");

    // Title normalization: dispatch-time "Codex Resume" must not leak into the
    // user-facing title; envelope reports the kind-derived label and stashes
    // the original under dispatchTitle for forensic continuity.
    assert.equal(r.title, "Codex Task", `title should be derived from kindLabel="task", got ${r.title}`);
    assert.equal(r.dispatchTitle, "Codex Resume");
    assert.equal(r.kindLabel, "task");

    // Recovery details still carry the granular interrupt + terminate fields.
    assert.ok(r.recovery && typeof r.recovery === "object");
    assert.ok(r.recovery.details && typeof r.recovery.details === "object");
    assert.equal(typeof r.recovery.details.terminateAttempted, "boolean");
    assert.equal(typeof r.recovery.details.terminateDelivered, "boolean");
  } finally {
    ensureChildKilled(child);
    if (previousBridgePluginData == null) {
      delete process.env.CODEX_BRIDGE_PLUGIN_DATA;
    } else {
      process.env.CODEX_BRIDGE_PLUGIN_DATA = previousBridgePluginData;
    }
    if (previousClaudePluginData == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousClaudePluginData;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
