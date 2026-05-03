import assert from "node:assert/strict";
import test from "node:test";

import { runIterateLoop } from "../src/lib/iterate-loop.mjs";

function reviewResult(verdict, index = 1) {
  return {
    schema_version: "1.0",
    review_kind: "adversarial",
    verdict,
    summary: `${verdict} summary ${index}`,
    findings: verdict === "approved" ? [] : [
      {
        severity: "high",
        title: `finding ${index}`,
        body: "needs a fix",
        file: "src/example.mjs",
        line_start: index,
        line_end: index,
        confidence: 1,
        recommendation: "fix it",
      },
    ],
    next_steps: verdict === "approved" ? [] : ["fix and rerun"],
    task_id: `task-${index}`,
    reviewed_branch_head_sha: `${String(index).repeat(40)}`.slice(0, 40),
    raw_output: `raw ${verdict}`,
  };
}

function makeDeps({ reviews, fail = {} } = {}) {
  const calls = [];
  let taskCounter = 1;
  let reviewCounter = 0;
  const deps = {
    calls,
    async startTask(args) {
      calls.push(["startTask", args]);
      if (fail.startTask) throw new Error("start failed");
      const taskId = `task-${taskCounter}`;
      return {
        task_id: taskId,
        artifacts: { meta_path: `${taskId}/meta.json` },
      };
    },
    async readTaskCompletion(args) {
      calls.push(["readTaskCompletion", args]);
      if (fail.readTaskCompletion) throw new Error("task failed");
      return {
        task_id: args.taskId,
        artifacts: { events_path: `${args.taskId}.events` },
      };
    },
    async runReview(args) {
      calls.push(["runReview", args]);
      if (fail.runReview) throw new Error("review failed");
      const result = reviews[reviewCounter] ?? reviews.at(-1);
      reviewCounter += 1;
      return {
        review_result: result,
        artifacts: { review_path: `${args.taskId}/review.json` },
      };
    },
    async writeVerdict(args) {
      calls.push(["writeVerdict", args]);
      if (fail.writeVerdict) throw new Error("verdict failed");
      return {
        verdict: {
          verdict: args.reviewResult.verdict,
          summary: args.reviewResult.summary,
          branch_head_sha: args.reviewResult.reviewed_branch_head_sha,
          reviewed_branch_head_sha: args.reviewResult.reviewed_branch_head_sha,
        },
        artifacts: { verdict_path: `${args.taskId}/verdict.json` },
      };
    },
    async startFollowup(args) {
      calls.push(["startFollowup", args]);
      if (fail.startFollowup) throw new Error("follow-up failed");
      taskCounter += 1;
      const taskId = `task-${taskCounter}`;
      return {
        task_id: taskId,
        artifacts: { meta_path: `${taskId}/meta.json` },
      };
    },
    async markSuperseded(args) {
      calls.push(["markSuperseded", args]);
      if (fail.markSuperseded) throw new Error("supersede failed");
      return {
        superseded_by: args.nextTaskId,
        artifacts: { verdict_path: `${args.taskId}/verdict.json` },
      };
    },
  };
  return deps;
}

test("runIterateLoop approves immediately and returns merge next action", async () => {
  const deps = makeDeps({ reviews: [reviewResult("approved", 1)] });
  const result = await runIterateLoop({
    prompt: "implement this",
    max: 3,
    deps,
  });

  assert.equal(result.status, "approved");
  assert.equal(result.iterations.length, 1);
  assert.equal(result.iterations[0].task_id, "task-1");
  assert.equal(result.iterations[0].verdict.verdict, "approved");
  assert.equal(result.next_action.kind, "merge");
  assert.deepEqual(result.next_action.argv, ["merge", "task-1"]);
  assert.deepEqual(deps.calls[0], [
    "startTask",
    {
      prompt: "implement this",
      iteration: 1,
      write: true,
      worktree_auto: true,
    },
  ]);
});

test("runIterateLoop resumes an existing task id without starting a new task", async () => {
  const deps = makeDeps({ reviews: [reviewResult("approved", 1)] });
  const result = await runIterateLoop({
    taskId: "task-existing",
    max: 2,
    deps,
  });

  assert.equal(result.status, "approved");
  assert.equal(result.iterations[0].task_id, "task-existing");
  assert.equal(deps.calls.some(([name]) => name === "startTask"), false);
  assert.equal(deps.calls[0][0], "readTaskCompletion");
});

