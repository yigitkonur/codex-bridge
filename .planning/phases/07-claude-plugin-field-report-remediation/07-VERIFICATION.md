# Phase 7 Verification: Claude Plugin Field Report Remediation

**Verified:** 2026-05-03
**Result:** Complete for Phase 7 scope

## Issue Coverage

| Field-report item | Status | Evidence |
|---|---|---|
| P0-01 `--brief` persisted but not delivered | Done | `src/codex-bridge.mjs` appends rendered brief to task prompt; static test asserts the contract. |
| P0-02 `--resume-last --worktree-auto` loses worktree continuity | Done | `src/codex-bridge.mjs` rejects the combination with `RESUME_WORKTREE_CONFLICT`; docs point to `iterate <task_id>`. |
| P0-03 docs imply invalid brief-only flow | Done | README, skill, plugin skill, command examples, and brief references now show `--brief @brief.json "real prompt"`. |
| P1-01 pipeline reports `0 files` for committed work | Done | `captureGitDiff` accepts explicit task base refs; auto-pipeline final summaries use task-base diffs. |
| P1-02 missing criteria hidden behind `missing=N` | Done | `[PIPELINE:check:done]` now includes serialized `missing_items` when incomplete. |
| P1-03 review approved while check failed | Addressed | Final phase still reports incomplete when checks fail; the event now includes missing items so review approval is not the only visible signal. |
| P1-04 manual git merge bypassed bridge flow | Addressed | Skill and plugin skill now route users back to bridge verdict/merge and warn manual git merge is recovery-only. |
| P1-05 schema validation lacks details | Done | Task and review brief loaders propagate `error.details` plus a schema repair suggestion. |
| P1-06 first-run worktree failure unclear | Done | Automatic worktree creation preflights git commits and reports initial-commit guidance. |
| P1-07 Monitor cannot show full worker thinking | Partially addressed | Missing check output is surfaced in events; full assistant-preview heartbeat telemetry remains future work. |
| P1-08 queued payload `eventsPath` is null | Existing behavior retained | Launch payload already exposes `eventsDir` and monitor command before thread id exists; task-id session aliases remain future work. |
| P1-09 task/thread id friction | Future backlog | Not implemented in this phase; would require session alias/symlink design. |
| P1-10 cancel/resume naming drift | Future backlog | Not implemented in this phase; lower-risk registry/title cleanup. |
| P1-11 iterate flow unclear | Done | Hook, skill, plugin skill, command reference, and README now route task follow-ups through `iterate <task_id>`. |
| P1-12 static validation recipe unclear | Done | README keeps local validation commands concrete; phase closeout records exact gates. |
| P2 docs/polish set | Addressed where low-risk | Brief composition, error recovery, read-only default, command examples, and hook guidance updated. Larger job-group/wait-any and task-id alias ideas remain future backlog. |

## Validation Commands

```bash
node --test test/bridge-static.test.mjs test/session-log.test.mjs test/brief.test.mjs
npm run build
npm test
npm run baseline:contracts -- --check
git diff --check
npm run verify:static
```

## Final Assessment

The blocking Claude-agent experience defects from the forensic session are
fixed in source, generated surfaces, tests, and user-facing guidance. Remaining
items are non-blocking backlog improvements around richer monitor telemetry,
task-id session aliases, naming polish, and multi-job primitives.
