// Semantic exit codes, structured CliError, and the single error-emit chokepoint.
// See skill/references/output-contracts.md for the taxonomy this file encodes.

import process from "node:process";

export const ExitCode = Object.freeze({
  SUCCESS: 0,
  CRASH: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  AUTH: 4,
  CONFLICT: 5,
  VALIDATION: 6,
  TRANSIENT: 7,
  PARTIAL: 8
});

const CLASS_TO_EXIT = Object.freeze({
  usage: ExitCode.USAGE,
  not_found: ExitCode.NOT_FOUND,
  auth: ExitCode.AUTH,
  conflict: ExitCode.CONFLICT,
  validation: ExitCode.VALIDATION,
  rate_limit: ExitCode.TRANSIENT,
  timeout: ExitCode.TRANSIENT,
  network: ExitCode.TRANSIENT,
  dependency_failed: ExitCode.TRANSIENT,
  partial_success: ExitCode.PARTIAL,
  internal: ExitCode.CRASH
});

// Codex `lastErrorInfo.codexErrorInfo` variants → {class, retryable, suggestion}.
// Source: src/lib/AGENTS.md "Error codes" + skill/references/error-recovery.md.
const CODEX_ERROR_INFO = Object.freeze({
  ContextWindowExceeded: {
    class: "validation",
    retryable: false,
    suggestion: "Start a new thread with a shorter prompt; do not retry the same turn."
  },
  UsageLimitExceeded: {
    class: "rate_limit",
    retryable: true,
    suggestion: "Wait for the rate-limit window to reset, then retry."
  },
  ServerOverloaded: {
    class: "network",
    retryable: true,
    suggestion: "Codex app-server is overloaded. Retry with backoff."
  },
  CyberPolicy: {
    class: "validation",
    retryable: false,
    suggestion: "Codex blocked the request under policy. Change the request rather than retrying."
  },
  HttpConnectionFailed: {
    class: "network",
    retryable: true,
    suggestion: "Retry once; if it persists, check network connectivity to OpenAI."
  },
  ResponseStreamConnectionFailed: {
    class: "network",
    retryable: true,
    suggestion: "Retry once; if it persists, check network connectivity to OpenAI."
  },
  ResponseStreamDisconnected: {
    class: "network",
    retryable: true,
    suggestion: "Retry once; if it persists, check network connectivity to OpenAI."
  },
  ResponseTooManyFailedAttempts: {
    // Not a retryable transient — upstream already exhausted its own retries.
    // Class as `internal` so exit code (1) matches `retryable:false`.
    class: "internal",
    retryable: false,
    suggestion: "Read the session log and try a different approach — retrying will fail the same way."
  },
  Unauthorized: {
    class: "auth",
    retryable: false,
    suggestion: "Run `codex login` (or `codex login --device-auth`), then retry."
  },
  SandboxError: {
    class: "conflict",
    retryable: false,
    suggestion: "Re-run with `--write` only if you intend workspace-write; review sandbox output."
  },
  ThreadRollbackFailed: {
    class: "conflict",
    retryable: false,
    suggestion: "The thread could not be rolled back. Start a new task from the current workspace state."
  },
  ActiveTurnNotSteerable: {
    class: "conflict",
    retryable: false,
    suggestion: "This active turn type cannot be steered. Wait for completion or start a new turn."
  },
  BadRequest: {
    class: "validation",
    retryable: false,
    suggestion: "Inspect the payload in the session log."
  },
  InternalServerError: {
    class: "dependency_failed",
    retryable: true,
    suggestion: "Retry after a brief backoff."
  },
  Other: {
    class: "internal",
    retryable: false,
    suggestion: "The Codex error has no taxonomy entry yet — read details.codexErrorPayload and details.rawCodexErrorInfo for the upstream payload."
  }
});

const CAMEL_CODEX_ERROR_INFO = new Map(
  Object.keys(CODEX_ERROR_INFO).map((key) => [
    key.slice(0, 1).toLowerCase() + key.slice(1),
    key
  ])
);

const SNAKE_CODEX_ERROR_INFO = new Map(
  Object.keys(CODEX_ERROR_INFO).map((key) => [
    key.replace(/[A-Z]/g, (letter, index) => `${index === 0 ? "" : "_"}${letter.toLowerCase()}`),
    key
  ])
);

