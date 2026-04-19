# XX-turn-timeout-configurable

**Derived from:** `src/lib/config.mjs::DEFAULT_CONFIG` adds `turn_plan_ms`, `turn_default_ms`, `pipeline_stage_ms`, `pipeline_total_ms`, `question_answer_ms`; `src/codex-bridge.mjs::runBridgeTask` resolves `turnTimeoutMs` as `request.turnPlanMs|turnDefaultMs → config.turn_* → built-in default`; `handleTask` plumbs `--turn-plan-ms` / `--turn-default-ms` / `--pipeline-stage-timeout-ms` / `--pipeline-total-timeout-ms` / `--question-timeout-ms` flags through `buildTaskRequest`; `handleSend` has a single `--turn-timeout-ms` that maps onto the applicable bucket; `parsePositiveMsOption` throws `usage` (exit 2) for malformed values.
**What this catches:** (a) Each new CLI flag validates positive-integer input at the usage boundary. (b) Malformed values fail fast before any Codex turn is billed. (c) Synopses advertise the new flags.
**Runtime cost:** fast; all scenarios are smokeable.

## Feature: turn / pipeline / question timeouts are configurable

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

### Scenario 1: every new flag rejects malformed values with usage/exit 2

For each flag in `--turn-plan-ms`, `--turn-default-ms`, `--pipeline-stage-timeout-ms`, `--pipeline-total-timeout-ms`, `--question-timeout-ms` on `task`:

Given I invoke `bridge task <flag> notanumber "x" 2>&1`
Then the output contains `<flag> must be a positive number of milliseconds`
And the exit code is `2`
And no Codex turn is started

And for `bridge task <flag> 0 "x"` and `bridge task <flag> -1 "x"`
Then the same usage error is produced (zero and negative are rejected)

And for `bridge send <threadId> --turn-timeout-ms notanumber "x"`
Then the same validation error shape is produced for `--turn-timeout-ms`

### Scenario 2: synopsis advertises every new flag

Given I run `bridge task --help | head -1` and `bridge send --help | head -1`
When I scan the synopsis
Then `bridge task` synopsis mentions: `--turn-plan-ms`, `--turn-default-ms`, `--pipeline-stage-timeout-ms`, `--pipeline-total-timeout-ms`, `--question-timeout-ms`
And `bridge send` synopsis mentions: `--turn-timeout-ms`, `--question-timeout-ms`
(`--idle-timeout-ms` is already there from 1.2.4.)

### Scenario 3: DEFAULT_CONFIG surfaces every new key via config show

Given I run `bridge config show 2>&1` (non-JSON; reads the effective config)
Then the output mentions `turn_plan_ms`, `turn_default_ms`, `pipeline_stage_ms`, `pipeline_total_ms`, `question_answer_ms` (one line each, with the resolved value)

### Scenario 4: live turn timeout actually fires (requires Codex)

Given Codex is authenticated
When I launch `bridge task --write --mode default --turn-default-ms 3000 --no-pipeline "run: sleep 10; echo done" --json`
Then the envelope has `ok: false` with an error whose `.code` indicates a turn-level timeout
And the `.events` file contains `[ERROR] … | ClientTimeout` (or similar class-`timeout` code)
And the exit code is `7`

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }

FLAGS=( --turn-plan-ms --turn-default-ms --pipeline-stage-timeout-ms --pipeline-total-timeout-ms --question-timeout-ms )
s1_pass=true
for f in "${FLAGS[@]}"; do
  out=$(bridge task "$f" notanumber "x" 2>&1); rc=$?
  if ! echo "$out" | grep -qE "${f} must be a positive number" || [ "$rc" -ne 2 ]; then
    s1_pass=false; break
  fi
done
$s1_pass && echo "s1 PASS" || echo "s1 FAIL"

syn_task=$(bridge task --help | head -1)
for f in --turn-plan-ms --turn-default-ms --pipeline-stage-timeout-ms --pipeline-total-timeout-ms --question-timeout-ms; do
  echo "$syn_task" | grep -q -- "$f" || { echo "s2 FAIL (task: missing $f)"; exit 1; }
done
syn_send=$(bridge send --help | head -1)
for f in --turn-timeout-ms --question-timeout-ms; do
  echo "$syn_send" | grep -q -- "$f" || { echo "s2 FAIL (send: missing $f)"; exit 1; }
done
echo "s2 PASS"

cfg=$(bridge config show 2>&1)
for k in turn_plan_ms turn_default_ms pipeline_stage_ms pipeline_total_ms question_answer_ms; do
  echo "$cfg" | grep -q "$k" || { echo "s3 FAIL (missing $k)"; exit 1; }
done
echo "s3 PASS"
```

### Enhancement candidates

- The per-flag-malformed-value test is noisy. A shared `parsePositiveMsOption` test in a JS unit runner would be leaner.
- If future timeouts are added, mirror the CLI flag / config key / validator pattern and add a scenario row here.
