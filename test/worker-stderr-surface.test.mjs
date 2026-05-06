// Task 20 / F-44 — `[WORKER_STDERR]` event tag and `result.workerErr` field.
//
// These tests pin the three observable surfaces:
//   1. `formatWorkerStderrEvent` produces a tagged block with size, class,
//      path, and a tail.
//   2. `classifyStderr` recognizes the canonical error classes.
//   3. `readWorkerErrTail` returns a bounded suffix and marks truncation.
//   4. `codexAdapter.getResult` populates `result.workerErr` when the
//      detached worker's `<logFile>.worker.err` is non-empty.
//
// The watcher itself (poll loop inside `runBridgeTask`) is exercised via
// fabricated stderr writes in the local end-to-end script; it is not
// reproduced as a unit test because the loop is wired to the heartbeat
// session that requires a running app-server.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyStderr,
  formatWorkerStderrEvent,
  readWorkerErrTail,
  WORKER_STDERR_TAIL_BYTES,
} from "../src/lib/session-log.mjs";
import codexAdapter from "../src/adapters/codex/index.mjs";
import { upsertJob, writeJobFile } from "../src/lib/state.mjs";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const session = { threadId: "thread-stderr" };

test("classifyStderr recognizes the canonical error classes", () => {
  assert.equal(classifyStderr("Error: ENETUNREACH at httpsAgent"), "network");
  assert.equal(classifyStderr("ECONNREFUSED 127.0.0.1:1234"), "network");
  assert.equal(classifyStderr("HTTP 429 RateLimit exceeded"), "rate_limit");
  assert.equal(classifyStderr("EACCES: permission denied, open '/etc/hosts'"), "permission");
  assert.equal(classifyStderr("segmentation fault (core dumped)"), "crash");
  assert.equal(classifyStderr("SIGSEGV received"), "crash");
  assert.equal(classifyStderr("Error [MODULE_NOT_FOUND]: Cannot find module 'foo'"), "missing_dependency");
  assert.equal(classifyStderr("/bin/sh: codex: command not found"), "missing_dependency");
  assert.equal(classifyStderr("hello world"), "unknown");
  assert.equal(classifyStderr(""), "unknown");
  assert.equal(classifyStderr(null), "unknown");
});

test("classifyStderr prioritizes rate_limit over generic network for HTTP 429", () => {
  // A 429 reply over the network is more actionable as `rate_limit` than
  // `network`. Order in `classifyStderr` matters; this test pins it.
  assert.equal(classifyStderr("RateLimit: quota exceeded; ECONNRESET"), "rate_limit");
});

