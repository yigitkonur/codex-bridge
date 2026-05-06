import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseArgs, splitRawArgumentString } from "./args.mjs";
import { validationError } from "./cli-errors.mjs";
import { readStdinIfPiped } from "./fs.mjs";
import { readPromptFileOrThrow } from "./task-runtime.mjs";
import { MODEL_ALIASES, VALID_REASONING_EFFORTS } from "./runtime-paths.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

export function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw validationError(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`,
      "INVALID_EFFORT"
    );
  }
  return normalized;
}

// Re-split argv elements that the shell didn't tokenize for us. Two shapes
// fall through here:
//
//   1. Slash-command wrappers (commands/*.md) that expand `$ARGUMENTS`
//      INTO ONE quoted argv element — the legacy single-element form.
//   2. Round-6 mixed-up form: a wrapper hard-codes some flags AND quotes
//      `$ARGUMENTS`, e.g. `setup --json "$ARGUMENTS"`. With user input
//      `--enable-review-gate --json`, the shell yields two argv elements
//      `["--json", "--enable-review-gate --json"]` — the second is a
//      collapsed flag bag that strict parseArgs would reject as an unknown
//      single flag named `"--enable-review-gate --json"`.
//
// We must NOT re-split task/adversarial-review prompt content, where a
// quoted prompt like `"write the plan"` arrives as one whitespace-bearing
// element by design. Heuristic: only re-split when the element clearly
// looks like a flag bag — its first non-whitespace character is `-`.
// Prompts almost never start with `-`; if a user really wants a leading-
// hyphen prompt they pass it after `--`. This keeps prompt fidelity for
// `task`/`adversarial-review`/`send` while fixing the flag-collapse case.
export function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  const out = [];
  for (const element of argv) {
    if (typeof element === "string" && /\s/.test(element) && element.trimStart().startsWith("-")) {
      const tokens = splitRawArgumentString(element);
      if (tokens.length > 1) {
        out.push(...tokens);
        continue;
      }
    }
    out.push(element);
  }
  return out;
}

export function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

export function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

export function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

export function resolvePromptInput(options, positionals, cwd) {
  if (options["prompt-file"]) {
    return readPromptFileOrThrow(path.resolve(cwd, options["prompt-file"]));
  }
  if (positionals.length === 1) {
    const candidate = path.resolve(cwd, positionals[0]);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return fs.readFileSync(candidate, "utf8");
      }
    } catch {
      // Not a file — treat as inline text
    }
  }
  const text = positionals.join(" ");
  if (text) return text;
  return readStdinIfPiped();
}
