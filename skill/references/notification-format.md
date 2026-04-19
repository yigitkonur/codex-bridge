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
  phase: {currentPhase}
  actions:
    retry: node {scriptPath} send {threadId} "<revised prompt>"
    log:   node {scriptPath} result {jobId}
    cancel: node {scriptPath} cancel {jobId}
```

`{errorCode}` is the raw Codex `codexErrorInfo` variant (e.g. `ClientTimeout`, `ResponseTooManyFailedAttempts`, `ActiveTurnNotSteerable`, `Unauthorized`) — not a shortened alias. Exit codes follow the mapping in `error-recovery.md`.

`{origin}` is `turn` for main-turn failures and `pipeline:<stage>` (where `<stage>` is the last completed pipeline stage — `diff`, `review`, `fix`, or `check`) for auto-pipeline sub-stage failures. The NDJSON counterparts (`ERROR`, `PIPELINE_ERROR`) also carry `data.origin` with the same values.

`[ERROR]` can originate from the main turn **or** from an auto-pipeline sub-stage (e.g. `auto-review exceeded 5m` with `origin: pipeline:review` + `phase: pipeline (completed: diff)`). In the pipeline-origin case, the sync `task --json` envelope may still be `ok:true` with `result.phase: "incomplete"` and `result.pipeline.error` set — read the envelope after Monitor self-terminates; don't assume exit-4/5/7 just because `[ERROR]` appeared. Branch on `origin: turn` vs `origin: pipeline:*` in tooling.

### [WARNING]
```
[WARNING] {threadId} {reason}
  family: {family}
  threshold: {N} consecutive failures
  sample: {truncatedCommand}
  turnInterrupted: {yes|no}
```

Emitted when `command_failure_circuit_breaker: true` (shipped default) detects `N=3` consecutive same-family command failures. `{family}` is one of `osascript`, `applescript-dialog`, `applescript-system`, `open-app`, `computer-use`. `{reason}` is `command-family-circuit-breaker-tripped`. `turnInterrupted: no` today — logging-only (see `config-reference.md#command_failure_circuit_breaker`). Monitor picks this up as non-terminal: `[WARNING]` does **not** self-terminate a following `events --follow` stream; the orchestrator decides whether to `cancel` or `send` a steer based on the family. Counter resets on the next turn and on any successful command. Matching NDJSON tag: `CIRCUIT_BREAKER`.

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