function normalizeCodexErrorInfoCode(value) {
  return CODEX_ERROR_INFO[value] ? value : (CAMEL_CODEX_ERROR_INFO.get(value) ?? SNAKE_CODEX_ERROR_INFO.get(value) ?? value);
}

export function normalizeCodexErrorInfo(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return {
      code: normalizeCodexErrorInfoCode(value),
      raw: value,
      payload: null
    };
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const [rawKey] = Object.keys(value);
    if (!rawKey) {
      return null;
    }
    return {
      code: normalizeCodexErrorInfoCode(rawKey),
      raw: value,
      payload: value[rawKey]
    };
  }
  return {
    code: String(value),
    raw: value,
    payload: null
  };
}

export class CliError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = "CliError";
    this.class = meta.class ?? "internal";
    this.code = meta.code ?? "INTERNAL_ERROR";
    this.retryable = meta.retryable ?? false;
    if (meta.suggestion) this.suggestion = meta.suggestion;
    if (meta.details) this.details = meta.details;
    if (meta.retryAfter != null) this.retryAfter = meta.retryAfter;
  }
}

export function usageError(message, suggestion) {
  return new CliError(message, { class: "usage", code: "USAGE_ERROR", retryable: false, suggestion });
}

export function validationError(message, code = "VALIDATION_ERROR", suggestion) {
  return new CliError(message, { class: "validation", code, retryable: false, suggestion });
}

export function notFoundError(message, code = "NOT_FOUND", suggestion) {
  return new CliError(message, { class: "not_found", code, retryable: false, suggestion });
}

export function conflictError(message, code = "CONFLICT", suggestion) {
  return new CliError(message, { class: "conflict", code, retryable: false, suggestion });
}

export function authError(message, suggestion) {
  return new CliError(message, { class: "auth", code: "UNAUTHORIZED", retryable: false, suggestion });
}

export function transientError(message, code = "TRANSIENT", suggestion) {
  return new CliError(message, { class: "network", code, retryable: true, suggestion });
}

export function invalidThreadIdError(value, source = "thread-id") {
  const hint = typeof value === "string" ? JSON.stringify(value.slice(0, 40)) : String(value);
  return new CliError(
    `invalid ${source}: expected a UUID (8-4-4-4-12 hex), got ${hint}`,
    {
      class: "validation",
      code: "INVALID_THREAD_ID",
      retryable: false,
      suggestion: "Thread ids are UUID v7 like 019d9a86-1c8a-7f41-8032-6c76bbe730a1. Run `status` to list known threads."
    }
  );
}

