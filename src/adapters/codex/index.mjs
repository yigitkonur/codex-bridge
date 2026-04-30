// Codex backend adapter — Phase A skeleton.
//
// Real implementations land in:
//   T2 — protocol (src/adapters/codex/protocol.mjs, broker.mjs)
//   T3 — dispatch + events (dispatch.mjs, events.mjs)
//   T4 — error mapper + pipeline (error-mapper.mjs, pipeline.mjs)
//
// Currently this exports only the BackendAdapter shell + capability
// declaration. Lifecycle methods throw NOT_IMPLEMENTED until later
// Phase 0 tasks complete. The bridge handlers continue to call
// src/lib/codex.mjs directly during Phase 0; the swap-in to
// selectAdapter() lands in T5.

const NOT_IMPLEMENTED = (verb) => () => {
  const err = new Error(
    `codex adapter '${verb}' not implemented yet (lands in T2-T5; bridge currently calls src/lib/codex.mjs directly)`,
  );
  err.code = "NOT_IMPLEMENTED";
  throw err;
};

const adapter = {
  name: "codex",
  displayName: "OpenAI Codex",
  capabilities() {
    return Object.freeze({
      supports_plan_mode:           true,
      supports_questions:           true,
      supports_streaming:           true,
      supports_resume:              true,
      supports_steering:            true,
      supports_background:          true,
      supports_auto_pipeline:       true,
      supports_adversarial_review:  true,
      supports_worktree:            true,
      supports_artifact_registry:   true,
      input_modalities:             ["text"],
      output_modalities:            ["text", "diff", "structured"],
      max_prompt_chars:             512000,
      billing_model:                "subscription",
      auth_strategy:                "oauth-cli",
      transport:                    "json-rpc-unix-socket",
    });
  },
  validateConfig(_config) {
    return { valid: true, errors: [] };
  },
  dispatch:     NOT_IMPLEMENTED("dispatch"),
  streamEvents: NOT_IMPLEMENTED("streamEvents"),
  getResult:    NOT_IMPLEMENTED("getResult"),
  cancel:       NOT_IMPLEMENTED("cancel"),
};

export default adapter;
