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

// Load bridge config with three-layer precedence (lowest → highest):
//   1. DEFAULT_CONFIG (hard-coded fallback)
//   2. `{skillDir}/config.yaml`            — the installed skill's defaults
//   3. `{overrideDir}/config.yaml`         — workspace override (if present)
//
// The override layer exists so a user can tweak bridge behavior for a single
// project without editing their global skill config. Prior to this, only
// layer (2) was read — a `config.yaml` in the working directory was silently
// ignored. See `unexpected-bridge-observations/07-cwd-config-yaml-is-ignored.md`
// for the original derailment. When invoked as `loadConfig(ROOT_DIR, cwd)`,
// the cwd's config.yaml is layered on top.
export function loadConfig(skillDir, overrideDir = null) {
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

  // Override layer is read only when a cwd/workspace root is explicitly
  // passed AND its config.yaml exists. No silent upward traversal.
  const overrideLayer =
    overrideDir && fs.existsSync(path.join(overrideDir, "config.yaml"))
      ? readYaml(path.join(overrideDir, "config.yaml"))
      : {};

  return {
    ...DEFAULT_CONFIG,
    ...skillLayer,
    ...overrideLayer,
  };
}

// Helper so callers can answer "where did the active config come from?".
// Used by `setup --json` / `version --json` so users can discover the file
// they need to edit. Honors the same resolution order as `loadConfig`.
export function resolveConfigSources(skillDir, overrideDir = null) {
  const skillConfigPath = skillDir
    ? path.join(skillDir, "config.yaml")
    : path.join(os.homedir(), ".codex-bridge", "config.yaml");
  const overrideConfigPath =
    overrideDir ? path.join(overrideDir, "config.yaml") : null;
  return {
    skillConfigPath,
    skillConfigExists: fs.existsSync(skillConfigPath),
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
