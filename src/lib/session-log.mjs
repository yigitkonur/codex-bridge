import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

export function resolveSessionDir(configDir) {
  const dir = (configDir ?? "~/.codex-bridge/sessions").replace(/^~/, os.homedir());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function initSession(sessionDir, threadId) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const ndjsonPath = path.join(sessionDir, `${threadId}.ndjson`);
  const eventsPath = path.join(sessionDir, `${threadId}.events`);
  fs.writeFileSync(ndjsonPath, "", { flag: "a" });
  fs.writeFileSync(eventsPath, "", { flag: "a" });
  return { ndjsonPath, eventsPath, sessionDir, threadId };
}

export function findSession(sessionDir, threadId) {
  const ndjsonPath = path.join(sessionDir, `${threadId}.ndjson`);
  const eventsPath = path.join(sessionDir, `${threadId}.events`);
  if (!fs.existsSync(ndjsonPath)) {
    return null;
  }
  return { ndjsonPath, eventsPath, sessionDir, threadId };
}

export function logNdjson(session, tag, method, data) {
  const entry = {
    ts: new Date().toISOString(),
    tag,
    method: method ?? null,
    threadId: session.threadId,
    data: data ?? {},
  };
  try {
    fs.appendFileSync(session.ndjsonPath, JSON.stringify(entry) + "\n");
  } catch {
    // Logging failure must not kill the task
  }
}

export function logEvent(session, formattedBlock) {
  try {
    fs.appendFileSync(session.eventsPath, formattedBlock + "\n");
  } catch {
    // Logging failure must not kill the task
  }
}

export function writeDiff(session, diffContent) {
  const diffPath = path.join(session.sessionDir, `${session.threadId}.diff`);
  try {
    fs.writeFileSync(diffPath, diffContent);
  } catch {
    // Silent failure
  }
  return diffPath;
}

export function writePlan(session, planText) {
  const planPath = path.join(session.sessionDir, `${session.threadId}.plan.md`);
  try {
    fs.writeFileSync(planPath, planText);
  } catch {
    // Silent failure
  }
  return planPath;
}

export function writeReview(session, reviewData) {
  const reviewPath = path.join(session.sessionDir, `${session.threadId}.review.json`);
  try {
    fs.writeFileSync(reviewPath, JSON.stringify(reviewData, null, 2));
  } catch {
    // Silent failure
  }
  return reviewPath;
}

export function captureGitDiff(cwd, session) {
  const numstatResult = spawnSync("git", ["diff", "--numstat", "HEAD"], { cwd, encoding: "utf8", timeout: 10000 });
  const fullResult = spawnSync("git", ["diff", "HEAD"], { cwd, encoding: "utf8", timeout: 10000 });

  const diffContent = fullResult.stdout || "";
  const diffPath = writeDiff(session, diffContent);

  const numstatOutput = numstatResult.stdout || "";
  const files = parseGitNumstat(numstatOutput);
  const summary = summarizeNumstat(files);

  return { diffStat: summary, files: files.map(formatFileStat), diffPath };
}

function parseGitNumstat(output) {
  const files = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)/);
    if (match) {
      const adds = match[1] === "-" ? 0 : parseInt(match[1]);
      const dels = match[2] === "-" ? 0 : parseInt(match[2]);
      const fileName = match[3].trim();
      files.push({ fileName, adds, dels });
    }
  }
  return files;
}

function formatFileStat({ fileName, adds, dels }) {
  const prefix = fileName.includes("=>") ? "R" : "M";
  return `${prefix} ${fileName} (+${adds} -${dels})`;
}

function summarizeNumstat(files) {
  const totalAdds = files.reduce((sum, f) => sum + f.adds, 0);
  const totalDels = files.reduce((sum, f) => sum + f.dels, 0);
  return `${files.length} files | +${totalAdds} -${totalDels}`;
}

// Action-command helpers: the events file is a record of ONE specific task,
// so the result/cancel commands must pin to that task's job id. Bare
// `result`/`cancel` would target "latest in session", which changes as new
// tasks start and could silently hit the wrong job when an agent reads the
// event later.
function resultActionLine(scriptPath, jobId, indent = "    detail: ") {
  return jobId
    ? `${indent}node ${scriptPath} result ${jobId}`
    : `${indent}node ${scriptPath} result    # rerun with the specific job id from status`;
}
function cancelActionLine(scriptPath, jobId, indent = "    cancel: ") {
  return jobId
    ? `${indent}node ${scriptPath} cancel ${jobId}`
    : `${indent}node ${scriptPath} cancel    # rerun with the specific job id from status`;
}

