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
  failing_stage: {stage}           # only on pipeline origins; matches the failed pipeline stage
  upstream_request_id: {uuid}      # v1.5.0+; only when the upstream error message carried a `request id: <uuid>` correlation handle
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
| `upstream:response-chain-lost` (v1.5.0) | Upstream 400 `previous_response_not_found`. The resp_id is dead; same-thread `send` repeats the 400 forever. Recovery requires a fresh task on committed state. Retry policy `new-thread / maxAttempts: 1`; goes straight to `[HANDOFF]`. |
| `upstream:auth` (v1.5.0) | Upstream 401 Unauthorized (direct Codex auth or proxy-layer). Deterministic; no retry policy will help. Policy `none / maxAttempts: 0`. `[HANDOFF]` precedes `[ERROR]` immediately. |
| `upstream:invalid-request` (v1.5.0) | Upstream 400 `invalid_request_error` not covered by the more specific `response-chain-lost` matcher. Some proxy-layer 400s are transient; retry policy `same-thread / maxAttempts: 3 / backoffMs: [2000, 5000, 12000]` before surfacing. |
| `turn` | Every other turn-level failure: `ContextWindowExceeded`, `Unauthorized`, `SandboxError`, generic turn-budget exhaustion, etc. Distinguish by `{errorCode}`. |
| `pipeline:<stage>` | Auto-pipeline sub-stage failure. `<stage>` matches `failing_stage`; `PIPELINE_ERROR.lastCompletedStage` records prior progress. |
| `bridge` | Bridge-layer safety net tripped. The emitted token is the bare string `bridge` (no `bridge:stall` / `bridge:unhandled-exit` sub-tokens — distinguish those two sub-cases by `{errorCode}`: `StallDetected` vs `UnhandledExit`). Indicates a bridge bug; treat as a bug report. |

The NDJSON counterparts (`ERROR`, `PIPELINE_ERROR`) carry `data.origin` with the same values plus `data.failing_stage` when applicable. `PIPELINE_ERROR` also carries `lastCompletedStage`; review verdict/count fields are `null` unless the review stage completed.

`[ERROR]` can originate from the main turn **or** from an auto-pipeline sub-stage (e.g. `auto-review exceeded 5m` with `origin: pipeline:review` + `failing_stage: review` + `phase: pipeline (completed: diff)`). In the pipeline-origin case, the sync `task --json` envelope may still be `ok:true` with `result.phase: "incomplete"` and `result.pipeline.error` set — read the envelope after Monitor self-terminates; don't assume exit-4/5/7 just because `[ERROR]` appeared. Branch on `origin: turn` vs `origin: pipeline:*` vs `origin: upstream:*` in tooling.

The `actions:` block is **cause-aware**: an idle-timeout `[ERROR]` suggests `relaunch: … --idle-timeout-ms 900000 …`, a compact-proxy 502 suggests narrowing required-reads + a shorter follow-up `send`, a pipeline sub-stage failure points at `rerun-review` rather than retrying the whole task, and so on. Every block ends with a `see:` line deep-linking into `skill/references/error-recovery.md` for the full recipe.

### [PARTIAL] (v1.5.0, non-terminal — pairs with [ERROR] / [HANDOFF])
```
[PARTIAL] {threadId} commits=[{sha1},{sha2}]
  current_head: {sha}
  last_ok_head: {snapshotSha}
  launched_at: {iso}
  dirty:
    - M src/foo.ts
  inspect: node {scriptPath} result {jobId}
```

Emitted **before** the terminal `[ERROR]` (and `[HANDOFF]` when present) whenever one or more commits landed during the failed turn. The bridge captures a git snapshot at the turn's start and diffs against it on any terminal failure path; a non-empty commit list means real work survived the error.

Non-terminal by itself — `[ERROR]` stays the tag that trips Monitor's self-termination (see `TERMINAL_TAG_REGEX`). The JSON envelope carries the same payload under `error.partial.{commits, currentHeadSha, lastOkHeadSha, dirtyFiles, launchedAtIso}`, so consumers reading the envelope don't need to parse `.events`. See `orchestration-flows.md#recovering-from-upstream-state-loss` for the consumer recipe.

