import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const hookPath = fileURLToPath(new URL("plugin/hooks/pre-tool-bash.mjs", root));

function runHook(command, extraEnv = {}, cwd) {
  const payload = { tool_name: "Bash", tool_input: { command } };
  if (cwd) payload.cwd = cwd;
  const input = JSON.stringify(payload);
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

test("PreToolUse(Bash) denies codex-bridge write tasks without worktree isolation", () => {
  const output = runHook('codex-bridge task --write "edit files"');

  assert.equal(isDenied(output), true);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /requires worktree isolation/);
  assert.match(output.hookSpecificOutput.additionalContext, /task --worktree-auto --write/);
});

test("PreToolUse(Bash) allows codex-bridge write tasks with enabled worktree isolation", () => {
  assert.deepEqual(runHook('codex-bridge task --write --worktree-auto "edit files"'), {
    continue: true,
  });
  assert.deepEqual(runHook('codex-bridge task --write --worktree-auto=true "edit files"'), {
    continue: true,
  });
});

test("PreToolUse(Bash) treats disabled worktree-auto as missing", () => {
  assert.equal(isDenied(runHook('codex-bridge task --write --worktree-auto=false "edit files"')), true);
  assert.equal(isDenied(runHook('codex-bridge task --write --worktree-auto="false" "edit files"')), true);
});

test("PreToolUse(Bash) does not treat --cwd as worktree isolation", () => {
  const output = runHook('codex-bridge task --write --cwd /tmp/main-checkout "edit files"');

  assert.equal(isDenied(output), true);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /requires worktree isolation/);
});

test("PreToolUse(Bash) honors explicit worktree opt-out", () => {
  assert.deepEqual(
    runHook('codex-bridge task --write "edit files"', {
      CODEX_BRIDGE_DISABLE_WORKTREE_AUTO: "1",
    }),
    { continue: true },
  );
});

test("PreToolUse(Bash) does not match flags inside quoted prompt text", () => {
  // Prompt argument names the flag — must NOT short-circuit the gate.
  assert.equal(
    isDenied(runHook('codex-bridge task --write "Fix the --worktree-auto check"')),
    true,
  );
  assert.equal(
    isDenied(runHook("codex-bridge task --write 'audit --worktree-auto handling'")),
    true,
  );
  // Prompt mentions --read-only — must not flip the conflict path either.
  assert.equal(
    isDenied(runHook('codex-bridge task --write "explain --read-only mode"')),
    true,
  );
});

test("PreToolUse(Bash) rewrite suggestion does not corrupt task-bearing paths", () => {
  const output = runHook('node /opt/task-runner/codex-bridge.mjs task --write "edit"');
  assert.equal(isDenied(output), true);
  assert.match(
    output.hookSpecificOutput.additionalContext,
    /\/opt\/task-runner\/codex-bridge\.mjs task --worktree-auto --write/,
  );
  assert.doesNotMatch(
    output.hookSpecificOutput.additionalContext,
    /task --worktree-auto-runner/,
  );
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
