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
    detail: node {scriptPath} result
```

`send`/`steer` take **thread** ids. `result`/`cancel`/`status` take **job** ids — run them with no id to pick the latest job in the current session.

### [ERROR]
```
[ERROR] {threadId} failed | {errorCode}
  {errorMessage}
  phase: {currentPhase}
  actions:
    retry: node {scriptPath} send {threadId} "<revised prompt>"
    log:   node {scriptPath} result
    cancel: node {scriptPath} cancel
```

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
    detail: node {scriptPath} result
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

### [REVIEW] (standalone review only)
```
[REVIEW] {threadId} verdict: {verdict} | {findingCount} findings
  [{severity}] {title} — {file}:{lineStart}
  full: {reviewFilePath}
  actions:
    fix: node {scriptPath} task --write "fix the {n} review findings"
```

### [PHASE] (optional, progress preset)
```
[PHASE] editing src/auth.ts
[PHASE] running: npm test
```
