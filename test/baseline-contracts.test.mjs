import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildBaselineContracts,
  verifyBaselineContracts
} from "../scripts/baseline-contracts.mjs";
import { upsertJob, writeJobFile } from "../src/lib/state.mjs";

const rootUrl = new URL("../", import.meta.url);
const rootPath = fileURLToPath(rootUrl);
const bridgePath = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));
const contractsPath = fileURLToPath(new URL("../scripts/baseline-contracts.mjs", import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function withCliFixture(run) {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-baseline-"));
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  const sessionDir = path.join(root, "sessions");
  const fakeBin = path.join(root, "bin");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(pluginData, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(fakeBin, "node"));
  fs.writeFileSync(
    path.join(pluginData, "codex-bridge-update.json"),
    JSON.stringify({ checkedAt: Date.now(), latestVersion: packageJson.version }),
    "utf8"
  );
  fs.writeFileSync(path.join(workspace, "config.yaml"), `session_dir: ${JSON.stringify(sessionDir)}\n`, "utf8");

  process.env.CODEX_BRIDGE_PLUGIN_DATA = pluginData;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    const threadId = "11111111-1111-4111-8111-111111111111";
    const job = {
      id: "task-baseline-json",
      sessionId: "baseline-session",
      jobClass: "task",
      status: "completed",
      phase: "done",
      threadId,
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:01.000Z",
      completedAt: "2026-04-30T00:00:01.000Z",
      result: { rawOutput: "baseline task output\n" }
    };
    upsertJob(workspace, job);
    writeJobFile(workspace, job.id, job);
    fs.writeFileSync(path.join(sessionDir, `${threadId}.events`), `[DONE] ${threadId} | duration=1s\n`, "utf8");

    return run({ workspace, pluginData, sessionDir, fakeBin, job });
  } finally {
    if (previousBridgePluginData == null) {
      delete process.env.CODEX_BRIDGE_PLUGIN_DATA;
    } else {
      process.env.CODEX_BRIDGE_PLUGIN_DATA = previousBridgePluginData;
    }
    if (previousClaudePluginData == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousClaudePluginData;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runBridge(args, { workspace, pluginData, fakeBin }) {
  return spawnSync(process.execPath, [bridgePath, ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_BRIDGE_PLUGIN_DATA: pluginData,
      CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
      CODEX_BRIDGE_BACKEND: "",
      PATH: fakeBin,
    },
  });
}

function parseEnvelope(result, expectedStatus = 0) {
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  assert.equal(result.stderr, "", result.stderr);
  assert.notEqual(result.stdout.trim(), "");
  return JSON.parse(result.stdout);
}

test("baseline contract report verifies static gate, generated surfaces, and command classification", () => {
  const report = buildBaselineContracts(rootPath);
  const check = verifyBaselineContracts(rootPath, report);

  assert.equal(check.ok, true, check.failures.join("\n"));
  assert.equal(report.static_gate.command, "npm run verify:static");
  assert.ok(report.generated_surfaces.some((surface) => surface.source === "src/codex-bridge.mjs"));
  assert.ok(report.generated_surfaces.some((surface) => surface.source === "hooks"));
  assert.equal(report.json_envelope_probes.length, 9);
  assert.deepEqual(
    report.dispatch_commands.filter(
      (command) =>
        !report.read_only_commands.includes(command) &&
        !Object.hasOwn(report.mutating_command_coverage, command)
    ),
    []
  );
  assert.ok(Object.hasOwn(report.mutating_command_coverage, "verdict"));
  assert.ok(Object.hasOwn(report.mutating_command_coverage, "merge"));
});

test("baseline contract CLI emits JSON and check mode exits cleanly", () => {
  const json = spawnSync(process.execPath, [contractsPath, "--json"], {
    cwd: rootPath,
    encoding: "utf8",
  });
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.project, "codex-bridge");
  assert.equal(payload.check.ok, true, payload.check.failures?.join("\n"));

  const check = spawnSync(process.execPath, [contractsPath, "--check"], {
    cwd: rootPath,
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(check.stdout, /Baseline contracts: OK/);
});

test("required machine-readable CLI envelopes keep the shared schema shape", () => {
  withCliFixture((fixture) => {
    const help = parseEnvelope(runBridge(["help", "--json"], fixture));
    assert.equal(help.ok, true);
    assert.equal(help.command, "help");
    assert.ok(help.result.commands.some((command) => command.name === "status"));
    assert.equal(typeof help.meta.duration_ms, "number");

    const config = parseEnvelope(runBridge(["config", "show", "--json", "--cwd", fixture.workspace], fixture));
    assert.equal(config.command, "config");
    assert.ok(config.result.effective_config);
    assert.deepEqual(config.result.precedence_order_low_to_high, [
      "DEFAULT_CONFIG",
      "skill-dir config.yaml",
      "workspace-root config.yaml",
      "cwd config.yaml",
    ]);

    const version = parseEnvelope(runBridge(["version", "--json", "--cwd", fixture.workspace], fixture));
    assert.equal(version.command, "version");
    assert.equal(version.result.version, packageJson.version);
    assert.equal(version.result.active_backend, "codex");
    assert.equal(typeof version.result.adapter_capabilities, "object");

    const setup = parseEnvelope(runBridge(["setup", "--json", "--cwd", fixture.workspace], fixture));
    assert.equal(setup.command, "setup");
    assert.equal(typeof setup.result.ready, "boolean");
    assert.equal(typeof setup.result.reviewGateEnabled, "boolean");
    assert.equal(typeof setup.result.reviewGateLockPath, "string");

    const status = parseEnvelope(runBridge(["status", "--json", "--cwd", fixture.workspace], fixture));
    assert.equal(status.command, "status");
    assert.equal(status.result.workspaceRoot, fixture.workspace);
    assert.equal(status.result.latestFinished.id, fixture.job.id);

    const result = parseEnvelope(runBridge(["result", fixture.job.id, "--json", "--cwd", fixture.workspace], fixture));
    assert.equal(result.command, "result");
    assert.equal(result.result.job.id, fixture.job.id);
    assert.equal(result.result.storedJob.result.rawOutput, "baseline task output\n");

    const wait = parseEnvelope(
      runBridge(["wait", fixture.job.id, "--json", "--timeout-ms", "1000", "--cwd", fixture.workspace], fixture)
    );
    assert.equal(wait.command, "wait");
    assert.equal(wait.result.jobId, fixture.job.id);
    assert.equal(wait.result.threadId, fixture.job.threadId);
    assert.equal(wait.result.terminalTag, "DONE");

    const events = parseEnvelope(runBridge(["events", fixture.job.id, "--json", "--cwd", fixture.workspace], fixture));
    assert.equal(events.command, "events");
    assert.equal(events.result.jobId, fixture.job.id);
    assert.equal(events.result.threadId, fixture.job.threadId);
    assert.doesNotMatch(events.stdout ?? JSON.stringify(events), /\[DONE\]/);

    const error = runBridge(["does-not-exist", "--json"], fixture);
    assert.notEqual(error.status, 0);
    assert.equal(error.stderr, "");
    const errorEnvelope = JSON.parse(error.stdout);
    assert.equal(errorEnvelope.ok, false);
    assert.equal(errorEnvelope.schema_version, "1.0");
    assert.equal(errorEnvelope.error.code, "UNKNOWN_SUBCOMMAND");
    assert.equal(errorEnvelope.error.retryable, false);
  });
});
