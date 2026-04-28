import assert from "node:assert/strict";
import test from "node:test";

import {
  detectOfficialOpenAICodexPlugin,
  clearDetectOfficialOpenAICodexPluginCache
} from "../src/lib/official-plugin.mjs";

function makeStubSpawnSync() {
  let count = 0;
  const stub = () => {
    count += 1;
    return {
      status: 0,
      stdout: JSON.stringify([{ id: "codex@openai-codex", enabled: true }]),
      stderr: ""
    };
  };
  return {
    spawnSync: stub,
    get count() {
      return count;
    }
  };
}

test("detectOfficialOpenAICodexPlugin memoizes claude plugin list spawn under default cache", () => {
  clearDetectOfficialOpenAICodexPluginCache();
  const stub = makeStubSpawnSync();

  for (let i = 0; i < 10; i += 1) {
    const result = detectOfficialOpenAICodexPlugin({ spawnSync: stub.spawnSync });
    assert.equal(result.status, "active");
  }

  assert.ok(
    stub.count <= 2,
    `expected ≤2 spawn invocations under default cache, observed ${stub.count}`
  );
  assert.equal(stub.count, 1, "10 successive calls should produce a single cold spawn");
});

test("detectOfficialOpenAICodexPlugin re-spawns when maxAgeMs is 0", () => {
  clearDetectOfficialOpenAICodexPluginCache();
  const stub = makeStubSpawnSync();

  const baseline = detectOfficialOpenAICodexPlugin({ spawnSync: stub.spawnSync });
  assert.equal(baseline.status, "active");
  assert.equal(stub.count, 1);

  for (let i = 0; i < 5; i += 1) {
    const result = detectOfficialOpenAICodexPlugin({ spawnSync: stub.spawnSync, maxAgeMs: 0 });
    assert.equal(result.status, "active");
  }

  assert.equal(stub.count, 6, "maxAgeMs:0 must bypass the cache on every call");
});

test("detectOfficialOpenAICodexPlugin stores cached result and clearDetect... resets it", () => {
  clearDetectOfficialOpenAICodexPluginCache();
  const stub = makeStubSpawnSync();

  detectOfficialOpenAICodexPlugin({ spawnSync: stub.spawnSync });
  detectOfficialOpenAICodexPlugin({ spawnSync: stub.spawnSync });
  assert.equal(stub.count, 1, "second call within window should hit cache");

  clearDetectOfficialOpenAICodexPluginCache();
  detectOfficialOpenAICodexPlugin({ spawnSync: stub.spawnSync });
  assert.equal(stub.count, 2, "after clear, next call must re-spawn");
});
