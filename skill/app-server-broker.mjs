#!/usr/bin/env node

// src/adapters/codex/broker.mjs
import fs4 from "node:fs";
import net3 from "node:net";
import path4 from "node:path";
import process6 from "node:process";
import { pathToFileURL } from "node:url";

// src/lib/cli-errors.mjs
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
var UPSTREAM_RETRY_POLICY = Object.freeze({
  "upstream:transport": { strategy: "same-thread", maxAttempts: 3, backoffMs: [2e3, 5e3, 12e3] },
  "upstream:compact-proxy": { strategy: "same-thread", maxAttempts: 2, backoffMs: [1e4, 3e4] },
  "upstream:invalid-request": { strategy: "same-thread", maxAttempts: 3, backoffMs: [2e3, 5e3, 12e3] },
  "upstream:response-chain-lost": { strategy: "new-thread", maxAttempts: 1, backoffMs: [0] },
  "upstream:auth": { strategy: "none", maxAttempts: 0, backoffMs: [] }
});

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

// src/adapters/codex/protocol.mjs
import net2 from "node:net";
import process5 from "node:process";
import { spawn as spawn2 } from "node:child_process";
import readline from "node:readline";

// src/lib/broker-endpoint.mjs
import path from "node:path";
import process2 from "node:process";
function sanitizePipeName(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
}
function createBrokerEndpoint(sessionDir, platform = process2.platform) {
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
import fs3 from "node:fs";
import net from "node:net";
import os2 from "node:os";
import path3 from "node:path";
import process4 from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// src/lib/process.mjs
import { spawnSync } from "node:child_process";
import process3 from "node:process";
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
    shell: process3.platform === "win32" ? process3.env.SHELL || true : false,
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
function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}
function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }
  const platform = options.platform ?? process3.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process3.kill.bind(process3);
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
import fs2 from "node:fs";
import os from "node:os";
import path2 from "node:path";

// src/lib/official-plugin.mjs
var OFFICIAL_PLUGIN_STATUS = Object.freeze({
  ACTIVE: "active",
  ABSENT: "absent",
  UNKNOWN: "unknown"
});

// src/lib/git.mjs
import fs from "node:fs";
var MAX_UNTRACKED_BYTES = 24 * 1024;
var DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
var REGULAR_FILE_READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
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

// src/lib/workspace.mjs
function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}

// src/lib/state.mjs
var BRIDGE_PLUGIN_DATA_ENV = "CODEX_BRIDGE_PLUGIN_DATA";
var LEGACY_PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
var FALLBACK_STATE_ROOT_DIR = path2.join(os.tmpdir(), "codex-companion");
function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs2.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }
  const slugSource = path2.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[BRIDGE_PLUGIN_DATA_ENV] || process.env[LEGACY_PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path2.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path2.join(stateRoot, `${slug}-${hash}`);
}

// src/lib/broker-lifecycle.mjs
var BROKER_STATE_FILE = "broker.json";
function createBrokerSessionDir(prefix = "cxc-") {
  return fs3.mkdtempSync(path3.join(os2.tmpdir(), prefix));
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
function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process4.env }) {
  const logFd = fs3.openSync(logFile, "a");
  const child = spawn(process4.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs3.closeSync(logFd);
  return child;
}
function resolveBrokerStateFile(cwd) {
  return path3.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}
function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs3.existsSync(stateFile)) {
    return null;
  }
  try {
    return JSON.parse(fs3.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}
function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs3.mkdirSync(stateDir, { recursive: true });
  fs3.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}
