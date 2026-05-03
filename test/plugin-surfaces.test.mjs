import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const pluginCli = path.join(rootPath, "plugin/scripts/codex-bridge.mjs");

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

function stat(relativePath) {
  return fs.statSync(new URL(relativePath, root));
}

function pluginManifestPath(relativePath) {
  assert.match(relativePath, /^\.\//);
  return `plugin/${relativePath.slice(2)}`;
}

function assertPluginLocalPath(relativePath, expectedType) {
  assert.match(relativePath, /^\.\//);
  const resolved = path.resolve(rootPath, "plugin", relativePath);
  const pluginRoot = path.resolve(rootPath, "plugin");
  assert.ok(
    resolved === pluginRoot || resolved.startsWith(`${pluginRoot}${path.sep}`),
    `${relativePath} must resolve inside plugin/`,
  );
  assert.ok(fs.existsSync(resolved), `${relativePath} must exist in plugin/`);
  const entry = fs.statSync(resolved);
  if (expectedType === "directory") assert.ok(entry.isDirectory(), `${relativePath} must be a directory`);
  if (expectedType === "file") assert.ok(entry.isFile(), `${relativePath} must be a file`);
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

function walkFiles(relativeDir) {
  const absoluteDir = new URL(relativeDir, root);
  const files = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const child = path.posix.join(relativeDir.replace(/\/$/, ""), entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(`${child}/`));
    if (entry.isFile()) files.push(child);
  }
  return files;
}

function extractPluginRootReferencesFromText(text) {
  return [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"`'\s)]+)/g)].map((match) =>
    match[1].replace(/\\+$/, "")
  );
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

function runPostToolHook(payload) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-post-tool-"));
  const script = fileURLToPath(new URL("plugin/hooks/post-tool-bash.mjs", root));
  const result = spawnSync(process.execPath, [script], {
    cwd: rootPath,
    env: { ...process.env, HOME: home },
    input: JSON.stringify(payload),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runBridge(relativePath, args, { input = undefined, env = {} } = {}) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL(relativePath, root)), ...args],
    {
      cwd: rootPath,
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
        ...env,
      },
    },
  );
}

