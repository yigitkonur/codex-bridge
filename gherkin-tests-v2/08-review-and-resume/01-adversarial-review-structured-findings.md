# 01-adversarial-review-structured-findings

**Derived from:** `src/codex-bridge.mjs:691-707` (`validateNativeReviewRequest`: rejects focus text with `REVIEW_FOCUS_UNSUPPORTED`, suggests `adversarial-review`), `src/codex-bridge.mjs:322` (handler registry entry for `adversarial-review`), `src/schemas/review-output.schema.json` (structured-finding schema the adversarial prompt is bound to), `src/prompts/adversarial-review.md` (the prompt that enforces the schema), `skill/SKILL.md` "Adversarial review" section.
**What this catches:** The schema contract — if `findings[]` ever loses `severity`, `file`, `line_start`, `line_end`, or `recommendation`, every downstream consumer (Claude summarising, CI filters, issue-creation hooks) breaks. Also pins the command split: `review` is the built-in reviewer and must not accept focus text; `adversarial-review` is the prompt-steerable one. A regression that lets `review` silently accept focus text would blur the two commands and break agent routing in SKILL.md. Third, pins that `--scope branch --base main` is a valid, documented invocation path.
**Runtime cost:** slow (one real Codex review turn, 1–3 min)
**Test subject:** `$TMPDIR/html-site` git repo containing a small JS file with a deliberate SQL-injection-style bug in the current working tree (uncommitted), plus a separate branch where the buggy file is committed on top of `main`

## Feature: `adversarial-review` returns schema-valid findings; `review` refuses focus text

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

Given Codex CLI is installed on `$PATH` and authenticated
And `bridge()` is defined as above (targets the repo's own bundle, not the globally-installed copy)
And `cwd = $TMPDIR/html-site` has a working-tree diff adding a JS route that interpolates `req.query.id` directly into a SQL string (unparameterised)
And a feature branch off `main` contains that same file committed on top
And `SCHEMA = ${REPO_ROOT}/src/schemas/review-output.schema.json`

### Scenario: adversarial-review on working tree returns schema-valid findings including one high/critical about SQL injection

When I run `bridge adversarial-review --scope working-tree --json "focus on SQL injection"`
Then stdout is a single envelope with `ok == true`
And `result.findings` is a JSON array of length ≥ 1
And every element has string keys `severity`, `title`, `body`, `file`, `line_start`, `line_end`, `confidence`, `recommendation` (all required by `review-output.schema.json`)
And each `severity` is one of `"critical" | "high" | "medium" | "low"`
And `line_start` ≤ `line_end` and both are positive integers ≥ 1
And `confidence` is a number in [0, 1]
And at least one finding has `severity ∈ {critical, high}` and `file` referencing the buggy JS file

### Scenario: `review` rejects focus text with REVIEW_FOCUS_UNSUPPORTED (exit 6)

When I run `bridge review --scope working-tree --json "focus on SQL injection"`
Then the process exits 6
And stdout is a single envelope with `ok == false`
And `error.class == "validation"` and `error.code == "REVIEW_FOCUS_UNSUPPORTED"`
And `error.suggestion` mentions `adversarial-review`

### Scenario: adversarial-review with `--scope branch --base main` returns the same envelope shape

When I run `bridge adversarial-review --scope branch --base main --json`
Then stdout is a single envelope with `ok == true`
And `result.findings` is an array (possibly empty if Codex judges the committed diff clean)
And if non-empty, every element still validates against `${REPO_ROOT}/src/schemas/review-output.schema.json`

### Pass / fail predicate

```sh
# Setup
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }

# Scenario 1 — structured findings + the expected severity
# All 8 required Finding fields from review-output.schema.json are asserted.
bridge adversarial-review --scope working-tree --json "focus on SQL injection" \
  | jq -e '.ok==true
           and (.result.findings | length >= 1)
           and (.result.findings | all(
                  has("severity") and has("title") and has("body")
                  and has("file") and has("line_start") and has("line_end")
                  and has("confidence") and has("recommendation")
                  and (.severity | IN("critical","high","medium","low"))
                  and (.line_start | type == "number") and (.line_end | type == "number")
                  and .line_start <= .line_end and .line_start >= 1
                  and (.confidence | type == "number") and .confidence >= 0 and .confidence <= 1))
           and (.result.findings | any(.severity == "critical" or .severity == "high"))'

# Scenario 2 — focus-text rejected (smoke-runnable; does NOT require a live Codex session)
set +e
bridge review --scope working-tree --json "focus on SQL injection" > /tmp/08-01-s2.json 2>&1; rc=$?
test "$rc" = 6 || { echo "FAIL: expected exit 6, got $rc"; cat /tmp/08-01-s2.json; }
jq -e '.ok==false
       and .error.class=="validation"
       and .error.code=="REVIEW_FOCUS_UNSUPPORTED"
       and (.error.suggestion | test("adversarial-review"))' /tmp/08-01-s2.json

# Scenario 3 — branch scope still schema-valid
bridge adversarial-review --scope branch --base main --json \
  | jq -e '.ok==true
           and (.result.findings | type == "array")
           and (.result.findings | all(
                  has("severity") and has("title") and has("body")
                  and has("file") and has("line_start") and has("line_end")
                  and has("confidence") and has("recommendation")))'

# Schema field verification (no Codex run needed)
jq -e '.properties.findings.items.properties
       | has("severity") and has("title") and has("body")
         and has("file") and has("line_start") and has("line_end")
         and has("confidence") and has("recommendation")' \
  "${REPO_ROOT}/src/schemas/review-output.schema.json" && echo "schema OK"
```

### Enhancement candidates

A near-future fix is to validate `result.findings` against `src/schemas/review-output.schema.json` inside `handleReviewCommand` itself (the prompt is load-bearing but the CLI is the last line of defence). When that lands, scenario 1's manual jq assertions become redundant with runtime validation — the spec can relax to `ok == true` plus a single `ajv validate` call. A second enhancement: extend the contract so `review` (non-adversarial) accepts a narrowly-typed `--focus <enum>` without re-enabling free-form focus text; scenario 2 would gain a variant that accepts `--focus security` and rejects `--focus "SQL injection"`. The spec's three scenarios map cleanly onto that refactor.