`, "utf8");
}
function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs3.existsSync(stateFile)) {
    fs3.unlinkSync(stateFile);
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
    return path3.basename(modulePath) === "broker-lifecycle.mjs" && path3.basename(path3.dirname(modulePath)) === "lib" && path3.basename(path3.dirname(path3.dirname(modulePath))) === "src";
  } catch {
    return false;
  }
}
function readBrokerLogTail(logFile, maxChars = 4e3) {
  try {
    const log = fs3.readFileSync(logFile, "utf8").trim();
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
function resolveBrokerScriptPath({ moduleUrl = import.meta.url, existsSync = fs3.existsSync } = {}) {
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
  const pidFile = path3.join(sessionDir, "broker.pid");
  const logFile = path3.join(sessionDir, "broker.log");
  const scriptPath = options.scriptPath ?? resolveBrokerScriptPath();
  const timeoutMs = options.timeoutMs ?? 2e3;
  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process4.env
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
}
function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
    }
  }
  if (pidFile && fs3.existsSync(pidFile)) {
    fs3.unlinkSync(pidFile);
  }
  if (logFile && fs3.existsSync(logFile)) {
    fs3.unlinkSync(logFile);
  }
  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs3.existsSync(target.path)) {
        fs3.unlinkSync(target.path);
      }
    } catch {
    }
  }
  const resolvedSessionDir = sessionDir ?? (pidFile ? path3.dirname(pidFile) : logFile ? path3.dirname(logFile) : null);
  if (resolvedSessionDir && fs3.existsSync(resolvedSessionDir)) {
    try {
      fs3.rmdirSync(resolvedSessionDir);
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
      env: this.options.env ?? process5.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process5.platform === "win32" ? process5.env.SHELL || true : false,
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
          if (process5.platform === "win32") {
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
        if (process5.platform === "win32") {
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
      const explicitBrokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process5.env[BROKER_ENDPOINT_ENV] ?? null;
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

// src/adapters/codex/broker.mjs
var STREAMING_METHODS = /* @__PURE__ */ new Set(["turn/start", "review/start", "thread/compact/start"]);
function buildStreamThreadIds(method, params, result) {
  const threadIds = /* @__PURE__ */ new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}
function beginStreamTracking(streamTracker, socket, method, params) {
  if (!STREAMING_METHODS.has(method)) {
    return false;
  }
  streamTracker.registerStream(socket, buildStreamThreadIds(method, params ?? {}, null));
  return true;
}
function finalizeStreamTracking(streamTracker, socket, method, params, result, keepStream) {
  if (!STREAMING_METHODS.has(method)) {
    return false;
  }
  if (keepStream) {
    streamTracker.addStreamThreadIds(socket, buildStreamThreadIds(method, params ?? {}, result));
  } else {
    streamTracker.clearStreamStateIfMatch(socket);
  }
  return true;
}
function createStreamTracker() {
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  let activeCompletedThreadIds = null;
  let pendingThreadCompletions = null;
  function getActiveStreamSocket() {
    return activeStreamSocket;
  }
  function registerStream(socket, threadIds) {
    activeStreamSocket = socket;
    activeStreamThreadIds = threadIds instanceof Set ? threadIds : new Set(threadIds ?? []);
    activeCompletedThreadIds = /* @__PURE__ */ new Set();
    pendingThreadCompletions = /* @__PURE__ */ new Set();
  }
  function addStreamThreadIds(socket, threadIds) {
    if (activeStreamSocket !== socket || !activeStreamThreadIds) {
      return false;
    }
    const justAdded = [];
    for (const threadId of threadIds ?? []) {
      if (!threadId) {
        continue;
      }
      if (!activeStreamThreadIds.has(threadId)) {
        activeStreamThreadIds.add(threadId);
        justAdded.push(threadId);
      }
    }
    let drainedAny = false;
    if (pendingThreadCompletions) {
      for (const threadId of justAdded) {
        if (pendingThreadCompletions.has(threadId)) {
          pendingThreadCompletions.delete(threadId);
          if (!activeCompletedThreadIds) {
            activeCompletedThreadIds = /* @__PURE__ */ new Set();
          }
          activeCompletedThreadIds.add(threadId);
          drainedAny = true;
        }
      }
    }
    if (drainedAny) {
      tryReleaseStream(socket);
    }
    return true;
  }
  function clearAllStreamState() {
    activeStreamSocket = null;
    activeStreamThreadIds = null;
    activeCompletedThreadIds = null;
    pendingThreadCompletions = null;
  }
  function clearStreamStateIfMatch(socket) {
    if (activeStreamSocket === socket) {
      clearAllStreamState();
    }
  }
  function clearStreamStateOnFailedStreamStart(socket) {
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
      pendingThreadCompletions = null;
    }
  }
  function tryReleaseStream(target) {
    if (activeStreamSocket !== target) {
      return false;
    }
    const knownThreads = activeStreamThreadIds ? [...activeStreamThreadIds] : [];
    const completed = activeCompletedThreadIds ?? /* @__PURE__ */ new Set();
    const allKnownComplete = knownThreads.every((id) => completed.has(id));
    if (!allKnownComplete) {
      return false;
    }
    activeStreamSocket = null;
    activeStreamThreadIds = null;
    activeCompletedThreadIds = null;
    pendingThreadCompletions = null;
    return true;
  }
  function noteStreamThreads(message) {
    const item = message?.params?.item ?? null;
    if (item?.type !== "collabAgentToolCall") {
      return;
    }
    if (!activeStreamThreadIds) {
      return;
    }
    addStreamThreadIds(activeStreamSocket, item.receiverThreadIds ?? []);
  }
  function maybeReleaseStream(message, target) {
    if (message?.method !== "turn/completed" || activeStreamSocket !== target) {
      return;
    }
    const threadId = message.params?.threadId ?? null;
    if (!activeCompletedThreadIds) {
      activeCompletedThreadIds = /* @__PURE__ */ new Set();
    }
    if (threadId) {
      if (activeStreamThreadIds && !activeStreamThreadIds.has(threadId)) {
        if (!pendingThreadCompletions) {
          pendingThreadCompletions = /* @__PURE__ */ new Set();
        }
        pendingThreadCompletions.add(threadId);
        return;
      }
      activeCompletedThreadIds.add(threadId);
    } else {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
      activeCompletedThreadIds = null;
      pendingThreadCompletions = null;
      return;
    }
    tryReleaseStream(target);
  }
  return {
    getActiveStreamSocket,
    registerStream,
    addStreamThreadIds,
    clearAllStreamState,
    clearStreamStateIfMatch,
    clearStreamStateOnFailedStreamStart,
    noteStreamThreads,
    maybeReleaseStream,
    tryReleaseStream
  };
}
function buildJsonRpcError2(code, message, data) {
  return data === void 0 ? { code, message } : { code, message, data };
}
function send(socket, message) {
  if (socket.destroyed) {
    return false;
  }
  socket.write(`${JSON.stringify(message)}
