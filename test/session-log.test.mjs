import assert from "node:assert/strict";
import test from "node:test";

import {
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
