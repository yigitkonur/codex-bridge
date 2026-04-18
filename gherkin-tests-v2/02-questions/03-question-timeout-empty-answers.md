# 03-question-timeout-empty-answers

**Derived from:** `src/lib/pending-requests.mjs:4-5` (`POLL_INTERVAL_MS = 500`, `DEFAULT_QUESTION_TIMEOUT_MS = 300_000`), `src/lib/pending-requests.mjs:88` (`waitForResponse` function signature), `src/lib/pending-requests.mjs:101-103` (timeout branch: `Date.now() >= deadline` → `resolve(null)`), `src/codex-bridge.mjs:1355-1359` (timeout handler: sends `{ answers: {} }`, emits `QUESTION_TIMEOUT` to ndjson), `skill/references/notification-format.md`.
**What this catches:** After `[QUESTION]` is emitted, if no `{tid}.response.json` arrives within 5 minutes, the worker must deliver `{answers: {}}` to Codex and log `tag:"QUESTION_TIMEOUT"` to `.ndjson` — it must **not** hang forever, and it must **not** raise an error that fails the turn. If the poll loop ever regresses to wait indefinitely, the timeout assertion never fires and the scenario hangs (failing the outer test harness). If a future change makes timeout a hard failure instead of a soft empty-answer, the `phase` assertion flips. Both behaviors are load-bearing for scripted callers that launch async tasks and don't reliably call `respond`.
**Runtime cost:** slow (waits the full ~5 min question timeout by design; 5–8 min including Codex's resume turn)
**Test subject:** single-page HTML site with hero, feature list, and footer (any prompt that provokes a question works)

## Feature: question timeout delivers empty answers and continues the turn

### Background

Given Codex CLI installed and authenticated
And the following is defined in the test shell:
  ```sh
  REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
  bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
  ```
And `npm run build` has been run since the last `src/` edit
And resolved config uses the default `prompt_footer` (forces `requestUserInput`), `allow_questions: true`, `mode: default`, `auto_review: false`
And `cwd = $TMPDIR/html-site` is a clean git repo

### Scenario: no `respond` arrives — worker times out with empty answers, turn completes

Given the workspace above
When I run `bridge task --write --json --async "build a one-page HTML site, ask me which color palette you should use before writing CSS"`
Then the envelope returns `ok == true`, `result.phase == "running"`, and `result.job_id` set
And I capture `$TID = result.thread_id`, `$JOB = result.job_id`

When I wait without ever calling `bridge respond`
And I poll `{TID}.events` until a `[QUESTION] <TID> req-…` line appears (typically within ~60 s)
And I continue waiting at least 330 s (timeout ≈ 300 s + margin) from the `[QUESTION]` line's appearance
Then `{TID}.ndjson` contains at least one row with `tag == "QUESTION_TIMEOUT"` whose `data.requestId` equals the `req-…` id from the `[QUESTION]` line
And `{TID}.events` does **not** necessarily contain a `[CONFIRMED]` line for that req-id (the worker delivered `{}` internally rather than emitting a confirm)
And `{TID}.pending.json` is absent after the timeout (worker cleaned it up on its own exit path)

When I then run `bridge wait $JOB --timeout-ms 600000 --json`
Then the envelope returns `ok == true`
And `result.phase` is one of `"done"` or `"incomplete"` (the turn continued with empty answers, did not error)

### Pass / fail predicate

```sh
REQ=$(grep -oE 'req-[A-Za-z0-9]+' "$TID.events" | head -n1)
jq -se --arg req "$REQ" \
  'map(select(.tag == "QUESTION_TIMEOUT" and .data.requestId == $req)) | length >= 1' \
  "$TID.ndjson" \
  && test ! -f "$TID.pending.json" \
  && jq -e '.ok == true and (.result.phase | IN("done","incomplete"))' wait.json
```

### Enhancement candidates

If the poll loop in `waitForResponse` ever regresses to wait indefinitely on a missing response file, the outer harness's own deadline trips before `QUESTION_TIMEOUT` can be observed — failure mode is "scenario hangs" rather than "assertion fails", so CI should cap this scenario's wall-clock at ~10 min. The spec also documents a slightly surprising behavior: after timeout the turn **continues** (with empty answers) rather than failing with an error. A future behavior flip to "timeout = hard failure" would be caught by the `phase ∈ {done, incomplete}` assertion, and at that point maintainers can decide whether to update the spec or add a config flag like `question_timeout_policy: continue | fail`.
