# 02-events-follow-prefix-aware-filter

**Derived from:** `src/codex-bridge.mjs:1857-1876` (`tagOf` splits on `:` and uppercases; `filter` matches head-only against a Set — so `--filter PIPELINE` covers every `PIPELINE:*` subtype), `src/codex-bridge.mjs:1878` (`TERMINAL = /^\[(DONE|ERROR|INCOMPLETE)\]/` used for `--follow` self-termination independent of `--filter`), `src/codex-bridge.mjs:1880-1895` (initial dump sets `alreadyTerminal`; `--follow && alreadyTerminal` short-circuits), `skill/SKILL.md` ("Streaming events with filters" section).
**What this catches:** A regression that turns `--filter` into substring matching would make `PIPELINE` spuriously match any line whose payload mentions the word, flooding consumer pipelines. A regression in `--follow`'s short-circuit would cause consumers that attach *after* `[DONE]` has already been appended to hang until `--timeout-ms`. The three scenarios pin both the head-only semantic and the independence between `--filter` and the self-termination rule.
**Runtime cost:** fast (reads an already-written events file; no new Codex turns)
**Test subject:** a completed task whose `.events` already contains, in order, `[PIPELINE:diff]`, `[PIPELINE:review]`, `[PIPELINE:check]`, and `[DONE]` — produced by an earlier execute turn in the same session

## Feature: prefix-aware `--filter` and `--follow` self-termination

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

Given `npm run build` has been run since the last `src/` edit

**Scenarios 1 and 2 require** a previously-completed task `<id>` in this session whose events file `$EVENTS` contains these lines in order: `[PIPELINE:diff] …`, `[PIPELINE:review] …`, `[PIPELINE:check] …`, `[DONE] …`. This comes from running a live task; mark those scenarios "requires live task" and skip them in fast CI.

**Error-path smoke (fast, no Codex needed):** passing a nonexistent job id exits 3 with `error.code == "JOB_NOT_FOUND"` — verified by smoke test (see below).

### Scenario: `--filter PIPELINE` matches every PIPELINE:* subtype and `--follow` self-terminates on pre-existing `[DONE]`

**Requires live Codex task — runtime cost: fast once the events file exists. Skip if no prior task.**

When I run `bridge events <id> --follow --filter PIPELINE --timeout-ms 5000 --json`
Then stdout's non-envelope lines are exactly the three `[PIPELINE:*]` lines from `$EVENTS`, in order
And `[DONE]` is NOT in stdout's non-envelope lines (it did not pass the filter)
And the command exits before `--timeout-ms` elapses (observed wall-clock < 2 s)
And the trailing envelope reports `ok == true`, `result.followed == true`, `result.timedOut == false`, `result.filter == "PIPELINE"`

### Scenario: explicit terminal-tag filter also self-terminates and prints `[DONE]`

**Requires live Codex task — runtime cost: fast once the events file exists. Skip if no prior task.**

When I run `bridge events <id> --follow --filter DONE,ERROR,INCOMPLETE,PLAN,QUESTION --timeout-ms 5000 --json`
Then stdout contains exactly one `[DONE]` line and no `[PIPELINE:*]` lines
And the trailing envelope reports `ok == true`, `result.followed == true`, `result.timedOut == false`

### Scenario: unknown filter with no `--follow` returns cleanly with empty stdout

**Requires live Codex task — runtime cost: fast once the events file exists. Skip if no prior task.**

When I run `bridge events <id> --filter NONEXISTENT_TAG --json`
Then the only stdout output is the JSON envelope itself
And the envelope reports `ok == true`, `result.followed == false`, `result.timedOut == false`, `result.filter == "NONEXISTENT_TAG"`

### Scenario (error path, fast): nonexistent job id returns `JOB_NOT_FOUND`, exit 3

When I run `bridge events 00000000-0000-0000-0000-000000000000 --filter DONE --json`
Then the process exits 3
And stdout is a single JSON envelope with `ok == false`, `error.class == "not_found"`, `error.code == "JOB_NOT_FOUND"`

**Smoke result (verified):** exit 3, `{"ok":false,"error":{"class":"not_found","code":"JOB_NOT_FOUND",...}}`

### Pass / fail predicate

```sh
# Error-path scenario (fast, no live task needed)
bridge events 00000000-0000-0000-0000-000000000000 --filter DONE --json; rc=$?
test "$rc" = 3 && bridge events 00000000-0000-0000-0000-000000000000 --filter DONE --json \
  | jq -e '.ok==false and .error.class=="not_found" and .error.code=="JOB_NOT_FOUND"'

# Scenario 1 (requires live task — set ID and EVENTS to a completed task's values)
out1=$(bridge events "$ID" --follow --filter PIPELINE --timeout-ms 5000 --json)
test "$(printf '%s\n' "$out1" | grep -c '^\[PIPELINE:')" = 3 \
  && ! printf '%s\n' "$out1" | grep -q '^\[DONE\]' \
  && printf '%s\n' "$out1" | tail -n1 | jq -e '.ok==true and .result.followed==true and .result.timedOut==false and .result.filter=="PIPELINE"'

# Scenario 2 (requires live task)
out2=$(bridge events "$ID" --follow --filter DONE,ERROR,INCOMPLETE,PLAN,QUESTION --timeout-ms 5000 --json)
test "$(printf '%s\n' "$out2" | grep -c '^\[DONE\]')" = 1 \
  && ! printf '%s\n' "$out2" | grep -q '^\[PIPELINE:' \
  && printf '%s\n' "$out2" | tail -n1 | jq -e '.result.followed==true and .result.timedOut==false'

# Scenario 3 (requires live task)
out3=$(bridge events "$ID" --filter NONEXISTENT_TAG --json)
test "$(printf '%s\n' "$out3" | wc -l)" = 1 \
  && printf '%s\n' "$out3" | jq -e '.result.followed==false and .result.timedOut==false'
```

### Enhancement candidates

A future skill fix could extend filter grammar to include subtype matching (`PIPELINE:review` only) — at that point this spec becomes the contract for head-vs-subtype disambiguation. Another natural enhancement is streaming JSON lines instead of raw events when `--json` is combined with `--follow`; the current behavior (raw lines + trailing envelope) is intentional and this spec locks it in, so a switch to per-line JSON would require an explicit version bump. Catches regressions where a maintainer "simplifies" `tagOf` into `line.startsWith("[" + filter)` and accidentally makes `--filter DONE` also match `[DONE-SOMETHING]` (scenario 2 catches the count drift).
