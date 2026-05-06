// Config-layer access, adapter resolution, and developer-instruction
// loading. The skill-dir config layer is read once and cached for the
// lifetime of a process; cwd / workspace-root layers are re-read on every
// call because different subcommands within one invocation may target
// different working directories.

import fs from "node:fs";
import process from "node:process";

import { resolveAdapterForRuntime } from "../adapters/index.mjs";
import { validationError } from "./cli-errors.mjs";
import { loadConfig } from "./config.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import {
  EXECUTE_INSTRUCTIONS_PATH,
  PLAN_ENFORCEMENT_PATH,
  ROOT_DIR,
} from "./runtime-paths.mjs";

// Cached skill-dir config layer. Lazy because tests (and the auto-update
// hot-path probe) sometimes call getBridgeConfig before any cwd has been
// resolved. `let` is intentional — module-scoped mutation is fine since
// only this module writes to it.
let BRIDGE_CONFIG_SKILL_LAYER = null;

export function getBridgeConfig(cwd = null, workspaceRoot = null) {
  if (!cwd && !workspaceRoot) {
    if (!BRIDGE_CONFIG_SKILL_LAYER) {
      BRIDGE_CONFIG_SKILL_LAYER = loadConfig(ROOT_DIR);
    }
    return BRIDGE_CONFIG_SKILL_LAYER;
  }
  return loadConfig(ROOT_DIR, cwd, workspaceRoot);
}

// Test-only helper. Forces the next getBridgeConfig() call to re-read the
// skill-dir layer. Production code never needs this.
export function _resetBridgeConfigCacheForTest() {
  BRIDGE_CONFIG_SKILL_LAYER = null;
}

export async function resolveCommandAdapter({
  cwd = null,
  workspaceRoot = null,
  backend = null,
  metaBackend = null,
  taskMetadata = null,
  subagentType = null,
} = {}) {
  const resolvedWorkspaceRoot = workspaceRoot ?? (cwd ? resolveWorkspaceRoot(cwd) : null);
  return resolveAdapterForRuntime({
    skillDir: ROOT_DIR,
    cwd,
    workspaceRoot: resolvedWorkspaceRoot,
    backend,
    metaBackend,
    taskMetadata,
    subagentType,
    env: process.env,
  });
}

export function ensureCodexRuntimeAdapter(adapter) {
  if (adapter?.name === "codex") return;
  throw validationError(
    `Backend '${adapter?.name ?? "unknown"}' is selected but this CLI path is not wired to that adapter yet.`,
    "BACKEND_INCAPABLE",
    "Use --backend codex, unset CODEX_BRIDGE_BACKEND, or choose a config default_backend supported by this build."
  );
}

export const DEVELOPER_INSTRUCTIONS_FALLBACK = {
  plan: "Produce one concrete plan using the plan tool. Do not write code, do not ask questions, do not brainstorm alternatives.",
  default: "Execute the task autonomously. Do not ask questions. Make reasonable assumptions and proceed."
};

export function loadDeveloperInstructions(mode) {
  const templatePath = mode === "plan" ? PLAN_ENFORCEMENT_PATH : EXECUTE_INSTRUCTIONS_PATH;
  try {
    return fs.readFileSync(templatePath, "utf8");
  } catch {
    return DEVELOPER_INSTRUCTIONS_FALLBACK[mode] ?? DEVELOPER_INSTRUCTIONS_FALLBACK.default;
  }
}
