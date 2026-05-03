# Codex Bridge Claude Plugin Field Report Issue Register

Date: 2026-05-03
Source session: `/Users/yigitkonur/.claude/projects/-Users-yigitkonur-test-project/680e4036-ae81-4ded-9399-ab07999467b5.jsonl`
Bridge version observed: `2.0.0`
Backend observed: `codex-cli 0.128.0`
Workspace observed: `/Users/yigitkonur/test-project`

## Purpose

This register captures the concrete issues surfaced by a real Claude Code agent
using the Codex Bridge plugin and skill to delegate a small static-site build to
Codex. It combines transcript analysis with the agent's own forensic report.

The goal is not to judge model quality. The goal is to improve the bridge:
CLI behavior, skill guidance, hook ergonomics, Monitor/event usefulness, and
on-disk artifact forensics.

## Ground Truth Jobs

| Job | Role | Outcome | Notes |
|---|---|---|---|
| `task-mopesjw9-ma6fke` | Initial dentist site build | Partial/incomplete | Built files but missed `testimonials.html`; produced `patients.html`. Pipeline check reported `complete=false missing=7`. |
| `task-mopezcwt-044typ` | Attempted resume/fix | Cancelled | `--resume-last --worktree-auto` resumed thread state but opened a fresh worktree from empty `main`. |
| `task-mopf0hrb-y9hbx9` | Focused rename/fix | Complete | Replaced `patients.html` with `testimonials.html`, updated nav, and passed check. |

## Priority Definitions

| Priority | Meaning |
|---|---|
| P0 | Blocks correct use, loses work, or sends work to the wrong context. |
| P1 | Requires manual workaround in serious use or makes completion status unreliable. |
| P2 | Papercut, documentation gap, or polish issue that still affects agent confidence. |

## P0 Issues

### P0-01: `--brief` does not deliver brief content to the worker

**Problem**

The CLI persists `brief.json` and `brief.md`, but the rendered brief content is
not delivered to the Codex worker prompt and is not copied into the worktree. In
the field session, the worker saw only a short positional prompt referring to an
"attached brief" that it could not access.

**Evidence**

- Brief artifacts existed:
  - `~/.codex-bridge/jobs/task-mopesjw9-ma6fke/brief.json`
  - `~/.codex-bridge/jobs/task-mopesjw9-ma6fke/brief.md`
- Worker log reported:
  - `I don't have the referenced brief in the worktree or message payload.`
- The first job produced `patients.html` rather than the required
  `testimonials.html`, consistent with the worker not receiving the full
  assignment.

**Impact**

This breaks the product's structured delegation contract. Agents are encouraged
to use briefs for non-trivial work, but the worker may not receive the actual
instructions. The result is silent under-instruction, wrong output, and wasted
background job time.

**Required Fix**

Make `--brief` a real worker input, not only a registry/review artifact. Either:

- append the rendered `brief.md` to the worker prompt under a clear heading, or
- copy `brief.md` into the worktree before execution and inject an instruction
  telling the worker exactly where to read it.

Then add tests proving the worker payload includes `goal`, `worker_assignment`,
`specific_concerns`, and `acceptance_criteria`.

**Likely Files**

- `src/codex-bridge.mjs`
- `src/lib/artifact-registry.mjs`
- `src/adapters/codex/**`
- `skill/SKILL.md`
- `skill/references/brief-composition.md`
- `plugin/commands/**` if slash command examples mention brief usage
- generated `skill/` and `plugin/` outputs after build

### P0-02: `--resume-last --worktree-auto` loses worktree continuity

**Problem**

`--resume-last` appears to resume the Codex thread, but when combined with
`--worktree-auto` it creates a new worktree from the current base branch instead
of continuing from the previous task worktree or task branch.

**Evidence**

- Follow-up fix job: `task-mopezcwt-044typ`
- The job was intended to fix the just-built dentist site.
- It opened from the empty initial commit `6699b2b...`.
- Worker observed the worktree was empty except for git metadata.
- Cancel output included `thread not found: 019dec98-372f-7981-92e5-68c2da199012`
  while still reporting cancellation.

**Impact**

This is a dangerous silent footgun. A Claude agent can think it is fixing a
prior task while actually operating on an unrelated or empty tree. In larger
repositories, this could produce a misleading fix branch or overwrite the
orchestration path.

**Required Fix**

Choose one explicit semantic and enforce it:

- If `--resume-last` is thread-only, reject `--resume-last --worktree-auto` with
  a clear validation error.
- If task-continuity is desired, add `--resume-task <taskId>` or make
  `--iterate <taskId>` the documented path that carries worktree base, parent
  task metadata, and prior branch state.

Add tests for:

- thread-only resume refusal with worktree flags,
- task-based continuation preserving worktree base,
- cancelled resume jobs cleaning up registry/worktree state.

