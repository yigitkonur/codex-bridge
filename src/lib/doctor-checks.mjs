import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { fileURLToPath } from "node:url";
import { getCodexAuthStatus, getCodexAvailability } from "../adapters/codex/codex.mjs";
import { loadConfig, DEFAULT_CONFIG } from "./config.mjs";
import { runCommand } from "./process.mjs";
import { resolveSessionDir } from "./session-log.mjs";
import { listJobs, resolveJobsDir, updateState, upsertJob, writeJobFile } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

// Resolve skill/plugin root relative to this module file. This mirrors the
// ROOT_DIR logic in src/codex-bridge.mjs without importing that file.
const _DOCTOR_SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const _DOCTOR_SKILL_DIR = fs.existsSync(path.join(_DOCTOR_SCRIPT_DIR, "..", "schemas"))
  ? path.join(_DOCTOR_SCRIPT_DIR, "..")
  : path.join(_DOCTOR_SCRIPT_DIR, "..", "..");

function getBridgeConfig(cwd = null, workspaceRoot = null) {
  return loadConfig(_DOCTOR_SKILL_DIR, cwd, workspaceRoot);
}

const OLD_SESSION_AGE_DAYS = 30;
const WORKTREE_ROOT_NAME = ".codex-bridge-worktrees";
const BRANCH_PREFIX = "subagent/codex/";

export function pidIsAlive(pid) {
  const normalized = Number(pid);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return false;
  }
  try {
    process.kill(normalized, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function ageMsFrom(value, now = Date.now()) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;
}

function liveJobStatuses() {
  return new Set(["queued", "running"]);
}

function terminalJobStatuses() {
  return new Set(["completed", "failed", "cancelled", "orphaned"]);
}

function buildJobMap(jobs) {
  return new Map(jobs.filter((job) => job?.id).map((job) => [job.id, job]));
}

function defaultWorktreeRoot(repoRoot) {
  return path.resolve(repoRoot, "..", WORKTREE_ROOT_NAME);
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function directorySizeBytes(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return { path: dir, exists: false, bytes: 0, error: null };
  }
  const result = runCommand("du", ["-sk", dir], { timeout: 20_000 });
  if (!result.error && result.status === 0) {
    const kb = Number(result.stdout.trim().split(/\s+/)[0]);
    return {
      path: dir,
      exists: true,
      bytes: Number.isFinite(kb) ? kb * 1024 : 0,
      error: null,
    };
  }
  return {
    path: dir,
    exists: true,
    bytes: 0,
    error: result.error?.message ?? result.stderr.trim() ?? result.stdout.trim() ?? `exit ${result.status}`,
  };
}

function listLocalBranches(repoRoot) {
  const result = spawnSync("git", ["branch", "--list", `${BRANCH_PREFIX}*`], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\*\s+/, ""))
    .filter((line) => line.startsWith(BRANCH_PREFIX));
}

function listGitWorktrees(repoRoot) {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) return [];
  const entries = [];
  let current = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (current) entries.push(current);
  return entries;
}

export function checkStaleJobs(workspaceRoot, options = {}) {
  const now = options.now ?? Date.now();
  const findings = [];
  for (const job of listJobs(workspaceRoot, { raw: true })) {
    if (job?.status !== "running" && job?.status !== "queued") continue;
    const pid = Number(job.pid);
    if (pidIsAlive(pid)) continue;
    findings.push({
      type: "stale_job",
      severity: "error",
      action: "mark_orphaned",
      cleanable: true,
      jobId: job.id,
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      status: job.status,
      message: job.pid
        ? `registry says ${job.status}, PID ${job.pid} not alive`
        : `registry says ${job.status}, no PID recorded`,
      age_ms: ageMsFrom(job.updatedAt ?? job.createdAt, now),
    });
  }
  return findings;
}

