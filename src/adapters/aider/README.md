# aider Adapter (stub)

Status: **not implemented in v2.0.0.** This directory documents the contract a future contributor should satisfy when wiring Aider as a codex-bridge backend.

## What this would be

A `BackendAdapter` whose `dispatch` invokes `aider --message "..." --yes` against a worktree, parses Aider's line-buffered "Applied edit to ..." / "Committed: ..." output into canonical events, and writes Aider's diff into the artifact registry. Useful for orchestrators that want write-mode work with explicit file scoping.

## Anticipated capabilities

```jsonc
{
  "supports_plan_mode":           false,
  "supports_questions":           false,  // Aider supports /ask but it's interactive only
  "supports_streaming":           true,   // line-by-line stdout
  "supports_resume":              true,   // .aider.chat.history.md preserves context
  "supports_steering":            false,
  "supports_background":          true,
  "supports_auto_pipeline":       false,  // Aider has its own commit/test loop
  "supports_adversarial_review":  false,  // not designed for read-only review
  "supports_worktree":            true,
  "supports_artifact_registry":   true,
  "input_modalities":             ["text", "files"],
  "output_modalities":            ["diff", "text"],
  "billing_model":                "metered",
  "auth_strategy":                "api-key",  // user's choice of provider
  "transport":                    "stdio"
}
```

## Required env

One of (depending on user's provider):
- `ANTHROPIC_API_KEY` for `--model claude-3.7-sonnet`
- `OPENAI_API_KEY` for `--model gpt-5.4`
- (others per Aider's provider list)

## Implementation pointers

1. Read [`../_interface/INTERFACE.md`](../_interface/INTERFACE.md).
2. Read [`./INTERFACE.md`](INTERFACE.md) for native-protocol notes.
3. Implement `index.mjs` with the four required methods.
4. Add `aider` to `KNOWN_ADAPTERS` in [`../index.mjs`](../index.mjs).
5. Add `test/adapter-aider.test.mjs`.
