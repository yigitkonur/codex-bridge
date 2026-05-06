import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  findWorktreePromptAbsolutePathConflicts,
  formatWorktreePromptAbsolutePathConflict,
} from "../src/lib/task-runtime.mjs";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const sourceCli = fileURLToPath(new URL("src/codex-bridge.mjs", root));

function runBridge(args, { cwd = rootPath, env = {} } = {}) {
  return spawnSync(process.execPath, [sourceCli, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
      ...env,
    },
  });
}

function parseError(result) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  return envelope.error;
}

function withPluginData(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-path-guard-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("worktree absolute path detector catches launch-workspace paths", () => {
  const filePath = path.join(rootPath, "src", "foo.ts");
  const conflicts = findWorktreePromptAbsolutePathConflicts(
    `Edit ${filePath}:12 and keep tests green.`,
    rootPath,
  );

  assert.deepEqual(conflicts, [filePath]);
});

test("worktree absolute path detector catches launch-workspace paths when the root contains spaces", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex bridge root "));
  try {
    const filePath = path.join(workspace, "src", "foo.ts");
    const conflicts = findWorktreePromptAbsolutePathConflicts(
      `Edit ${filePath}:12 and keep tests green.`,
      workspace,
    );

    assert.deepEqual(conflicts, [filePath]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("worktree absolute path detector ignores outside absolute paths", () => {
  const conflicts = findWorktreePromptAbsolutePathConflicts(
    "Inspect /tmp/outside.txt but edit src/foo.ts.",
    rootPath,
  );

  assert.deepEqual(conflicts, []);
});

test("worktree absolute path conflict formatter is actionable", () => {
  const filePath = path.join(rootPath, "src", "foo.ts");
  const message = formatWorktreePromptAbsolutePathConflict([filePath], rootPath);

  assert.match(message, /absolute paths inside the launch workspace/);
  assert.match(message, /repo-relative paths/);
  assert.match(message, new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("task --worktree-auto rejects inline launch-workspace absolute paths before state creation", () =>
  withPluginData((pluginData) => {
    const filePath = path.join(rootPath, "src", "foo.ts");
    const result = runBridge(
      [
        "task",
        "--json",
        "--write",
        "--worktree-auto",
        `Edit ${filePath}:12.`,
      ],
      { env: { CODEX_BRIDGE_PLUGIN_DATA: pluginData } },
    );
    const error = parseError(result);

    assert.equal(result.status, 6);
    assert.equal(error.code, "WORKTREE_ABSOLUTE_PATH_CONFLICT");
    assert.match(error.message, /repo-relative paths/);
    assert.deepEqual(fs.readdirSync(pluginData), []);
  }));

test("task --worktree-auto rejects prompt_footer launch-workspace absolute paths before state creation", () =>
  withPluginData((pluginData) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-footer-"));
    const realWorkspace = fs.realpathSync.native(workspace);
    const filePath = path.join(realWorkspace, "src", "foo.ts");
    fs.writeFileSync(
      path.join(workspace, "config.yaml"),
      `prompt_footer: "Please edit ${filePath}"\n`,
      "utf8",
    );
    try {
      const result = runBridge(
        ["task", "--json", "--write", "--worktree-auto", "Edit src/foo.ts."],
        { cwd: workspace, env: { CODEX_BRIDGE_PLUGIN_DATA: pluginData } },
      );
      const error = parseError(result);

      assert.equal(result.status, 6);
      assert.equal(error.code, "WORKTREE_ABSOLUTE_PATH_CONFLICT");
      assert.deepEqual(fs.readdirSync(pluginData), []);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }));

test("task --worktree-auto checks workspace prompt_footer even when cwd config masks it", () =>
  withPluginData((pluginData) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-footer-root-"));
    const subdir = path.join(workspace, "subdir");
    fs.mkdirSync(subdir);
    execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
    const realWorkspace = fs.realpathSync.native(workspace);
    const filePath = path.join(realWorkspace, "src", "foo.ts");
    fs.writeFileSync(
      path.join(workspace, "config.yaml"),
      `prompt_footer: "Please edit ${filePath}"\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(subdir, "config.yaml"), 'prompt_footer: "safe footer"\n', "utf8");
    try {
      const result = runBridge(
        ["task", "--json", "--write", "--worktree-auto", "Edit src/foo.ts."],
        { cwd: subdir, env: { CODEX_BRIDGE_PLUGIN_DATA: pluginData } },
      );
      const error = parseError(result);

      assert.equal(result.status, 6);
      assert.equal(error.code, "WORKTREE_ABSOLUTE_PATH_CONFLICT");
      assert.deepEqual(fs.readdirSync(pluginData), []);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }));

test("task --worktree-auto rejects prompt-file launch-workspace absolute paths before state creation", () =>
  withPluginData((pluginData) => {
    const promptFile = path.join(os.tmpdir(), `codex-bridge-path-guard-${Date.now()}.md`);
    const filePath = path.join(rootPath, "src", "foo.ts");
    fs.writeFileSync(promptFile, `Edit ${filePath}.\n`, "utf8");
    try {
      const result = runBridge(
        ["task", "--json", "--write", "--worktree-auto", "--prompt-file", promptFile],
        { env: { CODEX_BRIDGE_PLUGIN_DATA: pluginData } },
      );
      const error = parseError(result);

      assert.equal(result.status, 6);
      assert.equal(error.code, "WORKTREE_ABSOLUTE_PATH_CONFLICT");
      assert.deepEqual(fs.readdirSync(pluginData), []);
    } finally {
      fs.rmSync(promptFile, { force: true });
    }
  }));

test("task --worktree-auto rejects structured brief launch-workspace absolute paths before state creation", () =>
  withPluginData((pluginData) => {
    const filePath = path.join(rootPath, "src", "foo.ts");
    const brief = JSON.stringify({
      goal: "Fix path handling",
      worker_assignment: `Edit ${filePath} safely.`,
    });
    const result = runBridge(
      ["task", "--json", "--write", "--worktree-auto", "--brief", brief, "Implement the brief."],
      { env: { CODEX_BRIDGE_PLUGIN_DATA: pluginData } },
    );
    const error = parseError(result);

    assert.equal(result.status, 6);
    assert.equal(error.code, "WORKTREE_ABSOLUTE_PATH_CONFLICT");
    assert.deepEqual(fs.readdirSync(pluginData), []);
  }));