`);
  return true;
}
function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}
function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs4.mkdirSync(path4.dirname(pidFile), { recursive: true });
  fs4.writeFileSync(pidFile, `${process6.pid}
`, "utf8");
}
function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}
function safeRejectServerRequest(message, error) {
  try {
    message?._client?.rejectServerRequest?.(message.id, error);
  } catch {
  }
}
function safeResolveServerRequest(message, result) {
  try {
    message?._client?.resolveServerRequest?.(message.id, result ?? {});
  } catch {
  }
}
function cleanupDisconnectedSocket(socket, activeRequestSocket, streamTracker, pendingServerRequests) {
  const retainedUpstreamOwnership = activeRequestSocket === socket || streamTracker.getActiveStreamSocket() === socket;
  for (const [key, pending] of pendingServerRequests) {
    if (pending.socket !== socket) {
      continue;
    }
    pendingServerRequests.delete(key);
    safeRejectServerRequest(
      pending.upstream,
      buildJsonRpcError2(-32e3, "Downstream bridge connection closed before resolving server request.")
    );
  }
  return { retainedUpstreamOwnership };
}
async function main() {
  const [subcommand, ...argv] = process6.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node src/adapters/codex/broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });
  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }
  const cwd = options.cwd ? path4.resolve(process6.cwd(), options.cwd) : process6.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path4.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);
  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  const streamTracker = createStreamTracker();
  let activeRequestSocket = null;
  let activeRequestToken = null;
  const pendingServerRequests = /* @__PURE__ */ new Map();
  const sockets = /* @__PURE__ */ new Set();
  let server = null;
  let shuttingDown = false;
  function cleanupDisconnectedDownstream(socket) {
    cleanupDisconnectedSocket(socket, activeRequestSocket, streamTracker, pendingServerRequests);
  }
  function cleanupBrokerFiles() {
    if (listenTarget.kind === "unix" && fs4.existsSync(listenTarget.path)) {
      try {
        fs4.unlinkSync(listenTarget.path);
      } catch {
      }
    }
    if (pidFile && fs4.existsSync(pidFile)) {
      try {
        fs4.unlinkSync(pidFile);
      } catch {
      }
    }
  }
  function clearAllOwnership() {
    activeRequestSocket = null;
    activeRequestToken = null;
    streamTracker.clearAllStreamState();
    pendingServerRequests.clear();
  }
  function closeDownstreamSockets(error) {
    const payload = error?.message ? `Upstream codex app-server exited: ${error.message}` : "Upstream codex app-server exited.";
    for (const socket of sockets) {
      send(socket, {
        id: null,
        error: buildJsonRpcError2(-32e3, payload)
      });
      socket.destroy();
    }
    sockets.clear();
  }
  function handleUpstreamExit(error) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearAllOwnership();
    closeDownstreamSockets(error);
    server?.close?.(() => {
    });
    cleanupBrokerFiles();
    setImmediate(() => process6.exit(error ? 1 : 0));
  }
  function routeNotification(message) {
    let target = activeRequestSocket ?? streamTracker.getActiveStreamSocket();
    if (message.method === "serverRequest/resolved") {
      const key = requestKey(message.params?.requestId);
      const pending = pendingServerRequests.get(key);
      if (pending) {
        pendingServerRequests.delete(key);
        target = pending.socket;
      }
    }
    if (!target) {
      return;
    }
    streamTracker.noteStreamThreads(message);
    send(target, message);
    streamTracker.maybeReleaseStream(message, target);
  }
  function routeServerRequest(message) {
    const target = activeRequestSocket ?? streamTracker.getActiveStreamSocket();
    if (!target) {
      safeRejectServerRequest(
        message,
        buildJsonRpcError2(-32e3, `No active downstream client for server request: ${message.method}`)
      );
      return;
    }
    pendingServerRequests.set(requestKey(message.id), { socket: target, upstream: message });
    if (!send(target, { id: message.id, method: message.method, params: message.params ?? {} })) {
      pendingServerRequests.delete(requestKey(message.id));
      safeRejectServerRequest(
        message,
        buildJsonRpcError2(-32e3, `Failed to forward server request: ${message.method}`)
      );
    }
  }
  async function shutdown(server2) {
    shuttingDown = true;
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {
    });
    await new Promise((resolve) => server2.close(resolve));
    cleanupBrokerFiles();
  }
  appClient.setNotificationHandler(routeNotification);
  appClient.setServerRequestHandler(routeServerRequest);
  appClient.on?.("exit", handleUpstreamExit);
  server = net3.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line.trim()) {
          continue;
        }
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError2(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }
        if (message.id !== void 0 && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }
        if (message.method === "initialized" && message.id === void 0) {
          continue;
        }
        if (message.id !== void 0 && !message.method) {
          const key = requestKey(message.id);
          const pending = pendingServerRequests.get(key);
          if (pending && pending.socket === socket) {
            pendingServerRequests.delete(key);
            if (message.error) {
              safeRejectServerRequest(pending.upstream, message.error);
            } else {
              safeResolveServerRequest(pending.upstream, message.result ?? {});
            }
            continue;
          }
          send(socket, {
            id: message.id,
            error: buildJsonRpcError2(-32603, `No pending server request response for id ${String(message.id)}.`)
          });
          continue;
        }
        if (message.id !== void 0 && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process6.exit(0);
        }
        if (message.id === void 0) {
          continue;
        }
        const activeStreamSocket = streamTracker.getActiveStreamSocket();
        const allowInterruptDuringActiveStream = (
          // Invariant: non-stream concurrent requests are already
          // busy-rejected before this carve-out runs, so activeRequestSocket
          // is always null here. The guard is defensive against future
          // changes to STREAMING_METHODS that could introduce a non-stream
          // request that is allowed to coexist with a stream.
          isInterruptRequest(message) && activeStreamSocket && !activeRequestSocket
        );
        if ((activeRequestSocket || activeStreamSocket) && !allowInterruptDuringActiveStream) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError2(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }
        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError2(error.rpcCode ?? -32e3, error.message)
            });
          }
          continue;
        }
        const isStreaming = STREAMING_METHODS.has(message.method);
        const requestToken = Symbol(message.method);
        activeRequestSocket = socket;
        activeRequestToken = requestToken;
        if (isStreaming) {
          beginStreamTracking(streamTracker, socket, message.method, message.params ?? {});
        }
        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming) {
            finalizeStreamTracking(
              streamTracker,
              socket,
              message.method,
              message.params ?? {},
              result,
              true
            );
          }
          if (activeRequestToken === requestToken) {
            activeRequestSocket = null;
            activeRequestToken = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError2(error.rpcCode ?? -32e3, error.message)
          });
          if (activeRequestToken === requestToken) {
            activeRequestSocket = null;
            activeRequestToken = null;
          }
          if (isStreaming) {
            streamTracker.clearStreamStateOnFailedStreamStart(socket);
          }
        }
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      cleanupDisconnectedDownstream(socket);
    });
    socket.on("error", () => {
      sockets.delete(socket);
      cleanupDisconnectedDownstream(socket);
    });
  });
  process6.on("SIGTERM", async () => {
    await shutdown(server);
    process6.exit(0);
  });
  process6.on("SIGINT", async () => {
    await shutdown(server);
    process6.exit(0);
  });
  server.listen(listenTarget.path);
}
var invokedDirectly = (() => {
  if (!process6.argv[1]) {
    return false;
  }
  try {
    const entryUrl = pathToFileURL(process6.argv[1]).href;
    return entryUrl === import.meta.url;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((error) => {
    process6.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process6.exit(1);
  });
}
var __testHooks__ = {
  createStreamTracker,
  buildStreamThreadIds,
  beginStreamTracking,
  cleanupDisconnectedSocket,
  finalizeStreamTracking,
  STREAMING_METHODS
};
export {
  __testHooks__
};
