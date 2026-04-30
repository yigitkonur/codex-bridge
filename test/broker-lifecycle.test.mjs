import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { ensureBrokerSession } from "../src/lib/broker-lifecycle.mjs";

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
      const session = await ensureBrokerSession(workspace, {
        scriptPath,
        timeoutMs: 1,
        env: {
          ...process.env,
          BROKER_TEST_CHILD_PID_FILE: childPidFile
        }
      });

      assert.equal(session, null);
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
    const session = await ensureBrokerSession(workspace, {
      scriptPath,
      timeoutMs: 1,
      killProcess(pid) {
        killCalls.push(pid);
      },
      env: {
        ...process.env,
        BROKER_TEST_CHILD_PID_FILE: childPidFile
      }
    });

    assert.equal(session, null);
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
