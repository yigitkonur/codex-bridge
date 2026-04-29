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
} from "../../lib/session-log.mjs";
import { COMPLETION_CHECK_SCHEMA, buildCollaborationMode, buildSandboxPolicy } from "../../lib/runtime-options.mjs";
import { extractUpstreamRequestId } from "../../lib/cli-errors.mjs";

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
  const completedStages = [];
  const startTime = Date.now();
  const executeInstructions = loadExecuteInstructions(rootDir);

  const remainingPipelineMs = () => totalMs - (Date.now() - startTime);

  const checkPipelineTimeout = () => {
    if (remainingPipelineMs() <= 0) {
      throw new PipelineTimeoutError(completedStages, totalMs);
    }
  };

  const buildStageDeadline = () => {
    const remainingMs = remainingPipelineMs();
    if (remainingMs <= 0) {
      throw new PipelineTimeoutError(completedStages, totalMs);
    }

    const timeoutMs = Math.min(stageMs, remainingMs);
    const totalLimited = remainingMs < stageMs;
    return {
      timeoutMs,
      // Keep the inner watchdog from preempting the pipeline-total timer with
      // a stage-timeout result when the remaining total budget is the limiter.
      turnTimeoutMs: totalLimited ? 0 : Math.max(0, timeoutMs - 500),
      timeoutErrorFactory: totalLimited
        ? () => new PipelineTimeoutError(completedStages, totalMs)
        : null,
    };
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
    let unstructuredReviewAttention = false;

    if (config.auto_review) {
      logEvent(session, formatPipelineEvent(session, { stage: "review" }));
      logNdjson(session, "PIPELINE_STAGE", null, { stage: "review" });

      try {
        const reviewDeadline = buildStageDeadline();
        const reviewResult = await withTimeout(
          runAppServerReview(cwd, {
            target: { type: "uncommittedChanges" },
            model: config.model,
            turnTimeoutMs: reviewDeadline.turnTimeoutMs,
            idleTimeoutMs: reviewDeadline.turnTimeoutMs,
          }),
          reviewDeadline.timeoutMs,
          "auto-review",
          reviewDeadline.timeoutErrorFactory
        );

        // Inner watchdog (idleTimeoutMs / turnTimeoutMs in captureTurn) can
        // fire before the outer `withTimeout` and resolve with `status: 1`
        // and an `error` field rather than throwing. Without this guard,
        // `reviewText` is empty, parseReviewText is skipped, and the default
        // `reviewVerdict = "approve"` would silently carry through to the
        // completion check and `[DONE]` — masking a stalled/timed-out review
        // as a passing one.
        //
        // Round-5 7c3507a threw TimeoutError unconditionally so the outer
        // catch emitted `[PIPELINE:failed]` with `errorCode: ClientTimeout`
        // and `failing_stage: review`. That hid auth/validation/upstream-
        // reject failures behind timeout-recovery guidance. Branch on the
        // structured error so only real timeouts map to `ClientTimeout`;
        // every other non-zero status surfaces with its real cause attached.
        if (reviewResult.status !== 0) {
          const innerError = reviewResult.error ?? null;
          const innerMessage = innerError?.message ?? "";
          const isTimeout =
            innerError?.code === "TurnTimeout" ||
            /Turn timed out after \d+ms\./.test(innerMessage) ||
            /No events received for \d+s/.test(innerMessage);
          const detail = innerMessage ? `: ${innerMessage}` : "";

          if (isTimeout) {
            const reviewError = new TimeoutError("auto-review", reviewDeadline.turnTimeoutMs);
            reviewError.message =
              `auto-review did not complete cleanly (status ${reviewResult.status}${detail}).`;
            throw reviewError;
          }

          const stageError = new PipelineStageError(
            "review",
            `auto-review failed (status ${reviewResult.status}${detail}).`,
            innerError
          );
          throw stageError;
        }

        completedStages.push("review");
        checkPipelineTimeout();

        // Parse review findings from the review text
        if (reviewResult.reviewText) {
          const parsed = parseReviewText(reviewResult.reviewText);
          reviewVerdict = parsed.verdict;
          reviewFindings = parsed.findings;
          reviewFindingCount = reviewFindings.length;
          unstructuredReviewAttention = reviewVerdict !== "approve" && reviewFindingCount === 0;
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
          const diffContentBeforeFix = readCapturedDiffContent(diffBeforeFix);

          const fixPrompt = buildFixPrompt(reviewFindings);
          let fixResult;
          let fixDeadline;
          try {
            fixDeadline = buildStageDeadline();
            fixResult = await withTimeout(
              runAppServerTurn(cwd, {
                resumeThreadId: threadId,
                prompt: fixPrompt,
                model: config.model,
                effort: "high",
                collaborationMode: buildCollaborationMode("default", config, {
                  developerInstructions: executeInstructions,
                }),
                sandboxPolicy: buildSandboxPolicy("default", config),
                turnTimeoutMs: fixDeadline.turnTimeoutMs,
                idleTimeoutMs: fixDeadline.turnTimeoutMs,
              }),
              fixDeadline.timeoutMs,
              "auto-fix",
              fixDeadline.timeoutErrorFactory
            );
          } catch (error) {
            if (error instanceof TimeoutError) {
              throw error;
            }
            const detail = error instanceof Error ? error.message : String(error);
            throw new PipelineStageError(
              "fix",
              `auto-fix failed before producing a result${detail ? `: ${detail}` : ""}.`,
              error instanceof Error ? error : null
            );
          }

          const fixStatus = fixResult?.status;
          if (fixStatus !== 0) {
            const innerError = fixResult?.error ?? null;
            const innerMessage = innerError?.message ?? "";
            const isTimeout =
              innerError?.code === "TurnTimeout" ||
              /Turn timed out after \d+ms\./.test(innerMessage) ||
              /No events received for \d+s/.test(innerMessage);
            const detail = innerMessage ? `: ${innerMessage}` : "";

            if (isTimeout) {
              const fixError = new TimeoutError("auto-fix", fixDeadline.turnTimeoutMs);
              fixError.message =
                `auto-fix did not complete cleanly (status ${fixStatus}${detail}).`;
              throw fixError;
            }

            throw new PipelineStageError(
              "fix",
              `auto-fix failed (status ${fixStatus}${detail}).`,
              innerError
            );
          }

          completedStages.push("fix");
          checkPipelineTimeout();

          // Capture diff after fix; derive the exact file list the fix
          // stage touched.
          const diffAfterFix = captureGitDiff(cwd, session);
          const diffContentAfterFix = readCapturedDiffContent(diffAfterFix);
          fixFilesTouched = collectStageTouchedFiles(
            diffBeforeFix,
            diffContentBeforeFix,
            diffAfterFix,
            diffContentAfterFix
          );

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
        if (error instanceof PipelineStageError) {
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
        const checkDeadline = buildStageDeadline();
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
            turnTimeoutMs: checkDeadline.turnTimeoutMs,
            idleTimeoutMs: checkDeadline.turnTimeoutMs,
          }),
          checkDeadline.timeoutMs,
          "completion-check",
          checkDeadline.timeoutErrorFactory
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
        const message = error instanceof Error ? error.message : String(error);
        const detail = message || "check failed";
        completionResult = {
          complete: false,
          missing_items: [
            `Completion check failed before producing a result: ${detail}`,
          ],
          summary: "completion-check failed",
        };
        logNdjson(session, "PIPELINE_ERROR", null, { stage: "check", error: detail });
        logEvent(session, formatPipelineEvent(session, {
          stage: "check",
          suffix: "failed",
          detail
        }));
        completedStages.push("check-failed");
      }
    }

    if (unstructuredReviewAttention) {
      const missingItem =
        "Native review reported needs-attention but did not include parseable file/line findings, so auto-fix could not run.";
      const existingMissingItems = Array.isArray(completionResult.missing_items)
        ? completionResult.missing_items
        : [];
      completionResult = {
        complete: false,
        missing_items: existingMissingItems.includes(missingItem)
          ? existingMissingItems
          : [...existingMissingItems, missingItem],
        summary: completionResult.complete
          ? "native review needs attention"
          : (typeof completionResult.summary === "string" ? completionResult.summary : "native review needs attention"),
      };
    }

    // Stage 4: Final git diff and notification
    const finalDiff = captureGitDiff(cwd, session);
    const duration = Math.round((Date.now() - startTime) / 1000);
    const missingItems = Array.isArray(completionResult.missing_items)
      ? completionResult.missing_items
      : [];
    const completionSummary = typeof completionResult.summary === "string"
      ? completionResult.summary
      : null;

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
        missingItems,
        scriptPath,
        jobId,
        cwd,
      }));
    }

    logNdjson(session, "PIPELINE_COMPLETE", null, {
      completedStages,
      duration,
      complete: completionResult.complete,
      missingItems,
      completionSummary,
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
      missingItems,
      completionSummary,
      touchedFiles: fixFilesTouched,
    };

  } catch (error) {
    const duration = Math.round((Date.now() - startTime) / 1000);
    // Pick the most specific error code for the [ERROR] tag. Timeouts
    // remain `ClientTimeout` (matches cli-errors.mjs synthesizers + round-5
    // contract). Pipeline stage errors propagate the underlying Codex error
    // code when present (e.g. `Unauthorized`, `BadRequest`, `ServerOverloaded`)
    // so orchestrators get the real cause + recovery guidance instead of a
    // generic `PipelineError`. Fall back to `PipelineError` for anything else.
    const errorCode = error instanceof TimeoutError
      ? "ClientTimeout"
      : (error instanceof PipelineStageError && error.cause?.code)
        ? error.cause.code
        : "PipelineError";
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
    // "diff failed" or "diff completed and review failed". TimeoutError's
    // `label` and PipelineStageError's `stage` both carry the authoritative
    // source; map them to the canonical stage token used in `completedStages`.
    const failingStage = error instanceof TimeoutError
      ? mapStageLabel(error.label)
      : error instanceof PipelineStageError
        ? error.stage
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

function readCapturedDiffContent(diff) {
  if (!diff?.diffPath) {
    return "";
  }
  try {
    return fs.readFileSync(diff.diffPath, "utf8");
  } catch {
    return "";
  }
}

function collectStageTouchedFiles(diffBefore, diffContentBefore, diffAfter, diffContentAfter) {
  const beforeStats = mapFormattedDiffFiles(diffBefore?.files ?? []);
  const afterStats = mapFormattedDiffFiles(diffAfter?.files ?? []);
  const beforeBlocks = splitDiffBlocksByPath(diffContentBefore);
  const afterBlocks = splitDiffBlocksByPath(diffContentAfter);
  const orderedFiles = uniqueStrings([
    ...afterStats.keys(),
    ...beforeStats.keys(),
    ...afterBlocks.keys(),
    ...beforeBlocks.keys(),
  ]);

  return orderedFiles.filter((file) => {
    const beforeSignal = beforeBlocks.get(file) ?? beforeStats.get(file) ?? null;
    const afterSignal = afterBlocks.get(file) ?? afterStats.get(file) ?? null;
    return beforeSignal !== afterSignal;
  });
}

function mapFormattedDiffFiles(files) {
  const map = new Map();
  for (const file of files) {
    const parsed = parseFormattedDiffFile(file);
    if (parsed) {
      map.set(parsed.path, parsed.stat);
    }
  }
  return map;
}

function parseFormattedDiffFile(file) {
  const match = String(file).match(/^[A-Z]\s+(.+?)\s+\(\+[\d-]+\s+-[\d-]+\)$/);
  if (!match) {
    return null;
  }
  return { path: match[1], stat: file };
}

function splitDiffBlocksByPath(diffContent) {
  const blocks = new Map();
  let currentPath = null;
  let currentLines = [];

  const flush = () => {
    if (currentPath) {
      blocks.set(currentPath, currentLines.join("\n"));
    }
  };

  for (const line of String(diffContent ?? "").split("\n")) {
    const nextPath = parseDiffGitHeader(line);
    if (nextPath) {
      flush();
      currentPath = nextPath;
      currentLines = [line];
    } else if (currentPath) {
      currentLines.push(line);
    }
  }

  flush();
  return blocks;
}

function parseDiffGitHeader(line) {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!match) {
    return null;
  }
  return match[2];
}