export function checkOrphanWorktrees(repoRoot, workspaceRoot, options = {}) {
  const now = options.now ?? Date.now();
  const jobs = buildJobMap(listJobs(workspaceRoot, { raw: true }));
  const worktreeRoot = defaultWorktreeRoot(repoRoot);
  const findings = [];
  for (const entry of safeReadDir(worktreeRoot)) {
    if (!entry.isDirectory() || !entry.name.startsWith("task-")) continue;
    const taskId = entry.name;
    const job = jobs.get(taskId);
    if (job && liveJobStatuses().has(job.status)) continue;
    const worktreePath = path.join(worktreeRoot, entry.name);
    let stat = null;
    try { stat = fs.statSync(worktreePath); } catch { /* best effort */ }
    findings.push({
      type: "orphan_worktree",
      severity: "warning",
      action: "remove_worktree",
      cleanable: true,
      taskId,
      path: worktreePath,
      jobStatus: job?.status ?? null,
      message: job
        ? `worktree exists for non-live job (${job.status})`
        : "worktree has no registry entry",
      age_ms: stat ? Math.max(0, now - stat.mtimeMs) : null,
    });
  }
  return findings;
}

export function checkOrphanBranches(repoRoot, workspaceRoot) {
  const jobs = buildJobMap(listJobs(workspaceRoot, { raw: true }));
  const worktreeBranches = new Set(listGitWorktrees(repoRoot).map((entry) => entry.branch).filter(Boolean));
  const findings = [];
  for (const branch of listLocalBranches(repoRoot)) {
    const taskId = branch.slice(BRANCH_PREFIX.length);
    const job = jobs.get(taskId);
    if (job && liveJobStatuses().has(job.status) && worktreeBranches.has(branch)) continue;
    if (job && liveJobStatuses().has(job.status) && !worktreeBranches.has(branch)) {
      findings.push({
        type: "orphan_branch",
        severity: "warning",
        action: "delete_branch",
        cleanable: true,
        taskId,
        branch,
        jobStatus: job.status,
        message: "branch has a live registry entry but no corresponding worktree",
      });
      continue;
    }
    findings.push({
      type: "orphan_branch",
      severity: "warning",
      action: "delete_branch",
      cleanable: true,
      taskId,
      branch,
      jobStatus: job?.status ?? null,
      message: job ? `branch exists for non-live job (${job.status})` : "branch has no registry entry",
    });
  }
  return findings;
}

export function checkOldSessionFiles(cwd, workspaceRoot, options = {}) {
  const now = options.now ?? Date.now();
  const config = getBridgeConfig(cwd, workspaceRoot);
  const sessionDir = resolveSessionDir(config.session_dir, workspaceRoot);
  const cutoffMs = now - OLD_SESSION_AGE_DAYS * 24 * 60 * 60 * 1000;
  let count = 0;
  let oldestMs = null;
  for (const entry of safeReadDir(sessionDir)) {
    if (!entry.isFile() || !/\.(events|ndjson)$/.test(entry.name)) continue;
    const filePath = path.join(sessionDir, entry.name);
    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    if (stat.mtimeMs >= cutoffMs) continue;
    count += 1;
    oldestMs = oldestMs == null ? stat.mtimeMs : Math.min(oldestMs, stat.mtimeMs);
  }
  if (count === 0) return [];
  return [{
    type: "old_session_files",
    severity: "warning",
    action: null,
    cleanable: false,
    path: sessionDir,
    count,
    older_than_days: OLD_SESSION_AGE_DAYS,
    age_ms: oldestMs == null ? null : Math.max(0, now - oldestMs),
    message: `${count} session event/log file(s) older than ${OLD_SESSION_AGE_DAYS} days`,
  }];
}

export function checkDiskUsage(cwd, workspaceRoot) {
  const config = getBridgeConfig(cwd, workspaceRoot);
  const sessionDir = resolveSessionDir(config.session_dir, workspaceRoot);
  const checks = [
    { type: "disk_usage", severity: "info", label: "sessions_dir", ...directorySizeBytes(sessionDir) },
    { type: "disk_usage", severity: "info", label: "jobs_dir", ...directorySizeBytes(resolveJobsDir(workspaceRoot)) },
    { type: "disk_usage", severity: "info", label: "codex_rollouts", ...directorySizeBytes(path.join(os.homedir(), ".codex", "sessions")) },
  ];
  return checks.map((check) => ({
    ...check,
    action: null,
    cleanable: false,
    message: check.error ? `unable to measure ${check.label}: ${check.error}` : `${check.label}: ${check.bytes} bytes`,
  }));
}

