# ollama Adapter (stub)

Status: **not implemented in v2.0.0.** This directory documents the contract a future contributor should satisfy when wiring Ollama (local model runtime) as a codex-bridge backend.

## What this would be

A `BackendAdapter` whose `dispatch` posts to Ollama's local HTTP API (`http://localhost:11434/api/chat`) and streams tokens back. Useful for fully-offline / zero-cost workloads where latency and capability tradeoffs are acceptable. Likely best paired with code-tuned local models (Deepseek-Coder, Qwen2.5-Coder, Llama 3 Code).

## Anticipated capabilities

```jsonc
{
  "supports_plan_mode":           false,  // no built-in tool support without scaffold
  "supports_questions":           false,
  "supports_streaming":           true,   // HTTP chunked stream
  "supports_resume":              false,  // stateless API
  "supports_steering":            false,
  "supports_background":          true,
  "supports_auto_pipeline":       false,
  "supports_adversarial_review":  true,   // read-only review works fine
  "supports_worktree":            true,
  "supports_artifact_registry":   true,
  "input_modalities":             ["text"],
  "output_modalities":            ["text"],
  "billing_model":                "local",
  "auth_strategy":                "none",
  "transport":                    "https"
}
```

## Required env

- (none; defaults to `http://localhost:11434`)
- `OLLAMA_HOST` to override
- `OLLAMA_MODEL` for the default model (or pass `--model` per dispatch)

## Implementation pointers

1. Read [`../_interface/INTERFACE.md`](../_interface/INTERFACE.md).
2. Read [`./INTERFACE.md`](INTERFACE.md) for native-protocol notes.
3. Implement `index.mjs` with the four required methods.
4. Add `ollama` to `KNOWN_ADAPTERS` in [`../index.mjs`](../index.mjs).
5. Add `test/adapter-ollama.test.mjs`.

For tool-use workflows (Edit/Write file modifications), this adapter would need a thin agent loop on top of raw Ollama chat — not a v1 priority.
