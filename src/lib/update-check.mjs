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

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const DEFAULT_FETCH_TIMEOUT_MS = 2500;
const GH_API_PATH = "repos/yigitkonur/codex-bridge/releases/latest";
const GITHUB_API_URL = `https://api.github.com/${GH_API_PATH}`;
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

// Direct HTTPS fetch. Succeeds for public repos unauthenticated, and for
// private repos when a token env var is set. Returns the tag string on
// success, or a structured failure describing the status code so callers
// can decide whether the gh-CLI fallback is worth trying.
async function fetchLatestTagDirect(timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  // If the repo is private, unauthenticated requests return 404. Pick up
  // the standard token env vars if set (GITHUB_TOKEN is what Actions
  // workflows expose, GH_TOKEN is the `gh` CLI convention).
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(GITHUB_API_URL, {
      signal: controller.signal,
      headers,
    });
    if (!res.ok) {
      return { ok: false, status: res.status, reason: `http-${res.status}`, authHeader: Boolean(token) };
    }
    const json = await res.json();
    if (typeof json?.tag_name !== "string") {
      return { ok: false, status: 200, reason: "bad-payload", authHeader: Boolean(token) };
    }
    return { ok: true, tag: json.tag_name.replace(/^v/i, ""), source: token ? "http-token" : "http-anon" };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return { ok: false, status: 0, reason: aborted ? "timeout" : "network", authHeader: Boolean(token) };
  } finally {
    clearTimeout(t);
  }
}

// gh-CLI fallback. When the direct fetch 404s on a private repo and no
// token env var was set, `gh api …` uses the user's authenticated gh
// session — the install path (`npx skills add …`) already requires this,
// so there's no new credential surface. Silent on failure (missing gh,
// unauthenticated gh, wrong host, etc.): same "no update info" result
// as a failed direct fetch.
function fetchLatestTagViaGh(timeoutMs) {
  try {
    const result = spawnSync("gh", ["api", GH_API_PATH, "--jq", ".tag_name"], {
      encoding: "utf8",
      timeout: timeoutMs,
      // Explicitly inherit $PATH only — we don't need stdin; stderr is
      // captured so a missing-auth gh error doesn't leak to the user's
      // console on every task launch.
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) {
      return { ok: false, reason: result.error?.code === "ENOENT" ? "gh-not-installed" : "gh-failed" };
    }
    const tag = String(result.stdout || "").trim();
    if (!tag) return { ok: false, reason: "gh-empty" };
    return { ok: true, tag: tag.replace(/^v/i, ""), source: "gh-cli" };
  } catch {
    return { ok: false, reason: "gh-exception" };
  }
}

// Two-step resolver: direct HTTPS first (cheapest, works for public repos
// and private-with-token), fall through to gh CLI if direct came back with
// a 404 (the private-repo-no-token signature). Other failure reasons
// (network / timeout / bad payload) skip the gh fallback — they'd likely
// hit the same problem.
async function fetchLatestTag(timeoutMs) {
  const direct = await fetchLatestTagDirect(timeoutMs);
  if (direct.ok) return direct;
  // Only retry via gh for the specific failure signature that gh can fix:
  // 404 without a token (repo private, caller unauthenticated over HTTPS).
  // A 404 with a token means the token doesn't grant access — gh won't
  // help either, but trying is still cheap and falls through cleanly.
  if (direct.status === 404) {
    const viaGh = fetchLatestTagViaGh(timeoutMs);
    if (viaGh.ok) return viaGh;
    return { ok: false, reason: `direct-${direct.reason}+${viaGh.reason}`, status: direct.status, authHeader: direct.authHeader };
  }
  return direct;
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

  const fetchResult = await fetchLatestTag(fetchTimeoutMs);
  if (!fetchResult.ok) {
    return {
      skipped: true,
      reason: cache ? "fetch-failed-using-stale" : "fetch-failed-no-cache",
      fetchReason: fetchResult.reason,
      fetchStatus: fetchResult.status ?? null,
      authHeader: fetchResult.authHeader ?? false,
      currentVersion,
      ...(cache && {
        latestVersion: cache.latestVersion,
        hasUpdate: compareVersions(currentVersion, cache.latestVersion) < 0,
        cacheAgeMs: now - cache.checkedAt,
      }),
    };
  }

  writeCache({ checkedAt: now, latestVersion: fetchResult.tag });
  return {
    skipped: false,
    cached: false,
    currentVersion,
    latestVersion: fetchResult.tag,
    source: fetchResult.source,
    hasUpdate: compareVersions(currentVersion, fetchResult.tag) < 0,
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
