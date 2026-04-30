# Capability Flags & Resolution Order

## Canonical capability flags

Every adapter's `capabilities()` returns these. Unknown flags pass through; consumers must tolerate extras.

| Flag | Type | Purpose |
|---|---|---|
| `supports_plan_mode` | boolean | Can run plan-then-execute turns |
| `supports_questions` | boolean | Emits `[QUESTION]` / accepts `respond` |
| `supports_streaming` | boolean | Emits incremental events vs single-shot result |
| `supports_resume` | boolean | Can continue an existing thread |
| `supports_steering` | boolean | Can inject mid-turn guidance |
| `supports_background` | boolean | Can detach worker |
| `supports_auto_pipeline` | boolean | Bridge-side review/fix/check stages run cleanly |
| `supports_adversarial_review` | boolean | Read-only adversarial review path supported |
| `supports_worktree` | boolean | Adapter understands per-task git worktrees |
| `supports_artifact_registry` | boolean | Writes diff/review/verdict to per-task dir |
| `input_modalities` | string[] | `text` \| `image` \| `files` |
| `output_modalities` | string[] | `text` \| `diff` \| `structured` |
| `max_prompt_chars` | number | Soft hint; bridge logs warning past it |
| `billing_model` | "subscription" \| "metered" \| "local" | Drives cost UX |
| `auth_strategy` | "oauth-cli" \| "api-key" \| "none" \| "ssh-key" | Drives setup UX |
| `transport` | string | Free-form (`json-rpc-unix-socket`, `https`, `stdio`, ...) |

## Capability gating rules

The runtime enforces boolean `supports_*` flags in [`../index.mjs::guardCapability`](../index.mjs). Non-boolean hints such as `max_prompt_chars`, `transport`, and modality arrays are not valid `guardCapability` inputs:

- `task --mode plan` against `supports_plan_mode=false` → exit 6 `BACKEND_INCAPABLE`
- `respond` / `[QUESTION]` against `supports_questions=false` → exit 6
- `--no-pipeline` is forced for adapters with `supports_auto_pipeline=false`; envelope's `result.pipeline.skipped_reason` carries `"backend-incapable"`
- `steer` against `supports_steering=false` → exit 6 immediately

Hooks and SKILL.md branch on capabilities via the version envelope and per-job `meta.json`, never via prose-only assumptions.

At adapter load time, any optional lifecycle flag set to `true` must have the matching callable method on the adapter object: `supports_questions` -> `respond`, `supports_resume` -> `resume`, and `supports_steering` -> `steer`. Under-declare the flag until the method exists.

## Adapter resolution order

`selectAdapter(options)` walks these layers; highest precedence wins. The first non-empty string-typed value is the resolved backend.

1. `--backend <name>` flag (CLI)
2. `CODEX_BRIDGE_BACKEND` environment variable
3. `<task_id>/meta.json::backend` (looked up via the artifact registry for `result`/`cancel`/`events`/`wait`/`status`)
4. cwd `.codex-bridge.yaml::adapter_routing[<subagent_type>]`
5. workspace-root `.codex-bridge.yaml::adapter_routing[<subagent_type>]`
6. user `~/.codex-bridge/config.yaml::adapter_routing[<subagent_type>]`
7. cwd `.codex-bridge.yaml::default_backend`
8. workspace-root `.codex-bridge.yaml::default_backend`
9. user `~/.codex-bridge/config.yaml::default_backend`
10. built-in default (`codex`)

If all layers are empty, `selectAdapter` throws `BACKEND_INCAPABLE` ("No backend resolved").

## Per-backend configuration namespace

Adapter-specific config lives under `adapters.<name>.*`:

```yaml
adapters:
  codex:
    effort: xhigh
    sandbox_policy: danger-full-access
    skip_meta_skills: true
    model: gpt-5.4
  gemini:        # future
    model: gemini-2.5-pro
    api_key_env: GEMINI_API_KEY
  aider:         # future
    model: claude-3.7-sonnet
    map_tokens: 1024
```

Each adapter ships its config schema at `src/adapters/<name>/config.schema.json`. The bridge merges layered config and validates each backend's namespace against its own schema at startup.
