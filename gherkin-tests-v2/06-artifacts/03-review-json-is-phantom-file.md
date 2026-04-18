# 03-review-json-is-phantom-file

**Derived from:** `src/lib/session-log.mjs:73-81` (`writeReview` defined at line 73, writes `{threadId}.review.json` via `writeFileSync`), `src/lib/AGENTS.md` section "State cluster" listing `.review.json` as an artifact "when pipeline review runs", smoke-test verified 2026-04-18: `grep -rn 'writeReview\s*(' src/ skill/scripts/codex-bridge.mjs` returns only the definition at `session-log.mjs:73` — it is imported in `src/codex-bridge.mjs:99` and `src/lib/auto-pipeline.mjs:8` but called at zero sites. Symmetric phantoms confirmed: `formatReviewEvent` (defined `session-log.mjs:246`) and `formatPhaseEvent` (defined `session-log.mjs:242`) are imported in `src/codex-bridge.mjs:97-98` but have no call sites anywhere in `src/` or the bundle.
**What this catches:** A latent writer that the docs imply is wired but isn't. This scenario pins the current reality ("phantom file") so any future commit that starts calling `writeReview` — whether from the auto-pipeline review stage, a new `adversarial-review` persistence path, or a side-effect of `review --scope branch` — will cause this test to fail and prompt the author to also update `SKILL.md` and the reference docs in the same change. Also flags the symmetric phantom formatters `formatReviewEvent` (`[REVIEW]`) and `formatPhaseEvent` (`[PHASE]`) whose outputs should have no emitters in the current build either.
**Runtime cost:** medium (runs `adversarial-review` plus a default-mode task that triggers the auto-pipeline review stage).
**Test subject:** a workspace with Codex authenticated and a dirty working tree.

## Feature: `.review.json` is defined but never produced

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

And `${SESSION_DIR} = ~/.codex-bridge/sessions`
And `codex` is authenticated
And the workspace has a committed file plus one uncommitted edit (so `review` has something to chew on and auto-pipeline will trigger its review stage)

### Scenario: `adversarial-review` does not persist findings to disk

When I run `bridge adversarial-review --json` against the dirty tree
Then the envelope carries findings in `result.findings` (stdout-only transport)
And `${SESSION_DIR}/${threadId}.review.json` does **not** exist on disk
And `.ndjson` for that thread contains no record whose `tag` is `PIPELINE_REVIEW_OUTPUT` and no `writeReview` side effect

### Scenario: default-mode task's auto-pipeline review stage does not persist either

When I run `bridge task --write "add a comment to README.md" --json` against the dirty tree
Then the bridge runs the silent auto-pipeline (diff → review → fix? → check) per `src/lib/auto-pipeline.mjs`
And `.ndjson` contains `PIPELINE_STAGE` records with `data.stage == "review"` and eventually `data.stage == "check"`
And `${SESSION_DIR}/${threadId}.review.json` is still absent
And findings from the review stage are surfaced only through `[PIPELINE:*]` events and the final `[DONE]`/`[INCOMPLETE]` envelope

### Pass / fail predicate

```bash
# Scenario 1
test ! -f "${SESSION_DIR}/${THREAD1}.review.json"

# Scenario 2
test ! -f "${SESSION_DIR}/${THREAD2}.review.json" \
  && jq -r 'select(.tag == "PIPELINE_STAGE") | .data.stage' "${SESSION_DIR}/${THREAD2}.ndjson" | grep -q '^review$'
```

### Enhancement candidates

- The moment a commit adds a `writeReview(session, …)` call (auto-pipeline review stage persisting findings, or a new `review --persist` flag), this test fails by design. That is the intended signal to (a) decide whether the artifact is now a supported output, (b) update `SKILL.md` "Artifacts" section, (c) add a positive scenario to `06-artifacts/` covering the new shape, and (d) document the JSON schema next to `src/schemas/review-output.schema.json`.
- Symmetric phantoms worth their own scenarios if they ever fire: `formatReviewEvent` produces `[REVIEW]` blocks and `formatPhaseEvent` produces `[PHASE]` blocks; both exist in `session-log.mjs` with no emitter found in the current build. Add "absent `[REVIEW]` in events" and "absent `[PHASE]` in events" assertions here if you want a defensive lock.
- If the imports in `codex-bridge.mjs:99` and `auto-pipeline.mjs:8` are removed (dead code elimination), this test still passes — the invariant is "file is not produced", not "function is never imported".
