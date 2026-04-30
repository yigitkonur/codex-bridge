import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const BRIDGE_PLUGIN_DATA_ENV = "CODEX_BRIDGE_PLUGIN_DATA";
const LEGACY_PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
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
  return input.session_id || process.env[SESSION_ID_ENV] || null;
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
