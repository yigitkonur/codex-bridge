import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  interruptAppServerTurn,
  runAppServerTurn,
  withAppServer,
} from "./codex.mjs";
import { readPendingRequestById, writeResponseFile } from "../../lib/pending-requests.mjs";
import {
  classifyStderr,
  readEvents,
  readWorkerErrTail,
  resolveSessionDir,
  TERMINAL_TAG_REGEX,
  TERMINAL_TAGS,
  WORKER_STDERR_TAIL_BYTES,
} from "../../lib/session-log.mjs";
import { buildSingleJobSnapshot, readStoredJob, resolveResultJob } from "../../lib/job-control.mjs";
import { loadConfig } from "../../lib/config.mjs";

const ADAPTER_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT_DIR = path.resolve(ADAPTER_DIR, "../..");
const BUNDLE_ROOT_DIR = path.resolve(ADAPTER_DIR, "..");
const CONFIG_ROOT_DIR = fs.existsSync(path.join(SOURCE_ROOT_DIR, "schemas"))
  ? SOURCE_ROOT_DIR
  : fs.existsSync(path.join(BUNDLE_ROOT_DIR, "schemas"))
    ? BUNDLE_ROOT_DIR
    : null;

function buildCapabilities() {
  return Object.freeze({
    supports_plan_mode:           true,
    supports_questions:           true,
    supports_streaming:           true,
    supports_resume:              true,
    supports_steering:            true,
    supports_background:          true,
    supports_auto_pipeline:       true,
    supports_adversarial_review:  true,
    supports_worktree:            true,
    supports_artifact_registry:   true,
    input_modalities:             ["text"],
    output_modalities:            ["text", "diff", "structured"],
    max_prompt_chars:             512000,
    billing_model:                "subscription",
    auth_strategy:                "oauth-cli",
    transport:                    "json-rpc-unix-socket",
  });
}

const defaultRuntime = Object.freeze({
  async runTurn(cwd, options) {
    return runAppServerTurn(cwd, options);
  },
  async steerTurn(cwd, { threadId, turnId, prompt }) {
    await withAppServer(cwd, async (client) => {
      await client.request("turn/steer", {
        threadId,
        input: [{ type: "text", text: prompt }],
        expectedTurnId: turnId,
      });
    });
    return { ok: true, threadId, turnId };
  },
  async interruptTurn(cwd, { threadId, turnId }) {
    return interruptAppServerTurn(cwd, { threadId, turnId });
  },
});

let runtime = defaultRuntime;

function normalizeAdapterOptions(options = {}) {
  return options && typeof options === "object" && !Array.isArray(options)
    ? options
    : {};
}

function defaultSessionDirForCwd(cwd, workspaceRoot = cwd) {
  const config = loadConfig(CONFIG_ROOT_DIR, cwd, workspaceRoot);
  return resolveSessionDir(config.session_dir, workspaceRoot);
}

function buildTurnOptions(prompt, options) {
  const adapterOptions = normalizeAdapterOptions(options.adapterOptions);
  const turnOptions = {
    ...(normalizeAdapterOptions(adapterOptions.turnOptions)),
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
    prompt,
  };
}

function eventTagForLine(line) {
  const terminal = TERMINAL_TAG_REGEX.exec(line);
  if (terminal) return terminal[1];
  const generic = /^\[([^\]]+)\]/.exec(line);
  return generic?.[1] ?? "ADAPTER:codex:event";
}

const EVENT_TERMINAL_PHASE = Object.freeze({
  DONE: "done",
  ERROR: "error",
  INCOMPLETE: "incomplete",
  PLAN: "plan-pending",
  CANCELLED: "cancelled",
  UNKNOWN: "error",
});

const SUCCESS_TERMINAL_TAGS = new Set(["DONE", "PLAN"]);

function workerTerminalTagForStatus(status) {
  switch (status) {
    case "completed":
      return "DONE";
    case "failed":
    case "orphaned":
      return "ERROR";
    case "cancelled":
      return "CANCELLED";
    default:
      return null;
  }
}

function workerExitCodeForStatus(status) {
  return status === "completed" ? 0 : 1;
}

function exitCodeForTerminalTag(tag, workerExitCode) {
  if (!tag) return workerExitCode;
  return SUCCESS_TERMINAL_TAGS.has(tag) ? 0 : 1;
}

function phaseForTerminalTag(tag, fallback) {
  return EVENT_TERMINAL_PHASE[tag] ?? fallback ?? "error";
}

function firstEventLine(block) {
  return String(block ?? "").split(/\r?\n/, 1)[0] ?? "";
}

