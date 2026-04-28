import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAutoPipeline } from "../src/lib/auto-pipeline.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const AUTO_PIPELINE_SRC = path.join(REPO_ROOT, "src", "lib", "auto-pipeline.mjs");

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

function makeReviewStub(calls) {
  return async (cwd, opts) => {
    calls.push({ cwd, opts: { ...opts } });
    return {
      status: 0,
      threadId: "review-thread",
      sourceThreadId: "review-thread",
      turnId: "review-turn",
      reviewText: "review approved — looks good",
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

test("auto-pipeline plumbs turnTimeoutMs/idleTimeoutMs into runAppServerReview", async () => {
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

test("auto-pipeline source pins per-turn watchdog at the fix-stage call site", () => {
  // The natural pipeline flow only enters the fix-stage runAppServerTurn when
  // parseReviewText returns structured findings. Native review currently
  // always returns `findings: []`, so a black-box runtime test cannot reach
  // that branch without monkey-patching internals. Pin the contract via a
  // static check on the source file: the fix-stage runAppServerTurn options
  // object must include both `turnTimeoutMs` and `idleTimeoutMs`. This guards
  // against a refactor that strips the options from the fix branch only.
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
