import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { __testHooks__, ensureBrokerSession, loadBrokerSession, teardownBrokerSession } from "../src/lib/broker-lifecycle.mjs";

const { resolveBrokerScriptPath } = __testHooks__;

function writeIdleBrokerScript(scriptPath) {
  fs.writeFileSync(
    scriptPath,
    [
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.BROKER_TEST_CHILD_PID_FILE, `${process.pid}\\n`, "utf8");',
      "setInterval(() => {}, 1000);"
    ].join("\n"),
    "utf8"
  );
}

function writeListeningBrokerScript(scriptPath) {
  fs.writeFileSync(
    scriptPath,
    [
      'import fs from "node:fs";',
      'import net from "node:net";',
      'const endpoint = process.argv[process.argv.indexOf("--endpoint") + 1];',
      'const pidFile = process.argv[process.argv.indexOf("--pid-file") + 1];',
      'const socketPath = endpoint.replace(/^unix:/, "");',
      'try { fs.unlinkSync(socketPath); } catch {}',
      'const server = net.createServer((socket) => socket.end());',
      'server.listen(socketPath, () => {',
      '  fs.appendFileSync(process.env.BROKER_TEST_COUNT_FILE, "spawned\\n", "utf8");',
      '  fs.writeFileSync(pidFile, `${process.pid}\\n`, "utf8");',
      '});',
      'setInterval(() => {}, 1000);'
    ].join("\n"),
    "utf8"
  );
}

async function readPidFile(pidFile) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    if (fs.existsSync(pidFile)) {
      return Number(fs.readFileSync(pidFile, "utf8").trim());
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for child pid file: ${pidFile}`);
}

function signalTestBroker(pid, killImpl) {
  if (!Number.isFinite(pid)) {
    return;
  }

  const targets = process.platform === "win32" ? [pid] : [-pid, pid];
  for (const target of targets) {
    try {
      killImpl(target, "SIGTERM");
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }
}

function restoreEnv(name, previousValue) {
  if (previousValue == null) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
}

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

test(
  "startup timeout uses the default process killer for the spawned broker pid",
  { skip: process.platform === "win32" ? "default killer uses taskkill on Windows" : false },
  async () => {
    const previousPluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-broker-lifecycle-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));
    const scriptPath = path.join(root, "idle-broker.mjs");
    const childPidFile = path.join(root, "child.pid");
    const originalKill = process.kill;
    const killImpl = originalKill.bind(process);
    const killCalls = [];
    let childPid = null;

    process.env.CODEX_BRIDGE_PLUGIN_DATA = root;
    writeIdleBrokerScript(scriptPath);
    process.kill = (pid, signal) => {
      killCalls.push({ pid, signal });
      return true;
    };

    try {
      await assert.rejects(
        () => ensureBrokerSession(workspace, {
          scriptPath,
          timeoutMs: 150,
          env: {
            ...process.env,
            BROKER_TEST_CHILD_PID_FILE: childPidFile
          }
        }),
        (error) => {
          assert.equal(error.code, "BROKER_START_FAILED");
          return true;
        }
      );
      childPid = await readPidFile(childPidFile);
      assert.ok(Number.isFinite(childPid) && childPid > 0);
      assert.deepEqual(killCalls, [{ pid: -childPid, signal: "SIGTERM" }]);
    } finally {
      process.kill = originalKill;
      if (childPid == null && fs.existsSync(childPidFile)) {
        childPid = Number(fs.readFileSync(childPidFile, "utf8").trim());
      }
      signalTestBroker(childPid, killImpl);
      restoreEnv("CODEX_BRIDGE_PLUGIN_DATA", previousPluginData);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
);

test("startup timeout still uses an injected killProcess", async () => {
  const previousPluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-broker-lifecycle-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));
  const scriptPath = path.join(root, "idle-broker.mjs");
  const childPidFile = path.join(root, "child.pid");
  const killCalls = [];
  const killImpl = process.kill.bind(process);
  let childPid = null;

  process.env.CODEX_BRIDGE_PLUGIN_DATA = root;
  writeIdleBrokerScript(scriptPath);

  try {
    await assert.rejects(
      () => ensureBrokerSession(workspace, {
        scriptPath,
        timeoutMs: 150,
        killProcess(pid) {
          killCalls.push(pid);
        },
        env: {
          ...process.env,
          BROKER_TEST_CHILD_PID_FILE: childPidFile
        }
      }),
      (error) => {
        assert.equal(error.code, "BROKER_START_FAILED");
        return true;
      }
    );
    childPid = await readPidFile(childPidFile);
    assert.deepEqual(killCalls, [childPid]);
  } finally {
    if (childPid == null && fs.existsSync(childPidFile)) {
      childPid = Number(fs.readFileSync(childPidFile, "utf8").trim());
    }
    signalTestBroker(childPid, killImpl);
    restoreEnv("CODEX_BRIDGE_PLUGIN_DATA", previousPluginData);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
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

test(
  "concurrent cold starts share one broker session",
  { skip: process.platform === "win32" ? "test broker script listens on unix sockets" : false },
  async () => {
    const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-broker-concurrent-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));
    const scriptPath = path.join(root, "listening-broker.mjs");
    const countFile = path.join(root, "spawn-count.txt");
    writeListeningBrokerScript(scriptPath);
    process.env.CODEX_BRIDGE_PLUGIN_DATA = root;

    let session = null;
    try {
      const [left, right] = await Promise.all([
        ensureBrokerSession(workspace, {
          scriptPath,
          timeoutMs: 5000,
          env: { ...process.env, BROKER_TEST_COUNT_FILE: countFile }
        }),
        ensureBrokerSession(workspace, {
          scriptPath,
          timeoutMs: 5000,
          env: { ...process.env, BROKER_TEST_COUNT_FILE: countFile }
        })
      ]);
      session = left;
      assert.equal(left.endpoint, right.endpoint);
      assert.equal(fs.readFileSync(countFile, "utf8").trim().split(/\r?\n/).length, 1);
    } finally {
      if (session) {
        teardownBrokerSession({ ...session, killProcess: (pid) => {
          try { process.kill(pid, "SIGTERM"); } catch {}
        } });
      }
      restoreEnv("CODEX_BRIDGE_PLUGIN_DATA", previousBridgePluginData);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
);
