---
title: codex-bridge skill — re-bloat prevention rules
audience: contributors editing SKILL.md or references/
---

# Re-bloat prevention rules

The v1.x skill grew to 22,061 words across 9 files. v2.0 ships at ~3,200. Anything added back into prose lives at risk of staling vs the runtime, so:

## Three gates a new `references/*.md` must clear

1. **CLI-derivability gate.** If the content can be emitted by an existing `--help`, `--json`, or schema flag, it lives in the CLI, not in markdown. Don't duplicate the envelope shape, exit codes, or per-subcommand flag tables — they're owned by the runtime.
2. **Hook-enforceability gate.** If the content is "always do X before Y" or "warn if Z," it belongs in a hook, not in prose. PreToolUse, PostToolUse, Stop, and SessionStart should enforce or surface canonical wiring where they actually do so; prose should explain *judgment*, not promise future procedure.
3. **Context-injectability gate.** If the content is conditional on capability X or differs per backend, surface it via `result.adapter_capabilities` at runtime. Don't fan it out across files — they will drift.

## Word budgets

- `SKILL.md` ≤ 1,500 words. Crossing the budget is a refactor PR, not an append. (Today: 980.)
- Each `references/*.md` ≤ 800 words. Same rule.
- A new reference file requires a paragraph in the PR description explaining which gate it cleared and which existing file (or `--help` flag) it does **not** duplicate.

## What belongs in prose at all

Only the things the runtime cannot tell you:

- **Judgment**: when to use this vs that, what to weigh, what failure modes you've seen.
- **Recovery decision trees** keyed on `error.code` (the codes themselves come from envelopes).
- **One canonical flow** — not three.

Everything else is owned by `<subcommand> --help`, `config show --json`, `version --json::result.adapter_capabilities`, or a runtime schema command once that command exists.

## When you find drift

- Prose says X, runtime emits Y → trust Y, fix the prose, don't preserve both.
- Prose says X, runtime says nothing → consider whether a `--schema` or capability flag should expose X. Usually yes.
- Prose says X, hook enforces Y that contradicts X → fix the prose. Hooks are the source of truth for procedure.

The CI lint (planned in T29) will reject SKILL.md > 1,500 words and any `references/*.md` > 800 words. Don't try to evade it.
