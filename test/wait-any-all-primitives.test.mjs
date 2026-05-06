import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { upsertJob } from "../src/lib/state.mjs";

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

function writeJob({ workspace, sessionDir }, { id, threadId, status = "running", phase = "running", events = "" }) {
  const now = "2026-05-06T12:00:00.000Z";
  upsertJob(workspace, {
    id,
    sessionId: "test-session",
    jobClass: "task",
    status,
    phase,
    threadId,
    createdAt: now,
    updatedAt: now,
    completedAt: status === "running" || status === "queued" ? null : now,
  });
  if (events != null) {
    fs.writeFileSync(path.join(sessionDir, `${threadId}.events`), events, "utf8");
  }
}

function runBridge(fixture, args) {
  const env = {
    ...process.env,
    CODEX_BRIDGE_PLUGIN_DATA: fixture.pluginData,
    CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
  };
  delete env.CLAUDE_PLUGIN_DATA;
  return spawnSync(process.execPath, [bridgePath, ...args, "--cwd", fixture.workspace], {
    cwd: fixture.workspace,
    env,
    encoding: "utf8",
  });
}

function useFixtureStateRoot(fixture) {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CODEX_BRIDGE_PLUGIN_DATA = fixture.pluginData;
  delete process.env.CLAUDE_PLUGIN_DATA;
  return () => {
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
  };
}

test("wait --all accepts a jobs list and summarizes all terminal jobs", () => {
  const fixture = makeFixture("codex-bridge-wait-all-");
  const restoreEnv = useFixtureStateRoot(fixture);
  try {
    writeJob(fixture, {
      id: "task-wait-all-done",
      threadId: "thread-wait-all-done",
      status: "completed",
      phase: "done",
      events: "[DONE] thread-wait-all-done completed in 4s | 1 files | +1 -0\n",
    });
    writeJob(fixture, {
      id: "task-wait-all-error",
      threadId: "thread-wait-all-error",
      status: "failed",
      phase: "failed",
      events: "[ERROR] thread-wait-all-error failed | ClientTimeout\n",
    });

    const result = runBridge(fixture, [
      "wait",
      "--all",
      "--jobs",
      "task-wait-all-done task-wait-all-error",
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
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
    assert.deepEqual(
      envelope.result.jobs.map((job) => [job.jobId, job.terminalTag]),
      [
        ["task-wait-all-done", "DONE"],
        ["task-wait-all-error", "ERROR"],
      ],
    );
  } finally {
    restoreEnv();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("wait --all timeout returns partial progress in JSON errors", () => {
  const fixture = makeFixture("codex-bridge-wait-all-timeout-");
  const restoreEnv = useFixtureStateRoot(fixture);
  try {
    writeJob(fixture, {
      id: "task-wait-timeout-done",
      threadId: "thread-wait-timeout-done",
      status: "completed",
      phase: "done",
      events: "[DONE] thread-wait-timeout-done completed in 1s | 0 files | +0 -0\n",
    });
    writeJob(fixture, {
      id: "task-wait-timeout-running",
      threadId: "thread-wait-timeout-running",
      events: "",
    });

    const result = runBridge(fixture, [
      "wait",
      "--all",
      "task-wait-timeout-done",
      "task-wait-timeout-running",
      "--timeout-ms",
      "1",
      "--json",
    ]);

    assert.equal(result.status, 7, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.error.code, "WAIT_TIMEOUT");
    assert.equal(envelope.error.details.mode, "all");
    assert.equal(envelope.error.details.summary.matched, 1);
    assert.equal(envelope.error.details.summary.pending, 1);
    assert.equal(envelope.error.details.jobs[0].jobId, "task-wait-timeout-done");
    assert.equal(envelope.error.details.pending[0].jobId, "task-wait-timeout-running");
  } finally {
    restoreEnv();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("wait --any error predicate ignores successful terminal jobs", () => {
  const fixture = makeFixture("codex-bridge-wait-any-error-");
  const restoreEnv = useFixtureStateRoot(fixture);
  try {
    writeJob(fixture, {
      id: "task-wait-error-done",
      threadId: "thread-wait-error-done",
      status: "completed",
      phase: "done",
      events: "[DONE] thread-wait-error-done completed in 1s | 0 files | +0 -0\n",
    });
    writeJob(fixture, {
      id: "task-wait-error-incomplete",
      threadId: "thread-wait-error-incomplete",
      status: "failed",
      phase: "incomplete",
      events: "[INCOMPLETE] thread-wait-error-incomplete | 0 files | +0 -0\n",
    });

    const result = runBridge(fixture, [
      "wait",
      "--any",
      "--predicate",
      "error",
      "task-wait-error-done",
      "task-wait-error-incomplete",
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.result.jobId, "task-wait-error-incomplete");
    assert.equal(envelope.result.state, "INCOMPLETE");
    assert.equal(envelope.result.terminalTag, "INCOMPLETE");
  } finally {
    restoreEnv();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("wait rejects invalid predicate and conflicting modes", () => {
  const fixture = makeFixture("codex-bridge-wait-invalid-");
  const restoreEnv = useFixtureStateRoot(fixture);
  try {
    writeJob(fixture, {
      id: "task-wait-invalid",
      threadId: "thread-wait-invalid",
      events: "",
    });

    const badPredicate = runBridge(fixture, [
      "wait",
      "--predicate",
      "needs-attention",
      "task-wait-invalid",
      "--json",
    ]);
    assert.equal(badPredicate.status, 2, badPredicate.stderr || badPredicate.stdout);
    assert.equal(JSON.parse(badPredicate.stdout).error.code, "USAGE_ERROR");

    const conflictingModes = runBridge(fixture, [
      "wait",
      "--any",
      "--all",
      "task-wait-invalid",
      "--json",
    ]);
    assert.equal(conflictingModes.status, 2, conflictingModes.stderr || conflictingModes.stdout);
    assert.equal(JSON.parse(conflictingModes.stdout).error.code, "USAGE_ERROR");
  } finally {
    restoreEnv();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("wait --any can wake on an interrupt predicate before terminal events", () => {
  const fixture = makeFixture("codex-bridge-wait-any-");
  const restoreEnv = useFixtureStateRoot(fixture);
  try {
    writeJob(fixture, {
      id: "task-wait-any-question",
      threadId: "thread-wait-any-question",
      events: "[QUESTION] thread-wait-any-question req-123\n",
    });
    writeJob(fixture, {
      id: "task-wait-any-running",
      threadId: "thread-wait-any-running",
      events: "",
    });

    const result = runBridge(fixture, [
      "wait",
      "--any",
      "--predicate",
      "interrupt+terminal",
      "task-wait-any-question",
      "task-wait-any-running",
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.result.mode, "any");
    assert.equal(envelope.result.predicate, "both");
    assert.equal(envelope.result.jobId, "task-wait-any-question");
    assert.equal(envelope.result.state, "QUESTION");
    assert.equal(envelope.result.terminalTag, null);
    assert.equal(envelope.result.interruptTag, "QUESTION");
    assert.equal(envelope.result.winner.eventsPath.endsWith("thread-wait-any-question.events"), true);
  } finally {
    restoreEnv();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
