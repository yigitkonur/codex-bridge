import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  captureGitDiff,
  classifyPlanContent,
  formatDoneEvent,
  formatErrorEvent,
  formatHeartbeatEvent,
  formatPlanEvent,
  formatPlanReadyEvent,
  formatQuestionEvent,
  formatTailCommand,
  initSession,
  logEvent,
  logNdjson,
  NDJSON_EVENT_FIELDS,
  NDJSON_EVENT_SCHEMA_VERSION,
  readEvents,
  readNdjson,
  resolveSessionDir,
  TERMINAL_TAG_REGEX,
  TERMINAL_TAGS,
  writeSessionAliases
} from "../src/lib/session-log.mjs";

const session = {
  threadId: "thread-1",
  sessionDir: "/tmp/codex-bridge-sessions",
  eventsPath: "/tmp/codex-bridge-sessions/thread-1.events",
  ndjsonPath: "/tmp/codex-bridge-sessions/thread-1.ndjson"
};

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test("event action commands preserve originating cwd", () => {
  const cwd = "/tmp/project with spaces";

  assert.match(
    formatQuestionEvent(session, {
      requestId: "req-1",
      questions: [{ id: "q1", question: "Answer?", options: [] }],
      scriptPath: "/bridge/codex-bridge.mjs",
      cwd
    }),
    /respond --cwd '\/tmp\/project with spaces' req-1/
  );

  assert.match(
    formatPlanEvent(session, {
      turnId: "turn-1",
      planTitle: "Plan",
      steps: [],
      planPath: "/tmp/plan.md",
      scriptPath: "/bridge/codex-bridge.mjs",
      cwd
    }),
    /send --cwd '\/tmp\/project with spaces' thread-1 --mode default/
  );

  assert.match(
    formatDoneEvent(session, {
      duration: 1,
      diffStat: "0 files | +0 -0",
      files: [],
      config: { model: "gpt-test", effort: "high" },
      diffPath: "/tmp/diff",
      scriptPath: "/bridge/codex-bridge.mjs",
      jobId: "job-1",
      cwd
    }),
    /result --cwd '\/tmp\/project with spaces' job-1/
  );

  assert.match(
    formatPlanReadyEvent(session, {
      summary: "## Plan\nImplement the change.",
      classification: "code_write",
      scriptPath: "/bridge/codex-bridge.mjs",
      jobId: "job-1",
      cwd
    }),
    /send --cwd '\/tmp\/project with spaces' thread-1 --mode default "Implement the plan\."/
  );

  assert.match(
    formatTailCommand({
      scriptPath: "/bridge/codex-bridge.mjs",
      jobId: "job-1",
      cwd
    }),
    /events --cwd '\/tmp\/project with spaces' job-1 --follow/
  );
});

