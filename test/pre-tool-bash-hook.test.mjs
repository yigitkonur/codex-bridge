import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const hookPath = fileURLToPath(new URL("plugin/hooks/pre-tool-bash.mjs", root));
const rootPath = fileURLToPath(root);

function runHook(command, extraEnv = {}, cwd = rootPath) {
  const input = JSON.stringify({
    tool_name: "Bash",
    cwd,
    tool_input: { command },
  });
  const result = spawnSync(process.execPath, [hookPath], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_BRIDGE_DISABLE_WORKTREE_AUTO: "",
      CODEX_BRIDGE_HOOK_DISABLE: "",
      ...extraEnv,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function isDenied(output) {
  return output.hookSpecificOutput?.permissionDecision === "deny";
}

function isAllowed(output) {
  return output.hookSpecificOutput?.permissionDecision === "allow";
}

test("PreToolUse(Bash) auto-approves the bundled bridge task command after safety gates pass", () => {
  const output = runHook('node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task --background --json "audit"');

  assert.equal(isAllowed(output), true);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /auto-approved/);
});

test("PreToolUse(Bash) auto-approves the absolute bundled bridge task path", () => {
  const pluginRoot = fileURLToPath(new URL("plugin/", root));
  const output = runHook(
    `node "${pluginRoot}scripts/codex-bridge.mjs" task --background --json "audit"`,
    { CLAUDE_PLUGIN_ROOT: pluginRoot },
  );

  assert.equal(isAllowed(output), true);
});

test("PreToolUse(Bash) does not auto-approve non-bundled or compound bridge-looking commands", () => {
  assert.deepEqual(
    runHook('node /opt/task-runner/codex-bridge.mjs task --background --json "audit"'),
    { continue: true },
  );
  assert.deepEqual(
    runHook('node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task --background --json "audit"; echo nope'),
    { continue: true },
  );
  assert.deepEqual(
    runHook('node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task --background --json "audit $(date)"'),
    { continue: true },
  );
});

test("PreToolUse(Bash) allows codex-bridge write tasks because runtime isolates by default", () => {
  assert.deepEqual(runHook('codex-bridge task --write "edit files"'), {
    continue: true,
  });

  const bundled = runHook('node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task --write "edit files"');
  assert.equal(isAllowed(bundled), true);
});

test("PreToolUse(Bash) allows codex-bridge write tasks with enabled worktree isolation", () => {
  assert.deepEqual(runHook('codex-bridge task --write --worktree-auto "edit files"'), {
    continue: true,
  });
  assert.deepEqual(runHook('codex-bridge task --write --worktree-auto=true "edit files"'), {
    continue: true,
  });
});

test("PreToolUse(Bash) leaves explicit worktree opt-out to normal permission flow", () => {
  assert.deepEqual(runHook('codex-bridge task --write --worktree-auto=false "edit files"'), {
    continue: true,
  });
  assert.deepEqual(runHook('codex-bridge task --write --worktree-auto="false" "edit files"'), {
    continue: true,
  });
  assert.deepEqual(runHook('codex-bridge task --write --no-worktree-auto "edit files"'), {
    continue: true,
  });
  assert.deepEqual(
    runHook('node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task --write --no-worktree-auto "edit files"'),
    { continue: true },
  );
  assert.deepEqual(runHook('codex-bridge task --write --worktree-auto=0 "edit files"'), {
    continue: true,
  });
});

test("PreToolUse(Bash) keeps default isolation when --cwd is present", () => {
  const output = runHook('codex-bridge task --write --cwd /tmp/main-checkout "edit files"');

  assert.deepEqual(output, { continue: true });
});

test("PreToolUse(Bash) honors explicit worktree opt-out", () => {
  assert.deepEqual(
    runHook('codex-bridge task --write "edit files"', {
      CODEX_BRIDGE_DISABLE_WORKTREE_AUTO: "1",
    }),
    { continue: true },
  );
});

test("PreToolUse(Bash) rejects worktree-auto prompts with absolute workspace paths", () => {
  const output = runHook(`codex-bridge task --write "write ${rootPath}src/foo.ts"`);

  assert.equal(isDenied(output), true);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /absolute workspace paths/);
  assert.match(output.hookSpecificOutput.additionalContext, /worktree path rewrite required/);
  assert.match(output.hookSpecificOutput.additionalContext, /src\/foo\.ts/);
  assert.match(output.hookSpecificOutput.additionalContext, /repo-relative paths/);

  const explicit = runHook(`codex-bridge task --write --worktree-auto "write ${rootPath}src/foo.ts"`);
  assert.equal(isDenied(explicit), true);
});

