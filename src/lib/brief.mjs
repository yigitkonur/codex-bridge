// Brief loader and validator for `task --brief @path.json`.
//
// Loads a structured-brief JSON (per plugin/schemas/brief.schema.json),
// validates it without pulling in AJV as a dependency, and returns
// either { ok: true, brief, briefHash } or { ok: false, code, message,
// details? }. The caller maps `code` to a CliError exit code.
//
// We hand-roll the validator instead of pulling in AJV. The schema is
// small and stable; the project already prefers zero-dep modules where
// reasonable, and the validator stays in lockstep with the schema by
// living in the same module. If the brief schema grows materially, a
// future refactor can swap in AJV.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { existsTask } from "./registry.mjs";

export const BRIEF_SCHEMA_VERSION = "1.0";
export const VALID_BACKENDS = new Set(["codex"]);
export const PARENT_ID_PATTERN = /^(task|review)-[A-Za-z0-9._-]+$/;

const ERR = {
  FILE_NOT_FOUND: "BRIEF_FILE_NOT_FOUND",
  INVALID_JSON: "BRIEF_INVALID_JSON",
  SCHEMA_VIOLATION: "BRIEF_SCHEMA_VIOLATION",
  PARENT_NOT_FOUND: "BRIEF_PARENT_NOT_FOUND",
  BACKEND_UNAVAILABLE: "BRIEF_BACKEND_UNAVAILABLE",
};

function fail(code, message, details) {
  return { ok: false, code, message, details };
}

function isString(v) {
  return typeof v === "string";
}
function isInteger(v) {
  return Number.isInteger(v);
}
function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function validateStringField(brief, key, opts) {
  const v = brief[key];
  if (v === undefined) {
    if (opts.required) {
      return `${key} is required`;
    }
    return null;
  }
  if (!isString(v)) return `${key} must be a string`;
  if (v.length < (opts.minLength ?? 1)) {
    return `${key} must be at least ${opts.minLength ?? 1} characters`;
  }
  if (v.length > opts.maxLength) {
    return `${key} must be at most ${opts.maxLength} characters`;
  }
  return null;
}

function validateStringArray(brief, key, opts) {
  const v = brief[key];
  if (v === undefined) return null;
  if (!Array.isArray(v)) return `${key} must be an array`;
  if (v.length > opts.maxItems) {
    return `${key} must have at most ${opts.maxItems} items`;
  }
  for (let i = 0; i < v.length; i++) {
    if (!isString(v[i])) return `${key}[${i}] must be a string`;
    if (v[i].length < 1) return `${key}[${i}] must be at least 1 character`;
    if (v[i].length > opts.maxItemLength) {
      return `${key}[${i}] must be at most ${opts.maxItemLength} characters`;
    }
  }
  return null;
}

function validateBriefShape(brief) {
  if (!isObject(brief)) return ["brief must be a JSON object"];

  const errors = [];

  if (brief.schema_version !== undefined && brief.schema_version !== BRIEF_SCHEMA_VERSION) {
    errors.push(
      `schema_version must be "${BRIEF_SCHEMA_VERSION}" (got ${JSON.stringify(brief.schema_version)})`,
    );
  }

  for (const [key, opts] of [
    ["goal", { required: true, minLength: 1, maxLength: 2000 }],
    ["worker_assignment", { required: true, minLength: 1, maxLength: 4000 }],
    ["behavior_digest_seed", { required: false, minLength: 0, maxLength: 8000 }],
  ]) {
    const err = validateStringField(brief, key, opts);
    if (err) errors.push(err);
  }

  for (const [key, opts] of [
    ["specific_concerns", { maxItems: 16, maxItemLength: 1000 }],
    ["acceptance_criteria", { maxItems: 16, maxItemLength: 1000 }],
  ]) {
    const err = validateStringArray(brief, key, opts);
    if (err) errors.push(err);
  }

  if (brief.parent_task_id !== undefined) {
    if (!isString(brief.parent_task_id)) {
      errors.push("parent_task_id must be a string");
    } else if (!PARENT_ID_PATTERN.test(brief.parent_task_id)) {
      errors.push(
        `parent_task_id must match ${PARENT_ID_PATTERN}: got ${JSON.stringify(brief.parent_task_id)}`,
      );
    }
  }

  if (brief.backend_hint !== undefined) {
    if (!isString(brief.backend_hint)) {
      errors.push("backend_hint must be a string");
    } else if (!VALID_BACKENDS.has(brief.backend_hint)) {
      errors.push(
        `backend_hint must be one of ${[...VALID_BACKENDS].join(", ")} (got ${JSON.stringify(brief.backend_hint)})`,
      );
    }
  }

  if (brief.iteration_max !== undefined) {
    if (!isInteger(brief.iteration_max)) {
      errors.push("iteration_max must be an integer");
    } else if (brief.iteration_max < 1 || brief.iteration_max > 10) {
      errors.push("iteration_max must be between 1 and 10");
    }
  }

  if (brief.trust_budget_override !== undefined) {
    const tbo = brief.trust_budget_override;
    if (!isObject(tbo)) {
      errors.push("trust_budget_override must be an object");
    } else {
      const allowedTrustBudgetKeys = new Set([
        "auto_merge_max_diff_lines",
        "auto_merge_max_files",
        "auto_merge_max_iterations",
      ]);
      for (const key of Object.keys(tbo)) {
        if (!allowedTrustBudgetKeys.has(key)) {
          errors.push(`unknown trust_budget_override field: ${key}`);
        }
      }
      for (const [key, min] of [
        ["auto_merge_max_diff_lines", 0],
        ["auto_merge_max_files", 0],
        ["auto_merge_max_iterations", 1],
      ]) {
        if (tbo[key] !== undefined) {
          if (!isInteger(tbo[key])) {
            errors.push(`trust_budget_override.${key} must be an integer`);
          } else if (tbo[key] < min) {
            errors.push(`trust_budget_override.${key} must be >= ${min}`);
          }
        }
      }
    }
  }

  // Reject extra top-level fields (additionalProperties: false in schema).
  const allowed = new Set([
    "schema_version",
    "goal",
    "worker_assignment",
    "behavior_digest_seed",
    "specific_concerns",
    "acceptance_criteria",
    "parent_task_id",
    "backend_hint",
    "iteration_max",
    "trust_budget_override",
  ]);
  for (const key of Object.keys(brief)) {
    if (!allowed.has(key)) {
      errors.push(`unknown field: ${key}`);
    }
  }

  return errors;
}

