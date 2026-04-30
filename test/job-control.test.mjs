import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildStatusSnapshot, readStoredJob, resolveResultJob } from "../src/lib/job-control.mjs";
import { resolveStateFile, upsertJob, writeJobFile } from "../src/lib/state.mjs";
import { SESSION_ID_ENV } from "../src/lib/tracked-jobs.mjs";

function withIsolatedState(run) {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-job-control-state-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-job-control-workspace-"));
  process.env.CODEX_BRIDGE_PLUGIN_DATA = stateRoot;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    return run({ workspace });
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
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function seedSessionJobs(workspace) {
  for (const job of [
    {
      id: "current-running",
      sessionId: "current-session",
      status: "running",
      phase: "running",
      pid: process.pid,
      updatedAt: "2026-04-29T12:03:00.000Z"
    },
    {
      id: "other-running",
      sessionId: "other-session",
      status: "running",
      phase: "running",
      pid: process.pid,
      updatedAt: "2026-04-29T12:04:00.000Z"
    },
    {
      id: "current-finished",
      sessionId: "current-session",
      status: "completed",
      phase: "done",
      updatedAt: "2026-04-29T12:01:00.000Z",
      completedAt: "2026-04-29T12:01:00.000Z"
    },
    {
      id: "other-finished",
      sessionId: "other-session",
      status: "completed",
      phase: "done",
      updatedAt: "2026-04-29T12:02:00.000Z",
      completedAt: "2026-04-29T12:02:00.000Z"
    }
  ]) {
    upsertJob(workspace, {
      createdAt: "2026-04-29T12:00:00.000Z",
      ...job
    });
  }
}

function writeRawStateJobs(workspace, jobs) {
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs }, null, 2)}\n`,
    "utf8"
  );
  for (const job of jobs) {
    writeJobFile(workspace, job.id, job);
  }
}

test("buildStatusSnapshot scopes status to the current Claude session by default", () => {
  withIsolatedState(({ workspace }) => {
    seedSessionJobs(workspace);

    const snapshot = buildStatusSnapshot(workspace, {
      env: { [SESSION_ID_ENV]: "current-session" }
    });

    assert.deepEqual(
      snapshot.running.map((job) => job.id),
      ["current-running"]
    );
    assert.equal(snapshot.latestFinished?.id, "current-finished");
    assert.deepEqual(snapshot.recent.map((job) => job.id), []);
  });
});

test("resolveResultJob resolves orphaned jobs by id prefix and thread id", () => {
  withIsolatedState(({ workspace }) => {
    const threadId = "11111111-1111-4111-8111-111111111111";
    const job = {
      id: "task-orphaned-deadbeef",
      sessionId: "current-session",
      jobClass: "task",
      status: "running",
      phase: "running",
      pid: 0,
      threadId,
      errorMessage: "Worker exited before recording completion.",
      logFile: path.join(workspace, "orphaned.log"),
      createdAt: "2026-04-29T12:00:00.000Z",
      updatedAt: "2026-04-29T12:01:00.000Z"
    };
    writeRawStateJobs(workspace, [job]);

    for (const reference of [job.id, "task-orphaned-dead", threadId]) {
      const resolved = resolveResultJob(workspace, reference);
      assert.equal(resolved.job.id, job.id);
      assert.equal(resolved.job.status, "orphaned");
      assert.equal(
        readStoredJob(resolved.workspaceRoot, resolved.job.id).errorMessage,
        "Worker exited before recording completion."
      );
    }
  });
});

test("resolveResultJob preserves not-finished errors for live queued and running jobs", () => {
  withIsolatedState(({ workspace }) => {
    for (const status of ["queued", "running"]) {
      upsertJob(workspace, {
        id: `live-${status}`,
        sessionId: "current-session",
        status,
        phase: status,
        pid: process.pid,
        threadId: `${status}-thread`,
        updatedAt: "2026-04-29T12:04:00.000Z"
      });

      assert.throws(
        () => resolveResultJob(workspace, `live-${status}`),
        (error) => error?.code === "JOB_NOT_FINISHED"
      );
    }
  });
});

test("buildStatusSnapshot includes all Claude sessions when options.all is true", () => {
  withIsolatedState(({ workspace }) => {
    seedSessionJobs(workspace);

    const snapshot = buildStatusSnapshot(workspace, {
      all: true,
      env: { [SESSION_ID_ENV]: "current-session" }
    });

    assert.deepEqual(
      snapshot.running.map((job) => job.id),
      ["other-running", "current-running"]
    );
    assert.equal(snapshot.latestFinished?.id, "other-finished");
    assert.deepEqual(
      snapshot.recent.map((job) => job.id),
      ["current-finished"]
    );
  });
});
