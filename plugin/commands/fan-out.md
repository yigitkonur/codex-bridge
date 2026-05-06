---
description: Dispatch N parallel codex-bridge tasks in a group via direct Bash
argument-hint: "--group <name> [--prompt 'text' | --brief @<path>] [--read-only|--write] [--model <model>] [--effort <effort>]"
allowed-tools: Bash(node:*)
---

# /codex-bridge:fan-out

Use this for parallel dispatch when N >= 2. It invokes the bundled bridge
directly from Bash instead of routing through the
`codex-bridge:codex-bridge-runner` subagent.

Raw user request:
$ARGUMENTS

Run this Bash body exactly once:

```bash
set -u

GROUP=""
PROMPTS=()
BRIEFS=()
COMMON_FLAGS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --group)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "ERROR: --group <name> required" >&2
        exit 2
      fi
      GROUP="$2"
      shift 2
      ;;
    --prompt)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "ERROR: --prompt <text> requires a non-empty value" >&2
        exit 2
      fi
      PROMPTS+=("$2")
      shift 2
      ;;
    --brief)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "ERROR: --brief @<path> requires a non-empty value" >&2
        exit 2
      fi
      BRIEFS+=("$2")
      shift 2
      ;;
    --backend|--mode|--model|-m|--effort|--cwd|--turn-default-ms|--turn-plan-ms|--pipeline-stage-timeout-ms|--pipeline-total-timeout-ms|--question-timeout-ms|--idle-timeout-ms)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "ERROR: $1 requires a value" >&2
        exit 2
      fi
      COMMON_FLAGS+=("$1" "$2")
      shift 2
      ;;
    *)
      COMMON_FLAGS+=("$1")
      shift
      ;;
  esac
done

if [ -z "$GROUP" ]; then
  echo "ERROR: --group <name> required" >&2
  exit 2
fi

if [ "${#PROMPTS[@]}" -eq 0 ] && [ "${#BRIEFS[@]}" -eq 0 ]; then
  echo "ERROR: at least one --prompt or --brief is required" >&2
  exit 2
fi

BRIDGE="${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs"
JOB_IDS=()
FAILED=0

extract_job_id() {
  node -e 'const fs = require("node:fs"); const input = fs.readFileSync(0, "utf8"); const payload = JSON.parse(input); process.stdout.write(payload?.result?.jobId ?? "");'
}

for prompt in "${PROMPTS[@]}"; do
  if RESULT=$(node "$BRIDGE" task --background --json --group "$GROUP" "${COMMON_FLAGS[@]}" "$prompt"); then
    JOB_ID=$(printf '%s' "$RESULT" | extract_job_id)
    if [ -n "$JOB_ID" ]; then
      JOB_IDS+=("$JOB_ID")
      echo "Dispatched: $JOB_ID -> \"${prompt:0:80}\""
    else
      FAILED=$((FAILED + 1))
      echo "FAILED: dispatch returned no jobId for prompt \"${prompt:0:80}\"" >&2
    fi
  else
    FAILED=$((FAILED + 1))
    echo "FAILED: prompt \"${prompt:0:80}\"" >&2
  fi
done

for brief in "${BRIEFS[@]}"; do
  if RESULT=$(node "$BRIDGE" task --background --json --group "$GROUP" --brief "$brief" "${COMMON_FLAGS[@]}" "Implement the task described in the brief."); then
    JOB_ID=$(printf '%s' "$RESULT" | extract_job_id)
    if [ -n "$JOB_ID" ]; then
      JOB_IDS+=("$JOB_ID")
      echo "Dispatched: $JOB_ID -> brief $brief"
    else
      FAILED=$((FAILED + 1))
      echo "FAILED: dispatch returned no jobId for brief $brief" >&2
    fi
  else
    FAILED=$((FAILED + 1))
    echo "FAILED: brief $brief" >&2
  fi
done

echo ""
echo "Dispatched ${#JOB_IDS[@]} jobs in group $GROUP."
if [ "${#JOB_IDS[@]}" -gt 0 ]; then
  printf 'Job IDs:'
  printf ' %s' "${JOB_IDS[@]}"
  printf '\n'
fi
echo "Track with: /codex-bridge:status --group $GROUP"
echo "Wait for: /codex-bridge:wait --group $GROUP --all"

if [ "$FAILED" -gt 0 ]; then
  echo "Failed dispatches: $FAILED" >&2
  exit 8
fi
```

Pass the raw user request as shell arguments to the Bash body so quoted prompt
text remains one `--prompt` value. Return the Bash output verbatim.
