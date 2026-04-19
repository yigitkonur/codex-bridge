// src/codex-bridge.mjs
import { spawn as spawn3 } from "node:child_process";
import fs13 from "node:fs";
import path11 from "node:path";
import process8 from "node:process";
import { fileURLToPath as fileURLToPath2 } from "node:url";

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
      exitCode: CLASS_TO_EXIT[err.class] ?? ExitCode.CRASH
    };
  }
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
  return {
    class: "internal",
    code: "INTERNAL_ERROR",
    message,
    retryable: false,
    exitCode: ExitCode.CRASH
  };
}
function buildErrorEnvelope(classified, { command } = {}) {
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
  if (json2) {
    const envelope = buildErrorEnvelope(classified, { command });
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
function detectJsonFlag(argv) {
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg === "--json" || arg === "--json=true" || arg === "-j") return true;
    if (arg === "--json=false") return false;
  }
  return false;
}
function detectHelpFlag(argv) {
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg === "--help" || arg === "-h" || arg === "--help=true") return true;
  }
  return false;
}

// src/lib/args.mjs
var ALWAYS_BOOLEAN = /* @__PURE__ */ new Set(["help", "h"]);
var ALWAYS_ALIASES = Object.freeze({ h: "help", j: "json" });
function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = /* @__PURE__ */ new Set([...config.booleanOptions ?? [], ...ALWAYS_BOOLEAN]);
  const aliasMap = { ...ALWAYS_ALIASES, ...config.aliasMap ?? {} };
  const strict = config.strict !== false;
  const options = {};
  const positionals = [];
  let passthrough = false;
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
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
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
        options[key2] = nextValue;
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
      options[key] = nextValue;
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

// src/lib/thread-id.mjs
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isThreadId(value) {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

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

// src/lib/app-server.mjs
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
import fs4 from "node:fs";
import net from "node:net";
import os2 from "node:os";
import path4 from "node:path";
import process5 from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// src/lib/state.mjs
import { createHash } from "node:crypto";
import fs3 from "node:fs";
import os from "node:os";
import path3 from "node:path";

// src/lib/git.mjs
import fs2 from "node:fs";
import path2 from "node:path";

// src/lib/process.mjs
import { spawnSync } from "node:child_process";
import process4 from "node:process";
function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: process4.platform === "win32" ? process4.env.SHELL || true : false,
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

// src/lib/git.mjs
var MAX_UNTRACKED_BYTES = 24 * 1024;
var DEFAULT_INLINE_DIFF_MAX_FILES = 2;
var DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
function git(cwd2, args, options = {}) {
  return runCommand("git", args, { cwd: cwd2, ...options });
}
function gitChecked(cwd2, args, options = {}) {
  return runCommandChecked("git", args, { cwd: cwd2, ...options });
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
function measureGitOutputBytes(cwd2, args, maxBytes) {
  const result = git(cwd2, args, { maxBuffer: maxBytes + 1 });
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
function measureCombinedGitOutputBytes(cwd2, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd2, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}
function buildBranchComparison(cwd2, baseRef) {
  const mergeBase = gitChecked(cwd2, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}
function ensureGitRepository(cwd2) {
  const result = git(cwd2, ["rev-parse", "--show-toplevel"]);
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
function getRepoRoot(cwd2) {
  return gitChecked(cwd2, ["rev-parse", "--show-toplevel"]).stdout.trim();
}
function detectDefaultBranch(cwd2) {
  const symbolic = git(cwd2, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      const candidate = remoteHead.replace("refs/remotes/origin/", "");
      const localCheck = git(cwd2, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
      if (localCheck.status === 0) {
        return candidate;
      }
      return `origin/${candidate}`;
    }
  }
  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd2, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd2, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
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
function getCurrentBranch(cwd2) {
  return gitChecked(cwd2, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}
function getWorkingTreeState(cwd2) {
  const staged = gitChecked(cwd2, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd2, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd2, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);
  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}
function resolveReviewTarget(cwd2, options = {}) {
  ensureGitRepository(cwd2);
  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd2);
  const supportedScopes = /* @__PURE__ */ new Set(["auto", "working-tree", "branch"]);
  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
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
    const detectedBase2 = detectDefaultBranch(cwd2);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase2}`,
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
  const detectedBase = detectDefaultBranch(cwd2);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}
function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}
function formatUntrackedFile(cwd2, relativePath) {
  const absolutePath = path2.join(cwd2, relativePath);
  let stat;
  try {
    stat = fs2.statSync(absolutePath);
  } catch {
    return `### ${relativePath}
(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}
(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}
(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }
  let buffer;
  try {
    buffer = fs2.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}
(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}
(skipped: binary file)`;
  }
  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}
function collectWorkingTreeContext(cwd2, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd2, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);
  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd2, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd2, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd2, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd2, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd2, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd2, file)).join("\n\n");
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
function collectBranchContext(cwd2, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd2, baseRef);
  const currentBranch = getCurrentBranch(cwd2);
  const changedFiles = gitChecked(cwd2, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd2, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd2, ["diff", "--stat", comparison.commitRange]).stdout.trim();
  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff ? [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection(
        "Branch Diff",
        gitChecked(cwd2, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
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
function collectReviewContext(cwd2, target, options = {}) {
  const repoRoot = getRepoRoot(cwd2);
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

// src/lib/workspace.mjs
function resolveWorkspaceRoot(cwd2) {
  try {
    return ensureGitRepository(cwd2);
  } catch {
    return cwd2;
  }
}

// src/lib/state.mjs
var STATE_VERSION = 1;
var PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
var FALLBACK_STATE_ROOT_DIR = path3.join(os.tmpdir(), "codex-companion");
var STATE_FILE_NAME = "state.json";
var JOBS_DIR_NAME = "jobs";
var MAX_JOBS = 50;
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
function resolveStateDir(cwd2) {
  const workspaceRoot = resolveWorkspaceRoot(cwd2);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs3.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }
  const slugSource = path3.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path3.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path3.join(stateRoot, `${slug}-${hash}`);
}
function resolveStateFile(cwd2) {
  return path3.join(resolveStateDir(cwd2), STATE_FILE_NAME);
}
function resolveJobsDir(cwd2) {
  return path3.join(resolveStateDir(cwd2), JOBS_DIR_NAME);
}
function ensureStateDir(cwd2) {
  fs3.mkdirSync(resolveJobsDir(cwd2), { recursive: true });
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
function loadState(cwd2) {
  const stateFile = resolveStateFile(cwd2);
  if (!fs3.existsSync(stateFile)) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(fs3.readFileSync(stateFile, "utf8"));
    const rawJobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    const { jobs, reaped } = reapOrphans(rawJobs);
    const state = {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...parsed.config ?? {}
      },
      jobs
    };
    if (reaped > 0) {
      try {
        fs3.writeFileSync(stateFile, `${JSON.stringify({
          version: parsed.version ?? STATE_VERSION,
          config: state.config,
          jobs: state.jobs
        }, null, 2)}
`, "utf8");
      } catch {
      }
    }
    return state;
  } catch {
    return defaultState();
  }
}
function pruneJobs(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))).slice(0, MAX_JOBS);
}
function removeFileIfExists(filePath) {
  if (filePath && fs3.existsSync(filePath)) {
    fs3.unlinkSync(filePath);
  }
}
function saveState(cwd2, state) {
  const previousJobs = loadState(cwd2).jobs;
  ensureStateDir(cwd2);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...state.config ?? {}
    },
    jobs: nextJobs
  };
  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd2, job.id));
    removeFileIfExists(job.logFile);
  }
  fs3.writeFileSync(resolveStateFile(cwd2), `${JSON.stringify(nextState, null, 2)}
`, "utf8");
  return nextState;
}
function updateState(cwd2, mutate) {
  const state = loadState(cwd2);
  mutate(state);
  return saveState(cwd2, state);
}
function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}
function upsertJob(cwd2, jobPatch) {
  return updateState(cwd2, (state) => {
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
function listJobs(cwd2) {
  return loadState(cwd2).jobs;
}
function setConfig(cwd2, key, value) {
  return updateState(cwd2, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}
function getConfig(cwd2) {
  return loadState(cwd2).config;
}
function writeJobFile(cwd2, jobId, payload) {
  ensureStateDir(cwd2);
  const jobFile = resolveJobFile(cwd2, jobId);
  fs3.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}
`, "utf8");
  return jobFile;
}
function readJobFile(jobFile) {
  return JSON.parse(fs3.readFileSync(jobFile, "utf8"));
}
function removeJobFile(jobFile) {
  if (fs3.existsSync(jobFile)) {
    fs3.unlinkSync(jobFile);
  }
}
function resolveJobLogFile(cwd2, jobId) {
  ensureStateDir(cwd2);
  return path3.join(resolveJobsDir(cwd2), `${jobId}.log`);
}
function resolveJobFile(cwd2, jobId) {
  ensureStateDir(cwd2);
  return path3.join(resolveJobsDir(cwd2), `${jobId}.json`);
}

// src/lib/broker-lifecycle.mjs
var BROKER_STATE_FILE = "broker.json";
function createBrokerSessionDir(prefix = "cxc-") {
  return fs4.mkdtempSync(path4.join(os2.tmpdir(), prefix));
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
function spawnBrokerProcess({ scriptPath, cwd: cwd2, endpoint, pidFile, logFile, env = process5.env }) {
  const logFd = fs4.openSync(logFile, "a");
  const child = spawn(process5.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd2, "--pid-file", pidFile], {
    cwd: cwd2,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs4.closeSync(logFd);
  return child;
}
function resolveBrokerStateFile(cwd2) {
  return path4.join(resolveStateDir(cwd2), BROKER_STATE_FILE);
}
function loadBrokerSession(cwd2) {
  const stateFile = resolveBrokerStateFile(cwd2);
  if (!fs4.existsSync(stateFile)) {
    return null;
  }
  try {
    return JSON.parse(fs4.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}
function saveBrokerSession(cwd2, session) {
  const stateDir = resolveStateDir(cwd2);
  fs4.mkdirSync(stateDir, { recursive: true });
  fs4.writeFileSync(resolveBrokerStateFile(cwd2), `${JSON.stringify(session, null, 2)}
`, "utf8");
}
function clearBrokerSession(cwd2) {
  const stateFile = resolveBrokerStateFile(cwd2);
  if (fs4.existsSync(stateFile)) {
    fs4.unlinkSync(stateFile);
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
async function ensureBrokerSession(cwd2, options = {}) {
  const existing = loadBrokerSession(cwd2);
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
    clearBrokerSession(cwd2);
  }
  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path4.join(sessionDir, "broker.pid");
  const logFile = path4.join(sessionDir, "broker.log");
  const scriptPath = options.scriptPath ?? fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));
  const child = spawnBrokerProcess({
    scriptPath,
    cwd: cwd2,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process5.env
  });
  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2e3);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    return null;
  }
  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null
  };
  saveBrokerSession(cwd2, session);
  return session;
}
function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
    }
  }
  if (pidFile && fs4.existsSync(pidFile)) {
    fs4.unlinkSync(pidFile);
  }
  if (logFile && fs4.existsSync(logFile)) {
    fs4.unlinkSync(logFile);
  }
  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs4.existsSync(target.path)) {
        fs4.unlinkSync(target.path);
      }
    } catch {
    }
  }
  const resolvedSessionDir = sessionDir ?? (pidFile ? path4.dirname(pidFile) : logFile ? path4.dirname(logFile) : null);
  if (resolvedSessionDir && fs4.existsSync(resolvedSessionDir)) {
    try {
      fs4.rmdirSync(resolvedSessionDir);
    } catch {
    }
  }
}

