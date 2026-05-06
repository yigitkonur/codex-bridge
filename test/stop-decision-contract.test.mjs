// Regression test: Stop/SubagentStop hooks must never emit decision: "approve".
//
// The platform validator only accepts `decision: "block"`; "approve" is
// silently dropped. Allow-stop is expressed by omitting the `decision` field
// entirely. Earlier versions of the bundled `plugin-dev:hook-development`
// skill documented `decision: "approve|block"`, leading hook authors astray.
// This test pins the contract for codex-bridge's own Stop-class hooks so a
// future copy-paste from misleading docs fails loudly.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

const STOP_HOOK_FILES = [
  "hooks/stop-gate.mjs",
  "hooks/subagent-stop.mjs",
  "plugin/hooks/stop-gate.mjs",
  "plugin/hooks/subagent-stop.mjs",
];

const DECISION_VALUE_RE = /["']decision["']\s*:\s*["']([^"']+)["']/g;

test("Stop/SubagentStop hook sources only emit decision value 'block'", () => {
  for (const rel of STOP_HOOK_FILES) {
    const abs = path.join(root, rel);
    assert.ok(fs.existsSync(abs), `expected hook source to exist: ${rel}`);
    const source = fs.readFileSync(abs, "utf8");
    const values = [...source.matchAll(DECISION_VALUE_RE)].map((m) => m[1]);
    for (const value of values) {
      assert.equal(
        value,
        "block",
        `${rel}: Stop/SubagentStop decision must be "block" (got "${value}"); use no decision field to allow stop`,
      );
    }
  }
});

test("stop-gate runtime output never contains decision: 'approve'", () => {
  // Drive the hook with minimal input. Without a real bridge it will reach the
  // allow-stop or error path; neither may emit "approve" — the only valid
  // decision value is "block", and allow-stop omits the field entirely.
  const hookPath = path.join(root, "plugin/hooks/stop-gate.mjs");
  const result = spawnSync(process.execPath, [hookPath], {
    input: '{"cwd":"/tmp"}',
    encoding: "utf8",
    env: { ...process.env, CODEX_BRIDGE_PLUGIN_DATA: "/tmp/cb-stop-decision-test" },
    timeout: 10000,
  });
  assert.ok(
    !/"decision"\s*:\s*"approve"/.test(result.stdout),
    `stop-gate emitted decision: "approve"; only "block" is valid: ${result.stdout}`,
  );
});
