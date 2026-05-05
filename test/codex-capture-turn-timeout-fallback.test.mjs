import assert from "node:assert/strict";
import test from "node:test";

import { captureTurn } from "../src/adapters/codex/codex.mjs";

class FakeTurnClient {
  constructor() {
    this.notificationHandler = null;
    this.listeners = new Map();
    this.requests = [];
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  on(eventName, handler) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName).add(handler);
  }

  off(eventName, handler) {
    this.listeners.get(eventName)?.delete(handler);
  }

  request(method, params) {
    this.requests.push({ method, params });
    return Promise.resolve({});
  }

  notify(message) {
    this.notificationHandler?.(message);
  }
}

test("turn timeout interrupts using threadTurnIds when state.turnId is unset", async () => {
  // Engineer the F2 precondition: state.turnId is null (no `turn/started` for
  // state.threadId arrived and the response carries no turn id), yet
  // state.threadTurnIds has a recorded turn id for state.threadId. Without F2 the
  // turn-timeout body skips `turn/interrupt` because it only consults
  // state.turnId; with F2 it falls back to threadTurnIds and issues the cancel.
  const client = new FakeTurnClient();

  const captured = captureTurn(
    client,
    "thread-1",
    () => {
      // Resolve with no turn id so post-response code does not set state.turnId.
      return Promise.resolve({});
    },
    {
      turnTimeoutMs: 30,
      interruptGraceMs: 1000,
      onResponse(_response, state) {
        // Populate threadTurnIds for state.threadId without touching state.turnId.
        // This simulates a buffered subagent flush or out-of-order race that
        // recorded the turn id while the root state.turnId is still unresolved.
        state.threadTurnIds.set(state.threadId, "TURN-FALLBACK");
      }
    }
  );

  let settled = false;
  captured.then(() => {
    settled = true;
  });

  // Wait long enough for turnTimeoutMs to fire.
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(client.requests, [
    { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "TURN-FALLBACK" } }
  ]);
  assert.equal(settled, false);

  // Deliver the corresponding turn/completed (interrupted) so captureTurn settles.
  client.notify({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "TURN-FALLBACK", status: "interrupted" } }
  });

  const state = await captured;

  assert.equal(state.finalTurn?.status, "interrupted");
  assert.equal(state.error?.code, "TurnTimeout");
});

test("turn timeout falls through to failed completion when no turn id is known", async () => {
  // No state.turnId, no threadTurnIds entry: F2 still falls through to failed
  // completion but emits a diagnostic on state.onProgress so the gap is observable.
  const client = new FakeTurnClient();
  const progressEvents = [];

  const captured = captureTurn(
    client,
    "thread-1",
    () => {
      return Promise.resolve({});
    },
    {
      turnTimeoutMs: 30,
      onProgress(update) {
        progressEvents.push(typeof update === "string" ? update : update?.message);
      }
    }
  );

  let guardTimer = null;
  const state = await Promise.race([
    captured,
    new Promise((_, reject) => {
      guardTimer = setTimeout(
        () => reject(new Error("captureTurn did not settle after turn timeout")),
        500
      );
    })
  ]).finally(() => {
    if (guardTimer) clearTimeout(guardTimer);
  });

  assert.equal(state.finalTurn?.status, "failed");
  assert.equal(state.error?.code, "TurnTimeout");
  assert.deepEqual(client.requests, []);
  assert.ok(
    progressEvents.some((message) =>
      typeof message === "string" && message.includes("turn timeout fired before turn id known")
    ),
    `expected diagnostic about missing turn id; got ${JSON.stringify(progressEvents)}`
  );
});
