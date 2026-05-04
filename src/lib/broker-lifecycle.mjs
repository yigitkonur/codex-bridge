import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { terminateProcessTree } from "./process.mjs";
import { resolveStateDir, writeJsonFileAtomic } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";
const BROKER_LOCK_FILE = "broker.lock";
const BROKER_LOCK_TIMEOUT_MS = 5_000;
const BROKER_STALE_LOCK_MS = 30_000;

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

function resolveBrokerLockFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_LOCK_FILE);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBrokerLockPid(lockFile) {
  try {
    const [pidLine] = fs.readFileSync(lockFile, "utf8").split(/\r?\n/, 1);
    const pid = Number.parseInt(pidLine, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function acquireBrokerLock(cwd, { timeoutMs = BROKER_LOCK_TIMEOUT_MS, staleMs = BROKER_STALE_LOCK_MS } = {}) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockFile = resolveBrokerLockFile(cwd);
  const startedAt = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      let ownedIno = null;
      try { ownedIno = fs.fstatSync(fd).ino; } catch { /* noop */ }
      return () => {
        try { fs.closeSync(fd); } catch { /* noop */ }
        try {
          if (ownedIno !== null) {
            const stat = fs.statSync(lockFile);
            if (stat.ino !== ownedIno) return;
          }
          fs.unlinkSync(lockFile);
        } catch (releaseError) {
          if (releaseError?.code !== "ENOENT") {
            // Best effort; do not throw from a finally-style release.
          }
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        const stat = fs.statSync(lockFile);
        const ownerPid = readBrokerLockPid(lockFile);
        const ownerAlive = ownerPid ? isProcessAlive(ownerPid) : false;
        if ((ownerPid && !ownerAlive) || (!ownerPid && Date.now() - stat.mtimeMs > staleMs)) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        const err = new Error(`Timed out waiting for broker session lock: ${lockFile}`);
        err.code = "BROKER_LOCK_TIMEOUT";
        throw err;
      }
      await sleep(50);
    }
  }
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  writeJsonFileAtomic(resolveBrokerStateFile(cwd), session);
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

function isSourceBrokerLifecycleUrl(moduleUrl) {
  try {
    const modulePath = fileURLToPath(moduleUrl);
    return (
      path.basename(modulePath) === "broker-lifecycle.mjs" &&
      path.basename(path.dirname(modulePath)) === "lib" &&
      path.basename(path.dirname(path.dirname(modulePath))) === "src"
    );
  } catch {
    return false;
  }
}

function readBrokerLogTail(logFile, maxChars = 4000) {
  try {
    const log = fs.readFileSync(logFile, "utf8").trim();
    if (!log) {
      return "";
    }
    return log.length > maxChars ? log.slice(-maxChars) : log;
  } catch {
    return "";
  }
}

function createBrokerStartFailure({ endpoint, scriptPath, logFile, timeoutMs }) {
  const logTail = readBrokerLogTail(logFile);
  const detail = logTail ? ` Broker log:\n${logTail}` : " No broker log output was captured.";
  const error = new Error(
    `Codex app-server broker failed to start within ${timeoutMs}ms at ${endpoint} using ${scriptPath}.${detail}`
  );
  error.code = "BROKER_START_FAILED";
  return error;
}

function resolveBrokerScriptPath({ moduleUrl = import.meta.url, existsSync = fs.existsSync } = {}) {
  // Three possible broker locations:
  //   plugin/scripts/app-server-broker.mjs — sibling of plugin/scripts/codex-bridge.mjs (canonical from v2.0)
  //   skill/app-server-broker.mjs — one level up from skill/scripts/codex-bridge.mjs (legacy layout)
  //   src/adapters/codex/broker.mjs — source mode, relative to src/lib/broker-lifecycle.mjs
  const pluginBroker = new URL("./app-server-broker.mjs", moduleUrl);
  const bundledBroker = new URL("../app-server-broker.mjs", moduleUrl);
  const sourceBroker = new URL("../adapters/codex/broker.mjs", moduleUrl);
  const candidates = isSourceBrokerLifecycleUrl(moduleUrl)
    ? [sourceBroker, pluginBroker, bundledBroker]
    : [pluginBroker, bundledBroker, sourceBroker];
  for (const url of candidates) {
    const p = fileURLToPath(url);
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Could not locate broker script. Tried:\n  ${candidates
      .map((url) => fileURLToPath(url))
      .join("\n  ")}`
  );
}

export async function ensureBrokerSession(cwd, options = {}) {
  const release = await acquireBrokerLock(cwd, {
    timeoutMs: options.lockTimeoutMs ?? BROKER_LOCK_TIMEOUT_MS,
    staleMs: options.lockStaleMs ?? BROKER_STALE_LOCK_MS,
  });
  try {
    const existing = loadBrokerSession(cwd);
    if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
      return existing;
    }

    if (existing) {
      teardownBrokerSession({
        endpoint: existing.endpoint ?? null,
        pidFile: existing.pidFile ?? null,
        logFile: existing.logFile ?? null,
        sessionDir: existing.sessionDir ?? null,
        pid: existing.pid ?? null,
        killProcess: options.killProcess ?? null
      });
      clearBrokerSession(cwd);
    }

    const sessionDir = createBrokerSessionDir();
    const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
    const endpoint = endpointFactory(sessionDir, options.platform);
    const pidFile = path.join(sessionDir, "broker.pid");
    const logFile = path.join(sessionDir, "broker.log");
    const scriptPath = options.scriptPath ?? resolveBrokerScriptPath();
    const timeoutMs = options.timeoutMs ?? 2000;

    const child = spawnBrokerProcess({
      scriptPath,
      cwd,
      endpoint,
      pidFile,
      logFile,
      env: options.env ?? process.env
    });

    const ready = await waitForBrokerEndpoint(endpoint, timeoutMs);
    if (!ready) {
      const startFailure = createBrokerStartFailure({ endpoint, scriptPath, logFile, timeoutMs });
      teardownBrokerSession({
        endpoint,
        pidFile,
        logFile,
        sessionDir,
        pid: child.pid ?? null,
        killProcess: options.killProcess ?? terminateProcessTree
      });
      throw startFailure;
    }

    const session = {
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null
    };
    saveBrokerSession(cwd, session);
    return session;
  } finally {
    release();
  }
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}

export const __testHooks__ = {
  resolveBrokerScriptPath,
  acquireBrokerLock
};