test("runIterateLoop starts a follow-up after needs-attention and then approves", async () => {
  const deps = makeDeps({
    reviews: [reviewResult("needs-attention", 1), reviewResult("approved", 2)],
  });
  const result = await runIterateLoop({
    prompt: "implement this",
    max: 3,
    deps,
  });

  assert.equal(result.status, "approved");
  assert.equal(result.iterations.length, 2);
  assert.equal(result.iterations[0].next_task_id, "task-2");
  assert.equal(result.iterations[1].task_id, "task-2");
  const followupCall = deps.calls.find(([name]) => name === "startFollowup");
  assert.ok(followupCall);
  assert.match(followupCall[1].prompt, /Review verdict: needs-attention/);
  assert.match(followupCall[1].prompt, /Findings JSON/);
  const supersededCall = deps.calls.find(([name]) => name === "markSuperseded");
  assert.ok(supersededCall);
  assert.deepEqual(supersededCall[1], {
    taskId: "task-1",
    nextTaskId: "task-2",
    iteration: 1,
    verdict: "needs-attention",
    reviewResult: reviewResult("needs-attention", 1),
  });
});

test("runIterateLoop enforces max iterations for repeated must-fix verdicts", async () => {
  const deps = makeDeps({
    reviews: [reviewResult("must-fix", 1), reviewResult("must-fix", 2)],
  });
  const result = await runIterateLoop({
    prompt: "implement this",
    max: 2,
    deps,
  });

  assert.equal(result.status, "iteration-limit");
  assert.equal(result.incomplete, true);
  assert.equal(result.iterations.length, 2);
  assert.equal(result.iterations[0].next_task_id, "task-2");
  assert.equal(result.iterations[1].next_task_id, undefined);
  assert.equal(deps.calls.filter(([name]) => name === "startFollowup").length, 1);
  assert.equal(deps.calls.filter(([name]) => name === "markSuperseded").length, 1);
});

test("runIterateLoop returns task-failed with artifacts when task completion fails", async () => {
  const deps = makeDeps({
    reviews: [reviewResult("approved", 1)],
    fail: { readTaskCompletion: true },
  });
  const result = await runIterateLoop({
    prompt: "implement this",
    max: 2,
    deps,
  });

  assert.equal(result.status, "task-failed");
  assert.equal(result.failed_step, "read-task-completion");
  assert.equal(result.artifacts.meta_path, "task-1/meta.json");
});

test("runIterateLoop returns review-failed when review execution fails", async () => {
  const deps = makeDeps({
    reviews: [reviewResult("approved", 1)],
    fail: { runReview: true },
  });
  const result = await runIterateLoop({
    prompt: "implement this",
    max: 2,
    deps,
  });

  assert.equal(result.status, "review-failed");
  assert.equal(result.failed_step, "run-review");
  assert.equal(result.artifacts.events_path, "task-1.events");
});

test("runIterateLoop returns verdict-failed when verdict persistence fails", async () => {
  const deps = makeDeps({
    reviews: [reviewResult("approved", 1)],
    fail: { writeVerdict: true },
  });
  const result = await runIterateLoop({
    prompt: "implement this",
    max: 2,
    deps,
  });

  assert.equal(result.status, "verdict-failed");
  assert.equal(result.failed_step, "write-verdict");
  assert.equal(result.artifacts.review_path, "task-1/review.json");
});

test("runIterateLoop returns follow-up-failed when redispatch fails", async () => {
  const deps = makeDeps({
    reviews: [reviewResult("needs-attention", 1)],
    fail: { startFollowup: true },
  });
  const result = await runIterateLoop({
    prompt: "implement this",
    max: 2,
    deps,
  });

  assert.equal(result.status, "follow-up-failed");
  assert.equal(result.failed_step, "start-follow-up");
  assert.equal(result.iterations.length, 1);
  assert.equal(result.artifacts.verdict_path, "task-1/verdict.json");
});

test("runIterateLoop returns verdict-failed when superseded marker persistence fails", async () => {
  const deps = makeDeps({
    reviews: [reviewResult("needs-attention", 1)],
    fail: { markSuperseded: true },
  });
  const result = await runIterateLoop({
    prompt: "implement this",
    max: 2,
    deps,
  });

  assert.equal(result.status, "verdict-failed");
  assert.equal(result.failed_step, "mark-superseded");
  assert.equal(result.iterations.length, 1);
  assert.equal(result.iterations[0].next_task_id, "task-2");
});
