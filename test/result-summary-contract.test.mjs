import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import codexAdapter from "../src/adapters/codex/index.mjs";
import { extractItemText } from "../src/lib/envelope-helpers.mjs";
import { upsertJob, writeJobFile } from "../src/lib/state.mjs";

const bridgePath = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("codex result summary exposes the complete final message", async (t) => {
  const previousPluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const root = makeTempDir("codex-result-summary-");
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const sessionDir = path.join(root, "sessions");
  const finalMessage = [
    "**Cluster verdict - REJECTED**",
    "",
    "- finding: missing lifecycle cleanup",
    "- source: src/runtime.mjs:42",
    "- fix: persist the cleanup result",
    "",
  ].join("\n");

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

  fs.writeFileSync(path.join(workspace, "config.yaml"), `session_dir: ${JSON.stringify(sessionDir)}\n`, "utf8");
  const job = {
    id: "task-full-summary",
    status: "completed",
    phase: "done",
    title: "Codex Task",
    jobClass: "task",
    workspaceRoot: workspace,
    threadId: "thread-full-summary",
    summary: "**Cluster verdict - REJECTED**",
    result: {
      rawOutput: finalMessage,
    },
  };
  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, job);
  fs.writeFileSync(path.join(sessionDir, "thread-full-summary.events"), "[DONE] completed\n");

  const normalized = await codexAdapter.getResult(job.id, { cwd: workspace });

  assert.equal(normalized.summary, finalMessage);
  assert.equal(normalized.finalMessage, finalMessage);
});

test("result --json escapes control characters in stored raw output", (t) => {
  const previousPluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const root = makeTempDir("codex-result-json-control-");
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const sessionDir = path.join(root, "sessions");
  const rawOutput = "line 1\nline 2\tcolumn\u001b[31mred\u001b[0m\u0000end";

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

  fs.writeFileSync(path.join(workspace, "config.yaml"), `session_dir: ${JSON.stringify(sessionDir)}\n`, "utf8");
  const job = {
    id: "task-json-control-chars",
    status: "completed",
    phase: "done",
    title: "Codex Task",
    jobClass: "task",
    workspaceRoot: workspace,
    threadId: "thread-json-control-chars",
    summary: "line 1",
    result: {
      rawOutput,
    },
  };
  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, job);
  fs.writeFileSync(path.join(sessionDir, "thread-json-control-chars.events"), "[DONE] completed\n");

  const result = spawnSync(
    process.execPath,
    [bridgePath, "result", job.id, "--json", "--cwd", workspace],
    {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_BRIDGE_PLUGIN_DATA: stateRoot,
        CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.includes("\u0000"), false);
  assert.equal(result.stdout.includes("\u001b"), false);

  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.result.adapterResult.finalMessage, rawOutput);
  assert.equal(envelope.result.adapterResult.summary, rawOutput);
  assert.equal(envelope.result.adapterResult.raw.storedJob.result.rawOutput, rawOutput);
});

test("agent message transcript extraction preserves full text", () => {
  const text = `${"x".repeat(600)}\nsecond line`;

  assert.equal(extractItemText({ type: "agentMessage", text }), text);
});

test("result transcript final-only prints the stored final message", (t) => {
  const previousPluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const root = makeTempDir("codex-result-transcript-");
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const sessionDir = path.join(root, "sessions");
  const finalMessage = "first line\nsecond line\nthird line\n";

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

  fs.writeFileSync(path.join(workspace, "config.yaml"), `session_dir: ${JSON.stringify(sessionDir)}\n`, "utf8");
  const job = {
    id: "task-transcript",
    status: "completed",
    phase: "done",
    title: "Codex Task",
    jobClass: "task",
    workspaceRoot: workspace,
    threadId: "thread-transcript",
    summary: "first line",
    result: {
      rawOutput: finalMessage,
    },
  };
  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, job);
  fs.writeFileSync(path.join(sessionDir, "thread-transcript.events"), "[DONE] completed\n");

  const result = spawnSync(
    process.execPath,
    [
      bridgePath,
      "result",
      job.id,
      "--transcript",
      "--final-only",
      "--format",
      "text",
      "--cwd",
      workspace,
    ],
    {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_BRIDGE_PLUGIN_DATA: stateRoot,
        CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, finalMessage);
});
