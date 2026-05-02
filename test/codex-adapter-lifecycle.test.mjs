import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import codexAdapter, {
  _resetCodexAdapterRuntimeForTest,
  _setCodexAdapterRuntimeForTest,
} from "../src/adapters/codex/index.mjs";
import { readResponseFile, writePendingRequest } from "../src/lib/pending-requests.mjs";
import { upsertJob, writeJobFile } from "../src/lib/state.mjs";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("codex adapter dispatch delegates to the app-server turn runtime", async (t) => {
  const cwd = makeTempDir("codex-adapter-dispatch-");
  const sessionDir = path.join(cwd, "sessions");
  fs.mkdirSync(sessionDir);
  const calls = [];
  _setCodexAdapterRuntimeForTest({
    async runTurn(callCwd, options) {
      calls.push({ cwd: callCwd, options });
      return {
        status: 0,
        threadId: "019e1f00-0000-7000-8000-000000000001",
        turnId: "turn-1",
        finalMessage: "ok",
      };
    },
  });
  t.after(() => {
    _resetCodexAdapterRuntimeForTest();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const result = await codexAdapter.dispatch("hello", {
    cwd,
    jobId: "task-abc",
    sessionDir,
    model: "gpt-test",
    effort: "high",
    adapterOptions: {
      turnOptions: {
        sandbox: "read-only",
        persistThread: true,
      },
    },
  });

  assert.equal(result.jobId, "task-abc");
  assert.equal(result.threadId, "019e1f00-0000-7000-8000-000000000001");
  assert.equal(result.sessionDir, sessionDir);
  assert.equal(result.rawResult.finalMessage, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, cwd);
  assert.equal(calls[0].options.prompt, "hello");
  assert.equal(calls[0].options.model, "gpt-test");
  assert.equal(calls[0].options.effort, "high");
  assert.equal(calls[0].options.sandbox, "read-only");
  assert.equal(calls[0].options.persistThread, true);
});

test("codex adapter resume injects the target thread id", async (t) => {
  const cwd = makeTempDir("codex-adapter-resume-");
  const sessionDir = path.join(cwd, "sessions");
  fs.mkdirSync(sessionDir);
  const calls = [];
  _setCodexAdapterRuntimeForTest({
    async runTurn(callCwd, options) {
      calls.push({ cwd: callCwd, options });
      return {
        status: 0,
        threadId: options.resumeThreadId,
        turnId: "turn-resume",
        finalMessage: "continued",
      };
    },
  });
  t.after(() => {
    _resetCodexAdapterRuntimeForTest();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const result = await codexAdapter.resume(
    "019e1f00-0000-7000-8000-000000000002",
    "continue",
    { cwd, sessionDir },
  );

  assert.equal(result.threadId, "019e1f00-0000-7000-8000-000000000002");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.prompt, "continue");
  assert.equal(calls[0].options.resumeThreadId, "019e1f00-0000-7000-8000-000000000002");
});

test("codex adapter respond persists the bridge response payload", async (t) => {
  const root = makeTempDir("codex-adapter-respond-");
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(sessionDir);
  const threadId = "019e1f00-0000-7000-8000-000000000003";
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writePendingRequest(sessionDir, threadId, {
    internalId: "req-abc",
    rpcRequestId: 42,
    threadId,
    method: "item/tool/requestUserInput",
  });

  const payload = { answers: { q1: { answers: ["ship it"] } } };
  const result = await codexAdapter.respond(threadId, "req-abc", payload, { sessionDir });
  const response = readResponseFile(sessionDir, threadId);

  assert.equal(result.ok, true);
  assert.equal(result.threadId, threadId);
  assert.deepEqual(response, {
    requestId: "req-abc",
    rpcRequestId: 42,
    payload,
  });
});

test("codex adapter steer and cancel use backend lifecycle hooks", async (t) => {
  const cwd = makeTempDir("codex-adapter-control-");
  const calls = [];
  _setCodexAdapterRuntimeForTest({
    async steerTurn(callCwd, args) {
      calls.push({ type: "steer", cwd: callCwd, args });
      return { ok: true, threadId: args.threadId, turnId: args.turnId };
    },
    async interruptTurn(callCwd, args) {
      calls.push({ type: "interrupt", cwd: callCwd, args });
      return { attempted: true, interrupted: true };
    },
  });
  t.after(() => {
    _resetCodexAdapterRuntimeForTest();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const steer = await codexAdapter.steer("thread-1", "turn-1", "focus", { cwd });
  const cancel = await codexAdapter.cancel("task-1", { cwd, threadId: "thread-1", turnId: "turn-1" });

  assert.equal(steer.ok, true);
  assert.equal(cancel.interrupted, true);
  assert.deepEqual(calls.map((call) => call.type), ["steer", "interrupt"]);
  assert.equal(calls[0].args.prompt, "focus");
  assert.equal(calls[1].args.threadId, "thread-1");
});

test("codex adapter result and event streaming normalize persisted job state", async (t) => {
  const previousPluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const root = makeTempDir("codex-adapter-result-");
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(workspace);
  fs.mkdirSync(sessionDir);
  process.env.CODEX_BRIDGE_PLUGIN_DATA = stateRoot;
  t.after(() => {
    if (previousPluginData === undefined) {
      delete process.env.CODEX_BRIDGE_PLUGIN_DATA;
    } else {
      process.env.CODEX_BRIDGE_PLUGIN_DATA = previousPluginData;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const job = {
    id: "task-result",
    status: "completed",
    phase: "done",
    title: "Codex Task",
    jobClass: "task",
    workspaceRoot: workspace,
    threadId: "thread-result",
    summary: "done",
    result: {
      artifacts: { diff: "/tmp/diff.patch" },
    },
  };
  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, job);
  fs.writeFileSync(
    path.join(sessionDir, "thread-result.events"),
    "[DONE] completed\n[CHECKPOINT] final digest\n",
  );

  const normalized = await codexAdapter.getResult(job.id, { cwd: workspace });
  const events = [];
  for await (const event of codexAdapter.streamEvents(job.id, { cwd: workspace, sessionDir })) {
    events.push(event);
  }

  assert.equal(normalized.jobId, job.id);
  assert.equal(normalized.threadId, "thread-result");
  assert.equal(normalized.phase, "done");
  assert.equal(normalized.exitCode, 0);
  assert.deepEqual(events.map((event) => event.tag), ["DONE", "CHECKPOINT"]);
});