// src/lib/app-server.mjs
var BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
var BROKER_BUSY_RPC_CODE = -32001;
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
var AppServerClientBase = class {
  constructor(cwd2, options = {}) {
    this.cwd = cwd2;
    this.options = options;
    this.pending = /* @__PURE__ */ new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }
  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }
  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params) {
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ id, method, params });
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
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
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
    const params = message.params ?? {};
    if (method === "item/tool/requestUserInput") {
      if (this.serverRequestHandler) {
        message._client = this;
        this.serverRequestHandler(message);
      } else {
        this.sendMessage({ id: message.id, result: { answers: {} } });
      }
      return;
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      this.sendMessage({ id: message.id, result: { decision: "accept" } });
      return;
    }
    if (method === "item/permissions/requestApproval") {
      const permissions = params.permissions ?? {};
      this.sendMessage({ id: message.id, result: { permissions, scope: "session" } });
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      this.sendMessage({ id: message.id, result: { action: "accept", content: null } });
      return;
    }
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${method}`)
    });
  }
  setServerRequestHandler(handler) {
    this.serverRequestHandler = handler;
  }
  handleExit(error) {
    if (this.exitResolved) {
      return;
    }
    this.exitResolved = true;
    this.exitError = error ?? null;
    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(void 0);
  }
  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
};
var SpawnedCodexAppServerClient = class extends AppServerClientBase {
  constructor(cwd2, options = {}) {
    super(cwd2, options);
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
    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }
  async close() {
    if (this.closed) {
      await this.exitPromise;
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
    await this.exitPromise;
  }
  sendMessage(message) {
    const line = `${JSON.stringify(message)}
`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
};
var BrokerCodexAppServerClient = class extends AppServerClientBase {
  constructor(cwd2, options = {}) {
    super(cwd2, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }
  async initialize() {
    await new Promise((resolve, reject) => {
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
    });
    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }
  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }
    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }
  sendMessage(message) {
    const line = `${JSON.stringify(message)}
`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
};
var CodexAppServerClient = class {
  static async connect(cwd2, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process6.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd2)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd2, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint ? new BrokerCodexAppServerClient(cwd2, { ...options, brokerEndpoint }) : new SpawnedCodexAppServerClient(cwd2, options);
    await client.initialize();
    return client;
  }
};

// src/lib/codex.mjs
var SERVICE_NAME = "claude_code_codex_plugin";
var TASK_THREAD_PREFIX = "Codex Companion Task";
var DEFAULT_CONTINUE_PROMPT = "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
function cleanCodexStderr(stderr) {
  return stderr.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:")).join("\n");
}
function buildThreadParams(cwd2, options = {}) {
  return {
    cwd: cwd2,
    model: options.model ?? null,
    approvalPolicy: "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? false,
    experimentalRawEvents: false
  };
}
function buildResumeParams(threadId, cwd2, options = {}) {
  return {
    threadId,
    cwd: cwd2,
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
    pendingCollaborations: /* @__PURE__ */ new Set(),
    activeSubagentTurns: /* @__PURE__ */ new Set(),
    completionTimer: null,
    lastAgentMessage: "",
    reviewText: "",
    planDetected: false,
    planText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
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
async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;
  const idleTimeoutMs = Number(options.idleTimeoutMs) > 0 ? Number(options.idleTimeoutMs) : 0;
  let lastNotificationAt = Date.now();
  let idleInterval = null;
  if (idleTimeoutMs > 0) {
    const checkIntervalMs = Math.min(5e3, idleTimeoutMs);
    idleInterval = setInterval(() => {
      if (state.completed) {
        return;
      }
      const elapsed = Date.now() - lastNotificationAt;
      if (elapsed >= idleTimeoutMs) {
        clearInterval(idleInterval);
        idleInterval = null;
        const seconds = Math.round(idleTimeoutMs / 1e3);
        state.error = { message: `No events received for ${seconds}s (possible stuck)` };
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
  client.setNotificationHandler((message) => {
    lastNotificationAt = Date.now();
    if (!state.turnId) {
      state.bufferedNotifications.push(message);
      return;
    }
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
  });
  const onExit = () => {
    if (!state.completed) {
      state.error = { message: "Codex app-server exited unexpectedly" };
      completeTurn(state, null, { inferredStatus: "failed" });
    }
  };
  if (client.on) client.on("exit", onExit);
  try {
    const response = await startRequest();
    lastNotificationAt = Date.now();
    options.onResponse?.(response, state);
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
    }
    for (const message of state.bufferedNotifications) {
      if (belongsToTurn(state, message)) {
        applyTurnNotification(state, message);
      } else {
        if (previousHandler) {
          previousHandler(message);
        }
      }
    }
    state.bufferedNotifications.length = 0;
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
    client.setNotificationHandler(previousHandler ?? null);
    if (client.off) client.off("exit", onExit);
    else if (client.removeListener) client.removeListener("exit", onExit);
  }
}
async function withAppServer(cwd2, fn) {
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd2);
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
    const directClient = await CodexAppServerClient.connect(cwd2, { disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}
async function startThread(client, cwd2, options = {}) {
  const response = await client.request("thread/start", buildThreadParams(cwd2, options));
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
async function resumeThread(client, threadId, cwd2, options = {}) {
  return client.request("thread/resume", buildResumeParams(threadId, cwd2, options));
}
function buildResultStatus(turnState) {
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
async function getCodexAuthStatusFromClient(client, cwd2) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd: cwd2
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
function getCodexAvailability(cwd2) {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd: cwd2 });
  if (!versionStatus.available) {
    return versionStatus;
  }
  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd: cwd2 });
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
function getSessionRuntimeStatus(env = process.env, cwd2 = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd2)?.endpoint ?? null;
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
async function getCodexAuthStatus(cwd2, options = {}) {
  const availability = getCodexAvailability(cwd2);
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
    client = await CodexAppServerClient.connect(cwd2, {
      env: options.env,
      reuseExistingBroker: true
    });
    return await getCodexAuthStatusFromClient(client, cwd2);
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
async function interruptAppServerTurn(cwd2, { threadId, turnId }) {
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }
  const availability = getCodexAvailability(cwd2);
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
    client = await CodexAppServerClient.connect(cwd2, { reuseExistingBroker: true });
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
async function runAppServerReview(cwd2, options = {}) {
  const availability = getCodexAvailability(cwd2);
  if (!availability.available) {
    throw new CliError("Codex CLI is not installed or is missing required runtime support.", {
      class: "dependency_failed",
      code: "CODEX_UNAVAILABLE",
      retryable: false,
      suggestion: "Install Codex with `npm install -g @openai/codex`, then rerun `codex-bridge setup`."
    });
  }
  return withAppServer(cwd2, async (client) => {
    emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
    const thread = await startThread(client, cwd2, {
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
      () => client.request("review/start", {
        threadId: sourceThreadId,
        delivery,
        target: options.target
      }),
      {
        onProgress: options.onProgress,
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
async function runAppServerTurn(cwd2, options = {}) {
  const availability = getCodexAvailability(cwd2);
  if (!availability.available) {
    throw new CliError("Codex CLI is not installed or is missing required runtime support.", {
      class: "dependency_failed",
      code: "CODEX_UNAVAILABLE",
      retryable: false,
      suggestion: "Install Codex with `npm install -g @openai/codex`, then rerun `codex-bridge setup`."
    });
  }
  return withAppServer(cwd2, async (client) => {
    let threadId;
    if (options.onServerRequest) {
      client.setServerRequestHandler(options.onServerRequest);
    }
    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      const response = await resumeThread(client, options.resumeThreadId, cwd2, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: false
      });
      threadId = response.thread.id;
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      const response = await startThread(client, cwd2, {
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
      } catch {
      }
    }
    const turnPromise = captureTurn(
      client,
      threadId,
      () => client.request("turn/start", turnParams),
      {
        onProgress: options.onProgress,
        idleTimeoutMs: options.idleTimeoutMs ?? null,
        onIdleTimeout: options.onIdleTimeout ?? null,
        onItemCompleted: options.onItemCompleted ?? null
      }
    );
    let turnState;
    if (options.turnTimeoutMs && options.turnTimeoutMs > 0) {
      turnState = await Promise.race([
        turnPromise,
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error(`Turn timed out after ${options.turnTimeoutMs}ms`)), options.turnTimeoutMs);
          if (t.unref) t.unref();
        })
      ]);
    } else {
      turnState = await turnPromise;
    }
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
async function findLatestTaskThread(cwd2) {
  const availability = getCodexAvailability(cwd2);
  if (!availability.available) {
    throw new CliError("Codex CLI is not installed or is missing required runtime support.", {
      class: "dependency_failed",
      code: "CODEX_UNAVAILABLE",
      retryable: false,
      suggestion: "Install Codex with `npm install -g @openai/codex`, then rerun `codex-bridge setup`."
    });
  }
  return withAppServer(cwd2, async (client) => {
    const response = await client.request("thread/list", {
      cwd: cwd2,
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

// src/lib/prompts.mjs
import fs5 from "node:fs";
import path5 from "node:path";
function loadPromptTemplate(rootDir, name) {
  const promptPath = path5.join(rootDir, "prompts", `${name}.md`);
  return fs5.readFileSync(promptPath, "utf8");
}
function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : "";
  });
}

// src/lib/job-control.mjs
import fs7 from "node:fs";

// src/lib/tracked-jobs.mjs
import fs6 from "node:fs";
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
  fs6.appendFileSync(logFile, `[${nowIso2()}] ${normalized}
