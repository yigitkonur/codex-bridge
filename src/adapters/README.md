# src/adapters/

Backend adapter abstraction for codex-bridge.

The bridge speaks one canonical surface (envelope, events, registry) to Claude Code. Each adapter under this directory translates that surface into a specific backend's native protocol.

## Layout

```
src/adapters/
├── index.mjs              # registry: loadAdapter, selectAdapter, guardCapability
├── index.d.ts             # canonical type contract
├── README.md              # this file
├── _interface/            # prose contracts (read these to write a new adapter)
│   ├── INTERFACE.md       # the contract in prose
│   ├── EVENT_VOCABULARY.md# canonical tag glossary (single source of truth)
│   ├── CAPABILITIES.md    # capability flags + resolution order
│   └── BRIEF.md           # brief schema and rendering rules
├── codex/                 # default and only shipping backend in v2.0
├── gemini/                # stub (future)
├── aider/                 # stub (future)
├── claude-cli/            # stub (future)
└── ollama/                # stub (future)
```

## To add a new adapter

1. Read [`_interface/INTERFACE.md`](_interface/INTERFACE.md) end-to-end.
2. Read [`_interface/CAPABILITIES.md`](_interface/CAPABILITIES.md) and decide what your backend can / can't do.
3. Read [`_interface/EVENT_VOCABULARY.md`](_interface/EVENT_VOCABULARY.md) and map your native events to canonical tags.
4. Create `src/adapters/<name>/` with at minimum `index.mjs`, `config.schema.json`, `README.md`.
5. Implement the four required methods (`dispatch`, `streamEvents`, `getResult`, `cancel`).
6. Add `<name>` to `KNOWN_ADAPTERS` in `index.mjs`.
7. Add a smoke test under `test/adapter-<name>.test.mjs`.
8. Document config keys + env vars in your `README.md`.

## Phase A status (v2.0.0)

This abstraction ships as internal-only scaffolding in v2.0.0. T1 (this PR) introduces the registry and type contracts. T2–T5 will relocate the Codex protocol layer into `src/adapters/codex/`, implement lifecycle methods, and wire `selectAdapter()` through CLI handlers (landing in T5). During Phase 0 (T1–T6), CLI handlers continue to call `src/lib/codex.mjs` directly; the adapter system is not yet wired into the runtime.

Future versions will add real backends in this order: `noop` (test-only), `claude-cli`, `gemini`, `aider`, `ollama`. Each will land as a separate PR and a separate minor version bump.
