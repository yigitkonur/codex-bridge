# Notification Format

Every notification has three parts: **Status** (what happened), **Evidence** (data), **Actions** (commands).

## Terminal Tags (Monitor self-terminates)

### [DONE]
```
[DONE] {threadId} completed in {duration}s | {diffStat}
  config: model={model} effort={effort} mode={modeFlow}
  diff: {diffFilePath}
  files:
    M src/auth.ts (+45 -12)
    A src/auth.test.ts (+62 -0)
  actions:
    review: node {scriptPath} review --scope working-tree
    revise: node {scriptPath} send {threadId} "<message>"
    detail: node {scriptPath} result {jobId}
```

`send`/`steer` take **thread** ids. `result`/`cancel`/`status` accept **either** a job id or the thread UUID; the `jobId` embedded in the action line is deterministic and job-specific — use it verbatim when available.

Every `task --json` launch also returns `result.monitor.{command, shell_fallback, terminal_tags, timeout_ms, tool_hint}` — a ready-to-paste `events --follow` invocation plus a `tool_hint` object shaped for the Claude Code `Monitor` tool. Prefer it over hand-rolling `tail -f`.

### [ERROR]
```
[ERROR] {threadId} failed | {errorCode}
  {errorMessage}
  origin: {origin}
  failing_stage: {stage}        # only on pipeline origins when a TimeoutError triggered the failure
  phase: {currentPhase}
  actions:
    … cause-aware lines (see below) …
    see: skill/references/error-recovery.md#<anchor>
```

`{errorCode}` is the raw Codex `codexErrorInfo` variant (e.g. `ClientTimeout`, `ResponseTooManyFailedAttempts`, `ActiveTurnNotSteerable`, `Unauthorized`) — not a shortened alias. Exit codes follow the mapping in `error-recovery.md`.

`{origin}` is one of the canonical tokens actually emitted by the bridge today (v1.4.1):

| Origin | Cause |
|---|---|
| `idle` | Idle watchdog fired: no events from Codex for the configured window. Message: `No events received for Ns`. |
| `upstream:compact-proxy` | The remote compact endpoint returned 502 ("Proxy request budget exhausted"). Typical on reading-heavy turns that trigger mid-turn context compaction. |
| `upstream:transport` | Upstream stream/socket disconnected before `turn/completed` — websocket closed, `ECONNRESET`, `ETIMEDOUT`, etc. Workspace unchanged; safe to retry. |
| `turn` | Every other turn-level failure: `ContextWindowExceeded`, `Unauthorized`, `SandboxError`, generic turn-budget exhaustion, etc. Distinguish by `{errorCode}`. |
| `pipeline:<lastCompleted>` | Auto-pipeline sub-stage failure. `<lastCompleted>` is the last stage that *finished* — see `failing_stage:` for the one that actually stalled. |
| `bridge:*` | Bridge-layer safety net tripped (`bridge:stall`, `bridge:unhandled-exit`). Indicates a bridge bug; treat as a bug report. |

The NDJSON counterparts (`ERROR`, `PIPELINE_ERROR`) carry `data.origin` with the same values plus `data.failing_stage` when applicable.

`[ERROR]` can originate from the main turn **or** from an auto-pipeline sub-stage (e.g. `auto-review exceeded 5m` with `origin: pipeline:diff` + `failing_stage: review` + `phase: pipeline (completed: diff)`). In the pipeline-origin case, the sync `task --json` envelope may still be `ok:true` with `result.phase: "incomplete"` and `result.pipeline.error` set — read the envelope after Monitor self-terminates; don't assume exit-4/5/7 just because `[ERROR]` appeared. Branch on `origin: turn` vs `origin: pipeline:*` vs `origin: upstream:*` in tooling.

The `actions:` block is **cause-aware**: an idle-timeout `[ERROR]` suggests `relaunch: … --idle-timeout-ms 900000 …`, a compact-proxy 502 suggests narrowing required-reads + a shorter follow-up `send`, a pipeline sub-stage failure points at `rerun-review` rather than retrying the whole task, and so on. Every block ends with a `see:` line deep-linking into `skill/references/error-recovery.md` for the full recipe.

### [WARNING]
```
[WARNING] {threadId} {reason}
  family: {family}
  threshold: {N} consecutive failures
  sample: {truncatedCommand}
  turnInterrupted: {yes|no}
```

Emitted when `command_failure_circuit_breaker: true` (shipped default) detects `N=3` consecutive same-family command failures. `{family}` is one of `osascript`, `applescript-dialog`, `applescript-system`, `open-app`, `computer-use`. `{reason}` is `command-family-circuit-breaker-tripped`. `turnInterrupted: no` today — logging-only (see `config-reference.md#command_failure_circuit_breaker`). Monitor picks this up as non-terminal: `[WARNING]` does **not** self-terminate a following `events --follow` stream; the orchestrator decides whether to `cancel` or `send` a steer based on the family. Counter resets on the next turn and on any successful command. Matching NDJSON tag: `CIRCUIT_BREAKER`.

### [HEARTBEAT]
```
[HEARTBEAT] {threadId} t={elapsed} | phase={plan|execute} | pid={pid}
  lastItem: {itemType} (age {ageSeconds})
  budget: {remaining} remaining
  tail: node {scriptPath} events {jobId} --follow --exclude HEARTBEAT --timeout-ms 1800000
```

Emitted every 60 s (override via `CODEX_BRIDGE_HEARTBEAT_MS` env) during any running turn — the unconditional liveness pulse introduced in 1.3.0. Non-terminal: `events --follow` does **not** self-terminate on `[HEARTBEAT]`. Monitor's default filter **excludes** `HEARTBEAT` (see `DEFAULT_MONITOR_EXCLUDE` in `src/lib/session-log.mjs`) so pure-liveness pulses don't flood LLM context; pass `--include HEARTBEAT` (or drop the default exclude) explicitly when you *do* want to see the pulse.

