import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveJobLogFile, upsertJob, writeJobFile } from "../src/lib/state.mjs";

const bridgePath = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));

function withBundleFixture(run) {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;
  const previousHome = process.env.HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-bundle-"));
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  const sessionDir = path.join(root, "sessions");
  const fakeHome = path.join(root, "home");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(pluginData, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.writeFileSync(path.join(workspace, "config.yaml"), `session_dir: ${JSON.stringify(sessionDir)}\n`, "utf8");

  process.env.CODEX_BRIDGE_PLUGIN_DATA = pluginData;
  delete process.env.CLAUDE_PLUGIN_DATA;
  process.env.HOME = fakeHome;

  try {
    const taskId = "task-bundle-test";
    const threadId = "22222222-2222-4222-8222-222222222222";
    const job = {
      id: taskId,
      sessionId: "bundle-session",
      jobClass: "task",
      status: "completed",
      phase: "done",
      threadId,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:02.000Z",
      completedAt: "2026-05-01T00:00:02.000Z"
    };
    upsertJob(workspace, job);
    const logFile = resolveJobLogFile(workspace, taskId);
    const storedJob = { ...job, logFile };
    writeJobFile(workspace, taskId, storedJob);
    fs.writeFileSync(path.join(sessionDir, `${threadId}.events`), `[DONE] ${threadId} completed\n`, "utf8");
    fs.writeFileSync(
      path.join(sessionDir, `${threadId}.ndjson`),
      JSON.stringify({ ts: "2026-05-01T00:00:01.000Z", tag: "DONE", method: "turn/completed", threadId }) + "\n",
      "utf8"
    );
    fs.writeFileSync(path.join(sessionDir, `${threadId}.diff`), "diff --git a/x b/x\n", "utf8");
    fs.writeFileSync(logFile, "[info] task log\n", "utf8");
    fs.writeFileSync(`${logFile}.worker.err`, "worker stderr\n", "utf8");
    const rolloutDir = path.join(fakeHome, ".codex", "sessions", "2026", "05", "01");
    fs.mkdirSync(rolloutDir, { recursive: true });
    fs.writeFileSync(path.join(rolloutDir, `rollout-2026-05-01T00-00-01-${threadId}.jsonl`), "{}\n", "utf8");

    return run({ root, workspace, pluginData, fakeHome, taskId, threadId });
  } finally {
    if (previousBridgePluginData == null) delete process.env.CODEX_BRIDGE_PLUGIN_DATA;
    else process.env.CODEX_BRIDGE_PLUGIN_DATA = previousBridgePluginData;
    if (previousClaudePluginData == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousClaudePluginData;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runBridge(args, fixture) {
  return spawnSync(process.execPath, [bridgePath, ...args], {
    cwd: fixture.workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_BRIDGE_PLUGIN_DATA: fixture.pluginData,
      CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
      HOME: fixture.fakeHome
    }
  });
}

function tarList(tarball) {
  const result = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

function tarRead(tarball, member) {
  const result = spawnSync("tar", ["-xzOf", tarball, member], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("bundle writes default forensic tarball with manifest and timeline", () => {
  withBundleFixture((fixture) => {
    const result = runBridge(["bundle", fixture.taskId, "--json"], fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    const tarball = path.join(fs.realpathSync.native(fixture.workspace), `codex-bridge-bundle-${fixture.taskId}.tar.gz`);
    assert.equal(envelope.result.bundlePath, tarball);
    assert.equal(fs.existsSync(tarball), true);

    const prefix = `codex-bridge-bundle-${fixture.taskId}`;
    const members = tarList(tarball);
    assert.ok(members.includes(`${prefix}/manifest.json`));
    assert.ok(members.includes(`${prefix}/timeline.txt`));
    assert.ok(members.includes(`${prefix}/events/${fixture.threadId}.events`));
    assert.ok(members.includes(`${prefix}/events/${fixture.threadId}.ndjson`));
    assert.ok(members.includes(`${prefix}/events/${fixture.threadId}.diff`));
    assert.ok(members.includes(`${prefix}/registry/${fixture.taskId}.json`));
    assert.ok(members.includes(`${prefix}/logs/${fixture.taskId}.log`));
    assert.ok(members.includes(`${prefix}/logs/${fixture.taskId}.log.worker.err`));
    assert.ok(members.some((member) => member.startsWith(`${prefix}/codex-rollout/rollout-`)));

    const manifest = JSON.parse(tarRead(tarball, `${prefix}/manifest.json`));
    assert.equal(manifest.task_id, fixture.taskId);
    assert.equal(manifest.thread_id, fixture.threadId);
    assert.equal(manifest.job_state.status, "completed");
    assert.ok(Array.isArray(manifest.contents));
    assert.ok(manifest.contents.includes("timeline.txt"));

    const timeline = tarRead(tarball, `${prefix}/timeline.txt`);
    assert.match(timeline, /Timeline for task-bundle-test/);
    assert.match(timeline, /\[DONE\]/);
  });
});

test("bundle honors --output and --no-include-rollout", () => {
  withBundleFixture((fixture) => {
    const outPath = path.join(fixture.root, "custom.tar.gz");
    const result = runBridge(["bundle", fixture.taskId, "--output", outPath, "--no-include-rollout", "--json"], fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.result.bundlePath, outPath);
    assert.equal(fs.existsSync(outPath), true);
    const members = tarList(outPath);
    assert.equal(members.some((member) => member.includes("/codex-rollout/rollout-")), false);
    assert.ok(members.includes(`codex-bridge-bundle-${fixture.taskId}/codex-rollout/`));
  });
});

test("task --help bundle surfaces bundle options", () => {
  withBundleFixture((fixture) => {
    const result = runBridge(["task", "--help", "bundle"], fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /codex-bridge bundle <task-id>/);
    assert.match(result.stdout, /--output <path>/);
    assert.match(result.stdout, /--no-include-rollout/);
  });
});
