// Per-task artifact registry for codex-bridge.
//
// Layout (per plan §6.2):
//
//   ~/.codex-bridge/jobs/<task_id>/
//     meta.json            — adapter, backend, model, started_at, base_sha,
//                            worktree_path, parent_task_id, iteration_index,
//                            schema_version, capabilities, brief_hash, phase
//     brief.json           — verbatim structured brief (T16)
//     brief.md             — human-readable rendering (T16)
//     events.jsonl         — line-buffered NormalizedEvent stream
//     ndjson.jsonl         — adapter-native event mirror
//     diff.patch           — captured before merge
//     plan.md              — if [PLAN] arrived
//     review.json          — reviewer's structured output
//     verdict.json         — Opus's post-review decision
//     stderr.log           — adapter raw stderr (forensics)
//     lock                 — POSIX flock guard
//     rewake.signal        — terminal-tag deposit (T22 wakes Claude)
//
// This v1 module ships the minimum API the rest of the stack needs:
// writeMeta, readMeta, writeReview, readReview, jobDir, existsTask, listTasks. Full lock /
// cleanup / compaction / iteration-chain helpers land in follow-ups
// once the consumers (T16 brief, T18 --worktree-auto, T19 merge,
// T20 verdict, T21 iterate) need them.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REGISTRY_SCHEMA_VERSION = "1.0";

// Monotonic counter so two writers in the same millisecond/PID don't
// collide on the same .tmp filename and race each other into ENOENT
// on the trailing renameSync.
let tmpCounter = 0;
function tmpSuffix() {
  tmpCounter = (tmpCounter + 1) >>> 0;
  return `${process.pid}.${Date.now()}.${tmpCounter}`;
}

export class RegistryReadError extends Error {
  constructor(message, { filePath, cause } = {}) {
    super(message, { cause });
    this.name = "RegistryReadError";
    this.code = "REGISTRY_READ_FAILED";
    this.filePath = filePath ?? null;
  }
}

export function registryRoot() {
  // Honor CODEX_BRIDGE_REGISTRY for tests.
  const override = process.env.CODEX_BRIDGE_REGISTRY;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".codex-bridge", "jobs");
}

export function jobDir(taskId) {
  if (!taskId || typeof taskId !== "string") {
    throw new TypeError("jobDir(taskId): taskId must be a non-empty string");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new TypeError(
      `jobDir(taskId): taskId contains invalid characters: ${JSON.stringify(taskId)}`,
    );
  }
  // Reject "." and ".." even though the regex permits them — path.join
  // would normalize these out of the registry root and let a caller
  // read/write the parent directory.
  if (taskId === "." || taskId === "..") {
    throw new TypeError(
      `jobDir(taskId): taskId must not be "." or "..": ${JSON.stringify(taskId)}`,
    );
  }
  return path.join(registryRoot(), taskId);
}

export function existsTask(taskId) {
  // Returns false for both "no such task directory" and "invalid task id"
  // (TypeError from jobDir). Callers that want to distinguish the two
  // should call jobDir() directly and let the validation error propagate.
  try {
    return fs.existsSync(jobDir(taskId));
  } catch {
    return false;
  }
}

export function ensureJobDir(taskId) {
  const dir = jobDir(taskId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeMeta(taskId, meta) {
  if (!meta || typeof meta !== "object") {
    throw new TypeError("writeMeta(taskId, meta): meta must be an object");
  }
  const dir = ensureJobDir(taskId);
  const payload = {
    ...meta,
    schema_version: REGISTRY_SCHEMA_VERSION,
    task_id: taskId,
    written_at: new Date().toISOString(),
  };
  const target = path.join(dir, "meta.json");
  // Atomic write — temp file then rename. Avoids partial reads if a
  // consumer races us.
  const tmp = `${target}.tmp.${tmpSuffix()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, target);
  return target;
}

function writeRegistryTextFile(taskId, fileName, content) {
  const dir = ensureJobDir(taskId);
  const target = path.join(dir, fileName);
  const tmp = `${target}.tmp.${tmpSuffix()}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, target);
  return target;
}

export function writeBriefArtifacts(taskId, { brief, rendered, hash, source } = {}) {
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
    throw new TypeError("writeBriefArtifacts(taskId, artifacts): artifacts.brief must be an object");
  }
  const briefJsonPath = writeRegistryTextFile(taskId, "brief.json", `${JSON.stringify({
    schema_version: REGISTRY_SCHEMA_VERSION,
    task_id: taskId,
    brief_hash: hash ?? null,
    brief_source: source ?? null,
    written_at: new Date().toISOString(),
    brief,
  }, null, 2)}\n`);
  const briefMdPath = rendered
    ? writeRegistryTextFile(taskId, "brief.md", String(rendered).endsWith("\n") ? String(rendered) : `${rendered}\n`)
    : null;
  return { briefJsonPath, briefMdPath };
}

