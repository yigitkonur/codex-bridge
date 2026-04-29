import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const bridgePath = fileURLToPath(new URL("../src/codex-bridge.mjs", import.meta.url));

test("auto-apply appends async spawn errors after closing the parent fd", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-auto-apply-"));
  const pluginData = path.join(root, "plugin-data");
  const home = path.join(root, "home");
  const markerPath = path.join(root, "spawn.log");
  const preloaderPath = path.join(root, "spawn-preload.mjs");

  fs.mkdirSync(pluginData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(pluginData, "codex-bridge-update.json"),
    JSON.stringify({ checkedAt: Date.now(), latestVersion: "99.0.0" }),
    "utf8"
  );
  fs.writeFileSync(
    preloaderPath,
    [
      'import childProcess from "node:child_process";',
      'import { EventEmitter } from "node:events";',
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      "",
      "childProcess.spawn = (...args) => {",
      "  fs.appendFileSync(process.env.CODEX_BRIDGE_SPAWN_MARKER, `${args[0]}\\n`, 'utf8');",
      "  const child = new EventEmitter();",
      "  child.unref = () => {};",
      "  process.nextTick(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));",
      "  return child;",
      "};",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_BRIDGE_PLUGIN_DATA: pluginData,
    CODEX_BRIDGE_SPAWN_MARKER: markerPath,
    HOME: home,
  };
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.CODEX_BRIDGE_NO_UPDATE_CHECK;

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preloaderPath).href, bridgePath, "config", "show"],
      { cwd: root, env, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(markerPath, "utf8"), "npx\n");

    const log = fs.readFileSync(path.join(home, ".codex-bridge", "auto-update.log"), "utf8");
    assert.match(log, /auto-apply triggered for v99\.0\.0/);
    assert.match(log, /spawn failed \(npx not on PATH\?\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
