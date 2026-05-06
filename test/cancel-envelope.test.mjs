import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createSubagentWorktree, pruneWorktreeOnCancel } from "../src/lib/git.mjs";
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

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function makeGitWorkspace(root) {
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  runGit(workspace, ["init", "-b", "main"]);
  runGit(workspace, ["config", "user.email", "test@example.com"]);
  runGit(workspace, ["config", "user.name", "test"]);
  fs.writeFileSync(path.join(workspace, "README.md"), "# test\n", "utf8");
  runGit(workspace, ["add", "README.md"]);
  runGit(workspace, ["commit", "-m", "initial"]);
  return workspace;
}

function withRegistry(registry, callback) {
  const previous = process.env.CODEX_BRIDGE_REGISTRY;
  process.env.CODEX_BRIDGE_REGISTRY = registry;
  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_BRIDGE_REGISTRY;
    } else {
      process.env.CODEX_BRIDGE_REGISTRY = previous;
    }
  }
}

function branchExists(cwd, branch) {
  return runGit(cwd, ["branch", "--list", branch]) !== "";
}

function restoreEnv(name, previous) {
  if (previous == null) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

function withCancelableWorktreeJob({ rootPrefix, jobId, threadId }, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), rootPrefix));
  const pluginData = path.join(root, "plugin-data");
  const registry = path.join(root, "registry");
  const sessionDir = path.join(root, "sessions");
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;

  process.env.CODEX_BRIDGE_PLUGIN_DATA = pluginData;
  delete process.env.CLAUDE_PLUGIN_DATA;

  let child = null;
  let workspace = null;
  let worktree = null;
  try {
    workspace = makeGitWorkspace(root);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "config.yaml"),
      `session_dir: ${JSON.stringify(sessionDir)}\n`,
      "utf8"
    );

    worktree = createSubagentWorktree({ cwd: workspace, taskId: jobId, backend: "codex" });
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

    child = spawnSacrificialChild();
    upsertJob(workspace, {
      id: jobId,
      sessionId: "test-session",
      jobClass: "task",
      kindLabel: "task",
      title: "Codex Task",
      status: "running",
      phase: "running",
      pid: child.pid,
      threadId,
      backend: "codex",
      worktree,
      isolation_mode: worktree.isolation_mode,
      createdAt: "2026-04-29T12:00:00.000Z",
      updatedAt: "2026-04-29T12:01:00.000Z",
    });

    const env = {
      ...process.env,
      CODEX_BRIDGE_PLUGIN_DATA: pluginData,
      CODEX_BRIDGE_REGISTRY: registry,
      CODEX_BRIDGE_NO_UPDATE_CHECK: "1"
    };
    delete env.CLAUDE_PLUGIN_DATA;
    callback({ workspace, worktree, jobId, env });
  } finally {
    ensureChildKilled(child);
    if (workspace && worktree) {
      try {
        pruneWorktreeOnCancel({ cwd: workspace, taskId: jobId, branch: worktree.branch, path: worktree.path });
      } catch {
        // Best-effort test cleanup.
      }
    }
    restoreEnv("CODEX_BRIDGE_PLUGIN_DATA", previousBridgePluginData);
    restoreEnv("CLAUDE_PLUGIN_DATA", previousClaudePluginData);
    fs.rmSync(root, { recursive: true, force: true });
  }
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
});

