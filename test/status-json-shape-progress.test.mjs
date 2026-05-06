import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { upsertJob, writeJobFile } from "../src/lib/state.mjs";

const bridgePath = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));

function makeFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, "config.yaml"), `session_dir: ${JSON.stringify(sessionDir)}\n`, "utf8");
  return { root, workspace, pluginData, sessionDir };
}

function writeJob(fixture, job) {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CODEX_BRIDGE_PLUGIN_DATA = fixture.pluginData;
  delete process.env.CLAUDE_PLUGIN_DATA;
  const record = {
    jobClass: "task",
    createdAt: "2026-05-06T12:00:00.000Z",
    updatedAt: "2026-05-06T12:00:00.000Z",
    ...job,
  };
  try {
    writeJobFile(fixture.workspace, record.id, record);
    upsertJob(fixture.workspace, record);
    if (job.events) {
      fs.writeFileSync(path.join(fixture.sessionDir, `${record.threadId}.events`), job.events, "utf8");
    }
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
  }
  return record;
}

function runBridge(fixture, args, env = {}) {
  return spawnSync(process.execPath, [bridgePath, ...args, "--cwd", fixture.workspace], {
    cwd: fixture.workspace,
    env: {
      ...process.env,
      CODEX_BRIDGE_PLUGIN_DATA: fixture.pluginData,
      CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
      ...env,
      CLAUDE_PLUGIN_DATA: "",
    },
    encoding: "utf8",
  });
}

test("status --all --json exposes jobs array and active progress", () => {
  const fixture = makeFixture("codex-bridge-status-json-progress-");
  try {
    const logFile = path.join(fixture.root, "running.log");
    fs.writeFileSync(
      logFile,
      [
        "[2026-05-06T12:00:00.000Z] Starting Focus task.",
        "[2026-05-06T12:00:10.000Z] Running command: npm test",
        "[2026-05-06T12:00:20.000Z] Applying 2 file change(s).",
        "[2026-05-06T12:00:30.000Z] File changes completed.",
        "",
      ].join("\n"),
      "utf8",
    );

    writeJob(fixture, {
      id: "task-current-running",
      sessionId: "session-a",
      status: "running",
      phase: "editing",
      pid: process.pid,
      threadId: "thread-current-running",
      startedAt: "2026-05-06T12:00:00.000Z",
      updatedAt: "2026-05-06T12:00:30.000Z",
      logFile,
      events: "[HEARTBEAT] thread-current-running alive\n[CHECKPOINT] thread-current-running working\n",
    });
    writeJob(fixture, {
      id: "task-other-running",
      sessionId: "session-b",
      status: "running",
      phase: "running",
      pid: process.pid,
      threadId: "thread-other-running",
      updatedAt: "2026-05-06T12:00:40.000Z",
    });

    const result = runBridge(fixture, ["status", "--all", "--session", "session-a", "--json"]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.command, "status");
    assert.ok(!Object.hasOwn(envelope.result, "job"));
    assert.ok(Array.isArray(envelope.result.jobs));
    assert.deepEqual(envelope.result.jobs.map((job) => job.id), ["task-current-running"]);
    assert.equal(envelope.result.jobs[0].status, "running");
    assert.ok(!Object.hasOwn(envelope.result.jobs[0], "state"));
    assert.equal(envelope.result.as_of, envelope.result.summary.as_of);
    assert.equal(envelope.result.jobs[0].progress.shell_commands_run, 1);
    assert.equal(envelope.result.jobs[0].progress.artifacts_written, 2);
    assert.equal(envelope.result.jobs[0].progress.last_action, "File changes completed.");
    assert.equal(envelope.result.jobs[0].progress.last_action_at_seconds, 30);
    assert.equal(envelope.result.jobs[0].progress.events_since_last_status, 2);
    assert.equal(envelope.result.jobs[0].progress.tokens_consumed_estimate, null);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("status list filters support empty jobs array and since timestamp", () => {
  const fixture = makeFixture("codex-bridge-status-json-filters-");
  try {
    writeJob(fixture, {
      id: "task-old",
      sessionId: "session-a",
      status: "completed",
      phase: "done",
      threadId: "thread-old",
      createdAt: "2026-05-06T11:58:00.000Z",
      updatedAt: "2026-05-06T11:59:00.000Z",
      completedAt: "2026-05-06T11:59:00.000Z",
    });
    writeJob(fixture, {
      id: "task-new",
      sessionId: "session-a",
      status: "completed",
      phase: "done",
      threadId: "thread-new",
      updatedAt: "2026-05-06T12:05:00.000Z",
      completedAt: "2026-05-06T12:05:00.000Z",
    });

    const empty = runBridge(fixture, ["status", "--all", "--session", "missing-session", "--json"]);
    assert.equal(empty.status, 0, empty.stderr || empty.stdout);
    assert.deepEqual(JSON.parse(empty.stdout).result.jobs, []);

    const since = runBridge(fixture, ["status", "--all", "--since", "2026-05-06T12:00:00.000Z", "--json"]);
    assert.equal(since.status, 0, since.stderr || since.stdout);
    const envelope = JSON.parse(since.stdout);
    assert.deepEqual(envelope.result.jobs.map((job) => job.id), ["task-new"]);
    assert.equal(envelope.result.summary.total, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