test("PreToolUse(Bash) checks simple wrapped bridge task invocations", () => {
  const output = runHook(`cd "${rootPath}" && codex-bridge task --write --worktree-auto "write ${rootPath}src/foo.ts"`, {}, "/tmp");

  assert.equal(isDenied(output), true);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /absolute workspace paths/);
});

test("PreToolUse(Bash) scans prompt files for absolute workspace paths", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-hook-prompt-"));
  try {
    const promptFile = path.join(temp, "prompt.md");
    fs.writeFileSync(promptFile, `write ${rootPath}src/from-prompt.ts\n`, "utf8");
    const output = runHook(`codex-bridge task --write --worktree-auto --prompt-file "${promptFile}"`);

    assert.equal(isDenied(output), true);
    assert.match(output.hookSpecificOutput.additionalContext, /from-prompt\.ts/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("PreToolUse(Bash) allows worktree-auto prompts with outside absolute paths", () => {
  assert.deepEqual(runHook('codex-bridge task --write --worktree-auto "inspect /tmp/outside.txt"'), {
    continue: true,
  });
});

test("PreToolUse(Bash) does not match flags inside quoted prompt text", () => {
  // Prompt argument names the flag — must NOT short-circuit the gate.
  assert.deepEqual(runHook('codex-bridge task --write "Fix the --worktree-auto check"'), {
    continue: true,
  });
  assert.deepEqual(runHook("codex-bridge task --write 'audit --worktree-auto handling'"), {
    continue: true,
  });
  // Prompt mentions --read-only — must not flip the conflict path either.
  assert.deepEqual(runHook('codex-bridge task --write "explain --read-only mode"'), {
    continue: true,
  });
});

test("PreToolUse(Bash) handles task-bearing paths without rewrite", () => {
  assert.deepEqual(runHook('node /opt/task-runner/codex-bridge.mjs task --write --no-worktree-auto "edit"'), {
    continue: true,
  });
});

test("PreToolUse(Bash) denies read-only bridge tasks when sandbox enforcement is enabled", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-sandbox-enforce-"));
  try {
    fs.writeFileSync(path.join(temp, "config.yaml"), "codex_bridge:\n  sandbox_enforce: true\n");
    const output = runHook('codex-bridge task --read-only "audit"', {}, temp);

    assert.equal(isDenied(output), true);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /sandbox\.enforce: true/);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /--read-only is forbidden/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("PreToolUse(Bash) honors cwd sandbox enforcement opt-out over workspace config", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-sandbox-precedence-"));
  try {
    const workspace = path.join(temp, "workspace");
    const child = path.join(workspace, "child");
    fs.mkdirSync(child, { recursive: true });
    spawnSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    fs.writeFileSync(path.join(workspace, "config.yaml"), "codex_bridge:\n  sandbox_enforce: true\n");
    fs.writeFileSync(path.join(child, "config.yaml"), "codex_bridge:\n  sandbox_enforce: false\n");

    assert.deepEqual(runHook('codex-bridge task --read-only "audit"', {}, child), {
      continue: true,
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("PreToolUse(Bash) denies read-only bridge tasks when sandbox enforcement is enabled", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-sandbox-enforce-"));
  try {
    fs.writeFileSync(path.join(temp, "config.yaml"), "codex_bridge:\n  sandbox_enforce: true\n");
    const output = runHook('codex-bridge task --read-only "audit"', {}, temp);

    assert.equal(isDenied(output), true);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /sandbox\.enforce: true/);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /--read-only is forbidden/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("PreToolUse(Bash) honors cwd sandbox enforcement opt-out over workspace config", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-sandbox-precedence-"));
  try {
    const workspace = path.join(temp, "workspace");
    const child = path.join(workspace, "child");
    fs.mkdirSync(child, { recursive: true });
    spawnSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    fs.writeFileSync(path.join(workspace, "config.yaml"), "codex_bridge:\n  sandbox_enforce: true\n");
    fs.writeFileSync(path.join(child, "config.yaml"), "codex_bridge:\n  sandbox_enforce: false\n");

    assert.deepEqual(runHook('codex-bridge task --read-only "audit"', {}, child), {
      continue: true,
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
