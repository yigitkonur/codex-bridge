# unexpected-bridge-observations

Session-anchored notes about codex-bridge behavior that surprised the author during live use — things the skill could be enhanced to warn about, avoid, or handle better. Think of this as the feature backlog for a skill-quality pass.

**Distinction from `gherkin-tests-v2/`:** the specs in that directory are *contracts* (the bridge should always behave this way). These notes are *observations* (on date X, the bridge did Y, here's the fix idea).

## Entries

| # | Title | Status |
|---|---|---|
| 01 | Plan mode bypassed by Codex's superpowers skills | open, fix ideas in file |
| 02 | Auto-review stage stalls 5 min on a 5 KB diff | open, workaround: `auto_review: false` |
| 03 | `next_action.description` misleads orchestrator on pipeline timeouts | open, one-line fix scoped |
| 04 | `.ndjson` missing `TURN_PARAMS` + `ITEM_COMPLETED` under superpowers | open, hypothesis not verified |
| 05 | `bridge cancel` (no args) errors with `AMBIGUOUS_CANCEL` when multiple jobs active | open, spec update needed |
| 06 | Stop-gate review accumulates orphaned "running" rescue tasks across sessions (7 ghosts reaped during this session's cleanup) | open, startup-time reaper scoped |
| 07 | `config.yaml` in cwd/workspace is silently ignored — real config lives at `$CLAUDE_PLUGIN_DATA/state/<slug>-<hash>/config.yaml` | open, 5 fixes scoped |
| 08 | `adversarial-review` writes no session artifacts for its own thread — `.events` / `.ndjson` / `.review.json` all absent | open, 3 fixes scoped |

## How to add an entry

Number sequentially starting at `01-`. Kebab-case slug describing the surprise in under 8 words. Structure:

```markdown
# NN — one-line title

**Observed:** YYYY-MM-DD during <context>
**Codex version:** <exact codex-cli version>
**Bridge state:** <commit sha or "uncommitted + notes">

## What happened
<concrete description, include exact command and output>

## Why it's a derailment
<the specific contract that was violated or user expectation that was broken>

## Root cause (hypothesis)
<only if you have evidence — otherwise say "not isolated">

## Suggested fix
<one actionable change, scoped; name the file + function where the change would land if you know>

## Related
<cross-links to sibling observations, gherkin-tests-v2 scenarios, SKILL.md sections>
```

## When to graduate an entry

Move from open → resolved when a commit actually ships the fix or rewrites the spec to match the observed reality. Keep the entry — don't delete — and annotate with `**Resolved in:** <commit sha>`. That preserves the historical record and tells future debuggers why the code now behaves the way it does.
