#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE_BRIDGE = path.join(ROOT, "src", "codex-bridge.mjs");
const SKILL_BRIDGE = path.join(ROOT, "skill", "scripts", "codex-bridge.mjs");
const PLUGIN_BRIDGE = path.join(ROOT, "plugin", "scripts", "codex-bridge.mjs");

function parseArgs(argv) {
  const options = {
    requireCodex: false,
    json: false,
    cwd: null,
    taskPrompt: "Reply with exactly: codex-bridge smoke ok",
    skipTask: false,
    skipReview: false,
    staticOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--require-codex") options.requireCodex = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--cwd") options.cwd = path.resolve(argv[++i] ?? "");
    else if (arg === "--task-prompt") options.taskPrompt = argv[++i] ?? "";
    else if (arg === "--skip-task") options.skipTask = true;
    else if (arg === "--skip-review") options.skipReview = true;
    else if (arg === "--static-only") options.staticOnly = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node scripts/runtime-smoke.mjs [--require-codex] [--json] [--cwd <workspace>]",
      "",
      "Runs static-safe CLI probes always. When Codex CLI + app-server are available,",
      "runs setup, foreground task, review, and event/result smoke. With --require-codex,",
      "missing runtime support fails instead of skipping live probes.",
      "",
    ].join("\n")
  );
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: {
      ...process.env,
      CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
      ...(options.env ?? {}),
    },
    encoding: "utf8",
    timeout: options.timeoutMs ?? 120_000,
  });
}

function parseJsonProbe(name, result, expectedStatus = 0) {
  if (result.status !== expectedStatus) {
    throw new Error(`${name} exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${name} did not emit JSON: ${error.message}\n${result.stdout}`);
  }
}

function pushProbe(probes, name, result, expectedStatus = 0) {
  const envelope = parseJsonProbe(name, result, expectedStatus);
  probes.push({
    name,
    status: result.status,
    ok: envelope.ok,
    command: envelope.command ?? null,
    code: envelope.error?.code ?? null,
  });
  return envelope;
}

function codexAvailable() {
  const version = run("codex", ["--version"], { timeoutMs: 10_000 });
  const appServerHelp = run("codex", ["app-server", "--help"], { timeoutMs: 10_000 });
  return {
    ok: version.status === 0 && appServerHelp.status === 0,
    version: version.stdout.trim() || version.stderr.trim() || null,
    versionStatus: version.status,
    appServerHelpStatus: appServerHelp.status,
  };
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-runtime-smoke-"));
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  const sessions = path.join(root, "sessions");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(pluginData, { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(workspace, "config.yaml"), `session_dir: ${JSON.stringify(sessions)}\nauto_review: false\n`, "utf8");
  run("git", ["init"], { cwd: workspace, timeoutMs: 10_000 });
  run("git", ["config", "user.email", "codex-bridge@example.test"], { cwd: workspace, timeoutMs: 10_000 });
  run("git", ["config", "user.name", "Codex Bridge Smoke"], { cwd: workspace, timeoutMs: 10_000 });
  fs.writeFileSync(path.join(workspace, "README.md"), "# smoke\n", "utf8");
  run("git", ["add", "README.md"], { cwd: workspace, timeoutMs: 10_000 });
  run("git", ["commit", "-m", "initial"], { cwd: workspace, timeoutMs: 10_000 });
  fs.writeFileSync(path.join(workspace, "smoke-change.txt"), "runtime smoke review target\n", "utf8");
  return { root, workspace, pluginData, sessions };
}

function runStaticProbes(probes) {
  for (const bridge of [SOURCE_BRIDGE, SKILL_BRIDGE, PLUGIN_BRIDGE]) {
    const label = path.relative(ROOT, bridge);
    pushProbe(probes, `${label} help --json`, run(process.execPath, [bridge, "help", "--json"]));
    const invalid = run(process.execPath, [bridge, "send", "not-a-thread", "hello", "--json"]);
    pushProbe(probes, `${label} invalid thread`, invalid, 6);
  }
}

function runLiveProbes({ probes, workspace, pluginData, taskPrompt, skipTask, skipReview }) {
  const common = {
    cwd: workspace,
    env: {
      CODEX_BRIDGE_PLUGIN_DATA: pluginData,
    },
    timeoutMs: 900_000,
  };

  const setup = pushProbe(
    probes,
    "setup --json",
    run(process.execPath, [SOURCE_BRIDGE, "setup", "--json", "--cwd", workspace], common)
  );
  if (!setup.result?.ready) {
    throw new Error(`setup --json reported not ready: ${JSON.stringify(setup.result)}`);
  }

  if (!skipTask) {
    const task = pushProbe(
      probes,
      "foreground task smoke",
      run(process.execPath, [
        SOURCE_BRIDGE,
        "task",
        "--mode",
        "default",
        "--no-pipeline",
        "--json",
        "--cwd",
        workspace,
        taskPrompt,
      ], common)
    );
    const jobId = task.result?.job?.id ?? task.result?.jobId ?? null;
    const threadId = task.result?.threadId ?? task.result?.job?.threadId ?? null;
    if (jobId) {
      pushProbe(probes, "result smoke", run(process.execPath, [SOURCE_BRIDGE, "result", jobId, "--json", "--cwd", workspace], common));
    }
    if (threadId) {
      pushProbe(probes, "events smoke", run(process.execPath, [SOURCE_BRIDGE, "events", threadId, "--json", "--cwd", workspace], common));
    }
  }

  if (!skipReview) {
    pushProbe(
      probes,
      "review smoke",
      run(process.execPath, [
        SOURCE_BRIDGE,
        "adversarial-review",
        "--json",
        "--cwd",
        workspace,
        "--scope",
        "working-tree",
        "Runtime smoke review; report only material issues.",
      ], common)
    );
  }
}

export function runRuntimeSmoke(options = {}) {
  const probes = [];
  runStaticProbes(probes);

  if (options.staticOnly) {
    return {
      ok: true,
      live: "skipped",
      skipReason: "static-only",
      availability: null,
      probes,
    };
  }

  const availability = codexAvailable();
  if (!availability.ok) {
    if (options.requireCodex) {
      throw new Error(`Codex runtime unavailable: ${JSON.stringify(availability)}`);
    }
    return {
      ok: true,
      live: "skipped",
      skipReason: "codex-runtime-unavailable",
      availability,
      probes,
    };
  }

  const fixture = options.cwd
    ? { root: null, workspace: options.cwd, pluginData: path.join(os.tmpdir(), `codex-bridge-smoke-plugin-${process.pid}`) }
    : makeWorkspace();
  try {
    runLiveProbes({
      probes,
      workspace: fixture.workspace,
      pluginData: fixture.pluginData,
      taskPrompt: options.taskPrompt,
      skipTask: options.skipTask,
      skipReview: options.skipReview,
    });
    return { ok: true, live: "passed", availability, probes };
  } finally {
    if (fixture.root) fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = runRuntimeSmoke(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(`Runtime smoke: ${result.live}\n`);
      for (const probe of result.probes) {
        process.stdout.write(`  ${probe.name}: status=${probe.status} ok=${probe.ok}\n`);
      }
      if (result.skipReason) process.stdout.write(`  skipped live probes: ${result.skipReason}\n`);
    }
  } catch (error) {
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
    } else {
      process.stderr.write(`runtime-smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(1);
  }
}