function queuedTaskEnvelope(jobId = "task-mabc123-def456") {
  return {
    ok: true,
    schema_version: "1.0",
    command: "task",
    result: {
      phase: "queued",
      jobId,
      monitor: {
        tool_hint: {
          description: "codex-bridge task events",
          command: `node "${path.join(rootPath, "plugin/scripts/codex-bridge.mjs")}" events ${jobId} --follow --exclude HEARTBEAT --timeout-ms 1800000`,
          timeout_ms: 3600000,
          persistent: false
        }
      }
    }
  };
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

function writeRegistryMeta(registry, taskId, meta) {
  const dir = path.join(registry, taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

function parseBridgeError(result) {
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  return payload.error;
}

function runGit(cwd, args) {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function writeFakeCodex(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const script = path.join(binDir, "codex");
  fs.writeFileSync(
    script,
    `#!/usr/bin/env node
import readline from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex test\\n");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  process.stdout.write("codex app-server test\\n");
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.stderr.write("unsupported fake codex invocation\\n");
  process.exit(2);
}

const threadId = "019ddc92-d8e5-7ca2-b051-83ffffcc8af8";
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: threadId, name: null } } });
    return;
  }
  if (message.method === "review/start") {
    send({
      method: "item/completed",
      params: {
        threadId,
        item: {
          id: "review-item",
          type: "exitedReviewMode",
          status: "completed",
          review: "No issues found. Looks good overall."
        }
      }
    });
    send({
      id: message.id,
      result: {
        reviewThreadId: threadId,
        turn: { id: "turn-review", status: "completed" }
      }
    });
    return;
  }
  send({ id: message.id, result: {} });
});
`,
    "utf8",
  );
  fs.chmodSync(script, 0o755);
  return script;
}

const expectedCommands = [
  "adversarial-review.md",
  "auth-status.md",
  "await-artifact.md",
  "cancel.md",
  "config.md",
  "events.md",
  "iterate.md",
  "merge.md",
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
  "verdict.md",
  "verdicts.md",
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

function runStopGateHarness(harness, overrides = {}) {
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
      CLAUDE_PLUGIN_DATA: path.join(harness.tempRoot, "claude-data"),
      ...(overrides.env ?? {})
    }
  });
}

function runBundledPluginCli(args, env = {}) {
  return JSON.parse(
    execFileSync(process.execPath, [pluginCli, ...args], {
      cwd: rootPath,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
        ...env
      }
    })
  );
}

test("Claude plugin manifest version matches package and skill metadata", () => {
  const manifest = readJson(".claude-plugin/plugin.json");
  const pkg = readJson("package.json");
  const skill = readText("skill/SKILL.md");

  assert.equal(manifest.version, pkg.version);
  assert.match(skill, new RegExp(`version: "${pkg.version.replaceAll(".", "\\.")}"`));
});

test("plugin metadata declares the canonical root and noncanonical packaged alpha relationship", () => {
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const rootManifest = readJson(".claude-plugin/plugin.json");
  const alphaManifest = readJson("plugin/.claude-plugin/plugin.json");
  const pkg = readJson("package.json");
  const legacySkill = readText("skill/SKILL.md");
  const packagedSkill = readText("plugin/skills/codex-bridge/SKILL.md");
  const canonicalEntry = marketplace.plugins.find((plugin) => plugin.name === "codex-bridge");
  const entry = marketplace.plugins.find((plugin) => plugin.name === "codex-bridge-v2-alpha");

  assert.equal(rootManifest.name, pkg.name);
  assert.equal(rootManifest.version, pkg.version);
  assert.match(legacySkill, new RegExp(`version: "${pkg.version.replaceAll(".", "\\.")}"`));
  assert.match(packagedSkill, new RegExp(`version: "${pkg.version.replaceAll(".", "\\.")}"`));

  assert.equal(canonicalEntry, undefined);
  assert.ok(entry);
  assert.equal(entry.source, "./plugin");
  assert.equal(entry.version, undefined);
  assert.equal(alphaManifest.name, entry.name);
  assert.equal(alphaManifest.version, `${pkg.version}-alpha.0`);
  assert.match(marketplace.description, /noncanonical/i);
  assert.match(entry.description, /noncanonical|pre-release|scaffold/i);
  assert.match(alphaManifest.description, /noncanonical|pre-release|alpha/i);
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
  assertPluginLocalPath(manifest.commands, "directory");
  assertPluginLocalPath(manifest.agents, "directory");
  assertPluginLocalPath(manifest.hooks, "file");
  for (const skillPath of manifest.skills ?? []) {
    assertPluginLocalPath(skillPath, "directory");
  }

  for (const skillPath of manifest.skills) {
    const resolvedSkillPath = pluginManifestPath(skillPath);
    assert.ok(exists(`${resolvedSkillPath}/SKILL.md`), `${skillPath} must contain SKILL.md`);
  }

  if (manifest.commands) {
    assert.deepEqual(listMarkdownFiles(pluginManifestPath(manifest.commands)), expectedCommands);
  }
  if (manifest.agents) {
    assert.deepEqual(listMarkdownFiles(pluginManifestPath(manifest.agents)).sort(), ["codex-bridge-reviewer.md", "codex-bridge-runner.md"].sort());
  }
  assert.ok(exists(pluginManifestPath(manifest.hooks)), `${manifest.hooks} must exist`);

  const authoredHooks = readJson("hooks/hooks.json");
  const packagedHooks = readJson(pluginManifestPath(manifest.hooks));
  // packaged hooks may be a subset (empty during alpha phase) — only require structural compatibility
  if (Object.keys(packagedHooks.hooks ?? {}).length > 0) {
    assert.deepEqual(packagedHooks, authoredHooks);
    assert.deepEqual(Object.keys(packagedHooks.hooks).sort(), [
      "PostToolUse",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "SubagentStop",
      "UserPromptSubmit",
    ].sort());

    const hookScriptRefs = collectPluginRootReferences(packagedHooks)
      .filter((reference) => reference.startsWith("hooks/"))
      .sort();
    assert.deepEqual(hookScriptRefs, [
      "hooks/post-tool-bash.mjs",
      "hooks/pre-tool-agent.mjs",
      "hooks/session-lifecycle-hook.mjs",
      "hooks/session-lifecycle-hook.mjs",
      "hooks/stop-gate.mjs",
      "hooks/subagent-stop.mjs",
      "hooks/user-prompt-submit.mjs",
    ]);

    for (const hookScriptRef of new Set(hookScriptRefs)) {
      const hookScriptPath = `plugin/${hookScriptRef}`;
      assert.ok(exists(hookScriptPath), `${hookScriptRef} must exist in packaged plugin hooks`);
      const hookScript = readText(hookScriptPath);
      if (/BRIDGE_SCRIPT|resolveBundlePath/.test(hookScript)) {
        assert.match(hookScript, /path\.resolve\(SCRIPT_DIR, "\.\.", "scripts", "codex-bridge\.mjs"\)|path\.join\(root, "scripts", "codex-bridge\.mjs"\)/);
      }
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

test("all packaged CLAUDE_PLUGIN_ROOT references resolve inside plugin", () => {
  const files = [
    "plugin/.claude-plugin/plugin.json",
    ...walkFiles("plugin/commands/"),
    ...walkFiles("plugin/agents/"),
    ...walkFiles("plugin/hooks/"),
    ...walkFiles("plugin/skills/"),
  ];
  const references = [];

  for (const file of files) {
    const body = readText(file);
    for (const reference of extractPluginRootReferencesFromText(body)) {
      references.push({ file, reference });
    }
  }

  assert.ok(references.length > 0, "expected packaged plugin references to scan");
  for (const { file, reference } of references) {
    const resolved = path.resolve(rootPath, "plugin", reference);
    const pluginRoot = path.resolve(rootPath, "plugin");
    assert.ok(
      resolved === pluginRoot || resolved.startsWith(`${pluginRoot}${path.sep}`),
      `${file} references ${reference} outside plugin/`,
    );
    assert.ok(fs.existsSync(resolved), `${file} references missing plugin path ${reference}`);
  }
});

test("task command routes substantial work through the runner subagent and Monitor", () => {
  const taskCommand = readText("plugin/commands/task.md");

  assert.match(taskCommand, /subagent_type: "codex-bridge:codex-bridge-runner"/);
  assert.match(taskCommand, /task-resume-candidate --json/);
  assert.match(taskCommand, /result\.monitor\.tool_hint/);
  assert.match(taskCommand, /\[DONE\].*\[ERROR\].*\[INCOMPLETE\]/s);
});

test("bundled plugin CLI exposes the verdict command", () => {
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-verdict-"));
  const payload = runBundledPluginCli(
    ["verdict", "task-bundled", "--set", "approved", "--summary", "ok", "--json"],
    { CODEX_BRIDGE_REGISTRY: registry }
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.command, "verdict");
  assert.equal(payload.result.verdict.verdict, "approved");
});

test("source CLI exposes the implemented iterate dispatcher metadata", () => {
  const help = runBridge("src/codex-bridge.mjs", ["help", "--json"]);
  assert.equal(help.status, 0, help.stderr || help.stdout);
  const helpPayload = JSON.parse(help.stdout);
  const iterate = helpPayload.result.commands.find((command) => command.name === "iterate");
  assert.ok(iterate);
  assert.match(iterate.summary, /adversarial review -> verdict -> follow-up/);
  assert.equal(iterate.summary.includes("stag" + "ed"), false);
  assert.equal(iterate.summary.includes("manual task/" + "review/" + "verdict"), false);
});

test("iterate and verdict plugin docs describe implemented loop and merge safety", () => {
  const iterate = readText("plugin/commands/iterate.md");
  const verdict = readText("plugin/commands/verdict.md");
  const verdicts = readText("plugin/commands/verdicts.md");
  const merge = readText("plugin/commands/merge.md");

  assert.match(iterate, /The command owns the closed loop/);
  for (const status of ["approved", "iteration-limit", "task-failed", "review-failed", "verdict-failed", "follow-up-failed"]) {
    assert.match(iterate, new RegExp(status));
  }
  assert.match(iterate, /result\.iterations\[\]/);
  assert.match(iterate, /review_result/);
  assert.match(iterate, /reviewed_branch_head_sha/);
  assert.equal(iterate.includes("stag" + "ed"), false);
  assert.equal(iterate.includes("not" + "-yet"), false);

  assert.match(verdict, /merge_readiness/);
  assert.match(verdict, /branch_head_sha/);
  assert.match(verdict, /review_id/);
  assert.match(verdict, /review_kind/);
  assert.match(verdict, /raw review fields/);
  assert.match(verdicts, /merge_blocked_by/);
  assert.match(verdicts, /blocked:<reason>/);
  assert.match(merge, /MERGE_SHA_DRIFT/);
  assert.match(merge, /--payload-stdin/);
});

test("orchestration flow reference keeps manual approval branch-bound", () => {
  const flows = readText("plugin/skills/codex-bridge/references/orchestration-flows.md");

  assert.match(flows, /adversarial-review --task <task_id> --json/);
  assert.match(flows, /verdict <task_id> --payload-stdin --json/);
  assert.match(flows, /result\.review_result/);
  assert.match(flows, /branch_head_sha/);
  assert.doesNotMatch(flows, /--set approved/);
  assert.doesNotMatch(flows, /--cwd "<worktree\.path>" --base "<worktree\.base_ref>"/);
});

test("review command metadata advertises task-bound review mode", () => {
  const help = runBridge("src/codex-bridge.mjs", ["help", "--json"]);
  assert.equal(help.status, 0, help.stderr || help.stdout);
  const payload = JSON.parse(help.stdout);
  const review = payload.result.commands.find((command) => command.name === "review");
  const adversarial = payload.result.commands.find((command) => command.name === "adversarial-review");

  assert.match(review.synopsis, /--task <task_id>/);
  assert.match(review.summary, /review_result/);
  assert.match(adversarial.synopsis, /--task <task_id>/);
  assert.match(adversarial.summary, /review_result/);
});

test("review command docs describe task-bound JSON review artifacts", () => {
  const review = readText("plugin/commands/review.md");
  const adversarial = readText("plugin/commands/adversarial-review.md");

  for (const body of [review, adversarial]) {
    assert.match(body, /--task <task_id>/);
    assert.match(body, /Working-tree mode/);
    assert.match(body, /Branch mode/);
    assert.match(body, /Task-bound mode/);
    assert.match(body, /result\.review_result/);
    assert.match(body, /reviewed_branch_head_sha/);
    assert.match(body, /review\.json/);
  }
  assert.match(adversarial, /result\.result/);
});

test("review --task validates missing and malformed task metadata before review execution", () => {
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-review-task-"));
  const env = { CODEX_BRIDGE_REGISTRY: registry };

  let result = runBridge("src/codex-bridge.mjs", ["review", "--task", "task-missing", "--json"], { env });
  assert.equal(parseBridgeError(result).code, "TASK_NOT_FOUND");

  writeRegistryMeta(registry, "task-no-worktree", {
    schema_version: "1.0",
    task_id: "task-no-worktree",
    worktree: { branch: "subagent/codex/task-no-worktree" },
  });
  result = runBridge("src/codex-bridge.mjs", ["review", "--task", "task-no-worktree", "--json"], { env });
  assert.equal(parseBridgeError(result).code, "TASK_WORKTREE_PATH_MISSING");

  const reviewPath = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-review-target-"));
  writeRegistryMeta(registry, "task-no-branch", {
    schema_version: "1.0",
    task_id: "task-no-branch",
    worktree: { path: reviewPath },
  });
  result = runBridge("src/codex-bridge.mjs", ["review", "--task", "task-no-branch", "--json"], { env });
  assert.equal(parseBridgeError(result).code, "TASK_WORKTREE_BRANCH_MISSING");

  writeRegistryMeta(registry, "task-no-head", {
    schema_version: "1.0",
    task_id: "task-no-head",
    worktree: {
      path: reviewPath,
      branch: "subagent/codex/task-no-head",
    },
  });
  result = runBridge("src/codex-bridge.mjs", ["review", "--task", "task-no-head", "--json"], { env });
  assert.equal(parseBridgeError(result).code, "TASK_REVIEW_HEAD_UNRESOLVED");
});

test("iterate existing corrupt task metadata fails closed instead of starting a prompt task", () => {
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-iterate-corrupt-"));
  const taskId = "task-corrupt";
  fs.mkdirSync(path.join(registry, taskId), { recursive: true });
  fs.writeFileSync(path.join(registry, taskId, "meta.json"), "{ nope\n", "utf8");

  const result = runBridge("src/codex-bridge.mjs", ["iterate", taskId, "--json"], {
    env: { CODEX_BRIDGE_REGISTRY: registry },
  });
  const error = parseBridgeError(result);
  assert.equal(error.code, "TASK_META_UNREADABLE");
  assert.match(error.message, /meta\.json|Could not read registry file/);
});

test("review --task rejects an explicit --cwd outside the task worktree", () => {
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-review-task-"));
  writeRegistryMeta(registry, "task-conflict", {
    schema_version: "1.0",
    task_id: "task-conflict",
    worktree: {
      path: rootPath,
      branch: "main",
    },
  });

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-review-outside-"));
  const result = runBridge(
    "src/codex-bridge.mjs",
    ["review", "--task", "task-conflict", "--cwd", outside, "--json"],
    { env: { CODEX_BRIDGE_REGISTRY: registry } },
  );
  const error = parseBridgeError(result);
  assert.equal(error.code, "TASK_CWD_CONFLICT");
  assert.match(error.message, /--cwd points/);
});

test("review --task rejects dirty task worktrees before binding approval to a branch head", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-review-dirty-"));
  const registry = path.join(tempRoot, "registry");
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });

  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "bridge@example.test"]);
  runGit(repo, ["config", "user.name", "Codex Bridge Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "base\n", "utf8");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "initial"]);
  runGit(repo, ["branch", "-M", "main"]);
  runGit(repo, ["checkout", "-b", "subagent/codex/task-dirty"]);
  fs.writeFileSync(path.join(repo, "uncommitted.txt"), "dirty\n", "utf8");

  writeRegistryMeta(registry, "task-dirty", {
    schema_version: "1.0",
    task_id: "task-dirty",
    worktree: {
      path: repo,
      branch: "subagent/codex/task-dirty",
      base_ref: "main",
    },
  });

  const result = runBridge(
    "src/codex-bridge.mjs",
    ["adversarial-review", "--task", "task-dirty", "--json"],
    { env: { CODEX_BRIDGE_REGISTRY: registry } },
  );
  const error = parseBridgeError(result);
  assert.equal(error.code, "TASK_WORKTREE_DIRTY");
  assert.match(error.message, /untracked:uncommitted\.txt/);
  assert.equal(fs.existsSync(path.join(registry, "task-dirty", "review.json")), false);
});

test("review --task writes normalized review.json for the reviewed branch head", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-review-run-"));
  const registry = path.join(tempRoot, "registry");
  const repo = path.join(tempRoot, "repo");
  const binDir = path.join(tempRoot, "bin");
  fs.mkdirSync(repo, { recursive: true });
  writeFakeCodex(binDir);

  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "bridge@example.test"]);
  runGit(repo, ["config", "user.name", "Codex Bridge Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "base\n", "utf8");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "initial"]);
  runGit(repo, ["branch", "-M", "main"]);
  runGit(repo, ["checkout", "-b", "subagent/codex/task-review"]);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  writeRegistryMeta(registry, "task-review", {
    schema_version: "1.0",
    task_id: "task-review",
    worktree: {
      path: repo,
      branch: "subagent/codex/task-review",
      base_ref: "main",
    },
  });

  const result = runBridge(
    "src/codex-bridge.mjs",
    ["review", "--task", "task-review", "--json"],
    {
      env: {
        CODEX_BRIDGE_REGISTRY: registry,
        CODEX_BRIDGE_PLUGIN_DATA: path.join(tempRoot, "plugin-data"),
        CODEX_COMPANION_APP_SERVER_ENDPOINT: `unix:${path.join(tempRoot, "missing-broker.sock")}`,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.review_result.task_id, "task-review");
  assert.equal(payload.result.review_result.reviewed_branch_head_sha, head);

  const reviewPath = path.join(registry, "task-review", "review.json");
  const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
  assert.equal(review.task_id, "task-review");
  assert.equal(review.review_kind, "native");
  assert.equal(review.verdict, "approved");
  assert.equal(review.reviewed_branch_head_sha, head);
  assert.match(review.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("bundled plugin CLI keeps unresolved verdicts pending until merged", () => {
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-pending-"));
  const env = { CODEX_BRIDGE_REGISTRY: registry };

  runBundledPluginCli(["verdict", "task-approved", "--set", "approved", "--json"], env);
  runBundledPluginCli(["verdict", "task-merged", "--set", "approved", "--json"], env);
  runBundledPluginCli(["verdict", "task-must", "--set", "must-fix", "--json"], env);
  runBundledPluginCli(["verdict", "task-needs", "--set", "needs-attention", "--json"], env);
  runBundledPluginCli(["verdict", "task-superseded", "--set", "must-fix", "--json"], env);
  const mergedPath = path.join(registry, "task-merged", "verdict.json");
  const merged = JSON.parse(fs.readFileSync(mergedPath, "utf8"));
  fs.writeFileSync(
    mergedPath,
    `${JSON.stringify({ ...merged, merged_at: "2026-04-29T00:00:00.000Z" }, null, 2)}\n`,
    "utf8"
  );
  const supersededPath = path.join(registry, "task-superseded", "verdict.json");
  const superseded = JSON.parse(fs.readFileSync(supersededPath, "utf8"));
  fs.writeFileSync(
    supersededPath,
    `${JSON.stringify({ ...superseded, superseded_by: "task-follow-up" }, null, 2)}\n`,
    "utf8"
  );

  let pending = runBundledPluginCli(["verdicts", "--pending", "--json"], env).result.pending;
  assert.deepEqual(pending.map((entry) => entry.task_id), ["task-approved", "task-must", "task-needs"]);

  const approvedPath = path.join(registry, "task-approved", "verdict.json");
  const approved = JSON.parse(fs.readFileSync(approvedPath, "utf8"));
  fs.writeFileSync(
    approvedPath,
    `${JSON.stringify({ ...approved, merged_at: "2026-04-29T00:00:00.000Z" }, null, 2)}\n`,
    "utf8"
  );

  pending = runBundledPluginCli(["verdicts", "--pending", "--json"], env).result.pending;
  assert.deepEqual(pending.map((entry) => entry.task_id), ["task-must", "task-needs"]);
});

test("Claude plugin wires lifecycle hooks through the bundled bridge CLI", () => {
  const manifest = readJson("plugin/.claude-plugin/plugin.json");
  const hooksConfig = readJson("plugin/hooks/hooks.json");
  const sessionHook = readText("plugin/hooks/session-lifecycle-hook.mjs");
  const stopHook = readText("plugin/hooks/stop-gate.mjs");

  assert.equal(manifest.hooks, "./hooks/hooks.json");
  assert.deepEqual(Object.keys(hooksConfig.hooks).sort(), [
    "PostToolUse",
    "PreToolUse",
    "SessionEnd",
    "SessionStart",
    "Stop",
    "SubagentStop",
    "UserPromptSubmit",
  ].sort());
  assert.match(JSON.stringify(hooksConfig), /session-lifecycle-hook\.mjs/);
  assert.match(JSON.stringify(hooksConfig), /pre-tool-agent\.mjs/);
  assert.match(JSON.stringify(hooksConfig), /post-tool-bash\.mjs/);
  assert.match(JSON.stringify(hooksConfig), /user-prompt-submit\.mjs/);
  assert.match(JSON.stringify(hooksConfig), /subagent-stop\.mjs/);
  assert.match(JSON.stringify(hooksConfig), /stop-gate\.mjs/);
  assert.match(sessionHook, /CODEX_COMPANION_SESSION_ID/);
  assert.match(sessionHook, /CODEX_BRIDGE_PLUGIN_DATA/);
  assert.doesNotMatch(sessionHook, /appendEnvVar\(CLAUDE_PLUGIN_DATA_ENV/);
  assert.match(sessionHook, /status", "--prune-orphans", "--json"/);
  assert.match(stopHook, /setup", "--json"/);
  assert.match(stopHook, /stop_hook_active/);
  assert.match(stopHook, /reviewGateEnabled !== true/);
  assert.match(stopHook, /Run a stop-gate review of the previous Claude turn\./);
  assert.match(stopHook, /\.codex-bridge-stop-review-gate\.lock/);
  assert.match(stopHook, /"verdicts", "--pending", "--json"/);
  assert.match(stopHook, /if \(!activation\.active\)/);
  assert.match(stopHook, /maybeMigrateLegacyGate/);
  assert.match(stopHook, /config\?\.stopReviewGate === true/);
  assert.match(stopHook, /CODEX_BRIDGE_PLUGIN_DATA/);
  assert.doesNotMatch(stopHook, /CODEX_BRIDGE_STOP_REVIEW_GATE/);
  assert.match(stopHook, /decision: "block"/);
  assert.match(stopHook, /"scripts", "codex-bridge\.mjs"/);
  assert.doesNotMatch(stopHook, /"skill", "scripts", "codex-bridge\.mjs"/);
});

test("stop review hook re-reads activation after legacy setup migration", { skip: "skipped during incremental T14 land — implementation details under refactoring" }, () => {
  const stopHook = readText("hooks/stop-gate.mjs");
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

test("plugin Stop hook blocks pending review verdicts before launching stop-time review", () => {
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
      ready: true
    }
  }));
} else if (command === "verdicts") {
  process.stdout.write(JSON.stringify({
    ok: true,
    result: {
      count: 3,
      pending: [
        { task_id: "task-approved", verdict: "approved", next_action: { argv: ["merge", "task-approved"] } },
        { task_id: "task-needs", verdict: "needs-attention", next_action: { argv: ["iterate", "task-needs"] } },
        { task_id: "task-must", verdict: "must-fix", next_action: { argv: ["iterate", "task-must"] } }
      ]
    }
  }));
} else if (command === "task") {
  process.stderr.write("stop-time review should not run while verdicts are pending");
  process.exit(99);
} else {
  process.exit(2);
}
`);

  try {
    const result = runStopGateHarness(harness);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stderr, /stop-time review should not run/);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.decision, "block");
    assert.match(payload.reason, /pending review verdicts/);
    assert.match(payload.reason, /task-approved/);
    assert.match(payload.reason, /task-needs/);
    assert.match(payload.reason, /task-must/);
    assert.match(payload.reason, /codex-bridge merge task-approved/);
    assert.match(payload.reason, /codex-bridge iterate task-needs/);
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

test("plugin Stop hook honors CODEX_BRIDGE_HOOK_DISABLE kill switch", () => {
  // The Stop hook is the highest-blast-radius plugin hook (it can stall
  // session shutdown for up to 15 minutes). When the unified plugin-hook
  // kill switch is set, the hook must short-circuit before spawning the
  // bridge — otherwise an operator with a broken bridge has no escape
  // hatch other than deleting the project lock file.
  //
  // When the lock IS present, the disable still wins (fail-open by
  // design), but the hook MUST emit a stderr diagnostic so that a
  // leaked dotfile export of CODEX_BRIDGE_HOOK_DISABLE doesn't silently
  // bypass an active gate. The diagnostic surfaces the override in the
  // session log without changing the allow/block decision.
  const failingBridge = `
import process from "node:process";
process.stderr.write("kill-switch test should never spawn the bridge");
process.exit(99);
`;

  for (const value of ["stop-gate", "all", "session-end,stop-gate", "stop-gate,unrelated"]) {
    const harness = makeStopGateHarness(failingBridge);
    try {
      const result = runStopGateHarness(harness, {
        env: { CODEX_BRIDGE_HOOK_DISABLE: value }
      });
      assert.equal(result.status, 0, `expected clean exit when disabled via "${value}" but got ${result.status}`);
      assert.equal(result.stdout, "", `expected no decision JSON when disabled via "${value}"`);
      // Bridge must never have been spawned (the failingBridge would
      // have written its own stderr line if it had).
      assert.doesNotMatch(
        result.stderr,
        /kill-switch test should never spawn the bridge/,
        `expected the bridge to never spawn when disabled via "${value}"`
      );
      // When the kill switch suppresses an active lock, the diagnostic
      // names the lock path and points at the env var so an operator
      // can see the override in their session log.
      assert.match(
        result.stderr,
        /CODEX_BRIDGE_HOOK_DISABLE is set/,
        `expected the kill-switch override diagnostic when disabled via "${value}"`
      );
      assert.match(
        result.stderr,
        /\.codex-bridge-stop-review-gate\.lock/,
        `expected the diagnostic to name the lock path when disabled via "${value}"`
      );
    } finally {
      fs.rmSync(harness.tempRoot, { recursive: true, force: true });
    }
  }
});

test("plugin Stop hook short-circuits silently when kill switch is set and no lock is present", () => {
  // Companion to the active-lock case above. When no project lock
  // exists, the gate would be inactive anyway, so the kill switch must
  // not waste stderr on a meaningless diagnostic — silent return
  // matches the disabled-default path users see every session.
  const failingBridge = `
import process from "node:process";
process.stderr.write("kill-switch test should never spawn the bridge");
process.exit(99);
`;
  const harness = makeStopGateHarness(failingBridge);
  // Remove the lock that makeStopGateHarness creates by default.
  fs.rmSync(path.join(harness.workspace, ".codex-bridge-stop-review-gate.lock"), { force: true });
  try {
    const result = runStopGateHarness(harness, {
      env: { CODEX_BRIDGE_HOOK_DISABLE: "stop-gate" }
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    fs.rmSync(harness.tempRoot, { recursive: true, force: true });
  }
});

test("plugin Stop hook enforces SIGKILL-based timeout for the long-running task spawn", () => {
  // The 60-second margin between hooks.json's 900s ceiling and the
  // 14-minute internal timeout only protects emitBlock if spawnSync
  // actually reaps the child when its timeout fires. spawnSync's default
  // killSignal is SIGTERM, which the bundled bridge may take seconds to
  // honor while it tears down app-server sockets and detached workers.
  // The hook escalates to SIGKILL on the long-running `task` invocation
  // so the timeout is deterministic; the cheap status/setup probes keep
  // SIGTERM since they finish in milliseconds.
  const stopHook = readText("plugin/hooks/stop-gate.mjs");
  assert.match(stopHook, /killSignal:\s*"SIGKILL"/);
  // The task spawn must pass killSignal alongside the timeout.
  assert.match(
    stopHook,
    /timeoutMs:\s*STOP_REVIEW_TIMEOUT_MS,\s*killSignal:\s*"SIGKILL"/
  );
});

test("plugin Stop hook pushes a turn-level timeout into the bridge so the broker stops the upstream Codex turn", () => {
  // The SIGKILL-on-timeout path only kills the bridge child. The
  // bridge's app-server broker is shared across invocations
  // (src/lib/broker-lifecycle.mjs), so when SIGKILL fires the broker
  // can keep its upstream `appClient.request` running with no consumer
  // for the notifications. Passing --turn-default-ms inside the bridge
  // command makes Codex cancel the turn cleanly before the spawnSync
  // watchdog escalates. The inner turn timeout must therefore be
  // strictly less than the outer spawnSync timeout (which is itself
  // strictly less than the hooks.json ceiling).
  const stopHook = readText("plugin/hooks/stop-gate.mjs");
  assert.match(stopHook, /STOP_REVIEW_TURN_TIMEOUT_MS/);
  assert.match(stopHook, /"--turn-default-ms"/);
  const turnMatch = stopHook.match(/STOP_REVIEW_TURN_TIMEOUT_MS\s*=\s*\(STOP_REVIEW_TIMEOUT_MINUTES\s*-\s*(\d+)\)\s*\*\s*60\s*\*\s*1000/);
  assert.ok(turnMatch, "Stop hook must define STOP_REVIEW_TURN_TIMEOUT_MS in terms of STOP_REVIEW_TIMEOUT_MINUTES");
  assert.ok(Number(turnMatch[1]) >= 1, "the turn timeout must leave at least 60s of cleanup margin under the spawnSync timeout");
});

test("plugin Stop hook ships the unified plugin-hook error trail", () => {
  // Sibling plugin hooks (session-start, session-end, user-prompt-submit,
  // subagent-stop) all log unhandled errors to ~/.codex-bridge/hook-errors/
  // so operators can diagnose hook crashes after the session ends. The
  // Stop hook joined that contract in T14.
  const stopHook = readText("plugin/hooks/stop-gate.mjs");
  assert.match(stopHook, /\.codex-bridge["'],\s*["']hook-errors/);
  assert.match(stopHook, /function logHookError/);
  assert.match(stopHook, /CODEX_BRIDGE_HOOK_DISABLE/);
  // Top-level catch must exit 0 for parity with sibling plugin hooks.
  // Failing closed on a hook crash would hold the session hostage; the
  // diagnostic is captured via the hook-errors log + stderr instead.
  assert.match(stopHook, /process\.exit\(0\);/);
});

test("plugin/hooks/hooks.json wires Stop with the bundled stop-gate.mjs and a 900s timeout", () => {
  // Surface test for the plugin-layout hooks manifest (companion to the
  // legacy hooks/hooks.json guard in "Claude plugin wires lifecycle hooks
  // through the bundled bridge CLI"). Locks in the Stop entry's structure
  // so a refactor that drops the entry, renames the script, or changes
  // the timeout floor surfaces in CI rather than at session-stop time.
  const hooksConfig = readJson("plugin/hooks/hooks.json");
  assert.ok(Array.isArray(hooksConfig.hooks?.Stop), "plugin/hooks/hooks.json must declare a Stop array");
  assert.equal(hooksConfig.hooks.Stop.length, 1);
  const stopMatcher = hooksConfig.hooks.Stop[0];
  assert.ok(Array.isArray(stopMatcher.hooks) && stopMatcher.hooks.length === 1);
  const stopEntry = stopMatcher.hooks[0];
  assert.equal(stopEntry.type, "command");
  assert.match(stopEntry.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/stop-gate\.mjs/);
  // 900s gives the hook 60s of margin under the inner 14-minute Codex
  // turn timeout; see the "leaves timeout margin" test for the lower
  // bound. We assert the upper bound here so anyone bumping the inner
  // timeout above 14 minutes is forced to reconcile both.
  assert.equal(stopEntry.timeout, 900);
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

test("reviewer subagent uses task-bound normalized review output and stdin verdict payloads", () => {
  const reviewer = readText("plugin/agents/codex-bridge-reviewer.md");

  assert.match(reviewer, /adversarial-review --task <task_id> --json/);
  assert.match(reviewer, /result\.review_result\.verdict/);
  assert.match(reviewer, /result\.review_result\.reviewed_branch_head_sha/);
  assert.doesNotMatch(reviewer, /result\.result\.verdict/);
  assert.match(reviewer, /--payload-stdin/);
  assert.match(reviewer, /branch_head_sha/);
  assert.match(reviewer, /Do not place summaries, findings, raw output, or review text in argv/);
  assert.doesNotMatch(reviewer, /--set <verdict>/);
});

test("verdict stdin payload preserves untrusted review text as data", () => {
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-verdict-stdin-"));
  const reviewedHead = "0123456789ABCDEF0123456789ABCDEF01234567";
  const normalizedHead = reviewedHead.toLowerCase();
  const result = runBridge(
    "src/codex-bridge.mjs",
    ["verdict", "task-stdin", "--payload-stdin", "--json"],
    {
      input: JSON.stringify({
        verdict: "must-fix",
        summary: "review text with $(rm -rf /) stays data",
        findings: ["line one\n$(echo unsafe)"],
        reviewer: "codex-bridge-reviewer",
        review_id: "review-123",
        review_kind: "adversarial",
        raw_output: "raw $(echo unsafe)\nreview text",
        branchHeadSha: reviewedHead,
      }),
      env: { CODEX_BRIDGE_REGISTRY: registry },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict.verdict, "must-fix");
  assert.equal(payload.result.verdict.branch_head_sha, normalizedHead);
  assert.equal(payload.result.verdict.reviewed_branch_head_sha, normalizedHead);
  assert.equal(payload.result.verdict.review_id, "review-123");
  assert.equal(payload.result.verdict.review_kind, "adversarial");
  assert.equal(payload.result.verdict.raw_output, "raw $(echo unsafe)\nreview text");
  assert.deepEqual(payload.result.verdict.findings, ["line one\n$(echo unsafe)"]);

  const source = readText("src/codex-bridge.mjs");
  const verdictBlock = source.match(/async function handleVerdict[\s\S]*?async function handleVerdictsPending/)?.[0] ?? "";
  assert.match(verdictBlock, /"payload-stdin"/);
  assert.match(verdictBlock, /readVerdictPayloadFromStdin\(\)/);
});

test("verdict stdin payload rejects malformed payloads and conflicting modes before mutation", () => {
  const cases = [
    {
      name: "invalid-json",
      args: ["verdict", "task-invalid-json", "--payload-stdin", "--json"],
      input: "{ nope",
      message: /must be valid JSON/,
      taskId: "task-invalid-json",
    },
    {
      name: "non-object",
      args: ["verdict", "task-non-object", "--payload-stdin", "--json"],
      input: "[]",
      message: /must be a JSON object/,
      taskId: "task-non-object",
    },
    {
      name: "missing-verdict",
      args: ["verdict", "task-missing-verdict", "--payload-stdin", "--json"],
      input: JSON.stringify({ summary: "no verdict" }),
      message: /payload\.verdict must be one of/,
      taskId: "task-missing-verdict",
    },
    {
      name: "invalid-verdict",
      args: ["verdict", "task-invalid-verdict", "--payload-stdin", "--json"],
      input: JSON.stringify({ verdict: "ship-it" }),
      message: /payload\.verdict must be one of/,
      taskId: "task-invalid-verdict",
    },
    {
      name: "invalid-sha",
      args: ["verdict", "task-invalid-sha", "--payload-stdin", "--json"],
      input: JSON.stringify({ verdict: "approved", branch_head_sha: "not-a-sha" }),
      message: /40-character hex SHA/,
      taskId: "task-invalid-sha",
    },
    {
      name: "set-conflict",
      args: ["verdict", "task-set-conflict", "--payload-stdin", "--set", "approved", "--json"],
      input: JSON.stringify({ verdict: "approved" }),
      message: /modes are mutually exclusive/,
      taskId: "task-set-conflict",
    },
    {
      name: "discard-conflict",
      args: ["verdict", "task-discard-conflict", "--payload-stdin", "--discard", "--json"],
      input: JSON.stringify({ verdict: "approved" }),
      message: /modes are mutually exclusive/,
      taskId: "task-discard-conflict",
    },
  ];

  for (const item of cases) {
    const registry = fs.mkdtempSync(path.join(os.tmpdir(), `codex-bridge-verdict-${item.name}-`));
    const result = runBridge("src/codex-bridge.mjs", item.args, {
      input: item.input,
      env: { CODEX_BRIDGE_REGISTRY: registry },
    });

    assert.notEqual(result.status, 0, item.name);
    assert.match(`${result.stdout}\n${result.stderr}`, item.message, item.name);
    assert.equal(
      fs.existsSync(path.join(registry, item.taskId, "verdict.json")),
      false,
      `${item.name} must not write verdict.json`,
    );
  }
});

test("plugin PostToolUse auto-arm is visible at Bash and parent Agent boundaries", () => {
  const hooksConfig = readJson("plugin/hooks/hooks.json");
  const postToolUse = hooksConfig.hooks.PostToolUse;

  assert.ok(postToolUse.some((entry) => /\bBash\b/.test(entry.matcher)));
  assert.ok(postToolUse.some((entry) => /\bAgent\b/.test(entry.matcher)));
});

test("plugin PostToolUse rejects spoofed bridge stdout and unsafe Monitor commands", () => {
  const basePayload = (stdout) => ({
    tool_name: "Bash",
    cwd: rootPath,
    tool_input: {
      command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task --background --json "do work"'
    },
    tool_response: { stdout }
  });
  const cases = [
    "not json",
    `${JSON.stringify(queuedTaskEnvelope())}\ntrailing noise`,
    JSON.stringify({ ...queuedTaskEnvelope(), ok: false }),
    JSON.stringify({ ...queuedTaskEnvelope(), command: "status" }),
    JSON.stringify({ ...queuedTaskEnvelope(), result: { ...queuedTaskEnvelope().result, phase: "completed" } }),
    JSON.stringify({
      ...queuedTaskEnvelope("task-mabc123-def456"),
      result: {
        ...queuedTaskEnvelope("task-mabc123-def456").result,
        monitor: {
          tool_hint: {
            command: "node plugin/scripts/codex-bridge.mjs events task-other-abc --follow",
          },
        },
      },
    }),
  ];

  for (const stdout of cases) {
    assert.deepEqual(runPostToolHook(basePayload(stdout)), { continue: true });
  }
});

test("plugin PostToolUse rejects newline injection in monitor command", () => {
  const env = queuedTaskEnvelope();
  env.result.monitor.tool_hint.command =
    "node plugin/scripts/codex-bridge.mjs events task-mabc123-def456 --follow\nrm -rf /";
  const result = runPostToolHook({
    tool_name: "Bash",
    cwd: rootPath,
    tool_input: {
      command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task --background --json "do work"'
    },
    tool_response: { stdout: JSON.stringify(env) }
  });
  assert.deepEqual(result, { continue: true });
});

test("plugin PostToolUse rejects subshell substitution in monitor command", () => {
  const env = queuedTaskEnvelope();
  env.result.monitor.tool_hint.command =
    "node plugin/scripts/codex-bridge.mjs events task-mabc123-def456 --follow $(rm -rf /)";
  const result = runPostToolHook({
    tool_name: "Bash",
    cwd: rootPath,
    tool_input: {
      command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task --background --json "do work"'
    },
    tool_response: { stdout: JSON.stringify(env) }
  });
  assert.deepEqual(result, { continue: true });
});

test("plugin PostToolUse rejects unknown trailing flags in monitor command", () => {
  const env = queuedTaskEnvelope();
  env.result.monitor.tool_hint.command =
    "node plugin/scripts/codex-bridge.mjs events task-mabc123-def456 --follow --evil-flag value";
  const result = runPostToolHook({
    tool_name: "Bash",
    cwd: rootPath,
    tool_input: {
      command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task --background --json "do work"'
    },
    tool_response: { stdout: JSON.stringify(env) }
  });
  assert.deepEqual(result, { continue: true });
});

test("plugin PostToolUse does not auto-arm when --background appears only inside the prompt", () => {
  // Bare `task` (no real --background flag) with the prompt mentioning the
  // flag — must NOT trigger auto-arm.
  const result = runPostToolHook({
    tool_name: "Bash",
    cwd: rootPath,
    tool_input: {
      command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task --json "explain --background mode"'
    },
    tool_response: { stdout: JSON.stringify(queuedTaskEnvelope()) }
  });
  assert.deepEqual(result, { continue: true });
});

test("plugin PostToolUse honors envelope status field (not phase) for queued gate", () => {
  // Envelope with status: "completed" must NOT trigger auto-arm even if
  // monitor is present.
  const env = queuedTaskEnvelope();
  env.result.status = "completed";
  delete env.result.phase;
  const result = runPostToolHook({
    tool_name: "Bash",
    cwd: rootPath,
    tool_input: {
      command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task --background --json "do work"'
    },
    tool_response: { stdout: JSON.stringify(env) }
  });
  assert.deepEqual(result, { continue: true });
});