export function classifyError(err) {
  if (err instanceof CliError) {
    return {
      class: err.class,
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      suggestion: err.suggestion,
      details: err.details,
      retryAfter: err.retryAfter,
      exitCode: CLASS_TO_EXIT[err.class] ?? ExitCode.CRASH
    };
  }

  // Codex turn errors carry `codexErrorInfo` / `codex_error_info` on the thrown error.
  const codexInfo = normalizeCodexErrorInfo(err?.codexErrorInfo ?? err?.codex_error_info ?? null);
  if (codexInfo && CODEX_ERROR_INFO[codexInfo.code]) {
    const entry = CODEX_ERROR_INFO[codexInfo.code];
    return {
      class: entry.class,
      code: codexInfo.code,
      message: err.message ?? String(err),
      retryable: entry.retryable,
      suggestion: entry.suggestion,
      details: {
        codexErrorInfo: codexInfo.code,
        rawCodexErrorInfo: codexInfo.raw,
        ...(codexInfo.payload != null ? { codexErrorPayload: codexInfo.payload } : {}),
        ...(err?.additionalDetails != null ? { additionalDetails: err.additionalDetails } : {}),
        ...(err?.additional_details != null ? { additionalDetails: err.additional_details } : {})
      },
      exitCode: CLASS_TO_EXIT[entry.class] ?? ExitCode.CRASH
    };
  }

  // Idle-timeout synthesized in runBridgeTask when the transport goes silent.
  const message = err?.message ?? String(err);
  if (/No events received for \d+s/.test(message)) {
    return {
      class: "timeout",
      code: "ClientTimeout",
      message,
      retryable: true,
      suggestion: "Check whether the turn is stuck; cancel and retry with a simpler prompt if needed.",
      exitCode: ExitCode.TRANSIENT
    };
  }
  if (err?.code === "TurnTimeout" || /Turn timed out after \d+ms\./.test(message)) {
    return {
      class: "timeout",
      code: "TurnTimeout",
      message,
      retryable: true,
      suggestion: "The turn exceeded its configured budget. Retry with a simpler prompt or increase the turn timeout.",
      details: {
        originalCode: err?.code ?? null
      },
      exitCode: ExitCode.TRANSIENT
    };
  }
  if (err?.code === "ETIMEDOUT") {
    return {
      class: "timeout",
      code: "ClientTimeout",
      message,
      retryable: true,
      suggestion: "Init/shutdown/socket-connect timed out. Verify Codex is responding and retry.",
      exitCode: ExitCode.TRANSIENT
    };
  }
  // Match both the synthesized capitalized message from codex.mjs and the
  // lowercase protocol error from app-server.mjs.
  if (/codex app-server exited unexpectedly/i.test(message)) {
    return {
      class: "dependency_failed",
      code: "ProcessDeath",
      message,
      retryable: true,
      suggestion: "Run `setup` to verify Codex is installed and authenticated; then retry.",
      exitCode: ExitCode.TRANSIENT
    };
  }
  // Transport-layer drops where upstream never tags a `codexErrorInfo` (e.g.
  // the WS to /v1/responses closes without a close frame, so no terminal
  // `turn/completed` arrives). Treat as transient — workspace is unchanged,
  // safe to retry. Covers the user-reported "stream disconnected before
  // completion: Upstream websocket closed before response.completed" case.
  if (/stream disconnected|websocket closed|no close frame|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message)) {
    return {
      class: "network",
      code: "UPSTREAM_STREAM_DISCONNECTED",
      message,
      retryable: true,
      suggestion: "Upstream connection dropped mid-turn. Retry the same prompt; prior reasoning is lost but the workspace is unchanged.",
      exitCode: ExitCode.TRANSIENT
    };
  }

  // Tier-2 string matchers for raw HTTP errors from upstream that arrive
  // without a `codexErrorInfo` variant. These must be ordered: the
  // response-chain-lost matcher runs before `invalid_request_error` so the
  // more specific 400 doesn't get shadowed by the generic one.
  if (/previous_response_not_found|previous_response_id/i.test(message)) {
    return {
      class: "dependency_failed",
      code: "PreviousResponseNotFound",
      message,
      retryable: true,
      suggestion: "Upstream response chain is lost. Start a new task from committed state; do not `send` on the dead thread.",
      details: { retry_strategy: "new-thread" },
      exitCode: ExitCode.TRANSIENT
    };
  }
  if (/\b401\b.*Unauthorized|Proxy authentication must be configured/i.test(message)) {
    return {
      class: "auth",
      code: "UpstreamUnauthorized",
      message,
      retryable: false,
      suggestion: "Upstream returned 401. For proxy setups, reauth the proxy; for Codex login, run `codex login`. Do not retry the same thread.",
      exitCode: ExitCode.AUTH
    };
  }
  if (/invalid_request_error/i.test(message)) {
    return {
      class: "validation",
      code: "UpstreamInvalidRequest",
      message,
      retryable: true,
      suggestion: "Upstream rejected the request as malformed. Bridge will retry with backoff; if that fails, inspect input and relaunch.",
      exitCode: ExitCode.VALIDATION
    };
  }

  return {
    class: "internal",
    code: "INTERNAL_ERROR",
    message,
    retryable: false,
    exitCode: ExitCode.CRASH
  };
}

// Parse the upstream request id out of an error message, if present. Codex
// passes it verbatim from the OpenAI response headers — format is a UUID.
export function extractUpstreamRequestId(message) {
  if (!message) return null;
  const match = /request id:\s*([0-9a-f-]{8,})/i.exec(String(message));
  return match ? match[1] : null;
}

// Match the success envelope schema contract (schema_version 1.0).
export function buildErrorEnvelope(classified, { command, partial, handoff } = {}) {
  const error = {
    class: classified.class,
    code: classified.code,
    message: classified.message,
    retryable: Boolean(classified.retryable)
  };
  if (classified.suggestion) error.suggestion = classified.suggestion;
  if (classified.details) error.details = classified.details;
  if (classified.retryAfter != null) error.retry_after = classified.retryAfter;

  const upstreamRequestId = extractUpstreamRequestId(classified.message);
  if (upstreamRequestId) error.upstream_request_id = upstreamRequestId;

  if (partial) error.partial = partial;
  if (handoff) error.handoff = handoff;

  const envelope = { ok: false, schema_version: "1.0", error };
  if (command) envelope.command = command;
  return envelope;
}

