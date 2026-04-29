import assert from "node:assert/strict";
import test from "node:test";

import { captureTurn } from "../src/lib/codex.mjs";

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

function turnStarted(threadId = "thread-1", turnId = "turn-1") {
  return {
    method: "turn/started",
    params: {
      threadId,
      turn: { id: turnId, status: "inProgress" }
    }
  };
}

function turnCompleted(threadId = "thread-1", turnId = "turn-1", status = "completed") {
  return {
    method: "turn/completed",
    params: {
      threadId,
      turn: { id: turnId, status }
    }
  };
}

test("captureTurn completes when terminal notification arrives before turn/start response", async () => {
  const client = new FakeTurnClient();
  const never = new Promise(() => {});

  const captured = captureTurn(client, "thread-1", () => {
    queueMicrotask(() => {
      client.notify(turnStarted());
      client.notify(turnCompleted());
    });
    return never;
  });

  const state = await captured;

  assert.equal(state.turnId, "turn-1");
  assert.equal(state.finalTurn.status, "completed");
  assert.equal(state.error, null);
});

test("captureTurn does not idle-timeout while a server request is pending", async () => {
  const client = new FakeTurnClient();
  let activityMarker = null;

  const captured = captureTurn(
    client,
    "thread-1",
    () => Promise.resolve({ turn: { id: "turn-1", status: "inProgress" } }),
    {
      idleTimeoutMs: 20,
      onActivityMarkerReady(marker) {
        activityMarker = marker;
      }
    }
  );

  await new Promise((resolve) => setTimeout(resolve, 5));
  const finishServerRequest = activityMarker.startServerRequest();
  await new Promise((resolve) => setTimeout(resolve, 70));
  client.notify(turnCompleted());
  finishServerRequest();

  const state = await captured;

  assert.equal(state.finalTurn.status, "completed");
  assert.equal(state.error, null);
});

test("captureTurn waits for interrupted turn completion after timeout", async () => {
  const client = new FakeTurnClient();
  const captured = captureTurn(
    client,
    "thread-1",
    () => {
      queueMicrotask(() => client.notify(turnStarted()));
      return Promise.resolve({ turn: { id: "turn-1", status: "inProgress" } });
    },
    {
      turnTimeoutMs: 10,
      interruptGraceMs: 1000
    }
  );

  let settled = false;
  captured.then(() => {
    settled = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(client.requests, [
    { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } }
  ]);
  assert.equal(settled, false);

  client.notify(turnCompleted("thread-1", "turn-1", "interrupted"));
  const state = await captured;

  assert.equal(state.finalTurn.status, "interrupted");
  assert.deepEqual(state.error, { message: "Turn timed out after 10ms.", code: "TurnTimeout" });
});