function bracketTagForEventBlock(block) {
  return /^\[([^\]]+)\]/.exec(firstEventLine(block))?.[1] ?? null;
}

function resolveStoredEventsPath(storedJob, threadId, cwd, workspaceRoot, options) {
  const candidates = [
    options.eventsPath,
    storedJob?.result?.eventsPath,
    storedJob?.result?.artifacts?.eventsPath,
    storedJob?.eventsPath,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  if (!threadId) return null;
  const eventDirs = [
    options.sessionDir,
    storedJob?.result?.eventsDir,
    storedJob?.result?.artifacts?.eventsDir,
    storedJob?.eventsDir,
  ];
  const configuredEventDir = eventDirs.find((candidate) => typeof candidate === "string" && candidate.trim());
  const sessionDir = configuredEventDir
    ? resolveSessionDir(configuredEventDir, workspaceRoot ?? cwd)
    : defaultSessionDirForCwd(cwd, workspaceRoot);
  return path.join(sessionDir, `${threadId}.events`);
}

function readEventTerminalState(eventsPath) {
  if (!eventsPath || !fs.existsSync(eventsPath)) {
    return { found: false, eventsPath: eventsPath ?? null, eventsFileExists: false };
  }

  const events = readEvents(eventsPath);
  let pipelineFailed = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const rawTag = bracketTagForEventBlock(events[index]);
    if (rawTag === "PIPELINE:failed") {
      pipelineFailed = {
        tag: "INCOMPLETE",
        rawTag,
        line: firstEventLine(events[index]),
      };
      continue;
    }
    if (TERMINAL_TAGS.includes(rawTag)) {
      if (pipelineFailed && rawTag !== "ERROR") {
        return {
          found: true,
          ...pipelineFailed,
          eventsPath,
          source: "pipeline-failed",
        };
      }
      return {
        found: true,
        tag: rawTag,
        rawTag,
        line: firstEventLine(events[index]),
        eventsPath,
        source: "events-terminal",
      };
    }
  }

  if (pipelineFailed) {
    return {
      found: true,
      ...pipelineFailed,
      eventsPath,
      source: "pipeline-failed",
    };
  }

  return {
    found: true,
    tag: "UNKNOWN",
    rawTag: null,
    line: null,
    eventsPath,
    source: "events-missing-terminal",
  };
}

function formatDiscrepancyReason(eventState, terminalTag, workerTerminalTag, workerExitCode) {
  const eventTag = eventState.rawTag ? `[${eventState.rawTag}]` : "no terminal tag";
  const classification =
    eventState.rawTag && eventState.rawTag !== terminalTag
      ? `, classified as [${terminalTag}]`
      : "";
  return `events emitted ${eventTag}${classification} but worker status implied [${workerTerminalTag ?? "UNKNOWN"}] (workerExitCode=${workerExitCode})`;
}

async function dispatch(prompt, options = {}) {
  const normalized = normalizeAdapterOptions(options);
  const cwd = normalized.cwd ?? process.cwd();
  const sessionDir = normalized.sessionDir ?? defaultSessionDirForCwd(cwd);
  const result = await runtime.runTurn(cwd, buildTurnOptions(prompt, normalized));
  return {
    jobId: normalized.jobId ?? result.threadId ?? null,
    threadId: result.threadId ?? null,
    turnId: result.turnId ?? null,
    sessionDir,
    capabilities: buildCapabilities(),
    status: result.status,
    rawResult: result,
  };
}

async function resume(threadId, prompt, options = {}) {
  const normalized = normalizeAdapterOptions(options);
  return dispatch(prompt, {
    ...normalized,
    resumeThreadId: threadId,
    adapterOptions: {
      ...(normalizeAdapterOptions(normalized.adapterOptions)),
      turnOptions: {
        ...(normalizeAdapterOptions(normalized.adapterOptions?.turnOptions)),
        resumeThreadId: threadId,
      },
    },
  });
}

async function steer(threadId, turnId, prompt, options = {}) {
  const cwd = normalizeAdapterOptions(options).cwd ?? process.cwd();
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
    payload: answer,
  });
  return {
    ok: true,
    requestId,
    threadId: pending.threadId,
  };
}

async function cancel(_jobId, options = {}) {
  const normalized = normalizeAdapterOptions(options);
  const result = await runtime.interruptTurn(normalized.cwd ?? process.cwd(), {
    threadId: normalized.threadId ?? null,
    turnId: normalized.turnId ?? null,
  });
  return {
    ok: result.interrupted !== false,
    attempted: Boolean(result.attempted),
    interrupted: Boolean(result.interrupted),
    reason: result.detail ?? null,
  };
}

