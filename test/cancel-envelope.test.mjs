import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createSubagentWorktree } from "../src/lib/git.mjs";
import { writeMeta } from "../src/lib/registry.mjs";
import { upsertJob } from "../src/lib/state.mjs";

const bridgePath = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));

function spawnSacrificialChild() {
  // Long-running, ignores SIGTERM nothing fancy — just stays alive long
  // enough for `cancel` to hit it. setInterval keeps the event loop busy;
  // the parent will SIGTERM us via terminateProcessTree.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000);"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

function ensureChildKilled(child) {
  if (!child || child.killed) return;
  try {
    process.kill(child.pid, "SIGKILL");
  } catch {
    // Already gone — fine.
  }
}

function restoreEnv(name, previous) {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function branchExists(cwd, branch) {
  const result = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd,
    encoding: "utf8",
  });
  return result.status === 0;
}

function makeGitWorkspace(root) {
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  runGit(workspace, ["init", "-b", "main"]);
  runGit(workspace, ["config", "user.email", "test@example.com"]);
  runGit(workspace, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(workspace, "README.md"), "# test\n", "utf8");
  runGit(workspace, ["add", "README.md"]);
  runGit(workspace, ["commit", "-m", "initial"]);
  return workspace;
}

function withRegistry(registry, fn) {
  const previous = process.env.CODEX_BRIDGE_REGISTRY;
  process.env.CODEX_BRIDGE_REGISTRY = registry;
  try {
    return fn();
  } finally {
    restoreEnv("CODEX_BRIDGE_REGISTRY", previous);
  }
}

function makeCancelableWorktreeJob(root, jobId) {
  const workspace = makeGitWorkspace(root);
  const pluginData = path.join(root, "plugin-data");
  const registry = path.join(root, "registry");
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "config.yaml"),
    `session_dir: ${JSON.stringify(sessionDir)}\n`,
    "utf8",
  );

  const worktree = createSubagentWorktree({
    cwd: workspace,
    taskId: jobId,
    backend: "codex",
  });
  withRegistry(registry, () => {
    writeMeta(jobId, {
      backend: "codex",
      worktree,
      isolation_mode: worktree.isolation_mode,
      base_ref: worktree.base_ref,
      base_sha: worktree.base_sha,
      phase: "running",
    });
  });

  const child = spawnSacrificialChild();
  const job = {
    id: jobId,
    sessionId: `session-${jobId}`,
    jobClass: "task",
    kindLabel: "task",
    title: "Codex Task",
    status: "running",
    phase: "running",
    pid: child.pid,
    backend: "codex",
    registryTaskId: jobId,
    worktree,
    isolation_mode: worktree.isolation_mode,
    createdAt: "2026-04-29T12:00:00.000Z",
    updatedAt: "2026-04-29T12:01:00.000Z",
  };

  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CODEX_BRIDGE_PLUGIN_DATA = pluginData;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
    upsertJob(workspace, job);
  } finally {
    restoreEnv("CODEX_BRIDGE_PLUGIN_DATA", previousBridgePluginData);
    restoreEnv("CLAUDE_PLUGIN_DATA", previousClaudePluginData);
  }

  const env = {
    ...process.env,
    CODEX_BRIDGE_PLUGIN_DATA: pluginData,
    CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
    CODEX_BRIDGE_REGISTRY: registry,
  };
  delete env.CLAUDE_PLUGIN_DATA;

  return { workspace, pluginData, registry, sessionDir, child, job, worktree, env };
}

