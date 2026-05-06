// Read/write helper for the project-level `.claude/codex-bridge.local.md`
// configuration file. The file uses YAML frontmatter under `---` fences
// followed by free-form markdown body content. Both halves are preserved
// across edits so users can keep notes alongside their settings.
//
// This module is the single source of truth for the .local.md path, parse,
// and serialize behavior. Higher-level handlers (`/codex-bridge:config`)
// compose it with the schema in `./config.mjs` to validate keys and values
// before writing.
//
// Storage location: `<workspace>/.claude/codex-bridge.local.md`. Workspace
// resolution lives in `./workspace.mjs` so the file follows the user's git
// project root rather than the cwd of the invocation.

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export const LOCAL_CONFIG_RELATIVE_PATH = path.join(".claude", "codex-bridge.local.md");

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const DEFAULT_BODY = [
  "",
  "# Codex Bridge — project-local configuration",
  "",
  "This file holds project-local overrides for the codex-bridge plugin.",
  "Settings live in the YAML frontmatter at the top of the file. Edit the",
  "frontmatter or use the `/codex-bridge:config` slash command. Markdown",
  "below the closing `---` is preserved across edits and is yours to use",
  "for notes.",
  "",
].join("\n");

export function resolveLocalConfigPath(workspaceRoot) {
  if (!workspaceRoot || typeof workspaceRoot !== "string") {
    throw new TypeError("resolveLocalConfigPath requires a workspaceRoot string");
  }
  return path.join(workspaceRoot, LOCAL_CONFIG_RELATIVE_PATH);
}

// Parse the file at `<workspace>/.claude/codex-bridge.local.md` into a
// `{ frontmatter, body, exists, parseError }` shape. Missing files return
// `exists: false` with empty frontmatter. A malformed YAML block surfaces
// `parseError` and an empty frontmatter so callers can decide whether to
// reject or rewrite.
export function readLocalConfig(workspaceRoot) {
  const filePath = resolveLocalConfigPath(workspaceRoot);
  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      exists: false,
      frontmatter: {},
      body: "",
      parseError: null,
    };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const match = FRONTMATTER_REGEX.exec(raw);
  if (!match) {
    return {
      filePath,
      exists: true,
      frontmatter: {},
      body: raw,
      parseError: null,
    };
  }
  const [, frontmatterRaw, body] = match;
  let frontmatter = {};
  let parseError = null;
  try {
    const parsed = yaml.load(frontmatterRaw) ?? {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed;
    } else {
      parseError = "frontmatter must be a YAML mapping (key: value pairs)";
    }
  } catch (error) {
    parseError = error?.message ?? String(error);
  }
  return {
    filePath,
    exists: true,
    frontmatter,
    body: body ?? "",
    parseError,
  };
}

// Persist `frontmatter` and `body` to the .local.md file, creating the
// `.claude/` directory as needed. Frontmatter is dumped via `js-yaml` with
// stable line widths and no anchor reuse so the rendered YAML round-trips
// cleanly when the user re-runs `config set`. An empty frontmatter object
// still writes the `---` fences so the file shape is predictable.
export function writeLocalConfig(workspaceRoot, frontmatter, body) {
  const filePath = resolveLocalConfigPath(workspaceRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const serialized = serializeLocalConfig(frontmatter, body);
  fs.writeFileSync(filePath, serialized, "utf8");
  return filePath;
}

export function serializeLocalConfig(frontmatter, body) {
  const safeFrontmatter = frontmatter && typeof frontmatter === "object" && !Array.isArray(frontmatter)
    ? frontmatter
    : {};
  const yamlText = Object.keys(safeFrontmatter).length === 0
    ? ""
    : yaml.dump(safeFrontmatter, { lineWidth: 100, noRefs: true, sortKeys: false });
  const normalizedBody = typeof body === "string" && body.length > 0 ? body : DEFAULT_BODY;
  const bodyWithLeadingNewline = normalizedBody.startsWith("\n") ? normalizedBody : `\n${normalizedBody}`;
  return `---\n${yamlText}---${bodyWithLeadingNewline}`;
}

export function getDefaultLocalConfigBody() {
  return DEFAULT_BODY;
}
