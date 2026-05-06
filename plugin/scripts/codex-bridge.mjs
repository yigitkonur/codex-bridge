// src/codex-bridge.mjs
import { spawn as spawn3, spawnSync as spawnSync4 } from "node:child_process";
import fs17 from "node:fs";
import os8 from "node:os";
import path15 from "node:path";
import process10 from "node:process";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// package.json
var package_default = {
  name: "codex-bridge",
  version: "2.2.0",
  description: "Hook-driven Claude Code plugin that delegates implementation, review, and closed-loop iteration to OpenAI Codex with worktree isolation, structured briefs, Monitor auto-arm, and trust-budgeted merge.",
  type: "module",
  scripts: {
    "baseline:contracts": "node scripts/baseline-contracts.mjs",
    build: "node esbuild.config.mjs",
    dev: "node src/codex-bridge.mjs",
    "release:package": "node scripts/package-release.mjs",
    "smoke:runtime": "node scripts/runtime-smoke.mjs",
    test: "node --test test/*.test.mjs",
    "verify:static": "npm run build && npm test && npm run baseline:contracts -- --check"
  },
  author: "Yigit Konur",
  license: "MIT",
  engines: {
    node: ">=22.0.0"
  },
  devDependencies: {
    esbuild: "^0.24.0",
    "js-yaml": "^4.1.0"
  }
};

// src/lib/cli-errors.mjs
import process2 from "node:process";
var ExitCode = Object.freeze({
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
var CLASS_TO_EXIT = Object.freeze({
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
var CODEX_ERROR_INFO = Object.freeze({
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
    suggestion: "Read the session log and try a different approach \u2014 retrying will fail the same way."
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
    suggestion: "The Codex error has no taxonomy entry yet \u2014 read details.codexErrorPayload and details.rawCodexErrorInfo for the upstream payload."
  }
});
var CAMEL_CODEX_ERROR_INFO = new Map(
  Object.keys(CODEX_ERROR_INFO).map((key) => [
    key.slice(0, 1).toLowerCase() + key.slice(1),
    key
  ])
);
var SNAKE_CODEX_ERROR_INFO = new Map(
  Object.keys(CODEX_ERROR_INFO).map((key) => [
    key.replace(/[A-Z]/g, (letter, index) => `${index === 0 ? "" : "_"}${letter.toLowerCase()}`),
    key
  ])
);
function normalizeCodexErrorInfoCode(value) {
  return CODEX_ERROR_INFO[value] ? value : CAMEL_CODEX_ERROR_INFO.get(value) ?? SNAKE_CODEX_ERROR_INFO.get(value) ?? value;
}
function normalizeCodexErrorInfo(value) {
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
var CliError = class extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = "CliError";
    this.class = meta.class ?? "internal";
    this.code = meta.code ?? "INTERNAL_ERROR";
    this.retryable = meta.retryable ?? false;
    if (meta.suggestion) this.suggestion = meta.suggestion;
    if (meta.details) this.details = meta.details;
    if (meta.retryAfter != null) this.retryAfter = meta.retryAfter;
    if (meta.origin) this.origin = meta.origin;
    if (meta.nextAction) this.nextAction = meta.nextAction;
  }
};
function usageError(message, suggestion) {
  return new CliError(message, { class: "usage", code: "USAGE_ERROR", retryable: false, suggestion });
}
function validationError(message, code = "VALIDATION_ERROR", suggestion) {
  return new CliError(message, { class: "validation", code, retryable: false, suggestion });
}
function notFoundError(message, code = "NOT_FOUND", suggestion) {
  return new CliError(message, { class: "not_found", code, retryable: false, suggestion });
}
function conflictError(message, code = "CONFLICT", suggestion) {
  return new CliError(message, { class: "conflict", code, retryable: false, suggestion });
}
function invalidThreadIdError(value, source = "thread-id") {
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
function classifyError(err) {
  if (err instanceof CliError) {
    return {
      class: err.class,
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      suggestion: err.suggestion,
      details: err.details,
      retryAfter: err.retryAfter,
      origin: err.origin,
      nextAction: err.nextAction,
      exitCode: CLASS_TO_EXIT[err.class] ?? ExitCode.CRASH
    };
  }
  if (err?.code === "BACKEND_INCAPABLE" || err?.name === "AdapterError") {
    return {
      class: "validation",
      code: "BACKEND_INCAPABLE",
      message: err.message ?? String(err),
      retryable: false,
      suggestion: "Select a supported backend, or unset CODEX_BRIDGE_BACKEND.",
      details: err?.details,
      exitCode: ExitCode.VALIDATION
    };
  }
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
        ...codexInfo.payload != null ? { codexErrorPayload: codexInfo.payload } : {},
        ...err?.additionalDetails != null ? { additionalDetails: err.additionalDetails } : {},
        ...err?.additional_details != null ? { additionalDetails: err.additional_details } : {}
      },
      exitCode: CLASS_TO_EXIT[entry.class] ?? ExitCode.CRASH
    };
  }
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
  if (err?.code === "BROKER_LOCK_TIMEOUT") {
    return {
      class: "timeout",
      code: "BROKER_LOCK_TIMEOUT",
      message,
      retryable: true,
      suggestion: "Another bridge process is starting the shared broker. Retry after a brief delay, or inspect active bridge jobs with `status --all`.",
      exitCode: ExitCode.TRANSIENT
    };
  }
  if (err?.code === "BROKER_START_FAILED") {
    return {
      class: "dependency_failed",
      code: "BROKER_START_FAILED",
      message,
      retryable: true,
      suggestion: "Run `setup --json` to verify Codex app-server readiness, then retry.",
      exitCode: ExitCode.TRANSIENT
    };
  }
  if (err?.code === "JOB_DETAIL_CORRUPT") {
    return {
      class: "conflict",
      code: "JOB_DETAIL_CORRUPT",
      message,
      retryable: false,
      suggestion: "Run `status --all` to inspect the surviving state index; relaunch if the detailed result is required.",
      details: {
        jobFile: err.jobFile ?? null,
        corruptPath: err.corruptPath ?? null
      },
      exitCode: ExitCode.CONFLICT
    };
  }
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
function extractUpstreamRequestId(message) {
  if (!message) return null;
  const match = /request id:\s*([0-9a-f-]{8,})/i.exec(String(message));
  return match ? match[1] : null;
}
function defaultNextAction(classified) {
  if (!classified?.suggestion) return null;
  return {
    kind: "follow-suggestion",
    description: classified.suggestion
  };
}
function buildErrorEnvelope(classified, { command, partial, handoff, origin = null, nextAction = null } = {}) {
  const error = {
    class: classified.class,
    code: classified.code,
    message: classified.message,
    retryable: Boolean(classified.retryable)
  };
  if (classified.suggestion) error.suggestion = classified.suggestion;
  if (classified.details) error.details = classified.details;
  if (classified.retryAfter != null) error.retry_after = classified.retryAfter;
  const effectiveOrigin = origin ?? classified.origin ?? null;
  if (effectiveOrigin) error.origin = effectiveOrigin;
  const effectiveNextAction = nextAction ?? classified.nextAction ?? defaultNextAction(classified);
  if (effectiveNextAction) error.next_action = effectiveNextAction;
  const upstreamRequestId = extractUpstreamRequestId(classified.message);
  if (upstreamRequestId) error.upstream_request_id = upstreamRequestId;
  if (partial) error.partial = partial;
  if (handoff) error.handoff = handoff;
  const envelope = { ok: false, schema_version: "1.0", error };
  if (command) envelope.command = command;
  return envelope;
}
var UPSTREAM_RETRY_POLICY = Object.freeze({
  "upstream:transport": { strategy: "same-thread", maxAttempts: 3, backoffMs: [2e3, 5e3, 12e3] },
  "upstream:compact-proxy": { strategy: "same-thread", maxAttempts: 2, backoffMs: [1e4, 3e4] },
  "upstream:invalid-request": { strategy: "same-thread", maxAttempts: 3, backoffMs: [2e3, 5e3, 12e3] },
  "upstream:response-chain-lost": { strategy: "new-thread", maxAttempts: 1, backoffMs: [0] },
  "upstream:auth": { strategy: "none", maxAttempts: 0, backoffMs: [] }
});
function getUpstreamRetryPolicy(origin) {
  return UPSTREAM_RETRY_POLICY[origin] ?? null;
}
function buildHandoffEnvelope({ classified, reason, session, artifacts, partial, prompt, retries, upstreamRequestId } = {}) {
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
function emitSuccess(command, result, rendered, { json: json2 = false, startedAt = null, stdout = process2.stdout } = {}) {
  if (json2) {
    const envelope = {
      ok: true,
      schema_version: "1.0",
      command: command ?? null,
      result,
      meta: startedAt != null ? { duration_ms: Date.now() - startedAt } : {}
    };
    stdout.write(`${JSON.stringify(envelope, null, 2)}
`);
  } else if (rendered != null) {
    stdout.write(typeof rendered === "string" ? rendered : String(rendered));
  }
}
function emitError(err, { json: json2 = false, command = null, stderr = process2.stderr, stdout = process2.stdout } = {}) {
  const classified = classifyError(err);
  const partial = err?.partial ?? null;
  const handoff = err?.handoff ?? null;
  const origin = err?.origin ?? classified.origin ?? null;
  const nextAction = err?.nextAction ?? classified.nextAction ?? null;
  if (json2) {
    const envelope = buildErrorEnvelope(classified, { command, partial, handoff, origin, nextAction });
    stdout.write(`${JSON.stringify(envelope)}
`);
  } else {
    stderr.write(`${classified.message}
`);
    if (classified.suggestion) {
      stderr.write(`  \u2192 ${classified.suggestion}
`);
    }
  }
  process2.exitCode = classified.exitCode;
  return classified;
}
function* tokenizeOutsideQuotes(arg) {
  let buffer = "";
  let quote = null;
  for (let i = 0; i < arg.length; i++) {
    const ch = arg[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buffer) {
        yield buffer;
        buffer = "";
      }
      continue;
    }
    buffer += ch;
  }
  if (buffer) yield buffer;
}
function looksLikeFlagBearingArg(arg) {
  if (typeof arg !== "string") return false;
  const trimmed = arg.trimStart();
  return trimmed.startsWith("-");
}
var PROMPT_ACCEPTING_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "task",
  "send",
  "steer",
  "adversarial-review",
  "iterate"
]);
var NON_PROMPT_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "respond",
  "review",
  "summary",
  "status",
  "result",
  "wait",
  "events",
  "cancel",
  "await-artifact",
  "setup",
  "version",
  "update",
  "config",
  "auth-status",
  "task-resume-candidate",
  "merge",
  "verdict",
  "verdicts",
  "help"
]);
function outsideQuoteTokens(arg) {
  return Array.from(tokenizeOutsideQuotes(arg));
}
function collapsedTrailingFlagToken(arg) {
  if (typeof arg !== "string" || !/\s/.test(arg) || /["']/.test(arg)) return [];
  const tokens = outsideQuoteTokens(arg);
  if (tokens.length < 2 || tokens.includes("--")) return [];
  const last = tokens[tokens.length - 1];
  if (!last.startsWith("-")) return [];
  const earlierFlag = tokens.slice(0, -1).some((token) => token.startsWith("-"));
  return earlierFlag ? [last] : [];
}
function promptCommandFlagBearingSlice(rest) {
  const scanned = [];
  for (const arg of rest) {
    if (looksLikeFlagBearingArg(arg)) {
      scanned.push(arg);
      continue;
    }
    if (!/["']/.test(arg)) {
      const suffix = collapsedTrailingFlagToken(arg);
      if (suffix.length > 0) {
        scanned.push(suffix.join(" "));
      }
      continue;
    }
    const tokens = outsideQuoteTokens(arg);
    if (tokens.length > 0) {
      scanned.push(tokens.join(" "));
    }
  }
  return scanned;
}
function flagBearingSlice(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return [];
  const head = argv[0];
  if (PROMPT_ACCEPTING_SUBCOMMANDS.has(head)) {
    return promptCommandFlagBearingSlice(argv.slice(1));
  }
  if (NON_PROMPT_SUBCOMMANDS.has(head)) return argv.slice(1);
  return argv;
}
function elementCarriesAnyToken(arg, targets, { stopOnDoubleDash = true } = {}) {
  if (typeof arg !== "string") return false;
  if (stopOnDoubleDash && arg === "--") return false;
  if (targets.has(arg)) return true;
  if (!/\s|["']/.test(arg)) return false;
  for (const token of tokenizeOutsideQuotes(arg)) {
    if (stopOnDoubleDash && token === "--") return false;
    if (targets.has(token)) return true;
  }
  return false;
}
var JSON_TRUE_TOKENS = /* @__PURE__ */ new Set(["--json", "--json=true", "-j"]);
var JSON_FALSE_TOKENS = /* @__PURE__ */ new Set(["--json=false"]);
var HELP_TOKENS = /* @__PURE__ */ new Set(["--help", "-h", "--help=true"]);
function detectJsonFlag(argv) {
  let result = false;
  for (const arg of flagBearingSlice(argv)) {
    if (arg === "--") break;
    if (JSON_TRUE_TOKENS.has(arg)) return true;
    if (JSON_FALSE_TOKENS.has(arg)) return false;
    if (/\s|["']/.test(arg)) {
      for (const token of tokenizeOutsideQuotes(arg)) {
        if (token === "--") return result;
        if (JSON_TRUE_TOKENS.has(token)) return true;
        if (JSON_FALSE_TOKENS.has(token)) result = false;
      }
    }
  }
  return result;
}
function detectHelpFlag(argv) {
  for (const arg of flagBearingSlice(argv)) {
    if (arg === "--") break;
    if (elementCarriesAnyToken(arg, HELP_TOKENS)) return true;
  }
  return false;
}
function classifyTurnErrorOrigin(error) {
  const message = String(error?.message ?? error ?? "");
  if (/No events received for \d+s/.test(message)) return "idle";
  if (/responses\/compact|Proxy request budget exhausted|Error running remote compact task/i.test(message)) {
    return "upstream:compact-proxy";
  }
  if (/stream disconnected|websocket closed|no close frame|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message)) {
    return "upstream:transport";
  }
  if (/previous_response_not_found|previous_response_id/i.test(message)) {
    return "upstream:response-chain-lost";
  }
  if (/\b401\b.*Unauthorized|Proxy authentication must be configured/i.test(message)) {
    return "upstream:auth";
  }
  if (/invalid_request_error/i.test(message)) {
    return "upstream:invalid-request";
  }
  return "turn";
}

// src/lib/args.mjs
var ALWAYS_BOOLEAN = /* @__PURE__ */ new Set(["help", "h"]);
var ALWAYS_ALIASES = Object.freeze({ h: "help", j: "json" });
function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const repeatableValueOptions = new Set(config.repeatableValueOptions ?? []);
  for (const k of repeatableValueOptions) valueOptions.add(k);
  const booleanOptions = /* @__PURE__ */ new Set([...config.booleanOptions ?? [], ...ALWAYS_BOOLEAN]);
  const aliasMap = { ...ALWAYS_ALIASES, ...config.aliasMap ?? {} };
  const strict = config.strict !== false;
  const options = {};
  const positionals = [];
  let passthrough = false;
  const setValue = (key, value) => {
    if (repeatableValueOptions.has(key)) {
      const existing = options[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else if (existing === void 0) {
        options[key] = [value];
      } else {
        options[key] = [existing, value];
      }
      return;
    }
    options[key] = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (passthrough) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      passthrough = true;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    if (token.startsWith("--")) {
      const rawOption = token.slice(2);
      const equalsIndex = rawOption.indexOf("=");
      const rawKey = equalsIndex === -1 ? rawOption : rawOption.slice(0, equalsIndex);
      const inlineValue = equalsIndex === -1 ? void 0 : rawOption.slice(equalsIndex + 1);
      const key2 = aliasMap[rawKey] ?? rawKey;
      if (booleanOptions.has(key2)) {
        options[key2] = inlineValue === void 0 ? true : inlineValue !== "false";
        continue;
      }
      if (valueOptions.has(key2)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === void 0) {
          throw usageError(`Missing value for --${rawKey}`);
        }
        setValue(key2, nextValue);
        if (inlineValue === void 0) {
          index += 1;
        }
        continue;
      }
      if (strict) {
        throw usageError(
          `Unknown flag: --${rawKey}`,
          `Run with --help to see available flags.`
        );
      }
      positionals.push(token);
      continue;
    }
    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;
    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }
    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === void 0) {
        throw usageError(`Missing value for -${shortKey}`);
      }
      setValue(key, nextValue);
      index += 1;
      continue;
    }
    if (strict) {
      throw usageError(
        `Unknown flag: -${shortKey}`,
        `Run with --help to see available flags.`
      );
    }
    positionals.push(token);
  }
  return { options, positionals };
}
function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const character = raw[i];
    if (quote === "'") {
      if (character === "'") {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null;
        continue;
      }
      if (character === "\\" && i + 1 < raw.length) {
        const next = raw[i + 1];
        if (next === "\\" || next === '"') {
          current += next;
          i += 1;
        } else {
          current += "\\";
        }
        continue;
      }
      current += character;
      continue;
    }
    if (character === "\\") {
      if (i + 1 < raw.length) {
        current += raw[i + 1];
        i += 1;
      } else {
        current += "\\";
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

// src/adapters/index.mjs
import process9 from "node:process";

// src/adapters/codex/index.mjs
import fs11 from "node:fs";
import path9 from "node:path";
import process8 from "node:process";

// src/lib/fs.mjs
import fs from "node:fs";
function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}
function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return fs.readFileSync(0, "utf8");
}

// src/adapters/codex/protocol.mjs
import net2 from "node:net";
import process6 from "node:process";
import { spawn as spawn2 } from "node:child_process";
import readline from "node:readline";

// src/lib/broker-endpoint.mjs
import path from "node:path";
import process3 from "node:process";
function sanitizePipeName(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
}
function createBrokerEndpoint(sessionDir, platform = process3.platform) {
  if (platform === "win32") {
    const pipeName = sanitizePipeName(`${path.win32.basename(sessionDir)}-codex-app-server`);
    return `pipe:\\\\.\\pipe\\${pipeName}`;
  }
  return `unix:${path.join(sessionDir, "broker.sock")}`;
}
function parseBrokerEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new Error("Missing broker endpoint.");
  }
  if (endpoint.startsWith("pipe:")) {
    const pipePath = endpoint.slice("pipe:".length);
    if (!pipePath) {
      throw new Error("Broker pipe endpoint is missing its path.");
    }
    return { kind: "pipe", path: pipePath };
  }
  if (endpoint.startsWith("unix:")) {
    const socketPath = endpoint.slice("unix:".length);
    if (!socketPath) {
      throw new Error("Broker Unix socket endpoint is missing its path.");
    }
    return { kind: "unix", path: socketPath };
  }
  throw new Error(`Unsupported broker endpoint: ${endpoint}`);
}

// src/lib/broker-lifecycle.mjs
import fs5 from "node:fs";
import net from "node:net";
import os2 from "node:os";
import path5 from "node:path";
import process5 from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// src/lib/process.mjs
import { spawnSync } from "node:child_process";
import process4 from "node:process";
var DEFAULT_RUN_COMMAND_TIMEOUT_MS = 1e4;
function resolveRunCommandTimeout(timeout) {
  if (timeout == null) {
    return DEFAULT_RUN_COMMAND_TIMEOUT_MS;
  }
  const parsed = Number(timeout);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RUN_COMMAND_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(parsed));
}
function runCommand(command, args = [], options = {}) {
  const spawnSyncImpl = options.spawnSync ?? spawnSync;
  const result = spawnSyncImpl(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: process4.platform === "win32" ? process4.env.SHELL || true : false,
    timeout: resolveRunCommandTimeout(options.timeout),
    windowsHide: true
  });
  const normalizedStatus = result.status != null ? result.status : result.signal ? 128 : 1;
  return {
    command,
    args,
    status: normalizedStatus,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}
function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}
function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */
  result.error.code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}
function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}
function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }
  const platform = options.platform ?? process4.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process4.kill.bind(process4);
  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });
    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }
    const combinedOutput = `${result.stderr}
${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }
    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }
    if (result.error) {
      throw result.error;
    }
    throw new Error(formatCommandFailure(result));
  }
  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }
    return { attempted: true, delivered: false, method: "process-group" };
  }
}
function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}

// src/lib/state.mjs
import { createHash } from "node:crypto";
import fs4 from "node:fs";
import os from "node:os";
import path4 from "node:path";

// src/lib/official-plugin.mjs
import { spawnSync as spawnSync2 } from "node:child_process";
var OFFICIAL_PLUGIN_STATUS = Object.freeze({
  ACTIVE: "active",
  ABSENT: "absent",
  UNKNOWN: "unknown"
});
var CLAUDE_PLUGIN_LIST_TIMEOUT_MS = 3e3;
function stringValue(value) {
  return typeof value === "string" ? value : "";
}
function normalizePathLike(value) {
  return stringValue(value).replace(/\\/g, "/").toLowerCase();
}
function pluginEntryEnabled(entry) {
  if (!entry || typeof entry !== "object") return false;
  if ("enabled" in entry) return Boolean(entry.enabled);
  if ("disabled" in entry) return !entry.disabled;
  return true;
}
function summarizePluginEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    id: entry.id ?? null,
    name: entry.name ?? null,
    version: entry.version ?? null,
    scope: entry.scope ?? null,
    installPath: entry.installPath ?? entry.path ?? null,
    enabled: pluginEntryEnabled(entry)
  };
}
function isOfficialOpenAICodexPluginEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const id = stringValue(entry.id).toLowerCase();
  const name = stringValue(entry.name).toLowerCase();
  const source = stringValue(entry.source).toLowerCase();
  const installPath = normalizePathLike(entry.installPath ?? entry.path);
  const authorName = stringValue(entry.author?.name ?? entry.author).toLowerCase();
  if (id === "codex@openai-codex") return true;
  if (id === "codex" && authorName === "openai") return true;
  if (name === "codex" && authorName === "openai") return true;
  if (source.includes("openai/codex-plugin-cc")) return true;
  if (source.includes("openai-codex") && (id.includes("codex") || name === "codex")) return true;
  if (installPath.includes("/openai-codex/codex/")) return true;
  if (installPath.endsWith("/openai-codex/codex")) return true;
  if (installPath.includes("/codex-plugin-cc/plugins/codex")) return true;
  return false;
}
function detectOfficialOpenAICodexPluginFromEntries(entries) {
  if (!Array.isArray(entries)) {
    return {
      status: OFFICIAL_PLUGIN_STATUS.UNKNOWN,
      detail: "Claude plugin list output was not an array.",
      plugin: null
    };
  }
  const plugin = entries.find((entry) => pluginEntryEnabled(entry) && isOfficialOpenAICodexPluginEntry(entry));
  if (plugin) {
    return {
      status: OFFICIAL_PLUGIN_STATUS.ACTIVE,
      detail: "Official OpenAI Codex plugin is enabled.",
      plugin: summarizePluginEntry(plugin)
    };
  }
  return {
    status: OFFICIAL_PLUGIN_STATUS.ABSENT,
    detail: "Official OpenAI Codex plugin was not found in the enabled Claude plugin list.",
    plugin: null
  };
}
function extractPluginEntries(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.plugins)) return parsed.plugins;
  if (Array.isArray(parsed?.result?.plugins)) return parsed.result.plugins;
  return null;
}
function detectOfficialOpenAICodexPluginUncached(options = {}) {
  const spawn4 = options.spawnSync ?? spawnSync2;
  const result = spawn4("claude", ["plugin", "list", "--json"], {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? CLAUDE_PLUGIN_LIST_TIMEOUT_MS
  });
  if (result.error) {
    return {
      status: OFFICIAL_PLUGIN_STATUS.UNKNOWN,
      detail: `Could not run \`claude plugin list --json\`: ${result.error.message}`,
      plugin: null
    };
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      status: OFFICIAL_PLUGIN_STATUS.UNKNOWN,
      detail: detail ? `\`claude plugin list --json\` exited with status ${result.status}: ${detail}` : `\`claude plugin list --json\` exited with status ${result.status}.`,
      plugin: null
    };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return detectOfficialOpenAICodexPluginFromEntries(extractPluginEntries(parsed));
  } catch (error) {
    return {
      status: OFFICIAL_PLUGIN_STATUS.UNKNOWN,
      detail: `Could not parse \`claude plugin list --json\`: ${error instanceof Error ? error.message : String(error)}`,
      plugin: null
    };
  }
}
var DEFAULT_DETECT_CACHE_MS = 3e4;
var cached = null;
var cachedAt = 0;
function detectOfficialOpenAICodexPlugin(options = {}) {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_DETECT_CACHE_MS;
  if (maxAgeMs > 0 && cached !== null && Date.now() - cachedAt < maxAgeMs) {
    return cached;
  }
  const result = detectOfficialOpenAICodexPluginUncached(options);
  cached = result;
  cachedAt = Date.now();
  return result;
}

// src/lib/git.mjs
import fs3 from "node:fs";
import path3 from "node:path";
import { execFileSync as childExecFileSync } from "node:child_process";

// src/lib/prompts.mjs
import fs2 from "node:fs";
import path2 from "node:path";
function loadPromptTemplate(rootDir, name) {
  const promptPath = path2.join(rootDir, "prompts", `${name}.md`);
  return fs2.readFileSync(promptPath, "utf8");
}
function interpolateTemplate(template, variables, options = {}) {
  const requiredKeys = options?.requiredKeys ?? null;
  if (requiredKeys) {
    const iterable = requiredKeys instanceof Set ? requiredKeys : new Set(requiredKeys);
    for (const key of iterable) {
      if (!Object.prototype.hasOwnProperty.call(variables, key)) {
        throw new Error(`interpolateTemplate: missing required key '${key}'`);
      }
    }
  }
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : "";
  });
}
var PROMPT_VALUE_MAX_LEN = 200;
function sanitizePromptValue(value, options = {}) {
  if (typeof value !== "string") {
    return "";
  }
  const requestedMaxLength = options?.maxLength;
  const maxLength = Number.isInteger(requestedMaxLength) && requestedMaxLength >= 0 ? requestedMaxLength : PROMPT_VALUE_MAX_LEN;
  const stripped = value.replace(/[\n\r<>]/g, " ");
  const collapsed = stripped.replace(/\s+/g, " ");
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return collapsed.slice(0, maxLength);
}

// src/lib/git.mjs
var MAX_UNTRACKED_BYTES = 24 * 1024;
var DEFAULT_INLINE_DIFF_MAX_FILES = 2;
var DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
var REGULAR_FILE_READ_FLAGS = fs3.constants.O_RDONLY | (fs3.constants.O_NOFOLLOW ?? 0) | (fs3.constants.O_NONBLOCK ?? 0);
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}
function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}
function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}
function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}
function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}
function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */
  result.error.code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}
function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}
function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}
function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new CliError("git is not installed. Install Git and retry.", {
      class: "dependency_failed",
      code: "GIT_NOT_INSTALLED",
      retryable: false,
      suggestion: "Install Git (e.g. `brew install git` or your distro's package) and retry."
    });
  }
  if (result.status !== 0) {
    throw new CliError("This command must run inside a Git repository.", {
      class: "validation",
      code: "NOT_A_GIT_REPO",
      retryable: false,
      suggestion: "Run from within a Git working tree, or pass --cwd to point at one."
    });
  }
  return result.stdout.trim();
}
function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}
function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      const candidate = remoteHead.replace("refs/remotes/origin/", "");
      const localCheck = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
      if (localCheck.status === 0) {
        return candidate;
      }
      return `origin/${candidate}`;
    }
  }
  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }
  throw new CliError("Unable to detect the repository default branch.", {
    class: "not_found",
    code: "DEFAULT_BRANCH_NOT_FOUND",
    retryable: false,
    suggestion: "Pass `--base <ref>` explicitly, or use `--scope working-tree`."
  });
}
function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}
function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);
  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}
function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);
  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = /* @__PURE__ */ new Set(["auto", "working-tree", "branch"]);
  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${sanitizePromptValue(baseRef)}`,
      baseRef,
      explicit: true
    };
  }
  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }
  if (!supportedScopes.has(requestedScope)) {
    throw new CliError(
      `Unsupported review scope "${requestedScope}".`,
      {
        class: "validation",
        code: "INVALID_SCOPE",
        retryable: false,
        suggestion: "Use one of: auto, working-tree, branch, or pass --base <ref>."
      }
    );
  }
  if (requestedScope === "branch") {
    const detectedBase2 = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${sanitizePromptValue(detectedBase2)}`,
      baseRef: detectedBase2,
      explicit: true
    };
  }
  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }
  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${sanitizePromptValue(detectedBase)}`,
    baseRef: detectedBase,
    explicit: false
  };
}
function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}
function realpathSync(filePath) {
  return fs3.realpathSync.native ? fs3.realpathSync.native(filePath) : fs3.realpathSync(filePath);
}
function isPathInside(parentPath, candidatePath) {
  const relative = path3.relative(parentPath, candidatePath);
  return relative === "" || !relative.startsWith("..") && !path3.isAbsolute(relative);
}
function readFileDescriptor(fd, size) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = fs3.readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}
function formatUntrackedFile(cwd, relativePath) {
  let repoRoot;
  try {
    repoRoot = realpathSync(cwd);
  } catch {
    return `### ${relativePath}
(skipped: repository root is unreadable)`;
  }
  const absolutePath = path3.resolve(repoRoot, relativePath);
  if (!isPathInside(repoRoot, absolutePath)) {
    return `### ${relativePath}
(skipped: path resolves outside repository)`;
  }
  let stat;
  try {
    stat = fs3.lstatSync(absolutePath);
  } catch {
    return `### ${relativePath}
(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isSymbolicLink()) {
    return `### ${relativePath}
(skipped: symlink)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}
(skipped: directory)`;
  }
  if (!stat.isFile()) {
    return `### ${relativePath}
(skipped: non-regular file)`;
  }
  let resolvedPath;
  try {
    resolvedPath = realpathSync(absolutePath);
  } catch {
    return `### ${relativePath}
(skipped: broken symlink or unreadable file)`;
  }
  if (!isPathInside(repoRoot, resolvedPath)) {
    return `### ${relativePath}
(skipped: path resolves outside repository)`;
  }
  let fd;
  let buffer;
  try {
    fd = fs3.openSync(resolvedPath, REGULAR_FILE_READ_FLAGS);
    const readStat = fs3.fstatSync(fd);
    if (!readStat.isFile()) {
      return `### ${relativePath}
(skipped: non-regular file)`;
    }
    if (readStat.size > MAX_UNTRACKED_BYTES) {
      return `### ${relativePath}
(skipped: ${readStat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
    }
    buffer = readFileDescriptor(fd, readStat.size);
  } catch {
    return `### ${relativePath}
(skipped: broken symlink or unreadable file)`;
  } finally {
    if (fd !== void 0) {
      try {
        fs3.closeSync(fd);
      } catch {
      }
    }
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}
(skipped: binary file)`;
  }
  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}
function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);
  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = state.untracked.join("\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody)
    ];
  }
  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}
function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();
  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff ? [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection(
        "Branch Diff",
        gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
      )
    ].join("\n") : [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection("Changed Files", changedFiles.join("\n"))
    ].join("\n"),
    changedFiles,
    comparison
  };
}
function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }
  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";
}
function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;
  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison });
  }
  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    ...details
  };
}
function runGit(cwd, args, opts = {}) {
  if (!Array.isArray(args)) {
    throw new TypeError("runGit: args must be an array of git arguments (no shell strings)");
  }
  const { swallowStderr, ...rest } = opts;
  return childExecFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", swallowStderr ? "pipe" : "inherit"],
    ...rest
  });
}
function tryRunGit(cwd, args, options = {}) {
  const result = git(cwd, args, options);
  if (result.error || result.status !== 0) {
    return { ok: false, result };
  }
  return { ok: true, stdout: result.stdout, result };
}
function defaultWorktreeRoot(repoRoot) {
  return path3.resolve(repoRoot, "..", ".codex-bridge-worktrees");
}
function assertSafeTaskId(taskId, caller) {
  if (!taskId || typeof taskId !== "string") {
    throw new Error(`${caller}: taskId is required`);
  }
  if (taskId === "." || taskId === ".." || !/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new Error(
      `${caller}: taskId must be a safe path segment: ${JSON.stringify(taskId)}`
    );
  }
}
function buildBranchName({ taskId, backend, branchPrefix }) {
  const prefix = branchPrefix ?? "subagent";
  const back = backend ?? "codex";
  return `${prefix}/${back}/${taskId}`;
}
function assertSafeBranchName(cwd, branch, caller) {
  const result = tryRunGit(cwd, ["check-ref-format", "--branch", branch]);
  if (!result.ok) {
    throw new Error(
      `${caller}: branch name is invalid: ${JSON.stringify(branch)}`
    );
  }
}
function branchExists(cwd, branch) {
  return tryRunGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}
function currentCheckoutRef(cwd) {
  const symbolic = tryRunGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (symbolic.ok) return symbolic.stdout.trim();
  return runGit(cwd, ["rev-parse", "HEAD"]).trim();
}
function createSubagentWorktree({
  cwd,
  taskId,
  backend = "codex",
  baseRef,
  branchPrefix = "subagent",
  worktreeRoot,
  allowBranchFallback = true
}) {
  assertSafeTaskId(taskId, "createSubagentWorktree");
  ensureGitRepository(cwd);
  const repoRoot = getRepoRoot(cwd);
  const headCheck = git(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (headCheck.status !== 0) {
    throw new CliError("Git repository has no commits; worktree isolation needs a base commit.", {
      class: "validation",
      code: "GIT_REPO_HAS_NO_COMMITS",
      retryable: false,
      suggestion: 'Create an initial commit first, for example: `git add -A && git commit -m "initial commit"` or `git commit --allow-empty -m "initial commit"`.'
    });
  }
  const currentBranch = getCurrentBranch(cwd);
  const resolvedBaseRef = baseRef ?? (currentBranch !== "HEAD" ? currentBranch : null) ?? detectDefaultBranch(cwd) ?? "HEAD";
  const baseSha = runGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${resolvedBaseRef}^{commit}`
  ], { swallowStderr: true }).trim();
  const branch = buildBranchName({ taskId, backend, branchPrefix });
  assertSafeBranchName(repoRoot, branch, "createSubagentWorktree");
  const root = worktreeRoot ?? defaultWorktreeRoot(repoRoot);
  const wtPath = path3.join(root, taskId);
  const createdAt = (/* @__PURE__ */ new Date()).toISOString();
  if (branchExists(repoRoot, branch)) {
    throw new Error(
      `createSubagentWorktree: branch ${branch} already exists; remove or rename before retrying`
    );
  }
  try {
    fs3.mkdirSync(root, { recursive: true });
    runGit(repoRoot, ["worktree", "add", "-b", branch, wtPath, baseSha], {
      swallowStderr: true
    });
    return {
      isolation_mode: "worktree",
      path: wtPath,
      branch,
      base_ref: resolvedBaseRef,
      base_sha: baseSha,
      created_at: createdAt
    };
  } catch (err) {
    tryRunGit(repoRoot, ["worktree", "remove", "--force", wtPath]);
    const partialBranchSha = tryRunGit(repoRoot, ["rev-parse", "--verify", branch]);
    if (partialBranchSha.ok && partialBranchSha.stdout.trim() === baseSha) {
      tryRunGit(repoRoot, ["branch", "-D", branch]);
    }
    if (!allowBranchFallback) {
      throw new Error(
        `createSubagentWorktree: worktree creation failed and branch fallback is disabled: ${err.message ?? err}`
      );
    }
    if (getWorkingTreeState(repoRoot).isDirty) {
      throw new Error(
        "createSubagentWorktree: worktree creation failed and branch-only fallback is unsafe with a dirty working tree"
      );
    }
    const previousRef = currentCheckoutRef(repoRoot);
    try {
      runGit(repoRoot, ["checkout", "-b", branch, baseSha], { swallowStderr: true });
    } catch (innerErr) {
      throw new Error(
        `createSubagentWorktree: worktree fallback also failed: ${innerErr.message ?? innerErr}`
      );
    }
    return {
      isolation_mode: "branch-only",
      path: cwd,
      branch,
      base_ref: resolvedBaseRef,
      base_sha: baseSha,
      created_at: createdAt,
      previous_ref: previousRef,
      fallback_reason: err.message ?? String(err)
    };
  }
}
function pruneWorktreeOnCancel({ cwd, taskId, branch, previousRef, worktreeRoot, path: explicitPath }) {
  assertSafeTaskId(taskId, "pruneWorktreeOnCancel");
  ensureGitRepository(cwd);
  const repoRoot = getRepoRoot(cwd);
  let wtPath = null;
  if (typeof explicitPath === "string" && explicitPath.length > 0) {
    wtPath = explicitPath;
  } else if (typeof worktreeRoot === "string" && worktreeRoot.length > 0) {
    wtPath = path3.join(worktreeRoot, taskId);
  } else if (branch) {
    const registered = listSubagentWorktrees(repoRoot).find((w) => w.branch === branch);
    if (registered) {
      wtPath = registered.path;
    }
  }
  if (!wtPath) {
    wtPath = path3.join(defaultWorktreeRoot(repoRoot), taskId);
  }
  const wtPathResolved = path3.resolve(wtPath);
  const repoRootResolved = path3.resolve(repoRoot);
  const isMainWorktree = wtPathResolved === repoRootResolved;
  if (!isMainWorktree && fs3.existsSync(wtPath)) {
    runGit(repoRoot, ["worktree", "remove", "--force", wtPath]);
    if (fs3.existsSync(wtPath)) {
      throw new Error(`pruneWorktreeOnCancel: worktree still exists after remove: ${wtPath}`);
    }
  }
  if (branch) {
    assertSafeBranchName(repoRoot, branch, "pruneWorktreeOnCancel");
    if (branchExists(repoRoot, branch)) {
      if (getCurrentBranch(repoRoot) === branch) {
        if (!previousRef) {
          throw new Error(
            `pruneWorktreeOnCancel: cannot delete checked-out branch without previousRef: ${branch}`
          );
        }
        runGit(repoRoot, ["checkout", previousRef]);
      }
      runGit(repoRoot, ["branch", "-D", branch]);
      if (branchExists(repoRoot, branch)) {
        throw new Error(`pruneWorktreeOnCancel: branch still exists after delete: ${branch}`);
      }
    }
  }
  return { pruned: !fs3.existsSync(wtPath), branchDeleted: branch ? !branchExists(repoRoot, branch) : false };
}
function mergeSubagentBranch({
  cwd,
  taskId,
  branch,
  baseRef = "main",
  expectedBranchSha,
  worktreePath,
  runTests = true
}) {
  if (!taskId) throw new Error("mergeSubagentBranch: taskId is required");
  if (!branch) throw new Error("mergeSubagentBranch: branch is required");
  if (!expectedBranchSha) {
    throw new Error("mergeSubagentBranch: expectedBranchSha is required");
  }
  ensureGitRepository(cwd);
  const repoRoot = getRepoRoot(cwd);
  if (typeof baseRef !== "string" || /[\s;|&`$()<>"'\\]/.test(baseRef)) {
    throw new Error(`mergeSubagentBranch: unsafe baseRef: ${JSON.stringify(baseRef)}`);
  }
  assertSafeBranchName(repoRoot, branch, "mergeSubagentBranch");
  try {
    runGit(repoRoot, ["fetch", "--no-tags", "origin", baseRef], {
      swallowStderr: true,
      timeout: 3e4
    });
  } catch {
  }
  const dirty = tryRunGit(repoRoot, ["status", "--porcelain"]);
  if (dirty.ok && dirty.stdout.trim().length > 0) {
    const err = new Error(
      `repo is dirty; commit or stash before merging. Status: ${dirty.stdout.trim()}`
    );
    err.kind = "precondition";
    throw err;
  }
  const expectedSha = String(expectedBranchSha).trim().toLowerCase();
  const taskWorktreePath = worktreePath ?? path3.join(defaultWorktreeRoot(repoRoot), taskId);
  if (taskWorktreePath && fs3.existsSync(taskWorktreePath) && path3.resolve(taskWorktreePath) !== repoRoot) {
    const taskDirty = tryRunGit(taskWorktreePath, ["status", "--porcelain", "--untracked-files=all"]);
    if (taskDirty.ok && taskDirty.stdout.trim().length > 0) {
      const err = new Error(
        `task worktree is dirty; refusing to prune unmerged changes. Status: ${taskDirty.stdout.trim()}`
      );
      err.kind = "precondition";
      throw err;
    }
  }
  const branchShaResult = tryRunGit(repoRoot, ["rev-parse", "--verify", branch]);
  const branchSha = branchShaResult.ok ? branchShaResult.stdout.trim().toLowerCase() : "";
  if (!branchSha) {
    const err = new Error(`branch ${branch} does not exist`);
    err.kind = "precondition";
    throw err;
  }
  if (branchSha !== expectedSha) {
    const err = new Error(
      `branch ${branch} is at ${branchSha}, but approved verdict reviewed ${expectedSha}; rerun review before merging`
    );
    err.kind = "sha_drift";
    throw err;
  }
  runGit(repoRoot, ["checkout", baseRef], { swallowStderr: true });
  const remoteTipResult = tryRunGit(repoRoot, ["rev-parse", "--verify", `refs/remotes/origin/${baseRef}`]);
  const remoteTip = remoteTipResult.ok ? remoteTipResult.stdout.trim() : null;
  if (remoteTip) {
    try {
      runGit(repoRoot, ["merge", "--ff-only", `refs/remotes/origin/${baseRef}`], { swallowStderr: true });
    } catch {
      const err = new Error(
        `local ${baseRef} has diverged from origin/${baseRef}; reconcile before merging`
      );
      err.kind = "precondition";
      throw err;
    }
  }
  try {
    runGit(repoRoot, ["merge", "--ff-only", branch], { swallowStderr: true });
  } catch (err) {
    const wrapped = new Error(
      `ff-merge failed (branch is not a linear descendant of ${baseRef}); rebase ${branch} onto ${baseRef} or run /codex-bridge:iterate first`
    );
    wrapped.kind = "conflict";
    throw wrapped;
  }
  const commitSha = runGit(repoRoot, ["rev-parse", "HEAD"], { swallowStderr: true }).toString().trim();
  pruneWorktreeOnCancel({ cwd: repoRoot, taskId, branch });
  return {
    strategy: "ff",
    commit_sha: commitSha,
    base_ref: baseRef,
    branch,
    tests_passed: runTests ? null : false
    // null = not yet measured; false = skipped
  };
}
function listSubagentWorktrees(cwd) {
  ensureGitRepository(cwd);
  const repoRoot = getRepoRoot(cwd);
  const out = tryRunGit(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!out.ok) return [];
  const entries = [];
  let current = null;
  for (const line of out.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null, head: null, locked: false };
    } else if (line.startsWith("HEAD ") && current) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ") && current) {
      const ref = line.slice("branch ".length);
      current.branch = ref.replace(/^refs\/heads\//, "");
    } else if (line === "locked" && current) {
      current.locked = true;
    }
  }
  if (current) entries.push(current);
  return entries.filter(
    (e) => e.path.includes(".codex-bridge-worktrees/") || e.branch && e.branch.startsWith("subagent/")
  );
}

// src/lib/workspace.mjs
function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}

// src/lib/state.mjs
var STATE_VERSION = 1;
var BRIDGE_PLUGIN_DATA_ENV = "CODEX_BRIDGE_PLUGIN_DATA";
var LEGACY_PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
var FALLBACK_STATE_ROOT_DIR = path4.join(os.tmpdir(), "codex-companion");
var STATE_FILE_NAME = "state.json";
var STATE_LOCK_FILE_NAME = "state.lock";
var JOBS_DIR_NAME = "jobs";
var MAX_JOBS = 50;
var LOCK_TIMEOUT_MS = 5e3;
var STALE_LOCK_MS = 3e4;
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}
function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs4.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }
  const slugSource = path4.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[BRIDGE_PLUGIN_DATA_ENV] || process.env[LEGACY_PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path4.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path4.join(stateRoot, `${slug}-${hash}`);
}
function resolveStateFile(cwd) {
  return path4.join(resolveStateDir(cwd), STATE_FILE_NAME);
}
function resolveStateLockFile(cwd) {
  return path4.join(resolveStateDir(cwd), STATE_LOCK_FILE_NAME);
}
function resolveJobsDir(cwd) {
  return path4.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}
function ensureStateDir(cwd) {
  fs4.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}
function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}
function acquireStateLock(cwd) {
  ensureStateDir(cwd);
  const lockFile = resolveStateLockFile(cwd);
  const startedAt = Date.now();
  while (true) {
    try {
      const fd = fs4.openSync(lockFile, "wx");
      fs4.writeFileSync(fd, `${process.pid}
${(/* @__PURE__ */ new Date()).toISOString()}
`, "utf8");
      let ownedIno = null;
      try {
        ownedIno = fs4.fstatSync(fd).ino;
      } catch {
      }
      return () => {
        try {
          fs4.closeSync(fd);
        } catch {
        }
        try {
          if (ownedIno !== null) {
            const stat = fs4.statSync(lockFile);
            if (stat.ino !== ownedIno) {
              return;
            }
          }
          fs4.unlinkSync(lockFile);
        } catch (releaseError) {
          if (releaseError?.code !== "ENOENT") {
          }
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        const stat = fs4.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          fs4.unlinkSync(lockFile);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for state lock: ${lockFile}`);
      }
      sleepSync(50);
    }
  }
}
function pidIsAlive(pid) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "ESRCH") return false;
    return true;
  }
}
function reapOrphans(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return { jobs, reaped: 0 };
  let changed = 0;
  const reaped = jobs.map((job) => {
    if (!job || job.status !== "running" && job.status !== "queued") return job;
    if (pidIsAlive(job.pid)) return job;
    changed++;
    return {
      ...job,
      status: "orphaned",
      phase: "orphaned",
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      errorMessage: job.errorMessage ?? `Backing process (pid ${job.pid ?? "?"}) no longer alive \u2014 reaped on load.`
    };
  });
  return { jobs: reaped, reaped: changed };
}
function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs4.existsSync(stateFile)) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(fs4.readFileSync(stateFile, "utf8"));
    const rawJobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...parsed.config ?? {}
      },
      jobs: rawJobs
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return defaultState();
    }
    let renamedPath = null;
    try {
      const candidate = `${stateFile}.corrupt-${Date.now()}`;
      fs4.renameSync(stateFile, candidate);
      renamedPath = candidate;
    } catch (renameError) {
      if (renameError && renameError.code !== "ENOENT" && renameError.code !== "EXDEV") {
      }
    }
    process.emitWarning(
      `State file at ${stateFile} was corrupt (${error?.message ?? error}); preserved at ${renamedPath ?? "<unable to rename>"}`,
      "CodexBridgeStateWarning"
    );
    return defaultState();
  }
}
function isActiveJob(job) {
  return job?.status === "queued" || job?.status === "running";
}
function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}
function pruneJobs(jobs) {
  const sortedJobs = sortJobsNewestFirst(jobs);
  const activeJobs = sortedJobs.filter(isActiveJob);
  const terminalJobs = sortedJobs.filter((job) => !isActiveJob(job)).slice(0, MAX_JOBS);
  return sortJobsNewestFirst([...activeJobs, ...terminalJobs]);
}
function removeFileIfExists(filePath) {
  if (filePath && fs4.existsSync(filePath)) {
    fs4.unlinkSync(filePath);
  }
}
function writeJsonFileAtomic(filePath, payload) {
  fs4.mkdirSync(path4.dirname(filePath), { recursive: true });
  const tempPath = path4.join(
    path4.dirname(filePath),
    `.${path4.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  const fd = fs4.openSync(tempPath, "w");
  try {
    fs4.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}
`, "utf8");
    fs4.fsyncSync(fd);
  } finally {
    fs4.closeSync(fd);
  }
  try {
    fs4.renameSync(tempPath, filePath);
  } catch (renameError) {
    try {
      fs4.unlinkSync(tempPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
      }
    }
    throw renameError;
  }
}
function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const { jobs: reapedJobs } = reapOrphans(state.jobs ?? []);
  const nextJobs = pruneJobs(reapedJobs);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...state.config ?? {}
    },
    jobs: nextJobs
  };
  writeJsonFileAtomic(resolveStateFile(cwd), nextState);
  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    try {
      removeJobFile(resolveJobFile(cwd, job.id));
    } catch {
    }
    try {
      removeFileIfExists(job.logFile);
    } catch {
    }
  }
  return nextState;
}
function updateState(cwd, mutate) {
  const release = acquireStateLock(cwd);
  try {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  } finally {
    release();
  }
}
function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}
function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp2 = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp2,
        updatedAt: timestamp2,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp2
    };
  });
}
function listJobs(cwd, options = {}) {
  const jobs = loadState(cwd).jobs;
  if (options && options.raw) {
    return jobs;
  }
  const { jobs: reapedJobs } = reapOrphans(jobs);
  return reapedJobs;
}
function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}
function getConfig(cwd) {
  return loadState(cwd).config;
}
function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeJsonFileAtomic(jobFile, payload);
  return jobFile;
}
function readJobFile(jobFile) {
  try {
    return JSON.parse(fs4.readFileSync(jobFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw error;
    }
    let corruptPath = null;
    if (fs4.existsSync(jobFile)) {
      corruptPath = `${jobFile}.corrupt-${Date.now()}`;
      try {
        fs4.renameSync(jobFile, corruptPath);
      } catch {
        corruptPath = null;
      }
    }
    const wrapped = new Error(
      `Job detail file at ${jobFile} was corrupt${corruptPath ? `; preserved at ${corruptPath}` : ""}.`
    );
    wrapped.code = "JOB_DETAIL_CORRUPT";
    wrapped.jobFile = jobFile;
    wrapped.corruptPath = corruptPath;
    wrapped.cause = error;
    throw wrapped;
  }
}
function removeJobFile(jobFile) {
  if (fs4.existsSync(jobFile)) {
    fs4.unlinkSync(jobFile);
  }
}
function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path4.join(resolveJobsDir(cwd), `${jobId}.log`);
}
function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path4.join(resolveJobsDir(cwd), `${jobId}.json`);
}

// src/lib/broker-lifecycle.mjs
var BROKER_STATE_FILE = "broker.json";
var BROKER_LOCK_FILE = "broker.lock";
var BROKER_LOCK_TIMEOUT_MS = 5e3;
var BROKER_STALE_LOCK_MS = 3e4;
function createBrokerSessionDir(prefix = "cxc-") {
  return fs5.mkdtempSync(path5.join(os2.tmpdir(), prefix));
}
function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}
async function waitForBrokerEndpoint(endpoint, timeoutMs = 2e3) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process5.env }) {
  const logFd = fs5.openSync(logFile, "a");
  const child = spawn(process5.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs5.closeSync(logFd);
  return child;
}
function resolveBrokerStateFile(cwd) {
  return path5.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}
function resolveBrokerLockFile(cwd) {
  return path5.join(resolveStateDir(cwd), BROKER_LOCK_FILE);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function readBrokerLockPid(lockFile) {
  try {
    const [pidLine] = fs5.readFileSync(lockFile, "utf8").split(/\r?\n/, 1);
    const pid = Number.parseInt(pidLine, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
function isProcessAlive(pid) {
  try {
    process5.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
async function acquireBrokerLock(cwd, { timeoutMs = BROKER_LOCK_TIMEOUT_MS, staleMs = BROKER_STALE_LOCK_MS } = {}) {
  const stateDir = resolveStateDir(cwd);
  fs5.mkdirSync(stateDir, { recursive: true });
  const lockFile = resolveBrokerLockFile(cwd);
  const startedAt = Date.now();
  while (true) {
    try {
      const fd = fs5.openSync(lockFile, "wx");
      fs5.writeFileSync(fd, `${process5.pid}
${(/* @__PURE__ */ new Date()).toISOString()}
`, "utf8");
      let ownedIno = null;
      try {
        ownedIno = fs5.fstatSync(fd).ino;
      } catch {
      }
      return () => {
        try {
          fs5.closeSync(fd);
        } catch {
        }
        try {
          if (ownedIno !== null) {
            const stat = fs5.statSync(lockFile);
            if (stat.ino !== ownedIno) return;
          }
          fs5.unlinkSync(lockFile);
        } catch (releaseError) {
          if (releaseError?.code !== "ENOENT") {
          }
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        const stat = fs5.statSync(lockFile);
        const ownerPid = readBrokerLockPid(lockFile);
        const ownerAlive = ownerPid ? isProcessAlive(ownerPid) : false;
        if (ownerPid && !ownerAlive || !ownerPid && Date.now() - stat.mtimeMs > staleMs) {
          fs5.unlinkSync(lockFile);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        const err = new Error(`Timed out waiting for broker session lock: ${lockFile}`);
        err.code = "BROKER_LOCK_TIMEOUT";
        throw err;
      }
      await sleep(50);
    }
  }
}
function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs5.existsSync(stateFile)) {
    return null;
  }
  try {
    return JSON.parse(fs5.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}
function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs5.mkdirSync(stateDir, { recursive: true });
  writeJsonFileAtomic(resolveBrokerStateFile(cwd), session);
}
function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs5.existsSync(stateFile)) {
    fs5.unlinkSync(stateFile);
  }
}
async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}
function isSourceBrokerLifecycleUrl(moduleUrl) {
  try {
    const modulePath = fileURLToPath(moduleUrl);
    return path5.basename(modulePath) === "broker-lifecycle.mjs" && path5.basename(path5.dirname(modulePath)) === "lib" && path5.basename(path5.dirname(path5.dirname(modulePath))) === "src";
  } catch {
    return false;
  }
}
function readBrokerLogTail(logFile, maxChars = 4e3) {
  try {
    const log = fs5.readFileSync(logFile, "utf8").trim();
    if (!log) {
      return "";
    }
    return log.length > maxChars ? log.slice(-maxChars) : log;
  } catch {
    return "";
  }
}
function createBrokerStartFailure({ endpoint, scriptPath, logFile, timeoutMs }) {
  const logTail = readBrokerLogTail(logFile);
  const detail = logTail ? ` Broker log:
${logTail}` : " No broker log output was captured.";
  const error = new Error(
    `Codex app-server broker failed to start within ${timeoutMs}ms at ${endpoint} using ${scriptPath}.${detail}`
  );
  error.code = "BROKER_START_FAILED";
  return error;
}
function resolveBrokerScriptPath({ moduleUrl = import.meta.url, existsSync = fs5.existsSync } = {}) {
  const pluginBroker = new URL("./app-server-broker.mjs", moduleUrl);
  const bundledBroker = new URL("../app-server-broker.mjs", moduleUrl);
  const sourceBroker = new URL("../adapters/codex/broker.mjs", moduleUrl);
  const candidates = isSourceBrokerLifecycleUrl(moduleUrl) ? [sourceBroker, pluginBroker, bundledBroker] : [pluginBroker, bundledBroker, sourceBroker];
  for (const url of candidates) {
    const p = fileURLToPath(url);
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Could not locate broker script. Tried:
  ${candidates.map((url) => fileURLToPath(url)).join("\n  ")}`
  );
}
async function ensureBrokerSession(cwd, options = {}) {
  const release = await acquireBrokerLock(cwd, {
    timeoutMs: options.lockTimeoutMs ?? BROKER_LOCK_TIMEOUT_MS,
    staleMs: options.lockStaleMs ?? BROKER_STALE_LOCK_MS
  });
  try {
    const existing = loadBrokerSession(cwd);
    if (existing && await isBrokerEndpointReady(existing.endpoint)) {
      return existing;
    }
    if (existing) {
      teardownBrokerSession({
        endpoint: existing.endpoint ?? null,
        pidFile: existing.pidFile ?? null,
        logFile: existing.logFile ?? null,
        sessionDir: existing.sessionDir ?? null,
        pid: existing.pid ?? null,
        killProcess: options.killProcess ?? null
      });
      clearBrokerSession(cwd);
    }
    const sessionDir = createBrokerSessionDir();
    const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
    const endpoint = endpointFactory(sessionDir, options.platform);
    const pidFile = path5.join(sessionDir, "broker.pid");
    const logFile = path5.join(sessionDir, "broker.log");
    const scriptPath = options.scriptPath ?? resolveBrokerScriptPath();
    const timeoutMs = options.timeoutMs ?? 2e3;
    const child = spawnBrokerProcess({
      scriptPath,
      cwd,
      endpoint,
      pidFile,
      logFile,
      env: options.env ?? process5.env
    });
    const ready = await waitForBrokerEndpoint(endpoint, timeoutMs);
    if (!ready) {
      const startFailure = createBrokerStartFailure({ endpoint, scriptPath, logFile, timeoutMs });
      teardownBrokerSession({
        endpoint,
        pidFile,
        logFile,
        sessionDir,
        pid: child.pid ?? null,
        killProcess: options.killProcess ?? terminateProcessTree
      });
      throw startFailure;
    }
    const session = {
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null
    };
    saveBrokerSession(cwd, session);
    return session;
  } finally {
    release();
  }
}
function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
    }
  }
  if (pidFile && fs5.existsSync(pidFile)) {
    fs5.unlinkSync(pidFile);
  }
  if (logFile && fs5.existsSync(logFile)) {
    fs5.unlinkSync(logFile);
  }
  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs5.existsSync(target.path)) {
        fs5.unlinkSync(target.path);
      }
    } catch {
    }
  }
  const resolvedSessionDir = sessionDir ?? (pidFile ? path5.dirname(pidFile) : logFile ? path5.dirname(logFile) : null);
  if (resolvedSessionDir && fs5.existsSync(resolvedSessionDir)) {
    try {
      fs5.rmdirSync(resolvedSessionDir);
    } catch {
    }
  }
}

// src/adapters/codex/protocol.mjs
var BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
var BROKER_BUSY_RPC_CODE = -32001;
var APP_SERVER_INITIALIZE_TIMEOUT_MS = 1e4;
var APP_SERVER_SHUTDOWN_TIMEOUT_MS = 5e3;
var SAVED_BROKER_ENDPOINT_PROBE_TIMEOUT_MS = 150;
var DEFAULT_CLIENT_INFO = {
  title: "Codex Bridge",
  name: "codex_bridge",
  version: "1.0.0"
};
var DEFAULT_CAPABILITIES = {
  experimentalApi: true,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};
function buildJsonRpcError(code, message, data) {
  return data === void 0 ? { code, message } : { code, message, data };
}
function createProtocolError(message, data) {
  const error = (
    /** @type {ProtocolError} */
    new Error(message)
  );
  error.data = data;
  if (data?.code !== void 0) {
    error.rpcCode = data.code;
  }
  return error;
}
function timeoutError(message) {
  const error = new Error(message);
  error.code = "ETIMEDOUT";
  return error;
}
function withTimeout(promise, ms, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(message)), ms);
      timer.unref?.();
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
function serverRequestError(method) {
  return buildJsonRpcError(-32601, `Unsupported server request: ${method}`);
}
async function loadReadySavedBrokerEndpoint(cwd) {
  const brokerSession = loadBrokerSession(cwd);
  if (!brokerSession) {
    return null;
  }
  const endpoint = brokerSession.endpoint ?? null;
  try {
    if (endpoint && await waitForBrokerEndpoint(endpoint, SAVED_BROKER_ENDPOINT_PROBE_TIMEOUT_MS)) {
      return endpoint;
    }
  } catch {
  }
  clearBrokerSession(cwd);
  return null;
}
var AppServerClientBase = class {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = /* @__PURE__ */ new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.transportClosed = false;
    this.exitError = null;
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";
    this.serverRequestHandler = null;
    this.listeners = /* @__PURE__ */ new Map();
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.transportExitPromise = new Promise((resolve) => {
      this.resolveTransportExit = resolve;
    });
  }
  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }
  on(eventName, handler) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, /* @__PURE__ */ new Set());
    }
    this.listeners.get(eventName).add(handler);
    return this;
  }
  off(eventName, handler) {
    this.listeners.get(eventName)?.delete(handler);
    return this;
  }
  emit(eventName, payload) {
    for (const handler of this.listeners.get(eventName) ?? []) {
      try {
        handler(payload);
      } catch {
      }
    }
  }
  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./protocol").AppServerRequestParams<M>} params
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<import("./protocol").AppServerResponse<M>>}
   */
  request(method, params, options = {}) {
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }
    const signal = options.signal ?? null;
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("request aborted"));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      let abortHandler = null;
      const cleanupAbort = () => {
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
          abortHandler = null;
        }
      };
      const wrappedResolve = (value) => {
        cleanupAbort();
        resolve(value);
      };
      const wrappedReject = (error) => {
        cleanupAbort();
        reject(error);
      };
      this.pending.set(id, { resolve: wrappedResolve, reject: wrappedReject, method });
      if (signal) {
        abortHandler = () => {
          if (this.pending.get(id)) {
            this.pending.delete(id);
          }
          cleanupAbort();
          reject(signal.reason ?? new Error("request aborted"));
        };
        signal.addEventListener("abort", abortHandler, { once: true });
      }
      try {
        this.sendMessage({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        cleanupAbort();
        reject(error);
      }
    });
  }
  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }
  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }
  handleLine(line) {
    if (!line.trim()) {
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(
        createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }),
        { transportExited: false }
      );
      return;
    }
    if (message.id !== void 0 && message.method) {
      this.handleServerRequest(message);
      return;
    }
    if (message.id !== void 0) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method && this.notificationHandler) {
      this.notificationHandler(
        /** @type {AppServerNotification} */
        message
      );
    }
  }
  handleServerRequest(message) {
    const method = message.method;
    if (this.serverRequestHandler) {
      message._client = this;
      Promise.resolve(this.serverRequestHandler(message)).catch((error) => {
        this.rejectServerRequest(
          message.id,
          buildJsonRpcError(-32e3, error?.message ?? `Server request handler failed for ${method}.`)
        );
      });
      return;
    }
    this.rejectServerRequest(message.id, serverRequestError(method));
  }
  setServerRequestHandler(handler) {
    this.serverRequestHandler = handler;
  }
  resolveServerRequest(id, result) {
    this.sendMessage({ id, result: result ?? {} });
  }
  rejectServerRequest(id, error) {
    this.sendMessage({ id, error });
  }
  handleExit(error, { transportExited = true } = {}) {
    if (transportExited && !this.transportClosed) {
      this.transportClosed = true;
      this.resolveTransportExit(void 0);
    }
    if (this.exitResolved) {
      return;
    }
    this.exitResolved = true;
    this.exitError = error ?? null;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.emit("exit", this.exitError);
    this.resolveExit(void 0);
  }
  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
};
var SpawnedCodexAppServerClient = class extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }
  async initialize() {
    this.proc = spawn2("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process6.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process6.platform === "win32" ? process6.env.SHELL || true : false,
      windowsHide: true
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.proc.on("error", (error) => {
      this.handleExit(error);
    });
    this.proc.on("exit", (code, signal) => {
      const detail = code === 0 ? null : createProtocolError(`codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`);
      this.handleExit(detail);
    });
    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });
    await withTimeout(
      this.request("initialize", {
        clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
        capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
      }),
      APP_SERVER_INITIALIZE_TIMEOUT_MS,
      "Timed out initializing codex app-server."
    );
    this.notify("initialized", {});
  }
  async close() {
    if (this.transportClosed) {
      await this.transportExitPromise;
      return;
    }
    this.closed = true;
    if (this.readline) {
      this.readline.close();
    }
    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          if (process6.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, 50).unref?.();
    }
    try {
      await withTimeout(this.transportExitPromise, APP_SERVER_SHUTDOWN_TIMEOUT_MS, "Timed out shutting down codex app-server.");
    } catch (error) {
      if (this.proc && this.proc.exitCode === null) {
        if (process6.platform === "win32") {
          try {
            terminateProcessTree(this.proc.pid);
          } catch {
          }
        } else {
          this.proc.kill("SIGKILL");
        }
      }
      this.handleExit(error);
    }
  }
  sendMessage(message) {
    const line = `${JSON.stringify(message)}
`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    if (stdin.destroyed || !stdin.writable) {
      throw new Error("codex app-server stdin is closed.");
    }
    stdin.write(line, (error) => {
      if (error) {
        this.handleExit(error);
      }
    });
  }
};
var BrokerCodexAppServerClient = class extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }
  async initialize() {
    await withTimeout(new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net2.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    }), APP_SERVER_INITIALIZE_TIMEOUT_MS, "Timed out connecting to codex app-server broker.");
    await withTimeout(
      this.request("initialize", {
        clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
        capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
      }),
      APP_SERVER_INITIALIZE_TIMEOUT_MS,
      "Timed out initializing codex app-server broker connection."
    );
    this.notify("initialized", {});
  }
  async close() {
    if (this.transportClosed) {
      await this.transportExitPromise;
      return;
    }
    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    try {
      await withTimeout(this.transportExitPromise, APP_SERVER_SHUTDOWN_TIMEOUT_MS, "Timed out closing codex app-server broker connection.");
    } catch (error) {
      this.socket?.destroy();
      this.handleExit(error);
    }
  }
  sendMessage(message) {
    const line = `${JSON.stringify(message)}
`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    if (socket.destroyed || !socket.writable) {
      throw new Error("codex app-server broker connection is closed.");
    }
    socket.write(line, (error) => {
      if (error) {
        this.handleExit(error);
      }
    });
  }
};
var CodexAppServerClient = class {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    let brokerEndpointSource = null;
    if (!options.disableBroker) {
      const explicitBrokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process6.env[BROKER_ENDPOINT_ENV] ?? null;
      if (explicitBrokerEndpoint) {
        brokerEndpoint = explicitBrokerEndpoint;
        brokerEndpointSource = "explicit";
      }
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = await loadReadySavedBrokerEndpoint(cwd);
        if (brokerEndpoint) {
          brokerEndpointSource = "saved";
        }
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
        if (brokerEndpoint) {
          brokerEndpointSource = "managed";
        }
      }
    }
    const createBrokerClient = options._createBrokerClient ?? ((clientCwd, clientOptions) => new BrokerCodexAppServerClient(clientCwd, clientOptions));
    const createDirectClient = options._createDirectClient ?? ((clientCwd, clientOptions) => new SpawnedCodexAppServerClient(clientCwd, clientOptions));
    const client = brokerEndpoint ? createBrokerClient(cwd, { ...options, brokerEndpoint }) : createDirectClient(cwd, options);
    try {
      await client.initialize();
    } catch (error) {
      await client.close().catch(() => {
      });
      if (brokerEndpointSource === "saved") {
        clearBrokerSession(cwd);
        const fallbackClient = createDirectClient(cwd, options);
        try {
          await fallbackClient.initialize();
        } catch (fallbackError) {
          await fallbackClient.close().catch(() => {
          });
          throw fallbackError;
        }
        return fallbackClient;
      }
      throw error;
    }
    return client;
  }
};

// src/adapters/codex/codex.mjs
var SERVICE_NAME = "claude_code_codex_plugin";
var TASK_THREAD_PREFIX = "Codex Companion Task";
var TURN_INTERRUPT_GRACE_MS = 3e4;
var DEFAULT_CONTINUE_PROMPT = "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
function cleanCodexStderr(stderr) {
  return stderr.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:")).join("\n");
}
function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? false,
    experimentalRawEvents: false
  };
}
function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: "never",
    sandbox: options.sandbox ?? "read-only"
  };
}
function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}
function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}
function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}
function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}
function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}
function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}
function collectTouchedFiles(fileChanges) {
  const paths = /* @__PURE__ */ new Set();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}
function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}
function extractReasoningSections(value) {
  if (!value) {
    return [];
  }
  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }
  return [];
}
function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}
function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }
  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}
function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}
function registerThread(state, threadId, options = {}) {
  if (!threadId) {
    return;
  }
  state.threadIds.add(threadId);
  const label = options.threadName ?? options.name ?? options.agentNickname ?? options.agentRole ?? state.threadLabels.get(threadId) ?? null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}
function describeStartedItem(state, item) {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${item.changes.length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary = subagents.length > 0 ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.` : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}
function describeCompletedItem(state, item) {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary = subagents.length > 0 ? `Subagent ${subagents.join(", ")} ${item.status}.` : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}
function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  return {
    threadId,
    rootThreadId: threadId,
    threadIds: /* @__PURE__ */ new Set([threadId]),
    threadTurnIds: /* @__PURE__ */ new Map(),
    threadLabels: /* @__PURE__ */ new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    completionTimer: null,
    pendingCollaborations: /* @__PURE__ */ new Set(),
    activeSubagentTurns: /* @__PURE__ */ new Set(),
    lastAgentMessage: "",
    reviewText: "",
    planDetected: false,
    planText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    pendingServerRequests: 0,
    onProgress: options.onProgress ?? null,
    onItemCompleted: typeof options.onItemCompleted === "function" ? options.onItemCompleted : null
  };
}
function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}
function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }
  clearCompletionTimer(state);
  state.completed = true;
  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: options.inferredStatus ?? "completed"
    };
  }
  if (options.inferred) {
    emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
  }
  state.resolveCompletion(state);
}
function scheduleInferredCompletion(state) {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }
  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }
  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, 250);
  state.completionTimer.unref?.();
}
function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}
function recordItem(state, item, lifecycle, threadId = null) {
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }
  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state);
        }
      }
      if (lifecycle === "completed") {
        const sourceLabel = labelForThread(state, threadId);
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }
  if (item.type === "plan" && lifecycle === "completed") {
    state.planDetected = true;
    state.planText = item.text ?? "";
    emitLogEvent(state.onProgress, {
      message: `Plan proposed: ${shorten(item.text ?? "", 96)}`,
      stderrMessage: null,
      phase: "plan_ready",
      logTitle: "Proposed plan",
      logBody: item.text ?? ""
    });
    return;
  }
  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }
  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}` : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }
  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }
  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}
function applyTurnNotification(state, message) {
  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) === state.threadId && !state.turnId) {
        state.turnId = message.params.turn.id;
      }
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        (message.params.threadId ?? null) === state.threadId ? {
          threadId: message.params.threadId ?? null,
          turnId: message.params.turn.id ?? null
        } : {}
      );
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const update = describeStartedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "item/completed":
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      if (typeof state.onItemCompleted === "function") {
        try {
          state.onItemCompleted(message.params.item, { threadId: message.params.threadId ?? null });
        } catch (err) {
          emitProgress(state.onProgress, `onItemCompleted threw: ${err?.message ?? err}`, null);
        }
      }
      break;
    case "error": {
      const err = message.params.error ?? {};
      const willRetry = message.params.will_retry ?? message.params.willRetry ?? false;
      const codexErrorInfo = err.codexErrorInfo ?? err.codex_error_info ?? null;
      state.error = err;
      state.lastErrorInfo = { codexErrorInfo, willRetry };
      if (!willRetry) {
        emitProgress(state.onProgress, `Codex error: ${err.message} [${codexErrorInfo ?? "unknown"}]`, "failed");
      }
      break;
    }
    case "serverRequest/resolved":
      emitProgress(state.onProgress, `Server request resolved: ${message.params.requestId}`, "confirmed");
      break;
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      {
        const completedTurn = message.params.turn;
        if (completedTurn?.status !== "completed" && completedTurn?.error) {
          state.error = { ...state.error ?? {}, ...completedTurn.error };
        }
        completeTurn(state, completedTurn);
      }
      break;
    default:
      break;
  }
}
function routeTurnNotification(state, message, previousHandler) {
  if (message.method === "thread/started" || message.method === "thread/name/updated") {
    applyTurnNotification(state, message);
    return;
  }
  if (!belongsToTurn(state, message)) {
    if (previousHandler) {
      previousHandler(message);
    }
    return;
  }
  applyTurnNotification(state, message);
}
function flushBufferedNotifications(state, previousHandler) {
  if (state.bufferedNotifications.length === 0 || !state.turnId) {
    return;
  }
  const buffered = state.bufferedNotifications.splice(0);
  for (const message of buffered) {
    routeTurnNotification(state, message, previousHandler);
    if (state.completed) {
      break;
    }
  }
}
async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;
  const idleTimeoutMs = Number(options.idleTimeoutMs) > 0 ? Number(options.idleTimeoutMs) : 0;
  const turnTimeoutMs = Number(options.turnTimeoutMs) > 0 ? Number(options.turnTimeoutMs) : 0;
  let lastNotificationAt = Date.now();
  let idleInterval = null;
  let turnTimer = null;
  let interruptGraceTimer = null;
  const turnAbort = new AbortController();
  const markActivity = () => {
    lastNotificationAt = Date.now();
  };
  markActivity.startServerRequest = () => {
    state.pendingServerRequests += 1;
    markActivity();
    let finished = false;
    return () => {
      if (finished) {
        return;
      }
      finished = true;
      state.pendingServerRequests = Math.max(0, state.pendingServerRequests - 1);
      markActivity();
    };
  };
  if (typeof options.onActivityMarkerReady === "function") {
    options.onActivityMarkerReady(markActivity);
  }
  if (idleTimeoutMs > 0) {
    const checkIntervalMs = Math.min(5e3, idleTimeoutMs);
    idleInterval = setInterval(() => {
      if (state.completed) {
        return;
      }
      if (state.pendingServerRequests > 0) {
        markActivity();
        return;
      }
      const elapsed = Date.now() - lastNotificationAt;
      if (elapsed >= idleTimeoutMs) {
        clearInterval(idleInterval);
        idleInterval = null;
        const seconds = Math.round(idleTimeoutMs / 1e3);
        state.error = { message: `No events received for ${seconds}s (idle timeout).` };
        emitProgress(state.onProgress, state.error.message, "failed");
        if (typeof options.onIdleTimeout === "function") {
          try {
            options.onIdleTimeout({ threadId: state.threadId, turnId: state.turnId, elapsedMs: elapsed });
          } catch {
          }
        }
        completeTurn(state, null, { inferredStatus: "failed" });
      }
    }, checkIntervalMs);
    idleInterval.unref?.();
  }
  if (turnTimeoutMs > 0) {
    turnTimer = setTimeout(() => {
      if (state.completed) {
        return;
      }
      const message = `Turn timed out after ${turnTimeoutMs}ms.`;
      state.error = { message, code: "TurnTimeout" };
      emitProgress(state.onProgress, message, "failed");
      const interruptTurnId = state.turnId ?? state.threadTurnIds.get(state.threadId) ?? null;
      if (interruptTurnId) {
        try {
          Promise.resolve(client.request("turn/interrupt", { threadId: state.threadId, turnId: interruptTurnId })).catch((error) => {
            emitProgress(state.onProgress, `turn/interrupt after timeout failed: ${error?.message ?? error}`, null);
            if (!state.completed) {
              completeTurn(state, null, { inferredStatus: "failed" });
            }
          });
        } catch (error) {
          emitProgress(state.onProgress, `turn/interrupt after timeout failed: ${error?.message ?? error}`, null);
          completeTurn(state, null, { inferredStatus: "failed" });
          return;
        }
        const interruptGraceMs = Number(options.interruptGraceMs) > 0 ? Number(options.interruptGraceMs) : TURN_INTERRUPT_GRACE_MS;
        interruptGraceTimer = setTimeout(() => {
          if (state.completed) {
            return;
          }
          emitProgress(
            state.onProgress,
            `turn/interrupt did not produce turn/completed within ${interruptGraceMs}ms.`,
            "failed"
          );
          completeTurn(state, null, { inferredStatus: "failed" });
        }, interruptGraceMs);
        interruptGraceTimer.unref?.();
        return;
      }
      emitProgress(
        state.onProgress,
        "turn timeout fired before turn id known; upstream turn may continue running",
        null
      );
      completeTurn(state, null, { inferredStatus: "failed" });
    }, turnTimeoutMs);
    turnTimer.unref?.();
  }
  client.setNotificationHandler((message) => {
    lastNotificationAt = Date.now();
    if (!state.turnId) {
      const messageThreadId = extractThreadId(message);
      if (messageThreadId === state.threadId && (message.method === "turn/started" || message.method === "turn/completed")) {
        applyTurnNotification(state, message);
        flushBufferedNotifications(state, previousHandler);
        return;
      }
      state.bufferedNotifications.push(message);
      return;
    }
    routeTurnNotification(state, message, previousHandler);
  });
  const onExit = () => {
    if (state.completed) {
      return;
    }
    const bufferedTerminal = state.bufferedNotifications.find(
      (message) => message?.method === "turn/completed" && (message?.params?.threadId ?? null) === state.threadId
    );
    if (bufferedTerminal) {
      applyTurnNotification(state, bufferedTerminal);
      if (state.completed) {
        return;
      }
    }
    state.error = { message: "Codex app-server exited unexpectedly" };
    completeTurn(state, null, { inferredStatus: "failed" });
  };
  if (client.on) client.on("exit", onExit);
  try {
    const response = await Promise.race([
      startRequest(turnAbort.signal),
      state.completion.then(() => null)
    ]);
    if (!response) {
      turnAbort.abort(new Error("captureTurn: state.completion won the race"));
      return await state.completion;
    }
    markActivity();
    if (state.completed) {
      return await state.completion;
    }
    options.onResponse?.(response, state);
    const responseTurnId = response.turn?.id ?? null;
    if (responseTurnId && state.turnId && state.turnId !== responseTurnId) {
      state.error = {
        message: `turn/start response turn id ${responseTurnId} did not match streamed turn id ${state.turnId}.`,
        code: "ProtocolDrift"
      };
      completeTurn(state, null, { inferredStatus: "failed" });
      return await state.completion;
    }
    state.turnId = state.turnId ?? responseTurnId;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
    }
    flushBufferedNotifications(state, previousHandler);
    if (response.turn?.status && response.turn.status !== "inProgress") {
      completeTurn(state, response.turn);
    }
    return await state.completion;
  } finally {
    clearCompletionTimer(state);
    if (idleInterval) {
      clearInterval(idleInterval);
      idleInterval = null;
    }
    if (turnTimer) {
      clearTimeout(turnTimer);
      turnTimer = null;
    }
    if (interruptGraceTimer) {
      clearTimeout(interruptGraceTimer);
      interruptGraceTimer = null;
    }
    if (typeof options.onActivityMarkerReady === "function") {
      options.onActivityMarkerReady(null);
    }
    client.setNotificationHandler(previousHandler ?? null);
    if (client.off) client.off("exit", onExit);
    else if (client.removeListener) client.removeListener("exit", onExit);
  }
}
async function withAppServer(cwd, fn) {
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect = client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE || brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED");
    if (client) {
      await client.close().catch(() => {
      });
      client = null;
    }
    if (!shouldRetryDirect) {
      throw error;
    }
    const directClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}
async function startThread(client, cwd, options = {}) {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch (err) {
      const msg = String(err?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}
async function resumeThread(client, threadId, cwd, options = {}) {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}
function buildResultStatus(turnState) {
  if (turnState.error?.code === "TurnTimeout") {
    return 1;
  }
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}
var BUILTIN_PROVIDER_LABELS = /* @__PURE__ */ new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);
function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}
function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}
function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}
function resolveProviderConfig(configResponse) {
  const config = configResponse?.config;
  if (!config || typeof config !== "object") {
    return {
      providerId: null,
      providerConfig: null
    };
  }
  const providerId = normalizeProviderId(config.model_provider);
  const providers = config.model_providers && typeof config.model_providers === "object" && !Array.isArray(config.model_providers) ? config.model_providers : null;
  const providerConfig = providerId && providers?.[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;
  return {
    providerId,
    providerConfig
  };
}
function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth = typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);
  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }
  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }
  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }
  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}
async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });
    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  }
}
function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }
  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }
  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}
function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Codex runtime.",
      endpoint
    };
  }
  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Codex runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}
async function getCodexAuthStatus(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      env: options.env,
      reuseExistingBroker: true
    });
    return await getCodexAuthStatusFromClient(client, cwd);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  } finally {
    if (client) {
      await client.close().catch(() => {
      });
    }
  }
}
async function interruptAppServerTurn(cwd, { threadId, turnId }) {
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true });
    await client.request("turn/interrupt", { threadId, turnId });
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Interrupted ${turnId} on ${threadId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {
    });
  }
}
async function runAppServerReview(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new CliError("Codex CLI is not installed or is missing required runtime support.", {
      class: "dependency_failed",
      code: "CODEX_UNAVAILABLE",
      retryable: false,
      suggestion: "Install Codex with `npm install -g @openai/codex`, then rerun `codex-bridge setup`."
    });
  }
  return withAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
    const thread = await startThread(client, cwd, {
      model: options.model,
      sandbox: "read-only",
      ephemeral: true,
      threadName: options.threadName
    });
    const sourceThreadId = thread.thread.id;
    emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", {
      threadId: sourceThreadId
    });
    const delivery = options.delivery ?? "inline";
    const turnState = await captureTurn(
      client,
      sourceThreadId,
      (signal) => client.request("review/start", {
        threadId: sourceThreadId,
        delivery,
        target: options.target
      }, { signal }),
      {
        onProgress: options.onProgress,
        idleTimeoutMs: options.idleTimeoutMs ?? null,
        turnTimeoutMs: options.turnTimeoutMs ?? null,
        onResponse(response, state) {
          if (response.reviewThreadId) {
            state.threadIds.add(response.reviewThreadId);
            if (delivery === "detached") {
              state.threadId = response.reviewThreadId;
            }
          }
        }
      }
    );
    return {
      status: buildResultStatus(turnState),
      threadId: turnState.threadId,
      sourceThreadId,
      turnId: turnState.turnId,
      reviewText: turnState.reviewText,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}
async function runAppServerTurn(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new CliError("Codex CLI is not installed or is missing required runtime support.", {
      class: "dependency_failed",
      code: "CODEX_UNAVAILABLE",
      retryable: false,
      suggestion: "Install Codex with `npm install -g @openai/codex`, then rerun `codex-bridge setup`."
    });
  }
  return withAppServer(cwd, async (client) => {
    let threadId;
    let markServerRequestActivity = null;
    if (options.onServerRequest) {
      client.setServerRequestHandler(async (message) => {
        const finishServerRequest = typeof markServerRequestActivity?.startServerRequest === "function" ? markServerRequestActivity.startServerRequest() : null;
        markServerRequestActivity?.();
        try {
          return await options.onServerRequest(message);
        } finally {
          finishServerRequest?.();
        }
      });
    }
    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      const response = await resumeThread(client, options.resumeThreadId, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: false
      });
      threadId = response.thread.id;
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      const response = await startThread(client, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: options.persistThread ? false : true,
        threadName: options.persistThread ? options.threadName : options.threadName ?? null
      });
      threadId = response.thread.id;
    }
    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
      threadId
    });
    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new CliError("A prompt is required for this Codex run.", {
        class: "validation",
        code: "MISSING_PROMPT",
        retryable: false
      });
    }
    const turnParams = {
      threadId,
      input: buildTurnInput(prompt),
      model: options.model ?? null,
      effort: options.effort ?? null,
      outputSchema: options.outputSchema ?? null
    };
    if (options.collaborationMode) {
      turnParams.collaborationMode = options.collaborationMode;
    }
    if (options.sandboxPolicy) {
      turnParams.sandboxPolicy = options.sandboxPolicy;
    }
    if (typeof options.onTurnStart === "function") {
      try {
        options.onTurnStart({
          threadId,
          turnParams,
          promptLength: prompt.length,
          promptPreview: prompt.slice(0, 200)
        });
      } catch (err) {
        emitProgress(
          options.onProgress,
          `onTurnStart threw: ${err?.message ?? err}`,
          null
        );
      }
    }
    const turnPromise = captureTurn(
      client,
      threadId,
      (signal) => client.request("turn/start", turnParams, { signal }),
      {
        onProgress: options.onProgress,
        idleTimeoutMs: options.idleTimeoutMs ?? null,
        turnTimeoutMs: options.turnTimeoutMs ?? null,
        onActivityMarkerReady(marker) {
          markServerRequestActivity = marker;
        },
        onIdleTimeout: options.onIdleTimeout ?? null,
        onItemCompleted: options.onItemCompleted ?? null
      }
    );
    const turnState = await turnPromise;
    return {
      status: buildResultStatus(turnState),
      threadId,
      turnId: turnState.turnId,
      finalMessage: turnState.lastAgentMessage,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr),
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      commandExecutions: turnState.commandExecutions,
      planDetected: turnState.planDetected,
      planText: turnState.planText
    };
  });
}
async function findLatestTaskThread(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new CliError("Codex CLI is not installed or is missing required runtime support.", {
      class: "dependency_failed",
      code: "CODEX_UNAVAILABLE",
      retryable: false,
      suggestion: "Install Codex with `npm install -g @openai/codex`, then rerun `codex-bridge setup`."
    });
  }
  return withAppServer(cwd, async (client) => {
    const response = await client.request("thread/list", {
      cwd,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: TASK_THREAD_PREFIX
    });
    return response.data.find((thread) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)) ?? null;
  });
}
function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}
function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }
  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}
function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

// src/lib/pending-requests.mjs
import fs6 from "node:fs";
import path6 from "node:path";
var DEFAULT_QUESTION_TIMEOUT_MS = 3e5;
var POLL_INTERVAL_MS = 500;
function writePendingRequest(sessionDir, threadId, entry) {
  const filePath = path6.join(sessionDir, `${threadId}.pending.json`);
  fs6.writeFileSync(filePath, JSON.stringify(entry, null, 2));
  return filePath;
}
function readPendingRequestById(sessionDir, requestId) {
  let files;
  try {
    files = fs6.readdirSync(sessionDir).filter((f) => f.endsWith(".pending.json"));
  } catch {
    return null;
  }
  for (const file of files) {
    try {
      const content = JSON.parse(fs6.readFileSync(path6.join(sessionDir, file), "utf8"));
      if (content.internalId === requestId) {
        return content;
      }
    } catch {
    }
  }
  return null;
}
function clearPendingRequest(sessionDir, threadId) {
  const filePath = path6.join(sessionDir, `${threadId}.pending.json`);
  try {
    fs6.unlinkSync(filePath);
  } catch {
  }
}
function writeResponseFile(sessionDir, threadId, payload) {
  const filePath = path6.join(sessionDir, `${threadId}.response.json`);
  fs6.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}
function readResponseFile(sessionDir, threadId) {
  const filePath = path6.join(sessionDir, `${threadId}.response.json`);
  try {
    const content = JSON.parse(fs6.readFileSync(filePath, "utf8"));
    fs6.unlinkSync(filePath);
    return content;
  } catch {
    return null;
  }
}
function waitForResponse(sessionDir, threadId, timeoutMs = DEFAULT_QUESTION_TIMEOUT_MS, expectedRequestId = null) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const response = readResponseFile(sessionDir, threadId);
      if (response) {
        if (expectedRequestId && response.requestId && response.requestId !== expectedRequestId) {
        } else {
          resolve(response);
          return;
        }
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(check, POLL_INTERVAL_MS);
    };
    check();
  });
}

// src/lib/session-log.mjs
import fs7 from "node:fs";
import path7 from "node:path";
import os3 from "node:os";
import { spawnSync as spawnSync3 } from "node:child_process";
var MAX_UNTRACKED_STAT_BYTES = 256 * 1024;
function resolveSessionDir(configDir, baseDir = process.cwd()) {
  const configured = configDir ?? "~/.codex-bridge/sessions";
  const expanded = configured.replace(/^~/, os3.homedir());
  const dir = path7.isAbsolute(expanded) ? expanded : path7.resolve(baseDir, expanded);
  fs7.mkdirSync(dir, { recursive: true });
  return dir;
}
function initSession(sessionDir, threadId) {
  fs7.mkdirSync(sessionDir, { recursive: true });
  const ndjsonPath = path7.join(sessionDir, `${threadId}.ndjson`);
  const eventsPath = path7.join(sessionDir, `${threadId}.events`);
  fs7.writeFileSync(ndjsonPath, "", { flag: "a" });
  fs7.writeFileSync(eventsPath, "", { flag: "a" });
  return { ndjsonPath, eventsPath, sessionDir, threadId };
}
function writeSessionAliases(session, jobId) {
  if (!session?.sessionDir || !session?.threadId || !jobId) return null;
  const aliasDir = path7.join(session.sessionDir, "by-task");
  fs7.mkdirSync(aliasDir, { recursive: true });
  const payload = {
    schema_version: "1.0",
    jobId,
    threadId: session.threadId,
    eventsPath: session.eventsPath,
    ndjsonPath: session.ndjsonPath,
    diffPath: path7.join(session.sessionDir, `${session.threadId}.diff`)
  };
  const aliasPath = path7.join(aliasDir, `${jobId}.json`);
  fs7.writeFileSync(aliasPath, JSON.stringify(payload, null, 2) + "\n");
  for (const [suffix, target] of Object.entries({
    events: session.eventsPath,
    ndjson: session.ndjsonPath,
    diff: payload.diffPath
  })) {
    const linkPath = path7.join(aliasDir, `${jobId}.${suffix}`);
    try {
      fs7.rmSync(linkPath, { force: true });
      fs7.symlinkSync(target, linkPath);
    } catch {
    }
  }
  return { ...payload, aliasPath };
}
function findSession(sessionDir, threadId) {
  const ndjsonPath = path7.join(sessionDir, `${threadId}.ndjson`);
  const eventsPath = path7.join(sessionDir, `${threadId}.events`);
  if (!fs7.existsSync(ndjsonPath)) {
    return null;
  }
  return { ndjsonPath, eventsPath, sessionDir, threadId };
}
function logNdjson(session, tag, method, data) {
  const entry = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    tag,
    method: method ?? null,
    threadId: session.threadId,
    data: data ?? {}
  };
  try {
    fs7.appendFileSync(session.ndjsonPath, redactText(JSON.stringify(entry), session) + "\n");
  } catch {
  }
}
function logEvent(session, formattedBlock) {
  try {
    fs7.appendFileSync(session.eventsPath, redactText(formattedBlock, session) + "\n");
  } catch {
  }
}
function redactText(text, session) {
  if (!session?.redactSecrets) return text;
  return String(text).replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]").replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]").replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "[REDACTED_SLACK_TOKEN]").replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)["']?[^"',\s}\\]+/gi, "$1[REDACTED]");
}
function writeDiff(session, diffContent) {
  const diffPath = path7.join(session.sessionDir, `${session.threadId}.diff`);
  try {
    fs7.writeFileSync(diffPath, diffContent);
  } catch {
  }
  return diffPath;
}
function writePlan(session, planText) {
  const planPath = path7.join(session.sessionDir, `${session.threadId}.plan.md`);
  try {
    fs7.writeFileSync(planPath, planText);
  } catch {
  }
  return planPath;
}
function writeReview(session, reviewData) {
  const reviewPath = path7.join(session.sessionDir, `${session.threadId}.review.json`);
  try {
    fs7.writeFileSync(reviewPath, JSON.stringify(reviewData, null, 2));
  } catch {
  }
  return reviewPath;
}
function captureGitSnapshot(cwd) {
  const isoTimestamp = (/* @__PURE__ */ new Date()).toISOString();
  try {
    const headResult = spawnSync3("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 1e4 });
    if (headResult.status !== 0 || !headResult.stdout) {
      return { headSha: null, porcelain: null, isoTimestamp };
    }
    const statusResult = spawnSync3("git", ["status", "--porcelain=v1"], { cwd, encoding: "utf8", timeout: 1e4 });
    return {
      headSha: headResult.stdout.trim(),
      porcelain: statusResult.status === 0 ? statusResult.stdout ?? "" : "",
      isoTimestamp
    };
  } catch {
    return { headSha: null, porcelain: null, isoTimestamp };
  }
}
function diffGitSnapshot(cwd, snapshot) {
  if (!snapshot || !snapshot.headSha) {
    return { commits: [], currentHeadSha: null, lastOkHeadSha: null, dirtyFiles: [], launchedAtIso: snapshot?.isoTimestamp ?? null };
  }
  let commits = [];
  let currentHeadSha = null;
  let dirtyFiles = [];
  try {
    const logResult = spawnSync3(
      "git",
      ["log", "--format=%h", `${snapshot.headSha}..HEAD`],
      { cwd, encoding: "utf8", timeout: 1e4 }
    );
    if (logResult.status === 0 && logResult.stdout) {
      commits = logResult.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    }
    const headResult = spawnSync3("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 1e4 });
    if (headResult.status === 0 && headResult.stdout) {
      currentHeadSha = headResult.stdout.trim();
    }
    const statusResult = spawnSync3("git", ["status", "--porcelain=v1"], { cwd, encoding: "utf8", timeout: 1e4 });
    if (statusResult.status === 0 && statusResult.stdout) {
      dirtyFiles = statusResult.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    }
  } catch {
  }
  return {
    commits,
    currentHeadSha,
    lastOkHeadSha: snapshot.headSha,
    dirtyFiles,
    launchedAtIso: snapshot.isoTimestamp ?? null
  };
}
function captureGitDiff(cwd, session, options = {}) {
  const baseRef = typeof options.baseRef === "string" && options.baseRef.trim() ? options.baseRef.trim() : "HEAD";
  const numstatResult = spawnSync3("git", ["diff", "--numstat", baseRef], { cwd, encoding: "utf8", timeout: 1e4 });
  const fullResult = spawnSync3("git", ["diff", baseRef], { cwd, encoding: "utf8", timeout: 1e4 });
  const untrackedFiles = getUntrackedFileStats(cwd);
  const diffContent = appendUntrackedDiffMarkers(fullResult.stdout || "", untrackedFiles, baseRef);
  const diffPath = writeDiff(session, diffContent);
  const numstatOutput = numstatResult.stdout || "";
  const files = [...parseGitNumstat(numstatOutput), ...untrackedFiles];
  const summary = summarizeNumstat(files);
  return { diffStat: summary, files: files.map(formatFileStat), diffPath };
}
function getUntrackedFileStats(cwd) {
  try {
    const result = spawnSync3(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd, encoding: "utf8", timeout: 1e4 }
    );
    if (result.status !== 0 || !result.stdout) {
      return [];
    }
    return result.stdout.split("\0").filter(Boolean).map((fileName) => buildUntrackedFileStat(cwd, fileName)).filter(Boolean);
  } catch {
    return [];
  }
}
function buildUntrackedFileStat(cwd, fileName) {
  const absolutePath = resolveInsideCwd(cwd, fileName);
  if (!absolutePath) {
    return null;
  }
  let sizeBytes = null;
  let adds = 0;
  try {
    const stat = fs7.lstatSync(absolutePath);
    sizeBytes = stat.size;
    if (stat.isFile() && stat.size <= MAX_UNTRACKED_STAT_BYTES) {
      const content = fs7.readFileSync(absolutePath);
      if (!looksBinary(content)) {
        adds = countTextLines(content);
      }
    }
  } catch {
  }
  return {
    fileName: displayGitPath(fileName),
    adds,
    dels: 0,
    status: "A",
    untracked: true,
    sizeBytes
  };
}
function resolveInsideCwd(cwd, fileName) {
  const root = path7.resolve(cwd);
  const absolutePath = path7.resolve(root, fileName);
  if (absolutePath !== root && !absolutePath.startsWith(root + path7.sep)) {
    return null;
  }
  return absolutePath;
}
function looksBinary(content) {
  return content.subarray(0, Math.min(content.length, 8e3)).includes(0);
}
function countTextLines(content) {
  if (content.length === 0) {
    return 0;
  }
  const text = content.toString("utf8");
  const newlineCount = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlineCount : newlineCount + 1;
}
function displayGitPath(fileName) {
  return fileName.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}
function appendUntrackedDiffMarkers(diffContent, untrackedFiles, baseRef = "HEAD") {
  if (untrackedFiles.length === 0) {
    return diffContent;
  }
  const marker = formatUntrackedDiffMarkers(untrackedFiles, baseRef);
  if (!diffContent) {
    return marker;
  }
  return `${diffContent}${diffContent.endsWith("\n") ? "" : "\n"}${marker}`;
}
function formatUntrackedDiffMarkers(untrackedFiles, baseRef = "HEAD") {
  const lines = [`# Untracked files omitted from git diff ${baseRef}:`];
  for (const file of untrackedFiles) {
    const size = Number.isFinite(file.sizeBytes) ? `, ${file.sizeBytes} bytes` : "";
    lines.push(`diff --git a/${file.fileName} b/${file.fileName}`);
    lines.push("new file mode 100644");
    lines.push("--- /dev/null");
    lines.push(`+++ b/${file.fileName}`);
    lines.push("@@ untracked file @@");
    lines.push(`+<untracked file: ${file.fileName}${size}; content omitted from session diff>`);
  }
  return `${lines.join("\n")}
`;
}
function parseGitNumstat(output) {
  const files = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)/);
    if (match) {
      const adds = match[1] === "-" ? 0 : parseInt(match[1]);
      const dels = match[2] === "-" ? 0 : parseInt(match[2]);
      const fileName = match[3].trim();
      files.push({ fileName, adds, dels });
    }
  }
  return files;
}
function formatFileStat({ fileName, adds, dels, status = null }) {
  const prefix = fileName.includes("=>") ? "R" : "M";
  if (status) {
    return `${status} ${fileName} (+${adds} -${dels})`;
  }
  return `${prefix} ${fileName} (+${adds} -${dels})`;
}
function summarizeNumstat(files) {
  const totalAdds = files.reduce((sum, f) => sum + f.adds, 0);
  const totalDels = files.reduce((sum, f) => sum + f.dels, 0);
  return `${files.length} files | +${totalAdds} -${totalDels}`;
}
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
function formatCwdFlag(cwd) {
  return cwd ? ` --cwd ${shellQuote(cwd)}` : "";
}
function commandPrefix(scriptPath, subcommand, cwd = null) {
  return `node ${shellQuote(scriptPath)} ${subcommand}${formatCwdFlag(cwd)}`;
}
function resultActionLine(scriptPath, jobId, indent = "    detail: ", cwd = null) {
  return jobId ? `${indent}${commandPrefix(scriptPath, "result", cwd)} ${jobId}` : `${indent}${commandPrefix(scriptPath, "result", cwd)}    # rerun with the specific job id from status`;
}
function cancelActionLine(scriptPath, jobId, indent = "    cancel: ", cwd = null) {
  return jobId ? `${indent}${commandPrefix(scriptPath, "cancel", cwd)} ${jobId}` : `${indent}${commandPrefix(scriptPath, "cancel", cwd)}    # rerun with the specific job id from status`;
}
function jobCommandCwd(cwd, stateCwd) {
  return stateCwd ?? cwd;
}
function formatDoneEvent(session, { duration, diffStat, files, config, diffPath, scriptPath, jobId = null, cwd = null, stateCwd = null }) {
  const jobCwd = jobCommandCwd(cwd, stateCwd);
  const lines = [
    `[DONE] ${session.threadId} completed in ${duration}s | ${diffStat}`,
    `  config: model=${config.model} effort=${config.effort} mode=${config.modeFlow || "default"}`,
    `  diff: ${diffPath}`
  ];
  if (files && files.length > 0) {
    lines.push("  files:");
    for (const f of files.slice(0, 20)) {
      lines.push(`    ${f}`);
    }
  }
  lines.push("  actions:");
  lines.push(`    review: ${commandPrefix(scriptPath, "review", cwd)} --scope working-tree`);
  lines.push(`    revise: ${commandPrefix(scriptPath, "send", cwd)} ${session.threadId} "<message>"`);
  lines.push(resultActionLine(scriptPath, jobId, "    detail: ", jobCwd));
  return lines.join("\n");
}
function buildActionsBlock({ origin, errorCode, scriptPath, threadId, jobId, failingStage, cwd = null, stateCwd = null }) {
  const lines = ["  actions:"];
  const see = (anchor) => `    see: skill/references/error-recovery.md#${anchor}`;
  const jobCwd = jobCommandCwd(cwd, stateCwd);
  if (origin === "upstream:response-chain-lost") {
    lines.push(
      `    new-task: ${commandPrefix(scriptPath, "task", cwd)} --json --mode default "<prompt rebased on last good sha>"    # do NOT send on the dead thread`,
      `    inspect:  git log --oneline <launch-iso>..HEAD    # audit what committed before the chain loss`,
      resultActionLine(scriptPath, jobId, "    log:     ", jobCwd),
      see("response-chain-lost")
    );
    return lines;
  }
  if (origin === "upstream:auth") {
    lines.push(
      "    reauth:  run `codex login` (or reauth your upstream proxy if one is in the path)",
      "    do-not:  retry the same thread \u2014 auth is deterministic; the 401 will repeat",
      resultActionLine(scriptPath, jobId, "    log:    ", jobCwd),
      cancelActionLine(scriptPath, jobId, "    cancel: ", jobCwd),
      see("upstream-auth-401")
    );
    return lines;
  }
  if (origin === "upstream:invalid-request") {
    lines.push(
      `    inspect: ${commandPrefix(scriptPath, "result", jobCwd)} ${jobId ?? threadId}    # read the upstream error.message; rebuild the prompt`,
      `    new-task: ${commandPrefix(scriptPath, "task", cwd)} --json --mode default "<fixed prompt>"`,
      see("upstream-invalid-request")
    );
    return lines;
  }
  if (origin === "idle") {
    lines.push(
      `    relaunch: ${commandPrefix(scriptPath, "task", cwd)} --idle-timeout-ms 900000 --turn-default-ms 3600000 "<same prompt>"`,
      resultActionLine(scriptPath, jobId, "    log:   ", jobCwd),
      cancelActionLine(scriptPath, jobId, "    cancel: ", jobCwd),
      see("idle-timeout")
    );
    return lines;
  }
  if (origin === "upstream:compact-proxy") {
    lines.push(
      "    narrow:  split the task, or trim required-reads before resending (the upstream compact proxy ran out of budget mid-turn)",
      `    resume:  ${commandPrefix(scriptPath, "send", cwd)} ${threadId} "<shorter follow-up>"`,
      resultActionLine(scriptPath, jobId, "    log:   ", jobCwd),
      see("compact-proxy-502")
    );
    return lines;
  }
  if (origin === "upstream:transport") {
    lines.push(
      `    retry:   ${commandPrefix(scriptPath, "send", cwd)} ${threadId} "<same prompt>"    # workspace unchanged; prior reasoning is lost`,
      resultActionLine(scriptPath, jobId, "    log:   ", jobCwd),
      cancelActionLine(scriptPath, jobId, "    cancel: ", jobCwd),
      see("upstream-transport-drop")
    );
    return lines;
  }
  if (typeof origin === "string" && origin.startsWith("pipeline:")) {
    const stageLine = failingStage ? ` (failing stage: ${failingStage})` : "";
    lines.push(
      `    inspect:     ${commandPrefix(scriptPath, "result", jobCwd)} ${jobId ?? threadId}    # main task may already be done${stageLine}`,
      `    rerun-review: ${commandPrefix(scriptPath, "review", cwd)} --scope working-tree`,
      see("pipeline-stage-timeout")
    );
    return lines;
  }
  if (typeof origin === "string" && origin.startsWith("bridge")) {
    lines.push(
      resultActionLine(scriptPath, jobId, "    log:    ", jobCwd),
      cancelActionLine(scriptPath, jobId, "    cancel: ", jobCwd),
      see("bridge-unhandled-exit")
    );
    return lines;
  }
  if (errorCode === "Unauthorized") {
    lines.push(
      "    login:  codex login",
      `    retry:  ${commandPrefix(scriptPath, "send", cwd)} ${threadId} "<revised prompt>"`,
      see("unauthorized")
    );
    return lines;
  }
  if (errorCode === "ContextWindowExceeded") {
    lines.push(
      `    new:    ${commandPrefix(scriptPath, "task", cwd)} "<shorter prompt>"    # context window full; do not retry the same turn`,
      resultActionLine(scriptPath, jobId, "    log:   ", jobCwd),
      see("context-window-exceeded")
    );
    return lines;
  }
  if (errorCode === "SandboxError") {
    lines.push(
      "    policy: set config.sandbox_policy: danger-full-access (or re-run with --write)",
      `    retry:  ${commandPrefix(scriptPath, "send", cwd)} ${threadId} "<revised prompt>"`,
      see("sandbox-denial")
    );
    return lines;
  }
  lines.push(
    `    retry: ${commandPrefix(scriptPath, "send", cwd)} ${threadId} "<revised prompt>"`,
    resultActionLine(scriptPath, jobId, "    log:   ", jobCwd),
    cancelActionLine(scriptPath, jobId, "    cancel: ", jobCwd)
  );
  return lines;
}
function formatErrorEvent(session, { errorCode, message, phase, origin = "turn", failingStage = null, scriptPath, jobId = null, upstreamRequestId = null, cwd = null, stateCwd = null }) {
  const lines = [
    `[ERROR] ${session.threadId} failed | ${errorCode}`,
    `  ${message}`,
    `  origin: ${origin}`
  ];
  if (failingStage) {
    lines.push(`  failing_stage: ${failingStage}`);
  }
  if (upstreamRequestId) {
    lines.push(`  upstream_request_id: ${upstreamRequestId}`);
  }
  lines.push(`  phase: ${phase || "unknown"}`);
  lines.push(...buildActionsBlock({
    origin,
    errorCode,
    scriptPath,
    threadId: session.threadId,
    jobId,
    failingStage,
    cwd,
    stateCwd
  }));
  return lines.join("\n");
}
function formatPartialEvent(session, { commits = [], currentHeadSha = null, lastOkHeadSha = null, launchedAtIso = null, dirtyFiles = [], scriptPath = null, jobId = null, cwd = null, stateCwd = null }) {
  const jobCwd = jobCommandCwd(cwd, stateCwd);
  const lines = [`[PARTIAL] ${session.threadId} commits=[${commits.join(",")}]`];
  if (currentHeadSha) lines.push(`  current_head: ${currentHeadSha}`);
  if (lastOkHeadSha) lines.push(`  last_ok_head: ${lastOkHeadSha}`);
  if (launchedAtIso) lines.push(`  launched_at: ${launchedAtIso}`);
  if (dirtyFiles && dirtyFiles.length > 0) {
    lines.push("  dirty:");
    for (const f of dirtyFiles.slice(0, 20)) {
      lines.push(`    - ${f}`);
    }
    if (dirtyFiles.length > 20) lines.push(`    ... and ${dirtyFiles.length - 20} more`);
  }
  if (scriptPath && jobId) {
    lines.push(`  inspect: ${commandPrefix(scriptPath, "result", jobCwd)} ${jobId}`);
  }
  return lines.join("\n");
}
function formatRetryingEvent(session, { attempt, maxAttempts, backoffMs, origin, strategy, errorCode, reason = null }) {
  const lines = [
    `[RETRYING] ${session.threadId} attempt ${attempt}/${maxAttempts} | origin=${origin} | strategy=${strategy} | backoff=${backoffMs}ms`
  ];
  if (errorCode) lines.push(`  last_error: ${errorCode}`);
  if (reason) lines.push(`  reason: ${reason}`);
  return lines.join("\n");
}
function formatHandoffEvent(session, { reason, origin, errorCode, upstreamRequestId, session: sessionInfo, artifacts, partial, prompt, retries = [], scriptPath, cwd = null, stateCwd = null }) {
  const jobCwd = jobCommandCwd(cwd, stateCwd);
  const lines = [
    `[HANDOFF] ${session.threadId} reason=${reason} | origin=${origin}${errorCode ? ` | code=${errorCode}` : ""}`
  ];
  if (upstreamRequestId) lines.push(`  upstream_request_id: ${upstreamRequestId}`);
  if (sessionInfo?.jobId) lines.push(`  job_id: ${sessionInfo.jobId}`);
  if (sessionInfo?.threadId) lines.push(`  thread_id: ${sessionInfo.threadId}`);
  if (artifacts) {
    lines.push("  artifacts:");
    if (artifacts.eventsPath) lines.push(`    events: ${artifacts.eventsPath}`);
    if (artifacts.workerErrPath) lines.push(`    worker_err: ${artifacts.workerErrPath}`);
    if (artifacts.diffPath) lines.push(`    diff: ${artifacts.diffPath}`);
    if (artifacts.planPath) lines.push(`    plan: ${artifacts.planPath}`);
    if (artifacts.reviewPath) lines.push(`    review: ${artifacts.reviewPath}`);
  }
  if (partial && Array.isArray(partial.commits) && partial.commits.length > 0) {
    lines.push(`  partial: commits=[${partial.commits.join(",")}] head=${partial.currentHeadSha ?? "?"} since=${partial.launchedAtIso ?? "?"}`);
  }
  if (prompt?.promptFilePath) {
    lines.push(`  prompt_file: ${prompt.promptFilePath}`);
  }
  if (retries && retries.length > 0) {
    lines.push(`  retries: ${retries.length} attempts logged`);
  }
  lines.push("  next:");
  if (scriptPath && sessionInfo?.jobId) {
    lines.push(`    read:     ${commandPrefix(scriptPath, "result", jobCwd)} ${sessionInfo.jobId} --json    # full handoff envelope under .error.handoff`);
  }
  if (partial?.lastOkHeadSha || partial?.currentHeadSha) {
    lines.push(`    audit:    git log --oneline ${partial.lastOkHeadSha ?? partial.currentHeadSha}..HEAD`);
  }
  lines.push(`    relaunch: ${commandPrefix(scriptPath, "task", cwd)} --json --mode default --prompt-file <rebased prompt>    # seed with last commit + remaining scope`);
  lines.push("    see: skill/references/orchestration-flows.md#recovering-from-upstream-state-loss");
  return lines.join("\n");
}
function formatIncompleteEvent(session, { diffStat, diffPath, verdict, findingCount, failingStage = null, missingItems, scriptPath, jobId = null, cwd = null, stateCwd = null }) {
  const jobCwd = jobCommandCwd(cwd, stateCwd);
  const lines = [
    `[INCOMPLETE] ${session.threadId} | ${diffStat}`,
    `  diff: ${diffPath}`,
    `  review: ${verdict} (${findingCount} findings)`
  ];
  if (failingStage) {
    lines.push(`  failing_stage: ${failingStage}`);
  }
  if (missingItems && missingItems.length > 0) {
    lines.push("  missing:");
    for (const item of missingItems) {
      lines.push(`    - ${item}`);
    }
  }
  lines.push("  actions:");
  lines.push(`    fix:  ${commandPrefix(scriptPath, "send", cwd)} ${session.threadId} "Complete the missing items"`);
  lines.push(`    new:  ${commandPrefix(scriptPath, "task", cwd)} --write "..."`);
  lines.push(resultActionLine(scriptPath, jobId, "    detail: ", jobCwd));
  return lines.join("\n");
}
function formatQuestionEvent(session, { requestId, questions, scriptPath, cwd = null }) {
  const lines = [`[QUESTION] ${session.threadId} ${requestId}`];
  for (const q of questions || []) {
    lines.push(`  "${q.question}"`);
    if (q.options && q.options.length > 0) {
      const letters = "abcdefghijklmnopqrstuvwxyz";
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        lines.push(`  (${letters[i]}) ${opt.label} \u2014 ${opt.description}`);
      }
      if (q.isOther) {
        lines.push("  [other: custom answer allowed]");
      }
    }
    lines.push("respond:");
    if (q.options && q.options.length > 0) {
      for (const opt of q.options) {
        lines.push(`  ${commandPrefix(scriptPath, "respond", cwd)} ${requestId} --question-id ${q.id} --answer ${shellQuote(opt.label)}`);
      }
    } else {
      lines.push(`  ${commandPrefix(scriptPath, "respond", cwd)} ${requestId} --question-id ${q.id} --answer "<answer>"`);
    }
  }
  return lines.join("\n");
}
function formatPlanEvent(session, { turnId, planTitle, steps, planPath, scriptPath, cwd = null }) {
  const lines = [`[PLAN] ${session.threadId} ${turnId}`];
  lines.push(`  ${planTitle || "(untitled plan)"}`);
  if (steps && steps.length > 0) {
    for (const step of steps.slice(0, 10)) {
      lines.push(`  ${step.number ?? "-"}. [ ] ${step.text}`);
    }
    if (steps.length > 10) {
      lines.push(`  ... and ${steps.length - 10} more steps`);
    }
  }
  lines.push(`  plan: ${planPath}`);
  lines.push("actions:");
  lines.push(`  approve: ${commandPrefix(scriptPath, "send", cwd)} ${session.threadId} --mode default "Implement the plan."`);
  lines.push(`  revise:  ${commandPrefix(scriptPath, "send", cwd)} ${session.threadId} "<revision instructions>"`);
  return lines.join("\n");
}
function formatConfirmedEvent(session, { requestId }) {
  return `[CONFIRMED] ${session.threadId} ${requestId} | codex resumed`;
}
function formatHeartbeatEvent(session, { elapsedMs, phase, lastItem, lastItemAgeMs, pid, jobId = null, budgetRemainingMs = null, scriptPath = null, cwd = null, assistantPreview = null }) {
  const lines = [
    `[HEARTBEAT] ${session.threadId} t=${fmtSeconds(elapsedMs)} | phase=${phase ?? "?"} | pid=${pid ?? "?"}`
  ];
  const itemLine = lastItem ? `  lastItem: ${lastItem}${Number.isFinite(lastItemAgeMs) ? ` (age ${fmtSeconds(lastItemAgeMs)})` : ""}` : "  lastItem: (none yet)";
  lines.push(itemLine);
  if (assistantPreview) {
    lines.push(`  assistant: ${compactPreview(assistantPreview, 220)}`);
  }
  if (Number.isFinite(budgetRemainingMs) && budgetRemainingMs > 0) {
    lines.push(`  budget: ${fmtSeconds(budgetRemainingMs)} remaining`);
  }
  if (scriptPath && jobId) {
    lines.push(`  tail: ${formatTailCommand({ scriptPath, jobId, cwd })}`);
  }
  return lines.join("\n");
}
function compactPreview(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}
function fmtSeconds(ms) {
  const s = Math.max(0, Math.round(ms / 1e3));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m${String(rem).padStart(2, "0")}s`;
}
var TERMINAL_TAGS = Object.freeze(["DONE", "ERROR", "INCOMPLETE", "PLAN"]);
var TERMINAL_TAG_REGEX = /^\[(DONE|ERROR|INCOMPLETE|PLAN)\]/m;
var DEFAULT_MONITOR_EXCLUDE = Object.freeze(["HEARTBEAT"]);
function formatTailCommand({ scriptPath, jobId, timeoutMs = 18e5, exclude = DEFAULT_MONITOR_EXCLUDE, cwd = null }) {
  const excludeClause = exclude && exclude.length > 0 ? ` --exclude ${Array.from(exclude).join(",")}` : "";
  return `${commandPrefix(scriptPath, "events", cwd)} ${jobId} --follow${excludeClause} --timeout-ms ${timeoutMs}`;
}
function formatCheckpointEvent(session, {
  elapsedMs,
  phase,
  intervalMs,
  pid,
  jobId = null,
  lastAssistantMessage = null,
  tools = [],
  commits = [],
  diffStat = null,
  filesChangedSinceStart = null,
  scriptPath = null,
  cwd = null
}) {
  const head = `[CHECKPOINT] ${session.threadId} t=${fmtSeconds(elapsedMs)} | phase=${phase ?? "?"} | interval=${fmtSeconds(intervalMs)} | pid=${pid ?? "?"}`;
  const lines = [head];
  if (lastAssistantMessage) {
    const MAX_ASSISTANT_MESSAGE_CHARS = 8e3;
    const raw = String(lastAssistantMessage).trim();
    if (raw) {
      const truncated = raw.length > MAX_ASSISTANT_MESSAGE_CHARS ? raw.slice(0, MAX_ASSISTANT_MESSAGE_CHARS) + `
\u2026 (truncated, ${raw.length - MAX_ASSISTANT_MESSAGE_CHARS} more chars)` : raw;
      lines.push("  assistant:");
      for (const line of truncated.split("\n")) {
        lines.push(`    ${line}`);
      }
    } else {
      lines.push("  assistant: (no new assistant message this interval)");
    }
  } else {
    lines.push("  assistant: (no new assistant message this interval)");
  }
  lines.push(`  tools (${tools.length}):`);
  if (tools.length === 0) {
    lines.push("    (none)");
  } else {
    for (const t of tools) {
      lines.push(`    - ${t.type}${t.summary ? `: ${t.summary}` : ""}`);
    }
  }
  if (commits && commits.length > 0) {
    lines.push(`  commits (${commits.length}):`);
    for (const c of commits) {
      lines.push(`    - ${c.sha} ${c.subject}`);
    }
  }
  if (diffStat) {
    lines.push(`  diff-since-last-checkpoint: ${diffStat}`);
  }
  if (filesChangedSinceStart) {
    lines.push(`  files-changed-since-turn-start: ${filesChangedSinceStart}`);
  }
  if (scriptPath && jobId) {
    lines.push(`  tail: ${formatTailCommand({ scriptPath, jobId, cwd })}`);
  }
  return lines.join("\n");
}
function formatDirectivesEvent(session, {
  mode,
  effort,
  sandbox,
  approval = null,
  quiet = false,
  skipMetaSkills = false,
  pipelineEnabled = [],
  model = null
}) {
  const parts = [
    `mode=${mode}`,
    `effort=${effort}`,
    `sandbox=${sandbox}`
  ];
  if (approval) parts.push(`approval=${approval}`);
  parts.push(`quiet=${quiet ? "true" : "false"}`);
  parts.push(`skip_meta_skills=${skipMetaSkills ? "true" : "false"}`);
  parts.push(`pipeline=${Array.isArray(pipelineEnabled) && pipelineEnabled.length > 0 ? pipelineEnabled.join(",") : "none"}`);
  if (model) parts.push(`model=${model}`);
  return `[DIRECTIVES] ${session.threadId} | ${parts.join(" | ")}`;
}
function formatPipelineEvent(session, { stage, suffix, detail }) {
  const head = suffix ? `PIPELINE:${stage}:${suffix}` : `PIPELINE:${stage}`;
  const ts = (/* @__PURE__ */ new Date()).toISOString().slice(11, 19);
  return detail ? `[${head}] ${ts} ${detail}` : `[${head}] ${ts}`;
}
function formatWarningEvent(session, { reason, family, threshold, sampleCommand, turnInterrupted }) {
  const lines = [
    `[WARNING] ${session.threadId} ${reason}`,
    `  family: ${family}`,
    `  threshold: ${threshold} consecutive failures`
  ];
  if (sampleCommand) lines.push(`  sample: ${sampleCommand.slice(0, 120)}`);
  lines.push(`  turnInterrupted: ${turnInterrupted ? "yes" : "no"}`);
  return lines.join("\n");
}

// src/lib/job-control.mjs
import fs9 from "node:fs";

// src/lib/tracked-jobs.mjs
import fs8 from "node:fs";
import process7 from "node:process";
var SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
function nowIso2() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }
  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}
function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs8.appendFileSync(logFile, `[${nowIso2()}] ${normalized}
`, "utf8");
}
function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs8.appendFileSync(logFile, `
[${nowIso2()}] ${title}
${String(body).trimEnd()}
`, "utf8");
}
function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs8.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}
function createJobRecord(base, options = {}) {
  const env = options.env ?? process7.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso2(),
    ...sessionId ? { sessionId } : {}
  };
}
function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;
    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }
    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }
    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }
    if (!changed) {
      return;
    }
    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs8.existsSync(jobFile)) {
      return;
    }
    let storedJob;
    try {
      storedJob = readJobFile(jobFile);
    } catch (error) {
      if (error?.code !== "JOB_DETAIL_CORRUPT") {
        throw error;
      }
      storedJob = listJobs(workspaceRoot, { raw: true }).find((job) => job.id === jobId) ?? {
        id: jobId,
        status: "running",
        phase: "running"
      };
      patch.detailRecovery = {
        code: "JOB_DETAIL_CORRUPT",
        jobFile,
        corruptPath: error.corruptPath ?? null
      };
    }
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
    upsertJob(workspaceRoot, patch);
  };
}
function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }
  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process7.stderr.write(`[codex] ${stderrMessage}
`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}
function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs8.existsSync(jobFile)) {
    return null;
  }
  try {
    return readJobFile(jobFile);
  } catch (error) {
    if (error?.code === "JOB_DETAIL_CORRUPT") {
      return listJobs(workspaceRoot, { raw: true }).find((job) => job.id === jobId) ?? null;
    }
    throw error;
  }
}
async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso2(),
    phase: "starting",
    pid: process7.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);
  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso2();
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso2();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    throw error;
  }
}

// src/lib/job-control.mjs
var DEFAULT_MAX_STATUS_JOBS = 8;
var DEFAULT_MAX_PROGRESS_LINES = 4;
function sortJobsNewestFirst2(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}
function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}
function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}
function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "task";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "task";
  }
  return "job";
}
function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}
function isProgressBlockTitle(line) {
  return ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) || /^Subagent .+ message$/.test(line) || /^Subagent .+ reasoning summary$/.test(line);
}
function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs9.existsSync(logFile)) {
    return [];
  }
  const lines = fs9.readFileSync(logFile, "utf8").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).filter((line) => line.startsWith("[")).map(stripLogPrefix).filter((line) => line && !isProgressBlockTitle(line));
  return lines.slice(-maxLines);
}
function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }
  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }
  const totalSeconds = Math.max(0, Math.round((end - start) / 1e3));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
function looksLikeVerificationCommand2(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}
function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }
  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand2(line) ? "verifying" : job.jobClass === "review" ? "reviewing" : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand2(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }
  return job.jobClass === "review" ? "reviewing" : "running";
}
function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview: job.status === "queued" || job.status === "running" || job.status === "failed" ? readJobProgressPreview(job.logFile, maxProgressLines) : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration: job.status === "completed" || job.status === "failed" || job.status === "cancelled" ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt) : null
  };
  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}
function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs9.existsSync(jobFile)) {
    return null;
  }
  try {
    return readJobFile(jobFile);
  } catch (error) {
    if (error?.code === "JOB_DETAIL_CORRUPT") {
      throw new CliError(`Job detail for ${jobId} is corrupt.`, {
        class: "conflict",
        code: "JOB_DETAIL_CORRUPT",
        retryable: false,
        suggestion: "Run `status` to inspect the state index; relaunch the task if the detail artifact is required.",
        details: {
          jobId,
          jobFile,
          corruptPath: error.corruptPath ?? null,
          cause: error.cause?.message ?? null
        },
        nextAction: {
          kind: "inspect-status",
          command: `status ${jobId}`,
          description: "Inspect the state-index record that survived the corrupt detail file."
        }
      });
    }
    throw error;
  }
}
function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }
  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }
  const byThread = filtered.find((job) => job.threadId && job.threadId === reference);
  if (byThread) {
    return byThread;
  }
  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new CliError(`Job reference "${reference}" is ambiguous. Use a longer job id.`, {
      class: "validation",
      code: "AMBIGUOUS_JOB_REFERENCE",
      retryable: false
    });
  }
  throw new CliError(`No job found for "${reference}".`, {
    class: "not_found",
    code: "JOB_NOT_FOUND",
    retryable: false,
    suggestion: "Run `status` to list known jobs."
  });
}
function isResultTerminalJob(job) {
  return job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "orphaned";
}
function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const allJobs = listJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst2(options.all ? allJobs : filterJobsForCurrentSession(allJobs, options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const running = jobs.filter((job) => job.status === "queued" || job.status === "running").map((job) => enrichJob(job, { maxProgressLines }));
  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;
  const recent = (options.all ? jobs : jobs.slice(0, maxJobs)).filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id).map((job) => enrichJob(job, { maxProgressLines }));
  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}
function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst2(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new CliError(`No job found for "${reference}".`, {
      class: "not_found",
      code: "JOB_NOT_FOUND",
      retryable: false,
      suggestion: "Run `status` to inspect known jobs."
    });
  }
  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}
function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst2(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  if (reference) {
    const activeMatch = jobs.find(
      (job) => (job.status === "queued" || job.status === "running") && (job.id === reference || job.id.startsWith(reference) || job.threadId === reference)
    );
    if (activeMatch) {
      throw new CliError(`Job ${activeMatch.id} is still ${activeMatch.status}.`, {
        class: "conflict",
        code: "JOB_NOT_FINISHED",
        retryable: false,
        suggestion: `Check \`status ${activeMatch.id} --wait\` and try again once it finishes.`
      });
    }
  }
  const selected = matchJobReference(
    jobs,
    reference,
    isResultTerminalJob
  );
  if (selected) {
    return { workspaceRoot, job: selected };
  }
  if (reference) {
    throw new CliError(`No finished job found for "${reference}".`, {
      class: "not_found",
      code: "JOB_NOT_FOUND",
      retryable: false,
      suggestion: "Run `status` to inspect active jobs."
    });
  }
  throw new CliError("No finished Codex jobs found for this repository yet.", {
    class: "not_found",
    code: "NO_FINISHED_JOBS",
    retryable: false
  });
}
function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst2(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");
  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new CliError(`No active job found for "${reference}".`, {
        class: "not_found",
        code: "ACTIVE_JOB_NOT_FOUND",
        retryable: false
      });
    }
    return { workspaceRoot, job: selected };
  }
  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);
  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new CliError("Multiple Codex jobs are active.", {
      class: "validation",
      code: "AMBIGUOUS_CANCEL",
      retryable: false,
      suggestion: "Pass a job id to `cancel`."
    });
  }
  if (getCurrentSessionId(options)) {
    throw new CliError("No active Codex jobs to cancel for this session.", {
      class: "not_found",
      code: "NO_ACTIVE_JOBS",
      retryable: false
    });
  }
  throw new CliError("No active Codex jobs to cancel.", {
    class: "not_found",
    code: "NO_ACTIVE_JOBS",
    retryable: false
  });
}

// src/lib/config.mjs
import fs10 from "node:fs";
import path8 from "node:path";
import os4 from "node:os";

// node_modules/js-yaml/dist/js-yaml.mjs
function isNothing(subject) {
  return typeof subject === "undefined" || subject === null;
}
function isObject(subject) {
  return typeof subject === "object" && subject !== null;
}
function toArray(sequence) {
  if (Array.isArray(sequence)) return sequence;
  else if (isNothing(sequence)) return [];
  return [sequence];
}
function extend(target, source) {
  var index, length, key, sourceKeys;
  if (source) {
    sourceKeys = Object.keys(source);
    for (index = 0, length = sourceKeys.length; index < length; index += 1) {
      key = sourceKeys[index];
      target[key] = source[key];
    }
  }
  return target;
}
function repeat(string, count) {
  var result = "", cycle;
  for (cycle = 0; cycle < count; cycle += 1) {
    result += string;
  }
  return result;
}
function isNegativeZero(number) {
  return number === 0 && Number.NEGATIVE_INFINITY === 1 / number;
}
var isNothing_1 = isNothing;
var isObject_1 = isObject;
var toArray_1 = toArray;
var repeat_1 = repeat;
var isNegativeZero_1 = isNegativeZero;
var extend_1 = extend;
var common = {
  isNothing: isNothing_1,
  isObject: isObject_1,
  toArray: toArray_1,
  repeat: repeat_1,
  isNegativeZero: isNegativeZero_1,
  extend: extend_1
};
function formatError(exception2, compact) {
  var where = "", message = exception2.reason || "(unknown reason)";
  if (!exception2.mark) return message;
  if (exception2.mark.name) {
    where += 'in "' + exception2.mark.name + '" ';
  }
  where += "(" + (exception2.mark.line + 1) + ":" + (exception2.mark.column + 1) + ")";
  if (!compact && exception2.mark.snippet) {
    where += "\n\n" + exception2.mark.snippet;
  }
  return message + " " + where;
}
function YAMLException$1(reason, mark) {
  Error.call(this);
  this.name = "YAMLException";
  this.reason = reason;
  this.mark = mark;
  this.message = formatError(this, false);
  if (Error.captureStackTrace) {
    Error.captureStackTrace(this, this.constructor);
  } else {
    this.stack = new Error().stack || "";
  }
}
YAMLException$1.prototype = Object.create(Error.prototype);
YAMLException$1.prototype.constructor = YAMLException$1;
YAMLException$1.prototype.toString = function toString(compact) {
  return this.name + ": " + formatError(this, compact);
};
var exception = YAMLException$1;
function getLine(buffer, lineStart, lineEnd, position, maxLineLength) {
  var head = "";
  var tail = "";
  var maxHalfLength = Math.floor(maxLineLength / 2) - 1;
  if (position - lineStart > maxHalfLength) {
    head = " ... ";
    lineStart = position - maxHalfLength + head.length;
  }
  if (lineEnd - position > maxHalfLength) {
    tail = " ...";
    lineEnd = position + maxHalfLength - tail.length;
  }
  return {
    str: head + buffer.slice(lineStart, lineEnd).replace(/\t/g, "\u2192") + tail,
    pos: position - lineStart + head.length
    // relative position
  };
}
function padStart(string, max) {
  return common.repeat(" ", max - string.length) + string;
}
function makeSnippet(mark, options) {
  options = Object.create(options || null);
  if (!mark.buffer) return null;
  if (!options.maxLength) options.maxLength = 79;
  if (typeof options.indent !== "number") options.indent = 1;
  if (typeof options.linesBefore !== "number") options.linesBefore = 3;
  if (typeof options.linesAfter !== "number") options.linesAfter = 2;
  var re = /\r?\n|\r|\0/g;
  var lineStarts = [0];
  var lineEnds = [];
  var match;
  var foundLineNo = -1;
  while (match = re.exec(mark.buffer)) {
    lineEnds.push(match.index);
    lineStarts.push(match.index + match[0].length);
    if (mark.position <= match.index && foundLineNo < 0) {
      foundLineNo = lineStarts.length - 2;
    }
  }
  if (foundLineNo < 0) foundLineNo = lineStarts.length - 1;
  var result = "", i, line;
  var lineNoLength = Math.min(mark.line + options.linesAfter, lineEnds.length).toString().length;
  var maxLineLength = options.maxLength - (options.indent + lineNoLength + 3);
  for (i = 1; i <= options.linesBefore; i++) {
    if (foundLineNo - i < 0) break;
    line = getLine(
      mark.buffer,
      lineStarts[foundLineNo - i],
      lineEnds[foundLineNo - i],
      mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo - i]),
      maxLineLength
    );
    result = common.repeat(" ", options.indent) + padStart((mark.line - i + 1).toString(), lineNoLength) + " | " + line.str + "\n" + result;
  }
  line = getLine(mark.buffer, lineStarts[foundLineNo], lineEnds[foundLineNo], mark.position, maxLineLength);
  result += common.repeat(" ", options.indent) + padStart((mark.line + 1).toString(), lineNoLength) + " | " + line.str + "\n";
  result += common.repeat("-", options.indent + lineNoLength + 3 + line.pos) + "^\n";
  for (i = 1; i <= options.linesAfter; i++) {
    if (foundLineNo + i >= lineEnds.length) break;
    line = getLine(
      mark.buffer,
      lineStarts[foundLineNo + i],
      lineEnds[foundLineNo + i],
      mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo + i]),
      maxLineLength
    );
    result += common.repeat(" ", options.indent) + padStart((mark.line + i + 1).toString(), lineNoLength) + " | " + line.str + "\n";
  }
  return result.replace(/\n$/, "");
}
var snippet = makeSnippet;
var TYPE_CONSTRUCTOR_OPTIONS = [
  "kind",
  "multi",
  "resolve",
  "construct",
  "instanceOf",
  "predicate",
  "represent",
  "representName",
  "defaultStyle",
  "styleAliases"
];
var YAML_NODE_KINDS = [
  "scalar",
  "sequence",
  "mapping"
];
function compileStyleAliases(map2) {
  var result = {};
  if (map2 !== null) {
    Object.keys(map2).forEach(function(style) {
      map2[style].forEach(function(alias) {
        result[String(alias)] = style;
      });
    });
  }
  return result;
}
function Type$1(tag, options) {
  options = options || {};
  Object.keys(options).forEach(function(name) {
    if (TYPE_CONSTRUCTOR_OPTIONS.indexOf(name) === -1) {
      throw new exception('Unknown option "' + name + '" is met in definition of "' + tag + '" YAML type.');
    }
  });
  this.options = options;
  this.tag = tag;
  this.kind = options["kind"] || null;
  this.resolve = options["resolve"] || function() {
    return true;
  };
  this.construct = options["construct"] || function(data) {
    return data;
  };
  this.instanceOf = options["instanceOf"] || null;
  this.predicate = options["predicate"] || null;
  this.represent = options["represent"] || null;
  this.representName = options["representName"] || null;
  this.defaultStyle = options["defaultStyle"] || null;
  this.multi = options["multi"] || false;
  this.styleAliases = compileStyleAliases(options["styleAliases"] || null);
  if (YAML_NODE_KINDS.indexOf(this.kind) === -1) {
    throw new exception('Unknown kind "' + this.kind + '" is specified for "' + tag + '" YAML type.');
  }
}
var type = Type$1;
function compileList(schema2, name) {
  var result = [];
  schema2[name].forEach(function(currentType) {
    var newIndex = result.length;
    result.forEach(function(previousType, previousIndex) {
      if (previousType.tag === currentType.tag && previousType.kind === currentType.kind && previousType.multi === currentType.multi) {
        newIndex = previousIndex;
      }
    });
    result[newIndex] = currentType;
  });
  return result;
}
function compileMap() {
  var result = {
    scalar: {},
    sequence: {},
    mapping: {},
    fallback: {},
    multi: {
      scalar: [],
      sequence: [],
      mapping: [],
      fallback: []
    }
  }, index, length;
  function collectType(type2) {
    if (type2.multi) {
      result.multi[type2.kind].push(type2);
      result.multi["fallback"].push(type2);
    } else {
      result[type2.kind][type2.tag] = result["fallback"][type2.tag] = type2;
    }
  }
  for (index = 0, length = arguments.length; index < length; index += 1) {
    arguments[index].forEach(collectType);
  }
  return result;
}
function Schema$1(definition) {
  return this.extend(definition);
}
Schema$1.prototype.extend = function extend2(definition) {
  var implicit = [];
  var explicit = [];
  if (definition instanceof type) {
    explicit.push(definition);
  } else if (Array.isArray(definition)) {
    explicit = explicit.concat(definition);
  } else if (definition && (Array.isArray(definition.implicit) || Array.isArray(definition.explicit))) {
    if (definition.implicit) implicit = implicit.concat(definition.implicit);
    if (definition.explicit) explicit = explicit.concat(definition.explicit);
  } else {
    throw new exception("Schema.extend argument should be a Type, [ Type ], or a schema definition ({ implicit: [...], explicit: [...] })");
  }
  implicit.forEach(function(type$1) {
    if (!(type$1 instanceof type)) {
      throw new exception("Specified list of YAML types (or a single Type object) contains a non-Type object.");
    }
    if (type$1.loadKind && type$1.loadKind !== "scalar") {
      throw new exception("There is a non-scalar type in the implicit list of a schema. Implicit resolving of such types is not supported.");
    }
    if (type$1.multi) {
      throw new exception("There is a multi type in the implicit list of a schema. Multi tags can only be listed as explicit.");
    }
  });
  explicit.forEach(function(type$1) {
    if (!(type$1 instanceof type)) {
      throw new exception("Specified list of YAML types (or a single Type object) contains a non-Type object.");
    }
  });
  var result = Object.create(Schema$1.prototype);
  result.implicit = (this.implicit || []).concat(implicit);
  result.explicit = (this.explicit || []).concat(explicit);
  result.compiledImplicit = compileList(result, "implicit");
  result.compiledExplicit = compileList(result, "explicit");
  result.compiledTypeMap = compileMap(result.compiledImplicit, result.compiledExplicit);
  return result;
};
var schema = Schema$1;
var str = new type("tag:yaml.org,2002:str", {
  kind: "scalar",
  construct: function(data) {
    return data !== null ? data : "";
  }
});
var seq = new type("tag:yaml.org,2002:seq", {
  kind: "sequence",
  construct: function(data) {
    return data !== null ? data : [];
  }
});
var map = new type("tag:yaml.org,2002:map", {
  kind: "mapping",
  construct: function(data) {
    return data !== null ? data : {};
  }
});
var failsafe = new schema({
  explicit: [
    str,
    seq,
    map
  ]
});
function resolveYamlNull(data) {
  if (data === null) return true;
  var max = data.length;
  return max === 1 && data === "~" || max === 4 && (data === "null" || data === "Null" || data === "NULL");
}
function constructYamlNull() {
  return null;
}
function isNull(object) {
  return object === null;
}
var _null = new type("tag:yaml.org,2002:null", {
  kind: "scalar",
  resolve: resolveYamlNull,
  construct: constructYamlNull,
  predicate: isNull,
  represent: {
    canonical: function() {
      return "~";
    },
    lowercase: function() {
      return "null";
    },
    uppercase: function() {
      return "NULL";
    },
    camelcase: function() {
      return "Null";
    },
    empty: function() {
      return "";
    }
  },
  defaultStyle: "lowercase"
});
function resolveYamlBoolean(data) {
  if (data === null) return false;
  var max = data.length;
  return max === 4 && (data === "true" || data === "True" || data === "TRUE") || max === 5 && (data === "false" || data === "False" || data === "FALSE");
}
function constructYamlBoolean(data) {
  return data === "true" || data === "True" || data === "TRUE";
}
function isBoolean(object) {
  return Object.prototype.toString.call(object) === "[object Boolean]";
}
var bool = new type("tag:yaml.org,2002:bool", {
  kind: "scalar",
  resolve: resolveYamlBoolean,
  construct: constructYamlBoolean,
  predicate: isBoolean,
  represent: {
    lowercase: function(object) {
      return object ? "true" : "false";
    },
    uppercase: function(object) {
      return object ? "TRUE" : "FALSE";
    },
    camelcase: function(object) {
      return object ? "True" : "False";
    }
  },
  defaultStyle: "lowercase"
});
function isHexCode(c) {
  return 48 <= c && c <= 57 || 65 <= c && c <= 70 || 97 <= c && c <= 102;
}
function isOctCode(c) {
  return 48 <= c && c <= 55;
}
function isDecCode(c) {
  return 48 <= c && c <= 57;
}
function resolveYamlInteger(data) {
  if (data === null) return false;
  var max = data.length, index = 0, hasDigits = false, ch;
  if (!max) return false;
  ch = data[index];
  if (ch === "-" || ch === "+") {
    ch = data[++index];
  }
  if (ch === "0") {
    if (index + 1 === max) return true;
    ch = data[++index];
    if (ch === "b") {
      index++;
      for (; index < max; index++) {
        ch = data[index];
        if (ch === "_") continue;
        if (ch !== "0" && ch !== "1") return false;
        hasDigits = true;
      }
      return hasDigits && ch !== "_";
    }
    if (ch === "x") {
      index++;
      for (; index < max; index++) {
        ch = data[index];
        if (ch === "_") continue;
        if (!isHexCode(data.charCodeAt(index))) return false;
        hasDigits = true;
      }
      return hasDigits && ch !== "_";
    }
    if (ch === "o") {
      index++;
      for (; index < max; index++) {
        ch = data[index];
        if (ch === "_") continue;
        if (!isOctCode(data.charCodeAt(index))) return false;
        hasDigits = true;
      }
      return hasDigits && ch !== "_";
    }
  }
  if (ch === "_") return false;
  for (; index < max; index++) {
    ch = data[index];
    if (ch === "_") continue;
    if (!isDecCode(data.charCodeAt(index))) {
      return false;
    }
    hasDigits = true;
  }
  if (!hasDigits || ch === "_") return false;
  return true;
}
function constructYamlInteger(data) {
  var value = data, sign = 1, ch;
  if (value.indexOf("_") !== -1) {
    value = value.replace(/_/g, "");
  }
  ch = value[0];
  if (ch === "-" || ch === "+") {
    if (ch === "-") sign = -1;
    value = value.slice(1);
    ch = value[0];
  }
  if (value === "0") return 0;
  if (ch === "0") {
    if (value[1] === "b") return sign * parseInt(value.slice(2), 2);
    if (value[1] === "x") return sign * parseInt(value.slice(2), 16);
    if (value[1] === "o") return sign * parseInt(value.slice(2), 8);
  }
  return sign * parseInt(value, 10);
}
function isInteger(object) {
  return Object.prototype.toString.call(object) === "[object Number]" && (object % 1 === 0 && !common.isNegativeZero(object));
}
var int = new type("tag:yaml.org,2002:int", {
  kind: "scalar",
  resolve: resolveYamlInteger,
  construct: constructYamlInteger,
  predicate: isInteger,
  represent: {
    binary: function(obj) {
      return obj >= 0 ? "0b" + obj.toString(2) : "-0b" + obj.toString(2).slice(1);
    },
    octal: function(obj) {
      return obj >= 0 ? "0o" + obj.toString(8) : "-0o" + obj.toString(8).slice(1);
    },
    decimal: function(obj) {
      return obj.toString(10);
    },
    /* eslint-disable max-len */
    hexadecimal: function(obj) {
      return obj >= 0 ? "0x" + obj.toString(16).toUpperCase() : "-0x" + obj.toString(16).toUpperCase().slice(1);
    }
  },
  defaultStyle: "decimal",
  styleAliases: {
    binary: [2, "bin"],
    octal: [8, "oct"],
    decimal: [10, "dec"],
    hexadecimal: [16, "hex"]
  }
});
var YAML_FLOAT_PATTERN = new RegExp(
  // 2.5e4, 2.5 and integers
  "^(?:[-+]?(?:[0-9][0-9_]*)(?:\\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$"
);
function resolveYamlFloat(data) {
  if (data === null) return false;
  if (!YAML_FLOAT_PATTERN.test(data) || // Quick hack to not allow integers end with `_`
  // Probably should update regexp & check speed
  data[data.length - 1] === "_") {
    return false;
  }
  return true;
}
function constructYamlFloat(data) {
  var value, sign;
  value = data.replace(/_/g, "").toLowerCase();
  sign = value[0] === "-" ? -1 : 1;
  if ("+-".indexOf(value[0]) >= 0) {
    value = value.slice(1);
  }
  if (value === ".inf") {
    return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  } else if (value === ".nan") {
    return NaN;
  }
  return sign * parseFloat(value, 10);
}
var SCIENTIFIC_WITHOUT_DOT = /^[-+]?[0-9]+e/;
function representYamlFloat(object, style) {
  var res;
  if (isNaN(object)) {
    switch (style) {
      case "lowercase":
        return ".nan";
      case "uppercase":
        return ".NAN";
      case "camelcase":
        return ".NaN";
    }
  } else if (Number.POSITIVE_INFINITY === object) {
    switch (style) {
      case "lowercase":
        return ".inf";
      case "uppercase":
        return ".INF";
      case "camelcase":
        return ".Inf";
    }
  } else if (Number.NEGATIVE_INFINITY === object) {
    switch (style) {
      case "lowercase":
        return "-.inf";
      case "uppercase":
        return "-.INF";
      case "camelcase":
        return "-.Inf";
    }
  } else if (common.isNegativeZero(object)) {
    return "-0.0";
  }
  res = object.toString(10);
  return SCIENTIFIC_WITHOUT_DOT.test(res) ? res.replace("e", ".e") : res;
}
function isFloat(object) {
  return Object.prototype.toString.call(object) === "[object Number]" && (object % 1 !== 0 || common.isNegativeZero(object));
}
var float = new type("tag:yaml.org,2002:float", {
  kind: "scalar",
  resolve: resolveYamlFloat,
  construct: constructYamlFloat,
  predicate: isFloat,
  represent: representYamlFloat,
  defaultStyle: "lowercase"
});
var json = failsafe.extend({
  implicit: [
    _null,
    bool,
    int,
    float
  ]
});
var core = json;
var YAML_DATE_REGEXP = new RegExp(
  "^([0-9][0-9][0-9][0-9])-([0-9][0-9])-([0-9][0-9])$"
);
var YAML_TIMESTAMP_REGEXP = new RegExp(
  "^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:[Tt]|[ \\t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\\.([0-9]*))?(?:[ \\t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?$"
);
function resolveYamlTimestamp(data) {
  if (data === null) return false;
  if (YAML_DATE_REGEXP.exec(data) !== null) return true;
  if (YAML_TIMESTAMP_REGEXP.exec(data) !== null) return true;
  return false;
}
function constructYamlTimestamp(data) {
  var match, year, month, day, hour, minute, second, fraction = 0, delta = null, tz_hour, tz_minute, date;
  match = YAML_DATE_REGEXP.exec(data);
  if (match === null) match = YAML_TIMESTAMP_REGEXP.exec(data);
  if (match === null) throw new Error("Date resolve error");
  year = +match[1];
  month = +match[2] - 1;
  day = +match[3];
  if (!match[4]) {
    return new Date(Date.UTC(year, month, day));
  }
  hour = +match[4];
  minute = +match[5];
  second = +match[6];
  if (match[7]) {
    fraction = match[7].slice(0, 3);
    while (fraction.length < 3) {
      fraction += "0";
    }
    fraction = +fraction;
  }
  if (match[9]) {
    tz_hour = +match[10];
    tz_minute = +(match[11] || 0);
    delta = (tz_hour * 60 + tz_minute) * 6e4;
    if (match[9] === "-") delta = -delta;
  }
  date = new Date(Date.UTC(year, month, day, hour, minute, second, fraction));
  if (delta) date.setTime(date.getTime() - delta);
  return date;
}
function representYamlTimestamp(object) {
  return object.toISOString();
}
var timestamp = new type("tag:yaml.org,2002:timestamp", {
  kind: "scalar",
  resolve: resolveYamlTimestamp,
  construct: constructYamlTimestamp,
  instanceOf: Date,
  represent: representYamlTimestamp
});
function resolveYamlMerge(data) {
  return data === "<<" || data === null;
}
var merge = new type("tag:yaml.org,2002:merge", {
  kind: "scalar",
  resolve: resolveYamlMerge
});
var BASE64_MAP = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\n\r";
function resolveYamlBinary(data) {
  if (data === null) return false;
  var code, idx, bitlen = 0, max = data.length, map2 = BASE64_MAP;
  for (idx = 0; idx < max; idx++) {
    code = map2.indexOf(data.charAt(idx));
    if (code > 64) continue;
    if (code < 0) return false;
    bitlen += 6;
  }
  return bitlen % 8 === 0;
}
function constructYamlBinary(data) {
  var idx, tailbits, input = data.replace(/[\r\n=]/g, ""), max = input.length, map2 = BASE64_MAP, bits = 0, result = [];
  for (idx = 0; idx < max; idx++) {
    if (idx % 4 === 0 && idx) {
      result.push(bits >> 16 & 255);
      result.push(bits >> 8 & 255);
      result.push(bits & 255);
    }
    bits = bits << 6 | map2.indexOf(input.charAt(idx));
  }
  tailbits = max % 4 * 6;
  if (tailbits === 0) {
    result.push(bits >> 16 & 255);
    result.push(bits >> 8 & 255);
    result.push(bits & 255);
  } else if (tailbits === 18) {
    result.push(bits >> 10 & 255);
    result.push(bits >> 2 & 255);
  } else if (tailbits === 12) {
    result.push(bits >> 4 & 255);
  }
  return new Uint8Array(result);
}
function representYamlBinary(object) {
  var result = "", bits = 0, idx, tail, max = object.length, map2 = BASE64_MAP;
  for (idx = 0; idx < max; idx++) {
    if (idx % 3 === 0 && idx) {
      result += map2[bits >> 18 & 63];
      result += map2[bits >> 12 & 63];
      result += map2[bits >> 6 & 63];
      result += map2[bits & 63];
    }
    bits = (bits << 8) + object[idx];
  }
  tail = max % 3;
  if (tail === 0) {
    result += map2[bits >> 18 & 63];
    result += map2[bits >> 12 & 63];
    result += map2[bits >> 6 & 63];
    result += map2[bits & 63];
  } else if (tail === 2) {
    result += map2[bits >> 10 & 63];
    result += map2[bits >> 4 & 63];
    result += map2[bits << 2 & 63];
    result += map2[64];
  } else if (tail === 1) {
    result += map2[bits >> 2 & 63];
    result += map2[bits << 4 & 63];
    result += map2[64];
    result += map2[64];
  }
  return result;
}
function isBinary(obj) {
  return Object.prototype.toString.call(obj) === "[object Uint8Array]";
}
var binary = new type("tag:yaml.org,2002:binary", {
  kind: "scalar",
  resolve: resolveYamlBinary,
  construct: constructYamlBinary,
  predicate: isBinary,
  represent: representYamlBinary
});
var _hasOwnProperty$3 = Object.prototype.hasOwnProperty;
var _toString$2 = Object.prototype.toString;
function resolveYamlOmap(data) {
  if (data === null) return true;
  var objectKeys = [], index, length, pair, pairKey, pairHasKey, object = data;
  for (index = 0, length = object.length; index < length; index += 1) {
    pair = object[index];
    pairHasKey = false;
    if (_toString$2.call(pair) !== "[object Object]") return false;
    for (pairKey in pair) {
      if (_hasOwnProperty$3.call(pair, pairKey)) {
        if (!pairHasKey) pairHasKey = true;
        else return false;
      }
    }
    if (!pairHasKey) return false;
    if (objectKeys.indexOf(pairKey) === -1) objectKeys.push(pairKey);
    else return false;
  }
  return true;
}
function constructYamlOmap(data) {
  return data !== null ? data : [];
}
var omap = new type("tag:yaml.org,2002:omap", {
  kind: "sequence",
  resolve: resolveYamlOmap,
  construct: constructYamlOmap
});
var _toString$1 = Object.prototype.toString;
function resolveYamlPairs(data) {
  if (data === null) return true;
  var index, length, pair, keys, result, object = data;
  result = new Array(object.length);
  for (index = 0, length = object.length; index < length; index += 1) {
    pair = object[index];
    if (_toString$1.call(pair) !== "[object Object]") return false;
    keys = Object.keys(pair);
    if (keys.length !== 1) return false;
    result[index] = [keys[0], pair[keys[0]]];
  }
  return true;
}
function constructYamlPairs(data) {
  if (data === null) return [];
  var index, length, pair, keys, result, object = data;
  result = new Array(object.length);
  for (index = 0, length = object.length; index < length; index += 1) {
    pair = object[index];
    keys = Object.keys(pair);
    result[index] = [keys[0], pair[keys[0]]];
  }
  return result;
}
var pairs = new type("tag:yaml.org,2002:pairs", {
  kind: "sequence",
  resolve: resolveYamlPairs,
  construct: constructYamlPairs
});
var _hasOwnProperty$2 = Object.prototype.hasOwnProperty;
function resolveYamlSet(data) {
  if (data === null) return true;
  var key, object = data;
  for (key in object) {
    if (_hasOwnProperty$2.call(object, key)) {
      if (object[key] !== null) return false;
    }
  }
  return true;
}
function constructYamlSet(data) {
  return data !== null ? data : {};
}
var set = new type("tag:yaml.org,2002:set", {
  kind: "mapping",
  resolve: resolveYamlSet,
  construct: constructYamlSet
});
var _default = core.extend({
  implicit: [
    timestamp,
    merge
  ],
  explicit: [
    binary,
    omap,
    pairs,
    set
  ]
});
var _hasOwnProperty$1 = Object.prototype.hasOwnProperty;
var CONTEXT_FLOW_IN = 1;
var CONTEXT_FLOW_OUT = 2;
var CONTEXT_BLOCK_IN = 3;
var CONTEXT_BLOCK_OUT = 4;
var CHOMPING_CLIP = 1;
var CHOMPING_STRIP = 2;
var CHOMPING_KEEP = 3;
var PATTERN_NON_PRINTABLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
var PATTERN_NON_ASCII_LINE_BREAKS = /[\x85\u2028\u2029]/;
var PATTERN_FLOW_INDICATORS = /[,\[\]\{\}]/;
var PATTERN_TAG_HANDLE = /^(?:!|!!|![a-z\-]+!)$/i;
var PATTERN_TAG_URI = /^(?:!|[^,\[\]\{\}])(?:%[0-9a-f]{2}|[0-9a-z\-#;\/\?:@&=\+\$,_\.!~\*'\(\)\[\]])*$/i;
function _class(obj) {
  return Object.prototype.toString.call(obj);
}
function is_EOL(c) {
  return c === 10 || c === 13;
}
function is_WHITE_SPACE(c) {
  return c === 9 || c === 32;
}
function is_WS_OR_EOL(c) {
  return c === 9 || c === 32 || c === 10 || c === 13;
}
function is_FLOW_INDICATOR(c) {
  return c === 44 || c === 91 || c === 93 || c === 123 || c === 125;
}
function fromHexCode(c) {
  var lc;
  if (48 <= c && c <= 57) {
    return c - 48;
  }
  lc = c | 32;
  if (97 <= lc && lc <= 102) {
    return lc - 97 + 10;
  }
  return -1;
}
function escapedHexLen(c) {
  if (c === 120) {
    return 2;
  }
  if (c === 117) {
    return 4;
  }
  if (c === 85) {
    return 8;
  }
  return 0;
}
function fromDecimalCode(c) {
  if (48 <= c && c <= 57) {
    return c - 48;
  }
  return -1;
}
function simpleEscapeSequence(c) {
  return c === 48 ? "\0" : c === 97 ? "\x07" : c === 98 ? "\b" : c === 116 ? "	" : c === 9 ? "	" : c === 110 ? "\n" : c === 118 ? "\v" : c === 102 ? "\f" : c === 114 ? "\r" : c === 101 ? "\x1B" : c === 32 ? " " : c === 34 ? '"' : c === 47 ? "/" : c === 92 ? "\\" : c === 78 ? "\x85" : c === 95 ? "\xA0" : c === 76 ? "\u2028" : c === 80 ? "\u2029" : "";
}
function charFromCodepoint(c) {
  if (c <= 65535) {
    return String.fromCharCode(c);
  }
  return String.fromCharCode(
    (c - 65536 >> 10) + 55296,
    (c - 65536 & 1023) + 56320
  );
}
function setProperty(object, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(object, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value
    });
  } else {
    object[key] = value;
  }
}
var simpleEscapeCheck = new Array(256);
var simpleEscapeMap = new Array(256);
for (i = 0; i < 256; i++) {
  simpleEscapeCheck[i] = simpleEscapeSequence(i) ? 1 : 0;
  simpleEscapeMap[i] = simpleEscapeSequence(i);
}
var i;
function State$1(input, options) {
  this.input = input;
  this.filename = options["filename"] || null;
  this.schema = options["schema"] || _default;
  this.onWarning = options["onWarning"] || null;
  this.legacy = options["legacy"] || false;
  this.json = options["json"] || false;
  this.listener = options["listener"] || null;
  this.implicitTypes = this.schema.compiledImplicit;
  this.typeMap = this.schema.compiledTypeMap;
  this.length = input.length;
  this.position = 0;
  this.line = 0;
  this.lineStart = 0;
  this.lineIndent = 0;
  this.firstTabInLine = -1;
  this.documents = [];
}
function generateError(state, message) {
  var mark = {
    name: state.filename,
    buffer: state.input.slice(0, -1),
    // omit trailing \0
    position: state.position,
    line: state.line,
    column: state.position - state.lineStart
  };
  mark.snippet = snippet(mark);
  return new exception(message, mark);
}
function throwError(state, message) {
  throw generateError(state, message);
}
function throwWarning(state, message) {
  if (state.onWarning) {
    state.onWarning.call(null, generateError(state, message));
  }
}
var directiveHandlers = {
  YAML: function handleYamlDirective(state, name, args) {
    var match, major, minor;
    if (state.version !== null) {
      throwError(state, "duplication of %YAML directive");
    }
    if (args.length !== 1) {
      throwError(state, "YAML directive accepts exactly one argument");
    }
    match = /^([0-9]+)\.([0-9]+)$/.exec(args[0]);
    if (match === null) {
      throwError(state, "ill-formed argument of the YAML directive");
    }
    major = parseInt(match[1], 10);
    minor = parseInt(match[2], 10);
    if (major !== 1) {
      throwError(state, "unacceptable YAML version of the document");
    }
    state.version = args[0];
    state.checkLineBreaks = minor < 2;
    if (minor !== 1 && minor !== 2) {
      throwWarning(state, "unsupported YAML version of the document");
    }
  },
  TAG: function handleTagDirective(state, name, args) {
    var handle, prefix;
    if (args.length !== 2) {
      throwError(state, "TAG directive accepts exactly two arguments");
    }
    handle = args[0];
    prefix = args[1];
    if (!PATTERN_TAG_HANDLE.test(handle)) {
      throwError(state, "ill-formed tag handle (first argument) of the TAG directive");
    }
    if (_hasOwnProperty$1.call(state.tagMap, handle)) {
      throwError(state, 'there is a previously declared suffix for "' + handle + '" tag handle');
    }
    if (!PATTERN_TAG_URI.test(prefix)) {
      throwError(state, "ill-formed tag prefix (second argument) of the TAG directive");
    }
    try {
      prefix = decodeURIComponent(prefix);
    } catch (err) {
      throwError(state, "tag prefix is malformed: " + prefix);
    }
    state.tagMap[handle] = prefix;
  }
};
function captureSegment(state, start, end, checkJson) {
  var _position, _length, _character, _result;
  if (start < end) {
    _result = state.input.slice(start, end);
    if (checkJson) {
      for (_position = 0, _length = _result.length; _position < _length; _position += 1) {
        _character = _result.charCodeAt(_position);
        if (!(_character === 9 || 32 <= _character && _character <= 1114111)) {
          throwError(state, "expected valid JSON character");
        }
      }
    } else if (PATTERN_NON_PRINTABLE.test(_result)) {
      throwError(state, "the stream contains non-printable characters");
    }
    state.result += _result;
  }
}
function mergeMappings(state, destination, source, overridableKeys) {
  var sourceKeys, key, index, quantity;
  if (!common.isObject(source)) {
    throwError(state, "cannot merge mappings; the provided source object is unacceptable");
  }
  sourceKeys = Object.keys(source);
  for (index = 0, quantity = sourceKeys.length; index < quantity; index += 1) {
    key = sourceKeys[index];
    if (!_hasOwnProperty$1.call(destination, key)) {
      setProperty(destination, key, source[key]);
      overridableKeys[key] = true;
    }
  }
}
function storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, startLine, startLineStart, startPos) {
  var index, quantity;
  if (Array.isArray(keyNode)) {
    keyNode = Array.prototype.slice.call(keyNode);
    for (index = 0, quantity = keyNode.length; index < quantity; index += 1) {
      if (Array.isArray(keyNode[index])) {
        throwError(state, "nested arrays are not supported inside keys");
      }
      if (typeof keyNode === "object" && _class(keyNode[index]) === "[object Object]") {
        keyNode[index] = "[object Object]";
      }
    }
  }
  if (typeof keyNode === "object" && _class(keyNode) === "[object Object]") {
    keyNode = "[object Object]";
  }
  keyNode = String(keyNode);
  if (_result === null) {
    _result = {};
  }
  if (keyTag === "tag:yaml.org,2002:merge") {
    if (Array.isArray(valueNode)) {
      for (index = 0, quantity = valueNode.length; index < quantity; index += 1) {
        mergeMappings(state, _result, valueNode[index], overridableKeys);
      }
    } else {
      mergeMappings(state, _result, valueNode, overridableKeys);
    }
  } else {
    if (!state.json && !_hasOwnProperty$1.call(overridableKeys, keyNode) && _hasOwnProperty$1.call(_result, keyNode)) {
      state.line = startLine || state.line;
      state.lineStart = startLineStart || state.lineStart;
      state.position = startPos || state.position;
      throwError(state, "duplicated mapping key");
    }
    setProperty(_result, keyNode, valueNode);
    delete overridableKeys[keyNode];
  }
  return _result;
}
function readLineBreak(state) {
  var ch;
  ch = state.input.charCodeAt(state.position);
  if (ch === 10) {
    state.position++;
  } else if (ch === 13) {
    state.position++;
    if (state.input.charCodeAt(state.position) === 10) {
      state.position++;
    }
  } else {
    throwError(state, "a line break is expected");
  }
  state.line += 1;
  state.lineStart = state.position;
  state.firstTabInLine = -1;
}
function skipSeparationSpace(state, allowComments, checkIndent) {
  var lineBreaks = 0, ch = state.input.charCodeAt(state.position);
  while (ch !== 0) {
    while (is_WHITE_SPACE(ch)) {
      if (ch === 9 && state.firstTabInLine === -1) {
        state.firstTabInLine = state.position;
      }
      ch = state.input.charCodeAt(++state.position);
    }
    if (allowComments && ch === 35) {
      do {
        ch = state.input.charCodeAt(++state.position);
      } while (ch !== 10 && ch !== 13 && ch !== 0);
    }
    if (is_EOL(ch)) {
      readLineBreak(state);
      ch = state.input.charCodeAt(state.position);
      lineBreaks++;
      state.lineIndent = 0;
      while (ch === 32) {
        state.lineIndent++;
        ch = state.input.charCodeAt(++state.position);
      }
    } else {
      break;
    }
  }
  if (checkIndent !== -1 && lineBreaks !== 0 && state.lineIndent < checkIndent) {
    throwWarning(state, "deficient indentation");
  }
  return lineBreaks;
}
function testDocumentSeparator(state) {
  var _position = state.position, ch;
  ch = state.input.charCodeAt(_position);
  if ((ch === 45 || ch === 46) && ch === state.input.charCodeAt(_position + 1) && ch === state.input.charCodeAt(_position + 2)) {
    _position += 3;
    ch = state.input.charCodeAt(_position);
    if (ch === 0 || is_WS_OR_EOL(ch)) {
      return true;
    }
  }
  return false;
}
function writeFoldedLines(state, count) {
  if (count === 1) {
    state.result += " ";
  } else if (count > 1) {
    state.result += common.repeat("\n", count - 1);
  }
}
function readPlainScalar(state, nodeIndent, withinFlowCollection) {
  var preceding, following, captureStart, captureEnd, hasPendingContent, _line, _lineStart, _lineIndent, _kind = state.kind, _result = state.result, ch;
  ch = state.input.charCodeAt(state.position);
  if (is_WS_OR_EOL(ch) || is_FLOW_INDICATOR(ch) || ch === 35 || ch === 38 || ch === 42 || ch === 33 || ch === 124 || ch === 62 || ch === 39 || ch === 34 || ch === 37 || ch === 64 || ch === 96) {
    return false;
  }
  if (ch === 63 || ch === 45) {
    following = state.input.charCodeAt(state.position + 1);
    if (is_WS_OR_EOL(following) || withinFlowCollection && is_FLOW_INDICATOR(following)) {
      return false;
    }
  }
  state.kind = "scalar";
  state.result = "";
  captureStart = captureEnd = state.position;
  hasPendingContent = false;
  while (ch !== 0) {
    if (ch === 58) {
      following = state.input.charCodeAt(state.position + 1);
      if (is_WS_OR_EOL(following) || withinFlowCollection && is_FLOW_INDICATOR(following)) {
        break;
      }
    } else if (ch === 35) {
      preceding = state.input.charCodeAt(state.position - 1);
      if (is_WS_OR_EOL(preceding)) {
        break;
      }
    } else if (state.position === state.lineStart && testDocumentSeparator(state) || withinFlowCollection && is_FLOW_INDICATOR(ch)) {
      break;
    } else if (is_EOL(ch)) {
      _line = state.line;
      _lineStart = state.lineStart;
      _lineIndent = state.lineIndent;
      skipSeparationSpace(state, false, -1);
      if (state.lineIndent >= nodeIndent) {
        hasPendingContent = true;
        ch = state.input.charCodeAt(state.position);
        continue;
      } else {
        state.position = captureEnd;
        state.line = _line;
        state.lineStart = _lineStart;
        state.lineIndent = _lineIndent;
        break;
      }
    }
    if (hasPendingContent) {
      captureSegment(state, captureStart, captureEnd, false);
      writeFoldedLines(state, state.line - _line);
      captureStart = captureEnd = state.position;
      hasPendingContent = false;
    }
    if (!is_WHITE_SPACE(ch)) {
      captureEnd = state.position + 1;
    }
    ch = state.input.charCodeAt(++state.position);
  }
  captureSegment(state, captureStart, captureEnd, false);
  if (state.result) {
    return true;
  }
  state.kind = _kind;
  state.result = _result;
  return false;
}
function readSingleQuotedScalar(state, nodeIndent) {
  var ch, captureStart, captureEnd;
  ch = state.input.charCodeAt(state.position);
  if (ch !== 39) {
    return false;
  }
  state.kind = "scalar";
  state.result = "";
  state.position++;
  captureStart = captureEnd = state.position;
  while ((ch = state.input.charCodeAt(state.position)) !== 0) {
    if (ch === 39) {
      captureSegment(state, captureStart, state.position, true);
      ch = state.input.charCodeAt(++state.position);
      if (ch === 39) {
        captureStart = state.position;
        state.position++;
        captureEnd = state.position;
      } else {
        return true;
      }
    } else if (is_EOL(ch)) {
      captureSegment(state, captureStart, captureEnd, true);
      writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
      captureStart = captureEnd = state.position;
    } else if (state.position === state.lineStart && testDocumentSeparator(state)) {
      throwError(state, "unexpected end of the document within a single quoted scalar");
    } else {
      state.position++;
      captureEnd = state.position;
    }
  }
  throwError(state, "unexpected end of the stream within a single quoted scalar");
}
function readDoubleQuotedScalar(state, nodeIndent) {
  var captureStart, captureEnd, hexLength, hexResult, tmp, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch !== 34) {
    return false;
  }
  state.kind = "scalar";
  state.result = "";
  state.position++;
  captureStart = captureEnd = state.position;
  while ((ch = state.input.charCodeAt(state.position)) !== 0) {
    if (ch === 34) {
      captureSegment(state, captureStart, state.position, true);
      state.position++;
      return true;
    } else if (ch === 92) {
      captureSegment(state, captureStart, state.position, true);
      ch = state.input.charCodeAt(++state.position);
      if (is_EOL(ch)) {
        skipSeparationSpace(state, false, nodeIndent);
      } else if (ch < 256 && simpleEscapeCheck[ch]) {
        state.result += simpleEscapeMap[ch];
        state.position++;
      } else if ((tmp = escapedHexLen(ch)) > 0) {
        hexLength = tmp;
        hexResult = 0;
        for (; hexLength > 0; hexLength--) {
          ch = state.input.charCodeAt(++state.position);
          if ((tmp = fromHexCode(ch)) >= 0) {
            hexResult = (hexResult << 4) + tmp;
          } else {
            throwError(state, "expected hexadecimal character");
          }
        }
        state.result += charFromCodepoint(hexResult);
        state.position++;
      } else {
        throwError(state, "unknown escape sequence");
      }
      captureStart = captureEnd = state.position;
    } else if (is_EOL(ch)) {
      captureSegment(state, captureStart, captureEnd, true);
      writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
      captureStart = captureEnd = state.position;
    } else if (state.position === state.lineStart && testDocumentSeparator(state)) {
      throwError(state, "unexpected end of the document within a double quoted scalar");
    } else {
      state.position++;
      captureEnd = state.position;
    }
  }
  throwError(state, "unexpected end of the stream within a double quoted scalar");
}
function readFlowCollection(state, nodeIndent) {
  var readNext = true, _line, _lineStart, _pos, _tag = state.tag, _result, _anchor = state.anchor, following, terminator, isPair, isExplicitPair, isMapping, overridableKeys = /* @__PURE__ */ Object.create(null), keyNode, keyTag, valueNode, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch === 91) {
    terminator = 93;
    isMapping = false;
    _result = [];
  } else if (ch === 123) {
    terminator = 125;
    isMapping = true;
    _result = {};
  } else {
    return false;
  }
  if (state.anchor !== null) {
    state.anchorMap[state.anchor] = _result;
  }
  ch = state.input.charCodeAt(++state.position);
  while (ch !== 0) {
    skipSeparationSpace(state, true, nodeIndent);
    ch = state.input.charCodeAt(state.position);
    if (ch === terminator) {
      state.position++;
      state.tag = _tag;
      state.anchor = _anchor;
      state.kind = isMapping ? "mapping" : "sequence";
      state.result = _result;
      return true;
    } else if (!readNext) {
      throwError(state, "missed comma between flow collection entries");
    } else if (ch === 44) {
      throwError(state, "expected the node content, but found ','");
    }
    keyTag = keyNode = valueNode = null;
    isPair = isExplicitPair = false;
    if (ch === 63) {
      following = state.input.charCodeAt(state.position + 1);
      if (is_WS_OR_EOL(following)) {
        isPair = isExplicitPair = true;
        state.position++;
        skipSeparationSpace(state, true, nodeIndent);
      }
    }
    _line = state.line;
    _lineStart = state.lineStart;
    _pos = state.position;
    composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
    keyTag = state.tag;
    keyNode = state.result;
    skipSeparationSpace(state, true, nodeIndent);
    ch = state.input.charCodeAt(state.position);
    if ((isExplicitPair || state.line === _line) && ch === 58) {
      isPair = true;
      ch = state.input.charCodeAt(++state.position);
      skipSeparationSpace(state, true, nodeIndent);
      composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
      valueNode = state.result;
    }
    if (isMapping) {
      storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, _line, _lineStart, _pos);
    } else if (isPair) {
      _result.push(storeMappingPair(state, null, overridableKeys, keyTag, keyNode, valueNode, _line, _lineStart, _pos));
    } else {
      _result.push(keyNode);
    }
    skipSeparationSpace(state, true, nodeIndent);
    ch = state.input.charCodeAt(state.position);
    if (ch === 44) {
      readNext = true;
      ch = state.input.charCodeAt(++state.position);
    } else {
      readNext = false;
    }
  }
  throwError(state, "unexpected end of the stream within a flow collection");
}
function readBlockScalar(state, nodeIndent) {
  var captureStart, folding, chomping = CHOMPING_CLIP, didReadContent = false, detectedIndent = false, textIndent = nodeIndent, emptyLines = 0, atMoreIndented = false, tmp, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch === 124) {
    folding = false;
  } else if (ch === 62) {
    folding = true;
  } else {
    return false;
  }
  state.kind = "scalar";
  state.result = "";
  while (ch !== 0) {
    ch = state.input.charCodeAt(++state.position);
    if (ch === 43 || ch === 45) {
      if (CHOMPING_CLIP === chomping) {
        chomping = ch === 43 ? CHOMPING_KEEP : CHOMPING_STRIP;
      } else {
        throwError(state, "repeat of a chomping mode identifier");
      }
    } else if ((tmp = fromDecimalCode(ch)) >= 0) {
      if (tmp === 0) {
        throwError(state, "bad explicit indentation width of a block scalar; it cannot be less than one");
      } else if (!detectedIndent) {
        textIndent = nodeIndent + tmp - 1;
        detectedIndent = true;
      } else {
        throwError(state, "repeat of an indentation width identifier");
      }
    } else {
      break;
    }
  }
  if (is_WHITE_SPACE(ch)) {
    do {
      ch = state.input.charCodeAt(++state.position);
    } while (is_WHITE_SPACE(ch));
    if (ch === 35) {
      do {
        ch = state.input.charCodeAt(++state.position);
      } while (!is_EOL(ch) && ch !== 0);
    }
  }
  while (ch !== 0) {
    readLineBreak(state);
    state.lineIndent = 0;
    ch = state.input.charCodeAt(state.position);
    while ((!detectedIndent || state.lineIndent < textIndent) && ch === 32) {
      state.lineIndent++;
      ch = state.input.charCodeAt(++state.position);
    }
    if (!detectedIndent && state.lineIndent > textIndent) {
      textIndent = state.lineIndent;
    }
    if (is_EOL(ch)) {
      emptyLines++;
      continue;
    }
    if (state.lineIndent < textIndent) {
      if (chomping === CHOMPING_KEEP) {
        state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
      } else if (chomping === CHOMPING_CLIP) {
        if (didReadContent) {
          state.result += "\n";
        }
      }
      break;
    }
    if (folding) {
      if (is_WHITE_SPACE(ch)) {
        atMoreIndented = true;
        state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
      } else if (atMoreIndented) {
        atMoreIndented = false;
        state.result += common.repeat("\n", emptyLines + 1);
      } else if (emptyLines === 0) {
        if (didReadContent) {
          state.result += " ";
        }
      } else {
        state.result += common.repeat("\n", emptyLines);
      }
    } else {
      state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
    }
    didReadContent = true;
    detectedIndent = true;
    emptyLines = 0;
    captureStart = state.position;
    while (!is_EOL(ch) && ch !== 0) {
      ch = state.input.charCodeAt(++state.position);
    }
    captureSegment(state, captureStart, state.position, false);
  }
  return true;
}
function readBlockSequence(state, nodeIndent) {
  var _line, _tag = state.tag, _anchor = state.anchor, _result = [], following, detected = false, ch;
  if (state.firstTabInLine !== -1) return false;
  if (state.anchor !== null) {
    state.anchorMap[state.anchor] = _result;
  }
  ch = state.input.charCodeAt(state.position);
  while (ch !== 0) {
    if (state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, "tab characters must not be used in indentation");
    }
    if (ch !== 45) {
      break;
    }
    following = state.input.charCodeAt(state.position + 1);
    if (!is_WS_OR_EOL(following)) {
      break;
    }
    detected = true;
    state.position++;
    if (skipSeparationSpace(state, true, -1)) {
      if (state.lineIndent <= nodeIndent) {
        _result.push(null);
        ch = state.input.charCodeAt(state.position);
        continue;
      }
    }
    _line = state.line;
    composeNode(state, nodeIndent, CONTEXT_BLOCK_IN, false, true);
    _result.push(state.result);
    skipSeparationSpace(state, true, -1);
    ch = state.input.charCodeAt(state.position);
    if ((state.line === _line || state.lineIndent > nodeIndent) && ch !== 0) {
      throwError(state, "bad indentation of a sequence entry");
    } else if (state.lineIndent < nodeIndent) {
      break;
    }
  }
  if (detected) {
    state.tag = _tag;
    state.anchor = _anchor;
    state.kind = "sequence";
    state.result = _result;
    return true;
  }
  return false;
}
function readBlockMapping(state, nodeIndent, flowIndent) {
  var following, allowCompact, _line, _keyLine, _keyLineStart, _keyPos, _tag = state.tag, _anchor = state.anchor, _result = {}, overridableKeys = /* @__PURE__ */ Object.create(null), keyTag = null, keyNode = null, valueNode = null, atExplicitKey = false, detected = false, ch;
  if (state.firstTabInLine !== -1) return false;
  if (state.anchor !== null) {
    state.anchorMap[state.anchor] = _result;
  }
  ch = state.input.charCodeAt(state.position);
  while (ch !== 0) {
    if (!atExplicitKey && state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, "tab characters must not be used in indentation");
    }
    following = state.input.charCodeAt(state.position + 1);
    _line = state.line;
    if ((ch === 63 || ch === 58) && is_WS_OR_EOL(following)) {
      if (ch === 63) {
        if (atExplicitKey) {
          storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
          keyTag = keyNode = valueNode = null;
        }
        detected = true;
        atExplicitKey = true;
        allowCompact = true;
      } else if (atExplicitKey) {
        atExplicitKey = false;
        allowCompact = true;
      } else {
        throwError(state, "incomplete explicit mapping pair; a key node is missed; or followed by a non-tabulated empty line");
      }
      state.position += 1;
      ch = following;
    } else {
      _keyLine = state.line;
      _keyLineStart = state.lineStart;
      _keyPos = state.position;
      if (!composeNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true)) {
        break;
      }
      if (state.line === _line) {
        ch = state.input.charCodeAt(state.position);
        while (is_WHITE_SPACE(ch)) {
          ch = state.input.charCodeAt(++state.position);
        }
        if (ch === 58) {
          ch = state.input.charCodeAt(++state.position);
          if (!is_WS_OR_EOL(ch)) {
            throwError(state, "a whitespace character is expected after the key-value separator within a block mapping");
          }
          if (atExplicitKey) {
            storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
            keyTag = keyNode = valueNode = null;
          }
          detected = true;
          atExplicitKey = false;
          allowCompact = false;
          keyTag = state.tag;
          keyNode = state.result;
        } else if (detected) {
          throwError(state, "can not read an implicit mapping pair; a colon is missed");
        } else {
          state.tag = _tag;
          state.anchor = _anchor;
          return true;
        }
      } else if (detected) {
        throwError(state, "can not read a block mapping entry; a multiline key may not be an implicit key");
      } else {
        state.tag = _tag;
        state.anchor = _anchor;
        return true;
      }
    }
    if (state.line === _line || state.lineIndent > nodeIndent) {
      if (atExplicitKey) {
        _keyLine = state.line;
        _keyLineStart = state.lineStart;
        _keyPos = state.position;
      }
      if (composeNode(state, nodeIndent, CONTEXT_BLOCK_OUT, true, allowCompact)) {
        if (atExplicitKey) {
          keyNode = state.result;
        } else {
          valueNode = state.result;
        }
      }
      if (!atExplicitKey) {
        storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, _keyLine, _keyLineStart, _keyPos);
        keyTag = keyNode = valueNode = null;
      }
      skipSeparationSpace(state, true, -1);
      ch = state.input.charCodeAt(state.position);
    }
    if ((state.line === _line || state.lineIndent > nodeIndent) && ch !== 0) {
      throwError(state, "bad indentation of a mapping entry");
    } else if (state.lineIndent < nodeIndent) {
      break;
    }
  }
  if (atExplicitKey) {
    storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
  }
  if (detected) {
    state.tag = _tag;
    state.anchor = _anchor;
    state.kind = "mapping";
    state.result = _result;
  }
  return detected;
}
function readTagProperty(state) {
  var _position, isVerbatim = false, isNamed = false, tagHandle, tagName, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch !== 33) return false;
  if (state.tag !== null) {
    throwError(state, "duplication of a tag property");
  }
  ch = state.input.charCodeAt(++state.position);
  if (ch === 60) {
    isVerbatim = true;
    ch = state.input.charCodeAt(++state.position);
  } else if (ch === 33) {
    isNamed = true;
    tagHandle = "!!";
    ch = state.input.charCodeAt(++state.position);
  } else {
    tagHandle = "!";
  }
  _position = state.position;
  if (isVerbatim) {
    do {
      ch = state.input.charCodeAt(++state.position);
    } while (ch !== 0 && ch !== 62);
    if (state.position < state.length) {
      tagName = state.input.slice(_position, state.position);
      ch = state.input.charCodeAt(++state.position);
    } else {
      throwError(state, "unexpected end of the stream within a verbatim tag");
    }
  } else {
    while (ch !== 0 && !is_WS_OR_EOL(ch)) {
      if (ch === 33) {
        if (!isNamed) {
          tagHandle = state.input.slice(_position - 1, state.position + 1);
          if (!PATTERN_TAG_HANDLE.test(tagHandle)) {
            throwError(state, "named tag handle cannot contain such characters");
          }
          isNamed = true;
          _position = state.position + 1;
        } else {
          throwError(state, "tag suffix cannot contain exclamation marks");
        }
      }
      ch = state.input.charCodeAt(++state.position);
    }
    tagName = state.input.slice(_position, state.position);
    if (PATTERN_FLOW_INDICATORS.test(tagName)) {
      throwError(state, "tag suffix cannot contain flow indicator characters");
    }
  }
  if (tagName && !PATTERN_TAG_URI.test(tagName)) {
    throwError(state, "tag name cannot contain such characters: " + tagName);
  }
  try {
    tagName = decodeURIComponent(tagName);
  } catch (err) {
    throwError(state, "tag name is malformed: " + tagName);
  }
  if (isVerbatim) {
    state.tag = tagName;
  } else if (_hasOwnProperty$1.call(state.tagMap, tagHandle)) {
    state.tag = state.tagMap[tagHandle] + tagName;
  } else if (tagHandle === "!") {
    state.tag = "!" + tagName;
  } else if (tagHandle === "!!") {
    state.tag = "tag:yaml.org,2002:" + tagName;
  } else {
    throwError(state, 'undeclared tag handle "' + tagHandle + '"');
  }
  return true;
}
function readAnchorProperty(state) {
  var _position, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch !== 38) return false;
  if (state.anchor !== null) {
    throwError(state, "duplication of an anchor property");
  }
  ch = state.input.charCodeAt(++state.position);
  _position = state.position;
  while (ch !== 0 && !is_WS_OR_EOL(ch) && !is_FLOW_INDICATOR(ch)) {
    ch = state.input.charCodeAt(++state.position);
  }
  if (state.position === _position) {
    throwError(state, "name of an anchor node must contain at least one character");
  }
  state.anchor = state.input.slice(_position, state.position);
  return true;
}
function readAlias(state) {
  var _position, alias, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch !== 42) return false;
  ch = state.input.charCodeAt(++state.position);
  _position = state.position;
  while (ch !== 0 && !is_WS_OR_EOL(ch) && !is_FLOW_INDICATOR(ch)) {
    ch = state.input.charCodeAt(++state.position);
  }
  if (state.position === _position) {
    throwError(state, "name of an alias node must contain at least one character");
  }
  alias = state.input.slice(_position, state.position);
  if (!_hasOwnProperty$1.call(state.anchorMap, alias)) {
    throwError(state, 'unidentified alias "' + alias + '"');
  }
  state.result = state.anchorMap[alias];
  skipSeparationSpace(state, true, -1);
  return true;
}
function composeNode(state, parentIndent, nodeContext, allowToSeek, allowCompact) {
  var allowBlockStyles, allowBlockScalars, allowBlockCollections, indentStatus = 1, atNewLine = false, hasContent = false, typeIndex, typeQuantity, typeList, type2, flowIndent, blockIndent;
  if (state.listener !== null) {
    state.listener("open", state);
  }
  state.tag = null;
  state.anchor = null;
  state.kind = null;
  state.result = null;
  allowBlockStyles = allowBlockScalars = allowBlockCollections = CONTEXT_BLOCK_OUT === nodeContext || CONTEXT_BLOCK_IN === nodeContext;
  if (allowToSeek) {
    if (skipSeparationSpace(state, true, -1)) {
      atNewLine = true;
      if (state.lineIndent > parentIndent) {
        indentStatus = 1;
      } else if (state.lineIndent === parentIndent) {
        indentStatus = 0;
      } else if (state.lineIndent < parentIndent) {
        indentStatus = -1;
      }
    }
  }
  if (indentStatus === 1) {
    while (readTagProperty(state) || readAnchorProperty(state)) {
      if (skipSeparationSpace(state, true, -1)) {
        atNewLine = true;
        allowBlockCollections = allowBlockStyles;
        if (state.lineIndent > parentIndent) {
          indentStatus = 1;
        } else if (state.lineIndent === parentIndent) {
          indentStatus = 0;
        } else if (state.lineIndent < parentIndent) {
          indentStatus = -1;
        }
      } else {
        allowBlockCollections = false;
      }
    }
  }
  if (allowBlockCollections) {
    allowBlockCollections = atNewLine || allowCompact;
  }
  if (indentStatus === 1 || CONTEXT_BLOCK_OUT === nodeContext) {
    if (CONTEXT_FLOW_IN === nodeContext || CONTEXT_FLOW_OUT === nodeContext) {
      flowIndent = parentIndent;
    } else {
      flowIndent = parentIndent + 1;
    }
    blockIndent = state.position - state.lineStart;
    if (indentStatus === 1) {
      if (allowBlockCollections && (readBlockSequence(state, blockIndent) || readBlockMapping(state, blockIndent, flowIndent)) || readFlowCollection(state, flowIndent)) {
        hasContent = true;
      } else {
        if (allowBlockScalars && readBlockScalar(state, flowIndent) || readSingleQuotedScalar(state, flowIndent) || readDoubleQuotedScalar(state, flowIndent)) {
          hasContent = true;
        } else if (readAlias(state)) {
          hasContent = true;
          if (state.tag !== null || state.anchor !== null) {
            throwError(state, "alias node should not have any properties");
          }
        } else if (readPlainScalar(state, flowIndent, CONTEXT_FLOW_IN === nodeContext)) {
          hasContent = true;
          if (state.tag === null) {
            state.tag = "?";
          }
        }
        if (state.anchor !== null) {
          state.anchorMap[state.anchor] = state.result;
        }
      }
    } else if (indentStatus === 0) {
      hasContent = allowBlockCollections && readBlockSequence(state, blockIndent);
    }
  }
  if (state.tag === null) {
    if (state.anchor !== null) {
      state.anchorMap[state.anchor] = state.result;
    }
  } else if (state.tag === "?") {
    if (state.result !== null && state.kind !== "scalar") {
      throwError(state, 'unacceptable node kind for !<?> tag; it should be "scalar", not "' + state.kind + '"');
    }
    for (typeIndex = 0, typeQuantity = state.implicitTypes.length; typeIndex < typeQuantity; typeIndex += 1) {
      type2 = state.implicitTypes[typeIndex];
      if (type2.resolve(state.result)) {
        state.result = type2.construct(state.result);
        state.tag = type2.tag;
        if (state.anchor !== null) {
          state.anchorMap[state.anchor] = state.result;
        }
        break;
      }
    }
  } else if (state.tag !== "!") {
    if (_hasOwnProperty$1.call(state.typeMap[state.kind || "fallback"], state.tag)) {
      type2 = state.typeMap[state.kind || "fallback"][state.tag];
    } else {
      type2 = null;
      typeList = state.typeMap.multi[state.kind || "fallback"];
      for (typeIndex = 0, typeQuantity = typeList.length; typeIndex < typeQuantity; typeIndex += 1) {
        if (state.tag.slice(0, typeList[typeIndex].tag.length) === typeList[typeIndex].tag) {
          type2 = typeList[typeIndex];
          break;
        }
      }
    }
    if (!type2) {
      throwError(state, "unknown tag !<" + state.tag + ">");
    }
    if (state.result !== null && type2.kind !== state.kind) {
      throwError(state, "unacceptable node kind for !<" + state.tag + '> tag; it should be "' + type2.kind + '", not "' + state.kind + '"');
    }
    if (!type2.resolve(state.result, state.tag)) {
      throwError(state, "cannot resolve a node with !<" + state.tag + "> explicit tag");
    } else {
      state.result = type2.construct(state.result, state.tag);
      if (state.anchor !== null) {
        state.anchorMap[state.anchor] = state.result;
      }
    }
  }
  if (state.listener !== null) {
    state.listener("close", state);
  }
  return state.tag !== null || state.anchor !== null || hasContent;
}
function readDocument(state) {
  var documentStart = state.position, _position, directiveName, directiveArgs, hasDirectives = false, ch;
  state.version = null;
  state.checkLineBreaks = state.legacy;
  state.tagMap = /* @__PURE__ */ Object.create(null);
  state.anchorMap = /* @__PURE__ */ Object.create(null);
  while ((ch = state.input.charCodeAt(state.position)) !== 0) {
    skipSeparationSpace(state, true, -1);
    ch = state.input.charCodeAt(state.position);
    if (state.lineIndent > 0 || ch !== 37) {
      break;
    }
    hasDirectives = true;
    ch = state.input.charCodeAt(++state.position);
    _position = state.position;
    while (ch !== 0 && !is_WS_OR_EOL(ch)) {
      ch = state.input.charCodeAt(++state.position);
    }
    directiveName = state.input.slice(_position, state.position);
    directiveArgs = [];
    if (directiveName.length < 1) {
      throwError(state, "directive name must not be less than one character in length");
    }
    while (ch !== 0) {
      while (is_WHITE_SPACE(ch)) {
        ch = state.input.charCodeAt(++state.position);
      }
      if (ch === 35) {
        do {
          ch = state.input.charCodeAt(++state.position);
        } while (ch !== 0 && !is_EOL(ch));
        break;
      }
      if (is_EOL(ch)) break;
      _position = state.position;
      while (ch !== 0 && !is_WS_OR_EOL(ch)) {
        ch = state.input.charCodeAt(++state.position);
      }
      directiveArgs.push(state.input.slice(_position, state.position));
    }
    if (ch !== 0) readLineBreak(state);
    if (_hasOwnProperty$1.call(directiveHandlers, directiveName)) {
      directiveHandlers[directiveName](state, directiveName, directiveArgs);
    } else {
      throwWarning(state, 'unknown document directive "' + directiveName + '"');
    }
  }
  skipSeparationSpace(state, true, -1);
  if (state.lineIndent === 0 && state.input.charCodeAt(state.position) === 45 && state.input.charCodeAt(state.position + 1) === 45 && state.input.charCodeAt(state.position + 2) === 45) {
    state.position += 3;
    skipSeparationSpace(state, true, -1);
  } else if (hasDirectives) {
    throwError(state, "directives end mark is expected");
  }
  composeNode(state, state.lineIndent - 1, CONTEXT_BLOCK_OUT, false, true);
  skipSeparationSpace(state, true, -1);
  if (state.checkLineBreaks && PATTERN_NON_ASCII_LINE_BREAKS.test(state.input.slice(documentStart, state.position))) {
    throwWarning(state, "non-ASCII line breaks are interpreted as content");
  }
  state.documents.push(state.result);
  if (state.position === state.lineStart && testDocumentSeparator(state)) {
    if (state.input.charCodeAt(state.position) === 46) {
      state.position += 3;
      skipSeparationSpace(state, true, -1);
    }
    return;
  }
  if (state.position < state.length - 1) {
    throwError(state, "end of the stream or a document separator is expected");
  } else {
    return;
  }
}
function loadDocuments(input, options) {
  input = String(input);
  options = options || {};
  if (input.length !== 0) {
    if (input.charCodeAt(input.length - 1) !== 10 && input.charCodeAt(input.length - 1) !== 13) {
      input += "\n";
    }
    if (input.charCodeAt(0) === 65279) {
      input = input.slice(1);
    }
  }
  var state = new State$1(input, options);
  var nullpos = input.indexOf("\0");
  if (nullpos !== -1) {
    state.position = nullpos;
    throwError(state, "null byte is not allowed in input");
  }
  state.input += "\0";
  while (state.input.charCodeAt(state.position) === 32) {
    state.lineIndent += 1;
    state.position += 1;
  }
  while (state.position < state.length - 1) {
    readDocument(state);
  }
  return state.documents;
}
function loadAll$1(input, iterator, options) {
  if (iterator !== null && typeof iterator === "object" && typeof options === "undefined") {
    options = iterator;
    iterator = null;
  }
  var documents = loadDocuments(input, options);
  if (typeof iterator !== "function") {
    return documents;
  }
  for (var index = 0, length = documents.length; index < length; index += 1) {
    iterator(documents[index]);
  }
}
function load$1(input, options) {
  var documents = loadDocuments(input, options);
  if (documents.length === 0) {
    return void 0;
  } else if (documents.length === 1) {
    return documents[0];
  }
  throw new exception("expected a single document in the stream, but found more");
}
var loadAll_1 = loadAll$1;
var load_1 = load$1;
var loader = {
  loadAll: loadAll_1,
  load: load_1
};
var _toString = Object.prototype.toString;
var _hasOwnProperty = Object.prototype.hasOwnProperty;
var CHAR_BOM = 65279;
var CHAR_TAB = 9;
var CHAR_LINE_FEED = 10;
var CHAR_CARRIAGE_RETURN = 13;
var CHAR_SPACE = 32;
var CHAR_EXCLAMATION = 33;
var CHAR_DOUBLE_QUOTE = 34;
var CHAR_SHARP = 35;
var CHAR_PERCENT = 37;
var CHAR_AMPERSAND = 38;
var CHAR_SINGLE_QUOTE = 39;
var CHAR_ASTERISK = 42;
var CHAR_COMMA = 44;
var CHAR_MINUS = 45;
var CHAR_COLON = 58;
var CHAR_EQUALS = 61;
var CHAR_GREATER_THAN = 62;
var CHAR_QUESTION = 63;
var CHAR_COMMERCIAL_AT = 64;
var CHAR_LEFT_SQUARE_BRACKET = 91;
var CHAR_RIGHT_SQUARE_BRACKET = 93;
var CHAR_GRAVE_ACCENT = 96;
var CHAR_LEFT_CURLY_BRACKET = 123;
var CHAR_VERTICAL_LINE = 124;
var CHAR_RIGHT_CURLY_BRACKET = 125;
var ESCAPE_SEQUENCES = {};
ESCAPE_SEQUENCES[0] = "\\0";
ESCAPE_SEQUENCES[7] = "\\a";
ESCAPE_SEQUENCES[8] = "\\b";
ESCAPE_SEQUENCES[9] = "\\t";
ESCAPE_SEQUENCES[10] = "\\n";
ESCAPE_SEQUENCES[11] = "\\v";
ESCAPE_SEQUENCES[12] = "\\f";
ESCAPE_SEQUENCES[13] = "\\r";
ESCAPE_SEQUENCES[27] = "\\e";
ESCAPE_SEQUENCES[34] = '\\"';
ESCAPE_SEQUENCES[92] = "\\\\";
ESCAPE_SEQUENCES[133] = "\\N";
ESCAPE_SEQUENCES[160] = "\\_";
ESCAPE_SEQUENCES[8232] = "\\L";
ESCAPE_SEQUENCES[8233] = "\\P";
var DEPRECATED_BOOLEANS_SYNTAX = [
  "y",
  "Y",
  "yes",
  "Yes",
  "YES",
  "on",
  "On",
  "ON",
  "n",
  "N",
  "no",
  "No",
  "NO",
  "off",
  "Off",
  "OFF"
];
var DEPRECATED_BASE60_SYNTAX = /^[-+]?[0-9_]+(?::[0-9_]+)+(?:\.[0-9_]*)?$/;
function compileStyleMap(schema2, map2) {
  var result, keys, index, length, tag, style, type2;
  if (map2 === null) return {};
  result = {};
  keys = Object.keys(map2);
  for (index = 0, length = keys.length; index < length; index += 1) {
    tag = keys[index];
    style = String(map2[tag]);
    if (tag.slice(0, 2) === "!!") {
      tag = "tag:yaml.org,2002:" + tag.slice(2);
    }
    type2 = schema2.compiledTypeMap["fallback"][tag];
    if (type2 && _hasOwnProperty.call(type2.styleAliases, style)) {
      style = type2.styleAliases[style];
    }
    result[tag] = style;
  }
  return result;
}
function encodeHex(character) {
  var string, handle, length;
  string = character.toString(16).toUpperCase();
  if (character <= 255) {
    handle = "x";
    length = 2;
  } else if (character <= 65535) {
    handle = "u";
    length = 4;
  } else if (character <= 4294967295) {
    handle = "U";
    length = 8;
  } else {
    throw new exception("code point within a string may not be greater than 0xFFFFFFFF");
  }
  return "\\" + handle + common.repeat("0", length - string.length) + string;
}
var QUOTING_TYPE_SINGLE = 1;
var QUOTING_TYPE_DOUBLE = 2;
function State(options) {
  this.schema = options["schema"] || _default;
  this.indent = Math.max(1, options["indent"] || 2);
  this.noArrayIndent = options["noArrayIndent"] || false;
  this.skipInvalid = options["skipInvalid"] || false;
  this.flowLevel = common.isNothing(options["flowLevel"]) ? -1 : options["flowLevel"];
  this.styleMap = compileStyleMap(this.schema, options["styles"] || null);
  this.sortKeys = options["sortKeys"] || false;
  this.lineWidth = options["lineWidth"] || 80;
  this.noRefs = options["noRefs"] || false;
  this.noCompatMode = options["noCompatMode"] || false;
  this.condenseFlow = options["condenseFlow"] || false;
  this.quotingType = options["quotingType"] === '"' ? QUOTING_TYPE_DOUBLE : QUOTING_TYPE_SINGLE;
  this.forceQuotes = options["forceQuotes"] || false;
  this.replacer = typeof options["replacer"] === "function" ? options["replacer"] : null;
  this.implicitTypes = this.schema.compiledImplicit;
  this.explicitTypes = this.schema.compiledExplicit;
  this.tag = null;
  this.result = "";
  this.duplicates = [];
  this.usedDuplicates = null;
}
function indentString(string, spaces) {
  var ind = common.repeat(" ", spaces), position = 0, next = -1, result = "", line, length = string.length;
  while (position < length) {
    next = string.indexOf("\n", position);
    if (next === -1) {
      line = string.slice(position);
      position = length;
    } else {
      line = string.slice(position, next + 1);
      position = next + 1;
    }
    if (line.length && line !== "\n") result += ind;
    result += line;
  }
  return result;
}
function generateNextLine(state, level) {
  return "\n" + common.repeat(" ", state.indent * level);
}
function testImplicitResolving(state, str2) {
  var index, length, type2;
  for (index = 0, length = state.implicitTypes.length; index < length; index += 1) {
    type2 = state.implicitTypes[index];
    if (type2.resolve(str2)) {
      return true;
    }
  }
  return false;
}
function isWhitespace(c) {
  return c === CHAR_SPACE || c === CHAR_TAB;
}
function isPrintable(c) {
  return 32 <= c && c <= 126 || 161 <= c && c <= 55295 && c !== 8232 && c !== 8233 || 57344 <= c && c <= 65533 && c !== CHAR_BOM || 65536 <= c && c <= 1114111;
}
function isNsCharOrWhitespace(c) {
  return isPrintable(c) && c !== CHAR_BOM && c !== CHAR_CARRIAGE_RETURN && c !== CHAR_LINE_FEED;
}
function isPlainSafe(c, prev, inblock) {
  var cIsNsCharOrWhitespace = isNsCharOrWhitespace(c);
  var cIsNsChar = cIsNsCharOrWhitespace && !isWhitespace(c);
  return (
    // ns-plain-safe
    (inblock ? (
      // c = flow-in
      cIsNsCharOrWhitespace
    ) : cIsNsCharOrWhitespace && c !== CHAR_COMMA && c !== CHAR_LEFT_SQUARE_BRACKET && c !== CHAR_RIGHT_SQUARE_BRACKET && c !== CHAR_LEFT_CURLY_BRACKET && c !== CHAR_RIGHT_CURLY_BRACKET) && c !== CHAR_SHARP && !(prev === CHAR_COLON && !cIsNsChar) || isNsCharOrWhitespace(prev) && !isWhitespace(prev) && c === CHAR_SHARP || prev === CHAR_COLON && cIsNsChar
  );
}
function isPlainSafeFirst(c) {
  return isPrintable(c) && c !== CHAR_BOM && !isWhitespace(c) && c !== CHAR_MINUS && c !== CHAR_QUESTION && c !== CHAR_COLON && c !== CHAR_COMMA && c !== CHAR_LEFT_SQUARE_BRACKET && c !== CHAR_RIGHT_SQUARE_BRACKET && c !== CHAR_LEFT_CURLY_BRACKET && c !== CHAR_RIGHT_CURLY_BRACKET && c !== CHAR_SHARP && c !== CHAR_AMPERSAND && c !== CHAR_ASTERISK && c !== CHAR_EXCLAMATION && c !== CHAR_VERTICAL_LINE && c !== CHAR_EQUALS && c !== CHAR_GREATER_THAN && c !== CHAR_SINGLE_QUOTE && c !== CHAR_DOUBLE_QUOTE && c !== CHAR_PERCENT && c !== CHAR_COMMERCIAL_AT && c !== CHAR_GRAVE_ACCENT;
}
function isPlainSafeLast(c) {
  return !isWhitespace(c) && c !== CHAR_COLON;
}
function codePointAt(string, pos) {
  var first = string.charCodeAt(pos), second;
  if (first >= 55296 && first <= 56319 && pos + 1 < string.length) {
    second = string.charCodeAt(pos + 1);
    if (second >= 56320 && second <= 57343) {
      return (first - 55296) * 1024 + second - 56320 + 65536;
    }
  }
  return first;
}
function needIndentIndicator(string) {
  var leadingSpaceRe = /^\n* /;
  return leadingSpaceRe.test(string);
}
var STYLE_PLAIN = 1;
var STYLE_SINGLE = 2;
var STYLE_LITERAL = 3;
var STYLE_FOLDED = 4;
var STYLE_DOUBLE = 5;
function chooseScalarStyle(string, singleLineOnly, indentPerLevel, lineWidth, testAmbiguousType, quotingType, forceQuotes, inblock) {
  var i;
  var char = 0;
  var prevChar = null;
  var hasLineBreak = false;
  var hasFoldableLine = false;
  var shouldTrackWidth = lineWidth !== -1;
  var previousLineBreak = -1;
  var plain = isPlainSafeFirst(codePointAt(string, 0)) && isPlainSafeLast(codePointAt(string, string.length - 1));
  if (singleLineOnly || forceQuotes) {
    for (i = 0; i < string.length; char >= 65536 ? i += 2 : i++) {
      char = codePointAt(string, i);
      if (!isPrintable(char)) {
        return STYLE_DOUBLE;
      }
      plain = plain && isPlainSafe(char, prevChar, inblock);
      prevChar = char;
    }
  } else {
    for (i = 0; i < string.length; char >= 65536 ? i += 2 : i++) {
      char = codePointAt(string, i);
      if (char === CHAR_LINE_FEED) {
        hasLineBreak = true;
        if (shouldTrackWidth) {
          hasFoldableLine = hasFoldableLine || // Foldable line = too long, and not more-indented.
          i - previousLineBreak - 1 > lineWidth && string[previousLineBreak + 1] !== " ";
          previousLineBreak = i;
        }
      } else if (!isPrintable(char)) {
        return STYLE_DOUBLE;
      }
      plain = plain && isPlainSafe(char, prevChar, inblock);
      prevChar = char;
    }
    hasFoldableLine = hasFoldableLine || shouldTrackWidth && (i - previousLineBreak - 1 > lineWidth && string[previousLineBreak + 1] !== " ");
  }
  if (!hasLineBreak && !hasFoldableLine) {
    if (plain && !forceQuotes && !testAmbiguousType(string)) {
      return STYLE_PLAIN;
    }
    return quotingType === QUOTING_TYPE_DOUBLE ? STYLE_DOUBLE : STYLE_SINGLE;
  }
  if (indentPerLevel > 9 && needIndentIndicator(string)) {
    return STYLE_DOUBLE;
  }
  if (!forceQuotes) {
    return hasFoldableLine ? STYLE_FOLDED : STYLE_LITERAL;
  }
  return quotingType === QUOTING_TYPE_DOUBLE ? STYLE_DOUBLE : STYLE_SINGLE;
}
function writeScalar(state, string, level, iskey, inblock) {
  state.dump = function() {
    if (string.length === 0) {
      return state.quotingType === QUOTING_TYPE_DOUBLE ? '""' : "''";
    }
    if (!state.noCompatMode) {
      if (DEPRECATED_BOOLEANS_SYNTAX.indexOf(string) !== -1 || DEPRECATED_BASE60_SYNTAX.test(string)) {
        return state.quotingType === QUOTING_TYPE_DOUBLE ? '"' + string + '"' : "'" + string + "'";
      }
    }
    var indent = state.indent * Math.max(1, level);
    var lineWidth = state.lineWidth === -1 ? -1 : Math.max(Math.min(state.lineWidth, 40), state.lineWidth - indent);
    var singleLineOnly = iskey || state.flowLevel > -1 && level >= state.flowLevel;
    function testAmbiguity(string2) {
      return testImplicitResolving(state, string2);
    }
    switch (chooseScalarStyle(
      string,
      singleLineOnly,
      state.indent,
      lineWidth,
      testAmbiguity,
      state.quotingType,
      state.forceQuotes && !iskey,
      inblock
    )) {
      case STYLE_PLAIN:
        return string;
      case STYLE_SINGLE:
        return "'" + string.replace(/'/g, "''") + "'";
      case STYLE_LITERAL:
        return "|" + blockHeader(string, state.indent) + dropEndingNewline(indentString(string, indent));
      case STYLE_FOLDED:
        return ">" + blockHeader(string, state.indent) + dropEndingNewline(indentString(foldString(string, lineWidth), indent));
      case STYLE_DOUBLE:
        return '"' + escapeString(string) + '"';
      default:
        throw new exception("impossible error: invalid scalar style");
    }
  }();
}
function blockHeader(string, indentPerLevel) {
  var indentIndicator = needIndentIndicator(string) ? String(indentPerLevel) : "";
  var clip = string[string.length - 1] === "\n";
  var keep = clip && (string[string.length - 2] === "\n" || string === "\n");
  var chomp = keep ? "+" : clip ? "" : "-";
  return indentIndicator + chomp + "\n";
}
function dropEndingNewline(string) {
  return string[string.length - 1] === "\n" ? string.slice(0, -1) : string;
}
function foldString(string, width) {
  var lineRe = /(\n+)([^\n]*)/g;
  var result = function() {
    var nextLF = string.indexOf("\n");
    nextLF = nextLF !== -1 ? nextLF : string.length;
    lineRe.lastIndex = nextLF;
    return foldLine(string.slice(0, nextLF), width);
  }();
  var prevMoreIndented = string[0] === "\n" || string[0] === " ";
  var moreIndented;
  var match;
  while (match = lineRe.exec(string)) {
    var prefix = match[1], line = match[2];
    moreIndented = line[0] === " ";
    result += prefix + (!prevMoreIndented && !moreIndented && line !== "" ? "\n" : "") + foldLine(line, width);
    prevMoreIndented = moreIndented;
  }
  return result;
}
function foldLine(line, width) {
  if (line === "" || line[0] === " ") return line;
  var breakRe = / [^ ]/g;
  var match;
  var start = 0, end, curr = 0, next = 0;
  var result = "";
  while (match = breakRe.exec(line)) {
    next = match.index;
    if (next - start > width) {
      end = curr > start ? curr : next;
      result += "\n" + line.slice(start, end);
      start = end + 1;
    }
    curr = next;
  }
  result += "\n";
  if (line.length - start > width && curr > start) {
    result += line.slice(start, curr) + "\n" + line.slice(curr + 1);
  } else {
    result += line.slice(start);
  }
  return result.slice(1);
}
function escapeString(string) {
  var result = "";
  var char = 0;
  var escapeSeq;
  for (var i = 0; i < string.length; char >= 65536 ? i += 2 : i++) {
    char = codePointAt(string, i);
    escapeSeq = ESCAPE_SEQUENCES[char];
    if (!escapeSeq && isPrintable(char)) {
      result += string[i];
      if (char >= 65536) result += string[i + 1];
    } else {
      result += escapeSeq || encodeHex(char);
    }
  }
  return result;
}
function writeFlowSequence(state, level, object) {
  var _result = "", _tag = state.tag, index, length, value;
  for (index = 0, length = object.length; index < length; index += 1) {
    value = object[index];
    if (state.replacer) {
      value = state.replacer.call(object, String(index), value);
    }
    if (writeNode(state, level, value, false, false) || typeof value === "undefined" && writeNode(state, level, null, false, false)) {
      if (_result !== "") _result += "," + (!state.condenseFlow ? " " : "");
      _result += state.dump;
    }
  }
  state.tag = _tag;
  state.dump = "[" + _result + "]";
}
function writeBlockSequence(state, level, object, compact) {
  var _result = "", _tag = state.tag, index, length, value;
  for (index = 0, length = object.length; index < length; index += 1) {
    value = object[index];
    if (state.replacer) {
      value = state.replacer.call(object, String(index), value);
    }
    if (writeNode(state, level + 1, value, true, true, false, true) || typeof value === "undefined" && writeNode(state, level + 1, null, true, true, false, true)) {
      if (!compact || _result !== "") {
        _result += generateNextLine(state, level);
      }
      if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
        _result += "-";
      } else {
        _result += "- ";
      }
      _result += state.dump;
    }
  }
  state.tag = _tag;
  state.dump = _result || "[]";
}
function writeFlowMapping(state, level, object) {
  var _result = "", _tag = state.tag, objectKeyList = Object.keys(object), index, length, objectKey, objectValue, pairBuffer;
  for (index = 0, length = objectKeyList.length; index < length; index += 1) {
    pairBuffer = "";
    if (_result !== "") pairBuffer += ", ";
    if (state.condenseFlow) pairBuffer += '"';
    objectKey = objectKeyList[index];
    objectValue = object[objectKey];
    if (state.replacer) {
      objectValue = state.replacer.call(object, objectKey, objectValue);
    }
    if (!writeNode(state, level, objectKey, false, false)) {
      continue;
    }
    if (state.dump.length > 1024) pairBuffer += "? ";
    pairBuffer += state.dump + (state.condenseFlow ? '"' : "") + ":" + (state.condenseFlow ? "" : " ");
    if (!writeNode(state, level, objectValue, false, false)) {
      continue;
    }
    pairBuffer += state.dump;
    _result += pairBuffer;
  }
  state.tag = _tag;
  state.dump = "{" + _result + "}";
}
function writeBlockMapping(state, level, object, compact) {
  var _result = "", _tag = state.tag, objectKeyList = Object.keys(object), index, length, objectKey, objectValue, explicitPair, pairBuffer;
  if (state.sortKeys === true) {
    objectKeyList.sort();
  } else if (typeof state.sortKeys === "function") {
    objectKeyList.sort(state.sortKeys);
  } else if (state.sortKeys) {
    throw new exception("sortKeys must be a boolean or a function");
  }
  for (index = 0, length = objectKeyList.length; index < length; index += 1) {
    pairBuffer = "";
    if (!compact || _result !== "") {
      pairBuffer += generateNextLine(state, level);
    }
    objectKey = objectKeyList[index];
    objectValue = object[objectKey];
    if (state.replacer) {
      objectValue = state.replacer.call(object, objectKey, objectValue);
    }
    if (!writeNode(state, level + 1, objectKey, true, true, true)) {
      continue;
    }
    explicitPair = state.tag !== null && state.tag !== "?" || state.dump && state.dump.length > 1024;
    if (explicitPair) {
      if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
        pairBuffer += "?";
      } else {
        pairBuffer += "? ";
      }
    }
    pairBuffer += state.dump;
    if (explicitPair) {
      pairBuffer += generateNextLine(state, level);
    }
    if (!writeNode(state, level + 1, objectValue, true, explicitPair)) {
      continue;
    }
    if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
      pairBuffer += ":";
    } else {
      pairBuffer += ": ";
    }
    pairBuffer += state.dump;
    _result += pairBuffer;
  }
  state.tag = _tag;
  state.dump = _result || "{}";
}
function detectType(state, object, explicit) {
  var _result, typeList, index, length, type2, style;
  typeList = explicit ? state.explicitTypes : state.implicitTypes;
  for (index = 0, length = typeList.length; index < length; index += 1) {
    type2 = typeList[index];
    if ((type2.instanceOf || type2.predicate) && (!type2.instanceOf || typeof object === "object" && object instanceof type2.instanceOf) && (!type2.predicate || type2.predicate(object))) {
      if (explicit) {
        if (type2.multi && type2.representName) {
          state.tag = type2.representName(object);
        } else {
          state.tag = type2.tag;
        }
      } else {
        state.tag = "?";
      }
      if (type2.represent) {
        style = state.styleMap[type2.tag] || type2.defaultStyle;
        if (_toString.call(type2.represent) === "[object Function]") {
          _result = type2.represent(object, style);
        } else if (_hasOwnProperty.call(type2.represent, style)) {
          _result = type2.represent[style](object, style);
        } else {
          throw new exception("!<" + type2.tag + '> tag resolver accepts not "' + style + '" style');
        }
        state.dump = _result;
      }
      return true;
    }
  }
  return false;
}
function writeNode(state, level, object, block, compact, iskey, isblockseq) {
  state.tag = null;
  state.dump = object;
  if (!detectType(state, object, false)) {
    detectType(state, object, true);
  }
  var type2 = _toString.call(state.dump);
  var inblock = block;
  var tagStr;
  if (block) {
    block = state.flowLevel < 0 || state.flowLevel > level;
  }
  var objectOrArray = type2 === "[object Object]" || type2 === "[object Array]", duplicateIndex, duplicate;
  if (objectOrArray) {
    duplicateIndex = state.duplicates.indexOf(object);
    duplicate = duplicateIndex !== -1;
  }
  if (state.tag !== null && state.tag !== "?" || duplicate || state.indent !== 2 && level > 0) {
    compact = false;
  }
  if (duplicate && state.usedDuplicates[duplicateIndex]) {
    state.dump = "*ref_" + duplicateIndex;
  } else {
    if (objectOrArray && duplicate && !state.usedDuplicates[duplicateIndex]) {
      state.usedDuplicates[duplicateIndex] = true;
    }
    if (type2 === "[object Object]") {
      if (block && Object.keys(state.dump).length !== 0) {
        writeBlockMapping(state, level, state.dump, compact);
        if (duplicate) {
          state.dump = "&ref_" + duplicateIndex + state.dump;
        }
      } else {
        writeFlowMapping(state, level, state.dump);
        if (duplicate) {
          state.dump = "&ref_" + duplicateIndex + " " + state.dump;
        }
      }
    } else if (type2 === "[object Array]") {
      if (block && state.dump.length !== 0) {
        if (state.noArrayIndent && !isblockseq && level > 0) {
          writeBlockSequence(state, level - 1, state.dump, compact);
        } else {
          writeBlockSequence(state, level, state.dump, compact);
        }
        if (duplicate) {
          state.dump = "&ref_" + duplicateIndex + state.dump;
        }
      } else {
        writeFlowSequence(state, level, state.dump);
        if (duplicate) {
          state.dump = "&ref_" + duplicateIndex + " " + state.dump;
        }
      }
    } else if (type2 === "[object String]") {
      if (state.tag !== "?") {
        writeScalar(state, state.dump, level, iskey, inblock);
      }
    } else if (type2 === "[object Undefined]") {
      return false;
    } else {
      if (state.skipInvalid) return false;
      throw new exception("unacceptable kind of an object to dump " + type2);
    }
    if (state.tag !== null && state.tag !== "?") {
      tagStr = encodeURI(
        state.tag[0] === "!" ? state.tag.slice(1) : state.tag
      ).replace(/!/g, "%21");
      if (state.tag[0] === "!") {
        tagStr = "!" + tagStr;
      } else if (tagStr.slice(0, 18) === "tag:yaml.org,2002:") {
        tagStr = "!!" + tagStr.slice(18);
      } else {
        tagStr = "!<" + tagStr + ">";
      }
      state.dump = tagStr + " " + state.dump;
    }
  }
  return true;
}
function getDuplicateReferences(object, state) {
  var objects = [], duplicatesIndexes = [], index, length;
  inspectNode(object, objects, duplicatesIndexes);
  for (index = 0, length = duplicatesIndexes.length; index < length; index += 1) {
    state.duplicates.push(objects[duplicatesIndexes[index]]);
  }
  state.usedDuplicates = new Array(length);
}
function inspectNode(object, objects, duplicatesIndexes) {
  var objectKeyList, index, length;
  if (object !== null && typeof object === "object") {
    index = objects.indexOf(object);
    if (index !== -1) {
      if (duplicatesIndexes.indexOf(index) === -1) {
        duplicatesIndexes.push(index);
      }
    } else {
      objects.push(object);
      if (Array.isArray(object)) {
        for (index = 0, length = object.length; index < length; index += 1) {
          inspectNode(object[index], objects, duplicatesIndexes);
        }
      } else {
        objectKeyList = Object.keys(object);
        for (index = 0, length = objectKeyList.length; index < length; index += 1) {
          inspectNode(object[objectKeyList[index]], objects, duplicatesIndexes);
        }
      }
    }
  }
}
function dump$1(input, options) {
  options = options || {};
  var state = new State(options);
  if (!state.noRefs) getDuplicateReferences(input, state);
  var value = input;
  if (state.replacer) {
    value = state.replacer.call({ "": value }, "", value);
  }
  if (writeNode(state, 0, value, true, true)) return state.dump + "\n";
  return "";
}
var dump_1 = dump$1;
var dumper = {
  dump: dump_1
};
function renamed(from, to) {
  return function() {
    throw new Error("Function yaml." + from + " is removed in js-yaml 4. Use yaml." + to + " instead, which is now safe by default.");
  };
}
var Type = type;
var Schema = schema;
var FAILSAFE_SCHEMA = failsafe;
var JSON_SCHEMA = json;
var CORE_SCHEMA = core;
var DEFAULT_SCHEMA = _default;
var load = loader.load;
var loadAll = loader.loadAll;
var dump = dumper.dump;
var YAMLException = exception;
var types = {
  binary,
  float,
  map,
  null: _null,
  pairs,
  set,
  timestamp,
  bool,
  int,
  merge,
  omap,
  seq,
  str
};
var safeLoad = renamed("safeLoad", "load");
var safeLoadAll = renamed("safeLoadAll", "loadAll");
var safeDump = renamed("safeDump", "dump");
var jsYaml = {
  Type,
  Schema,
  FAILSAFE_SCHEMA,
  JSON_SCHEMA,
  CORE_SCHEMA,
  DEFAULT_SCHEMA,
  load,
  loadAll,
  dump,
  YAMLException,
  types,
  safeLoad,
  safeLoadAll,
  safeDump
};

// src/lib/runtime-options.mjs
var DEFAULT_CONFIG = {
  mode: "plan",
  model: "gpt-5.4",
  // Default reasoning effort for execute turns. Plan turns are always forced
  // to "xhigh" regardless (plan is a bounded reasoning exercise; more effort
  // is always worth it there). For execute turns the historical default was
  // "high", but live delegations on non-trivial scaffolding (multi-file
  // ports, cross-module refactors) consistently benefited from "xhigh" —
  // the wall-clock tax is modest relative to the turn budget and the quality
  // uplift is large. "xhigh" is the new default; callers who want a cheaper
  // turn set `effort: "high"` (or lower) in config.yaml or pass
  // `--effort high` at the CLI. Accepted values: none | minimal | low |
  // medium | high | xhigh.
  effort: "xhigh",
  auto_review: true,
  post_task_prompt: [
    "Review your own work critically:",
    "1. Is this task 100% complete?",
    "2. Are there any edge cases you missed?",
    "3. Did you run all relevant tests?",
    "List any unfinished items."
  ].join("\n"),
  allow_questions: true,
  session_dir: "~/.codex-bridge/sessions",
  // Ship with no sandbox by default so Codex can commit its own work without
  // hitting raw POSIX errors on `.git/` writes. Users who want a stricter
  // profile can set `sandbox_policy: "workspace-write"` or `"read-only"` in
  // their config.yaml. Matches `codex --dangerously-bypass-approvals-and-
  // sandbox`. See skill/references/config-reference.md for the full matrix.
  sandbox_policy: "danger-full-access",
  sandbox_enforce: false,
  forbid_codex_direct: true,
  // When true, prepend a strong orchestrator directive telling Codex to skip
  // any internal planning / ceremony / meta-skill chains it would normally
  // walk before execution (framework-agnostic — covers any skill that
  // produces spec/plan scaffolding under `docs/`, `plans/`, or similar paths
  // before touching the deliverable). Codex's default skill chains routinely
  // spend many minutes producing such scaffolding that isn't part of the
  // task when an orchestrator is already driving the plan/execute loop.
  // Advisory — Codex may still invoke its own skills; this measurably
  // reduces the rate.
  skip_meta_skills: true,
  // When true, monitor repeated same-family command failures (osascript,
  // open -a, display dialog, computer-use/*, AppleScript) and emit a
  // [WARNING] event to `.events` once the threshold (N=3 consecutive) is
  // hit. An orchestrator tailing via Monitor can catch the warning and
  // decide to cancel/steer before Codex burns token budget iterating over
  // headless-environment probes. Logging-only today; auto-interrupt would
  // require a new post-turn-start hook exposing `turnId`. See
  // config-reference.md for the threshold, family list, and enhancement
  // candidates.
  command_failure_circuit_breaker: true,
  // Max wall-clock gap between app-server notifications before a turn is
  // declared stuck and failed with `ClientTimeout`. The prior 120s hard-code
  // was tuned for execute-heavy turns and would false-positive during
  // reasoning-heavy windows (e.g. Codex planning across many files between
  // `item.completed` notifications). 300s covers observed reasoning gaps
  // without masking genuine stalls. Override per-project in config.yaml;
  // per-invocation override via `--idle-timeout-ms <ms>` on `task` / `send`.
  idle_timeout_ms: 3e5,
  // Wall-clock ceiling per Codex turn, distinct from the idle gap. Plan
  // turns get a shorter budget because they're bounded reasoning jobs;
  // execute turns need more because they actually change code. Both are
  // overridable via --turn-plan-ms / --turn-default-ms on task (or
  // --turn-timeout-ms on send, which resolves to the applicable one). Pre-
  // 1.2.5 these were hard-coded; a big scaffold that legitimately needed
  // >10 min (e.g. a multi-file Swift/Xcode bootstrap with SPM resolution)
  // hit the ceiling and Codex was interrupted mid-task.
  // v1.3.0: turn budgets are 30 min minimum on every code path.
  // Pre-1.3.0 the plan budget was 5 min and the execute budget was 10 min;
  // both routinely killed live work mid-task with Codex still actively
  // reasoning or writing (the swift-vibescroll Phase 1 / Phase 2 pattern).
  // Raising both to 30 min removes the entire class of "bridge hard-
  // interrupted my task" bug. Short edits still complete in seconds — the
  // ceiling only kicks in when Codex is genuinely still working. The
  // ceiling is not the primary "something is actually wrong" detector —
  // that's the idle watchdog (idle_timeout_ms, 5 min) and the heartbeat /
  // finally-backstop observability guarantees. The turn budget is a
  // safety net past those, not a throttle.
  turn_plan_ms: 18e5,
  turn_default_ms: 18e5,
  // Auto-pipeline budgets — per-stage (review / fix / check) and total.
  // Pre-1.2.5 both were hard-coded in auto-pipeline.mjs; long native reviews
  // on ~60-file diffs could blow the stage ceiling without any escape hatch.
  pipeline_stage_ms: 3e5,
  pipeline_total_ms: 9e5,
  // How long `requestUserInput` waits for a human/orchestrator to answer
  // before rejecting the server request. Five minutes is tight for thoughtful
  // decisions; make it configurable so a slow loop can widen the window
  // without silently coercing the turn into a no-op answer.
  question_answer_ms: 3e5,
  artifact_retention_jobs: 50,
  artifact_retention_days: 30,
  redact_secrets: false,
  prompt_footer: "When you need to ask a question to user, always use the request_user_input tool with distinct options to help the user navigate choices. Never ask questions as plain text messages."
};
function resolveEffort(config, options = {}) {
  return options.effort ?? config.effort ?? "high";
}
function resolveModel(config, options = {}) {
  return options.model ?? config.model ?? DEFAULT_CONFIG.model;
}
function buildCollaborationMode(mode, config, options = {}) {
  if (!mode) {
    return null;
  }
  const effort = mode === "plan" ? "xhigh" : resolveEffort(config, options);
  return {
    mode,
    settings: {
      model: resolveModel(config, options),
      reasoning_effort: effort,
      developer_instructions: options.developerInstructions ?? null
    }
  };
}
var VALID_SANDBOX_POLICY_OVERRIDES = /* @__PURE__ */ new Set([
  "danger-full-access",
  "workspace-write",
  "read-only"
]);
function buildSandboxPolicy(mode, config = {}) {
  const override = config?.sandbox_policy;
  if (override != null && !VALID_SANDBOX_POLICY_OVERRIDES.has(override)) {
  } else if (override === "danger-full-access") {
    return { type: "dangerFullAccess" };
  } else if (override === "workspace-write") {
    return { type: "workspaceWrite" };
  } else if (override === "read-only") {
    return { type: "readOnly" };
  }
  if (mode === "default") {
    return { type: "workspaceWrite" };
  }
  return { type: "readOnly" };
}
var COMPLETION_CHECK_SCHEMA = {
  type: "object",
  properties: {
    complete: { type: "boolean" },
    missing_items: {
      type: "array",
      items: { type: "string" }
    },
    summary: { type: "string" }
  },
  required: ["complete", "missing_items", "summary"],
  additionalProperties: false
};

// src/lib/config.mjs
var CONFIG_SCHEMA = {
  mode: { type: "enum", values: ["plan", "default"] },
  model: { type: "string" },
  effort: { type: "enum", values: ["none", "minimal", "low", "medium", "high", "xhigh"] },
  auto_review: { type: "boolean" },
  post_task_prompt: { type: "string" },
  allow_questions: { type: "boolean" },
  session_dir: { type: "string" },
  sandbox_policy: { type: "enum", values: ["danger-full-access", "workspace-write", "read-only"] },
  sandbox_enforce: { type: "boolean" },
  forbid_codex_direct: { type: "boolean" },
  skip_meta_skills: { type: "boolean" },
  command_failure_circuit_breaker: { type: "boolean" },
  idle_timeout_ms: { type: "positive-number" },
  turn_plan_ms: { type: "positive-number" },
  turn_default_ms: { type: "positive-number" },
  pipeline_stage_ms: { type: "positive-number" },
  pipeline_total_ms: { type: "positive-number" },
  question_answer_ms: { type: "positive-number" },
  artifact_retention_jobs: { type: "positive-number" },
  artifact_retention_days: { type: "positive-number" },
  redact_secrets: { type: "boolean" },
  prompt_footer: { type: "string" },
  default_backend: { type: "string" },
  adapter_routing: { type: "object" }
};
function isConfigValueValid(schema2, value) {
  return schema2.type === "string" ? typeof value === "string" : schema2.type === "boolean" ? typeof value === "boolean" : schema2.type === "object" ? value && typeof value === "object" && !Array.isArray(value) : schema2.type === "positive-number" ? Number(value) > 0 : schema2.type === "enum" ? typeof value === "string" && schema2.values.includes(value) : true;
}
function parseConfigFile(filePath, source) {
  if (!filePath || !fs10.existsSync(filePath)) {
    return { config: {}, diagnostics: [] };
  }
  try {
    const raw = fs10.readFileSync(filePath, "utf8");
    const doc = jsYaml.load(raw) ?? {};
    const bridge = doc.codex_bridge ?? doc;
    return {
      config: typeof bridge === "object" && bridge !== null ? bridge : {},
      diagnostics: []
    };
  } catch (error) {
    return {
      config: {},
      diagnostics: [{
        severity: "error",
        code: "CONFIG_PARSE_ERROR",
        source,
        path: filePath,
        key: null,
        message: `Could not read or parse config.yaml; this layer was ignored (${error?.message ?? error}).`
      }]
    };
  }
}
function validateConfigLayer(layer, source, pathValue) {
  const diagnostics = [];
  if (!layer || typeof layer !== "object") return diagnostics;
  for (const [key, value] of Object.entries(layer)) {
    const schema2 = CONFIG_SCHEMA[key];
    if (!schema2) {
      diagnostics.push({
        severity: "warning",
        code: "CONFIG_UNKNOWN_KEY",
        source,
        path: pathValue,
        key,
        message: `Unknown config key '${key}' will be ignored by current runtime paths.`
      });
      continue;
    }
    if (!isConfigValueValid(schema2, value)) {
      diagnostics.push({
        severity: "error",
        code: "CONFIG_INVALID_VALUE",
        source,
        path: pathValue,
        key,
        message: schema2.type === "enum" ? `Invalid value for '${key}'; expected one of: ${schema2.values.join(", ")}.` : `Invalid value for '${key}'; expected ${schema2.type}.`
      });
    }
  }
  return diagnostics;
}
function sanitizeConfigLayer(layer) {
  const sanitized = {};
  if (!layer || typeof layer !== "object") return sanitized;
  for (const [key, value] of Object.entries(layer)) {
    const schema2 = CONFIG_SCHEMA[key];
    if (!schema2 || !isConfigValueValid(schema2, value)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}
function configPaths(skillDir, overrideDir = null, workspaceRoot = null) {
  const skillConfigPath = skillDir ? path8.join(skillDir, "config.yaml") : path8.join(os4.homedir(), ".codex-bridge", "config.yaml");
  const workspaceConfigPath = workspaceRoot && workspaceRoot !== overrideDir ? path8.join(workspaceRoot, "config.yaml") : null;
  const overrideConfigPath = overrideDir ? path8.join(overrideDir, "config.yaml") : null;
  return { skillConfigPath, workspaceConfigPath, overrideConfigPath };
}
function loadConfigLayers(skillDir, overrideDir = null, workspaceRoot = null) {
  const { skillConfigPath, workspaceConfigPath, overrideConfigPath } = configPaths(skillDir, overrideDir, workspaceRoot);
  const skillParsed = parseConfigFile(skillConfigPath, "skill-dir");
  const skillLayer = skillParsed.config;
  const workspaceParsed = workspaceConfigPath ? parseConfigFile(workspaceConfigPath, "workspace-root") : { config: {}, diagnostics: [] };
  const workspaceLayer = workspaceParsed.config;
  const overrideParsed = overrideConfigPath ? parseConfigFile(overrideConfigPath, "cwd") : { config: {}, diagnostics: [] };
  const overrideLayer = overrideParsed.config;
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...sanitizeConfigLayer(skillLayer),
    ...sanitizeConfigLayer(workspaceLayer),
    ...sanitizeConfigLayer(overrideLayer)
  };
  return {
    defaults: DEFAULT_CONFIG,
    skillConfig: sanitizeConfigLayer(skillLayer),
    workspaceConfig: sanitizeConfigLayer(workspaceLayer),
    cwdConfig: sanitizeConfigLayer(overrideLayer),
    mergedConfig,
    sources: {
      skillConfigPath,
      skillConfigExists: fs10.existsSync(skillConfigPath),
      workspaceConfigPath,
      workspaceConfigExists: workspaceConfigPath ? fs10.existsSync(workspaceConfigPath) : false,
      overrideConfigPath,
      overrideConfigExists: overrideConfigPath ? fs10.existsSync(overrideConfigPath) : false
    },
    diagnostics: [
      ...skillParsed.diagnostics,
      ...validateConfigLayer(skillLayer, "skill-dir", skillConfigPath),
      ...workspaceParsed.diagnostics,
      ...validateConfigLayer(workspaceLayer, "workspace-root", workspaceConfigPath),
      ...overrideParsed.diagnostics,
      ...validateConfigLayer(overrideLayer, "cwd", overrideConfigPath)
    ]
  };
}
function loadConfig(skillDir, overrideDir = null, workspaceRoot = null) {
  return loadConfigLayers(skillDir, overrideDir, workspaceRoot).mergedConfig;
}
function resolveConfigSources(skillDir, overrideDir = null, workspaceRoot = null) {
  return loadConfigLayers(skillDir, overrideDir, workspaceRoot).sources;
}
function validateConfigLayers(skillDir, overrideDir = null, workspaceRoot = null) {
  return loadConfigLayers(skillDir, overrideDir, workspaceRoot).diagnostics;
}

// src/adapters/codex/index.mjs
function buildCapabilities() {
  return Object.freeze({
    supports_plan_mode: true,
    supports_questions: true,
    supports_streaming: true,
    supports_resume: true,
    supports_steering: true,
    supports_background: true,
    supports_auto_pipeline: true,
    supports_adversarial_review: true,
    supports_worktree: true,
    supports_artifact_registry: true,
    input_modalities: ["text"],
    output_modalities: ["text", "diff", "structured"],
    max_prompt_chars: 512e3,
    billing_model: "subscription",
    auth_strategy: "oauth-cli",
    transport: "json-rpc-unix-socket"
  });
}
var defaultRuntime = Object.freeze({
  async runTurn(cwd, options) {
    return runAppServerTurn(cwd, options);
  },
  async steerTurn(cwd, { threadId, turnId, prompt }) {
    await withAppServer(cwd, async (client) => {
      await client.request("turn/steer", {
        threadId,
        input: [{ type: "text", text: prompt }],
        expectedTurnId: turnId
      });
    });
    return { ok: true, threadId, turnId };
  },
  async interruptTurn(cwd, { threadId, turnId }) {
    return interruptAppServerTurn(cwd, { threadId, turnId });
  }
});
var runtime = defaultRuntime;
function normalizeAdapterOptions(options = {}) {
  return options && typeof options === "object" && !Array.isArray(options) ? options : {};
}
function defaultSessionDirForCwd(cwd) {
  const config = getConfig(cwd);
  return resolveSessionDir(config.session_dir ?? DEFAULT_CONFIG.session_dir);
}
function buildTurnOptions(prompt, options) {
  const adapterOptions = normalizeAdapterOptions(options.adapterOptions);
  const turnOptions = {
    ...normalizeAdapterOptions(adapterOptions.turnOptions)
  };
  if (options.resumeThreadId && !turnOptions.resumeThreadId) {
    turnOptions.resumeThreadId = options.resumeThreadId;
  }
  if (options.model && !turnOptions.model) {
    turnOptions.model = options.model;
  }
  if (options.effort && !turnOptions.effort) {
    turnOptions.effort = options.effort;
  }
  if (Number(options.timeoutMs) > 0 && !turnOptions.turnTimeoutMs) {
    turnOptions.turnTimeoutMs = Number(options.timeoutMs);
  }
  return {
    ...turnOptions,
    prompt
  };
}
function eventTagForLine(line) {
  const terminal = TERMINAL_TAG_REGEX.exec(line);
  if (terminal) return terminal[1];
  const generic = /^\[([^\]]+)\]/.exec(line);
  return generic?.[1] ?? "ADAPTER:codex:event";
}
async function dispatch(prompt, options = {}) {
  const normalized = normalizeAdapterOptions(options);
  const cwd = normalized.cwd ?? process8.cwd();
  const sessionDir = normalized.sessionDir ?? defaultSessionDirForCwd(cwd);
  const result = await runtime.runTurn(cwd, buildTurnOptions(prompt, normalized));
  return {
    jobId: normalized.jobId ?? result.threadId ?? null,
    threadId: result.threadId ?? null,
    turnId: result.turnId ?? null,
    sessionDir,
    capabilities: buildCapabilities(),
    status: result.status,
    rawResult: result
  };
}
async function resume(threadId, prompt, options = {}) {
  const normalized = normalizeAdapterOptions(options);
  return dispatch(prompt, {
    ...normalized,
    resumeThreadId: threadId,
    adapterOptions: {
      ...normalizeAdapterOptions(normalized.adapterOptions),
      turnOptions: {
        ...normalizeAdapterOptions(normalized.adapterOptions?.turnOptions),
        resumeThreadId: threadId
      }
    }
  });
}
async function steer(threadId, turnId, prompt, options = {}) {
  const cwd = normalizeAdapterOptions(options).cwd ?? process8.cwd();
  return runtime.steerTurn(cwd, { threadId, turnId, prompt });
}
async function respond(_threadOrJobId, requestId, answer, options = {}) {
  const normalized = normalizeAdapterOptions(options);
  if (!normalized.sessionDir) {
    const err = new Error("codex adapter respond requires options.sessionDir");
    err.code = "PENDING_REQUEST_SESSION_DIR_REQUIRED";
    throw err;
  }
  const pending = readPendingRequestById(normalized.sessionDir, requestId);
  if (!pending) {
    const err = new Error(`No pending request found: ${requestId}.`);
    err.code = "PENDING_REQUEST_NOT_FOUND";
    throw err;
  }
  writeResponseFile(normalized.sessionDir, pending.threadId, {
    requestId: pending.internalId,
    rpcRequestId: pending.rpcRequestId,
    payload: answer
  });
  return {
    ok: true,
    requestId,
    threadId: pending.threadId
  };
}
async function cancel(_jobId, options = {}) {
  const normalized = normalizeAdapterOptions(options);
  const result = await runtime.interruptTurn(normalized.cwd ?? process8.cwd(), {
    threadId: normalized.threadId ?? null,
    turnId: normalized.turnId ?? null
  });
  return {
    ok: result.interrupted !== false,
    attempted: Boolean(result.attempted),
    interrupted: Boolean(result.interrupted),
    reason: result.detail ?? null
  };
}
async function getResult(jobId, options = {}) {
  const normalized = normalizeAdapterOptions(options);
  const cwd = normalized.cwd ?? process8.cwd();
  const { workspaceRoot, job } = resolveResultJob(cwd, jobId);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const exitCode = job.status === "completed" ? 0 : 1;
  return {
    jobId: job.id,
    threadId: job.threadId ?? storedJob?.threadId ?? null,
    phase: job.phase ?? storedJob?.phase ?? job.status ?? "error",
    exitCode,
    terminalTag: job.status === "completed" ? "DONE" : job.status === "cancelled" ? "ERROR" : null,
    summary: job.summary ?? storedJob?.summary ?? null,
    artifacts: storedJob?.result?.artifacts ?? {},
    raw: { job, storedJob }
  };
}
async function* streamEvents(jobId, optionsOrSignal = {}) {
  const options = optionsOrSignal instanceof AbortSignal ? { signal: optionsOrSignal } : normalizeAdapterOptions(optionsOrSignal);
  const cwd = options.cwd ?? process8.cwd();
  const snapshot = buildSingleJobSnapshot(cwd, jobId);
  const threadId = snapshot.job.threadId;
  if (!threadId) {
    const err = new Error(`Job ${snapshot.job.id} has no thread id yet.`);
    err.code = "JOB_HAS_NO_THREAD";
    throw err;
  }
  const sessionDir = options.sessionDir ?? defaultSessionDirForCwd(cwd);
  const eventsPath = options.eventsPath ?? path9.join(sessionDir, `${threadId}.events`);
  const content = fs11.readFileSync(eventsPath, "utf8");
  for (const line of content.split(/\r?\n/).filter(Boolean)) {
    if (options.signal?.aborted) return;
    yield {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      tag: eventTagForLine(line),
      origin: "bridge",
      data: { line, eventsPath },
      raw: line
    };
  }
}
var adapter = {
  name: "codex",
  displayName: "OpenAI Codex",
  capabilities: buildCapabilities,
  validateConfig(_config) {
    return { valid: true, errors: [] };
  },
  dispatch,
  streamEvents,
  getResult,
  cancel,
  respond,
  resume,
  steer
};
var codex_default = adapter;

// src/adapters/index.mjs
var REQUIRED_FIELDS = ["name", "displayName"];
var REQUIRED_METHODS = ["capabilities", "validateConfig", "dispatch", "streamEvents", "getResult", "cancel"];
var OPTIONAL_CAPABILITY_METHODS = Object.freeze({
  supports_questions: "respond",
  supports_resume: "resume",
  supports_steering: "steer"
});
var ADAPTER_LOADERS = {
  codex: () => codex_default
};
var BACKEND_ENV_VAR = "CODEX_BRIDGE_BACKEND";
var KNOWN_ADAPTERS = Object.keys(ADAPTER_LOADERS);
var adapterCache = /* @__PURE__ */ new Map();
var AdapterError = class extends CliError {
  constructor(code, message, details) {
    super(message, {
      class: "validation",
      code,
      retryable: false,
      details
    });
    this.name = "AdapterError";
  }
};
function validateAdapter(adapter2, name) {
  if (!adapter2 || typeof adapter2 !== "object") {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      `Adapter '${name}' default export is not an object`
    );
  }
  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(adapter2, field)) {
      throw new AdapterError(
        "BACKEND_INCAPABLE",
        `Adapter '${name}' missing required field: ${field}`
      );
    }
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter2[method] !== "function") {
      throw new AdapterError(
        "BACKEND_INCAPABLE",
        `Adapter '${name}' missing required method: ${method}`
      );
    }
  }
  if (adapter2.name !== name) {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      `Adapter at '${name}/index.mjs' declares name='${adapter2.name}', expected '${name}'`
    );
  }
  const capabilities = adapter2.capabilities();
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      `Adapter '${name}' capabilities() must return an object`
    );
  }
  for (const [capability, method] of Object.entries(OPTIONAL_CAPABILITY_METHODS)) {
    if (capabilities[capability] === true && typeof adapter2[method] !== "function") {
      throw new AdapterError(
        "BACKEND_INCAPABLE",
        `Adapter '${name}' declares ${capability}=true but is missing optional method: ${method}`,
        { backend: name, capability, method }
      );
    }
  }
}
async function loadAdapter(name) {
  if (!KNOWN_ADAPTERS.includes(name)) {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      `Unknown backend '${name}'. Known: ${KNOWN_ADAPTERS.join(", ")}`
    );
  }
  const cached2 = adapterCache.get(name);
  if (cached2) return cached2;
  const adapter2 = ADAPTER_LOADERS[name]();
  validateAdapter(adapter2, name);
  adapterCache.set(name, adapter2);
  return adapter2;
}
async function selectAdapter(options = {}) {
  if (options.cwdConfig && typeof options.cwdConfig !== "object") {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      "selectAdapter: cwdConfig must be an object"
    );
  }
  if (options.workspaceConfig && typeof options.workspaceConfig !== "object") {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      "selectAdapter: workspaceConfig must be an object"
    );
  }
  if (options.userConfig && typeof options.userConfig !== "object") {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      "selectAdapter: userConfig must be an object"
    );
  }
  const routedBackend = (config) => options.subagentType ? config?.adapter_routing?.[options.subagentType]?.backend : void 0;
  const candidates = [
    options.backend,
    options.envBackend,
    options.metaBackend,
    routedBackend(options.cwdConfig),
    routedBackend(options.workspaceConfig),
    routedBackend(options.userConfig),
    options.cwdConfig?.default_backend,
    options.workspaceConfig?.default_backend,
    options.userConfig?.default_backend,
    options.defaultBackend ?? "codex"
  ];
  const name = candidates.find((c) => typeof c === "string" && c.length > 0);
  if (!name) {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      "No backend resolved (all layers empty)"
    );
  }
  return loadAdapter(name);
}
function metadataBackend(metadata) {
  if (!metadata || typeof metadata !== "object") return void 0;
  return metadata.backend;
}
function metadataSubagentType(metadata) {
  if (!metadata || typeof metadata !== "object") return void 0;
  return metadata.subagentType ?? metadata.subagent_type;
}
function buildAdapterSelectionOptions(options = {}) {
  const env = options.env ?? process9.env;
  const metadata = options.taskMetadata ?? options.metadata ?? null;
  const layers = options.configLayers ?? {};
  return {
    backend: options.backend,
    envBackend: env?.[BACKEND_ENV_VAR],
    metaBackend: options.metaBackend ?? metadataBackend(metadata),
    subagentType: options.subagentType ?? metadataSubagentType(metadata),
    cwdConfig: options.cwdConfig ?? layers.cwdConfig,
    workspaceConfig: options.workspaceConfig ?? layers.workspaceConfig,
    userConfig: options.userConfig ?? layers.userConfig ?? layers.skillConfig,
    defaultBackend: options.defaultBackend
  };
}
async function resolveAdapter(options = {}) {
  return selectAdapter(buildAdapterSelectionOptions(options));
}
async function resolveAdapterForRuntime(options = {}) {
  const configLayers = options.configLayers ?? loadConfigLayers(
    options.skillDir ?? null,
    options.cwd ?? null,
    options.workspaceRoot ?? null
  );
  return resolveAdapter({
    ...options,
    configLayers
  });
}
function guardCapability(adapter2, capability) {
  const caps = adapter2.capabilities();
  if (!capability.startsWith("supports_") || typeof caps[capability] !== "boolean") {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      `Capability '${capability}' is not a boolean support flag`,
      { backend: adapter2.name, capability }
    );
  }
  if (caps[capability] !== true) {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      `Backend '${adapter2.name}' does not support capability '${capability}'`,
      { backend: adapter2.name, capability }
    );
  }
}

// src/lib/thread-id.mjs
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isThreadId(value) {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

// src/lib/registry.mjs
import fs12 from "node:fs";
import os5 from "node:os";
import path10 from "node:path";
var REGISTRY_SCHEMA_VERSION = "1.0";
var tmpCounter = 0;
function tmpSuffix() {
  tmpCounter = tmpCounter + 1 >>> 0;
  return `${process.pid}.${Date.now()}.${tmpCounter}`;
}
var RegistryReadError = class extends Error {
  constructor(message, { filePath, cause } = {}) {
    super(message, { cause });
    this.name = "RegistryReadError";
    this.code = "REGISTRY_READ_FAILED";
    this.filePath = filePath ?? null;
  }
};
function registryRoot() {
  const override = process.env.CODEX_BRIDGE_REGISTRY;
  if (override && override.length > 0) return override;
  return path10.join(os5.homedir(), ".codex-bridge", "jobs");
}
function jobDir(taskId) {
  if (!taskId || typeof taskId !== "string") {
    throw new TypeError("jobDir(taskId): taskId must be a non-empty string");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new TypeError(
      `jobDir(taskId): taskId contains invalid characters: ${JSON.stringify(taskId)}`
    );
  }
  if (taskId === "." || taskId === "..") {
    throw new TypeError(
      `jobDir(taskId): taskId must not be "." or "..": ${JSON.stringify(taskId)}`
    );
  }
  return path10.join(registryRoot(), taskId);
}
function existsTask(taskId) {
  try {
    return fs12.existsSync(jobDir(taskId));
  } catch {
    return false;
  }
}
function ensureJobDir(taskId) {
  const dir = jobDir(taskId);
  fs12.mkdirSync(dir, { recursive: true });
  return dir;
}
function writeMeta(taskId, meta) {
  if (!meta || typeof meta !== "object") {
    throw new TypeError("writeMeta(taskId, meta): meta must be an object");
  }
  const dir = ensureJobDir(taskId);
  const payload = {
    ...meta,
    schema_version: REGISTRY_SCHEMA_VERSION,
    task_id: taskId,
    written_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  const target = path10.join(dir, "meta.json");
  const tmp = `${target}.tmp.${tmpSuffix()}`;
  fs12.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}
`, "utf8");
  fs12.renameSync(tmp, target);
  return target;
}
function writeRegistryTextFile(taskId, fileName, content) {
  const dir = ensureJobDir(taskId);
  const target = path10.join(dir, fileName);
  const tmp = `${target}.tmp.${tmpSuffix()}`;
  fs12.writeFileSync(tmp, content, "utf8");
  fs12.renameSync(tmp, target);
  return target;
}
function writeBriefArtifacts(taskId, { brief, rendered, hash, source } = {}) {
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
    throw new TypeError("writeBriefArtifacts(taskId, artifacts): artifacts.brief must be an object");
  }
  const briefJsonPath = writeRegistryTextFile(taskId, "brief.json", `${JSON.stringify({
    schema_version: REGISTRY_SCHEMA_VERSION,
    task_id: taskId,
    brief_hash: hash ?? null,
    brief_source: source ?? null,
    written_at: (/* @__PURE__ */ new Date()).toISOString(),
    brief
  }, null, 2)}
`);
  const briefMdPath = rendered ? writeRegistryTextFile(taskId, "brief.md", String(rendered).endsWith("\n") ? String(rendered) : `${rendered}
`) : null;
  return { briefJsonPath, briefMdPath };
}
function writeDiffArtifact(taskId, diffContent) {
  return writeRegistryTextFile(taskId, "diff.patch", String(diffContent ?? ""));
}
function readMeta(taskId) {
  const target = path10.join(jobDir(taskId), "meta.json");
  return readRegistryJson(target);
}
function readRegistryJson(target) {
  let text;
  try {
    text = fs12.readFileSync(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new RegistryReadError(`Could not read registry file: ${target}`, {
      filePath: target,
      cause: error
    });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RegistryReadError(`Registry file is not valid JSON: ${target}`, {
      filePath: target,
      cause: error
    });
  }
}
var TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
function listTasks() {
  const root = registryRoot();
  if (!fs12.existsSync(root)) return [];
  try {
    return fs12.readdirSync(root, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && entry.name !== "." && entry.name !== ".." && TASK_ID_PATTERN.test(entry.name)
    ).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}
function readVerdict(taskId) {
  const target = path10.join(jobDir(taskId), "verdict.json");
  return readRegistryJson(target);
}
function writeVerdict(taskId, verdict) {
  if (!verdict || typeof verdict !== "object") {
    throw new TypeError("writeVerdict(taskId, verdict): verdict must be an object");
  }
  if (!["approved", "needs-attention", "must-fix"].includes(verdict.verdict)) {
    throw new TypeError(
      "writeVerdict(taskId, verdict): verdict.verdict must be one of approved | needs-attention | must-fix"
    );
  }
  const dir = ensureJobDir(taskId);
  const payload = {
    ...verdict,
    schema_version: REGISTRY_SCHEMA_VERSION,
    task_id: taskId,
    decided_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  const target = path10.join(dir, "verdict.json");
  const tmp = `${target}.tmp.${tmpSuffix()}`;
  fs12.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}
`, "utf8");
  fs12.renameSync(tmp, target);
  return target;
}
function writeReview2(taskId, review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    throw new TypeError("writeReview(taskId, review): review must be an object");
  }
  const dir = ensureJobDir(taskId);
  const payload = {
    ...review,
    schema_version: REGISTRY_SCHEMA_VERSION,
    task_id: taskId,
    ts: (/* @__PURE__ */ new Date()).toISOString()
  };
  const target = path10.join(dir, "review.json");
  const tmp = `${target}.tmp.${tmpSuffix()}`;
  fs12.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}
`, "utf8");
  fs12.renameSync(tmp, target);
  return target;
}

// src/lib/brief.mjs
import fs13 from "node:fs";
import path11 from "node:path";
import { createHash as createHash2 } from "node:crypto";
var BRIEF_SCHEMA_VERSION = "1.0";
var VALID_BACKENDS = /* @__PURE__ */ new Set(["codex"]);
var PARENT_ID_PATTERN = /^(task|review)-[A-Za-z0-9._-]+$/;
var ERR = {
  FILE_NOT_FOUND: "BRIEF_FILE_NOT_FOUND",
  INVALID_JSON: "BRIEF_INVALID_JSON",
  SCHEMA_VIOLATION: "BRIEF_SCHEMA_VIOLATION",
  PARENT_NOT_FOUND: "BRIEF_PARENT_NOT_FOUND",
  BACKEND_UNAVAILABLE: "BRIEF_BACKEND_UNAVAILABLE"
};
function fail(code, message, details) {
  return { ok: false, code, message, details };
}
function isString(v) {
  return typeof v === "string";
}
function isInteger2(v) {
  return Number.isInteger(v);
}
function isObject2(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}
function validateStringField(brief, key, opts) {
  const v = brief[key];
  if (v === void 0) {
    if (opts.required) {
      return `${key} is required`;
    }
    return null;
  }
  if (!isString(v)) return `${key} must be a string`;
  if (v.length < (opts.minLength ?? 1)) {
    return `${key} must be at least ${opts.minLength ?? 1} characters`;
  }
  if (v.length > opts.maxLength) {
    return `${key} must be at most ${opts.maxLength} characters`;
  }
  return null;
}
function validateStringArray(brief, key, opts) {
  const v = brief[key];
  if (v === void 0) return null;
  if (!Array.isArray(v)) return `${key} must be an array`;
  if (v.length > opts.maxItems) {
    return `${key} must have at most ${opts.maxItems} items`;
  }
  for (let i = 0; i < v.length; i++) {
    if (!isString(v[i])) return `${key}[${i}] must be a string`;
    if (v[i].length < 1) return `${key}[${i}] must be at least 1 character`;
    if (v[i].length > opts.maxItemLength) {
      return `${key}[${i}] must be at most ${opts.maxItemLength} characters`;
    }
  }
  return null;
}
function validateBriefShape(brief) {
  if (!isObject2(brief)) return ["brief must be a JSON object"];
  const errors = [];
  if (brief.schema_version !== void 0 && brief.schema_version !== BRIEF_SCHEMA_VERSION) {
    errors.push(
      `schema_version must be "${BRIEF_SCHEMA_VERSION}" (got ${JSON.stringify(brief.schema_version)})`
    );
  }
  for (const [key, opts] of [
    ["goal", { required: true, minLength: 1, maxLength: 2e3 }],
    ["worker_assignment", { required: true, minLength: 1, maxLength: 4e3 }],
    ["behavior_digest_seed", { required: false, minLength: 0, maxLength: 8e3 }]
  ]) {
    const err = validateStringField(brief, key, opts);
    if (err) errors.push(err);
  }
  for (const [key, opts] of [
    ["specific_concerns", { maxItems: 16, maxItemLength: 1e3 }],
    ["acceptance_criteria", { maxItems: 16, maxItemLength: 1e3 }]
  ]) {
    const err = validateStringArray(brief, key, opts);
    if (err) errors.push(err);
  }
  if (brief.parent_task_id !== void 0) {
    if (!isString(brief.parent_task_id)) {
      errors.push("parent_task_id must be a string");
    } else if (!PARENT_ID_PATTERN.test(brief.parent_task_id)) {
      errors.push(
        `parent_task_id must match ${PARENT_ID_PATTERN}: got ${JSON.stringify(brief.parent_task_id)}`
      );
    }
  }
  if (brief.backend_hint !== void 0) {
    if (!isString(brief.backend_hint)) {
      errors.push("backend_hint must be a string");
    } else if (!VALID_BACKENDS.has(brief.backend_hint)) {
      errors.push(
        `backend_hint must be one of ${[...VALID_BACKENDS].join(", ")} (got ${JSON.stringify(brief.backend_hint)})`
      );
    }
  }
  if (brief.iteration_max !== void 0) {
    if (!isInteger2(brief.iteration_max)) {
      errors.push("iteration_max must be an integer");
    } else if (brief.iteration_max < 1 || brief.iteration_max > 10) {
      errors.push("iteration_max must be between 1 and 10");
    }
  }
  if (brief.trust_budget_override !== void 0) {
    const tbo = brief.trust_budget_override;
    if (!isObject2(tbo)) {
      errors.push("trust_budget_override must be an object");
    } else {
      const allowedTrustBudgetKeys = /* @__PURE__ */ new Set([
        "auto_merge_max_diff_lines",
        "auto_merge_max_files",
        "auto_merge_max_iterations"
      ]);
      for (const key of Object.keys(tbo)) {
        if (!allowedTrustBudgetKeys.has(key)) {
          errors.push(`unknown trust_budget_override field: ${key}`);
        }
      }
      for (const [key, min] of [
        ["auto_merge_max_diff_lines", 0],
        ["auto_merge_max_files", 0],
        ["auto_merge_max_iterations", 1]
      ]) {
        if (tbo[key] !== void 0) {
          if (!isInteger2(tbo[key])) {
            errors.push(`trust_budget_override.${key} must be an integer`);
          } else if (tbo[key] < min) {
            errors.push(`trust_budget_override.${key} must be >= ${min}`);
          }
        }
      }
    }
  }
  const allowed = /* @__PURE__ */ new Set([
    "schema_version",
    "goal",
    "worker_assignment",
    "behavior_digest_seed",
    "specific_concerns",
    "acceptance_criteria",
    "parent_task_id",
    "backend_hint",
    "iteration_max",
    "trust_budget_override"
  ]);
  for (const key of Object.keys(brief)) {
    if (!allowed.has(key)) {
      errors.push(`unknown field: ${key}`);
    }
  }
  return errors;
}
function briefHash(briefText) {
  return `sha256:${createHash2("sha256").update(briefText, "utf8").digest("hex")}`;
}
function loadBrief(arg, options = {}) {
  if (!isString(arg) || arg.length === 0) {
    return fail(ERR.SCHEMA_VIOLATION, "brief argument must be @path or inline JSON");
  }
  let raw;
  let source;
  if (arg.startsWith("@")) {
    const requestedPath = arg.slice(1);
    const filePath = isString(options?.baseDir) && options.baseDir.length > 0 ? path11.resolve(options.baseDir, requestedPath) : path11.resolve(requestedPath);
    if (!fs13.existsSync(filePath)) {
      return fail(ERR.FILE_NOT_FOUND, `brief file not found: ${filePath}`);
    }
    try {
      raw = fs13.readFileSync(filePath, "utf8");
      source = filePath;
    } catch (err) {
      return fail(ERR.FILE_NOT_FOUND, `cannot read brief file: ${err.message}`);
    }
  } else {
    raw = arg;
    source = "inline";
  }
  let brief;
  try {
    brief = JSON.parse(raw);
  } catch (err) {
    return fail(ERR.INVALID_JSON, `brief JSON parse failed: ${err.message}`);
  }
  const errors = validateBriefShape(brief);
  if (errors.length > 0) {
    return fail(ERR.SCHEMA_VIOLATION, `brief failed schema validation`, errors);
  }
  if (brief.parent_task_id !== void 0 && !existsTask(brief.parent_task_id)) {
    return fail(
      ERR.PARENT_NOT_FOUND,
      `brief.parent_task_id not found: ${brief.parent_task_id}`
    );
  }
  if (brief.backend_hint !== void 0 && !VALID_BACKENDS.has(brief.backend_hint)) {
    return fail(
      ERR.BACKEND_UNAVAILABLE,
      `brief.backend_hint=${JSON.stringify(brief.backend_hint)} is not installed in v2.0; valid: ${[...VALID_BACKENDS].join(", ")}`
    );
  }
  return {
    ok: true,
    brief,
    briefHash: briefHash(raw),
    source
  };
}
function renderBriefAsMarkdown(brief) {
  const lines = [];
  lines.push("# Brief");
  lines.push("");
  lines.push("## Goal");
  lines.push(brief.goal);
  lines.push("");
  lines.push("## Worker assignment");
  lines.push(brief.worker_assignment);
  if (brief.behavior_digest_seed) {
    lines.push("");
    lines.push("## What the orchestrator already knows");
    lines.push(brief.behavior_digest_seed);
  }
  if (Array.isArray(brief.specific_concerns) && brief.specific_concerns.length > 0) {
    lines.push("");
    lines.push("## Specific concerns");
    for (const c of brief.specific_concerns) lines.push(`- ${c}`);
  }
  if (Array.isArray(brief.acceptance_criteria) && brief.acceptance_criteria.length > 0) {
    lines.push("");
    lines.push("## Acceptance criteria");
    for (const a of brief.acceptance_criteria) lines.push(`- [ ] ${a}`);
  }
  if (brief.parent_task_id) {
    lines.push("");
    lines.push(`Parent task: \`${brief.parent_task_id}\``);
  }
  return lines.join("\n");
}

// src/lib/adversarial-review-prompt.mjs
var OPUS_CONCERN_MAX_LEN = 1e3;
function formatOpusConcerns(concerns) {
  const list = Array.isArray(concerns) ? concerns.map(
    (c) => typeof c === "string" ? sanitizePromptValue(c.trim(), { maxLength: OPUS_CONCERN_MAX_LEN }).trim() : ""
  ).filter((c) => c.length > 0) : [];
  if (list.length === 0) {
    return '(No orchestrator-supplied concerns. Run the review with --brief @<path>.json or --concern "..." to surface focus areas.)';
  }
  return list.map((c) => `- concern_data: ${JSON.stringify(c)}`).join("\n");
}
function buildAdversarialReviewPrompt(rootDir, context, focusText, opusConcerns = []) {
  const template = loadPromptTemplate(rootDir, "adversarial-review");
  return interpolateTemplate(
    template,
    {
      TARGET_LABEL: sanitizePromptValue(context.target.label),
      USER_FOCUS: sanitizePromptValue(focusText) || "No extra focus provided.",
      REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
      OPUS_CONCERNS: formatOpusConcerns(opusConcerns),
      REVIEW_INPUT: context.content
    },
    {
      requiredKeys: /* @__PURE__ */ new Set([
        "TARGET_LABEL",
        "USER_FOCUS",
        "REVIEW_COLLECTION_GUIDANCE",
        "OPUS_CONCERNS",
        "REVIEW_INPUT"
      ])
    }
  );
}

// src/lib/render.mjs
function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}
function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}
var ALLOWED_FINDING_SEVERITIES = /* @__PURE__ */ new Set(["critical", "high", "medium", "low"]);
function validateReviewFinding(finding, index) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    return `finding[${index}] is not an object`;
  }
  if (typeof finding.severity !== "string" || !finding.severity.trim()) {
    return `finding[${index}] missing required field 'severity'`;
  }
  if (!ALLOWED_FINDING_SEVERITIES.has(finding.severity.trim())) {
    return `finding[${index}] has invalid severity '${finding.severity}'`;
  }
  if (typeof finding.title !== "string" || !finding.title.trim()) {
    return `finding[${index}] missing required field 'title'`;
  }
  if (typeof finding.body !== "string" || !finding.body.trim()) {
    return `finding[${index}] missing required field 'body'`;
  }
  if (typeof finding.file !== "string" || !finding.file.trim()) {
    return `finding[${index}] missing required field 'file'`;
  }
  if (!Number.isInteger(finding.line_start) || finding.line_start < 1) {
    return `finding[${index}] missing required field 'line_start'`;
  }
  if (!Number.isInteger(finding.line_end) || finding.line_end < finding.line_start) {
    return `finding[${index}] missing required field 'line_end'`;
  }
  if (typeof finding.confidence !== "number" || Number.isNaN(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) {
    return `finding[${index}] missing required field 'confidence'`;
  }
  if (typeof finding.recommendation !== "string") {
    return `finding[${index}] missing required field 'recommendation'`;
  }
  return null;
}
function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  for (let index = 0; index < data.findings.length; index += 1) {
    const findingError = validateReviewFinding(data.findings[index], index);
    if (findingError) {
      return findingError;
    }
  }
  return null;
}
function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd = Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart) ? source.line_end : lineStart;
  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    confidence: typeof source.confidence === "number" && source.confidence >= 0 && source.confidence <= 1 ? source.confidence : null,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}
function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps.filter((step) => typeof step === "string" && step.trim()).map((step) => step.trim())
  };
}
function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(result, "result") || Object.prototype.hasOwnProperty.call(result, "parseError");
}
function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}
function escapeMarkdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
function formatCodexResumeCommand(job) {
  if (!job?.threadId) {
    return null;
  }
  return `codex resume ${job.threadId}`;
}
function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Codex Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`codex-bridge status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`codex-bridge cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}
function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`  Codex session ID: ${job.threadId}`);
  }
  const resumeCommand = formatCodexResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume in Codex: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: codex-bridge cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: codex-bridge result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: codex-bridge review");
    lines.push("  Stricter review: codex-bridge adversarial-review");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}
function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }
  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}
function renderSetupReport(report) {
  const lines = [
    "# Codex Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- codex: ${report.codex.detail}`,
    `- auth: ${report.auth.detail}`,
    `- backend: ${report.active_backend ?? "unknown"}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    `- official OpenAI Codex plugin: ${report.officialOpenAICodexPluginStatus ?? "unknown"}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    `- review gate lock: ${report.reviewGateLockPath ?? "n/a"}${report.reviewGateLockExists ? " (present)" : ""}${report.reviewGateLockIgnored ? " (ignored)" : ""}`,
    `- monitor hook mirror: ${report.monitorHookInstalled ? "installed" : "not installed"} (${report.monitorHookSettingsPath ?? "n/a"})`,
    `- sandbox enforcement: ${report.sandboxEnforcementInstalled ? "installed" : "not installed"} (${report.sandboxEnforcementSettingsPath ?? "n/a"})`,
    ""
  ];
  if (report.reviewGateSuppressionReason) {
    lines.push(`Review gate suppression: ${report.reviewGateSuppressionReason}`, "");
  }
  if (report.monitorHookSettingsParseError) {
    lines.push(`Monitor hook settings warning: ${report.monitorHookSettingsParseError}`, "");
  }
  if (report.sandboxEnforcementSettingsParseError) {
    lines.push(`Sandbox enforcement settings warning: ${report.sandboxEnforcementSettingsParseError}`, "");
  }
  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }
  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }
  return `${lines.join("\n").trimEnd()}
`;
}
function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines2 = [
      `# Codex ${meta.reviewLabel}`,
      "",
      "Codex did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];
    if (parsedResult.rawOutput) {
      lines2.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }
    appendReasoningSection(lines2, meta.reasoningSummary ?? parsedResult.reasoningSummary);
    return `${lines2.join("\n").trimEnd()}
`;
  }
  const validationError2 = validateReviewResultShape(parsedResult.parsed);
  if (validationError2) {
    const lines2 = [
      `# Codex ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "Codex returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError2}`
    ];
    if (parsedResult.rawOutput) {
      lines2.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }
    appendReasoningSection(lines2, meta.reasoningSummary ?? parsedResult.reasoningSummary);
    return `${lines2.join("\n").trimEnd()}
`;
  }
  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Codex ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];
  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      const severityHeader = typeof finding.confidence === "number" ? `${finding.severity} \xB7 conf=${finding.confidence.toFixed(2)}` : finding.severity;
      lines.push(`- [${severityHeader}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }
  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }
  appendReasoningSection(lines, meta.reasoningSummary);
  return `${lines.join("\n").trimEnd()}
`;
}
function renderNativeReviewResult(result, meta) {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const lines = [
    `# Codex ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ""
  ];
  if (stdout) {
    lines.push(stdout);
  } else if (result.status === 0) {
    lines.push("Codex review completed without any stdout output.");
  } else {
    lines.push("Codex review failed.");
  }
  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }
  appendReasoningSection(lines, meta.reasoningSummary);
  return `${lines.join("\n").trimEnd()}
`;
}
function renderTaskResult(parsedResult, meta) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) {
    return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}
`;
  }
  const message = String(parsedResult?.failureMessage ?? "").trim() || "Codex did not return a final message.";
  return `${message}
`;
}
function renderStatusReport(report) {
  const lines = [
    "# Codex Status",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`,
    ""
  ];
  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }
  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }
  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }
  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    if (report.config.stopReviewGateLockPath) {
      lines.push(`Project lock: ${report.config.stopReviewGateLockPath}`);
    }
    lines.push("Ending the session will trigger a fresh Codex stop-time review and block if it finds issues.");
  } else if (report.reviewGateLockIgnored) {
    lines.push("The Codex Bridge stop-time review gate lock is present but ignored.");
    if (report.reviewGateSuppressionReason) {
      lines.push(`Reason: ${report.reviewGateSuppressionReason}`);
    }
  }
  return `${lines.join("\n").trimEnd()}
`;
}
function renderJobStatusReport(job) {
  const lines = ["# Codex Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}
`;
}
function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? `codex resume ${threadId}` : null;
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}
`;
    if (!threadId) {
      return output;
    }
    return `${output}
Codex session ID: ${threadId}
Resume in Codex: ${resumeCommand}
`;
  }
  const rawOutput = typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput || typeof storedJob?.result?.codex?.stdout === "string" && storedJob.result.codex.stdout || "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}
`;
    if (!threadId) {
      return output;
    }
    return `${output}
Codex session ID: ${threadId}
Resume in Codex: ${resumeCommand}
`;
  }
  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}
`;
    if (!threadId) {
      return output;
    }
    return `${output}
Codex session ID: ${threadId}
Resume in Codex: ${resumeCommand}
`;
  }
  const lines = [
    `# ${job.title ?? "Codex Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];
  if (threadId) {
    lines.push(`Codex session ID: ${threadId}`);
    lines.push(`Resume in Codex: ${resumeCommand}`);
  }
  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }
  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }
  return `${lines.join("\n").trimEnd()}
`;
}
function renderCancelReport(job) {
  const lines = [
    "# Codex Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];
  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `codex-bridge status` for the updated queue.");
  return `${lines.join("\n").trimEnd()}
`;
}

// src/adapters/codex/pipeline.mjs
import fs14 from "node:fs";
import path12 from "node:path";

// src/lib/review-result.mjs
var REVIEW_RESULT_SCHEMA_VERSION = "1.0";
var REVIEW_KINDS = /* @__PURE__ */ new Set(["native", "adversarial"]);
var NORMALIZED_VERDICTS = /* @__PURE__ */ new Set(["approved", "needs-attention", "must-fix"]);
var ADVERSARIAL_VERDICTS = /* @__PURE__ */ new Set(["approve", "approved", "needs-attention", "must-fix"]);
var FINDING_SEVERITIES = /* @__PURE__ */ new Set(["critical", "high", "medium", "low", "P0", "P1", "P2", "P3", "P4"]);
function parseNativeReviewText(text) {
  const reviewText = typeof text === "string" ? text : String(text ?? "");
  if (!reviewText.trim()) {
    return {
      verdict: "needs-attention",
      summary: "Native review returned no review output.",
      findings: [],
      next_steps: ["Rerun review; blank native review output cannot approve the target."],
      raw_output: reviewText
    };
  }
  const findings = parseNativeReviewFindings(reviewText).map(
    (finding, index) => validateReviewFinding2(finding, index)
  );
  if (findings.length > 0) {
    return {
      verdict: "must-fix",
      summary: firstMeaningfulLine(reviewText, "Native review reported actionable findings."),
      findings,
      next_steps: ["Fix the reported findings, then rerun review."],
      raw_output: reviewText
    };
  }
  const lower = reviewText.toLowerCase();
  const reviewTextWithoutNoIssuePhrases = lower.replace(
    /\bno\s+(?:(?:major|material|significant|substantive|critical|actionable|blocking|new|remaining)\s+)*(?:issues?|findings?|problems?|concerns?|regressions?)\s*(?:found|detected|identified|remain|remaining)?\b/g,
    ""
  ).replace(
    /\bwithout\s+(?:(?:major|material|significant|substantive|critical|actionable|blocking|new|remaining)\s+)*(?:issues?|findings?|problems?|concerns?|regressions?)\b/g,
    ""
  ).replace(/\b(?:issues?|findings?|problems?|concerns?):\s*(?:none|n\/a)\b/g, "");
  const explicitAttention = lower.includes("needs-attention") || /\bneeds attention\b/.test(lower) || /\brequires attention\b/.test(lower);
  const hasIssues = explicitAttention || /\b(?:findings?|issues?|problems?|concerns?|regressions?)\b/.test(reviewTextWithoutNoIssuePhrases);
  return {
    verdict: hasIssues ? "needs-attention" : "approved",
    summary: firstMeaningfulLine(
      reviewText,
      hasIssues ? "Native review reported attention without structured findings." : "Native review approved the target."
    ),
    findings: [],
    next_steps: hasIssues ? ["Rerun review or inspect the raw output for unstructured concerns."] : [],
    raw_output: reviewText
  };
}
function normalizeNativeReviewResult(input) {
  const source = normalizeInputObject(input, "reviewText");
  const parsed = parseNativeReviewText(source.reviewText);
  return buildReviewResult({
    reviewKind: "native",
    parsed,
    source
  });
}
function normalizeAdversarialReviewResult(input) {
  const source = normalizeInputObject(input, "raw_output");
  const data = parseAdversarialPayload(source.payload);
  if (!ADVERSARIAL_VERDICTS.has(data.verdict)) {
    throw reviewResultTypeError(
      `adversarial review verdict must be one of approve | approved | needs-attention | must-fix (got ${JSON.stringify(data.verdict)})`,
      "verdict"
    );
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    throw reviewResultTypeError("adversarial review summary must be a non-empty string", "summary");
  }
  if (!Array.isArray(data.findings)) {
    throw reviewResultTypeError("adversarial review findings must be an array", "findings");
  }
  if (!Array.isArray(data.next_steps)) {
    throw reviewResultTypeError("adversarial review next_steps must be an array", "next_steps");
  }
  const findings = data.findings.map((finding, index) => validateReviewFinding2(finding, index));
  const verdict = normalizeVerdict(data.verdict, findings);
  return buildReviewResult({
    reviewKind: "adversarial",
    parsed: {
      verdict,
      summary: data.summary.trim(),
      findings,
      next_steps: data.next_steps.filter((step) => typeof step === "string" && step.trim()).map((step) => step.trim()),
      raw_output: source.raw_output
    },
    source
  });
}
function mapReviewVerdictToTaskVerdict(reviewResult) {
  const verdict = typeof reviewResult === "string" ? reviewResult : reviewResult?.verdict;
  if (verdict === "approve") return "approved";
  if (NORMALIZED_VERDICTS.has(verdict)) return verdict;
  throw reviewResultTypeError(`unknown review verdict: ${JSON.stringify(verdict)}`, "verdict");
}
function validateReviewFinding2(finding, index = 0) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    throw reviewResultTypeError(`finding[${index}] must be an object`, `findings.${index}`);
  }
  const severity = normalizeRequiredString(finding.severity, `finding[${index}].severity`, `findings.${index}.severity`);
  if (!FINDING_SEVERITIES.has(severity)) {
    throw reviewResultTypeError(
      `finding[${index}].severity must be one of ${Array.from(FINDING_SEVERITIES).join(" | ")} (got ${JSON.stringify(finding.severity)})`,
      `findings.${index}.severity`
    );
  }
  const title = normalizeRequiredString(finding.title, `finding[${index}].title`, `findings.${index}.title`);
  const file = normalizeRequiredString(finding.file, `finding[${index}].file`, `findings.${index}.file`);
  const lineStart = normalizePositiveInteger(finding.line_start, `finding[${index}].line_start`, `findings.${index}.line_start`);
  const lineEnd = normalizePositiveInteger(
    finding.line_end ?? finding.line_start,
    `finding[${index}].line_end`,
    `findings.${index}.line_end`
  );
  if (lineEnd < lineStart) {
    throw reviewResultTypeError(
      `finding[${index}].line_end must be greater than or equal to line_start`,
      `findings.${index}.line_end`
    );
  }
  const recommendation = typeof finding.recommendation === "string" ? finding.recommendation.trim() : "";
  const body = typeof finding.body === "string" && finding.body.trim() ? finding.body.trim() : recommendation || title;
  const confidence = finding.confidence == null ? 1 : finding.confidence;
  if (typeof confidence !== "number" || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    throw reviewResultTypeError(
      `finding[${index}].confidence must be a number between 0 and 1`,
      `findings.${index}.confidence`
    );
  }
  return {
    severity,
    title,
    body,
    file,
    line_start: lineStart,
    line_end: lineEnd,
    confidence,
    recommendation
  };
}
function buildReviewResult({ reviewKind, parsed, source }) {
  if (!REVIEW_KINDS.has(reviewKind)) {
    throw reviewResultTypeError(`review_kind must be native or adversarial (got ${JSON.stringify(reviewKind)})`, "review_kind");
  }
  const verdict = mapReviewVerdictToTaskVerdict(parsed.verdict);
  const result = {
    schema_version: REVIEW_RESULT_SCHEMA_VERSION,
    review_kind: reviewKind,
    verdict,
    summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : `${reviewKind} review completed.`,
    findings: Array.isArray(parsed.findings) ? parsed.findings.map((finding, index) => validateReviewFinding2(finding, index)) : [],
    next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps.filter((step) => typeof step === "string" && step.trim()).map((step) => step.trim()) : [],
    target: source.target ?? null,
    task_id: source.task_id ?? source.taskId ?? null,
    reviewed_branch_head_sha: source.reviewed_branch_head_sha ?? source.reviewedBranchHeadSha ?? null,
    raw_output: parsed.raw_output ?? source.raw_output ?? null
  };
  if (!NORMALIZED_VERDICTS.has(result.verdict)) {
    throw reviewResultTypeError(`normalized verdict is invalid: ${JSON.stringify(result.verdict)}`, "verdict");
  }
  return result;
}
function normalizeInputObject(input, textField) {
  if (typeof input === "string") {
    return {
      payload: input,
      [textField]: input,
      raw_output: input
    };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw reviewResultTypeError("review result input must be an object or string", "input");
  }
  const payload = input.parsed ?? input.result ?? input.payload ?? input.review_result ?? input;
  const rawOutput = input.raw_output ?? input.rawOutput ?? input.reviewText ?? input.finalMessage ?? payload;
  return {
    ...input,
    payload,
    reviewText: input.reviewText ?? input.review_text ?? input.raw_output ?? input.rawOutput ?? "",
    raw_output: rawOutput
  };
}
function parseAdversarialPayload(payload) {
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch (error) {
      throw reviewResultTypeError(`adversarial review output must be valid JSON: ${error.message}`, "raw_output");
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw reviewResultTypeError("adversarial review output must be a JSON object", "raw_output");
  }
  return payload;
}
function normalizeVerdict(verdict, findings) {
  if (verdict === "approve" || verdict === "approved") {
    return findings.length > 0 ? "must-fix" : "approved";
  }
  if (verdict === "must-fix") return "must-fix";
  if (verdict === "needs-attention") {
    return findings.length > 0 ? "must-fix" : "needs-attention";
  }
  throw reviewResultTypeError(`unknown review verdict: ${JSON.stringify(verdict)}`, "verdict");
}
function parseNativeReviewFindings(reviewText) {
  const lines = reviewText.split(/\r?\n/);
  const findings = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const recommendation = current.body.map((line) => line.trim()).filter(Boolean).join("\n");
    findings.push({
      severity: current.severity,
      title: current.title,
      body: recommendation || current.title,
      file: current.file,
      line_start: current.lineStart,
      line_end: current.lineEnd,
      confidence: 1,
      recommendation
    });
    current = null;
  };
  for (const line of lines) {
    const header = parseNativeFindingHeader(line);
    if (header) {
      flush();
      current = { ...header, body: [] };
      continue;
    }
    if (current && (/^(?:\s{2,}|\t+)\S/.test(line) || line.trim() === "")) {
      current.body.push(line);
    }
  }
  flush();
  return findings;
}
function parseNativeFindingHeader(line) {
  const match = line.match(/^\s*[-*]\s+\[(P\d+)\]\s+(.+?)\s+(?:\u2014|\u2013|--|-)\s+(.+?):(\d+)(?:-(\d+))?\s*$/i);
  if (!match) return null;
  const lineStart = Number.parseInt(match[4], 10);
  if (!Number.isInteger(lineStart) || lineStart < 1) return null;
  const parsedLineEnd = match[5] ? Number.parseInt(match[5], 10) : lineStart;
  const lineEnd = Number.isInteger(parsedLineEnd) && parsedLineEnd >= lineStart ? parsedLineEnd : lineStart;
  return {
    severity: match[1].toUpperCase(),
    title: match[2].trim(),
    file: match[3].trim(),
    lineStart,
    lineEnd
  };
}
function normalizeRequiredString(value, messageField, errorField = messageField) {
  if (typeof value !== "string" || !value.trim()) {
    throw reviewResultTypeError(`${messageField} must be a non-empty string`, errorField);
  }
  return value.trim();
}
function normalizePositiveInteger(value, messageField, errorField = messageField) {
  if (!Number.isInteger(value) || value < 1) {
    throw reviewResultTypeError(`${messageField} must be a positive integer`, errorField);
  }
  return value;
}
function firstMeaningfulLine(text, fallback) {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? fallback;
}
function reviewResultTypeError(message, field) {
  const error = new TypeError(message);
  error.code = "INVALID_REVIEW_RESULT";
  error.field = field;
  return error;
}

// src/adapters/codex/pipeline.mjs
var PIPELINE_TIMEOUT_MS_DEFAULT = 9e5;
var STAGE_TIMEOUT_MS_DEFAULT = 3e5;
function loadExecuteInstructions(rootDir) {
  const p = path12.join(rootDir, "templates", "execute-instructions.md");
  try {
    return fs14.readFileSync(p, "utf8");
  } catch {
    return "Execute the task autonomously. Do not ask questions. Make reasonable assumptions and proceed.";
  }
}
async function runAutoPipeline(options) {
  const {
    session,
    threadId,
    cwd,
    config,
    scriptPath,
    rootDir,
    runAppServerTurn: runAppServerTurn2,
    runAppServerReview: runAppServerReview2,
    jobId = null,
    stateCwd = cwd,
    stageTimeoutMs = null,
    totalTimeoutMs = null
  } = options;
  const stageMs = Number(stageTimeoutMs) > 0 ? Number(stageTimeoutMs) : STAGE_TIMEOUT_MS_DEFAULT;
  const totalMs = Number(totalTimeoutMs) > 0 ? Number(totalTimeoutMs) : PIPELINE_TIMEOUT_MS_DEFAULT;
  const completedStages = [];
  const startTime = Date.now();
  const executeInstructions = loadExecuteInstructions(rootDir);
  const taskMeta = jobId ? readMeta(jobId) : null;
  const taskDiffBaseRef = typeof taskMeta?.base_sha === "string" && taskMeta.base_sha ? taskMeta.base_sha : typeof taskMeta?.base_ref === "string" && taskMeta.base_ref ? taskMeta.base_ref : null;
  const captureTaskDiff = () => taskDiffBaseRef ? captureGitDiff(cwd, session, { baseRef: taskDiffBaseRef }) : captureGitDiff(cwd, session);
  const remainingPipelineMs = () => totalMs - (Date.now() - startTime);
  const checkPipelineTimeout = () => {
    if (remainingPipelineMs() <= 0) {
      throw new PipelineTimeoutError(completedStages, totalMs);
    }
  };
  const buildStageDeadline = () => {
    const remainingMs = remainingPipelineMs();
    if (remainingMs <= 0) {
      throw new PipelineTimeoutError(completedStages, totalMs);
    }
    const timeoutMs = Math.min(stageMs, remainingMs);
    const totalLimited = remainingMs < stageMs;
    return {
      timeoutMs,
      // Keep the inner watchdog from preempting the pipeline-total timer with
      // a stage-timeout result when the remaining total budget is the limiter.
      turnTimeoutMs: totalLimited ? 0 : Math.max(0, timeoutMs - 500),
      timeoutErrorFactory: totalLimited ? () => new PipelineTimeoutError(completedStages, totalMs) : null
    };
  };
  let fixFilesTouched = [];
  let reviewVerdict = "approved";
  let reviewFindings = [];
  let reviewFindingCount = 0;
  let incompleteStage = null;
  try {
    logEvent(session, formatPipelineEvent(session, { stage: "diff" }));
    logNdjson(session, "PIPELINE_STAGE", null, { stage: "diff" });
    const diff1 = captureGitDiff(cwd, session);
    completedStages.push("diff");
    logEvent(session, formatPipelineEvent(session, { stage: "diff", suffix: "done", detail: diff1.diffStat }));
    checkPipelineTimeout();
    let unstructuredReviewAttention = false;
    if (config.auto_review) {
      logEvent(session, formatPipelineEvent(session, { stage: "review" }));
      logNdjson(session, "PIPELINE_STAGE", null, { stage: "review" });
      try {
        const reviewDeadline = buildStageDeadline();
        const reviewResult = await withTimeout2(
          runAppServerReview2(cwd, {
            target: { type: "uncommittedChanges" },
            model: config.model,
            turnTimeoutMs: reviewDeadline.turnTimeoutMs,
            idleTimeoutMs: reviewDeadline.turnTimeoutMs
          }),
          reviewDeadline.timeoutMs,
          "auto-review",
          reviewDeadline.timeoutErrorFactory
        );
        if (reviewResult.status !== 0) {
          const innerError = reviewResult.error ?? null;
          const innerMessage = innerError?.message ?? "";
          const isTimeout = innerError?.code === "TurnTimeout" || /Turn timed out after \d+ms\./.test(innerMessage) || /No events received for \d+s/.test(innerMessage);
          const detail = innerMessage ? `: ${innerMessage}` : "";
          if (isTimeout) {
            const reviewError = new TimeoutError("auto-review", reviewDeadline.turnTimeoutMs);
            reviewError.message = `auto-review did not complete cleanly (status ${reviewResult.status}${detail}).`;
            throw reviewError;
          }
          const stageError = new PipelineStageError(
            "review",
            `auto-review failed (status ${reviewResult.status}${detail}).`,
            innerError
          );
          throw stageError;
        }
        completedStages.push("review");
        checkPipelineTimeout();
        const parsed = parseNativeReviewText(reviewResult.reviewText);
        reviewVerdict = parsed.verdict;
        reviewFindings = parsed.findings;
        reviewFindingCount = reviewFindings.length;
        unstructuredReviewAttention = reviewVerdict !== "approved" && reviewFindingCount === 0;
        logEvent(session, formatPipelineEvent(session, {
          stage: "review",
          suffix: "done",
          detail: `verdict=${reviewVerdict} findings=${reviewFindingCount}`
        }));
        if (reviewFindings.length > 0) {
          logEvent(session, formatPipelineEvent(session, { stage: "fix" }));
          logNdjson(session, "PIPELINE_STAGE", null, { stage: "fix", findingCount: reviewFindings.length });
          const diffBeforeFix = captureGitDiff(cwd, session);
          const diffContentBeforeFix = readCapturedDiffContent(diffBeforeFix);
          const fixPrompt = buildFixPrompt(reviewFindings);
          let fixResult;
          let fixDeadline;
          try {
            fixDeadline = buildStageDeadline();
            fixResult = await withTimeout2(
              runAppServerTurn2(cwd, {
                resumeThreadId: threadId,
                prompt: fixPrompt,
                model: config.model,
                effort: "high",
                collaborationMode: buildCollaborationMode("default", config, {
                  developerInstructions: executeInstructions
                }),
                sandboxPolicy: buildSandboxPolicy("default", config),
                turnTimeoutMs: fixDeadline.turnTimeoutMs,
                idleTimeoutMs: fixDeadline.turnTimeoutMs
              }),
              fixDeadline.timeoutMs,
              "auto-fix",
              fixDeadline.timeoutErrorFactory
            );
          } catch (error) {
            if (error instanceof TimeoutError) {
              throw error;
            }
            const detail = error instanceof Error ? error.message : String(error);
            throw new PipelineStageError(
              "fix",
              `auto-fix failed before producing a result${detail ? `: ${detail}` : ""}.`,
              error instanceof Error ? error : null
            );
          }
          const fixStatus = fixResult?.status;
          if (fixStatus !== 0) {
            const innerError = fixResult?.error ?? null;
            const innerMessage = innerError?.message ?? "";
            const isTimeout = innerError?.code === "TurnTimeout" || /Turn timed out after \d+ms\./.test(innerMessage) || /No events received for \d+s/.test(innerMessage);
            const detail = innerMessage ? `: ${innerMessage}` : "";
            if (isTimeout) {
              const fixError = new TimeoutError("auto-fix", fixDeadline.turnTimeoutMs);
              fixError.message = `auto-fix did not complete cleanly (status ${fixStatus}${detail}).`;
              throw fixError;
            }
            throw new PipelineStageError(
              "fix",
              `auto-fix failed (status ${fixStatus}${detail}).`,
              innerError
            );
          }
          completedStages.push("fix");
          checkPipelineTimeout();
          const diffAfterFix = captureGitDiff(cwd, session);
          const diffContentAfterFix = readCapturedDiffContent(diffAfterFix);
          fixFilesTouched = collectStageTouchedFiles(
            diffBeforeFix,
            diffContentBeforeFix,
            diffAfterFix,
            diffContentAfterFix
          );
          logEvent(session, formatPipelineEvent(session, {
            stage: "fix",
            suffix: "done",
            detail: fixFilesTouched.length ? `files=${JSON.stringify(fixFilesTouched.slice(0, 10))}${fixFilesTouched.length > 10 ? ` (+${fixFilesTouched.length - 10} more)` : ""}` : "files=[]"
          }));
        }
      } catch (error) {
        if (error instanceof TimeoutError) {
          throw error;
        }
        if (error instanceof PipelineStageError) {
          throw error;
        }
        logNdjson(session, "PIPELINE_ERROR", null, { stage: "review", error: error.message });
        logEvent(session, formatPipelineEvent(session, {
          stage: "review",
          suffix: "failed",
          detail: error.message ?? "review failed"
        }));
        completedStages.push("review-failed");
      }
    }
    let completionResult = { complete: true, missing_items: [], summary: "Complete" };
    if (config.post_task_prompt && config.post_task_prompt.trim()) {
      logEvent(session, formatPipelineEvent(session, { stage: "check" }));
      logNdjson(session, "PIPELINE_STAGE", null, { stage: "check" });
      try {
        const checkDeadline = buildStageDeadline();
        const checkResult = await withTimeout2(
          runAppServerTurn2(cwd, {
            resumeThreadId: threadId,
            prompt: config.post_task_prompt,
            model: config.model,
            effort: "medium",
            collaborationMode: buildCollaborationMode("default", config, {
              developerInstructions: executeInstructions
            }),
            sandboxPolicy: { type: "readOnly" },
            outputSchema: COMPLETION_CHECK_SCHEMA,
            turnTimeoutMs: checkDeadline.turnTimeoutMs,
            idleTimeoutMs: checkDeadline.turnTimeoutMs
          }),
          checkDeadline.timeoutMs,
          "completion-check",
          checkDeadline.timeoutErrorFactory
        );
        completedStages.push("check");
        if (checkResult.status !== 0) {
          incompleteStage = "check";
          completionResult = {
            complete: false,
            missing_items: [
              `Completion check turn failed (status ${checkResult.status}${checkResult.error?.message ? `: ${checkResult.error.message}` : ""}).`
            ],
            summary: "completion-check failed"
          };
        } else if (checkResult.finalMessage) {
          try {
            completionResult = JSON.parse(checkResult.finalMessage);
          } catch (error) {
            const parseMessage = error instanceof Error ? error.message : String(error);
            incompleteStage = "check";
            completionResult = {
              complete: false,
              missing_items: [
                `Completion check returned invalid JSON: ${parseMessage}. Re-run the check or return JSON matching the completion schema.`
              ],
              summary: "completion-check invalid-json"
            };
          }
        } else {
          incompleteStage = "check";
          completionResult = {
            complete: false,
            missing_items: ["Completion check produced no final message."],
            summary: "completion-check inconclusive"
          };
        }
        const missingDetail = Array.isArray(completionResult.missing_items) && completionResult.missing_items.length ? ` missing=${completionResult.missing_items.length} missing_items=${JSON.stringify(completionResult.missing_items)}` : "";
        logEvent(session, formatPipelineEvent(session, {
          stage: "check",
          suffix: "done",
          detail: `complete=${Boolean(completionResult.complete)}${missingDetail}`
        }));
      } catch (error) {
        if (error instanceof TimeoutError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        const detail = message || "check failed";
        incompleteStage = "check";
        completionResult = {
          complete: false,
          missing_items: [
            `Completion check failed before producing a result: ${detail}`
          ],
          summary: "completion-check failed"
        };
        logNdjson(session, "PIPELINE_ERROR", null, { stage: "check", error: detail });
        logEvent(session, formatPipelineEvent(session, {
          stage: "check",
          suffix: "failed",
          detail
        }));
        completedStages.push("check-failed");
      }
    }
    if (unstructuredReviewAttention) {
      const missingItem = "Native review reported needs-attention but did not include parseable file/line findings, so auto-fix could not run.";
      const existingMissingItems = Array.isArray(completionResult.missing_items) ? completionResult.missing_items : [];
      incompleteStage ??= "review";
      completionResult = {
        complete: false,
        missing_items: existingMissingItems.includes(missingItem) ? existingMissingItems : [...existingMissingItems, missingItem],
        summary: completionResult.complete ? "native review needs attention" : typeof completionResult.summary === "string" ? completionResult.summary : "native review needs attention"
      };
    }
    const finalDiff = captureTaskDiff();
    const duration = Math.round((Date.now() - startTime) / 1e3);
    const missingItems = Array.isArray(completionResult.missing_items) ? completionResult.missing_items : [];
    const completionSummary = typeof completionResult.summary === "string" ? completionResult.summary : null;
    const complete = Boolean(completionResult.complete);
    const partial = !complete;
    const failingStage = partial ? incompleteStage : null;
    const completion = normalizeCompletionResult(completionResult, missingItems, completionSummary, complete);
    if (complete) {
      logEvent(session, formatDoneEvent(session, {
        duration,
        diffStat: finalDiff.diffStat,
        files: finalDiff.files,
        config: { model: config.model, effort: config.effort, modeFlow: "plan\u2192default" },
        diffPath: finalDiff.diffPath,
        scriptPath,
        jobId,
        cwd,
        stateCwd
      }));
    } else {
      logEvent(session, formatIncompleteEvent(session, {
        diffStat: finalDiff.diffStat,
        diffPath: finalDiff.diffPath,
        verdict: reviewVerdict,
        findingCount: reviewFindingCount,
        failingStage,
        missingItems,
        scriptPath,
        jobId,
        cwd,
        stateCwd
      }));
    }
    logNdjson(session, "PIPELINE_COMPLETE", null, {
      completedStages,
      duration,
      complete,
      partial,
      failing_stage: failingStage,
      stageTimeoutMs: stageMs,
      totalTimeoutMs: totalMs,
      reviewVerdict,
      reviewFindingCount,
      fixFilesTouched,
      missingItems,
      completionSummary,
      completion,
      touchedFiles: fixFilesTouched
    });
    logEvent(session, formatPipelineEvent(session, {
      stage: "done",
      detail: `stages=${completedStages.join(",")} complete=${complete} partial=${partial}${failingStage ? ` failing_stage=${failingStage}` : ""} touched=${fixFilesTouched.length}`
    }));
    return {
      complete,
      partial,
      completedStages,
      duration,
      diff: finalDiff,
      failing_stage: failingStage,
      stageTimeoutMs: stageMs,
      totalTimeoutMs: totalMs,
      reviewVerdict,
      reviewFindingCount,
      fixFilesTouched,
      completion,
      missingItems,
      completionSummary,
      touchedFiles: fixFilesTouched
    };
  } catch (error) {
    const duration = Math.round((Date.now() - startTime) / 1e3);
    const errorCode = error instanceof TimeoutError ? "ClientTimeout" : error instanceof PipelineStageError && error.cause?.code ? error.cause.code : "PipelineError";
    const errorMessage = error instanceof PipelineTimeoutError ? `Auto-pipeline exceeded ${fmtSeconds(totalMs)}. Completed stages: ${completedStages.join(", ")}` : error.message;
    let finalDiff;
    try {
      finalDiff = captureTaskDiff();
    } catch {
      finalDiff = { diffStat: "0 files | +0 -0", files: [], diffPath: "" };
    }
    const lastStage = completedStages[completedStages.length - 1] ?? "pipeline";
    const origin = `pipeline:${lastStage}`;
    const failingStage = error instanceof TimeoutError ? mapStageLabel(error.label) : error instanceof PipelineStageError ? error.stage : null;
    const upstreamRequestId = extractUpstreamRequestId(errorMessage);
    logEvent(session, formatErrorEvent(session, {
      errorCode,
      message: errorMessage,
      phase: `pipeline (completed: ${completedStages.join(", ")})`,
      origin,
      failingStage,
      scriptPath,
      jobId,
      upstreamRequestId,
      cwd,
      stateCwd
    }));
    logNdjson(session, "PIPELINE_ERROR", null, {
      completedStages,
      duration,
      error: errorMessage,
      origin,
      failing_stage: failingStage,
      partial: true,
      stageTimeoutMs: stageMs,
      totalTimeoutMs: totalMs,
      reviewVerdict,
      reviewFindingCount,
      fixFilesTouched,
      touchedFiles: fixFilesTouched
    });
    logEvent(session, formatPipelineEvent(session, {
      stage: "failed",
      detail: `failing_stage=${failingStage ?? "unknown"} at=${lastStage} stages=${completedStages.join(",")} touched=${fixFilesTouched.length}`
    }));
    const completion = normalizeCompletionResult(
      { complete: false, missing_items: [], summary: null },
      [],
      null,
      false
    );
    return {
      complete: false,
      partial: true,
      completedStages,
      duration,
      error: errorMessage,
      diff: finalDiff,
      failing_stage: failingStage,
      stageTimeoutMs: stageMs,
      totalTimeoutMs: totalMs,
      reviewVerdict,
      reviewFindingCount,
      fixFilesTouched,
      completion,
      missingItems: [],
      completionSummary: null,
      touchedFiles: fixFilesTouched
    };
  }
}
function normalizeCompletionResult(completionResult, missingItems, completionSummary, complete) {
  const source = completionResult && typeof completionResult === "object" && !Array.isArray(completionResult) ? completionResult : {};
  return {
    ...source,
    complete,
    missing_items: missingItems,
    summary: completionSummary
  };
}
function buildFixPrompt(findings) {
  const lines = ["Fix the following review findings:"];
  for (const f of findings) {
    lines.push(`- [${f.severity}] ${f.title} at ${f.file}:${f.line_start}-${f.line_end}`);
    if (f.recommendation) {
      lines.push(`  Recommendation: ${f.recommendation}`);
    }
  }
  return lines.join("\n");
}
function readCapturedDiffContent(diff) {
  if (!diff?.diffPath) {
    return "";
  }
  try {
    return fs14.readFileSync(diff.diffPath, "utf8");
  } catch {
    return "";
  }
}
function collectStageTouchedFiles(diffBefore, diffContentBefore, diffAfter, diffContentAfter) {
  const beforeStats = mapFormattedDiffFiles(diffBefore?.files ?? []);
  const afterStats = mapFormattedDiffFiles(diffAfter?.files ?? []);
  const beforeBlocks = splitDiffBlocksByPath(diffContentBefore);
  const afterBlocks = splitDiffBlocksByPath(diffContentAfter);
  const orderedFiles = uniqueStrings([
    ...afterStats.keys(),
    ...beforeStats.keys(),
    ...afterBlocks.keys(),
    ...beforeBlocks.keys()
  ]);
  return orderedFiles.filter((file) => {
    const beforeSignal = beforeBlocks.get(file) ?? beforeStats.get(file) ?? null;
    const afterSignal = afterBlocks.get(file) ?? afterStats.get(file) ?? null;
    return beforeSignal !== afterSignal;
  });
}
function mapFormattedDiffFiles(files) {
  const map2 = /* @__PURE__ */ new Map();
  for (const file of files) {
    const parsed = parseFormattedDiffFile(file);
    if (parsed) {
      map2.set(parsed.path, parsed.stat);
    }
  }
  return map2;
}
function parseFormattedDiffFile(file) {
  const match = String(file).match(/^[A-Z]\s+(.+?)\s+\(\+[\d-]+\s+-[\d-]+\)$/);
  if (!match) {
    return null;
  }
  return { path: match[1], stat: file };
}
function splitDiffBlocksByPath(diffContent) {
  const blocks = /* @__PURE__ */ new Map();
  let currentPath = null;
  let currentLines = [];
  const flush = () => {
    if (currentPath) {
      blocks.set(currentPath, currentLines.join("\n"));
    }
  };
  for (const line of String(diffContent ?? "").split("\n")) {
    const nextPath = parseDiffGitHeader(line);
    if (nextPath) {
      flush();
      currentPath = nextPath;
      currentLines = [line];
    } else if (currentPath) {
      currentLines.push(line);
    }
  }
  flush();
  return blocks;
}
function parseDiffGitHeader(line) {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!match) {
    return null;
  }
  return match[2];
}
function uniqueStrings(values) {
  const seen = /* @__PURE__ */ new Set();
  const unique = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique;
}
function mapStageLabel(label) {
  switch (label) {
    case "auto-review":
      return "review";
    case "auto-fix":
      return "fix";
    case "completion-check":
      return "check";
    case "auto-pipeline":
      return "pipeline-total";
    default:
      return label || null;
  }
}
var TimeoutError = class extends Error {
  constructor(label, timeoutMs) {
    super(`${label} exceeded ${fmtSeconds(timeoutMs)}`);
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
};
var PipelineStageError = class extends Error {
  constructor(stage, message, cause = null) {
    super(message);
    this.name = "PipelineStageError";
    this.stage = stage;
    if (cause) this.cause = cause;
  }
};
var PipelineTimeoutError = class extends TimeoutError {
  constructor(completedStages, timeoutMs = PIPELINE_TIMEOUT_MS_DEFAULT) {
    super("auto-pipeline", timeoutMs);
    this.completedStages = completedStages;
  }
};
function withTimeout2(promise, timeoutMs, label, timeoutErrorFactory = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(typeof timeoutErrorFactory === "function" ? timeoutErrorFactory() : new TimeoutError(label, timeoutMs));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// src/lib/update-check.mjs
import fs15 from "node:fs";
import path13 from "node:path";
import os6 from "node:os";
var DEFAULT_CACHE_TTL_MS = 60 * 60 * 1e3;
var DEFAULT_FETCH_TIMEOUT_MS = 2500;
var APPLY_ATTEMPT_WINDOW_MS = 60 * 60 * 1e3;
var GITHUB_API_URL = "https://api.github.com/repos/yigitkonur/codex-bridge/releases/latest";
var USER_AGENT = "codex-bridge-update-check";
function cachePath() {
  const pluginDataDir = process.env.CODEX_BRIDGE_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  const root = pluginDataDir ? path13.join(pluginDataDir, "codex-bridge-update.json") : path13.join(os6.homedir(), ".codex-bridge", "update-cache.json");
  return root;
}
function readCache() {
  try {
    const raw = fs15.readFileSync(cachePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed == null) return null;
    return parsed;
  } catch {
    return null;
  }
}
function writeCache(entry) {
  try {
    const p = cachePath();
    fs15.mkdirSync(path13.dirname(p), { recursive: true });
    fs15.writeFileSync(p, JSON.stringify(entry, null, 2));
    return true;
  } catch {
    return false;
  }
}
function hasReleaseCache(cache) {
  return cache && typeof cache.checkedAt === "number" && typeof cache.latestVersion === "string";
}
function cacheLockPath() {
  return `${cachePath()}.lock`;
}
function removeStaleLock(lockPath, staleMs) {
  try {
    const stat = fs15.statSync(lockPath);
    if (Date.now() - stat.mtimeMs <= staleMs) return false;
    fs15.unlinkSync(lockPath);
    return true;
  } catch (err) {
    return err?.code === "ENOENT";
  }
}
function acquireCacheLock(staleMs) {
  const lockPath = cacheLockPath();
  try {
    fs15.mkdirSync(path13.dirname(lockPath), { recursive: true });
  } catch {
    return null;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs15.openSync(lockPath, "wx");
      try {
        fs15.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      } catch {
      }
      return { fd, lockPath };
    } catch (err) {
      if (err?.code !== "EEXIST") return null;
      if (!removeStaleLock(lockPath, staleMs)) return null;
    }
  }
  return null;
}
function releaseCacheLock(lock) {
  try {
    fs15.closeSync(lock.fd);
  } catch {
  }
  try {
    fs15.unlinkSync(lock.lockPath);
  } catch {
  }
}
function hasRecentApplyAttempt(cache, now, windowMs) {
  return cache && typeof cache.lastApplyAttempt === "number" && now - cache.lastApplyAttempt <= windowMs;
}
function writeApplyAttemptMarker(targetVersion, attemptedAt, existing = readCache()) {
  const next = {
    ...existing ?? {},
    lastApplyAttempt: attemptedAt
  };
  if (typeof targetVersion === "string") {
    next.lastApplyTargetVersion = targetVersion;
  }
  return writeCache(next);
}
function claimApplyAttempt(targetVersion, windowMs = APPLY_ATTEMPT_WINDOW_MS) {
  const lock = acquireCacheLock(Math.max(windowMs, 6e4));
  if (!lock) return false;
  try {
    const cache = readCache();
    const now = Date.now();
    if (hasRecentApplyAttempt(cache, now, windowMs)) return false;
    return writeApplyAttemptMarker(targetVersion, now, cache);
  } catch {
    return false;
  } finally {
    releaseCacheLock(lock);
  }
}
function shouldAttemptApply(windowMs = APPLY_ATTEMPT_WINDOW_MS) {
  return claimApplyAttempt(void 0, windowMs);
}
function markApplyAttempted(targetVersion) {
  const lock = acquireCacheLock(APPLY_ATTEMPT_WINDOW_MS);
  if (!lock) return;
  try {
    writeApplyAttemptMarker(targetVersion, Date.now());
  } catch {
  } finally {
    releaseCacheLock(lock);
  }
}
function parseVersion(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+](.+))?$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), tag: m[4] ?? "" };
}
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.tag === pb.tag) return 0;
  if (pa.tag === "") return 1;
  if (pb.tag === "") return -1;
  return pa.tag < pb.tag ? -1 : 1;
}
async function fetchLatestTag(timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(GITHUB_API_URL, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT
      }
    });
    if (!res.ok) {
      return { ok: false, status: res.status, reason: `http-${res.status}` };
    }
    const json2 = await res.json();
    if (typeof json2?.tag_name !== "string") {
      return { ok: false, status: 200, reason: "bad-payload" };
    }
    return { ok: true, tag: json2.tag_name.replace(/^v/i, "") };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return { ok: false, status: 0, reason: aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(t);
  }
}
async function checkForUpdate({
  currentVersion,
  force = false,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS
} = {}) {
  const cache = readCache();
  const hasCachedRelease = hasReleaseCache(cache);
  const now = Date.now();
  if (!force && hasCachedRelease && now - cache.checkedAt < cacheTtlMs) {
    return {
      skipped: false,
      cached: true,
      currentVersion,
      latestVersion: cache.latestVersion,
      hasUpdate: compareVersions(currentVersion, cache.latestVersion) < 0,
      cacheAgeMs: now - cache.checkedAt
    };
  }
  const fetchResult = await fetchLatestTag(fetchTimeoutMs);
  if (!fetchResult.ok) {
    return {
      skipped: true,
      reason: hasCachedRelease ? "fetch-failed-using-stale" : "fetch-failed-no-cache",
      fetchReason: fetchResult.reason,
      fetchStatus: fetchResult.status ?? null,
      currentVersion,
      ...hasCachedRelease && {
        latestVersion: cache.latestVersion,
        hasUpdate: compareVersions(currentVersion, cache.latestVersion) < 0,
        cacheAgeMs: now - cache.checkedAt
      }
    };
  }
  const applyMarkers = {};
  if (cache && Object.prototype.hasOwnProperty.call(cache, "lastApplyAttempt")) {
    applyMarkers.lastApplyAttempt = cache.lastApplyAttempt;
  }
  if (cache && Object.prototype.hasOwnProperty.call(cache, "lastApplyTargetVersion")) {
    applyMarkers.lastApplyTargetVersion = cache.lastApplyTargetVersion;
  }
  writeCache({ checkedAt: now, latestVersion: fetchResult.tag, ...applyMarkers });
  return {
    skipped: false,
    cached: false,
    currentVersion,
    latestVersion: fetchResult.tag,
    hasUpdate: compareVersions(currentVersion, fetchResult.tag) < 0,
    cacheAgeMs: 0
  };
}
function formatUpdateNotice(result) {
  if (!result || !result.hasUpdate || !result.latestVersion) return null;
  return `codex-bridge ${result.latestVersion} is available (you have ${result.currentVersion}). Run \`npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y\` to update, or pass --apply to \`codex-bridge update\` to install automatically.`;
}

// src/lib/iterate-loop.mjs
function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: error.code ?? null
    };
  }
  if (error && typeof error === "object") {
    return {
      message: String(error.message ?? JSON.stringify(error)),
      code: error.code ?? null
    };
  }
  return { message: String(error), code: null };
}
function artifactsFrom(...values) {
  return Object.assign(
    {},
    ...values.map((value) => value?.artifacts).filter((value) => value && typeof value === "object" && !Array.isArray(value))
  );
}
function taskIdFrom(value) {
  return value?.task_id ?? value?.taskId ?? value?.jobId ?? null;
}
function reviewResultFrom(value) {
  return value?.review_result ?? value?.reviewResult ?? value;
}
function verdictFrom(value) {
  return value?.verdict && typeof value.verdict === "object" ? value.verdict : value;
}
function mergeNextAction(taskId) {
  return {
    kind: "merge",
    argv: ["merge", taskId],
    description: "Merge the approved unchanged reviewed branch head."
  };
}
function inspectNextAction(taskId, status) {
  return {
    kind: "inspect-artifacts",
    argv: ["verdict", taskId, "--json"],
    description: `${status} reached; inspect review and verdict artifacts before continuing.`
  };
}
function failureResult({ status, max, iterations, taskId, iteration, step, error, artifacts }) {
  return {
    status,
    incomplete: true,
    iteration_max: max,
    iterations,
    current_task_id: taskId ?? null,
    failed_iteration: iteration,
    failed_step: step,
    error: serializeError(error),
    artifacts: artifacts ?? {},
    next_action: taskId ? inspectNextAction(taskId, status) : null
  };
}
async function callStep({ status, step, max, iterations, taskId, iteration, artifacts }, fn, arg) {
  try {
    return { ok: true, value: await fn(arg) };
  } catch (error) {
    return {
      ok: false,
      value: failureResult({
        status,
        max,
        iterations,
        taskId,
        iteration,
        step,
        error,
        artifacts
      })
    };
  }
}
function buildIterateFollowupPrompt({ previousTaskId, reviewResult, verdict }) {
  const findings = Array.isArray(reviewResult?.findings) ? reviewResult.findings : [];
  return [
    "Continue the existing codex-bridge task in the same worktree.",
    `Previous task: ${previousTaskId}`,
    `Review verdict: ${verdict}`,
    `Review summary: ${reviewResult?.summary ?? "No summary provided."}`,
    findings.length > 0 ? `Findings JSON:
${JSON.stringify(findings, null, 2)}` : "Findings JSON:\n[]",
    "Fix the review findings, preserve unrelated work, and leave artifacts for the next review iteration."
  ].join("\n\n");
}
async function runIterateLoop(options = {}) {
  const max = Number(options.max ?? 3);
  if (!Number.isInteger(max) || max < 1) {
    throw new TypeError(`runIterateLoop max must be a positive integer (got ${JSON.stringify(options.max)})`);
  }
  const deps = options.deps ?? {};
  const iterations = [];
  let taskId = options.taskId ?? null;
  let taskState = null;
  if (!taskId) {
    if (typeof deps.startTask !== "function") {
      throw new TypeError("runIterateLoop requires deps.startTask for prompt input");
    }
    const started = await callStep(
      {
        status: "task-failed",
        step: "start-task",
        max,
        iterations,
        taskId: null,
        iteration: 1,
        artifacts: {}
      },
      deps.startTask,
      {
        prompt: options.prompt,
        iteration: 1,
        write: true,
        worktree_auto: true
      }
    );
    if (!started.ok) return started.value;
    taskState = started.value;
    taskId = taskIdFrom(taskState);
    if (!taskId) {
      return failureResult({
        status: "task-failed",
        max,
        iterations,
        taskId: null,
        iteration: 1,
        step: "start-task",
        error: new Error("startTask did not return task_id"),
        artifacts: artifactsFrom(taskState)
      });
    }
  }
  if (typeof deps.readTaskCompletion !== "function") {
    deps.readTaskCompletion = async ({ startedTask }) => startedTask ?? {};
  }
  if (typeof deps.runReview !== "function") {
    throw new TypeError("runIterateLoop requires deps.runReview");
  }
  if (typeof deps.writeVerdict !== "function") {
    throw new TypeError("runIterateLoop requires deps.writeVerdict");
  }
  if (typeof deps.startFollowup !== "function") {
    throw new TypeError("runIterateLoop requires deps.startFollowup");
  }
  for (let iteration = 1; iteration <= max; iteration += 1) {
    const taskCompletion = await callStep(
      {
        status: "task-failed",
        step: "read-task-completion",
        max,
        iterations,
        taskId,
        iteration,
        artifacts: artifactsFrom(taskState)
      },
      deps.readTaskCompletion,
      { taskId, iteration, startedTask: taskState }
    );
    if (!taskCompletion.ok) return taskCompletion.value;
    const review = await callStep(
      {
        status: "review-failed",
        step: "run-review",
        max,
        iterations,
        taskId,
        iteration,
        artifacts: artifactsFrom(taskState, taskCompletion.value)
      },
      deps.runReview,
      { taskId, iteration, task: taskCompletion.value }
    );
    if (!review.ok) return review.value;
    const reviewResult = reviewResultFrom(review.value);
    const reviewedBranchHeadSha = reviewResult?.reviewed_branch_head_sha ?? reviewResult?.branch_head_sha ?? null;
    const verdictWrite = await callStep(
      {
        status: "verdict-failed",
        step: "write-verdict",
        max,
        iterations,
        taskId,
        iteration,
        artifacts: artifactsFrom(taskState, taskCompletion.value, review.value)
      },
      deps.writeVerdict,
      { taskId, iteration, reviewResult }
    );
    if (!verdictWrite.ok) return verdictWrite.value;
    const verdict = verdictFrom(verdictWrite.value);
    let verdictValue;
    try {
      verdictValue = mapReviewVerdictToTaskVerdict(verdict);
    } catch (error) {
      return failureResult({
        status: "verdict-failed",
        max,
        iterations,
        taskId,
        iteration,
        step: "normalize-verdict",
        error,
        artifacts: artifactsFrom(taskState, taskCompletion.value, review.value, verdictWrite.value)
      });
    }
    const entry = {
      iteration,
      task_id: taskId,
      review_result: reviewResult,
      verdict,
      reviewed_branch_head_sha: reviewedBranchHeadSha,
      artifacts: artifactsFrom(taskState, taskCompletion.value, review.value, verdictWrite.value)
    };
    iterations.push(entry);
    if (verdictValue === "approved") {
      return {
        status: "approved",
        iteration_max: max,
        iterations,
        task_id: taskId,
        reviewed_branch_head_sha: reviewedBranchHeadSha,
        next_action: mergeNextAction(taskId)
      };
    }
    if (iteration >= max) {
      return {
        status: "iteration-limit",
        incomplete: true,
        iteration_max: max,
        iterations,
        current_task_id: taskId,
        reviewed_branch_head_sha: reviewedBranchHeadSha,
        artifacts: entry.artifacts,
        next_action: inspectNextAction(taskId, "iteration-limit")
      };
    }
    const followupPrompt = buildIterateFollowupPrompt({
      previousTaskId: taskId,
      reviewResult,
      verdict: verdictValue
    });
    const followup = await callStep(
      {
        status: "follow-up-failed",
        step: "start-follow-up",
        max,
        iterations,
        taskId,
        iteration,
        artifacts: entry.artifacts
      },
      deps.startFollowup,
      {
        previousTaskId: taskId,
        iteration: iteration + 1,
        prompt: followupPrompt,
        reviewResult,
        verdict
      }
    );
    if (!followup.ok) return followup.value;
    const nextTaskId = taskIdFrom(followup.value);
    if (!nextTaskId) {
      return failureResult({
        status: "follow-up-failed",
        max,
        iterations,
        taskId,
        iteration,
        step: "start-follow-up",
        error: new Error("startFollowup did not return task_id"),
        artifacts: artifactsFrom(entry, followup.value)
      });
    }
    entry.next_task_id = nextTaskId;
    if (typeof deps.markSuperseded === "function") {
      const superseded = await callStep(
        {
          status: "verdict-failed",
          step: "mark-superseded",
          max,
          iterations,
          taskId,
          iteration,
          artifacts: artifactsFrom(entry, followup.value)
        },
        deps.markSuperseded,
        {
          taskId,
          nextTaskId,
          iteration,
          verdict: verdictValue,
          reviewResult
        }
      );
      if (!superseded.ok) return superseded.value;
      entry.artifacts = artifactsFrom(entry, superseded.value);
    }
    taskId = nextTaskId;
    taskState = followup.value;
  }
  return {
    status: "iteration-limit",
    incomplete: true,
    iteration_max: max,
    iterations,
    current_task_id: taskId,
    next_action: inspectNextAction(taskId, "iteration-limit")
  };
}

// src/lib/sandbox-enforcement.mjs
import fs16 from "node:fs";
import os7 from "node:os";
import path14 from "node:path";
var SANDBOX_ENFORCEMENT_MARKER_KEY = "_codex_bridge_sandbox_enforce";
var SANDBOX_ENFORCEMENT_MARKER_VALUE = "codex-bridge";
var SANDBOX_ENFORCEMENT_DENY_RULES = Object.freeze([
  {
    tool: "Bash",
    matcher: { command: ".*codex-bridge(?:\\.mjs)?\\s+task\\b.*--read-only" },
    reason: "sandbox.enforce: true (workspace policy) - --read-only forbidden",
    [SANDBOX_ENFORCEMENT_MARKER_KEY]: SANDBOX_ENFORCEMENT_MARKER_VALUE
  },
  {
    tool: "Bash",
    matcher: {
      command: ".*codex\\s+(?:exec\\s+)?.*(?:--sandbox(?:\\s+|=)|-s(?:\\s+|=))(?:read-only|workspace-write)"
    },
    reason: "Direct codex CLI sandbox downgrade forbidden",
    [SANDBOX_ENFORCEMENT_MARKER_KEY]: SANDBOX_ENFORCEMENT_MARKER_VALUE
  }
]);
function resolveClaudeSettingsPath() {
  return path14.join(os7.homedir(), ".claude", "settings.json");
}
function readClaudeSettings(settingsPath = resolveClaudeSettingsPath()) {
  if (!fs16.existsSync(settingsPath)) {
    return { exists: false, settings: {}, parseError: null };
  }
  try {
    const raw = fs16.readFileSync(settingsPath, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        exists: true,
        settings: null,
        parseError: "settings file must contain a JSON object"
      };
    }
    return { exists: true, settings: parsed, parseError: null };
  } catch (err) {
    return {
      exists: true,
      settings: null,
      parseError: err instanceof Error ? err.message : String(err)
    };
  }
}
function writeClaudeSettings(settingsPath, settings) {
  fs16.mkdirSync(path14.dirname(settingsPath), { recursive: true });
  const tmpPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
  fs16.writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}
`, "utf8");
  fs16.renameSync(tmpPath, settingsPath);
}
function hasSandboxEnforcement(settings) {
  const deny = settings?.permissions?.deny;
  return Array.isArray(deny) && deny.filter(
    (rule) => rule?.[SANDBOX_ENFORCEMENT_MARKER_KEY] === SANDBOX_ENFORCEMENT_MARKER_VALUE
  ).length === SANDBOX_ENFORCEMENT_DENY_RULES.length;
}
function getSandboxEnforcementStatus(settingsPath = resolveClaudeSettingsPath()) {
  const read = readClaudeSettings(settingsPath);
  return {
    installed: read.settings ? hasSandboxEnforcement(read.settings) : false,
    settingsPath,
    settingsExists: read.exists,
    settingsParseError: read.parseError,
    markerKey: SANDBOX_ENFORCEMENT_MARKER_KEY
  };
}
function assertSettingsShape(settingsPath, read, action) {
  if (read.parseError) {
    throw new Error(`Cannot ${action} sandbox enforcement in ${settingsPath}: ${read.parseError}.`);
  }
  const settings = read.settings ?? {};
  if (settings.permissions == null) settings.permissions = {};
  if (!settings.permissions || typeof settings.permissions !== "object" || Array.isArray(settings.permissions)) {
    throw new Error(`Cannot ${action} sandbox enforcement in ${settingsPath}: permissions must be a JSON object.`);
  }
  if (settings.permissions.deny == null) settings.permissions.deny = [];
  if (!Array.isArray(settings.permissions.deny)) {
    throw new Error(`Cannot ${action} sandbox enforcement in ${settingsPath}: permissions.deny must be an array.`);
  }
  return settings;
}
function installSandboxEnforcement(settingsPath = resolveClaudeSettingsPath()) {
  const read = readClaudeSettings(settingsPath);
  const settings = assertSettingsShape(settingsPath, read, "install");
  const alreadyInstalled = hasSandboxEnforcement(settings);
  if (!alreadyInstalled) {
    settings.permissions.deny = settings.permissions.deny.filter(
      (rule) => rule?.[SANDBOX_ENFORCEMENT_MARKER_KEY] !== SANDBOX_ENFORCEMENT_MARKER_VALUE
    );
    settings.permissions.deny.push(...SANDBOX_ENFORCEMENT_DENY_RULES);
    writeClaudeSettings(settingsPath, settings);
  }
  return {
    alreadyInstalled,
    status: getSandboxEnforcementStatus(settingsPath)
  };
}
function uninstallSandboxEnforcement(settingsPath = resolveClaudeSettingsPath()) {
  const read = readClaudeSettings(settingsPath);
  const settings = assertSettingsShape(settingsPath, read, "uninstall");
  const before = settings.permissions.deny.length;
  settings.permissions.deny = settings.permissions.deny.filter(
    (rule) => rule?.[SANDBOX_ENFORCEMENT_MARKER_KEY] !== SANDBOX_ENFORCEMENT_MARKER_VALUE
  );
  const removed = before - settings.permissions.deny.length;
  if (removed > 0 || !read.exists) {
    writeClaudeSettings(settingsPath, settings);
  }
  return {
    removed,
    status: getSandboxEnforcementStatus(settingsPath)
  };
}

// src/codex-bridge.mjs
function buildRecovery({ reason, retryable, nextActions = [], artifacts = {}, details = {} }) {
  return {
    schema_version: "1.0",
    reason,
    retryable: Boolean(retryable),
    next_actions: nextActions,
    artifacts,
    details
  };
}
function mirrorDiffToRegistry(taskId, diffPath) {
  if (!taskId || !diffPath) return null;
  try {
    if (!fs17.existsSync(diffPath)) return null;
    return writeDiffArtifact(taskId, fs17.readFileSync(diffPath, "utf8"));
  } catch {
    return null;
  }
}
function maybeTriggerAutoApply(rawArgv, subcommand) {
  try {
    if (process10.env.CODEX_BRIDGE_NO_UPDATE_CHECK === "1") return;
    if (detectJsonFlag(rawArgv)) return;
    if (detectHelpFlag(rawArgv)) return;
    if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") return;
    if (subcommand === "version" || subcommand === "update") return;
    void checkForUpdate({ currentVersion: BRIDGE_VERSION }).then((result) => {
      if (!result || !result.hasUpdate || !result.latestVersion) return;
      if (!shouldAttemptApply()) return;
      markApplyAttempted(result.latestVersion);
      spawnDetachedAutoApply(result.latestVersion);
    }).catch(() => {
    });
  } catch {
  }
}
function spawnDetachedAutoApply(targetVersion) {
  try {
    const logDir = path15.join(os8.homedir(), ".codex-bridge");
    fs17.mkdirSync(logDir, { recursive: true });
    const logFile = path15.join(logDir, "auto-update.log");
    try {
      const stat = fs17.statSync(logFile);
      if (stat.size > 2 * 1024 * 1024) fs17.truncateSync(logFile, 0);
    } catch {
    }
    const fd = fs17.openSync(logFile, "a");
    try {
      const banner = `
[${(/* @__PURE__ */ new Date()).toISOString()}] auto-apply triggered for v${targetVersion} (from ${BRIDGE_VERSION})
`;
      fs17.writeSync(fd, banner);
      const child = spawn3(
        "npx",
        ["-y", "skills@latest", "add", "yigitkonur/codex-bridge", "-a", "claude-code", "-g", "-y"],
        {
          detached: true,
          stdio: ["ignore", fd, fd],
          env: process10.env
        }
      );
      child.on("error", () => {
        try {
          fs17.appendFileSync(logFile, `[${(/* @__PURE__ */ new Date()).toISOString()}] spawn failed (npx not on PATH?)
`, "utf8");
        } catch {
        }
      });
      child.unref();
    } finally {
      try {
        fs17.closeSync(fd);
      } catch {
      }
    }
  } catch {
  }
}
var SCRIPT_DIR = path15.dirname(fileURLToPath2(import.meta.url));
var SCRIPT_PATH = path15.join(SCRIPT_DIR, "codex-bridge.mjs");
var ROOT_DIR = fs17.existsSync(path15.join(SCRIPT_DIR, "schemas")) ? SCRIPT_DIR : path15.resolve(SCRIPT_DIR, "..");
var REVIEW_SCHEMA = path15.join(ROOT_DIR, "schemas", "review-output.schema.json");
var EXECUTE_INSTRUCTIONS_PATH = path15.join(ROOT_DIR, "templates", "execute-instructions.md");
var PLAN_ENFORCEMENT_PATH = path15.join(ROOT_DIR, "templates", "plan-enforcement.md");
function shellQuote2(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
function bridgeCommand(subcommand, cwd = null) {
  return `node ${shellQuote2(SCRIPT_PATH)} ${subcommand}${cwd ? ` --cwd ${shellQuote2(cwd)}` : ""}`;
}
function buildTurnErrorNextAction({ origin, errorCode, threadId, jobId = null, cwd = null, stateCwd = null }) {
  const target = jobId ?? threadId;
  const jobCwd = stateCwd ?? cwd;
  if (origin === "upstream:response-chain-lost") {
    return {
      kind: "new-task",
      command: `${bridgeCommand("task", cwd)} --json --mode default "<prompt rebased on last good sha>"`,
      description: "The upstream response chain is dead; start a fresh task from committed state instead of sending on the same thread."
    };
  }
  if (origin === "upstream:auth" || errorCode === "Unauthorized") {
    return {
      kind: "reauth",
      command: "codex login",
      description: "Refresh Codex authentication, then relaunch the task; retrying the same thread will repeat the auth failure."
    };
  }
  if (origin === "upstream:transport") {
    return {
      kind: "retry-same-thread",
      command: threadId ? `${bridgeCommand("send", cwd)} ${threadId} "<same prompt>"` : `${bridgeCommand("task", cwd)} --json --mode default "<same prompt>"`,
      description: "The upstream stream dropped before completion; workspace state is unchanged, so retry the same thread once."
    };
  }
  if (origin === "idle" || errorCode === "ClientTimeout" || errorCode === "TurnTimeout") {
    return {
      kind: "relaunch-with-longer-timeouts",
      command: `${bridgeCommand("task", cwd)} --idle-timeout-ms 900000 --turn-default-ms 3600000 "<same prompt>"`,
      description: "A timeout budget expired; relaunch with a larger budget after confirming the original job is not still progressing."
    };
  }
  if (origin === "upstream:invalid-request") {
    return {
      kind: "new-task",
      command: `${bridgeCommand("task", cwd)} --json --mode default "<fixed prompt>"`,
      description: "Inspect the upstream validation error, fix the prompt/input shape, and launch a fresh task."
    };
  }
  if (target) {
    return {
      kind: "inspect-result",
      command: `${bridgeCommand("result", jobCwd)} ${target}`,
      description: "Inspect the persisted result and session log before deciding whether to retry or start fresh."
    };
  }
  return {
    kind: threadId ? "retry-with-revised-prompt" : "new-task",
    command: threadId ? `${bridgeCommand("send", cwd)} ${threadId} "<revised prompt>"` : `${bridgeCommand("task", cwd)} --json --mode default "<revised prompt>"`,
    description: threadId ? "Retry with an adjusted prompt, or cancel and start fresh." : "Start a fresh task with a revised prompt."
  };
}
var DEVELOPER_INSTRUCTIONS_FALLBACK = {
  plan: "Produce one concrete plan using the plan tool. Do not write code, do not ask questions, do not brainstorm alternatives.",
  default: "Execute the task autonomously. Do not ask questions. Make reasonable assumptions and proceed."
};
function loadDeveloperInstructions(mode) {
  const templatePath = mode === "plan" ? PLAN_ENFORCEMENT_PATH : EXECUTE_INSTRUCTIONS_PATH;
  try {
    return fs17.readFileSync(templatePath, "utf8");
  } catch {
    return DEVELOPER_INSTRUCTIONS_FALLBACK[mode] ?? DEVELOPER_INSTRUCTIONS_FALLBACK.default;
  }
}
function appendRenderedBriefToPrompt(prompt, brief) {
  if (!brief) return prompt ?? "";
  const rendered = renderBriefAsMarkdown(brief);
  return [
    prompt ?? "",
    "[CODEX-BRIDGE STRUCTURED BRIEF]",
    "The following brief is part of the worker instructions. Follow the worker_assignment and verify the acceptance_criteria before finishing.",
    rendered,
    "[/CODEX-BRIDGE STRUCTURED BRIEF]"
  ].filter((part) => String(part).trim()).join("\n\n");
}
function prepareRuntimeSession(session, config, jobId) {
  if (!session) return session;
  session.redactSecrets = Boolean(config?.redact_secrets);
  writeSessionAliases(session, jobId);
  return session;
}
var DEFAULT_STATUS_WAIT_TIMEOUT_MS = 24e4;
var DEFAULT_STATUS_POLL_INTERVAL_MS = 2e3;
var VALID_REASONING_EFFORTS = /* @__PURE__ */ new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
var MODEL_ALIASES = /* @__PURE__ */ new Map([["spark", "gpt-5.3-codex-spark"]]);
var STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
var STOP_REVIEW_GATE_LOCK_FILE = ".codex-bridge-stop-review-gate.lock";
var BRIDGE_CONFIG_SKILL_LAYER = null;
function getBridgeConfig(cwd = null, workspaceRoot = null) {
  if (!cwd && !workspaceRoot) {
    if (!BRIDGE_CONFIG_SKILL_LAYER) {
      BRIDGE_CONFIG_SKILL_LAYER = loadConfig(ROOT_DIR);
    }
    return BRIDGE_CONFIG_SKILL_LAYER;
  }
  return loadConfig(ROOT_DIR, cwd, workspaceRoot);
}
async function resolveCommandAdapter({
  cwd = null,
  workspaceRoot = null,
  backend = null,
  metaBackend = null,
  taskMetadata = null,
  subagentType = null
} = {}) {
  const resolvedWorkspaceRoot = workspaceRoot ?? (cwd ? resolveWorkspaceRoot(cwd) : null);
  return resolveAdapterForRuntime({
    skillDir: ROOT_DIR,
    cwd,
    workspaceRoot: resolvedWorkspaceRoot,
    backend,
    metaBackend,
    taskMetadata,
    subagentType,
    env: process10.env
  });
}
function ensureCodexRuntimeAdapter(adapter2) {
  if (adapter2?.name === "codex") return;
  throw validationError(
    `Backend '${adapter2?.name ?? "unknown"}' is selected but this CLI path is not wired to that adapter yet.`,
    "BACKEND_INCAPABLE",
    "Use --backend codex, unset CODEX_BRIDGE_BACKEND, or choose a config default_backend supported by this build."
  );
}
function buildJsonRpcError2(code, message, data) {
  return data === void 0 ? { code, message } : { code, message, data };
}
function rejectServerRequest(message, code, detail) {
  message._client?.rejectServerRequest?.(
    message.id,
    buildJsonRpcError2(code, detail)
  );
}
function createBridgeServerRequestHandler({ sessionDir, config, questionAnswerMs = null, cwd = null }) {
  return (message) => {
    const params = message.params ?? {};
    const threadId = params.threadId ?? "unknown";
    const session = findSession(sessionDir, threadId) ?? initSession(sessionDir, threadId);
    if (message.method !== "item/tool/requestUserInput") {
      logNdjson(session, "SERVER_REQUEST_UNSUPPORTED", message.method, {
        rpcRequestId: message.id,
        params
      });
      rejectServerRequest(message, -32601, `Unsupported server request: ${message.method}`);
      return;
    }
    const internalId = `req-${threadId.slice(-6)}-${Date.now().toString(36)}`;
    const entry = {
      internalId,
      rpcRequestId: message.id,
      method: message.method,
      threadId,
      firstQuestionId: params.questions?.[0]?.id ?? "q1",
      params,
      createdAt: Date.now()
    };
    writePendingRequest(sessionDir, threadId, entry);
    logEvent(session, formatQuestionEvent(session, {
      requestId: internalId,
      questions: params.questions ?? [],
      scriptPath: SCRIPT_PATH,
      cwd
    }));
    logNdjson(session, "QUESTION", message.method, { requestId: internalId, questions: params.questions });
    const timeoutMs = questionAnswerMs ?? (Number(config.question_answer_ms) > 0 ? Number(config.question_answer_ms) : DEFAULT_CONFIG.question_answer_ms);
    return waitForResponse(sessionDir, threadId, timeoutMs, internalId).then((response) => {
      clearPendingRequest(sessionDir, threadId);
      if (response?.payload) {
        message._client?.resolveServerRequest?.(message.id, response.payload);
        logEvent(session, formatConfirmedEvent(session, { requestId: internalId }));
        logNdjson(session, "CONFIRMED", "serverRequest/resolved", { requestId: internalId });
        return;
      }
      rejectServerRequest(
        message,
        -32e3,
        `requestUserInput timed out after ${timeoutMs}ms without an answer.`
      );
      logNdjson(session, "QUESTION_TIMEOUT", null, { requestId: internalId, timeoutMs });
    }).catch((error) => {
      clearPendingRequest(sessionDir, threadId);
      rejectServerRequest(message, -32e3, error?.message ?? "requestUserInput response handling failed.");
    });
  };
}
function appendTaskFooter(rendered, { jobId, eventsPath, eventsDir, monitorCommand }) {
  if (!jobId) return rendered;
  const base = rendered.endsWith("\n") ? rendered : `${rendered}
`;
  const parts = [`Job: ${jobId}`];
  if (eventsDir) parts.push(`Events dir: ${eventsDir}`);
  if (eventsPath) parts.push(`Events file: ${eventsPath}`);
  if (monitorCommand) parts.push(`Monitor: ${monitorCommand}`);
  return `${base}
${parts.join(" \xB7 ")}
`;
}
function buildMonitorHint({ eventsPath, jobId, threadId, cwd = null }) {
  const identifier = jobId ?? threadId;
  if (!identifier) return null;
  const cliCommand = formatTailCommand({
    scriptPath: SCRIPT_PATH,
    jobId: identifier,
    timeoutMs: 18e5,
    exclude: DEFAULT_MONITOR_EXCLUDE,
    cwd
  });
  const shellFallback = eventsPath ? `tail -f ${JSON.stringify(eventsPath)} | while IFS= read -r line; do echo "$line"; case "$line" in "[DONE]"*|"[ERROR]"*|"[INCOMPLETE]"*|"[PLAN]"*) break ;; esac; done` : null;
  return {
    command: cliCommand,
    shell_fallback: shellFallback,
    terminal_tags: [...TERMINAL_TAGS],
    exclude_tags: [...DEFAULT_MONITOR_EXCLUDE],
    timeout_ms: 18e5,
    tool_hint: {
      description: "codex-bridge task events (excludes heartbeat noise; passes interrupts + checkpoints through)",
      command: cliCommand,
      timeout_ms: 36e5,
      persistent: false
    }
  };
}
function extractItemText(item) {
  if (!item || typeof item !== "object") return null;
  switch (item.type) {
    case "agentMessage":
      return typeof item.text === "string" ? item.text.slice(0, 500) : null;
    case "commandExecution":
      return typeof item.command === "string" ? item.command.slice(0, 200) : null;
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      if (changes.length === 0) {
        return typeof item.path === "string" ? item.path : null;
      }
      const first = changes[0] ?? {};
      const kind = first.kind ?? first.change ?? first.op ?? "";
      const path16 = first.path ?? "";
      const summary = `${kind ? kind + " " : ""}${path16}`.trim();
      if (!summary) return null;
      const suffix = changes.length > 1 ? ` (+${changes.length - 1} more)` : "";
      return `${summary}${suffix}`.slice(0, 200);
    }
    case "plan":
      if (typeof item.title === "string" && item.title.trim()) {
        return item.title.slice(0, 200);
      }
      if (typeof item.text === "string") {
        const firstLine = item.text.split("\n").find((line) => line.trim()) ?? "";
        return firstLine ? firstLine.slice(0, 200) : null;
      }
      return null;
    case "reasoning":
      if (typeof item.summary === "string") {
        return item.summary.slice(0, 200);
      }
      if (Array.isArray(item.summary)) {
        for (const section of item.summary) {
          if (typeof section === "string" && section.trim()) {
            return section.slice(0, 200);
          }
          if (section && typeof section === "object" && typeof section.text === "string" && section.text.trim()) {
            return section.text.slice(0, 200);
          }
        }
      }
      return null;
    case "mcpToolCall":
      if (item.server || item.tool) {
        return `${item.server ?? ""}/${item.tool ?? ""}`.slice(0, 200);
      }
      return null;
    case "commandExecutionOutput":
    case "webSearch":
      if (typeof item.query === "string") return item.query.slice(0, 200);
      return null;
    default:
      return null;
  }
}
var COMMANDS = Object.freeze({
  task: {
    synopsis: "task [--write] [--read-only] [--worktree-auto] [--brief @<path>.json|<inline-json>] [--mode plan|default] [--effort <level>] [-m <model>] [--prompt-file <path>] [--resume|--resume-last] [--fresh] [--background] [--no-pipeline] [--quiet] [--idle-timeout-ms <ms>] [--turn-plan-ms <ms>] [--turn-default-ms <ms>] [--pipeline-stage-timeout-ms <ms>] [--pipeline-total-timeout-ms <ms>] [--question-timeout-ms <ms>] [--legacy-envelope] [--json] [prompt or file.md]",
    summary: "Start a new Codex task. Defaults: plan mode, configured sandbox, foreground. Use --mode default to skip planning and execute directly. --worktree-auto isolates write-mode work in a per-task git worktree. --brief @path.json appends a structured brief to the worker prompt and persists it under the artifact registry.",
    examples: [
      'codex-bridge task --write "Fix the auth bug in src/auth.ts"',
      'codex-bridge task --mode default --write "Trivial typo fix"',
      "codex-bridge task --prompt-file prompt.md --effort high --write",
      'codex-bridge task --resume-last "Continue the previous thread"',
      'codex-bridge task --background --write "Rewrite tests" --json',
      'codex-bridge task --background --write --worktree-auto --brief @brief.json --json "Implement the task described in the structured brief"'
    ]
  },
  send: {
    synopsis: "send <thread-id> [--backend <name>] [--mode plan|default] [--effort <level>] [--quiet] [--idle-timeout-ms <ms>] [--turn-timeout-ms <ms>] [--question-timeout-ms <ms>] [--json] [prompt or file.md]",
    summary: "Resume a thread with a new prompt. Use for plan approval, revisions, and follow-ups. <thread-id> is a UUID returned by task.",
    examples: [
      'codex-bridge send 019d9a86-1c8a-7f41-8032-6c76bbe730a1 --mode default "Implement the plan."',
      'codex-bridge send 019d9a86-1c8a-7f41-8032-6c76bbe730a1 "Revise step 2: use token bucket instead"'
    ]
  },
  steer: {
    synopsis: "steer <thread-id> <turn-id> [--backend <name>] [prompt or file.md]",
    summary: "Send mid-turn guidance to an active Codex turn. Not valid for review/compaction turns. Both ids are UUIDs.",
    examples: ['codex-bridge steer 019d9a86-1c8a-7f41-8032-6c76bbe730a1 019d9a86-2012-7152-bcc9-228a263d286a "Focus on auth first"']
  },
  respond: {
    synopsis: "respond <request-id> [--backend <name>] (--question-id <qid> --answer <answer> | --json-payload <json>) [--json]",
    summary: "Answer a [QUESTION] emitted by Codex (requestUserInput).",
    examples: [
      'codex-bridge respond req-xyz --question-id q1 --answer "jwt"',
      `codex-bridge respond req-xyz --json-payload '{"answers":{"q1":{"answers":["jwt"]}}}'`
    ]
  },
  review: {
    synopsis: "review [--backend <name>] [--task <task_id>] [--scope auto|working-tree|branch] [--base <ref>] [-m <model>] [--json]",
    summary: "Run a standalone code review using Codex's built-in reviewer. With --task, review the task worktree and bind the JSON review_result to the reviewed branch HEAD.",
    examples: [
      "codex-bridge review --scope working-tree",
      "codex-bridge review --scope branch --base main",
      "codex-bridge review --task task-mo5xxx --json"
    ]
  },
  "adversarial-review": {
    synopsis: "adversarial-review [--backend <name>] [--task <task_id>] [--scope auto|working-tree|branch] [--base <ref>] [-m <model>] [--brief @<path>.json] [--concern <text>]... [--json] [focus text...]",
    summary: "Run an adversarial review with a structured JSON result. With --task, review the task worktree and bind the JSON review_result to the reviewed branch HEAD. --brief and --concern populate the {{OPUS_CONCERNS}} channel in the prompt \u2014 the orchestrator's privileged focus signal. Brief items precede flag items and are de-duped while preserving order.",
    examples: [
      'codex-bridge adversarial-review "focus on SQL injection risks"',
      "codex-bridge adversarial-review --scope branch --base main",
      "codex-bridge adversarial-review --brief @review-brief.json",
      `codex-bridge adversarial-review --concern "Don't swallow non-retryable 4xx" --concern "Make timeout configurable"`,
      "codex-bridge adversarial-review --task task-mo5xxx --json"
    ]
  },
  iterate: {
    synopsis: "iterate <task_id_or_prompt> [--max <n>] [--brief <path>] [--backend <name>] [--write] [--json]",
    summary: "Run task -> adversarial review -> verdict -> follow-up until approved or the iteration limit is reached.",
    examples: [
      'codex-bridge iterate "Implement the brief" --max 3 --json',
      "codex-bridge iterate task-abc --max 2"
    ]
  },
  summary: {
    synopsis: "summary <thread-id> [--tail <n>] [--json]",
    summary: "Generate a readable transcript from the NDJSON session log (default tail=200).",
    examples: ["codex-bridge summary 019d9a86-1c8a-7f41-8032-6c76bbe730a1 --tail 400"]
  },
  status: {
    synopsis: "status [job-id] [--all] [--wait] [--watch [--interval 10s] [--watch-timeout-ms <ms>]] [--prune-orphans|--cleanup [--dry-run] [--retention-days <n>] [--retention-jobs <n>]] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]",
    summary: "List jobs, or inspect one by id. With --wait, poll one job to terminal. With --watch, repeatedly render the multi-job table and exit when all tracked jobs reach terminal state (Ctrl-C-safe). Use --watch for N-job orchestration.",
    examples: [
      "codex-bridge status",
      "codex-bridge status task-abc --wait --timeout-ms 600000",
      "codex-bridge status --all --json",
      "codex-bridge status --watch --interval 5s",
      "codex-bridge status --watch --all --json"
    ]
  },
  result: {
    synopsis: "result [job-id] [--json]",
    summary: "Get the full result of a completed job. Omit job-id for the latest in this session.",
    examples: ["codex-bridge result task-abc --json"]
  },
  wait: {
    synopsis: "wait [--any] <job-id-or-thread-id...> [--timeout-ms <ms>] [--json]",
    summary: "Block until target job events emit [DONE], [ERROR], [INCOMPLETE], or [PLAN]. With --any, return the first terminal job from N targets.",
    examples: [
      "codex-bridge wait task-abc --timeout-ms 600000 --json",
      "codex-bridge wait --any task-a task-b task-c --json",
      "codex-bridge wait 019d9a86-1c8a-7f41-8032-6c76bbe730a1"
    ]
  },
  events: {
    synopsis: "events <job-id-or-thread-id> [--follow] [--filter <tags> | --exclude <tags>] [--timeout-ms <ms>] [--json]",
    summary: "Stream the target's events file. `--filter` keeps only listed tags (inclusion); `--exclude` drops listed tags and shows everything else (exclusion \u2014 forward-compatible default for Monitor). Flags are mutually exclusive.",
    examples: [
      "codex-bridge events task-abc --follow --exclude HEARTBEAT  # default Monitor shape",
      "codex-bridge events task-abc --filter DONE,ERROR,INCOMPLETE,PLAN  # narrow inclusion view",
      "codex-bridge events 019d9a86-1c8a-7f41-8032-6c76bbe730a1 --follow --exclude HEARTBEAT,CHECKPOINT --timeout-ms 600000"
    ]
  },
  cancel: {
    synopsis: "cancel [job-id] [--json]",
    summary: "Cancel a running job. Attempts `turn/interrupt` before terminating the worker tree.",
    examples: ["codex-bridge cancel task-abc"]
  },
  merge: {
    synopsis: "merge <task_id> [--no-tests] [--pr] [--json]",
    summary: "Fast-forward merge an approved worktree task branch back into its recorded base ref.",
    examples: [
      "codex-bridge merge task-abc --json",
      "codex-bridge merge task-abc --no-tests"
    ]
  },
  "await-artifact": {
    synopsis: "await-artifact <job-id> <path> [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]",
    summary: "Block until <path> exists and is stable (size unchanged across consecutive polls), or the target job reaches a terminal state, or timeout. Primitive for multi-job orchestration when success = 'artifact exists at path'. Exit 7 on timeout or job-terminal-without-artifact.",
    examples: [
      "codex-bridge await-artifact task-abc report.md --timeout-ms 600000",
      "codex-bridge await-artifact 019d9a86-1c8a-7f41-8032-6c76bbe730a1 ./out/summary.json --json"
    ]
  },
  setup: {
    synopsis: "setup [--json] [--enable-review-gate | --disable-review-gate]",
    summary: "Health check: Node/npm/Codex install, auth, broker runtime; toggle stop-gate review.",
    examples: ["codex-bridge setup --json"]
  },
  version: {
    synopsis: "version [--backend <name>] [--check-update] [--json]",
    summary: "Print bridge version, schema version, Node version, Codex version, active backend, capability list, and cached update status. `--check-update` forces a fresh GitHub round-trip.",
    examples: ["codex-bridge version --json", "codex-bridge version --backend codex --json", "codex-bridge version --check-update --json"]
  },
  update: {
    synopsis: "update [--force] [--apply|--yes] [--json]",
    summary: "Check GitHub releases for a newer codex-bridge and print the install recipe. Does not self-modify the skill \u2014 run the printed command yourself when you want to upgrade.",
    examples: ["codex-bridge update --json", "codex-bridge update --force"]
  },
  config: {
    synopsis: "config show [--json]",
    summary: "Show effective merged config + which files the values came from (defaults < skill-dir < workspace-root < cwd). Use when a config knob seems to have no effect.",
    examples: ["codex-bridge config show", "codex-bridge config show --json"]
  },
  "auth-status": {
    synopsis: "auth-status [--json]",
    summary: "Report Codex auth state (thin wrapper; `setup` is the heavyweight equivalent).",
    examples: ["codex-bridge auth-status --json"]
  },
  "task-resume-candidate": {
    synopsis: "task-resume-candidate [--json]",
    summary: "Report the latest resumable task for this Claude session (useful before `task --resume`).",
    examples: ["codex-bridge task-resume-candidate --json"]
  },
  verdict: {
    synopsis: "verdict <task-id> [--set approved|needs-attention|must-fix --summary <text> [--finding <text>]... | --payload-stdin | --discard] [--json]",
    summary: "Read or write a task's verdict.json. Read mode (no flags) prints the current verdict. Write mode (--set) persists; stdin mode (--payload-stdin) reads a JSON object without putting review text in argv. --discard removes the artifact directory and clears the Stop gate's pending list. The Stop hook blocks while approved verdicts are unmerged.",
    examples: [
      "codex-bridge verdict task-mo5xxx",
      'codex-bridge verdict task-mo5xxx --set approved --summary "Tests green; concerns dismissed."',
      'codex-bridge verdict task-mo5xxx --set must-fix --finding "Drops 4xx errors silently" --json',
      "codex-bridge verdict task-mo5xxx --payload-stdin --json",
      "codex-bridge verdict task-mo5xxx --discard"
    ]
  },
  verdicts: {
    synopsis: "verdicts --pending [--json]",
    summary: "Flat list of approved-but-unmerged or needs-attention verdicts. Used by the Stop gate hook to decide whether to block session exit. Idempotent.",
    examples: ["codex-bridge verdicts --pending --json"]
  }
});
var EXIT_CODE_DOC = [
  "Exit codes:",
  "  0  success",
  "  1  crash / unhandled internal error",
  "  2  usage error (unknown subcommand, unknown flag, missing argument)",
  "  3  not found (job, thread, or resource)",
  "  4  auth failure (run `codex login`)",
  "  5  conflict (already running, state mismatch)",
  "  6  validation error (bad input)",
  "  7  transient error (timeout, network, rate-limit)  \u2014 retry with backoff",
  "  8  partial success (check result details)"
].join("\n");
var GLOBAL_FLAGS_DOC = [
  "Global flags (every subcommand):",
  "  --json            Machine-readable output (error envelope under failures).",
  "  -C, --cwd <dir>   Override the working directory.",
  "  -h, --help        Show help for the subcommand and exit."
].join("\n");
function printUsage() {
  const lines = ["Usage:"];
  for (const name of Object.keys(COMMANDS)) {
    lines.push(`  codex-bridge ${COMMANDS[name].synopsis}`);
  }
  lines.push("", GLOBAL_FLAGS_DOC, "", EXIT_CODE_DOC, "", "Run `codex-bridge <subcommand> --help` for per-command details.");
  console.log(lines.join("\n"));
}
function printSubcommandUsage(name) {
  const entry = COMMANDS[name];
  if (!entry) {
    printUsage();
    return;
  }
  const lines = [
    `codex-bridge ${entry.synopsis}`,
    "",
    entry.summary
  ];
  if (entry.examples?.length) {
    lines.push("", "Examples:");
    for (const example of entry.examples) {
      lines.push(`  ${example}`);
    }
  }
  lines.push("", GLOBAL_FLAGS_DOC, "", EXIT_CODE_DOC);
  console.log(lines.join("\n"));
}
function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}
function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw validationError(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`,
      "INVALID_EFFORT"
    );
  }
  return normalized;
}
function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  const out = [];
  for (const element of argv) {
    if (typeof element === "string" && /\s/.test(element) && element.trimStart().startsWith("-")) {
      const tokens = splitRawArgumentString(element);
      if (tokens.length > 1) {
        out.push(...tokens);
        continue;
      }
    }
    out.push(element);
  }
  return out;
}
function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...config.aliasMap ?? {}
    }
  });
}
function resolveCommandCwd(options = {}) {
  return options.cwd ? path15.resolve(process10.cwd(), options.cwd) : process10.cwd();
}
function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}
function resolveStopReviewGateLockPath(workspaceRoot) {
  return path15.join(workspaceRoot, STOP_REVIEW_GATE_LOCK_FILE);
}
function readStopReviewGate(workspaceRoot, officialPlugin = detectOfficialOpenAICodexPlugin({ cwd: workspaceRoot })) {
  const lockPath = resolveStopReviewGateLockPath(workspaceRoot);
  let lockExists = fs17.existsSync(lockPath);
  let migratedFromLegacyConfig = false;
  if (!lockExists) {
    let legacyEnabled = false;
    try {
      legacyEnabled = getConfig(workspaceRoot)?.stopReviewGate === true;
    } catch {
      legacyEnabled = false;
    }
    if (legacyEnabled) {
      try {
        fs17.writeFileSync(
          lockPath,
          [
            "# Codex Bridge stop-time review gate",
            "# Presence of this file enables the Claude Code Stop hook for this project.",
            "# Migrated from legacy state.json config.stopReviewGate=true.",
            ""
          ].join("\n"),
          "utf8"
        );
        lockExists = true;
        migratedFromLegacyConfig = true;
      } catch {
        lockExists = true;
        migratedFromLegacyConfig = true;
      }
    }
  }
  const reviewGateSuppressionReason = officialPlugin.status === OFFICIAL_PLUGIN_STATUS.ACTIVE ? "official-openai-codex-plugin-active" : officialPlugin.status === OFFICIAL_PLUGIN_STATUS.UNKNOWN ? "official-openai-codex-plugin-status-unknown" : null;
  return {
    enabled: lockExists && reviewGateSuppressionReason == null,
    lockPath,
    lockExists,
    migratedFromLegacyConfig,
    officialOpenAICodexPluginStatus: officialPlugin.status,
    officialOpenAICodexPlugin: officialPlugin.plugin ?? null,
    officialOpenAICodexPluginDetail: officialPlugin.detail ?? null,
    reviewGateSuppressedByOfficialPlugin: officialPlugin.status === OFFICIAL_PLUGIN_STATUS.ACTIVE,
    reviewGateLockIgnored: lockExists && reviewGateSuppressionReason != null,
    reviewGateSuppressionReason
  };
}
function setStopReviewGate(workspaceRoot, enabled, officialPlugin = detectOfficialOpenAICodexPlugin({ cwd: workspaceRoot })) {
  const lockPath = resolveStopReviewGateLockPath(workspaceRoot);
  if (enabled) {
    try {
      fs17.writeFileSync(
        lockPath,
        [
          "# Codex Bridge stop-time review gate",
          "# Presence of this file enables the Claude Code Stop hook for this project.",
          ""
        ].join("\n"),
        "utf8"
      );
    } catch {
    }
  } else {
    try {
      fs17.rmSync(lockPath, { force: true });
    } catch {
    }
    try {
      setConfig(workspaceRoot, "stopReviewGate", false);
    } catch {
    }
  }
  return readStopReviewGate(workspaceRoot, officialPlugin);
}
function applyStopReviewGateSnapshot(snapshot) {
  const gate = readStopReviewGate(snapshot.workspaceRoot);
  return {
    ...snapshot,
    officialOpenAICodexPluginStatus: gate.officialOpenAICodexPluginStatus,
    officialOpenAICodexPlugin: gate.officialOpenAICodexPlugin,
    officialOpenAICodexPluginDetail: gate.officialOpenAICodexPluginDetail,
    reviewGateSuppressedByOfficialPlugin: gate.reviewGateSuppressedByOfficialPlugin,
    reviewGateLockIgnored: gate.reviewGateLockIgnored,
    reviewGateSuppressionReason: gate.reviewGateSuppressionReason,
    config: {
      ...snapshot.config,
      stopReviewGate: gate.enabled,
      stopReviewGateLockPath: gate.lockPath,
      stopReviewGateLockExists: gate.lockExists,
      officialOpenAICodexPluginStatus: gate.officialOpenAICodexPluginStatus,
      reviewGateSuppressedByOfficialPlugin: gate.reviewGateSuppressedByOfficialPlugin,
      reviewGateLockIgnored: gate.reviewGateLockIgnored,
      reviewGateSuppressionReason: gate.reviewGateSuppressionReason
    },
    needsReview: gate.enabled
  };
}
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function shorten2(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}
function firstMeaningfulLine2(text, fallback) {
  const line = String(text ?? "").split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  return line ?? fallback;
}
function installSandboxEnforcementForSetup() {
  try {
    return installSandboxEnforcement();
  } catch (err) {
    throw validationError(
      err instanceof Error ? err.message : String(err),
      "SANDBOX_ENFORCEMENT_INSTALL_FAILED",
      "Fix ~/.claude/settings.json so permissions.deny is a JSON array, then rerun setup --enforce-sandbox."
    );
  }
}
function uninstallSandboxEnforcementForSetup() {
  try {
    return uninstallSandboxEnforcement();
  } catch (err) {
    throw validationError(
      err instanceof Error ? err.message : String(err),
      "SANDBOX_ENFORCEMENT_UNINSTALL_FAILED",
      "Fix ~/.claude/settings.json so permissions.deny is a JSON array, then rerun setup --disable-sandbox-enforcement."
    );
  }
}
async function buildSetupReport(cwd, actionsTaken = [], options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const officialPlugin = options.officialPlugin ?? detectOfficialOpenAICodexPlugin({ cwd });
  const reviewGate = readStopReviewGate(workspaceRoot, officialPlugin);
  const adapter2 = await resolveCommandAdapter({ cwd, workspaceRoot });
  const sandboxEnforcement = getSandboxEnforcementStatus();
  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (reviewGate.reviewGateSuppressedByOfficialPlugin) {
    nextSteps.push("Use the official OpenAI Codex plugin for stop-time review; Codex Bridge review gate is disabled while it is enabled.");
  } else if (reviewGate.reviewGateSuppressionReason === "official-openai-codex-plugin-status-unknown") {
    nextSteps.push("Codex Bridge could not verify whether the official OpenAI Codex plugin is active, so it will not enable a duplicate stop-time review gate.");
  } else if (!reviewGate.enabled) {
    nextSteps.push("Optional: run `codex-bridge setup --enable-review-gate` to create a project lock file for stop-time review.");
  }
  if (sandboxEnforcement.settingsParseError) {
    nextSteps.push(`Sandbox enforcement status could not read ${sandboxEnforcement.settingsPath}: ${sandboxEnforcement.settingsParseError}.`);
  } else if (!sandboxEnforcement.installed) {
    nextSteps.push("Optional: run `codex-bridge setup --enforce-sandbox` to deny sandbox downgrades at the Claude permission layer.");
  }
  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    active_backend: adapter2.name,
    adapter_capabilities: adapter2.capabilities(),
    sessionRuntime: getSessionRuntimeStatus(process10.env, workspaceRoot),
    reviewGateEnabled: reviewGate.enabled,
    reviewGateLockPath: reviewGate.lockPath,
    reviewGateLockExists: reviewGate.lockExists,
    officialOpenAICodexPluginStatus: reviewGate.officialOpenAICodexPluginStatus,
    officialOpenAICodexPlugin: reviewGate.officialOpenAICodexPlugin,
    officialOpenAICodexPluginDetail: reviewGate.officialOpenAICodexPluginDetail,
    reviewGateSuppressedByOfficialPlugin: reviewGate.reviewGateSuppressedByOfficialPlugin,
    reviewGateLockIgnored: reviewGate.reviewGateLockIgnored,
    reviewGateSuppressionReason: reviewGate.reviewGateSuppressionReason,
    sandboxEnforcementInstalled: sandboxEnforcement.installed,
    sandboxEnforcementSettingsPath: sandboxEnforcement.settingsPath,
    sandboxEnforcementSettingsExists: sandboxEnforcement.settingsExists,
    sandboxEnforcementSettingsParseError: sandboxEnforcement.settingsParseError,
    actionsTaken,
    nextSteps
  };
}
async function handleSetup(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate", "enforce-sandbox", "disable-sandbox-enforcement"]
  });
  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw conflictError(
      "Choose either --enable-review-gate or --disable-review-gate.",
      "REVIEW_GATE_CONFLICT"
    );
  }
  if (options["enforce-sandbox"] && options["disable-sandbox-enforcement"]) {
    throw conflictError(
      "Choose either --enforce-sandbox or --disable-sandbox-enforcement.",
      "SANDBOX_ENFORCEMENT_CONFLICT"
    );
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];
  const officialPlugin = detectOfficialOpenAICodexPlugin({ cwd, maxAgeMs: 0 });
  if (options["enable-review-gate"]) {
    if (officialPlugin.status === OFFICIAL_PLUGIN_STATUS.ABSENT) {
      const reviewGate = setStopReviewGate(workspaceRoot, true, officialPlugin);
      if (reviewGate.enabled && reviewGate.lockExists) {
        actionsTaken.push(`Enabled the project stop-time review gate via ${reviewGate.lockPath}.`);
      } else {
        actionsTaken.push(
          `Failed to create the stop-time review gate lock at ${reviewGate.lockPath}; the gate is NOT enabled. Check write permissions on the git project root, then rerun \`codex-bridge setup --enable-review-gate\`.`
        );
      }
    } else if (officialPlugin.status === OFFICIAL_PLUGIN_STATUS.ACTIVE) {
      actionsTaken.push("Skipped enabling the Codex Bridge stop-time review gate because the official OpenAI Codex plugin is enabled.");
    } else {
      actionsTaken.push("Skipped enabling the Codex Bridge stop-time review gate because the official OpenAI Codex plugin status could not be verified.");
    }
  } else if (options["disable-review-gate"]) {
    const reviewGate = setStopReviewGate(workspaceRoot, false, officialPlugin);
    if (reviewGate.lockExists) {
      actionsTaken.push(
        `Failed to remove the stop-time review gate lock at ${reviewGate.lockPath}; the gate is still active. Please remove the lock file manually.`
      );
    } else {
      actionsTaken.push(
        `Disabled the project stop-time review gate by removing ${reviewGate.lockPath}.`
      );
    }
  }
  if (options["enforce-sandbox"]) {
    const result = installSandboxEnforcementForSetup();
    actionsTaken.push(
      result.alreadyInstalled ? `Sandbox enforcement deny rules already present in ${result.status.settingsPath}.` : `Installed sandbox enforcement deny rules in ${result.status.settingsPath}.`
    );
  } else if (options["disable-sandbox-enforcement"]) {
    const result = uninstallSandboxEnforcementForSetup();
    actionsTaken.push(
      result.removed > 0 ? `Removed ${result.removed} sandbox enforcement deny rule${result.removed === 1 ? "" : "s"} from ${result.status.settingsPath}.` : `Sandbox enforcement deny rules were not present in ${result.status.settingsPath}.`
    );
  }
  const finalReport = await buildSetupReport(cwd, actionsTaken, { officialPlugin });
  emitSuccess("setup", finalReport, renderSetupReport(finalReport), {
    json: options.json,
    startedAt
  });
}
var BRIDGE_VERSION = package_default.version;
var BRIDGE_SCHEMA_VERSION = "1.0";
var BRIDGE_CAPABILITIES = Object.freeze([
  "plan-mode",
  "background-jobs",
  "auto-pipeline",
  "adversarial-review",
  "stop-gate-review",
  "structured-errors",
  "per-subcommand-help",
  "machine-readable-help",
  "workspace-config-override",
  "update-check",
  "backend-adapter"
]);
async function handleVersion(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "backend"],
    booleanOptions: ["json", "check-update"]
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const adapter2 = await resolveCommandAdapter({ cwd, workspaceRoot, backend: options.backend });
  const codex = getCodexAvailability(cwd);
  const update = await checkForUpdate({
    currentVersion: BRIDGE_VERSION,
    force: Boolean(options["check-update"])
  });
  const payload = {
    version: BRIDGE_VERSION,
    schema_version: BRIDGE_SCHEMA_VERSION,
    node_version: process10.version,
    codex: {
      available: codex.available,
      detail: codex.detail ?? null
    },
    capabilities: [...BRIDGE_CAPABILITIES],
    active_backend: adapter2.name,
    adapter_capabilities: adapter2.capabilities(),
    update: {
      latest_version: update.latestVersion ?? null,
      has_update: Boolean(update.hasUpdate),
      checked_at_age_ms: update.cacheAgeMs ?? null,
      check_skipped: Boolean(update.skipped),
      check_skip_reason: update.reason ?? null
    }
  };
  const updateLine = formatUpdateNotice(update);
  const rendered = [
    `codex-bridge ${payload.version} (schema ${payload.schema_version})`,
    `  node:  ${payload.node_version}`,
    `  codex: ${codex.available ? codex.detail ?? "available" : "not installed"}`,
    `  backend: ${payload.active_backend}`,
    `  caps:  ${payload.capabilities.join(", ")}`,
    updateLine ? `  update: ${updateLine}` : `  update: up to date${update.latestVersion ? ` (latest ${update.latestVersion})` : ""}`
  ].join("\n") + "\n";
  emitSuccess("version", payload, rendered, { json: options.json, startedAt });
}
async function handleConfigShow(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const action = positionals[0] ?? "show";
  if (action !== "show") {
    throw usageError(
      `config: unknown action '${action}'. Supported: show.`
    );
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sources = resolveConfigSources(ROOT_DIR, cwd, workspaceRoot);
  const effective = getBridgeConfig(cwd, workspaceRoot);
  const diagnostics = validateConfigLayers(ROOT_DIR, cwd, workspaceRoot);
  const overrides = {};
  for (const [k, v] of Object.entries(effective)) {
    if (JSON.stringify(DEFAULT_CONFIG[k]) !== JSON.stringify(v)) {
      overrides[k] = v;
    }
  }
  const payload = {
    sources: {
      defaults: "(built into src/lib/config.mjs::DEFAULT_CONFIG)",
      skill_config_path: sources.skillConfigPath,
      skill_config_exists: sources.skillConfigExists,
      workspace_config_path: sources.workspaceConfigPath,
      workspace_config_exists: sources.workspaceConfigExists,
      override_config_path: sources.overrideConfigPath,
      override_config_exists: sources.overrideConfigExists
    },
    effective_config: effective,
    overrides_vs_defaults: overrides,
    diagnostics,
    warnings: diagnostics.filter((d) => d.severity === "warning"),
    errors: diagnostics.filter((d) => d.severity === "error"),
    precedence_order_low_to_high: [
      "DEFAULT_CONFIG",
      "skill-dir config.yaml",
      "workspace-root config.yaml",
      "cwd config.yaml"
    ]
  };
  const linePresence = (p, ok) => p ? `${p} (${ok ? "present" : "not found"})` : "(n/a \u2014 cwd == workspace root)";
  const lines = [
    "Config resolution (lowest \u2192 highest precedence):",
    `  1. built-in defaults \u2014 src/lib/config.mjs::DEFAULT_CONFIG`,
    `  2. skill-dir         \u2014 ${linePresence(sources.skillConfigPath, sources.skillConfigExists)}`,
    `  3. workspace-root    \u2014 ${linePresence(sources.workspaceConfigPath, sources.workspaceConfigExists)}`,
    `  4. cwd               \u2014 ${linePresence(sources.overrideConfigPath, sources.overrideConfigExists)}`,
    "",
    "Effective config:"
  ];
  for (const [k, v] of Object.entries(effective)) {
    const marker = Object.prototype.hasOwnProperty.call(overrides, k) ? "*" : " ";
    const preview = typeof v === "string" && v.length > 70 ? `${v.slice(0, 67)}...` : JSON.stringify(v);
    lines.push(`  ${marker} ${k}: ${preview}`);
  }
  if (Object.keys(overrides).length > 0) {
    lines.push("", "* = differs from DEFAULT_CONFIG");
  }
  if (diagnostics.length > 0) {
    lines.push("", "Diagnostics:");
    for (const diagnostic of diagnostics) {
      lines.push(`  ${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.source}:${diagnostic.key ?? "(file)"} \u2014 ${diagnostic.message}`);
    }
  }
  const rendered = `${lines.join("\n")}
`;
  emitSuccess("config", payload, rendered, { json: options.json, startedAt });
}
async function handleUpdate(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "force", "apply", "yes"]
  });
  const update = await checkForUpdate({
    currentVersion: BRIDGE_VERSION,
    force: Boolean(options.force)
  });
  const installCommand = "npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y";
  const wantApply = Boolean(options.apply || options.yes);
  if (wantApply && update.hasUpdate && update.latestVersion) {
    const applyResult = runSkillsAddForApply(options.json);
    const payload2 = {
      current_version: BRIDGE_VERSION,
      latest_version: update.latestVersion ?? null,
      has_update: true,
      update_check: {
        cached: Boolean(update.cached),
        skipped: Boolean(update.skipped),
        reason: update.reason ?? null,
        fetch_reason: update.fetchReason ?? null,
        fetch_status: update.fetchStatus ?? null,
        cache_age_ms: update.cacheAgeMs ?? null
      },
      apply: {
        requested: true,
        command: applyResult.command,
        ok: applyResult.ok,
        exit_code: applyResult.exitCode,
        error: applyResult.error,
        timed_out: Boolean(applyResult.timedOut)
      },
      applied: applyResult.ok,
      apply_exit_code: applyResult.exitCode,
      apply_error: applyResult.error,
      install_command: installCommand
    };
    const rendered2 = applyResult.ok ? `Installed codex-bridge ${update.latestVersion} (was ${BRIDGE_VERSION}). Re-invoke the skill to pick up the new files.
` : `Attempted to install ${update.latestVersion} (from ${BRIDGE_VERSION}) but the installer exited ${applyResult.exitCode}.
` + (applyResult.error ? `  ${applyResult.error}
` : "") + `Re-run manually: ${installCommand}
`;
    if (applyResult.ok) {
      emitSuccess("update", payload2, rendered2, { json: options.json, startedAt });
    } else {
      const err = new CliError(
        applyResult.timedOut ? "skills installer timed out" : `skills installer exited ${applyResult.exitCode}`,
        {
          class: "dependency_failed",
          code: "UPDATE_APPLY_FAILED",
          retryable: true,
          suggestion: `Re-run manually: ${installCommand}`,
          details: {
            command: applyResult.command,
            exitCode: applyResult.exitCode,
            error: applyResult.error,
            timedOut: Boolean(applyResult.timedOut)
          },
          nextAction: {
            kind: "manual-update",
            command: installCommand,
            description: "Run the installer manually after checking npm/network availability."
          }
        }
      );
      emitError(err, { json: options.json, command: "update" });
    }
    return;
  }
  const payload = {
    current_version: BRIDGE_VERSION,
    latest_version: update.latestVersion ?? null,
    has_update: Boolean(update.hasUpdate),
    update_check: {
      cached: Boolean(update.cached),
      skipped: Boolean(update.skipped),
      reason: update.reason ?? null,
      fetch_reason: update.fetchReason ?? null,
      fetch_status: update.fetchStatus ?? null,
      cache_age_ms: update.cacheAgeMs ?? null
    },
    apply: {
      requested: wantApply,
      skipped: wantApply ? update.hasUpdate ? null : "no-update" : "not-requested",
      command: installCommand
    },
    check_skipped: Boolean(update.skipped),
    check_skip_reason: update.reason ?? null,
    fetch_reason: update.fetchReason ?? null,
    fetch_status: update.fetchStatus ?? null,
    install_command: installCommand,
    // --apply was requested but nothing to install: echo back the intent
    // so scripted callers can tell "no action taken" from "skipped".
    applied: wantApply && !update.hasUpdate ? false : null
  };
  let rendered;
  if (update.skipped && !update.latestVersion) {
    rendered = renderUpdateFailureHint(update, BRIDGE_VERSION);
  } else if (update.hasUpdate) {
    rendered = `codex-bridge ${update.latestVersion} available (you have ${BRIDGE_VERSION}).
To update, run:
  ${installCommand}
Or rerun with --apply to install automatically.
`;
  } else {
    rendered = `codex-bridge is up to date (${BRIDGE_VERSION}${update.latestVersion ? `, latest ${update.latestVersion}` : ""}).
`;
  }
  emitSuccess("update", payload, rendered, { json: options.json, startedAt });
}
function runSkillsAddForApply(jsonMode) {
  const command = "npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y";
  const timeoutMs = 6e5;
  try {
    const result = spawnSync4(
      "npx",
      ["-y", "skills@latest", "add", "yigitkonur/codex-bridge", "-a", "claude-code", "-g", "-y"],
      {
        stdio: jsonMode ? ["ignore", "pipe", "pipe"] : "inherit",
        encoding: "utf8",
        timeout: timeoutMs
      }
    );
    if (result.error) {
      return {
        ok: false,
        exitCode: null,
        error: result.error.code === "ENOENT" ? "npx not found on PATH; install Node.js to get npx" : result.error.code === "ETIMEDOUT" ? `skills installer timed out after ${Math.round(timeoutMs / 1e3)}s` : result.error.message,
        command,
        timedOut: result.error.code === "ETIMEDOUT"
      };
    }
    if (result.status !== 0) {
      const stderrTail = typeof result.stderr === "string" ? result.stderr.trim().split("\n").slice(-3).join("\n") : null;
      return { ok: false, exitCode: result.status, error: stderrTail || null, command, timedOut: false };
    }
    return { ok: true, exitCode: 0, error: null, command, timedOut: false };
  } catch (err) {
    return { ok: false, exitCode: null, error: err?.message ?? String(err), command, timedOut: false };
  }
}
function renderUpdateFailureHint(update, currentVersion) {
  const reason = update.fetchReason ?? update.reason ?? "unknown";
  const lines = [`Update check failed (current: ${currentVersion}, reason: ${reason}).`];
  if (reason === "timeout" || reason === "network") {
    lines.push("Network error reaching api.github.com. Retry in a moment.");
  } else if (update.fetchStatus === 403) {
    lines.push("GitHub returned 403 \u2014 likely the anonymous 60/hr rate limit. Wait an hour or re-run from a different IP.");
  } else if (update.fetchStatus === 404) {
    lines.push("GitHub returned 404. Re-run with --force; if it persists, the release endpoint may be temporarily unreachable.");
  } else {
    lines.push("Retry with --force; if it persists, check network connectivity to api.github.com.");
  }
  return lines.join("\n") + "\n";
}
async function handleAuthStatus(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const auth = await getCodexAuthStatus(cwd);
  const status = auth.loggedIn ? "logged in" : "not logged in";
  const provider = auth.provider ? ` via ${auth.provider}` : "";
  const lines = [`Auth: ${status}${provider}.`];
  if (auth.detail) lines.push(`  ${auth.detail}`);
  if (!auth.loggedIn && auth.requiresOpenaiAuth) {
    lines.push("  \u2192 Run `codex login` (or `codex login --device-auth`).");
  }
  emitSuccess("auth-status", auth, `${lines.join("\n")}
`, {
    json: options.json,
    startedAt
  });
}
function buildMachineReadableHelp() {
  return {
    version: BRIDGE_VERSION,
    schema_version: BRIDGE_SCHEMA_VERSION,
    commands: Object.entries(COMMANDS).map(([name, entry]) => ({
      name,
      synopsis: `codex-bridge ${entry.synopsis}`,
      summary: entry.summary,
      examples: entry.examples ?? []
    })),
    global_flags: [
      { flag: "--json", alias: "-j", description: "Machine-readable output (error envelope on failure)." },
      { flag: "--cwd <dir>", alias: "-C", description: "Override the working directory." },
      { flag: "--help", alias: "-h", description: "Show per-subcommand help and exit." }
    ],
    exit_codes: {
      0: "success",
      1: "crash / unhandled internal error",
      2: "usage (unknown subcommand, unknown flag, missing argument)",
      3: "not_found (job, thread, resource)",
      4: "auth (run `codex login`)",
      5: "conflict (already running, state mismatch)",
      6: "validation (bad input)",
      7: "transient (timeout, network, rate-limit) \u2014 retry with backoff",
      8: "partial_success (check result details)"
    }
  };
}
function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new CliError(
      "Codex CLI is not installed or is missing required runtime support.",
      {
        class: "dependency_failed",
        code: "CODEX_UNAVAILABLE",
        retryable: false,
        suggestion: "Install Codex with `npm install -g @openai/codex`, then rerun `setup`."
      }
    );
  }
}
function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }
  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }
  return null;
}
function validateNativeReviewRequest(target, focusText, extras = {}) {
  if (focusText.trim()) {
    throw validationError(
      "`review` maps to the built-in reviewer and does not support custom focus text.",
      "REVIEW_FOCUS_UNSUPPORTED",
      `Retry with \`adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }
  if (extras.brief) {
    throw validationError(
      "`review` does not accept --brief. The orchestrator-concerns channel is only honored by adversarial-review.",
      "REVIEW_BRIEF_UNSUPPORTED",
      "Retry with `adversarial-review --brief @<path>.json` to surface the brief's specific_concerns to the reviewer."
    );
  }
  if (Array.isArray(extras.opusConcerns) && extras.opusConcerns.length > 0) {
    throw validationError(
      "`review` does not accept --concern. The orchestrator-concerns channel is only honored by adversarial-review.",
      "REVIEW_CONCERN_UNSUPPORTED",
      'Retry with `adversarial-review --concern "..."` (repeatable) to surface focus areas to the reviewer.'
    );
  }
  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw validationError(
      "This `review` target is not supported by the built-in reviewer.",
      "REVIEW_TARGET_UNSUPPORTED",
      "Retry with `adversarial-review` for custom targeting."
    );
  }
  return nativeTarget;
}
function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}
function getCurrentClaudeSessionId() {
  return process10.env[SESSION_ID_ENV] ?? null;
}
function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}
function findLatestResumableTaskJob(jobs) {
  return jobs.find(
    (job) => job.jobClass === "task" && job.threadId && job.status === "completed"
  ) ?? null;
}
async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);
  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep2(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }
  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}
async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst2(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw conflictError(
      `Task ${activeTask.id} is still running.`,
      "TASK_ALREADY_RUNNING",
      `Run \`status ${activeTask.id}\` (or \`cancel ${activeTask.id}\`) before continuing.`
    );
  }
  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }
  if (sessionId) {
    return null;
  }
  return findLatestTaskThread(workspaceRoot);
}
async function executeReviewRun(request) {
  const adapter2 = await resolveCommandAdapter({
    cwd: request.cwd,
    workspaceRoot: resolveWorkspaceRoot(request.cwd),
    backend: request.backend ?? null
  });
  ensureCodexRuntimeAdapter(adapter2);
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);
  const startedAt = Date.now();
  const reviewConfig = getBridgeConfig(request.cwd, resolveWorkspaceRoot(request.cwd));
  const reviewSessionDir = resolveSessionDir(reviewConfig.session_dir, resolveWorkspaceRoot(request.cwd));
  const logReviewTerminalEvent = (session, result2, { reviewKind, targetLabel }) => {
    if (result2.status === 0) {
      logEvent(session, formatDoneEvent(session, {
        duration: Math.round((Date.now() - startedAt) / 1e3),
        diffStat: `${reviewKind} review completed: ${targetLabel}`,
        files: [],
        config: {
          model: request.model ?? reviewConfig.model,
          effort: reviewConfig.effort,
          modeFlow: reviewKind
        },
        diffPath: "not captured for review",
        scriptPath: SCRIPT_PATH,
        jobId: request.jobId ?? null,
        cwd: request.cwd
      }));
      return;
    }
    const classified = classifyError(result2.error ?? { message: result2.stderr || `${reviewKind} review failed.` });
    logEvent(session, formatErrorEvent(session, {
      errorCode: classified.code,
      message: classified.message,
      phase: classified.class,
      origin: "review",
      scriptPath: SCRIPT_PATH,
      jobId: request.jobId ?? null,
      cwd: request.cwd
    }));
  };
  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  if (target.mode === "working-tree") {
    const diffCheck = runCommand("git", ["diff", "--quiet"], { cwd: request.cwd });
    const stagedCheck = runCommand("git", ["diff", "--cached", "--quiet"], { cwd: request.cwd });
    const untrackedCheck = runCommand("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: request.cwd
    });
    if (diffCheck.status === 0 && stagedCheck.status === 0 && untrackedCheck.status === 0 && untrackedCheck.stdout.trim() === "") {
      throw new CliError("No working-tree changes to review.", {
        class: "validation",
        code: "REVIEW_EMPTY_DIFF",
        retryable: false,
        suggestion: "Make a change (working tree or staged) before invoking `review`, or use --scope branch to review a branch vs base."
      });
    }
  }
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText, {
      brief: request.brief,
      opusConcerns: request.opusConcerns
    });
    const result2 = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      idleTimeoutMs: Number(reviewConfig.idle_timeout_ms) > 0 ? Number(reviewConfig.idle_timeout_ms) : DEFAULT_CONFIG.idle_timeout_ms,
      turnTimeoutMs: Number(reviewConfig.turn_default_ms) > 0 ? Number(reviewConfig.turn_default_ms) : DEFAULT_CONFIG.turn_default_ms,
      onProgress: request.onProgress
    });
    if (result2.threadId) {
      const reviewSession = findSession(reviewSessionDir, result2.threadId) ?? initSession(reviewSessionDir, result2.threadId);
      logNdjson(reviewSession, "TURN_COMPLETED", "turn/completed", {
        turnId: result2.turnId,
        status: result2.status,
        reviewKind: "native",
        target
      });
      logReviewTerminalEvent(reviewSession, result2, {
        reviewKind: "native",
        targetLabel: target.label
      });
    }
    const reviewResult = result2.status === 0 ? normalizeNativeReviewResult({
      reviewText: result2.reviewText,
      target,
      task_id: request.taskId ?? null,
      reviewed_branch_head_sha: request.reviewedBranchHeadSha ?? null
    }) : null;
    if (request.taskId && reviewResult) {
      writeReview2(request.taskId, reviewResult);
    }
    const payload2 = {
      review: reviewName,
      target,
      review_result: reviewResult,
      threadId: result2.threadId,
      sourceThreadId: result2.sourceThreadId,
      codex: {
        status: result2.status,
        stderr: result2.stderr,
        stdout: result2.reviewText,
        reasoning: result2.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result2.status,
        stdout: result2.reviewText,
        stderr: result2.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result2.reasoningSummary }
    );
    return {
      exitStatus: result2.status,
      threadId: result2.threadId,
      turnId: result2.turnId,
      payload: payload2,
      rendered,
      summary: payload2.review_result?.summary ?? firstMeaningfulLine2(result2.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label,
      error: result2.error ?? null
    };
  }
  const context = collectReviewContext(request.cwd, target);
  const briefConcerns = Array.isArray(request.brief?.specific_concerns) ? request.brief.specific_concerns : [];
  const flagConcerns = Array.isArray(request.opusConcerns) ? request.opusConcerns : [];
  const seen = /* @__PURE__ */ new Set();
  const opusConcerns = [...briefConcerns, ...flagConcerns].filter((c) => typeof c === "string" && c.trim().length > 0).filter((c) => {
    const key = c.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const prompt = buildAdversarialReviewPrompt(ROOT_DIR, context, focusText, opusConcerns);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    idleTimeoutMs: Number(reviewConfig.idle_timeout_ms) > 0 ? Number(reviewConfig.idle_timeout_ms) : DEFAULT_CONFIG.idle_timeout_ms,
    turnTimeoutMs: Number(reviewConfig.turn_default_ms) > 0 ? Number(reviewConfig.turn_default_ms) : DEFAULT_CONFIG.turn_default_ms,
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const normalizedReviewResult = result.status === 0 && parsed.parsed && !parsed.parseError ? normalizeAdversarialReviewResult({
    payload: parsed.parsed,
    raw_output: parsed.rawOutput,
    target,
    task_id: request.taskId ?? null,
    reviewed_branch_head_sha: request.reviewedBranchHeadSha ?? null
  }) : null;
  if (request.taskId && normalizedReviewResult) {
    writeReview2(request.taskId, normalizedReviewResult);
  }
  if (result.threadId) {
    const advSession = findSession(reviewSessionDir, result.threadId) ?? initSession(reviewSessionDir, result.threadId);
    logNdjson(advSession, "TURN_COMPLETED", "turn/completed", {
      turnId: result.turnId,
      status: result.status,
      reviewKind: "adversarial",
      target,
      findingCount: Array.isArray(parsed.parsed?.findings) ? parsed.parsed.findings.length : null
    });
    logReviewTerminalEvent(advSession, result, {
      reviewKind: "adversarial",
      targetLabel: context.target.label
    });
    if (parsed.parsed && !parsed.parseError) {
      try {
        writeReview(advSession, parsed.parsed);
      } catch {
      }
    }
  }
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    review_result: normalizedReviewResult,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };
  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine2(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label,
    error: result.error ?? null
  };
}
async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.stateCwd ?? request.cwd);
  const adapter2 = request.adapter ?? await resolveCommandAdapter({
    cwd: request.cwd,
    workspaceRoot,
    backend: request.backend ?? null,
    metaBackend: request.metaBackend ?? null,
    taskMetadata: request.taskMetadata ?? null,
    subagentType: request.subagentType ?? null
  });
  ensureCodexRuntimeAdapter(adapter2);
  ensureCodexAvailable(request.cwd);
  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });
  let resumeThreadId = request.resumeThreadId ?? null;
  if (!resumeThreadId && request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw notFoundError(
        "No previous Codex task thread was found for this repository.",
        "NO_RESUMABLE_THREAD",
        "Start a fresh task without --resume-last."
      );
    }
    resumeThreadId = latestThread.id;
  }
  if (!request.prompt && !resumeThreadId) {
    throw validationError(
      "Provide a prompt, a prompt file, piped stdin, or use --resume-last.",
      "MISSING_PROMPT"
    );
  }
  const dispatch2 = await adapter2.dispatch(request.prompt, {
    cwd: request.cwd,
    jobId: request.jobId ?? null,
    sessionDir: request.sessionDir ?? null,
    model: request.model,
    effort: request.effort,
    mode: request.write ? "default" : "read-only",
    adapterOptions: {
      turnOptions: {
        resumeThreadId,
        defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
        model: request.model,
        effort: request.effort,
        sandbox: request.write ? "workspace-write" : "read-only",
        sandboxPolicy: request.sandboxPolicy ?? null,
        collaborationMode: request.collaborationMode ?? null,
        turnTimeoutMs: request.turnTimeoutMs ?? null,
        idleTimeoutMs: request.idleTimeoutMs ?? null,
        onTurnStart: request.onTurnStart ?? null,
        onItemCompleted: request.onItemCompleted ?? null,
        onServerRequest: request.onServerRequest ?? null,
        onProgress: request.onProgress,
        persistThread: true,
        threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
      }
    }
  });
  const result = dispatch2.rawResult ?? dispatch2;
  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };
  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine2(rawOutput, firstMeaningfulLine2(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write),
    // V3.2: expose Codex error info so runForegroundCommand can map to exit codes
    // (Unauthorized → 4, ContextWindowExceeded → 6, ClientTimeout/Http → 7, ...).
    // result.error carries `codexErrorInfo` directly when Codex reports one.
    error: result.error ?? null,
    planDetected: result.planDetected,
    planText: result.planText
  };
}
function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}
function safeRealPath(filePath) {
  try {
    return fs17.realpathSync.native ? fs17.realpathSync.native(filePath) : fs17.realpathSync(filePath);
  } catch {
    return path15.resolve(filePath);
  }
}
function samePath(left, right) {
  return safeRealPath(left) === safeRealPath(right);
}
function summarizeWorkingTreeState(state) {
  const files = [
    ...state.staged.map((file) => `staged:${file}`),
    ...state.unstaged.map((file) => `unstaged:${file}`),
    ...state.untracked.map((file) => `untracked:${file}`)
  ];
  const shown = files.slice(0, 20).join(", ");
  return files.length > 20 ? `${shown}, ... and ${files.length - 20} more` : shown;
}
function requireTaskReviewContext(taskId, options = {}) {
  const meta = readMeta(taskId);
  if (!meta) {
    throw notFoundError(
      `no meta.json found for ${taskId}; run task --worktree-auto before reviewing with --task`,
      "TASK_NOT_FOUND"
    );
  }
  const worktree = meta.worktree && typeof meta.worktree === "object" && !Array.isArray(meta.worktree) ? meta.worktree : {};
  const worktreePath = worktree.path ?? meta.worktree_path ?? null;
  if (typeof worktreePath !== "string" || worktreePath.trim() === "") {
    throw validationError(
      `meta.json for ${taskId} is missing worktree.path; refusing to review the caller cwd`,
      "TASK_WORKTREE_PATH_MISSING"
    );
  }
  const branch = worktree.branch ?? meta.branch ?? meta.worktree_branch ?? null;
  if (typeof branch !== "string" || branch.trim() === "") {
    throw validationError(
      `meta.json for ${taskId} is missing worktree.branch; refusing to review an unbound target`,
      "TASK_WORKTREE_BRANCH_MISSING"
    );
  }
  const reviewCwd = path15.resolve(worktreePath);
  if (options.cwd && !samePath(path15.resolve(process10.cwd(), options.cwd), reviewCwd)) {
    throw validationError(
      `--task ${taskId} resolves to ${reviewCwd}, but --cwd points to ${path15.resolve(process10.cwd(), options.cwd)}`,
      "TASK_CWD_CONFLICT",
      "Omit --cwd with --task, or pass the task worktree path recorded in meta.json."
    );
  }
  const head = runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd: reviewCwd });
  if (head.error || head.status !== 0 || !head.stdout.trim()) {
    const detail = head.error?.message ?? head.stderr.trim() ?? `git exited with status ${head.status}`;
    throw validationError(
      `could not resolve reviewed branch HEAD for ${taskId} in ${reviewCwd}: ${detail}`,
      "TASK_REVIEW_HEAD_UNRESOLVED"
    );
  }
  const state = getWorkingTreeState(reviewCwd);
  if (state.isDirty) {
    throw validationError(
      `task worktree for ${taskId} is dirty; commit, discard, or rerun the task before task-bound review. Status: ${summarizeWorkingTreeState(state)}`,
      "TASK_WORKTREE_DIRTY",
      "Task-bound review binds verdicts to the reviewed branch HEAD, so staged, unstaged, or untracked worktree changes must not be left outside that commit."
    );
  }
  return {
    taskId,
    meta,
    cwd: reviewCwd,
    base: options.base ?? worktree.base_ref ?? meta.base_ref ?? null,
    scope: options.scope ?? "branch",
    branch: branch.trim(),
    reviewedBranchHeadSha: head.stdout.trim()
  };
}
function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn",
      kindLabel: "rescue-review"
    };
  }
  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    kindLabel: "task",
    summary: shorten2(prompt || fallbackSummary)
  };
}
function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check \`codex-bridge status ${payload.jobId}\` for progress.
`;
}
function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (jobClass === "review") return "review";
  if (jobClass === "task") return "task";
  return "job";
}
function createCompanionJob({
  id = null,
  prefix,
  kind,
  title,
  workspaceRoot,
  jobClass,
  kindLabel,
  summary,
  write = false,
  ...extra
}) {
  return createJobRecord({
    id: id ?? generateJobId(prefix),
    kind,
    kindLabel: kindLabel ?? getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    ...extra
  });
}
function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  const stderr = options.stderr === false ? false : true;
  return {
    logFile,
    progress: createProgressReporter({
      stderr,
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}
function buildTaskJob(workspaceRoot, taskMetadata, write, options = {}) {
  return createCompanionJob({
    id: options.id ?? null,
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    kindLabel: taskMetadata.kindLabel ?? "task",
    summary: taskMetadata.summary,
    write,
    backend: options.backend ?? null,
    adapter_capabilities: options.adapterCapabilities ?? null,
    ...options.worktree ? {
      registryTaskId: options.id ?? null,
      worktree: options.worktree,
      isolation_mode: options.worktree.isolation_mode
    } : {}
  });
}
function buildTaskRequest({
  cwd,
  stateCwd,
  model,
  effort,
  prompt,
  brief,
  write,
  readOnly,
  resumeLast,
  jobId,
  mode,
  idleTimeoutMs,
  noPipeline,
  turnPlanMs,
  turnDefaultMs,
  pipelineStageMs,
  pipelineTotalMs,
  questionAnswerMs,
  backend = null
}) {
  const opt = (n) => Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null;
  return {
    cwd,
    stateCwd: stateCwd ?? cwd,
    model,
    effort,
    prompt,
    brief: brief ?? null,
    write,
    readOnly: Boolean(readOnly),
    resumeLast,
    jobId,
    mode: mode ?? null,
    idleTimeoutMs: opt(idleTimeoutMs),
    turnPlanMs: opt(turnPlanMs),
    turnDefaultMs: opt(turnDefaultMs),
    pipelineStageMs: opt(pipelineStageMs),
    pipelineTotalMs: opt(pipelineTotalMs),
    questionAnswerMs: opt(questionAnswerMs),
    noPipeline: Boolean(noPipeline),
    backend: backend ?? null
  };
}
function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return readPromptFileOrThrow(path15.resolve(cwd, options["prompt-file"]));
  }
  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}
function readPromptFileOrThrow(absPath) {
  try {
    return fs17.readFileSync(absPath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw notFoundError(`Prompt file not found: ${absPath}`, "PROMPT_FILE_NOT_FOUND");
    }
    if (err?.code === "EACCES" || err?.code === "EPERM") {
      throw new CliError(`Cannot read prompt file (permission denied): ${absPath}`, {
        class: "auth",
        code: "PROMPT_FILE_PERMISSION",
        retryable: false
      });
    }
    if (err?.code === "EISDIR") {
      throw validationError(`Prompt file path is a directory: ${absPath}`, "PROMPT_FILE_IS_DIRECTORY");
    }
    throw err;
  }
}
function requireTaskRequest(prompt, resumeLast) {
  if (!String(prompt ?? "").trim() && !resumeLast) {
    throw validationError(
      "Provide a prompt, a prompt file, piped stdin, or use --resume-last.",
      "MISSING_PROMPT",
      'Example: `codex-bridge task --write "Fix the auth bug"`'
    );
  }
}
function parsePositiveMsOption(flagName, raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw usageError(
      `${flagName} must be a positive number of milliseconds, got ${JSON.stringify(raw)}`
    );
  }
  return n;
}
function parseDurationOption(flagName, raw, { defaultMs = null } = {}) {
  if (raw == null || raw === "") return defaultMs;
  const str2 = String(raw).trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(str2);
  if (!match) {
    throw usageError(
      `${flagName} must be a positive duration (e.g. "500ms", "10s", "2m"), got ${JSON.stringify(raw)}`
    );
  }
  const n = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  const multiplier = unit === "m" ? 6e4 : unit === "s" ? 1e3 : 1;
  const ms = n * multiplier;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw usageError(
      `${flagName} must be a positive duration, got ${JSON.stringify(raw)}`
    );
  }
  return ms;
}
function persistFailureErrorInPayload(execution, command = null) {
  if (!execution || execution.exitStatus === 0) {
    return execution;
  }
  const errLike = execution.error ?? { message: `Codex turn failed (status ${execution.exitStatus}).` };
  const partial = errLike?.partial ?? null;
  const handoff = errLike?.handoff ?? null;
  const origin = errLike?.origin ?? null;
  const nextAction = errLike?.nextAction ?? null;
  const { error } = buildErrorEnvelope(classifyError(errLike), { command, partial, handoff, origin, nextAction });
  const payload = execution.payload && typeof execution.payload === "object" && !Array.isArray(execution.payload) ? execution.payload : {};
  return {
    ...execution,
    payload: {
      ...payload,
      error
    }
  };
}
async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile
  });
  const command = options.command ?? null;
  const execution = await runTrackedJob(
    job,
    async () => persistFailureErrorInPayload(await runner(progress), command),
    { logFile }
  );
  if (execution.exitStatus !== 0) {
    const errLike = execution.error ?? { message: `Codex turn failed (status ${execution.exitStatus}).` };
    if (options.json) {
      emitError(errLike, { json: true, command });
    } else {
      if (execution.rendered) {
        process10.stdout.write(execution.rendered);
      }
      emitError(errLike, { json: false, command });
    }
    return execution;
  }
  emitSuccess(command, execution.payload, execution.rendered, {
    json: options.json,
    startedAt: options.startedAt
  });
  return execution;
}
function spawnDetachedTaskWorker(cwd, workspaceRoot, jobId, logFile = null) {
  const scriptPath = SCRIPT_PATH;
  let stdioConfig = "ignore";
  if (logFile) {
    try {
      const stderrPath = `${logFile}.worker.err`;
      const stderrFd = fs17.openSync(stderrPath, "a");
      stdioConfig = ["ignore", "ignore", stderrFd];
    } catch {
    }
  }
  const child = spawn3(process10.execPath, [
    scriptPath,
    "task-worker",
    "--cwd",
    cwd,
    "--workspace-root",
    workspaceRoot,
    "--job-id",
    jobId
  ], {
    cwd,
    env: process10.env,
    detached: true,
    stdio: stdioConfig,
    windowsHide: true
  });
  child.unref();
  if (Array.isArray(stdioConfig) && typeof stdioConfig[2] === "number") {
    try {
      fs17.closeSync(stdioConfig[2]);
    } catch {
    }
  }
  return child;
}
function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);
  let child;
  try {
    child = spawnDetachedTaskWorker(cwd, job.workspaceRoot, job.id, logFile);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso2();
    const existingRecord2 = readStoredJob(job.workspaceRoot, job.id) ?? queuedRecord;
    const failedRecord = {
      ...existingRecord2,
      status: "failed",
      phase: "failed",
      pid: null,
      logFile: existingRecord2.logFile ?? logFile,
      request: existingRecord2.request ?? request,
      completedAt,
      errorMessage
    };
    writeJobFile(job.workspaceRoot, job.id, failedRecord);
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      logFile: failedRecord.logFile,
      request: failedRecord.request,
      completedAt,
      errorMessage
    });
    throw error;
  }
  const spawnedPid = child.pid ?? null;
  const existingRecord = readStoredJob(job.workspaceRoot, job.id) ?? queuedRecord;
  if (existingRecord.status === "queued") {
    const spawnedRecord = {
      ...existingRecord,
      pid: spawnedPid,
      logFile: existingRecord.logFile ?? logFile,
      request: existingRecord.request ?? request
    };
    writeJobFile(job.workspaceRoot, job.id, spawnedRecord);
    upsertJob(job.workspaceRoot, {
      id: job.id,
      pid: spawnedRecord.pid,
      logFile: spawnedRecord.logFile,
      request: spawnedRecord.request
    });
  }
  const resolvedSessionDir = resolveSessionDir(getBridgeConfig(cwd ?? null, job.workspaceRoot).session_dir, job.workspaceRoot);
  return {
    payload: {
      jobId: job.id,
      threadId: null,
      eventsPath: null,
      eventsDir: resolvedSessionDir,
      status: "queued",
      title: job.title,
      summary: job.summary,
      registryTaskId: job.registryTaskId ?? null,
      worktree: job.worktree ?? null,
      logFile,
      monitor: buildMonitorHint({ eventsPath: null, jobId: job.id, threadId: null, cwd: request.stateCwd ?? job.workspaceRoot })
    },
    logFile
  };
}
async function handleReviewCommand(argv, config) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd", "backend", "brief", "task"],
    repeatableValueOptions: ["concern"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });
  const taskReview = options.task ? requireTaskReviewContext(options.task, options) : null;
  const cwd = taskReview?.cwd ?? resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const adapter2 = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    backend: options.backend ?? null
  });
  ensureCodexRuntimeAdapter(adapter2);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: taskReview?.base ?? options.base,
    scope: taskReview?.scope ?? options.scope
  });
  let brief = null;
  if (options.brief) {
    const result = loadBrief(options.brief, { baseDir: cwd });
    if (!result.ok) {
      throw new CliError(result.message, {
        code: result.code,
        class: result.code === "BRIEF_FILE_NOT_FOUND" ? "not_found" : "validation",
        details: result.details,
        suggestion: result.code === "BRIEF_SCHEMA_VIOLATION" ? "Fix the brief JSON to match the schema. Common valid top-level keys are goal, worker_assignment, specific_concerns, acceptance_criteria, behavior_digest_seed, parent_task_id, backend_hint, iteration_max, and trust_budget_override." : void 0
      });
    }
    brief = result.brief;
  }
  const opusConcerns = Array.isArray(options.concern) ? options.concern : options.concern ? [options.concern] : [];
  config.validateRequest?.(target, focusText, { brief, opusConcerns });
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) => executeReviewRun({
      cwd,
      base: taskReview?.base ?? options.base,
      scope: taskReview?.scope ?? options.scope,
      model: options.model,
      backend: options.backend ?? null,
      focusText,
      brief,
      opusConcerns,
      reviewName: config.reviewName,
      taskId: taskReview?.taskId ?? null,
      reviewedBranchHeadSha: taskReview?.reviewedBranchHeadSha ?? null,
      onProgress: progress
    }),
    {
      json: options.json,
      startedAt,
      command: config.reviewName === "Adversarial Review" ? "adversarial-review" : "review"
    }
  );
}
async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}
async function runBridgeTask(request) {
  const stateCwd = request.stateCwd ?? request.cwd;
  const workspaceRoot = resolveWorkspaceRoot(stateCwd);
  const config = getBridgeConfig(request.cwd ?? null, workspaceRoot);
  const adapter2 = await resolveCommandAdapter({
    cwd: request.cwd ?? null,
    workspaceRoot,
    backend: request.backend ?? null,
    metaBackend: request.metaBackend ?? null,
    taskMetadata: request.taskMetadata ?? null,
    subagentType: request.subagentType ?? null
  });
  ensureCodexRuntimeAdapter(adapter2);
  const sessionDir = resolveSessionDir(config.session_dir, workspaceRoot);
  const effectiveMode = request.mode ?? config.mode ?? "plan";
  const isPlanMode = effectiveMode === "plan" && !request.resumeLast;
  const metaSkillsPreamble = "[ORCHESTRATOR DIRECTIVE] Do not invoke your own planning, brainstorming, ceremony, or meta-skill chains before execution. Do not create scaffold files (spec documents, plan documents, design memos) under paths like `docs/`, `plans/`, `specs/`, or similar before touching the deliverable \u2014 unless the task explicitly asks for such an artifact as its output.";
  const metaSkillsPrefix = config.skip_meta_skills ? isPlanMode ? `${metaSkillsPreamble} The calling orchestrator is already driving the plan/execute loop; produce a concise inline [PLAN] and stop \u2014 the orchestrator approves before execution.

` : `${metaSkillsPreamble} The calling orchestrator has already planned this task; your job is to execute it directly.

` : "";
  const baseTaskPrompt = request.resumeLast && !String(request.prompt ?? "").trim() ? DEFAULT_CONTINUE_PROMPT : request.prompt ?? "";
  const taskPrompt = appendRenderedBriefToPrompt(baseTaskPrompt, request.brief ?? null);
  const promptWithFooter = config.prompt_footer ? `${metaSkillsPrefix}${taskPrompt}

${config.prompt_footer}` : `${metaSkillsPrefix}${taskPrompt}`;
  const activeMode = isPlanMode ? "plan" : "default";
  const developerInstructions = loadDeveloperInstructions(activeMode);
  const CIRCUIT_BREAKER_THRESHOLD = 3;
  const CIRCUIT_BREAKER_WINDOW = 5;
  const breakerState = {
    recent: [],
    // [{family, failed}] ring, trimmed to WINDOW entries
    tripped: false
  };
  const detectCommandFamily = (command) => {
    if (typeof command !== "string") return null;
    const trimmed = command.trim();
    if (!trimmed) return null;
    if (/\bdisplay dialog\b|\bdisplay notification\b/i.test(trimmed)) return "applescript-dialog";
    if (/\bSystem Events\b|\btell application\b/i.test(trimmed)) return "applescript-system";
    if (/^computer-use\/|^tool:\s*computer-use/i.test(trimmed)) return "computer-use";
    if (/^\s*open\s+-a\b/i.test(trimmed)) return "open-app";
    if (/^\/bin\/zsh.*osascript\b|^osascript\b|\bosascript\s+-[eJl]\b/i.test(trimmed)) return "osascript";
    return null;
  };
  const isFailureHidingWrapper = (command) => {
    if (typeof command !== "string") return false;
    return /(?:^|[^&])&(?![&])[\s\S]{0,200}?\bkill\b/.test(command) || /\|\|\s*(true|exit\s+0)\b/.test(command) || /;\s*true\s*['"]?\s*$/.test(command);
  };
  const bridgeRequest = {
    ...request,
    adapter: adapter2,
    sessionDir,
    prompt: promptWithFooter,
    collaborationMode: isPlanMode ? buildCollaborationMode("plan", config, { developerInstructions }) : request.write ? buildCollaborationMode("default", config, { developerInstructions, effort: request.effort }) : null,
    // Always resolve through buildSandboxPolicy so `config.sandbox_policy`
    // wins regardless of plan/write flags. When no override is set, the
    // mode-derived default applies (plan → readOnly, --write → workspaceWrite,
    // plain exec → readOnly).
    //
    // `request.readOnly` is the one explicit override that bypasses
    // `config.sandbox_policy` entirely. Used by the stop-time review-gate
    // hook to guarantee the gate-time review can never mutate the repo even
    // when the user has set `sandbox_policy: danger-full-access`. The Stop
    // hook only ALLOWs/BLOCKs the previous turn — it must not double as a
    // license to write at session shutdown.
    sandboxPolicy: request.readOnly ? { type: "readOnly" } : buildSandboxPolicy(
      isPlanMode || !request.write ? "plan" : "default",
      config
    ),
    effort: isPlanMode ? "xhigh" : request.effort ?? config.effort ?? "high",
    // Turn timeout resolution (most specific wins): CLI flag → config.yaml
    // key → built-in default. Plan and execute turns use separate budgets
    // because plan is a bounded reasoning exercise while execute spans the
    // actual code changes. Pre-1.2.5 these were hard-coded (300 000 / 600 000);
    // large scaffolds legitimately needed more than 10 min of execute time
    // and were getting interrupted.
    turnTimeoutMs: isPlanMode ? request.turnPlanMs ?? (Number(config.turn_plan_ms) > 0 ? Number(config.turn_plan_ms) : 18e5) : request.turnDefaultMs ?? (Number(config.turn_default_ms) > 0 ? Number(config.turn_default_ms) : 18e5),
    // Resolution order: --idle-timeout-ms flag → config.yaml `idle_timeout_ms`
    // → 300_000 fallback. 300s default covers reasoning-heavy turns between
    // `item.completed` notifications; see config.mjs DEFAULT_CONFIG comment.
    idleTimeoutMs: Number(request.idleTimeoutMs) > 0 ? Number(request.idleTimeoutMs) : Number(config.idle_timeout_ms) > 0 ? Number(config.idle_timeout_ms) : 3e5,
    onTurnStart: (info) => {
      heartbeatState.session = prepareRuntimeSession(
        findSession(sessionDir, info.threadId) ?? initSession(sessionDir, info.threadId),
        config,
        request.jobId ?? null
      );
      heartbeatState.phase = isPlanMode ? "plan" : "execute";
      heartbeatState.turnTimeoutMs = info.turnParams?.turnTimeoutMs ?? heartbeatState.turnTimeoutMs;
      startHeartbeat();
      startCheckpoint();
      const s = heartbeatState.session;
      breakerState.recent.length = 0;
      breakerState.tripped = false;
      logNdjson(s, "TURN_PARAMS", "turn/start", {
        model: info.turnParams.model,
        effort: info.turnParams.effort,
        collaborationMode: info.turnParams.collaborationMode,
        sandboxPolicy: info.turnParams.sandboxPolicy,
        hasOutputSchema: Boolean(info.turnParams.outputSchema),
        promptLength: info.promptLength,
        promptPreview: info.promptPreview
      });
      try {
        const sandboxType = info.turnParams.sandboxPolicy?.type ?? "unknown";
        const pipelineEnabled = [];
        if (config.auto_review) pipelineEnabled.push("review");
        if (config.post_task_prompt) pipelineEnabled.push("check");
        if (request.noPipeline) pipelineEnabled.length = 0;
        logEvent(s, formatDirectivesEvent(s, {
          mode: isPlanMode ? "plan" : "default",
          effort: info.turnParams.effort ?? "?",
          sandbox: sandboxType,
          quiet: request.onProgress == null,
          skipMetaSkills: Boolean(config.skip_meta_skills),
          pipelineEnabled,
          model: info.turnParams.model ?? null
        }));
      } catch {
      }
    },
    onItemCompleted: (item, { threadId }) => {
      const effectiveThreadId = threadId ?? null;
      if (!effectiveThreadId) return;
      const s = prepareRuntimeSession(
        findSession(sessionDir, effectiveThreadId) ?? initSession(sessionDir, effectiveThreadId),
        config,
        request.jobId ?? null
      );
      logNdjson(s, "ITEM_COMPLETED", "item/completed", {
        itemId: item?.id ?? null,
        itemType: item?.type ?? null,
        text: extractItemText(item)
      });
      heartbeatState.lastItem = item?.type ?? null;
      heartbeatState.lastItemAt = Date.now();
      try {
        const itemType = item?.type ?? null;
        if (itemType === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
          checkpointState.lastAssistantMessage = item.text;
        }
        if (itemType === "commandExecution") {
          checkpointState.tools.push({
            type: "commandExecution",
            summary: extractItemText(item) ?? ""
          });
          checkpointState.actionableCount += 1;
          checkpointState.seenFirstActionable = true;
        } else if (itemType === "fileChange") {
          checkpointState.tools.push({
            type: "fileChange",
            summary: extractItemText(item) ?? "(unknown)"
          });
          checkpointState.actionableCount += 1;
          checkpointState.seenFirstActionable = true;
        } else if (itemType === "plan") {
          checkpointState.tools.push({
            type: "plan",
            summary: extractItemText(item) ?? "(plan)"
          });
          checkpointState.actionableCount += 1;
          checkpointState.seenFirstActionable = true;
        }
      } catch {
      }
      if (!config.command_failure_circuit_breaker || breakerState.tripped || item?.type !== "commandExecution") {
        return;
      }
      const family = detectCommandFamily(item.command);
      if (!family) return;
      const rawFailed = item.status !== "completed" || typeof item.exitCode === "number" && item.exitCode !== 0;
      const wrappedFailed = !rawFailed && isFailureHidingWrapper(item.command);
      const failed = rawFailed || wrappedFailed;
      breakerState.recent.push({ family, failed });
      if (breakerState.recent.length > CIRCUIT_BREAKER_WINDOW) {
        breakerState.recent.shift();
      }
      const familyFails = breakerState.recent.filter((r) => r.family === family && r.failed).length;
      if (familyFails < CIRCUIT_BREAKER_THRESHOLD) return;
      breakerState.tripped = true;
      logEvent(s, formatWarningEvent(s, {
        reason: "command-family-circuit-breaker-tripped",
        family,
        threshold: CIRCUIT_BREAKER_THRESHOLD,
        sampleCommand: item.command,
        turnInterrupted: false
      }));
      logNdjson(s, "CIRCUIT_BREAKER", null, {
        family,
        threshold: CIRCUIT_BREAKER_THRESHOLD,
        windowSize: CIRCUIT_BREAKER_WINDOW,
        failsInWindow: familyFails,
        wrapperDetected: wrappedFailed,
        turnInterrupted: false
      });
    }
  };
  bridgeRequest.onServerRequest = createBridgeServerRequestHandler({
    sessionDir,
    config,
    questionAnswerMs: request.questionAnswerMs ?? null,
    cwd: request.cwd
  });
  const heartbeatState = {
    session: null,
    startTime: Date.now(),
    phase: isPlanMode ? "plan" : "execute",
    lastItem: null,
    lastItemAt: null,
    turnTimeoutMs: null
  };
  let heartbeatTimer = null;
  const HEARTBEAT_INTERVAL_MS = Number(process10.env.CODEX_BRIDGE_HEARTBEAT_MS) > 0 ? Number(process10.env.CODEX_BRIDGE_HEARTBEAT_MS) : 6e4;
  const CHECKPOINT_INTERVAL_MS = Number(process10.env.CODEX_BRIDGE_CHECKPOINT_MS) > 0 ? Number(process10.env.CODEX_BRIDGE_CHECKPOINT_MS) : 5 * 60 * 1e3;
  const STALL_CHECKPOINT_THRESHOLD = Number(process10.env.CODEX_BRIDGE_STALL_CHECKPOINTS) > 0 ? Number(process10.env.CODEX_BRIDGE_STALL_CHECKPOINTS) : 3;
  let checkpointTimer = null;
  let checkpointInFlight = false;
  let terminalEmitted = false;
  const markTerminalEmitted = () => {
    terminalEmitted = true;
  };
  const checkpointState = {
    startTime: Date.now(),
    lastCheckpointAt: Date.now(),
    intervalMs: CHECKPOINT_INTERVAL_MS,
    lastHead: null,
    // git HEAD at last checkpoint (or turn start)
    startHead: null,
    // git HEAD at turn start (for since-start diff)
    lastAssistantMessage: null,
    tools: [],
    // pushed by onItemCompleted
    actionableCount: 0,
    // reset every checkpoint
    barrenCheckpoints: 0,
    // consecutive checkpoints with actionableCount == 0
    seenFirstActionable: false
    // gate for barren-counter start (prevents false stall on slow-to-start turns)
  };
  const gitCwd = request.cwd && typeof request.cwd === "string" ? request.cwd : null;
  const readGitHead = () => {
    if (!gitCwd) return null;
    try {
      const r = spawnSync4("git", ["rev-parse", "HEAD"], {
        cwd: gitCwd,
        encoding: "utf8",
        timeout: 5e3
      });
      return r.status === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  };
  const readGitLogRange = (from, to) => {
    if (!gitCwd || !from || !to || from === to) return [];
    try {
      const r = spawnSync4(
        "git",
        ["log", "--no-color", "--no-decorate", "-n", "50", "--pretty=%h %s", `${from}..${to}`],
        { cwd: gitCwd, encoding: "utf8", timeout: 5e3 }
      );
      if (r.status !== 0) return [];
      return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
        const sp = l.indexOf(" ");
        return sp < 0 ? { sha: l, subject: "" } : { sha: l.slice(0, sp), subject: l.slice(sp + 1) };
      });
    } catch {
      return [];
    }
  };
  const readGitDiffStat = (from, to) => {
    if (!gitCwd || !from || !to || from === to) return null;
    try {
      const r = spawnSync4("git", ["diff", "--shortstat", `${from}..${to}`], {
        cwd: gitCwd,
        encoding: "utf8",
        timeout: 5e3
      });
      return r.status === 0 ? r.stdout.trim() || null : null;
    } catch {
      return null;
    }
  };
  const startHeartbeat = () => {
    if (heartbeatTimer || !heartbeatState.session) return;
    heartbeatTimer = setInterval(() => {
      try {
        const now = Date.now();
        const elapsed = now - heartbeatState.startTime;
        const budgetRemaining = Number.isFinite(heartbeatState.turnTimeoutMs) && heartbeatState.turnTimeoutMs > 0 ? heartbeatState.turnTimeoutMs - elapsed : null;
        logEvent(
          heartbeatState.session,
          formatHeartbeatEvent(heartbeatState.session, {
            elapsedMs: elapsed,
            phase: heartbeatState.phase,
            lastItem: heartbeatState.lastItem,
            lastItemAgeMs: heartbeatState.lastItemAt ? now - heartbeatState.lastItemAt : null,
            pid: process10.pid,
            jobId: request.jobId ?? null,
            budgetRemainingMs: budgetRemaining,
            scriptPath: SCRIPT_PATH,
            cwd: stateCwd,
            assistantPreview: checkpointState.lastAssistantMessage
          })
        );
      } catch {
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
  };
  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };
  const runCheckpoint = () => {
    if (!heartbeatState.session) return;
    if (checkpointInFlight) return;
    checkpointInFlight = true;
    try {
      const now = Date.now();
      const elapsedMs = now - heartbeatState.startTime;
      const intervalMs = now - checkpointState.lastCheckpointAt;
      const currentHead = readGitHead();
      const fromHead = checkpointState.lastHead ?? checkpointState.startHead;
      const commits = fromHead && currentHead ? readGitLogRange(fromHead, currentHead) : [];
      const diffStat = fromHead && currentHead ? readGitDiffStat(fromHead, currentHead) : null;
      const filesChangedSinceStart = checkpointState.startHead && currentHead ? readGitDiffStat(checkpointState.startHead, currentHead) : null;
      const hasContent = checkpointState.actionableCount > 0 || Boolean(checkpointState.lastAssistantMessage) || commits.length > 0 || Boolean(diffStat);
      if (hasContent) {
        try {
          const toolsSnapshot = checkpointState.tools;
          checkpointState.tools = [];
          logEvent(
            heartbeatState.session,
            formatCheckpointEvent(heartbeatState.session, {
              elapsedMs,
              phase: heartbeatState.phase,
              intervalMs,
              pid: process10.pid,
              jobId: request.jobId ?? null,
              lastAssistantMessage: checkpointState.lastAssistantMessage,
              tools: toolsSnapshot,
              commits,
              diffStat,
              filesChangedSinceStart,
              scriptPath: SCRIPT_PATH,
              cwd: stateCwd
            })
          );
          logNdjson(heartbeatState.session, "CHECKPOINT", null, {
            elapsedMs,
            intervalMs,
            actionableCount: checkpointState.actionableCount,
            barrenCheckpoints: checkpointState.barrenCheckpoints,
            toolCount: toolsSnapshot.length,
            commitsInInterval: commits.length
          });
        } catch {
        }
      }
      if (checkpointState.seenFirstActionable) {
        if (checkpointState.actionableCount === 0) {
          checkpointState.barrenCheckpoints += 1;
        } else {
          checkpointState.barrenCheckpoints = 0;
        }
      }
      if (checkpointState.barrenCheckpoints >= STALL_CHECKPOINT_THRESHOLD && !terminalEmitted) {
        try {
          const stallWindowMs = CHECKPOINT_INTERVAL_MS * STALL_CHECKPOINT_THRESHOLD;
          logEvent(
            heartbeatState.session,
            formatErrorEvent(heartbeatState.session, {
              errorCode: "StallDetected",
              message: `No actionable items (commandExecution / fileChange / plan) in ${STALL_CHECKPOINT_THRESHOLD} consecutive ${Math.round(CHECKPOINT_INTERVAL_MS / 6e4)}-minute checkpoints (${Math.round(stallWindowMs / 6e4)} min total). Codex is alive (heartbeats present) but not making measurable progress. Cancel with \`cancel ${request.jobId ?? heartbeatState.session.threadId}\`, or steer the thread. Note: the Codex turn is still running \u2014 this terminal tag signals the orchestrator; the turn itself will not stop until you cancel it or hit the turn budget.`,
              phase: heartbeatState.phase ?? "execute",
              origin: "bridge",
              scriptPath: SCRIPT_PATH,
              jobId: request.jobId ?? null,
              cwd: request.cwd,
              stateCwd
            })
          );
          logNdjson(heartbeatState.session, "ERROR", null, {
            errorCode: "StallDetected",
            origin: "bridge",
            barrenCheckpoints: checkpointState.barrenCheckpoints,
            windowMs: stallWindowMs
          });
          terminalEmitted = true;
          stopCheckpoint();
          stopHeartbeat();
        } catch {
        }
      }
      checkpointState.lastCheckpointAt = now;
      checkpointState.lastHead = currentHead ?? checkpointState.lastHead;
      checkpointState.lastAssistantMessage = null;
      if (!hasContent) checkpointState.tools = [];
      checkpointState.actionableCount = 0;
    } finally {
      checkpointInFlight = false;
    }
  };
  const startCheckpoint = () => {
    if (checkpointTimer) return;
    if (checkpointState.startHead == null) {
      checkpointState.startHead = readGitHead();
      checkpointState.lastHead = checkpointState.startHead;
    }
    checkpointTimer = setInterval(() => {
      try {
        runCheckpoint();
      } catch {
      }
    }, CHECKPOINT_INTERVAL_MS);
    checkpointTimer.unref?.();
  };
  const stopCheckpoint = () => {
    if (checkpointTimer) {
      clearInterval(checkpointTimer);
      checkpointTimer = null;
    }
  };
  let result;
  let session;
  const turnStartSnapshot = captureGitSnapshot(request.cwd);
  const retryHistory = [];
  try {
    result = await executeTaskRun(bridgeRequest);
    while (result.exitStatus !== 0 && result.error) {
      const origin = classifyTurnErrorOrigin(result.error);
      const policy = getUpstreamRetryPolicy(origin);
      if (!policy || policy.strategy !== "same-thread" || retryHistory.length >= policy.maxAttempts) break;
      const attempt = retryHistory.length + 1;
      const backoffMs = policy.backoffMs[attempt - 1] ?? 2e3;
      const errorCode = result.error?.codexErrorInfo ?? result.error?.code ?? classifyError(result.error).code;
      if (result.threadId) {
        const retrySession = prepareRuntimeSession(initSession(sessionDir, result.threadId), config, request.jobId ?? null);
        logEvent(retrySession, formatRetryingEvent(retrySession, {
          attempt,
          maxAttempts: policy.maxAttempts,
          backoffMs,
          origin,
          strategy: policy.strategy,
          errorCode,
          reason: String(result.error?.message ?? result.error).slice(0, 200)
        }));
        logNdjson(retrySession, "RETRYING", null, { attempt, maxAttempts: policy.maxAttempts, backoffMs, origin, errorCode });
      }
      retryHistory.push({
        attemptIso: (/* @__PURE__ */ new Date()).toISOString(),
        origin,
        errorCode,
        backoffMs,
        outcome: "pending"
      });
      if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));
      const retryResult = await executeTaskRun({
        ...bridgeRequest,
        resumeThreadId: result.threadId ?? bridgeRequest.resumeThreadId ?? null
      });
      if (retryResult.exitStatus === 0 || !retryResult.error) {
        retryHistory[retryHistory.length - 1].outcome = "success";
        result = retryResult;
        break;
      }
      retryHistory[retryHistory.length - 1].outcome = "failed";
      result = retryResult;
    }
    session = prepareRuntimeSession(initSession(sessionDir, result.threadId), config, request.jobId ?? null);
    const computedEventsPath = result.threadId ? path15.join(sessionDir, `${result.threadId}.events`) : null;
    const monitor = buildMonitorHint({
      eventsPath: computedEventsPath,
      jobId: request.jobId ?? null,
      threadId: result.threadId ?? null,
      cwd: stateCwd
    });
    if (request.jobId && result.rendered && typeof result.rendered === "string") {
      result.rendered = appendTaskFooter(result.rendered, {
        jobId: request.jobId,
        eventsPath: computedEventsPath,
        eventsDir: sessionDir,
        monitorCommand: monitor?.command ?? null
      });
    }
    logNdjson(session, "TURN_COMPLETED", "turn/completed", {
      turnId: result.turnId,
      status: result.exitStatus,
      planDetected: result.planDetected,
      touchedFiles: result.payload?.touchedFiles ?? []
    });
    const setPhase = (phase, nextAction, extras = {}) => {
      result.payload = {
        ...result.payload,
        phase,
        next_action: nextAction,
        eventsPath: computedEventsPath,
        eventsDir: sessionDir,
        jobId: request.jobId ?? null,
        ...extras
      };
    };
    if (result.exitStatus !== 0 && result.error) {
      const errorMessage = String(result.error.message ?? result.error);
      const origin = classifyTurnErrorOrigin(result.error);
      const codexErrorInfo = normalizeCodexErrorInfo(
        result.error.codexErrorInfo ?? result.error.codex_error_info ?? null
      );
      const classifiedTurnError = classifyError(result.error);
      const errorCode = origin === "idle" ? "ClientTimeout" : codexErrorInfo?.code ?? classifiedTurnError.code ?? "CodexError";
      const touchedFiles = result.payload?.touchedFiles ?? [];
      const upstreamRequestId = extractUpstreamRequestId(errorMessage);
      const partialDiff = diffGitSnapshot(request.cwd, turnStartSnapshot);
      let partialForEnvelope = null;
      if (partialDiff.commits.length > 0) {
        partialForEnvelope = {
          commits: partialDiff.commits,
          currentHeadSha: partialDiff.currentHeadSha,
          lastOkHeadSha: partialDiff.lastOkHeadSha,
          dirtyFiles: partialDiff.dirtyFiles,
          launchedAtIso: partialDiff.launchedAtIso
        };
        logEvent(session, formatPartialEvent(session, {
          commits: partialDiff.commits,
          currentHeadSha: partialDiff.currentHeadSha,
          lastOkHeadSha: partialDiff.lastOkHeadSha,
          launchedAtIso: partialDiff.launchedAtIso,
          dirtyFiles: partialDiff.dirtyFiles,
          scriptPath: SCRIPT_PATH,
          jobId: request.jobId ?? null,
          cwd: request.cwd,
          stateCwd
        }));
        logNdjson(session, "PARTIAL", null, {
          commits: partialDiff.commits,
          currentHeadSha: partialDiff.currentHeadSha,
          lastOkHeadSha: partialDiff.lastOkHeadSha,
          launchedAtIso: partialDiff.launchedAtIso
        });
      }
      let handoffForEnvelope = null;
      const policyForOrigin = getUpstreamRetryPolicy(origin);
      const isUpstreamTerminal = Boolean(policyForOrigin);
      if (isUpstreamTerminal) {
        const eventsPath = path15.join(sessionDir, `${session.threadId}.events`);
        const diffPath = path15.join(sessionDir, `${session.threadId}.diff`);
        const planPath = path15.join(sessionDir, `${session.threadId}.plan.md`);
        const reviewPath = path15.join(sessionDir, `${session.threadId}.review.json`);
        const reason = policyForOrigin.strategy === "none" ? origin === "upstream:auth" ? "upstream-auth-requires-reauth" : "upstream-no-retry-policy" : "upstream-retry-exhausted";
        handoffForEnvelope = buildHandoffEnvelope({
          classified: { origin, code: errorCode, message: errorMessage },
          reason,
          session: {
            jobId: request.jobId ?? null,
            threadId: session.threadId,
            sessionId: session.threadId
          },
          artifacts: {
            eventsPath,
            workerErrPath: request.logFile ? `${request.logFile}.worker.err` : null,
            diffPath,
            planPath,
            reviewPath
          },
          partial: partialForEnvelope,
          prompt: {
            original: request.prompt ?? null,
            promptFilePath: request.promptFilePath ?? null,
            resumeSuggestion: "Read eventsPath + diffPath; `git log --oneline <lastOkHeadSha>..HEAD`; relaunch with `task --json --mode default --prompt-file <rebuilt>` seeded with the last commit sha and remaining scope."
          },
          retries: retryHistory,
          upstreamRequestId
        });
        logEvent(session, formatHandoffEvent(session, {
          reason: handoffForEnvelope.reason,
          origin,
          errorCode,
          upstreamRequestId,
          session: { jobId: request.jobId ?? null, threadId: session.threadId },
          artifacts: handoffForEnvelope.artifacts,
          partial: partialForEnvelope,
          prompt: handoffForEnvelope.prompt,
          retries: retryHistory,
          scriptPath: SCRIPT_PATH,
          cwd: request.cwd,
          stateCwd
        }));
        logNdjson(session, "HANDOFF", null, {
          reason: handoffForEnvelope.reason,
          origin,
          errorCode,
          upstreamRequestId
        });
      }
      if (result.error && typeof result.error === "object") {
        if (partialForEnvelope) result.error.partial = partialForEnvelope;
        if (handoffForEnvelope) result.error.handoff = handoffForEnvelope;
      }
      if (codexErrorInfo?.code === "SandboxError" && touchedFiles.length > 0) {
        const cwdArg = JSON.stringify(request.cwd);
        setPhase("workspace-dirty", {
          command: `git -C ${cwdArg} add -A && git -C ${cwdArg} commit -m "<subject>"`,
          description: "Codex produced a diff but the sandbox blocked the commit. Commit on Codex's behalf, or re-run with config.sandbox_policy: danger-full-access."
        }, { errorCode, touchedFiles, monitor, sandboxError: errorMessage });
        let dirtyDiff;
        try {
          dirtyDiff = captureGitDiff(request.cwd, session);
          mirrorDiffToRegistry(request.jobId ?? request.taskId ?? null, dirtyDiff.diffPath);
        } catch {
          dirtyDiff = { diffStat: `${touchedFiles.length} touched files`, diffPath: "" };
        }
        logEvent(session, formatIncompleteEvent(session, {
          diffStat: dirtyDiff.diffStat,
          diffPath: dirtyDiff.diffPath,
          verdict: "workspace-dirty",
          findingCount: touchedFiles.length,
          missingItems: [
            "Codex produced workspace changes, but the sandbox blocked the final commit. Commit the generated diff outside the sandbox."
          ],
          scriptPath: SCRIPT_PATH,
          jobId: request.jobId ?? null,
          cwd: request.cwd
        }));
        markTerminalEmitted();
        return { ...result, session, exitStatus: 0, error: null };
      }
      logEvent(session, formatErrorEvent(session, {
        errorCode,
        message: errorMessage,
        phase: isPlanMode ? "plan" : "execution",
        origin,
        scriptPath: SCRIPT_PATH,
        jobId: request.jobId ?? null,
        upstreamRequestId,
        cwd: request.cwd
      }));
      logNdjson(session, "ERROR", null, { errorCode, message: errorMessage, origin, upstreamRequestId });
      markTerminalEmitted();
      const nextAction = buildTurnErrorNextAction({
        origin,
        errorCode,
        threadId: result.threadId,
        jobId: request.jobId ?? null,
        cwd: request.cwd,
        stateCwd
      });
      if (result.error && typeof result.error === "object") {
        result.error.origin = origin;
        result.error.nextAction = nextAction;
      }
      setPhase("error", nextAction, { errorCode, monitor });
      return { ...result, session };
    }
    if (result.planDetected && result.planText) {
      const planPath = writePlan(session, result.planText);
      const steps = extractPlanSteps(result.planText);
      logEvent(session, formatPlanEvent(session, {
        turnId: result.turnId,
        planTitle: result.planText.split("\n")[0]?.slice(0, 80) ?? "Plan",
        steps,
        planPath,
        scriptPath: SCRIPT_PATH,
        cwd: request.cwd
      }));
      markTerminalEmitted();
      setPhase("plan-pending", {
        command: `${bridgeCommand("send", request.cwd)} ${result.threadId} --mode default "Implement the plan."`,
        description: "Approve the plan and switch to execution mode. To revise instead, drop --mode and send revision text."
      }, { planPath, planSteps: steps, monitor });
      return { ...result, session, planPath };
    }
    if (request.noPipeline) {
      logNdjson(session, "PIPELINE_SKIPPED", null, { reason: "--no-pipeline flag" });
    }
    if (result.exitStatus === 0 && !request.noPipeline && (config.auto_review || config.post_task_prompt)) {
      const pipelineResult = await runAutoPipeline({
        session,
        threadId: result.threadId,
        cwd: request.cwd,
        config,
        scriptPath: SCRIPT_PATH,
        rootDir: ROOT_DIR,
        runAppServerTurn,
        runAppServerReview,
        jobId: request.jobId ?? null,
        stateCwd,
        // Timeouts: CLI flag → config.yaml → built-in default, same pattern as
        // the turn/idle budgets. runAutoPipeline treats `null` as "use your own
        // resolution order" so we only pass resolved numbers when we have
        // them.
        stageTimeoutMs: request.pipelineStageMs ?? (Number(config.pipeline_stage_ms) > 0 ? Number(config.pipeline_stage_ms) : null),
        totalTimeoutMs: request.pipelineTotalMs ?? (Number(config.pipeline_total_ms) > 0 ? Number(config.pipeline_total_ms) : null)
      });
      if (pipelineResult?.complete === false) {
        const pipelineErrored = Boolean(pipelineResult.error);
        const failedStage = pipelineResult.failing_stage ?? (pipelineResult.completedStages?.length ? pipelineResult.completedStages[pipelineResult.completedStages.length - 1] : "diff");
        const nextAction = pipelineErrored ? {
          command: `${bridgeCommand("result", stateCwd)} ${request.jobId ?? result.threadId}`,
          description: `Pipeline stalled after stage '${failedStage}' (${pipelineResult.error}). Read result for partial state. If this keeps happening, set auto_review: false in config.yaml.`
        } : {
          command: `${bridgeCommand("send", request.cwd)} ${result.threadId} "Complete the missing items"`,
          description: "Codex's completion check flagged gaps. Read [INCOMPLETE] in events for specifics."
        };
        setPhase("incomplete", nextAction, { pipeline: pipelineResult, monitor });
      } else {
        setPhase("done", {
          command: `${bridgeCommand("result", stateCwd)} ${request.jobId ?? result.threadId}`,
          description: "Task finished and passed completion check. Inspect full result or send a follow-up."
        }, { pipeline: pipelineResult, monitor });
      }
      markTerminalEmitted();
      return { ...result, session, pipeline: pipelineResult };
    }
    const diff = captureGitDiff(request.cwd, session);
    mirrorDiffToRegistry(request.jobId ?? request.taskId ?? null, diff.diffPath);
    logEvent(session, formatDoneEvent(session, {
      duration: 0,
      diffStat: diff.diffStat,
      files: diff.files,
      config: { model: config.model, effort: config.effort, modeFlow: isPlanMode ? "plan\u2192default" : "default" },
      diffPath: diff.diffPath,
      scriptPath: SCRIPT_PATH,
      jobId: request.jobId ?? null,
      cwd: request.cwd,
      stateCwd
    }));
    markTerminalEmitted();
    setPhase("done", {
      command: `${bridgeCommand("result", stateCwd)} ${request.jobId ?? result.threadId}`,
      description: "Task finished. Inspect full result or send a follow-up."
    }, { diffPath: diff.diffPath, monitor });
    return { ...result, session, diff };
  } finally {
    stopHeartbeat();
    stopCheckpoint();
    const backstopSession = heartbeatState.session ?? session ?? null;
    if (!terminalEmitted && backstopSession && backstopSession.eventsPath) {
      try {
        logEvent(
          backstopSession,
          formatErrorEvent(backstopSession, {
            errorCode: "UnhandledExit",
            message: "Turn exited without emitting a terminal tag. Likely a crash, SIGKILL, or an un-instrumented error path. If this reproduces, check `~/.codex-bridge/crashes/` for a crash dump and open an issue \u2014 this marker is itself the bug report.",
            phase: heartbeatState.phase ?? "unknown",
            origin: "bridge",
            scriptPath: SCRIPT_PATH,
            jobId: request.jobId ?? null,
            cwd: request.cwd,
            stateCwd
          })
        );
        logNdjson(backstopSession, "ERROR", null, {
          errorCode: "UnhandledExit",
          origin: "bridge",
          message: "finally-backstop synthesized terminal tag"
        });
      } catch {
      }
    }
  }
}
function extractPlanSteps(planText) {
  const steps = [];
  for (const line of (planText || "").split("\n")) {
    const match = line.match(/^\s*(\d+)\.\s+(.+)/);
    if (match) {
      steps.push({ number: parseInt(match[1]), text: match[2].trim(), status: "pending" });
    }
  }
  return steps.length > 0 ? steps : [{ number: 1, text: planText?.split("\n")[0] ?? "Plan", status: "pending" }];
}
async function handleTask(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [
      "model",
      "effort",
      "cwd",
      "prompt-file",
      "mode",
      "backend",
      "idle-timeout-ms",
      "turn-plan-ms",
      "turn-default-ms",
      "pipeline-stage-timeout-ms",
      "pipeline-total-timeout-ms",
      "question-timeout-ms",
      "brief",
      "intercepted-from"
    ],
    booleanOptions: ["json", "write", "read-only", "resume-last", "resume", "fresh", "background", "no-pipeline", "quiet", "worktree-auto", "rewake-on-terminal", "legacy-envelope"],
    aliasMap: {
      m: "model"
    }
  });
  const VALID_MODES = /* @__PURE__ */ new Set(["plan", "default"]);
  if (options.mode != null && !VALID_MODES.has(options.mode)) {
    throw usageError(`mode must be plan or default, got ${JSON.stringify(options.mode)}`);
  }
  const idleTimeoutOverride = parsePositiveMsOption("--idle-timeout-ms", options["idle-timeout-ms"]);
  const turnPlanOverride = parsePositiveMsOption("--turn-plan-ms", options["turn-plan-ms"]);
  const turnDefaultOverride = parsePositiveMsOption("--turn-default-ms", options["turn-default-ms"]);
  const pipelineStageOverride = parsePositiveMsOption("--pipeline-stage-timeout-ms", options["pipeline-stage-timeout-ms"]);
  const pipelineTotalOverride = parsePositiveMsOption("--pipeline-total-timeout-ms", options["pipeline-total-timeout-ms"]);
  const questionTimeoutOverride = parsePositiveMsOption("--question-timeout-ms", options["question-timeout-ms"]);
  const noPipeline = Boolean(options["no-pipeline"]);
  const quietMode = Boolean(options.quiet) || Boolean(options.json) && options.quiet !== false;
  let cwd = resolveCommandCwd(options);
  const stateCwd = cwd;
  const workspaceRoot = resolveCommandWorkspace(options);
  let brief = null;
  let briefHash2 = null;
  let briefSource = null;
  if (options.brief || options["intercepted-from"]) {
    if (!options["worktree-auto"]) {
      throw conflictError(
        "--brief and --intercepted-from require --worktree-auto (the registry slot that stores brief.json / intercepted_from is created by the worktree path).",
        "BRIEF_REQUIRES_WORKTREE_AUTO"
      );
    }
  }
  if (options.brief) {
    const result = loadBrief(options.brief, { baseDir: cwd });
    if (!result.ok) {
      throw new CliError(result.message, {
        code: result.code,
        class: result.code === "BRIEF_FILE_NOT_FOUND" ? "not_found" : "validation",
        details: result.details,
        suggestion: result.code === "BRIEF_SCHEMA_VIOLATION" ? "Fix the brief JSON to match the schema. Common valid top-level keys are goal, worker_assignment, specific_concerns, acceptance_criteria, behavior_digest_seed, parent_task_id, backend_hint, iteration_max, and trust_budget_override." : void 0
      });
    }
    brief = result.brief;
    briefHash2 = result.briefHash;
    briefSource = result.source ?? options.brief;
  }
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw conflictError(
      "Choose either --resume/--resume-last or --fresh.",
      "RESUME_FRESH_CONFLICT"
    );
  }
  if (resumeLast && options["worktree-auto"]) {
    throw conflictError(
      "--resume/--resume-last resumes a Codex thread only and cannot safely create a fresh worktree. Use `iterate <task_id>` to continue task worktree state, or start a fresh `task --write --worktree-auto` from the current branch.",
      "RESUME_WORKTREE_CONFLICT",
      "Use `codex-bridge iterate <task_id>` for follow-up fixes, or drop --resume-last and dispatch a fresh worktree task."
    );
  }
  requireTaskRequest(prompt, resumeLast);
  const write = Boolean(options.write);
  const readOnly = Boolean(options["read-only"]);
  if (write && readOnly) {
    throw conflictError(
      "Choose either --write or --read-only, not both.",
      "WRITE_READ_ONLY_CONFLICT"
    );
  }
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });
  const adapter2 = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    backend: options.backend ?? null,
    taskMetadata
  });
  ensureCodexRuntimeAdapter(adapter2);
  const job = buildTaskJob(workspaceRoot, taskMetadata, write, {
    backend: adapter2.name,
    adapterCapabilities: adapter2.capabilities()
  });
  let worktreeInfo = null;
  if (options["worktree-auto"]) {
    if (!write) {
      throw conflictError(
        "--worktree-auto requires --write.",
        "WORKTREE_WRITE_REQUIRED"
      );
    }
    ensureCodexAvailable(cwd);
    try {
      worktreeInfo = createSubagentWorktree({
        cwd,
        taskId: job.id,
        backend: adapter2.name,
        allowBranchFallback: false
      });
      if (worktreeInfo.isolation_mode !== "worktree") {
        throw new Error(`expected isolated worktree, got ${worktreeInfo.isolation_mode}`);
      }
      job.registryTaskId = job.id;
      job.worktree = worktreeInfo;
      job.isolation_mode = worktreeInfo.isolation_mode;
      try {
        writeMeta(job.id, {
          backend: adapter2.name,
          capabilities: adapter2.capabilities(),
          worktree: worktreeInfo,
          isolation_mode: worktreeInfo.isolation_mode,
          base_ref: worktreeInfo.base_ref,
          base_sha: worktreeInfo.base_sha,
          phase: "queued",
          brief_hash: briefHash2,
          brief_source: briefSource
        });
        if (brief) {
          writeBriefArtifacts(job.id, {
            brief,
            rendered: renderBriefAsMarkdown(brief),
            hash: briefHash2,
            source: briefSource
          });
        }
      } catch {
      }
      cwd = worktreeInfo.path;
    } catch (err) {
      if (err instanceof CliError) {
        throw err;
      }
      throw new CliError(
        `failed to create subagent worktree for ${job.id}: ${err.message ?? err}`,
        {
          code: "WORKTREE_CREATE_FAILED",
          class: "internal",
          suggestion: "Check that cwd is a Git repository with at least one commit, the base ref exists, and the worktree branch/path are available."
        }
      );
    }
  }
  if (options.background) {
    ensureCodexAvailable(cwd);
    const request = buildTaskRequest({
      cwd,
      stateCwd,
      model,
      effort,
      prompt,
      brief,
      write,
      readOnly,
      resumeLast,
      jobId: job.id,
      mode: options.mode ?? null,
      idleTimeoutMs: idleTimeoutOverride,
      turnPlanMs: turnPlanOverride,
      turnDefaultMs: turnDefaultOverride,
      pipelineStageMs: pipelineStageOverride,
      pipelineTotalMs: pipelineTotalOverride,
      questionAnswerMs: questionTimeoutOverride,
      noPipeline,
      backend: adapter2.name
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    emitSuccess("task", payload, renderQueuedTaskLaunch(payload), {
      json: options.json,
      startedAt
    });
    return;
  }
  await runForegroundCommand(
    job,
    (progress) => runBridgeTask({
      cwd,
      stateCwd,
      model,
      effort,
      prompt,
      brief,
      write,
      readOnly,
      resumeLast,
      jobId: job.id,
      mode: options.mode ?? null,
      idleTimeoutMs: idleTimeoutOverride,
      turnPlanMs: turnPlanOverride,
      turnDefaultMs: turnDefaultOverride,
      pipelineStageMs: pipelineStageOverride,
      pipelineTotalMs: pipelineTotalOverride,
      questionAnswerMs: questionTimeoutOverride,
      noPipeline,
      backend: adapter2.name,
      // `--quiet` suppresses the stderr `[codex] …` progress stream so
      // agents don't pattern-match a thread UUID out of it. Monitor /
      // `events --follow` remain the canonical in-run observation surface.
      onProgress: quietMode ? null : progress
    }),
    { json: options.json, startedAt, command: "task" }
  );
}
async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "workspace-root", "job-id"]
  });
  if (!options["job-id"]) {
    throw usageError("Missing required --job-id for task-worker.");
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = options["workspace-root"] ? path15.resolve(process10.cwd(), options["workspace-root"]) : resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw notFoundError(
      `No stored job found for ${options["job-id"]}.`,
      "JOB_NOT_FOUND"
    );
  }
  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new CliError(
      `Stored job ${options["job-id"]} is missing its task request payload.`,
      { class: "internal", code: "JOB_CORRUPT", retryable: false }
    );
  }
  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    async () => (
      // Go through `runBridgeTask` (not `executeTaskRun` directly) so the
      // detached worker builds the same session-logging hooks, prompt
      // decorations (`skip_meta_skills`, `prompt_footer`), sandbox-policy
      // resolution, `[QUESTION]` handler, and auto-pipeline that the
      // foreground path uses. Pre-v1.2.1 this line called `executeTaskRun`
      // directly, so `task --background` ran the turn but produced ZERO
      // session artifacts (`.events`, `.ndjson`, `.diff`) — breaking every
      // `wait` / `events --follow` caller. See `gherkin-tests-v2/
      // 07-orchestration/08-background-path-produces-session-files.md`.
      persistFailureErrorInPayload(
        await runBridgeTask({
          ...request,
          onProgress: progress
        }),
        "task"
      )
    ),
    { logFile }
  );
}
async function handleStatus(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms", "interval", "watch-timeout-ms", "retention-days", "retention-jobs"],
    booleanOptions: ["json", "all", "wait", "prune-orphans", "cleanup", "watch", "dry-run"]
  });
  const cwd = resolveCommandCwd(options);
  if (options.watch) {
    if (positionals[0]) {
      throw usageError("`status --watch` does not take a job-id argument; it watches ALL tracked jobs.");
    }
    if (options["prune-orphans"] || options.cleanup || options.wait) {
      throw usageError("`--watch` is mutually exclusive with `--prune-orphans`/`--cleanup`/`--wait`.");
    }
    const intervalMs = parseDurationOption("--interval", options.interval, { defaultMs: 1e4 });
    const overallTimeoutMs = parseDurationOption("--watch-timeout-ms", options["watch-timeout-ms"], { defaultMs: null });
    await runStatusWatch(cwd, {
      intervalMs,
      overallTimeoutMs,
      all: options.all,
      json: options.json,
      startedAt
    });
    return;
  }
  if (options["prune-orphans"] || options.cleanup) {
    const report2 = options.cleanup ? cleanupTerminalJobs(cwd, {
      dryRun: Boolean(options["dry-run"]),
      retentionDays: Number(options["retention-days"]) > 0 ? Number(options["retention-days"]) : null,
      retentionJobs: Number(options["retention-jobs"]) > 0 ? Number(options["retention-jobs"]) : null
    }) : pruneOrphanedJobs(cwd);
    emitSuccess("status", report2, options.cleanup ? renderCleanupReport(report2) : renderPruneOrphansReport(report2), {
      json: options.json,
      startedAt
    });
    return;
  }
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait ? await waitForSingleJobSnapshot(cwd, reference, {
      timeoutMs: options["timeout-ms"],
      pollIntervalMs: options["poll-interval-ms"]
    }) : buildSingleJobSnapshot(cwd, reference);
    emitSuccess("status", snapshot, renderJobStatusReport(snapshot.job), {
      json: options.json,
      startedAt
    });
    return;
  }
  if (options.wait) {
    throw usageError("`status --wait` requires a job id.");
  }
  const report = applyStopReviewGateSnapshot(buildStatusSnapshot(cwd, { all: options.all }));
  emitSuccess("status", report, renderStatusReport(report), {
    json: options.json,
    startedAt
  });
}
async function runStatusWatch(cwd, { intervalMs, overallTimeoutMs, all, json: json2, startedAt }) {
  const deadline = overallTimeoutMs ? Date.now() + overallTimeoutMs : null;
  let ticks = 0;
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
  };
  process10.on("SIGINT", onSigint);
  try {
    while (true) {
      ticks += 1;
      const snapshot = applyStopReviewGateSnapshot(buildStatusSnapshot(cwd, { all }));
      const activeCount = snapshot.running?.length ?? 0;
      const tickEntry = {
        schema_version: "1.0",
        tick: ticks,
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        activeCount,
        running: (snapshot.running ?? []).map((j) => ({
          id: j.id,
          status: j.status,
          phase: j.phase ?? null,
          threadId: j.threadId ?? null,
          kind: j.kindLabel ?? j.kind ?? null
        }))
      };
      if (json2) {
        process10.stdout.write(`${JSON.stringify(tickEntry)}
`);
      } else {
        process10.stdout.write(`\x1B[2J\x1B[H`);
        process10.stdout.write(`watch tick #${ticks} \xB7 ${tickEntry.ts} \xB7 active=${activeCount}

`);
        process10.stdout.write(renderStatusReport(snapshot));
      }
      if (activeCount === 0) {
        const summary = {
          terminated: true,
          reason: "all-terminal",
          ticks,
          final: snapshot
        };
        if (json2) {
          emitSuccess("status", summary, null, { json: true, startedAt });
        }
        return;
      }
      if (interrupted) {
        const summary = { terminated: false, reason: "sigint", ticks, final: snapshot };
        if (json2) emitSuccess("status", summary, null, { json: true, startedAt });
        return;
      }
      if (deadline && Date.now() >= deadline) {
        const summary = { terminated: false, reason: "watch-timeout", ticks, final: snapshot };
        if (json2) emitSuccess("status", summary, null, { json: true, startedAt });
        else process10.stdout.write(`
watch timed out after ${ticks} ticks with ${activeCount} active job(s).
`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    process10.off("SIGINT", onSigint);
  }
}
async function handleAwaitArtifact(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json"]
  });
  const jobRef = positionals[0];
  const artifactPath = positionals[1];
  if (!jobRef || !artifactPath) {
    throw usageError("`await-artifact <job-id> <path>` requires both a job reference and a file path.");
  }
  const cwd = resolveCommandCwd(options);
  const timeoutMs = parseDurationOption("--timeout-ms", options["timeout-ms"], { defaultMs: 9e5 });
  const pollIntervalMs = parseDurationOption("--poll-interval-ms", options["poll-interval-ms"], { defaultMs: 2e3 });
  const resolvedPath = path15.isAbsolute(artifactPath) ? artifactPath : path15.resolve(cwd, artifactPath);
  const deadline = Date.now() + timeoutMs;
  let prevSize = null;
  while (true) {
    let jobSnapshot;
    try {
      jobSnapshot = buildSingleJobSnapshot(cwd, jobRef);
    } catch (e) {
      if (e && e.code === "JOB_NOT_FOUND") {
        throw e;
      }
      throw e;
    }
    const jobStatus = jobSnapshot.job?.status ?? "unknown";
    const jobTerminal = jobStatus !== "queued" && jobStatus !== "running";
    let statInfo = null;
    try {
      statInfo = fs17.statSync(resolvedPath);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (statInfo) {
      if (prevSize != null && prevSize === statInfo.size) {
        const payload = {
          exists: true,
          path: resolvedPath,
          size: statInfo.size,
          terminated: jobTerminal,
          jobStatus,
          elapsedMs: Date.now() - startedAt,
          recovery: buildRecovery({
            reason: "artifact-ready",
            retryable: false,
            artifacts: { artifactPath: resolvedPath }
          })
        };
        emitSuccess("await-artifact", payload, `artifact ready: ${resolvedPath} (${statInfo.size} bytes)
`, {
          json: options.json,
          startedAt
        });
        return;
      }
      prevSize = statInfo.size;
    }
    if (jobTerminal) {
      const payload = {
        exists: Boolean(statInfo),
        path: resolvedPath,
        size: statInfo?.size ?? null,
        terminated: true,
        reason: `job-${jobStatus}`,
        jobStatus,
        elapsedMs: Date.now() - startedAt,
        recovery: buildRecovery({
          reason: `job-${jobStatus}`,
          retryable: true,
          nextActions: [
            `Run result ${jobSnapshot.job?.id ?? jobRef} to inspect the terminal job output.`,
            "Verify the producer writes the expected artifact path, then rerun or resume the task."
          ],
          artifacts: {
            expectedArtifactPath: resolvedPath,
            logFile: jobSnapshot.job?.logFile ?? null
          },
          details: { jobId: jobSnapshot.job?.id ?? null, jobStatus }
        })
      };
      if (!statInfo) {
        process10.exitCode = 7;
        emitSuccess("await-artifact", payload, `job reached ${jobStatus} without producing ${resolvedPath}
`, {
          json: options.json,
          startedAt
        });
        return;
      }
      emitSuccess("await-artifact", payload, `artifact present: ${resolvedPath} (${statInfo.size} bytes, job ${jobStatus})
`, {
        json: options.json,
        startedAt
      });
      return;
    }
    if (Date.now() >= deadline) {
      const payload = {
        exists: false,
        path: resolvedPath,
        terminated: false,
        reason: "timeout",
        jobStatus,
        elapsedMs: Date.now() - startedAt,
        recovery: buildRecovery({
          reason: "timeout",
          retryable: true,
          nextActions: [
            `Run status ${jobSnapshot.job?.id ?? jobRef} to confirm whether the producer is still active.`,
            "Retry await-artifact with a larger --timeout-ms or inspect events for stalled output."
          ],
          artifacts: {
            expectedArtifactPath: resolvedPath,
            logFile: jobSnapshot.job?.logFile ?? null
          },
          details: { jobId: jobSnapshot.job?.id ?? null, jobStatus }
        })
      };
      process10.exitCode = 7;
      emitSuccess("await-artifact", payload, `timeout waiting for ${resolvedPath} (job ${jobStatus})
`, {
        json: options.json,
        startedAt
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
function pruneOrphanedJobs(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listJobs(workspaceRoot, { raw: true });
  const reaped = [];
  const skipped = [];
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  for (const job of jobs) {
    const isActive = job.status === "running" || job.status === "queued";
    if (!isActive) continue;
    const pid = Number(job.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      reaped.push(finalizeOrphan(workspaceRoot, job, ts, "no-pid"));
      continue;
    }
    let alive = false;
    try {
      process10.kill(pid, 0);
      alive = true;
    } catch (err) {
      if (err && err.code === "EPERM") {
        alive = true;
      }
    }
    if (alive) {
      skipped.push({ id: job.id, pid, reason: "pid-alive" });
    } else {
      reaped.push(finalizeOrphan(workspaceRoot, job, ts, "dead-pid"));
    }
  }
  return {
    workspaceRoot,
    reaped,
    skipped,
    reapedCount: reaped.length,
    skippedCount: skipped.length,
    ts,
    recovery: buildRecovery({
      reason: reaped.length > 0 ? "orphans-reaped" : "state-clean",
      retryable: reaped.length > 0,
      nextActions: reaped.length > 0 ? [
        "Inspect result/events for reaped jobs before retrying any interrupted work.",
        "Rerun the original task only after confirming no generated artifacts were left half-written."
      ] : [],
      details: { reapedCount: reaped.length, skippedCount: skipped.length }
    })
  };
}
function finalizeOrphan(workspaceRoot, job, ts, reason) {
  const record = {
    ...job,
    status: "orphaned",
    phase: "orphaned",
    pid: null,
    completedAt: ts,
    errorMessage: `Reaped by status --prune-orphans at ${ts} (${reason}).`
  };
  writeJobFile(workspaceRoot, job.id, record);
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "orphaned",
    phase: "orphaned",
    pid: null,
    completedAt: ts,
    errorMessage: record.errorMessage
  });
  return { id: job.id, previousStatus: job.status, reason, pid: job.pid ?? null };
}
function renderPruneOrphansReport(report) {
  if (report.reapedCount === 0 && report.skippedCount === 0) {
    return "No active jobs to inspect \u2014 state is clean.\n";
  }
  const lines = [];
  if (report.reapedCount === 0) {
    lines.push(`No orphans: ${report.skippedCount} active job(s), all backed by live PIDs.`);
  } else {
    lines.push(`Reaped ${report.reapedCount} orphan(s) (status:"running"/"queued" with dead PIDs):`);
    for (const entry of report.reaped) {
      lines.push(`  - ${entry.id} (was ${entry.previousStatus}, ${entry.reason}, pid=${entry.pid ?? "null"})`);
    }
    if (report.skippedCount > 0) {
      lines.push(`Kept ${report.skippedCount} active job(s) backed by live PIDs.`);
    }
  }
  return `${lines.join("\n")}
`;
}
function cleanupTerminalJobs(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getBridgeConfig(cwd, workspaceRoot);
  const retentionDays = options.retentionDays ?? (Number(config.artifact_retention_days) || 30);
  const retentionJobs = options.retentionJobs ?? (Number(config.artifact_retention_jobs) || 50);
  const dryRun = Boolean(options.dryRun);
  const jobs = listJobs(workspaceRoot, { raw: true });
  const terminal = sortJobsNewestFirst2(jobs.filter((job) => !isActiveStatus(job.status)));
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1e3;
  const removable = terminal.filter((job, index) => {
    const ts = Date.parse(job.completedAt ?? job.updatedAt ?? job.createdAt ?? "");
    return index >= retentionJobs || Number.isFinite(ts) && ts < cutoffMs;
  });
  const removed = [];
  if (!dryRun && removable.length > 0) {
    const removeIds = new Set(removable.map((job) => job.id));
    updateState(workspaceRoot, (state) => {
      state.jobs = (state.jobs ?? []).filter((job) => !removeIds.has(job.id));
    });
    for (const job of removable) {
      for (const filePath of [resolveJobFile(workspaceRoot, job.id), job.logFile, `${job.logFile}.worker.err`]) {
        if (!filePath) continue;
        try {
          fs17.rmSync(filePath, { force: true });
        } catch {
        }
      }
      removed.push({ id: job.id, status: job.status, completedAt: job.completedAt ?? null });
    }
  }
  return {
    workspaceRoot,
    dryRun,
    retentionDays,
    retentionJobs,
    candidates: removable.map((job) => ({ id: job.id, status: job.status, completedAt: job.completedAt ?? null })),
    removed,
    removedCount: removed.length,
    candidateCount: removable.length
  };
}
function isActiveStatus(status) {
  return status === "queued" || status === "running";
}
function renderCleanupReport(report) {
  if (report.candidateCount === 0) {
    return `No terminal jobs exceed retention (${report.retentionJobs} jobs / ${report.retentionDays} days).
`;
  }
  const verb = report.dryRun ? "Would remove" : "Removed";
  const lines = [`${verb} ${report.dryRun ? report.candidateCount : report.removedCount} terminal job(s):`];
  const entries = report.dryRun ? report.candidates : report.removed;
  for (const entry of entries) {
    lines.push(`  - ${entry.id} (${entry.status}, completed=${entry.completedAt ?? "unknown"})`);
  }
  return `${lines.join("\n")}
`;
}
async function handleResult(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const adapter2 = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    metaBackend: storedJob?.backend ?? job.backend ?? null
  });
  ensureCodexRuntimeAdapter(adapter2);
  const adapterResult = await adapter2.getResult(job.id, { cwd });
  const payload = {
    job,
    storedJob,
    adapterResult
  };
  emitSuccess("result", payload, renderStoredJobResult(job, storedJob), {
    json: options.json,
    startedAt
  });
}
function waitForTerminalEvent(eventsPath, pattern, timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;
    let offset = 0;
    let watcher = null;
    let pollTimer = null;
    let timer = null;
    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      if (watcher) {
        try {
          watcher.close();
        } catch {
        }
      }
      if (pollTimer) clearInterval(pollTimer);
      if (timer) clearTimeout(timer);
      resolve(payload);
    };
    const scan = () => {
      try {
        const data = fs17.readFileSync(eventsPath, "utf8");
        if (data.length < offset) offset = 0;
        const tail = data.slice(offset);
        offset = data.length;
        for (const line of tail.split("\n")) {
          const m = pattern.exec(line);
          if (m) {
            finish({ timedOut: false, tag: m[1], line });
            return;
          }
        }
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    };
    const attachWatcher = () => {
      try {
        watcher = fs17.watch(eventsPath, { persistent: false }, scan);
        scan();
      } catch (e) {
        if (e.code === "ENOENT") {
          if (!pollTimer) {
            pollTimer = setInterval(() => {
              if (fs17.existsSync(eventsPath)) {
                clearInterval(pollTimer);
                pollTimer = null;
                attachWatcher();
              }
            }, 500);
          }
        } else {
          throw e;
        }
      }
    };
    if (fs17.existsSync(eventsPath)) {
      scan();
      if (!resolved) attachWatcher();
    } else {
      pollTimer = setInterval(() => {
        if (fs17.existsSync(eventsPath)) {
          clearInterval(pollTimer);
          pollTimer = null;
          attachWatcher();
        }
      }, 500);
    }
    timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
  });
}
async function handleWait(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms"],
    booleanOptions: ["json", "any"]
  });
  const cwd = resolveCommandCwd(options);
  if (options.any) {
    await handleWaitAny(cwd, positionals, options, startedAt);
    return;
  }
  const reference = positionals[0] ?? "";
  if (!reference) {
    throw usageError("wait requires <job-id-or-thread-id>");
  }
  let job;
  try {
    job = resolveResultJob(cwd, reference).job;
  } catch (err) {
    if (err?.code === "JOB_NOT_FINISHED") {
      job = buildSingleJobSnapshot(cwd, reference).job;
    } else {
      throw err;
    }
  }
  if (!job?.threadId) {
    throw notFoundError(
      `Job ${job?.id ?? reference} has no thread id yet.`,
      "JOB_HAS_NO_THREAD"
    );
  }
  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const eventsPath = path15.join(sessionDir, `${job.threadId}.events`);
  const timeoutMs = Math.max(1e3, Number(options["timeout-ms"]) || 6e5);
  const TERMINAL = TERMINAL_TAG_REGEX;
  const result = await waitForTerminalEvent(eventsPath, TERMINAL, timeoutMs);
  if (result.timedOut) {
    throw new CliError(
      `No terminal event in ${eventsPath} within ${Math.round(timeoutMs / 1e3)}s.`,
      {
        class: "timeout",
        code: "WAIT_TIMEOUT",
        retryable: true,
        suggestion: "Run `status <job-id>` to inspect live state."
      }
    );
  }
  const elapsedMs = Date.now() - startedAt;
  emitSuccess(
    "wait",
    {
      jobId: job.id,
      threadId: job.threadId,
      terminalTag: result.tag,
      lastEventLine: result.line,
      eventsPath,
      elapsedMs
    },
    `${result.tag} ${job.threadId} after ${Math.round(elapsedMs / 1e3)}s
`,
    { json: options.json, startedAt }
  );
}
async function handleWaitAny(cwd, references, options, startedAt) {
  const refs = references.filter(Boolean);
  if (refs.length < 2) {
    throw usageError("wait --any requires at least two job ids or thread ids.");
  }
  const timeoutMs = Math.max(1e3, Number(options["timeout-ms"]) || 6e5);
  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const TERMINAL = TERMINAL_TAG_REGEX;
  const targets = refs.map((reference) => {
    let job;
    try {
      job = resolveResultJob(cwd, reference).job;
    } catch (err) {
      if (err?.code === "JOB_NOT_FINISHED") {
        job = buildSingleJobSnapshot(cwd, reference).job;
      } else {
        throw err;
      }
    }
    if (!job?.threadId) {
      throw notFoundError(`Job ${job?.id ?? reference} has no thread id yet.`, "JOB_HAS_NO_THREAD");
    }
    return {
      reference,
      job,
      eventsPath: path15.join(sessionDir, `${job.threadId}.events`)
    };
  });
  const deadline = Date.now() + timeoutMs;
  let winner = null;
  while (!winner && Date.now() < deadline) {
    for (const target of targets) {
      const result = scanTerminalEvent(target.eventsPath, TERMINAL);
      if (result) {
        winner = { target, result };
        break;
      }
    }
    if (!winner) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!winner) {
    throw new CliError(`No terminal event for any target within ${Math.round(timeoutMs / 1e3)}s.`, {
      class: "timeout",
      code: "WAIT_TIMEOUT",
      retryable: true,
      suggestion: "Run `status --watch --all` to inspect live multi-job state."
    });
  }
  const elapsedMs = Date.now() - startedAt;
  emitSuccess(
    "wait",
    {
      mode: "any",
      winner: {
        reference: winner.target.reference,
        jobId: winner.target.job.id,
        threadId: winner.target.job.threadId,
        terminalTag: winner.result.tag,
        lastEventLine: winner.result.line,
        eventsPath: winner.target.eventsPath
      },
      targets: targets.map((target) => ({
        reference: target.reference,
        jobId: target.job.id,
        threadId: target.job.threadId,
        eventsPath: target.eventsPath
      })),
      elapsedMs
    },
    `${winner.result.tag} ${winner.target.job.id} after ${Math.round(elapsedMs / 1e3)}s
`,
    { json: options.json, startedAt }
  );
}
function scanTerminalEvent(eventsPath, pattern) {
  try {
    const data = fs17.readFileSync(eventsPath, "utf8");
    for (const line of data.split("\n")) {
      const m = pattern.exec(line);
      if (m) return { timedOut: false, tag: m[1], line };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return null;
}
async function handleEvents(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "filter", "exclude"],
    booleanOptions: ["json", "follow"]
  });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (!reference) {
    throw usageError("events requires <job-id-or-thread-id>");
  }
  if (options.filter != null && options.exclude != null) {
    throw usageError(
      "Pass either --filter OR --exclude, not both. --filter shows only listed tags (inclusion); --exclude shows everything except listed tags (forward-compatible)."
    );
  }
  let job;
  try {
    job = resolveResultJob(cwd, reference).job;
  } catch (err) {
    if (err?.code === "JOB_NOT_FINISHED") {
      job = buildSingleJobSnapshot(cwd, reference).job;
    } else {
      throw err;
    }
  }
  if (!job?.threadId) {
    throw notFoundError(
      `Job ${job?.id ?? reference} has no thread id yet.`,
      "JOB_HAS_NO_THREAD"
    );
  }
  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const eventsPath = path15.join(sessionDir, `${job.threadId}.events`);
  const parseTagList = (raw) => {
    if (raw == null || raw === "") return null;
    const tags = raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    return tags.length > 0 ? new Set(tags) : null;
  };
  const filter = parseTagList(options.filter);
  const exclude = parseTagList(options.exclude);
  const writeEventLine = (line) => {
    if (!options.json) process10.stdout.write(line + "\n");
  };
  const tagOf = (line) => {
    const m = /^\[([^\]]+)\]/.exec(line);
    return m ? m[1].split(":")[0].toUpperCase() : null;
  };
  let lastBlockIncluded = true;
  const passes = (line) => {
    const tag = tagOf(line);
    if (tag == null) {
      return lastBlockIncluded;
    }
    let included;
    if (filter) included = filter.has(tag);
    else if (exclude) included = !exclude.has(tag);
    else included = true;
    lastBlockIncluded = included;
    return included;
  };
  const TERMINAL = TERMINAL_TAG_REGEX;
  let initial = "";
  let alreadyTerminal = false;
  if (fs17.existsSync(eventsPath)) {
    initial = fs17.readFileSync(eventsPath, "utf8");
    for (const line of initial.split("\n")) {
      if (!line) continue;
      if (passes(line)) writeEventLine(line);
      if (TERMINAL.test(line)) alreadyTerminal = true;
    }
  }
  const timeoutMs = Math.max(1e3, Number(options["timeout-ms"]) || 6e5);
  if (!options.follow || alreadyTerminal) {
    emitSuccess(
      "events",
      {
        jobId: job.id,
        threadId: job.threadId,
        eventsPath,
        followed: Boolean(options.follow),
        filter: options.filter ?? null,
        exclude: options.exclude ?? null
      },
      "",
      { json: options.json, startedAt }
    );
    return;
  }
  let timedOut = false;
  let terminalTag = null;
  let terminalLine = null;
  const followStartMs = Date.now();
  await new Promise((resolve) => {
    let offset = initial.length;
    let watcher = null;
    let pollTimer = null;
    let timer = null;
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      if (reason === "timeout") timedOut = true;
      if (watcher) watcher.close();
      if (pollTimer) clearInterval(pollTimer);
      if (timer) clearTimeout(timer);
      resolve();
    };
    const scanAppended = () => {
      let data;
      try {
        data = fs17.readFileSync(eventsPath, "utf8");
      } catch (e) {
        if (e.code === "ENOENT") return;
        throw e;
      }
      if (data.length < offset) offset = 0;
      const tail = data.slice(offset);
      offset = data.length;
      const lines = tail.split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (!line) continue;
        if (passes(line)) writeEventLine(line);
        if (TERMINAL.test(line)) {
          terminalTag = TERMINAL.exec(line)[1];
          terminalLine = line;
          return finish("terminal");
        }
      }
    };
    const attachWatcher = () => {
      try {
        watcher = fs17.watch(eventsPath, { persistent: false }, scanAppended);
        scanAppended();
      } catch (e) {
        if (e.code === "ENOENT") {
          if (!pollTimer)
            pollTimer = setInterval(() => {
              if (fs17.existsSync(eventsPath)) {
                clearInterval(pollTimer);
                pollTimer = null;
                attachWatcher();
              }
            }, 500);
        } else {
          throw e;
        }
      }
    };
    if (fs17.existsSync(eventsPath)) {
      attachWatcher();
    } else {
      pollTimer = setInterval(() => {
        if (fs17.existsSync(eventsPath)) {
          clearInterval(pollTimer);
          pollTimer = null;
          attachWatcher();
        }
      }, 500);
    }
    timer = setTimeout(() => finish("timeout"), timeoutMs);
  });
  if (timedOut && !options.json) {
    throw new CliError(
      `No terminal event in ${eventsPath} within ${Math.round(timeoutMs / 1e3)}s.`,
      {
        class: "timeout",
        code: "WAIT_TIMEOUT",
        retryable: true,
        suggestion: "Run `status <job-id>` to inspect live state."
      }
    );
  }
  emitSuccess(
    "events",
    {
      jobId: job.id,
      threadId: job.threadId,
      eventsPath,
      followed: true,
      filter: options.filter ?? null,
      exclude: options.exclude ?? null,
      timedOut,
      // Final-envelope fields added in 1.2.5 so Monitor / orchestrators can
      // distinguish happy-path closure from timeout without re-reading the
      // file. terminalTag is one of DONE / ERROR / INCOMPLETE / PLAN on success,
      // or null when the stream ended via timeout. elapsedMs measures
      // follow duration only (not total job elapsed time).
      terminalTag,
      terminalLine,
      elapsedMs: Date.now() - followStartMs
    },
    "",
    { json: options.json, startedAt }
  );
}
function handleTaskResumeCandidate(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst2(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);
  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate: candidate == null ? null : {
      id: candidate.id,
      status: candidate.status,
      title: candidate.title ?? null,
      summary: candidate.summary ?? null,
      threadId: candidate.threadId,
      completedAt: candidate.completedAt ?? null,
      updatedAt: candidate.updatedAt ?? null
    }
  };
  const rendered = candidate ? `Resumable task found: ${candidate.id} (${candidate.status}).
` : "No resumable task found for this session.\n";
  emitSuccess("task-resume-candidate", payload, rendered, {
    json: options.json,
    startedAt
  });
}
async function handleCancel(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process10.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;
  const adapter2 = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    metaBackend: existing.backend ?? job.backend ?? null
  });
  ensureCodexRuntimeAdapter(adapter2);
  const interrupt = await adapter2.cancel(job.id, { cwd, threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.` : `Codex turn interrupt failed${interrupt.reason ? `: ${interrupt.reason}` : "."}`
    );
  }
  const terminate = terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");
  const warnings = [];
  if (interrupt.attempted && !interrupt.interrupted) {
    warnings.push(
      interrupt.reason ? `turn interrupt failed: ${interrupt.reason}` : "turn interrupt failed (no reason returned)"
    );
  }
  if (terminate.attempted && !terminate.delivered) {
    warnings.push(`process ${job.pid} was already gone (method=${terminate.method ?? "unknown"})`);
  }
  const completedAt = nowIso2();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };
  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });
  const kindLabel = existing.kindLabel ?? job.kindLabel ?? job.jobClass ?? "task";
  const KIND_TITLE = {
    "task": "Codex Task",
    "review": "Codex Review",
    "adversarial-review": "Codex Adversarial Review",
    "rescue-review": "Codex Stop Gate Review"
  };
  const normalizedTitle = KIND_TITLE[kindLabel] ?? "Codex Job";
  const payload = {
    jobId: job.id,
    status: "cancelled",
    cancelled: true,
    processTerminated: Boolean(terminate.delivered),
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted,
    reason: "cancelled-by-user",
    warnings,
    title: normalizedTitle,
    dispatchTitle: job.title ?? null,
    kindLabel,
    recovery: buildRecovery({
      reason: "cancelled-by-user",
      retryable: false,
      nextActions: [
        `Run result ${job.id} to inspect any partial output.`,
        "Start a fresh task if the cancelled work is still required."
      ],
      artifacts: {
        logFile: job.logFile ?? null,
        threadId,
        turnId
      },
      details: {
        interruptAttempted: interrupt.attempted,
        interrupted: interrupt.interrupted,
        interruptReason: interrupt.reason ?? null,
        terminateAttempted: terminate.attempted,
        terminateDelivered: Boolean(terminate.delivered),
        terminateMethod: terminate.method ?? null
      }
    })
  };
  emitSuccess("cancel", payload, renderCancelReport({ ...nextJob, title: normalizedTitle }), {
    json: options.json,
    startedAt
  });
}
function resolvePromptInput(options, positionals, cwd) {
  if (options["prompt-file"]) {
    return readPromptFileOrThrow(path15.resolve(cwd, options["prompt-file"]));
  }
  if (positionals.length === 1) {
    const candidate = path15.resolve(cwd, positionals[0]);
    try {
      if (fs17.existsSync(candidate) && fs17.statSync(candidate).isFile()) {
        return fs17.readFileSync(candidate, "utf8");
      }
    } catch {
    }
  }
  const text = positionals.join(" ");
  if (text) return text;
  return readStdinIfPiped();
}
function readReviewedBranchHeadSha(verdict) {
  const candidates = [
    verdict?.branch_head_sha,
    verdict?.reviewed_branch_head_sha,
    verdict?.branchHeadSha
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim().toLowerCase();
    if (/^[a-f0-9]{40}$/.test(normalized)) {
      return normalized;
    }
  }
  return null;
}
function readCurrentTaskBranchHeadSha(meta, cwd) {
  const branch = meta?.worktree?.branch;
  if (!branch) return null;
  const candidates = [
    meta?.worktree?.path,
    cwd
  ].filter(
    (candidate, index, all) => typeof candidate === "string" && candidate.length > 0 && fs17.existsSync(candidate) && all.indexOf(candidate) === index
  );
  for (const candidateCwd of candidates) {
    const result = runCommand("git", ["rev-parse", "--verify", branch], {
      cwd: candidateCwd,
      timeout: 1e4
    });
    if (result.status !== 0 || result.error) continue;
    const sha = result.stdout.trim().toLowerCase();
    if (/^[a-f0-9]{40}$/.test(sha)) return sha;
  }
  return null;
}
function describeMergeBlocker(blocker) {
  if (blocker === "missing_approval") return "verdict is not approved";
  if (blocker === "missing_branch_sha") return "approved verdict is missing branch_head_sha";
  if (blocker === "missing_branch") return "task metadata is missing worktree.branch";
  if (blocker === "branch_head_unavailable") return "current branch head could not be resolved";
  if (blocker === "head_drift") return "current branch head differs from the approved reviewed head";
  return "merge readiness could not be determined";
}
function nextActionForMergeReadiness(taskId, blocker) {
  if (!blocker) {
    return {
      kind: "merge",
      argv: ["merge", taskId],
      description: "Merge the approved unchanged reviewed branch head."
    };
  }
  if (blocker === "missing_approval") {
    return {
      kind: "review-or-iterate",
      argv: ["iterate", taskId],
      description: "Continue review or iterate until the task has an approved verdict."
    };
  }
  if (blocker === "missing_branch_sha" || blocker === "head_drift" || blocker === "branch_head_unavailable") {
    return {
      kind: "rerun-review",
      argv: ["adversarial-review", "--task", taskId, "--json"],
      description: "Rerun task-bound review and record a fresh verdict for the current branch head."
    };
  }
  return {
    kind: "inspect-task-metadata",
    argv: ["verdict", taskId, "--json"],
    description: "Inspect task metadata before attempting merge."
  };
}
function buildVerdictMergeReadiness(taskId, verdict, meta, cwd) {
  const reviewedBranchHeadSha = readReviewedBranchHeadSha(verdict);
  const currentBranchHeadSha = readCurrentTaskBranchHeadSha(meta, cwd);
  const blockers = [];
  if (verdict?.verdict !== "approved") {
    blockers.push("missing_approval");
  } else if (!reviewedBranchHeadSha) {
    blockers.push("missing_branch_sha");
  } else if (!meta?.worktree?.branch) {
    blockers.push("missing_branch");
  } else if (!currentBranchHeadSha) {
    blockers.push("branch_head_unavailable");
  } else if (currentBranchHeadSha !== reviewedBranchHeadSha) {
    blockers.push("head_drift");
  }
  const primaryBlocker = blockers[0] ?? null;
  return {
    merge_ready: blockers.length === 0,
    merge_blocked_by: primaryBlocker,
    merge_blockers: blockers,
    merge_block_reason: primaryBlocker ? describeMergeBlocker(primaryBlocker) : null,
    branch: meta?.worktree?.branch ?? null,
    branch_head_sha: reviewedBranchHeadSha,
    reviewed_branch_head_sha: reviewedBranchHeadSha,
    current_branch_head_sha: currentBranchHeadSha,
    next_action: nextActionForMergeReadiness(taskId, primaryBlocker)
  };
}
function buildIterateArtifacts(taskId, execution = null, logFile = null) {
  const dir = jobDir(taskId);
  return {
    registry_dir: dir,
    meta_path: path15.join(dir, "meta.json"),
    review_path: path15.join(dir, "review.json"),
    verdict_path: path15.join(dir, "verdict.json"),
    events_path: execution?.payload?.eventsPath ?? null,
    events_dir: execution?.payload?.eventsDir ?? null,
    log_file: logFile
  };
}
function isSafeTaskId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    return false;
  }
  return true;
}
function resolveIterateInput(options, positionals, cwd) {
  if (positionals.length === 1) {
    const taskId = positionals[0];
    if (isSafeTaskId(taskId) && existsTask(taskId)) {
      let meta;
      try {
        meta = readMeta(taskId);
      } catch (err) {
        throw validationError(
          `task ${taskId} metadata is unreadable: ${err.message ?? err}`,
          "TASK_META_UNREADABLE"
        );
      }
      if (!meta) {
        throw validationError(
          `task ${taskId} exists but is missing meta.json; restore the task metadata or discard the task before iterating`,
          "TASK_META_MISSING"
        );
      }
      return { taskId, prompt: null, meta };
    }
  }
  return {
    taskId: null,
    prompt: resolvePromptInput(options, positionals, cwd),
    meta: null
  };
}
function loadIterateBrief(options, cwd) {
  if (!options.brief) return { brief: null, briefHash: null, source: null };
  const result = loadBrief(options.brief, { baseDir: cwd });
  if (!result.ok) {
    throw new CliError(result.message, {
      code: result.code,
      class: result.code === "BRIEF_FILE_NOT_FOUND" ? "not_found" : "validation"
    });
  }
  return {
    brief: result.brief,
    briefHash: result.briefHash,
    source: result.source ?? options.brief
  };
}
function buildIteratePrompt(prompt, brief) {
  const text = String(prompt ?? "").trim();
  if (!brief?.brief) return text;
  const renderedBrief = renderBriefAsMarkdown(brief.brief);
  return [renderedBrief, text].filter(Boolean).join("\n\n");
}
async function runIterateTaskJob({
  prompt,
  cwd,
  stateCwd,
  workspaceRoot,
  model,
  effort,
  adapter: adapter2,
  parentTaskId = null,
  iteration = 1,
  worktree = null,
  brief = null
}) {
  const taskMetadata = buildTaskRunMetadata({ prompt });
  const job = buildTaskJob(workspaceRoot, taskMetadata, true, {
    backend: adapter2.name,
    adapterCapabilities: adapter2.capabilities()
  });
  let worktreeInfo = worktree;
  if (!worktreeInfo) {
    worktreeInfo = createSubagentWorktree({
      cwd,
      taskId: job.id,
      backend: adapter2.name,
      allowBranchFallback: false
    });
  }
  if (worktreeInfo.isolation_mode !== "worktree") {
    throw new Error(`iterate requires an isolated worktree, got ${worktreeInfo.isolation_mode}`);
  }
  job.registryTaskId = job.id;
  job.worktree = worktreeInfo;
  job.isolation_mode = worktreeInfo.isolation_mode;
  writeMeta(job.id, {
    backend: adapter2.name,
    capabilities: adapter2.capabilities(),
    worktree: worktreeInfo,
    isolation_mode: worktreeInfo.isolation_mode,
    base_ref: worktreeInfo.base_ref,
    base_sha: worktreeInfo.base_sha,
    phase: "iterate-running",
    parent_task_id: parentTaskId,
    iteration_index: iteration,
    brief_hash: brief?.briefHash ?? null,
    brief_source: brief?.source ?? null
  });
  if (brief?.brief) {
    writeBriefArtifacts(job.id, {
      brief: brief.brief,
      rendered: renderBriefAsMarkdown(brief.brief),
      hash: brief.briefHash,
      source: brief.source
    });
  }
  const taskCwd = worktreeInfo.path;
  const request = buildTaskRequest({
    cwd: taskCwd,
    stateCwd,
    model,
    effort,
    prompt,
    brief: brief?.brief ?? null,
    write: true,
    readOnly: false,
    resumeLast: false,
    jobId: job.id,
    mode: "default",
    noPipeline: true,
    backend: adapter2.name
  });
  const { logFile } = createTrackedProgress(job, { stderr: false });
  const execution = await runTrackedJob(
    job,
    async () => persistFailureErrorInPayload(
      await runBridgeTask({
        ...request,
        onProgress: null
      }),
      "task"
    ),
    { logFile }
  );
  return {
    task_id: job.id,
    execution,
    worktree: worktreeInfo,
    artifacts: buildIterateArtifacts(job.id, execution, logFile)
  };
}
function createIterateDependencies({ cwd, workspaceRoot, model, effort, adapter: adapter2, brief }) {
  const stateCwd = cwd;
  const readTaskCompletion = async ({ taskId, startedTask }) => {
    if (startedTask?.execution?.exitStatus && startedTask.execution.exitStatus !== 0) {
      const err = new Error(startedTask.execution.error?.message ?? `task ${taskId} failed`);
      err.code = "ITERATE_TASK_FAILED";
      throw err;
    }
    const storedJob = readStoredJob(workspaceRoot, taskId);
    if (storedJob?.status === "queued" || storedJob?.status === "running") {
      const err = new Error(`task ${taskId} is still ${storedJob.status}; wait for task completion before reviewing`);
      err.code = "ITERATE_TASK_STILL_RUNNING";
      throw err;
    }
    if (storedJob?.status === "failed") {
      const err = new Error(storedJob.errorMessage ?? `task ${taskId} failed`);
      err.code = "ITERATE_TASK_FAILED";
      throw err;
    }
    const meta = readMeta(taskId);
    if (!meta) {
      const err = new Error(`no meta.json found for ${taskId}`);
      err.code = "ITERATE_TASK_META_MISSING";
      throw err;
    }
    return {
      task_id: taskId,
      meta,
      artifacts: buildIterateArtifacts(taskId, startedTask?.execution ?? null, startedTask?.artifacts?.log_file ?? null)
    };
  };
  const runReview = async ({ taskId }) => {
    const taskReview = requireTaskReviewContext(taskId, {});
    const reviewRun = await executeReviewRun({
      cwd: taskReview.cwd,
      base: taskReview.base,
      scope: taskReview.scope,
      model,
      backend: adapter2.name,
      reviewName: "Adversarial Review",
      taskId,
      reviewedBranchHeadSha: taskReview.reviewedBranchHeadSha
    });
    const reviewResult = reviewRun.payload?.review_result ?? null;
    if (reviewRun.exitStatus !== 0 || !reviewResult) {
      const err = new Error(reviewRun.error?.message ?? reviewRun.payload?.parseError ?? `review failed for ${taskId}`);
      err.code = "ITERATE_REVIEW_FAILED";
      throw err;
    }
    return {
      review_result: reviewResult,
      thread_id: reviewRun.threadId ?? null,
      artifacts: buildIterateArtifacts(taskId)
    };
  };
  const writeIterateVerdict = async ({ taskId, reviewResult }) => {
    const verdict = mapReviewVerdictToTaskVerdict(reviewResult);
    const reviewedHead = reviewResult?.reviewed_branch_head_sha ?? reviewResult?.branch_head_sha ?? null;
    writeVerdict(taskId, {
      ...reviewResult,
      verdict,
      reviewer: "codex-bridge-iterate",
      ...reviewedHead ? { branch_head_sha: reviewedHead, reviewed_branch_head_sha: reviewedHead } : {}
    });
    return {
      verdict: readVerdict(taskId),
      artifacts: buildIterateArtifacts(taskId)
    };
  };
  const startFollowup = async ({ previousTaskId, iteration, prompt }) => {
    const meta = readMeta(previousTaskId);
    if (!meta?.worktree?.path || !meta?.worktree?.branch) {
      const err = new Error(`task ${previousTaskId} is missing worktree metadata for follow-up`);
      err.code = "ITERATE_FOLLOWUP_META_MISSING";
      throw err;
    }
    return runIterateTaskJob({
      prompt,
      cwd: meta.worktree.path,
      stateCwd,
      workspaceRoot,
      model,
      effort,
      adapter: adapter2,
      parentTaskId: previousTaskId,
      iteration,
      worktree: meta.worktree,
      brief
    });
  };
  const markSuperseded = async ({ taskId, nextTaskId, iteration, verdict }) => {
    const supersededAt = nowIso2();
    const reason = "iterate-followup";
    const existingVerdict = readVerdict(taskId);
    if (existingVerdict) {
      writeVerdict(taskId, {
        ...existingVerdict,
        superseded_by: nextTaskId,
        superseded_at: supersededAt,
        superseded_reason: reason,
        superseded_iteration: iteration + 1
      });
    }
    const meta = readMeta(taskId);
    if (meta) {
      writeMeta(taskId, {
        ...meta,
        phase: "superseded",
        superseded_by: nextTaskId,
        superseded_at: supersededAt,
        superseded_reason: reason,
        superseded_verdict: verdict
      });
    }
    return {
      superseded_by: nextTaskId,
      artifacts: buildIterateArtifacts(taskId)
    };
  };
  return {
    startTask: ({ prompt, iteration }) => runIterateTaskJob({
      prompt,
      cwd,
      stateCwd,
      workspaceRoot,
      model,
      effort,
      adapter: adapter2,
      iteration,
      brief
    }),
    readTaskCompletion,
    runReview,
    writeVerdict: writeIterateVerdict,
    startFollowup,
    markSuperseded
  };
}
async function handleIterate(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["max", "brief", "backend", "cwd", "prompt-file", "model", "effort"],
    booleanOptions: ["json", "write"],
    aliasMap: { m: "model" }
  });
  const max = options.max ? Number.parseInt(options.max, 10) : 3;
  if (!Number.isInteger(max) || max < 1 || max > 10) {
    throw usageError(`--max must be an integer between 1 and 10 (got ${JSON.stringify(options.max)})`);
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const input = resolveIterateInput(options, positionals, cwd);
  const brief = loadIterateBrief(options, cwd);
  const prompt = input.taskId ? null : buildIteratePrompt(input.prompt, brief);
  if (!input.taskId && !prompt) {
    throw validationError("iterate requires a task_id, prompt, prompt file, or piped stdin", "MISSING_PROMPT");
  }
  const adapter2 = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    backend: options.backend ?? null
  });
  ensureCodexRuntimeAdapter(adapter2);
  guardCapability(adapter2, "supports_worktree");
  guardCapability(adapter2, "supports_artifact_registry");
  guardCapability(adapter2, "supports_adversarial_review");
  ensureCodexAvailable(cwd);
  if (!input.taskId) ensureGitRepository(cwd);
  const config = getBridgeConfig(cwd, workspaceRoot);
  const model = normalizeRequestedModel(options.model ?? config.model);
  const effort = normalizeReasoningEffort(options.effort ?? config.effort);
  const payload = await runIterateLoop({
    max,
    taskId: input.taskId,
    prompt,
    deps: createIterateDependencies({
      cwd,
      workspaceRoot,
      model,
      effort,
      adapter: adapter2,
      brief
    })
  });
  emitSuccess(
    "iterate",
    payload,
    `iterate ${payload.status} after ${payload.iterations?.length ?? 0}/${max} iteration(s).
`,
    { json: options.json, startedAt }
  );
}
var VERDICT_VALUES = /* @__PURE__ */ new Set(["approved", "needs-attention", "must-fix"]);
function validateVerdictValue(verdict, optionName = "--set") {
  if (!VERDICT_VALUES.has(verdict)) {
    throw usageError(
      `${optionName} must be one of approved | needs-attention | must-fix (got ${JSON.stringify(verdict)})`
    );
  }
}
function readVerdictPayloadFromStdin() {
  const raw = readStdinIfPiped().trim();
  if (!raw) {
    throw usageError("--payload-stdin requires a JSON object on stdin");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw usageError(`--payload-stdin must be valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError("--payload-stdin must be a JSON object");
  }
  validateVerdictValue(parsed.verdict, "payload.verdict");
  if (parsed.findings != null && !Array.isArray(parsed.findings)) {
    throw usageError("payload.findings must be an array when provided");
  }
  const reviewedBranchHeadSha = parsed.branch_head_sha ?? parsed.reviewed_branch_head_sha ?? parsed.branchHeadSha ?? null;
  if (reviewedBranchHeadSha != null && (typeof reviewedBranchHeadSha !== "string" || !/^[0-9a-f]{40}$/i.test(reviewedBranchHeadSha.trim()))) {
    throw usageError("payload.reviewed_branch_head_sha must be a 40-character hex SHA when provided");
  }
  const normalizedBranchHeadSha = typeof reviewedBranchHeadSha === "string" ? reviewedBranchHeadSha.trim().toLowerCase() : null;
  return {
    ...parsed,
    verdict: parsed.verdict,
    summary: typeof parsed.summary === "string" ? parsed.summary : null,
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    reviewer: typeof parsed.reviewer === "string" ? parsed.reviewer : null,
    ...normalizedBranchHeadSha ? {
      branch_head_sha: normalizedBranchHeadSha,
      reviewed_branch_head_sha: normalizedBranchHeadSha
    } : {}
  };
}
async function handleVerdict(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["set", "summary", "reviewer", "cwd"],
    repeatableValueOptions: ["finding"],
    booleanOptions: ["json", "discard", "payload-stdin"]
  });
  const taskId = positionals[0];
  if (!taskId) {
    throw usageError("verdict requires a task_id positional argument");
  }
  const modeCount = [Boolean(options.discard), Boolean(options.set), Boolean(options["payload-stdin"])].filter(Boolean).length;
  if (modeCount > 1) {
    throw usageError("verdict modes are mutually exclusive: choose one of --set, --payload-stdin, or --discard");
  }
  if (options.discard) {
    const target = path15.join(jobDir(taskId), "verdict.json");
    let removed = false;
    if (fs17.existsSync(target)) {
      fs17.rmSync(target, { force: true });
      removed = true;
    }
    emitSuccess(
      "verdict",
      { task_id: taskId, action: "discarded", removed },
      `Discarded verdict for ${taskId}
`,
      { json: options.json, startedAt }
    );
    return;
  }
  if (options["payload-stdin"]) {
    if (options.summary || options.reviewer || options.finding) {
      throw usageError("--payload-stdin cannot be combined with --summary, --reviewer, or --finding");
    }
    const payload = readVerdictPayloadFromStdin();
    writeVerdict(taskId, payload);
    const stored2 = readVerdict(taskId);
    emitSuccess(
      "verdict",
      { task_id: taskId, action: "set", verdict: stored2 },
      `Verdict for ${taskId}: ${payload.verdict}
`,
      { json: options.json, startedAt }
    );
    return;
  }
  if (options.set) {
    const verdict = options.set;
    validateVerdictValue(verdict);
    const payload = {
      verdict,
      summary: options.summary ?? null,
      findings: Array.isArray(options.finding) ? options.finding : options.finding ? [options.finding] : [],
      reviewer: options.reviewer ?? null
    };
    writeVerdict(taskId, payload);
    const stored2 = readVerdict(taskId);
    emitSuccess(
      "verdict",
      { task_id: taskId, action: "set", verdict: stored2 },
      `Verdict for ${taskId}: ${verdict}
`,
      { json: options.json, startedAt }
    );
    return;
  }
  const stored = readVerdict(taskId);
  if (!stored) {
    throw notFoundError(
      `no verdict found for ${taskId}; use --set to create one`
    );
  }
  const cwd = resolveCommandCwd(options);
  const meta = readMeta(taskId);
  const mergeReadiness = buildVerdictMergeReadiness(taskId, stored, meta, cwd);
  const result = {
    task_id: taskId,
    verdict: {
      ...stored,
      summary: stored.summary ?? null,
      branch: mergeReadiness.branch,
      branch_head_sha: mergeReadiness.branch_head_sha,
      reviewed_branch_head_sha: mergeReadiness.reviewed_branch_head_sha
    },
    merge_readiness: mergeReadiness
  };
  emitSuccess(
    "verdict",
    result,
    JSON.stringify(result, null, 2) + "\n",
    { json: options.json, startedAt }
  );
}
async function handleVerdictsPending(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "pending"]
  });
  if (!options.pending) {
    throw usageError(
      "verdicts requires --pending (only mode currently supported)"
    );
  }
  const cwd = resolveCommandCwd(options);
  const pendingVerdicts = /* @__PURE__ */ new Set(["approved", "needs-attention", "must-fix"]);
  const tasks = listTasks();
  const pending = [];
  for (const taskId of tasks) {
    const verdict = readVerdict(taskId);
    if (!verdict) continue;
    const meta = readMeta(taskId);
    if (verdict.merged_at || meta?.merged_at || meta?.phase === "merged") {
      continue;
    }
    if (verdict.superseded_by || meta?.superseded_by || meta?.phase === "superseded") {
      continue;
    }
    if (pendingVerdicts.has(verdict.verdict)) {
      const mergeReadiness = buildVerdictMergeReadiness(taskId, verdict, meta, cwd);
      pending.push({
        task_id: taskId,
        verdict: verdict.verdict,
        summary: verdict.summary ?? null,
        decided_at: verdict.decided_at,
        branch: mergeReadiness.branch,
        branch_head_sha: mergeReadiness.branch_head_sha,
        reviewed_branch_head_sha: mergeReadiness.reviewed_branch_head_sha,
        current_branch_head_sha: mergeReadiness.current_branch_head_sha,
        merge_ready: mergeReadiness.merge_ready,
        merge_blocked_by: mergeReadiness.merge_blocked_by,
        merge_blockers: mergeReadiness.merge_blockers,
        merge_block_reason: mergeReadiness.merge_block_reason,
        next_action: mergeReadiness.next_action
      });
    }
  }
  const rendered = pending.length === 0 ? "No pending verdicts.\n" : pending.map(
    (p) => `${p.task_id}  ${p.verdict}  ${p.branch ?? "(no branch)"}  ${p.merge_ready ? "merge-ready" : `blocked:${p.merge_blocked_by ?? "unknown"}`}  ${p.summary ?? ""}`
  ).join("\n") + "\n";
  emitSuccess(
    "verdicts",
    { count: pending.length, pending },
    rendered,
    { json: options.json, startedAt }
  );
}
async function handleMerge(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "no-tests", "pr"]
  });
  const taskId = positionals[0];
  if (!taskId) {
    throw usageError("merge requires a task_id positional argument");
  }
  const cwd = resolveCommandCwd(options);
  const verdict = readVerdict(taskId);
  if (!verdict) {
    throw notFoundError(
      `no verdict found for ${taskId}; run review and record an approved verdict before merging`
    );
  }
  if (verdict.verdict !== "approved") {
    throw new CliError(
      `verdict for ${taskId} is ${verdict.verdict}, not approved; refusing to merge. Re-run review or iterate before approving this task.`,
      { code: "VERDICT_NOT_APPROVED", class: "conflict" }
    );
  }
  const reviewedBranchHeadSha = readReviewedBranchHeadSha(verdict);
  if (!reviewedBranchHeadSha) {
    throw new CliError(
      `approved verdict for ${taskId} is missing branch_head_sha; rerun review so the approval is bound to the reviewed branch head`,
      { code: "VERDICT_HEAD_SHA_MISSING", class: "conflict" }
    );
  }
  const meta = readMeta(taskId);
  if (!meta) {
    throw notFoundError(
      `no meta.json found for ${taskId}; the task was not dispatched via --worktree-auto`
    );
  }
  const branch = meta.worktree?.branch;
  const baseRef = meta.worktree?.base_ref ?? "main";
  if (!branch) {
    throw new CliError(
      `meta.json for ${taskId} missing worktree.branch \u2014 task may not have been dispatched via --worktree-auto`,
      { code: "MERGE_META_INVALID", class: "internal" }
    );
  }
  if (options.pr) {
    throw new CliError(
      "--pr mode not yet implemented; ff-merge into the base ref is the only supported strategy in v2.0. Drop --pr or wait for the follow-up.",
      { code: "MERGE_PR_NOT_IMPLEMENTED", class: "internal" }
    );
  }
  let mergeResult;
  try {
    mergeResult = mergeSubagentBranch({
      cwd,
      taskId,
      branch,
      baseRef,
      expectedBranchSha: reviewedBranchHeadSha,
      worktreePath: meta.worktree?.path,
      runTests: !options["no-tests"]
    });
  } catch (err) {
    const kind = err?.kind;
    if (kind === "conflict") {
      throw new CliError(
        `merge failed: ${err.message ?? err}. The worktree was left intact; resolve conflicts manually or rerun /codex-bridge:iterate.`,
        { code: "MERGE_CONFLICT", class: "conflict" }
      );
    }
    if (kind === "sha_drift") {
      throw new CliError(
        `merge refused: ${err.message ?? err}`,
        { code: "MERGE_SHA_DRIFT", class: "conflict" }
      );
    }
    if (kind === "precondition") {
      throw new CliError(
        `merge precondition failed: ${err.message ?? err}`,
        { code: "MERGE_PRECONDITION", class: "usage" }
      );
    }
    throw new CliError(
      `merge failed: ${err.message ?? err}`,
      { code: "MERGE_INTERNAL", class: "internal" }
    );
  }
  const mergedAt = nowIso2();
  const {
    schema_version: _verdictSchemaVersion,
    task_id: _verdictTaskId,
    decided_at: _verdictDecidedAt,
    ...verdictBody
  } = verdict;
  writeVerdict(taskId, {
    ...verdictBody,
    merged_at: mergedAt,
    merge: mergeResult
  });
  const {
    schema_version: _schemaVersion,
    task_id: _taskId,
    written_at: _writtenAt,
    ...metaBody
  } = meta;
  writeMeta(taskId, {
    ...metaBody,
    phase: "merged",
    merged_at: mergedAt,
    merge: mergeResult
  });
  const payload = {
    task_id: taskId,
    merge: mergeResult,
    verdict: verdict.verdict,
    reviewed_branch_head_sha: reviewedBranchHeadSha
  };
  emitSuccess(
    "merge",
    payload,
    `Merged ${branch} into ${baseRef} (${mergeResult.commit_sha?.slice(0, 8) ?? "?"})
`,
    { json: options.json, startedAt }
  );
}
async function handleSend(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [
      "mode",
      "effort",
      "cwd",
      "backend",
      "idle-timeout-ms",
      "turn-timeout-ms",
      "question-timeout-ms"
    ],
    booleanOptions: ["json", "wait", "quiet"],
    aliasMap: { m: "mode" }
  });
  const VALID_MODES = /* @__PURE__ */ new Set(["plan", "default"]);
  if (options.mode != null && !VALID_MODES.has(options.mode)) {
    throw usageError(`mode must be plan or default, got ${JSON.stringify(options.mode)}`);
  }
  const idleTimeoutOverride = parsePositiveMsOption("--idle-timeout-ms", options["idle-timeout-ms"]);
  const turnTimeoutOverride = parsePositiveMsOption("--turn-timeout-ms", options["turn-timeout-ms"]);
  const questionTimeoutOverride = parsePositiveMsOption("--question-timeout-ms", options["question-timeout-ms"]);
  const quietMode = Boolean(options.quiet) || Boolean(options.json) && options.quiet !== false;
  const startedAt = Date.now();
  const rawThreadId = positionals[0];
  if (!rawThreadId) {
    throw usageError("send requires <thread-id>");
  }
  if (!isThreadId(rawThreadId)) {
    throw invalidThreadIdError(rawThreadId, "thread-id");
  }
  const threadId = rawThreadId.trim();
  const promptParts = positionals.slice(1);
  const cwd = resolveCommandCwd(options);
  const prompt = resolvePromptInput(options, promptParts, cwd);
  if (!prompt) {
    throw validationError("send requires a prompt (text or file)", "MISSING_PROMPT");
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getBridgeConfig(cwd, workspaceRoot);
  const adapter2 = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    backend: options.backend ?? null
  });
  ensureCodexRuntimeAdapter(adapter2);
  guardCapability(adapter2, "supports_resume");
  const modeOverride = options.mode;
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const sendIsPlanMode = modeOverride === "plan";
  const turnOptions = {
    resumeThreadId: threadId,
    prompt,
    model: config.model,
    effort: normalizeReasoningEffort(options.effort ?? config.effort),
    sandbox: modeOverride === "default" ? "workspace-write" : modeOverride === "plan" ? "read-only" : void 0,
    onProgress: null,
    // Resolution order: --idle-timeout-ms flag → config.yaml `idle_timeout_ms`
    // → 300_000 fallback. Mirrors the `task` path; see runBridgeTask.
    idleTimeoutMs: idleTimeoutOverride != null ? idleTimeoutOverride : Number(config.idle_timeout_ms) > 0 ? Number(config.idle_timeout_ms) : DEFAULT_CONFIG.idle_timeout_ms,
    // Turn timeout: per-invocation override > the mode-appropriate config key
    // (turn_plan_ms for plan-mode sends, turn_default_ms otherwise) > built-in
    // default. `send` gets a single --turn-timeout-ms flag that maps onto the
    // right budget based on the resolved mode.
    turnTimeoutMs: turnTimeoutOverride ?? (sendIsPlanMode ? Number(config.turn_plan_ms) > 0 ? Number(config.turn_plan_ms) : DEFAULT_CONFIG.turn_plan_ms : Number(config.turn_default_ms) > 0 ? Number(config.turn_default_ms) : DEFAULT_CONFIG.turn_default_ms),
    onTurnStart: (info) => {
      const s = findSession(sessionDir, info.threadId) ?? initSession(sessionDir, info.threadId);
      logNdjson(s, "TURN_PARAMS", "turn/start", {
        model: info.turnParams.model,
        effort: info.turnParams.effort,
        collaborationMode: info.turnParams.collaborationMode,
        sandboxPolicy: info.turnParams.sandboxPolicy,
        hasOutputSchema: Boolean(info.turnParams.outputSchema),
        promptLength: info.promptLength,
        promptPreview: info.promptPreview
      });
    },
    onItemCompleted: (item, { threadId: itemThreadId }) => {
      const effectiveThreadId = itemThreadId ?? null;
      if (!effectiveThreadId) return;
      const s = findSession(sessionDir, effectiveThreadId) ?? initSession(sessionDir, effectiveThreadId);
      logNdjson(s, "ITEM_COMPLETED", "item/completed", {
        itemId: item?.id ?? null,
        itemType: item?.type ?? null,
        text: extractItemText(item)
      });
    },
    onServerRequest: createBridgeServerRequestHandler({
      sessionDir,
      config,
      questionAnswerMs: questionTimeoutOverride ?? null,
      cwd
    })
  };
  const resolvedSandboxMode = modeOverride === "default" ? "default" : "plan";
  turnOptions.sandboxPolicy = buildSandboxPolicy(resolvedSandboxMode, config);
  if (modeOverride) {
    turnOptions.collaborationMode = buildCollaborationMode(modeOverride, config, {
      effort: options.effort,
      developerInstructions: loadDeveloperInstructions(modeOverride)
    });
  }
  ensureCodexAvailable(cwd);
  const dispatch2 = await adapter2.resume(threadId, prompt, {
    cwd,
    sessionDir,
    model: config.model,
    effort: turnOptions.effort,
    mode: modeOverride ?? "default",
    adapterOptions: {
      turnOptions
    }
  });
  const result = dispatch2.rawResult ?? dispatch2;
  if (result.status !== 0) {
    const errLike = result.error ?? { message: `send failed on thread ${threadId} (status ${result.status}).` };
    const session2 = findSession(sessionDir, threadId) ?? initSession(sessionDir, threadId);
    const classified = classifyError(errLike);
    logEvent(session2, formatErrorEvent(session2, {
      errorCode: classified.code,
      message: classified.message,
      phase: classified.class,
      origin: "send",
      scriptPath: SCRIPT_PATH,
      cwd
    }));
    logNdjson(session2, "ERROR", "turn/completed", { error: classified });
    emitError(errLike, { json: options.json, command: "send" });
    return;
  }
  const session = findSession(sessionDir, threadId) ?? initSession(sessionDir, threadId);
  if (result.planDetected && result.planText) {
    const planPath = writePlan(session, result.planText);
    const steps = extractPlanSteps(result.planText);
    logEvent(session, formatPlanEvent(session, {
      turnId: result.turnId,
      planTitle: result.planText.split("\n")[0]?.slice(0, 80) ?? "Plan",
      steps,
      planPath,
      scriptPath: SCRIPT_PATH,
      cwd
    }));
    logNdjson(session, "PLAN", "item/completed", {
      turnId: result.turnId ?? null,
      planPath,
      planDetected: true
    });
    const eventsPath2 = session?.eventsPath ?? null;
    const renderedLines2 = [`Plan updated for ${threadId}.`];
    if (eventsPath2) renderedLines2.push(`  events: ${eventsPath2}`);
    emitSuccess(
      "send",
      {
        threadId,
        status: result.status,
        turnId: result.turnId ?? null,
        eventsPath: eventsPath2,
        phase: "plan-pending",
        planPath,
        planSteps: steps,
        finalMessage: result.finalMessage ?? null
      },
      `${renderedLines2.join("\n")}
`,
      { json: options.json, startedAt }
    );
    return;
  }
  logEvent(session, formatDoneEvent(session, {
    duration: Math.round((Date.now() - startedAt) / 1e3),
    diffStat: "send follow-up",
    files: [],
    config: {
      model: config.model,
      effort: turnOptions.effort,
      modeFlow: modeOverride ?? "resume"
    },
    diffPath: "not captured for send",
    scriptPath: SCRIPT_PATH,
    cwd
  }));
  logNdjson(session, "DONE", "turn/completed", {
    turnId: result.turnId ?? null,
    status: result.status
  });
  const eventsPath = session?.eventsPath ?? null;
  const renderedLines = [`Sent to ${threadId}. Status: ${result.status}`];
  if (eventsPath) renderedLines.push(`  events: ${eventsPath}`);
  const payload = {
    threadId,
    status: result.status,
    turnId: result.turnId ?? null,
    eventsPath,
    finalMessage: result.finalMessage ?? null
  };
  emitSuccess("send", payload, `${renderedLines.join("\n")}
`, {
    json: options.json,
    startedAt
  });
}
async function handleSteer(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "backend"],
    booleanOptions: ["json"]
  });
  const [rawThreadId, turnId, ...promptParts] = positionals;
  if (!rawThreadId || !turnId) {
    throw usageError("steer requires <thread-id> <turn-id> <prompt...>");
  }
  if (!isThreadId(rawThreadId)) {
    throw invalidThreadIdError(rawThreadId, "thread-id");
  }
  const threadId = rawThreadId.trim();
  const cwd = resolveCommandCwd(options);
  const prompt = resolvePromptInput(options, promptParts, cwd);
  if (!prompt) {
    throw validationError("steer requires a prompt", "MISSING_PROMPT");
  }
  const adapter2 = await resolveCommandAdapter({
    cwd,
    workspaceRoot: resolveWorkspaceRoot(cwd),
    backend: options.backend ?? null
  });
  ensureCodexRuntimeAdapter(adapter2);
  guardCapability(adapter2, "supports_steering");
  ensureCodexAvailable(cwd);
  await adapter2.steer(threadId, turnId, prompt, { cwd });
  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const session = findSession(sessionDir, threadId);
  if (session) {
    logNdjson(session, "STEER", "turn/steer", { turnId, prompt: prompt.slice(0, 120) });
  }
  emitSuccess("steer", { threadId, turnId, steered: true }, `Steered turn ${turnId} on thread ${threadId}
`, {
    json: options.json,
    startedAt
  });
}
async function handleRespond(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["question-id", "answer", "json-payload", "cwd", "backend"],
    booleanOptions: ["json"]
  });
  const requestId = positionals[0];
  if (!requestId) {
    throw usageError("respond requires <request-id>");
  }
  const cwd = resolveCommandCwd(options);
  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const adapter2 = await resolveCommandAdapter({
    cwd,
    workspaceRoot: resolveWorkspaceRoot(cwd),
    backend: options.backend ?? null
  });
  ensureCodexRuntimeAdapter(adapter2);
  guardCapability(adapter2, "supports_questions");
  const pending = readPendingRequestById(sessionDir, requestId);
  if (!pending) {
    throw notFoundError(
      `No pending request found: ${requestId}.`,
      "PENDING_REQUEST_NOT_FOUND",
      "It may have timed out or already been answered."
    );
  }
  let payload;
  if (options["json-payload"]) {
    try {
      payload = JSON.parse(options["json-payload"]);
    } catch (error) {
      throw usageError(
        `respond --json-payload must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    const answer = options.answer;
    if (!answer) {
      throw usageError("respond requires --answer");
    }
    if (pending.method === "item/tool/requestUserInput") {
      const qId = options["question-id"] ?? pending.firstQuestionId ?? "q1";
      payload = { answers: { [qId]: { answers: [answer] } } };
    } else {
      payload = { decision: answer };
    }
  }
  await adapter2.respond(pending.threadId, requestId, payload, { sessionDir });
  const session = findSession(sessionDir, pending.threadId);
  if (session) {
    logNdjson(session, "SERVER_RESPONSE", null, { requestId, payload });
  }
  emitSuccess(
    "respond",
    { status: "responded", requestId, threadId: pending.threadId },
    `Response written for ${requestId}. Worker will deliver it.
`,
    { json: options.json, startedAt }
  );
}
async function handleSummary(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["tail", "cwd"],
    booleanOptions: ["json"]
  });
  const threadId = positionals[0];
  if (!threadId) {
    throw usageError("summary requires <thread-id>");
  }
  const cwd = resolveCommandCwd(options);
  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const session = findSession(sessionDir, threadId);
  if (!session) {
    throw notFoundError(
      `No session found for thread ${threadId}`,
      "SESSION_NOT_FOUND"
    );
  }
  const tailLines = parseInt(options.tail) || 200;
  let content;
  try {
    content = fs17.readFileSync(session.ndjsonPath, "utf8");
  } catch {
    throw new CliError(
      `Cannot read session log: ${session.ndjsonPath}`,
      { class: "internal", code: "SESSION_LOG_UNREADABLE", retryable: false }
    );
  }
  const allLines = content.split("\n").filter(Boolean);
  const lines = allLines.slice(-tailLines);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
    }
  }
  const transcript = buildTranscript(entries, threadId);
  emitSuccess("summary", { threadId, entries }, `${transcript}
`, {
    json: options.json,
    startedAt
  });
}
function buildTranscript(entries, threadId) {
  const lines = [`## Thread ${threadId}`];
  let currentTurnId = null;
  let turnIndex = 0;
  for (const entry of entries) {
    if (entry.tag === "TURN_STARTED" || entry.method === "turn/started" && entry.data?.turn?.id) {
      turnIndex += 1;
      currentTurnId = entry.data?.turn?.id ?? entry.data?.turnId ?? `turn-${turnIndex}`;
      const ts = entry.ts ? entry.ts.slice(11, 19) : "";
      lines.push("", `### Turn ${turnIndex} \u2014 ${ts}`);
      continue;
    }
    if (entry.method === "item/completed") {
      const item = entry.data?.item ?? entry.data ?? {};
      if (item.type === "userMessage") {
        const text = item.content?.map((c) => c.text).join(" ") ?? "";
        lines.push(`> ${text}`);
      } else if (item.type === "agentMessage") {
        lines.push("", `**Assistant:** ${item.text ?? ""}`);
      } else if (item.type === "plan") {
        lines.push("", `**Plan proposed:**`, item.text ?? "");
      } else if (item.type === "commandExecution") {
        const cmd = (item.command ?? "").slice(0, 200);
        lines.push(`tool: shell ${cmd}`);
      } else if (item.type === "fileChange") {
        const files = (item.changes ?? []).map((c) => c.path).join(", ");
        lines.push(`tool: apply_patch ${files.slice(0, 200)}`);
      } else if (item.type === "exitedReviewMode") {
        lines.push("", `**Review:** ${item.review ?? ""}`);
      }
      continue;
    }
    if (entry.tag === "ERROR") {
      lines.push("", `**Error:** ${entry.data?.message ?? JSON.stringify(entry.data)}`);
    }
  }
  return lines.join("\n");
}
var SUBCOMMAND_DISPATCH = Object.freeze({
  setup: handleSetup,
  version: handleVersion,
  update: handleUpdate,
  config: handleConfigShow,
  "auth-status": handleAuthStatus,
  review: handleReview,
  "adversarial-review": (argv) => handleReviewCommand(argv, { reviewName: "Adversarial Review" }),
  task: handleTask,
  "task-worker": handleTaskWorker,
  send: handleSend,
  steer: handleSteer,
  respond: handleRespond,
  summary: handleSummary,
  status: handleStatus,
  result: handleResult,
  wait: handleWait,
  events: handleEvents,
  "task-resume-candidate": handleTaskResumeCandidate,
  cancel: handleCancel,
  "await-artifact": handleAwaitArtifact,
  merge: handleMerge,
  verdict: handleVerdict,
  verdicts: handleVerdictsPending,
  iterate: handleIterate
});
process10.on("SIGPIPE", () => {
});
process10.stdout.on("error", (err) => {
  if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) return;
  throw err;
});
process10.stderr.on("error", (err) => {
  if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) return;
  throw err;
});
function writeCrashLog(kind, error) {
  try {
    const crashDir = path15.join(os8.homedir(), ".codex-bridge", "crashes");
    fs17.mkdirSync(crashDir, { recursive: true });
    const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    const file = path15.join(crashDir, `${ts}-${process10.pid}.log`);
    const payload = {
      kind,
      ts,
      pid: process10.pid,
      argv: process10.argv,
      cwd: process10.cwd(),
      nodeVersion: process10.version,
      bridgeVersion: package_default.version,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack, code: error.code } : { raw: String(error) }
    };
    fs17.writeFileSync(file, JSON.stringify(payload, null, 2));
    try {
      process10.stderr.write(
        `[codex-bridge] internal ${kind}: ${error?.message ?? error} \u2014 crash report at ${file}
`
      );
    } catch {
    }
  } catch {
  }
}
process10.on("unhandledRejection", (reason) => {
  writeCrashLog("unhandledRejection", reason);
  process10.exitCode = process10.exitCode || 1;
});
process10.on("uncaughtException", (err) => {
  writeCrashLog("uncaughtException", err);
  process10.exit(process10.exitCode || 1);
});
async function main() {
  const startedAt = Date.now();
  const rawArgv = process10.argv.slice(2);
  const [subcommand, ...argv] = rawArgv;
  maybeTriggerAutoApply(rawArgv, subcommand);
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    if (detectJsonFlag(rawArgv)) {
      emitSuccess("help", buildMachineReadableHelp(), null, { json: true, startedAt });
      return;
    }
    printUsage();
    return;
  }
  if (COMMANDS[subcommand] && detectHelpFlag(rawArgv)) {
    printSubcommandUsage(subcommand);
    return;
  }
  const handler = SUBCOMMAND_DISPATCH[subcommand];
  if (!handler) {
    throw new CliError(`Unknown subcommand: ${subcommand}`, {
      class: "usage",
      code: "UNKNOWN_SUBCOMMAND",
      retryable: false,
      suggestion: "Run `help --json` to list available subcommands."
    });
  }
  await handler(argv);
}
main().catch((error) => {
  const rawArgv = process10.argv.slice(2);
  const json2 = detectJsonFlag(rawArgv);
  const command = rawArgv[0] && COMMANDS[rawArgv[0]] ? rawArgv[0] : null;
  emitError(error, { json: json2, command });
});
/*! Bundled license information:

js-yaml/dist/js-yaml.mjs:
  (*! js-yaml 4.1.1 https://github.com/nodeca/js-yaml @license MIT *)
*/
