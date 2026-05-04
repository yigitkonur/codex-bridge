import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { upsertJob } from "../src/lib/state.mjs";

const bridgePath = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));

test("events --json emits one JSON envelope without raw event text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-events-json-"));
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
      id: "task-json-events",
      sessionId: "test-session",
      jobClass: "task",
      status: "completed",
      phase: "done",
      threadId: "thread-json-events",
      createdAt: "2026-04-29T12:00:00.000Z",
      updatedAt: "2026-04-29T12:01:00.000Z",
      completedAt: "2026-04-29T12:01:00.000Z"
    };
    upsertJob(workspace, job);
    fs.writeFileSync(
      path.join(sessionDir, `${job.threadId}.events`),
      [
        `[CHECKPOINT] ${job.threadId} t=1s | phase=running`,
        "  assistant: working",
        `[DONE] ${job.threadId} | duration=2s`
      ].join("\n") + "\n",
      "utf8"
    );

    const env = {
      ...process.env,
      CODEX_BRIDGE_PLUGIN_DATA: pluginData,
      CODEX_BRIDGE_NO_UPDATE_CHECK: "1"
    };
    delete env.CLAUDE_PLUGIN_DATA;

    const result = spawnSync(
      process.execPath,
      [bridgePath, "events", job.id, "--json", "--cwd", workspace],
      { cwd: workspace, env, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trimStart().startsWith("{"), true, result.stdout);
    assert.doesNotMatch(result.stdout, /\[(CHECKPOINT|DONE)\]/);

    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, "events");
    assert.equal(envelope.result.jobId, job.id);
    assert.equal(envelope.result.threadId, job.threadId);
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

test("events --follow treats PLAN as terminal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-plan-follow-"));
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
    fs.writeFileSync(path.join(workspace, "config.yaml"), `session_dir: ${JSON.stringify(sessionDir)}\n`, "utf8");

    const job = {
      id: "task-plan-events",
      sessionId: "test-session",
      jobClass: "task",
      status: "running",
      phase: "plan-pending",
      threadId: "thread-plan-events",
      createdAt: "2026-04-29T12:00:00.000Z",
      updatedAt: "2026-04-29T12:01:00.000Z"
    };
    upsertJob(workspace, job);
    fs.writeFileSync(
      path.join(sessionDir, `${job.threadId}.events`),
      `[PLAN] ${job.threadId} turn-1\n  approve: node bridge send\n`,
      "utf8"
    );

    const env = {
      ...process.env,
      CODEX_BRIDGE_PLUGIN_DATA: pluginData,
      CODEX_BRIDGE_NO_UPDATE_CHECK: "1"
    };
    delete env.CLAUDE_PLUGIN_DATA;

    const result = spawnSync(
      process.execPath,
      [bridgePath, "events", job.id, "--json", "--follow", "--timeout-ms", "1000", "--cwd", workspace],
      { cwd: workspace, env, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result.followed, true);
    assert.equal(envelope.result.timedOut, undefined);
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
