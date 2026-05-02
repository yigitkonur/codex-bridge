import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAutoPipeline } from "../src/adapters/codex/pipeline.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const AUTO_PIPELINE_SRC = path.join(REPO_ROOT, "src", "adapters", "codex", "pipeline.mjs");

function makeTempSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pipeline-watchdog-"));
  const threadId = "thread-watchdog";
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
  return result.stdout;
}

function makeReviewStub(calls, reviewText = "review approved \u2014 looks good") {
  return async (cwd, opts) => {
    calls.push({ cwd, opts: { ...opts } });
    return {
      status: 0,
      threadId: "review-thread",
      sourceThreadId: "review-thread",
      turnId: "review-turn",
      reviewText,
      reasoningSummary: "",
      turn: { id: "review-turn", status: "completed" },
      error: null,
      stderr: "",
    };
  };
}

function makeTurnStub(calls) {
  return async (cwd, opts) => {
    calls.push({ cwd, opts: { ...opts } });
    return {
      status: 0,
      threadId: opts.resumeThreadId ?? "thread-x",
      turnId: "turn-x",
      finalMessage: JSON.stringify({ complete: true, missing_items: [], summary: "ok" }),
      reasoningSummary: "",
      turn: { id: "turn-x", status: "completed" },
      error: null,
      stderr: "",
      fileChanges: [],
      touchedFiles: [],
    };
  };
}

