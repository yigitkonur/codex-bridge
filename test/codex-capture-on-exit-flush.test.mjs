import assert from "node:assert/strict";
import test from "node:test";

import { captureTurn } from "../src/adapters/codex/codex.mjs";

class FakeTurnClient {
  constructor() {
    this.notificationHandler = null;
    this.listeners = new Map();
    this.requests = [];
    this.exitFired = false;
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

  fireExit() {
    if (this.exitFired) {
      return;
    }
    this.exitFired = true;
    for (const handler of this.listeners.get("exit") ?? []) {
      handler(new Error("transport closed"));
    }
  }
}

test("captureTurn replays a buffered terminal turn/completed when the transport exits", async () => {
  const client = new FakeTurnClient();
  const never = new Promise(() => {});
  // Engineer the F1 precondition: state.turnId stays null (startRequest never resolves
  // and we never deliver a state.threadId terminal through the early-establish path),
  // but a `turn/completed` for state.threadId still ends up inside
  // `state.bufferedNotifications`. We exploit that the notification handler buffers
  // by-reference, then mutate the buffered object to match state.threadId before
  // firing the transport exit. Without F1 the onExit handler ignores the buffer and
  // returns "failed"; with F1 it replays the terminal and reports "completed".
  const sneaky = {
    method: "turn/completed",
    params: {
      threadId: "subagent-1",
      turn: { id: "turn-real", status: "completed" }
    }
  };

  const captured = captureTurn(client, "thread-1", () => {
    queueMicrotask(() => {
      // First push: buffered (different threadId so the early-establish branch skips).
      client.notify(sneaky);
      // Mutate in place so the buffered entry now matches state.threadId for F1's scan.
      sneaky.params.threadId = "thread-1";
      client.fireExit();
    });
    return never;
  });

  const state = await captured;

  assert.equal(state.finalTurn?.status, "completed");
  assert.equal(state.finalTurn?.id, "turn-real");
  assert.equal(state.error, null);
});

test("captureTurn falls through to failed completion on exit when no buffered terminal matches", async () => {
  const client = new FakeTurnClient();
  const never = new Promise(() => {});

  const captured = captureTurn(client, "thread-1", () => {
    queueMicrotask(() => {
      // Buffer a non-terminal subagent notification so the buffer is non-empty
      // but holds no matching terminal for state.threadId.
      client.notify({
        method: "item/completed",
        params: {
          threadId: "subagent-2",
          item: { type: "agentMessage", text: "hi" }
        }
      });
      client.fireExit();
    });
    return never;
  });

  const state = await captured;

  assert.equal(state.finalTurn?.status, "failed");
  assert.deepEqual(state.error, { message: "Codex app-server exited unexpectedly" });
});
