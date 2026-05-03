# Retrospective

## Milestone: v2.0.0 — Bridge Completion

**Shipped:** 2026-05-03  
**Phases:** 6  
**Plans:** 19

### What Was Built

- Static contract gate and generated-output discipline for dual `skill/` and `plugin/` layouts.
- Backend-aware Codex delegation runtime with foreground/background observability and lifecycle controls.
- Review, verdict, merge, and iterate loop with branch-head safety and durable artifacts.
- Packaged plugin and hook surface hardening with spoof-resistant Monitor behavior.
- Canonical state/session/registry artifact contracts and structured recovery payloads.
- Release packaging, checksums, CI static smoke, update diagnostics, and authenticated runtime smoke.

### What Worked

- Source-first planning kept stale prose from driving implementation.
- `npm run verify:static` became the useful convergence point after every risky change.
- Small focused tests around CLI envelopes, hook subprocesses, registry artifacts, and generated outputs caught contract drift cheaply.
- Live smoke in Phase 6 closed the gap static tests could not honestly prove.

### What Was Inefficient

- Phase 5 and Phase 6 initially missed per-plan `SUMMARY.md` files, which the milestone audit caught and corrected.
- Generated dual-layout maintenance remains noisy: source changes often create large bundle diffs.
- Some GSD workflow helpers assume SDK availability and interactive confirmation, so this closeout required manual equivalent steps.

### Patterns Established

- Treat source, tests, package metadata, hook/plugin manifests, generated bundles, and CI as authority.
- Archive before deleting living planning files.
- Keep only one authoritative copy of milestone evidence after archive; remove duplicate live copies once byte-equivalence is verified.
- Keep runtime behavior machine-readable through JSON envelopes and stable artifact formats.
- Use fail-closed statuses for ambiguous automation output.

### Key Lessons

- Static gates should name runtime gaps instead of pretending to prove authenticated app-server behavior.
- Worktree/review/verdict flows need branch-head binding everywhere approvals are persisted or consumed.
- Hook automation needs active spoof tests, not only benign-path tests.
- Release readiness is stronger when packaging is a source script with tests, not inline workflow shell.

## Cross-Milestone Trends

| Theme | Observation |
|---|---|
| Contract drift | Highest recurring risk; mitigated by generated-output and baseline-contract checks. |
| Runtime proof | Authenticated Codex smoke is required for release confidence. |
| Distribution | Legacy skill and packaged plugin dual-output remains useful but expensive. |
| Future work | Next milestone should define fresh requirements before implementation. |