function uniqueStrings(values) {
  const seen = new Set();
  const unique = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function parseReviewText(reviewText) {
  const findings = parseNativeReviewFindings(reviewText);
  if (findings.length > 0) {
    return { verdict: "needs-attention", findings };
  }

  const lower = reviewText.toLowerCase();
  const reviewTextWithoutNoIssuePhrases = lower
    .replace(/\bno\s+(?:actionable\s+)?(?:issues?|findings?|problems?|concerns?)\b/g, "")
    .replace(/\b(?:issues?|findings?|problems?|concerns?):\s*(?:none|n\/a)\b/g, "");
  const explicitAttention =
    lower.includes("needs-attention") ||
    /\bneeds attention\b/.test(lower) ||
    /\brequires attention\b/.test(lower);
  const hasIssues =
    explicitAttention ||
    /\b(?:findings?|issues?|problems?|concerns?|regressions?)\b/.test(reviewTextWithoutNoIssuePhrases);
  return {
    verdict: hasIssues ? "needs-attention" : "approve",
    findings: [],
  };
}

function parseNativeReviewFindings(reviewText) {
  const lines = reviewText.split(/\r?\n/);
  const findings = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const recommendation = current.body
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");
    findings.push({
      severity: current.severity,
      title: current.title,
      file: current.file,
      line_start: current.lineStart,
      line_end: current.lineEnd,
      recommendation,
    });
    current = null;
  };

  for (const line of lines) {
    const header = parseNativeFindingHeader(line);
    if (header) {
      flush();
      current = { ...header, body: [] };
      continue;
    }

    if (current && (/^(?:\s{2,}|\t+)\S/.test(line) || line.trim() === "")) {
      current.body.push(line);
    }
  }

  flush();
  return findings;
}

