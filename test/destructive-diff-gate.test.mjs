import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAutoPipeline } from "../src/adapters/codex/pipeline.mjs";
import { loadConfigLayers } from "../src/lib/config.mjs";
import { writeMeta } from "../src/lib/registry.mjs";
import { writeResponseFile } from "../src/lib/pending-requests.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");

function makeTempSession(threadId = "thread-destructive") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-destructive-diff-"));
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const ndjsonPath = path.join(sessionDir, `${threadId}.ndjson`);
  const eventsPath = path.join(sessionDir, `${threadId}.events`);
  fs.writeFileSync(ndjsonPath, "");
  fs.writeFileSync(eventsPath, "");
  return {
    root,
    session: { ndjsonPath, eventsPath, sessionDir, threadId },
  };
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  return result.stdout.trim();
}

function initRepo(root) {
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "bridge@example.test"]);
  runGit(repo, ["config", "user.name", "Codex Bridge Test"]);
  return repo;
}

function makeTurnStub(calls) {
  return async (cwd, opts) => {
    calls.push({ cwd, opts: { ...opts } });
    return {
      status: 0,
      threadId: opts.resumeThreadId ?? "thread-destructive",
      turnId: "turn-destructive",
      finalMessage: JSON.stringify({ complete: true, missing_items: [], summary: "ok" }),
      reasoningSummary: "",
      turn: { id: "turn-destructive", status: "completed" },
      error: null,
      stderr: "",
      fileChanges: [],
      touchedFiles: [],
    };
  };
}

function makeReviewStub(calls) {
  return async (cwd, opts) => {
    calls.push({ cwd, opts: { ...opts } });
    return {
      status: 0,
      threadId: "review-thread",
      sourceThreadId: "review-thread",
      turnId: "review-turn",
      reviewText: "review approved",
      reasoningSummary: "",
      turn: { id: "review-turn", status: "completed" },
      error: null,
      stderr: "",
    };
  };
}