**Likely Files**

- `src/codex-bridge.mjs`
- `src/lib/state.mjs`
- `src/lib/worktree*.mjs` or worktree lifecycle helpers
- `src/lib/artifact-registry.mjs`
- `test/*.test.mjs`
- `skill/references/error-recovery.md`
- `skill/references/orchestration-flows.md`

### P0-03: Brief examples and skill wording imply an invalid or unsafe flow

**Problem**

Skill and orchestration examples imply that `--brief @brief.json` can replace a
positional prompt. The actual CLI requires a prompt, prompt file, stdin, or
resume flag. Even after a minimal prompt is added, the brief contents are not
delivered to the worker unless explicitly included elsewhere.

**Evidence**

- CLI returned:
  - `MISSING_PROMPT`
  - `Provide a prompt, a prompt file, piped stdin, or use --resume-last.`
- Help/docs example pattern observed:
  - `codex-bridge task --background --write --worktree-auto --brief @brief.json --json`
- The field agent concluded the wording "prefer a brief over a free-text prompt"
  changed its path and caused the first bad dispatch.

**Impact**

This creates a first-contact failure and then a subtler second failure: agents
fix `MISSING_PROMPT` by adding a short prompt such as "follow the brief", but the
worker still cannot see the brief.

**Required Fix**

Update all brief guidance to say:

- `--brief` preserves structured intent and feeds review/check artifacts.
- The worker must still receive a complete prompt.
- Until P0-01 is fixed, critical instructions must be in the prompt or
  `--prompt-file`.

After P0-01 is fixed, update guidance again to document the exact delivery
semantics.

**Likely Files**

- `skill/SKILL.md`
- `skill/references/brief-composition.md`
- `skill/references/orchestration-flows.md`
- `README.md`
- `src/codex-bridge.mjs` help examples
- generated plugin/skill bundles after build

## P1 Issues

### P1-01: Pipeline summary reports `0 files | +0 -0` for committed work

**Problem**

The pipeline diff summary appears to measure the worktree dirty diff after the
worker has already committed. For committed task branches, the summary reports
zero files and zero line changes even when the branch contains substantial
changes.

**Evidence**

- Initial build branch had 6 files and 798 insertions, but event summary said:
  - `[INCOMPLETE] ... 0 files | +0 -0`
- Fix branch had 7 changed files and a non-zero diff, but event summary said:
  - `[DONE] ... 0 files | +0 -0`

**Impact**

Agents looking at Monitor can conclude that no work happened, or that pipeline
review/check evaluated an empty diff. This undermines trust in the events.

**Required Fix**

For worktree tasks, compute summary diff against the task base:

- `base_ref..HEAD` for committed branch work,
- plus dirty worktree diff if any uncommitted changes remain.

If the current behavior is intentional, label it explicitly as
`working_tree_dirty_diff`.

### P1-02: Check failure count omits failing criteria

**Problem**

`[PIPELINE:check:done] complete=false missing=7` reports only the count of
missing criteria, not which criteria failed.

**Evidence**

- Event line:
  - `[PIPELINE:check:done] 06:52:16 complete=false missing=7`
- The agent had to compare `brief.json` manually against worktree output to
  infer failures.

**Impact**

The bridge knows enough to count missing criteria but does not provide the
actionable list. Recovery becomes manual and slow.

**Required Fix**

Emit the missing criteria list in:

- `.events`,
- `.ndjson`,
- `status --json`,
- `result --json`.

Keep a compact human line and structured JSON details.

### P1-03: Review can approve while check fails

**Problem**

The auto-pipeline review stage reported `verdict=approved findings=0` before
the check stage reported `complete=false missing=7`.

**Evidence**

- Initial job events:
  - `[PIPELINE:review:done] ... verdict=approved findings=0`
  - `[PIPELINE:check:done] ... complete=false missing=7`

**Impact**

If the agent stops at review approval, incomplete work can be merged. This is
especially risky because the field session later manually merged branches with
plain git.

**Required Fix**

Separate stage verdicts from final task verdict:

- Review stage may be `approved`.
- Overall task must be `incomplete` until check passes.
- Final merge/verdict commands should refuse approval when check failed.

### P1-04: Bridge merge/verdict path was bypassed in real use

**Problem**

The field session merged task branches with `git merge --ff-only` instead of
using a bridge-managed verdict/merge flow.

**Evidence**

- Transcript commands included:
  - `git merge --ff-only subagent/codex/task-mopesjw9-ma6fke`
  - `git merge --ff-only subagent/codex/task-mopf0hrb-y9hbx9`
- No explicit `codex-bridge verdict` or `codex-bridge merge` command was used.

**Impact**

The product's safety surface exists but was not naturally used by the agent.
That means docs/skill flow are not steering agents toward the intended lifecycle.