export function formatDoneEvent(session, { duration, diffStat, files, config, diffPath, scriptPath, jobId = null }) {
  const lines = [
    `[DONE] ${session.threadId} completed in ${duration}s | ${diffStat}`,
    `  config: model=${config.model} effort=${config.effort} mode=${config.modeFlow || "default"}`,
    `  diff: ${diffPath}`,
  ];
  if (files && files.length > 0) {
    lines.push("  files:");
    for (const f of files.slice(0, 20)) {
      lines.push(`    ${f}`);
    }
  }
  lines.push("  actions:");
  lines.push(`    review: node ${scriptPath} review --scope working-tree`);
  lines.push(`    revise: node ${scriptPath} send ${session.threadId} "<message>"`);
  lines.push(resultActionLine(scriptPath, jobId));
  return lines.join("\n");
}

export function formatErrorEvent(session, { errorCode, message, phase, origin = "turn", scriptPath, jobId = null }) {
  const lines = [
    `[ERROR] ${session.threadId} failed | ${errorCode}`,
    `  ${message}`,
    `  origin: ${origin}`,
    `  phase: ${phase || "unknown"}`,
    "  actions:",
    `    retry: node ${scriptPath} send ${session.threadId} "<revised prompt>"`,
    resultActionLine(scriptPath, jobId, "    log:   "),
    cancelActionLine(scriptPath, jobId),
  ];
  return lines.join("\n");
}

export function formatIncompleteEvent(session, { diffStat, diffPath, verdict, findingCount, missingItems, scriptPath, jobId = null }) {
  const lines = [
    `[INCOMPLETE] ${session.threadId} | ${diffStat}`,
    `  diff: ${diffPath}`,
    `  review: ${verdict} (${findingCount} findings)`,
  ];
  if (missingItems && missingItems.length > 0) {
    lines.push("  missing:");
    for (const item of missingItems) {
      lines.push(`    - ${item}`);
    }
  }
  lines.push("  actions:");
  lines.push(`    fix:  node ${scriptPath} send ${session.threadId} "Complete the missing items"`);
  lines.push(`    new:  node ${scriptPath} task --write "..."`);
  lines.push(resultActionLine(scriptPath, jobId));
  return lines.join("\n");
}

export function formatQuestionEvent(session, { requestId, questions, scriptPath }) {
  const lines = [`[QUESTION] ${session.threadId} ${requestId}`];
  for (const q of (questions || [])) {
    lines.push(`  "${q.question}"`);
    if (q.options && q.options.length > 0) {
      const letters = "abcdefghijklmnopqrstuvwxyz";
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        lines.push(`  (${letters[i]}) ${opt.label} — ${opt.description}`);
      }
      if (q.isOther) {
        lines.push("  [other: custom answer allowed]");
      }
    }
    lines.push("respond:");
    if (q.options && q.options.length > 0) {
      for (const opt of q.options) {
        lines.push(`  node ${scriptPath} respond ${requestId} --question-id ${q.id} --answer "${opt.label}"`);
      }
    } else {
      lines.push(`  node ${scriptPath} respond ${requestId} --question-id ${q.id} --answer "<answer>"`);
    }
  }
  return lines.join("\n");
}

export function formatPlanEvent(session, { turnId, planTitle, steps, planPath, scriptPath }) {
  const lines = [`[PLAN] ${session.threadId} ${turnId}`];
  lines.push(`  ${planTitle || "(untitled plan)"}`);
  if (steps && steps.length > 0) {
    for (const step of steps.slice(0, 10)) {
      lines.push(`  ${step.number ?? "-"}. [ ] ${step.text}`);
    }
    if (steps.length > 10) {
      lines.push(`  ... and ${steps.length - 10} more steps`);
    }
  }
  lines.push(`  plan: ${planPath}`);
  lines.push("actions:");
  lines.push(`  approve: node ${scriptPath} send ${session.threadId} --mode default "Implement the plan."`);
  lines.push(`  revise:  node ${scriptPath} send ${session.threadId} "<revision instructions>"`);
  return lines.join("\n");
}

export function formatConfirmedEvent(session, { requestId }) {
  return `[CONFIRMED] ${session.threadId} ${requestId} | codex resumed`;
}