test("pipeline timeout error actions surface timeout relaunch budget", () => {
  const event = formatErrorEvent(session, {
    errorCode: "ClientTimeout",
    message: "auto-review exceeded 12m",
    phase: "pipeline (completed: diff)",
    origin: "pipeline:diff",
    failingStage: "review",    scriptPath: "/bridge/codex-bridge.mjs",
    jobId: "job-1",
    cwd: "/tmp/project",
  });

  assert.match(event, /inspect:\s+node '\/bridge\/codex-bridge\.mjs' result --cwd '\/tmp\/project' job-1/);
  assert.match(event, /rerun-review:\s+node '\/bridge\/codex-bridge\.mjs' review --cwd '\/tmp\/project' --scope working-tree/);
  assert.match(event, /extend-timeout:\s+node '\/bridge\/codex-bridge\.mjs' task --cwd '\/tmp\/project' --pipeline-stage-timeout-ms 1200000 --pipeline-total-timeout-ms 3600000 "<same prompt>"/);
  assert.match(event, /see: skill\/references\/error-recovery\.md#pipeline-stage-timeout/);
});

test("PLAN_READY is interrupt-class and renders approval actions", () => {
  const rendered = formatPlanReadyEvent(session, {
    summary: "## Plan\nImplement the change.",
    classification: "code_write",
    scriptPath: "/bridge/codex-bridge.mjs",
    jobId: "job-1",
    cwd: "/tmp/project",
  });

  assert.match(rendered, /^\[PLAN_READY\] thread-1 \| classification=code_write/m);
  assert.match(rendered, /summary:\n    ## Plan\n    Implement the change\./);
  assert.match(rendered, /approve:\s+node '\/bridge\/codex-bridge\.mjs' send --cwd '\/tmp\/project' thread-1 --mode default "Implement the plan\."/);
  assert.match(rendered, /revise:\s+node '\/bridge\/codex-bridge\.mjs' send --cwd '\/tmp\/project' thread-1 "Revise: <your feedback>"/);
  assert.match(rendered, /cancel:\s+node '\/bridge\/codex-bridge\.mjs' cancel --cwd '\/tmp\/project' job-1/);
  assert.doesNotMatch(rendered, TERMINAL_TAG_REGEX);
  assert.equal(TERMINAL_TAGS.includes("PLAN_READY"), false);
});

test("plan content classifier separates routing classes", () => {
  assert.equal(classifyPlanContent("Read the code and report findings."), "read_only");
  assert.equal(classifyPlanContent("Implement the fix in src/lib/task-runtime.mjs."), "code_write");
  assert.equal(classifyPlanContent("Deploy the package after tests pass."), "external");
  assert.equal(classifyPlanContent("Delete generated files with rm -rf dist."), "destructive");});

test("DONE event labels task diff separately from workspace diff", () => {
  const rendered = formatDoneEvent(session, {
    duration: 1,
    diffStat: "3 files | +10 -2",
    files: ["M dirty.txt (+9 -2)", "A new.txt (+1 -0)"],
    config: { model: "gpt-test", effort: "high" },
    diffPath: "/tmp/workspace.diff",
    taskDiff: { diffStat: "1 touched file", files: ["M new.txt (+? -?)"], diffPath: "" },
    workspaceDiff: { diffStat: "3 files | +10 -2", files: [], diffPath: "/tmp/workspace.diff" },
    workspaceWasClean: false,
    touchedFiles: ["new.txt"],    scriptPath: "/bridge/codex-bridge.mjs",
    jobId: "job-1",
    cwd: "/tmp/project",
  });

  assert.match(rendered.split("\n")[0], /1 touched file/);
  assert.match(rendered, /task_diff: 1 touched file/);
  assert.match(rendered, /workspace_diff: 3 files \| \+10 -2/);
  assert.match(rendered, /workspace_was_clean: false/);
  assert.match(rendered, /touchedFiles: \["new.txt"\]/);
});

test("session aliases map task ids to thread artifact paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-alias-"));
  const runtimeSession = initSession(dir, "019dec98-372f-7981-92e5-68c2da199012");
  const alias = writeSessionAliases(runtimeSession, "task-abc123");
  assert.equal(alias.jobId, "task-abc123");
  assert.equal(alias.threadId, runtimeSession.threadId);
  assert.equal(JSON.parse(fs.readFileSync(alias.aliasPath, "utf8")).eventsPath, runtimeSession.eventsPath);
});

test("secret redaction masks persisted event and ndjson text", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-redact-"));
  const runtimeSession = { ...initSession(dir, "thread-redact"), redactSecrets: true };
  logEvent(runtimeSession, "token=ghp_abcdefghijklmnopqrstuvwxyz123456");
  logNdjson(runtimeSession, "TEST", null, { value: "api_key=sk-abcdefghijklmnopqrstuvwxyz123456" });
  assert.doesNotMatch(fs.readFileSync(runtimeSession.eventsPath, "utf8"), /ghp_/);
  assert.doesNotMatch(fs.readFileSync(runtimeSession.ndjsonPath, "utf8"), /sk-/);
  assert.match(fs.readFileSync(runtimeSession.eventsPath, "utf8"), /REDACTED/);
});

