# 03-review-empty-diff

**Derived from:** `src/codex-bridge.mjs:797-809` (`review` pre-flight: `git diff --quiet` + `git diff --cached --quiet` probe in `runBridgeTask`, throws `REVIEW_EMPTY_DIFF` when both exit 0), `src/lib/cli-errors.mjs:18-30` (`validation` class → exit 6), `src/lib/git.mjs` (`collectReviewContext`), `SKILL.md` "Review" section.
**What this catches:** Regressions in the pre-review diff probe. The guard exists so `--scope working-tree` (and `--scope auto` when it falls through to working-tree) never pays for a Codex review turn on an empty working tree. If the probe is inverted, skipped, or if `--scope auto` changes its fallback heuristic, this scenario surfaces it. Also pins that the error is emitted before a review turn is spawned — no `.events` / `.ndjson` are created for the never-launched turn.
**Runtime cost:** fast (scenario 1 is a pure validator check; scenario 2 would spawn a real review turn — mark `slow` / Codex-required if ever enabled in CI).
**Test subject:** a freshly-initialised git repository with no working-tree changes.

## Feature: `review` refuses empty working trees, accepts non-empty ones

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

And `npm run build` has been run since the last `src/` edit
And `$FIXTURE` is an ephemeral git repository: `FIXTURE=$(mktemp -d) && cd "$FIXTURE" && git init -q && git commit --allow-empty -m init -q`
And `git -C "$FIXTURE" diff --quiet` exits `0`
And `git -C "$FIXTURE" diff --cached --quiet` exits `0` (no staged changes)

### Scenario: working tree is clean — review refuses to run

Given no files have been modified in `$FIXTURE`
When I run `bridge review --scope working-tree --json` with `cwd=$FIXTURE`
Then the envelope has `ok: false`
And `.error.code` equals `"REVIEW_EMPTY_DIFF"`
And `.error.class` equals `"validation"`
And `.error.retryable` equals `false`
And `.error.suggestion` mentions `--scope branch` as the alternative
And the exit code is `6`
And no session artifacts are created (no `*.events`, `*.ndjson`, `*.diff`, `*.review.json` for any thread id from this invocation)

### Scenario: one-line edit — review runs (control case; requires Codex auth)

Given I append a single line to `$FIXTURE/index.html`
And `git -C "$FIXTURE" diff --quiet` now exits non-zero
When I run `bridge review --scope working-tree --json` with `cwd=$FIXTURE`
Then the envelope has `ok: true`
And a review turn executed against the working-tree diff
And session artifacts (`{THREAD}.events`, `{THREAD}.ndjson`) now exist in the configured session dir

Note: scenario 2 requires a live Codex install and authentication. Mark it `slow` in a runner. Do not smoke it in isolation.

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }

# Scenario 1 — smokeable without Codex
FIXTURE=$(mktemp -d)
cd "$FIXTURE"
git init -q && git commit --allow-empty -m init -q
bridge review --scope working-tree --json > /tmp/03.json 2>&1; rc=$?
jq -e '.ok == false and .error.code == "REVIEW_EMPTY_DIFF" and .error.class == "validation"' /tmp/03.json \
  && test $rc -eq 6 \
  && echo "03 PASS" || echo "03 FAIL"
cd -
rm -rf "$FIXTURE"
```

**Smoke result (2026-04-18):** Scenario 1 PASS. exit 6, `REVIEW_EMPTY_DIFF`. Actual suggestion text: `"Make a change (working tree or staged) before invoking \`review\`, or use --scope branch to review a branch vs base."`. Scenario 2 SKIPPED (requires live Codex).

### Enhancement candidates

- If `--scope auto` is taught to fall back to `branch` mode when the working tree is empty, scenario 1 must be re-scoped to `--scope working-tree` explicitly (and a new scenario added for the auto-fallback path).
- `adversarial-review` shares the same guard via the same `runBridgeTask` path; a sibling scenario in `04-errors/` should cover that surface once added.
- A future "review pending commits on upstream" mode may need its own empty-check; the test pins the current guard so any refactor is deliberate.