export async function checkCodexCli(cwd) {
  const availability = getCodexAvailability(cwd);
  const auth = availability.available ? await getCodexAuthStatus(cwd) : null;
  return [{
    type: "codex_cli",
    severity: availability.available && auth?.loggedIn ? "info" : "warning",
    action: null,
    cleanable: false,
    available: availability.available,
    version: availability.detail ?? null,
    auth: auth ? {
      loggedIn: Boolean(auth.loggedIn),
      detail: auth.detail ?? null,
      source: auth.source ?? null,
      provider: auth.provider ?? null,
    } : null,
    message: availability.available
      ? `Codex CLI available; auth ${auth?.loggedIn ? "logged in" : "not logged in"}`
      : `Codex CLI unavailable: ${availability.detail}`,
  }];
}

export async function runDoctorChecks(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let repoRoot = workspaceRoot;
  const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    timeout: 5000,
  });
  if (gitRoot.status === 0 && gitRoot.stdout.trim()) {
    repoRoot = gitRoot.stdout.trim();
  }
  const actionableFindings = [
    ...checkStaleJobs(workspaceRoot),
    ...checkOrphanWorktrees(repoRoot, workspaceRoot),
    ...checkOrphanBranches(repoRoot, workspaceRoot),
  ];
  const informationalFindings = [
    ...checkOldSessionFiles(cwd, workspaceRoot),
    ...checkDiskUsage(cwd, workspaceRoot),
    ...(await checkCodexCli(cwd)),
  ];
  return {
    workspaceRoot,
    repoRoot,
    findings: [...actionableFindings, ...informationalFindings],
  };
}

function assertSafeBranch(branch) {
  if (typeof branch !== "string" || !branch.startsWith(BRANCH_PREFIX) || /[\s;|&`$()<>"'\\]/.test(branch)) {
    throw new Error(`unsafe branch name: ${JSON.stringify(branch)}`);
  }
}

function worktreeStatus(worktreePath) {
  const result = spawnSync("git", ["-C", worktreePath, "status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

export function applyDoctorAction(finding, context, options = {}) {
  if (!finding?.cleanable) {
    return { finding, action: finding?.action ?? null, cleaned: false, skipped: true, reason: "not-cleanable" };
  }
  if (finding.action === "mark_orphaned") {
    const ts = new Date().toISOString();
    const existing = listJobs(context.workspaceRoot, { raw: true }).find((job) => job.id === finding.jobId) ?? {};
    const record = {
      ...existing,
      id: finding.jobId,
      status: "orphaned",
      phase: "orphaned",
      pid: null,
      completedAt: ts,
      errorMessage: `Marked orphaned by doctor at ${ts}.`,
    };
    updateState(context.workspaceRoot, (state) => {
      state.jobs = (state.jobs ?? []).map((job) => job.id === finding.jobId ? { ...job, ...record } : job);
    });
    writeJobFile(context.workspaceRoot, finding.jobId, record);
    upsertJob(context.workspaceRoot, record);
    return { finding, action: finding.action, cleaned: true, skipped: false };
  }
  if (finding.action === "remove_worktree") {
    const dirty = worktreeStatus(finding.path);
    if (dirty && !options.force) {
      return { finding, action: finding.action, cleaned: false, skipped: true, reason: "dirty-worktree", detail: dirty };
    }
    const remove = spawnSync("git", ["worktree", "remove", "--force", finding.path], {
      cwd: context.repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (remove.status !== 0 && finding.path.includes(`${path.sep}${WORKTREE_ROOT_NAME}${path.sep}`)) {
      fs.rmSync(finding.path, { recursive: true, force: true });
    }
    return {
      finding,
      action: finding.action,
      cleaned: !fs.existsSync(finding.path),
      skipped: false,
      detail: remove.status === 0 ? null : (remove.stderr.trim() || remove.stdout.trim() || null),
    };
  }
  if (finding.action === "delete_branch") {
    assertSafeBranch(finding.branch);
    const result = spawnSync("git", ["branch", "-D", finding.branch], {
      cwd: context.repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    return {
      finding,
      action: finding.action,
      cleaned: result.status === 0,
      skipped: false,
      detail: result.status === 0 ? null : (result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`),
    };
  }
  return { finding, action: finding.action, cleaned: false, skipped: true, reason: "unknown-action" };
}
