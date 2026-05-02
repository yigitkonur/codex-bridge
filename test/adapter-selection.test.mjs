import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  guardCapability,
  selectAdapter,
  _resetAdapterCache
} from "../src/adapters/index.mjs";

const BRIDGE_SCRIPT = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));

function makeUpdateCacheRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-version-cache-"));
  fs.writeFileSync(
    path.join(root, "codex-bridge-update.json"),
    JSON.stringify({ checkedAt: Date.now(), latestVersion: "1.5.0" })
  );
  return root;
}

function runVersion(args = [], { cwd = process.cwd(), env = {} } = {}) {
  const cacheRoot = makeUpdateCacheRoot();
  const result = spawnSync(process.execPath, [BRIDGE_SCRIPT, "version", "--json", ...args], {
    cwd,
    env: {
      ...process.env,
      CODEX_BRIDGE_PLUGIN_DATA: cacheRoot,
      CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
      CODEX_BRIDGE_BACKEND: "",
      ...env,
    },
    encoding: "utf8",
  });
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  return result;
}

function parseJsonOutput(result) {
  assert.equal(result.stderr, "");
  assert.notEqual(result.stdout.trim(), "");
  return JSON.parse(result.stdout);
}

test("selectAdapter honors explicit, env, cwd, workspace, user, and default precedence", async () => {
  _resetAdapterCache();

  assert.equal((await selectAdapter({
    backend: "codex",
    envBackend: "gemini",
  })).name, "codex");

  assert.equal((await selectAdapter({
    envBackend: "codex",
    cwdConfig: { default_backend: "gemini" },
  })).name, "codex");

  assert.equal((await selectAdapter({
    cwdConfig: { default_backend: "codex" },
    workspaceConfig: { default_backend: "gemini" },
    userConfig: { default_backend: "gemini" },
  })).name, "codex");

  assert.equal((await selectAdapter({
    workspaceConfig: { default_backend: "codex" },
    userConfig: { default_backend: "gemini" },
  })).name, "codex");

  assert.equal((await selectAdapter({
    userConfig: { default_backend: "codex" },
    defaultBackend: "gemini",
  })).name, "codex");
});

test("selectAdapter rejects the highest-precedence unknown backend", async () => {
  await assert.rejects(
    () => selectAdapter({
      cwdConfig: { default_backend: "gemini" },
      workspaceConfig: { default_backend: "codex" },
    }),
    {
      name: "AdapterError",
      code: "BACKEND_INCAPABLE",
    }
  );
});

test("adapter capability gates expose implemented optional verbs", async () => {
  const adapter = await selectAdapter({ defaultBackend: "codex" });

  assert.doesNotThrow(() => guardCapability(adapter, "supports_plan_mode"));
  assert.doesNotThrow(() => guardCapability(adapter, "supports_resume"));
  assert.doesNotThrow(() => guardCapability(adapter, "supports_questions"));
  assert.doesNotThrow(() => guardCapability(adapter, "supports_steering"));
  assert.equal(typeof adapter.dispatch, "function");
  assert.equal(typeof adapter.resume, "function");
  assert.equal(typeof adapter.respond, "function");
  assert.equal(typeof adapter.steer, "function");
  assert.throws(
    () => guardCapability({ name: "limited", capabilities: () => ({ supports_steering: false }) }, "supports_steering"),
    {
      name: "AdapterError",
      code: "BACKEND_INCAPABLE",
    }
  );
});

test("version --json resolves active backend from env and rejects unknown env backend", () => {
  const ok = runVersion([], { env: { CODEX_BRIDGE_BACKEND: "codex" } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(parseJsonOutput(ok).result.active_backend, "codex");

  const rejected = runVersion([], { env: { CODEX_BRIDGE_BACKEND: "gemini" } });
  assert.equal(rejected.status, 6, rejected.stderr);
  const envelope = parseJsonOutput(rejected);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "BACKEND_INCAPABLE");
});

test("version --backend overrides cwd config and cwd config overrides workspace config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-version-root-"));
  const subdir = path.join(root, "subdir");
  fs.mkdirSync(subdir);

  try {
    const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);

    fs.writeFileSync(path.join(root, "config.yaml"), "codex_bridge:\n  default_backend: gemini\n");
    fs.writeFileSync(path.join(subdir, "config.yaml"), "codex_bridge:\n  default_backend: codex\n");

    const cwdWins = runVersion(["--cwd", subdir], { cwd: root });
    assert.equal(cwdWins.status, 0, cwdWins.stderr);
    assert.equal(parseJsonOutput(cwdWins).result.active_backend, "codex");

    fs.writeFileSync(path.join(subdir, "config.yaml"), "codex_bridge:\n  default_backend: gemini\n");
    const configRejects = runVersion(["--cwd", subdir], { cwd: root });
    assert.equal(configRejects.status, 6, configRejects.stderr);
    assert.equal(parseJsonOutput(configRejects).error.code, "BACKEND_INCAPABLE");

    const flagWins = runVersion(["--cwd", subdir, "--backend", "codex"], { cwd: root });
    assert.equal(flagWins.status, 0, flagWins.stderr);
    assert.equal(parseJsonOutput(flagWins).result.active_backend, "codex");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
