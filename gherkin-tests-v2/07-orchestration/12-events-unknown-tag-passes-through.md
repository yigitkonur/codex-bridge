# 12-events-unknown-tag-passes-through

**Derived from:** `src/codex-bridge.mjs::handleEvents` (v1.4.0 `tagOf` regex widened to `/^\[([^\]]+)\]/` to recognize unknown-shape tags), default `--exclude HEARTBEAT` contract, multi-line block inheritance rule (continuation lines inherit header decision).

**What this catches:** Forward compatibility — when a future bridge version adds a new tag like `[NETWORK-STALL]`, `[FUTURE_TAG_V15]`, or `[RETRY_2]`, orchestrators on v1.4.0 pass those through by default (exclusion-based filter) AND the tag's continuation lines travel with it (the regex recognizes the header as a header, not a continuation line). Pre-1.4.0 the narrower `[A-Za-z:]+` regex misidentified digits/underscore/hyphen tags as continuation lines, and the inclusion-based default filter silently dropped any unknown tag — the exact "nothing is happening" class of derailment.

**Runtime cost:** trivial — fixture file + one `events` invocation. No Codex.

**Test subject:** a `.events` file containing a tag outside the current vocabulary.

## Feature: unknown-shape tags reach the orchestrator under the default exclusion filter

### Background

Given the codex-bridge bundle is installed at `$SCRIPT_PATH`
And `codex-bridge version --json` reports `"version": "1.3.0"` or later

### Scenario 1: tag with digit suffix passes through `--exclude HEARTBEAT`

Given a `.events` file at `$SESSIONS_DIR/019fedcba-4321-7098-dcba-000000000002.events` containing:
```
[HEARTBEAT] 019fedcba-…-000000000002 t=1m | phase=execute | pid=1
  lastItem: (none)
[FUTURE_TAG_V15] synthetic header line
  first continuation
  second continuation
[DONE] 019fedcba-…-000000000002 completed in 2m | 0 files
  actions:
    result: node x result job-2
```
And a state.json entry links job id `task-unknown-tag-fixture` to that threadId

When I run `node $SCRIPT_PATH events task-unknown-tag-fixture --follow --exclude HEARTBEAT --timeout-ms 2000`

Then stdout contains `[FUTURE_TAG_V15] synthetic header line`
And stdout contains `  first continuation`
And stdout contains `  second continuation`
And stdout does NOT contain `[HEARTBEAT]` or its continuation line `  lastItem: (none)`
And stdout contains `[DONE] 019fedcba-`
And exit code is 0

### Scenario 2: tag with hyphen passes through

Given a `.events` file contains a `[NETWORK-STALL] simulated transient failure` block
When I run `events … --follow --exclude HEARTBEAT --timeout-ms 2000`

Then stdout contains `[NETWORK-STALL] simulated transient failure`
And the process reaches its `[DONE]` terminal line and exits 0

### Scenario 3 (regression guard): inclusion filter correctly drops unknown tags

Given the same fixture as scenario 1

When I run `node $SCRIPT_PATH events task-unknown-tag-fixture --follow --filter DONE,CHECKPOINT --timeout-ms 2000`

Then stdout does NOT contain `[FUTURE_TAG_V15]` (inclusion list doesn't include it)
And stdout does NOT contain `[HEARTBEAT]`
And stdout contains `[DONE] 019fedcba-`
And exit code is 0

### Pass / fail predicate

Pass when all three scenarios' stdout assertions hold. Scenario 1 + 2 demonstrate forward-compat (unknown tags reach orchestrator under default exclusion). Scenario 3 demonstrates explicit inclusion still works for narrow-view use cases.
