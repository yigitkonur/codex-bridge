// test/new-event-tags.test.mjs — v2.2.0
// Unit tests for the four new observability event tags:
//   [STALL_WARNING], [NEEDS_ATTENTION], [ARTIFACT], [DRIFT_WARN]
import assert from "node:assert/strict";
import test from "node:test";

import {
  formatStallWarningEvent,
  formatNeedsAttentionEvent,
  formatArtifactEvent,
  formatDriftWarnEvent,
} from "../src/lib/session-log.mjs";

const session = {
  threadId: "test-thread-uuid-1234",
  sessionDir: "/tmp/codex-bridge-sessions",
  eventsPath: "/tmp/codex-bridge-sessions/test-thread-uuid-1234.events",
  ndjsonPath: "/tmp/codex-bridge-sessions/test-thread-uuid-1234.ndjson",
};

// ---------------------------------------------------------------------------
// [STALL_WARNING]
// ---------------------------------------------------------------------------

test("[STALL_WARNING] emits correct tag with required fields", () => {
  const block = formatStallWarningEvent(session, {
    durationMs: 5 * 60 * 1000,
    thresholdMs: 5 * 60 * 1000,
    remainingMs: 10 * 60 * 1000,
  });
  assert.match(block, /^\[STALL_WARNING\]/);
  assert.match(block, new RegExp(session.threadId));
  assert.match(block, /threshold:/);
  assert.match(block, /terminal in/);
});

test("[STALL_WARNING] includes last_action when provided", () => {
  const block = formatStallWarningEvent(session, {
    durationMs: 5 * 60 * 1000,
    thresholdMs: 5 * 60 * 1000,
    remainingMs: 10 * 60 * 1000,
    lastMeaningfulAction: "fileChange",
  });
  assert.match(block, /last_action: fileChange/);
});

test("[STALL_WARNING] omits last_action when not provided", () => {
  const block = formatStallWarningEvent(session, {
    durationMs: 5 * 60 * 1000,
    thresholdMs: 5 * 60 * 1000,
    remainingMs: 10 * 60 * 1000,
  });
  assert.doesNotMatch(block, /last_action/);
});

test("[STALL_WARNING] formats duration in readable time units", () => {
  const block = formatStallWarningEvent(session, {
    durationMs: 5 * 60 * 1000,  // 5 minutes
    thresholdMs: 5 * 60 * 1000,
    remainingMs: 10 * 60 * 1000,
  });
  // fmtSeconds(300000) = "5m"
  assert.match(block, /5m/);
});

// ---------------------------------------------------------------------------
// [NEEDS_ATTENTION]
// ---------------------------------------------------------------------------

test("[NEEDS_ATTENTION] emits correct tag for QUESTION underlying event", () => {
  const block = formatNeedsAttentionEvent(session, {
    underlyingTag: "QUESTION",
    threadId: session.threadId,
    summary: "What is the preferred output format?",
    nextAction: "respond req-123 --question-id q1 --answer yes",
  });
  assert.match(block, /^\[NEEDS_ATTENTION\]/);
  assert.match(block, /underlying=QUESTION/);
  assert.match(block, new RegExp(session.threadId));
});

test("[NEEDS_ATTENTION] emits correct tag for PLAN underlying event", () => {
  const block = formatNeedsAttentionEvent(session, {
    underlyingTag: "PLAN",
    threadId: session.threadId,
    summary: "Implement the auth module",
    nextAction: `send ${session.threadId} --mode default "Implement the plan."`,
  });
  assert.match(block, /underlying=PLAN/);
  assert.match(block, /summary:/);
  assert.match(block, /next_action:/);
});

test("[NEEDS_ATTENTION] emits correct tag for ERROR underlying event", () => {
  const block = formatNeedsAttentionEvent(session, {
    underlyingTag: "ERROR",
    threadId: session.threadId,
    summary: "StallDetected: no progress for 15 min",
    nextAction: null,
  });
  assert.match(block, /underlying=ERROR/);
  assert.doesNotMatch(block, /next_action/);
});

test("[NEEDS_ATTENTION] falls back to session threadId when threadId not provided", () => {
  const block = formatNeedsAttentionEvent(session, {
    underlyingTag: "QUESTION",
    summary: "question text",
  });
  assert.match(block, new RegExp(session.threadId));
});

test("[NEEDS_ATTENTION] truncates long summary at 200 chars", () => {
  const longSummary = "x".repeat(300);
  const block = formatNeedsAttentionEvent(session, {
    underlyingTag: "QUESTION",
    threadId: session.threadId,
    summary: longSummary,
  });
  // summary field should be present but truncated
  assert.match(block, /summary:/);
  // The block should not contain the full 300-char string after the prefix
  const summaryLine = block.split("\n").find((l) => l.includes("summary:")) ?? "";
  assert.ok(summaryLine.length < 250, "summary line should be truncated");
});

