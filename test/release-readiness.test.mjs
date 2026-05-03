import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { packageRelease } from "../scripts/package-release.mjs";
import { runRuntimeSmoke } from "../scripts/runtime-smoke.mjs";

const rootPath = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const buildWorkflow = fs.readFileSync(new URL("../.github/workflows/build.yml", import.meta.url), "utf8");
const releaseWorkflow = fs.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

test("package.json exposes release and runtime smoke scripts", () => {
  assert.equal(packageJson.scripts["release:package"], "node scripts/package-release.mjs");
  assert.equal(packageJson.scripts["smoke:runtime"], "node scripts/runtime-smoke.mjs");
  assert.match(packageJson.scripts["verify:static"], /npm run build/);
  assert.match(packageJson.scripts["verify:static"], /npm test/);
  assert.match(packageJson.scripts["verify:static"], /baseline:contracts/);
});

test("build workflow runs the static gate and smoke harness", () => {
  assert.match(buildWorkflow, /npm run verify:static/);
  assert.match(buildWorkflow, /npm run smoke:runtime -- --static-only --json/);
  assert.match(buildWorkflow, /verify committed bundle matches fresh build/);
});

test("release workflow packages from the source script after static verification", () => {
  const verifyIndex = releaseWorkflow.indexOf("npm run verify:static");
  const packageIndex = releaseWorkflow.indexOf("npm run release:package -- --tag");
  assert.ok(verifyIndex >= 0, "release workflow must run static verification");
  assert.ok(packageIndex >= 0, "release workflow must call package script");
  assert.ok(verifyIndex < packageIndex, "release must verify before packaging");
  assert.match(releaseWorkflow, /dist\/SHA256SUMS/);
  assert.match(releaseWorkflow, /body_path: \$\{\{ steps\.notes\.outputs\.notes_path \}\}/);
});

test("release package script stages archives, checksums, and notes without maintainer docs", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-release-package-"));
  try {
    const result = packageRelease({
      tag: `v${packageJson.version}`,
      distDir: tempRoot,
      skipBuild: true,
    });

    for (const artifact of Object.values(result.artifacts)) {
      assert.ok(fs.existsSync(artifact), `missing artifact ${artifact}`);
      assert.ok(fs.statSync(artifact).size > 0, `empty artifact ${artifact}`);
    }

    const sums = fs.readFileSync(result.artifacts.checksums, "utf8");
    assert.match(sums, /codex-bridge-v.*\.tar\.gz/);
    assert.match(sums, /codex-bridge-v.*\.zip/);
    assert.doesNotMatch(sums, /SHA256SUMS/);

    const tarList = spawnSync("tar", ["-tzf", result.artifacts.tarball], { encoding: "utf8" });
    assert.equal(tarList.status, 0, tarList.stderr);
    assert.match(tarList.stdout, /codex-bridge\/SKILL\.md/);
    assert.doesNotMatch(tarList.stdout, /codex-bridge\/AGENTS\.md/);
    assert.doesNotMatch(tarList.stdout, /codex-bridge\/CLAUDE\.md/);

    const notes = fs.readFileSync(result.artifacts.releaseNotes, "utf8");
    assert.match(notes, /npx -y skills@latest add yigitkonur\/codex-bridge/);
    assert.match(notes, /setup --json/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runtime smoke harness static mode validates bundled CLI envelopes without Codex", () => {
  const result = runRuntimeSmoke({ staticOnly: true });
  assert.equal(result.ok, true);
  assert.equal(result.live, "skipped");
  assert.equal(result.skipReason, "static-only");
  assert.ok(result.probes.length >= 6);
  assert.ok(result.probes.every((probe) => probe.status === 0 || probe.status === 6));
});

test("runtime smoke CLI emits JSON in static-only mode", () => {
  const cli = spawnSync(process.execPath, ["scripts/runtime-smoke.mjs", "--static-only", "--json"], {
    cwd: rootPath,
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const payload = JSON.parse(cli.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.live, "skipped");
  assert.equal(payload.skipReason, "static-only");
});
