# src/templates/AGENTS.md

Developer-instruction templates that are passed as `collaborationMode.settings.developer_instructions` on every `turn/start` call. They define the **collaboration stance** Codex adopts for the turn.

Loaded by `src/codex-bridge.mjs::loadDeveloperInstructions(mode)` (lines 113–120) with a filesystem read and a hardcoded fallback if the file is missing:

```js
const DEVELOPER_INSTRUCTIONS_FALLBACK = {
  plan: "Produce one concrete plan using the plan tool. Do not write code, do not ask questions, do not brainstorm alternatives.",
  default: "Execute the task autonomously. Do not ask questions. Make reasonable assumptions and proceed."
};
```

The fallback is intentionally terse — it exists so the CLI never fails on a missing file. If someone deletes or renames a template, the fallback preserves the non-negotiable invariants; prose polish lives only in the files.

## Current files

| File | Mode | Sandbox | Reasoning effort | Loaded when |
|---|---|---|---|---|
| `plan-enforcement.md` | `plan` | `readOnly` | `xhigh` (forced) | `runBridgeTask` picks plan mode (`config.mode === "plan" && !request.resumeLast`). |
| `execute-instructions.md` | `default` | `workspaceWrite` | `config.effort` (default `high`) | Default/execute turns, including the auto-pipeline fix stage. |

Copied into `skill/templates/` by esbuild.

## `plan-enforcement.md` — the planning contract

Non-negotiable rules (see lines 5–10 of the file):

- **Produce exactly one plan using the plan tool** (`item.type == "plan"`). No code edits, no verification commands.
- **Never ask clarifying questions back to the user.** When a detail is unclear, pick the most defensible default, state the assumption inside the plan, and continue.
- **Don't end the turn with "shall I proceed?"** Produce the plan and stop.
- **Don't propose alternative plans.** Pick one.

Approval flow (lines 17–18): the user switches mode to `default` (via `send --mode default`), which terminates plan mode and starts execution.

## `execute-instructions.md` — the execution contract

Non-negotiable rules:

- **Assumptions-first execution** (lines 7–14): do not ask questions. Make sensible assumptions. State them in the final message. Continue.
- **Don't block on uncertainty.** Choose a reasonable default and continue (line 36).
- **Use the plan tool for progress**, not chat (line 39).
- **Long-horizon execution** (lines 31–36): break work into milestones, verify step-by-step, avoid doing everything at the end.
- **Be mindful of time** (line 28): ≤60 s research budget per turn.

## Editing rules

1. **Keep the tone imperative and second-person.** `You are`, `Do not`, `Produce`. Not `You should try to...`. Softening these lines breaks the behavior.
2. **"Do not ask questions" is a hard constraint in every mode.** Every auto-pipeline stage (review, fix, completion check) depends on it; a question mid-pipeline stalls the whole flow until `waitForResponse` times out (5 min). Any change to the question policy must update the auto-pipeline error-recovery path too.
3. **Match the plan-tool reference.** Plan mode's deliverable is the plan tool's `item/completed` with `type: "plan"`. If Codex upstream renames the tool, update the template text.
4. **Never cross modes.** `plan-enforcement.md` must not mention "execute" as a fallback. `execute-instructions.md` must not suggest planning. Mixing produces hybrid behavior that's hard to predict.
5. **Templates are read on every turn.** Changes are live after the next `npm run build` (or immediate in dev mode via `src/codex-bridge.mjs` directly).

## Relationship with `config.yaml`'s `prompt_footer`

Per `skill/config.yaml`, a `prompt_footer` is appended to every user prompt before it ships:

```
When you need to ask a question to user, always use the request_user_input tool
with distinct options to help the user navigate choices. Never ask questions as
plain text messages.
```

That footer is a user-prompt-level rule; the template here is a **developer-instruction-level** rule. Codex treats developer instructions as higher priority. Both exist because some models occasionally regress on one channel or the other — having both belts is intentional. Do not delete the footer when tightening the template, and vice versa.

## Things to avoid

- **Don't include workflow examples with concrete filenames.** The templates are repo-agnostic; concrete references rot.
- **Don't add verification-command snippets to `execute-instructions.md`.** Different projects have different test commands; Codex picks them up from AGENTS.md/CLAUDE.md in the target repo.
- **Don't introduce new "collaboration styles" without wiring them through `src/lib/config.mjs::buildCollaborationMode`.** The mode string `"plan" | "default"` is the public contract.
- **Don't remove the fallback constants in `codex-bridge.mjs` when reorganizing.** A missing template file is recoverable; a missing fallback is a crash.
