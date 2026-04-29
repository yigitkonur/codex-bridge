# Brief composition

A brief is a structured JSON object that travels with a task from dispatch through review. It replaces free-text prompts for non-trivial work because:

- The `specific_concerns` array flows verbatim into `adversarial-review`'s `{{OPUS_CONCERNS}}` placeholder — the orchestrator's privileged channel.
- The brief is persisted at `<jobs>/<task_id>/brief.json` so the original intent survives even if you change the prompt template later.
- The brief is hashed; `meta.json::brief_hash` lets you identify "is this the same brief I sent before" across iterations.

The schema is at `plugin/schemas/brief.schema.json`. Validate yours before dispatch (the bridge does this anyway).

## Required fields

- **`goal`** — one sentence, what the task accomplishes. Up to 2000 chars.
- **`worker_assignment`** — the imperative instructions for Codex. Up to 4000 chars. Don't pad with rationale; this is what the worker reads.

## Optional fields that matter

- **`specific_concerns`** — array of up to 16 strings. **Each item flows into the review prompt.** This is your privileged channel: anything you've been watching from `[CHECKPOINT]` and `[PLAN]` events that warrants extra scrutiny. Phrase as risks ("Don't swallow non-retryable 4xx errors"), not as features ("Add retry").
- **`acceptance_criteria`** — array of up to 16 strings. Codex sees these and the iterate loop checks them before declaring `verdict=approved`. Use for tests, diff size limits, "must not touch X."
- **`behavior_digest_seed`** — up to 8000 chars of context the worker needs but can't be expected to derive (existing API contracts, file paths, recent design decisions). Don't dump the whole repo; dump the *relevant* slice.
- **`parent_task_id`** — for iterate-loop children. Set automatically by `/codex-bridge:iterate`; don't set by hand.
- **`backend_hint`** — `"codex"` only in v2.0; expanded as adapters land.
- **`iteration_max`** — overrides the loop's default 3.
- **`trust_budget_override`** — soft caps for auto-merge: `auto_merge_max_diff_lines`, `auto_merge_max_files`, `auto_merge_max_iterations`.

## When to use a brief vs free-text

Use a brief when:

- The task is non-trivial (multi-file, multi-step).
- You want concerns surfaced to the reviewer.
- The work might iterate (re-dispatching with the same intent).

Skip the brief (free-text prompt is fine) when:

- The task is one short imperative ("rename foo to bar across the repo").
- You're in plan-mode and the plan itself is the deliverable.

## Worked example

```json
{
  "goal": "Add retry/backoff to the upstream fetcher",
  "worker_assignment": "Implement exponential backoff with jitter, max 3 attempts. Preserve the existing public API of fetchUpstream(). Cover with a unit test that asserts the retry count and the gap between attempts (allow ±20%). Use the existing Config object for the timeout — don't add new globals.",
  "specific_concerns": [
    "Don't retry on non-retryable 4xx codes (400, 401, 403, 404)",
    "Don't swallow upstream errors silently — wrap and rethrow with the original cause",
    "Make sure the backoff actually fires; the previous fetcher had a bug where attempts ran back-to-back"
  ],
  "acceptance_criteria": [
    "npm test passes",
    "Diff stays under 200 lines",
    "No new dependencies"
  ],
  "behavior_digest_seed": "fetchUpstream lives at src/net/fetcher.mjs. Config is read via getConfig(). The unit test should mirror the existing test in test/fetcher.test.mjs."
}
```

## Anti-patterns

- **Concerns as features.** "Use exponential backoff" belongs in `worker_assignment`. "Don't break the API" belongs in `specific_concerns`.
- **Acceptance as wishlist.** If `npm test` doesn't actually exist, don't list it. The iterate loop will block forever.
- **Whole-repo digest.** `behavior_digest_seed` is a slice, not a tarball. If it's > 4000 chars, you're probably dumping noise.
- **Unbounded iteration.** Default `iteration_max=3` is usually right. Don't bump to 10 unless the work is genuinely incremental.

## Versioning

The schema's `schema_version` is `"1.0"`. The brief is preserved verbatim; future schema changes will keep the loader backward-compat for at least one minor cycle.
