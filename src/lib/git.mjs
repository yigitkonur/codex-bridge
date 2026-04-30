import fs from "node:fs";
import path from "node:path";

import { CliError } from "./cli-errors.mjs";
import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";
import { sanitizePromptValue } from "./prompts.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
const REGULAR_FILE_READ_FLAGS =
  fs.constants.O_RDONLY |
  (fs.constants.O_NOFOLLOW ?? 0) |
  (fs.constants.O_NONBLOCK ?? 0);

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new CliError("git is not installed. Install Git and retry.", {
      class: "dependency_failed",
      code: "GIT_NOT_INSTALLED",
      retryable: false,
      suggestion: "Install Git (e.g. `brew install git` or your distro's package) and retry."
    });
  }
  if (result.status !== 0) {
    throw new CliError("This command must run inside a Git repository.", {
      class: "validation",
      code: "NOT_A_GIT_REPO",
      retryable: false,
      suggestion: "Run from within a Git working tree, or pass --cwd to point at one."
    });
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      const candidate = remoteHead.replace("refs/remotes/origin/", "");
      // Only return the bare name if a matching local branch exists;
      // otherwise `merge-base HEAD <name>` will fail in freshly cloned repos.
      const localCheck = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
      if (localCheck.status === 0) {
        return candidate;
      }
      return `origin/${candidate}`;
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new CliError("Unable to detect the repository default branch.", {
    class: "not_found",
    code: "DEFAULT_BRANCH_NOT_FOUND",
    retryable: false,
    suggestion: "Pass `--base <ref>` explicitly, or use `--scope working-tree`."
  });
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${sanitizePromptValue(baseRef)}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new CliError(
      `Unsupported review scope "${requestedScope}".`,
      {
        class: "validation",
        code: "INVALID_SCOPE",
        retryable: false,
        suggestion: "Use one of: auto, working-tree, branch, or pass --base <ref>."
      }
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${sanitizePromptValue(detectedBase)}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${sanitizePromptValue(detectedBase)}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function realpathSync(filePath) {
  return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
}

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readFileDescriptor(fd, size) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function formatUntrackedFile(cwd, relativePath) {
  let repoRoot;
  try {
    repoRoot = realpathSync(cwd);
  } catch {
    return `### ${relativePath}\n(skipped: repository root is unreadable)`;
  }

  const absolutePath = path.resolve(repoRoot, relativePath);
  if (!isPathInside(repoRoot, absolutePath)) {
    return `### ${relativePath}\n(skipped: path resolves outside repository)`;
  }

  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isSymbolicLink()) {
    return `### ${relativePath}\n(skipped: symlink)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (!stat.isFile()) {
    return `### ${relativePath}\n(skipped: non-regular file)`;
  }

  let resolvedPath;
  try {
    resolvedPath = realpathSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isPathInside(repoRoot, resolvedPath)) {
    return `### ${relativePath}\n(skipped: path resolves outside repository)`;
  }

  let fd;
  let buffer;
  try {
    fd = fs.openSync(resolvedPath, REGULAR_FILE_READ_FLAGS);
    const readStat = fs.fstatSync(fd);
    if (!readStat.isFile()) {
      return `### ${relativePath}\n(skipped: non-regular file)`;
    }
    if (readStat.size > MAX_UNTRACKED_BYTES) {
      return `### ${relativePath}\n(skipped: ${readStat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
    }
    buffer = readFileDescriptor(fd, readStat.size);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close failures after the read decision has already been made.
      }
    }
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = state.untracked.join("\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    ...details
  };
}

// =============================================================================
// Worktree helpers (Phase 2a / T17)
// =============================================================================
//
// Per plan §3.1, write-mode tasks isolate inside a git worktree under
// `<repoRoot>/../.codex-bridge-worktrees/<task_id>`. The branch is named
// `subagent/<backend>/<task_id>` so reviewers can identify the originating
// task at a glance. The worktree's base SHA is captured at creation time
// and persisted in the registry's meta.json (T15 wiring) so the diff is
// reproducible even if the parent branch advances during the worker's run.
//
// Failure mode (no disk, not-a-git-repo, etc.) falls back to an in-place
// branch checkout marked with `isolation_mode: "branch-only"` so the
// caller can downgrade gracefully — the worktree is a safety isolation,
// not a hard prerequisite for the workflow.

function runGit(cwd, args, options = {}) {
  return gitChecked(cwd, args, options).stdout;
}

function tryRunGit(cwd, args, options = {}) {
  const result = git(cwd, args, options);
  if (result.error || result.status !== 0) {
    return { ok: false, result };
  }
  return { ok: true, stdout: result.stdout, result };
}

function defaultWorktreeRoot(repoRoot) {
  return path.resolve(repoRoot, "..", ".codex-bridge-worktrees");
}

function assertSafeTaskId(taskId, caller) {
  if (!taskId || typeof taskId !== "string") {
    throw new Error(`${caller}: taskId is required`);
  }
  if (taskId === "." || taskId === ".." || !/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new Error(
      `${caller}: taskId must be a safe path segment: ${JSON.stringify(taskId)}`,
    );
  }
}

function buildBranchName({ taskId, backend, branchPrefix }) {
  const prefix = branchPrefix ?? "subagent";
  const back = backend ?? "codex";
  return `${prefix}/${back}/${taskId}`;
}

function assertSafeBranchName(cwd, branch, caller) {
  const result = tryRunGit(cwd, ["check-ref-format", "--branch", branch]);
  if (!result.ok) {
    throw new Error(
      `${caller}: branch name is invalid: ${JSON.stringify(branch)}`,
    );
  }
}

function branchExists(cwd, branch) {
  return tryRunGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

function currentCheckoutRef(cwd) {
  const symbolic = tryRunGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (symbolic.ok) return symbolic.stdout.trim();
  return runGit(cwd, ["rev-parse", "HEAD"]).trim();
}

// createSubagentWorktree({ cwd, taskId, backend, baseRef, branchPrefix, worktreeRoot })
// Returns one of:
//   { isolation_mode: "worktree", path, branch, base_ref, base_sha, created_at }
//   { isolation_mode: "branch-only", path: cwd, branch, base_ref, base_sha, created_at }
//   throws on hard failure (not-a-git-repo, branch already exists outside our control, ...)
export function createSubagentWorktree({
  cwd,
  taskId,
  backend = "codex",
  baseRef,
  branchPrefix = "subagent",
  worktreeRoot,
  allowBranchFallback = true,
}) {
  assertSafeTaskId(taskId, "createSubagentWorktree");

  ensureGitRepository(cwd);
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(cwd);
  // getCurrentBranch returns "HEAD" when detached (never empty), so the
  // ?? chain previously skipped detectDefaultBranch entirely. Treat
  // detached HEAD explicitly so the default-branch fallback can fire.
  const resolvedBaseRef =
    baseRef ??
    (currentBranch !== "HEAD" ? currentBranch : null) ??
    detectDefaultBranch(cwd) ??
    "HEAD";
  const baseSha = runGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${resolvedBaseRef}^{commit}`,
  ]).trim();
  const branch = buildBranchName({ taskId, backend, branchPrefix });
  assertSafeBranchName(repoRoot, branch, "createSubagentWorktree");
  const root = worktreeRoot ?? defaultWorktreeRoot(repoRoot);
  const wtPath = path.join(root, taskId);
  const createdAt = new Date().toISOString();

  // Refuse to clobber an existing branch that we didn't create.
  if (branchExists(repoRoot, branch)) {
    throw new Error(
      `createSubagentWorktree: branch ${branch} already exists; remove or rename before retrying`,
    );
  }

  // Try the worktree path first.
  try {
    fs.mkdirSync(root, { recursive: true });
    runGit(repoRoot, ["worktree", "add", "-b", branch, wtPath, baseSha]);
    return {
      isolation_mode: "worktree",
      path: wtPath,
      branch,
      base_ref: resolvedBaseRef,
      base_sha: baseSha,
      created_at: createdAt,
    };
  } catch (err) {
    // Roll back the partial worktree creation so we don't leave a
    // half-set worktree pointer.
    tryRunGit(repoRoot, ["worktree", "remove", "--force", wtPath]);
    if (!allowBranchFallback) {
      throw new Error(
        `createSubagentWorktree: worktree creation failed and branch fallback is disabled: ${err.message ?? err}`,
      );
    }
    if (getWorkingTreeState(repoRoot).isDirty) {
      throw new Error(
        "createSubagentWorktree: worktree creation failed and branch-only fallback is unsafe with a dirty working tree",
      );
    }
    const previousRef = currentCheckoutRef(repoRoot);
    // Branch-only fallback: stay in cwd, create the branch in place.
    try {
      runGit(repoRoot, ["checkout", "-b", branch, baseSha]);
    } catch (innerErr) {
      throw new Error(
        `createSubagentWorktree: worktree fallback also failed: ${innerErr.message ?? innerErr}`,
      );
    }
    return {
      isolation_mode: "branch-only",
      path: cwd,
      branch,
      base_ref: resolvedBaseRef,
      base_sha: baseSha,
      created_at: createdAt,
      previous_ref: previousRef,
      fallback_reason: err.message ?? String(err),
    };
  }
}

// pruneWorktreeOnCancel({ cwd, taskId, branch, previousRef, worktreeRoot, path })
// Removes the worktree (force) and deletes the branch. Used by `cancel`
// and by the merge gate after a successful ff-merge. Idempotent — calling
// against an already-pruned worktree is a no-op.
//
// `worktreeRoot` and `path` are optional and let the caller target a
// worktree that was created with a non-default `worktreeRoot`. If both are
// omitted, the registered worktree path is recovered from
// `git worktree list --porcelain` by branch (preferred) or by the default
// `<repoRoot>/../.codex-bridge-worktrees/<taskId>` layout as a fallback.
export function pruneWorktreeOnCancel({ cwd, taskId, branch, previousRef, worktreeRoot, path: explicitPath }) {
  assertSafeTaskId(taskId, "pruneWorktreeOnCancel");
  ensureGitRepository(cwd);
  const repoRoot = getRepoRoot(cwd);

  // Resolve the worktree path. Priority:
  //   1. caller-supplied explicit `path`
  //   2. caller-supplied `worktreeRoot` joined with `taskId`
  //   3. discovered via `git worktree list --porcelain` matched by branch
  //   4. default `<repoRoot>/../.codex-bridge-worktrees/<taskId>` layout
  let wtPath = null;
  if (typeof explicitPath === "string" && explicitPath.length > 0) {
    wtPath = explicitPath;
  } else if (typeof worktreeRoot === "string" && worktreeRoot.length > 0) {
    wtPath = path.join(worktreeRoot, taskId);
  } else if (branch) {
    const registered = listSubagentWorktrees(repoRoot).find((w) => w.branch === branch);
    if (registered) {
      wtPath = registered.path;
    }
  }
  if (!wtPath) {
    wtPath = path.join(defaultWorktreeRoot(repoRoot), taskId);
  }

  // `git worktree remove` refuses to operate on the main working tree.
  // In the branch-only fallback path, the subagent branch lives inside
  // repoRoot itself, so any discovered/explicit path that resolves to
  // the main tree must be skipped — the branch-delete step below still
  // runs, which is what the caller actually wants.
  const wtPathResolved = path.resolve(wtPath);
  const repoRootResolved = path.resolve(repoRoot);
  const isMainWorktree = wtPathResolved === repoRootResolved;

  if (!isMainWorktree && fs.existsSync(wtPath)) {
    runGit(repoRoot, ["worktree", "remove", "--force", wtPath]);
    if (fs.existsSync(wtPath)) {
      throw new Error(`pruneWorktreeOnCancel: worktree still exists after remove: ${wtPath}`);
    }
  }
  if (branch) {
    assertSafeBranchName(repoRoot, branch, "pruneWorktreeOnCancel");
    // -D not -d: branch may have unmerged commits while we're cancelling.
    if (branchExists(repoRoot, branch)) {
      if (getCurrentBranch(repoRoot) === branch) {
        if (!previousRef) {
          throw new Error(
            `pruneWorktreeOnCancel: cannot delete checked-out branch without previousRef: ${branch}`,
          );
        }
        runGit(repoRoot, ["checkout", previousRef]);
      }
      runGit(repoRoot, ["branch", "-D", branch]);
      if (branchExists(repoRoot, branch)) {
        throw new Error(`pruneWorktreeOnCancel: branch still exists after delete: ${branch}`);
      }
    }
  }
  return { pruned: !fs.existsSync(wtPath), branchDeleted: branch ? !branchExists(repoRoot, branch) : false };
}

// listSubagentWorktrees(cwd) -> [{ path, branch, head, locked }]
// Filtered list of git worktrees that look like ours (path under
// .codex-bridge-worktrees/, branch matching subagent/...).
export function listSubagentWorktrees(cwd) {
  ensureGitRepository(cwd);
  const repoRoot = getRepoRoot(cwd);
  const out = tryRunGit(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!out.ok) return [];
  const entries = [];
  let current = null;
  for (const line of out.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null, head: null, locked: false };
    } else if (line.startsWith("HEAD ") && current) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ") && current) {
      const ref = line.slice("branch ".length);
      current.branch = ref.replace(/^refs\/heads\//, "");
    } else if (line === "locked" && current) {
      current.locked = true;
    }
  }
  if (current) entries.push(current);
  return entries.filter(
    (e) => e.path.includes(".codex-bridge-worktrees/") || (e.branch && e.branch.startsWith("subagent/")),
  );
}
