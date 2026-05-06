import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bridgePath = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-global-flags-"));
  const repo = path.join(root, "repo");
  const outside = path.join(root, "outside");
  const pluginData = path.join(root, "plugin-data");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(pluginData, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "config.yaml"), "session_dir: .codex-bridge-sessions\n", "utf8");
  const expectedWorkspaceRoot = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { repo, outside, pluginData, expectedWorkspaceRoot };
}

function runBridge(args, fixture) {
  return spawnSync(process.execPath, [bridgePath, ...args], {
    cwd: fixture.outside,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_BRIDGE_PLUGIN_DATA: fixture.pluginData,
      CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
    },
  });
}

function parseEnvelope(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "", result.stderr);
  return JSON.parse(result.stdout);
}

test("global --cwd before subcommand targets the requested workspace", (t) => {
  const fixture = makeFixture(t);
  const envelope = parseEnvelope(runBridge(["--cwd", fixture.repo, "status", "--json"], fixture));

  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "status");
  assert.equal(envelope.result.workspaceRoot, fixture.expectedWorkspaceRoot);
});

test("global --json and -C before subcommand still produce a command envelope", (t) => {
  const fixture = makeFixture(t);
  const envelope = parseEnvelope(runBridge(["--json", "-C", fixture.repo, "status", "--all"], fixture));

  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "status");
  assert.equal(envelope.result.workspaceRoot, fixture.expectedWorkspaceRoot);
});

test("global --cwd before task --help reaches subcommand help", (t) => {
  const fixture = makeFixture(t);
  const result = runBridge(["--cwd", fixture.repo, "task", "--help"], fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^codex-bridge task /);
  assert.match(result.stdout, /Global flags \(parsed before or after the subcommand\):/);
});

test("post-subcommand value options can still consume flag-looking values", (t) => {
  const fixture = makeFixture(t);
  const result = runBridge(["task", "--prompt-file", "--cwd"], fixture);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Prompt file not found:/);
  assert.match(result.stderr, /--cwd/);
});

test("double dash after subcommand keeps later globals positional", (t) => {
  const fixture = makeFixture(t);
  const result = runBridge(["status", "--", "--json"], fixture);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /No job found for "--json"/);
});
