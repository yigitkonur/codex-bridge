import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);

function readText(relativePath) {
  return fs.readFileSync(new URL(relativePath, root), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function listMarkdownFiles(relativeDir) {
  return fs
    .readdirSync(new URL(relativeDir, root))
    .filter((entry) => entry.endsWith(".md"))
    .sort();
}

function exists(relativePath) {
  return fs.existsSync(new URL(relativePath, root));
}

function pluginManifestPath(relativePath) {
  assert.match(relativePath, /^\.\//);
  return `plugin/${relativePath.slice(2)}`;
}

function collectPluginRootReferences(value) {
  const references = [];
  if (typeof value === "string") {
    for (const match of value.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/g)) {
      references.push(match[1]);
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      references.push(...collectPluginRootReferences(entry));
    }
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      references.push(...collectPluginRootReferences(entry));
    }
  }
  return references;
}

function runHook(relativePath, input, env = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(rootPath, relativePath)],
    {
      cwd: rootPath,
      input: JSON.stringify(input),
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_BRIDGE_HOOK_DISABLE: "",
        ...env,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function resolveTestJobsDir(pluginData, workspaceRoot) {
  const canonical = fs.realpathSync.native(workspaceRoot);
  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug =
    slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return path.join(pluginData, "state", `${slug}-${hash}`, "jobs");
}

function writeJobMetadata(jobsDir, id, workspaceRoot, sessionId) {
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobsDir, `${id}.json`),
    `${JSON.stringify({ id, workspaceRoot, sessionId }, null, 2)}\n`,
  );
}

function writeRewakeSignal(jobsDir, id, text) {
  fs.mkdirSync(path.join(jobsDir, id), { recursive: true });
  fs.writeFileSync(path.join(jobsDir, id, "rewake.signal"), text);
}

function writeEvents(jobsDir, id, text) {
  fs.mkdirSync(path.join(jobsDir, id), { recursive: true });
  fs.writeFileSync(path.join(jobsDir, id, "events.jsonl"), text);
}

const expectedCommands = [
  "adversarial-review.md",
  "auth-status.md",
  "await-artifact.md",
  "cancel.md",
  "config.md",
  "events.md",
  "respond.md",
  "result.md",
  "review.md",
  "send.md",
  "setup.md",
  "status.md",
  "steer.md",
  "summary.md",
  "task.md",
  "update.md",
  "version.md",
  "wait.md"
];

function makeStopGateHarness(fakeBridgeSource) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-stop-gate-"));
  const pluginRoot = path.join(tempRoot, "plugin");
  const hookDir = path.join(pluginRoot, "hooks");
  const scriptsDir = path.join(pluginRoot, "scripts");
  const workspace = path.join(tempRoot, "workspace");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.copyFileSync(new URL("plugin/hooks/stop-gate.mjs", root), path.join(hookDir, "stop-gate.mjs"));
  fs.writeFileSync(path.join(scriptsDir, "codex-bridge.mjs"), fakeBridgeSource);
  fs.writeFileSync(path.join(workspace, ".codex-bridge-stop-review-gate.lock"), "");
  return {
    tempRoot,
    hookPath: path.join(hookDir, "stop-gate.mjs"),
    workspace
  };
}

function runStopGateHarness(harness) {
  return spawnSync(process.execPath, [harness.hookPath], {
    cwd: harness.workspace,
    input: JSON.stringify({
      cwd: harness.workspace,
      session_id: "session-stop-gate-test",
      stop_hook_active: false
    }),
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_BRIDGE_PLUGIN_DATA: path.join(harness.tempRoot, "plugin-data"),
      CLAUDE_PLUGIN_DATA: path.join(harness.tempRoot, "claude-data")
    }
  });
}

test("Claude plugin manifest version matches package and skill metadata", () => {
  const manifest = readJson(".claude-plugin/plugin.json");
  const pkg = readJson("package.json");
  const skill = readText("skill/SKILL.md");

  assert.equal(manifest.version, pkg.version);
  assert.match(skill, new RegExp(`version: "${pkg.version.replaceAll(".", "\\.")}"`));
});

