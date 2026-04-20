#!/usr/bin/env node

// src/app-server-broker.mjs
import fs3 from "node:fs";
import net3 from "node:net";
import path4 from "node:path";
import process6 from "node:process";

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

// src/lib/app-server.mjs
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
import fs2 from "node:fs";
import net from "node:net";
import os2 from "node:os";
import path3 from "node:path";
import process4 from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// src/lib/state.mjs
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path2 from "node:path";

// src/lib/process.mjs
import { spawnSync } from "node:child_process";
import process3 from "node:process";
function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: process3.platform === "win32" ? process3.env.SHELL || true : false,
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

// src/lib/git.mjs
var MAX_UNTRACKED_BYTES = 24 * 1024;
var DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
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
var PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
var FALLBACK_STATE_ROOT_DIR = path2.join(os.tmpdir(), "codex-companion");
function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }
  const slugSource = path2.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path2.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path2.join(stateRoot, `${slug}-${hash}`);
}

// src/lib/broker-lifecycle.mjs
var BROKER_STATE_FILE = "broker.json";
function createBrokerSessionDir(prefix = "cxc-") {
  return fs2.mkdtempSync(path3.join(os2.tmpdir(), prefix));
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
  const logFd = fs2.openSync(logFile, "a");
  const child = spawn(process4.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs2.closeSync(logFd);
  return child;
}
function resolveBrokerStateFile(cwd) {
  return path3.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}
function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs2.existsSync(stateFile)) {
    return null;
  }
  try {
    return JSON.parse(fs2.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}
function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs2.mkdirSync(stateDir, { recursive: true });
  fs2.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}
`, "utf8");
}
function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs2.existsSync(stateFile)) {
    fs2.unlinkSync(stateFile);
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
  const scriptPath = options.scriptPath ?? fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));
  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process4.env
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
  if (pidFile && fs2.existsSync(pidFile)) {
    fs2.unlinkSync(pidFile);
  }
  if (logFile && fs2.existsSync(logFile)) {
    fs2.unlinkSync(logFile);
  }
  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs2.existsSync(target.path)) {
        fs2.unlinkSync(target.path);
      }
    } catch {
    }
  }
  const resolvedSessionDir = sessionDir ?? (pidFile ? path3.dirname(pidFile) : logFile ? path3.dirname(logFile) : null);
  if (resolvedSessionDir && fs2.existsSync(resolvedSessionDir)) {
    try {
      fs2.rmdirSync(resolvedSessionDir);
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
  constructor(cwd, options = {}) {
    this.cwd = cwd;
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
  constructor(cwd, options = {}) {
    super(cwd, options);
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
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process5.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint }) : new SpawnedCodexAppServerClient(cwd, options);
    await client.initialize();
    return client;
  }
};

// src/app-server-broker.mjs
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
function buildJsonRpcError2(code, message, data) {
  return data === void 0 ? { code, message } : { code, message, data };
}
function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}
`);
}
function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}
function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs3.mkdirSync(path4.dirname(pidFile), { recursive: true });
  fs3.writeFileSync(pidFile, `${process6.pid}
`, "utf8");
}
async function main() {
  const [subcommand, ...argv] = process6.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
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
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  const sockets = /* @__PURE__ */ new Set();
  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }
  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }
  async function shutdown(server2) {
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {
    });
    await new Promise((resolve) => server2.close(resolve));
    if (listenTarget.kind === "unix" && fs3.existsSync(listenTarget.path)) {
      fs3.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs3.existsSync(pidFile)) {
      fs3.unlinkSync(pidFile);
    }
  }
  appClient.setNotificationHandler(routeNotification);
  const server = net3.createServer((socket) => {
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
        if (message.id !== void 0 && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process6.exit(0);
        }
        if (message.id === void 0) {
          continue;
        }
        const allowInterruptDuringActiveStream = isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;
        if ((activeRequestSocket && activeRequestSocket !== socket || activeStreamSocket && activeStreamSocket !== socket) && !allowInterruptDuringActiveStream) {
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
        activeRequestSocket = socket;
        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError2(error.rpcCode ?? -32e3, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && isStreaming) {
            activeStreamSocket = null;
            activeStreamThreadIds = null;
          }
        }
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });
    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
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
main().catch((error) => {
  process6.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
  process6.exit(1);
});
