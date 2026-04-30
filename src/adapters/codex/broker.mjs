#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "../../lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./protocol.mjs";
import { parseBrokerEndpoint } from "../../lib/broker-endpoint.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

// Encapsulates the broker's stream-ownership state machine. Extracted so the
// stream-release ordering invariants (incl. early-arrival completion
// reconciliation) can be exercised directly in tests without spinning up a
// real socket pair. Exported via `__testHooks__` only — production code
// constructs one instance inside `main()`.
function createStreamTracker() {
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  let activeCompletedThreadIds = null;
  // Holds thread IDs whose turn/completed notification arrived BEFORE the
  // collabAgentToolCall that registers them as receiver threads. When the
  // matching collabAgentToolCall later registers those threads, they are
  // promoted to completed and the release condition is re-evaluated.
  let pendingThreadCompletions = null;

  function getActiveStreamSocket() {
    return activeStreamSocket;
  }

  function registerStream(socket, threadIds) {
    activeStreamSocket = socket;
    activeStreamThreadIds = threadIds instanceof Set ? threadIds : new Set(threadIds ?? []);
    activeCompletedThreadIds = new Set();
    pendingThreadCompletions = new Set();
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
    // Mirrors the legacy failed-streaming-request branch: clear socket and
    // thread sets but leave activeCompletedThreadIds untouched (preserves
    // historical behavior at app-server-broker.mjs:375-378).
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
    // Match the legacy `[...threads].every(...)` semantics: an empty
    // activeStreamThreadIds set is vacuously complete (e.g., a turn/start
    // was issued without a known threadId). Without this, streams whose
    // initial registration carried no thread id would never release.
    const knownThreads = activeStreamThreadIds ? [...activeStreamThreadIds] : [];
    const completed = activeCompletedThreadIds ?? new Set();
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
    const justAdded = [];
    for (const threadId of item.receiverThreadIds ?? []) {
      if (!threadId) {
        continue;
      }
      if (!activeStreamThreadIds.has(threadId)) {
        activeStreamThreadIds.add(threadId);
        justAdded.push(threadId);
      }
    }
    // Drain any pre-arrived completions for the threads we just registered:
    // their turn/completed notification fired before this collabAgentToolCall.
    let drainedAny = false;
    if (pendingThreadCompletions) {
      for (const threadId of justAdded) {
        if (pendingThreadCompletions.has(threadId)) {
          pendingThreadCompletions.delete(threadId);
          if (!activeCompletedThreadIds) {
            activeCompletedThreadIds = new Set();
          }
          activeCompletedThreadIds.add(threadId);
          drainedAny = true;
        }
      }
    }
    // Only re-evaluate release when we actually reconciled a pending
    // completion — otherwise the empty-threads vacuous-truth path in
    // tryReleaseStream could incorrectly release a stream whose first
    // collabAgentToolCall arrived with no receiver threads.
    if (drainedAny) {
      tryReleaseStream(activeStreamSocket);
    }
  }

  function maybeReleaseStream(message, target) {
    if (message?.method !== "turn/completed" || activeStreamSocket !== target) {
      return;
    }
    const threadId = message.params?.threadId ?? null;
    if (!activeCompletedThreadIds) {
      activeCompletedThreadIds = new Set();
    }
    if (threadId) {
      // Early-arrival case: if the thread is not yet registered as a known
      // stream thread (its collabAgentToolCall has not arrived), stage the
      // completion for later reconciliation by noteStreamThreads instead of
      // dropping it.
      if (activeStreamThreadIds && !activeStreamThreadIds.has(threadId)) {
        if (!pendingThreadCompletions) {
          pendingThreadCompletions = new Set();
        }
        pendingThreadCompletions.add(threadId);
        return;
      }
      activeCompletedThreadIds.add(threadId);
    } else {
      // Null threadId: release the stream unconditionally (legacy behavior
      // for terminal notifications without a thread association).
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
    clearAllStreamState,
    clearStreamStateIfMatch,
    clearStreamStateOnFailedStreamStart,
    noteStreamThreads,
    maybeReleaseStream,
    tryReleaseStream
  };
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return false;
  }
  socket.write(`${JSON.stringify(message)}\n`);
  return true;
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

function safeRejectServerRequest(message, error) {
  try {
    message?._client?.rejectServerRequest?.(message.id, error);
  } catch {
    // The upstream app-server may already be gone. Cleanup must continue.
  }
}

function safeResolveServerRequest(message, result) {
  try {
    message?._client?.resolveServerRequest?.(message.id, result ?? {});
  } catch {
    // The upstream app-server may already be gone. Cleanup must continue.
  }
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node src/adapters/codex/broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  const streamTracker = createStreamTracker();
  let activeRequestSocket = null;
  let activeRequestToken = null;
  const pendingServerRequests = new Map();
  const sockets = new Set();
  let server = null;
  let shuttingDown = false;

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
      activeRequestToken = null;
    }
    streamTracker.clearStreamStateIfMatch(socket);
    for (const [key, pending] of pendingServerRequests) {
      if (pending.socket !== socket) {
        continue;
      }
      pendingServerRequests.delete(key);
      safeRejectServerRequest(
        pending.upstream,
        buildJsonRpcError(-32000, "Downstream bridge connection closed before resolving server request.")
      );
    }
  }

  function cleanupBrokerFiles() {
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      try { fs.unlinkSync(listenTarget.path); } catch { /* best effort */ }
    }
    if (pidFile && fs.existsSync(pidFile)) {
      try { fs.unlinkSync(pidFile); } catch { /* best effort */ }
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
        error: buildJsonRpcError(-32000, payload)
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
    server?.close?.(() => {});
    cleanupBrokerFiles();
    setImmediate(() => process.exit(error ? 1 : 0));
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
        buildJsonRpcError(-32000, `No active downstream client for server request: ${message.method}`)
      );
      return;
    }
    pendingServerRequests.set(requestKey(message.id), { socket: target, upstream: message });
    if (!send(target, { id: message.id, method: message.method, params: message.params ?? {} })) {
      pendingServerRequests.delete(requestKey(message.id));
      safeRejectServerRequest(
        message,
        buildJsonRpcError(-32000, `Failed to forward server request: ${message.method}`)
      );
    }
  }

  async function shutdown(server) {
    shuttingDown = true;
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    cleanupBrokerFiles();
  }

  appClient.setNotificationHandler(routeNotification);
  appClient.setServerRequestHandler(routeServerRequest);
  appClient.on?.("exit", handleUpstreamExit);

  server = net.createServer((socket) => {
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
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && !message.method) {
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
            error: buildJsonRpcError(-32603, `No pending server request response for id ${String(message.id)}.`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        const activeStreamSocket = streamTracker.getActiveStreamSocket();
        const allowInterruptDuringActiveStream =
          // Invariant: non-stream concurrent requests are already
          // busy-rejected before this carve-out runs, so activeRequestSocket
          // is always null here. The guard is defensive against future
          // changes to STREAMING_METHODS that could introduce a non-stream
          // request that is allowed to coexist with a stream.
          isInterruptRequest(message) && activeStreamSocket && !activeRequestSocket;

        if (
          (activeRequestSocket || activeStreamSocket) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
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
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        const requestToken = Symbol(message.method);
        activeRequestSocket = socket;
        activeRequestToken = requestToken;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          const responseSent = send(socket, { id: message.id, result });
          if (isStreaming && responseSent && sockets.has(socket) && !socket.destroyed) {
            streamTracker.registerStream(
              socket,
              buildStreamThreadIds(message.method, message.params ?? {}, result)
            );
          }
          if (activeRequestToken === requestToken) {
            activeRequestSocket = null;
            activeRequestToken = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestToken === requestToken) {
            activeRequestSocket = null;
            activeRequestToken = null;
          }
          // Only clear stream ownership if THIS failed request was the stream
          // itself. A failed non-stream request on the same socket must not
          // orphan an in-flight turn — stream ownership is released by
          // turn/completed or by socket close/error, not by unrelated per-
          // request failures.
          if (isStreaming) {
            streamTracker.clearStreamStateOnFailedStreamStart(socket);
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

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

// Only run main() when invoked as a CLI entry point. Tests that import this
// module to exercise __testHooks__ must not trigger broker startup.
const invokedDirectly = (() => {
  if (!process.argv[1]) {
    return false;
  }
  try {
    const entryUrl = new URL(`file://${process.argv[1]}`).href;
    return entryUrl === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

// Test-only hooks. Not part of the public API; consumers must not depend on
// the shape of this object outside the codex-bridge test suite.
export const __testHooks__ = {
  createStreamTracker,
  buildStreamThreadIds,
  STREAMING_METHODS
};
