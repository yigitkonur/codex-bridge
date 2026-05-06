import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { upsertJob, writeJobFile } from "../src/lib/state.mjs";

const bridgePath = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));

function withFixture(run) {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-wait-"));
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(pluginData, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, "config.yaml"), `session_dir: ${JSON.stringify(sessionDir)}\n`, "utf8");
  process.env.CODEX_BRIDGE_PLUGIN_DATA = pluginData;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    return run({ workspace, pluginData, sessionDir });
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
}

function addJob({ workspace, sessionDir }, { id, threadId, status = "running", phase = "running", events }) {
  const job = {
    id,
    sessionId: "wait-test-session",
    jobClass: "task",
    status,
    phase,
    threadId,
    createdAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-06T00:00:01.000Z",
    ...(status === "running" ? {} : { completedAt: "2026-05-06T00:00:01.000Z" }),
  };
  upsertJob(workspace, job);
  writeJobFile(workspace, id, job);
  fs.writeFileSync(path.join(sessionDir, `${threadId}.events`), events, "utf8");
  return job;
}

function runBridge(args, fixture) {
  return spawnSync(process.execPath, [bridgePath, ...args, "--cwd", fixture.workspace], {
    cwd: fixture.workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_BRIDGE_PLUGIN_DATA: fixture.pluginData,
      CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
    },
  });
}

function parseEnvelope(result, expectedStatus = 0) {
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  assert.equal(result.stderr, "", result.stderr);
  return JSON.parse(result.stdout);
}

test("wait --all returns a structured summary for an explicit cohort", () => {
  withFixture((fixture) => {
    addJob(fixture, {
      id: "task-wait-all-done",
      threadId: "thread-wait-all-done",
      status: "completed",
      phase: "done",
      events: "[DONE] thread-wait-all-done | duration=1s\n",
    });
    addJob(fixture, {
      id: "task-wait-all-error",
      threadId: "thread-wait-all-error",
      status: "failed",
      phase: "failed",
      events: "[ERROR] thread-wait-all-error | origin=turn\n",
    });

    const envelope = parseEnvelope(runBridge([
      "wait",
      "--all",
      "task-wait-all-done",
      "task-wait-all-error",
      "--timeout-ms",
      "1000",
      "--json",
    ], fixture));

    assert.equal(envelope.command, "wait");
    assert.equal(envelope.result.mode, "all");
    assert.equal(envelope.result.predicate, "terminal");
    assert.deepEqual(envelope.result.summary, {
      total: 2,
      matched: 2,
      pending: 0,
      completed: 1,
      plan: 0,
      failed: 1,
      cancelled: 0,
      errors: 1,
      incomplete: 0,
      questions: 0,
      interrupts: 0,
      terminal: 2,
    });
    assert.deepEqual(envelope.result.jobs.map((job) => job.state), ["DONE", "ERROR"]);
  });
});

test("wait --any --predicate interrupt wakes on QUESTION", () => {
  withFixture((fixture) => {
    addJob(fixture, {
      id: "task-wait-interrupt-running",
      threadId: "thread-wait-interrupt-running",
      events: "[HEARTBEAT] thread-wait-interrupt-running t=1s\n",
    });
    addJob(fixture, {
      id: "task-wait-interrupt-question",
      threadId: "thread-wait-interrupt-question",
      events: "[QUESTION] thread-wait-interrupt-question req-1\n  q1: Choose\n",
    });

    const envelope = parseEnvelope(runBridge([
      "wait",
      "--any",
      "--predicate",
      "interrupt",
      "task-wait-interrupt-running",
      "task-wait-interrupt-question",
      "--timeout-ms",
      "1000",
      "--json",
    ], fixture));

    assert.equal(envelope.result.mode, "any");
    assert.equal(envelope.result.predicate, "interrupt");
    assert.equal(envelope.result.winner.jobId, "task-wait-interrupt-question");
    assert.equal(envelope.result.winner.state, "QUESTION");
    assert.equal(envelope.result.winner.terminalTag, null);
    assert.equal(envelope.result.winner.interruptTag, "QUESTION");
  });
});

test("wait --any --predicate error ignores successful terminal events", () => {
  withFixture((fixture) => {
    addJob(fixture, {
      id: "task-wait-error-done",
      threadId: "thread-wait-error-done",
      status: "completed",
      phase: "done",
      events: "[DONE] thread-wait-error-done | duration=1s\n",
    });
    addJob(fixture, {
      id: "task-wait-error-incomplete",
      threadId: "thread-wait-error-incomplete",
      status: "failed",
      phase: "incomplete",
      events: "[INCOMPLETE] thread-wait-error-incomplete no_files_touched\n",
    });

    const envelope = parseEnvelope(runBridge([
      "wait",
      "--any",
      "--predicate=error",
      "task-wait-error-done",
      "task-wait-error-incomplete",
      "--timeout-ms",
      "1000",
      "--json",
    ], fixture));

    assert.equal(envelope.result.winner.jobId, "task-wait-error-incomplete");
    assert.equal(envelope.result.winner.state, "INCOMPLETE");
    assert.equal(envelope.result.winner.terminalTag, "INCOMPLETE");
  });
});

test("wait accepts --jobs cohorts and rejects invalid mode/predicate input", () => {
  withFixture((fixture) => {
    addJob(fixture, {
      id: "task-wait-jobs-a",
      threadId: "thread-wait-jobs-a",
      status: "completed",
      phase: "done",
      events: "[DONE] thread-wait-jobs-a | duration=1s\n",
    });
    addJob(fixture, {
      id: "task-wait-jobs-b",
      threadId: "thread-wait-jobs-b",
      status: "completed",
      phase: "done",
      events: "[PLAN] thread-wait-jobs-b turn-1\n",
    });

    const envelope = parseEnvelope(runBridge([
      "wait",
      "--jobs",
      "task-wait-jobs-a task-wait-jobs-b",
      "--timeout-ms",
      "1000",
      "--json",
    ], fixture));
    assert.equal(envelope.result.mode, "all");
    assert.equal(envelope.result.summary.total, 2);
    assert.deepEqual(envelope.result.jobs.map((job) => job.jobId), ["task-wait-jobs-a", "task-wait-jobs-b"]);

    const conflict = parseEnvelope(runBridge([
      "wait",
      "--any",
      "--all",
      "task-wait-jobs-a",
      "task-wait-jobs-b",
      "--json",
    ], fixture), 2);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, "USAGE_ERROR");

    const invalidPredicate = parseEnvelope(runBridge([
      "wait",
      "--predicate",
      "ready",
      "task-wait-jobs-a",
      "--json",
    ], fixture), 2);
    assert.equal(invalidPredicate.ok, false);
    assert.equal(invalidPredicate.error.code, "USAGE_ERROR");
  });
});
