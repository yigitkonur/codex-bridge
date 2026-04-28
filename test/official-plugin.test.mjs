import assert from "node:assert/strict";
import test from "node:test";

import {
  detectOfficialOpenAICodexPlugin,
  detectOfficialOpenAICodexPluginFromEntries,
  isOfficialOpenAICodexPluginEntry
} from "../src/lib/official-plugin.mjs";

test("official OpenAI Codex plugin detection matches Claude plugin list identity", () => {
  const result = detectOfficialOpenAICodexPluginFromEntries([
    {
      id: "codex@openai-codex",
      version: "1.0.4",
      enabled: true,
      installPath: "/Users/me/.claude/plugins/cache/openai-codex/codex/1.0.4"
    }
  ]);

  assert.equal(result.status, "active");
  assert.equal(result.plugin.id, "codex@openai-codex");
});

test("official plugin detection ignores disabled official plugin and codex-bridge", () => {
  const result = detectOfficialOpenAICodexPluginFromEntries([
    {
      id: "codex@openai-codex",
      enabled: false,
      installPath: "/Users/me/.claude/plugins/cache/openai-codex/codex/1.0.4"
    },
    {
      id: "codex-bridge@yigitkonur",
      enabled: true,
      installPath: "/Users/me/dev/codex-bridge"
    }
  ]);

  assert.equal(result.status, "absent");
});

test("official plugin detection recognizes the upstream repository layout", () => {
  assert.equal(
    isOfficialOpenAICodexPluginEntry({
      enabled: true,
      installPath: "/tmp/codex-plugin-cc/plugins/codex"
    }),
    true
  );
});

test("official plugin detection treats malformed plugin list output as unknown", () => {
  const result = detectOfficialOpenAICodexPluginFromEntries({ plugins: [] });

  assert.equal(result.status, "unknown");
});

test("official plugin detection accepts claude plugin list wrapper shapes", () => {
  for (const stdout of [
    JSON.stringify([{ id: "codex@openai-codex", enabled: true }]),
    JSON.stringify({ plugins: [{ id: "codex@openai-codex", enabled: true }] }),
    JSON.stringify({ result: { plugins: [{ id: "codex@openai-codex", enabled: true }] } })
  ]) {
    const result = detectOfficialOpenAICodexPlugin({
      spawnSync: () => ({ status: 0, stdout, stderr: "" })
    });

    assert.equal(result.status, "active");
  }
});