test("heartbeat can surface compact assistant preview", () => {
  const rendered = formatHeartbeatEvent(session, {
    elapsedMs: 60_000,
    phase: "execute",
    lastItem: "agentMessage",
    lastItemAgeMs: 5_000,
    pid: 123,
    assistantPreview: "I am editing the pipeline and then I will run tests.",
  });
  assert.match(rendered, /assistant: I am editing the pipeline/);
});

test("event action commands quote bridge script path", () => {
  assert.equal(
    formatTailCommand({
      scriptPath: "/bridge dir/codex-bridge.mjs",
      jobId: "job-1"
    }),
    "node '/bridge dir/codex-bridge.mjs' events job-1 --follow --exclude HEARTBEAT --timeout-ms 1800000"
  );
});

test("relative session_dir resolves against workspace root, not process cwd", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-session-dir-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const workspace = path.join(tempRoot, "workspace");
  const otherCwd = path.join(tempRoot, "other");
  fs.mkdirSync(workspace);
  fs.mkdirSync(otherCwd);

  const previous = process.cwd();
  process.chdir(otherCwd);
  try {
    const resolved = resolveSessionDir(".codex-bridge/sessions", workspace);
    assert.equal(resolved, path.join(workspace, ".codex-bridge", "sessions"));
    assert.ok(fs.existsSync(resolved));
  } finally {
    process.chdir(previous);
  }
});

test("session replay helpers read append-only ndjson/events and preserve corrupt lines", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-replay-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const sessionDir = path.join(tempRoot, "sessions");
  const replaySession = initSession(sessionDir, "thread-replay");
  logNdjson(replaySession, "TURN_PARAMS", "turn/start", { model: "gpt-test" });
  fs.appendFileSync(replaySession.ndjsonPath, "{ not json\n", "utf8");
  logNdjson(replaySession, "DONE", "turn/completed", { status: 0 });

  logEvent(replaySession, "[PLAN] first\nbody");
  logEvent(replaySession, "[PIPELINE:review] start");
  logEvent(replaySession, "[DONE] second");

  const ndjson = readNdjson(replaySession);
  assert.equal(ndjson.length, 3);
  assert.deepEqual(Object.keys(ndjson[0]), NDJSON_EVENT_FIELDS);
  assert.equal(ndjson[0].schema_version, NDJSON_EVENT_SCHEMA_VERSION);
  assert.equal(ndjson[0].tag, "TURN_PARAMS");
  assert.equal(ndjson[1].schema_version, NDJSON_EVENT_SCHEMA_VERSION);
  assert.equal(ndjson[1].tag, "CORRUPT_NDJSON_LINE");
  assert.match(ndjson[1].data.raw, /not json/);
  assert.equal(ndjson[2].tag, "DONE");
  assert.deepEqual(readNdjson(replaySession, { maxEntries: 1 }).map((entry) => entry.tag), ["DONE"]);

  const events = readEvents(replaySession);
  assert.deepEqual(events, ["[PLAN] first\nbody", "[PIPELINE:review] start", "[DONE] second"]);
  assert.deepEqual(readEvents(replaySession, { maxBlocks: 1 }), ["[DONE] second"]);
});

test("logNdjson writes the canonical event schema", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-ndjson-schema-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const runtimeSession = initSession(tempRoot, "thread-schema");
  logNdjson(runtimeSession, "DONE", "turn/completed", { status: "completed" });

  const [rawLine] = fs.readFileSync(runtimeSession.ndjsonPath, "utf8").trim().split("\n");
  const event = JSON.parse(rawLine);
  assert.deepEqual(Object.keys(event), NDJSON_EVENT_FIELDS);
  assert.equal(event.schema_version, NDJSON_EVENT_SCHEMA_VERSION);
  assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(event.tag, "DONE");
  assert.equal(event.method, "turn/completed");
  assert.equal(event.threadId, "thread-schema");
  assert.deepEqual(event.data, { status: "completed" });
});

