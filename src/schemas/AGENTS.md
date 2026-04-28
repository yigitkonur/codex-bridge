# src/schemas/AGENTS.md

This folder contains authored JSON schema source copied into `skill/schemas/`
by `npm run build`.

## Current File

`review-output.schema.json` is the schema passed to adversarial review turns via
`readOutputSchema(REVIEW_SCHEMA)` in `src/codex-bridge.mjs`.

Native `review` does not use this schema; it calls app-server `review/start`.
`adversarial-review` uses this schema with `turn/start` and then parses
`result.finalMessage` as JSON.

## Schema Shape

The root object is strict:

- Draft: JSON Schema 2020-12.
- `additionalProperties: false`.
- Required root fields: `verdict`, `summary`, `findings`, `next_steps`.
- `verdict` enum: `approve` or `needs-attention`.
- `findings` is an array of strict objects.

Each finding requires:

- `severity`: `critical`, `high`, `medium`, or `low`
- `title`
- `body`
- `file`
- `line_start`
- `line_end`
- `confidence`: number from 0 to 1
- `recommendation`

## Coupled Code

Change this schema only with the code and prompt paths that consume it:

- `src/prompts/adversarial-review.md` must instruct Codex to emit the same
  fields.
- `src/codex-bridge.mjs` persists parsed results with `writeReview` and puts the
  parsed object under the command payload.
- `src/lib/render.mjs` renders adversarial review findings.
- `test/plugin-surfaces.test.mjs` (added by `feat/runtime-improvements`) does
  not validate schema contents, so add or adjust tests when changing behavior
  once that suite lands.

## Editing Rules

- Keep the schema strict unless the renderer and downstream consumers are made
  tolerant of extra fields.
- Keep line numbers positive integers; render and review workflows assume
  concrete file locations.
- Do not rename fields for cosmetic reasons. The JSON envelope is a user-facing
  contract.
- If adding a field, update prompt wording, renderer behavior, skill references,
  and tests together.

## Build And Verification

After editing the schema, run `npm run build`. Once the
`feat/runtime-improvements` stack lands, also run `npm test`; on this branch
alone `package.json` defines only `build` and `dev`.

```bash
npm run build
npm test   # post-feat/runtime-improvements
```

Confirm the generated copy changed as expected:

- `skill/schemas/review-output.schema.json`
