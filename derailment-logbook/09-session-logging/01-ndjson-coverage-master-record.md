# 09 / 01 — Session logging: NDJSON is not what the docs claim

**Scenarios under test:**
- `Scenario: Every notification type is logged to NDJSON`
- `Scenario Outline: Notifications map to correct NDJSON tags`
- `Scenario: Plan item/completed gets PLAN tag`
- `Scenario: Review events get specific tags`
- `Scenario: Git diff capture gets DIFF tag`
- `Scenario: Client-side timeouts get TIMEOUT tag`
- `Scenario: Generic notifications get NOTIFICATION tag`

---

## [BROKE] Gherkin expects tags the bridge doesn't persist

Correction after reading source: the bridge writes more than the 3 tags I observed on disk (`TURN_COMPLETED`, `PIPELINE_STAGE`, `PIPELINE_ERROR`). The full writer vocabulary is: `TURN_PARAMS`, `TURN_COMPLETED`, `QUESTION`, `CONFIRMED`, `QUESTION_TIMEOUT`, `SERVER_RESPONSE`, `STEER`, `ERROR` (when `will_retry:false`), `PIPELINE_STAGE`, `PIPELINE_COMPLETE`, `PIPELINE_ERROR`.

But Gherkin feature 09 still names: `THREAD_STARTED`, `TURN_STARTED`, `ITEM_STARTED`, `ITEM_COMPLETED`, `PLAN`, `REVIEW_START`, `REVIEW_END`, `DIFF`, `TIMEOUT`, `NOTIFICATION`. None of those are written.

**Impact:**
- `Scenario Outline: Notifications map to correct NDJSON tags` — rows for `thread/started`, `turn/started`, `item/started`, `item/completed` never match. Rows for `turn/completed`, `error`, `item/tool/requestUserInput`, `serverRequest/resolved` do.
- `Scenario: NDJSON supports timeline reconstruction` — "turn boundaries should be identifiable by `TURN_STARTED` tags" is wrong; use `TURN_PARAMS` (fires at `onTurnStart`).
- Scenarios for `REVIEW_START`, `REVIEW_END`, `DIFF`, `TIMEOUT`, `NOTIFICATION` tags never match.

**Fix target:**
1. Docs direction (applied): rewrite `ndjson-guide.md` to list the real writer vocabulary with fields and source pointers.
2. Gherkin direction (not applied here): drop scenarios that name non-existent tags, or replace them with the real tag names.

---

## [NICE] Malformed NDJSON lines are skipped during `summary`

Ran `summary <thread> --json` against a 3-line NDJSON where line 2 was `CORRUPTED LINE {not json`. Result: `entries` contained exactly the 2 valid entries; exit 0. Matches `Scenario: Malformed NDJSON lines are skipped during parsing`. Keep.

---

## [NICE] NDJSON file is append-only

Spot-checked: no `.ndjson` files have overwritten/truncated bytes between appended records. Every line ends with `\n`. `Scenario: NDJSON file is append-only` holds.

---

## [GUESSED] Session file naming — `{threadId}.*`

The Gherkin says `thr_abc.ndjson` as the filename. Real files: `<UUID>.ndjson`. The scenario is placeholder-syntactic but a reader could confuse it for a real prefix. See `04-notifications-and-events/01-thread-id-format-mismatch.md`.
