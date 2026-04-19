# XX-version-source-of-truth

**Derived from:** `src/codex-bridge.mjs` top-of-file `import packageJson from "../package.json" with { type: "json" }` (bundled via esbuild); `const BRIDGE_VERSION = packageJson.version` replaces the pre-1.2.5 hard-coded `"1.2.3"` string literal that drifted away from `package.json`.
**What this catches:** (a) `bridge version --json` reports the version embedded by esbuild at build time, which must equal `package.json.version`. (b) `skill/SKILL.md`'s `version:` frontmatter matches package.json. (c) Legacy doc strings referencing "120 s watchdog" have been scrubbed from the three canonical sites (`SKILL.md:77`, `skill/references/monitor-patterns.md`, `skill/references/error-recovery.md`).
**Runtime cost:** fast; no Codex needed.

## Feature: single source of truth for the bridge version

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

And `npm run build` has been run since the last `src/` or `package.json` edit.

### Scenario 1: CLI reports package.json's version

Given `package.json`'s `.version` field is a valid semver string
When I run `bridge version --json` and compare to `node -e "console.log(require('./package.json').version)"`
Then the two values are equal
And the exit code is `0`

### Scenario 2: SKILL.md frontmatter matches package.json

Given `skill/SKILL.md` carries a `metadata.version` YAML frontmatter key
When I extract it (`awk '/metadata:/,/---/' skill/SKILL.md | grep 'version:'`) and compare to `package.json.version`
Then the two values are equal
And the `version --json` result above also matches

### Scenario 3: legacy 120s strings are gone

Given the 1.2.4 release changed the idle-watchdog default to 300s and made it configurable
When I grep SKILL.md and references/ for `"120 s"` / `"120s"` / `"120_000"` / `"2 minutes.*idle"`
Then no matches are found in:
- `skill/SKILL.md`
- `skill/references/monitor-patterns.md`
- `skill/references/error-recovery.md`

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }

pkg_v=$(node -e "console.log(require('${REPO_ROOT}/package.json').version)")
cli_v=$(bridge version --json 2>/dev/null | jq -r '.result.version')
test "$pkg_v" = "$cli_v" && echo "S1 PASS" || echo "S1 FAIL (pkg=$pkg_v cli=$cli_v)"

skill_v=$(awk '/^metadata:/{f=1;next} f && /version:/{gsub(/[" ]/,"",$2); print $2; exit}' "${REPO_ROOT}/skill/SKILL.md")
test "$pkg_v" = "$skill_v" && echo "S2 PASS" || echo "S2 FAIL (pkg=$pkg_v skill=$skill_v)"

! grep -Eqs '120 ?s idle|120_000|2 minutes.*idle' \
  "${REPO_ROOT}/skill/SKILL.md" \
  "${REPO_ROOT}/skill/references/monitor-patterns.md" \
  "${REPO_ROOT}/skill/references/error-recovery.md" \
  && echo "S3 PASS" || echo "S3 FAIL"
```

### Enhancement candidates

- Add the same check to the npm prepublish step so version drift can't ship.
- If SKILL.md ever moves its frontmatter version to a different key, update the awk snippet accordingly.
