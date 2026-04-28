import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listJobs, resolveStateFile, resolveStateDir, upsertJob } from "../src/lib/state.mjs";

function runWorker({ pluginData, cwd, jobId }) {
  const script = `
    process.env.CODEX_BRIDGE_PLUGIN_DATA = ${JSON.stringify(pluginData)};
    const { upsertJob } = await import(${JSON.stringify(new URL("../src/lib/state.mjs", import.meta.url).href)});
    upsertJob(${JSON.stringify(cwd)}, {
      id: ${JSON.stringify(jobId)},
      status: "completed",
      phase: "done",
      title: ${JSON.stringify(jobId)}
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
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

test("concurrent state writers preserve all jobs", async () => {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-state-test-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));
  process.env.CODEX_BRIDGE_PLUGIN_DATA = root;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
    const jobIds = Array.from({ length: 12 }, (_, index) => `job-${index}`);
    await Promise.all(jobIds.map((jobId) => runWorker({ pluginData: root, cwd: workspace, jobId })));

    const jobs = listJobs(workspace);
    assert.deepEqual(
      jobs.map((job) => job.id).sort(),
      jobIds.sort()
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

test("CODEX_BRIDGE_PLUGIN_DATA takes precedence over CLAUDE_PLUGIN_DATA", () => {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;
  const bridgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-preferred-state-"));
  const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-legacy-state-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));

  process.env.CODEX_BRIDGE_PLUGIN_DATA = bridgeRoot;
  process.env.CLAUDE_PLUGIN_DATA = claudeRoot;
  try {
    assert.equal(resolveStateDir(workspace).startsWith(path.join(bridgeRoot, "state")), true);
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
    fs.rmSync(bridgeRoot, { recursive: true, force: true });
    fs.rmSync(claudeRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("listJobs does not rewrite state while inspecting stale running jobs", () => {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-reaper-read-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));
  process.env.CODEX_BRIDGE_PLUGIN_DATA = root;
  try {
    const stateFile = resolveStateFile(workspace);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify({
      version: 1,
      config: {},
      jobs: [{ id: "stale", status: "running", phase: "run", pid: 99999999 }]
    }, null, 2)}\n`, "utf8");
    const before = fs.readFileSync(stateFile, "utf8");

    const jobs = listJobs(workspace);

    assert.equal(jobs[0].status, "running");
    assert.equal(fs.readFileSync(stateFile, "utf8"), before);
  } finally {
    if (previousBridgePluginData == null) {
      delete process.env.CODEX_BRIDGE_PLUGIN_DATA;
    } else {
      process.env.CODEX_BRIDGE_PLUGIN_DATA = previousBridgePluginData;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("mutating state update reaps stale jobs under the state lock", () => {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-reaper-write-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));
  process.env.CODEX_BRIDGE_PLUGIN_DATA = root;
  try {
    const stateFile = resolveStateFile(workspace);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify({
      version: 1,
      config: {},
      jobs: [{ id: "stale", status: "running", phase: "run", pid: 99999999 }]
    }, null, 2)}\n`, "utf8");

    upsertJob(workspace, { id: "fresh", status: "completed", phase: "done" });
    const jobs = listJobs(workspace);

    assert.equal(jobs.find((job) => job.id === "stale")?.status, "orphaned");
    assert.equal(jobs.find((job) => job.id === "fresh")?.status, "completed");
  } finally {
    if (previousBridgePluginData == null) {
      delete process.env.CODEX_BRIDGE_PLUGIN_DATA;
    } else {
      process.env.CODEX_BRIDGE_PLUGIN_DATA = previousBridgePluginData;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("corrupt state file is quarantined and recovered to defaults", () => {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-corrupt-state-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));
  process.env.CODEX_BRIDGE_PLUGIN_DATA = root;
  try {
    const stateFile = resolveStateFile(workspace);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, "{\n", "utf8");

    // Recovery returns defaults (empty job list) so callers can keep working.
    const jobs = listJobs(workspace);
    assert.deepEqual(jobs, []);

    // The original payload is preserved as a `.corrupt-<ts>` sibling for
    // forensic inspection.
    const stateDir = path.dirname(stateFile);
    const baseName = path.basename(stateFile);
    const siblings = fs.readdirSync(stateDir);
    const corruptSibling = siblings.find((name) =>
      name.startsWith(`${baseName}.corrupt-`)
    );
    assert.ok(
      corruptSibling,
      `expected a ${baseName}.corrupt-* sibling; saw ${siblings.join(", ")}`
    );
    assert.equal(
      fs.readFileSync(path.join(stateDir, corruptSibling), "utf8"),
      "{\n"
    );
  } finally {
    if (previousBridgePluginData == null) {
      delete process.env.CODEX_BRIDGE_PLUGIN_DATA;
    } else {
      process.env.CODEX_BRIDGE_PLUGIN_DATA = previousBridgePluginData;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
