import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { upsertJob } from "../src/lib/state.mjs";

const bridgePath = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));

// Field-report P2-09: pin the behavior of `--exclude HEARTBEAT`.
// Heartbeats are multi-line blocks (header + indented continuation lines).
// The filter must drop the whole block, not just the header.
test("events --exclude HEARTBEAT drops both header and continuation lines", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-exclude-heartbeat-"));
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  const sessionDir = path.join(root, "sessions");
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;

  process.env.CODEX_BRIDGE_PLUGIN_DATA = pluginData;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "config.yaml"),
      `session_dir: ${JSON.stringify(sessionDir)}\n`,
      "utf8"
    );

    const job = {
      id: "task-exclude-heartbeat",
      sessionId: "test-session",
      jobClass: "task",
      status: "completed",
      phase: "done",
      threadId: "thread-exclude-heartbeat",
      createdAt: "2026-04-29T12:00:00.000Z",
      updatedAt: "2026-04-29T12:01:00.000Z",
      completedAt: "2026-04-29T12:01:00.000Z"
    };
    upsertJob(workspace, job);

    // Mix heartbeats with non-heartbeat events. Heartbeats are multi-line:
    // header + indented continuation lines. Bridge filter must inherit the
    // header's drop decision through the continuation lines (otherwise the
    // body would leak through with the header silently absent).
    const eventsContent = [
      `[DIRECTIVES] ${job.threadId} | mode=default | effort=high`,
      `[HEARTBEAT] ${job.threadId} t=1m02s | phase=execute | pid=12345`,
      "  lastItem: agentMessage (age 33s)",
      "  tail: working on dentist site",
      `[PIPELINE:diff] 06:51:33`,
      `[PIPELINE:diff:done] 06:51:33 0 files | +0 -0`,
      `[HEARTBEAT] ${job.threadId} t=2m02s | phase=execute | pid=12345`,
      "  lastItem: commandExecution (age 1s)",
      `[DONE] ${job.threadId} completed in 4s | 1 files | +2 -0`
    ].join("\n") + "\n";

    fs.writeFileSync(path.join(sessionDir, `${job.threadId}.events`), eventsContent, "utf8");

    const env = {
      ...process.env,
      CODEX_BRIDGE_PLUGIN_DATA: pluginData,
      CODEX_BRIDGE_NO_UPDATE_CHECK: "1"
    };
    delete env.CLAUDE_PLUGIN_DATA;

    const result = spawnSync(
      process.execPath,
      [bridgePath, "events", job.id, "--exclude", "HEARTBEAT", "--cwd", workspace],
      { cwd: workspace, env, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);

    // Hard guarantees the field report asked us to lock in.
    assert.doesNotMatch(result.stdout, /\[HEARTBEAT\]/, "heartbeat header should be filtered out");
    assert.doesNotMatch(result.stdout, /lastItem: agentMessage/, "heartbeat continuation must inherit drop");
    assert.doesNotMatch(result.stdout, /lastItem: commandExecution/, "second heartbeat continuation must inherit drop");
    assert.doesNotMatch(result.stdout, /tail: working on dentist site/, "heartbeat tail body must inherit drop");

    // Non-heartbeat tags survive.
    assert.match(result.stdout, /\[DIRECTIVES\]/);
    assert.match(result.stdout, /\[PIPELINE:diff\]/);
    assert.match(result.stdout, /\[PIPELINE:diff:done\]/);
    assert.match(result.stdout, /\[DONE\]/);
  } finally {
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

// Companion: the documented Monitor preset excludes heartbeat, directives,
// and verbose checkpoint body while preserving concise checkpoint summaries.
test("events with default monitor exclude preserves checkpoint summary but drops runtime echoes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-exclude-heartbeat-vocab-"));
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  const sessionDir = path.join(root, "sessions");
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;

  process.env.CODEX_BRIDGE_PLUGIN_DATA = pluginData;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "config.yaml"),
      `session_dir: ${JSON.stringify(sessionDir)}\n`,
      "utf8"
    );

    const job = {
      id: "task-vocab",
      sessionId: "test-session",
      jobClass: "task",
      status: "completed",
      phase: "done",
      threadId: "thread-vocab",
      createdAt: "2026-04-29T12:00:00.000Z",
      updatedAt: "2026-04-29T12:01:00.000Z",
      completedAt: "2026-04-29T12:01:00.000Z"
    };
    upsertJob(workspace, job);

    const tid = job.threadId;
    const lines = [
      `[DIRECTIVES] ${tid} | mode=default`,
      `[HEARTBEAT] ${tid} t=1m | phase=execute | pid=1`,
      "  noisy: should not appear",
      `[CHECKPOINT_SUMMARY] ${tid} t=5m | phase=execute | tools=1 (rg:1) | last="rg src"`,
      `[CHECKPOINT] ${tid} t=5m | phase=execute`,
      "  assistant: verbose body should not appear",
      `[PIPELINE:review] 06:55:00`,
      `[PIPELINE:review:done] 06:55:30 verdict=approved findings=0`,
      `[PIPELINE:check:done] 06:55:35 complete=false missing=2 missing_items=["a","b"]`,
      `[STALL_WARNING] ${tid} t=10m | phase=execute | no actionable progress for 1 checkpoint`,
      `[WARNING] ${tid} circuit-breaker fired`,
      `[INCOMPLETE] ${tid} | 0 files | +0 -0`,
    ].join("\n") + "\n";

    fs.writeFileSync(path.join(sessionDir, `${tid}.events`), lines, "utf8");

    const env = {
      ...process.env,
      CODEX_BRIDGE_PLUGIN_DATA: pluginData,
      CODEX_BRIDGE_NO_UPDATE_CHECK: "1"
    };
    delete env.CLAUDE_PLUGIN_DATA;

    const result = spawnSync(
      process.execPath,
      [bridgePath, "events", job.id, "--exclude", "HEARTBEAT,CHECKPOINT", "--cwd", workspace],
      { cwd: workspace, env, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);

    // Standard MDN escapeRegExp — matches every regex metachar including ]
    // and \. Earlier inline form had a malformed character class (missing ]
    // as a member, doubled trailing backslash) that happened to work for our
    // test data but would mis-escape any tag containing brackets/backslashes.
    const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const tag of ["DIRECTIVES", "CHECKPOINT_SUMMARY", "PIPELINE:review", "PIPELINE:review:done", "PIPELINE:check:done", "STALL_WARNING", "WARNING", "INCOMPLETE"]) {
      assert.match(result.stdout, new RegExp(`\\[${escapeRegExp(tag)}\\]`), `${tag} should pass through`);
    }
    assert.doesNotMatch(result.stdout, /\[DIRECTIVES\]/);
    assert.doesNotMatch(result.stdout, /\[HEARTBEAT\]/);
    assert.doesNotMatch(result.stdout, /\[CHECKPOINT\]/);
    assert.doesNotMatch(result.stdout, /noisy: should not appear/);
    assert.doesNotMatch(result.stdout, /verbose body should not appear/);

    // Confirm the new check-stage payload survives the filter intact (P1-04).
    assert.match(result.stdout, /missing_items=\[/);
  } finally {
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
