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
import { SESSION_ID_ENV } from "../src/lib/tracked-jobs.mjs";

const rootUrl = new URL("../", import.meta.url);
const rootPath = fileURLToPath(rootUrl);
const bridgePath = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));
const contractsPath = fileURLToPath(new URL("../scripts/baseline-contracts.mjs", import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function withCliFixture(run) {
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;
  const previousSessionId = process.env[SESSION_ID_ENV];
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
  delete process.env[SESSION_ID_ENV];

  try {
    const threadId = "11111111-1111-4111-8111-111111111111";
    const job = {
      id: "task-baseline-json",
      sessionId: "baseline-session",
      jobClass: "task",
      status: "completed",
      phase: "done",
      threadId,
      group: "baseline-group",
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
    if (previousSessionId == null) {
      delete process.env[SESSION_ID_ENV];
    } else {
      process.env[SESSION_ID_ENV] = previousSessionId;
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
      CODEX_BRIDGE_SESSION_ID: "",
      CODEX_COMPANION_SESSION_ID: "baseline-session",
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

function getPathValue(value, dottedPath) {
  if (dottedPath.includes(":")) {
    const [pathPart, expectedLiteral] = dottedPath.split(":");
    const resolved = getPathValue(value, pathPart);
    if (expectedLiteral === "false") return resolved === false;
    if (expectedLiteral === "true") return resolved === true;
    return resolved === expectedLiteral;
  }
  return dottedPath.split(".").reduce((current, part) => current?.[part], value);
}

function assertExpectedProbe(report, command, envelope) {
  const probe = report.json_envelope_probes.find((entry) => entry.command === command);
  assert.ok(probe, `missing probe metadata for ${command}`);
  for (const expected of probe.expected) {
    const resolved = getPathValue(envelope, expected);
    if (expected.includes(":")) {
      assert.equal(resolved, true, `${command} expected ${expected}`);
    } else {
      assert.notEqual(resolved, undefined, `${command} expected ${expected}`);
    }
  }
}

function makeContractFixture() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-contract-fixture-"));
  for (const entry of ["package.json", "src", "skill", "plugin", "hooks", "test"]) {
    fs.cpSync(path.join(rootPath, entry), path.join(tempRoot, entry), { recursive: true });
  }
  fs.symlinkSync(path.join(rootPath, "node_modules"), path.join(tempRoot, "node_modules"), "dir");
  return tempRoot;
}

test("baseline contract report verifies static gate, generated surfaces, and command classification", () => {
  const report = buildBaselineContracts(rootPath);
  const check = verifyBaselineContracts(rootPath, report);

  assert.equal(check.ok, true, check.failures.join("\n"));
  assert.equal(report.static_gate.command, "npm run verify:static");
  assert.ok(report.generated_surfaces.some((surface) => surface.source === "src/codex-bridge.mjs"));
  assert.ok(report.generated_surfaces.some((surface) => surface.source === "hooks"));
  assert.equal(report.json_envelope_probes.length, 10);
  assert.deepEqual(report.ndjson_event_schema.fields, [
    "schema_version",
    "ts",
    "tag",
    "method",
    "threadId",
    "data",
  ]);
  assert.equal(report.ndjson_event_schema.version, "1.0");
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
  assert.ok(Object.hasOwn(report.mutating_command_coverage, "iterate"));
  assert.match(report.mutating_command_coverage.task.mutation, /auto-pipeline stage\/budget\/partial-completion proof/);
  assert.ok(report.mutating_command_coverage.task.failure_tests.includes("test/auto-pipeline-turn-watchdog.test.mjs"));
  assert.match(report.mutating_command_coverage.iterate.mutation, /closed-loop task, adversarial review, verdict persistence/);
  assert.ok(report.mutating_command_coverage.iterate.success_tests.includes("test/iterate-loop.test.mjs"));
  assert.equal(report.mutating_command_coverage.iterate.baseline_gap, null);
  assert.equal(Object.hasOwn(report.baseline_gaps, "iterate"), false);
  assert.doesNotMatch(report.mutating_command_coverage.task.baseline_gap, /live review smoke was run/i);
});

test("baseline contract checker fails on stale generated bundles", () => {
  const tempRoot = makeContractFixture();
  try {
    fs.appendFileSync(path.join(tempRoot, "skill/scripts/codex-bridge.mjs"), "\n// stale bundle probe\n");
    const check = verifyBaselineContracts(tempRoot);
    assert.equal(check.ok, false);
    assert.ok(check.failures.includes("stale generated bundle: skill/scripts/codex-bridge.mjs"));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("baseline contract checker fails closed on dispatch and metadata drift", () => {
  const brokenDispatchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-broken-dispatch-"));
  try {
    fs.mkdirSync(path.join(brokenDispatchRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(brokenDispatchRoot, "package.json"), JSON.stringify({ name: "codex-bridge", version: "0.0.0" }));
    fs.writeFileSync(path.join(brokenDispatchRoot, "src/codex-bridge.mjs"), "const HANDLERS = {};\n");
    assert.throws(
      () => buildBaselineContracts(brokenDispatchRoot),
      /Unable to locate SUBCOMMAND_DISPATCH/
    );
  } finally {
    fs.rmSync(brokenDispatchRoot, { recursive: true, force: true });
  }

  const report = buildBaselineContracts(rootPath);
  const missingExpected = verifyBaselineContracts(rootPath, {
    ...report,
    json_envelope_probes: report.json_envelope_probes.map((probe) => ({ ...probe, expected: [] })),
  });
  assert.equal(missingExpected.ok, false);
  assert.ok(missingExpected.failures.some((failure) => failure.startsWith("JSON probe has no expected fields:")));

  const nonTestCoverage = verifyBaselineContracts(rootPath, {
    ...report,
    mutating_command_coverage: {
      ...report.mutating_command_coverage,
      setup: {
        ...report.mutating_command_coverage.setup,
        success_tests: ["package.json"],
      },
    },
  });
  assert.equal(nonTestCoverage.ok, false);
  assert.ok(nonTestCoverage.failures.includes("setup references non-test coverage file: package.json"));
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
  const report = buildBaselineContracts(rootPath);
  withCliFixture((fixture) => {
    const help = parseEnvelope(runBridge(["help", "--json"], fixture));
    assertExpectedProbe(report, "help --json", help);
    assert.equal(help.ok, true);
    assert.equal(help.command, "help");
    assert.ok(help.result.commands.some((command) => command.name === "status"));
    assert.equal(typeof help.meta.duration_ms, "number");

    const config = parseEnvelope(runBridge(["config", "show", "--json", "--cwd", fixture.workspace], fixture));
    assertExpectedProbe(report, "config show --json", config);
    assert.equal(config.command, "config");
    assert.ok(config.result.effective_config);
    assert.deepEqual(config.result.precedence_order_low_to_high, [
      "DEFAULT_CONFIG",
      "skill-dir config.yaml",
      "workspace-root config.yaml",
      "cwd config.yaml",
    ]);

    const version = parseEnvelope(runBridge(["version", "--json", "--cwd", fixture.workspace], fixture));
    assertExpectedProbe(report, "version --json", version);
    assert.equal(version.command, "version");
    assert.equal(version.result.version, packageJson.version);
    assert.equal(version.result.active_backend, "codex");
    assert.equal(typeof version.result.adapter_capabilities, "object");

    const setup = parseEnvelope(runBridge(["setup", "--json", "--cwd", fixture.workspace], fixture));
    assertExpectedProbe(report, "setup --json", setup);
    assert.equal(setup.command, "setup");
    assert.equal(typeof setup.result.ready, "boolean");
    assert.equal(typeof setup.result.reviewGateEnabled, "boolean");
    assert.equal(typeof setup.result.reviewGateLockPath, "string");
    assert.equal(setup.result.active_backend, "codex");
    assert.equal(typeof setup.result.adapter_capabilities, "object");

    const status = parseEnvelope(runBridge(["status", "--all", "--json", "--cwd", fixture.workspace], fixture));
    assertExpectedProbe(report, "status --all --json", status);
    assert.equal(status.command, "status");
    assert.equal(status.result.workspaceRoot, fixture.workspace);
    assert.ok(Object.hasOwn(status.result, "latestFinished"));

    const groupStatus = parseEnvelope(runBridge(["status", "--group", "baseline-group", "--json", "--cwd", fixture.workspace], fixture));
    assert.equal(groupStatus.command, "status");
    assert.equal(groupStatus.result.group, "baseline-group");
    assert.equal(groupStatus.result.latestFinished.id, fixture.job.id);

    const groupWait = parseEnvelope(runBridge(["wait", "--group", "baseline-group", "--all", "--json", "--cwd", fixture.workspace], fixture));
    assert.equal(groupWait.command, "wait");
    assert.equal(groupWait.result.mode, "group-all");
    assert.equal(groupWait.result.group, "baseline-group");
    assert.equal(groupWait.result.total, 1);

    const result = parseEnvelope(runBridge(["result", fixture.job.id, "--json", "--cwd", fixture.workspace], fixture));
    assertExpectedProbe(report, "result <job-id> --json", result);
    assert.equal(result.command, "result");
    assert.equal(result.result.job.id, fixture.job.id);
    assert.equal(result.result.storedJob.result.rawOutput, "baseline task output\n");

    const wait = parseEnvelope(
      runBridge(["wait", fixture.job.id, "--json", "--timeout-ms", "1000", "--cwd", fixture.workspace], fixture)
    );
    assertExpectedProbe(report, "wait <job-id> --json", wait);
    assert.equal(wait.command, "wait");
    assert.equal(wait.result.jobId, fixture.job.id);
    assert.equal(wait.result.threadId, fixture.job.threadId);
    assert.equal(wait.result.terminalTag, "DONE");

    const events = parseEnvelope(runBridge(["events", fixture.job.id, "--json", "--cwd", fixture.workspace], fixture));
    assertExpectedProbe(report, "events <job-id> --json", events);
    assert.equal(events.command, "events");
    assert.equal(events.result.jobId, fixture.job.id);
    assert.equal(events.result.threadId, fixture.job.threadId);
    assert.doesNotMatch(events.stdout ?? JSON.stringify(events), /\[DONE\]/);

    const bundle = parseEnvelope(runBridge(["bundle", fixture.job.id, "--json", "--cwd", fixture.workspace], fixture));
    assertExpectedProbe(report, "bundle <job-id> --json", bundle);
    assert.equal(bundle.command, "bundle");
    assert.equal(bundle.result.taskId, fixture.job.id);
    assert.equal(bundle.result.threadId, fixture.job.threadId);
    assert.ok(fs.existsSync(bundle.result.bundlePath));
    assert.ok(bundle.result.contents.includes("manifest.json"));

    const error = runBridge(["does-not-exist", "--json"], fixture);
    assert.notEqual(error.status, 0);
    assert.equal(error.stderr, "");
    const errorEnvelope = JSON.parse(error.stdout);
    assertExpectedProbe(report, "unknown-subcommand --json", errorEnvelope);
    assert.equal(errorEnvelope.ok, false);
    assert.equal(errorEnvelope.schema_version, "1.0");
    assert.equal(errorEnvelope.error.code, "UNKNOWN_SUBCOMMAND");
    assert.equal(errorEnvelope.error.retryable, false);
  });
});
