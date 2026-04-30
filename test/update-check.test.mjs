import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkForUpdate,
  claimApplyAttempt,
  markApplyAttempted,
  shouldAttemptApply,
} from "../src/lib/update-check.mjs";

function readUpdateCache(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "codex-bridge-update.json"), "utf8"));
}

test("checkForUpdate preserves apply markers during forced successful refresh", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-update-check-"));
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;
  const previousFetch = globalThis.fetch;

  process.env.CODEX_BRIDGE_PLUGIN_DATA = root;
  delete process.env.CLAUDE_PLUGIN_DATA;

  t.after(() => {
    if (previousBridgePluginData === undefined) {
      delete process.env.CODEX_BRIDGE_PLUGIN_DATA;
    } else {
      process.env.CODEX_BRIDGE_PLUGIN_DATA = previousBridgePluginData;
    }

    if (previousClaudePluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousClaudePluginData;
    }

    globalThis.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const initialCheckedAt = Date.now() - 10_000;
  fs.writeFileSync(
    path.join(root, "codex-bridge-update.json"),
    JSON.stringify({ checkedAt: initialCheckedAt, latestVersion: "1.4.0" }),
    "utf8"
  );

  markApplyAttempted("1.4.9");
  const cacheWithApplyMarker = readUpdateCache(root);

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { tag_name: "1.5.0" };
    },
  });

  const result = await checkForUpdate({
    currentVersion: "1.4.0",
    force: true,
    fetchTimeoutMs: 1000,
  });

  assert.equal(result.latestVersion, "1.5.0");
  assert.equal(result.cached, false);

  const refreshedCache = readUpdateCache(root);
  assert.equal(refreshedCache.latestVersion, "1.5.0");
  assert.ok(refreshedCache.checkedAt > initialCheckedAt);
  assert.equal(refreshedCache.lastApplyAttempt, cacheWithApplyMarker.lastApplyAttempt);
  assert.equal(refreshedCache.lastApplyTargetVersion, "1.4.9");
});

test("claimApplyAttempt records only one immediate apply slot", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-update-claim-"));
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;

  process.env.CODEX_BRIDGE_PLUGIN_DATA = root;
  delete process.env.CLAUDE_PLUGIN_DATA;

  t.after(() => {
    if (previousBridgePluginData === undefined) {
      delete process.env.CODEX_BRIDGE_PLUGIN_DATA;
    } else {
      process.env.CODEX_BRIDGE_PLUGIN_DATA = previousBridgePluginData;
    }

    if (previousClaudePluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousClaudePluginData;
    }

    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(
    path.join(root, "codex-bridge-update.json"),
    JSON.stringify({ checkedAt: Date.now(), latestVersion: "1.5.0" }),
    "utf8"
  );

  assert.equal(claimApplyAttempt("1.5.0"), true);
  assert.equal(claimApplyAttempt("1.5.0"), false);

  const cache = readUpdateCache(root);
  assert.equal(cache.latestVersion, "1.5.0");
  assert.equal(cache.lastApplyTargetVersion, "1.5.0");
  assert.equal(typeof cache.lastApplyAttempt, "number");
  assert.equal(fs.existsSync(path.join(root, "codex-bridge-update.json.lock")), false);
});

test("shouldAttemptApply compatibility gate claims before returning", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-update-should-"));
  const previousBridgePluginData = process.env.CODEX_BRIDGE_PLUGIN_DATA;
  const previousClaudePluginData = process.env.CLAUDE_PLUGIN_DATA;

  process.env.CODEX_BRIDGE_PLUGIN_DATA = root;
  delete process.env.CLAUDE_PLUGIN_DATA;

  t.after(() => {
    if (previousBridgePluginData === undefined) {
      delete process.env.CODEX_BRIDGE_PLUGIN_DATA;
    } else {
      process.env.CODEX_BRIDGE_PLUGIN_DATA = previousBridgePluginData;
    }

    if (previousClaudePluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousClaudePluginData;
    }

    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(
    path.join(root, "codex-bridge-update.json"),
    JSON.stringify({ checkedAt: Date.now(), latestVersion: "1.5.0" }),
    "utf8"
  );

  assert.equal(shouldAttemptApply(), true);
  assert.equal(shouldAttemptApply(), false);

  const cache = readUpdateCache(root);
  assert.equal(cache.latestVersion, "1.5.0");
  assert.equal(typeof cache.lastApplyAttempt, "number");
});
