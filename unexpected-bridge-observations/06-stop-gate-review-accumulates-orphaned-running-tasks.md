# 06 — stop-gate review accumulates orphaned "running" tasks across sessions

**Observed:** 2026-04-18 during end-of-session cleanup.
**Codex version:** `codex-cli 0.104.0`

## What happened

Over the course of today's session, three separate stop-hook notifications cited a stuck Codex task that the session couldn't end cleanly without. Each was a `kindLabel: "rescue"` job created by the stop-gate review — the automatic "let Codex look at your last turn and either ALLOW or BLOCK" feature toggled via `bridge setup --enable-review-gate`.

Surveying `$CLAUDE_PLUGIN_DATA/state/*/state.json` across all workspace roots at cleanup time turned up **7 still-marked-running rescue tasks** across 3 state dirs:

```
codex-bridge-04efbae62558fec9   (this repo): 4 running, 33 total
cbtest-fast.dWV084              (today's fixture): 1 running
tmp-11fe14a563f7aed6            (a different workspace): 2 running — started 2026-04-17 (yesterday!)
```

**None of those 7 "running" tasks had a live OS process backing them** (`ps aux | grep codex-bridge.*task-` was empty). They were all ghost entries.

## Why this is a derailment

1. **Status drift.** `job-control.mjs`'s cancel semantics update `status: "cancelled"` only via the `bridge cancel` code path. If the underlying node process dies for any other reason (SIGKILL from `pkill`, parent shell exit, OOM, stop-hook cleanup that terminates the process but not the state), the job stays `running` forever. There's no reaper.

2. **Stop-hook noise compounds.** Every Claude Code session turn that modifies files fires the stop-gate review as a new rescue task. Because superpowers skill loading routes the task through a lengthy pre-execute chain (~3–5 min before any useful work), many reviews time out or get terminated when the session ends before they finish. Each such task becomes a ghost. Over ~10 hours of use, this repo accumulated **33 rescue-task entries** in state.json, of which 4 were still marked running.

3. **Cross-session pollution.** The `tmp-11fe14a563f7aed6` workspace's two ghost tasks started at `2026-04-17T01:54:03` and `2026-04-17T02:44:51` — yesterday. The state.json preserves them indefinitely since `MAX_JOBS = 50` (`state.mjs`) and no reaper logic examines "has this PID been dead for >N hours, mark as failed."

4. **Confusing stop-hook UX.** Every session's stop-hook output cites a different task id, but the user sees the same pattern of "task still running, /codex:cancel to stop it." The user can't easily tell that these are all the same kind of orphan from the same underlying bug.

## Hypothesis on root cause

Two layers:

- **Rescue-task timeout > Claude Code session timeout.** The stop-gate review is spawned right as the user's turn ends. Claude Code's stop-hook doesn't wait for it; the process gets backgrounded. When the next session starts (or the user closes the terminal), the backgrounded review is either still limping along or already dead — but `tracked-jobs.mjs::runTrackedJob` only transitions `running → completed|failed` inside its own try/catch. External termination leaves `running` on disk.

- **No startup-time reaper.** When `bridge` starts and loads state, it never checks whether the PIDs it thinks are "running" are actually alive. A cheap `kill -0 <pid>` probe would catch most orphans; a stat-based liveness check on the log file (no recent writes) would catch the rest.

## Suggested fixes (not implemented here)

1. **Startup-time orphan reaper in `src/lib/state.mjs`**. On first `loadState` per process, walk `state.jobs` for any `{status: "running", pid: N}` where `process.kill(N, 0)` throws `ESRCH`. Transition those to `status: "orphaned"` with a note like `errorMessage: "Process died without updating state (reaped at <ts>)"`. Idempotent, cheap, and drains the pile over time.

2. **Staleness reaper**. For any `status: "running"` job whose `updatedAt` is >6 hours old, mark as `orphaned`. Covers the PID-reuse edge case where the original PID has since been given to a different process.

3. **Stop-gate review with a hard deadline**. When the stop hook invokes the rescue task, pass `--timeout-ms 180_000` (3 min) or similar. If it hasn't produced a verdict, default to ALLOW and kill the task. Currently there's no explicit budget.

4. **`bridge status --cleanup` or `--prune-orphans` subcommand**. Manual escape hatch for users who hit this. One-line fix for the 7 entries found today.

5. **Document the tradeoff in SKILL.md.** The stop-gate review is opt-in via `bridge setup --enable-review-gate`. Its cost profile (every turn pays a Codex-turn-worth of latency, even if the turn didn't do much) and its failure mode (orphan accumulation) should be called out so users can make an informed choice.

## Cleanup performed in this session

Ran a targeted script to mark all 7 ghosts as `status: "cancelled"` with `errorMessage: "Orphaned rescue task — no backing process at cleanup on 2026-04-18"`. The state is now consistent, but will re-fill if the underlying bug isn't fixed.

## Related

- `gherkin-tests-v2/07-orchestration/04-cancel-interrupts-running-turn.md` — the cancel-semantics spec. A new scenario could assert the reaper's orphan-detection behavior once (1) lands.
- Observation 05 (`AMBIGUOUS_CANCEL`) — the related UX where `bridge cancel` (no args) errors when multiple rescue ghosts are active. A reaper would make that case rarer.
- Observation 01 (plan-mode bypass) — the underlying reason rescue tasks take so long: they too are subject to the superpowers skill chain before they reach the actual review turn.
