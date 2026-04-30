import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { AppServerClientBase, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "../src/adapters/codex/protocol.mjs";
import { createBrokerEndpoint } from "../src/lib/broker-endpoint.mjs";
import { loadBrokerSession, saveBrokerSession } from "../src/lib/broker-lifecycle.mjs";

const appServerSource = fs.readFileSync(new URL("../src/adapters/codex/protocol.mjs", import.meta.url), "utf8");

function restoreEnv(name, previousValue) {
  if (previousValue == null) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
}

class FakeClient extends AppServerClientBase {
  constructor() {
    super(process.cwd());
    this.sent = [];
  }

  sendMessage(message) {
    this.sent.push(message);
  }
}

class FakeConnectClient {
  constructor(transport, initializeError = null) {
    this.transport = transport;
    this.initializeError = initializeError;
    this.initializeCalls = 0;
    this.closeCalls = 0;
  }

  async initialize() {
    this.initializeCalls += 1;
    if (this.initializeError) {
      throw this.initializeError;
    }
  }

  async close() {
    this.closeCalls += 1;
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

test("connect closes initialized transport resources after initialize failure", async () => {
  const failure = new Error("initialize failed");
  const directClient = new FakeConnectClient("direct", failure);

  await assert.rejects(
    CodexAppServerClient.connect(process.cwd(), {
      disableBroker: true,
      _createDirectClient() {
        return directClient;
      }
    }),
    failure
  );

  assert.equal(directClient.initializeCalls, 1);
  assert.equal(directClient.closeCalls, 1);
});

test("connect clears stale saved broker endpoint and falls back to direct client", async () => {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;
  const previousBrokerEndpoint = process.env[BROKER_ENDPOINT_ENV];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-app-server-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));
  const staleSessionDir = fs.mkdtempSync(path.join(root, "stale-broker-"));
  const staleEndpoint = createBrokerEndpoint(staleSessionDir);
  const directClient = new FakeConnectClient("direct");
  let brokerClientCreated = false;

  process.env.CODEX_BRIDGE_PLUGIN_DATA = root;
  delete process.env.CLAUDE_PLUGIN_DATA;
  delete process.env[BROKER_ENDPOINT_ENV];

  try {
    saveBrokerSession(workspace, {
      endpoint: staleEndpoint,
      pidFile: path.join(staleSessionDir, "broker.pid"),
      logFile: path.join(staleSessionDir, "broker.log"),
      sessionDir: staleSessionDir,
      pid: 1
    });

    const client = await CodexAppServerClient.connect(workspace, {
      reuseExistingBroker: true,
      _createBrokerClient() {
        brokerClientCreated = true;
        return new FakeConnectClient("broker");
      },
      _createDirectClient() {
        return directClient;
      }
    });

    assert.equal(client, directClient);
    assert.equal(client.transport, "direct");
    assert.equal(directClient.initializeCalls, 1);
    assert.equal(brokerClientCreated, false);
    assert.equal(loadBrokerSession(workspace), null);
  } finally {
    restoreEnv("CODEX_BRIDGE_PLUGIN_DATA", previousBridgePluginData);
    restoreEnv("CLAUDE_PLUGIN_DATA", previousClaudePluginData);
    restoreEnv(BROKER_ENDPOINT_ENV, previousBrokerEndpoint);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("connect does not replace an explicit broker endpoint with direct fallback", async () => {
  const failure = new Error("explicit broker failed");
  const brokerClient = new FakeConnectClient("broker", failure);
  const explicitSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-explicit-broker-"));
  const explicitEndpoint = createBrokerEndpoint(explicitSessionDir);
  let directClientCreated = false;

  try {
    await assert.rejects(
      CodexAppServerClient.connect(process.cwd(), {
        brokerEndpoint: explicitEndpoint,
        _createBrokerClient(_cwd, clientOptions) {
          assert.equal(clientOptions.brokerEndpoint, explicitEndpoint);
          return brokerClient;
        },
        _createDirectClient() {
          directClientCreated = true;
          return new FakeConnectClient("direct");
        }
      }),
      failure
    );

    assert.equal(brokerClient.initializeCalls, 1);
    assert.equal(brokerClient.closeCalls, 1);
    assert.equal(directClientCreated, false);
  } finally {
    fs.rmSync(explicitSessionDir, { recursive: true, force: true });
  }
});
