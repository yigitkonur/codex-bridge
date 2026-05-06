const DEFAULT_CONFIG = {
  mode: "plan",
  model: "gpt-5.4",
  // Default reasoning effort for execute turns. Plan turns are always forced
  // to "xhigh" regardless (plan is a bounded reasoning exercise; more effort
  // is always worth it there). For execute turns the historical default was
  // "high", but live delegations on non-trivial scaffolding (multi-file
  // ports, cross-module refactors) consistently benefited from "xhigh" —
  // the wall-clock tax is modest relative to the turn budget and the quality
  // uplift is large. "xhigh" is the new default; callers who want a cheaper
  // turn set `effort: "high"` (or lower) in config.yaml or pass
  // `--effort high` at the CLI. Accepted values: none | minimal | low |
  // medium | high | xhigh.
  effort: "xhigh",
  auto_review: true,
  post_task_prompt: [
    "Review your own work critically:",
    "1. Is this task 100% complete?",
    "2. Are there any edge cases you missed?",
    "3. Did you run all relevant tests?",
    "List any unfinished items.",
  ].join("\n"),
  allow_questions: true,
  session_dir: "~/.codex-bridge/sessions",
  // Ship with no sandbox by default so Codex can commit its own work without
  // hitting raw POSIX errors on `.git/` writes. Users who want a stricter
  // profile can set `sandbox_policy: "workspace-write"` or `"read-only"` in
  // their config.yaml. Matches `codex --dangerously-bypass-approvals-and-
  // sandbox`. See skill/references/config-reference.md for the full matrix.
  sandbox_policy: "danger-full-access",
  sandbox_enforce: false,
  forbid_codex_direct: true,
  // When true, prepend a strong orchestrator directive telling Codex to skip
  // any internal planning / ceremony / meta-skill chains it would normally
  // walk before execution (framework-agnostic — covers any skill that
  // produces spec/plan scaffolding under `docs/`, `plans/`, or similar paths
  // before touching the deliverable). Codex's default skill chains routinely
  // spend many minutes producing such scaffolding that isn't part of the
  // task when an orchestrator is already driving the plan/execute loop.
  // Advisory — Codex may still invoke its own skills; this measurably
  // reduces the rate.
  skip_meta_skills: true,
  // When true, monitor repeated same-family command failures (osascript,
  // open -a, display dialog, computer-use/*, AppleScript) and emit a
  // [WARNING] event to `.events` once the threshold (N=3 consecutive) is
  // hit. An orchestrator tailing via Monitor can catch the warning and
  // decide to cancel/steer before Codex burns token budget iterating over
  // headless-environment probes. Logging-only today; auto-interrupt would
  // require a new post-turn-start hook exposing `turnId`. See
  // config-reference.md for the threshold, family list, and enhancement
  // candidates.
  command_failure_circuit_breaker: true,
  stop_review_gate: {
    enabled: false,
    timeout_ms: 600_000,
    fast_scan_only: true,
  },
  // Max wall-clock gap between app-server notifications before a turn is
  // declared stuck and failed with `ClientTimeout`. The prior 120s hard-code
  // was tuned for execute-heavy turns and would false-positive during
  // reasoning-heavy windows (e.g. Codex planning across many files between
  // `item.completed` notifications). 300s covers observed reasoning gaps
  // without masking genuine stalls. Override per-project in config.yaml;
  // per-invocation override via `--idle-timeout-ms <ms>` on `task` / `send`.
  idle_timeout_ms: 300_000,
  // Wall-clock ceiling per Codex turn, distinct from the idle gap. Plan
  // turns get a shorter budget because they're bounded reasoning jobs;
  // execute turns need more because they actually change code. Both are
  // overridable via --turn-plan-ms / --turn-default-ms on task (or
  // --turn-timeout-ms on send, which resolves to the applicable one). Pre-
  // 1.2.5 these were hard-coded; a big scaffold that legitimately needed
  // >10 min (e.g. a multi-file Swift/Xcode bootstrap with SPM resolution)
  // hit the ceiling and Codex was interrupted mid-task.
  // v1.3.0: turn budgets are 30 min minimum on every code path.
  // Pre-1.3.0 the plan budget was 5 min and the execute budget was 10 min;
  // both routinely killed live work mid-task with Codex still actively
  // reasoning or writing (the swift-vibescroll Phase 1 / Phase 2 pattern).
  // Raising both to 30 min removes the entire class of "bridge hard-
  // interrupted my task" bug. Short edits still complete in seconds — the
  // ceiling only kicks in when Codex is genuinely still working. The
  // ceiling is not the primary "something is actually wrong" detector —
  // that's the idle watchdog (idle_timeout_ms, 5 min) and the heartbeat /
  // finally-backstop observability guarantees. The turn budget is a
  // safety net past those, not a throttle.
  turn_plan_ms: 1_800_000,
  turn_default_ms: 1_800_000,
  // Auto-pipeline budgets — per-stage (review / fix / check) and total.
  // Pre-1.2.5 both were hard-coded in auto-pipeline.mjs; long native reviews
  // on ~60-file diffs could blow the stage ceiling without any escape hatch.
  // Raise the default stage budget from the old 5-minute floor to a
  // 12-minute median-task budget; pipeline total follows at 30 minutes so
  // review + fix + check can all complete without making runaway calls
  // unbounded. Small tasks still finish as soon as their model calls return.
  pipeline_stage_ms: 720_000,
  pipeline_total_ms: 1_800_000,
  // How long `requestUserInput` waits for a human/orchestrator to answer
  // before rejecting the server request. Five minutes is tight for thoughtful
  // decisions; make it configurable so a slow loop can widen the window
  // without silently coercing the turn into a no-op answer.
  question_answer_ms: 300_000,
  artifact_retention_jobs: 50,
  artifact_retention_days: 30,
  redact_secrets: false,
  // v2.2.0 — [STALL_WARNING] fires at this wall-clock gap of zero actionable
  // progress. Default 5 min (one checkpoint interval). The terminal StallDetected
  // fires after the full STALL_CHECKPOINT_THRESHOLD × checkpoint interval (15 min
  // by default). Configurable so short-budget automation can widen or narrow the
  // early-warning window. Set to 0 to disable [STALL_WARNING] (does not affect
  // the terminal stall detector).
  stall_warning_threshold_ms: 5 * 60 * 1000,
  prompt_footer: "When you need to ask a question to user, always use the request_user_input tool with distinct options to help the user navigate choices. Never ask questions as plain text messages.",
};

