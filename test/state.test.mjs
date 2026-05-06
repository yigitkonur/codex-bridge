import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateFile,
  resolveStateDir,
  readJobFile,
  saveState,
  upsertJob,
  writeJobFile
} from "../src/lib/state.mjs";

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
    const jobIds = Array.from({ length: 8 }, (_, index) => `job-${index}`);
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

test("pruning caps terminal history without deleting old active jobs", () => {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-active-prune-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));
  process.env.CODEX_BRIDGE_PLUGIN_DATA = root;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
    const activeRecords = [
      {
        id: "old-running",
        status: "running",
        phase: "run",
        pid: process.pid,
        updatedAt: "2025-01-01T00:00:00.000Z",
        logFile: resolveJobLogFile(workspace, "old-running")
      },
      {
        id: "old-queued",
        status: "queued",
        phase: "queued",
        pid: process.pid,
        updatedAt: "2025-01-01T00:00:01.000Z",
        logFile: resolveJobLogFile(workspace, "old-queued")
      }
    ];

    for (const record of activeRecords) {
      fs.writeFileSync(record.logFile, `${record.id}\n`, "utf8");
      writeJobFile(workspace, record.id, record);
    }

    const terminalRecords = Array.from({ length: 60 }, (_, index) => ({
      id: `terminal-${String(index).padStart(2, "0")}`,
      status: "completed",
      phase: "done",
      pid: null,
      updatedAt: new Date(Date.UTC(2025, 0, 2, 0, 0, index)).toISOString()
    }));

    const stateFile = resolveStateFile(workspace);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      `${JSON.stringify({
        version: 1,
        config: {},
        jobs: [...activeRecords, ...terminalRecords]
      }, null, 2)}\n`,
      "utf8"
    );
    saveState(workspace, { config: {}, jobs: [...activeRecords, ...terminalRecords] });

    const jobs = listJobs(workspace, { raw: true });
    const jobIds = new Set(jobs.map((job) => job.id));
    assert.equal(jobIds.has("old-running"), true);
    assert.equal(jobIds.has("old-queued"), true);
    assert.equal(jobs.filter((job) => job.status !== "queued" && job.status !== "running").length, 50);
    assert.equal(jobs.length, 52);
    assert.equal(jobIds.has("terminal-00"), false);
    assert.equal(jobIds.has("terminal-59"), true);

    for (const record of activeRecords) {
      assert.equal(fs.existsSync(resolveJobFile(workspace, record.id)), true);
      assert.equal(fs.existsSync(record.logFile), true);
    }
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

    // Round-8 reaps stale-PID jobs in-memory in the default read view, so
    // callers observe `orphaned` immediately without a disk write. The
    // load-bearing assertion is the next line: the on-disk state file must
    // be byte-identical — read-only paths stay read-only.
    assert.equal(jobs[0].status, "orphaned");
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

test("corrupt job detail file is quarantined with a structured error", () => {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-corrupt-job-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));
  process.env.CODEX_BRIDGE_PLUGIN_DATA = root;
  try {
    const jobFile = resolveJobFile(workspace, "task-corrupt");
    fs.mkdirSync(path.dirname(jobFile), { recursive: true });
    fs.writeFileSync(jobFile, "{\n", "utf8");

    assert.throws(
      () => readJobFile(jobFile),
      (error) => {
        assert.equal(error.code, "JOB_DETAIL_CORRUPT");
        assert.equal(error.jobFile, jobFile);
        assert.ok(error.corruptPath?.startsWith(`${jobFile}.corrupt-`));
        assert.equal(fs.readFileSync(error.corruptPath, "utf8"), "{\n");
        return true;
      }
    );
    assert.equal(fs.existsSync(jobFile), false);
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
