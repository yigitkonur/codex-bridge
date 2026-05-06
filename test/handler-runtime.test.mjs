import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  _resetCodexAdapterRuntimeForTest,
  _setCodexAdapterRuntimeForTest,
} from "../src/adapters/codex/index.mjs";
import { handleIterate } from "../src/handlers/registry.mjs";
import { handleTaskWorker } from "../src/handlers/task.mjs";
import { readJobFile, resolveJobFile, writeJobFile } from "../src/lib/state.mjs";

function makeFakeCodexBin(root) {
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex 0.0.0-test");
  process.exit(0);
}
if (args[0] === "app-server" && args.includes("--help")) {
  console.log("Usage: codex app-server");
  process.exit(0);
}
console.error("fake codex app-server should not be invoked in handler-runtime tests");
process.exit(1);
`,
    "utf8",
  );
  fs.chmodSync(codexPath, 0o755);
  return binDir;
}

async function withEnv(updates, fn) {
  const previous = new Map();
  for (const key of Object.keys(updates)) {
    previous.set(key, process.env[key]);
    const value = updates[key];
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  let stdout = "";
  process.stdout.write = function write(chunk, encoding, callback) {
    stdout += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    if (typeof encoding === "function") encoding();
    if (typeof callback === "function") callback();
    return true;
  };
  try {
    const value = await fn();
    return { stdout, value };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function initGitRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "bridge@example.test"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Codex Bridge Test"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "base\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
}

test("task-worker executes a stored job through tracked progress", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-task-worker-"));
  const workspace = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const binDir = makeFakeCodexBin(tempRoot);
  const jobId = "task-worker-regression";

  await withEnv(
    {
      CODEX_BRIDGE_PLUGIN_DATA: path.join(tempRoot, "plugin-data"),
      CODEX_COMPANION_SESSION_ID: undefined,
      HOME: path.join(tempRoot, "home"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    async () => {
      writeJobFile(workspace, jobId, {
        id: jobId,
        kind: "task",
        kindLabel: "task",
        title: "Task worker regression",
        workspaceRoot: workspace,
        jobClass: "task",
        status: "queued",
        phase: "queued",
        write: true,
        request: {
          cwd: workspace,
          stateCwd: workspace,
          prompt: "worker prompt",
          write: true,
          readOnly: false,
          resumeLast: false,
          jobId,
          mode: "default",
          noPipeline: true,
          backend: "codex",
        },
      });

      _setCodexAdapterRuntimeForTest({
        async runTurn(cwd, options) {
          assert.equal(cwd, workspace);
          assert.match(options.prompt, /worker prompt/);
          return {
            status: 0,
            threadId: "thread-worker-regression",
            turnId: "turn-worker-regression",
            finalMessage: "worker complete",
            reasoningSummary: [],
            touchedFiles: [],
          };
        },
      });
      try {
        await handleTaskWorker([
          "--cwd",
          workspace,
          "--workspace-root",
          workspace,
          "--job-id",
          jobId,
        ]);
      } finally {
        _resetCodexAdapterRuntimeForTest();
      }

      const stored = readJobFile(resolveJobFile(workspace, jobId));
      assert.equal(stored.status, "completed");
      assert.equal(stored.threadId, "thread-worker-regression");
    },
  );
});

test("iterate prompt starts a tracked task job before task failure handling", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-iterate-runtime-"));
  const repo = path.join(tempRoot, "repo");
  initGitRepo(repo);
  const binDir = makeFakeCodexBin(tempRoot);
  const registry = path.join(tempRoot, "registry");
  const turns = [];

  await withEnv(
    {
      CODEX_BRIDGE_PLUGIN_DATA: path.join(tempRoot, "plugin-data"),
      CODEX_BRIDGE_REGISTRY: registry,
      CODEX_COMPANION_SESSION_ID: undefined,
      HOME: path.join(tempRoot, "home"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    async () => {
      _setCodexAdapterRuntimeForTest({
        async runTurn(cwd, options) {
          turns.push({ cwd, options });
          return {
            status: 1,
            threadId: "thread-iterate-regression",
            turnId: "turn-iterate-regression",
            finalMessage: "",
            stderr: "simulated task failure",
            reasoningSummary: [],
            touchedFiles: [],
            error: new Error("simulated task failure"),
          };
        },
      });
      try {
        const { stdout } = await captureStdout(() =>
          handleIterate([
            "--cwd",
            repo,
            "--max",
            "1",
            "--json",
            "exercise iterate dispatch",
          ]),
        );
        const envelope = JSON.parse(stdout);
        assert.equal(envelope.ok, true);
        assert.equal(envelope.result.status, "task-failed");
        assert.equal(envelope.result.failed_step, "read-task-completion");
        assert.equal(turns.length, 1);
        assert.notEqual(turns[0].cwd, repo);
        assert.match(turns[0].options.prompt, /exercise iterate dispatch/);

        const taskId = envelope.result.current_task_id;
        assert.match(taskId, /^task-/);
        assert.ok(fs.existsSync(path.join(registry, taskId, "meta.json")));
      } finally {
        _resetCodexAdapterRuntimeForTest();
      }
    },
  );
});
