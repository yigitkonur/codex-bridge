# BackendAdapter Interface

Prose companion to [`../index.d.ts`](../index.d.ts) (the type contract) and [`../index.mjs`](../index.mjs) (the registry implementation). Read this first if you're authoring a new adapter.

## What an adapter is

A `BackendAdapter` is a thin wrapper around a coding backend (codex, gemini, aider, claude-cli, ollama, ...) that translates between codex-bridge's canonical surface and the backend's native protocol. The bridge owns: the `--json` envelope, the event vocabulary (see [`EVENT_VOCABULARY.md`](EVENT_VOCABULARY.md)), the artifact registry, the worktree story, the brief schema. Adapters own: dispatch, event translation, error mapping, prompt rendering.

## Required exports

Every `src/adapters/<name>/index.mjs` must `export default` an object that satisfies the `BackendAdapter` interface in [`../index.d.ts`](../index.d.ts). The registry validates this shape at load time:

- **Identity**: `name`, `displayName`, `capabilities()`, `validateConfig(config)`
- **Lifecycle (required)**: `dispatch(prompt, options)`, `streamEvents(jobId, signal)`, `getResult(jobId)`, `cancel(jobId)`

Optional methods are gated by capability flags. Don't expose `respond` if your `capabilities().supports_questions` is `false`; the bridge will refuse to call it (`guardCapability` throws `BACKEND_INCAPABLE`).

## What `dispatch` returns

A `DispatchResult` carries the bridge-canonical `jobId`, your native `threadId`, and the absolute `sessionDir` where artifacts will live. Capabilities are echoed for callers that don't want a separate round-trip.

## What `streamEvents` yields

`NormalizedEvent` instances with one of the canonical tags (see [`EVENT_VOCABULARY.md`](EVENT_VOCABULARY.md)) or an adapter-namespaced tag (`ADAPTER:<name>:<event>`). Don't emit untagged events. Don't reuse canonical tags for adapter-specific semantics; the registry rejects adapters whose `capabilities().reserved_tags` overlap with the canonical set.

## Error mapping

Adapters install their error classifier via `registerErrorMapper(adapterName, mapper)`. The bridge calls it before envelope rendering. Map your native errors to a stable `{ code, class, details? }` shape; the bridge uses `code` for exit-code routing.

## Capability negotiation

`capabilities()` returns a frozen object describing what the backend can do. The bridge surfaces it in three places:
- `version --json::result.adapter_capabilities`
- every dispatch envelope's `result.adapter_capabilities`
- the artifact registry's `meta.json::capabilities`

Hooks and SKILL.md branch on capabilities — never on prose-only assumptions. If your backend doesn't support `supports_questions`, the bridge will exit 6 (`BACKEND_INCAPABLE`) on `respond` calls. The recommended UX is to bake clarifications into the original prompt or switch backends.

## What the registry validates at load

`loadAdapter(name)` enforces:
- Default export is an object
- Required fields present (`name`, `displayName`, `capabilities`, `validateConfig`)
- Required methods are functions (`dispatch`, `streamEvents`, `getResult`, `cancel`)
- `adapter.name === name` (matches the directory)

Validation failures throw `AdapterError` with code `BACKEND_INCAPABLE`.

## Adding a new adapter

1. Create `src/adapters/<name>/` with `index.mjs`, `config.schema.json`, `README.md`.
2. Implement the four required methods.
3. Declare your capabilities truthfully — under-declare rather than over-declare.
4. Translate your native event protocol into canonical tags (see [`EVENT_VOCABULARY.md`](EVENT_VOCABULARY.md)).
5. Register an error mapper at module top-level: `registerErrorMapper("<name>", mapper)`.
6. Add `<name>` to `KNOWN_ADAPTERS` in [`../index.mjs`](../index.mjs).
7. Add `test/adapter-<name>.test.mjs` with a smoke test that loads the adapter and validates a sample event stream.

The first version doesn't need to support every optional method — set capabilities accurately and the bridge will degrade gracefully (skipping pipeline stages, refusing `respond`, etc.).
