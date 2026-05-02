import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createSubagentWorktree,
  mergeSubagentBranch,
  pruneWorktreeOnCancel,
  listSubagentWorktrees,
} from "../src/lib/git.mjs";
import { writeMeta } from "../src/lib/registry.mjs";

const bridgePath = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-git-"));
  fs.rmSync(defaultWorktreeRootForRepo(dir), { recursive: true, force: true });
  execSync("git init -b main", { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "test"', { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git add README.md", { cwd: dir });
  execSync('git commit -m "initial"', { cwd: dir });
  return dir;
}

function defaultWorktreeRootForRepo(repo) {
  return path.resolve(repo, "..", ".codex-bridge-worktrees");
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
  fs.rmSync(defaultWorktreeRootForRepo(repo), { recursive: true, force: true });
}

function writeTaskMeta(registry, taskId, meta) {
  const previous = process.env.CODEX_BRIDGE_REGISTRY;
  process.env.CODEX_BRIDGE_REGISTRY = registry;
  try {
    writeMeta(taskId, meta);
  } finally {
    if (previous === undefined) delete process.env.CODEX_BRIDGE_REGISTRY;
    else process.env.CODEX_BRIDGE_REGISTRY = previous;
  }
}

function runBridge(args, { cwd, registry, input = undefined }) {
  return spawnSync(process.execPath, [bridgePath, ...args], {
    cwd,
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
      CODEX_BRIDGE_REGISTRY: registry,
    },
  });
}

