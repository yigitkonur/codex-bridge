import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const BRIDGE_PLUGIN_DATA_ENV = "CODEX_BRIDGE_PLUGIN_DATA";
const LEGACY_PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const STATE_LOCK_FILE_NAME = "state.lock";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

function nowIso() {
  return new Date().toISOString();
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

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[BRIDGE_PLUGIN_DATA_ENV] || process.env[LEGACY_PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

function resolveStateLockFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_LOCK_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
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
      const fd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      // Capture this lock's inode so the release closure can validate that the
      // file on disk is still ours before unlinking it. If our lock was reaped
      // as stale by a sibling process and a different inode now lives at the
      // path, unlinking would corrupt the new holder's lock.
      let ownedIno = null;
      try { ownedIno = fs.fstatSync(fd).ino; } catch { /* noop */ }
      return () => {
        try { fs.closeSync(fd); } catch { /* noop */ }
        try {
          if (ownedIno !== null) {
            const stat = fs.statSync(lockFile);
            if (stat.ino !== ownedIno) {
              // Another holder owns the file now; do not unlink.
              return;
            }
          }
          fs.unlinkSync(lockFile);
        } catch (releaseError) {
          // ENOENT is fine — already unlinked by a stale-lock cleanup race.
          if (releaseError?.code !== "ENOENT") {
            // Best effort: do not throw out of a finally-style release.
          }
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(lockFile);
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

// Probe whether a pid is a live process. `process.kill(pid, 0)` throws
// ESRCH when the pid is gone — we use that as the dead-pid signal. EPERM
// means the pid exists but we lack permission to signal; treat as alive
// (conservative — don't reap someone else's process). Any other error is
// also conservative: assume alive so we don't false-reap.
function pidIsAlive(pid) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "ESRCH") return false;
    // EPERM / EINVAL / unknown — err on the side of "alive" to avoid
    // misclassifying a real job as orphaned.
    return true;
  }
}

// Walks the job list, looking for `queued`/`running` entries whose backing
// pid is no longer alive, and transitions them to `orphaned`. Callers that
// persist this result must do so under `state.lock`.
function reapOrphans(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return { jobs, reaped: 0 };
  let changed = 0;
  const reaped = jobs.map((job) => {
    if (!job || (job.status !== "running" && job.status !== "queued")) return job;
    if (pidIsAlive(job.pid)) return job;
    changed++;
    return {
      ...job,
      status: "orphaned",
      phase: "orphaned",
      updatedAt: new Date().toISOString(),
      errorMessage:
        job.errorMessage ??
        `Backing process (pid ${job.pid ?? "?"}) no longer alive — reaped on load.`,
    };
  });
  return { jobs: reaped, reaped: changed };
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const rawJobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: rawJobs,
    };
  } catch (error) {
    // Corrupt state.json: a re-throw here wedges every state-touching command
    // because saveStateUnlocked itself calls loadState for previousJobs. To
    // avoid that cascade while still preserving forensic data, rename the
    // corrupt file to a sibling `.corrupt-<ts>` and fall back to defaults.
    let renamedPath = null;
    try {
      const candidate = `${stateFile}.corrupt-${Date.now()}`;
      fs.renameSync(stateFile, candidate);
      renamedPath = candidate;
    } catch (renameError) {
      // EXDEV (cross-device), ENOENT (already gone), and EACCES are all
      // best-effort situations — the warning below still records the issue.
      if (renameError && renameError.code !== "ENOENT" && renameError.code !== "EXDEV") {
        // swallow other rename errors as well; the goal is recovery not strict accounting
      }
    }
    process.emitWarning(
      `State file at ${stateFile} was corrupt (${error?.message ?? error}); preserved at ${renamedPath ?? "<unable to rename>"}`,
      "CodexBridgeStateWarning"
    );
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function writeJsonFileAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  const fd = fs.openSync(tempPath, "w");
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tempPath, filePath);
  } catch (renameError) {
    // Rename failed (cross-device EXDEV, permission, or other). Sweep the
    // straggling temp file before propagating so we do not leak `.tmp`
    // siblings on every retry.
    try { fs.unlinkSync(tempPath); } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
        // best effort; do not mask the original error
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
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeJsonFileAtomic(resolveStateFile(cwd), nextState);
  return nextState;
}

export function saveState(cwd, state) {
  const release = acquireStateLock(cwd);
  try {
    return saveStateUnlocked(cwd, state);
  } finally {
    release();
  }
}

export function updateState(cwd, mutate) {
  const release = acquireStateLock(cwd);
  try {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  } finally {
    release();
  }
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