Matching NDJSON tag: `PARTIAL`.

### [RETRYING] (v1.5.0, non-terminal)
```
[RETRYING] {threadId} attempt {n}/{max} | origin={origin} | strategy={same-thread|new-thread} | backoff={ms}ms
  last_error: {errorCode}
  reason: {truncatedErrorMessage}
```

Emitted before the bridge sleeps through a backoff window and reattempts the turn on an `upstream:*` failure with a retryable policy. See `UPSTREAM_RETRY_POLICY` in `src/lib/cli-errors.mjs` for the per-origin table (`upstream:transport` → 3 attempts; `upstream:compact-proxy` → 2 attempts; `upstream:invalid-request` → 3 attempts; `upstream:response-chain-lost` → 1 attempt new-thread; `upstream:auth` → 0 attempts).

Non-terminal: Monitor does **not** self-terminate on `[RETRYING]`. A reader that sees `[RETRYING] 1/3 …` can expect up to two more retry blocks before the final `[ERROR]` / `[HANDOFF]` pair.

Matching NDJSON tag: `RETRYING`.

### [HANDOFF] (v1.5.0, precedes [ERROR])
```
[HANDOFF] {threadId} reason={upstream-retry-exhausted|upstream-auth-requires-reauth} | origin={origin} | code={errorCode}
  upstream_request_id: {uuid}
  job_id: {jobId}
  thread_id: {threadId}
  artifacts:
    events: {eventsPath}
    worker_err: {workerErrPath}
    diff: {diffPath}
    plan: {planPath}
    review: {reviewPath}
  partial: commits=[{shas}] head={sha} since={iso}
  prompt_file: {path-if-prompt-file-used}
  retries: {N} attempts logged
  next:
    read:     node {scriptPath} result {jobId} --json    # full handoff envelope under .error.handoff
    audit:    git log --oneline {lastOkHeadSha}..HEAD
    relaunch: node {scriptPath} task --json --mode default --prompt-file <rebased prompt>
    see: skill/references/orchestration-flows.md#recovering-from-upstream-state-loss
```

Emitted when the `UPSTREAM_RETRY_POLICY` loop exhausts its budget, or immediately for origins whose policy is `strategy: none` (today: `upstream:auth`). The block renders the handoff envelope as a human-readable summary; the same data lives under `error.handoff` in the JSON envelope. Pairs with `[ERROR]` — **`[HANDOFF]` comes first so the existing `TERMINAL_TAG_REGEX` still trips on `[ERROR]`**.

Envelope shape (JSON):
```json
{
  "ok": false,
  "error": {
    "class": "dependency_failed",
    "code": "PreviousResponseNotFound",
    "message": "…",
    "retryable": true,
    "upstream_request_id": "e42f5508-…",
    "partial": { "commits": ["abc","def"], "currentHeadSha": "…", "lastOkHeadSha": "…", "dirtyFiles": [], "launchedAtIso": "…" },
    "handoff": {
      "schema_version": "1.0",
      "reason": "upstream-retry-exhausted",
      "origin": "upstream:response-chain-lost",
      "errorCode": "PreviousResponseNotFound",
      "errorMessage": "…",
      "upstream_request_id": "e42f5508-…",
      "session": { "jobId": "task-abc", "threadId": "019d…", "sessionId": "019d…" },
      "artifacts": { "eventsPath": "…", "workerErrPath": "…", "diffPath": "…", "planPath": "…", "reviewPath": "…" },
      "partial": { "commits": ["abc","def"], … },
      "prompt": { "original": "…", "promptFilePath": "…", "resumeSuggestion": "…" },
      "retries": [{ "attemptIso": "…", "origin": "…", "errorCode": "…", "backoffMs": 2000, "outcome": "failed" }]
    }
  }
}
```

Matching NDJSON tag: `HANDOFF`. Monitor does **not** exclude `[HANDOFF]` by default.

