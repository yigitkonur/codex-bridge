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

export function loadConfig(skillDir) {
  const configPath = skillDir
    ? path.join(skillDir, "config.yaml")
    : path.join(os.homedir(), ".codex-bridge", "config.yaml");

  let userConfig = {};
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    userConfig = yaml.load(raw) ?? {};
  } catch {
    // Config missing or malformed — use defaults silently
  }

  const bridge = userConfig.codex_bridge ?? userConfig;
  return {
    ...DEFAULT_CONFIG,
    ...(typeof bridge === "object" && bridge !== null ? bridge : {}),
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
