# Changelog

All notable changes to `codex-bridge` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Unreleased changes live under the `Unreleased` section until a release is cut —
see the "Adding an entry" section at the bottom for the workflow.

## [Unreleased]

### Added — v2.0.0 plugin redesign (Phases 0–4)

Structural rewrite from user-level skill to hook-driven Claude Code plugin.
22,061 → 3,626 words of teaching surface (-84%); 3 → 7 hooks; new artifact
registry + brief schema + staged iterate helper. Migration notes in
[`MIGRATION.md`](MIGRATION.md).

- Adapter abstraction at `src/adapters/` — codex-only in v2.0; future backends
  (gemini, aider, claude-cli, ollama) are mechanical additions. Capabilities
  surface at `version --json::result.adapter_capabilities` and per-job
  `meta.json::capabilities`.
- Plugin scaffolding at `plugin/` (manifest v2.0.0, marketplace shim, commands,
  agents, hooks, skills, schemas, prompts, scripts).
- Hook surface (7): SessionStart (status injection), SessionEnd (broker shutdown
  + orphan prune), UserPromptSubmit (resume detection + rewake delivery),
  SubagentStop (terminal tag surfacing), Stop (review gate + verdict sweep),
  PreToolUse(Agent) (selective Explore-class intercept), PreToolUse(Bash)
  (auto-reject task --write without --worktree-auto), PostToolUse(Bash)
  (Monitor auto-arm via result.monitor.tool_hint).
- Brief schema (`plugin/schemas/brief.schema.json`): structured task input with
  `goal`, `worker_assignment`, `specific_concerns`, `acceptance_criteria`,
  `parent_task_id`, `iteration_max`, `trust_budget_override`. Brief preserved
  verbatim at `<jobs>/<task_id>/brief.json`.
- `--brief @<path>.json` accepted by `task` and `adversarial-review`.
  `brief.specific_concerns` flows verbatim into the adversarial-review prompt's
  new `{{OPUS_CONCERNS}}` placeholder.
- Repeatable `--concern <text>` flag for ad-hoc orchestrator concerns;
  parseArgs grows `repeatableValueOptions` config option.
- Worktree-per-dispatch isolation: write-mode tasks land in
  `<repo>/../.codex-bridge-worktrees/<task_id>` on `subagent/codex/<task_id>`
  branch with captured base SHA. Branch-only fallback when worktree creation
  fails (returned as `result.isolation_mode: "branch-only"`).
- Per-task artifact registry at `~/.codex-bridge/jobs/<task_id>/`:
  `meta.json`, `brief.json`, `brief.md`, `events.jsonl`, `diff.patch`,
  `review.json`, `verdict.json`, `lock`. POSIX flock prevents concurrent
  writers (`TASK_DIR_LOCKED`).
- New CLI subcommands: `merge` (gated; refuses if verdict ≠ approved; fast-
  forward only), `verdict` (read/write/discard), `verdicts --pending`
  (used by Stop gate), `iterate` (staged helper that returns `next_action`
  for the manual task → review → verdict workflow).
- New slash commands: `/codex-bridge:merge`, `/codex-bridge:verdict`,
  `/codex-bridge:iterate`. All existing `/codex-bridge:*` commands keep their
  signatures; `/codex-bridge:adversarial-review` adds `--brief` + `--concern`.
- New agent: `codex-bridge:codex-bridge-reviewer` (writes verdict, stays out of
  the parent transcript).
- Adversarial-review prompt borrows OpenAI's
  `<role>/<operating_stance>/<attack_surface>/<finding_bar>/<calibration_rules>/<grounding_rules>/<final_check>`
  skeleton with the new `<orchestrator_concerns>` block carrying
  `{{OPUS_CONCERNS}}`.
- Config resolution layers built-in defaults, installed-root `config.yaml`,
  workspace-root `config.yaml`, then cwd `config.yaml`. New keys:
  `default_backend`, `trust_budget`, `worktree_default`, `monitor_verbosity`,
  `event_log_retention_days`, `adapter_routing`.
- New error codes: `BRIEF_FILE_NOT_FOUND`, `BRIEF_INVALID_JSON`,
  `BRIEF_SCHEMA_VIOLATION`, `BRIEF_PARENT_NOT_FOUND`,
  `BRIEF_BACKEND_UNAVAILABLE`, `BACKEND_INCAPABLE`, `TASK_DIR_LOCKED`,
  `VERDICT_NOT_APPROVED`, `WORKTREE_CREATE_FAILED`,
  `WORKTREE_READ_ONLY_CONFLICT`, `REVIEW_BRIEF_UNSUPPORTED`,
  `REVIEW_CONCERN_UNSUPPORTED`.
- Kill switches: `CODEX_BRIDGE_HOOK_DISABLE=<comma-list>|all`,
  `CODEX_BRIDGE_DISABLE_WORKTREE_AUTO=1`, `--no-hooks` global flag.
- Skill slim: SKILL.md 9,964 → 980 words. References:
  `error-recovery.md` 7,822 → 661, `orchestration-flows.md` 5,115 → 544,
  `notification-format.md` 4,865 → 231, `monitor-patterns.md` 3,062 → 223.
  New: `brief-composition.md` (renamed from `prompt-writing.md`), `AGENTS.md`
  (re-bloat prevention rules). Deleted: `command-reference.md`,
  `config-reference.md`, `ndjson-guide.md` (owned by runtime help and JSON
  output).
- CI lint (`test/skill-word-budget.test.mjs`): SKILL.md ≤ 1,500 words; each
  `references/*.md` ≤ 800 words. Banned files stay deleted.

### Changed — v2.0.0

- Envelope `schema_version` remains `1.0` while new `result.*` fields are
  additive:
  `task_id`, `task_dir`, `worktree`, `isolation_mode`, `provenance`,
  `iteration_chain`, `active_backend`, `adapter_capabilities`. The
  `--legacy-envelope` flag is accepted for compatibility but does not select a
  separate schema version yet.
- `BRIDGE_CAPABILITIES` gains `backend-adapter`, `brief-schema`,
  `artifact-registry`, `iteration-chain`.
- esbuild emits both `skill/` (legacy, deprecated in Phase 4) and `plugin/`
  (canonical from v2.0.0); broker bundle path probed across both layouts.

### Removed — v2.0.0

- `~/.agents/skills/codex-bridge/` legacy skill install (Phase 4; overlap
  window in Phase 3 keeps both).
- `references/command-reference.md`, `references/config-reference.md`,
  `references/ndjson-guide.md` (owned by runtime).

> **Note on cross-branch entries.** Items marked *(preview — `<sibling-branch>`)* describe work that lands with a sibling branch on the post-v1.5.0 stack and is **not** present on this docs branch alone. They are recorded here so the changelog reflects the whole stack, but a release cut from this branch in isolation would not include them. Items without a preview marker land with this branch.

### Added
- *(preview — `feat/plugin-surfaces`)* Claude Code plugin-native slash commands
  under `/codex-bridge:*`, plus a thin `codex-bridge:codex-bridge-runner`
  subagent that forwards substantial task delegation to the existing bridge
  runtime while preserving Monitor-ready envelopes.
- *(preview — `feat/plugin-surfaces`)* Claude Code lifecycle hooks for
  session-id export, session-end orphan pruning, and the optional stop-time
  review gate, implemented as thin wrappers around the existing bridge CLI.
- *(preview — `feat/plugin-surfaces`)* Stop-time review gate activation is
  explicit, visible, and project-scoped: the Stop hook only runs Codex when
  `.codex-bridge-stop-review-gate.lock` exists at the git project root.
- *(preview — `feat/plugin-surfaces`)* Stop-time review gate defers to the
  official OpenAI Codex plugin: when that plugin is enabled, codex-bridge
  refuses to enable or run its own Stop review gate and reports the
  suppression in setup/status JSON.
- *(preview — `feat/runtime-improvements`)* Static regression coverage for
  plugin manifest version sync, command discovery, hook discovery, command
  script paths, and the runner subagent's thin-forwarder contract.

### Fixed
- *(preview — `feat/plugin-surfaces`)* `.claude-plugin/plugin.json` matches the
  package / skill metadata version instead of advertising stale `1.2.3`
  metadata to Claude Code plugin discovery.
- `auto-pipeline` terminal tag: `[PIPELINE:done]` / `[PIPELINE:failed]` now
  emit the documented names (previously rendered as
  `[PIPELINE:pipeline:done]` / `[PIPELINE:pipeline:failed]` — contradicted
  every doc surface). Consumers expecting the literal `[PIPELINE:done]` /
  `[PIPELINE:failed]` string in `.events` (via grep, regex, or exact-match
  string parsers) saw nothing on the buggy build. The `events --filter
  PIPELINE` recipe still kept matching either form, since `--filter`
  extracts only the head tag family (`m[1].split(":")[0].toUpperCase()`,
  `src/codex-bridge.mjs:3734`), but the closing-tag literal text was
  wrong. Source call sites in `src/lib/auto-pipeline.mjs` now pass
  `stage: "done"` / `stage: "failed"` directly. Orchestrators that were
  relying on the buggy literal must switch to the documented names.

### Docs (skill bundle)

Skill bundle re-aligned with v1.5.0 source after an independent audit
(73 findings verified against `src/`). No behavior changes in the
skill/docs commits — only accuracy and coverage improvements:

- `SKILL.md`: plan-turn timeout 15 min → 30 min; exit-code table adds
  row 8 (partial success); `--write` first-turn caveat rewritten to
  respect the shipped `danger-full-access` default; `result.next_action.command`
  note reflects the full `node <path>` form actually written into the
  envelope; Monitor tag-vocabulary enumeration adds `[DIRECTIVES]`,
  `[CONFIRMED]`, `[PARTIAL]`, `[RETRYING]`, `[HANDOFF]`.