test("cancel emits CANCELLED and releases events follow", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-cancel-event-"));
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  const sessionDir = path.join(root, "sessions");
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;

  process.env.CODEX_BRIDGE_PLUGIN_DATA = pluginData;
  delete process.env.CLAUDE_PLUGIN_DATA;

  let child = null;
  let monitor = null;
  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "config.yaml"),
      `session_dir: ${JSON.stringify(sessionDir)}\n`,
      "utf8"
    );

    child = spawnSacrificialChild();
    const job = {
      id: "task-cancel-event",
      sessionId: "test-session",
      jobClass: "task",
      kindLabel: "task",
      title: "Codex Task",
      status: "running",
      phase: "running",
      pid: child.pid,
      threadId: "thread-cancel-event",
      backend: "codex",
      createdAt: "2026-04-29T12:00:00.000Z",
      updatedAt: "2026-04-29T12:01:00.000Z",
    };
    upsertJob(workspace, job);
    fs.writeFileSync(path.join(sessionDir, `${job.threadId}.events`), "", "utf8");

    const env = {
      ...process.env,
      CODEX_BRIDGE_PLUGIN_DATA: pluginData,
      CODEX_BRIDGE_NO_UPDATE_CHECK: "1"
    };
    delete env.CLAUDE_PLUGIN_DATA;

    let monitorStdout = "";
    let monitorStderr = "";
    monitor = spawn(
      process.execPath,
      [bridgePath, "events", job.id, "--json", "--follow", "--timeout-ms", "1500", "--cwd", workspace],
      { cwd: workspace, env }
    );
    monitor.stdout.on("data", (chunk) => { monitorStdout += chunk.toString(); });
    monitor.stderr.on("data", (chunk) => { monitorStderr += chunk.toString(); });

    await new Promise((resolve) => setTimeout(resolve, 250));

    const cancel = spawnSync(
      process.execPath,
      [bridgePath, "cancel", job.id, "--json", "--cwd", workspace],
      { cwd: workspace, env, encoding: "utf8" }
    );
    assert.equal(cancel.status, 0, cancel.stderr || cancel.stdout);

    const close = await new Promise((resolve) => {
      monitor.on("close", (code, signal) => resolve({ code, signal }));
    });
    monitor = null;

    assert.equal(close.code, 0, monitorStderr || monitorStdout);
    const envelope = JSON.parse(monitorStdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result.followed, true);
    assert.equal(envelope.result.timedOut, false);
    assert.equal(envelope.result.terminalTag, "CANCELLED");
    assert.match(envelope.result.terminalLine, /^\[CANCELLED\] thread-cancel-event /);

    const events = fs.readFileSync(path.join(sessionDir, `${job.threadId}.events`), "utf8");
    assert.match(events, /^\[CANCELLED\] thread-cancel-event /m);
  } finally {
    if (monitor && !monitor.killed) {
      monitor.kill("SIGKILL");
    }
    ensureChildKilled(child);
    restoreEnv("CODEX_BRIDGE_PLUGIN_DATA", previousBridgePluginData);
    restoreEnv("CLAUDE_PLUGIN_DATA", previousClaudePluginData);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cancel removes worktree-auto worktree and branch by default", () => {
  withCancelableWorktreeJob({
    rootPrefix: "codex-bridge-cancel-cleanup-",
    jobId: "task-cancel-cleanup",
    threadId: "thread-cancel-cleanup",
  }, ({ workspace, worktree, jobId, env }) => {
    const result = spawnSync(
      process.execPath,
      [bridgePath, "cancel", jobId, "--json", "--cwd", workspace],
      { cwd: workspace, env, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result.cleanup?.succeeded, true);
    assert.equal(envelope.result.cleanup?.worktreeRemoved, true);
    assert.equal(envelope.result.cleanup?.branchDeleted, true);
    assert.equal(fs.existsSync(worktree.path), false, "cancel should remove the per-task worktree");
    assert.equal(branchExists(workspace, worktree.branch), false, "cancel should delete the per-task branch");
  });
});

test("cancel --keep-worktree preserves worktree-auto artifacts", () => {
  withCancelableWorktreeJob({
    rootPrefix: "codex-bridge-cancel-keep-",
    jobId: "task-cancel-keep",
    threadId: "thread-cancel-keep",
  }, ({ workspace, worktree, jobId, env }) => {
    const result = spawnSync(
      process.execPath,
      [bridgePath, "cancel", jobId, "--keep-worktree", "--json", "--cwd", workspace],
      { cwd: workspace, env, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result.cleanup?.succeeded, false);
    assert.equal(envelope.result.cleanup?.preservedWorktree, true);
    assert.equal(envelope.result.cleanup?.preservedBranch, true);
    assert.ok(
      envelope.result.warnings.includes("preserving worktree also preserves its checked-out branch"),
      "keep-worktree should explain why the branch remains too",
    );
    assert.equal(fs.existsSync(worktree.path), true, "keep-worktree should preserve the per-task worktree");
    assert.equal(branchExists(workspace, worktree.branch), true, "keep-worktree should preserve the per-task branch");
  });
});