`, "utf8");
}
function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs6.appendFileSync(logFile, `
[${nowIso2()}] ${title}
${String(body).trimEnd()}
`, "utf8");
}
function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs6.writeFileSync(logFile, "", "utf8");
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
    if (!fs6.existsSync(jobFile)) {
      return;
    }
    const storedJob = readJobFile(jobFile);
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
  if (!fs6.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
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
function sortJobsNewestFirst(jobs) {
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
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
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
  if (!logFile || !fs7.existsSync(logFile)) {
    return [];
  }
  const lines = fs7.readFileSync(logFile, "utf8").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).filter((line) => line.startsWith("[")).map(stripLogPrefix).filter((line) => line && !isProgressBlockTitle(line));
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
  if (!fs7.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
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
function buildStatusSnapshot(cwd2, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd2);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
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
function buildSingleJobSnapshot(cwd2, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd2);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
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
function resolveResultJob(cwd2, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd2);
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  if (reference) {
    const activeMatch = jobs.find(
      (job) => (job.status === "queued" || job.status === "running") && (job.id === reference || job.id.startsWith(reference))
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
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
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
function resolveCancelableJob(cwd2, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd2);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
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
    `- session runtime: ${report.sessionRuntime.label}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    ""
  ];
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
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
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
    lines.push("Ending the session will trigger a fresh Codex adversarial review and block if it finds issues.");
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

// src/lib/config.mjs
import fs8 from "node:fs";
import path6 from "node:path";
import os3 from "node:os";

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

// src/lib/config.mjs
var DEFAULT_CONFIG = {
  mode: "plan",
  model: "gpt-5.4",
  effort: "high",
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
  // When true, prepend a strong orchestrator directive telling Codex to skip
  // its internal planning/ceremony skills (using-superpowers, brainstorming,
  // writing-plans, using-git-worktrees). Codex's default skill chain routinely
  // spends ~10 minutes writing docs/superpowers/specs/*.md and plans/*.md
  // files that are not part of the deliverable when the bridge is already
  // orchestrating the task. Advisory — Codex may ignore the directive.
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
  prompt_footer: "When you need to ask a question to user, always use the request_user_input tool with distinct options to help the user navigate choices. Never ask questions as plain text messages."
};
function loadConfig(skillDir, overrideDir = null, workspaceRoot = null) {
  const readYaml = (p) => {
    try {
      const raw = fs8.readFileSync(p, "utf8");
      const doc = jsYaml.load(raw) ?? {};
      const bridge = doc.codex_bridge ?? doc;
      return typeof bridge === "object" && bridge !== null ? bridge : {};
    } catch {
      return {};
    }
  };
  const skillConfigPath = skillDir ? path6.join(skillDir, "config.yaml") : path6.join(os3.homedir(), ".codex-bridge", "config.yaml");
  const skillLayer = readYaml(skillConfigPath);
  const workspaceConfigPath = workspaceRoot && workspaceRoot !== overrideDir ? path6.join(workspaceRoot, "config.yaml") : null;
  const workspaceLayer = workspaceConfigPath && fs8.existsSync(workspaceConfigPath) ? readYaml(workspaceConfigPath) : {};
  const overrideConfigPath = overrideDir ? path6.join(overrideDir, "config.yaml") : null;
  const overrideLayer = overrideConfigPath && fs8.existsSync(overrideConfigPath) ? readYaml(overrideConfigPath) : {};
  return {
    ...DEFAULT_CONFIG,
    ...skillLayer,
    ...workspaceLayer,
    ...overrideLayer
  };
}
function resolveConfigSources(skillDir, overrideDir = null, workspaceRoot = null) {
  const skillConfigPath = skillDir ? path6.join(skillDir, "config.yaml") : path6.join(os3.homedir(), ".codex-bridge", "config.yaml");
  const workspaceConfigPath = workspaceRoot && workspaceRoot !== overrideDir ? path6.join(workspaceRoot, "config.yaml") : null;
  const overrideConfigPath = overrideDir ? path6.join(overrideDir, "config.yaml") : null;
  return {
    skillConfigPath,
    skillConfigExists: fs8.existsSync(skillConfigPath),
    workspaceConfigPath,
    workspaceConfigExists: workspaceConfigPath ? fs8.existsSync(workspaceConfigPath) : false,
    overrideConfigPath,
    overrideConfigExists: overrideConfigPath ? fs8.existsSync(overrideConfigPath) : false
  };
}
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