- `references/command-reference.md`: turn-plan/turn-default defaults
  300000/600000 → 1800000/1800000; events `--timeout-ms` default
  1800000 → 600000 (matches handler); adds workspace-dirty phase row;
  adds `status --watch`/`--interval`/`--watch-timeout-ms`; adds
  `version --check-update`; adds full sections for `update`, `config`,
  `await-artifact` (present in COMMANDS but previously undocumented);
  adds synthesized-error-code table (UPSTREAM_STREAM_DISCONNECTED,
  PreviousResponseNotFound, UpstreamUnauthorized, UpstreamInvalidRequest);
  replaces stale `wait` known-gap with actual WAIT_TIMEOUT behavior;
  adds events `--follow` early-exit envelope shape.
- `references/config-reference.md`: `turn_plan_ms` default 900000 →
  1800000; `allow_questions` flagged as documented-but-unread;
  new "Validation and error handling" subsection covering all 5
  failure modes (YAML parse, malformed `*_ms` in config vs CLI,
  malformed `sandbox_policy`, unvalidated strings); new "Environment
  variable overrides" subsection for `CODEX_BRIDGE_HEARTBEAT_MS`,
  `CODEX_BRIDGE_CHECKPOINT_MS`, `CODEX_BRIDGE_STALL_CHECKPOINTS`,
  `CODEX_BRIDGE_NO_UPDATE_CHECK`.
- `config.yaml`: ship all six `*_ms` timeout keys as commented stubs
  matching defaults, for visible control surface.
- `references/error-recovery.md`: split unified codexErrorInfo table
  into Codex-emitted (9 rows) vs bridge-synthesized (6 rows) with
  explicit Retryable? column for the second; new UPSTREAM_RETRY_POLICY
  table (5 rows with strategy / maxAttempts / backoff); new envelope-
  shapes subsection (success + error + retryAfter→retry_after rename);
  new [HANDOFF] envelope subsection; Plan-turn timeout row 15 → 30 min;
  decision tree annotates pipeline:/bridge origins with actual emitting
  module; ClientTimeout / ProcessDeath grouped with synthesized codes.
- `references/notification-format.md`: `bridge:*` origin row corrected
  to `bridge` (bare string; no `bridge:stall` / `bridge:unhandled-exit`
  sub-tokens are emitted); new [CHECKPOINT] schema section (previously
  zero schema documentation despite the tag shipping in 1.3.0); [QUESTION]
  respond: fanout documented (one line per option, not one template);
  [DIRECTIVES] schema adds conditional `approval=` and `model=` segments
  + parse-as-key-value note; [REVIEW] reserved-status note corrected
  re: writeReview having a caller on the adversarial-review path.
- `references/monitor-patterns.md`: define `$EVENTS_FILE` derivation
  up front; Preset C `timeout_ms: 300000` → `21600000` (5 min →
  6 h, matching the "session-long" label).
- `references/prompt-writing.md`: plan-mode sandbox framed as a
  reasoning constraint (not a sandbox one); `turn_plan_ms` default
  15 → 30 min; new "How to deliver the prompt" subsection documenting
  `readTaskPrompt` precedence and the argv-newline-collapse pitfall.
- `references/orchestration-flows.md`: drop pandoc `{#recovering-...}`
  suffix (GFM renders literally); simplify "Running N jobs in parallel
  (fan-out / fan-in)" → "Running N jobs in parallel" so the GFM auto-slug
  matches SKILL.md's cross-link.
- `references/templates/*.md`: each mission template gains a "Use it"
  block showing the canonical `task --prompt-file mission.md` dispatch.
- `AGENTS.md` (repo root): `ROOT_DIR` line pointer 97-103 → 235-237;
  `buildCollaborationMode` line pointer 56 → 191-196;
  `CODEX_BRIDGE_NO_UPDATE_CHECK` read site 128 → 161; drop stale
  `GITHUB_TOKEN`/`GH_TOKEN` row (no longer read since 1.2.8); add
  `CODEX_BRIDGE_HEARTBEAT_MS`/`_CHECKPOINT_MS`/`_STALL_CHECKPOINTS`.
- `skill/AGENTS.md`: references table uses full `references/templates/`
  prefix to disambiguate from the generated `skill/templates/` siblings.

## [1.5.0] — 2026-04-20

Truthful upstream-error classification, automatic exp-backoff retry,
and a `[PARTIAL]` + `[HANDOFF]` pair that makes mid-turn upstream
failures recoverable instead of catastrophic. Driven by a forensic
audit from a live Swift/SwiftUI mission where two commits landed
before an HTTP 400 `previous_response_not_found` killed the turn —
the v1.4.1 envelope misreported the failure as generic `internal`,
and the caller had to hand-reconstruct workspace state from
`git log`. v1.5.0 closes that gap end-to-end.

### Added