// Per-origin retry policy for upstream failures (P0-4). Keyed by the origin
// string returned by `classifyTurnErrorOrigin`. `same-thread` resends the
// prompt on the existing thread (reuses resp_id). `new-thread` launches a
// fresh task — the only viable recovery when the response chain is dead.
// `none` goes straight to handoff (auth errors are deterministic; retrying
// with the same credentials changes nothing).
export const UPSTREAM_RETRY_POLICY = Object.freeze({
  "upstream:transport":          { strategy: "same-thread", maxAttempts: 3, backoffMs: [2000, 5000, 12000] },
  "upstream:compact-proxy":      { strategy: "same-thread", maxAttempts: 2, backoffMs: [10000, 30000] },
  "upstream:invalid-request":    { strategy: "same-thread", maxAttempts: 3, backoffMs: [2000, 5000, 12000] },
  "upstream:response-chain-lost":{ strategy: "new-thread",  maxAttempts: 1, backoffMs: [0] },
  "upstream:auth":               { strategy: "none",        maxAttempts: 0, backoffMs: [] }
});

export function getUpstreamRetryPolicy(origin) {
  return UPSTREAM_RETRY_POLICY[origin] ?? null;
}

// Assemble the handoff envelope emitted when the retry budget is exhausted
// (or immediately for origins with `strategy: "none"`). This shape is the
// single artifact another agent reads to continue the work — keep it stable
// across versions; orchestration-flows.md#recovering-from-upstream-state-loss
// documents the consumer contract.
export function buildHandoffEnvelope({ classified, reason, session, artifacts, partial, prompt, retries, upstreamRequestId } = {}) {
  const handoff = {
    schema_version: "1.0",
    reason: reason ?? "upstream-retry-exhausted",
    origin: classified?.origin ?? null,
    errorCode: classified?.code ?? null,
    errorMessage: classified?.message ?? null
  };
  const reqId = upstreamRequestId ?? extractUpstreamRequestId(classified?.message);
  if (reqId) handoff.upstream_request_id = reqId;
  if (session) handoff.session = session;
  if (artifacts) handoff.artifacts = artifacts;
  if (partial) handoff.partial = partial;
  if (prompt) handoff.prompt = prompt;
  if (Array.isArray(retries) && retries.length > 0) handoff.retries = retries;
  return handoff;
}

// Single chokepoint for successful --json / rendered output. Wraps `result` in
// the uniform success envelope when json is true; writes the rendered string
// otherwise. If `rendered` is null and json is false, writes nothing (the
// handler has already emitted human text via process.stdout.write).
export function emitSuccess(command, result, rendered, { json = false, startedAt = null, stdout = process.stdout } = {}) {
  if (json) {
    const envelope = {
      ok: true,
      schema_version: "1.0",
      command: command ?? null,
      result,
      meta: startedAt != null ? { duration_ms: Date.now() - startedAt } : {}
    };
    stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else if (rendered != null) {
    stdout.write(typeof rendered === "string" ? rendered : String(rendered));
  }
}

export function emitError(err, { json = false, command = null, stderr = process.stderr, stdout = process.stdout } = {}) {
  const classified = classifyError(err);

  // Pick up partial/handoff fields attached to the thrown error by
  // runBridgeTask (v1.5.0 retry + handoff path). Both flow through to the
  // JSON envelope under `error.partial` and `error.handoff` so orchestrators
  // can consume the handoff without tailing `.events`.
  const partial = err?.partial ?? null;
  const handoff = err?.handoff ?? null;

  if (json) {
    const envelope = buildErrorEnvelope(classified, { command, partial, handoff });
    stdout.write(`${JSON.stringify(envelope)}\n`);
  } else {
    stderr.write(`${classified.message}\n`);
    if (classified.suggestion) {
      stderr.write(`  → ${classified.suggestion}\n`);
    }
  }

  process.exitCode = classified.exitCode;
  return classified;
}

// Quick argv scan: pre-dispatch detection of `--json` / `-j` so `main().catch`
// can choose the right error channel without re-parsing per-handler specs.
export function detectJsonFlag(argv) {
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg === "--json" || arg === "--json=true" || arg === "-j") return true;
    if (arg === "--json=false") return false;
  }
  return false;
}

