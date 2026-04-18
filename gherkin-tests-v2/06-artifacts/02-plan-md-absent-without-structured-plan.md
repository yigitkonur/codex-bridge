# 02-plan-md-absent-without-structured-plan

**Derived from:** `src/codex-bridge.mjs:1420-1431` (`if (result.planDetected && result.planText) { writePlan(...); logEvent([PLAN]) }` — single guarded call site), `src/lib/session-log.mjs:63-71` (`writePlan` writes `{threadId}.plan.md`), `src/lib/codex.mjs` `captureTurn` (`planDetected` set only on `item/completed` with `type: "plan"`, per upstream invariant that plan item id is `"{turn.id}-plan"`), `SKILL.md` "When Codex's internal skills route around formal planning, this file is absent."
**What this catches:** Regressions that desynchronize the `[PLAN]` event from the `.plan.md` file. The event and the file are written together behind the same guard (`planDetected && planText`); if someone emits `[PLAN]` heuristically from assistant text without triggering `writePlan`, agents following the event's `planPath` hit `ENOENT`. Equally, writing `.plan.md` without the event makes it invisible to Monitor tailers.
**Runtime cost:** medium (two plan-mode turns).
**Test subject:** a workspace with Codex authenticated; two prompts picked to exercise both branches.

## Feature: `.plan.md` exists iff Codex emitted a structured plan item

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

And `${SESSION_DIR} = ~/.codex-bridge/sessions`
And `codex` is authenticated
And plan mode is the default (per `src/lib/config.mjs:DEFAULT_CONFIG.mode = "plan"`)

### Scenario: prompt that reliably triggers the plan tool

Given a prompt Codex typically renders as a structured plan, e.g. `"Build a small static HTML site with a hero, three cards, and a footer"`
When I run `bridge task --write "Build a small static HTML site with a hero, three cards, and a footer" --json`
Then the turn completes with `result.phase == "plan-pending"`
And `${SESSION_DIR}/${threadId}.plan.md` exists
And the file is non-empty
And `${SESSION_DIR}/${threadId}.events` contains a `[PLAN]` block whose `planPath` field points to that same file
And the two are consistent: `grep -c '^' ${threadId}.plan.md > 0` and `grep -F "${threadId}.plan.md" ${threadId}.events > 0`

### Scenario: trivial prompt that skips structured planning

Given a prompt Codex handles without the plan tool, e.g. `"What is 2+2?"`
When I run `bridge task --write "What is 2+2?" --json`
Then the turn may complete via `agentMessage` alone, with no `item/completed` of `type: "plan"`
And `${SESSION_DIR}/${threadId}.plan.md` does **not** exist (guard at `codex-bridge.mjs:1422` skips both `writePlan` and the `[PLAN]` log together)
And `${SESSION_DIR}/${threadId}.events` contains no `[PLAN]` block (the guard is symmetric — either both fire or neither does)
And this is the documented "Codex's internal skills route around formal planning" state from SKILL.md, not a bug

### Pass / fail predicate

```bash
# Scenario 1
test -s "${SESSION_DIR}/${THREAD1}.plan.md" && grep -qF "${SESSION_DIR}/${THREAD1}.plan.md" "${SESSION_DIR}/${THREAD1}.events"

# Scenario 2
test ! -f "${SESSION_DIR}/${THREAD2}.plan.md" && ! grep -q '^\[PLAN\]' "${SESSION_DIR}/${THREAD2}.events"
```

### Enhancement candidates

- If a heuristic `[PLAN]` detector is ever added (scanning assistant text for "Plan:" headings) the guard at `codex-bridge.mjs:1422` will split in two and this test will catch it. The fix is either to have the heuristic also call `writePlan(fake_text)`, or to document the new `[PLAN]` subtype (`[PLAN:heuristic]`) and update `skill/references/notification-format.md`.
- If Codex upstream renames `item/completed.type: "plan"`, `captureTurn.planDetected` goes permanently false and scenario 1 regresses — useful as an early-warning for a protocol drift.
- Pairs with `06-artifacts/03-review-json-is-phantom-file.md` which covers the symmetric case where a writer exists but is never invoked.
