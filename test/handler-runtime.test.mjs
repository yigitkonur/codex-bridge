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
import { buildTaskRequest, buildTaskRuntimeSummary, renderQueuedTaskLaunch, runBridgeTask } from "../src/lib/task-runtime.mjs";
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

test("queued task launch renders worktree base ref source", () => {
  const output = renderQueuedTaskLaunch({
    title: "Codex Task",
    jobId: "task-123",
    runtime: {
      effective: {
        mode: "plan",
        effort: "high",
        model: "gpt-5.5-codex",
      },
      warnings: [],
    },
    worktree: {
      base_ref: "main",
      base_ref_source: "cli-flag",
    },
  });

  assert.match(output, /Codex Task started in the background as task-123/);
  assert.match(output, /Runtime: mode=plan effort=high model=gpt-5\.5-codex\./);
  assert.match(output, /Worktree base: main \(cli-flag\)\./);
});

test("runtime summary exposes per-stage models for dispatch envelopes", () => {
  const runtime = buildTaskRuntimeSummary(
    buildTaskRequest({
      cwd: "/tmp/repo",
      stateCwd: "/tmp/repo",
      prompt: "edit the project",
      write: true,
      readOnly: false,
      resumeLast: false,
      jobId: "task-runtime-summary",
      mode: "default",
      model: "gpt-5.5-codex",
      effort: "high",
      noPipeline: false,
      backend: "codex",
    }),
    {
      mode: "plan",
      model: "gpt-5.4",
      effort: "xhigh",
      auto_review: true,
      post_task_prompt: "check completeness",
    },
  );

  assert.deepEqual(runtime.requested, {
    mode: "default",
    model: "gpt-5.5-codex",
    effort: "high",
  });
  assert.equal(runtime.effective.mode, "default");
  assert.equal(runtime.effective.model, "gpt-5.5-codex");
  assert.equal(runtime.effective.effort, "high");
  assert.deepEqual(runtime.models, {
    assistant: "gpt-5.5-codex",
    review: "gpt-5.5-codex",
    fix: "gpt-5.5-codex",
    check: "gpt-5.5-codex",
  });
  assert.deepEqual(runtime.pipeline, ["diff", "review", "fix", "check"]);
  assert.deepEqual(runtime.warnings, []);
});

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