**Required Fix**

Make the canonical happy path impossible to miss:

1. `task --write --worktree-auto`
2. `events --follow`
3. `result/status`
4. `adversarial-review` or auto-pipeline result review
5. `verdict`
6. `merge`

Add explicit guidance: do not manually merge `subagent/codex/*` branches unless
recovering from a bridge failure.

### P1-05: `BRIEF_SCHEMA_VIOLATION` lacks documented AJV details

**Problem**

`error-recovery.md` says `BRIEF_SCHEMA_VIOLATION` exposes `error.details` with
the AJV array. The actual error envelope did not include `details` or a
suggestion.

**Evidence**

Actual error:

```json
{"ok":false,"schema_version":"1.0","error":{"class":"validation","code":"BRIEF_SCHEMA_VIOLATION","message":"brief failed schema validation","retryable":false},"command":"task"}
```

**Impact**

The agent had to find and read `schemas/brief.schema.json` manually to discover
that an extra top-level field caused the failure.

**Required Fix**

Return at least:

- `error.details[]` with schema path and message,
- `error.suggestion`,
- offending top-level keys when `additionalProperties` fails.

Then update docs to match the real envelope.

### P1-06: First-run git repository requirement is under-documented

**Problem**

`--worktree-auto` requires the target directory to be a git repository with at
least one commit, but the skill does not make this first-run requirement clear.

**Evidence**

The agent ran:

- `git init -q`
- `git commit -q --allow-empty -m "initial commit"`

before dispatching the first write task.

**Impact**

New users trying Codex Bridge in a fresh directory can fail before reaching the
actual delegation flow.

**Required Fix**

Add preflight behavior and docs:

- CLI validation error should say `cwd is not a git repository with at least one commit`.
- Skill should include a short setup recipe for fresh directories.

### P1-07: Monitor does not expose enough live worker progress for debugging

**Problem**

Monitor is sufficient for terminal state, but during execution it mostly shows
heartbeats and stage changes. To understand what Codex was doing, the agent had
to read `task-*.log.worker.err`.

**Evidence**

The smoking-gun worker message about the missing brief appeared in:

- `~/.claude/plugins/data/codex-bridge-codex-bridge/state/test-project-665d5be8170bdede/jobs/task-mopesjw9-ma6fke.log.worker.err`

not in the high-signal Monitor event stream.

**Impact**

Forensics are good after opening logs, but Monitor alone cannot tell the agent
whether the worker is thinking, stuck, missing context, or executing commands.

**Required Fix**

Add compact progress events:

- last assistant message preview,
- last shell command summary,
- current phase,
- age since last meaningful event,
- path to `.worker.err` when deeper inspection is needed.

### P1-08: Dispatch response did not provide a concrete events path

**Problem**

The queued background response included `eventsPath: null` and only an
`eventsDir`, so the agent needed a separate `events --cwd <workspace> <jobId>`
pattern rather than a direct file path.

**Impact**

This is recoverable but weakens first-contact ergonomics and artifact
discoverability.

**Required Fix**

Once a task id is allocated, return either:

- a task-keyed events alias path, or
- a machine-readable `monitorCommand` / `eventsCommand`.

### P1-09: Task id and thread id indexing causes forensic friction

**Problem**

Jobs are keyed by `task-*`, while session `.events` and `.ndjson` files are
keyed by Codex thread id. Debugging requires reading metadata to map between the
two.

**Impact**

This adds friction to every forensic pass and becomes harder with multiple
parallel jobs.

**Required Fix**

Create stable aliases:

- `~/.codex-bridge/sessions/by-task/<taskId>.events`
- `~/.codex-bridge/sessions/by-task/<taskId>.ndjson`
- include these paths in `status --json`.

### P1-10: Cancel/resume output contains inconsistent internal naming

**Problem**

The cancelled resume job produced confusing output: cancellation succeeded, but
the interrupt reason said the thread was not found. Dispatch naming also mixed
`Codex Resume`, `kindLabel: task`, and task registry labels.

**Impact**

Agents cannot confidently tell whether cancellation was clean, partial, or
best-effort.

**Required Fix**

Normalize cancellation envelopes:

- `cancelled: true|false`
- `processTerminated: true|false`
- `turnInterruptAttempted: true|false`
- `turnInterrupted: true|false`
- `reason` and `warnings[]` separated from success status.

### P1-11: Iterate/fix flow did not present itself naturally

**Problem**

After an incomplete task, the agent attempted `--resume-last` and then a fresh
task. It did not use an explicit iterate/fix primitive.

**Impact**

The most important loop for delegated work is not discoverable under pressure.

**Required Fix**

Add a clear incomplete-task recovery recipe:

- inspect `result/status`,
- run `iterate <taskId>` or documented equivalent,
- preserve base/worktree/parent metadata,
- re-run check,
- merge only after final approval.