// src/lib/session-log.mjs
import fs9 from "node:fs";
import path7 from "node:path";
import os4 from "node:os";
import { spawnSync as spawnSync2 } from "node:child_process";
function resolveSessionDir(configDir) {
  const dir = (configDir ?? "~/.codex-bridge/sessions").replace(/^~/, os4.homedir());
  fs9.mkdirSync(dir, { recursive: true });
  return dir;
}
function initSession(sessionDir, threadId) {
  fs9.mkdirSync(sessionDir, { recursive: true });
  const ndjsonPath = path7.join(sessionDir, `${threadId}.ndjson`);
  const eventsPath = path7.join(sessionDir, `${threadId}.events`);
  fs9.writeFileSync(ndjsonPath, "", { flag: "a" });
  fs9.writeFileSync(eventsPath, "", { flag: "a" });
  return { ndjsonPath, eventsPath, sessionDir, threadId };
}
function findSession(sessionDir, threadId) {
  const ndjsonPath = path7.join(sessionDir, `${threadId}.ndjson`);
  const eventsPath = path7.join(sessionDir, `${threadId}.events`);
  if (!fs9.existsSync(ndjsonPath)) {
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
    fs9.appendFileSync(session.ndjsonPath, JSON.stringify(entry) + "\n");
  } catch {
  }
}
function logEvent(session, formattedBlock) {
  try {
    fs9.appendFileSync(session.eventsPath, formattedBlock + "\n");
  } catch {
  }
}
function writeDiff(session, diffContent) {
  const diffPath = path7.join(session.sessionDir, `${session.threadId}.diff`);
  try {
    fs9.writeFileSync(diffPath, diffContent);
  } catch {
  }
  return diffPath;
}
function writePlan(session, planText) {
  const planPath = path7.join(session.sessionDir, `${session.threadId}.plan.md`);
  try {
    fs9.writeFileSync(planPath, planText);
  } catch {
  }
  return planPath;
}
function writeReview(session, reviewData) {
  const reviewPath = path7.join(session.sessionDir, `${session.threadId}.review.json`);
  try {
    fs9.writeFileSync(reviewPath, JSON.stringify(reviewData, null, 2));
  } catch {
  }
  return reviewPath;
}
function captureGitDiff(cwd2, session) {
  const numstatResult = spawnSync2("git", ["diff", "--numstat", "HEAD"], { cwd: cwd2, encoding: "utf8", timeout: 1e4 });
  const fullResult = spawnSync2("git", ["diff", "HEAD"], { cwd: cwd2, encoding: "utf8", timeout: 1e4 });
  const diffContent = fullResult.stdout || "";
  const diffPath = writeDiff(session, diffContent);
  const numstatOutput = numstatResult.stdout || "";
  const files = parseGitNumstat(numstatOutput);
  const summary = summarizeNumstat(files);
  return { diffStat: summary, files: files.map(formatFileStat), diffPath };
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
function formatFileStat({ fileName, adds, dels }) {
  const prefix = fileName.includes("=>") ? "R" : "M";
  return `${prefix} ${fileName} (+${adds} -${dels})`;
}
function summarizeNumstat(files) {
  const totalAdds = files.reduce((sum, f) => sum + f.adds, 0);
  const totalDels = files.reduce((sum, f) => sum + f.dels, 0);
  return `${files.length} files | +${totalAdds} -${totalDels}`;
}
function resultActionLine(scriptPath, jobId, indent = "    detail: ") {
  return jobId ? `${indent}node ${scriptPath} result ${jobId}` : `${indent}node ${scriptPath} result    # rerun with the specific job id from status`;
}
function cancelActionLine(scriptPath, jobId, indent = "    cancel: ") {
  return jobId ? `${indent}node ${scriptPath} cancel ${jobId}` : `${indent}node ${scriptPath} cancel    # rerun with the specific job id from status`;
}
function formatDoneEvent(session, { duration, diffStat, files, config, diffPath, scriptPath, jobId = null }) {
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
  lines.push(`    review: node ${scriptPath} review --scope working-tree`);
  lines.push(`    revise: node ${scriptPath} send ${session.threadId} "<message>"`);
  lines.push(resultActionLine(scriptPath, jobId));
  return lines.join("\n");
}
function formatErrorEvent(session, { errorCode, message, phase, origin = "turn", scriptPath, jobId = null }) {
  const lines = [
    `[ERROR] ${session.threadId} failed | ${errorCode}`,
    `  ${message}`,
    `  origin: ${origin}`,
    `  phase: ${phase || "unknown"}`,
    "  actions:",
    `    retry: node ${scriptPath} send ${session.threadId} "<revised prompt>"`,
    resultActionLine(scriptPath, jobId, "    log:   "),
    cancelActionLine(scriptPath, jobId)
  ];
  return lines.join("\n");
}
function formatIncompleteEvent(session, { diffStat, diffPath, verdict, findingCount, missingItems, scriptPath, jobId = null }) {
  const lines = [
    `[INCOMPLETE] ${session.threadId} | ${diffStat}`,
    `  diff: ${diffPath}`,
    `  review: ${verdict} (${findingCount} findings)`
  ];
  if (missingItems && missingItems.length > 0) {
    lines.push("  missing:");
    for (const item of missingItems) {
      lines.push(`    - ${item}`);
    }
  }
  lines.push("  actions:");
  lines.push(`    fix:  node ${scriptPath} send ${session.threadId} "Complete the missing items"`);
  lines.push(`    new:  node ${scriptPath} task --write "..."`);
  lines.push(resultActionLine(scriptPath, jobId));
  return lines.join("\n");
}
function formatQuestionEvent(session, { requestId, questions, scriptPath }) {
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
        lines.push(`  node ${scriptPath} respond ${requestId} --question-id ${q.id} --answer "${opt.label}"`);
      }
    } else {
      lines.push(`  node ${scriptPath} respond ${requestId} --question-id ${q.id} --answer "<answer>"`);
    }
  }
  return lines.join("\n");
}
function formatPlanEvent(session, { turnId, planTitle, steps, planPath, scriptPath }) {
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
  lines.push(`  approve: node ${scriptPath} send ${session.threadId} --mode default "Implement the plan."`);
  lines.push(`  revise:  node ${scriptPath} send ${session.threadId} "<revision instructions>"`);
  return lines.join("\n");
}
function formatConfirmedEvent(session, { requestId }) {
  return `[CONFIRMED] ${session.threadId} ${requestId} | codex resumed`;
}
function formatPipelineEvent(session, { stage }) {
  return `[PIPELINE:${stage}] ${(/* @__PURE__ */ new Date()).toISOString().slice(11, 19)}`;
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

// src/lib/pending-requests.mjs
import fs10 from "node:fs";
import path8 from "node:path";
var DEFAULT_QUESTION_TIMEOUT_MS = 3e5;
var POLL_INTERVAL_MS = 500;
function writePendingRequest(sessionDir, threadId, entry) {
  const filePath = path8.join(sessionDir, `${threadId}.pending.json`);
  fs10.writeFileSync(filePath, JSON.stringify(entry, null, 2));
  return filePath;
}
function readPendingRequestById(sessionDir, requestId) {
  let files;
  try {
    files = fs10.readdirSync(sessionDir).filter((f) => f.endsWith(".pending.json"));
  } catch {
    return null;
  }
  for (const file of files) {
    try {
      const content = JSON.parse(fs10.readFileSync(path8.join(sessionDir, file), "utf8"));
      if (content.internalId === requestId) {
        return content;
      }
    } catch {
    }
  }
  return null;
}
function clearPendingRequest(sessionDir, threadId) {
  const filePath = path8.join(sessionDir, `${threadId}.pending.json`);
  try {
    fs10.unlinkSync(filePath);
  } catch {
  }
}
function writeResponseFile(sessionDir, threadId, payload) {
  const filePath = path8.join(sessionDir, `${threadId}.response.json`);
  fs10.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}
function readResponseFile(sessionDir, threadId) {
  const filePath = path8.join(sessionDir, `${threadId}.response.json`);
  try {
    const content = JSON.parse(fs10.readFileSync(filePath, "utf8"));
    fs10.unlinkSync(filePath);
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

// src/lib/auto-pipeline.mjs
import fs11 from "node:fs";
import path9 from "node:path";
var PIPELINE_TIMEOUT_MS = 9e5;
var STAGE_TIMEOUT_MS = 3e5;
function fmtSeconds(ms) {
  const s = Math.max(0, Math.round(ms / 1e3));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m${rem.toString().padStart(2, "0")}s`;
}
function loadExecuteInstructions(rootDir) {
  const p = path9.join(rootDir, "templates", "execute-instructions.md");
  try {
    return fs11.readFileSync(p, "utf8");
  } catch {
    return "Execute the task autonomously. Do not ask questions. Make reasonable assumptions and proceed.";
  }
}
async function runAutoPipeline(options) {
  const {
    session,
    threadId,
    cwd: cwd2,
    config,
    scriptPath,
    rootDir,
    runAppServerTurn: runAppServerTurn2,
    runAppServerReview: runAppServerReview2,
    jobId = null
  } = options;
  const completedStages = [];
  const startTime = Date.now();
  const executeInstructions = loadExecuteInstructions(rootDir);
  const checkPipelineTimeout = () => {
    if (Date.now() - startTime > PIPELINE_TIMEOUT_MS) {
      throw new PipelineTimeoutError(completedStages);
    }
  };
  try {
    logEvent(session, formatPipelineEvent(session, { stage: "diff" }));
    logNdjson(session, "PIPELINE_STAGE", null, { stage: "diff" });
    const diff1 = captureGitDiff(cwd2, session);
    completedStages.push("diff");
    checkPipelineTimeout();
    let reviewVerdict = "approve";
    let reviewFindings = [];
    let reviewFindingCount = 0;
    if (config.auto_review) {
      logEvent(session, formatPipelineEvent(session, { stage: "review" }));
      logNdjson(session, "PIPELINE_STAGE", null, { stage: "review" });
      try {
        const reviewResult = await withTimeout(
          runAppServerReview2(cwd2, {
            target: { type: "uncommittedChanges" },
            model: config.model
          }),
          STAGE_TIMEOUT_MS,
          "auto-review"
        );
        completedStages.push("review");
        checkPipelineTimeout();
        if (reviewResult.reviewText) {
          const parsed = parseReviewText(reviewResult.reviewText);
          reviewVerdict = parsed.verdict;
          reviewFindings = parsed.findings;
          reviewFindingCount = reviewFindings.length;
        }
        if (reviewFindings.length > 0) {
          logEvent(session, formatPipelineEvent(session, { stage: "fix" }));
          logNdjson(session, "PIPELINE_STAGE", null, { stage: "fix", findingCount: reviewFindings.length });
          const fixPrompt = buildFixPrompt(reviewFindings);
          await withTimeout(
            runAppServerTurn2(cwd2, {
              resumeThreadId: threadId,
              prompt: fixPrompt,
              model: config.model,
              effort: "high",
              collaborationMode: buildCollaborationMode("default", config, {
                developerInstructions: executeInstructions
              }),
              sandboxPolicy: buildSandboxPolicy("default", config)
            }),
            STAGE_TIMEOUT_MS,
            "auto-fix"
          );
          completedStages.push("fix");
          checkPipelineTimeout();
          captureGitDiff(cwd2, session);
        }
      } catch (error) {
        if (error instanceof TimeoutError) {
          throw error;
        }
        logNdjson(session, "PIPELINE_ERROR", null, { stage: "review", error: error.message });
        completedStages.push("review-failed");
      }
    }
    let completionResult = { complete: true, missing_items: [], summary: "Complete" };
    if (config.post_task_prompt && config.post_task_prompt.trim()) {
      logEvent(session, formatPipelineEvent(session, { stage: "check" }));
      logNdjson(session, "PIPELINE_STAGE", null, { stage: "check" });
      try {
        const checkResult = await withTimeout(
          runAppServerTurn2(cwd2, {
            resumeThreadId: threadId,
            prompt: config.post_task_prompt,
            model: config.model,
            effort: "medium",
            collaborationMode: buildCollaborationMode("default", config, {
              developerInstructions: executeInstructions
            }),
            sandboxPolicy: { type: "readOnly" },
            outputSchema: COMPLETION_CHECK_SCHEMA
          }),
          STAGE_TIMEOUT_MS,
          "completion-check"
        );
        completedStages.push("check");
        if (checkResult.status !== 0) {
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
          } catch {
            completionResult = {
              complete: true,
              missing_items: [],
              summary: checkResult.finalMessage.slice(0, 200)
            };
          }
        } else {
          completionResult = {
            complete: false,
            missing_items: ["Completion check produced no final message."],
            summary: "completion-check inconclusive"
          };
        }
      } catch (error) {
        if (error instanceof TimeoutError) {
          throw error;
        }
        logNdjson(session, "PIPELINE_ERROR", null, { stage: "check", error: error.message });
        completedStages.push("check-failed");
      }
    }
    const finalDiff = captureGitDiff(cwd2, session);
    const duration = Math.round((Date.now() - startTime) / 1e3);
    if (completionResult.complete) {
      logEvent(session, formatDoneEvent(session, {
        duration,
        diffStat: finalDiff.diffStat,
        files: finalDiff.files,
        config: { model: config.model, effort: config.effort, modeFlow: "plan\u2192default" },
        diffPath: finalDiff.diffPath,
        scriptPath,
        jobId
      }));
    } else {
      logEvent(session, formatIncompleteEvent(session, {
        diffStat: finalDiff.diffStat,
        diffPath: finalDiff.diffPath,
        verdict: reviewVerdict,
        findingCount: reviewFindingCount,
        missingItems: completionResult.missing_items || [],
        scriptPath,
        jobId
      }));
    }
    logNdjson(session, "PIPELINE_COMPLETE", null, {
      completedStages,
      duration,
      complete: completionResult.complete
    });
    return {
      complete: completionResult.complete,
      completedStages,
      duration,
      diff: finalDiff
    };
  } catch (error) {
    const duration = Math.round((Date.now() - startTime) / 1e3);
    const errorCode = error instanceof TimeoutError ? "ClientTimeout" : "PipelineError";
    const errorMessage = error instanceof PipelineTimeoutError ? `Auto-pipeline exceeded ${fmtSeconds(PIPELINE_TIMEOUT_MS)}. Completed stages: ${completedStages.join(", ")}` : error.message;
    let finalDiff;
    try {
      finalDiff = captureGitDiff(cwd2, session);
    } catch {
      finalDiff = { diffStat: "0 files | +0 -0", files: [], diffPath: "" };
    }
    const lastStage = completedStages[completedStages.length - 1] ?? "pipeline";
    const origin = `pipeline:${lastStage}`;
    logEvent(session, formatErrorEvent(session, {
      errorCode,
      message: errorMessage,
      phase: `pipeline (completed: ${completedStages.join(", ")})`,
      origin,
      scriptPath,
      jobId
    }));
    logNdjson(session, "PIPELINE_ERROR", null, {
      completedStages,
      duration,
      error: errorMessage,
      origin
    });
    return {
      complete: false,
      completedStages,
      duration,
      error: errorMessage
    };
  }
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
function parseReviewText(reviewText) {
  const lower = reviewText.toLowerCase();
  const hasIssues = lower.includes("needs-attention") || lower.includes("finding") || lower.includes("issue");
  return {
    verdict: hasIssues ? "needs-attention" : "approve",
    findings: []
  };
}
var TimeoutError = class extends Error {
  constructor(label, timeoutMs) {
    super(`${label} exceeded ${fmtSeconds(timeoutMs)}`);
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
};
var PipelineTimeoutError = class extends TimeoutError {
  constructor(completedStages) {
    super("auto-pipeline", PIPELINE_TIMEOUT_MS);
    this.completedStages = completedStages;
  }
};
function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(label, timeoutMs));
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
import fs12 from "node:fs";
import path10 from "node:path";
import os5 from "node:os";
var DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
var DEFAULT_FETCH_TIMEOUT_MS = 2500;
var GITHUB_API_URL = "https://api.github.com/repos/yigitkonur/codex-bridge/releases/latest";
var USER_AGENT = "codex-bridge-update-check";
function cachePath() {
  const root = process.env.CLAUDE_PLUGIN_DATA ? path10.join(process.env.CLAUDE_PLUGIN_DATA, "codex-bridge-update.json") : path10.join(os5.homedir(), ".codex-bridge", "update-cache.json");
  return root;
}
function readCache() {
  try {
    const raw = fs12.readFileSync(cachePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed == null) return null;
    if (typeof parsed.checkedAt !== "number") return null;
    if (typeof parsed.latestVersion !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
function writeCache(entry) {
  try {
    const p = cachePath();
    fs12.mkdirSync(path10.dirname(p), { recursive: true });
    fs12.writeFileSync(p, JSON.stringify(entry, null, 2));
  } catch {
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
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(GITHUB_API_URL, {
      signal: controller.signal,
      headers
    });
    if (!res.ok) return null;
    const json2 = await res.json();
    if (typeof json2?.tag_name !== "string") return null;
    return json2.tag_name.replace(/^v/i, "");
  } catch {
    return null;
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
  const now = Date.now();
  if (!force && cache && now - cache.checkedAt < cacheTtlMs) {
    return {
      skipped: false,
      cached: true,
      currentVersion,
      latestVersion: cache.latestVersion,
      hasUpdate: compareVersions(currentVersion, cache.latestVersion) < 0,
      cacheAgeMs: now - cache.checkedAt
    };
  }
  const latest = await fetchLatestTag(fetchTimeoutMs);
  if (!latest) {
    return {
      skipped: true,
      reason: cache ? "fetch-failed-using-stale" : "fetch-failed-no-cache",
      currentVersion,
      ...cache && {
        latestVersion: cache.latestVersion,
        hasUpdate: compareVersions(currentVersion, cache.latestVersion) < 0,
        cacheAgeMs: now - cache.checkedAt
      }
    };
  }
  writeCache({ checkedAt: now, latestVersion: latest });
  return {
    skipped: false,
    cached: false,
    currentVersion,
    latestVersion: latest,
    hasUpdate: compareVersions(currentVersion, latest) < 0,
    cacheAgeMs: 0
  };
}
function formatUpdateNotice(result) {
  if (!result || !result.hasUpdate || !result.latestVersion) return null;
  return `codex-bridge ${result.latestVersion} is available (you have ${result.currentVersion}). Run \`npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y\` to update.`;
}

// src/codex-bridge.mjs
function maybeEmitUpdateNotice(rawArgv, subcommand) {
  try {
    if (process8.env.CODEX_BRIDGE_NO_UPDATE_CHECK === "1") return;
    if (detectJsonFlag(rawArgv)) return;
    if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") return;
    if (subcommand === "version" || subcommand === "update") return;
    void checkForUpdate({ currentVersion: BRIDGE_VERSION }).then((result) => {
      if (!result || !result.hasUpdate) return;
      if (result.cached === false && result.cacheAgeMs === 0) {
        return;
      }
      const line = formatUpdateNotice(result);
      if (line) process8.stdout.write(`${line}
`);
    }).catch(() => {
    });
  } catch {
  }
}
var SCRIPT_DIR = path11.dirname(fileURLToPath2(import.meta.url));
var SCRIPT_PATH = path11.join(SCRIPT_DIR, "codex-bridge.mjs");
var ROOT_DIR = fs13.existsSync(path11.join(SCRIPT_DIR, "schemas")) ? SCRIPT_DIR : path11.resolve(SCRIPT_DIR, "..");
var REVIEW_SCHEMA = path11.join(ROOT_DIR, "schemas", "review-output.schema.json");
var EXECUTE_INSTRUCTIONS_PATH = path11.join(ROOT_DIR, "templates", "execute-instructions.md");
var PLAN_ENFORCEMENT_PATH = path11.join(ROOT_DIR, "templates", "plan-enforcement.md");
var DEVELOPER_INSTRUCTIONS_FALLBACK = {
  plan: "Produce one concrete plan using the plan tool. Do not write code, do not ask questions, do not brainstorm alternatives.",
  default: "Execute the task autonomously. Do not ask questions. Make reasonable assumptions and proceed."
};
function loadDeveloperInstructions(mode) {
  const templatePath = mode === "plan" ? PLAN_ENFORCEMENT_PATH : EXECUTE_INSTRUCTIONS_PATH;
  try {
    return fs13.readFileSync(templatePath, "utf8");
  } catch {
    return DEVELOPER_INSTRUCTIONS_FALLBACK[mode] ?? DEVELOPER_INSTRUCTIONS_FALLBACK.default;
  }
}
var DEFAULT_STATUS_WAIT_TIMEOUT_MS = 24e4;
var DEFAULT_STATUS_POLL_INTERVAL_MS = 2e3;
var VALID_REASONING_EFFORTS = /* @__PURE__ */ new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
var MODEL_ALIASES = /* @__PURE__ */ new Map([["spark", "gpt-5.3-codex-spark"]]);
var STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
var BRIDGE_CONFIG_SKILL_LAYER = null;
function getBridgeConfig(cwd2 = null, workspaceRoot = null) {
  if (!cwd2 && !workspaceRoot) {
    if (!BRIDGE_CONFIG_SKILL_LAYER) {
      BRIDGE_CONFIG_SKILL_LAYER = loadConfig(ROOT_DIR);
    }
    return BRIDGE_CONFIG_SKILL_LAYER;
  }
  return loadConfig(ROOT_DIR, cwd2, workspaceRoot);
}
function buildMonitorHint({ eventsPath, jobId, threadId }) {
  const identifier = jobId ?? threadId;
  if (!identifier) return null;
  const cliCommand = `node ${SCRIPT_PATH} events ${identifier} --follow --filter DONE,ERROR,INCOMPLETE,PLAN,QUESTION --timeout-ms 600000`;
  const shellFallback = eventsPath ? `tail -f ${JSON.stringify(eventsPath)} | while IFS= read -r line; do echo "$line"; case "$line" in *"[DONE]"*|*"[ERROR]"*|*"[INCOMPLETE]"*) break ;; esac; done` : null;
  return {
    command: cliCommand,
    shell_fallback: shellFallback,
    terminal_tags: ["DONE", "ERROR", "INCOMPLETE"],
    timeout_ms: 6e5,
    tool_hint: {
      description: "codex-bridge task terminal events",
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
      const path12 = first.path ?? "";
      const summary = `${kind ? kind + " " : ""}${path12}`.trim();
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
    synopsis: "task [--write] [--mode plan|default] [--effort <level>] [-m <model>] [--prompt-file <path>] [--resume|--resume-last] [--fresh] [--background] [--json] [prompt or file.md]",
    summary: "Start a new Codex task. Defaults: plan mode, read-only sandbox, foreground. Use --mode default to skip planning and execute directly.",
    examples: [
      'codex-bridge task --write "Fix the auth bug in src/auth.ts"',
      'codex-bridge task --mode default --write "Trivial typo fix"',
      "codex-bridge task --prompt-file prompt.md --effort high --write",
      "codex-bridge task --resume-last --write",
      'codex-bridge task --background --write "Rewrite tests" --json'
    ]
  },
  send: {
    synopsis: "send <thread-id> [--mode plan|default] [--effort <level>] [--json] [prompt or file.md]",
    summary: "Resume a thread with a new prompt. Use for plan approval, revisions, and follow-ups. <thread-id> is a UUID returned by task.",
    examples: [
      'codex-bridge send 019d9a86-1c8a-7f41-8032-6c76bbe730a1 --mode default "Implement the plan."',
      'codex-bridge send 019d9a86-1c8a-7f41-8032-6c76bbe730a1 "Revise step 2: use token bucket instead"'
    ]
  },
  steer: {
    synopsis: "steer <thread-id> <turn-id> [prompt or file.md]",
    summary: "Send mid-turn guidance to an active Codex turn. Not valid for review/compaction turns. Both ids are UUIDs.",
    examples: ['codex-bridge steer 019d9a86-1c8a-7f41-8032-6c76bbe730a1 019d9a86-2012-7152-bcc9-228a263d286a "Focus on auth first"']
  },
  respond: {
    synopsis: "respond <request-id> (--question-id <qid> --answer <answer> | --json-payload <json>) [--json]",
    summary: "Answer a [QUESTION] emitted by Codex (requestUserInput).",
    examples: [
      'codex-bridge respond req-xyz --question-id q1 --answer "jwt"',
      `codex-bridge respond req-xyz --json-payload '{"answers":{"q1":{"answers":["jwt"]}}}'`
    ]
  },
  review: {
    synopsis: "review [--scope auto|working-tree|branch] [--base <ref>] [-m <model>] [--json]",
    summary: "Run a standalone code review using Codex's built-in reviewer.",
    examples: [
      "codex-bridge review --scope working-tree",
      "codex-bridge review --scope branch --base main"
    ]
  },
  "adversarial-review": {
    synopsis: "adversarial-review [--scope auto|working-tree|branch] [--base <ref>] [-m <model>] [--json] [focus text...]",
    summary: "Run an adversarial review with a structured JSON result.",
    examples: [
      'codex-bridge adversarial-review "focus on SQL injection risks"',
      "codex-bridge adversarial-review --scope branch --base main"
    ]
  },
  summary: {
    synopsis: "summary <thread-id> [--tail <n>] [--json]",
    summary: "Generate a readable transcript from the NDJSON session log (default tail=200).",
    examples: ["codex-bridge summary 019d9a86-1c8a-7f41-8032-6c76bbe730a1 --tail 400"]
  },
  status: {
    synopsis: "status [job-id] [--all] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]",
    summary: "List jobs, or inspect one by id. With --wait, poll until the job reaches a terminal state.",
    examples: [
      "codex-bridge status",
      "codex-bridge status task-abc --wait --timeout-ms 600000",
      "codex-bridge status --all --json"
    ]
  },
  result: {
    synopsis: "result [job-id] [--json]",
    summary: "Get the full result of a completed job. Omit job-id for the latest in this session.",
    examples: ["codex-bridge result task-abc --json"]
  },
  wait: {
    synopsis: "wait <job-id-or-thread-id> [--timeout-ms <ms>] [--json]",
    summary: "Block until the target job's events file emits [DONE], [ERROR], or [INCOMPLETE].",
    examples: [
      "codex-bridge wait task-abc --timeout-ms 600000 --json",
      "codex-bridge wait 019d9a86-1c8a-7f41-8032-6c76bbe730a1"
    ]
  },
  events: {
    synopsis: "events <job-id-or-thread-id> [--follow] [--filter <tags>] [--timeout-ms <ms>] [--json]",
    summary: "Stream the target's events file; optional tag filter and follow mode. Lines go to stdout; --json adds a trailing envelope (both with and without --follow).",
    examples: [
      "codex-bridge events task-abc --filter DONE,ERROR,INCOMPLETE",
      "codex-bridge events 019d9a86-1c8a-7f41-8032-6c76bbe730a1 --follow --filter PIPELINE,DONE,ERROR --timeout-ms 600000"
    ]
  },
  cancel: {
    synopsis: "cancel [job-id] [--json]",
    summary: "Cancel a running job. Attempts `turn/interrupt` before terminating the worker tree.",
    examples: ["codex-bridge cancel task-abc"]
  },
  setup: {
    synopsis: "setup [--json] [--enable-review-gate | --disable-review-gate]",
    summary: "Health check: Node/npm/Codex install, auth, broker runtime; toggle stop-gate review.",
    examples: ["codex-bridge setup --json"]
  },
  version: {
    synopsis: "version [--check-update] [--json]",
    summary: "Print bridge version, schema version, Node version, Codex version, capability list, and cached update status. `--check-update` forces a fresh GitHub round-trip.",
    examples: ["codex-bridge version --json", "codex-bridge version --check-update --json"]
  },
  update: {
    synopsis: "update [--force] [--json]",
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
  return argv;
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
  return options.cwd ? path11.resolve(process8.cwd(), options.cwd) : process8.cwd();
}
function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}
function sleep(ms) {
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
function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "").split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  return line ?? fallback;
}
async function buildSetupReport(cwd2, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd2);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd: cwd2 });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd: cwd2 });
  const codexStatus = getCodexAvailability(cwd2);
  const authStatus = await getCodexAuthStatus(cwd2);
  const config = getConfig(workspaceRoot);
  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `codex-bridge setup --enable-review-gate` to require a fresh review before stop.");
  }
  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process8.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}
