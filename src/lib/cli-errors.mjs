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
  BadRequest: {
    class: "validation",
    retryable: false,
    suggestion: "Inspect the payload in the session log."
  },
  InternalServerError: {
    class: "dependency_failed",
    retryable: true,
    suggestion: "Retry after a brief backoff."
  }
  // ActiveTurnNotSteerable / Other fall through to default classification.
});

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
  const codexInfo = err?.codexErrorInfo ?? err?.codex_error_info ?? null;
  if (codexInfo && CODEX_ERROR_INFO[codexInfo]) {
    const entry = CODEX_ERROR_INFO[codexInfo];
    return {
      class: entry.class,
      code: codexInfo,
      message: err.message ?? String(err),
      retryable: entry.retryable,
      suggestion: entry.suggestion,
      details: { codexErrorInfo: codexInfo },
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
  if (/Codex app-server exited unexpectedly/.test(message)) {
    return {
      class: "dependency_failed",
      code: "ProcessDeath",
      message,
      retryable: true,
      suggestion: "Run `setup` to verify Codex is installed and authenticated; then retry.",
      exitCode: ExitCode.TRANSIENT
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

// Match the success envelope schema contract (schema_version 1.0).
export function buildErrorEnvelope(classified, { command } = {}) {
  const error = {
    class: classified.class,
    code: classified.code,
    message: classified.message,
    retryable: Boolean(classified.retryable)
  };
  if (classified.suggestion) error.suggestion = classified.suggestion;
  if (classified.details) error.details = classified.details;
  if (classified.retryAfter != null) error.retry_after = classified.retryAfter;

  const envelope = { ok: false, schema_version: "1.0", error };
  if (command) envelope.command = command;
  return envelope;
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

  if (json) {
    const envelope = buildErrorEnvelope(classified, { command });
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