test("auto-pipeline caps review withTimeout by remaining total budget", async () => {
  const { root, session } = makeTempSession();
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timeoutCalls = [];

  let nowCall = 0;
  const nowValues = [10_000, 10_000, 12_000, 12_000];
  Date.now = () => nowValues[Math.min(nowCall++, nowValues.length - 1)];
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = {
      callback,
      delay,
      args,
      cleared: false,
      unref() {
        this.unrefed = true;
      },
    };
    timeoutCalls.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };

  try {
    const reviewCalls = [];
    const turnCalls = [];

    const result = await runAutoPipeline({
      session,
      threadId: "thread-watchdog",
      cwd: root,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: true,
        post_task_prompt: "",
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: makeTurnStub(turnCalls),
      runAppServerReview: makeReviewStub(reviewCalls),
      jobId: "job-watchdog",
      stageTimeoutMs: 10_000,
      totalTimeoutMs: 7_000,
    });

    assert.equal(result.complete, true);
    assert.equal(reviewCalls.length, 1, "expected review to run");
    assert.equal(turnCalls.length, 0, "clean review must not trigger a fix turn");
    assert.deepEqual(
      timeoutCalls.map((timer) => timer.delay),
      [5_000],
      "review withTimeout must use min(stageMs, remaining total budget)"
    );
    assert.equal(
      reviewCalls[0].opts.turnTimeoutMs,
      0,
      "inner turn watchdog stays disabled when the total-budget timer owns the deadline"
    );
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-pipeline caps review, fix, and check deadlines by remaining total budget", async () => {
  const { root, session } = makeTempSession();
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timeoutCalls = [];

  let nowCall = 0;
  const nowValues = [0, 0, 0, 6_000, 9_000, 9_000, 10_500, 10_500];
  Date.now = () => nowValues[Math.min(nowCall++, nowValues.length - 1)];
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = {
      callback,
      delay,
      args,
      cleared: false,
      unref() {
        this.unrefed = true;
      },
    };
    timeoutCalls.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };

  try {
    const reviewCalls = [];
    const turnCalls = [];
    const reviewText = [
      "Review findings:",
      "- [P1] Exercise the fix stage -- src/lib/auto-pipeline.mjs:1",
      "  The fix stage should receive the remaining total budget.",
    ].join("\n");

    const result = await runAutoPipeline({
      session,
      threadId: "thread-watchdog",
      cwd: root,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: true,
        post_task_prompt: "Confirm completion in JSON.",
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: makeTurnStub(turnCalls),
      runAppServerReview: makeReviewStub(reviewCalls, reviewText),
      jobId: "job-watchdog",
      stageTimeoutMs: 5_000,
      totalTimeoutMs: 12_000,
    });

    assert.equal(result.complete, true);
    assert.deepEqual(result.completedStages, ["diff", "review", "fix", "check"]);
    assert.equal(result.partial, false);
    assert.equal(result.failing_stage, null);
    assert.equal(result.stageTimeoutMs, 5_000);
    assert.equal(result.totalTimeoutMs, 12_000);
    assert.equal(result.reviewVerdict, "must-fix");
    assert.equal(result.reviewFindingCount, 1);
    assert.deepEqual(result.fixFilesTouched, []);
    assert.deepEqual(result.completion, { complete: true, missing_items: [], summary: "ok" });
    assert.deepEqual(result.missingItems, []);
    assert.equal(result.completionSummary, "ok");
    assert.equal(reviewCalls.length, 1, "expected one review call");
    assert.equal(turnCalls.length, 2, "expected fix and check turns");
    assert.deepEqual(
      timeoutCalls.map((timer) => timer.delay),
      [5_000, 3_000, 1_500],
      "each stage withTimeout must use min(stageMs, remaining total budget)"
    );
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-pipeline does not start review when total budget is already exhausted", async () => {
  const { root, session } = makeTempSession();
  const originalDateNow = Date.now;
  let nowCall = 0;
  const nowValues = [20_000, 20_100, 20_100];
  Date.now = () => nowValues[Math.min(nowCall++, nowValues.length - 1)];

  try {
    const reviewCalls = [];
    const turnCalls = [];

    const result = await runAutoPipeline({
      session,
      threadId: "thread-watchdog",
      cwd: root,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: true,
        post_task_prompt: "",
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: makeTurnStub(turnCalls),
      runAppServerReview: makeReviewStub(reviewCalls),
      jobId: "job-watchdog",
      stageTimeoutMs: 5_000,
      totalTimeoutMs: 100,
    });

    assert.equal(result.complete, false);
    assert.deepEqual(result.completedStages, ["diff"]);
    assert.match(result.error, /Auto-pipeline exceeded/);
    assert.equal(reviewCalls.length, 0, "review must not start with no total budget remaining");
    assert.equal(turnCalls.length, 0, "no follow-up turn should start after total budget exhaustion");
  } finally {
    Date.now = originalDateNow;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-pipeline plumbs turnTimeoutMs/idleTimeoutMs into runAppServerReview", async () => {
  const { root, session } = makeTempSession();
  try {
    const reviewCalls = [];
    const turnCalls = [];

    // 500 was the suggested floor in the plan; use 5_000 so the
    // 500ms inner-grace subtraction still yields a positive
    // per-turn budget the inner watchdog can act on.
    const stageMs = 5_000;

    const result = await runAutoPipeline({
      session,
      threadId: "thread-watchdog",
      cwd: root,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: true,
        // No post_task_prompt — skip completion check for this assertion.
        post_task_prompt: "",
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: makeTurnStub(turnCalls),
      runAppServerReview: makeReviewStub(reviewCalls),
      jobId: "job-watchdog",
      stageTimeoutMs: stageMs,
      totalTimeoutMs: stageMs * 4,
    });

    assert.equal(reviewCalls.length, 1, "expected runAppServerReview to be called once");
    assert.equal(turnCalls.length, 0, "clean native review must not trigger a fix turn");
    assert.equal(result.complete, true, "clean native review should approve");
    const reviewOpts = reviewCalls[0].opts;
    assert.equal(
      typeof reviewOpts.turnTimeoutMs,
      "number",
      "review call must receive turnTimeoutMs"
    );
    assert.ok(
      reviewOpts.turnTimeoutMs > 0 && reviewOpts.turnTimeoutMs <= stageMs,
      `review turnTimeoutMs must be a positive value derived from stageMs (got ${reviewOpts.turnTimeoutMs})`
    );
    assert.equal(
      typeof reviewOpts.idleTimeoutMs,
      "number",
      "review call must receive idleTimeoutMs"
    );
    assert.ok(
      reviewOpts.idleTimeoutMs > 0 && reviewOpts.idleTimeoutMs <= stageMs,
      `review idleTimeoutMs must be a positive value derived from stageMs (got ${reviewOpts.idleTimeoutMs})`
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-pipeline lets issue language override generic native review approval", async () => {
  const { root, session } = makeTempSession();
  try {
    const reviewCalls = [];
    const turnCalls = [];
    const stageMs = 5_000;
    const reviewText =
      "Approved. Looks good overall, but there is one issue: this should not auto-approve.";

    const result = await runAutoPipeline({
      session,
      threadId: "thread-watchdog",
      cwd: root,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: true,
        post_task_prompt: "",
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: makeTurnStub(turnCalls),
      runAppServerReview: makeReviewStub(reviewCalls, reviewText),
      jobId: "job-watchdog",
      stageTimeoutMs: stageMs,
      totalTimeoutMs: stageMs * 4,
    });

    assert.equal(reviewCalls.length, 1, "expected native review to run once");
    assert.equal(turnCalls.length, 0, "unparsed review findings must not run a blind fix turn");
    assert.equal(result.complete, false);
    assert.deepEqual(result.completedStages, ["diff", "review"]);
    assert.deepEqual(result.missingItems, [
      "Native review reported needs-attention but did not include parseable file/line findings, so auto-fix could not run.",
    ]);
    assert.equal(result.completionSummary, "native review needs attention");

    const events = fs.readFileSync(session.eventsPath, "utf8");
    assert.match(events, /\[PIPELINE:review:done\].*verdict=needs-attention findings=0/);
    assert.match(events, /\[INCOMPLETE\]/);
    assert.doesNotMatch(events, /\[DONE\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-pipeline keeps explicit no-issue native review wording clean", async () => {
  const cases = [
    { name: "no issues", reviewText: "No issues found. Looks good overall." },
    { name: "findings none", reviewText: "Findings: none\nNo changes requested." },
  ];

  for (const { name, reviewText } of cases) {
    const { root, session } = makeTempSession();
    try {
      const reviewCalls = [];
      const turnCalls = [];
      const stageMs = 5_000;

      const result = await runAutoPipeline({
        session,
        threadId: "thread-watchdog",
        cwd: root,
        config: {
          model: "gpt-5.4",
          effort: "xhigh",
          auto_review: true,
          post_task_prompt: "",
        },
        scriptPath: "/fake/script.mjs",
        rootDir: REPO_ROOT,
        runAppServerTurn: makeTurnStub(turnCalls),
        runAppServerReview: makeReviewStub(reviewCalls, reviewText),
        jobId: `job-watchdog-${name.replace(/\s+/g, "-")}`,
        stageTimeoutMs: stageMs,
        totalTimeoutMs: stageMs * 4,
      });

      assert.equal(reviewCalls.length, 1, `${name}: expected native review to run once`);
      assert.equal(turnCalls.length, 0, `${name}: clean native review must not trigger a fix turn`);
      assert.equal(result.complete, true, `${name}: explicit clean review should approve`);
      assert.deepEqual(result.completedStages, ["diff", "review"], `${name}: unexpected stages`);

      const events = fs.readFileSync(session.eventsPath, "utf8");
      assert.match(events, /\[PIPELINE:review:done\].*verdict=approved findings=0/);
      assert.match(events, /\[DONE\]/);
      assert.doesNotMatch(events, /\[INCOMPLETE\]/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("auto-pipeline parses native review findings and runs the fix stage", async () => {
  const { root, session } = makeTempSession();
  try {
    const reviewCalls = [];
    const turnCalls = [];
    const stageMs = 5_000;
    const reviewText = [
      "Review findings:",
      "- [P1] Preserve actionable native review findings \u2014 src/lib/auto-pipeline.mjs:123-124",
      "  The native review identified a real issue that must be fixed.",
    ].join("\n");

    const result = await runAutoPipeline({
      session,
      threadId: "thread-watchdog",
      cwd: root,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: true,
        post_task_prompt: "",
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: makeTurnStub(turnCalls),
      runAppServerReview: makeReviewStub(reviewCalls, reviewText),
      jobId: "job-watchdog",
      stageTimeoutMs: stageMs,
      totalTimeoutMs: stageMs * 4,
    });

    assert.equal(reviewCalls.length, 1, "expected native review to run once");
    assert.equal(turnCalls.length, 1, "structured native finding must trigger one fix turn");
    assert.deepEqual(result.completedStages, ["diff", "review", "fix"]);
    assert.equal(result.complete, true);

    const fixPrompt = turnCalls[0].opts.prompt;
    assert.match(fixPrompt, /^Fix the following review findings:/);
    assert.match(
      fixPrompt,
      /^- \[P1\] Preserve actionable native review findings at src\/lib\/auto-pipeline\.mjs:123-124$/m
    );
    assert.match(
      fixPrompt,
      /Recommendation: The native review identified a real issue that must be fixed\./
    );

    const events = fs.readFileSync(session.eventsPath, "utf8");
    assert.match(events, /\[PIPELINE:review:done\].*verdict=must-fix findings=1/);
    assert.match(events, /\[PIPELINE:fix:done\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-pipeline reports fix-stage edits to files already dirty before fix", async () => {
  const { root, session } = makeTempSession();
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    runGit(repo, ["init"]);
    runGit(repo, ["config", "user.email", "bridge@example.test"]);
    runGit(repo, ["config", "user.name", "Codex Bridge Test"]);

    fs.writeFileSync(path.join(repo, "existing.txt"), "base\n");
    runGit(repo, ["add", "existing.txt"]);
    runGit(repo, ["commit", "-m", "initial"]);

    fs.writeFileSync(path.join(repo, "existing.txt"), "base\npre-fix dirty\n");

    const reviewCalls = [];
    const turnCalls = [];
    const stageMs = 5_000;
    const reviewText = [
      "Review findings:",
      "- [P1] Update already dirty file \u2014 existing.txt:2",
      "  The existing dirty file still needs a fix.",
    ].join("\n");

    const result = await runAutoPipeline({
      session,
      threadId: "thread-watchdog",
      cwd: repo,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: true,
        post_task_prompt: "",
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: async (cwd, opts) => {
        turnCalls.push({ cwd, opts: { ...opts } });
        fs.appendFileSync(path.join(cwd, "existing.txt"), "fixed\n");
        fs.writeFileSync(path.join(cwd, "new-file.txt"), "new during fix\n");
        return {
          status: 0,
          threadId: opts.resumeThreadId ?? "thread-x",
          turnId: "turn-x",
          finalMessage: JSON.stringify({ complete: true, missing_items: [], summary: "ok" }),
          reasoningSummary: "",
          turn: { id: "turn-x", status: "completed" },
          error: null,
          stderr: "",
          fileChanges: [],
          touchedFiles: [],
        };
      },
      runAppServerReview: makeReviewStub(reviewCalls, reviewText),
      jobId: "job-watchdog",
      stageTimeoutMs: stageMs,
      totalTimeoutMs: stageMs * 4,
    });

    assert.equal(reviewCalls.length, 1, "expected native review to run once");
    assert.equal(turnCalls.length, 1, "structured native finding must trigger one fix turn");
    assert.equal(result.complete, true);
    assert.deepEqual(result.completedStages, ["diff", "review", "fix"]);
    assert.deepEqual([...result.touchedFiles].sort(), ["existing.txt", "new-file.txt"]);

    const entries = fs.readFileSync(session.ndjsonPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const completeEntry = entries.find((entry) => entry.tag === "PIPELINE_COMPLETE");
    assert.ok(completeEntry, "expected PIPELINE_COMPLETE entry");
    assert.deepEqual(
      [...completeEntry.data.touchedFiles].sort(),
      ["existing.txt", "new-file.txt"]
    );

    const events = fs.readFileSync(session.eventsPath, "utf8");
    assert.match(events, /\[PIPELINE:fix:done\].*existing\.txt/);
    assert.match(events, /\[PIPELINE:fix:done\].*new-file\.txt/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-pipeline treats failed fix turn status as terminal failure", async () => {
  const { root, session } = makeTempSession();
  try {
    const reviewCalls = [];
    const turnCalls = [];
    const stageMs = 5_000;
    const reviewText = [
      "Review findings:",
      "- [P1] Preserve actionable native review findings \u2014 src/lib/auto-pipeline.mjs:123-124",
      "  The native review identified a real issue that must be fixed.",
    ].join("\n");

    const result = await runAutoPipeline({
      session,
      threadId: "thread-watchdog",
      cwd: root,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: true,
        post_task_prompt: "",
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: async (cwd, opts) => {
        turnCalls.push({ cwd, opts: { ...opts } });
        return {
          status: 1,
          threadId: opts.resumeThreadId ?? "thread-x",
          turnId: "turn-x",
          finalMessage: "",
          reasoningSummary: "",
          turn: { id: "turn-x", status: "failed" },
          error: { code: "TurnFailed", message: "fix turn did not complete" },
          stderr: "",
          fileChanges: [],
          touchedFiles: [],
        };
      },
      runAppServerReview: makeReviewStub(reviewCalls, reviewText),
      jobId: "job-watchdog",
      stageTimeoutMs: stageMs,
      totalTimeoutMs: stageMs * 4,
    });

    assert.equal(reviewCalls.length, 1, "expected native review to run once");
    assert.equal(turnCalls.length, 1, "structured native finding must trigger one fix turn");
    assert.equal(result.complete, false);
    assert.deepEqual(result.completedStages, ["diff", "review"]);
    assert.equal(result.partial, true);
    assert.equal(result.failing_stage, "fix");
    assert.equal(result.stageTimeoutMs, stageMs);
    assert.equal(result.totalTimeoutMs, stageMs * 4);
    assert.equal(result.reviewVerdict, "must-fix");
    assert.equal(result.reviewFindingCount, 1);
    assert.deepEqual(result.fixFilesTouched, []);
    assert.equal(result.completion.complete, false);
    assert.match(result.error, /auto-fix failed \(status 1: fix turn did not complete\)\./);

    const events = fs.readFileSync(session.eventsPath, "utf8");
    assert.match(events, /\[PIPELINE:fix\]/);
    assert.match(events, /\[ERROR\]/);
    assert.match(events, /\[PIPELINE:failed\]/);
    assert.doesNotMatch(events, /\[PIPELINE:fix:done\]/);
    assert.doesNotMatch(events, /\[DONE\]/);

    const entries = fs.readFileSync(session.ndjsonPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const errorEntry = entries.find((entry) => entry.tag === "PIPELINE_ERROR");
    assert.deepEqual(errorEntry?.data.completedStages, ["diff", "review"]);
    assert.equal(errorEntry?.data.failing_stage, "fix");
    assert.equal(
      entries.some((entry) => entry.tag === "PIPELINE_COMPLETE"),
      false,
      "failed fix turn must not emit a successful pipeline-complete record"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-pipeline treats failed review status as terminal failure", async () => {
  const { root, session } = makeTempSession();
  try {
    const reviewCalls = [];
    const turnCalls = [];
    const stageMs = 5_000;

    const result = await runAutoPipeline({
      session,
      threadId: "thread-watchdog",
      cwd: root,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: true,
        post_task_prompt: "",
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: makeTurnStub(turnCalls),
      runAppServerReview: async (cwd, opts) => {
        reviewCalls.push({ cwd, opts: { ...opts } });
        return {
          status: 1,
          threadId: "review-thread",
          sourceThreadId: "review-thread",
          turnId: "review-turn",
          reviewText: "",
          reasoningSummary: "",
          turn: { id: "review-turn", status: "failed" },
          error: { code: "Unauthorized", message: "review auth rejected" },
          stderr: "",
        };
      },
      jobId: "job-watchdog",
      stageTimeoutMs: stageMs,
      totalTimeoutMs: stageMs * 4,
    });

    assert.equal(reviewCalls.length, 1, "expected native review to run once");
    assert.equal(turnCalls.length, 0, "failed native review must not continue to a fix turn");
    assert.equal(result.complete, false);
    assert.deepEqual(result.completedStages, ["diff"]);
    assert.equal(result.partial, true);
    assert.equal(result.failing_stage, "review");
    assert.equal(result.stageTimeoutMs, stageMs);
    assert.equal(result.totalTimeoutMs, stageMs * 4);
    assert.equal(result.reviewVerdict, "approved");
    assert.equal(result.reviewFindingCount, 0);
    assert.deepEqual(result.fixFilesTouched, []);
    assert.equal(result.completion.complete, false);
    assert.match(result.error, /auto-review failed \(status 1: review auth rejected\)\./);

    const events = fs.readFileSync(session.eventsPath, "utf8");
    assert.match(events, /\[PIPELINE:review\]/);
    assert.match(events, /\[ERROR\].*\| Unauthorized/);
    assert.match(events, /failing_stage: review/);
    assert.match(events, /\[PIPELINE:failed\]/);
    assert.doesNotMatch(events, /\[PIPELINE:review:failed\]/);
    assert.doesNotMatch(events, /\[DONE\]/);

    const entries = fs.readFileSync(session.ndjsonPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const errorEntry = entries.find((entry) => entry.tag === "PIPELINE_ERROR");
    assert.deepEqual(errorEntry?.data.completedStages, ["diff"]);
    assert.equal(errorEntry?.data.failing_stage, "review");
    assert.match(errorEntry?.data.error, /review auth rejected/);
    assert.equal(
      entries.some((entry) => entry.tag === "PIPELINE_COMPLETE"),
      false,
      "failed review must not emit a successful pipeline-complete record"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-pipeline marks unparsed needs-attention review incomplete instead of done", async () => {
  const { root, session } = makeTempSession();
  try {
    const reviewCalls = [];
    const turnCalls = [];
    const stageMs = 5_000;
    const reviewText = [
      "needs-attention",
      "There is an issue in the change, but this review omitted file and line metadata.",
    ].join("\n");

    const result = await runAutoPipeline({
      session,
      threadId: "thread-watchdog",
      cwd: root,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: true,
        post_task_prompt: "",
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: makeTurnStub(turnCalls),
      runAppServerReview: makeReviewStub(reviewCalls, reviewText),
      jobId: "job-watchdog",
      stageTimeoutMs: stageMs,
      totalTimeoutMs: stageMs * 4,
    });

    assert.equal(reviewCalls.length, 1, "expected native review to run once");
    assert.equal(turnCalls.length, 0, "unparsed review findings must not run a blind fix turn");
    assert.equal(result.complete, false);
    assert.deepEqual(result.completedStages, ["diff", "review"]);
    assert.deepEqual(result.missingItems, [
      "Native review reported needs-attention but did not include parseable file/line findings, so auto-fix could not run.",
    ]);
    assert.equal(result.completionSummary, "native review needs attention");

    const events = fs.readFileSync(session.eventsPath, "utf8");
    assert.match(events, /\[PIPELINE:review:done\].*verdict=needs-attention findings=0/);
    assert.match(events, /\[INCOMPLETE\]/);
    assert.match(events, /Native review reported needs-attention but did not include parseable file\/line findings/);
    assert.doesNotMatch(events, /\[DONE\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-pipeline plumbs turnTimeoutMs/idleTimeoutMs into completion-check runAppServerTurn", async () => {
  const { root, session } = makeTempSession();
  try {
    const reviewCalls = [];
    const turnCalls = [];

    // 500 was the suggested floor in the plan; use 5_000 so the
    // 500ms inner-grace subtraction still yields a positive
    // per-turn budget the inner watchdog can act on.
    const stageMs = 5_000;

    await runAutoPipeline({
      session,
      threadId: "thread-watchdog",
      cwd: root,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: false,
        post_task_prompt: "Confirm completion in JSON.",
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: makeTurnStub(turnCalls),
      runAppServerReview: makeReviewStub(reviewCalls),
      jobId: "job-watchdog",
      stageTimeoutMs: stageMs,
      totalTimeoutMs: stageMs * 4,
    });

    assert.equal(reviewCalls.length, 0, "review must not run when auto_review is false");
    assert.equal(
      turnCalls.length,
      1,
      "expected one completion-check runAppServerTurn invocation"
    );
    const checkOpts = turnCalls[0].opts;
    assert.equal(
      typeof checkOpts.turnTimeoutMs,
      "number",
      "completion-check turn must receive turnTimeoutMs"
    );
    assert.ok(
      checkOpts.turnTimeoutMs > 0 && checkOpts.turnTimeoutMs <= stageMs,
      `completion-check turnTimeoutMs must be a positive value derived from stageMs (got ${checkOpts.turnTimeoutMs})`
    );
    assert.equal(
      typeof checkOpts.idleTimeoutMs,
      "number",
      "completion-check turn must receive idleTimeoutMs"
    );
    assert.ok(
      checkOpts.idleTimeoutMs > 0 && checkOpts.idleTimeoutMs <= stageMs,
      `completion-check idleTimeoutMs must be a positive value derived from stageMs (got ${checkOpts.idleTimeoutMs})`
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-pipeline marks completion-check rejection incomplete instead of done", async () => {
  const { root, session } = makeTempSession();
  try {
    const reviewCalls = [];
    const turnCalls = [];
    const stageMs = 5_000;

    const result = await runAutoPipeline({
      session,
      threadId: "thread-watchdog",
      cwd: root,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: false,
        post_task_prompt: "Confirm completion in JSON.",
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: async (cwd, opts) => {
        turnCalls.push({ cwd, opts: { ...opts } });
        throw new Error("completion check transport failed");
      },
      runAppServerReview: makeReviewStub(reviewCalls),
      jobId: "job-watchdog",
      stageTimeoutMs: stageMs,
      totalTimeoutMs: stageMs * 4,
    });

    assert.equal(reviewCalls.length, 0, "review must not run when auto_review is false");
    assert.equal(turnCalls.length, 1, "expected one completion-check turn attempt");
    assert.equal(result.complete, false);
    assert.deepEqual(result.completedStages, ["diff", "check-failed"]);
    assert.equal(result.partial, true);
    assert.equal(result.failing_stage, "check");
    assert.equal(result.stageTimeoutMs, stageMs);
    assert.equal(result.totalTimeoutMs, stageMs * 4);
    assert.equal(result.reviewVerdict, "approved");
    assert.equal(result.reviewFindingCount, 0);
    assert.deepEqual(result.fixFilesTouched, []);
    assert.deepEqual(result.completion, {
      complete: false,
      missing_items: [
        "Completion check failed before producing a result: completion check transport failed",
      ],
      summary: "completion-check failed",
    });
    assert.deepEqual(result.missingItems, [
      "Completion check failed before producing a result: completion check transport failed",
    ]);
    assert.equal(result.completionSummary, "completion-check failed");

    const events = fs.readFileSync(session.eventsPath, "utf8");
    assert.match(events, /\[PIPELINE:check:failed\].*completion check transport failed/);
    assert.match(events, /\[INCOMPLETE\]/);
    assert.match(events, /failing_stage: check/);
    assert.match(events, /Completion check failed before producing a result: completion check transport failed/);
    assert.doesNotMatch(events, /\[DONE\]/);

    const entries = fs.readFileSync(session.ndjsonPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      entries.find((entry) => entry.tag === "PIPELINE_ERROR" && entry.data.stage === "check")?.data,
      { stage: "check", error: "completion check transport failed" }
    );
    assert.equal(
      entries.find((entry) => entry.tag === "PIPELINE_COMPLETE")?.data.complete,
      false
    );
    assert.deepEqual(
      entries.find((entry) => entry.tag === "PIPELINE_COMPLETE")?.data.missingItems,
      ["Completion check failed before producing a result: completion check transport failed"]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-pipeline marks invalid completion-check JSON incomplete instead of done", async () => {
  const { root, session } = makeTempSession();
  try {
    const reviewCalls = [];
    const turnCalls = [];
    const stageMs = 5_000;

    const result = await runAutoPipeline({
      session,
      threadId: "thread-watchdog",
      cwd: root,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: false,
        post_task_prompt: "Confirm completion in JSON.",
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: async (cwd, opts) => {
        turnCalls.push({ cwd, opts: { ...opts } });
        return {
          status: 0,
          threadId: opts.resumeThreadId ?? "thread-x",
          turnId: "turn-x",
          finalMessage: "Everything looks complete.",
          reasoningSummary: "",
          turn: { id: "turn-x", status: "completed" },
          error: null,
          stderr: "",
          fileChanges: [],
          touchedFiles: [],
        };
      },
      runAppServerReview: makeReviewStub(reviewCalls),
      jobId: "job-watchdog",
      stageTimeoutMs: stageMs,
      totalTimeoutMs: stageMs * 4,
    });

    assert.equal(reviewCalls.length, 0, "review must not run when auto_review is false");
    assert.equal(turnCalls.length, 1, "expected one completion-check turn attempt");
    assert.equal(result.complete, false);
    assert.deepEqual(result.completedStages, ["diff", "check"]);
    assert.equal(result.partial, true);
    assert.equal(result.failing_stage, "check");
    assert.equal(result.stageTimeoutMs, stageMs);
    assert.equal(result.totalTimeoutMs, stageMs * 4);
    assert.equal(result.reviewVerdict, "approved");
    assert.equal(result.reviewFindingCount, 0);
    assert.deepEqual(result.fixFilesTouched, []);
    assert.equal(result.completionSummary, "completion-check invalid-json");
    assert.equal(result.missingItems.length, 1);
    assert.match(result.missingItems[0], /Completion check returned invalid JSON:/);
    assert.match(result.missingItems[0], /return JSON matching the completion schema/);

    const events = fs.readFileSync(session.eventsPath, "utf8");
    assert.match(events, /\[PIPELINE:check:done\].*complete=false missing=1/);
    assert.match(events, /\[INCOMPLETE\]/);
    assert.match(events, /failing_stage: check/);
    assert.match(events, /Completion check returned invalid JSON:/);
    assert.doesNotMatch(events, /\[DONE\]/);

    const entries = fs.readFileSync(session.ndjsonPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const completeEntry = entries.find((entry) => entry.tag === "PIPELINE_COMPLETE");
    assert.equal(completeEntry?.data.complete, false);
    assert.equal(completeEntry?.data.partial, true);
    assert.equal(completeEntry?.data.failing_stage, "check");
    assert.equal(completeEntry?.data.stageTimeoutMs, stageMs);
    assert.equal(completeEntry?.data.totalTimeoutMs, stageMs * 4);
    assert.equal(completeEntry?.data.reviewVerdict, "approved");
    assert.equal(completeEntry?.data.reviewFindingCount, 0);
    assert.deepEqual(completeEntry?.data.fixFilesTouched, []);
    assert.equal(completeEntry?.data.completionSummary, "completion-check invalid-json");
    assert.deepEqual(completeEntry?.data.completion, result.completion);
    assert.deepEqual(completeEntry?.data.missingItems, result.missingItems);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-pipeline source pins per-turn watchdog at the fix-stage call site", () => {
  // Keep a static pin alongside the runtime fix-stage tests: the fix-stage
  // runAppServerTurn options object must include both `turnTimeoutMs` and
  // `idleTimeoutMs`. This guards against a refactor that strips the options
  // from the fix branch only.
  const source = fs.readFileSync(AUTO_PIPELINE_SRC, "utf8");

  // Anchor each block on its withTimeout label literal ("auto-fix",
  // "auto-review", "completion-check"). For each label, walk back through the
  // source from the label to its preceding `runAppServerTurn(cwd, {` /
  // `runAppServerReview(cwd, {` and assert the captured slice contains the
  // turnTimeoutMs/idleTimeoutMs keys. Using a lazy `[\s\S]*?` against `\}` was
  // unreliable because nested object literals inside the options (e.g.
  // `buildCollaborationMode(...)`) close their own braces first.
  function sliceForLabel(label, callee) {
    const labelIdx = source.indexOf(`"${label}"`);
    assert.ok(labelIdx >= 0, `could not locate withTimeout label "${label}" in source`);
    const calleeMarker = `${callee}(cwd, {`;
    const calleeIdx = source.lastIndexOf(calleeMarker, labelIdx);
    assert.ok(
      calleeIdx >= 0,
      `could not locate ${callee}(cwd, { ... }) preceding "${label}"`
    );
    return source.slice(calleeIdx, labelIdx);
  }

  const fixSlice = sliceForLabel("auto-fix", "runAppServerTurn");
  assert.match(
    fixSlice,
    /turnTimeoutMs\s*:/,
    "fix-stage runAppServerTurn must pass turnTimeoutMs to the inner turn watchdog"
  );
  assert.match(
    fixSlice,
    /idleTimeoutMs\s*:/,
    "fix-stage runAppServerTurn must pass idleTimeoutMs to the inner turn watchdog"
  );

  // Also verify the same options reach the review and completion-check sites,
  // mirroring the runtime tests above so a single grep encodes the full
  // contract that "every stage call carries a per-turn watchdog".
  const reviewSlice = sliceForLabel("auto-review", "runAppServerReview");
  assert.match(reviewSlice, /turnTimeoutMs\s*:/);
  assert.match(reviewSlice, /idleTimeoutMs\s*:/);

  const checkSlice = sliceForLabel("completion-check", "runAppServerTurn");
  assert.match(checkSlice, /turnTimeoutMs\s*:/);
  assert.match(checkSlice, /idleTimeoutMs\s*:/);
});

test("auto-pipeline clamps stage timeout to remaining total budget", async () => {
  const { root, session } = makeTempSession();
  try {
    const reviewCalls = [];
    const stageMs = 5_000;
    const totalMs = 200;
    const startedAt = Date.now();

    const result = await runAutoPipeline({
      session,
      threadId: "thread-total-budget",
      cwd: root,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: true,
        post_task_prompt: "",
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: makeTurnStub([]),
      runAppServerReview: async (cwd, opts) => {
        reviewCalls.push({ cwd, opts: { ...opts } });
        return new Promise(() => {});
      },
      jobId: "job-total-budget",
      stageTimeoutMs: stageMs,
      totalTimeoutMs: totalMs,
    });

    assert.equal(result.complete, false);
    assert.deepEqual(result.completedStages, ["diff"]);
    assert.equal(result.partial, true);
    assert.equal(result.failing_stage, "pipeline-total");
    assert.equal(result.stageTimeoutMs, stageMs);
    assert.equal(result.totalTimeoutMs, totalMs);
    assert.match(result.error, /Auto-pipeline exceeded/);
    assert.ok(
      Date.now() - startedAt < 1_500,
      "pipeline should stop on total budget instead of waiting for the full stage timeout"
    );
    assert.equal(reviewCalls.length, 1);
    assert.equal(reviewCalls[0].opts.turnTimeoutMs, 0);
    assert.equal(reviewCalls[0].opts.idleTimeoutMs, 0);

    const events = fs.readFileSync(session.eventsPath, "utf8");
    assert.match(events, /\[ERROR\].*ClientTimeout/s);
    assert.match(events, /failing_stage: pipeline-total/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-pipeline surfaces fix-stage nonzero status as fix failure", async () => {
  const { root, session } = makeTempSession();
  try {
    const turnCalls = [];
    const result = await runAutoPipeline({
      session,
      threadId: "thread-fix-failure",
      cwd: root,
      config: {
        model: "gpt-5.4",
        effort: "xhigh",
        auto_review: true,
        post_task_prompt: "Confirm completion in JSON.",
      },
      scriptPath: "/fake/script.mjs",
      rootDir: REPO_ROOT,
      runAppServerTurn: async (cwd, opts) => {
        turnCalls.push({ cwd, opts: { ...opts } });
        return {
          status: 1,
          threadId: opts.resumeThreadId ?? "thread-fix-failure",
          turnId: "fix-turn",
          finalMessage: "",
          reasoningSummary: "",
          turn: { id: "fix-turn", status: "failed" },
          error: { message: "auth denied", code: "Unauthorized" },
          stderr: "",
          fileChanges: [],
          touchedFiles: [],
        };
      },
      runAppServerReview: async () => ({
        status: 0,
        threadId: "review-thread",
        sourceThreadId: "review-thread",
        turnId: "review-turn",
        reviewText: [
          "- [P1] Fix auth failure - src/example.mjs:12",
          "  Recommendation: handle the auth error."
        ].join("\n"),
        reasoningSummary: "",
        turn: { id: "review-turn", status: "completed" },
        error: null,
        stderr: "",
      }),
      jobId: "job-fix-failure",
      stageTimeoutMs: 5_000,
      totalTimeoutMs: 20_000,
    });

    assert.equal(result.complete, false);
    assert.deepEqual(result.completedStages, ["diff", "review"]);
    assert.equal(result.partial, true);
    assert.equal(result.failing_stage, "fix");
    assert.equal(result.stageTimeoutMs, 5_000);
    assert.equal(result.totalTimeoutMs, 20_000);
    assert.equal(result.reviewVerdict, "must-fix");
    assert.equal(result.reviewFindingCount, 1);
    assert.deepEqual(result.fixFilesTouched, []);
    assert.match(result.error, /auto-fix failed \(status 1: auth denied\)/);
    assert.equal(turnCalls.length, 1, "completion check must not run after a fix-stage failure");

    const events = fs.readFileSync(session.eventsPath, "utf8");
    assert.match(events, /\[ERROR\].*Unauthorized/s);
    assert.match(events, /failing_stage: fix/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
