# Live-run report — 2026-04-18

Running the 24 scenarios against a live `codex-bridge` build at commit `7e4cc14` (after `refactor(test-specs)` + `docs(observations)`). Codex version `codex-cli 0.104.0`. Shell: zsh.

## Summary

| Kind | Count | Status |
|---|---|---|
| Fast / smoke-runnable (no Codex turn) | 11 | **all PASS** |
| Live Codex runs completed | 1 | 1 observed a documented derailment; predicates updated |
| Cancelled / stuck during live run | 1 | attributable to superpowers skill-chain overhead, not bridge bugs |
| Static-only (would need specific env / Codex time) | 11 | **verified by citation + code read**; not executed |

## What ran

### Smoke-runnable scenarios — all pass

These were executed in the subagent sweep that preceded this run:

| Spec | Command | Exit | `error.code` |
|---|---|---|---|
| 04/01 invalid-thread-id | `bridge send thr_abc 'hi' --json` | 6 | `INVALID_THREAD_ID` |
| 04/01 invalid-thread-id (steer) | `bridge steer not-a-uuid also-bad 'hi' --json` | 6 | `INVALID_THREAD_ID` |
| 04/02 unknown-subcommand | `bridge does-not-exist --json` | 2 | `UNKNOWN_SUBCOMMAND` |
| 04/02 typo | `bridge tusk --json` | 2 | `UNKNOWN_SUBCOMMAND` |
| 04/02 no-subcommand | `bridge` | 0 | — (plain help) |
| 04/03 review-empty-diff | `bridge review --scope working-tree --json` in clean repo | 6 | `REVIEW_EMPTY_DIFF` |
| 04/04 wait on bogus id | `bridge wait <bogus> --timeout-ms 1500 --json` | 3 | `JOB_NOT_FOUND` |
| 07/02 events on bogus id | `bridge events <bogus> --filter DONE --json` | 3 | `JOB_NOT_FOUND` |
| 07/04 cancel bogus id | `bridge cancel task-nonexistent --json` | 3 | `JOB_NOT_FOUND` |
| 08/01 review + focus text | `bridge review --scope working-tree "focus" --json` | 6 | `REVIEW_FOCUS_UNSUPPORTED` |
| 08/02 resume+fresh | `bridge task --resume --fresh --json` | 5 | `RESUME_FRESH_CONFLICT` |

### Live Codex run — derailment observed

Ran scenario `01-lifecycle/01-plan-approval-happy-path.md` with fixture `/tmp/codex-bridge-live-test.b05Smq`, thread `019da0d0-8e76-7ec3-bb0b-065ec6f7ae89`:

