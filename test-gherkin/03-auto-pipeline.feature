Feature: Auto-Pipeline — Silent Review, Fix, and Completion Check
  As the codex-bridge orchestration layer,
  I need to silently run review, fix, and completion check after execution
  so that tasks are self-correcting without polluting Claude Code's context.

  Background:
    Given the codex-bridge CLI is available
    And the Codex app-server is running and authenticated
    And a task on thread "thr_abc" has completed the execution turn

  # ── Pipeline Silence ───────────────────────────────────────────────────

  Scenario: Auto-pipeline does not write intermediate events
    Given auto_review is true in config
    And post_task_prompt is configured
    When the auto-pipeline runs
    Then no "[REVIEW]" tag should appear in the events file
    And no intermediate turn notifications should appear in the events file
    And only "[PIPELINE:*]" progress tags and the final terminal tag should appear in the events file

  Scenario: Auto-pipeline logs all intermediate activity to NDJSON
    Given auto_review is true in config
    When the auto-pipeline runs
    Then the NDJSON file should contain entries for the review turn
    And the NDJSON file should contain entries for the fix turn (if findings exist)
    And the NDJSON file should contain entries for the completion check turn
    And each NDJSON entry should have the correct tag (TURN_STARTED, ITEM_COMPLETED, etc.)

  # ── Pipeline Progress Tags ─────────────────────────────────────────────

  Scenario: PIPELINE progress tags are written to events file
    Given auto_review is true in config
    And post_task_prompt is configured
    When the auto-pipeline runs through all stages
    Then the events file should contain "[PIPELINE:review]" with a timestamp
    And the events file should contain "[PIPELINE:check]" with a timestamp

  Scenario: PIPELINE:fix tag appears only when findings exist
    Given auto_review is true in config
    And the auto-review finds 2 issues
    When the auto-pipeline runs
    Then the events file should contain "[PIPELINE:fix]" with a timestamp

  Scenario: PIPELINE:diff tag appears at final diff capture
    When the auto-pipeline completes
    Then the events file should contain "[PIPELINE:diff]" with a timestamp

  # ── Stage 1: Git Diff Capture ──────────────────────────────────────────

  Scenario: Initial git diff captured after execution
    When the auto-pipeline starts
    Then a file "{threadId}.diff" should be written in the session directory
    And the diff should contain the changes from the execution turn

  # ── Stage 2: Auto-Review ───────────────────────────────────────────────

  Scenario: Auto-review runs when config auto_review is true
    Given auto_review is true in config
    When the auto-pipeline reaches the review stage
    Then a review turn should be started on the same thread
    And the review should use scope "auto"

  Scenario: Auto-review is skipped when config auto_review is false
    Given auto_review is false in config
    When the auto-pipeline runs
    Then no review turn should be started
    And the pipeline should skip to the completion check stage

  Scenario: Auto-review with no findings skips fix stage
    Given auto_review is true in config
    When the auto-review completes with zero findings
    Then no fix turn should be started
    And the pipeline should proceed to the completion check stage

  Scenario: Auto-review with findings triggers fix turn
    Given auto_review is true in config
    When the auto-review completes with findings:
      | severity | title                     | file         | line_start | line_end |
      | high     | Missing null check        | src/auth.ts  | 42         | 42       |
      | medium   | Unused import             | src/utils.ts | 1          | 1        |
    Then a fix turn should be started on the same thread
    And the fix turn should use collaborationMode "default"
    And the fix turn should use sandbox "workspaceWrite"
    And the fix turn should inject execute.md as developerInstructions
    And the fix prompt should list each finding with severity, title, file, and line range

  Scenario: Fix turn produces updated diff
    Given the auto-review found findings and a fix turn ran
    When the fix turn completes
    Then the "{threadId}.diff" file should be overwritten with the combined diff
    And the combined diff should include both original execution and fix changes

  # ── Stage 3: Completion Check ──────────────────────────────────────────

  Scenario: Completion check runs when post_task_prompt is configured
    Given post_task_prompt contains a review prompt
    When the auto-pipeline reaches the completion check stage
    Then a completion check turn should be started on the same thread
    And the turn should use collaborationMode "default"
    And the turn should inject execute.md as developerInstructions
    And the turn should use sandbox "readOnly"
    And the prompt should be the post_task_prompt from config

  Scenario: Completion check is skipped when post_task_prompt is empty
    Given post_task_prompt is empty in config
    When the auto-pipeline runs
    Then no completion check turn should be started
    And the pipeline should proceed to the final notification

  Scenario: Completion check result — complete
    When the completion check agent responds indicating "100% complete"
    Then the pipeline should produce a "[DONE]" notification

  Scenario: Completion check result — incomplete with specific items
    When the completion check agent responds with:
      """
      Not fully complete. Missing items:
      - Integration tests for the new JWT flow
      - Error handling for token refresh edge case
      """
    Then the pipeline should produce an "[INCOMPLETE]" notification
    And the INCOMPLETE notification should list "Integration tests for the new JWT flow"
    And the INCOMPLETE notification should list "Error handling for token refresh edge case"

  Scenario: Completion check result — incomplete without specific items
    When the completion check agent responds with "The work is not fully complete"
    Then the pipeline should produce an "[INCOMPLETE]" notification
    And the INCOMPLETE notification should contain a generic message about incomplete work

  # ── Stage 4: Final Notification ────────────────────────────────────────

  Scenario: Final git diff captured at pipeline end
    When the auto-pipeline completes all stages
    Then the "{threadId}.diff" file should contain the cumulative diff of all changes

  Scenario: DONE notification includes full evidence
    When the auto-pipeline completes successfully
    Then the "[DONE]" notification should contain:
      | field     | pattern                                    |
      | threadId  | thr_abc                                    |
      | duration  | completed in {N}s                          |
      | diffStat  | {N} files                                  |
      | config    | model={model} effort={effort} mode={flow}  |
      | diff      | path to .diff file                         |
      | files     | file change lines with +/- stats           |
      | actions   | review, revise, detail commands             |

  Scenario: INCOMPLETE notification includes evidence and actions
    When the auto-pipeline determines the task is incomplete
    Then the "[INCOMPLETE]" notification should contain:
      | field    | pattern                                    |
      | threadId | thr_abc                                    |
      | diffStat | {N} files                                  |
      | diff     | path to .diff file                         |
      | review   | verdict and finding count                  |
      | missing  | list of missing items                      |
      | actions  | fix, new, detail commands                  |

  # ── Pipeline With All Stages Disabled ──────────────────────────────────

  Scenario: Pipeline with auto_review false and empty post_task_prompt
    Given auto_review is false in config
    And post_task_prompt is empty in config
    When the auto-pipeline runs
    Then only git diff should be captured
    And a "[DONE]" notification should be produced immediately

  # ── Pipeline Edge Cases ────────────────────────────────────────────────

  Scenario: Fix turn fails produces ERROR
    Given the auto-review found findings
    When the fix turn fails with an error
    Then the pipeline should produce an "[ERROR]" notification
    And the ERROR notification should mention "Auto-fix failed"
    And the pipeline should NOT proceed to the completion check

  Scenario: Unexpected question during fix turn produces ERROR
    Given the auto-review found findings and a fix turn is running
    When Codex sends a requestUserInput during the fix turn
    Then the question should time out (fix turns use execute instructions which suppress questions)
    And an "[ERROR]" notification should be produced mentioning "Unexpected question during auto-fix"

  Scenario: Context window exceeded during pipeline produces ERROR
    Given the auto-pipeline is running
    When a ContextWindowExceeded error occurs during the review stage
    Then the pipeline should produce an "[ERROR]" notification
    And the ERROR notification should mention "ContextWindowExceeded during review"

  Scenario: will_retry error during pipeline does not abort
    Given the auto-pipeline is running
    When an error notification arrives with will_retry set to true
    Then the pipeline should NOT abort
    And the pipeline should continue waiting for the turn to complete

  Scenario: No files changed produces valid DONE
    Given the execution turn completed but no files were modified
    When the auto-pipeline runs
    Then the "[DONE]" notification should contain "0 files"
    And the diff file should be empty or contain no changes

  # ── Review During Pipeline vs Standalone ───────────────────────────────

  Scenario: Auto-pipeline review does NOT produce REVIEW tag
    Given auto_review is true in config
    When the auto-pipeline runs the review stage
    Then no "[REVIEW]" tag should appear in the events file
    And the review results should only appear in the NDJSON log

  # ── Execute Instructions Injection ─────────────────────────────────────

  Scenario: Fix turn uses execute.md as developerInstructions
    Given the auto-review found findings
    When the fix turn is started
    Then the collaborationMode settings should include developerInstructions
    And the developerInstructions should contain the execute.md template content
    And the mode should be "default" (not "execute" which is unreachable via API)

  Scenario: Completion check turn uses execute.md as developerInstructions
    When the completion check turn is started
    Then the collaborationMode settings should include developerInstructions
    And the developerInstructions should contain the execute.md template content