test("marketplace keeps the v2 scaffold on a noncanonical alpha channel", () => {
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const alphaManifest = readJson("plugin/.claude-plugin/plugin.json");
  const canonicalEntry = marketplace.plugins.find((plugin) => plugin.name === "codex-bridge");
  const entry = marketplace.plugins.find((plugin) => plugin.name === "codex-bridge-v2-alpha");

  assert.equal(canonicalEntry, undefined);
  assert.ok(entry);
  assert.equal(entry.source, "./plugin");
  assert.equal(entry.version, undefined);
  assert.equal(alphaManifest.name, entry.name);
  assert.match(marketplace.description, /noncanonical/i);
  assert.match(entry.description, /noncanonical|pre-release|scaffold/i);
});

test("Claude plugin exposes command coverage for bridge orchestration", () => {
  assert.deepEqual(listMarkdownFiles("plugin/commands/"), expectedCommands);

  for (const command of expectedCommands) {
    const body = readText(path.join("plugin/commands", command));
    assert.match(body, /CLAUDE_PLUGIN_ROOT/);
    assert.match(
      body,
      /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-bridge\.mjs|codex-bridge-runner/
    );
    assert.doesNotMatch(
      body,
      /\$\{CLAUDE_PLUGIN_ROOT\}\/skill\/scripts\/codex-bridge\.mjs/
    );
  }
});

test("packaged plugin manifest paths resolve to plugin-local surfaces", () => {
  const manifest = readJson("plugin/.claude-plugin/plugin.json");

  assert.equal(readText("plugin/config.yaml"), readText("skill/config.yaml"));

  for (const skillPath of manifest.skills) {
    const resolvedSkillPath = pluginManifestPath(skillPath);
    assert.ok(exists(`${resolvedSkillPath}/SKILL.md`), `${skillPath} must contain SKILL.md`);
  }

  if (manifest.commands) {
    assert.deepEqual(listMarkdownFiles(pluginManifestPath(manifest.commands)), expectedCommands);
  }
  if (manifest.agents) {
    assert.deepEqual(listMarkdownFiles(pluginManifestPath(manifest.agents)), ["codex-bridge-runner.md"]);
  }
  assert.ok(exists(pluginManifestPath(manifest.hooks)), `${manifest.hooks} must exist`);

  const authoredHooks = readJson("hooks/hooks.json");
  const packagedHooks = readJson(pluginManifestPath(manifest.hooks));
  // packaged hooks may be a subset (empty during alpha phase) — only require structural compatibility
  if (Object.keys(packagedHooks.hooks ?? {}).length > 0) {
    assert.deepEqual(packagedHooks, authoredHooks);
    assert.deepEqual(Object.keys(packagedHooks.hooks).sort(), ["SessionEnd", "SessionStart", "Stop"]);

    const hookScriptRefs = collectPluginRootReferences(packagedHooks)
      .filter((reference) => reference.startsWith("hooks/"))
      .sort();
    assert.deepEqual(hookScriptRefs, [
      "hooks/session-lifecycle-hook.mjs",
      "hooks/session-lifecycle-hook.mjs",
      "hooks/stop-review-gate-hook.mjs"
    ]);

    for (const hookScriptRef of new Set(hookScriptRefs)) {
      const hookScriptPath = `plugin/${hookScriptRef}`;
      assert.ok(exists(hookScriptPath), `${hookScriptRef} must exist in packaged plugin hooks`);
      const hookScript = readText(hookScriptPath);
      assert.match(hookScript, /path\.resolve\(SCRIPT_DIR, "\.\.", "scripts", "codex-bridge\.mjs"\)/);
      assert.doesNotMatch(hookScript, /path\.resolve\(SCRIPT_DIR, "\.\.", "skill", "scripts", "codex-bridge\.mjs"\)/);
    }
  }

  if (manifest.commands) {
    for (const command of expectedCommands) {
      const body = readText(path.join(pluginManifestPath(manifest.commands), command));
      assert.match(body, /CLAUDE_PLUGIN_ROOT/);
      assert.doesNotMatch(body, /CLAUDE_PLUGIN_ROOT\}\/skill\/scripts\/codex-bridge\.mjs/);
      assert.match(body, /scripts\/codex-bridge\.mjs|codex-bridge-runner/);
    }
  }

  if (manifest.agents && exists("plugin/agents/codex-bridge-runner.md")) {
    const runner = readText("plugin/agents/codex-bridge-runner.md");
    assert.match(runner, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-bridge\.mjs" task/);
    assert.doesNotMatch(runner, /\$\{CLAUDE_PLUGIN_ROOT\}\/skill\/scripts\/codex-bridge\.mjs/);
  }
});

