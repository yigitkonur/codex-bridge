import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { __testHooks__, ensureBrokerSession, loadBrokerSession } from "../src/lib/broker-lifecycle.mjs";

const { resolveBrokerScriptPath } = __testHooks__;

test("source layout prefers relocated adapter broker over obsolete source broker", () => {
  const moduleUrl = new URL("../src/lib/broker-lifecycle.mjs", import.meta.url);
  const legacyBroker = fileURLToPath(new URL("../app-server-broker.mjs", moduleUrl));
  const relocatedBroker = fileURLToPath(new URL("../adapters/codex/broker.mjs", moduleUrl));

  const scriptPath = resolveBrokerScriptPath({
    moduleUrl,
    existsSync: (candidate) => candidate === legacyBroker || candidate === relocatedBroker
  });

  assert.equal(scriptPath, relocatedBroker);
});

test("bundled layout prefers bundled broker output", () => {
  const moduleUrl = new URL("../skill/scripts/codex-bridge.mjs", import.meta.url);
  const bundledBroker = fileURLToPath(new URL("../app-server-broker.mjs", moduleUrl));
  const sourceLikeBroker = fileURLToPath(new URL("../adapters/codex/broker.mjs", moduleUrl));

  const scriptPath = resolveBrokerScriptPath({
    moduleUrl,
    existsSync: (candidate) => candidate === bundledBroker || candidate === sourceLikeBroker
  });

  assert.equal(scriptPath, bundledBroker);
});

test("broker startup failure is surfaced instead of returning a null session", async () => {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-broker-lifecycle-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));
  const scriptPath = path.join(root, "never-listens.mjs");
  fs.writeFileSync(
    scriptPath,
    "console.error('broker test process never opened its endpoint');\nsetInterval(() => {}, 1000);\n",
    "utf8"
  );

  process.env.CODEX_BRIDGE_PLUGIN_DATA = root;
  let killAttempted = false;
  try {
    await assert.rejects(
      () => ensureBrokerSession(workspace, {
        scriptPath,
        timeoutMs: 150,
        killProcess: (pid) => {
          killAttempted = true;
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // The process may already have exited.
          }
        }
      }),
      (error) => {
        assert.equal(error.code, "BROKER_START_FAILED");
        assert.match(error.message, /Codex app-server broker failed to start/);
        assert.match(error.message, new RegExp(scriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      }
    );
    assert.equal(killAttempted, true);
    assert.equal(loadBrokerSession(workspace), null);
  } finally {
    if (previousBridgePluginData == null) {
      delete process.env.CODEX_BRIDGE_PLUGIN_DATA;
    } else {
      process.env.CODEX_BRIDGE_PLUGIN_DATA = previousBridgePluginData;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
