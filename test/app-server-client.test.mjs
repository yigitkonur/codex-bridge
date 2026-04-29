import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { AppServerClientBase } from "../src/lib/app-server.mjs";

const appServerSource = fs.readFileSync(new URL("../src/lib/app-server.mjs", import.meta.url), "utf8");

class FakeClient extends AppServerClientBase {
  constructor() {
    super(process.cwd());
    this.sent = [];
  }

  sendMessage(message) {
    this.sent.push(message);
  }
}

test("server requests without a handler are rejected, not auto-answered", () => {
  const client = new FakeClient();

  client.handleServerRequest({
    id: 7,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      questions: [{ id: "choice", question: "Pick?", options: [] }]
    }
  });

  assert.deepEqual(client.sent, [
    {
      id: 7,
      error: {
        code: -32601,
        message: "Unsupported server request: item/tool/requestUserInput"
      }
    }
  ]);
});

test("server request handlers resolve on the same client connection", () => {
  const client = new FakeClient();
  client.setServerRequestHandler((message) => {
    message._client.resolveServerRequest(message.id, {
      answers: {
        choice: { answers: ["yes"] }
      }
    });
  });

  client.handleServerRequest({
    id: "srv-1",
    method: "item/tool/requestUserInput",
    params: { threadId: "thread-1", questions: [{ id: "choice" }] }
  });

  assert.deepEqual(client.sent, [
    {
      id: "srv-1",
      result: {
        answers: {
          choice: { answers: ["yes"] }
        }
      }
    }
  ]);
});

test("transport exit emits exit and rejects pending requests", async () => {
  const client = new FakeClient();
  const request = client.request("thread/read", { threadId: "thread-1" });
  let exitSeen = false;
  client.on("exit", () => {
    exitSeen = true;
  });

  const failure = new Error("transport closed");
  client.handleExit(failure);

  await assert.rejects(request, /transport closed/);
  assert.equal(exitSeen, true);
  assert.equal(client.closed, true);
});

test("connect closes initialized transport resources after initialize failure", () => {
  const connect = appServerSource.match(/static async connect[\s\S]*?\n  }\n}/)?.[0] ?? "";
  assert.match(connect, /try \{\s*await client\.initialize\(\);\s*\} catch \(error\) \{\s*await client\.close\(\)\.catch\(\(\) => \{\}\);\s*throw error;\s*\}/);
});
