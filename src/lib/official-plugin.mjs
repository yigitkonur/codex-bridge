import { spawnSync } from "node:child_process";

export const OFFICIAL_PLUGIN_STATUS = Object.freeze({
  ACTIVE: "active",
  ABSENT: "absent",
  UNKNOWN: "unknown"
});

const CLAUDE_PLUGIN_LIST_TIMEOUT_MS = 3000;

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function normalizePathLike(value) {
  return stringValue(value).replace(/\\/g, "/").toLowerCase();
}

function pluginEntryEnabled(entry) {
  if (!entry || typeof entry !== "object") return false;
  if ("enabled" in entry) return Boolean(entry.enabled);
  if ("disabled" in entry) return !entry.disabled;
  return true;
}

function summarizePluginEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    id: entry.id ?? null,
    name: entry.name ?? null,
    version: entry.version ?? null,
    scope: entry.scope ?? null,
    installPath: entry.installPath ?? entry.path ?? null,
    enabled: pluginEntryEnabled(entry)
  };
}

export function isOfficialOpenAICodexPluginEntry(entry) {
  if (!entry || typeof entry !== "object") return false;

  const id = stringValue(entry.id).toLowerCase();
  const name = stringValue(entry.name).toLowerCase();
  const source = stringValue(entry.source).toLowerCase();
  const installPath = normalizePathLike(entry.installPath ?? entry.path);
  const authorName = stringValue(entry.author?.name ?? entry.author).toLowerCase();

  if (id === "codex@openai-codex") return true;
  if (id === "codex" && authorName === "openai") return true;
  if (name === "codex" && authorName === "openai") return true;
  if (source.includes("openai/codex-plugin-cc")) return true;
  if (source.includes("openai-codex") && (id.includes("codex") || name === "codex")) return true;
  if (installPath.includes("/openai-codex/codex/")) return true;
  if (installPath.endsWith("/openai-codex/codex")) return true;
  if (installPath.includes("/codex-plugin-cc/plugins/codex")) return true;

  return false;
}

export function detectOfficialOpenAICodexPluginFromEntries(entries) {
  if (!Array.isArray(entries)) {
    return {
      status: OFFICIAL_PLUGIN_STATUS.UNKNOWN,
      detail: "Claude plugin list output was not an array.",
      plugin: null
    };
  }

  const plugin = entries.find((entry) => pluginEntryEnabled(entry) && isOfficialOpenAICodexPluginEntry(entry));
  if (plugin) {
    return {
      status: OFFICIAL_PLUGIN_STATUS.ACTIVE,
      detail: "Official OpenAI Codex plugin is enabled.",
      plugin: summarizePluginEntry(plugin)
    };
  }

  return {
    status: OFFICIAL_PLUGIN_STATUS.ABSENT,
    detail: "Official OpenAI Codex plugin was not found in the enabled Claude plugin list.",
    plugin: null
  };
}

function extractPluginEntries(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.plugins)) return parsed.plugins;
  if (Array.isArray(parsed?.result?.plugins)) return parsed.result.plugins;
  return null;
}

export function detectOfficialOpenAICodexPluginUncached(options = {}) {
  const spawn = options.spawnSync ?? spawnSync;
  const result = spawn("claude", ["plugin", "list", "--json"], {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? CLAUDE_PLUGIN_LIST_TIMEOUT_MS
  });

  if (result.error) {
    return {
      status: OFFICIAL_PLUGIN_STATUS.UNKNOWN,
      detail: `Could not run \`claude plugin list --json\`: ${result.error.message}`,
      plugin: null
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      status: OFFICIAL_PLUGIN_STATUS.UNKNOWN,
      detail: detail
        ? `\`claude plugin list --json\` exited with status ${result.status}: ${detail}`
        : `\`claude plugin list --json\` exited with status ${result.status}.`,
      plugin: null
    };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return detectOfficialOpenAICodexPluginFromEntries(extractPluginEntries(parsed));
  } catch (error) {
    return {
      status: OFFICIAL_PLUGIN_STATUS.UNKNOWN,
      detail: `Could not parse \`claude plugin list --json\`: ${error instanceof Error ? error.message : String(error)}`,
      plugin: null
    };
  }
}

const DEFAULT_DETECT_CACHE_MS = 30_000;
let cached = null;
let cachedAt = 0;

export function detectOfficialOpenAICodexPlugin(options = {}) {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_DETECT_CACHE_MS;
  if (maxAgeMs > 0 && cached !== null && Date.now() - cachedAt < maxAgeMs) {
    return cached;
  }
  const result = detectOfficialOpenAICodexPluginUncached(options);
  cached = result;
  cachedAt = Date.now();
  return result;
}

export function clearDetectOfficialOpenAICodexPluginCache() {
  cached = null;
  cachedAt = 0;
}
