import assert from "node:assert/strict";
import test from "node:test";

import { __testHooks__ } from "../src/adapters/codex/broker.mjs";

const { createStreamTracker } = __testHooks__;

// Sentinel object stands in for a downstream socket. The tracker only checks
// reference equality on it and never calls socket methods, so a plain object
// is sufficient.
function makeSocket(id = "downstream") {
  return { id };
}

test("stream releases when sub-thread completion arrives BEFORE its collabAgentToolCall registration", () => {
  const tracker = createStreamTracker();
  const socket = makeSocket();

  // 1. turn/start{threadId: "tid-root"} resolves: register the stream.
  tracker.registerStream(socket, new Set(["tid-root"]));
  assert.equal(tracker.getActiveStreamSocket(), socket);

  // 2. Sub-thread turn/completed arrives BEFORE the collabAgentToolCall that
  //    would register tid-sub as a receiver thread. With the fix, this is
  //    staged in pendingThreadCompletions. Without the fix (HEAD), the
  //    legacy guard `!activeStreamThreadIds.has(threadId)` would drop it.
  tracker.maybeReleaseStream(
    { method: "turn/completed", params: { threadId: "tid-sub" } },
    socket
  );
  assert.equal(
    tracker.getActiveStreamSocket(),
    socket,
    "stream must remain active while root turn is still running"
  );

  // 3. collabAgentToolCall registers tid-sub as a receiver thread. The fix
  //    drains pendingThreadCompletions for tid-sub, promoting it into
  //    activeCompletedThreadIds and re-evaluating the release condition.
  tracker.noteStreamThreads({
    method: "item/completed",
    params: {
      item: {
        type: "collabAgentToolCall",
        receiverThreadIds: ["tid-sub"]
      }
    }
  });
  assert.equal(
    tracker.getActiveStreamSocket(),
    socket,
    "stream must remain active until the root thread also completes"
  );

  // 4. Final turn/completed for the root thread. Now both tid-root and
  //    tid-sub are present in activeCompletedThreadIds; the stream releases.
  tracker.maybeReleaseStream(
    { method: "turn/completed", params: { threadId: "tid-root" } },
    socket
  );
  assert.equal(
    tracker.getActiveStreamSocket(),
    null,
    "stream must release once every known thread has a recorded completion"
  );
});

test("stream stays active when a known thread has not yet completed", () => {
  const tracker = createStreamTracker();
  const socket = makeSocket();

  tracker.registerStream(socket, new Set(["tid-root"]));
  tracker.noteStreamThreads({
    method: "item/completed",
    params: {
      item: {
        type: "collabAgentToolCall",
        receiverThreadIds: ["tid-sub"]
      }
    }
  });

  // Only sub-thread completes; root has not.
  tracker.maybeReleaseStream(
    { method: "turn/completed", params: { threadId: "tid-sub" } },
    socket
  );
  assert.equal(
    tracker.getActiveStreamSocket(),
    socket,
    "stream must stay active until tid-root also completes"
  );

  tracker.maybeReleaseStream(
    { method: "turn/completed", params: { threadId: "tid-root" } },
    socket
  );
  assert.equal(tracker.getActiveStreamSocket(), null);
});

test("clearAllStreamState resets pendingThreadCompletions alongside other state", () => {
  const tracker = createStreamTracker();
  const socket = makeSocket();

  tracker.registerStream(socket, new Set(["tid-root"]));
  tracker.maybeReleaseStream(
    { method: "turn/completed", params: { threadId: "tid-orphan" } },
    socket
  );

  tracker.clearAllStreamState();
  assert.equal(tracker.getActiveStreamSocket(), null);

  // Re-register and arrive at orphan completion again. Without proper
  // clearing, residual pendingThreadCompletions could pollute the new
  // stream's reconciliation. Verify the new stream releases on its root
  // completion regardless of stale pending state.
  tracker.registerStream(socket, new Set(["tid-root2"]));
  tracker.maybeReleaseStream(
    { method: "turn/completed", params: { threadId: "tid-root2" } },
    socket
  );
  assert.equal(tracker.getActiveStreamSocket(), null);
});

