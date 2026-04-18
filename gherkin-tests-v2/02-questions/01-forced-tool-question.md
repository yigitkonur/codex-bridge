# 01-forced-tool-question

**Derived from:** `src/lib/pending-requests.mjs:20` (`writePendingRequest`), `src/lib/pending-requests.mjs:57` (`clearPendingRequest`), `src/lib/pending-requests.mjs:88` (`waitForResponse` — 500 ms poll, 5-min default timeout), `src/codex-bridge.mjs:1317` (`onServerRequest` assignment), `src/codex-bridge.mjs:1322` (`item/tool/requestUserInput` branch), `src/codex-bridge.mjs:1338` (`formatQuestionEvent` call), `src/lib/session-log.mjs` (`formatQuestionEvent`, `formatConfirmedEvent`), `skill/references/notification-format.md` (`[QUESTION]` / `[CONFIRMED]` tag shapes).
**What this catches:** The full happy path of Codex's forced `requestUserInput` tool — from the worker writing `{tid}.pending.json` before blocking, to `respond` unblocking via disk handoff, to the event log's `[QUESTION]`/`[CONFIRMED]` pair with matching request ids, to `clearPendingRequest` deleting the pending file. A regression in any of those steps (worker not writing the file, `respond` not finding it, poller not picking up the response, missing cleanup) produces a different failing assertion, making this the primary integration test for the ask/answer bridge.
**Runtime cost:** medium (one async task + one response round-trip; 30–90 s depending on how quickly Codex escalates to `requestUserInput`)
**Test subject:** single-page HTML site with hero, feature list, and footer

## Feature: `requestUserInput` tool question is surfaced, answered, and cleared

### Background

Given Codex CLI installed and authenticated
And the following is defined in the test shell:
  ```sh
  REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
  bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
  ```
And `npm run build` has been run since the last `src/` edit
And resolved config has the **default** `prompt_footer` (instructs Codex to use `requestUserInput`), `allow_questions: true`, `mode: default`, `auto_review: false`
And `cwd = $TMPDIR/html-site` is a clean git repo

### Scenario: question round-trip via on-disk pending/response files

Given the workspace above
When I run `bridge task --write --json --async "build a one-page HTML site, ask me which color palette you should use before writing CSS"`
Then the envelope returns `ok == true` with `result.phase == "running"` and `result.job_id` set
And I capture `$TID = result.thread_id`

When I run `bridge wait $JOB --timeout-ms 300000 --json` concurrently and poll `{TID}.events`
Then within 5 minutes `{TID}.events` contains a line matching `^\[QUESTION\] [0-9a-f-]{8,} req-[A-Za-z0-9]+`
And that line's body contains at least two option markers in the shape `(a) …` / `(b) …`
And `{TID}.pending.json` exists on disk while the turn is paused
And `{TID}.pending.json` parses as JSON with `requestId` matching the `req-…` id in the `[QUESTION]` line

When I run `bridge respond <req-id> --question-id Q1 --answer "dark" --json`
Then the envelope returns `ok == true` with `result.status == "responded"`
And within ~1 s (poll interval 500 ms) `{TID}.events` gains a line matching `^\[CONFIRMED\] [0-9a-f-]{8,} req-[A-Za-z0-9]+ \| codex resumed`
And the `req-…` id in the `[CONFIRMED]` line equals the one in the `[QUESTION]` line
And `{TID}.pending.json` no longer exists on disk (deleted by `clearPendingRequest`)

### Pass / fail predicate

```sh
REQ=$(grep -oE 'req-[A-Za-z0-9]+' "$TID.events" | head -n1)
grep -Eq "^\[QUESTION\] $TID $REQ"              "$TID.events" \
  && grep -Eq "^\[CONFIRMED\] $TID $REQ \| codex resumed" "$TID.events" \
  && jq -e '.ok == true and .result.status == "responded"' respond.json \
  && test ! -f "$TID.pending.json"
```

### Enhancement candidates

If a future change makes the worker skip deleting `{tid}.pending.json` on confirm, a second question on the same thread would read stale data and reply against the wrong `requestId` — this spec fails at the `test ! -f` step and points at `clearPendingRequest`. It also catches the symmetric regression where `respond` writes `{tid}.response.json` but the worker's 500 ms poller never picks it up (envelope says `responded` but `[CONFIRMED]` never shows up). A natural improvement the failure would motivate: include a monotonic `pending_seq` in the filename so stale files can't be mistaken for fresh ones even if cleanup races a new question.