async function handleSetup(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });
  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw conflictError(
      "Choose either --enable-review-gate or --disable-review-gate.",
      "REVIEW_GATE_CONFLICT"
    );
  }
  const cwd2 = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];
  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }
  const finalReport = await buildSetupReport(cwd2, actionsTaken);
  emitSuccess("setup", finalReport, renderSetupReport(finalReport), {
    json: options.json,
    startedAt
  });
}
var BRIDGE_VERSION = "1.2.0";
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
  "update-check"
]);
async function handleVersion(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "check-update"]
  });
  const cwd2 = resolveCommandCwd(options);
  const codex = getCodexAvailability(cwd2);
  const update = await checkForUpdate({
    currentVersion: BRIDGE_VERSION,
    force: Boolean(options["check-update"])
  });
  const payload = {
    version: BRIDGE_VERSION,
    schema_version: BRIDGE_SCHEMA_VERSION,
    node_version: process8.version,
    codex: {
      available: codex.available,
      detail: codex.detail ?? null
    },
    capabilities: [...BRIDGE_CAPABILITIES],
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
  const cwd2 = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sources = resolveConfigSources(ROOT_DIR, cwd2, workspaceRoot);
  const effective = getBridgeConfig(cwd2, workspaceRoot);
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
  const rendered = `${lines.join("\n")}
`;
  emitSuccess("config", payload, rendered, { json: options.json, startedAt });
}
async function handleUpdate(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "force"]
  });
  const update = await checkForUpdate({
    currentVersion: BRIDGE_VERSION,
    force: options.force !== false
  });
  const installCommand = "npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y";
  const payload = {
    current_version: BRIDGE_VERSION,
    latest_version: update.latestVersion ?? null,
    has_update: Boolean(update.hasUpdate),
    check_skipped: Boolean(update.skipped),
    check_skip_reason: update.reason ?? null,
    install_command: installCommand
  };
  let rendered;
  if (update.skipped && !update.latestVersion) {
    rendered = `Update check skipped (${update.reason}). Try again in a moment.
`;
  } else if (update.hasUpdate) {
    rendered = `codex-bridge ${update.latestVersion} available (you have ${BRIDGE_VERSION}).
To update, run:
  ${installCommand}
`;
  } else {
    rendered = `codex-bridge is up to date (${BRIDGE_VERSION}${update.latestVersion ? `, latest ${update.latestVersion}` : ""}).
`;
  }
  emitSuccess("update", payload, rendered, { json: options.json, startedAt });
}
async function handleAuthStatus(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd2 = resolveCommandCwd(options);
  const auth = await getCodexAuthStatus(cwd2);
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
function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}
function ensureCodexAvailable(cwd2) {
  const availability = getCodexAvailability(cwd2);
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
function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw validationError(
      "`review` maps to the built-in reviewer and does not support custom focus text.",
      "REVIEW_FOCUS_UNSUPPORTED",
      `Retry with \`adversarial-review ${focusText.trim()}\` for focused review instructions.`
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
  return process8.env[SESSION_ID_ENV] ?? null;
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
async function waitForSingleJobSnapshot(cwd2, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd2, reference);
  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd2, reference);
  }
  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}
