# 01 — plan mode bypassed by Codex's superpowers skills

**Observed:** 2026-04-18 during live run of `gherkin-tests-v2/01-lifecycle/01-plan-approval-happy-path.md`.
**Codex version:** `codex-cli 0.104.0`
**Bridge bundle:** `skill/scripts/codex-bridge.mjs` @ c6f694b + uncommitted gherkin-tests-v2 content (now at commit `refactor(test-specs): replace test-gherkin+derailment-logbook with gherkin-tests-v2`)
**Fixture:** fresh empty git repo in `/tmp/codex-bridge-live-test.b05Smq`
**Command:** `bridge task --write --json "build a single-page HTML site with a hero section, a 3-item feature list, and a footer. Save as index.html in the current directory."`

## What happened

The bridge launched in plan mode (config default). The `SKILL.md` contract says:

> The task starts in plan mode by default. … If `[PLAN]` arrives, review and approve or revise.

**`[PLAN]` never arrived.** Codex 0.104.0's internal skills (`using-superpowers`, `brainstorming`, per its own log output captured in `/tmp/task.json`) intercepted the prompt, chose a design approach directly, and called `apply_patch` to write `index.html` (5438 bytes) into the workspace — **during plan mode**, which the bridge's config had set the sandbox to `readOnly` for.

Observed events file contents in full:
```
[PIPELINE:diff] 13:40:41
[PIPELINE:review] 13:40:41
[ERROR] 019da0d0-8e76-7ec3-bb0b-065ec6f7ae89 failed | ClientTimeout
  auto-review exceeded 5m
  origin: pipeline:diff
  phase: pipeline (completed: diff)
```

Observed fixture after task:
```
index.html   (5438 bytes, valid HTML with hero/features/footer)
.git/
```

## Why this is a derailment

1. **`SKILL.md` contract broken.** A user reading the skill instructions expects `[PLAN]` on every plan-mode task. Claude orchestrators are instructed to wait for `[PLAN]` before `send --mode default`. Here, no `[PLAN]` ever emitted — the orchestrator would either wait forever or time out Monitor.

2. **`--write` semantic violated.** `SKILL.md` explicitly says: *"`--write` is not enough to enable file writing on the first turn. With the default `mode: plan`, the task runs against a `readOnly` sandbox."* In this run, `--write` WAS passed, `mode: plan` WAS config default, and Codex nevertheless wrote `index.html`. Either Codex's internal skills escape the bridge's sandbox policy, OR the `config.mode: plan` value is not actually reaching the sandbox construction call. Needs isolation.

3. **Spec `01-lifecycle/01-plan-approval-happy-path.md` is aspirational, not enforceable** as written. Its predicate:
   ```sh
   grep -c '^\[PLAN\]' ${TID}.events == 1
   ```
   will fail 100% of the time when a real Codex is used with its default superpowers bundle — which is the realistic user setup.

## Contributing cause (hypothesis)

Codex 0.104.0's skill-loading behavior (visible in the log: "I'm loading the required skills first") happens BEFORE the bridge's sandbox policy can constrain the turn. The `using-superpowers` skill's `brainstorming` + `writing-plans` + `writing-skills` chain appears to produce an internal `TodoWrite`-style plan that Codex treats as satisfied without emitting an `item/completed` event of `type: "plan"` — which is the only signal `captureTurn` uses to set `planDetected`. So `[PLAN]` is gated on Codex's structured plan tool, and the internal skills route around it.

## Suggested fixes (not implemented here)

1. **Bridge-side detection of plan-equivalent behavior.** Watch for any `apply_patch` tool call during a plan-mode turn; if one is attempted while `sandboxPolicy.type == "readOnly"`, fail fast with a distinct error code like `PLAN_MODE_WRITE_ATTEMPT` so the orchestrator knows Codex bypassed the plan. Today the write is silently allowed.

2. **Spec relaxation.** Rewrite the scenario to accept either `[PLAN]` OR a workspace-write event as the plan-mode outcome, documenting that "Codex's internal skills may produce a working artifact directly." The scenario becomes "plan mode produces either a [PLAN] event or a pre-built artifact with a [CONFIRMED]-style notice" — less clean but true.

3. **SKILL.md tightening.** Add a paragraph: *"If the user's Codex installation ships with the `superpowers` skill bundle active (default in Codex 0.104.0+), the plan phase may be skipped entirely and the turn will complete with files written. The `[PLAN]` event will not appear. Prefer `--mode default --write` explicitly for reproducible behavior."*

4. **Claude-side guard.** The orchestrator should set a Monitor timeout (e.g. 5 min) and fall through to `result` polling if no `[PLAN]` appears, rather than assuming a timeout means failure.

## Downstream effect

Because the first turn ran to completion with file writes, the auto-pipeline then tried to `[PIPELINE:review]` the 5KB diff. That review stage timed out at 5 min — see observation 02. So THIS derailment (plan bypass) cascaded into THAT derailment (auto-review timeout) in a single run.

## Related

- `05-ambiguities/01-pipeline-error-coexists-with-ok-true.md` — the pipeline timeout that followed this plan bypass produced the documented ambiguity (envelope `ok: true` + `phase: incomplete` + `[ERROR]` in events). Both fired in this single run.
- `SKILL.md` "How It Works" section, the paragraph starting "**Important:** Codex has its own internal skills that may override plan mode behavior." — this observation is empirical evidence of that warning, measured.