### P1-12: Final validation guidance is too shallow for real deliverables

**Problem**

The final validation in the field session was mostly filename and grep checks.
For a static website, there was no browser render, responsive check, link crawl,
or HTML validation.

**Impact**

Agents can declare completion without proving the user-facing result works.

**Required Fix**

Provide task-type validation recipes in skill references. For static sites:

- verify required files,
- crawl local relative links,
- open or screenshot the page,
- check no stale references,
- inspect responsive breakpoint if relevant.

## P2 Issues

### P2-01: Read-only default is not prominent enough

Tasks are read-only by default. The skill emphasizes that `--write` must pair
with `--worktree-auto`, but does not make the default behavior obvious enough.

Add a top-level sentence:

> Tasks are read-only by default. Use `--write` only when Codex should edit
> files, and pair it with `--worktree-auto`.

### P2-02: Timeout defaults are opaque

Help lists timeout flags as `<ms>` but does not show default values or guidance
for common job sizes.

Add defaults and recommended overrides to:

- `task --help`
- `skill/SKILL.md`
- `skill/references/monitor-patterns.md`

### P2-03: Heartbeat filtering may be leaky or unclear

The agent reported heartbeat events reaching Monitor despite `--exclude
HEARTBEAT`. Even if this was tool behavior rather than bridge behavior, the
filter semantics need to be clear.

Add tests or docs for exact/expression matching and make Monitor commands use
the proven filter.

### P2-04: Heartbeat content can be recursive/noisy

Heartbeat `tail` content can show the Monitor command itself rather than worker
progress.

Improve heartbeat payloads to prefer the latest meaningful worker activity.

### P2-05: Event vocabulary is not documented as a practical table

The skill tells agents to tolerate future tags, but agents still need a known
tag map for blocking and triage.

Add a table for:

- `DIRECTIVES`
- `HEARTBEAT`
- `PIPELINE:*`
- `CHECKPOINT`
- `PLAN`
- `QUESTION`
- `WARNING`
- `HANDOFF`
- `PARTIAL`
- `INCOMPLETE`
- `DONE`
- `ERROR`

### P2-06: Artifact root paths are easy to stale-document

The user's prompt referenced `codex-openai-codex`, while the real path was
`codex-bridge-codex-bridge`. Hardcoded paths in docs drift.

Expose artifact roots through:

- `setup --json`
- `status --json`
- `version --json` or a dedicated `paths --json`.

### P2-07: Brief schema valid keys are not discoverable enough

The field failure was caused by an extra top-level `constraints` key. The
schema rejected it, but the docs did not make the allowed top-level keys obvious
enough for fast authoring.

Add allowed keys and a validation example to `brief-composition.md`.

### P2-08: Some reference files are orphaned in the common flow

The field agent never opened `notification-format.md` or reference `AGENTS.md`.
That does not make them useless, but it suggests the skill reference surface may
be too broad for first-contact use.

Reorganize references into:

- core quick path,
- recovery path,
- advanced forensics.

### P2-09: Small-task overhead and positioning are unclear

For a five-page static HTML site, Codex Bridge overhead was larger than doing
the task directly. The bridge is still valuable for multi-file work,
backgrounding, review, and isolation, but docs should set expectations.

Add positioning guidance:

- best for multi-file refactors, risky edits, long-running work, parallel
  delegation, and reviewable branches;
- overkill for tiny single-pass edits.

### P2-10: Capability output can imply features are active when only available

`version --json` lists capabilities such as `plan-mode`, `questions`, and
`adversarial-review`, but the field run used `--mode default` and did not use
questions or explicit adversarial review.

Separate:

- available capabilities,
- active defaults,
- active for this job.

### P2-11: Native Agent intercept positioning is ambiguous

The field session used Skill plus Bash, not native Agent/Task interception. The
product should avoid implying that hook-based intercept is the normal stable
path until it is proven.

Document three modes separately:

- explicit slash/skill command,
- direct CLI,
- experimental hook intercept.

### P2-12: Cancelled task cleanup is not obvious

The cancelled task branch/worktree appeared to remain after cancellation.

Add either:

- `cancel --cleanup-worktree`,
- `cleanup --cancelled`,
- or clear post-cancel instructions in the skill.

## Cross-Cutting Product Direction

The bridge infrastructure is valuable: worktree isolation, background jobs,
Monitor, event files, and worker logs all helped. The issue is that the
orchestration contract is still too implicit. Claude agents fall back to Bash
and manual git when the documented happy path is not obvious or when an
abstraction surprises them.

The next milestone should focus on making the intended flow the path of least
resistance:

1. reliable brief delivery,
2. task-continuity-safe iteration,
3. actionable check/review results,
4. bridge-managed verdict and merge,
5. first-contact skill text that matches actual CLI behavior.