test("task command routes substantial work through the runner subagent and Monitor", () => {
  const taskCommand = readText("plugin/commands/task.md");

  assert.match(taskCommand, /subagent_type: "codex-bridge:codex-bridge-runner"/);
  assert.match(taskCommand, /task-resume-candidate --json/);
  assert.match(taskCommand, /result\.monitor\.tool_hint/);
  assert.match(taskCommand, /\[DONE\].*\[ERROR\].*\[INCOMPLETE\]/s);
});

test("Claude plugin wires lifecycle hooks through the bundled bridge CLI", () => {
  const manifest = readJson("plugin/.claude-plugin/plugin.json");
  const hooksConfig = readJson("plugin/hooks/hooks.json");
  const sessionHook = readText("plugin/hooks/session-lifecycle-hook.mjs");
  const stopHook = readText("plugin/hooks/stop-review-gate-hook.mjs");

  assert.equal(manifest.hooks, "./hooks/hooks.json");
  assert.deepEqual(Object.keys(hooksConfig.hooks).sort(), ["SessionEnd", "SessionStart", "Stop"]);
  assert.match(JSON.stringify(hooksConfig), /session-lifecycle-hook\.mjs/);
  assert.match(JSON.stringify(hooksConfig), /stop-review-gate-hook\.mjs/);
  assert.match(sessionHook, /CODEX_COMPANION_SESSION_ID/);
  assert.match(sessionHook, /CODEX_BRIDGE_PLUGIN_DATA/);
  assert.doesNotMatch(sessionHook, /appendEnvVar\(CLAUDE_PLUGIN_DATA_ENV/);
  assert.match(sessionHook, /status", "--prune-orphans", "--json"/);
  assert.match(stopHook, /setup", "--json"/);
  assert.match(stopHook, /stop_hook_active/);
  assert.match(stopHook, /reviewGateEnabled !== true/);
  assert.match(stopHook, /Run a stop-gate review of the previous Claude turn\./);
  assert.match(stopHook, /\.codex-bridge-stop-review-gate\.lock/);
  assert.match(stopHook, /if \(!activation\.active\)/);
  assert.match(stopHook, /maybeMigrateLegacyGate/);
  assert.match(stopHook, /config\?\.stopReviewGate === true/);
  assert.match(stopHook, /CODEX_BRIDGE_PLUGIN_DATA/);
  assert.doesNotMatch(stopHook, /CODEX_BRIDGE_STOP_REVIEW_GATE/);
  assert.match(stopHook, /decision: "block"/);
  assert.match(stopHook, /"scripts", "codex-bridge\.mjs"/);
  assert.doesNotMatch(stopHook, /"skill", "scripts", "codex-bridge\.mjs"/);
});

test("stop review hook re-reads activation after legacy setup migration", () => {
  const stopHook = readText("hooks/stop-review-gate-hook.mjs");
  const setupProbe = stopHook.indexOf('const probe = runBridge(cwd, input, ["setup", "--json"], { timeoutMs: 15000 });');
  const activationAfterProbe = stopHook.indexOf("const activationAfterProbe = reviewGateActivation(cwd);");
  const activeReturn = stopHook.indexOf("if (activationAfterProbe.active) return activationAfterProbe;");
  const configReturn = stopHook.indexOf("if (result.stopReviewGateConfig !== true) return activationAfterProbe;");
  const observedLockReturn = stopHook.indexOf("if (result.reviewGateLockExists === true) return activationAfterProbe;");
  const staleObservedLockReturn = stopHook.indexOf("if (result.reviewGateLockExists === true) return activation;");
  const migrationCall = stopHook.indexOf("activation = maybeMigrateLegacyGate(cwd, input, activation);");
  const inactiveReturn = stopHook.indexOf("if (!activation.active)", migrationCall);

  assert.notEqual(setupProbe, -1);
  assert.notEqual(activationAfterProbe, -1);
  assert.notEqual(activeReturn, -1);
  assert.notEqual(configReturn, -1);
  assert.notEqual(observedLockReturn, -1);
  assert.equal(staleObservedLockReturn, -1);
  assert.ok(setupProbe < activationAfterProbe);
  assert.ok(activationAfterProbe < activeReturn);
  assert.ok(activeReturn < configReturn);
  assert.ok(configReturn < observedLockReturn);
  assert.notEqual(migrationCall, -1);
  assert.ok(migrationCall < inactiveReturn);
});

test("plugin SessionEnd hook logs prune failures while allowing shutdown", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-session-end-"));
  try {
    const pluginRoot = path.join(tempHome, "plugin");
    const scriptsDir = path.join(pluginRoot, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(scriptsDir, "codex-bridge.mjs"),
      'process.stderr.write("prune failed\\n"); process.exit(42);\n',
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("plugin/hooks/session-end.mjs", root))],
      {
        cwd: fileURLToPath(root),
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          HOME: tempHome,
        },
        input: JSON.stringify({ cwd: fileURLToPath(root) }),
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0);
    assert.equal(result.stdout, '{"continue":true}');

    const logDir = path.join(tempHome, ".codex-bridge", "hook-errors");
    const logs = fs.readdirSync(logDir);
    assert.equal(logs.length, 1);
    const log = fs.readFileSync(path.join(logDir, logs[0]), "utf8");
    assert.match(log, /SessionEnd prune failed/);
    assert.match(log, /status=42/);
    assert.match(log, /prune failed/);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test("UserPromptSubmit resume intent reads Claude's documented prompt field", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-hook-home-"));
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-plugin-data-"));

  const output = runHook(
    "plugin/hooks/user-prompt-submit.mjs",
    { hook_event_name: "UserPromptSubmit", prompt: "continue" },
    { HOME: home, CODEX_BRIDGE_PLUGIN_DATA: pluginData },
  );

  assert.equal(output.continue, true);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /resume-intent detected/);
});

test("UserPromptSubmit rewake delivery is scoped to current workspace and session", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-hook-home-"));
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-plugin-data-"));
  const workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-a-"));
  const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-b-"));
  const jobsA = resolveTestJobsDir(pluginData, workspaceA);
  const jobsB = resolveTestJobsDir(pluginData, workspaceB);

  writeJobMetadata(jobsA, "task-aaaaaa-bbbbbb", workspaceA, "session-a");
  writeRewakeSignal(jobsA, "task-aaaaaa-bbbbbb", "[DONE] current");
  writeJobMetadata(jobsA, "task-cccccc-dddddd", workspaceA, "session-other");
  writeRewakeSignal(jobsA, "task-cccccc-dddddd", "[DONE] wrong session");
  writeJobMetadata(jobsB, "task-eeeeee-ffffff", workspaceB, "session-a");
  writeRewakeSignal(jobsB, "task-eeeeee-ffffff", "[DONE] wrong workspace");

  const output = runHook(
    "plugin/hooks/user-prompt-submit.mjs",
    {
      hook_event_name: "UserPromptSubmit",
      prompt: "status?",
      cwd: workspaceA,
      session_id: "session-a",
    },
    { HOME: home, CODEX_BRIDGE_PLUGIN_DATA: pluginData },
  );

  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /task-aaaaaa-bbbbbb: \[DONE\] current/);
  assert.doesNotMatch(context, /wrong session/);
  assert.doesNotMatch(context, /wrong workspace/);
  assert.equal(fs.existsSync(path.join(jobsA, "task-aaaaaa-bbbbbb", "rewake.signal")), false);
  assert.equal(
    fs.readdirSync(path.join(jobsA, "task-aaaaaa-bbbbbb")).some((entry) => entry.startsWith("rewake.signal.claimed-")),
    true,
  );
  assert.equal(fs.existsSync(path.join(jobsA, "task-cccccc-dddddd", "rewake.signal")), true);
  assert.equal(fs.existsSync(path.join(jobsB, "task-eeeeee-ffffff", "rewake.signal")), true);
});

