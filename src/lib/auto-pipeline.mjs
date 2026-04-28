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
  fmtSeconds,
} from "./session-log.mjs";
import { COMPLETION_CHECK_SCHEMA, buildCollaborationMode, buildSandboxPolicy } from "./config.mjs";
import { extractUpstreamRequestId } from "./cli-errors.mjs";

// Default budgets. Runtime callers may override via `stageTimeoutMs` /
// `totalTimeoutMs` on runAutoPipeline options, which in turn resolve from
// CLI flag → config.yaml → these defaults. Pre-1.2.5 both were constants
// with no escape hatch; large diffs that legitimately needed >5 min review
// time had no recourse short of editing the source. See config.mjs
// DEFAULT_CONFIG `pipeline_stage_ms` / `pipeline_total_ms`.
const PIPELINE_TIMEOUT_MS_DEFAULT = 900_000; // 15 minutes total
const STAGE_TIMEOUT_MS_DEFAULT = 300_000;    // 5 minutes per stage

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
    stageTimeoutMs = null,
    totalTimeoutMs = null,
  } = options;

  // Resolve per-stage and total budgets: caller override → built-in default.
  // Caller already did flag→config resolution, so passing `null` here means
  // "use the built-in default".
  const stageMs = Number(stageTimeoutMs) > 0 ? Number(stageTimeoutMs) : STAGE_TIMEOUT_MS_DEFAULT;
  const totalMs = Number(totalTimeoutMs) > 0 ? Number(totalTimeoutMs) : PIPELINE_TIMEOUT_MS_DEFAULT;
  // Per-turn watchdog budget. The outer `withTimeout` wrapper around each
  // stage call rejects when the stage clock hits `stageMs`, but it does not
  // tear the in-flight Codex turn down — the request just keeps running until
  // the underlying app-server eventually responds (or never does). We pass
  // these into runAppServerTurn / runAppServerReview so captureTurn's own
  // `idleTimeoutMs` / `turnTimeoutMs` watchers fire slightly before the outer
  // wrapper, giving the inner code a chance to issue `turn/interrupt` and
  // settle cleanly. The 500ms grace keeps the outer wrapper as the
  // load-bearing safety net.
  const stageTurnMs = Math.max(0, stageMs - 500);

  const completedStages = [];
  const startTime = Date.now();
  const executeInstructions = loadExecuteInstructions(rootDir);

  const checkPipelineTimeout = () => {
    if (Date.now() - startTime > totalMs) {
      throw new PipelineTimeoutError(completedStages, totalMs);
    }
  };

  // Pipeline-level accumulators for the end-of-run summary event and the
  // `result.pipeline.touchedFiles` payload. `fixFilesTouched` records which
  // files the fix stage itself wrote; it's distinct from `finalDiff.files`
  // (which is the cumulative diff since the pipeline started). Pre-1.2.5
  // nothing exposed the per-stage file set, so an orchestrator that saw
  // pipeline changes after a [DONE] had to blind-accept or diff by hand.
  let fixFilesTouched = [];

  try {
    // Stage 1: Capture initial git diff
    logEvent(session, formatPipelineEvent(session, { stage: "diff" }));
    logNdjson(session, "PIPELINE_STAGE", null, { stage: "diff" });
    const diff1 = captureGitDiff(cwd, session);
    completedStages.push("diff");
    logEvent(session, formatPipelineEvent(session, { stage: "diff", suffix: "done", detail: diff1.diffStat }));
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
            turnTimeoutMs: stageTurnMs,
            idleTimeoutMs: stageTurnMs,
          }),
          stageMs,
          "auto-review"
        );

        // Inner watchdog (idleTimeoutMs / turnTimeoutMs in captureTurn) can
        // fire before the outer `withTimeout` and resolve with `status: 1`
        // and an `error` field rather than throwing. Without this guard,
        // `reviewText` is empty, parseReviewText is skipped, and the default
        // `reviewVerdict = "approve"` would silently carry through to the
        // completion check and `[DONE]` — masking a stalled/timed-out review
        // as a passing one. Surface as a TimeoutError so the outer catch
        // emits `[PIPELINE:failed]` with `errorCode: ClientTimeout` and
        // `failing_stage: review` (see mapStageLabel below).
        if (reviewResult.status !== 0) {
          const detail = reviewResult.error?.message
            ? `: ${reviewResult.error.message}`
            : "";
          const reviewError = new TimeoutError("auto-review", stageTurnMs);
          reviewError.message =
            `auto-review did not complete cleanly (status ${reviewResult.status}${detail}).`;
          throw reviewError;
        }

        completedStages.push("review");
        checkPipelineTimeout();

        // Parse review findings from the review text
        if (reviewResult.reviewText) {
          const parsed = parseReviewText(reviewResult.reviewText);
          reviewVerdict = parsed.verdict;
          reviewFindings = parsed.findings;
          reviewFindingCount = reviewFindings.length;
        }
        logEvent(session, formatPipelineEvent(session, {
          stage: "review",
          suffix: "done",
          detail: `verdict=${reviewVerdict} findings=${reviewFindingCount}`
        }));

        // Stage 2b: Fix findings (if any)
        if (reviewFindings.length > 0) {
          logEvent(session, formatPipelineEvent(session, { stage: "fix" }));
          logNdjson(session, "PIPELINE_STAGE", null, { stage: "fix", findingCount: reviewFindings.length });

          // Snapshot the tree before the fix turn so we can subtract and
          // report exactly which files the fix stage wrote (distinct from
          // Codex's own earlier writes).
          const diffBeforeFix = captureGitDiff(cwd, session);
          const filesBeforeFix = new Set(diffBeforeFix.files.map((f) => f.replace(/^[A-Z] /, "").split(" ")[0]));

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
              sandboxPolicy: buildSandboxPolicy("default", config),
              turnTimeoutMs: stageTurnMs,
              idleTimeoutMs: stageTurnMs,
            }),
            stageMs,
            "auto-fix"
          );

          completedStages.push("fix");
          checkPipelineTimeout();

          // Capture diff after fix; derive the exact file list the fix
          // stage touched.
          const diffAfterFix = captureGitDiff(cwd, session);
          const filesAfterFix = diffAfterFix.files.map((f) => f.replace(/^[A-Z] /, "").split(" ")[0]);
          fixFilesTouched = filesAfterFix.filter((f) => !filesBeforeFix.has(f));

          logEvent(session, formatPipelineEvent(session, {
            stage: "fix",
            suffix: "done",
            detail: fixFilesTouched.length
              ? `files=${JSON.stringify(fixFilesTouched.slice(0, 10))}${fixFilesTouched.length > 10 ? ` (+${fixFilesTouched.length - 10} more)` : ""}`
              : "files=[]"
          }));
        }
      } catch (error) {
        if (error instanceof TimeoutError) {
          throw error;
        }
        // Review failed but not a timeout — log and continue
        logNdjson(session, "PIPELINE_ERROR", null, { stage: "review", error: error.message });
        logEvent(session, formatPipelineEvent(session, {
          stage: "review",
          suffix: "failed",
          detail: error.message ?? "review failed"
        }));
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
            turnTimeoutMs: stageTurnMs,
            idleTimeoutMs: stageTurnMs,
          }),
          stageMs,
          "completion-check"
        );

        completedStages.push("check");
        // Completion check result tag is emitted below after completionResult
        // is finalized (line ~204 in the pre-1.2.5 file), since the complete
        // bit depends on parsing checkResult.finalMessage.

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
        logEvent(session, formatPipelineEvent(session, {
          stage: "check",
          suffix: "done",
          detail: `complete=${Boolean(completionResult.complete)}${
            Array.isArray(completionResult.missing_items) && completionResult.missing_items.length
              ? ` missing=${completionResult.missing_items.length}`
              : ""
          }`
        }));
      } catch (error) {
        if (error instanceof TimeoutError) {
          throw error;
        }
        logNdjson(session, "PIPELINE_ERROR", null, { stage: "check", error: error.message });
        logEvent(session, formatPipelineEvent(session, {
          stage: "check",
          suffix: "failed",
          detail: error.message ?? "check failed"
        }));
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
        cwd,
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
        cwd,
      }));
    }

    logNdjson(session, "PIPELINE_COMPLETE", null, {
      completedStages,
      duration,
      complete: completionResult.complete,
      touchedFiles: fixFilesTouched,
    });

    // Symmetric terminal tag so `events --filter PIPELINE` sees both edges of
    // the pipeline lifecycle. Orchestrators can now wait for [PIPELINE:done]
    // before assuming the bridge has stopped writing to the workspace.
    // NOTE: previously passed { stage: "pipeline", suffix: "done" } which
    // rendered as [PIPELINE:pipeline:done] — contradicting every doc surface
    // that promised [PIPELINE:done]. Pass stage directly so the terminal
    // closer matches the documented name.
    logEvent(session, formatPipelineEvent(session, {
      stage: "done",
      detail: `stages=${completedStages.join(",")} complete=${Boolean(completionResult.complete)} touched=${fixFilesTouched.length}`
    }));

    return {
      complete: completionResult.complete,
      completedStages,
      duration,
      diff: finalDiff,
      touchedFiles: fixFilesTouched,
    };

  } catch (error) {
    const duration = Math.round((Date.now() - startTime) / 1000);
    const errorCode = error instanceof TimeoutError ? "ClientTimeout" : "PipelineError";
    const errorMessage = error instanceof PipelineTimeoutError
      ? `Auto-pipeline exceeded ${fmtSeconds(totalMs)}. Completed stages: ${completedStages.join(", ")}`
      : error.message;

    // Capture whatever diff exists
    let finalDiff;
    try {
      finalDiff = captureGitDiff(cwd, session);
    } catch {
      finalDiff = { diffStat: "0 files | +0 -0", files: [], diffPath: "" };
    }

    const lastStage = completedStages[completedStages.length - 1] ?? "pipeline";
    const origin = `pipeline:${lastStage}`;
    // `failing_stage` names the stage that *actually* stalled/errored — a
    // separate field from `origin` (which keeps its "last-completed" semantics
    // for backward compatibility with tooling that already filters on it).
    // Pre-1.4.1 readers had to guess whether `origin: pipeline:diff` meant
    // "diff failed" or "diff completed and review failed". The TimeoutError
    // label is the authoritative source; map its label to the canonical
    // stage token used in `completedStages`.
    const failingStage = error instanceof TimeoutError
      ? mapStageLabel(error.label)
      : null;
    const upstreamRequestId = extractUpstreamRequestId(errorMessage);
    logEvent(session, formatErrorEvent(session, {
      errorCode,
      message: errorMessage,
      phase: `pipeline (completed: ${completedStages.join(", ")})`,
      origin,
      failingStage,
      scriptPath,
      jobId,
      upstreamRequestId,
      cwd,
    }));

    logNdjson(session, "PIPELINE_ERROR", null, {
      completedStages,
      duration,
      error: errorMessage,
      origin,
      failing_stage: failingStage,
      touchedFiles: fixFilesTouched,
    });

    // See pipeline:done note above — terminal closer passes stage directly
    // to render as [PIPELINE:failed] instead of the stale [PIPELINE:pipeline:failed].
    logEvent(session, formatPipelineEvent(session, {
      stage: "failed",
      detail: `at=${lastStage} stages=${completedStages.join(",")} touched=${fixFilesTouched.length}`
    }));

    return {
      complete: false,
      completedStages,
      duration,
      error: errorMessage,
      touchedFiles: fixFilesTouched,
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

// Map a `withTimeout` label into the canonical stage token that also appears
// in `completedStages` (so `failing_stage` and `origin` share a vocabulary).
function mapStageLabel(label) {
  switch (label) {
    case "auto-review": return "review";
    case "auto-fix": return "fix";
    case "completion-check": return "check";
    case "auto-pipeline": return "pipeline-total";
    default: return label || null;
  }
}

export class TimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} exceeded ${fmtSeconds(timeoutMs)}`);
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

class PipelineTimeoutError extends TimeoutError {
  constructor(completedStages, timeoutMs = PIPELINE_TIMEOUT_MS_DEFAULT) {
    super("auto-pipeline", timeoutMs);
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
