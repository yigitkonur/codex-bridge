import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfigLayers, validateConfigLayers } from "../src/lib/config.mjs";

test("config diagnostics report unknown keys and invalid values by layer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-config-"));
  const skill = path.join(root, "skill");
  const workspace = path.join(root, "workspace");
  const cwd = path.join(workspace, "subdir");
  fs.mkdirSync(skill, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(skill, "config.yaml"), "codex_bridge:\n  sandbox_policy: nope\n  mystery_key: true\n");
  fs.writeFileSync(path.join(workspace, "config.yaml"), "codex_bridge:\n  artifact_retention_jobs: 0\n");
  fs.writeFileSync(path.join(cwd, "config.yaml"), "codex_bridge:\n  redact_secrets: sometimes\n");

  const diagnostics = validateConfigLayers(skill, cwd, workspace);
  assert.ok(diagnostics.some((d) => d.code === "CONFIG_UNKNOWN_KEY" && d.key === "mystery_key"));
  assert.ok(diagnostics.some((d) => d.code === "CONFIG_INVALID_VALUE" && d.key === "sandbox_policy"));
  assert.ok(diagnostics.some((d) => d.code === "CONFIG_INVALID_VALUE" && d.key === "artifact_retention_jobs"));
  assert.ok(diagnostics.some((d) => d.source === "cwd" && d.key === "redact_secrets"));

  const layers = loadConfigLayers(skill, cwd, workspace);
  assert.equal(layers.mergedConfig.sandbox_policy, "danger-full-access");
  assert.equal(layers.mergedConfig.artifact_retention_jobs, 50);
  assert.equal(layers.mergedConfig.redact_secrets, false);
  assert.equal(Object.prototype.hasOwnProperty.call(layers.mergedConfig, "mystery_key"), false);
});

test("malformed config yaml is reported and ignored for runtime merge", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-config-parse-"));
  const skill = path.join(root, "skill");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "config.yaml"), "codex_bridge:\n  mode: [\n", "utf8");

  const layers = loadConfigLayers(skill, null, null);
  assert.equal(layers.mergedConfig.mode, "plan");
  assert.ok(layers.diagnostics.some((d) => d.code === "CONFIG_PARSE_ERROR" && d.source === "skill-dir"));
});

test("runtime defaults include calibrated pipeline and retention budgets", () => {
  const layers = loadConfigLayers(null, null, null);
  assert.equal(layers.mergedConfig.pipeline_stage_ms, 720_000);
  assert.equal(layers.mergedConfig.pipeline_total_ms, 1_800_000);
  assert.equal(layers.mergedConfig.artifact_retention_jobs, 50);
  assert.equal(layers.mergedConfig.artifact_retention_days, 30);
  assert.equal(layers.mergedConfig.redact_secrets, false);
});
