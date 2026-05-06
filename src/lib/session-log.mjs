import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const MAX_UNTRACKED_STAT_BYTES = 256 * 1024;
export const NDJSON_EVENT_SCHEMA_VERSION = "1.0";
export const NDJSON_EVENT_FIELDS = Object.freeze([
  "schema_version",
  "ts",
  "tag",
  "method",
  "threadId",
  "data",
]);

export function resolveSessionDir(configDir, baseDir = process.cwd()) {
  const configured = configDir ?? "~/.codex-bridge/sessions";
  const expanded = configured.replace(/^~/, os.homedir());
  const dir = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
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

export function writeSessionAliases(session, jobId) {
  if (!session?.sessionDir || !session?.threadId || !jobId) return null;
  const aliasDir = path.join(session.sessionDir, "by-task");
  fs.mkdirSync(aliasDir, { recursive: true });
  const payload = {
    schema_version: "1.0",
    jobId,
    threadId: session.threadId,
    eventsPath: session.eventsPath,
    ndjsonPath: session.ndjsonPath,
    diffPath: path.join(session.sessionDir, `${session.threadId}.diff`),
  };
  const aliasPath = path.join(aliasDir, `${jobId}.json`);
  fs.writeFileSync(aliasPath, JSON.stringify(payload, null, 2) + "\n");
  for (const [suffix, target] of Object.entries({
    events: session.eventsPath,
    ndjson: session.ndjsonPath,
    diff: payload.diffPath,
  })) {
    const linkPath = path.join(aliasDir, `${jobId}.${suffix}`);
    try {
      fs.rmSync(linkPath, { force: true });
      fs.symlinkSync(target, linkPath);
    } catch {
      // Symlinks are best-effort; the JSON alias above is portable.
    }
  }
  return { ...payload, aliasPath };
}

export function findSession(sessionDir, threadId) {
  const ndjsonPath = path.join(sessionDir, `${threadId}.ndjson`);
  const eventsPath = path.join(sessionDir, `${threadId}.events`);
  if (!fs.existsSync(ndjsonPath)) {
    return null;
  }
  return { ndjsonPath, eventsPath, sessionDir, threadId };
}

export function readNdjson(sessionOrPath, { maxEntries = null } = {}) {
  const ndjsonPath = typeof sessionOrPath === "string" ? sessionOrPath : sessionOrPath?.ndjsonPath;
  if (!ndjsonPath || !fs.existsSync(ndjsonPath)) return [];
  const lines = fs.readFileSync(ndjsonPath, "utf8").split(/\r?\n/).filter(Boolean);
  const selected = Number.isInteger(maxEntries) && maxEntries > 0 ? lines.slice(-maxEntries) : lines;
  return selected.map((line, index) => {
    try {
      return canonicalizeNdjsonEvent(JSON.parse(line));
    } catch (error) {
      return {
        schema_version: NDJSON_EVENT_SCHEMA_VERSION,
        ts: null,
        tag: "CORRUPT_NDJSON_LINE",
        method: null,
        threadId: null,
        data: {
          line: index,
          raw: line,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
}

export function readEvents(sessionOrPath, { maxBlocks = null } = {}) {
  const eventsPath = typeof sessionOrPath === "string" ? sessionOrPath : sessionOrPath?.eventsPath;
  if (!eventsPath || !fs.existsSync(eventsPath)) return [];
  const raw = fs.readFileSync(eventsPath, "utf8");
  const blocks = raw
    .split(/\n(?=\[[^\]]+\])/)
    .map((block) => block.trim())
    .filter(Boolean);
  return Number.isInteger(maxBlocks) && maxBlocks > 0 ? blocks.slice(-maxBlocks) : blocks;
}

export function logNdjson(session, tag, method, data) {
  const entry = buildNdjsonEvent({
    ts: new Date().toISOString(),
    tag,
    method,
    threadId: session.threadId,
    data,
  });
  try {
    fs.appendFileSync(session.ndjsonPath, redactText(JSON.stringify(entry), session) + "\n");
  } catch {
    // Logging failure must not kill the task
  }
}

export function buildNdjsonEvent({ ts, tag, method = null, threadId = null, data = {} }) {
  return {
    schema_version: NDJSON_EVENT_SCHEMA_VERSION,
    ts,
    tag,
    method: method ?? null,
    threadId,
    data: data ?? {},
  };
}

function canonicalizeNdjsonEvent(entry) {
  return buildNdjsonEvent({
    ts: entry?.ts ?? null,
    tag: entry?.tag ?? null,
    method: entry?.method ?? null,
    threadId: entry?.threadId ?? null,
    data: entry?.data ?? {},
  });
}


export function logEvent(session, formattedBlock) {
  try {
    fs.appendFileSync(session.eventsPath, redactText(formattedBlock, session) + "\n");
  } catch {
    // Logging failure must not kill the task
  }
}

function redactText(text, session) {
  if (!session?.redactSecrets) return text;
  return String(text)
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)["']?[^"',\s}\\]+/gi, "$1[REDACTED]");
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

// v1.5.0 — cheap snapshot taken at turn/started so the terminal-failure
// path can report "these commits landed before the error" via [PARTIAL]
// and `result.partial`. Returns `{ headSha, porcelain, isoTimestamp }`.
// Silently returns `{ headSha: null, ... }` when `cwd` isn't a git repo —
// the bridge must keep running in non-repo contexts.
export function captureGitSnapshot(cwd) {
  const isoTimestamp = new Date().toISOString();
  try {
    const headResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 10000 });
    if (headResult.status !== 0 || !headResult.stdout) {
      return { headSha: null, porcelain: null, isoTimestamp };
    }
    const statusResult = spawnSync("git", ["status", "--porcelain=v1"], { cwd, encoding: "utf8", timeout: 10000 });
    return {
      headSha: headResult.stdout.trim(),
      porcelain: statusResult.status === 0 ? (statusResult.stdout ?? "") : "",
      isoTimestamp,
    };
  } catch {
    return { headSha: null, porcelain: null, isoTimestamp };
  }
}

// v1.5.0 — diff against a previous snapshot. Returns
// `{ commits, currentHeadSha, lastOkHeadSha, dirtyFiles, launchedAtIso }`
// — exactly the fields consumed by `formatPartialEvent` and the
// `result.partial` envelope field. If the snapshot was empty (non-repo),
// returns `{ commits: [], currentHeadSha: null, ... }` so the caller can
// skip emitting [PARTIAL].
export function diffGitSnapshot(cwd, snapshot) {
  if (!snapshot || !snapshot.headSha) {
    return { commits: [], currentHeadSha: null, lastOkHeadSha: null, dirtyFiles: [], launchedAtIso: snapshot?.isoTimestamp ?? null };
  }
  let commits = [];
  let currentHeadSha = null;
  let dirtyFiles = [];
  try {
    const logResult = spawnSync(
      "git",
      ["log", "--format=%h", `${snapshot.headSha}..HEAD`],
      { cwd, encoding: "utf8", timeout: 10000 }
    );
    if (logResult.status === 0 && logResult.stdout) {
      commits = logResult.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    }
    const headResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 10000 });
    if (headResult.status === 0 && headResult.stdout) {
      currentHeadSha = headResult.stdout.trim();
    }
    const statusResult = spawnSync("git", ["status", "--porcelain=v1"], { cwd, encoding: "utf8", timeout: 10000 });
    if (statusResult.status === 0 && statusResult.stdout) {
      dirtyFiles = statusResult.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    }
  } catch {
    // Swallow — partial reporting is best-effort
  }
  return {
    commits,
    currentHeadSha,
    lastOkHeadSha: snapshot.headSha,
    dirtyFiles,
    launchedAtIso: snapshot.isoTimestamp ?? null,
  };
}

export function captureGitDiff(cwd, session, options = {}) {
  const baseRef = typeof options.baseRef === "string" && options.baseRef.trim()
    ? options.baseRef.trim()
    : "HEAD";
  const numstatResult = spawnSync("git", ["diff", "--numstat", baseRef], { cwd, encoding: "utf8", timeout: 10000 });
  const fullResult = spawnSync("git", ["diff", baseRef], { cwd, encoding: "utf8", timeout: 10000 });
  const untrackedFiles = getUntrackedFileStats(cwd);

  const diffContent = appendUntrackedDiffMarkers(fullResult.stdout || "", untrackedFiles, baseRef);
  const diffPath = writeDiff(session, diffContent);

  const numstatOutput = numstatResult.stdout || "";
  const files = [...parseGitNumstat(numstatOutput), ...untrackedFiles];
  const summary = summarizeNumstat(files);

  return { diffStat: summary, files: files.map(formatFileStat), diffPath };
}

function getUntrackedFileStats(cwd) {
  try {
    const result = spawnSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd, encoding: "utf8", timeout: 10000 }
    );
    if (result.status !== 0 || !result.stdout) {
      return [];
    }
    return result.stdout
      .split("\0")
      .filter(Boolean)
      .map((fileName) => buildUntrackedFileStat(cwd, fileName))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildUntrackedFileStat(cwd, fileName) {
  const absolutePath = resolveInsideCwd(cwd, fileName);
  if (!absolutePath) {
    return null;
  }

  let sizeBytes = null;
  let adds = 0;
  try {
    const stat = fs.lstatSync(absolutePath);
    sizeBytes = stat.size;
    if (stat.isFile() && stat.size <= MAX_UNTRACKED_STAT_BYTES) {
      const content = fs.readFileSync(absolutePath);
      if (!looksBinary(content)) {
        adds = countTextLines(content);
      }
    }
  } catch {
    // Best-effort metadata only; still surface the untracked path.
  }

  return {
    fileName: displayGitPath(fileName),
    adds,
    dels: 0,
    status: "A",
    untracked: true,
    sizeBytes,
  };
}

function resolveInsideCwd(cwd, fileName) {
  const root = path.resolve(cwd);
  const absolutePath = path.resolve(root, fileName);
  if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) {
    return null;
  }
  return absolutePath;
}

function looksBinary(content) {
  return content.subarray(0, Math.min(content.length, 8000)).includes(0);
}

function countTextLines(content) {
  if (content.length === 0) {
    return 0;
  }
  const text = content.toString("utf8");
  const newlineCount = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlineCount : newlineCount + 1;
}

function displayGitPath(fileName) {
  return fileName.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function appendUntrackedDiffMarkers(diffContent, untrackedFiles, baseRef = "HEAD") {
  if (untrackedFiles.length === 0) {
    return diffContent;
  }
  const marker = formatUntrackedDiffMarkers(untrackedFiles, baseRef);
  if (!diffContent) {
    return marker;
  }
  return `${diffContent}${diffContent.endsWith("\n") ? "" : "\n"}${marker}`;
}

function formatUntrackedDiffMarkers(untrackedFiles, baseRef = "HEAD") {
  const lines = [`# Untracked files omitted from git diff ${baseRef}:`];
  for (const file of untrackedFiles) {
    const size = Number.isFinite(file.sizeBytes) ? `, ${file.sizeBytes} bytes` : "";
    lines.push(`diff --git a/${file.fileName} b/${file.fileName}`);
    lines.push("new file mode 100644");
    lines.push("--- /dev/null");
    lines.push(`+++ b/${file.fileName}`);
    lines.push("@@ untracked file @@");
    lines.push(`+<untracked file: ${file.fileName}${size}; content omitted from session diff>`);
  }
  return `${lines.join("\n")}\n`;
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

function formatFileStat({ fileName, adds, dels, status = null }) {
  const prefix = fileName.includes("=>") ? "R" : "M";
  if (status) {
    return `${status} ${fileName} (+${adds} -${dels})`;
  }
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
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function formatCwdFlag(cwd) {
  return cwd ? ` --cwd ${shellQuote(cwd)}` : "";
}

function commandPrefix(scriptPath, subcommand, cwd = null) {
  return `node ${shellQuote(scriptPath)} ${subcommand}${formatCwdFlag(cwd)}`;
}

function resultActionLine(scriptPath, jobId, indent = "    detail: ", cwd = null) {
  return jobId
    ? `${indent}${commandPrefix(scriptPath, "result", cwd)} ${jobId}`
    : `${indent}${commandPrefix(scriptPath, "result", cwd)}    # rerun with the specific job id from status`;
}
function cancelActionLine(scriptPath, jobId, indent = "    cancel: ", cwd = null) {
  return jobId
    ? `${indent}${commandPrefix(scriptPath, "cancel", cwd)} ${jobId}`
    : `${indent}${commandPrefix(scriptPath, "cancel", cwd)}    # rerun with the specific job id from status`;
}

function jobCommandCwd(cwd, stateCwd) {
  return stateCwd ?? cwd;
}

export function formatDoneEvent(session, { duration, diffStat, files, config, diffPath, scriptPath, jobId = null, cwd = null, stateCwd = null }) {
  const jobCwd = jobCommandCwd(cwd, stateCwd);
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
  lines.push(`    review: ${commandPrefix(scriptPath, "review", cwd)} --scope working-tree`);
  lines.push(`    revise: ${commandPrefix(scriptPath, "send", cwd)} ${session.threadId} "<message>"`);
  lines.push(resultActionLine(scriptPath, jobId, "    detail: ", jobCwd));
  return lines.join("\n");
}

// Cause-aware actions: the recovery move depends on the *origin* of the
// failure, not just the fact that one occurred. Pre-1.4.1 every [ERROR] block
// printed the same retry/log/cancel triple regardless of whether the turn was
// killed by the idle watchdog, a compact-proxy 502, a transport drop, or a
// pipeline-stage timeout — which actively misleads the orchestrator (e.g. a
// plain `send <threadId> "<revised prompt>"` on an idle timeout papers over
// a likely stall instead of extending the budget).
//
// Every branch also emits a `see:` line deep-linking into
// `skill/references/error-recovery.md` so an agent can pull the full recovery
// recipe in one read without relying on memory. Anchors are kept stable; new
// origins MUST register an anchor in error-recovery.md before landing here.
function buildActionsBlock({ origin, errorCode, scriptPath, threadId, jobId, failingStage, cwd = null, stateCwd = null }) {
  const lines = ["  actions:"];
  const see = (anchor) => `    see: skill/references/error-recovery.md#${anchor}`;
  const jobCwd = jobCommandCwd(cwd, stateCwd);

  if (origin === "upstream:response-chain-lost") {
    // Chain-lost: the upstream resp_id is dead. Same-thread `send` will repeat
    // the 400 forever. Recovery is a fresh task seeded from committed state;
    // `git log --oneline <launch-iso>` audits what survived.
    lines.push(
      `    new-task: ${commandPrefix(scriptPath, "task", cwd)} --json --mode default "<prompt rebased on last good sha>"    # do NOT send on the dead thread`,
      `    inspect:  git log --oneline <launch-iso>..HEAD    # audit what committed before the chain loss`,
      resultActionLine(scriptPath, jobId, "    log:     ", jobCwd),
      see("response-chain-lost"),
    );
    return lines;
  }

  if (origin === "upstream:auth") {
    lines.push(
      "    reauth:  run `codex login` (or reauth your upstream proxy if one is in the path)",
      "    do-not:  retry the same thread — auth is deterministic; the 401 will repeat",
      resultActionLine(scriptPath, jobId, "    log:    ", jobCwd),
      cancelActionLine(scriptPath, jobId, "    cancel: ", jobCwd),
      see("upstream-auth-401"),
    );
    return lines;
  }

  if (origin === "upstream:invalid-request") {
    lines.push(
      `    inspect: ${commandPrefix(scriptPath, "result", jobCwd)} ${jobId ?? threadId}    # read the upstream error.message; rebuild the prompt`,
      `    new-task: ${commandPrefix(scriptPath, "task", cwd)} --json --mode default "<fixed prompt>"`,
      see("upstream-invalid-request"),
    );
    return lines;
  }

  if (origin === "idle") {
    lines.push(
      `    relaunch: ${commandPrefix(scriptPath, "task", cwd)} --idle-timeout-ms 900000 --turn-default-ms 3600000 "<same prompt>"`,
      resultActionLine(scriptPath, jobId, "    log:   ", jobCwd),
      cancelActionLine(scriptPath, jobId, "    cancel: ", jobCwd),
      see("idle-timeout"),
    );
    return lines;
  }

  if (origin === "upstream:compact-proxy") {
    lines.push(
      "    narrow:  split the task, or trim required-reads before resending (the upstream compact proxy ran out of budget mid-turn)",
      `    resume:  ${commandPrefix(scriptPath, "send", cwd)} ${threadId} "<shorter follow-up>"`,
      resultActionLine(scriptPath, jobId, "    log:   ", jobCwd),
      see("compact-proxy-502"),
    );
    return lines;
  }

  if (origin === "upstream:transport") {
    lines.push(
      `    retry:   ${commandPrefix(scriptPath, "send", cwd)} ${threadId} "<same prompt>"    # workspace unchanged; prior reasoning is lost`,
      resultActionLine(scriptPath, jobId, "    log:   ", jobCwd),
      cancelActionLine(scriptPath, jobId, "    cancel: ", jobCwd),
      see("upstream-transport-drop"),
    );
    return lines;
  }

  if (typeof origin === "string" && origin.startsWith("pipeline:")) {
    // Pipeline origin: the main task may still have succeeded; only the
    // review/fix/check stage stalled. Guide the reader to inspect, rerun the
    // review from the current worktree, or relaunch with a wider pipeline
    // budget when the same stage repeatedly times out.
    const stageLine = failingStage ? ` (failing stage: ${failingStage})` : "";
    lines.push(
      `    inspect:     ${commandPrefix(scriptPath, "result", jobCwd)} ${jobId ?? threadId}    # main task may already be done${stageLine}`,
      `    rerun-review: ${commandPrefix(scriptPath, "review", cwd)} --scope working-tree`,
      `    extend-timeout: ${commandPrefix(scriptPath, "task", cwd)} --pipeline-stage-timeout-ms 1200000 --pipeline-total-timeout-ms 3600000 "<same prompt>"`,
      see("pipeline-stage-timeout"),
    );
    return lines;
  }

  // `bridge:*` origins (stall detector, unhandled exit) — the bridge itself
  // tripped a safety net. Action is to inspect logs + file a report.
  if (typeof origin === "string" && origin.startsWith("bridge")) {
    lines.push(
      resultActionLine(scriptPath, jobId, "    log:    ", jobCwd),
      cancelActionLine(scriptPath, jobId, "    cancel: ", jobCwd),
      see("bridge-unhandled-exit"),
    );
    return lines;
  }

  // Codex classifier codes: pick a smarter default per errorCode when we can.
  if (errorCode === "Unauthorized") {
    lines.push(
      "    login:  codex login",
      `    retry:  ${commandPrefix(scriptPath, "send", cwd)} ${threadId} "<revised prompt>"`,
      see("unauthorized"),
    );
    return lines;
  }
  if (errorCode === "ContextWindowExceeded") {
    lines.push(
      `    new:    ${commandPrefix(scriptPath, "task", cwd)} "<shorter prompt>"    # context window full; do not retry the same turn`,
      resultActionLine(scriptPath, jobId, "    log:   ", jobCwd),
      see("context-window-exceeded"),
    );
    return lines;
  }
  if (errorCode === "SandboxError") {
    lines.push(
      "    policy: set config.sandbox_policy: danger-full-access (or re-run with --write)",
      `    retry:  ${commandPrefix(scriptPath, "send", cwd)} ${threadId} "<revised prompt>"`,
      see("sandbox-denial"),
    );
    return lines;
  }

  // Default: the legacy retry/log/cancel triple — still sensible for generic
  // `origin: turn` failures without a more specific branch above.
  lines.push(
    `    retry: ${commandPrefix(scriptPath, "send", cwd)} ${threadId} "<revised prompt>"`,
    resultActionLine(scriptPath, jobId, "    log:   ", jobCwd),
    cancelActionLine(scriptPath, jobId, "    cancel: ", jobCwd),
  );
  return lines;
}

export function formatErrorEvent(session, { errorCode, message, phase, origin = "turn", failingStage = null, scriptPath, jobId = null, upstreamRequestId = null, cwd = null, stateCwd = null }) {
  const lines = [
    `[ERROR] ${session.threadId} failed | ${errorCode}`,
    `  ${message}`,
    `  origin: ${origin}`,
  ];
  if (failingStage) {
    lines.push(`  failing_stage: ${failingStage}`);
  }
  if (upstreamRequestId) {
    lines.push(`  upstream_request_id: ${upstreamRequestId}`);
  }
  lines.push(`  phase: ${phase || "unknown"}`);
  lines.push(...buildActionsBlock({
    origin,
    errorCode,
    scriptPath,
    threadId: session.threadId,
    jobId,
    failingStage,
    cwd,
    stateCwd,
  }));
  return lines.join("\n");
}

// v1.5.0 — emitted before an `[ERROR]` on any terminal failure where one or
// more commits landed during the turn (detected via git snapshot taken at
// `turn/started`). The `[PARTIAL]` block tells a reader "real work survived,
// the session id above is live, here is the last commit to rebase on" — which
// is the exact information a v1.4.1 operator had to hand-reconstruct from
// `git log` when a chain-lost 400 dropped into the `internal` bucket.
// Non-terminal by itself; the paired `[ERROR]` / `[HANDOFF]` is what trips
// Monitor self-termination.
export function formatPartialEvent(session, { commits = [], currentHeadSha = null, lastOkHeadSha = null, launchedAtIso = null, dirtyFiles = [], scriptPath = null, jobId = null, cwd = null, stateCwd = null }) {
  const jobCwd = jobCommandCwd(cwd, stateCwd);
  const lines = [`[PARTIAL] ${session.threadId} commits=[${commits.join(",")}]`];
  if (currentHeadSha) lines.push(`  current_head: ${currentHeadSha}`);
  if (lastOkHeadSha) lines.push(`  last_ok_head: ${lastOkHeadSha}`);
  if (launchedAtIso) lines.push(`  launched_at: ${launchedAtIso}`);
  if (dirtyFiles && dirtyFiles.length > 0) {
    lines.push("  dirty:");
    for (const f of dirtyFiles.slice(0, 20)) {
      lines.push(`    - ${f}`);
    }
    if (dirtyFiles.length > 20) lines.push(`    ... and ${dirtyFiles.length - 20} more`);
  }
  if (scriptPath && jobId) {
    lines.push(`  inspect: ${commandPrefix(scriptPath, "result", jobCwd)} ${jobId}`);
  }
  return lines.join("\n");
}

// v1.5.0 — emitted when the bridge is about to retry an upstream failure via
// the `UPSTREAM_RETRY_POLICY` loop. Non-terminal. Consumers watching
// `events --follow` see this *before* the retry fires so they know the
// bridge is still active rather than stalled.
export function formatRetryingEvent(session, { attempt, maxAttempts, backoffMs, origin, strategy, errorCode, reason = null }) {
  const lines = [
    `[RETRYING] ${session.threadId} attempt ${attempt}/${maxAttempts} | origin=${origin} | strategy=${strategy} | backoff=${backoffMs}ms`,
  ];
  if (errorCode) lines.push(`  last_error: ${errorCode}`);
  if (reason) lines.push(`  reason: ${reason}`);
  return lines.join("\n");
}

// v1.5.0 — terminal tag. Emitted when the `UPSTREAM_RETRY_POLICY` loop
// exhausts its budget (or immediately for origins with `strategy: "none"`
// like `upstream:auth`). The block renders the handoff envelope as a
// human-readable summary with explicit artifact paths + a relaunch template;
// the same data lives under `error.handoff` in the JSON envelope. Pairs with
// `[ERROR]` — Monitor treats the pair as a terminal combo (HANDOFF first,
// ERROR last so the existing TERMINAL_TAG_REGEX still fires on ERROR).
export function formatHandoffEvent(session, { reason, origin, errorCode, upstreamRequestId, session: sessionInfo, artifacts, partial, prompt, retries = [], scriptPath, cwd = null, stateCwd = null }) {
  const jobCwd = jobCommandCwd(cwd, stateCwd);
  const lines = [
    `[HANDOFF] ${session.threadId} reason=${reason} | origin=${origin}${errorCode ? ` | code=${errorCode}` : ""}`,
  ];
  if (upstreamRequestId) lines.push(`  upstream_request_id: ${upstreamRequestId}`);
  if (sessionInfo?.jobId) lines.push(`  job_id: ${sessionInfo.jobId}`);
  if (sessionInfo?.threadId) lines.push(`  thread_id: ${sessionInfo.threadId}`);
  if (artifacts) {
    lines.push("  artifacts:");
    if (artifacts.eventsPath) lines.push(`    events: ${artifacts.eventsPath}`);
    if (artifacts.workerErrPath) lines.push(`    worker_err: ${artifacts.workerErrPath}`);
    if (artifacts.diffPath) lines.push(`    diff: ${artifacts.diffPath}`);
    if (artifacts.planPath) lines.push(`    plan: ${artifacts.planPath}`);
    if (artifacts.reviewPath) lines.push(`    review: ${artifacts.reviewPath}`);
  }
  if (partial && Array.isArray(partial.commits) && partial.commits.length > 0) {
    lines.push(`  partial: commits=[${partial.commits.join(",")}] head=${partial.currentHeadSha ?? "?"} since=${partial.launchedAtIso ?? "?"}`);
  }
  if (prompt?.promptFilePath) {
    lines.push(`  prompt_file: ${prompt.promptFilePath}`);
  }
  if (retries && retries.length > 0) {
    lines.push(`  retries: ${retries.length} attempts logged`);
  }
  lines.push("  next:");
  if (scriptPath && sessionInfo?.jobId) {
    lines.push(`    read:     ${commandPrefix(scriptPath, "result", jobCwd)} ${sessionInfo.jobId} --json    # full handoff envelope under .error.handoff`);
  }
  if (partial?.lastOkHeadSha || partial?.currentHeadSha) {
    lines.push(`    audit:    git log --oneline ${partial.lastOkHeadSha ?? partial.currentHeadSha}..HEAD`);
  }
  lines.push(`    relaunch: ${commandPrefix(scriptPath, "task", cwd)} --json --mode default --prompt-file <rebased prompt>    # seed with last commit + remaining scope`);
  lines.push("    see: skill/references/orchestration-flows.md#recovering-from-upstream-state-loss");
  return lines.join("\n");
}

export function formatIncompleteEvent(session, { diffStat, diffPath, verdict, findingCount, failingStage = null, missingItems, scriptPath, jobId = null, cwd = null, stateCwd = null }) {
  const jobCwd = jobCommandCwd(cwd, stateCwd);
  const lines = [
    `[INCOMPLETE] ${session.threadId} | ${diffStat}`,
    `  diff: ${diffPath}`,
    `  review: ${verdict} (${findingCount} findings)`,
  ];
  if (failingStage) {
    lines.push(`  failing_stage: ${failingStage}`);
  }
  if (missingItems && missingItems.length > 0) {
    lines.push("  missing:");
    for (const item of missingItems) {
      lines.push(`    - ${item}`);
    }
  }
  lines.push("  actions:");
  lines.push(`    fix:  ${commandPrefix(scriptPath, "send", cwd)} ${session.threadId} "Complete the missing items"`);
  lines.push(`    new:  ${commandPrefix(scriptPath, "task", cwd)} --write "..."`);
  lines.push(resultActionLine(scriptPath, jobId, "    detail: ", jobCwd));
  return lines.join("\n");
}

export function formatQuestionEvent(session, { requestId, questions, scriptPath, cwd = null }) {
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
        lines.push(`  ${commandPrefix(scriptPath, "respond", cwd)} ${requestId} --question-id ${q.id} --answer ${shellQuote(opt.label)}`);
      }
    } else {
      lines.push(`  ${commandPrefix(scriptPath, "respond", cwd)} ${requestId} --question-id ${q.id} --answer "<answer>"`);
    }
  }
  return lines.join("\n");
}

export function formatPlanEvent(session, { turnId, planTitle, steps, planPath, scriptPath, cwd = null }) {
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
  lines.push(`  approve: ${commandPrefix(scriptPath, "send", cwd)} ${session.threadId} --mode default "Implement the plan."`);
  lines.push(`  revise:  ${commandPrefix(scriptPath, "send", cwd)} ${session.threadId} "<revision instructions>"`);
  return lines.join("\n");
}

export function formatConfirmedEvent(session, { requestId }) {
  return `[CONFIRMED] ${session.threadId} ${requestId} | codex resumed`;
}

export function formatHeartbeatEvent(session, { elapsedMs, phase, lastItem, lastItemAgeMs, pid, jobId = null, budgetRemainingMs = null, scriptPath = null, cwd = null, assistantPreview = null }) {
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
  if (assistantPreview) {
    lines.push(`  assistant: ${compactPreview(assistantPreview, 220)}`);
  }
  if (Number.isFinite(budgetRemainingMs) && budgetRemainingMs > 0) {
    lines.push(`  budget: ${fmtSeconds(budgetRemainingMs)} remaining`);
  }
  if (scriptPath && jobId) {
    lines.push(`  tail: ${formatTailCommand({ scriptPath, jobId, cwd })}`);
  }
  return lines.join("\n");
}

function compactPreview(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

// Shared across formatHeartbeatEvent / formatCheckpointEvent. Same
// behavior as the pipeline's former local fmtSeconds, consolidated here
// so `.events` time strings never drift.
export function fmtSeconds(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m${String(rem).padStart(2, "0")}s`;
}

// Canonical terminal-tag set — tags that self-terminate
// `events --follow`. Exported so the finally-backstop regex, Monitor's
// `terminal_tags` array, and every future consumer agree by construction.
export const TERMINAL_TAGS = Object.freeze(["DONE", "ERROR", "INCOMPLETE", "PLAN"]);
export const TERMINAL_TAG_REGEX = /^\[(DONE|ERROR|INCOMPLETE|PLAN)\]/m;

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
export function formatTailCommand({ scriptPath, jobId, timeoutMs = 1_800_000, exclude = DEFAULT_MONITOR_EXCLUDE, cwd = null }) {
  const excludeClause = exclude && exclude.length > 0
    ? ` --exclude ${Array.from(exclude).join(",")}`
    : "";
  return `${commandPrefix(scriptPath, "events", cwd)} ${jobId} --follow${excludeClause} --timeout-ms ${timeoutMs}`;
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
  cwd = null,
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
    lines.push(`  tail: ${formatTailCommand({ scriptPath, jobId, cwd })}`);
  }

  return lines.join("\n");
}

// v1.4.1 — first-event surface for the *effective* runtime config of the
// current turn. Emitted at `onTurnStart`, before the 5-minute CHECKPOINT
// cadence kicks in, so a reader who asks "what config did this run actually
// use?" can answer from `.events` directly. Solves the `skip_meta_skills`
// invisibility complaint: the directive influences prompt shape but emits
// nothing observable until now. Non-terminal.
export function formatDirectivesEvent(session, {
  mode,
  effort,
  sandbox,
  approval = null,
  quiet = false,
  skipMetaSkills = false,
  pipelineEnabled = [],
  model = null,
}) {
  const parts = [
    `mode=${mode}`,
    `effort=${effort}`,
    `sandbox=${sandbox}`,
  ];
  if (approval) parts.push(`approval=${approval}`);
  parts.push(`quiet=${quiet ? "true" : "false"}`);
  parts.push(`skip_meta_skills=${skipMetaSkills ? "true" : "false"}`);
  parts.push(`pipeline=${Array.isArray(pipelineEnabled) && pipelineEnabled.length > 0 ? pipelineEnabled.join(",") : "none"}`);
  if (model) parts.push(`model=${model}`);
  return `[DIRECTIVES] ${session.threadId} | ${parts.join(" | ")}`;
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

export function formatReviewEvent(session, { verdict, findingCount, findings, reviewPath, scriptPath, cwd = null }) {
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
  lines.push(`    fix: ${commandPrefix(scriptPath, "task", cwd)} --write "fix the ${findingCount} review findings"`);
  return lines.join("\n");
}

// v2.2.0 — Early stall warning (fires before the terminal StallDetected [ERROR]).
// Emitted after `stall_warning_threshold_ms` (default 5 min) of no actionable
// progress; the terminal StallDetected fires at the full 15-min window. An
// orchestrator can react to [STALL_WARNING] — steer or cancel — before the
// terminal tag forces a Monitor self-termination.
export function formatStallWarningEvent(session, { durationMs, thresholdMs, remainingMs, lastMeaningfulAction = null }) {
  const lines = [
    `[STALL_WARNING] ${session.threadId} no progress for ${fmtSeconds(durationMs)} | terminal in ${fmtSeconds(remainingMs)}`,
    `  threshold: ${fmtSeconds(thresholdMs)}`,
  ];
  if (lastMeaningfulAction) lines.push(`  last_action: ${lastMeaningfulAction}`);
  lines.push("  note: Codex is alive (heartbeats present) but no commands/file-changes/plans in this window.");
  return lines.join("\n");
}

// v2.2.0 — Composite attention-routing tag. Emitted alongside [QUESTION],
// [PLAN], and [ERROR] so an orchestrator monitoring N parallel jobs can filter
// a single tag to find "which jobs need me right now?" without merging three
// separate filter streams.
export function formatNeedsAttentionEvent(session, { underlyingTag, threadId, summary = null, nextAction = null }) {
  const lines = [
    `[NEEDS_ATTENTION] ${threadId ?? session.threadId} | underlying=${underlyingTag}`,
  ];
  if (summary) lines.push(`  summary: ${String(summary).slice(0, 200)}`);
  if (nextAction) lines.push(`  next_action: ${String(nextAction).slice(0, 200)}`);
  return lines.join("\n");
}

// v2.2.0 — Emitted when Codex creates a new file in the worktree (fileChange
// item with kind "create"). Gives the orchestrator an explicit "artifact
// landed" signal without having to diff the worktree or wait for [DONE].
export function formatArtifactEvent(session, { filePath, sizeBytes = null, threadId }) {
  const lines = [
    `[ARTIFACT] ${threadId ?? session.threadId} created ${filePath}`,
  ];
  if (sizeBytes != null && Number.isFinite(sizeBytes)) lines.push(`  size_bytes: ${sizeBytes}`);
  return lines.join("\n");
}

// v2.2.0 — Heuristic out-of-scope file detection. Fires when Codex touches
// files outside the inferred prompt scope (ratio > 30% AND total drifted > 3).
// False-positive risk is managed by the conservative ratio threshold; the
// orchestrator can adjust by cancelling or steering the thread.
export function formatDriftWarnEvent(session, { driftedFiles, driftRatio, promptScope, threadId }) {
  const lines = [
    `[DRIFT_WARN] ${threadId ?? session.threadId} | ${driftedFiles.length} out-of-scope files | ratio=${Math.round(driftRatio * 100)}%`,
  ];
  if (promptScope && promptScope.length > 0) {
    lines.push(`  prompt_scope: ${promptScope.slice(0, 5).join(", ")}${promptScope.length > 5 ? ` (+${promptScope.length - 5} more)` : ""}`);
  }
  if (driftedFiles.length > 0) {
    lines.push("  drifted:");
    for (const f of driftedFiles.slice(0, 10)) {
      lines.push(`    - ${f}`);
    }
    if (driftedFiles.length > 10) lines.push(`    ... and ${driftedFiles.length - 10} more`);
  }
  lines.push("  note: Codex is touching files outside the inferred prompt scope. Review or cancel to contain scope.");
  return lines.join("\n");
}