function parseNativeFindingHeader(line) {
  const match = line.match(/^\s*[-*]\s+\[(P\d+)\]\s+(.+?)\s+(?:\u2014|\u2013|--|-)\s+(.+?):(\d+)(?:-(\d+))?\s*$/i);
  if (!match) return null;

  const lineStart = Number.parseInt(match[4], 10);
  if (!Number.isInteger(lineStart) || lineStart < 1) return null;

  const parsedLineEnd = match[5] ? Number.parseInt(match[5], 10) : lineStart;
  const lineEnd = Number.isInteger(parsedLineEnd) && parsedLineEnd >= lineStart
    ? parsedLineEnd
    : lineStart;

  return {
    severity: match[1].toUpperCase(),
    title: match[2].trim(),
    file: match[3].trim(),
    lineStart,
    lineEnd,
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

// Non-timeout failure inside a pipeline stage. Carries the underlying
// Codex `error` object on `.cause` so the outer catch can surface the real
// code (Unauthorized, BadRequest, ServerOverloaded, …) instead of a generic
// `PipelineError`. `stage` populates `failing_stage` in the [ERROR] / NDJSON
// payloads so orchestrators see WHICH stage actually broke.
export class PipelineStageError extends Error {
  constructor(stage, message, cause = null) {
    super(message);
    this.name = "PipelineStageError";
    this.stage = stage;
    if (cause) this.cause = cause;
  }
}

class PipelineTimeoutError extends TimeoutError {
  constructor(completedStages, timeoutMs = PIPELINE_TIMEOUT_MS_DEFAULT) {
    super("auto-pipeline", timeoutMs);
    this.completedStages = completedStages;
  }
}

export function withTimeout(promise, timeoutMs, label, timeoutErrorFactory = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(typeof timeoutErrorFactory === "function"
        ? timeoutErrorFactory()
        : new TimeoutError(label, timeoutMs));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