function briefHash(briefText) {
  return `sha256:${createHash("sha256").update(briefText, "utf8").digest("hex")}`;
}

// loadBrief(arg) accepts either:
//   - a string starting with "@" — file path lookup
//   - a string of inline JSON
// Returns { ok: true, brief, briefHash, source } or { ok: false, code, message, details? }.
export function loadBrief(arg) {
  if (!isString(arg) || arg.length === 0) {
    return fail(ERR.SCHEMA_VIOLATION, "brief argument must be @path or inline JSON");
  }

  let raw;
  let source;
  if (arg.startsWith("@")) {
    const filePath = path.resolve(arg.slice(1));
    if (!fs.existsSync(filePath)) {
      return fail(ERR.FILE_NOT_FOUND, `brief file not found: ${filePath}`);
    }
    try {
      raw = fs.readFileSync(filePath, "utf8");
      source = filePath;
    } catch (err) {
      return fail(ERR.FILE_NOT_FOUND, `cannot read brief file: ${err.message}`);
    }
  } else {
    raw = arg;
    source = "inline";
  }

  let brief;
  try {
    brief = JSON.parse(raw);
  } catch (err) {
    return fail(ERR.INVALID_JSON, `brief JSON parse failed: ${err.message}`);
  }

  const errors = validateBriefShape(brief);
  if (errors.length > 0) {
    return fail(ERR.SCHEMA_VIOLATION, `brief failed schema validation`, errors);
  }

  if (
    brief.parent_task_id !== undefined &&
    !existsTask(brief.parent_task_id)
  ) {
    return fail(
      ERR.PARENT_NOT_FOUND,
      `brief.parent_task_id not found: ${brief.parent_task_id}`,
    );
  }

  if (
    brief.backend_hint !== undefined &&
    !VALID_BACKENDS.has(brief.backend_hint)
  ) {
    // Defensive: in v2.0 the schema enum equals VALID_BACKENDS so this
    // branch is unreachable (validateBriefShape rejects first). Kept for
    // the future split where the schema permits a wider set than the
    // runtime has installed (e.g., adding a "claude" backend without
    // shipping the adapter in the same release).
    return fail(
      ERR.BACKEND_UNAVAILABLE,
      `brief.backend_hint=${JSON.stringify(brief.backend_hint)} is not installed in v2.0; valid: ${[...VALID_BACKENDS].join(", ")}`,
    );
  }

  return {
    ok: true,
    brief,
    briefHash: briefHash(raw),
    source,
  };
}

// renderBriefAsMarkdown(brief) renders the validated structured brief
// into a stable markdown block for human reading and for inline injection
// into adapter prompts. Adapters can override via brief-template.mjs;
// this is the default rendering used when no adapter override exists.
export function renderBriefAsMarkdown(brief) {
  const lines = [];
  lines.push("# Brief");
  lines.push("");
  lines.push("## Goal");
  lines.push(brief.goal);
  lines.push("");
  lines.push("## Worker assignment");
  lines.push(brief.worker_assignment);
  if (brief.behavior_digest_seed) {
    lines.push("");
    lines.push("## What the orchestrator already knows");
    lines.push(brief.behavior_digest_seed);
  }
  if (Array.isArray(brief.specific_concerns) && brief.specific_concerns.length > 0) {
    lines.push("");
    lines.push("## Specific concerns");
    for (const c of brief.specific_concerns) lines.push(`- ${c}`);
  }
  if (
    Array.isArray(brief.acceptance_criteria) &&
    brief.acceptance_criteria.length > 0
  ) {
    lines.push("");
    lines.push("## Acceptance criteria");
    for (const a of brief.acceptance_criteria) lines.push(`- [ ] ${a}`);
  }
  if (brief.parent_task_id) {
    lines.push("");
    lines.push(`Parent task: \`${brief.parent_task_id}\``);
  }
  return lines.join("\n");
}