async function resolveLatestTrackedTaskThread(cwd2, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd2);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
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
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);
  const reviewConfig = getBridgeConfig(request.cwd, resolveWorkspaceRoot(request.cwd));
  const reviewSessionDir = resolveSessionDir(reviewConfig.session_dir);
  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  if (target.mode === "working-tree") {
    const diffCheck = runCommand("git", ["diff", "--quiet"], { cwd: request.cwd });
    const stagedCheck = runCommand("git", ["diff", "--cached", "--quiet"], { cwd: request.cwd });
    if (diffCheck.status === 0 && stagedCheck.status === 0) {
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
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result2 = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
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
    }
    const payload2 = {
      review: reviewName,
      target,
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
      summary: firstMeaningfulLine(result2.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label,
      error: result2.error ?? null
    };
  }
  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  if (result.threadId) {
    const advSession = findSession(reviewSessionDir, result.threadId) ?? initSession(reviewSessionDir, result.threadId);
    logNdjson(advSession, "TURN_COMPLETED", "turn/completed", {
      turnId: result.turnId,
      status: result.status,
      reviewKind: "adversarial",
      target,
      findingCount: Array.isArray(parsed.parsed?.findings) ? parsed.parsed.findings.length : null
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
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label,
    error: result.error ?? null
  };
}
async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);
  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });
  let resumeThreadId = null;
  if (request.resumeLast) {
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
  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
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
  });
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
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
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
function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }
  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
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
  return jobClass === "review" ? "review" : "rescue";
}
function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
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
function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}
function buildTaskRequest({ cwd: cwd2, model, effort, prompt, write, resumeLast, jobId, mode }) {
  return {
    cwd: cwd2,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    mode: mode ?? null
  };
}
function readTaskPrompt(cwd2, options, positionals) {
  if (options["prompt-file"]) {
    return readPromptFileOrThrow(path11.resolve(cwd2, options["prompt-file"]));
  }
  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}
