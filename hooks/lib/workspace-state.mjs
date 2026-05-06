import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const BRIDGE_PLUGIN_DATA_ENV = "CODEX_BRIDGE_PLUGIN_DATA";
const LEGACY_PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const BRIDGE_SESSION_ID_ENV = "CODEX_BRIDGE_SESSION_ID";
const LEGACY_SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");

export function resolveHookCwd(input = {}) {
  return input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function resolveWorkspaceRoot(cwd) {
  try {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // Fall through to cwd.
  }
  return cwd;
}

export function canonicalPath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}

export function computeWorkspaceHash(cwd) {
  return createHash("sha256").update(canonicalPath(resolveWorkspaceRoot(cwd))).digest("hex").slice(0, 16);
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const canonicalWorkspaceRoot = canonicalPath(workspaceRoot);
  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug =
    slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "workspace";
  const hash = createHash("sha256")
    .update(canonicalWorkspaceRoot)
    .digest("hex")
    .slice(0, 16);
  const pluginDataDir =
    process.env[BRIDGE_PLUGIN_DATA_ENV] || process.env[LEGACY_PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir
    ? path.join(pluginDataDir, "state")
    : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), "jobs");
}

export function currentSessionId(input = {}) {
  return input.session_id || process.env[BRIDGE_SESSION_ID_ENV] || process.env[LEGACY_SESSION_ID_ENV] || null;
}

export function readJobMetadata(jobsRoot, jobId) {
  const jobFile = path.join(jobsRoot, `${jobId}.json`);
  try {
    return JSON.parse(fs.readFileSync(jobFile, "utf8"));
  } catch {
    return null;
  }
}

export function jobMatchesHookContext(job, { workspaceRoot, sessionId }) {
  if (!job || typeof job !== "object") return false;

  if (job.workspaceRoot) {
    if (canonicalPath(job.workspaceRoot) !== canonicalPath(workspaceRoot)) {
      return false;
    }
  } else {
    return false;
  }

  if (sessionId) {
    return job.sessionId === sessionId;
  }

  return !job.sessionId;
}

function markerRoot(cwd = process.cwd()) {
  return path.join(resolveStateDir(cwd), "markers");
}

function markerPath(cwd, jobId, key) {
  return path.join(markerRoot(cwd), `${jobId}.${key}`);
}

export function setMarker(jobId, key, cwd = process.cwd()) {
  fs.mkdirSync(markerRoot(cwd), { recursive: true });
  const file = markerPath(cwd, jobId, key);
  try {
    const fd = fs.openSync(file, "wx");
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw err;
  }
}

export function hasMarker(jobId, key, cwd = process.cwd()) {
  return fs.existsSync(markerPath(cwd, jobId, key));
}

export function consumeMarker(jobId, key, cwd = process.cwd()) {
  try {
    fs.unlinkSync(markerPath(cwd, jobId, key));
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

export function listActiveJobs(cwd = process.cwd()) {
  const root = markerRoot(cwd);
  if (!fs.existsSync(root)) return [];
  const jobs = new Set();
  for (const entry of fs.readdirSync(root)) {
    const index = entry.indexOf(".");
    if (index > 0) jobs.add(entry.slice(0, index));
  }
  return [...jobs].sort();
}
