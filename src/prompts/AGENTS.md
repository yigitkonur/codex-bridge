# src/prompts/AGENTS.md

This folder contains authored prompt source copied into `skill/prompts/` by
`npm run build`.

## Current File

`adversarial-review.md` is the only prompt here. It is loaded by
`buildAdversarialReviewPrompt` in `src/codex-bridge.mjs` through
`loadPromptTemplate(ROOT_DIR, "adversarial-review")`, then interpolated with
`src/lib/prompts.mjs`.

## Placeholder Contract

The code currently passes these interpolation keys:

- `REVIEW_KIND`
- `TARGET_LABEL`
- `USER_FOCUS`
- `REVIEW_COLLECTION_GUIDANCE`
- `REVIEW_INPUT`

The prompt currently uses `TARGET_LABEL`, `USER_FOCUS`,
`REVIEW_COLLECTION_GUIDANCE`, and `REVIEW_INPUT`. Extra keys are harmless, but
missing placeholders render as empty strings because `interpolateTemplate`
replaces unknown `{{NAME}}` patterns with `""`.

If you add a placeholder, update `buildAdversarialReviewPrompt` at the same
time. If you remove a placeholder from code, check the prompt for stale
references.

## Output Coupling

The adversarial review prompt tells Codex to return JSON matching
`src/schemas/review-output.schema.json`. The renderer and persisted
`.review.json` artifacts expect the schema fields:

- `verdict`
- `summary`
- `findings`
- `next_steps`

Each finding must include severity, title, body, file, line range, confidence,
and recommendation. Do not ask the model for a different output shape unless the
schema and render path change with it.

## Grounding Rules

Keep the prompt adversarial but evidence-based. It should request material
findings, concrete file/line grounding, confidence, and actionable
recommendations. Do not add style-only review instructions unless the schema and
product behavior intentionally change.

User-controlled text is interpolated into `USER_FOCUS` and repository context is
interpolated into `REVIEW_INPUT`. Avoid adding new instruction-like wrappers
around user text that would let focus text override the review role.

## Build And Verification

After editing this prompt, run `npm run build`. Once the
`feat/runtime-improvements` stack lands, also run `npm test`; on this branch
alone `package.json` declares only `build` and `dev`, so `npm test` exits with
`Missing script: "test"`.

```bash
npm run build
npm test   # post-feat/runtime-improvements
```

Then inspect both source and generated copies if the diff is surprising:

- `src/prompts/adversarial-review.md`
- `skill/prompts/adversarial-review.md`

Runtime verification requires an authenticated Codex CLI and a real
`adversarial-review` invocation.
