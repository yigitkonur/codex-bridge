// Lightweight "is there a newer release on GitHub?" probe.
//
// Goals:
//   - Silent failure. Never block the caller, never throw. A network hiccup
//     or a rate-limit hit just means "no update info this time."
//   - Cheap. One HTTPS call per 24 h per workspace (cache file). The GitHub
//     REST API allows 60 requests/hour/IP unauthenticated — well under that
//     budget even if every single invocation triggers a check.
//   - Zero-dependency. Node 22+ has fetch built in; no axios, no node-fetch.
//
// Returns a plain object so callers can render whatever they want:
//   { skipped: boolean, reason?: string, currentVersion, latestVersion?, hasUpdate?, cacheAgeMs? }

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const DEFAULT_FETCH_TIMEOUT_MS = 2500;
const GITHUB_API_URL = "https://api.github.com/repos/yigitkonur/codex-bridge/releases/latest";
const USER_AGENT = "codex-bridge-update-check";

function cachePath() {
  const root = process.env.CLAUDE_PLUGIN_DATA
    ? path.join(process.env.CLAUDE_PLUGIN_DATA, "codex-bridge-update.json")
    : path.join(os.homedir(), ".codex-bridge", "update-cache.json");
  return root;
}

function readCache() {
  try {
    const raw = fs.readFileSync(cachePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed == null) return null;
    if (typeof parsed.checkedAt !== "number") return null;
    if (typeof parsed.latestVersion !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(entry) {
  try {
    const p = cachePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(entry, null, 2));
  } catch {
    // Silent — cache write failure must never propagate.
  }
}

// Parses "1.2.3" or "v1.2.3" → [1, 2, 3]. Non-numeric suffixes (e.g.
// pre-release tags) compare lexicographically and are accepted; for our
// purposes we treat any parse failure as "unknown, not behind."
export function parseVersion(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+](.+))?$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), tag: m[4] ?? "" };
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  // Prereleases: empty tag > any tag (a release tag is newer than any
  // prerelease with the same numeric triple — standard semver behavior).
  if (pa.tag === pb.tag) return 0;
  if (pa.tag === "") return 1;
  if (pb.tag === "") return -1;
  return pa.tag < pb.tag ? -1 : 1;
}

async function fetchLatestTag(timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(GITHUB_API_URL, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (typeof json?.tag_name !== "string") return null;
    return json.tag_name.replace(/^v/i, "");
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// The main entry. Returns a plain object; never throws.
//
//   checkForUpdate({ currentVersion, force?, cacheTtlMs?, fetchTimeoutMs? })
//
// `force: true` bypasses the cache (used by `bridge update --force` or a
// future `--no-cache` flag). Otherwise fresh cache hits return immediately.
export async function checkForUpdate({
  currentVersion,
  force = false,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  const cache = readCache();
  const now = Date.now();

  if (!force && cache && now - cache.checkedAt < cacheTtlMs) {
    return {
      skipped: false,
      cached: true,
      currentVersion,
      latestVersion: cache.latestVersion,
      hasUpdate: compareVersions(currentVersion, cache.latestVersion) < 0,
      cacheAgeMs: now - cache.checkedAt,
    };
  }

  const latest = await fetchLatestTag(fetchTimeoutMs);
  if (!latest) {
    return {
      skipped: true,
      reason: cache ? "fetch-failed-using-stale" : "fetch-failed-no-cache",
      currentVersion,
      ...(cache && {
        latestVersion: cache.latestVersion,
        hasUpdate: compareVersions(currentVersion, cache.latestVersion) < 0,
        cacheAgeMs: now - cache.checkedAt,
      }),
    };
  }

  writeCache({ checkedAt: now, latestVersion: latest });
  return {
    skipped: false,
    cached: false,
    currentVersion,
    latestVersion: latest,
    hasUpdate: compareVersions(currentVersion, latest) < 0,
    cacheAgeMs: 0,
  };
}

// One-line stdout notice for use when an update is available. Kept here so
// callers (both the CLI entry hook and the `update` / `version` handlers)
// render identical copy. Writes nothing when hasUpdate is false.
export function formatUpdateNotice(result) {
  if (!result || !result.hasUpdate || !result.latestVersion) return null;
  return (
    `codex-bridge ${result.latestVersion} is available ` +
    `(you have ${result.currentVersion}). ` +
    `Run \`npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y\` to update.`
  );
}
