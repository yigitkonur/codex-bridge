# Adapter Runtime Notes

**Updated:** 2026-05-05

## Current Runtime

The active runtime backend is Codex only. `src/adapters/index.mjs` loads
`codex` from `src/adapters/codex/index.mjs`; no other backend is registered in
`ADAPTER_LOADERS`. Future backend notes are planning material, not source
surfaces.

The Codex adapter currently exposes these capabilities through
`version --json::result.adapter_capabilities` and task metadata:

- `supports_plan_mode`, `supports_questions`, `supports_streaming`,
  `supports_resume`, `supports_steering`, `supports_background`,
  `supports_auto_pipeline`, `supports_adversarial_review`,
  `supports_worktree`, and `supports_artifact_registry` are all `true`.
- `input_modalities` is `["text"]`.
- `output_modalities` is `["text", "diff", "structured"]`.
- `max_prompt_chars` is `512000`.
- `billing_model` is `subscription`.
- `auth_strategy` is `oauth-cli`.
- `transport` is `json-rpc-unix-socket`.

## Adapter Contract

`src/adapters/index.d.ts` is the typed contract. A backend adapter must expose
identity fields, `capabilities()`, `validateConfig(config)`, and the required
lifecycle methods `dispatch`, `streamEvents`, `getResult`, and `cancel`.

Optional methods are guarded by capability flags:

| Capability | Required method when true |
|---|---|
| `supports_questions` | `respond` |
| `supports_resume` | `resume` |
| `supports_steering` | `steer` |

`loadAdapter(name)` validates this shape and throws `BACKEND_INCAPABLE` when a
backend is unknown or over-declares a capability. Under-declare until the method
exists and is tested.

## Adapter Resolution

`selectAdapter(options)` resolves the backend from highest to lowest precedence:

1. `--backend <name>`
2. `CODEX_BRIDGE_BACKEND`
3. task metadata backend for job-bound commands
4. cwd config `adapter_routing[<subagent_type>].backend`
5. workspace-root config `adapter_routing[<subagent_type>].backend`
6. user config `adapter_routing[<subagent_type>].backend`
7. cwd config `default_backend`
8. workspace-root config `default_backend`
9. user config `default_backend`
10. built-in default `codex`

Only schema-known, schema-valid config keys enter the effective config.

## Event Vocabulary

Adapters and bridge code emit tagged events. Unknown tags should pass through
unless explicitly filtered.

Terminal tags:

- `[DONE]` - successful task completion, `phase=done`.
- `[ERROR]` - task or pipeline failure. Some pipeline failures produce an
  `ok:true` task envelope with `result.phase="incomplete"`; read `origin`,
  `failing_stage`, and the JSON envelope before retrying.
- `[INCOMPLETE]` - partial completion with artifacts present.
- `[PLAN]` - plan-mode stopped for approval and is terminal for `wait`.

Interrupt and progress tags:

- `[QUESTION]` - backend is waiting for `respond`.
- `[CONFIRMED]` - question response was accepted.
- `[CHECKPOINT]` - periodic state snapshot.
- `[HEARTBEAT]` - liveness pulse, excluded from the default Monitor command.
- `[WARNING]` - non-fatal anomaly.

Pipeline tags:

- `[PIPELINE:<stage>]` and `[PIPELINE:<stage>:done]` for `diff`, `review`,
  `fix`, and `check`.
- `[PIPELINE:review:failed]`, `[PIPELINE:check:failed]`,
  `[PIPELINE:done]`, and `[PIPELINE:failed]`.

Recovery and bootstrap tags:

- `[RETRYING]`, `[PARTIAL]`, `[HANDOFF]`, and `[DIRECTIVES]`.

Backend-specific tags must use `[ADAPTER:<name>:<event>]` and must not reuse a
canonical tag for custom semantics.

## Future Backend Notes

Future non-Codex backends should start as GSD requirements before source files
are added. The retired source-adjacent docs mentioned possible backends:

- `claude-cli` could map headless Claude stream JSON to `[PLAN]`,
  `[QUESTION]`, `[DONE]`, `[INCOMPLETE]`, and `[ERROR]`.
- `aider` could parse line-buffered edit/commit output, but would need clear
  worktree and commit ownership rules.
- `gemini` and `ollama` would likely start as read-only or review-oriented
  backends because tool use, questions, and resume semantics are weaker or
  model-dependent.

Those notes are directional only. Do not advertise backend support until
`ADAPTER_LOADERS`, tests, command help, setup/auth behavior, and package docs
are updated together.
