import assert from "node:assert/strict";
import test from "node:test";

import { AppServerClientBase } from "../src/adapters/codex/protocol.mjs";

class FakeClient extends AppServerClientBase {
  constructor() {
    super(process.cwd());
    this.sent = [];
  }

  sendMessage(message) {
    this.sent.push(message);
  }
}

test("request() rejects with abort reason and removes pending entry when signal aborts", async () => {
  const client = new FakeClient();
  const controller = new AbortController();

  const promise = client.request("thread/read", { threadId: "thread-1" }, { signal: controller.signal });

  // Pending entry exists before abort.
  assert.equal(client.pending.size, 1);
  assert.equal(client.sent.length, 1);

  const reason = new Error("turn cancelled by parent");
  controller.abort(reason);

  await assert.rejects(promise, (err) => err === reason);
  // Pending map cleaned up.
  assert.equal(client.pending.size, 0);
  // Client transport remains open.
  assert.equal(client.closed, false);
});

test("request() with pre-aborted signal rejects immediately and never adds a pending entry", async () => {
  const client = new FakeClient();
  const controller = new AbortController();
  const reason = new Error("aborted before send");
  controller.abort(reason);

  const before = client.nextId;
  const promise = client.request("thread/read", { threadId: "thread-1" }, { signal: controller.signal });

  await assert.rejects(promise, (err) => err === reason);
  // No pending entry was created.
  assert.equal(client.pending.size, 0);
  // No message was placed on the wire.
  assert.equal(client.sent.length, 0);
  // ID counter was not consumed.
  assert.equal(client.nextId, before);
});

test("request() without options behaves identically to legacy two-arg form", async () => {
  const client = new FakeClient();
  const promise = client.request("thread/read", { threadId: "thread-1" });

  // Pending entry was created and message was sent.
  assert.equal(client.pending.size, 1);
  assert.equal(client.sent.length, 1);
  const sent = client.sent[0];
  assert.equal(sent.method, "thread/read");
  assert.deepEqual(sent.params, { threadId: "thread-1" });

  // Simulate a normal response from the server.
  client.handleLine(JSON.stringify({ id: sent.id, result: { ok: true } }));

  const result = await promise;
  assert.deepEqual(result, { ok: true });
  assert.equal(client.pending.size, 0);
});

test("request() with non-aborted signal still resolves normally and removes the abort listener", async () => {
  const client = new FakeClient();
  const controller = new AbortController();

  const promise = client.request("thread/read", { threadId: "thread-1" }, { signal: controller.signal });
  assert.equal(client.pending.size, 1);
  const sent = client.sent[0];

  // Resolve via the normal pending-map path.
  client.handleLine(JSON.stringify({ id: sent.id, result: { ok: true } }));
  const result = await promise;
  assert.deepEqual(result, { ok: true });
  assert.equal(client.pending.size, 0);

  // Aborting after the request resolved is a no-op (no error thrown, no pending change).
  controller.abort(new Error("late abort"));
  assert.equal(client.pending.size, 0);
});

test("captureTurn aborts startRequest pending entry when state.completion wins the race", async () => {
  // Late-import to avoid circular metadata at module-load time.
  const { captureTurn } = await import("../src/lib/codex.mjs");

  const client = new FakeClient();

  // startRequest captures the signal and only resolves if its signal aborts —
  // simulating the real-world scenario where turn/start never returns because
  // captureTurn forced completion via process exit / idle / turn timeout.
  let signalSeen = null;
  const startRequest = (signal) => {
    signalSeen = signal;
    // Use real client.request so the pending map is exercised.
    return client.request("turn/start", { input: [] }, { signal });
  };

  // Kick off captureTurn against a thread.
  const capturePromise = captureTurn(client, "thread-leak", startRequest, {
    idleTimeoutMs: 50,
    turnTimeoutMs: 0
  });

  // Wait one microtask so the Promise.race participants are wired up and the
  // pending map has the turn/start entry.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.pending.size, 1, "turn/start should be pending before idle timeout fires");

  // Let idleInterval fire and force completion.
  await capturePromise;

  // After captureTurn returns, the abandoned turn/start pending entry must be
  // gone — proving the abort signal cleaned it up.
  assert.equal(client.pending.size, 0);
  // Signal was actually wired through.
  assert.ok(signalSeen instanceof AbortSignal);
  assert.equal(signalSeen.aborted, true);
});
