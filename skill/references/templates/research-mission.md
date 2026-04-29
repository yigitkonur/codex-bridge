# Research Mission Template

Copy this into a prompt file for investigation tasks.

```markdown
## Objective
Investigate the target area and report concrete findings with file references.

## Scope
- Focus on:
- Ignore:

## Questions to Answer
1. What is the current behavior?
2. Which files or modules control it?
3. What risks or open questions remain?

## Constraints
- Do not make code changes.
- Prefer direct code evidence over guesses.

## Required Checks
Run any read-only commands needed to support the findings.

## Deliverable
- Summarize the behavior.
- Include exact file paths.
- Call out risks, gaps, or likely next edits.
```

## Use it

Save the markdown block above into `mission.md`, then dispatch (no `--write` — research is read-only):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs" task \
  --mode default --json --prompt-file mission.md
```

`--prompt-file` is required here — passing the multi-paragraph body as positional argv joins lines with single spaces and drops the section structure. See [prompt-writing.md](../prompt-writing.md#how-to-deliver-the-prompt).
