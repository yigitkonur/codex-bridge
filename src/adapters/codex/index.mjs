import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  interruptAppServerTurn,
  runAppServerTurn,
  withAppServer,
} from "./codex.mjs";
import { readPendingRequestById, writeResponseFile } from "../../lib/pending-requests.mjs";
import { resolveSessionDir, TERMINAL_TAG_REGEX } from "../../lib/session-log.mjs";
import { buildSingleJobSnapshot, readStoredJob, resolveResultJob } from "../../lib/job-control.mjs";
import { DEFAULT_CONFIG } from "../../lib/config.mjs";
import { getConfig } from "../../lib/state.mjs";

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

function defaultSessionDirForCwd(cwd) {
  const config = getConfig(cwd);
  return resolveSessionDir(config.session_dir ?? DEFAULT_CONFIG.session_dir);
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

async function getResult(jobId, options = {}) {
  const normalized = normalizeAdapterOptions(options);
  const cwd = normalized.cwd ?? process.cwd();
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
