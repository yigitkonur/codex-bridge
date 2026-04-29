# gemini Adapter (stub)

Status: **not implemented in v2.0.0.** This directory documents the contract a future contributor should satisfy when wiring Google's Gemini CLI as a codex-bridge backend.

## What this would be

A `BackendAdapter` whose `dispatch` shells out to the official Gemini CLI (`gemini` binary on `$PATH`), translates streaming responses into canonical `NormalizedEvent`s, and surfaces results through the bridge's standard envelope. Most useful for cheap-fast read-only workloads (the user's `Explore`-class subagent flows route here in the prototype).

## Anticipated capabilities

```jsonc
{
  "supports_plan_mode":           false,  // Gemini CLI has no native plan-then-execute
  "supports_questions":           false,  // no mid-turn interactive [QUESTION]
  "supports_streaming":           true,   // CLI streams tokens
  "supports_resume":              false,  // single-turn invocations
  "supports_steering":            false,
  "supports_background":          true,   // wrappable in nohup
  "supports_auto_pipeline":       false,  // bridge skips pipeline stages
  "supports_adversarial_review":  true,   // read-only diff review works
  "supports_worktree":            true,   // path-based; cwd-respecting
  "supports_artifact_registry":   true,
  "input_modalities":             ["text", "image"],
  "output_modalities":            ["text"],
  "billing_model":                "metered",
  "auth_strategy":                "api-key",
  "transport":                    "stdio"
}
```

## Required env

- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`)

## Implementation pointers

1. Read [`../_interface/INTERFACE.md`](../_interface/INTERFACE.md).
2. Read [`./INTERFACE.md`](INTERFACE.md) for native-protocol notes.
3. Implement `index.mjs` with the four required methods.
4. Add `gemini` to `KNOWN_ADAPTERS` in [`../index.mjs`](../index.mjs).
5. Add `test/adapter-gemini.test.mjs`.
