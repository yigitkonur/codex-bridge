import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  findWorktreePromptAbsolutePathConflicts,
  formatWorktreePromptAbsolutePathConflict,
} from "../src/lib/task-runtime.mjs";

const rootPath = fileURLToPath(new URL("../", import.meta.url));
const bridgePath = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));

function runRejectedTask(args) {
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-path-guard-state-"));
  try {
    const result = spawnSync(process.execPath, [bridgePath, ...args], {
      cwd: rootPath,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
        CODEX_BRIDGE_PLUGIN_DATA: pluginData,
      },
    });

    assert.equal(result.status, 6, result.stderr);
    assert.deepEqual(fs.readdirSync(pluginData), []);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
}

test("worktree prompt guard detects absolute paths inside the launch workspace", () => {
  const conflicts = findWorktreePromptAbsolutePathConflicts(
    `Write ${rootPath}src/foo.ts and ${rootPath}test/foo.test.mjs:12.`,
    rootPath,
  );

  assert.deepEqual(conflicts, [
    `${rootPath}src/foo.ts`,
    `${rootPath}test/foo.test.mjs`,
  ]);
});

test("worktree prompt guard ignores absolute paths outside the launch workspace", () => {
  const conflicts = findWorktreePromptAbsolutePathConflicts(
    "Inspect /tmp/codex-bridge-output.txt and then edit src/foo.ts",
    rootPath,
  );

  assert.deepEqual(conflicts, []);
});

test("worktree prompt guard formats an actionable validation error", () => {
  const message = formatWorktreePromptAbsolutePathConflict([`${rootPath}src/foo.ts`], rootPath);

  assert.match(message, /--worktree-auto cannot safely dispatch/);
  assert.match(message, /main checkout/);
  assert.match(message, /repo-relative paths/);
  assert.match(message, /src\/foo\.ts/);
});

test("task command rejects default-isolated write prompts before creating a job", () => {
  const envelope = runRejectedTask(
    [
      "task",
      "--json",
      "--write",
      `write ${rootPath}src/foo.ts`,
    ],
  );

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "WORKTREE_ABSOLUTE_PATH_CONFLICT");
  assert.match(envelope.error.message, /main checkout/);
});

test("task command rejects prompt-file absolute workspace paths before creating a job", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-path-guard-prompt-"));
  try {
    const promptFile = path.join(temp, "prompt.md");
    fs.writeFileSync(promptFile, `write ${rootPath}src/from-prompt.ts\n`, "utf8");
    const envelope = runRejectedTask([
      "task",
      "--json",
      "--write",
      "--worktree-auto",
      "--prompt-file",
      promptFile,
    ]);

    assert.equal(envelope.error.code, "WORKTREE_ABSOLUTE_PATH_CONFLICT");
    assert.match(envelope.error.message, /from-prompt\.ts/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("task command rejects brief absolute workspace paths before creating a job", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-path-guard-brief-"));
  try {
    const briefFile = path.join(temp, "brief.json");
    fs.writeFileSync(
      briefFile,
      JSON.stringify({
        goal: "Guard absolute prompt paths",
        worker_assignment: `write ${rootPath}src/from-brief.ts`,
      }),
      "utf8",
    );
    const envelope = runRejectedTask([
      "task",
      "--json",
      "--write",
      "--worktree-auto",
      "--brief",
      `@${briefFile}`,
      "Implement the brief.",
    ]);

    assert.equal(envelope.error.code, "WORKTREE_ABSOLUTE_PATH_CONFLICT");
    assert.match(envelope.error.message, /from-brief\.ts/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
