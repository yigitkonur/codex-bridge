// Lightweight "is there a newer release on GitHub?" probe.
//
// Goals:
//   - Silent failure. Never block the caller, never throw. A network hiccup
//     or a rate-limit hit just means "no update info this time."
//   - Cheap. One HTTPS call per 24 h per workspace (cache file). The GitHub
//     REST API allows 60 requests/hour/IP unauthenticated — well under that
//     budget since the cache holds for 24 h.
//   - Zero-dependency. Node 22+ has fetch built in; no axios, no node-fetch.
//   - Anonymous. codex-bridge is a public repo; unauthenticated `/releases/
//     latest` returns the data we need, and staying anonymous keeps the
//     bridge from burning the user's authenticated rate-limit budget
//     (5000/hr per user) on something that doesn't need it. The gh-CLI
//     fallback and GITHUB_TOKEN / GH_TOKEN reading that 1.2.7 added for
//     the private-repo case are gone — the repo went public in 1.2.8 and
//     those paths can no longer fire.
//
// Returns a plain object so callers can render whatever they want:
//   { skipped: boolean, reason?: string, currentVersion, latestVersion?, hasUpdate?, cacheAgeMs? }

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 1 hour cache — aligns with the auto-apply rate-limit window so a freshly
// released version lands on user installs within ~60 min of publication.
// Previously 24 h, which was fine for detection-only UX but too slow for
// the 1.2.9 hot-path auto-apply (users would wait up to a day after a fix
// shipped before their install caught up).
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 h
const DEFAULT_FETCH_TIMEOUT_MS = 2500;
export const APPLY_ATTEMPT_WINDOW_MS = 60 * 60 * 1000; // 1 h
const GITHUB_API_URL = "https://api.github.com/repos/yigitkonur/codex-bridge/releases/latest";
const USER_AGENT = "codex-bridge-update-check";

function cachePath() {
  // Prefer the bridge-scoped variable that the SessionStart hook
  // (hooks/session-lifecycle-hook.mjs) exports so plugin-managed
  // installs land their update cache alongside their state. Fall
  // back to the generic CLAUDE_PLUGIN_DATA, then to a $HOME slug.
  const pluginDataDir =
    process.env.CODEX_BRIDGE_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  const root = pluginDataDir
    ? path.join(pluginDataDir, "codex-bridge-update.json")
    : path.join(os.homedir(), ".codex-bridge", "update-cache.json");
  return root;
}

function readCache() {
  try {
    const raw = fs.readFileSync(cachePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed == null) return null;
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
    return true;
  } catch {
    // Silent — cache write failure must never propagate.
    return false;
  }
}

function hasReleaseCache(cache) {
  return (
    cache &&
    typeof cache.checkedAt === "number" &&
    typeof cache.latestVersion === "string"
  );
}

function cacheLockPath() {
  return `${cachePath()}.lock`;
}

function removeStaleLock(lockPath, staleMs) {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs <= staleMs) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch (err) {
    return err?.code === "ENOENT";
  }
}

function acquireCacheLock(staleMs) {
  const lockPath = cacheLockPath();
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    return null;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      } catch {
        // The exclusive file itself is the lock; metadata is best-effort.
      }
      return { fd, lockPath };
    } catch (err) {
      if (err?.code !== "EEXIST") return null;
      if (!removeStaleLock(lockPath, staleMs)) return null;
    }
  }

  return null;
}

function releaseCacheLock(lock) {
  try {
    fs.closeSync(lock.fd);
  } catch {
    // Best-effort lock cleanup.
  }

  try {
    fs.unlinkSync(lock.lockPath);
  } catch {
    // Best-effort lock cleanup.
  }
}

function hasRecentApplyAttempt(cache, now, windowMs) {
  return (
    cache &&
    typeof cache.lastApplyAttempt === "number" &&
    now - cache.lastApplyAttempt <= windowMs
  );
}

function writeApplyAttemptMarker(targetVersion, attemptedAt, existing = readCache()) {
  const next = {
    ...(existing ?? {}),
    lastApplyAttempt: attemptedAt,
  };

  if (typeof targetVersion === "string") {
    next.lastApplyTargetVersion = targetVersion;
  }

  return writeCache(next);
}

