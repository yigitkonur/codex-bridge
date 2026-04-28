# src/templates/AGENTS.md

This folder contains authored developer-instruction templates copied into
`skill/templates/` by `npm run build`.

## Current Files

| File | Used by |
|---|---|
| `plan-enforcement.md` | `loadDeveloperInstructions("plan")` in `src/codex-bridge.mjs` |
| `execute-instructions.md` | `loadDeveloperInstructions("default")` in `src/codex-bridge.mjs` and `runAutoPipeline` |

If either file is missing at runtime, the code falls back to short built-in
strings in `src/codex-bridge.mjs` or `src/lib/auto-pipeline.mjs`.

## Plan Template Contract

`plan-enforcement.md` is injected as developer instructions when collaboration
mode is `plan`. The code expects a completed item of type `plan`; `codex.mjs`
sets `planDetected` and `planText` only when it receives `item.type === "plan"`
on `item/completed`.

Keep plan mode focused on:

- exactly one concrete plan
- no file edits
- no verification commands
- no clarifying questions
- stop after producing the plan

If upstream Codex changes plan item naming or delivery, update `codex.mjs`,
this template, and tests together.

## Execute Template Contract

`execute-instructions.md` is injected for default execution and for auto-pipeline
fix/check turns. It tells Codex to execute independently, make reasonable
assumptions, report progress, and avoid blocking on questions.

Be careful with question language. The bridge also appends `prompt_footer` from
config telling Codex to use `request_user_input` when it needs a user decision.
The execute template should not encourage plain-text questions that bypass
`pending-requests.mjs` and `respond`.

## Editing Rules

- Keep these templates project-agnostic. Do not put codex-bridge repository test
  commands here; Codex should learn target-project commands from the target
  workspace.
- Do not mention Claude-specific tool names unless the app-server can actually
  produce the corresponding item type.
- Keep plan and execute modes distinct. Plan mode should not authorize edits;
  execute mode should not ask for plan approval.
- If changing behavior visible to users, update `skill/SKILL.md` and references.

## Build And Verification

After editing either template, run `npm run build`. Once the
`feat/runtime-improvements` stack lands, also run `npm test`; on this branch
alone `package.json` defines only `build` and `dev`.

```bash
npm run build
npm test   # post-feat/runtime-improvements
```

Check generated copies:

- `skill/templates/plan-enforcement.md`
- `skill/templates/execute-instructions.md`
