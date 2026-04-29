import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const bridge = fs.readFileSync(new URL("../src/codex-bridge.mjs", import.meta.url), "utf8");
const broker = fs.readFileSync(new URL("../src/adapters/codex/broker.mjs", import.meta.url), "utf8");

test("broker forwards server requests and tracks downstream responses", () => {
  assert.match(broker, /setServerRequestHandler\(routeServerRequest\)/);
  assert.match(broker, /pendingServerRequests/);
  assert.match(broker, /resolveServerRequest/);
  assert.match(broker, /rejectServerRequest/);
});

test("broker handles upstream app-server exit", () => {
  assert.match(broker, /appClient\.on\?\.\("exit", handleUpstreamExit\)/);
  assert.match(broker, /clearAllOwnership\(\)/);
  assert.match(broker, /closeDownstreamSockets\(error\)/);
});

test("broker clears resolved server requests and avoids closed stream ownership", () => {
  assert.match(broker, /message\.method === "serverRequest\/resolved"/);
  assert.match(broker, /pendingServerRequests\.delete\(key\)/);
  assert.match(broker, /responseSent && sockets\.has\(socket\) && !socket\.destroyed/);
  assert.match(broker, /activeRequestToken/);
});

test("wait terminal matching is anchored to event headers", () => {
  assert.match(bridge, /const TERMINAL = \/\^\\\[\(DONE\|ERROR\|INCOMPLETE\)\\\]\//);
  assert.match(bridge, /case "\$line" in "\[DONE\]"\*\|"\[ERROR\]"\*\|"\[INCOMPLETE\]"\*/);
  assert.doesNotMatch(bridge, /\*"\[DONE\]"\*\|\*"\[ERROR\]"\*\|\*"\[INCOMPLETE\]"\*/);
});

test("task retry binds same-thread retry to the failed thread id", () => {
  assert.doesNotMatch(bridge, /const retryResult = await executeTaskRun\(bridgeRequest\);/);
  assert.match(bridge, /resumeThreadId: result\.threadId/);
});

test("respond and summary resolve cwd before loading config", () => {
  const respond = bridge.match(/async function handleRespond[\s\S]*?async function handleSummary/)?.[0] ?? "";
  const summary = bridge.match(/async function handleSummary[\s\S]*?async function main/)?.[0] ?? "";
  assert.match(respond, /const cwd = resolveCommandCwd\(options\);/);
  assert.match(summary, /const cwd = resolveCommandCwd\(options\);/);
});

test("send emits plan event instead of terminal done for plan results", () => {
  const send = bridge.match(/async function handleSend[\s\S]*?async function handleSteer/)?.[0] ?? "";
  assert.match(send, /if \(result\.planDetected && result\.planText\)/);
  assert.ok(send.indexOf("formatPlanEvent") < send.indexOf("formatDoneEvent"));
});

test("review sessions emit terminal events", () => {
  const review = bridge.match(/async function executeReviewRun[\s\S]*?async function executeTaskRun/)?.[0] ?? "";
  assert.match(review, /logReviewTerminalEvent/);
  assert.match(review, /formatDoneEvent/);
  assert.match(review, /formatErrorEvent/);
});