export function formatHeartbeatEvent(session, { elapsedMs, phase, lastItem, lastItemAgeMs, pid, jobId = null, budgetRemainingMs = null, scriptPath = null }) {
  // Unconditional liveness pulse written to `.events` every ~60s during any
  // running turn. Purpose: an orchestrator tailing `events --follow` can never
  // go longer than the heartbeat interval without seeing *something* from the
  // bridge. Silence beyond ~90s is therefore a bug by definition — either the
  // bridge crashed without flushing a terminal tag, or the heartbeat timer
  // was never started. The `[HEARTBEAT]` block is **non-terminal**; it does
  // not trip `events --follow` self-termination.
  //
  // Each block carries a ready-to-paste re-attach command so an orchestrator
  // that loses its Monitor can recover from the most recent events-file line
  // alone. The pattern here mirrors formatDoneEvent's `actions:` block.
  const lines = [
    `[HEARTBEAT] ${session.threadId} t=${fmtSeconds(elapsedMs)} | phase=${phase ?? "?"} | pid=${pid ?? "?"}`,
  ];
  const itemLine =
    lastItem
      ? `  lastItem: ${lastItem}${
          Number.isFinite(lastItemAgeMs) ? ` (age ${fmtSeconds(lastItemAgeMs)})` : ""
        }`
      : "  lastItem: (none yet)";
  lines.push(itemLine);
  if (Number.isFinite(budgetRemainingMs) && budgetRemainingMs > 0) {
    lines.push(`  budget: ${fmtSeconds(budgetRemainingMs)} remaining`);
  }
  if (scriptPath && jobId) {
    lines.push(`  tail: ${formatTailCommand({ scriptPath, jobId })}`);
  }
  return lines.join("\n");
}