test("SubagentStop reports only the job id correlated from subagent output", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-hook-home-"));
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-plugin-data-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));
  const jobs = resolveTestJobsDir(pluginData, workspace);

  writeJobMetadata(jobs, "task-aaaaaa-bbbbbb", workspace, "session-a");
  writeEvents(jobs, "task-aaaaaa-bbbbbb", "[DONE] matched\n");
  writeJobMetadata(jobs, "task-cccccc-dddddd", workspace, "session-other");
  writeEvents(jobs, "task-cccccc-dddddd", "[ERROR] wrong session\n");

  const output = runHook(
    "plugin/hooks/subagent-stop.mjs",
    {
      hook_event_name: "SubagentStop",
      agent_type: "codex-bridge:codex-bridge-runner",
      last_assistant_message: "Job: task-aaaaaa-bbbbbb",
      cwd: workspace,
      session_id: "session-a",
    },
    { HOME: home, CODEX_BRIDGE_PLUGIN_DATA: pluginData },
  );

  assert.equal(output.continue, true);
  assert.equal(output.hookSpecificOutput.hookEventName, "SubagentStop");
  assert.match(output.hookSpecificOutput.additionalContext, /Task task-aaaaaa-bbbbbb -> \[DONE\]/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /task-cccccc-dddddd/);

  const uncorrelated = runHook(
    "plugin/hooks/subagent-stop.mjs",
    {
      hook_event_name: "SubagentStop",
      agent_type: "codex-bridge:codex-bridge-runner",
      cwd: workspace,
      session_id: "session-a",
    },
    { HOME: home, CODEX_BRIDGE_PLUGIN_DATA: pluginData },
  );
  assert.deepEqual(uncorrelated, { continue: true });
});