// Atomically claims the hot-path auto-apply slot. Returns `true` only when
// there's been no apply attempt within the window and the in-flight marker was
// written before the caller spawns an installer. The exclusive lock is local to
// this cache path and keeps concurrent bridge invocations from racing a stale
// read against a later write.
export function claimApplyAttempt(targetVersion, windowMs = APPLY_ATTEMPT_WINDOW_MS) {
  const lock = acquireCacheLock(Math.max(windowMs, 60_000));
  if (!lock) return false;

  try {
    const cache = readCache();
    const now = Date.now();
    if (hasRecentApplyAttempt(cache, now, windowMs)) return false;
    return writeApplyAttemptMarker(targetVersion, now, cache);
  } catch {
    return false;
  } finally {
    releaseCacheLock(lock);
  }
}

// Compatibility gate for existing callers. This now claims the slot before
// returning so the legacy `shouldAttemptApply(); markApplyAttempted(...)`
// sequence no longer exposes a read/write race.
export function shouldAttemptApply(windowMs = APPLY_ATTEMPT_WINDOW_MS) {
  return claimApplyAttempt(undefined, windowMs);
}

// Records or refreshes apply-attempt metadata in the cache file. Existing
// callers still use this immediately before spawning so target-version metadata
// is preserved; the actual slot claim happens in `claimApplyAttempt`.
export function markApplyAttempted(targetVersion) {
  const lock = acquireCacheLock(APPLY_ATTEMPT_WINDOW_MS);
  if (!lock) return;

  try {
    writeApplyAttemptMarker(targetVersion, Date.now());
  } catch {
    // Silent.
  } finally {
    releaseCacheLock(lock);
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

// Single anonymous fetch. Returns `{ok:true, tag}` on success or
// `{ok:false, status, reason}` on failure. The caller decides what to
// render for each failure mode.
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
    if (!res.ok) {
      return { ok: false, status: res.status, reason: `http-${res.status}` };
    }
    const json = await res.json();
    if (typeof json?.tag_name !== "string") {
      return { ok: false, status: 200, reason: "bad-payload" };
    }
    return { ok: true, tag: json.tag_name.replace(/^v/i, "") };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return { ok: false, status: 0, reason: aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(t);
  }
}

// The main entry. Returns a plain object; never throws.
//
//   checkForUpdate({ currentVersion, force?, cacheTtlMs?, fetchTimeoutMs? })
//
// `force: true` bypasses the cache (used by `bridge update --force`).
// Otherwise fresh cache hits return immediately.
export async function checkForUpdate({
  currentVersion,
  force = false,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  const cache = readCache();
  const hasCachedRelease = hasReleaseCache(cache);
  const now = Date.now();

  if (!force && hasCachedRelease && now - cache.checkedAt < cacheTtlMs) {
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
      reason: hasCachedRelease ? "fetch-failed-using-stale" : "fetch-failed-no-cache",
      fetchReason: fetchResult.reason,
      fetchStatus: fetchResult.status ?? null,
      currentVersion,
      ...(hasCachedRelease && {
        latestVersion: cache.latestVersion,
        hasUpdate: compareVersions(currentVersion, cache.latestVersion) < 0,
        cacheAgeMs: now - cache.checkedAt,
      }),
    };
  }

  const applyMarkers = {};
  if (cache && Object.prototype.hasOwnProperty.call(cache, "lastApplyAttempt")) {
    applyMarkers.lastApplyAttempt = cache.lastApplyAttempt;
  }
  if (cache && Object.prototype.hasOwnProperty.call(cache, "lastApplyTargetVersion")) {
    applyMarkers.lastApplyTargetVersion = cache.lastApplyTargetVersion;
  }

  writeCache({ checkedAt: now, latestVersion: fetchResult.tag, ...applyMarkers });
  return {
    skipped: false,
    cached: false,
    currentVersion,
    latestVersion: fetchResult.tag,
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
    `Run \`npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y\` to update, ` +
    `or pass --apply to \`codex-bridge update\` to install automatically.`
  );
}
