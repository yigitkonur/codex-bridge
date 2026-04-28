/**
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").ReviewTarget} ReviewTarget
 * @typedef {import("./app-server-protocol").ThreadItem} ThreadItem
 * @typedef {import("./app-server-protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./app-server-protocol").ThreadStartParams} ThreadStartParams
 * @typedef {import("./app-server-protocol").Turn} Turn
 * @typedef {import("./app-server-protocol").UserInput} UserInput
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   threadId: string,
 *   rootThreadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   threadLabels: Map<string, string>,
 *   turnId: string | null,
 *   bufferedNotifications: AppServerNotification[],
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: Turn | null,
 *   completed: boolean,
 *   pendingCollaborations: Set<string>,
 *   activeSubagentTurns: Set<string>,
 *   lastAgentMessage: string,
 *   reviewText: string,
 *   reasoningSummary: string[],
 *   error: unknown,
 *   messages: Array<{ lifecycle: string, phase: string | null, text: string }>,
 *   fileChanges: ThreadItem[],
 *   commandExecutions: ThreadItem[],
 *   onProgress: ProgressReporter | null,
 *   onItemCompleted: ((item: ThreadItem, context: { threadId: string | null }) => void) | null
 * }} TurnCaptureState
 */
import { readJsonFile } from "./fs.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { CliError } from "./cli-errors.mjs";
import { binaryAvailable } from "./process.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
const TURN_INTERRUPT_GRACE_MS = 30_000;
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

/** @returns {ThreadStartParams} */
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

/** @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: "never",
    sandbox: options.sandbox ?? "read-only"
  };
}

/** @returns {UserInput[]} */
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
  const paths = new Set();
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

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
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
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
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
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
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
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

/** @returns {TurnCaptureState} */
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
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
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

function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }

  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    // Honor explicit `inferredStatus` from the caller (idle-timeout /
    // process-death / error notifications all pass "failed"). Defaulting to
    // "completed" on every inferred completion would let timeouts return exit 0.
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
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
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
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null
            }
          : {}
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
          // User callback must never kill the captor.
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
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      {
        const completedTurn = message.params.turn;
        // Per upstream spec, `codexErrorInfo` lives on `turn.error`, not on the
        // prior `error` notification payload. Hoist it onto `state.error` so
        // classifyError can map it to retryable/class/suggestion instead of
        // falling through to {class:"internal", retryable:false}.
        if (completedTurn?.status !== "completed" && completedTurn?.error) {
          state.error = { ...(state.error ?? {}), ...completedTurn.error };
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

export async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;

  const idleTimeoutMs = Number(options.idleTimeoutMs) > 0 ? Number(options.idleTimeoutMs) : 0;
  const turnTimeoutMs = Number(options.turnTimeoutMs) > 0 ? Number(options.turnTimeoutMs) : 0;
  let lastNotificationAt = Date.now();
  let idleInterval = null;
  let turnTimer = null;
  let interruptGraceTimer = null;
  // AbortController used to clean up the abandoned `startRequest()` pending entry
  // when `state.completion` wins the race below. Without this, `client.pending`
  // accumulates one stale entry per aborted turn until the next `handleExit`
  // drains it — bounded but real on long-lived broker sessions.
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
    const checkIntervalMs = Math.min(5000, idleTimeoutMs);
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
        const seconds = Math.round(idleTimeoutMs / 1000);
        state.error = { message: `No events received for ${seconds}s (idle timeout).` };
        emitProgress(state.onProgress, state.error.message, "failed");
        if (typeof options.onIdleTimeout === "function") {
          try {
            options.onIdleTimeout({ threadId: state.threadId, turnId: state.turnId, elapsedMs: elapsed });
          } catch {
            // Diagnostic hook must not block completion.
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
        const interruptGraceMs =
          Number(options.interruptGraceMs) > 0 ? Number(options.interruptGraceMs) : TURN_INTERRUPT_GRACE_MS;
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
      if (
        messageThreadId === state.threadId &&
        (message.method === "turn/started" || message.method === "turn/completed")
      ) {
        applyTurnNotification(state, message);
        flushBufferedNotifications(state, previousHandler);
        return;
      }
      state.bufferedNotifications.push(message);
      return;
    }

    routeTurnNotification(state, message, previousHandler);
  });

  // Handle process death: reject completion instead of hanging forever.
  // If a buffered terminal `turn/completed` for this thread has already arrived
  // ahead of `state.turnId`, replay it through `applyTurnNotification` so the
  // captured terminal status wins instead of being misclassified as a crash.
  const onExit = () => {
    if (state.completed) {
      return;
    }
    const bufferedTerminal = state.bufferedNotifications.find(
      (message) =>
        message?.method === "turn/completed" &&
        (message?.params?.threadId ?? null) === state.threadId
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
      // state.completion won the race (process exit, idle timeout, turn timeout,
      // or buffered-terminal-on-exit flush). Abort the abandoned startRequest so
      // its pending entry is removed from client.pending instead of leaking
      // until the next handleExit.
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
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
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
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
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
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

const BUILTIN_PROVIDER_LABELS = new Map([
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
  const providers =
    config.model_providers && typeof config.model_providers === "object" && !Array.isArray(config.model_providers)
      ? config.model_providers
      : null;
  const providerConfig =
    providerId && providers?.[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;

  return {
    providerId,
    providerConfig
  };
}

function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
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

export function getCodexAvailability(cwd) {
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

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
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

export async function getCodexAuthStatus(cwd, options = {}) {
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
      await client.close().catch(() => {});
    }
  }
}

export async function interruptAppServerTurn(cwd, { threadId, turnId }) {
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
    await client?.close().catch(() => {});
  }
}

export async function runAppServerReview(cwd, options = {}) {
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
      (signal) =>
        client.request("review/start", {
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

export async function runAppServerTurn(cwd, options = {}) {
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

    // Hook: allow caller to handle server requests (e.g., requestUserInput)
    if (options.onServerRequest) {
      client.setServerRequestHandler(async (message) => {
        const finishServerRequest =
          typeof markServerRequestActivity?.startServerRequest === "function"
            ? markServerRequestActivity.startServerRequest()
            : null;
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
      outputSchema: options.outputSchema ?? null,
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
        // Pre-turn diagnostics must not block the turn — but silencing the
        // error category entirely is what let the v1.2.0 background-path
        // regression ship without detection. Surface through `onProgress`
        // so the per-job `.log` (and therefore the job record) captures
        // whatever the hook threw. Detached workers with `stdio: "ignore"`
        // depend on this path for visibility.
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

export async function findLatestTaskThread(cwd) {
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

    return (
      response.data.find((thread) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)) ??
      null
    );
  });
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
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

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX, withAppServer };