test("plugin Stop hook blocks when an active gate cannot verify setup", () => {
  const harness = makeStopGateHarness(`
import process from "node:process";

const [command] = process.argv.slice(2);
if (command === "status") {
  process.stdout.write(JSON.stringify({ ok: true, result: { running: [] } }));
} else if (command === "setup") {
  process.stderr.write("setup unavailable");
  process.exit(4);
} else if (command === "task") {
  process.stdout.write(JSON.stringify({ ok: true, result: { rawOutput: "ALLOW: ok" } }));
} else {
  process.exit(2);
}
`);

  try {
    const result = runStopGateHarness(harness);
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.decision, "block");
    assert.match(payload.reason, /setup could not verify the bridge runtime/);
  } finally {
    fs.rmSync(harness.tempRoot, { recursive: true, force: true });
  }
});

test("plugin Stop hook blocks when an active gate finds Codex not ready", () => {
  const harness = makeStopGateHarness(`
import process from "node:process";

const [command] = process.argv.slice(2);
if (command === "status") {
  process.stdout.write(JSON.stringify({ ok: true, result: { running: [] } }));
} else if (command === "setup") {
  process.stdout.write(JSON.stringify({
    ok: true,
    result: {
      reviewGateEnabled: true,
      reviewGateLockExists: true,
      ready: false
    }
  }));
} else if (command === "task") {
  process.stdout.write(JSON.stringify({ ok: true, result: { rawOutput: "ALLOW: ok" } }));
} else {
  process.exit(2);
}
`);

  try {
    const result = runStopGateHarness(harness);
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.decision, "block");
    assert.match(payload.reason, /Codex is not ready/);
  } finally {
    fs.rmSync(harness.tempRoot, { recursive: true, force: true });
  }
});

