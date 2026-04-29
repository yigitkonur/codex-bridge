import assert from "node:assert/strict";
import test from "node:test";

import { classifyError, normalizeCodexErrorInfo, ExitCode } from "../src/lib/cli-errors.mjs";

test("normalizes camelCase codexErrorInfo strings", () => {
  assert.deepEqual(normalizeCodexErrorInfo("sandboxError"), {
    code: "SandboxError",
    raw: "sandboxError",
    payload: null
  });

  const classified = classifyError({
    message: "sandbox blocked write",
    codexErrorInfo: "sandboxError"
  });

  assert.equal(classified.code, "SandboxError");
  assert.equal(classified.class, "conflict");
  assert.equal(classified.retryable, false);
});

test("normalizes object-shaped codexErrorInfo variants", () => {
  const raw = {
    responseStreamDisconnected: {
      httpStatusCode: 502
    }
  };

  const normalized = normalizeCodexErrorInfo(raw);
  assert.equal(normalized.code, "ResponseStreamDisconnected");
  assert.deepEqual(normalized.payload, { httpStatusCode: 502 });

  const classified = classifyError({
    message: "stream disconnected",
    codexErrorInfo: raw,
    additionalDetails: { requestId: "req-1" }
  });

  assert.equal(classified.code, "ResponseStreamDisconnected");
  assert.equal(classified.class, "network");
  assert.deepEqual(classified.details.rawCodexErrorInfo, raw);
  assert.deepEqual(classified.details.additionalDetails, { requestId: "req-1" });
});

test("normalizes upstream snake_case codexErrorInfo variants", () => {
  assert.deepEqual(normalizeCodexErrorInfo("server_overloaded"), {
    code: "ServerOverloaded",
    raw: "server_overloaded",
    payload: null
  });

  const raw = {
    response_stream_disconnected: {
      http_status_code: 502
    }
  };
  const classified = classifyError({
    message: "stream disconnected",
    codexErrorInfo: raw
  });

  assert.equal(classified.code, "ResponseStreamDisconnected");
  assert.equal(classified.class, "network");
  assert.equal(classified.retryable, true);
  assert.deepEqual(classified.details.rawCodexErrorInfo, raw);
});

test("classifies local turn timeout as retryable timeout", () => {
  const classified = classifyError({
    message: "Turn timed out after 1000ms.",
    code: "TurnTimeout"
  });

  assert.equal(classified.code, "TurnTimeout");
  assert.equal(classified.class, "timeout");
  assert.equal(classified.retryable, true);
  assert.equal(classified.exitCode, 7);
  assert.deepEqual(classified.details, { originalCode: "TurnTimeout" });
});

test("Other codexErrorInfo suggestion points at details.codexErrorPayload and details.rawCodexErrorInfo", () => {
  const classified = classifyError({
    message: "weird upstream thing",
    codexErrorInfo: "Other"
  });

  assert.equal(classified.code, "Other");
  assert.equal(classified.class, "internal");
  assert.equal(classified.retryable, false);
  assert.match(classified.suggestion, /details\.codexErrorPayload/);
  assert.match(classified.suggestion, /details\.rawCodexErrorInfo/);
  // Confirm the field names referenced in the suggestion are populated.
  assert.equal(classified.details.rawCodexErrorInfo, "Other");
  assert.equal(classified.details.codexErrorInfo, "Other");
});

test("classifies ETIMEDOUT err.code as retryable ClientTimeout", () => {
  const classified = classifyError({
    code: "ETIMEDOUT",
    message: "Timed out shutting down codex app-server."
  });

  assert.equal(classified.class, "timeout");
  assert.equal(classified.code, "ClientTimeout");
  assert.equal(classified.retryable, true);
  assert.equal(classified.exitCode, ExitCode.TRANSIENT);
});

test("ETIMEDOUT in message without err.code still hits UPSTREAM_STREAM_DISCONNECTED", () => {
  const classified = classifyError({
    message: "stream disconnected: ETIMEDOUT"
  });

  assert.equal(classified.code, "UPSTREAM_STREAM_DISCONNECTED");
  assert.equal(classified.class, "network");
  assert.equal(classified.retryable, true);
});
