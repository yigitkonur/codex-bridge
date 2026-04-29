// Verifies that when process A's lock is reaped as stale and process B takes
// over, A's eventual release does NOT unlink B's lock file (TOCTOU on the lock
// inode). Two child workers are orchestrated via filesystem sentinels so we
// can pin the inode that survives across A's release.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveStateDir } from "../src/lib/state.mjs";

const STATE_LOCK_FILE_NAME = "state.lock";
const STATE_MODULE_HREF = new URL("../src/lib/state.mjs", import.meta.url).href;

function spawnHoldingWorker({ pluginData, cwd, sentinelReady, sentinelGo, jobId, label }) {
  // Worker calls updateState and parks inside the mutate callback until the
  // test signals it. While parked, the worker's `acquireStateLock` is held
  // (its file descriptor is open and the lock file lives at the canonical
  // path).
  const script = `
    process.env.CODEX_BRIDGE_PLUGIN_DATA = ${JSON.stringify(pluginData)};
    const fs = await import("node:fs");
    const { updateState } = await import(${JSON.stringify(STATE_MODULE_HREF)});
    function sleepSync(ms) {
      const buffer = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(buffer), 0, 0, ms);
    }
    try {
      updateState(${JSON.stringify(cwd)}, (state) => {
        fs.writeFileSync(${JSON.stringify(sentinelReady)}, "ready", "utf8");
        const startedAt = Date.now();
        while (!fs.existsSync(${JSON.stringify(sentinelGo)})) {
          if (Date.now() - startedAt > 30000) {
            throw new Error("worker ${label} go-sentinel timed out");
          }
          sleepSync(50);
        }
        state.jobs.unshift({
          id: ${JSON.stringify(jobId)},
          status: "completed",
          phase: "done",
          updatedAt: new Date().toISOString()
        });
      });
    } catch (err) {
      console.error(err && err.stack ? err.stack : String(err));
      process.exit(1);
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return {
    child,
    done: new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `worker ${label} exited ${code}`));
      });
    })
  };
}

function waitForFile(filePath, timeoutMs = 8000) {
  const startedAt = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

function inoOf(filePath) {
  return fs.statSync(filePath).ino;
}

test("stale-lock release respects the captured inode and does not unlink another holder's lock", async () => {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-stale-toctou-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));
  process.env.CODEX_BRIDGE_PLUGIN_DATA = root;
  delete process.env.CLAUDE_PLUGIN_DATA;

  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, STATE_LOCK_FILE_NAME);

  const sentinelReadyA = path.join(root, "ready-A");
  const sentinelGoA = path.join(root, "go-A");
  const sentinelReadyB = path.join(root, "ready-B");
  const sentinelGoB = path.join(root, "go-B");

  let workerA = null;
  let workerB = null;

  try {
    // 1. Worker A acquires the state lock and parks.
    workerA = spawnHoldingWorker({
      pluginData: root,
      cwd: workspace,
      sentinelReady: sentinelReadyA,
      sentinelGo: sentinelGoA,
      jobId: "job-A",
      label: "A"
    });
    waitForFile(sentinelReadyA, 8000);

    // Confirm the lock exists and capture A's inode.
    assert.equal(fs.existsSync(lockFile), true, "worker A should have created a lock file");
    const inoA = inoOf(lockFile);

    // 2. Backdate the lock's mtime so worker B sees it as stale (>30s old).
    const stalePast = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lockFile, stalePast, stalePast);

    // 3. Worker B starts; it will see the stale lock, reap (unlink) it, and
    //    create its own lock with a fresh inode.
    workerB = spawnHoldingWorker({
      pluginData: root,
      cwd: workspace,
      sentinelReady: sentinelReadyB,
      sentinelGo: sentinelGoB,
      jobId: "job-B",
      label: "B"
    });
    waitForFile(sentinelReadyB, 8000);

    // Capture B's inode.
    const inoB = inoOf(lockFile);
    assert.notEqual(inoB, inoA, "worker B should have created a fresh lock inode after reaping A");

    // 4. Release worker A. Without the TOCTOU fix, A's release would unlink
    //    the lock file currently owned by B.
    fs.writeFileSync(sentinelGoA, "go", "utf8");
    await workerA.done;
    workerA = null;

    // 5. Verify B's lock survives A's release.
    assert.equal(
      fs.existsSync(lockFile),
      true,
      "worker B's lock file must survive worker A's release"
    );
    assert.equal(
      inoOf(lockFile),
      inoB,
      "worker B's lock inode must be unchanged after worker A's release"
    );

    // 6. Release worker B; its release should clean up its own lock.
    fs.writeFileSync(sentinelGoB, "go", "utf8");
    await workerB.done;
    workerB = null;

    assert.equal(
      fs.existsSync(lockFile),
      false,
      "worker B's release should have unlinked its own lock"
    );
  } finally {
    // Ensure no orphan child processes survive a failed assertion.
    for (const worker of [workerA, workerB]) {
      if (worker && !worker.child.killed) {
        try { worker.child.kill("SIGKILL"); } catch { /* noop */ }
      }
    }
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
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
