import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const hookPath = path.join(root, "plugin/hooks/pre-tool-agent.mjs");

function makeStubPlugin() {
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-hook-plugin-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-hook-workspace-"));
  const scriptsDir = path.join(pluginRoot, "scripts");
  const recordPath = path.join(pluginRoot, "task-record.json");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDir, "codex-bridge.mjs"),
    `#!/usr/bin/env node
import fs from "node:fs";
const [command, ...args] = process.argv.slice(2);
if (command === "auth-status") {
  process.stdout.write(JSON.stringify({
    ok: true,
    result: { loggedIn: process.env.STUB_CODEX_LOGGED_IN === "1" }
  }));
  process.exit(0);
}
if (command === "task") {
  fs.writeFileSync(process.env.STUB_RECORD_PATH, JSON.stringify({
    cwd: process.cwd(),
    args
  }));
  process.stdout.write(JSON.stringify({
    ok: true,
    result: {
      jobId: "task-hook-test",
      monitor: {
        tool_hint: {
          description: "stub monitor",
          command: "true",
          timeout_ms: 1,
          persistent: false
        }
      }
    }
  }));
  process.exit(0);
}
process.exit(2);
`,
    { mode: 0o755 },
  );
  return { pluginRoot, workspace, recordPath };
}

function runHook({ pluginRoot, workspace, recordPath, loggedIn }) {
  return spawnSync(process.execPath, [hookPath], {
    cwd: workspace,
    input: JSON.stringify({
      tool_name: "Agent",
      cwd: workspace,
      tool_input: {
        subagent_type: "Explore",
        prompt: "inspect the diff",
      },
    }),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      STUB_CODEX_LOGGED_IN: loggedIn ? "1" : "0",
      STUB_RECORD_PATH: recordPath,
    },
  });
}

test("pre-tool-agent only denies after auth preflight and dispatch succeed", () => {
  const fixture = makeStubPlugin();
  try {
    const result = runHook({ ...fixture, loggedIn: true });
    assert.equal(result.status, 0);

    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.additionalContext, /task-hook-test/);

    const record = JSON.parse(fs.readFileSync(fixture.recordPath, "utf8"));
    assert.equal(
      fs.realpathSync.native(record.cwd),
      fs.realpathSync.native(fixture.workspace),
    );
    assert.deepEqual(record.args.slice(0, 5), [
      "--background",
      "--json",
      "--intercepted-from",
      "Explore",
      "--read-only",
    ]);
  } finally {
    fs.rmSync(fixture.pluginRoot, { recursive: true, force: true });
    fs.rmSync(fixture.workspace, { recursive: true, force: true });
  }
});

test("pre-tool-agent falls back to native Agent when auth preflight fails", () => {
  const fixture = makeStubPlugin();
  try {
    const result = runHook({ ...fixture, loggedIn: false });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { continue: true });
    assert.equal(fs.existsSync(fixture.recordPath), false);
  } finally {
    fs.rmSync(fixture.pluginRoot, { recursive: true, force: true });
    fs.rmSync(fixture.workspace, { recursive: true, force: true });
  }
});

test("bundled task parsers include pre-tool-agent dispatch flags", () => {
  const pluginBundle = fs.readFileSync(
    path.join(root, "plugin/scripts/codex-bridge.mjs"),
    "utf8",
  );
  const skillBundle = fs.readFileSync(
    path.join(root, "skill/scripts/codex-bridge.mjs"),
    "utf8",
  );

  for (const bundle of [pluginBundle, skillBundle]) {
    assert.match(bundle, /"intercepted-from"/);
    assert.match(bundle, /"worktree-auto"/);
  }
});