test("readWorkerErrTail returns empty when the file is missing", () => {
  const dir = makeTempDir("codex-bridge-tail-missing-");
  try {
    const result = readWorkerErrTail(path.join(dir, "no-such-file.err"));
    assert.deepEqual(result, { tail: "", truncated: false, totalBytes: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readWorkerErrTail returns the full content when below the limit", () => {
  const dir = makeTempDir("codex-bridge-tail-full-");
  try {
    const file = path.join(dir, "small.err");
    fs.writeFileSync(file, "short stderr line");
    const result = readWorkerErrTail(file, WORKER_STDERR_TAIL_BYTES);
    assert.equal(result.tail, "short stderr line");
    assert.equal(result.truncated, false);
    assert.equal(result.totalBytes, "short stderr line".length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readWorkerErrTail truncates large files and marks truncation", () => {
  const dir = makeTempDir("codex-bridge-tail-truncate-");
  try {
    const file = path.join(dir, "large.err");
    const head = "A".repeat(2000);
    const tail = "ENETUNREACH at httpsAgent\n";
    fs.writeFileSync(file, head + tail);
    const result = readWorkerErrTail(file, 100);
    assert.equal(result.truncated, true);
    assert.equal(result.totalBytes, head.length + tail.length);
    assert.equal(result.tail.length, 100);
    // The tail ends with what's at the end of the file, including the
    // ENETUNREACH classifier hit.
    assert.match(result.tail, /ENETUNREACH/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("formatWorkerStderrEvent emits the tagged block with size, class, path, and tail", () => {
  const block = formatWorkerStderrEvent(session, {
    path: "/tmp/jobs/task-x.log.worker.err",
    sizeBytes: 2451,
    deltaBytes: 2451,
    tail: "Error: ENETUNREACH at TLSSocket.onSocketEnd",
    truncated: false,
    errorClassHint: "network",
  });
  assert.match(block, /^\[WORKER_STDERR\] thread-stderr/);
  assert.match(block, /size=2451 bytes/);
  assert.match(block, /delta=2451 bytes/);
  assert.match(block, /class=network/);
  assert.match(block, /path: \/tmp\/jobs\/task-x\.log\.worker\.err/);
  assert.match(block, /tail:\n {4}Error: ENETUNREACH/);
});

test("formatWorkerStderrEvent omits delta line when no delta is supplied", () => {
  const block = formatWorkerStderrEvent(session, {
    path: "/tmp/x.err",
    sizeBytes: 100,
    tail: "x",
    errorClassHint: "unknown",
  });
  assert.doesNotMatch(block, /delta=/);
});

test("formatWorkerStderrEvent marks truncation in the block", () => {
  const block = formatWorkerStderrEvent(session, {
    path: "/tmp/x.err",
    sizeBytes: 50_000,
    deltaBytes: 50_000,
    tail: "B".repeat(500),
    truncated: true,
    errorClassHint: "crash",
  });
  assert.match(block, /\[truncated: showing last 500 of 50000 bytes\]/);
});

test("codexAdapter.getResult populates result.workerErr when worker.err is non-empty", async (t) => {
  const previousPluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const root = makeTempDir("codex-bridge-workererr-");
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const logsDir = path.join(root, "logs");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  process.env.CODEX_BRIDGE_PLUGIN_DATA = stateRoot;
  t.after(() => {
    if (previousPluginData === undefined) {
      delete process.env.CODEX_BRIDGE_PLUGIN_DATA;
    } else {
      process.env.CODEX_BRIDGE_PLUGIN_DATA = previousPluginData;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const logFile = path.join(logsDir, "task-werr.log");
  fs.writeFileSync(logFile, "");
  fs.writeFileSync(`${logFile}.worker.err`, "Error: ENETUNREACH at TLSSocket.onSocketEnd\n");

  const job = {
    id: "task-werr",
    status: "failed",
    phase: "failed",
    title: "Codex Task",
    jobClass: "task",
    workspaceRoot: workspace,
    threadId: "thread-werr",
    summary: "failed",
    logFile,
  };
  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, job);

  const normalized = await codexAdapter.getResult(job.id, { cwd: workspace });
  assert.equal(normalized.jobId, "task-werr");
  assert.ok(normalized.workerErr, "expected workerErr summary on failed job");
  assert.equal(normalized.workerErr.path, `${logFile}.worker.err`);
  assert.ok(normalized.workerErr.size_bytes > 0);
  assert.match(normalized.workerErr.tail, /ENETUNREACH/);
  assert.equal(normalized.workerErr.truncated, false);
  assert.equal(normalized.workerErr.error_class_hint, "network");
});

test("codexAdapter.getResult returns workerErr=null when the file is empty or missing", async (t) => {
  const previousPluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const root = makeTempDir("codex-bridge-workererr-empty-");
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const logsDir = path.join(root, "logs");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  process.env.CODEX_BRIDGE_PLUGIN_DATA = stateRoot;
  t.after(() => {
    if (previousPluginData === undefined) {
      delete process.env.CODEX_BRIDGE_PLUGIN_DATA;
    } else {
      process.env.CODEX_BRIDGE_PLUGIN_DATA = previousPluginData;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Job with logFile but no worker.err on disk.
  const logFile = path.join(logsDir, "task-empty.log");
  fs.writeFileSync(logFile, "");
  const job = {
    id: "task-empty",
    status: "completed",
    phase: "done",
    title: "Codex Task",
    jobClass: "task",
    workspaceRoot: workspace,
    threadId: "thread-empty",
    summary: "done",
    logFile,
  };
  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, job);

  const normalized = await codexAdapter.getResult(job.id, { cwd: workspace });
  assert.equal(normalized.workerErr, null);

  // Even an existing-but-empty worker.err returns null — there's nothing to surface.
  fs.writeFileSync(`${logFile}.worker.err`, "");
  const normalizedAgain = await codexAdapter.getResult(job.id, { cwd: workspace });
  assert.equal(normalizedAgain.workerErr, null);
});