### [WARNING]
```
[WARNING] {threadId} {reason}
  family: {family}
  threshold: {N} consecutive failures
  sample: {truncatedCommand}
  turnInterrupted: {yes|no}
```

Emitted when `command_failure_circuit_breaker: true` (shipped default) detects `N=3` consecutive same-family command failures. `{family}` is one of `osascript`, `applescript-dialog`, `applescript-system`, `open-app`, `computer-use`. `{reason}` is `command-family-circuit-breaker-tripped`. `turnInterrupted: no` today — logging-only (see `config-reference.md#command_failure_circuit_breaker`). Monitor picks this up as non-terminal: `[WARNING]` does **not** self-terminate a following `events --follow` stream; the orchestrator decides whether to `cancel` or `send` a steer based on the family. Counter resets on the next turn and on any successful command. Matching NDJSON tag: `CIRCUIT_BREAKER`.

### [BRANCH_SWITCHED]
```
[BRANCH_SWITCHED] {threadId} | working-tree branch changed during task
  jobId: {jobId}
  before: {branch}
  after: {branch}
  detected_at: {stage}
  recommendation: inspect current branch and task diff before continuing; earlier operations may have used a different baseline
```

Emitted when the bridge samples the task cwd's current branch and sees it changed since the previous sample. This is non-terminal: the bridge surfaces the shared-checkout hazard but does not fail the task because an external session or manual git operation may be responsible. Matching NDJSON tag: `BRANCH_SWITCHED`.

### [HEARTBEAT]
```
[HEARTBEAT] {threadId} t={elapsed} | phase={plan|execute} | pid={pid}
  lastItem: {itemType} (age {ageSeconds})
  budget: {remaining} remaining
  tail: node {scriptPath} events {jobId} --follow --exclude HEARTBEAT,DIRECTIVES,CHECKPOINT --timeout-ms 1800000
```

Emitted every 60 s (override via `CODEX_BRIDGE_HEARTBEAT_MS` env) during any running turn — the unconditional liveness pulse introduced in 1.3.0. Non-terminal: `events --follow` does **not** self-terminate on `[HEARTBEAT]`. Monitor's default filter excludes `HEARTBEAT`, startup/runtime `DIRECTIVES`, and verbose `CHECKPOINT` (see `DEFAULT_MONITOR_EXCLUDE` in `src/lib/session-log.mjs`) so pure-liveness pulses, startup/runtime echoes, and rich checkpoint bodies don't flood LLM context; omit the default exclude to see every event including the pulse, or pass `--filter HEARTBEAT` for a heartbeat-only view.

