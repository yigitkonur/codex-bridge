# XX-update-check-gh-fallback

**Derived from:** `src/lib/update-check.mjs::fetchLatestTag` (two-step resolver in 1.2.7 — direct HTTPS first; `gh api` fallback via `spawnSync` on HTTP 404), `src/lib/update-check.mjs::fetchLatestTagViaGh` (new), `src/codex-bridge.mjs::renderUpdateFailureHint` (diagnostic hint when both paths fail). Addresses the silent-failure mode observed on the 1.2.6 install test: a private repo + no token → `latestVersion: null` + `"check_skipped: false"` + no actionable message.
**What this catches:** (a) When `gh` is authenticated and on `$PATH`, `update` resolves the latest release even without a `GH_TOKEN` env var. (b) When neither path works, `update --force` (non-JSON) prints a multi-line hint naming the failure mode and the fix. (c) `update --force --json` carries `result.source`, `result.fetch_reason`, `result.fetch_status` so scripts can branch on which path the checker took.
**Runtime cost:** fast; no live Codex. All three scenarios exercise the CLI with a controlled environment.

## Feature: `update` falls back to `gh api` on HTTP 404

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

And `npm run build` has been run since the last `src/` edit.

### Scenario 1: gh authenticated + no token → gh-CLI path resolves the latest tag

Given `gh auth status` succeeds (user has an authenticated gh session)
And no `GH_TOKEN` / `GITHUB_TOKEN` is present in the env
When I clear the cache (`rm -f ~/.codex-bridge/update-cache.json`) and run `bridge update --force --json`
Then `.result.has_update` is a boolean (not null)
And `.result.latest_version` is a semver string matching `/^\d+\.\d+\.\d+$/`
And `.result.source` equals `"gh-cli"`
And the exit code is `0`

### Scenario 2: GH_TOKEN present → direct HTTPS path wins; source = http-token

Given `GH_TOKEN` (e.g. `$(gh auth token)`) is set in the env
When I clear the cache and run `bridge update --force --json`
Then `.result.source` equals `"http-token"` (not `"gh-cli"` — direct was attempted first and succeeded)
And `.result.latest_version` matches the tag from scenario 1 (both paths hit the same upstream)

### Scenario 3: no token, gh not on PATH → diagnostic hint instead of silent success

Given a PATH that contains `node` but not `gh` (e.g. a temp directory with a `node` symlink)
And no `GH_TOKEN` / `GITHUB_TOKEN` in the env
When I clear the cache and run `bridge update --force` (non-JSON)
Then stdout contains `Update check failed`
And the output names the failure signature `direct-http-404+gh-not-installed`
And the output suggests either installing gh or exporting `GH_TOKEN`

And when I run the same with `--json`:
- `.result.check_skipped == true`
- `.result.fetch_reason` equals `"direct-http-404+gh-not-installed"`
- `.result.fetch_status` equals `404`
- `.result.has_update == false`
- `.result.latest_version` is `null`

### Scenario 4: public-repo path (no token) — `source: "http-anon"` (regression guard)

Given the canonical anonymous-access test (if the repo were public, or simulated by pointing update-check.mjs at a public repo URL)
When `fetchLatestTagDirect` succeeds with no `Authorization` header
Then `.result.source` equals `"http-anon"`

Note: scenario 4 is a code-path regression guard, not a live test, since the real repo being tested is private. Exercise it by temporarily editing `GITHUB_API_URL` to a public repo for manual verification, or stub `fetch` in a unit test.

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
NODE_BIN=$(which node)
NODE_DIR=$(dirname "$NODE_BIN")
TMPBIN=$(mktemp -d)
ln -sf "$NODE_BIN" "$TMPBIN/node"

bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }

# Scenario 1 — gh fallback
rm -f ~/.codex-bridge/update-cache.json
out=$(env -i HOME=$HOME PATH="$NODE_DIR" node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" update --force --json 2>&1)
echo "$out" | jq -e '.result.source == "gh-cli" and (.result.latest_version | test("^\\d+\\.\\d+\\.\\d+$"))' > /dev/null \
  && echo "s1 PASS" || echo "s1 FAIL ($out)"

# Scenario 2 — GH_TOKEN path
rm -f ~/.codex-bridge/update-cache.json
out=$(GH_TOKEN=$(gh auth token) node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" update --force --json 2>&1)
echo "$out" | jq -e '.result.source == "http-token"' > /dev/null \
  && echo "s2 PASS" || echo "s2 FAIL ($out)"

# Scenario 3 — no token, no gh → diagnostic hint
rm -f ~/.codex-bridge/update-cache.json
out=$(env -i HOME=$HOME PATH="$TMPBIN" "$TMPBIN/node" "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" update --force 2>&1)
echo "$out" | grep -q "Update check failed" \
  && echo "$out" | grep -q "direct-http-404+gh-not-installed" \
  && echo "s3 PASS" || echo "s3 FAIL ($out)"

rm -f ~/.codex-bridge/update-cache.json
out=$(env -i HOME=$HOME PATH="$TMPBIN" "$TMPBIN/node" "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" update --force --json 2>&1)
echo "$out" | jq -e '.result.fetch_reason == "direct-http-404+gh-not-installed" and .result.fetch_status == 404' > /dev/null \
  && echo "s3-json PASS" || echo "s3-json FAIL ($out)"

rm -rf "$TMPBIN"
```

### Enhancement candidates

- Cache the `source` field too, so callers can see whether a cached result came from an authenticated or anonymous path.
- If the gh fallback is used repeatedly (i.e. the user doesn't have a token and relies on `gh`), consider emitting a one-time suggestion to set `GH_TOKEN` to avoid the spawn cost on every check.
- A bolt-on that polls the GitHub API directly from the release CI (when the repo goes public or a public mirror is added) would eliminate the fallback need entirely.