test("PLAN is a terminal event tag for wait/follow consumers", () => {
  assert.deepEqual(TERMINAL_TAGS, ["DONE", "ERROR", "INCOMPLETE", "PLAN"]);
  const match = TERMINAL_TAG_REGEX.exec("[PLAN] thread turn");
  assert.equal(match?.[1], "PLAN");
});

test("question response commands shell-quote option labels", () => {
  const event = formatQuestionEvent(session, {
    requestId: "req-1",
    questions: [{
      id: "q1",
      question: "Choose?",
      options: [
        { label: "Use \"prod\" $TOKEN and `cmd`", description: "metacharacters" },
        { label: "O'Reilly choice", description: "single quote" }
      ]
    }],
    scriptPath: "/bridge/codex-bridge.mjs"
  });

  const answerCommands = event
    .split("\n")
    .filter((line) => line.includes(" --answer "));

  assert.deepEqual(answerCommands, [
    "  node '/bridge/codex-bridge.mjs' respond req-1 --question-id q1 --answer 'Use \"prod\" $TOKEN and `cmd`'",
    "  node '/bridge/codex-bridge.mjs' respond req-1 --question-id q1 --answer 'O'\\''Reilly choice'"
  ]);
});

test("captureGitDiff includes unstaged untracked files", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-session-log-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const sessionDir = path.join(tempRoot, "sessions");
  fs.mkdirSync(repo);
  fs.mkdirSync(sessionDir);

  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "codex-bridge@example.test"]);
  runGit(repo, ["config", "user.name", "Codex Bridge Test"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  runGit(repo, ["add", "tracked.txt"]);
  runGit(repo, ["commit", "-m", "initial"]);

  fs.writeFileSync(path.join(repo, "new-file.txt"), "one\ntwo\n");

  const captured = captureGitDiff(repo, {
    threadId: "thread-untracked",
    sessionDir,
  });

  assert.equal(captured.diffStat, "1 files | +2 -0");
  assert.deepEqual(captured.files, ["A new-file.txt (+2 -0)"]);

  const diffContent = fs.readFileSync(captured.diffPath, "utf8");
  assert.match(diffContent, /Untracked files omitted from git diff HEAD/);
  assert.match(diffContent, /diff --git a\/new-file\.txt b\/new-file\.txt/);
  assert.match(diffContent, /<untracked file: new-file\.txt, 8 bytes; content omitted from session diff>/);
});

test("captureGitDiff can summarize committed work since an explicit base ref", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-session-log-base-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const sessionDir = path.join(tempRoot, "sessions");
  fs.mkdirSync(repo);
  fs.mkdirSync(sessionDir);

  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "codex-bridge@example.test"]);
  runGit(repo, ["config", "user.name", "Codex Bridge Test"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  runGit(repo, ["add", "tracked.txt"]);
  runGit(repo, ["commit", "-m", "initial"]);
  const base = runGit(repo, ["rev-parse", "HEAD"]).stdout.trim();

  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\nnext\n");
  fs.writeFileSync(path.join(repo, "committed.txt"), "one\n");
  runGit(repo, ["add", "tracked.txt", "committed.txt"]);
  runGit(repo, ["commit", "-m", "worker commit"]);

  const captured = captureGitDiff(repo, {
    threadId: "thread-base",
    sessionDir,
  }, { baseRef: base });

  assert.equal(captured.diffStat, "2 files | +2 -0");
  assert.deepEqual(captured.files.sort(), [
    "M committed.txt (+1 -0)",
    "M tracked.txt (+1 -0)",
  ]);

  const diffContent = fs.readFileSync(captured.diffPath, "utf8");
  assert.match(diffContent, /diff --git a\/committed\.txt b\/committed\.txt/);
  assert.match(diffContent, /diff --git a\/tracked\.txt b\/tracked\.txt/);
});
