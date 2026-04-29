import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RUN_COMMAND_TIMEOUT_MS,
  runCommand,
  runCommandChecked
} from "../src/lib/process.mjs";

function makeSpawnResult(overrides = {}) {
  return {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    error: null,
    ...overrides
  };
}

test("runCommand forwards the default timeout to spawnSync", () => {
  let captured;
  const result = runCommand("git", ["status"], {
    cwd: "/tmp/example",
    spawnSync(command, args, options) {
      captured = { command, args, options };
      return makeSpawnResult({ stdout: "ok\n" });
    }
  });

  assert.deepEqual(captured.command, "git");
  assert.deepEqual(captured.args, ["status"]);
  assert.equal(captured.options.cwd, "/tmp/example");
  assert.equal(captured.options.timeout, DEFAULT_RUN_COMMAND_TIMEOUT_MS);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "ok\n");
});

test("runCommand forwards positive timeout overrides to spawnSync", () => {
  let captured;
  runCommand("git", ["diff"], {
    timeout: 30_000,
    spawnSync(command, args, options) {
      captured = { command, args, options };
      return makeSpawnResult();
    }
  });

  assert.equal(captured.options.timeout, 30_000);
});

test("runCommand keeps non-positive timeout overrides bounded", () => {
  let captured;
  runCommand("git", ["diff"], {
    timeout: 0,
    spawnSync(command, args, options) {
      captured = { command, args, options };
      return makeSpawnResult();
    }
  });

  assert.equal(captured.options.timeout, DEFAULT_RUN_COMMAND_TIMEOUT_MS);
});

test("runCommand timeout failures preserve diagnosable spawnSync errors", () => {
  const timeoutError = Object.assign(new Error("spawnSync git ETIMEDOUT"), {
    code: "ETIMEDOUT"
  });
  const spawnSync = () =>
    makeSpawnResult({
      status: null,
      signal: "SIGTERM",
      stdout: "partial output",
      stderr: "partial error",
      error: timeoutError
    });

  const result = runCommand("git", ["diff"], { spawnSync });

  assert.equal(result.status, 128);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.stdout, "partial output");
  assert.equal(result.stderr, "partial error");
  assert.equal(result.error, timeoutError);
  assert.throws(
    () => runCommandChecked("git", ["diff"], { spawnSync }),
    (error) => error === timeoutError
  );
});
