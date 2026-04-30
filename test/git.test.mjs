import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectReviewContext } from "../src/lib/git.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: 10000
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result;
}

function createRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-git-test-"));
  run("git", ["init", "-q"], { cwd: repo });
  return repo;
}

test("working-tree context includes normal untracked text but skips symlink targets outside repo", (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation is environment-dependent on Windows");
    return;
  }

  const repo = createRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-git-outside-"));

  try {
    fs.writeFileSync(path.join(repo, "notes.txt"), "normal untracked text\n", "utf8");
    fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET_OUTSIDE_REPO\n", "utf8");

    try {
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "secret-link"));
    } catch (error) {
      t.skip(`symlink unavailable: ${error.message}`);
      return;
    }

    const context = collectReviewContext(
      repo,
      { mode: "working-tree" },
      { includeDiff: true, maxInlineFiles: 10 }
    );

    assert.match(context.content, /### notes\.txt\n```\nnormal untracked text\n```/);
    assert.match(context.content, /### secret-link\n\(skipped: symlink\)/);
    assert.doesNotMatch(context.content, /SECRET_OUTSIDE_REPO/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("working-tree summary context lists untracked paths without file bodies", () => {
  const repo = createRepo();

  try {
    fs.writeFileSync(path.join(repo, "notes.txt"), "normal untracked text\n", "utf8");

    const context = collectReviewContext(
      repo,
      { mode: "working-tree" },
      { includeDiff: false, maxInlineFiles: 10 }
    );

    assert.equal(context.inputMode, "self-collect");
    assert.match(context.content, /## Changed Files\n\nnotes\.txt/);
    assert.match(context.content, /## Untracked Files\n\nnotes\.txt/);
    assert.doesNotMatch(context.content, /normal untracked text/);
    assert.doesNotMatch(context.content, /```/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
