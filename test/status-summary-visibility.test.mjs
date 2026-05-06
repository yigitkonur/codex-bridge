import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildStatusSnapshot } from "../src/lib/job-control.mjs";
import { upsertJob, writeJobFile } from "../src/lib/state.mjs";

const BRIDGE = new URL("../src/codex-bridge.mjs", import.meta.url);

function withIsolatedState(run) {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-status-summary-"));
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(workspace);
  fs.mkdirSync(sessionDir);
  process.env.CODEX_BRIDGE_PLUGIN_DATA = stateRoot;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    return run({ root, workspace, sessionDir });
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

function seedJob(workspace, job) {
  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, {
    id: job.id,
    status: job.status,
    phase: job.phase,
    threadId: job.threadId,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  });
}

function seedPipelineFailureFixture(workspace, sessionDir) {
    const successEvents = path.join(sessionDir, "thread-success.events");
    const pipelineFailedEvents = path.join(sessionDir, "thread-pipeline.events");
    fs.writeFileSync(successEvents, "[DONE] thread-success completed in 1s\n", "utf8");
    fs.writeFileSync(
      pipelineFailedEvents,
      [
        "[DONE] thread-pipeline completed in 1s",
        "[PIPELINE:failed] 03:14:39 failing_stage=review at=diff stages=diff touched=0",
        "",
      ].join("\n"),
      "utf8",
    );

    seedJob(workspace, {
      id: "task-success",
      status: "completed",
      phase: "done",
      threadId: "thread-success",
      updatedAt: "2026-05-06T12:00:00.000Z",
      completedAt: "2026-05-06T12:00:00.000Z",
      result: { eventsPath: successEvents },
    });
    seedJob(workspace, {
      id: "task-pipeline-failed",
      status: "completed",
      phase: "done",
      threadId: "thread-pipeline",
      updatedAt: "2026-05-06T12:01:00.000Z",
      completedAt: "2026-05-06T12:01:00.000Z",
      result: { eventsPath: pipelineFailedEvents },
    });

  return { pipelineFailedEvents, successEvents };
}

test("status summary promotes pipeline failures into failed counts", () => {
  withIsolatedState(({ workspace, sessionDir }) => {
    seedPipelineFailureFixture(workspace, sessionDir);

    const snapshot = buildStatusSnapshot(workspace, { all: true });

    assert.equal(snapshot.running.length, 0);
    assert.equal(snapshot.summary.total, 2);
    assert.equal(snapshot.summary.running, 0);
    assert.equal(snapshot.summary.completed_success, 1);
    assert.equal(snapshot.summary.completed_fail, 1);
    assert.equal(snapshot.summary.completed_incomplete, 0);
    assert.equal(snapshot.summary.cancelled, 0);
    assert.equal(snapshot.summary.awaiting_attention, 1);
    assert.deepEqual(snapshot.summary.interrupts, {
      awaiting_plan: 0,
      awaiting_question: 0,
    });
    assert.deepEqual(snapshot.needs_attention.map((entry) => [entry.jobId, entry.state]), [
      ["task-pipeline-failed", "PIPELINE_FAILED"],
    ]);
    assert.match(snapshot.needs_attention[0].reason, /failing_stage=review/);
  });
});

test("status --json exposes failed summary and needs_attention", () => {
  withIsolatedState(({ workspace, sessionDir }) => {
    seedPipelineFailureFixture(workspace, sessionDir);

    const result = spawnSync(
      process.execPath,
      [BRIDGE.pathname, "status", "--cwd", workspace, "--all", "--json"],
      {
        cwd: workspace,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, "status");
    assert.equal(envelope.result.summary.completed_fail, 1);
    assert.equal(envelope.result.summary.awaiting_attention, 1);
    assert.deepEqual(envelope.result.needs_attention.map((entry) => entry.state), ["PIPELINE_FAILED"]);

    const failedResult = spawnSync(
      process.execPath,
      [BRIDGE.pathname, "status", "--cwd", workspace, "--all", "--filter", "completed_fail", "--json"],
      {
        cwd: workspace,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
        },
      },
    );
    assert.equal(failedResult.status, 0, failedResult.stderr || failedResult.stdout);
    const failedEnvelope = JSON.parse(failedResult.stdout);
    assert.equal(failedEnvelope.result.filter, "completed_fail");
    assert.deepEqual(failedEnvelope.result.filtered_jobs.map((job) => job.jobId), ["task-pipeline-failed"]);
    assert.deepEqual(failedEnvelope.result.needs_attention.map((entry) => entry.jobId), ["task-pipeline-failed"]);
  });
});
