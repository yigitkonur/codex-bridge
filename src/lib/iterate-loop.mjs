import { mapReviewVerdictToTaskVerdict } from "./review-result.mjs";

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: error.code ?? null,
    };
  }
  if (error && typeof error === "object") {
    return {
      message: String(error.message ?? JSON.stringify(error)),
      code: error.code ?? null,
    };
  }
  return { message: String(error), code: null };
}

function artifactsFrom(...values) {
  return Object.assign(
    {},
    ...values
      .map((value) => value?.artifacts)
      .filter((value) => value && typeof value === "object" && !Array.isArray(value)),
  );
}

function taskIdFrom(value) {
  return value?.task_id ?? value?.taskId ?? value?.jobId ?? null;
}

function reviewResultFrom(value) {
  return value?.review_result ?? value?.reviewResult ?? value;
}

function verdictFrom(value) {
  return value?.verdict && typeof value.verdict === "object" ? value.verdict : value;
}

function mergeNextAction(taskId) {
  return {
    kind: "merge",
    argv: ["merge", taskId],
    description: "Merge the approved unchanged reviewed branch head.",
  };
}

function inspectNextAction(taskId, status) {
  return {
    kind: "inspect-artifacts",
    argv: ["verdict", taskId, "--json"],
    description: `${status} reached; inspect review and verdict artifacts before continuing.`,
  };
}

function failureResult({ status, max, iterations, taskId, iteration, step, error, artifacts }) {
  return {
    status,
    incomplete: true,
    iteration_max: max,
    iterations,
    current_task_id: taskId ?? null,
    failed_iteration: iteration,
    failed_step: step,
    error: serializeError(error),
    artifacts: artifacts ?? {},
    next_action: taskId ? inspectNextAction(taskId, status) : null,
  };
}

async function callStep({ status, step, max, iterations, taskId, iteration, artifacts }, fn, arg) {
  try {
    return { ok: true, value: await fn(arg) };
  } catch (error) {
    return {
      ok: false,
      value: failureResult({
        status,
        max,
        iterations,
        taskId,
        iteration,
        step,
        error,
        artifacts,
      }),
    };
  }
}

export function buildIterateFollowupPrompt({ previousTaskId, reviewResult, verdict }) {
  const findings = Array.isArray(reviewResult?.findings) ? reviewResult.findings : [];
  return [
    "Continue the existing codex-bridge task in the same worktree.",
    `Previous task: ${previousTaskId}`,
    `Review verdict: ${verdict}`,
    `Review summary: ${reviewResult?.summary ?? "No summary provided."}`,
    findings.length > 0
      ? `Findings JSON:\n${JSON.stringify(findings, null, 2)}`
      : "Findings JSON:\n[]",
    "Fix the review findings, preserve unrelated work, and leave artifacts for the next review iteration.",
  ].join("\n\n");
}