function parseBridgeJson(result, expectedStatus = 0) {
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  assert.notEqual(result.stdout.trim(), "");
  return JSON.parse(result.stdout);
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

test("createSubagentWorktree can reject branch-only fallback without switching checkout", () => {
  const repo = makeTempRepo();
  const blocker = path.join(os.tmpdir(), `codex-bridge-worktree-blocker-${process.pid}-${Date.now()}`);
  fs.writeFileSync(blocker, "not a directory");
  try {
    assert.throws(
      () =>
        createSubagentWorktree({
          cwd: repo,
          taskId: "task-no-fallback",
          backend: "codex",
          worktreeRoot: blocker,
          allowBranchFallback: false,
        }),
      /branch fallback is disabled/,
    );
    assert.equal(execSync("git branch --show-current", { cwd: repo }).toString().trim(), "main");
    assert.equal(
      execSync("git branch --list subagent/codex/task-no-fallback", { cwd: repo }).toString().trim(),
      "",
    );
  } finally {
    fs.rmSync(blocker, { force: true });
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

test("mergeSubagentBranch fast-forwards the reviewed branch head and prunes clean worktree", () => {
  const repo = makeTempRepo();
  try {
    const created = createSubagentWorktree({
      cwd: repo,
      taskId: "task-merge",
      backend: "codex",
    });
    fs.writeFileSync(path.join(created.path, "merged.txt"), "merged\n");
    execSync("git add merged.txt", { cwd: created.path });
    execSync('git commit -m "work"', { cwd: created.path });
    const branchSha = execSync(`git rev-parse ${created.branch}`, { cwd: repo }).toString().trim();

    const result = mergeSubagentBranch({
      cwd: repo,
      taskId: "task-merge",
      branch: created.branch,
      baseRef: "main",
      expectedBranchSha: branchSha,
      worktreePath: created.path,
    });

    assert.equal(result.strategy, "ff");
    assert.equal(result.commit_sha, branchSha);
    assert.ok(fs.existsSync(path.join(repo, "merged.txt")));
    assert.ok(!fs.existsSync(created.path));
  } finally {
    cleanup(repo);
  }
});

test("mergeSubagentBranch refuses to prune a dirty task worktree", () => {
  const repo = makeTempRepo();
  try {
    const created = createSubagentWorktree({
      cwd: repo,
      taskId: "task-dirty",
      backend: "codex",
    });
    const branchSha = execSync(`git rev-parse ${created.branch}`, { cwd: repo }).toString().trim();
    fs.writeFileSync(path.join(created.path, "uncommitted.txt"), "not committed\n");

    assert.throws(
      () =>
        mergeSubagentBranch({
          cwd: repo,
          taskId: "task-dirty",
          branch: created.branch,
          baseRef: "main",
          expectedBranchSha: branchSha,
          worktreePath: created.path,
        }),
      /task worktree is dirty/,
    );
    assert.ok(fs.existsSync(created.path));
  } finally {
    cleanup(repo);
  }
});

test("mergeSubagentBranch rejects a branch head that was not reviewed", () => {
  const repo = makeTempRepo();
  try {
    const created = createSubagentWorktree({
      cwd: repo,
      taskId: "task-stale-verdict",
      backend: "codex",
    });
    const reviewedSha = execSync(`git rev-parse ${created.branch}`, { cwd: repo }).toString().trim();
    fs.writeFileSync(path.join(created.path, "later.txt"), "later\n");
    execSync("git add later.txt", { cwd: created.path });
    execSync('git commit -m "later"', { cwd: created.path });

    assert.throws(
      () =>
        mergeSubagentBranch({
          cwd: repo,
          taskId: "task-stale-verdict",
          branch: created.branch,
          baseRef: "main",
          expectedBranchSha: reviewedSha,
          worktreePath: created.path,
        }),
      /approved verdict reviewed/,
    );
    assert.ok(fs.existsSync(created.path));
  } finally {
    cleanup(repo);
  }
});

test("bridge merge accepts public payload-stdin approval for the matching reviewed branch head", () => {
  const repo = makeTempRepo();
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-merge-registry-"));
  try {
    const taskId = "task-cli-merge";
    const created = createSubagentWorktree({
      cwd: repo,
      taskId,
      backend: "codex",
    });
    fs.writeFileSync(path.join(created.path, "cli-merged.txt"), "merged\n");
    execSync("git add cli-merged.txt", { cwd: created.path });
    execSync('git commit -m "cli work"', { cwd: created.path });
    const branchSha = execSync(`git rev-parse ${created.branch}`, { cwd: repo }).toString().trim();
    writeTaskMeta(registry, taskId, {
      worktree: {
        path: created.path,
        branch: created.branch,
        base_ref: "main",
      },
    });

    const verdict = parseBridgeJson(
      runBridge(["verdict", taskId, "--payload-stdin", "--json"], {
        cwd: repo,
        registry,
        input: JSON.stringify({
          verdict: "approved",
          summary: "review approved current head",
          branch_head_sha: branchSha,
        }),
      }),
    );
    assert.equal(verdict.result.verdict.branch_head_sha, branchSha);

    const readBack = parseBridgeJson(runBridge(["verdict", taskId, "--json"], { cwd: repo, registry }));
    assert.equal(readBack.result.merge_readiness.merge_ready, true);
    assert.equal(readBack.result.merge_readiness.branch_head_sha, branchSha);
    assert.equal(readBack.result.merge_readiness.current_branch_head_sha, branchSha);

    const merged = parseBridgeJson(runBridge(["merge", taskId, "--json", "--no-tests"], { cwd: repo, registry }));
    assert.equal(merged.result.reviewed_branch_head_sha, branchSha);
    assert.equal(merged.result.merge.commit_sha, branchSha);
    assert.ok(fs.existsSync(path.join(repo, "cli-merged.txt")));
    assert.equal(fs.existsSync(created.path), false);
  } finally {
    cleanup(repo);
    fs.rmSync(registry, { recursive: true, force: true });
  }
});

test("bridge merge rejects stale public approvals and pending verdicts explain blockers", () => {
  const repo = makeTempRepo();
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-merge-drift-registry-"));
  try {
    const staleTaskId = "task-cli-stale";
    const created = createSubagentWorktree({
      cwd: repo,
      taskId: staleTaskId,
      backend: "codex",
    });
    fs.writeFileSync(path.join(created.path, "first.txt"), "first\n");
    execSync("git add first.txt", { cwd: created.path });
    execSync('git commit -m "first"', { cwd: created.path });
    const reviewedSha = execSync(`git rev-parse ${created.branch}`, { cwd: repo }).toString().trim();
    writeTaskMeta(registry, staleTaskId, {
      worktree: {
        path: created.path,
        branch: created.branch,
        base_ref: "main",
      },
    });
    parseBridgeJson(
      runBridge(["verdict", staleTaskId, "--payload-stdin", "--json"], {
        cwd: repo,
        registry,
        input: JSON.stringify({
          verdict: "approved",
          summary: "approved before later commit",
          reviewed_branch_head_sha: reviewedSha,
        }),
      }),
    );
    fs.writeFileSync(path.join(created.path, "second.txt"), "second\n");
    execSync("git add second.txt", { cwd: created.path });
    execSync('git commit -m "second"', { cwd: created.path });
    const currentSha = execSync(`git rev-parse ${created.branch}`, { cwd: repo }).toString().trim();

    const merge = runBridge(["merge", staleTaskId, "--json", "--no-tests"], { cwd: repo, registry });
    assert.notEqual(merge.status, 0);
    assert.match(`${merge.stdout}\n${merge.stderr}`, /MERGE_SHA_DRIFT|approved verdict reviewed/);

    const attentionTaskId = "task-cli-attention";
    const noShaTaskId = "task-cli-missing-sha";
    writeTaskMeta(registry, attentionTaskId, {
      worktree: { path: repo, branch: "main", base_ref: "main" },
    });
    writeTaskMeta(registry, noShaTaskId, {
      worktree: { path: repo, branch: "main", base_ref: "main" },
    });
    parseBridgeJson(
      runBridge(["verdict", attentionTaskId, "--set", "needs-attention", "--summary", "needs work", "--json"], {
        cwd: repo,
        registry,
      }),
    );
    parseBridgeJson(
      runBridge(["verdict", noShaTaskId, "--set", "approved", "--summary", "missing sha", "--json"], {
        cwd: repo,
        registry,
      }),
    );

    const pending = parseBridgeJson(runBridge(["verdicts", "--pending", "--json"], { cwd: repo, registry }));
    const byTask = new Map(pending.result.pending.map((entry) => [entry.task_id, entry]));
    assert.equal(byTask.get(staleTaskId).merge_ready, false);
    assert.equal(byTask.get(staleTaskId).merge_blocked_by, "head_drift");
    assert.equal(byTask.get(staleTaskId).branch_head_sha, reviewedSha);
    assert.equal(byTask.get(staleTaskId).reviewed_branch_head_sha, reviewedSha);
    assert.equal(byTask.get(staleTaskId).current_branch_head_sha, currentSha);
    assert.equal(byTask.get(attentionTaskId).merge_blocked_by, "missing_approval");
    assert.equal(byTask.get(noShaTaskId).merge_blocked_by, "missing_branch_sha");
  } finally {
    cleanup(repo);
    fs.rmSync(registry, { recursive: true, force: true });
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

test("createSubagentWorktree fallback removes partial branch from failed worktree add", () => {
  const repo = makeTempRepo();
  const altRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-altroot-"));
  const stalePath = path.join(altRoot, "task-fallback");
  fs.mkdirSync(stalePath, { recursive: true });
  fs.writeFileSync(path.join(stalePath, "stale.txt"), "stale");
  try {
    const result = createSubagentWorktree({
      cwd: repo,
      taskId: "task-fallback",
      backend: "codex",
      worktreeRoot: altRoot,
    });
    assert.equal(result.isolation_mode, "branch-only");
    assert.equal(result.branch, "subagent/codex/task-fallback");
    assert.equal(result.path, repo);
  } finally {
    try {
      execSync("git checkout main", { cwd: repo, stdio: "ignore" });
    } catch {
      // Best-effort cleanup; the temp repo is removed below.
    }
    fs.rmSync(altRoot, { recursive: true, force: true });
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
