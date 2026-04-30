import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);

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
    assert.match(body, /scripts\/codex-bridge\.mjs|codex-bridge-runner/);
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