// Same idea for --help / -h so main() can short-circuit before the handler runs.
export function detectHelpFlag(argv) {
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg === "--help" || arg === "-h" || arg === "--help=true") return true;
  }
  return false;
}

// Classify the *origin* of a turn-level failure so the events-file renderer and
// `.ndjson` log can emit something more specific than the legacy `origin: "turn"`.
// The returned string is the canonical `origin:` token that also keys the
// cause-aware actions dispatch in `session-log.mjs::formatErrorEvent`.
//
// Vocabulary (what actually emits, truthful — do not add without wiring):
//   - `idle`                         — the no-event idle watchdog fired (message
//                                       carries "No events received for Ns").
//   - `upstream:compact-proxy`       — the remote compact endpoint returned 502
//                                       with a "Proxy request budget exhausted"
//                                       message. Seen when a reading-heavy turn
//                                       hits OpenAI's context-compaction proxy.
//   - `upstream:transport`           — the upstream stream disconnected / socket
//                                       reset before `turn/completed`. The
//                                       workspace is unchanged; safe to retry
//                                       the same prompt.
//   - `upstream:response-chain-lost` — upstream 400 `previous_response_not_found`.
//                                       The resp_id is dead; same-thread resend
//                                       will repeat the 400 forever. Recovery
//                                       requires a fresh task on committed state.
//   - `upstream:auth`                — upstream 401 Unauthorized (direct Codex
//                                       auth or proxy layer). Deterministic; no
//                                       retry policy will help.
//   - `upstream:invalid-request`     — upstream 400 `invalid_request_error` not
//                                       covered by more specific matchers. Some
//                                       proxy-layer 400s are transient; retry
//                                       with backoff before surfacing.
//   - `turn`                         — every other turn-level failure (turn
//                                       budget exhausted, Codex-classified
//                                       variants like ContextWindowExceeded /
//                                       Unauthorized / …).
//
// Pre-1.4.1 every turn-level failure emitted `origin: "turn"`, collapsing
// idle / compact-proxy 502 / transport drops / real turn-budget exhaustion
// into one bucket — unreadable for an orchestrator trying to pick a recovery
// move. See `unexpected-bridge-observations/` + the session transcript at
// `.codex-bridge/sessions/019dac1b-0ab0-7f53-bc87-2f9f54431ac5.events` for
// the motivating evidence.
export function classifyTurnErrorOrigin(error) {
  const message = String(error?.message ?? error ?? "");

  // Idle watchdog — matches the synthesized string from `codex.mjs`'s
  // `onIdleTimeout` path; distinct from Codex's own `ClientTimeout`
  // codexErrorInfo (which we still treat as a turn-level classifier below).
  if (/No events received for \d+s/.test(message)) return "idle";

  // Upstream compact-proxy 502. Signature: the "compact" URL from the
  // `.../backend-api/codex/responses/compact` endpoint, or the explicit
  // "Proxy request budget exhausted" phrase. Either one alone is sufficient.
  if (/responses\/compact|Proxy request budget exhausted|Error running remote compact task/i.test(message)) {
    return "upstream:compact-proxy";
  }

  // Upstream transport drops — websocket/stream disconnects, socket resets,
  // and the text aliases our own classifier already recognizes. Keeps parity
  // with the `UPSTREAM_STREAM_DISCONNECTED` branch in `classifyError` above.
  if (/stream disconnected|websocket closed|no close frame|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message)) {
    return "upstream:transport";
  }

  // Upstream 400 with response-chain loss. Must run BEFORE the generic
  // invalid_request_error matcher so the more-specific origin wins.
  if (/previous_response_not_found|previous_response_id/i.test(message)) {
    return "upstream:response-chain-lost";
  }

  // Upstream 401 / proxy-auth. Deterministic; no retry policy will help.
  if (/\b401\b.*Unauthorized|Proxy authentication must be configured/i.test(message)) {
    return "upstream:auth";
  }

  // Upstream 400 invalid_request_error (anything not already caught by the
  // chain-lost matcher above). Some proxy-layer 400s are transient; we retry
  // with backoff before surfacing.
  if (/invalid_request_error/i.test(message)) {
    return "upstream:invalid-request";
  }

  return "turn";
}
