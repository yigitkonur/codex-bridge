# 03 / 01 — `[PIPELINE:fix]` exists in code but is unreachable in default config

**Scenarios under test:**
- `Scenario: PIPELINE:fix tag appears only when findings exist`
- `Scenario: Auto-review with findings triggers fix turn`

---

## [BROKE] Three docs disagree on whether `[PIPELINE:fix]` ever fires

- `references/orchestration-flows.md:62` — "the current native auto-review returns plain text, not a structured findings list, so there is no automatic `[PIPELINE:fix]` stage"
- `references/notification-format.md:83` — lists `[PIPELINE:fix] HH:MM:SS` as if it always appears
- `test-gherkin/03-auto-pipeline.feature:38` — expects `[PIPELINE:fix]` when findings exist

Source (`src/lib/auto-pipeline.mjs:91`) *does* emit `[PIPELINE:fix]` — but only when `reviewFindings.length > 0`. Since the native auto-review (invoked in the auto-pipeline path) returns text, not structured findings, `reviewFindings` is always empty and the fix stage never runs under the default `auto_review: true` configuration. So an executor who (a) sees `[PIPELINE:fix]` in `notification-format.md`, (b) runs a task that changes real code, and (c) expects the fix stage to self-heal — never sees it.

**Root cause in skill text:** `notification-format.md` presents `[PIPELINE:fix]` without the caveat; `orchestration-flows.md` states the caveat but hides it in a paragraph.

**Fix target:**
1. `notification-format.md` `[PIPELINE:*]` block — annotate `fix` as "only fires when a structured review (e.g. adversarial-review feeding findings back) populates `reviewFindings`; the default native auto-review path never fires it."
2. Consider whether the Gherkin scenario should be removed or clearly scoped to adversarial-review-driven paths.

---

## [BROKE] Auto-review stalls at 300 s on default config

Carried over from `01-task-lifecycle/01-default-plan-sync-task.md`: the default `auto_review: true` pipeline silently stalls for the full internal 300 s timeout on trivial tasks that produced no diff. The stall is invisible to the sync caller until the deadline hits.

**Fix target:** SKILL.md `## How It Works` — warn that `auto_review: true` runs a separate Codex turn; on a zero-diff task the reviewer has nothing to say and occasionally times out. Recommend `auto_review: false` + `adversarial-review` on demand for predictable latency.

---

## [NICE] Events file correctly omits `[REVIEW]` during auto-pipeline

`Scenario: Auto-pipeline review does NOT produce REVIEW tag` — confirmed. My earlier run produced `[PIPELINE:review]` + `[ERROR]` (the pipeline timeout error) but no `[REVIEW]` tag. The tag is reserved for standalone `review` invocations.
