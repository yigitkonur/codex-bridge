// Verifies that writeJsonFileAtomic cleans up its `.tmp` straggler when the
// final rename fails. This is exercised through the public `saveState` path
// (no internal export needed) by patching `fs.renameSync` to throw EXDEV inside
// a child worker. The test then inspects the worker's state directory for any
// surviving `.tmp` files alongside the absence of the final `state.json`.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const STATE_MODULE_HREF = new URL("../src/lib/state.mjs", import.meta.url).href;

function resolveStatePaths({ pluginData, cwd, jobId = null }) {
  const script = `
    process.env.CODEX_BRIDGE_PLUGIN_DATA = ${JSON.stringify(pluginData)};
    delete process.env.CLAUDE_PLUGIN_DATA;
    const mod = await import(${JSON.stringify(STATE_MODULE_HREF)});
    console.log(JSON.stringify({
      stateDir: mod.resolveStateDir(${JSON.stringify(cwd)}),
      jobFile: ${JSON.stringify(jobId)} ? mod.resolveJobFile(${JSON.stringify(cwd)}, ${JSON.stringify(jobId)}) : null,
      logFile: ${JSON.stringify(jobId)} ? mod.resolveJobLogFile(${JSON.stringify(cwd)}, ${JSON.stringify(jobId)}) : null
    }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `path resolver exited ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

function runFailingRenameWorker({ pluginData, cwd }) {
  // The worker monkey-patches `fs.renameSync` to throw EXDEV BEFORE importing
  // `state.mjs`, so the writeJsonFileAtomic path observes the failure exactly
  // once and the temp-file cleanup branch is exercised.
  const script = `
    const fs = await import("node:fs");
    const original = fs.default.renameSync;
    fs.default.renameSync = function patchedRenameSync(from, to) {
      const err = new Error("simulated EXDEV from test");
      err.code = "EXDEV";
      throw err;
    };
    process.env.CODEX_BRIDGE_PLUGIN_DATA = ${JSON.stringify(pluginData)};
    const { saveState } = await import(${JSON.stringify(STATE_MODULE_HREF)});
    let threwAsExpected = false;
    try {
      saveState(${JSON.stringify(cwd)}, { jobs: [{ id: "x", status: "completed", phase: "done" }] });
    } catch (err) {
      if (err && err.code === "EXDEV") {
        threwAsExpected = true;
      } else {
        console.error("unexpected error:", err && err.stack ? err.stack : String(err));
        process.exit(2);
      }
    } finally {
      // Restore so any subsequent fs operations (none expected) work normally.
      fs.default.renameSync = original;
    }
    if (!threwAsExpected) {
      console.error("saveState did not propagate the EXDEV error");
      process.exit(3);
    }
    process.exit(0);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `worker exited ${code}`));
      }
    });
  });
}

function runFailingPruneWorker({ pluginData, cwd }) {
  const script = `
    const fs = await import("node:fs");
    const original = fs.default.renameSync;
    fs.default.renameSync = function patchedRenameSync(from, to) {
      const err = new Error("simulated EXDEV from prune test");
      err.code = "EXDEV";
      throw err;
    };
    process.env.CODEX_BRIDGE_PLUGIN_DATA = ${JSON.stringify(pluginData)};
    const { saveState } = await import(${JSON.stringify(STATE_MODULE_HREF)});
    try {
      saveState(${JSON.stringify(cwd)}, { jobs: [] });
    } catch (err) {
      if (err && err.code === "EXDEV") process.exit(0);
      console.error(err && err.stack ? err.stack : String(err));
      process.exit(2);
    } finally {
      fs.default.renameSync = original;
    }
    console.error("saveState did not propagate EXDEV");
    process.exit(3);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `worker exited ${code}`));
    });
  });
}

test("writeJsonFileAtomic sweeps the .tmp straggler when renameSync fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-tmp-sweep-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));

  try {
    await runFailingRenameWorker({ pluginData: root, cwd: workspace });

    const { stateDir } = resolveStatePaths({ pluginData: root, cwd: workspace });
    // The state dir should exist (ensureStateDir ran before the rename
    // failure) but no `.state.json.*.tmp` straggler should remain.
    const entries = fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : [];
    const stragglers = entries.filter((name) =>
      name.startsWith(".state.json.") && name.endsWith(".tmp")
    );
    assert.deepEqual(
      stragglers,
      [],
      `expected no .tmp stragglers under ${stateDir}; saw ${entries.join(", ")}`
    );

    // The final state.json must NOT exist because the rename failed.
    assert.equal(
      fs.existsSync(path.join(stateDir, "state.json")),
      false,
      "state.json must not exist after a failed rename"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("state prune does not delete job artifacts before failed state commit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-prune-rename-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));

  try {
    const { stateDir, jobFile, logFile } = resolveStatePaths({
      pluginData: root,
      cwd: workspace,
      jobId: "old-job"
    });
    fs.mkdirSync(path.dirname(jobFile), { recursive: true });
    fs.writeFileSync(jobFile, JSON.stringify({ id: "old-job", status: "completed", logFile }), "utf8");
    fs.writeFileSync(logFile, "log\n", "utf8");
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify({
        version: 1,
        config: {},
        jobs: [{ id: "old-job", status: "completed", phase: "done", logFile }]
      }, null, 2),
      "utf8"
    );

    await runFailingPruneWorker({ pluginData: root, cwd: workspace });

    assert.equal(fs.existsSync(jobFile), true, "job detail must survive failed state commit");
    assert.equal(fs.existsSync(logFile), true, "job log must survive failed state commit");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