export async function runIterateLoop(options = {}) {
  const max = Number(options.max ?? 3);
  if (!Number.isInteger(max) || max < 1) {
    throw new TypeError(`runIterateLoop max must be a positive integer (got ${JSON.stringify(options.max)})`);
  }
  const deps = options.deps ?? {};
  const iterations = [];
  let taskId = options.taskId ?? null;
  let taskState = null;

  if (!taskId) {
    if (typeof deps.startTask !== "function") {
      throw new TypeError("runIterateLoop requires deps.startTask for prompt input");
    }
    const started = await callStep(
      {
        status: "task-failed",
        step: "start-task",
        max,
        iterations,
        taskId: null,
        iteration: 1,
        artifacts: {},
      },
      deps.startTask,
      {
        prompt: options.prompt,
        iteration: 1,
        write: true,
        worktree_auto: true,
      },
    );
    if (!started.ok) return started.value;
    taskState = started.value;
    taskId = taskIdFrom(taskState);
    if (!taskId) {
      return failureResult({
        status: "task-failed",
        max,
        iterations,
        taskId: null,
        iteration: 1,
        step: "start-task",
        error: new Error("startTask did not return task_id"),
        artifacts: artifactsFrom(taskState),
      });
    }
  }

  if (typeof deps.readTaskCompletion !== "function") {
    deps.readTaskCompletion = async ({ startedTask }) => startedTask ?? {};
  }
  if (typeof deps.runReview !== "function") {
    throw new TypeError("runIterateLoop requires deps.runReview");
  }
  if (typeof deps.writeVerdict !== "function") {
    throw new TypeError("runIterateLoop requires deps.writeVerdict");
  }
  if (typeof deps.startFollowup !== "function") {
    throw new TypeError("runIterateLoop requires deps.startFollowup");
  }

  for (let iteration = 1; iteration <= max; iteration += 1) {
    const taskCompletion = await callStep(
      {
        status: "task-failed",
        step: "read-task-completion",
        max,
        iterations,
        taskId,
        iteration,
        artifacts: artifactsFrom(taskState),
      },
      deps.readTaskCompletion,
      { taskId, iteration, startedTask: taskState },
    );
    if (!taskCompletion.ok) return taskCompletion.value;

    const review = await callStep(
      {
        status: "review-failed",
        step: "run-review",
        max,
        iterations,
        taskId,
        iteration,
        artifacts: artifactsFrom(taskState, taskCompletion.value),
      },
      deps.runReview,
      { taskId, iteration, task: taskCompletion.value },
    );
    if (!review.ok) return review.value;
    const reviewResult = reviewResultFrom(review.value);
    const reviewedBranchHeadSha = reviewResult?.reviewed_branch_head_sha ?? reviewResult?.branch_head_sha ?? null;

    const verdictWrite = await callStep(
      {
        status: "verdict-failed",
        step: "write-verdict",
        max,
        iterations,
        taskId,
        iteration,
        artifacts: artifactsFrom(taskState, taskCompletion.value, review.value),
      },
      deps.writeVerdict,
      { taskId, iteration, reviewResult },
    );
    if (!verdictWrite.ok) return verdictWrite.value;
    const verdict = verdictFrom(verdictWrite.value);
    let verdictValue;
    try {
      verdictValue = mapReviewVerdictToTaskVerdict(verdict);
    } catch (error) {
      return failureResult({
        status: "verdict-failed",
        max,
        iterations,
        taskId,
        iteration,
        step: "normalize-verdict",
        error,
        artifacts: artifactsFrom(taskState, taskCompletion.value, review.value, verdictWrite.value),
      });
    }

    const entry = {
      iteration,
      task_id: taskId,
      review_result: reviewResult,
      verdict,
      reviewed_branch_head_sha: reviewedBranchHeadSha,
      artifacts: artifactsFrom(taskState, taskCompletion.value, review.value, verdictWrite.value),
    };
    iterations.push(entry);

    if (verdictValue === "approved") {
      return {
        status: "approved",
        iteration_max: max,
        iterations,
        task_id: taskId,
        reviewed_branch_head_sha: reviewedBranchHeadSha,
        next_action: mergeNextAction(taskId),
      };
    }

    if (iteration >= max) {
      return {
        status: "iteration-limit",
        incomplete: true,
        iteration_max: max,
        iterations,
        current_task_id: taskId,
        reviewed_branch_head_sha: reviewedBranchHeadSha,
        artifacts: entry.artifacts,
        next_action: inspectNextAction(taskId, "iteration-limit"),
      };
    }

    const followupPrompt = buildIterateFollowupPrompt({
      previousTaskId: taskId,
      reviewResult,
      verdict: verdictValue,
    });
    const followup = await callStep(
      {
        status: "follow-up-failed",
        step: "start-follow-up",
        max,
        iterations,
        taskId,
        iteration,
        artifacts: entry.artifacts,
      },
      deps.startFollowup,
      {
        previousTaskId: taskId,
        iteration: iteration + 1,
        prompt: followupPrompt,
        reviewResult,
        verdict,
      },
    );
    if (!followup.ok) return followup.value;
    const nextTaskId = taskIdFrom(followup.value);
    if (!nextTaskId) {
      return failureResult({
        status: "follow-up-failed",
        max,
        iterations,
        taskId,
        iteration,
        step: "start-follow-up",
        error: new Error("startFollowup did not return task_id"),
        artifacts: artifactsFrom(entry, followup.value),
      });
    }
    entry.next_task_id = nextTaskId;
    if (typeof deps.markSuperseded === "function") {
      const superseded = await callStep(
        {
          status: "verdict-failed",
          step: "mark-superseded",
          max,
          iterations,
          taskId,
          iteration,
          artifacts: artifactsFrom(entry, followup.value),
        },
        deps.markSuperseded,
        {
          taskId,
          nextTaskId,
          iteration,
          verdict: verdictValue,
          reviewResult,
        },
      );
      if (!superseded.ok) return superseded.value;
      entry.artifacts = artifactsFrom(entry, superseded.value);
    }
    taskId = nextTaskId;
    taskState = followup.value;
  }

  return {
    status: "iteration-limit",
    incomplete: true,
    iteration_max: max,
    iterations,
    current_task_id: taskId,
    next_action: inspectNextAction(taskId, "iteration-limit"),
  };
}
