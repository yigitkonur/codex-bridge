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

`send`/`steer` take **thread** ids. `result`/`cancel`/`status` take **job** ids. The `jobId` embedded in the action line points at the specific tracked job this event was written for — use it verbatim instead of the thread id.

### [ERROR]
```
[ERROR] {threadId} failed | {errorCode}
  {errorMessage}
  phase: {currentPhase}
  actions:
    retry: node {scriptPath} send {threadId} "<revised prompt>"
    log:   node {scriptPath} result {jobId}
    cancel: node {scriptPath} cancel {jobId}
```

`{errorCode}` is the raw Codex `codexErrorInfo` variant (e.g. `ClientTimeout`, `ResponseTooManyFailedAttempts`, `ActiveTurnNotSteerable`, `Unauthorized`) — not a shortened alias. Exit codes follow the mapping in `error-recovery.md`.

`[ERROR]` can originate from the main turn **or** from an auto-pipeline sub-stage (e.g. `auto-review exceeded 300000ms` with `phase: pipeline (completed: diff)`). In the pipeline-origin case, the sync `task --json` envelope may still be `ok:true` with `result.phase: "incomplete"` and `result.pipeline.error` set — so read the envelope after Monitor self-terminates; don't assume exit-4/5/7 just because `[ERROR]` appeared.

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

### [PIPELINE:*]
```
[PIPELINE:review] HH:MM:SS
[PIPELINE:fix] HH:MM:SS
[PIPELINE:check] HH:MM:SS
[PIPELINE:diff] HH:MM:SS
```

`[PIPELINE:fix]` fires only when a structured review populated `reviewFindings` (e.g. an adversarial-review result fed back in). The default native auto-review returns plain text, so `reviewFindings` is empty and `[PIPELINE:fix]` does not appear on the normal `auto_review: true` path. See `orchestration-flows.md`.

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
