import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  captureGitDiff,
  formatDoneEvent,
  formatPlanEvent,
  formatQuestionEvent,
  formatTailCommand
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
    formatTailCommand({
      scriptPath: "/bridge/codex-bridge.mjs",
      jobId: "job-1",
      cwd
    }),
    /events --cwd '\/tmp\/project with spaces' job-1 --follow/
  );
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
