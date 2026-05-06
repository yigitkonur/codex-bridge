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

export const CONFIG_SCHEMA = {
  mode: { type: "enum", values: ["plan", "default"] },
  model: { type: "string" },
  effort: { type: "enum", values: ["none", "minimal", "low", "medium", "high", "xhigh"] },
  auto_review: { type: "boolean" },
  post_task_prompt: { type: "string" },
  allow_questions: { type: "boolean" },
  session_dir: { type: "string" },
  sandbox_policy: { type: "enum", values: ["danger-full-access", "workspace-write", "read-only"] },
  sandbox_enforce: { type: "boolean" },
  forbid_codex_direct: { type: "boolean" },
  skip_meta_skills: { type: "boolean" },
  command_failure_circuit_breaker: { type: "boolean" },
  idle_timeout_ms: { type: "positive-number" },
  turn_plan_ms: { type: "positive-number" },
  turn_default_ms: { type: "positive-number" },
  pipeline_stage_ms: { type: "positive-number" },
  pipeline_total_ms: { type: "positive-number" },
  question_answer_ms: { type: "positive-number" },
  artifact_retention_jobs: { type: "positive-number" },
  artifact_retention_days: { type: "positive-number" },
  redact_secrets: { type: "boolean" },
  prompt_footer: { type: "string" },
  default_backend: { type: "string" },
  adapter_routing: { type: "object" },
  stall_warning_threshold_ms: { type: "positive-number" },
};

function isConfigValueValid(schema, value) {
  return (
    schema.type === "string" ? typeof value === "string" :
    schema.type === "boolean" ? typeof value === "boolean" :
    schema.type === "object" ? value && typeof value === "object" && !Array.isArray(value) :
    schema.type === "positive-number" ? Number(value) > 0 :
    schema.type === "enum" ? typeof value === "string" && schema.values.includes(value) :
    true
  );
}

// Parse a string value from the CLI into the JS type the schema expects.
// Returns `{ ok: true, value }` or `{ ok: false, error }`.
export function parseConfigValue(key, rawValue) {
  const schema = CONFIG_SCHEMA[key];
  if (!schema) {
    return { ok: false, error: `Unknown config key '${key}'.` };
  }
  if (schema.type === "boolean") {
    if (rawValue === "true" || rawValue === "1") return { ok: true, value: true };
    if (rawValue === "false" || rawValue === "0") return { ok: true, value: false };
    return { ok: false, error: `Invalid value for '${key}'; expected boolean (true/false).` };
  }
  if (schema.type === "positive-number") {
    const n = Number(rawValue);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: `Invalid value for '${key}'; expected a positive number.` };
    }
    return { ok: true, value: n };
  }
  if (schema.type === "enum") {
    if (!schema.values.includes(rawValue)) {
      return { ok: false, error: `Invalid value for '${key}'; expected one of: ${schema.values.join(", ")}.` };
    }
    return { ok: true, value: rawValue };
  }
  if (schema.type === "string") {
    return { ok: true, value: rawValue };
  }
  // object type cannot be set via single-value CLI arg
  return { ok: false, error: `Config key '${key}' has type 'object' and cannot be set via command line.` };
}

// Human-readable description of each config key for `config explain`.
export const CONFIG_KEY_DOCS = {
  mode: "Execution mode: 'plan' (default) sends a planning turn first, then an execute turn. 'default' skips the plan turn and executes directly. Valid values: plan | default.",
  model: "Codex model to use. Example: 'gpt-5.4'. Can be overridden per-invocation with --model.",
  effort: "Reasoning effort for execute turns. Plan turns are always forced to 'xhigh'. Valid values: none | minimal | low | medium | high | xhigh.",
  auto_review: "When true, runs a native code review after every successful execute turn (the auto-pipeline). Set to false to skip review and finish immediately. Boolean.",
  post_task_prompt: "Prompt appended after the task prompt asking Codex to self-review its own work. Set to empty string to disable.",
  allow_questions: "When true, Codex may ask clarifying questions mid-task (via item/tool/requestUserInput). Use 'respond <task-id>' to answer. Boolean.",
  session_dir: "Directory where session artifacts (.events, .ndjson, .diff, .plan.md, .review.json) are stored. Defaults to ~/.codex-bridge/sessions.",
  sandbox_policy: "Filesystem sandbox applied to Codex. 'danger-full-access' = no sandbox (default). 'workspace-write' = writes restricted to cwd. 'read-only' = no writes. Valid values: danger-full-access | workspace-write | read-only.",
  skip_meta_skills: "When true, prepends a directive telling Codex to skip internal meta-skill planning scaffolding (docs/, plans/ etc). Reduces overhead for orchestrator-driven flows. Boolean.",
  command_failure_circuit_breaker: "When true, monitors repeated same-family command failures (osascript, open -a, AppleScript, computer-use/*) and emits a [WARNING] event after 3 consecutive failures. Boolean.",
  idle_timeout_ms: "Max milliseconds between app-server notifications before the turn is declared stuck (ClientTimeout). Default: 300000 (5 min). Positive number.",
  turn_plan_ms: "Wall-clock ceiling per plan turn in milliseconds. Default: 1800000 (30 min). Positive number.",
  turn_default_ms: "Wall-clock ceiling per execute turn in milliseconds. Default: 1800000 (30 min). Positive number.",
  pipeline_stage_ms: "Per-stage timeout for the auto-pipeline (review, fix, check) in milliseconds. Default: 300000 (5 min). Positive number.",
  pipeline_total_ms: "Total wall-clock budget for the entire auto-pipeline in milliseconds. Default: 900000 (15 min). Positive number.",
  question_answer_ms: "How long to wait for a 'respond' answer to a Codex question before timing out. Default: 300000 (5 min). Positive number.",
  artifact_retention_jobs: "Max number of terminal jobs to keep when running 'status --cleanup'. Positive number.",
  artifact_retention_days: "Max age in days of terminal job artifacts to keep when running 'status --cleanup'. Positive number.",
  redact_secrets: "When true, scrub likely-secret strings from persisted event and NDJSON text. Boolean.",
  prompt_footer: "Text appended to every task prompt. Useful for project-wide instructions. String.",
  default_backend: "Override the backend adapter. Normally auto-detected. String.",
  adapter_routing: "Advanced: per-adapter routing rules. Object (cannot be set via config set; edit the file directly).",
};