test("falsification proof: pre-fix per-thread tracking with drop-guard cannot release after early-arrival", () => {
  // This sub-test mirrors the audit baseline that the D1 fix targets — a
  // broker variant that combines (a) per-thread `activeCompletedThreadIds`
  // tracking with (b) the legacy guard `!activeStreamThreadIds.has(threadId)`
  // that DROPS completions for unknown threads. In that variant, the
  // early-arrival sub-thread completion is silently lost; when its
  // collabAgentToolCall later registers it, no reconciliation set exists to
  // recover the dropped completion, and the final root completion can no
  // longer satisfy the `every` check. This is the exact wedge the
  // pendingThreadCompletions reconciliation set fixes.
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  let activeCompletedThreadIds = null;

  function preFixMaybeReleaseStream(message, target) {
    if (message.method !== "turn/completed" || activeStreamSocket !== target) {
      return;
    }
    const threadId = message.params?.threadId ?? null;
    // Buggy guard: drop completions whose threadId is not yet known.
    if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
      if (!activeCompletedThreadIds) activeCompletedThreadIds = new Set();
      if (threadId) activeCompletedThreadIds.add(threadId);
      const allKnownThreadsComplete = [...(activeStreamThreadIds ?? [])]
        .every((id) => activeCompletedThreadIds.has(id));
      if (!threadId || allKnownThreadsComplete) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        activeCompletedThreadIds = null;
      }
    }
  }

  function preFixNoteStreamThreads(message) {
    const item = message?.params?.item ?? null;
    if (item?.type !== "collabAgentToolCall") return;
    for (const tid of item.receiverThreadIds ?? []) {
      if (activeStreamThreadIds) activeStreamThreadIds.add(tid);
    }
  }

  const socket = makeSocket();
  activeStreamSocket = socket;
  activeStreamThreadIds = new Set(["tid-root"]);
  activeCompletedThreadIds = new Set();

  // 1. Sub-thread turn/completed arrives BEFORE its collabAgentToolCall.
  //    Pre-fix guard drops the completion entirely.
  preFixMaybeReleaseStream(
    { method: "turn/completed", params: { threadId: "tid-sub" } },
    socket
  );
  assert.equal(activeStreamSocket, socket, "pre-fix: stream still active after dropped early completion (expected)");
  assert.deepEqual(
    [...activeCompletedThreadIds],
    [],
    "pre-fix: tid-sub completion was dropped — no reconciliation set captured it"
  );

  // 2. collabAgentToolCall registers tid-sub.
  preFixNoteStreamThreads({
    method: "item/completed",
    params: { item: { type: "collabAgentToolCall", receiverThreadIds: ["tid-sub"] } }
  });

  // 3. Root turn/completed arrives. The guard passes (tid-root is known)
  //    and tid-root is added to completed. But tid-sub was never recorded,
  //    so the `every` check fails and the stream cannot release.
  preFixMaybeReleaseStream(
    { method: "turn/completed", params: { threadId: "tid-root" } },
    socket
  );
  assert.equal(
    activeStreamSocket,
    socket,
    "falsification: pre-fix code cannot release because the dropped tid-sub completion is unrecoverable"
  );

  // Now exercise the SAME scenario through the post-fix tracker and assert
  // the stream releases — proving the D1 reconciliation fixes the wedge.
  const tracker = createStreamTracker();
  const sock2 = makeSocket("downstream-2");
  tracker.registerStream(sock2, new Set(["tid-root"]));
  tracker.maybeReleaseStream(
    { method: "turn/completed", params: { threadId: "tid-sub" } },
    sock2
  );
  tracker.noteStreamThreads({
    method: "item/completed",
    params: { item: { type: "collabAgentToolCall", receiverThreadIds: ["tid-sub"] } }
  });
  tracker.maybeReleaseStream(
    { method: "turn/completed", params: { threadId: "tid-root" } },
    sock2
  );
  assert.equal(
    tracker.getActiveStreamSocket(),
    null,
    "post-fix: pendingThreadCompletions reconciliation releases the stream where pre-fix wedged"
  );
});