// Field-report P1-10 / P2-08: cancel envelope normalization.
// Asserts the documented field shape so future refactors don't quietly drop
// `cancelled`, `processTerminated`, `reason`, `warnings`, or the kind-derived
// `title` that replaces the dispatch-time "Codex Resume" / "Codex Task" label.
test("cancel emits a normalized envelope with explicit step booleans", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-cancel-envelope-"));
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  const sessionDir = path.join(root, "sessions");
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;

  process.env.CODEX_BRIDGE_PLUGIN_DATA = pluginData;
  delete process.env.CLAUDE_PLUGIN_DATA;

  let child = null;
  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "config.yaml"),
      `session_dir: ${JSON.stringify(sessionDir)}\n`,
      "utf8"
    );

    // Spawn a sacrificial alive process so resolveCancelableJob can see this
    // job as "running" instead of being reaped to "orphaned" on load. The
    // cancel handler will SIGTERM this pid via terminateProcessTree.
    child = spawnSacrificialChild();
    const job = {
      id: "task-cancel-envelope",
      sessionId: "test-session",
      jobClass: "task",
      kindLabel: "task",
      title: "Codex Resume", // simulates a --resume-last dispatch label
      status: "running",
      phase: "running",
      pid: child.pid,
      threadId: "thread-cancel-envelope",
      backend: "codex",
      createdAt: "2026-04-29T12:00:00.000Z",
      updatedAt: "2026-04-29T12:01:00.000Z",
    };
    upsertJob(workspace, job);

    const env = {
      ...process.env,
      CODEX_BRIDGE_PLUGIN_DATA: pluginData,
      CODEX_BRIDGE_NO_UPDATE_CHECK: "1"
    };
    delete env.CLAUDE_PLUGIN_DATA;

    const result = spawnSync(
      process.execPath,
      [bridgePath, "cancel", job.id, "--json", "--cwd", workspace],
      { cwd: workspace, env, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, "cancel");

    const r = envelope.result;
    assert.equal(r.jobId, job.id);
    assert.equal(r.status, "cancelled");
    assert.equal(r.cancelled, true, "cancelled bool must be present");
    assert.equal(r.processTerminated, true, "live pid → SIGTERM delivered");
    assert.equal(typeof r.turnInterruptAttempted, "boolean");
    assert.equal(typeof r.turnInterrupted, "boolean");
    assert.equal(r.reason, "cancelled-by-user");
    assert.ok(Array.isArray(r.warnings), "warnings must be an array");

    // Title normalization: dispatch-time "Codex Resume" must not leak into the
    // user-facing title; envelope reports the kind-derived label and stashes
    // the original under dispatchTitle for forensic continuity.
    assert.equal(r.title, "Codex Task", `title should be derived from kindLabel="task", got ${r.title}`);
    assert.equal(r.dispatchTitle, "Codex Resume");
    assert.equal(r.kindLabel, "task");

    // Recovery details still carry the granular interrupt + terminate fields.
    assert.ok(r.recovery && typeof r.recovery === "object");
    assert.ok(r.recovery.details && typeof r.recovery.details === "object");
    assert.equal(typeof r.recovery.details.terminateAttempted, "boolean");
    assert.equal(typeof r.recovery.details.terminateDelivered, "boolean");
  } finally {
    ensureChildKilled(child);
    restoreEnv("CODEX_BRIDGE_PLUGIN_DATA", previousBridgePluginData);
    restoreEnv("CLAUDE_PLUGIN_DATA", previousClaudePluginData);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cancel removes worktree-auto worktree and branch by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-cancel-cleanup-"));
  let fixture = null;
  try {
    fixture = makeCancelableWorktreeJob(root, "task-cancel-cleanup");

    const result = spawnSync(
      process.execPath,
      [bridgePath, "cancel", fixture.job.id, "--json", "--cwd", fixture.workspace],
      { cwd: fixture.workspace, env: fixture.env, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    const cleanup = envelope.result.cleanup;
    assert.equal(cleanup.reason, "cleaned");
    assert.equal(cleanup.succeeded, true);
    assert.equal(cleanup.worktreeRemoved, true);
    assert.equal(cleanup.branchDeleted, true);
    assert.equal(fs.existsSync(fixture.worktree.path), false);
    assert.equal(branchExists(fixture.workspace, fixture.worktree.branch), false);
  } finally {
    ensureChildKilled(fixture?.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cancel --keep-worktree preserves worktree-auto artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-cancel-keep-"));
  let fixture = null;
  try {
    fixture = makeCancelableWorktreeJob(root, "task-cancel-keep");

    const result = spawnSync(
      process.execPath,
      [bridgePath, "cancel", fixture.job.id, "--keep-worktree", "--json", "--cwd", fixture.workspace],
      { cwd: fixture.workspace, env: fixture.env, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    const cleanup = envelope.result.cleanup;
    assert.equal(cleanup.reason, "preserved-by-user");
    assert.equal(cleanup.succeeded, false);
    assert.equal(cleanup.preservedWorktree, true);
    assert.equal(cleanup.preservedBranch, true);
    assert.equal(fs.existsSync(fixture.worktree.path), true);
    assert.equal(branchExists(fixture.workspace, fixture.worktree.branch), true);
    assert.ok(envelope.result.warnings.some((warning) => warning.includes("preserving worktree")));
  } finally {
    ensureChildKilled(fixture?.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cancel --keep-branch removes the worktree but preserves the branch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-cancel-keep-branch-"));
  let fixture = null;
  try {
    fixture = makeCancelableWorktreeJob(root, "task-cancel-keep-branch");

    const result = spawnSync(
      process.execPath,
      [bridgePath, "cancel", fixture.job.id, "--keep-branch", "--json", "--cwd", fixture.workspace],
      { cwd: fixture.workspace, env: fixture.env, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    const cleanup = envelope.result.cleanup;
    assert.equal(cleanup.reason, "cleaned");
    assert.equal(cleanup.succeeded, true);
    assert.equal(cleanup.worktreeRemoved, true);
    assert.equal(cleanup.branchDeleted, false);
    assert.equal(cleanup.preservedBranch, true);
    assert.equal(fs.existsSync(fixture.worktree.path), false);
    assert.equal(branchExists(fixture.workspace, fixture.worktree.branch), true);
  } finally {
    ensureChildKilled(fixture?.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