// Build a `workerErr` summary for `result --json` from the per-job
// `<logFile>.worker.err` sidecar. Returns null when there is no log file
// path on record or the file is missing/empty — so consumers can branch
// on `result.adapterResult.workerErr === null` without inspecting the
// disk themselves. Task 20 / F-44 deliverable.
function buildWorkerErrSummary(job, storedJob) {
  const logFile = job?.logFile ?? storedJob?.logFile ?? null;
  if (!logFile) return null;
  const workerErrPath = `${logFile}.worker.err`;
  const tailInfo = readWorkerErrTail(workerErrPath, WORKER_STDERR_TAIL_BYTES);
  if (!tailInfo || tailInfo.totalBytes === 0) {
    return null;
  }
  return {
    path: workerErrPath,
    size_bytes: tailInfo.totalBytes,
    tail: tailInfo.tail,
    truncated: Boolean(tailInfo.truncated),
    error_class_hint: classifyStderr(tailInfo.tail),
  };
}

async function getResult(jobId, options = {}) {
  const normalized = normalizeAdapterOptions(options);
  const cwd = normalized.cwd ?? process.cwd();
  const { workspaceRoot, job } = resolveResultJob(cwd, jobId);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const workerExitCode = workerExitCodeForStatus(job.status);
  const workerTerminalTag = workerTerminalTagForStatus(job.status);
  const eventsPath = resolveStoredEventsPath(storedJob, job.threadId ?? storedJob?.threadId ?? null, cwd, workspaceRoot, normalized);
  const eventState = readEventTerminalState(eventsPath);
  const terminalTag = eventState.found ? eventState.tag : workerTerminalTag;
  const consistent = !eventState.found || workerTerminalTag === null || workerTerminalTag === terminalTag;
  const phase = eventState.found
    ? phaseForTerminalTag(terminalTag, storedJob?.result?.phase ?? job.phase ?? storedJob?.phase ?? job.status ?? "error")
    : (job.phase ?? storedJob?.phase ?? job.status ?? "error");
  const exitCode = exitCodeForTerminalTag(terminalTag, workerExitCode);
  const workerErr = buildWorkerErrSummary(job, storedJob);
  return {
    jobId: job.id,
    threadId: job.threadId ?? storedJob?.threadId ?? null,
    phase,
    exitCode,
    terminalTag,
    workerExitCode,
    consistent,
    discrepancyReason: consistent
      ? null
      : formatDiscrepancyReason(eventState, terminalTag, workerTerminalTag, workerExitCode),
    eventsPath: eventState.eventsPath,
    terminalSource: eventState.found ? eventState.source : "worker-status",
    eventTerminalLine: eventState.line ?? null,
    summary: job.summary ?? storedJob?.summary ?? null,
    artifacts: storedJob?.result?.artifacts ?? {},
    workerErr,
    raw: { job, storedJob },
  };
}

async function *streamEvents(jobId, optionsOrSignal = {}) {
  const options = optionsOrSignal instanceof AbortSignal
    ? { signal: optionsOrSignal }
    : normalizeAdapterOptions(optionsOrSignal);
  const cwd = options.cwd ?? process.cwd();
  const snapshot = buildSingleJobSnapshot(cwd, jobId);
  const threadId = snapshot.job.threadId;
  if (!threadId) {
    const err = new Error(`Job ${snapshot.job.id} has no thread id yet.`);
    err.code = "JOB_HAS_NO_THREAD";
    throw err;
  }
  const sessionDir = options.sessionDir ?? defaultSessionDirForCwd(cwd);
  const eventsPath = options.eventsPath ?? path.join(sessionDir, `${threadId}.events`);
  const content = fs.readFileSync(eventsPath, "utf8");
  for (const line of content.split(/\r?\n/).filter(Boolean)) {
    if (options.signal?.aborted) return;
    yield {
      ts: new Date().toISOString(),
      tag: eventTagForLine(line),
      origin: "bridge",
      data: { line, eventsPath },
      raw: line,
    };
  }
}

const adapter = {
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
  steer,
};

export default adapter;

// Test-only helper. Keeps lifecycle method tests deterministic without
// spawning a real Codex app-server.
export function _setCodexAdapterRuntimeForTest(overrides = {}) {
  runtime = {
    ...defaultRuntime,
    ...overrides,
  };
}

export function _resetCodexAdapterRuntimeForTest() {
  runtime = defaultRuntime;
}