export function resolveEffort(config, options = {}) {
  return options.effort ?? config.effort ?? "high";
}

export function resolveModel(config, options = {}) {
  return options.model ?? config.model ?? DEFAULT_CONFIG.model;
}

export function buildCollaborationMode(mode, config, options = {}) {
  if (!mode) {
    return null;
  }

  const effort = mode === "plan" ? "xhigh" : resolveEffort(config, options);

  return {
    mode,
    settings: {
      model: resolveModel(config, options),
      reasoning_effort: effort,
      developer_instructions: options.developerInstructions ?? null,
    },
  };
}

// Values accepted by config.sandbox_policy. `workspace-write` and `read-only`
// are the implicit defaults driven by `mode`; `danger-full-access` is a
// power-user opt-in that maps to upstream `SandboxPolicy::DangerFullAccess`
// and lifts the workspace-write restriction on `.git/` metadata (matches the
// behavior of `codex --dangerously-bypass-approvals-and-sandbox`).
const VALID_SANDBOX_POLICY_OVERRIDES = new Set([
  "danger-full-access",
  "workspace-write",
  "read-only",
]);

export function buildSandboxPolicy(mode, config = {}) {
  const override = config?.sandbox_policy;
  if (override != null && !VALID_SANDBOX_POLICY_OVERRIDES.has(override)) {
    // Unknown override silently falls back to the mode-derived default below —
    // a typo in config.yaml should never widen permissions.
  } else if (override === "danger-full-access") {
    return { type: "dangerFullAccess" };
  } else if (override === "workspace-write") {
    return { type: "workspaceWrite" };
  } else if (override === "read-only") {
    return { type: "readOnly" };
  }

  // Mode-derived defaults. Only the two recognized modes opt into write
  // access; unknown values default to the safest policy.
  if (mode === "default") {
    return { type: "workspaceWrite" };
  }
  return { type: "readOnly" };
}

export const COMPLETION_CHECK_SCHEMA = {
  type: "object",
  properties: {
    complete: { type: "boolean" },
    missing_items: {
      type: "array",
      items: { type: "string" },
    },
    summary: { type: "string" },
  },
  required: ["complete", "missing_items", "summary"],
  additionalProperties: false,
};

export { DEFAULT_CONFIG };
