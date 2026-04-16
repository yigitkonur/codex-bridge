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

export function formatDoneEvent(session, { duration, diffStat, files, config, diffPath, scriptPath }) {
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
  lines.push(`    detail: node ${scriptPath} result ${session.threadId}`);
  return lines.join("\n");
}

export function formatErrorEvent(session, { errorCode, message, phase, scriptPath }) {
  const lines = [
    `[ERROR] ${session.threadId} failed | ${errorCode}`,
    `  ${message}`,
    `  phase: ${phase || "unknown"}`,
    "  actions:",
    `    retry: node ${scriptPath} send ${session.threadId} "<revised prompt>"`,
    `    log:   node ${scriptPath} result ${session.threadId}`,
    `    cancel: node ${scriptPath} cancel ${session.threadId}`,
  ];
  return lines.join("\n");
}

export function formatIncompleteEvent(session, { diffStat, diffPath, verdict, findingCount, missingItems, scriptPath }) {
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
  lines.push(`    detail: node ${scriptPath} result ${session.threadId}`);
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

export function formatPipelineEvent(session, { stage }) {
  return `[PIPELINE:${stage}] ${new Date().toISOString().slice(11, 19)}`;
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