// Shared across formatHeartbeatEvent / formatCheckpointEvent. Same
// behavior as auto-pipeline.mjs's internal fmtSeconds — consolidated as
// the single source so `.events` time strings never drift.
export function fmtSeconds(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m${String(rem).padStart(2, "0")}s`;
}

// Canonical terminal-tag set — the three that self-terminate
// `events --follow`. Exported so the finally-backstop regex, Monitor's
// `terminal_tags` array, and every future consumer agree by construction.
export const TERMINAL_TAGS = Object.freeze(["DONE", "ERROR", "INCOMPLETE"]);
export const TERMINAL_TAG_REGEX = /^\[(DONE|ERROR|INCOMPLETE)\]/m;

// v1.4.0 — default Monitor/`events --follow` uses EXCLUSION instead of
// inclusion so new tags introduced by future bridge versions pass through
// automatically. Pre-1.4.0 the default was an inclusion list that silently
// dropped any tag not on the list — the "nothing is happening" class of
// failure. HEARTBEAT is the only tag excluded by default (every 60 s,
// pure liveness — would flood LLM context); CHECKPOINT and every
// interrupt-class tag (DONE, ERROR, INCOMPLETE, PLAN, QUESTION) pass
// through. An orchestrator who wants to also drop CHECKPOINT passes
// `--exclude HEARTBEAT,CHECKPOINT` explicitly.
export const DEFAULT_MONITOR_EXCLUDE = Object.freeze(["HEARTBEAT"]);

// Canonical tail invocation — reused by every `.events` block's `tail:`
// line and by `buildMonitorHint`. One builder so a change to the default
// exclusion list propagates everywhere that prints a re-attach hint.
export function formatTailCommand({ scriptPath, jobId, timeoutMs = 1_800_000, exclude = DEFAULT_MONITOR_EXCLUDE }) {
  const excludeClause = exclude && exclude.length > 0
    ? ` --exclude ${Array.from(exclude).join(",")}`
    : "";
  return `node ${scriptPath} events ${jobId} --follow${excludeClause} --timeout-ms ${timeoutMs}`;
}

// v1.3.0 — periodic rich digest of in-flight work. Emitted every 5 min (or
// `CODEX_BRIDGE_CHECKPOINT_MS`) alongside the 60-s heartbeat. The heartbeat
// proves liveness; the checkpoint summarizes what Codex *actually did* in
// the last interval so an orchestrator reviewing a running run can catch up
// from one block instead of scrolling the entire ndjson. Non-terminal.
//
// Sections:
//   - latest assistant message (full text, not truncated, so a reviewer
//     reads the same thing Codex just said — this is the most context-dense
//     signal per checkpoint)
//   - tools used (type + compact parameter preview; Read/Write/Edit/command
//     get path-level detail because those are what the orchestrator most
//     often wants to double-check before accepting work)
//   - git delta since the previous checkpoint (diff --stat + commit list)
//
// Every block also ends with a ready-to-paste re-attach tail command so an
// orchestrator that missed the preceding heartbeats can recover from the
// most recent checkpoint alone.
export function formatCheckpointEvent(session, {
  elapsedMs,
  phase,
  intervalMs,
  pid,
  jobId = null,
  lastAssistantMessage = null,
  tools = [],
  commits = [],
  diffStat = null,
  filesChangedSinceStart = null,
  scriptPath = null,
}) {
  const head = `[CHECKPOINT] ${session.threadId} t=${fmtSeconds(elapsedMs)} | phase=${phase ?? "?"} | interval=${fmtSeconds(intervalMs)} | pid=${pid ?? "?"}`;
  const lines = [head];

  if (lastAssistantMessage) {
    // Cap the assistant-message slice at ~8 KB. Codex can emit single
    // messages many KB long (full plans, long paste-of-error outputs);
    // embedding them verbatim in `.events` bloats the file and can break
    // naive line-based consumers. 8 KB is enough to read the intent while
    // keeping per-checkpoint blocks bounded.
    const MAX_ASSISTANT_MESSAGE_CHARS = 8_000;
    const raw = String(lastAssistantMessage).trim();
    if (raw) {
      const truncated = raw.length > MAX_ASSISTANT_MESSAGE_CHARS
        ? raw.slice(0, MAX_ASSISTANT_MESSAGE_CHARS) + `\n… (truncated, ${raw.length - MAX_ASSISTANT_MESSAGE_CHARS} more chars)`
        : raw;
      lines.push("  assistant:");
      for (const line of truncated.split("\n")) {
        lines.push(`    ${line}`);
      }
    } else {
      lines.push("  assistant: (no new assistant message this interval)");
    }
  } else {
    lines.push("  assistant: (no new assistant message this interval)");
  }

  lines.push(`  tools (${tools.length}):`);
  if (tools.length === 0) {
    lines.push("    (none)");
  } else {
    for (const t of tools) {
      // `summary` is a short one-liner provided by the caller (e.g.
      // "Read /path/to/file.ts lines 1-200" or "Edit src/foo.ts (+3 -1)").
      lines.push(`    - ${t.type}${t.summary ? `: ${t.summary}` : ""}`);
    }
  }

  if (commits && commits.length > 0) {
    lines.push(`  commits (${commits.length}):`);
    for (const c of commits) {
      lines.push(`    - ${c.sha} ${c.subject}`);
    }
  }

  if (diffStat) {
    lines.push(`  diff-since-last-checkpoint: ${diffStat}`);
  }
  if (filesChangedSinceStart) {
    lines.push(`  files-changed-since-turn-start: ${filesChangedSinceStart}`);
  }

  if (scriptPath && jobId) {
    lines.push(`  tail: ${formatTailCommand({ scriptPath, jobId })}`);
  }

  return lines.join("\n");
}

export function formatPipelineEvent(session, { stage, suffix, detail }) {
  // `suffix` makes start/done pairs explicit (e.g. `[PIPELINE:fix]` at start,
  // `[PIPELINE:fix:done]` at end) so `events --filter PIPELINE` gives a
  // symmetric stream an orchestrator can reason about. Pre-1.2.5 only the
  // start tag was written and callers of `events --follow` couldn't tell
  // whether the pipeline had actually stopped touching the repo — a
  // round-3 live delegation spent 15 min reconciling "did pipeline still run
  // after my commit?" because the bridge emitted nothing on completion.
  const head = suffix ? `PIPELINE:${stage}:${suffix}` : `PIPELINE:${stage}`;
  const ts = new Date().toISOString().slice(11, 19);
  return detail ? `[${head}] ${ts} ${detail}` : `[${head}] ${ts}`;
}

export function formatWarningEvent(session, { reason, family, threshold, sampleCommand, turnInterrupted }) {
  const lines = [
    `[WARNING] ${session.threadId} ${reason}`,
    `  family: ${family}`,
    `  threshold: ${threshold} consecutive failures`,
  ];
  if (sampleCommand) lines.push(`  sample: ${sampleCommand.slice(0, 120)}`);
  lines.push(`  turnInterrupted: ${turnInterrupted ? "yes" : "no"}`);
  return lines.join("\n");
}

export function formatPhaseEvent(session, { phase, detail }) {
  return `[PHASE] ${phase}${detail ? " " + detail : ""}`;
}

export function formatReviewEvent(session, { verdict, findingCount, findings, reviewPath, scriptPath }) {
  const lines = [`[REVIEW] ${session.threadId} verdict: ${verdict} | ${findingCount} findings`];
  if (findings && findings.length > 0) {
    for (const f of findings.slice(0, 5)) {
      lines.push(`  [${f.severity}] ${f.title} — ${f.file}:${f.line_start}`);
    }
    if (findings.length > 5) {
      lines.push(`  ... and ${findings.length - 5} more findings`);
    }
  }
  lines.push(`  full: ${reviewPath}`);
  lines.push("  actions:");
  lines.push(`    fix: node ${scriptPath} task --write "fix the ${findingCount} review findings"`);
  return lines.join("\n");
}
