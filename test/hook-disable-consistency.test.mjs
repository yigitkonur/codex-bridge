// CI test: CODEX_BRIDGE_HOOK_DISABLE kill-switch consistency across wired hooks.
//
// Every hook wired in hooks/hooks.json must honor the kill switch:
//   CODEX_BRIDGE_HOOK_DISABLE=all    → all hooks exit silently (empty stdout)
//   CODEX_BRIDGE_HOOK_DISABLE=<name> → only that hook exits silently
//
// "Silently" means process.exit(0) with no stdout output — no transcript noise,
// no {"continue":true} response. This matches the SKILL.md advertised behavior.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

// All hooks wired in hooks/hooks.json, resolved to their plugin/hooks/ copy
// (the copy that actually gets installed by the plugin).
const WIRED_HOOKS = [
  {
    name: "session-lifecycle-hook",
    file: "plugin/hooks/session-lifecycle-hook.mjs",
    event: "SessionStart",
    input: '{"session_id":"x","cwd":"/tmp"}',
  },
  {
    name: "pre-tool-agent",
    file: "plugin/hooks/pre-tool-agent.mjs",
    event: null,
    input: '{"tool_name":"Agent","tool_input":{"subagent_type":"general-purpose","prompt":"hello"},"cwd":"/tmp"}',
  },
  {
    name: "post-tool-bash",
    file: "plugin/hooks/post-tool-bash.mjs",
    event: null,
    input: '{"tool_name":"Bash","tool_input":{"command":"echo hi"},"tool_response":{"stdout":"hi"},"cwd":"/tmp"}',
  },
  {
    name: "user-prompt-submit",
    file: "plugin/hooks/user-prompt-submit.mjs",
    event: null,
    input: '{"prompt":"hello","cwd":"/tmp"}',
  },
  {
    name: "subagent-stop",
    file: "plugin/hooks/subagent-stop.mjs",
    event: null,
    input: '{"agent_type":"general","cwd":"/tmp"}',
  },
  {
    name: "stop-gate",
    file: "plugin/hooks/stop-gate.mjs",
    event: null,
    input: '{"cwd":"/tmp"}',
  },
];

function runHook(hook, disableValue) {
  const hookPath = `${root}${hook.file}`;
  const args = [hookPath];
  if (hook.event) args.push(hook.event);

  const result = spawnSync(process.execPath, args, {
    input: hook.input,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_BRIDGE_HOOK_DISABLE: disableValue,
      CODEX_BRIDGE_PLUGIN_DATA: "/tmp/cb-hook-test",
    },
    timeout: 5000,
  });

  return { stdout: result.stdout, status: result.status, stderr: result.stderr };
}

test("CODEX_BRIDGE_HOOK_DISABLE=all produces empty stdout from every wired hook", () => {
  for (const hook of WIRED_HOOKS) {
    const { stdout, status } = runHook(hook, "all");
    assert.equal(status, 0, `${hook.name} should exit 0 when kill-switch=all`);
    assert.equal(
      stdout.trim(),
      "",
      `${hook.name}: expected empty stdout when CODEX_BRIDGE_HOOK_DISABLE=all, got: ${stdout.slice(0, 200)}`,
    );
  }
});

test("CODEX_BRIDGE_HOOK_DISABLE=session-lifecycle-hook silences only that hook", () => {
  const target = WIRED_HOOKS.find((h) => h.name === "session-lifecycle-hook");
  const { stdout, status } = runHook(target, "session-lifecycle-hook");
  assert.equal(status, 0, "session-lifecycle-hook should exit 0 when named");
  assert.equal(
    stdout.trim(),
    "",
    "session-lifecycle-hook should be silent when named in disable list",
  );
});

test("CODEX_BRIDGE_HOOK_DISABLE comma list silences all named hooks", () => {
  const names = ["post-tool-bash", "subagent-stop"];
  for (const name of names) {
    const hook = WIRED_HOOKS.find((h) => h.name === name);
    const { stdout, status } = runHook(hook, names.join(","));
    assert.equal(status, 0, `${name} should exit 0`);
    assert.equal(
      stdout.trim(),
      "",
      `${name} should be silent when in comma-separated disable list`,
    );
  }
});
