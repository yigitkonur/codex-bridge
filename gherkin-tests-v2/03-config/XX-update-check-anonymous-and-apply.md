# XX-update-check-anonymous-and-apply

**Derived from:** `src/lib/update-check.mjs::fetchLatestTag` (1.2.8 — collapsed to a single anonymous HTTPS call; no token header, no gh-CLI fallback), `src/codex-bridge.mjs::handleUpdate` (1.2.8 — `--apply` / `--yes` flag that spawns `npx -y skills@latest add …` when newer version exists), `src/codex-bridge.mjs::runSkillsAddForApply` (the spawnSync wrapper), `src/codex-bridge.mjs::renderUpdateFailureHint` (simplified to cover network/403/404-propagation-lag). The repo is public as of 1.2.8, which is why the 1.2.7 gh-CLI fallback could be removed.
**What this catches:** (a) Anonymous HTTPS resolves the latest release for every caller (no token required). (b) `--apply` on a current install is a no-op that echoes `applied: false` back without invoking `npx`. (c) `--apply` synopsis advertised. (d) Removed paths (gh-fallback, token-reading, `source` field) no longer appear in the code or the envelope.
**Runtime cost:** scenarios 1–3 are fast and hit live api.github.com (once; 24 h cache). Scenario 4 (real install via npx) is slow and writes to `~/.claude/skills/codex-bridge/` — SKIPPED by default.

## Feature: update-check is anonymous-only; --apply does real auto-install

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

And `npm run build` has been run since the last `src/` edit.

### Scenario 1: anonymous detection works with no token, no gh on PATH

Given no `GH_TOKEN` / `GITHUB_TOKEN` is present in the env
And `gh` is not required on `$PATH`
When I clear the cache (`rm -f ~/.codex-bridge/update-cache.json`) and run `bridge update --force --json` under `env -i HOME=$HOME PATH=<node-bin-dir-only>`
Then `.result.latest_version` is a semver string matching `/^\d+\.\d+\.\d+$/`
And `.result.current_version` matches `package.json.version`
And `.result.has_update` is a boolean
And the exit code is `0`

Crucially: `.result.source` is **not present** (removed in 1.2.8) and the envelope has no `authHeader` signaling.

### Scenario 2: `--apply` on an up-to-date install is a no-op

Given the installed version equals the latest upstream release
When I run `bridge update --apply --force --json`
Then `.result.has_update == false`
And `.result.applied == false` (echoed-back intent — no install was triggered)
And `npx` was NOT spawned (verifiable via `pgrep -f 'npx.*skills'` before and after)
And the exit code is `0`

### Scenario 3: synopsis advertises `--apply` and `--yes`

Given I run `bridge update --help | head -1`
Then the output contains `[--apply|--yes]`

### Scenario 4: `--apply` on an outdated install actually installs (requires live network + writes to ~/.claude)

**SKIPPED in default runs** — touches the user's installed skill directory.

Given the installed bridge is older than the latest upstream release (e.g. temporarily downgrade: `npx skills@latest add yigitkonur/codex-bridge#v1.2.5 …`)
When I run `bridge update --apply --force`
Then `npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y` is spawned and runs to exit 0
And a follow-up `bridge version --json` reports the upstream `latest_version`
And the rendered output says "Installed codex-bridge <new> (was <old>). Re-invoke the skill to pick up the new files."

### Scenario 5: `--apply` installer failure surfaces as a class-dependency_failed envelope

Given a broken npx on PATH (e.g. a shim that exits 1)
When I run `bridge update --apply --force --json`
Then the envelope has `ok: false`
And `.error.class == "dependency_failed"`
And `.error.code == "UPDATE_APPLY_FAILED"`
And `.error.retryable == true`
And `.error.suggestion` contains the manual install command
And the exit code is `7` (transient)

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
NODE_DIR=$(dirname $(which node))

# Scenario 1 — anonymous
rm -f ~/.codex-bridge/update-cache.json
out=$(env -i HOME=$HOME PATH="$NODE_DIR" node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" update --force --json 2>&1)
echo "$out" | jq -e '.result.latest_version | test("^\\d+\\.\\d+\\.\\d+$")' > /dev/null \
  && echo "s1 PASS" || echo "s1 FAIL ($out)"

# Scenario 2 — --apply no-op on current
rm -f ~/.codex-bridge/update-cache.json
out=$(bridge update --apply --force --json 2>&1)
echo "$out" | jq -e '.result.has_update == false and .result.applied == false' > /dev/null \
  && echo "s2 PASS" || echo "s2 FAIL ($out)"

# Scenario 3 — synopsis
bridge update --help | head -1 | grep -q -- "--apply" \
  && echo "s3 PASS" || echo "s3 FAIL"

# Scenarios 4, 5 — live install / failure injection, SKIPPED in default runs
```

### Enhancement candidates

- `--apply --dry-run` that logs the command it would run without actually running it.
- `--apply` could pin to a specific tag (`--apply v1.3.0`) so users can roll forward or back to a known version instead of always tracking latest.
- Retention of the installer stderr tail: currently only the last 3 lines on failure. If users report noise or need more context, bump to 10 or make it configurable.