Purpose: if `[HEARTBEAT]` lines stop arriving, the bridge wrapper process is not alive — the caller can short-circuit their wait and investigate (`kill -0 <pid>` on the heartbeat's `pid`, or `pgrep -f codex-bridge`). The `tail:` line in each block is a ready-to-paste re-attach command so an agent that lost its Monitor session can recover from the most recent events-file line alone.

### [INCOMPLETE]
```
[INCOMPLETE] {threadId} | {diffStat}
  diff: {diffFilePath}
  review: {verdict} ({findingCount} findings)
  missing:
    - {item1}
    - {item2}
  actions:
    fix:  node {scriptPath} send {threadId} "Complete the missing items"
    new:  node {scriptPath} task --write "..."
    detail: node {scriptPath} result {jobId}
```

## Interactive Tags (Claude Code acts on these)

### [QUESTION]
```
[QUESTION] {threadId} {requestId}
  "{questionText}"
  (a) {optionLabel} — {optionDescription}
  (b) {optionLabel} — {optionDescription}
  [other: custom answer allowed]
respond:
  node {scriptPath} respond {requestId} --question-id {qId} --answer "{label}"
```

### [PLAN]
```
[PLAN] {threadId} {turnId}
  {planTitle}
  1. [ ] {step1}
  2. [ ] {step2}
  plan: {planFilePath}
actions:
  approve: node {scriptPath} send {threadId} --mode default "Implement the plan."
  revise:  node {scriptPath} send {threadId} "<revision instructions>"
```

## Informational Tags

### [CONFIRMED]
```
[CONFIRMED] {threadId} {requestId} | codex resumed
```

### [DIRECTIVES]
```
[DIRECTIVES] {threadId} | mode={plan|default} | effort={none|minimal|low|medium|high|xhigh} | sandbox={readOnly|workspaceWrite|dangerFullAccess} | quiet={true|false} | skip_meta_skills={true|false} | pipeline={review,check|none} | model={model}
```

Emitted once per turn at `turn/started`, before any `[HEARTBEAT]` / `[CHECKPOINT]` cadence. Surfaces the **effective** runtime config — what the bridge actually resolved after merging CLI flags, `config.yaml`, and built-in defaults. Resolves the invisible-directive problem for keys like `skip_meta_skills` that shape the prompt but otherwise emit nothing observable. Non-terminal.

`pipeline=` reflects the enabled auto-pipeline stages for this run (`review`, `check`, or a comma-joined subset). `pipeline=none` means `--no-pipeline` was passed or the config disabled both stages.

### [PIPELINE:*] — Auto-pipeline stage progress

Every pipeline stage emits both a **start tag** and a matching **`:done`** tag so an orchestrator tailing `events --filter PIPELINE` can tell exactly when each stage stops writing to the repo. Pre-1.2.5 only start tags existed, forcing agents to guess when the pipeline was hands-off.

```
[PIPELINE:diff] HH:MM:SS                           # stage start
[PIPELINE:diff:done] HH:MM:SS 2 files | +23 -5     # stage end (:done pair)

[PIPELINE:review] HH:MM:SS                         # stage start
[PIPELINE:review:done] HH:MM:SS verdict=approve findings=0

[PIPELINE:fix] HH:MM:SS                            # stage start (only when review returned structured findings)
[PIPELINE:fix:done] HH:MM:SS files=["a.ts","b.ts"] # stage end carries the list of files the fix stage wrote

[PIPELINE:check] HH:MM:SS                          # stage start
[PIPELINE:check:done] HH:MM:SS complete=true missing=0
```

Then exactly one terminal pipeline tag closes the whole pipeline:

```
[PIPELINE:done] HH:MM:SS stages=diff,review,check complete=true touched=0
# or, if a stage threw:
[PIPELINE:failed] HH:MM:SS at=review stages=diff,review touched=0
```

After `[PIPELINE:done]` / `[PIPELINE:failed]`, no further bridge-side writes are coming to the workspace — safe for the orchestrator to commit / inspect. The `touched=N` summary is the count of files in `[PIPELINE:fix:done] files=[…]`; on `task --json` it's also available as `result.pipeline.touchedFiles`.

`[PIPELINE:fix]` only fires when a structured review populated `reviewFindings` (e.g. an adversarial-review result fed back in). The default native auto-review returns plain text, so `reviewFindings` is empty and `[PIPELINE:fix]` does not appear on the normal `auto_review: true` path. Even then, `[PIPELINE:review:done]` still appears with `findings=0`. See `orchestration-flows.md` for lifecycle.

`--no-pipeline` on `task` / `send` skips the pipeline entirely; the events file sees no `[PIPELINE:*]` lines, and the ndjson log carries a `PIPELINE_SKIPPED` entry.

### [REVIEW] (reserved — not emitted by the current build)
```
[REVIEW] {threadId} verdict: {verdict} | {findingCount} findings
  [{severity}] {title} — {file}:{lineStart}
  full: {reviewFilePath}
  actions:
    fix: node {scriptPath} task --write "fix the {n} review findings"
```
`formatReviewEvent` and `writeReview` exist in `src/lib/session-log.mjs` but nothing in the standalone `review` / `adversarial-review` handlers calls them today. Neither this tag nor `{threadId}.review.json` appears on disk — the review payload is returned on stdout (or `--json`) only. Don't gate on this tag in Monitor scripts.

### [PHASE] (reserved — not emitted by the current build)
```
[PHASE] editing src/auth.ts
[PHASE] running: npm test
```
`formatPhaseEvent` is defined but has no caller. Monitor scripts should not expect `[PHASE]` lines.