Purpose: if `[HEARTBEAT]` lines stop arriving, the bridge wrapper process is not alive — the caller can short-circuit their wait and investigate (`kill -0 <pid>` on the heartbeat's `pid`, or `pgrep -f codex-bridge`). The `tail:` line in each block is a ready-to-paste re-attach command so an agent that lost its Monitor session can recover from the most recent events-file line alone.

### [CHECKPOINT_SUMMARY]
```
[CHECKPOINT_SUMMARY] {threadId} t={elapsed} | phase={plan|execute|?} | interval={duration} | pid={pid|?} | tools={N} ({breakdown}) | focus={paths} | last="{last action}"
```

Emitted immediately before a verbose `[CHECKPOINT]` whenever the checkpoint interval has content. This is the default-visible Monitor progress signal: one line, enough to see phase, recent tool volume, likely file focus, and the last meaningful action without streaming the full assistant/tool/diff body.

### [CHECKPOINT]
```
[CHECKPOINT] {threadId} t={elapsed} | phase={plan|execute|?} | interval={formattedDuration} | pid={pid|?}
  assistant:                                         # OR "assistant: (no new assistant message this interval)" when none
    {fullAssistantText capped at 8000 chars; truncated tail gets "… (truncated, N more chars)"}
  tools (N):                                         # always present; "(none)" when N=0
    - {type}: {summary}
  commits (N):                                       # only when commits non-empty
    - {sha} {subject}
  diff-since-last-checkpoint: {diffStat}             # only when diffStat truthy
  files-changed-since-turn-start: {summary}          # only when truthy
  tail: node {scriptPath} events {jobId} --follow --exclude HEARTBEAT,DIRECTIVES,CHECKPOINT --timeout-ms 1800000   # only when scriptPath + jobId both present
```

Both `t={elapsed}` and `interval={…}` render through the same duration formatter (`fmtSeconds`) — short windows show as `Xs`, longer ones as `Xm` or `XmYYs`, never as raw milliseconds.

Checked every `CODEX_BRIDGE_CHECKPOINT_MS` (default 5 min — env override) alongside the 60-s `[HEARTBEAT]`, but checkpoint events are only **written** for intervals that have something worth surfacing (an actionable item, a new assistant message, or a git delta). If an interval has no actionable items, no assistant message, and no diff, the bridge skips checkpoint emission entirely — consumers should not assume one block per interval. Non-terminal; `events --follow` does **not** self-terminate on `[CHECKPOINT]`. Monitor's default filter excludes verbose `[CHECKPOINT]` but keeps `[CHECKPOINT_SUMMARY]`; use `--exclude HEARTBEAT` when debugging and you need the full body. The assistant block is capped at 8000 chars per checkpoint; overflow gets a `… (truncated, N more chars)` tail.

The stall detector (`CODEX_BRIDGE_STALL_CHECKPOINTS`, default 3) counts consecutive **barren** checkpoint windows (zero actionable items — `commandExecution` / `fileChange` / `plan`). Barren windows before the terminal threshold emit `[STALL_WARNING]`; the threshold hit fires `[ERROR] | StallDetected`. **Grace period:** the barren counter only starts incrementing after the first actionable item lands; a turn that's still in its initial reasoning window won't trip the detector. Default terminal stall window therefore = `CHECKPOINT_MS × STALL_CHECKPOINTS` once Codex has produced at least one actionable item.

### [STALL_WARNING]
```
[STALL_WARNING] {threadId} t={elapsed} | phase={plan|execute|?} | no actionable progress for {N} checkpoint(s)
  warning_threshold: {duration}
  terminal_threshold: {duration}
  remaining_until_terminal: {duration}
  last_actionable: {summary} ({age} ago)
  recommendation: inspect the events file, steer the thread, or cancel before terminal stall.
```

Emitted for each barren checkpoint window after Codex has already produced one actionable item, until terminal `[ERROR] | StallDetected` fires. Non-terminal: `events --follow` does **not** self-terminate on `[STALL_WARNING]`. Matching NDJSON tag: `STALL_WARNING`.

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
  [other: custom answer allowed]                     # only when q.isOther
respond:                                             # ONE respond line per option (pre-filled with the option's literal label):
  node {scriptPath} respond {requestId} --question-id {qId} --answer "{labelA}"
  node {scriptPath} respond {requestId} --question-id {qId} --answer "{labelB}"
```

Free-form variant (no enumerated options): a single `respond:` line with `--answer "<answer>"` placeholder. Multi-question payloads iterate under a single `[QUESTION]` header — each question contributes its own option list and `respond:` fanout in sequence.

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
[DIRECTIVES] {threadId} | mode={plan|default} | effort={none|minimal|low|medium|high|xhigh} | sandbox={readOnly|workspaceWrite|dangerFullAccess} [| approval={never|on-request|on-failure|untrusted}] | quiet={true|false} | skip_meta_skills={true|false} | pipeline={diff,review,fix,check|diff|none} [| model={model}] [| models={stage:model,...}] [| warnings={n}]
```

Emitted once per turn at `turn/started`, before any `[HEARTBEAT]` / `[CHECKPOINT]` cadence. Surfaces the **effective** runtime config — what the bridge actually resolved after merging CLI flags, `config.yaml`, and built-in defaults. Resolves the invisible-directive problem for keys like `skip_meta_skills` that shape the prompt but otherwise emit nothing observable. Non-terminal.

`pipeline=` reflects the enabled auto-pipeline stages for this turn (`diff`, `review`, `fix`, `check`, or a comma-joined subset). `pipeline=diff` means `--no-pipeline` kept diff capture while skipping review/fix/check; `pipeline=none` means this is a plan-only turn or the config disabled both validation stages and no per-run skip requested diff capture. `models=` lists resolved per-stage models such as `assistant:gpt-5.5-codex,plan:gpt-5.5-codex`; `warnings=` is a count of runtime-resolution warnings carried in the JSON envelope's `result.runtime.warnings`. The bracketed segments (`approval=`, `model=`, `models=`, `warnings=`) appear in their fixed slots only when set — parse as `key=value` pairs split on ` | ` rather than positional indexing so future optional keys don't break consumers.

### [PIPELINE:*] — Auto-pipeline stage progress

Every pipeline stage emits both a **start tag** and a matching **`:done`** tag so an orchestrator tailing `events --filter PIPELINE` can tell exactly when each stage stops writing to the repo. Pre-1.2.5 only start tags existed, forcing agents to guess when the pipeline was hands-off.

```
[PIPELINE:diff] HH:MM:SS                           # stage start
[PIPELINE:diff:done] HH:MM:SS 2 files | +23 -5     # stage end (:done pair)
[PIPELINE:diff:large_change] HH:MM:SS class=destructive reason="1001 lines deleted (threshold 1000)" files=4 additions=0 deletions=1001 paused=true
[PIPELINE:diff:approved] HH:MM:SS class=destructive reason="1001 lines deleted (threshold 1000)" files=4 additions=0 deletions=1001

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
[PIPELINE:failed] HH:MM:SS failing_stage=review last_completed=diff stages=diff touched=0
```

After `[PIPELINE:done]` / `[PIPELINE:failed]`, no further bridge-side writes are coming to the workspace — safe for the orchestrator to commit / inspect. The `touched=N` summary is the count of files in `[PIPELINE:fix:done] files=[…]`; on `task --json` it's also available as `result.pipeline.touchedFiles`.

`[PIPELINE:fix]` only fires when a structured review populated `reviewFindings` (e.g. an adversarial-review result fed back in). The default native auto-review returns plain text, so `reviewFindings` is empty and `[PIPELINE:fix]` does not appear on the normal `auto_review: true` path. Even then, `[PIPELINE:review:done]` still appears with `findings=0`. See `orchestration-flows.md` for lifecycle.

`[PIPELINE:diff:large_change]` fires before review/fix/check when the task-base diff exceeds `destructive_diff_lines_deleted` or `destructive_diff_files_changed`. With the shipped `destructive_diff_mode: "pause"`, the next block is a `[QUESTION]`; answer `Approve` to continue or `Reject` to return `[INCOMPLETE]`.

`--no-pipeline` on `task` keeps `[PIPELINE:diff]`, `[PIPELINE:diff:done]`, and `[PIPELINE:done]` so the run still captures a task diff, then skips review/fix/check. The ndjson log carries a `PIPELINE_SKIPPED` entry naming the skipped validation stages.

### [REVIEW] (reserved — not emitted by the current build)
```
[REVIEW] {threadId} verdict: {verdict} | {findingCount} findings
  [{severity}] {title} — {file}:{lineStart}
  full: {reviewFilePath}
  actions:
    fix: node {scriptPath} task --write "fix the {n} review findings"
```
`formatReviewEvent` is defined in `src/lib/session-log.mjs` but has zero call sites; the `[REVIEW]` tag never appears on `.events`. Don't gate Monitor scripts on it. Note: `writeReview` **is** called from the adversarial-review path (`src/codex-bridge.mjs`), so `{threadId}.review.json` lands on disk after a structured `adversarial-review` run — but the auto-pipeline review stage still does not call `writeReview`, so that artifact is absent on the auto-pipeline path even when `[PIPELINE:review:done]` fires.

### [PHASE] (reserved — not emitted by the current build)
```
[PHASE] editing src/auth.ts
[PHASE] running: npm test
```
`formatPhaseEvent` is defined but has no caller. Monitor scripts should not expect `[PHASE]` lines.
