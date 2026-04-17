Feature: Task Lifecycle — Plan, Approve, Execute
  As Claude Code orchestrating a Codex task,
  I need the full plan-approve-execute lifecycle to work correctly
  so that every task goes through planning before execution.

  Background:
    Given the codex-bridge CLI is available
    And the Codex app-server is running and authenticated
    And the session directory "~/.codex-bridge/sessions" exists
    And the config file uses default settings

  # ── Happy Path: Plan → Approve → Execute → Done ──────────────────────

  Scenario: Default task starts in plan mode
    When I run "codex-bridge task --write 'Refactor the auth module'"
    Then the exit code should be 0
    And stdout should contain a thread ID matching "thr_"
    And stdout should contain an events file path ending in ".events"
    And stdout should contain an NDJSON file path ending in ".ndjson"
    And stdout should contain a status command hint
    And the turn sent to the app-server should have collaborationMode "plan"
    And the turn sent to the app-server should have sandbox "readOnly"
    And the turn sent to the app-server should have reasoning effort "xhigh"

  Scenario: Plan mode always uses xhigh effort regardless of config
    Given the config file has effort set to "low"
    When I run "codex-bridge task --write 'Fix a typo'"
    Then the turn sent to the app-server should have reasoning effort "xhigh"

  Scenario: Plan produced triggers PLAN notification
    Given a task is running in plan mode on thread "thr_abc"
    When Codex produces an item/completed notification with item.type "plan"
    Then the events file for "thr_abc" should contain a "[PLAN]" tag
    And the PLAN notification should contain the thread ID "thr_abc"
    And the PLAN notification should contain the turn ID
    And the PLAN notification should contain plan steps
    And the PLAN notification should contain an "approve" action with "--mode default"
    And the PLAN notification should contain a "revise" action with "send"
    And a file "{threadId}.plan.md" should be written with the full plan text

  Scenario: Plan approval switches to execution mode
    Given a task produced a "[PLAN]" notification on thread "thr_abc"
    When I run "codex-bridge send thr_abc --mode default 'Implement the plan.'"
    Then the turn sent to the app-server should have collaborationMode "default"
    And the turn sent to the app-server should have sandbox "workspaceWrite"
    And the turn sent to the app-server should have reasoning effort from config

  Scenario: Plan revision stays in plan mode
    Given a task produced a "[PLAN]" notification on thread "thr_abc"
    When I run "codex-bridge send thr_abc 'Revise step 2: use token bucket instead'"
    Then the turn sent to the app-server should NOT switch collaborationMode
    And the sandbox should remain "readOnly"
    And Codex should continue in plan mode

  Scenario: Revised plan produces a new PLAN notification
    Given a task produced a "[PLAN]" notification on thread "thr_abc"
    And I sent a revision "Revise step 2: use token bucket instead"
    When Codex produces a new item/completed notification with item.type "plan"
    Then the events file for "thr_abc" should contain a second "[PLAN]" tag
    And the plan.md file should be overwritten with the revised plan text

  Scenario: Multiple revisions before approval
    Given a task produced a "[PLAN]" notification on thread "thr_abc"
    When I send 3 revisions without --mode flag
    And each revision produces a new "[PLAN]" notification
    And I then run "codex-bridge send thr_abc --mode default 'Implement the plan.'"
    Then the turn should switch to collaborationMode "default"
    And execution should begin

  Scenario: Execution completes with DONE notification
    Given a task on thread "thr_abc" was approved and is executing
    When the execution turn completes successfully
    And the auto-pipeline completes successfully
    Then the events file should contain a "[DONE]" tag
    And the DONE notification should contain the thread ID
    And the DONE notification should contain duration in seconds
    And the DONE notification should contain a diff stat
    And the DONE notification should contain a config summary with model, effort, and mode flow
    And the DONE notification should contain a diff file path
    And the DONE notification should contain file change lines
    And the DONE notification should contain "review", "revise", and "detail" actions

  # ── Async vs Sync Mode ────────────────────────────────────────────────

  Scenario: Task runs asynchronously by default
    When I run "codex-bridge task --write 'Build a REST API'"
    Then the CLI should exit immediately after printing session paths
    And the task should continue running in the background

  Scenario: Task runs synchronously with --wait flag
    When I run "codex-bridge task --write --wait 'Build a REST API'"
    Then the CLI should block until the task completes
    And stdout should contain the task result

  # ── Prompt Handling ────────────────────────────────────────────────────

  Scenario: Task accepts inline text prompt
    When I run "codex-bridge task --write 'Fix the login bug'"
    Then the prompt sent to the app-server should be "Fix the login bug"

  Scenario: Task accepts file as prompt
    Given a file "task-prompt.md" exists with content "Implement OAuth2 flow"
    When I run "codex-bridge task --write task-prompt.md"
    Then the prompt sent to the app-server should be "Implement OAuth2 flow"

  Scenario: Task with empty prompt shows error
    When I run "codex-bridge task --write"
    Then the exit code should be non-zero
    And stderr should contain a usage hint

  # ── Direct Mode (Skip Planning) ───────────────────────────────────────

  Scenario: Config mode "default" skips plan phase
    Given the config file has mode set to "default"
    When I run "codex-bridge task --write 'Fix a typo'"
    Then the turn sent to the app-server should have collaborationMode "default"
    And the turn sent to the app-server should have sandbox "workspaceWrite"
    And no "[PLAN]" notification should be produced
    And the task should go directly to execution

  # ── Effort Override ────────────────────────────────────────────────────

  Scenario: --effort flag overrides config effort for execution
    Given the config file has effort set to "high"
    When I run "codex-bridge task --write --effort xhigh 'Complex refactoring'"
    Then the plan turn should still use effort "xhigh"
    And after approval, the execution turn should use effort "xhigh"

  Scenario Outline: Valid effort levels are accepted
    When I run "codex-bridge task --write --effort <level> 'Some task'"
    Then the exit code should be 0

    Examples:
      | level   |
      | none    |
      | minimal |
      | low     |
      | medium  |
      | high    |
      | xhigh   |

  # ── Session Files ──────────────────────────────────────────────────────

  Scenario: Session files are created at task start
    When I run "codex-bridge task --write 'Build feature X'"
    Then a file "{threadId}.ndjson" should exist in the session directory
    And a file "{threadId}.events" should exist in the session directory

  Scenario: NDJSON file logs every app-server notification
    Given a task is running on thread "thr_abc"
    When the app-server sends a thread/started notification
    And the app-server sends a turn/started notification
    And the app-server sends an item/completed notification
    And the app-server sends a turn/completed notification
    Then the NDJSON file should contain 4 entries in chronological order
    And each entry should have a "ts" timestamp
    And each entry should have a "tag" field
    And each entry should have a "method" field
    And each entry should have a "threadId" field

  Scenario: Events file only contains actionable tags
    Given a task completes the full lifecycle on thread "thr_abc"
    Then the events file should NOT contain raw notification methods
    And the events file should only contain tags from the set: DONE, ERROR, QUESTION, PLAN, INCOMPLETE, CONFIRMED, PHASE, PIPELINE

  # ── Follow-Up After Completion ─────────────────────────────────────────

  Scenario: Send follow-up to completed thread
    Given a task on thread "thr_abc" completed with "[DONE]"
    When I run "codex-bridge send thr_abc 'Also add error handling for the edge case'"
    Then a new turn should start on thread "thr_abc"
    And the turn should use the thread's current collaboration mode

  # ── Task ID Generation ─────────────────────────────────────────────────

  Scenario: Task generates a readable slug ID
    When I run "codex-bridge task --write 'Fix the login bug'"
    Then the task slug in stdout should contain words from the prompt
    And the task slug should end with a random suffix