// ---------------------------------------------------------------------------
// [ARTIFACT]
// ---------------------------------------------------------------------------

test("[ARTIFACT] emits correct tag with file path", () => {
  const block = formatArtifactEvent(session, {
    filePath: "src/lib/new-module.mjs",
    threadId: session.threadId,
  });
  assert.match(block, /^\[ARTIFACT\]/);
  assert.match(block, /created src\/lib\/new-module\.mjs/);
  assert.match(block, new RegExp(session.threadId));
});

test("[ARTIFACT] includes size_bytes when provided", () => {
  const block = formatArtifactEvent(session, {
    filePath: "output/report.json",
    sizeBytes: 1234,
    threadId: session.threadId,
  });
  assert.match(block, /size_bytes: 1234/);
});

test("[ARTIFACT] omits size_bytes when not provided", () => {
  const block = formatArtifactEvent(session, {
    filePath: "output/report.json",
    sizeBytes: null,
    threadId: session.threadId,
  });
  assert.doesNotMatch(block, /size_bytes/);
});

test("[ARTIFACT] falls back to session threadId when threadId not provided", () => {
  const block = formatArtifactEvent(session, {
    filePath: "output/result.txt",
  });
  assert.match(block, new RegExp(session.threadId));
});

// ---------------------------------------------------------------------------
// [DRIFT_WARN]
// ---------------------------------------------------------------------------

test("[DRIFT_WARN] emits correct tag with drifted files", () => {
  const driftedFiles = ["lib/unrelated.mjs", "scripts/cleanup.sh", "docs/notes.md", "test/extra.test.mjs"];
  const block = formatDriftWarnEvent(session, {
    driftedFiles,
    driftRatio: 0.4,
    promptScope: ["src/auth.ts", "src/db/"],
    threadId: session.threadId,
  });
  assert.match(block, /^\[DRIFT_WARN\]/);
  assert.match(block, new RegExp(session.threadId));
  assert.match(block, /4 out-of-scope files/);
  assert.match(block, /ratio=40%/);
});

test("[DRIFT_WARN] includes prompt scope and drifted file list", () => {
  const driftedFiles = ["src/foo.mjs", "src/bar.mjs", "src/baz.mjs", "src/qux.mjs"];
  const block = formatDriftWarnEvent(session, {
    driftedFiles,
    driftRatio: 0.5,
    promptScope: ["src/auth.ts"],
    threadId: session.threadId,
  });
  assert.match(block, /prompt_scope:/);
  assert.match(block, /drifted:/);
  assert.match(block, /src\/foo\.mjs/);
});

test("[DRIFT_WARN] truncates drifted file list at 10 entries and shows overflow", () => {
  const driftedFiles = Array.from({ length: 15 }, (_, i) => `src/file${i}.mjs`);
  const block = formatDriftWarnEvent(session, {
    driftedFiles,
    driftRatio: 0.6,
    promptScope: ["other/path.ts"],
    threadId: session.threadId,
  });
  assert.match(block, /and 5 more/);
});

test("[DRIFT_WARN] truncates prompt scope list at 5 entries", () => {
  const driftedFiles = ["a.mjs", "b.mjs", "c.mjs", "d.mjs"];
  const block = formatDriftWarnEvent(session, {
    driftedFiles,
    driftRatio: 0.5,
    promptScope: ["p1.ts", "p2.ts", "p3.ts", "p4.ts", "p5.ts", "p6.ts"],
    threadId: session.threadId,
  });
  assert.match(block, /\+1 more/);
});

test("[DRIFT_WARN] falls back to session threadId when threadId not provided", () => {
  const block = formatDriftWarnEvent(session, {
    driftedFiles: ["a.mjs", "b.mjs", "c.mjs", "d.mjs"],
    driftRatio: 0.5,
    promptScope: ["src/"],
  });
  assert.match(block, new RegExp(session.threadId));
});

// ---------------------------------------------------------------------------
// Tag uniqueness — ensure no two new tags share a prefix with existing tags
// ---------------------------------------------------------------------------

test("new tags have distinct [TAG] prefixes from existing terminal tags", () => {
  const existingTerminal = ["DONE", "ERROR", "INCOMPLETE", "PLAN"];
  const newTags = ["STALL_WARNING", "NEEDS_ATTENTION", "ARTIFACT", "DRIFT_WARN"];
  for (const newTag of newTags) {
    assert.ok(
      !existingTerminal.includes(newTag),
      `${newTag} should not clash with a terminal tag`
    );
  }
});
