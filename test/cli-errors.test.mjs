import assert from "node:assert/strict";
import test from "node:test";

import { buildErrorEnvelope, classifyError, CliError, normalizeCodexErrorInfo, ExitCode, detectHelpFlag, detectJsonFlag } from "../src/lib/cli-errors.mjs";

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

test("classifies backend adapter failures as BACKEND_INCAPABLE validation errors", () => {
  const classified = classifyError({
    name: "AdapterError",
    code: "BACKEND_INCAPABLE",
    message: "Unknown backend 'gemini'. Known: codex",
    details: { backend: "gemini" }
  });

  assert.equal(classified.class, "validation");
  assert.equal(classified.code, "BACKEND_INCAPABLE");
  assert.equal(classified.retryable, false);
  assert.equal(classified.exitCode, ExitCode.VALIDATION);
  assert.deepEqual(classified.details, { backend: "gemini" });
});

test("error envelopes carry origin and next action for direct orchestration", () => {
  const classified = classifyError(new CliError("bad config", {
    class: "validation",
    code: "CONFIG_INVALID_VALUE",
    retryable: false,
    suggestion: "Run `config show --json`.",
    origin: "config",
    nextAction: {
      kind: "inspect-config",
      command: "config show --json",
      description: "Inspect config diagnostics."
    }
  }));

  const envelope = buildErrorEnvelope(classified, { command: "task" });
  assert.equal(envelope.error.origin, "config");
  assert.deepEqual(envelope.error.next_action, {
    kind: "inspect-config",
    command: "config show --json",
    description: "Inspect config diagnostics."
  });
});

test("error envelopes derive a next action from suggestions", () => {
  const envelope = buildErrorEnvelope(classifyError(new CliError("missing job", {
    class: "not_found",
    code: "JOB_NOT_FOUND",
    retryable: false,
    suggestion: "Run `status` to list known jobs."
  })));

  assert.deepEqual(envelope.error.next_action, {
    kind: "follow-suggestion",
    description: "Run `status` to list known jobs."
  });
});

test("ETIMEDOUT in message without err.code still hits UPSTREAM_STREAM_DISCONNECTED", () => {
  const classified = classifyError({
    message: "stream disconnected: ETIMEDOUT"
  });

  assert.equal(classified.code, "UPSTREAM_STREAM_DISCONNECTED");
  assert.equal(classified.class, "network");
  assert.equal(classified.retryable, true);
});

test("prompt command flag scans ignore prompt prose before trailing value options", () => {
  const argv = [
    "task",
    "write docs for --help output and --json envelopes",
    "--cwd",
    "/repo"
  ];

  assert.equal(detectHelpFlag(argv), false);
  assert.equal(detectJsonFlag(argv), false);
});

test("prompt command flag scans still detect real trailing options after prompt", () => {
  const argv = [
    "task",
    "write docs for --help output",
    "--cwd",
    "/repo",
    "--json"
  ];

  assert.equal(detectHelpFlag(argv), false);
  assert.equal(detectJsonFlag(argv), true);
});

test("prompt command flag scans handle quoted collapsed prompt with trailing option", () => {
  const argv = [
    "task",
    "\"write docs for --help output\" --cwd /repo --json"
  ];

  assert.equal(detectHelpFlag(argv), false);
  assert.equal(detectJsonFlag(argv), true);

  const helpArgv = [
    "task",
    "\"write docs for --json output\" --help --cwd /repo"
  ];

  assert.equal(detectHelpFlag(helpArgv), true);
  assert.equal(detectJsonFlag(helpArgv), false);
});

test("prompt command flag scans keep collapsed prompt prose out of trailing flag detection", () => {
  const argv = [
    "task",
    "write docs for --help output --json"
  ];

  assert.equal(detectHelpFlag(argv), false);
  assert.equal(detectJsonFlag(argv), true);

  assert.equal(detectJsonFlag(["task", "write docs for --json"]), false);
});
