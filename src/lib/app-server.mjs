/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;
export const APP_SERVER_INITIALIZE_TIMEOUT_MS = 10_000;
export const APP_SERVER_SHUTDOWN_TIMEOUT_MS = 5_000;

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Bridge",
  name: "codex_bridge",
  version: "1.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: true,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
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

export class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.transportClosed = false;
    this.exitError = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";
    this.serverRequestHandler = null;
    this.listeners = new Map();

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    // Distinct from exitPromise: only resolves when the underlying transport
    // (child process / socket) has truly ended. close() awaits this so a
    // logical protocol failure that pre-resolved exitPromise still blocks
    // until child cleanup completes.
    this.transportExitPromise = new Promise((resolve) => {
      this.resolveTransportExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  on(eventName, handler) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
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
        // Listener failures must not break the transport.
      }
    }
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
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
      // Logical protocol failure — the transport (child stdout / socket) is
      // still alive. Mark the client closed but leave transportClosed=false
      // so close() can still end stdin and reap the child.
      this.handleExit(
        createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }),
        { transportExited: false }
      );
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
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
      this.notificationHandler(/** @type {AppServerNotification} */ (message));
    }
  }

  handleServerRequest(message) {
    const method = message.method;

    if (this.serverRequestHandler) {
      message._client = this;
      Promise.resolve(this.serverRequestHandler(message)).catch((error) => {
        this.rejectServerRequest(
          message.id,
          buildJsonRpcError(-32000, error?.message ?? `Server request handler failed for ${method}.`)
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
    // `transportExited` distinguishes a real transport end (process/socket
    // closed) from a logical protocol failure (e.g. JSON parse error in
    // handleLine) where the underlying child/socket is still alive and
    // close() must still tear it down. Promote `transportClosed` (and
    // resolve transportExitPromise) only on real exit; a later transport
    // callback fired after a logical failure still flips the flag here.
    if (transportExited && !this.transportClosed) {
      this.transportClosed = true;
      this.resolveTransportExit(undefined);
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
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    this.proc = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
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
      const detail =
        code === 0
          ? null
          : createProtocolError(`codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`);
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
          // On Windows with shell: true, the direct child is cmd.exe.
          // Use terminateProcessTree to kill the entire tree including
          // the grandchild node process.
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // Best-effort cleanup inside an unref'd timer — swallow errors
              // to avoid crashing the host process during shutdown.
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
        if (process.platform === "win32") {
          try {
            terminateProcessTree(this.proc.pid);
          } catch {
            // Best effort.
          }
        } else {
          this.proc.kill("SIGKILL");
        }
      }
      this.handleExit(error);
    }
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
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
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await withTimeout(new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
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
    const line = `${JSON.stringify(message)}\n`;
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
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    try {
      await client.initialize();
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
    return client;
  }
}