test("plugin Stop hook leaves timeout margin for its blocking timeout result", () => {
  const hooksConfig = readJson("plugin/hooks/hooks.json");
  const stopHook = readText("plugin/hooks/stop-gate.mjs");
  const hookTimeoutMs = hooksConfig.hooks.Stop[0].hooks[0].timeout * 1000;
  const match = stopHook.match(/const STOP_REVIEW_TIMEOUT_MINUTES = (\d+);/);

  assert.ok(match, "Stop hook must define its internal timeout in minutes");
  assert.ok(Number(match[1]) * 60 * 1000 <= hookTimeoutMs - 60_000);
});

test("plugin Stop hook migrates legacy gate state with setup's public fields", () => {
  const stopHook = readText("plugin/hooks/stop-gate.mjs");

  assert.doesNotMatch(stopHook, /stopReviewGateConfig/);
  assert.match(stopHook, /reviewGateLockExists/);
  assert.match(stopHook, /reviewGateEnabled/);
});

test("setup owns project-scoped review gate lock creation", () => {
  const bridge = readText("src/codex-bridge.mjs");
  const setupCommand = readText("plugin/commands/setup.md");

  assert.match(bridge, /\.codex-bridge-stop-review-gate\.lock/);
  assert.match(bridge, /detectOfficialOpenAICodexPlugin/);
  assert.match(bridge, /OFFICIAL_PLUGIN_STATUS\.ABSENT/);
  assert.match(bridge, /setStopReviewGate\(workspaceRoot, true, officialPlugin\)/);
  assert.match(bridge, /setStopReviewGate\(workspaceRoot, false, officialPlugin\)/);
  assert.doesNotMatch(setupCommand, /CODEX_BRIDGE_STOP_REVIEW_GATE/);
  assert.match(setupCommand, /project-specific/);
  assert.match(setupCommand, /official OpenAI Codex plugin/);
});

test("runner subagent remains a thin forwarding wrapper", () => {
  const manifest = readJson("plugin/.claude-plugin/plugin.json");
  const runner = readText("plugin/agents/codex-bridge-runner.md");

  assert.equal(manifest.agents, "./agents");
  assert.match(runner, /name: codex-bridge-runner/);
  assert.match(runner, /Use exactly one `Bash` call/);
  assert.match(runner, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-bridge\.mjs" task/);
  assert.match(runner, /Do not inspect the repository/);
  assert.match(runner, /Return the stdout of the bridge command exactly as-is/);
});

test("canonical plugin manifest paths resolve inside the plugin package", () => {
  const manifest = readJson("plugin/.claude-plugin/plugin.json");

  for (const skillPath of manifest.skills ?? []) {
    assert.equal(
      exists(path.join("plugin", skillPath, "SKILL.md")),
      true,
      `missing plugin skill referenced by manifest: ${skillPath}`
    );
  }
  assert.equal(exists(path.join("plugin", manifest.commands)), true);
  assert.equal(exists(path.join("plugin", manifest.agents)), true);
  assert.equal(exists(path.join("plugin", manifest.hooks)), true);
  assert.equal(exists("plugin/config.yaml"), true);

  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("plugin/scripts/codex-bridge.mjs", root)), "config", "show", "--json"],
    {
      cwd: rootPath,
      env: { ...process.env, CODEX_BRIDGE_NO_UPDATE_CHECK: "1" },
      encoding: "utf8"
    }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.result.sources.skill_config_exists, true);
  assert.match(payload.result.sources.skill_config_path, /plugin[/\\]config\.yaml$/);
});
