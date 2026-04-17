# 04 / 02 — NDJSON tag coverage contradicts the guide

**Scenarios under test:**
- `Scenario Outline: NDJSON entries have correct tags`
- `Scenario: NDJSON file logs every app-server notification` (feature 01)
- Every `references/ndjson-guide.md` jq example

---

## [BROKE] Observed NDJSON tag set is narrower than the guide

Across every `.ndjson` on disk (`~/.codex-bridge/sessions/*.ndjson`, 9 files), only three tags appeared:

```
TURN_COMPLETED
PIPELINE_STAGE
PIPELINE_ERROR
```

The sessions were all short / non-interactive / crashed. Reading `src/codex-bridge.mjs` and `src/lib/auto-pipeline.mjs` shows the writer actually emits a larger set: `TURN_PARAMS`, `TURN_COMPLETED`, `QUESTION`, `CONFIRMED`, `QUESTION_TIMEOUT`, `SERVER_RESPONSE`, `STEER`, `ERROR`, `PIPELINE_STAGE`, `PIPELINE_COMPLETE`, `PIPELINE_ERROR`. The `ndjson-guide.md` tag palette I walked in with wasn't entirely fiction — the old table just conflated the writer's vocabulary with upstream wire tags (`THREAD_STARTED`, `TURN_STARTED`, `ITEM_STARTED`, `ITEM_COMPLETED`, `PLAN`, `REVIEW_*`, `DIFF`, `TIMEOUT`, `NOTIFICATION`) that this bridge never persists.

**Gherkin rows that truly don't match reality:**

| `Examples:` method | Mapped tag | In source? |
|---|---|---|
| `thread/started` | `THREAD_STARTED` | No |
| `turn/started` | `TURN_STARTED` | No (`TURN_PARAMS` is written at `onTurnStart` instead, with different fields) |
| `item/started` | `ITEM_STARTED` | No |
| `item/completed` | `ITEM_COMPLETED` | No |
| `error` | `ERROR` | Yes, when `will_retry: false` |
| `item/tool/requestUserInput` | `QUESTION` | Yes |
| `serverRequest/resolved` | `CONFIRMED` | Yes |

**Fix target:**
1. `references/ndjson-guide.md` — list the actual writer vocabulary, with explicit "not persisted" note for the upstream tags above. (Applied this pass.)
2. Gherkin `04-notifications-and-events.feature:166–179` — drop the three non-existent rows or keep as aspirational.

---

## [BROKE] PIPELINE_ERROR is emitted but events file also gets `[ERROR]`

NDJSON shows `PIPELINE_ERROR` *and* the events file shows `[ERROR]` with the same payload. Two tags for the same underlying event — and one of them (the events file `[ERROR]`) self-terminates a Monitor. See `01-task-lifecycle/02-events-and-ndjson-divergence.md` for the detailed clash.

**Fix target:** `references/notification-format.md` must state that `[ERROR]` can originate from the auto-pipeline (not just the main task) and that the sync envelope may still be `ok:true`. Or: rename pipeline-only failures to `[PIPELINE:error]`.