test("plan-mode task honors explicit model and effort", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-plan-runtime-"));
  const repo = path.join(tempRoot, "repo");
  initGitRepo(repo);
  const binDir = makeFakeCodexBin(tempRoot);
  const jobId = "task-plan-runtime";
  let capturedOptions = null;

  await withEnv(
    {
      CODEX_BRIDGE_PLUGIN_DATA: path.join(tempRoot, "plugin-data"),
      CODEX_COMPANION_SESSION_ID: undefined,
      HOME: path.join(tempRoot, "home"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    async () => {
      _setCodexAdapterRuntimeForTest({
        async runTurn(cwd, options) {
          capturedOptions = options;
          assert.equal(cwd, repo);
          const threadId = "thread-plan-runtime";
          options.onTurnStart?.({
            threadId,
            turnId: "turn-plan-runtime",
            promptLength: options.prompt.length,
            promptPreview: options.prompt.slice(0, 80),
            turnParams: {
              model: options.model,
              effort: options.effort,
              collaborationMode: options.collaborationMode,
              sandboxPolicy: options.sandboxPolicy,
              turnTimeoutMs: options.turnTimeoutMs,
            },
          });
          return {
            status: 0,
            threadId,
            turnId: "turn-plan-runtime",
            finalMessage: "[PLAN]\n1. Make the requested change.",
            planDetected: true,
            planText: "[PLAN]\n1. Make the requested change.",
            reasoningSummary: [],
            touchedFiles: [],
          };
        },
      });
      try {
        const execution = await runBridgeTask(buildTaskRequest({
          cwd: repo,
          stateCwd: repo,
          prompt: "plan the requested change",
          write: true,
          readOnly: false,
          resumeLast: false,
          jobId,
          mode: "plan",
          model: "gpt-5.5-codex",
          effort: "high",
          noPipeline: true,
          backend: "codex",
        }));

        assert.equal(execution.payload.phase, "plan-pending");
        assert.equal(capturedOptions.model, "gpt-5.5-codex");
        assert.equal(capturedOptions.effort, "high");
        assert.equal(capturedOptions.collaborationMode.mode, "plan");
        assert.equal(capturedOptions.collaborationMode.settings.model, "gpt-5.5-codex");
        assert.equal(capturedOptions.collaborationMode.settings.reasoning_effort, "high");
        assert.equal(execution.payload.runtime.effective.mode, "plan");
        assert.equal(execution.payload.runtime.effective.model, "gpt-5.5-codex");
        assert.equal(execution.payload.runtime.effective.effort, "high");
        assert.equal(execution.payload.runtime.models.plan, "gpt-5.5-codex");

        const events = fs.readFileSync(execution.session.eventsPath, "utf8");
        assert.match(events, /\[DIRECTIVES\].*mode=plan/);
        assert.match(events, /\[DIRECTIVES\].*effort=high/);
        assert.match(events, /model=gpt-5\.5-codex/);
        assert.match(events, /models=.*plan:gpt-5\.5-codex/);
      } finally {
        _resetCodexAdapterRuntimeForTest();
      }
    },
  );
});

test("no-pipeline write task keeps diff capture while skipping validation stages", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-no-pipeline-"));
  const repo = path.join(tempRoot, "repo");
  initGitRepo(repo);
  const binDir = makeFakeCodexBin(tempRoot);
  const jobId = "task-no-pipeline-diff";
  let runTurnCalls = 0;

  await withEnv(
    {
      CODEX_BRIDGE_PLUGIN_DATA: path.join(tempRoot, "plugin-data"),
      CODEX_COMPANION_SESSION_ID: undefined,
      HOME: path.join(tempRoot, "home"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    async () => {
      _setCodexAdapterRuntimeForTest({
        async runTurn(cwd, options) {
          runTurnCalls += 1;
          assert.equal(cwd, repo);
          assert.match(options.prompt, /write a file/);
          fs.writeFileSync(path.join(repo, "changed.txt"), "changed\n", "utf8");
          return {
            status: 0,
            threadId: "thread-no-pipeline-diff",
            turnId: `turn-no-pipeline-diff-${runTurnCalls}`,
            finalMessage: "worker complete",
            reasoningSummary: [],
            touchedFiles: ["changed.txt"],
          };
        },
      });
      try {
        const execution = await runBridgeTask(buildTaskRequest({
          cwd: repo,
          stateCwd: repo,
          prompt: "write a file",
          write: true,
          readOnly: false,
          resumeLast: false,
          jobId,
          mode: "default",
          noPipeline: true,
          backend: "codex",
        }));

        assert.equal(execution.exitStatus, 0);
        assert.equal(runTurnCalls, 1);
        assert.equal(fs.readFileSync(path.join(repo, "changed.txt"), "utf8"), "changed\n");
        assert.deepEqual(execution.pipeline?.completedStages, ["diff"]);

        const events = fs.readFileSync(execution.session.eventsPath, "utf8");
        assert.match(events, /\[PIPELINE:diff\]/);
        assert.match(events, /\[PIPELINE:diff:done\]/);
        assert.match(events, /\[PIPELINE:done\]/);
        assert.match(events, /\[DONE\].*task_diff: (1 touched file|1 files \| \+1 -0)/);
        assert.match(events, /workspace_diff: 1 files \| \+1 -0/);
        assert.doesNotMatch(events, /\[PIPELINE:review\]/);
        assert.doesNotMatch(events, /\[PIPELINE:check\]/);
      } finally {
        _resetCodexAdapterRuntimeForTest();
      }
    },
  );
});

test("task runtime emits branch switched event when checkout moves mid-task", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-branch-switch-"));
  const repo = path.join(tempRoot, "repo");
  initGitRepo(repo);
  execFileSync("git", ["branch", "-M", "main"], { cwd: repo });
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["checkout", "main"], { cwd: repo, stdio: "ignore" });
  const binDir = makeFakeCodexBin(tempRoot);

  await withEnv(
    {
      CODEX_BRIDGE_PLUGIN_DATA: path.join(tempRoot, "plugin-data"),
      CODEX_COMPANION_SESSION_ID: undefined,
      HOME: path.join(tempRoot, "home"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    async () => {
      _setCodexAdapterRuntimeForTest({
        async runTurn(cwd, options) {
          assert.equal(cwd, repo);
          assert.match(options.prompt, /observe branch movement/);
          execFileSync("git", ["checkout", "feature"], { cwd: repo, stdio: "ignore" });
          return {
            status: 0,
            threadId: "thread-branch-switch",
            turnId: "turn-branch-switch",
            finalMessage: "branch moved",
            reasoningSummary: [],
            touchedFiles: [],
          };
        },
      });
      try {
        const execution = await runBridgeTask(buildTaskRequest({
          cwd: repo,
          stateCwd: repo,
          prompt: "observe branch movement",
          write: false,
          readOnly: true,
          resumeLast: false,
          jobId: "task-branch-switch",
          mode: "default",
          noPipeline: true,
          backend: "codex",
        }));

        assert.equal(execution.exitStatus, 0);
        const events = fs.readFileSync(execution.session.eventsPath, "utf8");
        assert.match(events, /\[BRANCH_SWITCHED\]/);
        assert.match(events, /before: main/);
        assert.match(events, /after: feature/);
        assert.match(events, /detected_at: after-execute/);
        assert.match(events, /jobId: task-branch-switch/);
        const ndjson = fs.readFileSync(execution.session.ndjsonPath, "utf8");
        assert.match(ndjson, /"tag":"BRANCH_SWITCHED"/);
        assert.match(ndjson, /"before":"main"/);
        assert.match(ndjson, /"after":"feature"/);
      } finally {
        _resetCodexAdapterRuntimeForTest();
      }
    },
  );
});

test("task ndjson compacts repeated turn noise", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-event-noise-"));
  const repo = path.join(tempRoot, "repo");
  initGitRepo(repo);
  const binDir = makeFakeCodexBin(tempRoot);
  const instructions = "Plan mode developer instructions.\n".repeat(40);

  await withEnv(
    {
      CODEX_BRIDGE_PLUGIN_DATA: path.join(tempRoot, "plugin-data"),
      CODEX_COMPANION_SESSION_ID: undefined,
      HOME: path.join(tempRoot, "home"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    async () => {
      _setCodexAdapterRuntimeForTest({
        async runTurn(cwd, options) {
          assert.equal(cwd, repo);
          const threadId = "thread-event-noise";
          options.onTurnStart?.({
            threadId,
            turnId: "turn-event-noise",
            promptLength: options.prompt.length,
            promptPreview: options.prompt.slice(0, 80),
            turnParams: {
              model: "gpt-test",
              effort: "xhigh",
              collaborationMode: {
                mode: "plan",
                settings: {
                  developer_instructions: instructions,
                  extra: "kept",
                },
              },
              sandboxPolicy: { type: "workspaceWrite" },
            },
          });
          options.onItemCompleted?.({ id: "rs_1", type: "reasoning" }, { threadId });
          options.onItemCompleted?.({ id: "rs_2", type: "reasoning", summary: [] }, { threadId });
          options.onItemCompleted?.({
            id: "msg_1",
            type: "agentMessage",
            text: "done",
          }, { threadId });
          fs.writeFileSync(path.join(repo, "changed.txt"), "changed\n", "utf8");
          return {
            status: 0,
            threadId,
            turnId: "turn-event-noise",
            finalMessage: "done",
            reasoningSummary: [],
            touchedFiles: ["changed.txt"],
          };
        },
      });
      try {
        const execution = await runBridgeTask(buildTaskRequest({
          cwd: repo,
          stateCwd: repo,
          prompt: "write a file",
          write: true,
          readOnly: false,
          resumeLast: false,
          jobId: "task-event-noise",
          mode: "default",
          noPipeline: true,
          backend: "codex",
        }));

        const ndjson = fs.readFileSync(execution.session.ndjsonPath, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const itemCompleted = ndjson.filter((entry) => entry.tag === "ITEM_COMPLETED");
        assert.deepEqual(itemCompleted.map((entry) => entry.data.itemType), ["agentMessage"]);

        const turnParams = ndjson.find((entry) => entry.tag === "TURN_PARAMS");
        const settings = turnParams.data.collaborationMode.settings;
        assert.equal(settings.developer_instructions, undefined);
        assert.equal(settings.developer_instructions_length, instructions.length);
        assert.match(settings.developer_instructions_hash, /^sha256:[a-f0-9]{64}$/);
        assert.equal(settings.extra, "kept");
        assert.match(settings.developer_instructions_ref, /^developer-instructions\/[a-f0-9]{64}\.txt$/);
        assert.equal(
          fs.readFileSync(path.join(execution.session.sessionDir, settings.developer_instructions_ref), "utf8"),
          instructions,
        );

        const turnCompleted = ndjson.find((entry) => entry.tag === "TURN_COMPLETED");
        assert.equal(turnCompleted.data.reasoningStepsCount, 2);
      } finally {
        _resetCodexAdapterRuntimeForTest();
      }
    },
  );
});

test("no-pipeline write task with no new work is incomplete despite preexisting diff", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-no-pipeline-empty-"));
  const repo = path.join(tempRoot, "repo");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "dirty.txt"), "preexisting\n", "utf8");
  const binDir = makeFakeCodexBin(tempRoot);

  await withEnv(
    {
      CODEX_BRIDGE_PLUGIN_DATA: path.join(tempRoot, "plugin-data"),
      CODEX_COMPANION_SESSION_ID: undefined,
      HOME: path.join(tempRoot, "home"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    async () => {
      _setCodexAdapterRuntimeForTest({
        async runTurn(cwd, options) {
          assert.equal(cwd, repo);
          assert.match(options.prompt, /make the requested edit/);
          return {
            status: 0,
            threadId: "thread-no-pipeline-empty",
            turnId: "turn-no-pipeline-empty",
            finalMessage: "nothing changed",
            reasoningSummary: [],
            touchedFiles: [],
          };
        },
      });
      try {
        const execution = await runBridgeTask(buildTaskRequest({
          cwd: repo,
          stateCwd: repo,
          prompt: "make the requested edit",
          write: true,
          readOnly: false,
          resumeLast: false,
          jobId: "task-no-pipeline-empty",
          mode: "default",
          noPipeline: true,
          backend: "codex",
        }));

        assert.equal(execution.exitStatus, 0);
        assert.equal(execution.payload.phase, "incomplete");
        assert.equal(execution.pipeline?.complete, false);
        assert.equal(execution.pipeline?.noWorkReason, "no_files_touched");
        assert.match(execution.pipeline?.missingItems?.[0] ?? "", /no_files_touched/);

        const events = fs.readFileSync(execution.session.eventsPath, "utf8");
        assert.match(events, /\[PIPELINE:diff\]/);
        assert.match(events, /\[INCOMPLETE\]/);
        assert.match(events, /no_files_touched/);
        assert.doesNotMatch(events, /\[DONE\]/);
      } finally {
        _resetCodexAdapterRuntimeForTest();
      }
    },
  );
});

test("barren checkpoint windows emit stall warnings before terminal stall", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-stall-warning-"));
  const repo = path.join(tempRoot, "repo");
  initGitRepo(repo);
  const binDir = makeFakeCodexBin(tempRoot);

  await withEnv(
    {
      CODEX_BRIDGE_PLUGIN_DATA: path.join(tempRoot, "plugin-data"),
      CODEX_BRIDGE_CHECKPOINT_MS: "20",
      CODEX_BRIDGE_STALL_CHECKPOINTS: "3",
      CODEX_COMPANION_SESSION_ID: undefined,
      HOME: path.join(tempRoot, "home"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    async () => {
      _setCodexAdapterRuntimeForTest({
        async runTurn(cwd, options) {
          assert.equal(cwd, repo);
          const threadId = "thread-stall-warning";
          options.onTurnStart?.({
            threadId,
            turnId: "turn-stall-warning",
            promptLength: options.prompt.length,
            promptPreview: options.prompt.slice(0, 80),
            turnParams: {
              model: "gpt-test",
              effort: "high",
              collaborationMode: null,
              sandboxPolicy: { type: "workspaceWrite" },
              turnTimeoutMs: 1_000,
            },
          });
          options.onItemCompleted?.({
            type: "commandExecution",
            command: "echo initial-progress",
            status: "completed",
            exitCode: 0,
          }, { threadId });
          const eventsPath = path.join(process.env.HOME, ".codex-bridge", "sessions", `${threadId}.events`);
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            if (fs.existsSync(eventsPath) && fs.readFileSync(eventsPath, "utf8").includes("StallDetected")) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return {
            status: 0,
            threadId,
            turnId: "turn-stall-warning",
            finalMessage: "eventually finished",
            reasoningSummary: [],
            touchedFiles: ["README.md"],
          };
        },
      });
      try {
        const execution = await runBridgeTask(buildTaskRequest({
          cwd: repo,
          stateCwd: repo,
          prompt: "exercise stall warning",
          write: true,
          readOnly: false,
          resumeLast: false,
          jobId: "task-stall-warning",
          mode: "default",
          noPipeline: true,
          backend: "codex",
        }));

        const events = fs.readFileSync(execution.session.eventsPath, "utf8");
        const warningIndex = events.indexOf("[STALL_WARNING]");
        const errorIndex = events.indexOf("[ERROR]");
        assert.notEqual(warningIndex, -1, events);
        assert.notEqual(errorIndex, -1, events);
        assert.ok(warningIndex < errorIndex, events);
        assert.match(events, /remaining_until_terminal:/);
        assert.match(events, /StallDetected/);
        assert.doesNotMatch(events, /\[DONE\]/);
        assert.doesNotMatch(events, /\[PIPELINE:done\]/);
        assert.equal(execution.exitStatus, 1);
        assert.equal(execution.payload.phase, "error");
        assert.equal(execution.payload.errorCode, "StallDetected");

        const ndjson = fs.readFileSync(execution.session.ndjsonPath, "utf8");
        assert.match(ndjson, /"tag":"STALL_WARNING"/);
      } finally {
        _resetCodexAdapterRuntimeForTest();
      }
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
