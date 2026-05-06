import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SANDBOX_ENFORCEMENT_MARKER_KEY,
  installSandboxEnforcement,
  uninstallSandboxEnforcement,
} from "../src/lib/sandbox-enforcement.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("sandbox enforcement install writes both Claude deny rules idempotently", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-sandbox-rules-"));
  try {
    const settingsPath = path.join(temp, ".claude", "settings.json");
    const first = installSandboxEnforcement(settingsPath);
    const second = installSandboxEnforcement(settingsPath);

    assert.equal(first.alreadyInstalled, false);
    assert.equal(second.alreadyInstalled, true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const bridgeRules = settings.permissions.deny.filter((rule) =>
      rule[SANDBOX_ENFORCEMENT_MARKER_KEY] === "codex-bridge"
    );
    assert.equal(bridgeRules.length, 2);
    assert.match(bridgeRules[0].matcher.command, /codex-bridge/);
    assert.match(bridgeRules[0].matcher.command, /--read-only/);
    assert.match(bridgeRules[1].matcher.command, /codex/);
    assert.match(bridgeRules[1].matcher.command, /--sandbox/);
    assert.match(bridgeRules[1].matcher.command, /-s/);
    assert.match("codex --sandbox=read-only", new RegExp(bridgeRules[1].matcher.command));
    assert.match("codex exec -s=workspace-write", new RegExp(bridgeRules[1].matcher.command));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("sandbox enforcement install repairs partial marked installs", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-sandbox-partial-"));
  try {
    const settingsPath = path.join(temp, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      permissions: {
        deny: [
          {
            tool: "Bash",
            matcher: { command: ".*codex-bridge.*--read-only" },
            reason: "old partial rule",
            [SANDBOX_ENFORCEMENT_MARKER_KEY]: "codex-bridge",
          },
        ],
      },
    }));

    const result = installSandboxEnforcement(settingsPath);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const bridgeRules = settings.permissions.deny.filter((rule) =>
      rule[SANDBOX_ENFORCEMENT_MARKER_KEY] === "codex-bridge"
    );

    assert.equal(result.alreadyInstalled, false);
    assert.equal(bridgeRules.length, 2);
    assert.equal(bridgeRules.some((rule) => rule.reason === "old partial rule"), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("sandbox enforcement uninstall removes only codex-bridge deny rules", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-sandbox-uninstall-"));
  try {
    const settingsPath = path.join(temp, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      permissions: {
        deny: [
          { tool: "Bash", matcher: { command: "echo nope" }, reason: "keep me" },
        ],
      },
    }));

    installSandboxEnforcement(settingsPath);
    const first = uninstallSandboxEnforcement(settingsPath);
    const second = uninstallSandboxEnforcement(settingsPath);

    assert.equal(first.removed, 2);
    assert.equal(second.removed, 0);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.deepEqual(settings.permissions.deny, [
      { tool: "Bash", matcher: { command: "echo nope" }, reason: "keep me" },
    ]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("setup --enforce-sandbox installs permission deny rules under HOME", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-setup-sandbox-"));
  try {
    const home = path.join(temp, "home");
    const bin = path.join(temp, "bin");
    const pluginData = path.join(temp, "plugin-data");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(pluginData, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(bin, "node"));

    const result = spawnSync(process.execPath, [
      path.join(root, "src/codex-bridge.mjs"),
      "setup",
      "--enforce-sandbox",
      "--json",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: bin,
        CODEX_BRIDGE_PLUGIN_DATA: pluginData,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.sandboxEnforcementInstalled, true);
    assert.match(payload.result.actionsTaken[0], /Installed sandbox enforcement deny rules/);
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.permissions.deny.length, 2);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
