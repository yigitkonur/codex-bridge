# claude-cli Adapter (stub)

Status: **not implemented in v2.0.0.** This directory documents the contract a future contributor should satisfy when wiring Anthropic's Claude CLI / Claude Code SDK as a codex-bridge backend.

## What this would be

A `BackendAdapter` whose `dispatch` invokes Claude Code's headless mode (`claude -p "..."`) or the Claude Agent SDK directly. Strong candidate for the first non-Codex shipping backend because it shares Anthropic's tool-use protocol and supports plan mode + interactive Q&A natively.

## Anticipated capabilities

```jsonc
{
  "supports_plan_mode":           true,
  "supports_questions":           true,
  "supports_streaming":           true,
  "supports_resume":              true,    // --continue / --resume
  "supports_steering":            false,
  "supports_background":          true,
  "supports_auto_pipeline":       true,
  "supports_adversarial_review":  true,
  "supports_worktree":            true,
  "supports_artifact_registry":   true,
  "input_modalities":             ["text", "image", "files"],
  "output_modalities":            ["text", "diff", "structured"],
  "billing_model":                "subscription",  // Claude Pro / Max
  "auth_strategy":                "oauth-cli",     // claude /login
  "transport":                    "stdio"
}
```

## Required env

- (none directly; Claude CLI uses its own auth state)
- Optional `ANTHROPIC_API_KEY` for API-key mode

## Implementation pointers

1. Read [`../_interface/INTERFACE.md`](../_interface/INTERFACE.md).
2. Read [`./INTERFACE.md`](INTERFACE.md) for native-protocol notes.
3. Implement `index.mjs` with the four required methods.
4. Add `claude-cli` to `KNOWN_ADAPTERS` in [`../index.mjs`](../index.mjs).
5. Add `test/adapter-claude-cli.test.mjs`.

This adapter is likely the smallest delta to ship because Claude CLI's output already maps cleanly to the bridge's `[PLAN]/[QUESTION]/[DONE]` interrupt model.