function readPromptFileOrThrow(absPath) {
  try {
    return fs13.readFileSync(absPath, "utf8");
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
async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  if (execution.exitStatus !== 0) {
    const errLike = execution.error ?? { message: `Codex turn failed (status ${execution.exitStatus}).` };
    if (options.json) {
      emitError(errLike, { json: true, command: options.command ?? null });
    } else {
      if (execution.rendered) {
        process8.stdout.write(execution.rendered);
      }
      emitError(errLike, { json: false, command: options.command ?? null });
    }
    return execution;
  }
  emitSuccess(options.command ?? null, execution.payload, execution.rendered, {
    json: options.json,
    startedAt: options.startedAt
  });
  return execution;
}
function spawnDetachedTaskWorker(cwd2, jobId) {
  const scriptPath = SCRIPT_PATH;
  const child = spawn3(process8.execPath, [scriptPath, "task-worker", "--cwd", cwd2, "--job-id", jobId], {
    cwd: cwd2,
    env: process8.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}
function enqueueBackgroundTask(cwd2, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");
  const child = spawnDetachedTaskWorker(cwd2, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);
  return {
    payload: {
      jobId: job.id,
      threadId: null,
      eventsPath: null,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile,
      monitor: buildMonitorHint({ eventsPath: null, jobId: job.id, threadId: null })
    },
    logFile
  };
}
async function handleReviewCommand(argv, config) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });
  const cwd2 = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd2, {
    base: options.base,
    scope: options.scope
  });
  config.validateRequest?.(target, focusText);
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
      cwd: cwd2,
      base: options.base,
      scope: options.scope,
      model: options.model,
      focusText,
      reviewName: config.reviewName,
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
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  const config = getBridgeConfig(request.cwd ?? null, workspaceRoot);
  const sessionDir = resolveSessionDir(config.session_dir);
  const effectiveMode = request.mode ?? config.mode ?? "plan";
  const isPlanMode = effectiveMode === "plan" && !request.resumeLast;
  const metaSkillsPreamble = "[ORCHESTRATOR DIRECTIVE] Do not invoke your own meta-skills \u2014 specifically `using-superpowers`, `brainstorming`, `writing-plans`, `using-git-worktrees`, or any equivalent planning/ceremony skill. Do not create docs/superpowers/specs/*.md or docs/superpowers/plans/*.md files unless the task explicitly asks for them.";
  const metaSkillsPrefix = config.skip_meta_skills ? isPlanMode ? `${metaSkillsPreamble} The calling orchestrator is already driving the plan/execute loop; produce a concise inline [PLAN] and stop \u2014 the orchestrator approves before execution.

` : `${metaSkillsPreamble} The calling orchestrator has already planned this task; your job is to execute it directly.

` : "";
  const promptWithFooter = config.prompt_footer ? `${metaSkillsPrefix}${request.prompt}

${config.prompt_footer}` : `${metaSkillsPrefix}${request.prompt}`;
  const activeMode = isPlanMode ? "plan" : "default";
  const developerInstructions = loadDeveloperInstructions(activeMode);
  const CIRCUIT_BREAKER_THRESHOLD = 3;
  const breakerState = {
    lastFamily: null,
    consecutiveFailures: 0,
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
  const bridgeRequest = {
    ...request,
    prompt: promptWithFooter,
    collaborationMode: isPlanMode ? buildCollaborationMode("plan", config, { developerInstructions }) : request.write ? buildCollaborationMode("default", config, { developerInstructions, effort: request.effort }) : null,
    // Always resolve through buildSandboxPolicy so `config.sandbox_policy`
    // wins regardless of plan/write flags. When no override is set, the
    // mode-derived default applies (plan → readOnly, --write → workspaceWrite,
    // plain exec → readOnly).
    sandboxPolicy: buildSandboxPolicy(
      isPlanMode || !request.write ? "plan" : "default",
      config
    ),
    effort: isPlanMode ? "xhigh" : request.effort ?? config.effort ?? "high",
    turnTimeoutMs: isPlanMode ? 3e5 : 6e5,
    idleTimeoutMs: 12e4,
    onTurnStart: (info) => {
      const s = findSession(sessionDir, info.threadId) ?? initSession(sessionDir, info.threadId);
      breakerState.lastFamily = null;
      breakerState.consecutiveFailures = 0;
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
    },
    onItemCompleted: (item, { threadId }) => {
      const effectiveThreadId = threadId ?? null;
      if (!effectiveThreadId) return;
      const s = findSession(sessionDir, effectiveThreadId) ?? initSession(sessionDir, effectiveThreadId);
      logNdjson(s, "ITEM_COMPLETED", "item/completed", {
        itemId: item?.id ?? null,
        itemType: item?.type ?? null,
        text: extractItemText(item)
      });
      if (!config.command_failure_circuit_breaker || breakerState.tripped || item?.type !== "commandExecution") {
        return;
      }
      const failed = item.status !== "completed" || typeof item.exitCode === "number" && item.exitCode !== 0;
      if (!failed) {
        breakerState.lastFamily = null;
        breakerState.consecutiveFailures = 0;
        return;
      }
      const family = detectCommandFamily(item.command);
      if (!family) {
        return;
      }
      if (family === breakerState.lastFamily) {
        breakerState.consecutiveFailures += 1;
      } else {
        breakerState.lastFamily = family;
        breakerState.consecutiveFailures = 1;
      }
      if (breakerState.consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) return;
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
        consecutiveFailures: breakerState.consecutiveFailures,
        turnInterrupted: false
      });
    }
  };
  bridgeRequest.onServerRequest = (message) => {
    const params = message.params ?? {};
    const threadId = params.threadId ?? "unknown";
    const session2 = findSession(sessionDir, threadId) ?? initSession(sessionDir, threadId);
    if (message.method === "item/tool/requestUserInput") {
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
      logEvent(session2, formatQuestionEvent(session2, {
        requestId: internalId,
        questions: params.questions ?? [],
        scriptPath: SCRIPT_PATH
      }));
      logNdjson(session2, "QUESTION", message.method, { requestId: internalId, questions: params.questions });
      waitForResponse(sessionDir, threadId, 3e5, internalId).then((response) => {
        clearPendingRequest(sessionDir, threadId);
        if (response && response.payload) {
          message._client?.sendMessage?.({ id: message.id, result: response.payload });
          logEvent(session2, formatConfirmedEvent(session2, { requestId: internalId }));
          logNdjson(session2, "CONFIRMED", "serverRequest/resolved", { requestId: internalId });
        } else {
          message._client?.sendMessage?.({ id: message.id, result: { answers: {} } });
          logNdjson(session2, "QUESTION_TIMEOUT", null, { requestId: internalId });
        }
      });
    }
  };
  const result = await executeTaskRun(bridgeRequest);
  const session = initSession(sessionDir, result.threadId);
  const monitor = buildMonitorHint({
    eventsPath: result.threadId ? path11.join(sessionDir, `${result.threadId}.events`) : null,
    jobId: request.jobId ?? null,
    threadId: result.threadId ?? null
  });
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
      ...extras
    };
  };
  if (result.exitStatus !== 0 && result.error) {
    const errorMessage = String(result.error.message ?? result.error);
    const isIdleTimeout = errorMessage.includes("No events received for");
    const codexErrorInfo = result.error.codexErrorInfo ?? result.error.codex_error_info ?? null;
    const errorCode = isIdleTimeout ? "ClientTimeout" : codexErrorInfo ?? "CodexError";
    const touchedFiles = result.payload?.touchedFiles ?? [];
    logEvent(session, formatErrorEvent(session, {
      errorCode,
      message: errorMessage,
      phase: isPlanMode ? "plan" : "execution",
      origin: "turn",
      scriptPath: SCRIPT_PATH,
      jobId: request.jobId ?? null
    }));
    logNdjson(session, "ERROR", null, { errorCode, message: errorMessage, origin: "turn" });
    if (codexErrorInfo === "SandboxError" && touchedFiles.length > 0) {
      const cwdArg = JSON.stringify(request.cwd);
      setPhase("workspace-dirty", {
        command: `git -C ${cwdArg} add -A && git -C ${cwdArg} commit -m "<subject>"`,
        description: "Codex produced a diff but the sandbox blocked the commit. Commit on Codex's behalf, or re-run with config.sandbox_policy: danger-full-access."
      }, { errorCode, touchedFiles, monitor, sandboxError: errorMessage });
      return { ...result, session, exitStatus: 0, error: null };
    }
    setPhase("error", {
      command: `node ${SCRIPT_PATH} send ${result.threadId} "<revised prompt>"`,
      description: "Retry with an adjusted prompt, or cancel and start fresh."
    }, { errorCode, monitor });
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
      scriptPath: SCRIPT_PATH
    }));
    setPhase("plan-pending", {
      command: `node ${SCRIPT_PATH} send ${result.threadId} --mode default "Implement the plan."`,
      description: "Approve the plan and switch to execution mode. To revise instead, drop --mode and send revision text."
    }, { planPath, planSteps: steps, monitor });
    return { ...result, session, planPath };
  }
  if (result.exitStatus === 0 && (config.auto_review || config.post_task_prompt)) {
    const pipelineResult = await runAutoPipeline({
      session,
      threadId: result.threadId,
      cwd: request.cwd,
      config,
      scriptPath: SCRIPT_PATH,
      rootDir: ROOT_DIR,
      runAppServerTurn,
      runAppServerReview,
      jobId: request.jobId ?? null
    });
    if (pipelineResult?.complete === false) {
      const pipelineErrored = Boolean(pipelineResult.error);
      const failedStage = pipelineResult.completedStages?.length ? pipelineResult.completedStages[pipelineResult.completedStages.length - 1] : "diff";
      const nextAction = pipelineErrored ? {
        command: `node ${SCRIPT_PATH} result ${request.jobId ?? result.threadId}`,
        description: `Pipeline stalled after stage '${failedStage}' (${pipelineResult.error}). Read result for partial state. If this keeps happening, set auto_review: false in config.yaml.`
      } : {
        command: `node ${SCRIPT_PATH} send ${result.threadId} "Complete the missing items"`,
        description: "Codex's completion check flagged gaps. Read [INCOMPLETE] in events for specifics."
      };
      setPhase("incomplete", nextAction, { pipeline: pipelineResult, monitor });
    } else {
      setPhase("done", {
        command: `node ${SCRIPT_PATH} result ${request.jobId ?? result.threadId}`,
        description: "Task finished and passed completion check. Inspect full result or send a follow-up."
      }, { pipeline: pipelineResult, monitor });
    }
    return { ...result, session, pipeline: pipelineResult };
  }
  const diff = captureGitDiff(request.cwd, session);
  logEvent(session, formatDoneEvent(session, {
    duration: 0,
    diffStat: diff.diffStat,
    files: diff.files,
    config: { model: config.model, effort: config.effort, modeFlow: isPlanMode ? "plan\u2192default" : "default" },
    diffPath: diff.diffPath,
    scriptPath: SCRIPT_PATH,
    jobId: request.jobId ?? null
  }));
  setPhase("done", {
    command: `node ${SCRIPT_PATH} result ${request.jobId ?? result.threadId}`,
    description: "Task finished. Inspect full result or send a follow-up."
  }, { diffPath: diff.diffPath, monitor });
  return { ...result, session, diff };
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
    valueOptions: ["model", "effort", "cwd", "prompt-file", "mode"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });
  const VALID_MODES = /* @__PURE__ */ new Set(["plan", "default"]);
  if (options.mode != null && !VALID_MODES.has(options.mode)) {
    throw usageError(`mode must be plan or default, got ${JSON.stringify(options.mode)}`);
  }
  const cwd2 = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd2, options, positionals);
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw conflictError(
      "Choose either --resume/--resume-last or --fresh.",
      "RESUME_FRESH_CONFLICT"
    );
  }
  requireTaskRequest(prompt, resumeLast);
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });
  if (options.background) {
    ensureCodexAvailable(cwd2);
    const job2 = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd: cwd2,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job2.id,
      mode: options.mode ?? null
    });
    const { payload } = enqueueBackgroundTask(cwd2, job2, request);
    emitSuccess("task", payload, renderQueuedTaskLaunch(payload), {
      json: options.json,
      startedAt
    });
    return;
  }
  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) => runBridgeTask({
      cwd: cwd2,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id,
      mode: options.mode ?? null,
      onProgress: progress
    }),
    { json: options.json, startedAt, command: "task" }
  );
}
async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });
  if (!options["job-id"]) {
    throw usageError("Missing required --job-id for task-worker.");
  }
  const cwd2 = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
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
    () => executeTaskRun({
      ...request,
      onProgress: progress
    }),
    { logFile }
  );
}
async function handleStatus(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });
  const cwd2 = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait ? await waitForSingleJobSnapshot(cwd2, reference, {
      timeoutMs: options["timeout-ms"],
      pollIntervalMs: options["poll-interval-ms"]
    }) : buildSingleJobSnapshot(cwd2, reference);
    emitSuccess("status", snapshot, renderJobStatusReport(snapshot.job), {
      json: options.json,
      startedAt
    });
    return;
  }
  if (options.wait) {
    throw usageError("`status --wait` requires a job id.");
  }
  const report = buildStatusSnapshot(cwd2, { all: options.all });
  emitSuccess("status", report, renderStatusReport(report), {
    json: options.json,
    startedAt
  });
}
function handleResult(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd2 = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd2, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
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
        const data = fs13.readFileSync(eventsPath, "utf8");
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
        watcher = fs13.watch(eventsPath, { persistent: false }, scan);
        scan();
      } catch (e) {
        if (e.code === "ENOENT") {
          if (!pollTimer) {
            pollTimer = setInterval(() => {
              if (fs13.existsSync(eventsPath)) {
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
    if (fs13.existsSync(eventsPath)) {
      scan();
      if (!resolved) attachWatcher();
    } else {
      pollTimer = setInterval(() => {
        if (fs13.existsSync(eventsPath)) {
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
    booleanOptions: ["json"]
  });
  const cwd2 = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (!reference) {
    throw usageError("wait requires <job-id-or-thread-id>");
  }
  let job;
  try {
    job = resolveResultJob(cwd2, reference).job;
  } catch (err) {
    if (err?.code === "JOB_NOT_FINISHED") {
      job = buildSingleJobSnapshot(cwd2, reference).job;
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
  const config = getBridgeConfig(cwd2);
  const sessionDir = resolveSessionDir(config.session_dir);
  const eventsPath = path11.join(sessionDir, `${job.threadId}.events`);
  const timeoutMs = Math.max(1e3, Number(options["timeout-ms"]) || 6e5);
  const TERMINAL = /\[(DONE|ERROR|INCOMPLETE)\]/;
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
async function handleEvents(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "filter"],
    booleanOptions: ["json", "follow"]
  });
  const cwd2 = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (!reference) {
    throw usageError("events requires <job-id-or-thread-id>");
  }
  let job;
  try {
    job = resolveResultJob(cwd2, reference).job;
  } catch (err) {
    if (err?.code === "JOB_NOT_FINISHED") {
      job = buildSingleJobSnapshot(cwd2, reference).job;
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
  const config = getBridgeConfig(cwd2);
  const sessionDir = resolveSessionDir(config.session_dir);
  const eventsPath = path11.join(sessionDir, `${job.threadId}.events`);
  const filter = options.filter ? new Set(
    options.filter.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
  ) : null;
  const tagOf = (line) => {
    const m = /^\[([A-Za-z:]+)\]/.exec(line);
    return m ? m[1].split(":")[0].toUpperCase() : null;
  };
  const passes = (line) => {
    if (!filter) return true;
    const tag = tagOf(line);
    return tag != null && filter.has(tag);
  };
  const TERMINAL = /^\[(DONE|ERROR|INCOMPLETE)\]/;
  let initial = "";
  let alreadyTerminal = false;
  if (fs13.existsSync(eventsPath)) {
    initial = fs13.readFileSync(eventsPath, "utf8");
    for (const line of initial.split("\n")) {
      if (!line) continue;
      if (passes(line)) process8.stdout.write(line + "\n");
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
        filter: options.filter ?? null
      },
      "",
      { json: options.json, startedAt }
    );
    return;
  }
  let timedOut = false;
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
        data = fs13.readFileSync(eventsPath, "utf8");
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
        if (passes(line)) process8.stdout.write(line + "\n");
        if (TERMINAL.test(line)) return finish("terminal");
      }
    };
    const attachWatcher = () => {
      try {
        watcher = fs13.watch(eventsPath, { persistent: false }, scanAppended);
        scanAppended();
      } catch (e) {
        if (e.code === "ENOENT") {
          if (!pollTimer)
            pollTimer = setInterval(() => {
              if (fs13.existsSync(eventsPath)) {
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
    if (fs13.existsSync(eventsPath)) {
      attachWatcher();
    } else {
      pollTimer = setInterval(() => {
        if (fs13.existsSync(eventsPath)) {
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
      timedOut
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
  const cwd2 = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
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
  const cwd2 = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd2, reference, { env: process8.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;
  const interrupt = await interruptAppServerTurn(cwd2, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.` : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }
  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");
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
  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };
  emitSuccess("cancel", payload, renderCancelReport(nextJob), {
    json: options.json,
    startedAt
  });
}
function resolvePromptInput(options, positionals, cwd2) {
  if (options["prompt-file"]) {
    return readPromptFileOrThrow(path11.resolve(cwd2, options["prompt-file"]));
  }
  if (positionals.length === 1) {
    const candidate = path11.resolve(cwd2, positionals[0]);
    try {
      if (fs13.existsSync(candidate) && fs13.statSync(candidate).isFile()) {
        return fs13.readFileSync(candidate, "utf8");
      }
    } catch {
    }
  }
  const text = positionals.join(" ");
  if (text) return text;
  return readStdinIfPiped();
}
async function handleSend(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["mode", "effort", "cwd"],
    booleanOptions: ["json", "wait"],
    aliasMap: { m: "mode" }
  });
  const VALID_MODES = /* @__PURE__ */ new Set(["plan", "default"]);
  if (options.mode != null && !VALID_MODES.has(options.mode)) {
    throw usageError(`mode must be plan or default, got ${JSON.stringify(options.mode)}`);
  }
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
  const cwd2 = resolveCommandCwd(options);
  const prompt = resolvePromptInput(options, promptParts, cwd2);
  if (!prompt) {
    throw validationError("send requires a prompt (text or file)", "MISSING_PROMPT");
  }
  const config = getBridgeConfig(cwd2);
  const modeOverride = options.mode;
  const sessionDir = resolveSessionDir(config.session_dir);
  const turnOptions = {
    resumeThreadId: threadId,
    prompt,
    model: config.model,
    effort: normalizeReasoningEffort(options.effort ?? config.effort),
    sandbox: modeOverride === "default" ? "workspace-write" : modeOverride === "plan" ? "read-only" : void 0,
    onProgress: null,
    idleTimeoutMs: 12e4,
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
    }
  };
  const resolvedSandboxMode = modeOverride === "default" ? "default" : "plan";
  turnOptions.sandboxPolicy = buildSandboxPolicy(resolvedSandboxMode, config);
  if (modeOverride) {
    turnOptions.collaborationMode = buildCollaborationMode(modeOverride, config, {
      effort: options.effort,
      developerInstructions: loadDeveloperInstructions(modeOverride)
    });
  }
  ensureCodexAvailable(cwd2);
  const workspaceRoot = resolveCommandWorkspace(options);
  const result = await runAppServerTurn(workspaceRoot, turnOptions);
  if (result.status !== 0) {
    const errLike = result.error ?? { message: `send failed on thread ${threadId} (status ${result.status}).` };
    emitError(errLike, { json: options.json, command: "send" });
    return;
  }
  const session = findSession(sessionDir, threadId);
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
    valueOptions: ["cwd"],
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
  const cwd2 = resolveCommandCwd(options);
  const prompt = resolvePromptInput(options, promptParts, cwd2);
  if (!prompt) {
    throw validationError("steer requires a prompt", "MISSING_PROMPT");
  }
  ensureCodexAvailable(cwd2);
  await withAppServer(cwd2, async (client) => {
    await client.request("turn/steer", {
      threadId,
      input: [{ type: "text", text: prompt }],
      expectedTurnId: turnId
    });
  });
  const config = getBridgeConfig(cwd2);
  const sessionDir = resolveSessionDir(config.session_dir);
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
    valueOptions: ["question-id", "answer", "json-payload", "cwd"],
    booleanOptions: ["json"]
  });
  const requestId = positionals[0];
  if (!requestId) {
    throw usageError("respond requires <request-id>");
  }
  const config = getBridgeConfig(cwd);
  const sessionDir = resolveSessionDir(config.session_dir);
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
    payload = JSON.parse(options["json-payload"]);
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
  writeResponseFile(sessionDir, pending.threadId, {
    requestId: pending.internalId,
    rpcRequestId: pending.rpcRequestId,
    payload
  });
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
  const config = getBridgeConfig(cwd);
  const sessionDir = resolveSessionDir(config.session_dir);
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
    content = fs13.readFileSync(session.ndjsonPath, "utf8");
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
  cancel: handleCancel
});
async function main() {
  const startedAt = Date.now();
  const rawArgv = process8.argv.slice(2);
  const [subcommand, ...argv] = rawArgv;
  maybeEmitUpdateNotice(rawArgv, subcommand);
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    if (detectJsonFlag(rawArgv)) {
      emitSuccess("help", buildMachineReadableHelp(), null, { json: true, startedAt });
      return;
    }
    printUsage();
    return;
  }
  if (COMMANDS[subcommand] && detectHelpFlag(argv)) {
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
  const rawArgv = process8.argv.slice(2);
  const json2 = detectJsonFlag(rawArgv);
  const command = rawArgv[0] && COMMANDS[rawArgv[0]] ? rawArgv[0] : null;
  emitError(error, { json: json2, command });
});
/*! Bundled license information:

js-yaml/dist/js-yaml.mjs:
  (*! js-yaml 4.1.1 https://github.com/nodeca/js-yaml @license MIT *)
*/
