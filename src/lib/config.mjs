import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
// The re-export below does not create a local binding for loadConfig().
import { DEFAULT_CONFIG } from "./runtime-options.mjs";

export {
  DEFAULT_CONFIG,
  COMPLETION_CHECK_SCHEMA,
  buildCollaborationMode,
  buildSandboxPolicy,
  resolveEffort,
  resolveModel,
} from "./runtime-options.mjs";

function readConfigFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const doc = yaml.load(raw) ?? {};
    const bridge = doc.codex_bridge ?? doc;
    return typeof bridge === "object" && bridge !== null ? bridge : {};
  } catch {
    return {};
  }
}

function configPaths(skillDir, overrideDir = null, workspaceRoot = null) {
  const skillConfigPath = skillDir
    ? path.join(skillDir, "config.yaml")
    : path.join(os.homedir(), ".codex-bridge", "config.yaml");
  const workspaceConfigPath =
    workspaceRoot && workspaceRoot !== overrideDir
      ? path.join(workspaceRoot, "config.yaml")
      : null;
  const overrideConfigPath =
    overrideDir ? path.join(overrideDir, "config.yaml") : null;
  return { skillConfigPath, workspaceConfigPath, overrideConfigPath };
}

// Load bridge config with four-layer precedence (lowest → highest):
//   1. DEFAULT_CONFIG             — hard-coded fallback
//   2. `{skillDir}/config.yaml`   — installed skill's global defaults
//   3. `{workspaceRoot}/config.yaml` — project-level (git repo root) if distinct from cwd
//   4. `{overrideDir}/config.yaml`   — cwd override (most specific)
//
// Layers 3 and 4 let a user override bridge behavior per-project without
// editing their global skill config. Running commands from a subdirectory
// of a repo still picks up the repo-root config via layer 3, and a cwd
// sibling config.yaml wins last. Prior to this, only layer 2 was read —
// see `unexpected-bridge-observations/07-cwd-config-yaml-is-ignored.md`
// for the original derailment.
//
// `overrideDir` is typically the caller's cwd. If `workspaceRoot` is
// provided and differs, its config.yaml gets layered in before cwd.
export function loadConfigLayers(skillDir, overrideDir = null, workspaceRoot = null) {
  const { skillConfigPath, workspaceConfigPath, overrideConfigPath } =
    configPaths(skillDir, overrideDir, workspaceRoot);
  const skillLayer = readConfigFile(skillConfigPath);

  // Workspace-root layer — only read if distinct from overrideDir (avoid
  // reading the same file twice) and actually exists.
  const workspaceLayer =
    workspaceConfigPath && fs.existsSync(workspaceConfigPath)
      ? readConfigFile(workspaceConfigPath)
      : {};

  // Override (cwd) layer — most specific, wins last.
  const overrideLayer =
    overrideConfigPath && fs.existsSync(overrideConfigPath)
      ? readConfigFile(overrideConfigPath)
      : {};

  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...skillLayer,
    ...workspaceLayer,
    ...overrideLayer,
  };

  return {
    defaults: DEFAULT_CONFIG,
    skillConfig: skillLayer,
    workspaceConfig: workspaceLayer,
    cwdConfig: overrideLayer,
    mergedConfig,
    sources: {
      skillConfigPath,
      skillConfigExists: fs.existsSync(skillConfigPath),
      workspaceConfigPath,
      workspaceConfigExists:
        workspaceConfigPath ? fs.existsSync(workspaceConfigPath) : false,
      overrideConfigPath,
      overrideConfigExists:
        overrideConfigPath ? fs.existsSync(overrideConfigPath) : false,
    },
  };
}

export function loadConfig(skillDir, overrideDir = null, workspaceRoot = null) {
  return loadConfigLayers(skillDir, overrideDir, workspaceRoot).mergedConfig;
}

// Helper so callers can answer "where did the active config come from?".
// Used by `config show`, `setup --json`, `version --json` so users can
// discover the exact file they need to edit. Reports all four layers.
export function resolveConfigSources(skillDir, overrideDir = null, workspaceRoot = null) {
  return loadConfigLayers(skillDir, overrideDir, workspaceRoot).sources;
}

export function resolveConfigLayers(skillDir, overrideDir = null, workspaceRoot = null) {
  const sources = resolveConfigSources(skillDir, overrideDir, workspaceRoot);
  return {
    skillConfig: sources.skillConfigExists ? readConfigFile(sources.skillConfigPath) : {},
    workspaceConfig: sources.workspaceConfigExists ? readConfigFile(sources.workspaceConfigPath) : {},
    cwdConfig: sources.overrideConfigExists ? readConfigFile(sources.overrideConfigPath) : {},
  };
}