function parseConfigFile(filePath, source) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { config: {}, diagnostics: [] };
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const doc = yaml.load(raw) ?? {};
    const bridge = doc.codex_bridge ?? doc;
    return {
      config: typeof bridge === "object" && bridge !== null ? bridge : {},
      diagnostics: []
    };
  } catch (error) {
    return {
      config: {},
      diagnostics: [{
        severity: "error",
        code: "CONFIG_PARSE_ERROR",
        source,
        path: filePath,
        key: null,
        message: `Could not read or parse config.yaml; this layer was ignored (${error?.message ?? error}).`,
      }]
    };
  }
}

function readConfigFile(filePath) {
  return parseConfigFile(filePath, "config").config;
}

function validateConfigLayer(layer, source, pathValue) {
  const diagnostics = [];
  if (!layer || typeof layer !== "object") return diagnostics;
  for (const [key, value] of Object.entries(layer)) {
    const schema = CONFIG_SCHEMA[key];
    if (!schema) {
      diagnostics.push({
        severity: "warning",
        code: "CONFIG_UNKNOWN_KEY",
        source,
        path: pathValue,
        key,
        message: `Unknown config key '${key}' will be ignored by current runtime paths.`,
      });
      continue;
    }
    if (!isConfigValueValid(schema, value)) {
      diagnostics.push({
        severity: "error",
        code: "CONFIG_INVALID_VALUE",
        source,
        path: pathValue,
        key,
        message: schema.type === "enum"
          ? `Invalid value for '${key}'; expected one of: ${schema.values.join(", ")}.`
          : `Invalid value for '${key}'; expected ${schema.type}.`,
      });
    }
  }
  return diagnostics;
}

function sanitizeConfigLayer(layer) {
  const sanitized = {};
  if (!layer || typeof layer !== "object") return sanitized;
  for (const [key, value] of Object.entries(layer)) {
    const schema = CONFIG_SCHEMA[key];
    if (!schema || !isConfigValueValid(schema, value)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
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
  const skillParsed = parseConfigFile(skillConfigPath, "skill-dir");
  const skillLayer = skillParsed.config;

  // Workspace-root layer — only read if distinct from overrideDir (avoid
  // reading the same file twice) and actually exists.
  const workspaceParsed = workspaceConfigPath
    ? parseConfigFile(workspaceConfigPath, "workspace-root")
    : { config: {}, diagnostics: [] };
  const workspaceLayer = workspaceParsed.config;

  // Override (cwd) layer — most specific, wins last.
  const overrideParsed = overrideConfigPath
    ? parseConfigFile(overrideConfigPath, "cwd")
    : { config: {}, diagnostics: [] };
  const overrideLayer = overrideParsed.config;

  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...sanitizeConfigLayer(skillLayer),
    ...sanitizeConfigLayer(workspaceLayer),
    ...sanitizeConfigLayer(overrideLayer),
  };

  return {
    defaults: DEFAULT_CONFIG,
    skillConfig: sanitizeConfigLayer(skillLayer),
    workspaceConfig: sanitizeConfigLayer(workspaceLayer),
    cwdConfig: sanitizeConfigLayer(overrideLayer),
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
    diagnostics: [
      ...skillParsed.diagnostics,
      ...validateConfigLayer(skillLayer, "skill-dir", skillConfigPath),
      ...workspaceParsed.diagnostics,
      ...validateConfigLayer(workspaceLayer, "workspace-root", workspaceConfigPath),
      ...overrideParsed.diagnostics,
      ...validateConfigLayer(overrideLayer, "cwd", overrideConfigPath),
    ],
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

export function validateConfigLayers(skillDir, overrideDir = null, workspaceRoot = null) {
  return loadConfigLayers(skillDir, overrideDir, workspaceRoot).diagnostics;
}
