// Verifies that writeJsonFileAtomic cleans up its `.tmp` straggler when the
// final rename fails. This is exercised through the public `saveState` path
// (no internal export needed) by patching `fs.renameSync` to throw EXDEV inside
// a child worker. The test then inspects the worker's state directory for any
// surviving `.tmp` files alongside the absence of the final `state.json`.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveStateDir } from "../src/lib/state.mjs";

const STATE_MODULE_HREF = new URL("../src/lib/state.mjs", import.meta.url).href;

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

test("writeJsonFileAtomic sweeps the .tmp straggler when renameSync fails", async () => {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-tmp-sweep-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));

  process.env.CODEX_BRIDGE_PLUGIN_DATA = root;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
    await runFailingRenameWorker({ pluginData: root, cwd: workspace });

    const stateDir = resolveStateDir(workspace);
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
