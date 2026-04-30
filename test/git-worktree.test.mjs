import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import {
  createSubagentWorktree,
  pruneWorktreeOnCancel,
  listSubagentWorktrees,
} from "../src/lib/git.mjs";

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-git-"));
  execSync("git init -b main", { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "test"', { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git add README.md", { cwd: dir });
  execSync('git commit -m "initial"', { cwd: dir });
  return dir;
}

function cleanup(repo) {
  // Try to remove any worktrees we created so the OS tmp cleanup is clean.
  try {
    const worktrees = listSubagentWorktrees(repo);
    for (const wt of worktrees) {
      const taskId = path.basename(wt.path);
      pruneWorktreeOnCancel({ cwd: repo, taskId, branch: wt.branch });
    }
  } catch {
    // Best-effort.
  }
  fs.rmSync(repo, { recursive: true, force: true });
  // Sibling dir for worktrees.
  fs.rmSync(path.resolve(repo, "..", ".codex-bridge-worktrees"), {
    recursive: true,
    force: true,
  });
}

test("createSubagentWorktree creates a worktree at the expected path", () => {
  const repo = makeTempRepo();
  try {
    const result = createSubagentWorktree({
      cwd: repo,
      taskId: "task-abc",
      backend: "codex",
    });
    assert.equal(result.isolation_mode, "worktree");
    assert.equal(result.branch, "subagent/codex/task-abc");
    assert.match(result.base_sha, /^[a-f0-9]{40}$/);
    assert.equal(result.base_ref, "main");
    assert.match(result.created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(fs.existsSync(result.path));
    assert.ok(fs.existsSync(path.join(result.path, "README.md")));
  } finally {
    cleanup(repo);
  }
});

test("createSubagentWorktree refuses to clobber an existing branch", () => {
  const repo = makeTempRepo();
  try {
    execSync("git branch subagent/codex/task-abc", { cwd: repo });
    assert.throws(
      () =>
        createSubagentWorktree({
          cwd: repo,
          taskId: "task-abc",
          backend: "codex",
        }),
      /already exists/,
    );
  } finally {
    cleanup(repo);
  }
});

test("createSubagentWorktree rejects unsafe task IDs before building paths", () => {
  const repo = makeTempRepo();
  try {
    assert.throws(
      () =>
        createSubagentWorktree({
          cwd: repo,
          taskId: "../escape",
          backend: "codex",
        }),
      /taskId must be a safe path segment/,
    );
  } finally {
    cleanup(repo);
  }
});

test("createSubagentWorktree treats shell metacharacters in baseRef as a ref, not a command", () => {
  const repo = makeTempRepo();
  const marker = path.join(repo, "shell-injection-marker");
  try {
    assert.throws(() =>
      createSubagentWorktree({
        cwd: repo,
        taskId: "task-safe",
        backend: "codex",
        baseRef: `HEAD; touch ${marker}`,
      }),
    );
    assert.equal(fs.existsSync(marker), false);
  } finally {
    cleanup(repo);
  }
});

test("pruneWorktreeOnCancel removes worktree + branch idempotently", () => {
  const repo = makeTempRepo();
  try {
    const created = createSubagentWorktree({
      cwd: repo,
      taskId: "task-prune",
      backend: "codex",
    });
    assert.ok(fs.existsSync(created.path));

    const pruned = pruneWorktreeOnCancel({ cwd: repo, taskId: "task-prune", branch: created.branch });
    assert.equal(pruned.pruned, true);
    assert.equal(pruned.branchDeleted, true);
    assert.ok(!fs.existsSync(created.path));

    // Idempotent — second call doesn't throw.
    assert.doesNotThrow(() => {
      const second = pruneWorktreeOnCancel({
        cwd: repo,
        taskId: "task-prune",
        branch: created.branch,
      });
      assert.equal(second.pruned, true);
      assert.equal(second.branchDeleted, true);
    });
  } finally {
    cleanup(repo);
  }
});

test("createSubagentWorktree refuses branch-only fallback with dirty parent checkout", () => {
  const repo = makeTempRepo();
  const blockedRoot = path.join(os.tmpdir(), `codex-bridge-blocked-${process.pid}-${Date.now()}`);
  fs.writeFileSync(blockedRoot, "not a directory");
  try {
    fs.writeFileSync(path.join(repo, "dirty.txt"), "dirty\n");
    assert.throws(
      () =>
        createSubagentWorktree({
          cwd: repo,
          taskId: "task-dirty",
          backend: "codex",
          worktreeRoot: blockedRoot,
        }),
      /branch-only fallback is unsafe with a dirty working tree/,
    );
    assert.equal(execSync("git branch --show-current", { cwd: repo }).toString().trim(), "main");
  } finally {
    fs.rmSync(blockedRoot, { force: true });
    cleanup(repo);
  }
});

test("createSubagentWorktree records the previous ref when using branch-only fallback", () => {
  const repo = makeTempRepo();
  const blockedRoot = path.join(os.tmpdir(), `codex-bridge-blocked-${process.pid}-${Date.now()}`);
  fs.writeFileSync(blockedRoot, "not a directory");
  try {
    const result = createSubagentWorktree({
      cwd: repo,
      taskId: "task-fallback",
      backend: "codex",
      worktreeRoot: blockedRoot,
    });
    assert.equal(result.isolation_mode, "branch-only");
    assert.equal(result.previous_ref, "main");
    assert.equal(execSync("git branch --show-current", { cwd: repo }).toString().trim(), result.branch);

    assert.doesNotThrow(() =>
      pruneWorktreeOnCancel({
        cwd: repo,
        taskId: "task-fallback",
        branch: result.branch,
        previousRef: result.previous_ref,
      }),
    );
  } finally {
    fs.rmSync(blockedRoot, { force: true });
    cleanup(repo);
  }
});

test("listSubagentWorktrees only returns codex-bridge worktrees", () => {
  const repo = makeTempRepo();
  try {
    createSubagentWorktree({
      cwd: repo,
      taskId: "task-listed",
      backend: "codex",
    });

    const list = listSubagentWorktrees(repo);
    assert.ok(list.length >= 1);
    const ours = list.find((w) => w.branch === "subagent/codex/task-listed");
    assert.ok(ours, "subagent/codex/task-listed should be in list");
    assert.match(ours.path, /\.codex-bridge-worktrees\/task-listed$/);
  } finally {
    cleanup(repo);
  }
});

test("createSubagentWorktree uses passed baseRef when provided", () => {
  const repo = makeTempRepo();
  try {
    // Create a second commit and a feature branch
    fs.writeFileSync(path.join(repo, "more.txt"), "x");
    execSync("git add more.txt && git commit -m more", { cwd: repo });
    const featSha = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
    execSync("git checkout -b feature", { cwd: repo });
    execSync("git checkout main", { cwd: repo });

    const result = createSubagentWorktree({
      cwd: repo,
      taskId: "task-base",
      backend: "codex",
      baseRef: "feature",
    });
    assert.equal(result.base_ref, "feature");
    assert.equal(result.base_sha, featSha);
  } finally {
    cleanup(repo);
  }
});

test("createSubagentWorktree honors a custom worktreeRoot", () => {
  const repo = makeTempRepo();
  const altRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-altroot-"));
  try {
    const result = createSubagentWorktree({
      cwd: repo,
      taskId: "task-alt",
      backend: "codex",
      worktreeRoot: altRoot,
    });
    assert.equal(result.path, path.join(altRoot, "task-alt"));
    assert.ok(fs.existsSync(result.path));

    // pruneWorktreeOnCancel must remove a worktree under a custom
    // worktreeRoot too — earlier the prune always derived the default
    // worktreeRoot and would silently leave non-default worktrees behind.
    const pruneResult = pruneWorktreeOnCancel({
      cwd: repo,
      taskId: "task-alt",
      branch: result.branch,
      worktreeRoot: altRoot,
    });
    assert.equal(pruneResult.pruned, true);
    assert.equal(pruneResult.branchDeleted, true);
    assert.equal(fs.existsSync(result.path), false);
  } finally {
    fs.rmSync(altRoot, { recursive: true, force: true });
    cleanup(repo);
  }
});
