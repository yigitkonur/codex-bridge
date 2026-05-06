import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveJobLogFile, upsertJob, writeJobFile } from "../src/lib/state.mjs";

const bridgePath = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));

function makeTimelineFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-timeline-"));
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  const sessionDir = path.join(root, "sessions");
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CODEX_BRIDGE_PLUGIN_DATA = pluginData;
  delete process.env.CLAUDE_PLUGIN_DATA;
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, "config.yaml"), `session_dir: ${JSON.stringify(sessionDir)}\n`, "utf8");

  const job = {
    id: "task-timeline",
    sessionId: "test-session",
    jobClass: "task",
    status: "completed",
    phase: "done",
    threadId: "thread-timeline",
    createdAt: "2026-05-01T18:09:33.000Z",
    updatedAt: "2026-05-01T18:09:50.000Z",
    completedAt: "2026-05-01T18:09:50.000Z"
  };
  const logFile = resolveJobLogFile(workspace, job.id);
  const storedJob = { ...job, workspaceRoot: workspace, logFile };
  upsertJob(workspace, storedJob);
  writeJobFile(workspace, job.id, storedJob);

  fs.writeFileSync(
    path.join(sessionDir, `${job.threadId}.events`),
    [
      "[DIRECTIVES] 18:09:34.903 mode=plan effort=xhigh sandbox=readOnly",
      "[DONE] 18:09:50.000 completed"
    ].join("\n") + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(sessionDir, `${job.threadId}.ndjson`),
    JSON.stringify({
      ts: "2026-05-01T18:09:35.750Z",
      tag: "ITEM_COMPLETED",
      method: "item/completed",
      threadId: job.threadId,
      data: { item: { type: "userMessage", content: [{ text: "Investigate" }] } }
    }) + "\n",
    "utf8"
  );
  fs.writeFileSync(
    logFile,
    [
      "[2026-05-01T18:09:33.546Z] Starting Codex Task.",
      "[2026-05-01T18:09:47.162Z] Running command: pwd && rg --files src"
    ].join("\n") + "\n",
    "utf8"
  );
  fs.writeFileSync(`${logFile}.worker.err`, "worker stderr line\n", "utf8");
  fs.utimesSync(`${logFile}.worker.err`, new Date("2026-05-01T18:09:48.000Z"), new Date("2026-05-01T18:09:48.000Z"));

  const env = {
    ...process.env,
    CODEX_BRIDGE_PLUGIN_DATA: pluginData,
    CODEX_BRIDGE_NO_UPDATE_CHECK: "1"
  };
  delete env.CLAUDE_PLUGIN_DATA;
  return { root, workspace, env, job, logFile, previousBridgePluginData, previousClaudePluginData };
}

function cleanupTimelineFixture(fixture) {
  if (fixture.previousBridgePluginData == null) {
    delete process.env.CODEX_BRIDGE_PLUGIN_DATA;
  } else {
    process.env.CODEX_BRIDGE_PLUGIN_DATA = fixture.previousBridgePluginData;
  }
  if (fixture.previousClaudePluginData == null) {
    delete process.env.CLAUDE_PLUGIN_DATA;
  } else {
    process.env.CLAUDE_PLUGIN_DATA = fixture.previousClaudePluginData;
  }
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function runBridge(fixture, args) {
  return spawnSync(process.execPath, [bridgePath, ...args, "--cwd", fixture.workspace], {
    cwd: fixture.workspace,
    env: fixture.env,
    encoding: "utf8"
  });
}

test("timeline prints a merged wall-clock sorted text view", () => {
  const fixture = makeTimelineFixture();
  try {
    const result = runBridge(fixture, ["timeline", fixture.job.id]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\[LOG\s+\] Starting Codex Task/);
    assert.match(result.stdout, /\[EVENT\s+\] \[DIRECTIVES\]/);
    assert.match(result.stdout, /\[NDJSON\s+\] \[ITEM_COMPLETED\] ITEM_COMPLETED userMessage/);
    assert.match(result.stdout, /\[WORKER\s+\] worker stderr line/);
    assert.ok(
      result.stdout.indexOf("18:09:33.546") < result.stdout.indexOf("18:09:34.903"),
      result.stdout
    );
  } finally {
    cleanupTimelineFixture(fixture);
  }
});

test("timeline supports json, html, source, since, and missing files", () => {
  const fixture = makeTimelineFixture();
  try {
    fs.rmSync(`${fixture.logFile}.worker.err`, { force: true });

    const jsonResult = runBridge(fixture, ["timeline", fixture.job.id, "--format", "json", "--source", "events"]);
    assert.equal(jsonResult.status, 0, jsonResult.stderr || jsonResult.stdout);
    const entries = JSON.parse(jsonResult.stdout);
    assert.equal(entries.length, 2);
    assert.equal(entries.every((entry) => entry.source === "events"), true);

    const sinceResult = runBridge(fixture, ["timeline", fixture.job.id, "--format", "json", "--since", "2026-05-01T18:09:36.000Z"]);
    assert.equal(sinceResult.status, 0, sinceResult.stderr || sinceResult.stdout);
    const filtered = JSON.parse(sinceResult.stdout);
    assert.equal(filtered.some((entry) => entry.body.includes("Starting Codex Task")), false);
    assert.equal(filtered.some((entry) => entry.body.includes("completed")), true);

    const htmlResult = runBridge(fixture, ["timeline", fixture.job.id, "--format", "html"]);
    assert.equal(htmlResult.status, 0, htmlResult.stderr || htmlResult.stdout);
    const htmlPath = htmlResult.stdout.trim();
    assert.equal(fs.existsSync(htmlPath), true);
    assert.match(fs.readFileSync(htmlPath, "utf8"), /<details class="entry/);
  } finally {
    cleanupTimelineFixture(fixture);
  }
});