export function writeDiffArtifact(taskId, diffContent) {
  return writeRegistryTextFile(taskId, "diff.patch", String(diffContent ?? ""));
}

export function readRegistryEvents(taskId, { maxEntries = null } = {}) {
  const target = path.join(jobDir(taskId), "events.jsonl");
  if (!fs.existsSync(target)) return [];
  const lines = fs.readFileSync(target, "utf8").split(/\r?\n/).filter(Boolean);
  const selected = Number.isInteger(maxEntries) && maxEntries > 0 ? lines.slice(-maxEntries) : lines;
  return selected.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      return {
        ts: null,
        tag: "CORRUPT_REGISTRY_EVENT",
        message: "Registry event line is not valid JSON.",
        line: index,
        raw: line,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export function readMeta(taskId) {
  const target = path.join(jobDir(taskId), "meta.json");
  return readRegistryJson(target);
}

function readRegistryJson(target) {
  let text;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new RegistryReadError(`Could not read registry file: ${target}`, {
      filePath: target,
      cause: error,
    });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RegistryReadError(`Registry file is not valid JSON: ${target}`, {
      filePath: target,
      cause: error,
    });
  }
}

// Same shape as the validation in jobDir(); enforced here so listTasks()
// only returns names that downstream readers (readMeta/readVerdict) can
// actually resolve without TypeError.
const TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function listTasks() {
  const root = registryRoot();
  if (!fs.existsSync(root)) return [];
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== "." &&
          entry.name !== ".." &&
          TASK_ID_PATTERN.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function readVerdict(taskId) {
  const target = path.join(jobDir(taskId), "verdict.json");
  return readRegistryJson(target);
}

export function writeVerdict(taskId, verdict) {
  if (!verdict || typeof verdict !== "object") {
    throw new TypeError("writeVerdict(taskId, verdict): verdict must be an object");
  }
  if (!["approved", "needs-attention", "must-fix"].includes(verdict.verdict)) {
    throw new TypeError(
      "writeVerdict(taskId, verdict): verdict.verdict must be one of approved | needs-attention | must-fix",
    );
  }
  const dir = ensureJobDir(taskId);
  const payload = {
    ...verdict,
    schema_version: REGISTRY_SCHEMA_VERSION,
    task_id: taskId,
    decided_at: new Date().toISOString(),
  };
  const target = path.join(dir, "verdict.json");
  const tmp = `${target}.tmp.${tmpSuffix()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, target);
  return target;
}

export function readReview(taskId) {
  const target = path.join(jobDir(taskId), "review.json");
  return readRegistryJson(target);
}

export function writeReview(taskId, review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    throw new TypeError("writeReview(taskId, review): review must be an object");
  }
  const dir = ensureJobDir(taskId);
  const payload = {
    ...review,
    schema_version: REGISTRY_SCHEMA_VERSION,
    task_id: taskId,
    ts: new Date().toISOString(),
  };
  const target = path.join(dir, "review.json");
  const tmp = `${target}.tmp.${tmpSuffix()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, target);
  return target;
}

// v1 append semantics:
//   - Synchronous fs.appendFileSync; throws if the underlying write fails
//     (ENOSPC, EROFS, EBUSY on Windows, etc.). Callers decide whether to
//     swallow — this differs from src/lib/session-log.mjs, which is
//     intentionally best-effort, because registry events are a forensics
//     artifact and silent loss would be worse than a loud failure.
//   - Single-process line atomicity is guaranteed for entries shorter than
//     PIPE_BUF (~4096 bytes on Linux); cross-process or oversized payloads
//     can interleave. The flock-guarded writer lands with the locking
//     helpers in a follow-up task.
export function appendEvent(taskId, event) {
  if (!event || typeof event !== "object") {
    throw new TypeError("appendEvent(taskId, event): event must be an object");
  }
  const dir = ensureJobDir(taskId);
  const target = path.join(dir, "events.jsonl");
  // Spread caller fields first so registry-controlled `ts` always wins.
  const enriched = { ...event, ts: new Date().toISOString() };
  fs.appendFileSync(target, `${JSON.stringify(enriched)}\n`, "utf8");
}