- **Tier-2 string classifiers for raw upstream HTTP errors.**
  `src/lib/cli-errors.mjs::classifyError` now matches on message text
  when `codexErrorInfo` is absent. Three new classes:
  - `PreviousResponseNotFound` (`dependency_failed`, exit 7,
    retryable via new-thread) — HTTP 400 response-chain loss from
    compaction / session expiry.
  - `UpstreamUnauthorized` (`auth`, exit 4, non-retryable) — raw
    401s, including Railway proxy "Proxy authentication must be
    configured" messages.
  - `UpstreamInvalidRequest` (`validation`, exit 6, retryable) —
    other 400 `invalid_request_error` cases (ordered AFTER
    chain-lost so it doesn't shadow).
- **Origin vocabulary extension.** `classifyTurnErrorOrigin` emits
  three new origins: `upstream:response-chain-lost`,
  `upstream:auth`, `upstream:invalid-request`. `.events` `origin=…`
  fields and action-block `see:` anchors use these names.
- **`UPSTREAM_RETRY_POLICY` + automatic exp-backoff retry.** On any
  `upstream:*` origin, the bridge retries before surfacing the error:
  - `upstream:transport` → same-thread × 3 @ 2s / 5s / 12s.
  - `upstream:compact-proxy` → same-thread × 2 @ 10s / 30s.
  - `upstream:invalid-request` → same-thread × 3 @ 2s / 5s / 12s.
  - `upstream:response-chain-lost` → new-thread × 1 (delegates to
    handoff; no auto-rebase).
  - `upstream:auth` → 0 (straight to handoff; reauth is deterministic).
  - Non-upstream origins retain pre-1.5.0 behavior (no retry).
- **`[RETRYING]` non-terminal tag.** Each retry attempt emits
  `[RETRYING] {threadId} attempt n/m | origin=… | strategy=… |
  backoff=…ms | reason=…` to `.events`. Monitor does NOT
  self-terminate on it.
- **`[PARTIAL]` tag + `result.partial` envelope field.** Git snapshot
  taken at `runBridgeTask` entry (`HEAD` sha + `porcelain -v1`
  dirty set); on any terminal error path with commits-landed, emits
  `[PARTIAL] {threadId} commits=[sha1,sha2] current={sha}
  since={iso}` BEFORE the `[ERROR]` block. JSON envelope carries
  `error.partial = { commits, currentHeadSha, lastOkHeadSha,
  dirtyFiles, launchedAtIso }`. Pairs with `[ERROR]`; `[ERROR]`
  remains the terminal signal for Monitor.
- **`[HANDOFF]` pre-terminal tag + `result.handoff` envelope.** When
  the retry budget is exhausted (or never existed, for
  `upstream:auth`), the bridge emits a multi-line `[HANDOFF]` block
  that carries everything another agent needs to continue: session
  ids, full paths to `.events` / `.worker.err` / `.diff` / `.plan.md`
  / `.review.json`, the original prompt (or its path), the `partial`
  snapshot, and the retry history. JSON envelope mirrors the same
  shape under `error.handoff`. `[HANDOFF]` precedes `[ERROR]` on the
  wire; Monitor self-terminates on the `[ERROR]` as usual.
- **`upstream_request_id` in `[ERROR]` blocks.**
  `extractUpstreamRequestId(message)` parses
  `/request id: ([0-9a-f-]{8,})/i` out of the upstream text and
  attaches it to: the `[ERROR]` block as a new `upstream_request_id:`
  line, the JSON envelope as `error.upstream_request_id`, and the
  handoff envelope's `upstream_request_id` field. Closes the "caller
  has to grep `.worker.err` to escalate to the proxy owner" gap
  surfaced in the Railway 401 session.
- **`job.retries[]` on `tracked-jobs`.** Each retry appends
  `{ attemptIso, origin, errorCode, backoffMs, outcome }`; never
  mutates prior entries. Surfaced in `status` / `result` JSON.

### Changed

- **`buildErrorEnvelope` signature.** Now accepts
  `{ command, partial, handoff }` options and threads `partial` +
  `handoff` + `upstream_request_id` onto the envelope when present.
  Back-compatible for callers that pass no options — pre-1.5.0
  envelopes without upstream metadata are unchanged.
- **`formatErrorEvent` signature.** Accepts optional
  `upstreamRequestId`; adds the line only when present, so existing
  `[ERROR]` blocks without an upstream id are byte-identical to
  pre-1.5.0.
- **`error-recovery.md` decision tree** rewritten around the new
  origin taxonomy. Branches on `origin:` first; the old dustbin
  "Other → read result log, assess" leaf is now the last fallback,
  not the only one. New anchors: `#response-chain-lost`,
  `#upstream-auth-401`, `#upstream-invalid-request`.
- **`notification-format.md` origin table** gains the three
  `upstream:*` rows and the `upstream_request_id:` field.
- **`SKILL.md` origin table** gains the three `upstream:*` rows plus
  a new "Upstream retry + handoff (v1.5.0)" subsection summarizing
  the retry / PARTIAL / HANDOFF flow.

### Fixed

- **Raw 401 / HTTP 400 falling into generic `internal`.** v1.4.1's
  classifier tier-1-matched only on `codexErrorInfo`; upstream
  proxies that deliver auth / validation errors as bare HTTP-status
  strings fell through to the `internal` bucket with the default
  "retry same thread" suggestion — wrong advice for auth (won't help)
  and dangerous for `previous_response_not_found` (retry repeats the
  400 against the dead resp_id). Tier-2 string matchers now classify
  these truthfully.
- **Retry-against-dead-response-chain misbehavior.** Pre-1.5.0 the
  suggested action block on a chain loss was a same-thread `send`;
  the only thing that works is a fresh `task` seeded from committed
  state. Action block and retry policy both reflect that now.

### Docs

- `skill/references/error-recovery.md` — new rows + 3 anchors
  + decision-tree rewrite.
- `skill/references/notification-format.md` — `[PARTIAL]`,
  `[RETRYING]`, `[HANDOFF]` tag sections; origin table extension;
  `upstream_request_id:` documented inside `[ERROR]` shape.
- `skill/references/orchestration-flows.md` — new
  "Recovering from upstream state loss" section with a 6-step
  worked recipe for consuming a handoff envelope.
- `skill/SKILL.md` — origin-table rows + "Upstream retry + handoff"
  subsection.

### Notes / non-goals

- **No `config.yaml` knobs for the retry policy this cycle.** Hard-
  coded defaults in `UPSTREAM_RETRY_POLICY`. Add knobs in a follow-up
  only when a real user reports the defaults are wrong.
- **`[HANDOFF]` is NOT in `DEFAULT_MONITOR_EXCLUDE`.** Orchestrators
  see it by default. It is also NOT added to `TERMINAL_TAG_REGEX` —
  the paired `[ERROR]` remains the single terminal signal for
  Monitor, preserving 1.4.0's exclusion-based contract.
- **Pipeline-stage errors do not enter the retry loop.** Only
  turn-level upstream errors are retried. Pipeline stages retain
  their existing per-stage timeout budget.

## [1.4.0] — 2026-04-19

Forward-compatible Monitor contract. The v1.3.0 observability work
(heartbeat, checkpoint, finally-backstop, 30-min turn budgets)
eliminated silent-failure modes but exposed a deeper architectural
flaw: the Monitor filter was an inclusion list. An orchestrator
passing `--filter DONE,ERROR,INCOMPLETE,PLAN,QUESTION,PIPELINE,…`
silently dropped any tag not on that list — including tags future
bridge versions would emit. v1.4.0 flips the contract.

### Added

- **`events --exclude <tags>` flag.** Drops listed tags, passes
  everything else. Mutually exclusive with `--filter`; passing both
  exits `2 USAGE_ERROR` before any file read.
- **`DEFAULT_MONITOR_EXCLUDE = ["HEARTBEAT"]`** exported from
  `src/lib/session-log.mjs` as the single source of truth for the
  default exclusion list. `buildMonitorHint`, `formatTailCommand`,
  and every re-attach hint inside `[HEARTBEAT]` / `[CHECKPOINT]`
  blocks consume it.
- **Unknown-tag forward-compat.** Under the default exclusion
  filter, any tag a future bridge version emits (e.g.
  `[NETWORK-STALL]`, `[FUTURE_TAG_V15]`) reaches the orchestrator
  verbatim. `tagOf` regex widened from `[A-Za-z:]+` to `[^\]]+`
  so digits / hyphens / underscores in tag names register as
  headers rather than silently-dropped continuation lines.
- **Multi-line block filter inheritance.** Continuation lines of
  a block (e.g. the `assistant:`, `tools:`, `diff:` body of
  a `[CHECKPOINT]` block) now inherit the header's inclusion
  decision. Pre-1.4.0 each line was filtered independently, so
  an included `[CHECKPOINT]` header shipped without its body — a
  latent bug since v1.3.0 introduced multi-line blocks.
- **Interrupt vs progress classification** in `skill/SKILL.md`
  and references: act-now tags (`[QUESTION]`, `[PLAN]`, `[DONE]`,
  `[ERROR]`, `[INCOMPLETE]`) vs periodic-scan tags
  (`[CHECKPOINT]`, `[PIPELINE:*]`, `[WARNING]`, `[CONFIRMED]`).
  Guides LLM orchestrators toward CHECKPOINT as the primary
  summary surface.

### Changed

- **Default Monitor hint uses `--exclude HEARTBEAT`** instead of
  a long inclusion list. Every `task --json` launch payload,
  `task --background` detached launch, and every `tail:` line
  printed inside `[HEARTBEAT]` / `[CHECKPOINT]` blocks now ship
  the forward-compatible shape by default. Orchestrators that
  paste `result.monitor.tool_hint` verbatim pick up the new
  default automatically.
- **`result.monitor.command` timeout raised to 1 800 000 ms**
  (30 min) to match the v1.3.0 turn-budget default.
- **Final-envelope shape** from `events --json --follow` now
  includes both `filter` and `exclude` fields — exactly one is
  non-null per invocation, per the mutual-exclusion CLI rule.
- **`DEFAULT_EVENTS_FILTER` removed** from
  `src/lib/session-log.mjs` (replaced by
  `DEFAULT_MONITOR_EXCLUDE`).

### Fixed

- **Inclusion filter dropped continuation lines of multi-line
  blocks.** Pre-1.4.0 the per-line filter predicate ran `tagOf`
  on each line; continuation lines (indented, no bracketed tag)
  returned `null` and were dropped. The new predicate tracks the
  most recent header's decision and applies it to subsequent
  continuation lines until the next header.
- **`tagOf` regex missed tags with digits / hyphens /
  underscores.** Widened to `[^\]]+` — the closing bracket is
  the only delimiter that can't appear inside a tag.

### Compatibility

- **Backward-compatible at the CLI.** Callers who explicitly
  pass `--filter <tags>` get pre-1.4.0 inclusion behavior
  unchanged. Only the *default* Monitor hint shape moved.
- **Orchestrators using `result.monitor.tool_hint` verbatim**
  pick up v1.4.0 transparently — the hint is now
  exclusion-based.
- **Hand-rolled `--filter` strings** in orchestrator code keep
  working but are forward-incompatible; update to
  `--exclude HEARTBEAT` to get future tags automatically.

### Docs

- `skill/SKILL.md` — non-JSON footer example, "Observability
  guarantee" section, new "Interrupts vs progress signals"
  subsection.
- `skill/references/monitor-patterns.md` — Preset A rewritten
  for exclusion default; Preset B, final-envelope shape,
  situation table updated.
- `skill/references/command-reference.md` — `events` synopsis,
  flag table, final-envelope example, recommended shape.
- `skill/references/notification-format.md` — `[HEARTBEAT]`
  block tail hint.
- `skill/references/orchestration-flows.md` — flow diagram,
  new "Handling unknown tags" forward-compat subsection.

### New gherkin scenarios

- `07-orchestration/10-events-exclude-flag.md`
- `07-orchestration/11-events-filter-exclude-mutually-exclusive.md`
- `07-orchestration/12-events-unknown-tag-passes-through.md`
- `01-lifecycle/05-monitor-default-excludes-heartbeat.md`

### Deferred to a future plan

Called out in the v1.4.0 plan so they aren't forgotten:
- Backpressure / ack protocol between bridge and Monitor.
- `events --since <tsMs>` cursor primitive for cheap re-attach.
- Splitting `[HEARTBEAT]` into a separate
  `<threadId>.heartbeat` file.
- Digest-only delivery (replacing streaming with a new
  `bridge digest` subcommand).
- `[ERROR]` disambiguation via a `final: { kind, action }`
  envelope field.
- fg/bg unification, supervisor daemon, typed JSON-RPC pushback.

## [1.2.9] — 2026-04-19

Hot-path auto-apply. Every `bridge task` / `send` / `result` / other
non-json non-update invocation now not only *detects* a newer release
(as 1.2.8 did via the anonymous probe) but also *applies* it —
spawning `npx -y skills@latest add yigitkonur/codex-bridge -a
claude-code -g -y` in the background, fire-and-forget, with all
output routed to `~/.codex-bridge/auto-update.log`. The current
invocation is never blocked; the new files land on disk before the
user's NEXT invocation.

1.2.8's `bridge update --apply` remains as the explicit synchronous
path for users who want to force-install immediately. The per-launch
stdout notice from 1.2.7 is gone — replaced by silent auto-apply.

### Changed

- **Cache TTL 24 h → 1 h** in `src/lib/update-check.mjs`. Aligns with
  the auto-apply rate-limit window. Previously 24 h meant a freshly
  released fix could wait a day before the user's install caught up;
  1 h closes that gap without hammering the anonymous API (60 req/hr
  × 1 h cache = at most 1 req/hr/workspace, well under the 60/hr/IP
  anonymous ceiling).

### Added

- **`maybeTriggerAutoApply`** in `src/codex-bridge.mjs` — replaces
  `maybeEmitUpdateNotice`. Guards are identical (opt out via
  `CODEX_BRIDGE_NO_UPDATE_CHECK=1`; skip `--json` / `update` / `version`
  / help / no-subcommand); on hot path it reads the 1 h cache, and
  when a newer release exists AND `shouldAttemptApply()` returns
  `true` (no attempt in the last hour), it claims the slot via
  `markApplyAttempted()` and spawns the installer detached.
- **`spawnDetachedAutoApply`** — detached spawn of `npx -y skills@
  latest add …` with `stdio: ["ignore", logFd, logFd]`. Log file
  rotates at ~2 MB to avoid unbounded growth on repeated failures.
  Banner written on each attempt:
  `[ISO-ts] auto-apply triggered for vX.Y.Z (from A.B.C)`. Spawn
  errors (e.g. `npx` not on PATH) captured silently to the log; the
  parent process never sees them.
- **`shouldAttemptApply` / `markApplyAttempted`** — exported helpers
  in `src/lib/update-check.mjs`. The per-hour apply-rate-limit
  marker lives in the same `update-cache.json` file as `checkedAt` /
  `latestVersion`, so no new filesystem state.
- **`APPLY_ATTEMPT_WINDOW_MS`** — exported constant (1 h), shared
  between the cache TTL and the apply marker so the two windows
  stay aligned.

### Removed

- **Per-launch stdout notice** — superseded by silent auto-apply.
  `formatUpdateNotice` is still exported (unchanged) for the
  `update` subcommand's own rendering path.

### Safety

- Never blocks the caller (detached + `.unref()`).
- Never writes to the caller's stdout/stderr (dedicated log file).
- Never throws (every code path that could throw is wrapped in
  try/catch that swallows).
- Rate-limited: one apply attempt per hour per workspace regardless
  of invocation frequency.
- Race-safe: `markApplyAttempted` runs BEFORE spawn, so concurrent
  invocations see the marker and no-op.
- Log rotation at ~2 MB prevents unbounded growth on repeated
  failure loops.

### Known behavior

- If `npx` is not on `$PATH`, the spawn fails silently. The log
  file records it. User can still run `npx skills add …` manually.
- The in-flight process continues to see the OLD version constant
  (imported from `package.json` at module load). The NEW files are
  visible to the NEXT invocation. This is by design — self-modifying
  a running script is worse than a one-invocation version skew.

## [1.2.8] — 2026-04-19

Repo flipped to public. Two changes follow from that: the 1.2.7 gh-CLI
fallback and token-reading become dead code (anonymous HTTPS now works
for every caller), and the bridge can finally do real auto-apply
without requiring the user to copy-paste `npx skills add …` into a
separate shell.

### Removed (dead code post-public)

- **`fetchLatestTagViaGh`** in `src/lib/update-check.mjs` — the
  spawnSync-gh fallback shipped in 1.2.7 to work around private-repo
  404s. Public repo means anonymous `https://api.github.com/repos/…/
  releases/latest` returns `200` with the release envelope directly.
- **`GITHUB_TOKEN` / `GH_TOKEN` env-var reading** — no longer needed
  and staying anonymous avoids burning the user's authenticated
  5000-req/hr budget on a probe that runs at most once per 24 h per
  workspace. Anonymous 60/hr/IP × 24 h cache is effectively unlimited
  for this access pattern.
- **Two-step resolver** collapsed into a single `fetchLatestTag` that
  does the anonymous fetch and returns `{ok:true, tag}` or
  `{ok:false, status, reason}`.
- **`source` envelope field** removed (the only remaining path is
  anonymous HTTPS, so the distinguisher has no value).
- **`renderUpdateFailureHint` gh/token branches** removed; the
  remaining hints cover the failure modes that can still fire
  (timeout / network / 403 rate-limit / 404 propagation lag).

### Added

- **`bridge update --apply` / `--yes`** — real auto-apply. When
  `--apply` is set and a newer release exists, the bridge spawns
  `npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y`
  for you, inherits its terminal (or captures stdout/stderr under
  `--json`), and reports the outcome in the envelope:
    - Success → `result.applied: true`, exit 0, rendered message
      tells you to re-invoke the skill to pick up the new files.
    - Failure (installer exited non-zero, npx missing, etc.) →
      `ok: false` error envelope with `class: dependency_failed`,
      `code: UPDATE_APPLY_FAILED`, `retryable: true`, and the
      manual install command in `suggestion`.
  Default behavior (no flag) remains detect-only so scripted callers
  don't get install side-effects they didn't ask for.
- **`formatUpdateNotice`** copy updated to mention `--apply` as an
  alternative to the full `npx skills add …` command.

### Docs

- `SKILL.md` Troubleshooting: replaced the "private repo + gh
  fallback" recovery block with a one-liner about the anonymous
  probe and a pointer to `update --apply`.

### Verified

- `env -i HOME PATH=<node-only>` (no token, no gh on PATH) →
  `has_update: false, latest_version: "1.2.7"` — anonymous HTTPS
  works end-to-end with zero auth plumbing.
- Synopsis advertises `update [--force] [--apply|--yes] [--json]`.
- `update --apply` on a current install returns `has_update: false,
  applied: false` without invoking `npx`.

## [1.2.7] — 2026-04-19

Auto-update actually works for private repos now. The 1.2.6 install test
surfaced a silent failure: `bridge update` reported "you're on the latest"
on a 1.2.3 install three versions behind, because the update checker
hits `https://api.github.com/repos/…/releases/latest` which 404s on
private repos without an `Authorization` header. The 404 was swallowed
as "no update info this time" with no user-visible signal.

### Fixed

- **`update` gh-CLI fallback** — `src/lib/update-check.mjs::fetchLatestTag`
  is now a two-step resolver: direct HTTPS first (cheapest, works for
  public repos and private-with-token), then `gh api repos/…/releases/
  latest` via `spawnSync` when the direct call returns 404. The gh
  fallback uses the user's existing authenticated gh session — same
  credentials the install path (`npx skills add …`) already needs — so
  no new secret surface. Silent on failure (missing gh, unauthenticated
  gh, wrong host): same "no update info" result as a failed direct fetch.
- **`update` failure diagnostic** — non-JSON `update --force` now prints
  an actionable hint when the fetch fails, instead of the pre-1.2.7
  opaque `Update check skipped (fetch-failed-no-cache)`. The message
  names the failure signature (e.g. `direct-http-404+gh-not-installed`)
  and suggests the concrete fix: install gh + `gh auth login`, or
  export `GH_TOKEN` / `GITHUB_TOKEN`.
- **`--json` envelope** now surfaces `result.source` on success
  (`"http-token"` / `"http-anon"` / `"gh-cli"`) and
  `result.fetch_reason` + `result.fetch_status` on failure so scripts
  can branch on which path the checker took.

### Docs

- `SKILL.md` Troubleshooting: added the "auto-update silently says
  up-to-date" recovery flow.

### Verified

- `env -i HOME PATH=<node-dir-only>` reproduced the silent failure from the
  1.2.6 install test: pre-1.2.7 returned `latest_version: null`; post-1.2.7
  returns an actionable hint naming `direct-http-404+gh-not-installed`.
- With `gh` on `$PATH` (no token), `update --json` returns
  `source: "gh-cli"` and the correct latest version.
- With `GH_TOKEN` in env, `source: "http-token"` (unchanged behavior).
- For public repos (unauthenticated direct fetch succeeds), `source: "http-anon"` — no change to hot path.

## [1.2.6] — 2026-04-19

Docs-only follow-up after the 1.2.5 audit. Zero code changes — every fix
is in `skill/SKILL.md` or under `skill/references/`. Goal: close the gap
between "what 1.2.5 code actually does" and "what SKILL.md / references
teach agents to do." SKILL.md is the only guaranteed-read doc, and the
audit found ~20 derailment-risk items that never propagated from the
1.2.5 code commits into the reader-facing text.

### Fixed (contradictions + stale claims in SKILL.md)

- **Canonical Monitor filter** — extended to `DONE,ERROR,INCOMPLETE,PLAN,QUESTION,PIPELINE,WARNING`. Pre-1.2.6 the canonical example used a narrower filter; agents pasting it missed the `[PIPELINE:*:done]` signals shipped in 1.2.5 and every `[WARNING]` from the circuit breaker.
- **"~5 minutes is stuck"** at `SKILL.md:77` was nonsense after 1.2.5 raised the idle watchdog default to 300 s (= 5 min). The watchdog already fires at the 5-min mark; the threshold is now expressed as "past the relevant timeout plus a buffer" with the full matrix inlined.
- **Auto-pipeline "silent"** at `SKILL.md:70` was pre-1.2.5 text. Rewritten to name the observable tags (`[PIPELINE:<stage>]` + `:done` + terminal `[PIPELINE:done|failed]`) plus `result.pipeline.touchedFiles`.
- **"Do not use threadId" vs "accept either"** — three separate lines contradicted each other (`SKILL.md:77` / `:106` / `:146`). Replaced with a single framing: both accept either, prefer jobId because it's deterministic, reserve threadId for `send`/`steer`.
- **Pre-1.2.5 async section** at `SKILL.md:115-131` with `THREAD_ID=<from output>` placeholders deleted — it was literally the "parse stderr" anti-pattern the canonical block warns against.
- **`:146` "accept either" list** now includes `events` and `wait` (previously only named status/result/cancel).
- **Session-files tag list** updated to include `[PIPELINE:*:done]`, terminal `[PIPELINE:done|failed]`, and `[WARNING]`.
- **`SKILL.md:255` "Not currently produced"** framing reversed — lead with what IS produced, mention reserved-but-not-emitted as a brief addendum.
- **`orchestration-flows.md` `Round-3` internal-incident vocabulary** generalized to "a prior incident".
- **`orchestration-flows.md:44` fg/bg mode caveat** corrected — `--background --mode default` is honored post-1.2.1; prior text claimed the override was silently dropped. SKILL.md and orchestration-flows now agree.
- **`command-reference.md:23` exit code 8** removed — the table listed "partial success" but no code path emits it.

### Added (1.2.5 capabilities now surfaced in always-read and reference docs)

- **`SKILL.md` identifier primer** at the top — first thing an agent reads. Names the derailment (threadId-grab from stderr) and the canonical handles.
- **`SKILL.md` "Timeout budgets" table** inlined — all six configurable timeouts (idle / turn-plan / turn-default / pipeline-stage / pipeline-total / question-answer) with flag + config key + default in one place.
- **`SKILL.md` "Task-launch flags" table** — lists `--no-pipeline`, `--quiet`, every timeout override, with a worked scaffold example.
- **`SKILL.md` `[PIPELINE:*:done]` and `[WARNING]` response sections** under "Responding to Events" — tells agents what the symmetric `:done` tags mean and how to react to circuit-breaker warnings.
- **`SKILL.md` Post-[DONE] checklist** lifted into the `[DONE]` section (previously only in `orchestration-flows.md`). Five bullets: confirm pipeline stopped / read touchedFiles / don't edit files Codex just wrote / don't use a generator as its own verification / verify on the committed tree.
- **`SKILL.md` workspace-dirty phase** documented (previously only in orchestration-flows.md).
- **`SKILL.md` shipped defaults that change Codex's behavior** — `sandbox_policy: "danger-full-access"` and `skip_meta_skills: true` called out in "How It Works" with one-line explanations each.
- **`SKILL.md` "When NOT to use Monitor"** lifted from `monitor-patterns.md` — addresses the round-2/3 derailment where Monitor was re-armed 9× on `xcodebuild`.
- **`SKILL.md` Troubleshooting** — added `config show`, `status --prune-orphans`, `~/.codex-bridge/crashes/`, and the Claude Code + Xcode DerivedData gotcha.
- **`command-reference.md` `task`/`send`/`status`/`events` tables** — every 1.2.5 flag added (`--no-pipeline`, `--quiet`, all `--*-ms` timeouts, `--prune-orphans` / `--cleanup`). `events --json --follow` return-envelope shape documented (`terminalTag`, `terminalLine`, `elapsedMs`).
- **`command-reference.md` `status --prune-orphans` body section** added (subcommand was previously unmentioned in prose).
- **`config-reference.md` Options table** — six new timeout keys added: `idle_timeout_ms`, `turn_plan_ms`, `turn_default_ms`, `pipeline_stage_ms`, `pipeline_total_ms`, `question_answer_ms`.
- **`config-reference.md` Examples** — added "large scaffold with raised budgets" and "slow human-in-the-loop answering" examples.
- **`notification-format.md` `[PIPELINE:*]` section** rewritten to include `:done` pairs, terminal `[PIPELINE:done|failed]`, and the `files=[…]` format on `[PIPELINE:fix:done]`.
- **`monitor-patterns.md` Preset A** — final-envelope shape documented; `run_in_background: true` note corrected (it returns a handle, doesn't block).
- **`ndjson-guide.md`** — added `PIPELINE_SKIPPED` (1.2.5 `--no-pipeline`) and `CIRCUIT_BREAKER` rows; `PIPELINE_COMPLETE` carries `touchedFiles`; new section "Finding a `<turn-id>` for `steer`".
- **`error-recovery.md` ClientTimeout branch** — 5 origins now spelled out individually with first-response actions (idle / turn / pipeline-stage / pipeline-total / question) since all five surface under the same `ClientTimeout` tag.
- **`prompt-writing.md` bridge-specifics** — what Codex actually reads (the `[ORCHESTRATOR DIRECTIVE]` preamble + `prompt_footer`), plan-mode vs execute-mode expectations, effort/sandbox implications.

### Changed (attention-budget pruning in SKILL.md)

- **jobId/threadId guidance** was restated 9× across `SKILL.md`. Consolidated into a single top-level "Identifiers" section.
- **Monitor command pattern** appeared 3× (canonical / async / streaming). Collapsed to one canonical block + a pointer from "Advanced".
- **Heartbeat shell one-liner** (~150 chars) moved out of always-read SKILL.md to `monitor-patterns.md` Preset C (where it already lived; duplication removed).
- **"Advanced" section** reduced to bullet pointers; steer / wait / events-streaming / retrospective / heartbeat details now live in the references only.
- **Session Files section** shrunk; "Not currently produced" disclaimer moved inline.
- **Configuration section** rewritten around load-bearing keys (`sandbox_policy`, `skip_meta_skills`, `command_failure_circuit_breaker`) alongside the runtime-tuned ones.
- **Sync quick-start example** replaced "What is 2+2?" with a realistic rename prompt. The trivial-math example contradicted the very next paragraph's warning that sync stalls on trivial prompts.
- **"Non-JSON shortcut (for humans at a shell)"** reframed as "Fallback when jq isn't available" — LLM agents were skipping a section titled "for humans."
- **Footer example** reframed from a shell-comment block to an explicit "printed verbatim after Codex's output" label.

### Hygiene

- **`allowed-tools` frontmatter** broadened from `Bash(node *) Monitor` to `Bash Monitor` — examples legitimately use `jq`, `git`, `pgrep`, `tail`, `test`.
- **`${CLAUDE_SKILL_DIR}` fallback note** added once at the top of SKILL.md ("substitute the install path if the variable isn't set") — previously 22 examples referenced the variable with no fallback guidance.
- **`config-reference.md`** dropped the "v1.1.0 / v1.1.1 new" framing in favor of describing current behavior.

### Architectural follow-ups (still out of scope)

Unchanged from prior rounds: fg/bg unification, broker-socket liveness as the idle signal, typed JSON-RPC pushback replacing tag-on-stdout, supervisor daemon, startup-time automatic orphan reaper (the manual `status --prune-orphans` in 1.2.5 covers the 90% case).

## [1.2.5] — 2026-04-19

Round-2 follow-ups after 1.2.4 landed in production. The acute bridge
bugs in 1.2.4 are gone (no more orphaned foreground jobs, no more false
120s stalls, no more JOB_NOT_FOUND on thread UUIDs for live jobs), but
three more derailment classes showed up under real use:

  1. release hygiene — 1.2.4 itself shipped with a hard-coded
     `BRIDGE_VERSION = "1.2.3"` and a SKILL.md frontmatter reading
     "1.2.3", so `version --json` reported a stale number and three
     doc sites still taught the old 120s watchdog;
  2. UX steering — agents reading stderr `[codex] Thread ready (…)`
     progress lines grabbed the thread UUID as a job handle and hit
     JOB_NOT_FOUND on Monitor; the canonical SKILL.md example did
     nothing to discourage this;
  3. pipeline visibility — `[PIPELINE:*]` only had start-tags, so an
     orchestrator seeing `[DONE]` couldn't tell whether the auto-fix
     stage was still writing to the repo; round-3 spent 15 min blindly
     reconciling a phantom "pipeline rewrote my files" diff.

### Fixed

- **Version drift (R1/R2/R3):** single source of truth — `BRIDGE_VERSION`
  is imported from `package.json` at build time via
  `import … with { type: "json" }` and esbuild inlines it. Pre-1.2.5
  the constant was hard-coded in `src/codex-bridge.mjs:620` and drifted
  whenever `package.json` was bumped without a corresponding src edit.
  `skill/SKILL.md` frontmatter and doc references to "120 s watchdog"
  are swept.
- **`[PIPELINE:*]` start-tags had no matching done-tags (P1/P3):** every
  pipeline stage (`diff`, `review`, `fix`, `check`) now emits both
  `[PIPELINE:<stage>]` (start) and `[PIPELINE:<stage>:done]` (end) to
  the events file. The fix stage's done-tag carries a
  `files=[…]` detail listing exactly which files the pipeline wrote
  (computed from a `git diff --name-only HEAD` before/after snapshot).
  Terminal `[PIPELINE:done]` / `[PIPELINE:failed]` closes out the
  whole pipeline. `result.pipeline.touchedFiles` surfaces the fix list
  on `task --json` for scripted consumers.
- **`kindLabel: "rescue"` for every user task (U3):** misleading — the
  historical "rescue" label was stop-gate-review-only and made
  orchestrators think every `status` entry was an auto-recovery job.
  `buildTaskRunMetadata` now sets `kindLabel: "task"` for user tasks
  and `kindLabel: "rescue-review"` for stop-gate jobs; legacy state
  records without an explicit `kindLabel` fall through to `"task"`
  instead of `"rescue"`.

### Added

- **Foreground-task footer (U2):** non-JSON `task`/`send` rendered
  output ends with `Job: <id> · Events: <path> · Monitor: <command>`.
  Single line, canonical jobId — orchestrators no longer need to run
  `--json | jq` or pattern-match the threadId from stderr to get the
  handle that `status`/`result`/`events` accept.
- **`--no-pipeline` flag (P2)** on `task` / `send` — per-invocation
  override for `auto_review:false` + `post_task_prompt:""`. Agents
  orchestrating their own completion checks no longer have to edit
  `config.yaml`.
- **Configurable turn / pipeline / question timeouts (T1–T4):**
  `--turn-plan-ms`, `--turn-default-ms`, `--pipeline-stage-timeout-ms`,
  `--pipeline-total-timeout-ms`, `--question-timeout-ms` on `task`
  (plus a single `--turn-timeout-ms` on `send`). All five new config
  keys in `DEFAULT_CONFIG`: `turn_plan_ms`, `turn_default_ms`,
  `pipeline_stage_ms`, `pipeline_total_ms`, `question_answer_ms`.
  Resolution flag → config → default; malformed values throw usage
  (exit 2). Same pattern as the 1.2.4 `--idle-timeout-ms` fix.
- **`--quiet` flag (D1)** on `task` / `send` — suppresses the
  `[codex] …` stderr progress stream. Eliminates the threadId-grab
  vector entirely for agents that tail Monitor / `events --follow`.
- **`events --follow --json` final envelope adds `terminalTag`,
  `terminalLine`, `elapsedMs` (D3):** Monitor can now distinguish
  `[DONE]` close from timeout without re-reading the file.
- **`status --prune-orphans` / `--cleanup` subcommand (D4):** walks
  `state.jobs` for `status:"running"|"queued"` with dead PIDs
  (`process.kill(pid, 0) → ESRCH`), transitions each to
  `status:"orphaned"` with a reap-note. Idempotent. Closes the
  observation/06 fix list.
- **`result.eventsPath` and `result.jobId` at payload top level (D6):**
  previously agents had to regex `result.monitor.command` to extract
  the events path. Now they read a typed field.
- **Crash-log trap (A3):** `process.on("unhandledRejection")` and
  `process.on("uncaughtException")` handlers write a JSON dump to
  `~/.codex-bridge/crashes/<ts>-<pid>.log` and emit a single stderr
  pointer line before the process exits. Does not swallow the crash
  — exit code still non-zero — but closes the
  "launcher exit 1 with no explanation" observability gap (the
  reported circuit-breaker suspicion was incorrect: the breaker
  only logs `WARNING`/ndjson and leaves exit code alone).

### Changed

- **SKILL.md canonical example (U1):** rewritten to use `--json` and
  paste `result.monitor.tool_hint` into Claude Code's Monitor tool.
  Steers agents away from grabbing the thread UUID out of stderr
  progress lines — the single strongest derailment signal in the
  round-1 and round-2 logs.
- **"When NOT to use Monitor" section (S1)** in
  `skill/references/monitor-patterns.md` — Monitor is only for
  codex-bridge `.events` files. `xcodebuild` / `npm test` / `pytest`
  should use `Bash` with `run_in_background`. The transcript's 9
  Monitor invocations on a single `xcodebuild` run is the exact
  anti-pattern.
- **"Post-[DONE] checklist" (S2/S3)** in
  `skill/references/orchestration-flows.md` — don't edit files Codex
  just wrote; don't use a generator (xcodegen / protoc / prisma /
  etc.) as verification for its own output (ordering is
  non-deterministic); verify on the committed tree, not the working
  copy. Addresses round-3's regeneration-noise reconciliation.
- **DerivedData note (S4)** in
  `skill/references/error-recovery.md` — in Claude Code on macOS,
  Xcode's `build.db` fails if DerivedData lives inside the workspace.
  Use `-derivedDataPath /tmp/<project>-dd …`.

### Docs

- New gherkin scenarios under `gherkin-tests-v2/`:
  - `03-config/XX-version-source-of-truth.md`
  - `06-artifacts/XX-pipeline-done-tags-on-events.md`
  - `05-ambiguities/XX-task-kindlabel-not-rescue.md`
  - `01-lifecycle/XX-turn-timeout-configurable.md`
  - `07-orchestration/XX-status-prune-orphans.md`
  - `04-errors/XX-uncaught-exception-leaves-crash-log.md`
  - `07-orchestration/XX-events-json-final-envelope.md`
  - `06-artifacts/XX-foreground-task-footer.md`
  - `07-orchestration/XX-no-pipeline-flag.md`

### Pushback on A3 (circuit breaker → exit 1)

The user's suspicion that v1.2.3's `fix(wrapper-regex)` circuit breaker
trips exit 1 on some invocation pattern does not hold up against the
code. `src/codex-bridge.mjs:1706-1754` shows the breaker only writes
a `[WARNING]` event + `CIRCUIT_BREAKER` ndjson record, and sets
`turnInterrupted:false`. It never mutates exit code. Could not
reproduce the reported exit-1 in a live smoke (`task --write
--background 2>&1 | tee | head`, `task … > /tmp/log 2>&1`, etc., all
exit 0). Instead of a speculative pattern-tightening that would risk
false-negatives on the legitimate Codex-wrapper detection, 1.2.5
installs an uncaughtException / unhandledRejection trap that records
a crash log next time an unexplained exit-1 occurs. That trail will
identify the real source — whatever it turns out to be.

### Architectural follow-ups (still out of scope)

Still deferred (round-1 list still valid): fg/bg unification, broker-
socket liveness as the idle signal, typed JSON-RPC pushback replacing
tag-on-stdout, supervisor daemon.

## [1.2.4] — 2026-04-19

Three bugs surfaced during a live Claude→Codex delegation. All three
were bridge-side, not caller error.

### Fixed

- **Foreground `task` no longer dies on EPIPE.** Installing `task` output
  through a closed pipe (`bridge task … | tee … | head -N`) previously
  killed the wrapper Node process mid-turn and left the Codex-side job
  `orphaned` while the app-server was still healthy. `main()` now ignores
  `SIGPIPE` and swallows `EPIPE` / `ERR_STREAM_DESTROYED` on stdout and
  stderr (`src/codex-bridge.mjs` top-level guards). Background workers
  were already immune via `stdio:"ignore"`; this brings foreground paths
  to parity.
- **`events <thread-id>` now works for running jobs.** `resolveResultJob`
  previously checked `job.threadId` only in the terminal-status branch,
  so a thread UUID passed to `events`/`wait` for a still-running job
  fell through to `JOB_NOT_FOUND`. The active-match block now also
  compares `job.threadId`, restoring the "either id works" contract
  advertised in `SKILL.md:77` for all job states.

### Changed

- **Idle-timeout watchdog is now configurable; default raised from
  120s to 300s.** Reasoning-heavy Codex turns (e.g. planning across
  many files between `item.completed` notifications) could legitimately
  exceed the prior 120s gap and false-positive as "stuck." Three
  resolution layers now apply (most specific wins):
  - `--idle-timeout-ms <ms>` flag on `task` and `send`
  - `idle_timeout_ms` in any config.yaml layer
  - Built-in default `300_000` in `DEFAULT_CONFIG` (`src/lib/config.mjs`)
  A malformed flag value throws `usage` (exit 2) rather than silently
  falling back — callers notice the typo. Idle-timeout error message
  reworded from "(possible stuck)" to "(idle timeout)." — the regex
  in `src/lib/cli-errors.mjs:171` still matches both.

### Docs

- New gherkin scenarios:
  - `04-errors/06-foreground-task-survives-epipe.md`
  - `01-lifecycle/04-idle-timeout-configurable.md`
  - `07-orchestration/09-events-accepts-thread-id-for-running-job.md`

### Root-cause trace

Broader architectural follow-ups (fg/bg unification, broker-socket
liveness, typed identifier resolver, feature-flag orthogonalization)
are scoped for a separate release.

## [1.2.3] — 2026-04-19

Wrapper-regex widening. v1.2.2's `isFailureHidingWrapper` matched
`... & [optional sleep]; kill` but missed the real form observed in
Codex logs: `... & pid="$!"; sleep 2; kill -INT $pid; wait $pid` — the
`pid=` assignment between the `&` and the `kill` broke the old regex.
v1.2.3 widens the `&-kill` arm to `(?:^|[^&])&(?![&])[\s\S]{0,200}?\bkill\b`
which (a) catches the real Codex pattern and (b) correctly *excludes*
`foo && kill bar` where `&&` + `kill` is a legitimate "after success"
construct (bonus false-positive fix over v1.2.2).

### Fixed

- `isFailureHidingWrapper` regex widened to catch the observed real
  Codex wrapper form `... & pid="$!"; sleep N; kill -TERM $pid`. The
  v1.2.2 regex expected `kill` to directly follow the `&` (possibly
  after a `sleep`); the new single-`&`-then-anything-then-`kill` form
  catches any shell background-and-kill idiom within 200 chars.
- `foo && kill bar` no longer matches the wrapper detector (the v1.2.2
  version did — bonus false-positive elimination).

### Docs

- `07-orchestration/07` predicate gains two scenarios: `s10` pins the
  real-form wrapper detection, `s11` is the `&&` regression guard.
  Predicate 11/11 passes offline.



Circuit-breaker behavioral upgrade. The v1.2.0 "3 strictly consecutive
same-family fails" threshold survived the v1.2.1 regression retest only
in spec; a live retest (T4) showed Codex routinely bypasses the
threshold by wrapping failing commands in `& sleep N; kill -TERM $!`
constructs that exit 0 — the consecutive counter reset on every wrapper
and never reached 3. v1.2.2 upgrades the detector.

### Changed

- **`command_failure_circuit_breaker` now uses a sliding window + wrapper
  detection.** Same-family failures are counted within a window of the
  last 5 commandExecutions; `[WARNING]` fires when 3 of those 5 are
  failures. Successful commands DO enter the window (not ignored), so
  interleaved successes no longer shield flailing. In addition,
  monitored-family commands that exit 0 but contain a known
  failure-hiding construct (`& kill`, `|| true`, `|| exit 0`,
  `; true` at end) are counted as failed regardless of exit code.
- NDJSON `CIRCUIT_BREAKER` record now carries `failsInWindow` (3-5),
  `windowSize` (5), and `wrapperDetected` (bool) so downstream tooling
  can distinguish raw structural failure from masked-by-wrapper failure.

### Docs

- `skill/references/config-reference.md` `command_failure_circuit_breaker`
  section rewritten to describe the sliding-window + wrapper semantics
  and reference the v1.2.2 behavior upgrade.
- `sandbox_policy` section gains a **macOS caveat** documenting that
  Apple seatbelt's `workspace-write` enforcement is best-effort: on some
  OS+Codex combinations `.git/` writes succeed, so the `workspace-dirty`
  phase is not guaranteed triggerable on macOS. Linux sandboxes are more
  consistently restrictive. This addresses the T3 "inconclusive" finding
  from the v1.2.1 retest.
- `07-orchestration/07-circuit-breaker-trips-on-repeated-family.md`
  rewritten: 6 scenarios → 9, covering sliding window, wrapper
  detection, window age-out, and the existing regression guards.
  Predicate 9/9 passes offline.



Hot-fix release. v1.2.0 introduced three opt-out-by-config defenses driven
by `runBridgeTask` (session-logging hooks, `skip_meta_skills` directive,
`sandbox_policy` resolution, `command_failure_circuit_breaker`). Live
retesting discovered that the detached `task-worker` on the background
path called `executeTaskRun` directly, bypassing `runBridgeTask` entirely
— so `task --background` completed turns successfully (assistant output
captured, job record transitioned to `completed`) but produced **zero
session artifacts**. `wait $jobId` timed out with `WAIT_TIMEOUT`, `events
--follow` had nothing to tail, and the async+Monitor contract documented
in `skill/SKILL.md` silently broke for every background caller.

### Fixed

- **`task --background` now produces `.events`, `.ndjson`, and `.diff`
  session files.** `handleTaskWorker` at `src/codex-bridge.mjs:2054` now
  calls `runBridgeTask` instead of `executeTaskRun` — identical contract
  to the foreground path, including `onTurnStart`/`onItemCompleted`/
  `onServerRequest` hooks, prompt decoration (`skip_meta_skills`,
  `prompt_footer`), config-aware sandbox-policy resolution, `[QUESTION]`
  handling, and the auto-pipeline. The foreground path was always
  correct; only the detached worker was stripped.
- **`onTurnStart` no longer swallows exceptions silently.** The empty
  `catch {}` at `src/lib/codex.mjs:1140` is replaced with
  `emitProgress(options.onProgress, …)` so any throw from
  `findSession` / `initSession` / `logNdjson` lands in the per-job `.log`
  and the job record instead of vanishing. This is the observability
  primitive that would have caught the v1.2.0 regression in testing.
- **Detached worker stderr is now captured.** `spawnDetachedTaskWorker`
  used `stdio: "ignore"` which swallowed every uncaught exception in the
  detached child. v1.2.1 redirects fd 2 to `${logFile}.worker.err` — an
  empty file on the happy path, a readable stacktrace on crashes.

### Docs

- New gherkin spec: `07-orchestration/08-background-path-produces-session-files.md`
  pinning the foreground/background parity invariant live. This test
  would have failed on v1.2.0 and caught the regression pre-ship.



Session-derailment defenses release. Closes the full five-bug user report
covering a swift-vibescroll session where Codex (a) flailed on sandbox-
blocked `.git/` writes, (b) looped on `osascript` / `display dialog`
probes against a headless environment, (c) had upstream WebSocket drops
misclassified as non-retryable, (d) burned ~10 min on internal meta-skill
ceremony producing spec/plan files that were not part of the deliverable,
and (e) produced committable diffs but could not finalize them.

### Added

- **`sandbox_policy` config key** — `"danger-full-access"` (new shipped
  default), `"workspace-write"`, `"read-only"`. `"danger-full-access"`
  maps to upstream `SandboxPolicy::DangerFullAccess` and mirrors
  `codex --dangerously-bypass-approvals-and-sandbox`, lifting the
  workspace-write restriction on `.git/` metadata. Users who want a
  stricter profile opt into `"workspace-write"` or `"read-only"`.
  Unknown values silently fall back to the mode-derived default so a
  typo cannot widen permissions.
- **`workspace-dirty` phase** for `task --json` envelopes. Emitted when
  Codex produced file changes but the turn ended with
  `codexErrorInfo: "SandboxError"`. Returns a success envelope (exit 0)
  with a ready-to-run `git -C <cwd> add -A && git commit` next-action
  instead of the previous misleading `phase:"error"` with
  "retry with adjusted prompt" guidance.
- **`skip_meta_skills` config key** (default `true`). Prepends a
  mode-aware `[ORCHESTRATOR DIRECTIVE]` to every prompt instructing
  Codex to skip its internal planning/ceremony skills
  (`using-superpowers`, `brainstorming`, `writing-plans`,
  `using-git-worktrees`). Plan-mode turns get "produce a concise inline
  [PLAN] and stop"; execute-mode turns get "execute it directly".
- **`command_failure_circuit_breaker` config key** (default `true`).
  Counts consecutive same-family command failures across
  `osascript`, `applescript-dialog`, `applescript-system`, `open-app`,
  `computer-use`. Emits a `[WARNING]` event to `.events` after `N=3`
  consecutive failures so an orchestrator tailing via Monitor can
  cancel/steer. Logging-only today; auto-interrupt is documented as
  an enhancement candidate.
- **`[WARNING]` notification tag** — first non-terminal info tag in the
  emitted vocabulary. `events --follow` does NOT self-terminate on it
  (the TERMINAL regex at `src/codex-bridge.mjs` still matches only
  `DONE|ERROR|INCOMPLETE`). Matching NDJSON writer: `CIRCUIT_BREAKER`.
- **`formatWarningEvent`** in `src/lib/session-log.mjs`.
- Gherkin specs: `03-config/04` (sandbox), `03-config/05` (skip_meta_skills),
  `03-config/06` (circuit-breaker config), `04-errors/05` (upstream
  disconnect classifier), `07-orchestration/06` (workspace-dirty),
  `07-orchestration/07` (circuit-breaker behavior). Each ships with an
  offline pass/fail predicate — no Codex spawn required.

### Fixed

- Upstream WebSocket drops mid-turn now classify as
  `{class:"network", code:"UPSTREAM_STREAM_DISCONNECTED", retryable:true,
  exit:7}`, unblocking the orchestrator's automatic retry for this
  textbook transient. Two layers: (a) the `turn/completed` handler in
  `src/lib/codex.mjs` now merges `turn.error` into `state.error` when
  the turn didn't complete, so `codexErrorInfo` tags reach
  `classifyError`; (b) `src/lib/cli-errors.mjs` gains a regex fallback
  for transport drops that never produce a terminal `turn/completed`
  (`stream disconnected | websocket closed | no close frame |
  ECONNRESET | ETIMEDOUT | socket hang up`). The typed
  `CODEX_ERROR_INFO` table runs first so correctly-tagged errors
  (`Unauthorized`, `SandboxError`, etc.) keep their specific
  classification.
- **`executeTaskRun` no longer drops seven `runBridgeTask`-built fields**.
  Pre-fix, `sandboxPolicy`, `collaborationMode`, `turnTimeoutMs`,
  `idleTimeoutMs`, `onTurnStart`, `onItemCompleted`, and
  `onServerRequest` were silently discarded at `executeTaskRun`'s
  `runAppServerTurn` call site — defeating `config.sandbox_policy`,
  plan-mode developer instructions, the 120 s idle watchdog, NDJSON
  logging hooks, and the `[QUESTION]` pipeline on the `task` path.
  Forward all fields explicitly.
- `handleSend` without `--mode` now honors `config.sandbox_policy`.
  Previously `sandboxPolicy` was only set inside the
  `if (modeOverride)` block, so a plain `send <tid> "prompt"` silently
  ignored the config.
- `workspace-dirty` `next_action.command` shell-quotes `request.cwd`
  via `JSON.stringify()` (matches the `buildMonitorHint` pattern). Paths
  with spaces no longer break the suggested git command.
- `detectCommandFamily` reordered so content-based patterns
  (`display dialog`, `System Events`, `tell application`) run before
  invocation umbrellas (`osascript`, `open -a`). `osascript -e 'display
  dialog "…"'` — the most common invocation form — now correctly
  classifies as `applescript-dialog` instead of the broad `osascript`.
  Pre-fix, the `applescript-dialog` and `applescript-system` families
  were unreachable for AppleScript run via `osascript -e`.
- `skip_meta_skills` directive is mode-aware. The original wording
  included "execute it directly" in **every** mode, which contradicted
  plan mode's "plan first, don't execute yet" intent.

### Changed

- **Default sandbox is now `danger-full-access`** (was mode-derived
  `workspace-write`). This is the practical fix for the reported
  derailment where Codex misinterpreted `.git/` write denials as puzzles
  to solve (attempting `osascript` / `display dialog` to reach a
  human-operated Terminal). Users who relied on the pre-v1.2.0 strict
  default can set `sandbox_policy: "workspace-write"` in their
  `config.yaml`.
- `src/lib/AGENTS.md` sandbox-policy table updated to reflect the new
  default. The prior "we do not use `dangerFullAccess`" invariant was a
  reflection of then-current behavior, not a permanent architectural
  constraint.

### Docs

- `skill/references/config-reference.md` — three new config keys
  documented with their full matrices.
- `skill/references/notification-format.md` — `[WARNING]` tag added
  with format template, emission conditions, non-terminal semantics.
- `skill/references/orchestration-flows.md` — `workspace-dirty` phase
  row added to the phase table.



Audit-driven cleanup release. Resolves `unexpected-bridge-observations/`
entries 06 and 08 end-to-end, completes the remaining 2 of 5 fixes for
obs 07, updates specs + reports to reflect the post-fix reality. No
breaking changes.

### Added

- **`bridge config show [--json]`** — prints the effective merged config
  along with each of the four source files (and whether each exists).
  `*` markers in rendered output flag keys that differ from
  `DEFAULT_CONFIG`. Closes obs 07 fix #4.
- **Workspace-root config layer**. `loadConfig` now reads four layers
  instead of three: `DEFAULT_CONFIG < skill-dir < workspaceRoot < cwd`.
  A user running a command from a subdir of a git repo now picks up
  `$(git rev-parse --show-toplevel)/config.yaml` between the skill
  defaults and any cwd-level override. Closes obs 07 fix #5.
- **`initSession` in the review handlers** — both `review` and
  `adversarial-review` now create `.events` + `.ndjson` files for their
  thread and write a `TURN_COMPLETED` record. `adversarial-review`
  additionally calls `writeReview` to persist its findings to
  `{threadId}.review.json` (the previously-phantom function now has a
  real caller). `bridge summary <review-tid>` and Monitor tooling can
  now inspect review threads. Closes obs 08.

### Changed

- **`loadState` is now self-reaping** — on every state read, walks the
  job list, probes each `status ∈ {running, queued}` job's pid with
  `process.kill(pid, 0)`, and transitions ESRCH entries to `orphaned`
  with a dated `errorMessage`. Idempotent + cheap + writes-back only
  when something actually changed. Closes obs 06. Empirically verified:
  inject a job with `pid: 999999`, run `bridge status`, the job flips to
  `orphaned`.

### Fixed

- Update-check now honors `GITHUB_TOKEN` / `GH_TOKEN` env vars. Without
  auth, unauthenticated requests against a private repository return 404
  and the check silently skips (`check_skip_reason:
  "fetch-failed-no-cache"`). With a token set, the check succeeds and
  returns the real `latest_version`. GH Actions workflows and developers
  running `gh auth login` get working checks for free; nothing else
  breaks if the token is absent.

### Docs

- `gherkin-tests-v2/07-orchestration/04-cancel-interrupts-running-turn.md`
  scenario 3 split into 3a (zero active → `NO_ACTIVE_JOBS`), 3b (exactly
  one → cancels it), 3c (multiple → `AMBIGUOUS_CANCEL`, observed live).
- `gherkin-tests-v2/LIVE_RUN_REPORT.md` promotes `03-config/01` and
  `03-config/02` from FAIL to PASS with the commit ref that landed the
  fix.
- `unexpected-bridge-observations/README.md` marks obs 06, 07, 08 as
  resolved with dates + mechanism notes.
- `skill/references/config-reference.md` documents the new 4-layer
  resolution order (was 3-layer).
- `README.md` grows a "staying up to date" section documenting
  `bridge update`, `bridge update --force`, the silent-notice opt-out
  env var, and the "re-run `skills add`" upgrade recipe. Also grows a
  "seeing what config is in effect" section pointing at `bridge config
  show` as the authoritative debug tool for config drift.
- `README.md` "what you get" bullets gain the self-healing-state
  reaper and the built-in update check as first-class features.
- `.github/workflows/release.yml` now builds the GitHub Release body
  from the matching `## [X.Y.Z]` section in `CHANGELOG.md`, prepended
  with an `## Install` snippet so users landing on the Release page
  see the install command at the top. The commit-based auto-summary
  still appends below for completeness.

## [1.1.0] — 2026-04-18

First release with per-launch update-check surface and workspace-level
config override. No breaking changes; every 1.0.0 caller continues to
work unchanged.

### Added

- **Update-check plumbing** (commit `cff0e5f`).
  - New `src/lib/update-check.mjs` module: 24h on-disk cache, 2.5s fetch
    timeout, silent failure. Uses GitHub REST (unauthenticated, within
    rate-limit budget given the cache).
  - `version [--check-update] [--json]` now surfaces `result.update` with
    `latest_version`, `has_update`, `checked_at_age_ms`,
    `check_skipped`, `check_skip_reason`. `--check-update` forces a
    fresh fetch.
  - New `update [--force] [--json]` subcommand: prints current vs
    latest + the `npx -y skills add …` install recipe. Does NOT
    self-modify the skill.
  - Silent per-launch stdout notice when a newer version is cached.
    Opt-out via `CODEX_BRIDGE_NO_UPDATE_CHECK=1` env or `--json` flag
    (envelope is preserved). Also skipped for `help`/`version`/`update`.
  - `BRIDGE_CAPABILITIES` gains `update-check` and
    `workspace-config-override`.

### Changed

- **Workspace `config.yaml` override** is now a real thing (commit
  `945621b`, see
  `unexpected-bridge-observations/07-cwd-config-yaml-is-ignored.md`).
  `src/lib/config.mjs::loadConfig(skillDir, overrideDir = null)` reads
  three layers top-down (`DEFAULT_CONFIG` < `{skillDir}/config.yaml` <
  `{overrideDir}/config.yaml`). Callers with a meaningful cwd (task,
  send, steer, wait, events) pass it through; cwd-less callers (help,
  version, respond, summary) keep the old behavior. New export
  `resolveConfigSources()` reports both paths + existence flags.

### Fixed

- `next_action.description` at `phase: "incomplete"` no longer claims
  "Codex's completion check flagged gaps" when the actual cause was a
  pipeline stage timeout. Branches on `pipeline.error` presence so
  orchestrators get a truthful next-step (commit `945621b`,
  `unexpected-bridge-observations/03`).

### Docs

- `CHANGELOG.md` (this file) introduced with "Adding an entry"
  workflow at the bottom.
- `README.md` gains a "Releasing" subsection documenting the version-
  bump + tag + push procedure.
- `skill/references/config-reference.md` documents the three-layer
  config resolution order.
- `unexpected-bridge-observations/` grows to 8 entries — new 07
  (workspace config.yaml ignored, partially resolved) and 08
  (`adversarial-review` creates no session artifacts).
- `gherkin-tests-v2/LIVE_RUN_REPORT.md` adds a retest addendum showing
  5 predicates now PASS live (1 was blocked on the config fix).

## [1.0.0] — 2026-04-17

First tagged release of the Claude Code skill + single-file Node.js bridge to
the OpenAI Codex app-server. `npx -y skills add yigitkonur/codex-bridge -a claude-code -g -y`
installs and runs; `bridge task --json "…"` delegates work to Codex and returns
a uniform envelope that Claude Code can switch on.

### Added

- Plan → approve → execute → auto-pipeline → done/incomplete lifecycle, driven
  by `src/lib/auto-pipeline.mjs` (diff → review → fix → completion-check).
- Append-only `.events` and `.ndjson` session artifacts per thread, plus
  `.diff` and `.plan.md` captured at appropriate points
  (`src/lib/session-log.mjs`).
- Structured error envelope (`{ok, error:{class, code, retryable, suggestion}}`)
  on failure, mapped 1:1 to exit codes 0/1/2/3/4/5/6/7/8
  (`src/lib/cli-errors.mjs`).
- `requestUserInput` round-trip via disk IPC (`src/lib/pending-requests.mjs`)
  so a separate `respond` CLI invocation can answer a question raised mid-turn.
- `adversarial-review` subcommand returning findings that validate against
  `schemas/review-output.schema.json`.
- `wait`, `events --follow`, `steer`, `summary`, `cancel`, and background jobs
  via `task --background`.
- JSON-RPC broker (`src/app-server-broker.mjs`) that multiplexes multiple CLI
  invocations onto a single Codex app-server connection in the same workspace.
- `.claude-plugin/plugin.json` for skills.sh / Claude plugin-marketplace
  discovery.
- Guided README bootstrap for new machines (Node 22 → Codex CLI → skill
  install) plus a troubleshooting table.
- CI drift check: `.github/workflows/build.yml` rebuilds from source and
  refuses to pass if `skill/scripts/*` diverges from the committed bundle.
- Release workflow: pushing a `vX.Y.Z` tag auto-packages `.tar.gz` + `.zip` +
  `SHA256SUMS` and attaches them to a GitHub release.
### Docs

- `AGENTS.md` (+ `CLAUDE.md` symlink) — repo-root instructions for agents.
- `REVIEW.md` — review-time checklist.
- `src/`, `src/lib/`, `skill/`, `gherkin-tests-v2/` — per-folder `AGENTS.md`
  with folder-specific conventions and invariants.
- `skill/references/` — user-facing reference docs for commands, config,
  notifications, NDJSON schema, error recovery, monitor patterns, prompt
  writing, and orchestration flow diagrams.

---

## Adding an entry

Every PR that changes behavior — adds a subcommand, changes an envelope
field, renames a config key, introduces or resolves an observation, etc. —
must touch this file.

1. **During development**, append a bullet under the `## [Unreleased]`
   section. Use one of five categories in this exact order:
   - `### Added` for new features / surfaces
   - `### Changed` for behavior changes to existing features
   - `### Deprecated` for soon-to-be-removed features (keep entry until
     removal release)
   - `### Removed` for features that were deprecated earlier and have now
     been removed
   - `### Fixed` for bug fixes
   - `### Security` for vulnerability mitigations
2. **Link each bullet** to the relevant commit SHA and, when applicable, the
   spec or observation it corresponds to (e.g.
   `gherkin-tests-v2/04-errors/03-review-empty-diff.md`,
   `unexpected-bridge-observations/07-cwd-config-yaml-is-ignored.md`).
3. **Keep voice consistent**: imperative, past-less. "Honor workspace
   config.yaml" — not "Honored" or "Now honors."
4. **When cutting a release**:
   - Decide major/minor/patch per semver:
     - MAJOR: breaking envelope / exit-code / config-key changes.
     - MINOR: new subcommands, new capabilities, new config keys.
     - PATCH: bug fixes, doc-only changes, internal refactors.
   - Rename the `[Unreleased]` heading to `[X.Y.Z] — YYYY-MM-DD`.
   - Add a fresh empty `## [Unreleased]` above it.
   - Bump `package.json` `version` and `src/codex-bridge.mjs`'s
     `BRIDGE_VERSION` in the same commit.
   - Commit as `chore(release): vX.Y.Z`, then tag and push:
     ```sh
     git tag vX.Y.Z
     git push origin main vX.Y.Z
     ```
   - The `release.yml` workflow auto-packages the tarball + zip +
     SHA256SUMS and attaches them to the GitHub release.
5. **Keep it truthful**: if a feature shipped only behind a flag or was
   reverted before release, note that explicitly. A changelog that overstates
   coverage is worse than no changelog.

Do NOT edit historical entries below `[Unreleased]`. Once a release is
tagged, its entry is frozen — subsequent fixes that affect it belong in a
new release section, not a retroactive edit.
