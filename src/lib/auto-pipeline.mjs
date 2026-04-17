import fs from "node:fs";
import path from "node:path";
import {
  logNdjson,
  logEvent,
  captureGitDiff,
  writePlan,
  writeReview,
  formatDoneEvent,
  formatErrorEvent,
  formatIncompleteEvent,
  formatPipelineEvent,
} from "./session-log.mjs";
import { COMPLETION_CHECK_SCHEMA, buildCollaborationMode, buildSandboxPolicy } from "./config.mjs";

const PIPELINE_TIMEOUT_MS = 900_000; // 15 minutes total
const STAGE_TIMEOUT_MS = 300_000;    // 5 minutes per stage

function fmtSeconds(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m${rem.toString().padStart(2, "0")}s`;
}

function loadExecuteInstructions(rootDir) {
  const p = path.join(rootDir, "templates", "execute-instructions.md");
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "Execute the task autonomously. Do not ask questions. Make reasonable assumptions and proceed.";
  }
}

export async function runAutoPipeline(options) {
  const {
    session,
    threadId,
    cwd,
    config,
    scriptPath,
    rootDir,
    runAppServerTurn,
    runAppServerReview,
    jobId = null,
  } = options;

  const completedStages = [];
  const startTime = Date.now();
  const executeInstructions = loadExecuteInstructions(rootDir);

  const checkPipelineTimeout = () => {
    if (Date.now() - startTime > PIPELINE_TIMEOUT_MS) {
      throw new PipelineTimeoutError(completedStages);
    }
  };

  try {
    // Stage 1: Capture initial git diff
    logEvent(session, formatPipelineEvent(session, { stage: "diff" }));
    logNdjson(session, "PIPELINE_STAGE", null, { stage: "diff" });
    const diff1 = captureGitDiff(cwd, session);
    completedStages.push("diff");
    checkPipelineTimeout();

    // Stage 2: Auto-review (if configured)
    let reviewVerdict = "approve";
    let reviewFindings = [];
    let reviewFindingCount = 0;

    if (config.auto_review) {
      logEvent(session, formatPipelineEvent(session, { stage: "review" }));
      logNdjson(session, "PIPELINE_STAGE", null, { stage: "review" });

      try {
        const reviewResult = await withTimeout(
          runAppServerReview(cwd, {
            target: { type: "uncommittedChanges" },
            model: config.model,
          }),
          STAGE_TIMEOUT_MS,
          "auto-review"
        );

        completedStages.push("review");
        checkPipelineTimeout();

        // Parse review findings from the review text
        if (reviewResult.reviewText) {
          const parsed = parseReviewText(reviewResult.reviewText);
          reviewVerdict = parsed.verdict;
          reviewFindings = parsed.findings;
          reviewFindingCount = reviewFindings.length;
        }

        // Stage 2b: Fix findings (if any)
        if (reviewFindings.length > 0) {
          logEvent(session, formatPipelineEvent(session, { stage: "fix" }));
          logNdjson(session, "PIPELINE_STAGE", null, { stage: "fix", findingCount: reviewFindings.length });

          const fixPrompt = buildFixPrompt(reviewFindings);
          await withTimeout(
            runAppServerTurn(cwd, {
              resumeThreadId: threadId,
              prompt: fixPrompt,
              model: config.model,
              effort: "high",
              collaborationMode: buildCollaborationMode("default", config, {
                developerInstructions: executeInstructions,
              }),
              sandboxPolicy: buildSandboxPolicy("default"),
            }),
            STAGE_TIMEOUT_MS,
            "auto-fix"
          );

          completedStages.push("fix");
          checkPipelineTimeout();

          // Capture diff after fix
          captureGitDiff(cwd, session);
        }
      } catch (error) {
        if (error instanceof TimeoutError) {
          throw error;
        }
        // Review failed but not a timeout — log and continue
        logNdjson(session, "PIPELINE_ERROR", null, { stage: "review", error: error.message });
        completedStages.push("review-failed");
      }
    }

    // Stage 3: Completion check (if configured)
    let completionResult = { complete: true, missing_items: [], summary: "Complete" };

    if (config.post_task_prompt && config.post_task_prompt.trim()) {
      logEvent(session, formatPipelineEvent(session, { stage: "check" }));
      logNdjson(session, "PIPELINE_STAGE", null, { stage: "check" });

      try {
        const checkResult = await withTimeout(
          runAppServerTurn(cwd, {
            resumeThreadId: threadId,
            prompt: config.post_task_prompt,
            model: config.model,
            effort: "medium",
            collaborationMode: buildCollaborationMode("default", config, {
              developerInstructions: executeInstructions,
            }),
            sandboxPolicy: { type: "readOnly" },
            outputSchema: COMPLETION_CHECK_SCHEMA,
          }),
          STAGE_TIMEOUT_MS,
          "completion-check"
        );

        completedStages.push("check");

        // Treat a failed completion-check turn as "incomplete" with a
        // diagnostic item, rather than silently falling through to `complete`.
        if (checkResult.status !== 0) {
          completionResult = {
            complete: false,
            missing_items: [
              `Completion check turn failed (status ${checkResult.status}${checkResult.error?.message ? `: ${checkResult.error.message}` : ""}).`
            ],
            summary: "completion-check failed",
          };
        } else if (checkResult.finalMessage) {
          try {
            completionResult = JSON.parse(checkResult.finalMessage);
          } catch {
            // Not valid JSON — try to determine completeness heuristically
            completionResult = {
              complete: true,
              missing_items: [],
              summary: checkResult.finalMessage.slice(0, 200),
            };
          }
        } else {
          // Turn succeeded but no final message — treat as inconclusive/incomplete.
          completionResult = {
            complete: false,
            missing_items: ["Completion check produced no final message."],
            summary: "completion-check inconclusive",
          };
        }
      } catch (error) {
        if (error instanceof TimeoutError) {
          throw error;
        }
        logNdjson(session, "PIPELINE_ERROR", null, { stage: "check", error: error.message });
        completedStages.push("check-failed");
      }
    }

    // Stage 4: Final git diff and notification
    const finalDiff = captureGitDiff(cwd, session);
    const duration = Math.round((Date.now() - startTime) / 1000);

    if (completionResult.complete) {
      logEvent(session, formatDoneEvent(session, {
        duration,
        diffStat: finalDiff.diffStat,
        files: finalDiff.files,
        config: { model: config.model, effort: config.effort, modeFlow: "plan→default" },
        diffPath: finalDiff.diffPath,
        scriptPath,
        jobId,
      }));
    } else {
      logEvent(session, formatIncompleteEvent(session, {
        diffStat: finalDiff.diffStat,
        diffPath: finalDiff.diffPath,
        verdict: reviewVerdict,
        findingCount: reviewFindingCount,
        missingItems: completionResult.missing_items || [],
        scriptPath,
        jobId,
      }));
    }

    logNdjson(session, "PIPELINE_COMPLETE", null, {
      completedStages,
      duration,
      complete: completionResult.complete,
    });

    return {
      complete: completionResult.complete,
      completedStages,
      duration,
      diff: finalDiff,
    };

  } catch (error) {
    const duration = Math.round((Date.now() - startTime) / 1000);
    const errorCode = error instanceof TimeoutError ? "ClientTimeout" : "PipelineError";
    const errorMessage = error instanceof PipelineTimeoutError
      ? `Auto-pipeline exceeded ${fmtSeconds(PIPELINE_TIMEOUT_MS)}. Completed stages: ${completedStages.join(", ")}`
      : error.message;

    // Capture whatever diff exists
    let finalDiff;
    try {
      finalDiff = captureGitDiff(cwd, session);
    } catch {
      finalDiff = { diffStat: "0 files | +0 -0", files: [], diffPath: "" };
    }

    logEvent(session, formatErrorEvent(session, {
      errorCode,
      message: errorMessage,
      phase: `pipeline (completed: ${completedStages.join(", ")})`,
      scriptPath,
      jobId,
    }));

    logNdjson(session, "PIPELINE_ERROR", null, {
      completedStages,
      duration,
      error: errorMessage,
    });

    return {
      complete: false,
      completedStages,
      duration,
      error: errorMessage,
    };
  }
}

function buildFixPrompt(findings) {
  const lines = ["Fix the following review findings:"];
  for (const f of findings) {
    lines.push(`- [${f.severity}] ${f.title} at ${f.file}:${f.line_start}-${f.line_end}`);
    if (f.recommendation) {
      lines.push(`  Recommendation: ${f.recommendation}`);
    }
  }
  return lines.join("\n");
}

function parseReviewText(reviewText) {
  // Native review returns plain text, not structured findings.
  // The auto-fix stage (stage 2b) requires structured findings with
  // severity/file/line data. Since native review doesn't provide that,
  // the fix stage is effectively a no-op for native reviews.
  //
  // When adversarial review is used instead, findings ARE structured
  // and the fix stage will activate. This is a known limitation —
  // a future version could switch auto-review to adversarial mode.
  const lower = reviewText.toLowerCase();
  const hasIssues = lower.includes("needs-attention") || lower.includes("finding") || lower.includes("issue");
  return {
    verdict: hasIssues ? "needs-attention" : "approve",
    findings: [],
  };
}

export class TimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} exceeded ${fmtSeconds(timeoutMs)}`);
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

class PipelineTimeoutError extends TimeoutError {
  constructor(completedStages) {
    super("auto-pipeline", PIPELINE_TIMEOUT_MS);
    this.completedStages = completedStages;
  }
}

export function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(label, timeoutMs));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
