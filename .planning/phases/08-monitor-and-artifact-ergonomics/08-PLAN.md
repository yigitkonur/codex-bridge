# Phase 8 Plan: Monitor And Artifact Ergonomics

**Status:** Complete
**Milestone:** v2.2.0

## Goal

Make task/session forensics easier from the command surface without manually
mapping `task_id` to `threadId`.

## Delivered

- Task-id session aliases under `<session_dir>/by-task/<task_id>.json`.
- Portable alias metadata for events, ndjson, and diff paths.
- `wait --any <job...>` fan-in command that returns the first terminal job.
- Heartbeat assistant previews for richer liveness context.
- Updated slash-command hints for wait/status ergonomics.

## Verification

- `test/session-log.test.mjs`
- `test/bridge-static.test.mjs`
