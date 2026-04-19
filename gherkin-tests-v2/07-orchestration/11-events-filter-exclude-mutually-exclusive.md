# 11-events-filter-exclude-mutually-exclusive

**Derived from:** `src/codex-bridge.mjs::handleEvents` (v1.4.0 mutual-exclusion guard — `throw usageError(...)` if both `options.filter` and `options.exclude` are set before any file read or job resolution).

**What this catches:** The CLI contract that `--filter` and `--exclude` cannot be combined in one invocation. Ensures an orchestrator that accidentally supplies both gets a clear exit-2 `USAGE_ERROR` with a specific message, instead of silent surprise behavior (e.g. one flag winning by code order, or both being applied simultaneously).

**Runtime cost:** trivial — the usage-error check fires before any resolveResultJob or file read. No Codex involvement.

**Test subject:** any argv combination that sets both flags.

## Feature: passing both `--filter` and `--exclude` exits `2 USAGE_ERROR`

### Background

Given the codex-bridge bundle is installed at `$SCRIPT_PATH`
And `codex-bridge version --json` reports `"version": "1.3.0"` or later

### Scenario 1: both flags, arbitrary values

When I run `node $SCRIPT_PATH events bogus-id --filter DONE --exclude HEARTBEAT`

Then the process exits 2
And stderr contains the substring `--filter OR --exclude, not both`
And no `.events` file read is attempted (the error fires before file access)

### Scenario 2: both flags with --follow and --json

When I run `node $SCRIPT_PATH events bogus-id --follow --filter PIPELINE --exclude HEARTBEAT --timeout-ms 5000 --json`

Then the process exits 2
And stdout contains a JSON error envelope with `"class": "usage"`, `"code": "USAGE_ERROR"`
And the message field references `--filter` and `--exclude`

### Pass / fail predicate

Pass when both scenarios exit 2 and the error message is present. Fail on any exit code other than 2, on a missing or wrong error message, or on evidence the command read the events file before erroring.
