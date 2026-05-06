import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listJobs, resolveStateFile, upsertJob, writeJobFile } from "../src/lib/state.mjs";

const bridgePath = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-doctor-"));
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  const sessionDir = path.join(root, "sessions");
  const fakeBin = path.join(root, "bin");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(pluginData, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(workspace, "config.yaml"), `session_dir: ${JSON.stringify(sessionDir)}\n`, "utf8");
  fs.writeFileSync(path.join(workspace, "README.md"), "fixture\n", "utf8");
  run("git", ["init", "-b", "main"], { cwd: workspace });
  run("git", ["config", "user.email", "doctor@example.test"], { cwd: workspace });
  run("git", ["config", "user.name", "Doctor Test"], { cwd: workspace });
  run("git", ["add", "README.md", "config.yaml"], { cwd: workspace });
  run("git", ["commit", "-m", "initial"], { cwd: workspace });
  fs.writeFileSync(
    path.join(fakeBin, "codex"),
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === '--version') { console.log('codex 0.0.0-test'); process.exit(0); }",
      "if (process.argv[2] === 'app-server' && process.argv[3] === '--help') { console.log('app-server help'); process.exit(0); }",
      "process.exit(1);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { root, workspace, pluginData, sessionDir, fakeBin };
}

function withBridgeEnv(fixture) {
  return {
    ...process.env,
    CODEX_BRIDGE_PLUGIN_DATA: fixture.pluginData,
    CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
    CLAUDE_PLUGIN_DATA: "",
    PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH}`,
  };
}

function runBridge(fixture, args, options = {}) {
  return spawnSync(process.execPath, [bridgePath, ...args, "--cwd", fixture.workspace], {
    cwd: fixture.workspace,
    env: withBridgeEnv(fixture),
    encoding: "utf8",
    ...options,
  });
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
  } finally {
    if (previousBridgePluginData == null) delete process.env.CODEX_BRIDGE_PLUGIN_DATA;
    else process.env.CODEX_BRIDGE_PLUGIN_DATA = previousBridgePluginData;
    if (previousClaudePluginData == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousClaudePluginData;
  }
  return record;
}

function forceStateJobStatus(fixture, jobId, patch) {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  process.env.CODEX_BRIDGE_PLUGIN_DATA = fixture.pluginData;
  try {
    const stateFile = resolveStateFile(fixture.workspace);
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.jobs = state.jobs.map((job) => job.id === jobId ? { ...job, ...patch } : job);
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } finally {
    if (previousBridgePluginData == null) delete process.env.CODEX_BRIDGE_PLUGIN_DATA;
    else process.env.CODEX_BRIDGE_PLUGIN_DATA = previousBridgePluginData;
  }
}

test("doctor --json reports stale jobs, orphans, disk usage, and codex status", () => {
  const fixture = makeFixture();
  try {
    writeJob(fixture, {
      id: "task-stale-doctor",
      status: "running",
      phase: "running",
      pid: 99999999,
      threadId: "thread-stale",
    });
    forceStateJobStatus(fixture, "task-stale-doctor", { status: "running", phase: "running", pid: 99999999 });
    const worktreeRoot = path.resolve(fixture.workspace, "..", ".codex-bridge-worktrees");
    fs.mkdirSync(path.join(worktreeRoot, "task-fake-orphan"), { recursive: true });
    run("git", ["branch", "subagent/codex/task-branch-orphan"], { cwd: fixture.workspace });
    const oldFile = path.join(fixture.sessionDir, "old.events");
    fs.writeFileSync(oldFile, "[DONE] old\n", "utf8");
    fs.utimesSync(oldFile, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));

    const result = runBridge(fixture, ["doctor", "--json"]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.command, "doctor");
    const types = new Set(envelope.result.findings.map((finding) => finding.type));
    assert.ok(types.has("stale_job"));
    assert.ok(types.has("orphan_worktree"));
    assert.ok(types.has("orphan_branch"));
    assert.ok(types.has("old_session_files"));
    assert.ok(types.has("disk_usage"));
    assert.ok(types.has("codex_cli"));
    assert.equal(envelope.result.findings.find((finding) => finding.type === "stale_job").pid, 99999999);
    assert.equal(envelope.result.findings.find((finding) => finding.type === "orphan_worktree").taskId, "task-fake-orphan");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("doctor --clean --yes cleans without prompts", () => {
  const fixture = makeFixture();
  try {
    writeJob(fixture, {
      id: "task-stale-doctor",
      status: "running",
      phase: "running",
      pid: 99999999,
      threadId: "thread-stale",
    });
    forceStateJobStatus(fixture, "task-stale-doctor", { status: "running", phase: "running", pid: 99999999 });
    const worktreeRoot = path.resolve(fixture.workspace, "..", ".codex-bridge-worktrees");
    const orphanPath = path.join(worktreeRoot, "task-fake-orphan");
    fs.mkdirSync(orphanPath, { recursive: true });
    run("git", ["branch", "subagent/codex/task-branch-orphan"], { cwd: fixture.workspace });

    const result = runBridge(fixture, ["doctor", "--clean", "--yes", "--json"]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.result.cleanedCount, 3);
    assert.equal(fs.existsSync(orphanPath), false);
    const branches = spawnSync("git", ["branch", "--list", "subagent/codex/task-branch-orphan"], {
      cwd: fixture.workspace,
      encoding: "utf8",
    });
    assert.equal(branches.stdout.trim(), "");

    const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
    process.env.CODEX_BRIDGE_PLUGIN_DATA = fixture.pluginData;
    try {
      assert.equal(listJobs(fixture.workspace, { raw: true }).find((job) => job.id === "task-stale-doctor")?.status, "orphaned");
    } finally {
      if (previousBridgePluginData == null) delete process.env.CODEX_BRIDGE_PLUGIN_DATA;
      else process.env.CODEX_BRIDGE_PLUGIN_DATA = previousBridgePluginData;
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
