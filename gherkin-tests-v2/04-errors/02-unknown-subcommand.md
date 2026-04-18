# 02-unknown-subcommand

**Derived from:** `src/codex-bridge.mjs:2488-2495` (handler lookup on `SUBCOMMAND_DISPATCH[subcommand]` + `UNKNOWN_SUBCOMMAND` throw), `src/codex-bridge.mjs:2472-2478` (no-subcommand / help branch: exits 0 with usage text, NOT a JSON envelope), `src/codex-bridge.mjs:2501-2504` (`main().catch` path + json flag detection for structured error emission), `src/lib/cli-errors.mjs:18-30` (`usage` class → exit 2).
**What this catches:** Regressions in the subcommand dispatcher. The lookup is a strict `SUBCOMMAND_DISPATCH[subcommand]` — no fuzzy match, no "did you mean" heuristic. This scenario pins that contract: a typo produces the canonical usage error with exit 2 and no session directory side effects. Also documents that the CLI distinguishes `UNKNOWN_SUBCOMMAND` (wrong name) from per-subcommand `USAGE_ERROR` (right name, wrong args). And pins the no-subcommand exit-0 behavior as a separate, non-JSON path.
**Runtime cost:** fast
**Test subject:** terminal session; no workspace state; no Codex auth required (the error fires before any RPC).

## Feature: reject unknown subcommand names; print help on no subcommand

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

And `npm run build` has been run since the last `src/` edit

### Scenario: obvious-nonsense subcommand

When I run `bridge does-not-exist --json`
Then stdout is a single JSON envelope with `ok: false`
And `.error.code` equals `"UNKNOWN_SUBCOMMAND"`
And `.error.class` equals `"usage"`
And `.error.retryable` equals `false`
And `.error.suggestion` equals `"Run \`help --json\` to list available subcommands."`
And the exit code is `2`

### Scenario: near-miss typo ("tusk" for "task")

When I run `bridge tusk --json`
Then the envelope is identical in shape to the previous scenario
And `.error.code` is still `"UNKNOWN_SUBCOMMAND"` (no "did you mean task" hint — the CLI does not do fuzzy matching)
And the exit code is `2`

### Scenario: no subcommand at all

When I run `bridge` with no arguments
Then the behavior follows the dispatcher's empty-argv short-circuit at `src/codex-bridge.mjs:2472`: `!subcommand` is `true`, so it calls `printUsage()` and returns
And the exit code is `0` (success — help-on-empty is intentional, not an error)
And stdout contains the usage text (beginning with `"Usage:"`)
And no JSON envelope is emitted (the no-subcommand path is NOT structured output, even if `--json` were somehow appended)

Note: this behavior differs from the named-but-unknown subcommand path. A missing subcommand position is a discovery case; a wrong subcommand name is a caller error. The distinction is by design and tested here explicitly.

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }

# Scenarios 1 and 2
bridge does-not-exist --json > /tmp/02a.json; rc1=$?
jq -e '.error.code == "UNKNOWN_SUBCOMMAND" and .error.class == "usage"' /tmp/02a.json \
  && test $rc1 -eq 2 && echo "02a PASS" || echo "02a FAIL"

bridge tusk --json > /tmp/02b.json; rc2=$?
jq -e '.error.code == "UNKNOWN_SUBCOMMAND" and .error.class == "usage"' /tmp/02b.json \
  && test $rc2 -eq 2 && echo "02b PASS" || echo "02b FAIL"

# Scenario 3 — exit 0, plain text usage
bridge > /tmp/02c.txt 2>&1; rc3=$?
test $rc3 -eq 0 && grep -q "^Usage:" /tmp/02c.txt \
  && echo "02c PASS" || echo "02c FAIL"
```

**Smoke result (2026-04-18):** All three scenarios PASS. `does-not-exist --json` → exit 2, `UNKNOWN_SUBCOMMAND`. `tusk --json` → exit 2, `UNKNOWN_SUBCOMMAND`. `bridge` (no args) → exit 0, stdout begins with `"Usage:"`. The no-subcommand path is plain text, not JSON.

### Enhancement candidates

- If "did you mean …?" heuristics are added (Levenshtein over `COMMANDS` keys), scenario 2 must be relaxed to also accept `.error.suggestion` containing the proposed name.
- Protects against a well-meaning refactor that collapses `UNKNOWN_SUBCOMMAND` into a generic `USAGE_ERROR` — tooling parses the specific code to decide whether to re-prompt or re-render the help page.
- If `bridge` with no args ever emits JSON and exits non-zero (treating missing-subcommand as an error), update scenario 3 to add the JSON-envelope contract and remove the exit-0 assertion.