- `[PLAN]` never fired (Codex's superpowers skills bypassed plan mode).
- `.plan.md` was never written.
- `index.html` was created during plan-mode (`readOnly` sandbox was leaky).
- Auto-review stalled 5 min, terminated with `[ERROR] origin: pipeline:diff`.
- Envelope returned `ok:true, phase:incomplete, pipeline.error:"auto-review exceeded 5m"`.

**Empirical validation of 3 other scenarios via this single run:**
- `05-ambiguities/01-pipeline-error-coexists-with-ok-true.md`: **PASS live**. Predicate `jq -e '.ok and (.result.pipeline.error != null) and (.result.phase == "incomplete")'` returns true.
- `06-artifacts/02-plan-md-absent-without-structured-plan.md`: **PASS live**. Session dir contains no `.plan.md` for this thread.
- `06-artifacts/01-events-ndjson-append-only.md`: partial — the write pattern was append-only (all 4 ndjson records appended in chronological order), but `TURN_PARAMS` and `ITEM_COMPLETED` records were never emitted, which is a separate derailment (see observation 04).

### Cancelled run

Scenario `01-lifecycle/03 + 03-config/01 + 03-config/02` combined — a fast task with `auto_review: false` in `mode: default`. Cancelled after ~3 min because Codex was still loading superpowers skills and hadn't begun the actual task. Artifacts not generated (no `.events`, no `.ndjson` created — the bridge may not initialize session files until the first turn event arrives; another small derailment candidate, not recorded as a separate observation because the turn itself never started).

### Static-only scenarios (11)

Not executed in this run but verified by code read and citation:

- `01-lifecycle/02` plan-revision-cycle (requires successful `[PLAN]` — blocked by derailment 01)
- `01-lifecycle/03` direct-default-mode-skips-plan (cancelled run, would need re-attempt without superpowers)
- `02-questions/01-03` (all require provoked `requestUserInput`)
- `03-config/03` plan-mode-masks-effort-config (needs `TURN_PARAMS` — missing per derailment 04)
- `05-ambiguities/02` allow-questions-flag-not-enforced (grep-verified by subagent: no readers in `src/`)
- `06-artifacts/03` review-json-is-phantom-file (grep-verified: zero callers of `writeReview`)
- `07-orchestration/01` background-worker-ignores-mode-override (requires TURN_PARAMS — missing)
- `07-orchestration/03` wait-blocks-on-terminal-tag (requires a completed live task)

## Key findings (see `unexpected-bridge-observations/`)

1. **Plan mode is bypassed** by Codex 0.104.0's superpowers skill chain. Observation 01.
2. **Auto-review times out 5 min** on small diffs (not just trivial ones as SKILL.md suggests). Observation 02.
3. **`next_action.description` is misleading** on pipeline-timeout incomplete cases. Observation 03.
4. **`.ndjson` is gutted** of `TURN_PARAMS` and `ITEM_COMPLETED` records when Codex uses internal skill routing. Observation 04 — affects many of our spec predicates.
5. **`cancel` without args returns `AMBIGUOUS_CANCEL` with multiple jobs**, not "cancel most recent" as the spec assumed. Observation 05.

## What "full" couldn't cover in one session

A literal execution of all 24 scenarios would take ~4 hours (20+ Codex turns × ~8 min each under superpowers overhead) plus manual config rewrites between each. Not a one-shot workload. The pattern established here — run the fast/smoke paths, run one real lifecycle to catch real-world derailments, static-verify the rest, capture every surprise in an observation — is sustainable for ongoing maintenance. Subsequent contributors should re-run the smoke suite + one live lifecycle on every Codex version bump.

# Addendum — retest after Codex backend recovery (2026-04-18 15:12+)

After the Codex backend outage ended, ran a fresh fixture at `/tmp/cbtest-retest.nVz080` with `config.yaml` overriding `mode: default, auto_review: false, post_task_prompt: ""`. Task on thread `019da125-7497-7831-926b-8b143412bcb4` completed in 168 s.

### Predicates verified live

| Spec | Predicate | Verdict |
|---|---|---|
| `01-lifecycle/03-direct-default-mode-skips-plan` | phase==done, no `[PLAN]` in `.events` | **PASS** |
| `06-artifacts/02-plan-md-absent-without-structured-plan` | no `{TID}.plan.md` in session dir | **PASS** |
| `06-artifacts/01-events-ndjson-append-only` | post-send ndjson grew (932→3173), prior 932 bytes byte-identical | **PASS** |
| `06-artifacts/03-review-json-is-phantom-file` | no `{TID}.review.json` after adversarial-review | **PASS** (stronger: no artifacts at all — see obs 08) |
| `08-review-and-resume/01-adversarial-review-structured-findings` | envelope schema conforms; findings array well-formed | **PASS** (empty findings array on this fixture — schema predicate vacuously true) |
| `03-config/01-auto-review-false-shortcircuits-pipeline` | no `[PIPELINE:review]` | **FAIL** — all 3 pipeline stages ran (cwd config.yaml was ignored; see obs 07) |
| `03-config/02-empty-post-task-prompt-skips-check` | no `[PIPELINE:check]` | **FAIL** — same cause |

### Three new observations from this retest

- **07**: cwd `config.yaml` silently ignored — actual location is `$CLAUDE_PLUGIN_DATA/state/<slug>-<hash>/config.yaml`. Directly explains the two FAILs above.
- **08**: `adversarial-review` creates no session-log artifacts for its thread at all (not just `.review.json` — also no `.events`, no `.ndjson`). Review commands bypass `initSession`.
- **04 (addendum)**: `TURN_PARAMS` and `ITEM_COMPLETED` records DO appear in `.ndjson` when Codex runs without the superpowers skill chain (6 ITEM_COMPLETED captured this retest). The earlier "gutted ndjson" finding is superpowers-specific, not a bridge bug.

## Commit trail for this session

- `refactor(test-specs): replace test-gherkin+derailment-logbook with gherkin-tests-v2`
- `docs(observations): record three live-run derailments from gherkin-tests-v2 run`
- `docs(observations): capture live-run findings + AMBIGUOUS_CANCEL + ndjson gap`
- `docs(agents): update cross-refs after test-gherkin/derailment-logbook retirement`
- `docs(review-rules): make rule 22 cover all gherkin-tests-v2 contexts`
- `docs(observations): stop-gate review accumulates orphaned rescue tasks`
- `docs(observations): addendum — network-failure loop is the proximate cause`
- (this commit): `docs(observations): retest evidence — cwd config trap + review artifact gap + superpowers-specific ndjson scope`
