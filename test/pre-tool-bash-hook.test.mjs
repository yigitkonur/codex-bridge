import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const hookPath = fileURLToPath(new URL("plugin/hooks/pre-tool-bash.mjs", root));

function runHook(command, extraEnv = {}) {
  const input = JSON.stringify({
    tool_name: "Bash",
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
