Feature: CLI Commands
  As Claude Code using codex-bridge as a tool,
  I need each CLI command to work correctly
  so that I can manage Codex tasks through the full lifecycle.

  Background:
    Given the codex-bridge CLI is available
    And the Codex app-server is running and authenticated

  # ── task command ───────────────────────────────────────────────────────

  Scenario: task with inline prompt
    When I run "codex-bridge task --write 'Fix the login bug'"
    Then the exit code should be 0
    And stdout should contain a thread ID
    And stdout should contain "events:" with a file path
    And stdout should contain "log:" with a file path
    And stdout should contain "status:" with a status command

  Scenario: task with file prompt
    Given a file "prompt.md" exists with content "Implement OAuth2 flow"
    When I run "codex-bridge task --write prompt.md"
    Then the prompt sent to the app-server should be "Implement OAuth2 flow"

  Scenario: task with --write enables workspace writing
    When I run "codex-bridge task --write 'Make changes'"
    Then the thread should be configured for file writing capability

  Scenario: task without --write uses read-only sandbox
    When I run "codex-bridge task 'Analyze the codebase'"
    Then the thread should use read-only sandbox

  Scenario: task with --effort overrides config
    When I run "codex-bridge task --write --effort xhigh 'Complex task'"
    Then the execution effort should be "xhigh"

  Scenario: task with --wait runs synchronously
    When I run "codex-bridge task --write --wait 'Quick fix'"
    Then the CLI should block until completion
    And stdout should contain the task result instead of session paths

  Scenario: task with --json outputs machine-readable format
    When I run "codex-bridge task --write --json 'Fix bug'"
    Then stdout should be valid JSON
    And the JSON should contain threadId, eventsPath, and ndjsonPath

  Scenario: task with --cwd overrides working directory
    When I run "codex-bridge task --write --cwd /tmp/project 'Fix bug'"
    Then the working directory sent to the app-server should be "/tmp/project"

  Scenario: task with empty prompt shows error
    When I run "codex-bridge task --write"
    Then the exit code should be non-zero
    And stderr should contain a usage hint

  # ── send command ───────────────────────────────────────────────────────

  Scenario: send for plan approval
    Given a task produced a "[PLAN]" notification on thread "thr_abc"
    When I run "codex-bridge send thr_abc --mode default 'Implement the plan.'"
    Then the exit code should be 0
    And the new turn should use collaborationMode "default"
    And the sandbox should switch to "workspaceWrite"

  Scenario: send for plan revision
    Given a task produced a "[PLAN]" notification on thread "thr_abc"
    When I run "codex-bridge send thr_abc 'Revise step 2: use Redis instead'"
    Then the exit code should be 0
    And the mode should not change (stays in current mode)

  Scenario: send with file as prompt
    Given a file "revision.md" exists with revision instructions
    When I run "codex-bridge send thr_abc revision.md"
    Then the prompt should be the file content

  Scenario: send without thread ID shows error
    When I run "codex-bridge send"
    Then the exit code should be non-zero
    And stderr should contain "send requires <thread-id>"

  Scenario: send without prompt shows error
    When I run "codex-bridge send thr_abc"
    Then the exit code should be non-zero
    And stderr should contain "send requires a prompt"

  Scenario: send with invalid mode shows error
    When I run "codex-bridge send thr_abc --mode execute 'Go'"
    Then the exit code should be non-zero
    And stderr should contain "mode must be plan or default"

  Scenario: send to nonexistent thread shows error
    When I run "codex-bridge send thr_nonexistent --mode default 'Go'"
    Then the exit code should be non-zero
    And stderr should contain "thread not found"

  Scenario: send with --effort overrides effort for this turn
    When I run "codex-bridge send thr_abc --mode default --effort xhigh 'Go'"
    Then the turn should use reasoning effort "xhigh"

  Scenario: send follow-up after DONE
    Given a task on thread "thr_abc" completed with "[DONE]"
    When I run "codex-bridge send thr_abc 'Also add error handling'"
    Then a new turn should start on the existing thread

  # ── steer command ──────────────────────────────────────────────────────

  Scenario: steer sends mid-turn guidance
    Given a task is actively running turn "turn_456" on thread "thr_abc"
    When I run "codex-bridge steer thr_abc turn_456 'Focus on auth first'"
    Then the exit code should be 0
    And a turn/steer RPC should be sent with the guidance text
    And stdout should contain "Steered turn turn_456 on thread thr_abc"

  Scenario: steer without thread ID shows error
    When I run "codex-bridge steer"
    Then the exit code should be non-zero
    And stderr should contain "steer requires <thread-id> <turn-id>"

  Scenario: steer without turn ID shows error
    When I run "codex-bridge steer thr_abc"
    Then the exit code should be non-zero
    And stderr should contain "steer requires <thread-id> <turn-id>"

  Scenario: steer with wrong turn ID shows error
    Given a task is actively running turn "turn_456" on thread "thr_abc"
    When I run "codex-bridge steer thr_abc turn_999 'Focus on auth'"
    Then the exit code should be non-zero
    And stderr should contain a turn ID mismatch error

  Scenario: steer during review turn shows error
    Given a review turn is active on thread "thr_abc" with turn "turn_456"
    When I run "codex-bridge steer thr_abc turn_456 'Change approach'"
    Then the exit code should be non-zero
    And stderr should contain "cannot steer" or reference error code -32600

  Scenario: steer when no active turn shows error
    Given thread "thr_abc" has no active turn
    When I run "codex-bridge steer thr_abc turn_456 'Do something'"
    Then the exit code should be non-zero
    And stderr should contain an error about no active turn

  Scenario: steer is logged to NDJSON
    Given a task is actively running turn "turn_456" on thread "thr_abc"
    When I run "codex-bridge steer thr_abc turn_456 'Focus on auth first'"
    Then the NDJSON file should contain a "STEER" tagged entry

  # ── respond command ────────────────────────────────────────────────────

  Scenario: respond with option label
    Given a "[QUESTION]" is pending with request ID "req-abc1-k9x" and question ID "q1"
    When I run "codex-bridge respond req-abc1-k9x --question-id q1 --answer jwt"
    Then the exit code should be 0
    And stdout should contain "Responded to req-abc1-k9x"

  Scenario: respond with --json-payload
    Given a "[QUESTION]" is pending with request ID "req-abc1-k9x"
    When I run "codex-bridge respond req-abc1-k9x --json-payload '{\"answers\":{\"q1\":{\"answers\":[\"jwt\"]}}}'"
    Then the exit code should be 0
    And the raw JSON should be sent to the app-server

  Scenario: respond without request ID shows error
    When I run "codex-bridge respond"
    Then the exit code should be non-zero
    And stderr should contain "respond requires <request-id>"

  # ── review command ─────────────────────────────────────────────────────

  Scenario: review with default scope
    When I run "codex-bridge review"
    Then the exit code should be 0
    And the review should use scope "auto"

  Scenario: review with --scope working-tree
    When I run "codex-bridge review --scope working-tree"
    Then the review should analyze uncommitted changes

  Scenario: review with --scope branch
    When I run "codex-bridge review --scope branch"
    Then the review should analyze the branch versus the base

  Scenario: review with --scope branch --base develop
    When I run "codex-bridge review --scope branch --base develop"
    Then the review should compare against the "develop" branch

  Scenario Outline: review accepts valid scopes
    When I run "codex-bridge review --scope <scope>"
    Then the exit code should be 0

    Examples:
      | scope        |
      | auto         |
      | working-tree |
      | branch       |

  Scenario: review produces REVIEW notification
    When I run "codex-bridge review --scope working-tree"
    And the review completes
    Then the events file should contain a "[REVIEW]" tag
    And a "{threadId}.review.json" file should be created

  # ── adversarial-review command ─────────────────────────────────────────

  Scenario: adversarial-review with focus text
    When I run "codex-bridge adversarial-review --scope working-tree 'focus on SQL injection risks'"
    Then the exit code should be 0
    And the review should include the focus text as direction

  Scenario: adversarial-review with default scope
    When I run "codex-bridge adversarial-review"
    Then the exit code should be 0
    And the review should use scope "auto"

  Scenario: adversarial-review produces structured JSON output
    When I run "codex-bridge adversarial-review --scope working-tree"
    And the review completes
    Then structured review findings should be available

  # ── summary command ────────────────────────────────────────────────────

  Scenario: summary generates readable transcript
    Given a task on thread "thr_abc" has a populated NDJSON log
    When I run "codex-bridge summary thr_abc"
    Then the exit code should be 0
    And stdout should contain markdown-formatted transcript
    And the transcript should show turn boundaries
    And the transcript should include user prompts in full
    And the transcript should include agent messages in full
    And tool calls should appear as one-liners

  Scenario: summary with --tail limits NDJSON lines
    Given a task on thread "thr_abc" has 500 NDJSON entries
    When I run "codex-bridge summary thr_abc --tail 50"
    Then only the last 50 entries should be processed

  Scenario: summary with --json outputs structured data
    When I run "codex-bridge summary thr_abc --json"
    Then stdout should be valid JSON
    And the JSON should contain threadId, entries, and transcript

  Scenario: summary without thread ID shows error
    When I run "codex-bridge summary"
    Then the exit code should be non-zero
    And stderr should contain "summary requires <thread-id>"

  Scenario: summary for nonexistent thread shows error
    When I run "codex-bridge summary thr_nonexistent"
    Then the exit code should be non-zero
    And stderr should contain "No session found"

  Scenario: summary for empty NDJSON shows message
    Given a task on thread "thr_abc" has an empty NDJSON file
    When I run "codex-bridge summary thr_abc"
    Then stdout should contain "No events recorded"

  Scenario: summary truncation rules
    Given a task on thread "thr_abc" has NDJSON with reasoning, deltas, and tool calls
    When I run "codex-bridge summary thr_abc"
    Then reasoning entries should be omitted
    And delta entries should be omitted
    And tool calls should show only tool name and first argument
    And user prompts should not be truncated
    And agent messages should not be truncated

  # ── status command ─────────────────────────────────────────────────────

  Scenario: status with job ID
    Given a task is running with thread ID "thr_abc"
    When I run "codex-bridge status thr_abc"
    Then the exit code should be 0
    And stdout should contain the job status

  Scenario: status with --all shows all jobs
    When I run "codex-bridge status --all"
    Then stdout should list all tracked jobs

  Scenario: status with --wait polls until completion
    Given a task is running with thread ID "thr_abc"
    When I run "codex-bridge status thr_abc --wait"
    Then the CLI should block until the job completes
    And then output the final status

  Scenario: status with --json outputs structured data
    When I run "codex-bridge status thr_abc --json"
    Then stdout should be valid JSON

  # ── result command ─────────────────────────────────────────────────────

  Scenario: result for completed job
    Given a task on thread "thr_abc" completed
    When I run "codex-bridge result thr_abc"
    Then the exit code should be 0
    And stdout should contain the full task result

  Scenario: result with --json
    When I run "codex-bridge result thr_abc --json"
    Then stdout should be valid JSON

  # ── cancel command ─────────────────────────────────────────────────────

  Scenario: cancel a running job
    Given a task is running with thread ID "thr_abc"
    When I run "codex-bridge cancel thr_abc"
    Then the exit code should be 0
    And the task should be cancelled
    And stdout should confirm cancellation

  Scenario: cancel with --json
    When I run "codex-bridge cancel thr_abc --json"
    Then stdout should be valid JSON

  # ── setup command ──────────────────────────────────────────────────────

  Scenario: setup health check passes
    Given Codex is installed and authenticated
    When I run "codex-bridge setup"
    Then the exit code should be 0
    And stdout should confirm Codex is available
    And stdout should confirm authentication is valid
    And stdout should confirm app-server is reachable

  Scenario: setup detects missing Codex installation
    Given Codex is not installed
    When I run "codex-bridge setup"
    Then the exit code should be non-zero
    And stderr should indicate Codex is not found

  Scenario: setup detects authentication failure
    Given Codex is installed but not authenticated
    When I run "codex-bridge setup"
    Then the exit code should be non-zero
    And stderr should indicate authentication is needed

  Scenario: setup with --json outputs structured data
    When I run "codex-bridge setup --json"
    Then stdout should be valid JSON with health check results

  # ── Global Flags ───────────────────────────────────────────────────────

  Scenario: --json flag works on all commands
    When I run "codex-bridge status --json"
    Then stdout should be valid JSON

  Scenario: --cwd flag works on all commands
    When I run "codex-bridge task --write --cwd /tmp/project 'Fix bug'"
    Then the working directory should be "/tmp/project"

  Scenario: Unknown command shows error
    When I run "codex-bridge unknown-command"
    Then the exit code should be non-zero
    And stderr should contain a usage hint or list of valid commands
