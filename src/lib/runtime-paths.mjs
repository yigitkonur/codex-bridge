// Path / version / effort / model constants resolved at module load. Pure
// data and load-time path probes — moved out of src/codex-bridge.mjs so
// handlers and the task runtime can import them without depending on the
// dispatcher.
//
// Path resolution must work in both source mode (this file at
// `src/lib/runtime-paths.mjs`) and bundled mode (esbuild inlines this file
// into `skill/scripts/codex-bridge.mjs` and `plugin/scripts/codex-bridge.mjs`,
// where `import.meta.url` then resolves to the bundle URL). The pattern
// mirrors broker-lifecycle.mjs:229-249: try multiple candidate locations
// and pick the one that exists.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../../package.json" with { type: "json" };

function resolveDispatcherDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Bundled mode: this file is inlined into `<scripts-dir>/codex-bridge.mjs`,
  // so import.meta.url resolves to the bundle and `here` is already the
  // dispatcher directory (skill/scripts/ or plugin/scripts/).
  if (fs.existsSync(path.join(here, "codex-bridge.mjs"))) return here;
  // Source mode: this file is at src/lib/runtime-paths.mjs; the dispatcher
  // is one level up at src/codex-bridge.mjs.
  const parent = path.resolve(here, "..");
  if (fs.existsSync(path.join(parent, "codex-bridge.mjs"))) return parent;
  // Last resort: return `here` so callers don't crash on probe-only access.
  // The mismatched path will surface as a missing schema/template error
  // when REVIEW_SCHEMA / EXECUTE_INSTRUCTIONS_PATH is actually read.
  return here;
}

export const SCRIPT_DIR = resolveDispatcherDir();
export const SCRIPT_PATH = path.join(SCRIPT_DIR, "codex-bridge.mjs");
// In dev (source mode): src/ → schemas at src/schemas/
// After bundle: skill/scripts/ or plugin/scripts/ → schemas one level up.
export const ROOT_DIR = fs.existsSync(path.join(SCRIPT_DIR, "schemas"))
  ? SCRIPT_DIR
  : path.resolve(SCRIPT_DIR, "..");
export const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
export const EXECUTE_INSTRUCTIONS_PATH = path.join(ROOT_DIR, "templates", "execute-instructions.md");
export const PLAN_ENFORCEMENT_PATH = path.join(ROOT_DIR, "templates", "plan-enforcement.md");

export const BRIDGE_VERSION = packageJson.version;
export const BRIDGE_SCHEMA_VERSION = "1.0";
export const BRIDGE_CAPABILITIES = Object.freeze([
  "plan-mode",
  "background-jobs",
  "auto-pipeline",
  "adversarial-review",
  "stop-gate-review",
  "structured-errors",
  "per-subcommand-help",
  "machine-readable-help",
  "workspace-config-override",
  "update-check",
  "backend-adapter"
]);

export const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
export const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
export const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
export const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
export const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
export const STOP_REVIEW_GATE_LOCK_FILE = ".codex-bridge-stop-review-gate.lock";
