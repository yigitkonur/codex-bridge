import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

const DEFAULT_CONFIG = {
  mode: "plan",
  model: "gpt-5.4",
  effort: "high",
  auto_review: true,
  post_task_prompt: [
    "Review your own work critically:",
    "1. Is this task 100% complete?",
    "2. Are there any edge cases you missed?",
    "3. Did you run all relevant tests?",
    "List any unfinished items.",
  ].join("\n"),
  allow_questions: true,
  session_dir: "~/.codex-bridge/sessions",
  prompt_footer: "When you need to ask a question to user, always use the request_user_input tool with distinct options to help the user navigate choices. Never ask questions as plain text messages.",
};

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
export function loadConfig(skillDir, overrideDir = null, workspaceRoot = null) {
  const readYaml = (p) => {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const doc = yaml.load(raw) ?? {};
      const bridge = doc.codex_bridge ?? doc;
      return typeof bridge === "object" && bridge !== null ? bridge : {};
    } catch {
      return {};
    }
  };

  const skillConfigPath = skillDir
    ? path.join(skillDir, "config.yaml")
    : path.join(os.homedir(), ".codex-bridge", "config.yaml");
  const skillLayer = readYaml(skillConfigPath);

  // Workspace-root layer — only read if distinct from overrideDir (avoid
  // reading the same file twice) and actually exists.
  const workspaceConfigPath =
    workspaceRoot && workspaceRoot !== overrideDir
      ? path.join(workspaceRoot, "config.yaml")
      : null;
  const workspaceLayer =
    workspaceConfigPath && fs.existsSync(workspaceConfigPath)
      ? readYaml(workspaceConfigPath)
      : {};

  // Override (cwd) layer — most specific, wins last.
  const overrideConfigPath =
    overrideDir ? path.join(overrideDir, "config.yaml") : null;
  const overrideLayer =
    overrideConfigPath && fs.existsSync(overrideConfigPath)
      ? readYaml(overrideConfigPath)
      : {};

  return {
    ...DEFAULT_CONFIG,
    ...skillLayer,
    ...workspaceLayer,
    ...overrideLayer,
  };
}

// Helper so callers can answer "where did the active config come from?".
// Used by `config show`, `setup --json`, `version --json` so users can
// discover the exact file they need to edit. Reports all four layers.
export function resolveConfigSources(skillDir, overrideDir = null, workspaceRoot = null) {
  const skillConfigPath = skillDir
    ? path.join(skillDir, "config.yaml")
    : path.join(os.homedir(), ".codex-bridge", "config.yaml");
  const workspaceConfigPath =
    workspaceRoot && workspaceRoot !== overrideDir
      ? path.join(workspaceRoot, "config.yaml")
      : null;
  const overrideConfigPath =
    overrideDir ? path.join(overrideDir, "config.yaml") : null;
  return {
    skillConfigPath,
    skillConfigExists: fs.existsSync(skillConfigPath),
    workspaceConfigPath,
    workspaceConfigExists:
      workspaceConfigPath ? fs.existsSync(workspaceConfigPath) : false,
    overrideConfigPath,
    overrideConfigExists:
      overrideConfigPath ? fs.existsSync(overrideConfigPath) : false,
  };
}

export function resolveEffort(config, options = {}) {
  return options.effort ?? config.effort ?? "high";
}

export function resolveModel(config, options = {}) {
  return options.model ?? config.model ?? DEFAULT_CONFIG.model;
}

export function buildCollaborationMode(mode, config, options = {}) {
  if (!mode) {
    return null;
  }

  const effort = mode === "plan" ? "xhigh" : resolveEffort(config, options);

  return {
    mode,
    settings: {
      model: resolveModel(config, options),
      reasoning_effort: effort,
      developer_instructions: options.developerInstructions ?? null,
    },
  };
}

export function buildSandboxPolicy(mode) {
  // Only the two recognized modes opt into write access. Unknown values
  // default to the safest policy (readOnly) so a typo in config.yaml cannot
  // silently widen sandbox permissions.
  if (mode === "default") {
    return { type: "workspaceWrite" };
  }
  return { type: "readOnly" };
}

export const COMPLETION_CHECK_SCHEMA = {
  type: "object",
  properties: {
    complete: { type: "boolean" },
    missing_items: {
      type: "array",
      items: { type: "string" },
    },
    summary: { type: "string" },
  },
  required: ["complete", "missing_items", "summary"],
  additionalProperties: false,
};

export { DEFAULT_CONFIG };
