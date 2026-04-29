import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const bridgePath = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));

function writeUpdateCache(root, latestVersion) {
  fs.writeFileSync(
    path.join(root, "codex-bridge-update.json"),
    JSON.stringify({ checkedAt: Date.now(), latestVersion }),
    "utf8"
  );
}

function runUpdateCommand(root, preloaderPath, markerPath, args = []) {
  return spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preloaderPath).href, bridgePath, "update", "--json", ...args],
    {
      env: {
        ...process.env,
        CODEX_BRIDGE_FETCH_MARKER: markerPath,
        CODEX_BRIDGE_FETCH_TAG: "1.5.0",
        CODEX_BRIDGE_NO_UPDATE_CHECK: "1",
        CODEX_BRIDGE_PLUGIN_DATA: root,
      },
      encoding: "utf8",
    }
  );
}

test("update uses the cached check unless --force is passed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-update-command-"));
  const markerPath = path.join(root, "fetch-calls.log");
  const preloaderPath = path.join(root, "fetch-preload.mjs");

  fs.writeFileSync(
    preloaderPath,
    [
      'import fs from "node:fs";',
      "globalThis.fetch = async (url) => {",
      "  fs.appendFileSync(process.env.CODEX_BRIDGE_FETCH_MARKER, `${url}\\n`, 'utf8');",
      "  return {",
      "    ok: true,",
      "    status: 200,",
      "    async json() { return { tag_name: process.env.CODEX_BRIDGE_FETCH_TAG }; },",
      "  };",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );

  try {
    writeUpdateCache(root, "99.0.0");

    const cached = runUpdateCommand(root, preloaderPath, markerPath);
    assert.equal(cached.status, 0, cached.stderr || cached.stdout);
    const cachedPayload = JSON.parse(cached.stdout);
    assert.equal(cachedPayload.result.latest_version, "99.0.0");
    assert.equal(cachedPayload.result.has_update, true);
    assert.equal(fs.existsSync(markerPath), false);

    const forced = runUpdateCommand(root, preloaderPath, markerPath, ["--force"]);
    assert.equal(forced.status, 0, forced.stderr || forced.stdout);
    const forcedPayload = JSON.parse(forced.stdout);
    assert.equal(forcedPayload.result.latest_version, "1.5.0");
    assert.equal(forcedPayload.result.has_update, false);
    assert.equal(fs.readFileSync(markerPath, "utf8").trim().split("\n").length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