async function answerPendingRequest(sessionDir, answer, { timeoutMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pendingFile = fs.readdirSync(sessionDir).find((name) => name.endsWith(".pending.json"));
    if (pendingFile) {
      const entry = JSON.parse(fs.readFileSync(path.join(sessionDir, pendingFile), "utf8"));
      writeResponseFile(sessionDir, entry.threadId, {
        requestId: entry.internalId,
        rpcRequestId: entry.rpcRequestId,
        payload: {
          answers: {
            [entry.firstQuestionId]: { answers: [answer] },
          },
        },
      });
      return entry;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No pending request appeared within ${timeoutMs}ms.`);
}

function setRegistryRoot(t, registryRoot) {
  const previous = process.env.CODEX_BRIDGE_REGISTRY;
  process.env.CODEX_BRIDGE_REGISTRY = registryRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_BRIDGE_REGISTRY;
    else process.env.CODEX_BRIDGE_REGISTRY = previous;
  });
}

test("destructive task-base diff pauses before review and can be rejected", async (t) => {
  const { root, session } = makeTempSession();
  setRegistryRoot(t, path.join(root, "registry"));
  try {
    const repo = initRepo(root);
    const taskId = "task-destructive-reject";
    fs.writeFileSync(path.join(repo, "large.txt"), Array.from({ length: 12 }, (_, i) => `line ${i}\n`).join(""));
    runGit(repo, ["add", "large.txt"]);
    runGit(repo, ["commit", "-m", "base"]);
    const baseSha = runGit(repo, ["rev-parse", "HEAD"]);

    fs.rmSync(path.join(repo, "large.txt"));
    runGit(repo, ["add", "-A"]);
    runGit(repo, ["commit", "-m", "delete large file"]);
    writeMeta(taskId, { base_sha: baseSha, base_ref: "main" });

    const reviewCalls = [];
    const turnCalls = [];
    const pipeline = runAutoPipeline({
      session,
      threadId: session.threadId,
      cwd: repo,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: true,
        post_task_prompt: "",
        destructive_diff_lines_deleted: 10,
        destructive_diff_files_changed: 30,
        destructive_diff_mode: "pause",
        question_answer_ms: 1_000,
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: makeTurnStub(turnCalls),
      runAppServerReview: makeReviewStub(reviewCalls),
      jobId: taskId,
      stageTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
    });

    await answerPendingRequest(session.sessionDir, "Reject");
    const result = await pipeline;

    assert.equal(reviewCalls.length, 0, "review must not run before rejected destructive diff approval");
    assert.equal(turnCalls.length, 0, "fix/check turns must not run after rejected destructive diff");
    assert.equal(result.complete, false);
    assert.equal(result.partial, true);
    assert.equal(result.failing_stage, "diff");
    assert.equal(result.reviewVerdict, "needs-attention");
    assert.match(result.missingItems.join("\n"), /Destructive diff rejected/);

    const events = fs.readFileSync(session.eventsPath, "utf8");
    assert.match(events, /\[PIPELINE:diff:large_change\].*class=destructive/);
    assert.match(events, /\[QUESTION\].*destructive diff/s);
    assert.match(events, /\[INCOMPLETE\]/);
    assert.doesNotMatch(events, /\[PIPELINE:review\]/);
    assert.doesNotMatch(events, /\[DONE\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("approved destructive diff continues to review", async (t) => {
  const { root, session } = makeTempSession("thread-destructive-approved");
  setRegistryRoot(t, path.join(root, "registry"));
  try {
    const repo = initRepo(root);
    const taskId = "task-destructive-approve";
    fs.writeFileSync(path.join(repo, "large.txt"), Array.from({ length: 12 }, (_, i) => `line ${i}\n`).join(""));
    runGit(repo, ["add", "large.txt"]);
    runGit(repo, ["commit", "-m", "base"]);
    const baseSha = runGit(repo, ["rev-parse", "HEAD"]);

    fs.rmSync(path.join(repo, "large.txt"));
    runGit(repo, ["add", "-A"]);
    runGit(repo, ["commit", "-m", "delete large file"]);
    writeMeta(taskId, { base_sha: baseSha, base_ref: "main" });

    const reviewCalls = [];
    const turnCalls = [];
    const pipeline = runAutoPipeline({
      session,
      threadId: session.threadId,
      cwd: repo,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: true,
        post_task_prompt: "",
        destructive_diff_lines_deleted: 10,
        destructive_diff_files_changed: 30,
        destructive_diff_mode: "pause",
        question_answer_ms: 1_000,
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: makeTurnStub(turnCalls),
      runAppServerReview: makeReviewStub(reviewCalls),
      jobId: taskId,
      stageTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
    });

    await answerPendingRequest(session.sessionDir, "Approve");
    const result = await pipeline;

    assert.equal(result.complete, true);
    assert.deepEqual(result.completedStages, ["diff", "review"]);
    assert.equal(reviewCalls.length, 1, "approval should allow review to continue");
    assert.equal(turnCalls.length, 0);

    const events = fs.readFileSync(session.eventsPath, "utf8");
    assert.match(events, /\[PIPELINE:diff:large_change\].*paused=true/);
    assert.match(events, /\[PIPELINE:diff:approved\]/);
    assert.match(events, /\[PIPELINE:review\]/);
    assert.match(events, /\[DONE\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("destructive direct-write commit is checked against turn start snapshot", async () => {
  const { root, session } = makeTempSession("thread-direct-destructive");
  try {
    const repo = initRepo(root);
    fs.writeFileSync(path.join(repo, "large.txt"), Array.from({ length: 12 }, (_, i) => `line ${i}\n`).join(""));
    runGit(repo, ["add", "large.txt"]);
    runGit(repo, ["commit", "-m", "base"]);
    const baseSha = runGit(repo, ["rev-parse", "HEAD"]);

    fs.rmSync(path.join(repo, "large.txt"));
    runGit(repo, ["add", "-A"]);
    runGit(repo, ["commit", "-m", "delete large file"]);

    const reviewCalls = [];
    const turnCalls = [];
    const pipeline = runAutoPipeline({
      session,
      threadId: session.threadId,
      cwd: repo,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: true,
        post_task_prompt: "",
        destructive_diff_lines_deleted: 10,
        destructive_diff_files_changed: 30,
        destructive_diff_mode: "pause",
        question_answer_ms: 1_000,
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: makeTurnStub(turnCalls),
      runAppServerReview: makeReviewStub(reviewCalls),
      turnStartSnapshot: { headSha: baseSha, porcelain: "", isoTimestamp: new Date().toISOString() },
      stageTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
    });

    await answerPendingRequest(session.sessionDir, "Reject");
    const result = await pipeline;

    assert.equal(result.complete, false);
    assert.equal(result.failing_stage, "diff");
    assert.equal(reviewCalls.length, 0);

    const events = fs.readFileSync(session.eventsPath, "utf8");
    assert.match(events, /\[PIPELINE:diff:large_change\].*class=destructive/);
    assert.doesNotMatch(events, /\[PIPELINE:review\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("destructive diff config defaults and validation are wired", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-destructive-config-"));
  try {
    const skill = path.join(root, "skill");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(skill, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(
      path.join(skill, "config.yaml"),
      [
        "codex_bridge:",
        "  destructive_diff_mode: nope",
        "  destructive_diff_lines_deleted: 0",
        "  destructive_diff_files_changed: -1",
        "",
      ].join("\n"),
      "utf8"
    );

    const layers = loadConfigLayers(skill, workspace, workspace);
    assert.equal(layers.mergedConfig.destructive_diff_mode, "pause");
    assert.equal(layers.mergedConfig.destructive_diff_lines_deleted, 1_000);
    assert.equal(layers.mergedConfig.destructive_diff_files_changed, 30);
    assert.ok(layers.diagnostics.some((d) => d.code === "CONFIG_INVALID_VALUE" && d.key === "destructive_diff_mode"));
    assert.ok(layers.diagnostics.some((d) => d.code === "CONFIG_INVALID_VALUE" && d.key === "destructive_diff_lines_deleted"));
    assert.ok(layers.diagnostics.some((d) => d.code === "CONFIG_INVALID_VALUE" && d.key === "destructive_diff_files_changed"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
