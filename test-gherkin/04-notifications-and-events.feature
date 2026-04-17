Feature: Notifications and Event File System
  As Claude Code monitoring a Codex task via the Monitor tool,
  I need notifications written correctly to the .events file
  so that I receive timely, actionable information about task progress.

  Background:
    Given the codex-bridge CLI is available
    And the Codex app-server is running and authenticated
    And a task is running on thread "thr_abc"

  # ── Terminal Tags ──────────────────────────────────────────────────────

  Scenario: DONE tag format
    When a task completes successfully
    Then the events file should contain a line matching "[DONE] thr_abc completed in {N}s | {diffStat}"
    And the DONE block should include "config:" line with model, effort, and mode
    And the DONE block should include "diff:" line with an absolute file path
    And the DONE block should include "files:" section with change lines
    And the DONE block should include "actions:" section
    And the actions should include "review:" with a review command
    And the actions should include "revise:" with a send command
    And the actions should include "detail:" with a result command

  Scenario: ERROR tag format
    When a task fails with error code "ContextWindowExceeded"
    Then the events file should contain a line matching "[ERROR] thr_abc failed | ContextWindowExceeded"
    And the ERROR block should include the error message text
    And the ERROR block should include "phase:" line
    And the ERROR block should include "actions:" section
    And the actions should include "retry:" with a send command
    And the actions should include "log:" with a result command
    And the actions should include "cancel:" with a cancel command

  Scenario: INCOMPLETE tag format
    When a completion check determines the task is incomplete
    Then the events file should contain a line matching "[INCOMPLETE] thr_abc | {diffStat}"
    And the INCOMPLETE block should include "diff:" line
    And the INCOMPLETE block should include "review:" line with verdict and finding count
    And the INCOMPLETE block should include "missing:" section with bullet items
    And the INCOMPLETE block should include "actions:" section
    And the actions should include "fix:" with a send command
    And the actions should include "new:" with a task command
    And the actions should include "detail:" with a result command

  # ── Interactive Tags ───────────────────────────────────────────────────

  Scenario: QUESTION tag format
    When Codex asks a question via requestUserInput
    Then the events file should contain a line matching "[QUESTION] thr_abc {requestId}"
    And the QUESTION block should include the question text in double quotes
    And the QUESTION block should list options as "(a) label -- description"
    And the QUESTION block should include "respond:" section with a respond command
    And the respond command should include the request ID and question ID

  Scenario: QUESTION tag with isOther includes other indicator
    When Codex asks a question with isOther set to true
    Then the QUESTION block should include "[other: custom answer allowed]"

  Scenario: QUESTION tag without isOther omits other indicator
    When Codex asks a question with isOther set to false
    Then the QUESTION block should NOT include "[other:"

  Scenario: PLAN tag format
    When Codex produces a plan via item/completed with type "plan"
    Then the events file should contain a line matching "[PLAN] thr_abc {turnId}"
    And the PLAN block should include plan step lines
    And the PLAN block should include "plan:" line with the plan file path
    And the PLAN block should include "actions:" section
    And the actions should include "approve:" with send --mode default command
    And the actions should include "revise:" with a send command

  Scenario: Long plan is truncated in events but full in plan.md
    When Codex produces a plan with 60 steps
    Then the PLAN block in the events file should show at most 10 steps
    And the plan.md file should contain all 60 steps

  # ── Confirmation Tag ───────────────────────────────────────────────────

  Scenario: CONFIRMED tag format
    When a serverRequest/resolved notification arrives for request "req-abc1"
    Then the events file should contain "[CONFIRMED] thr_abc req-abc1 | codex resumed"

  # ── Pipeline Progress Tags ─────────────────────────────────────────────

  Scenario Outline: PIPELINE progress tag format
    When the auto-pipeline reaches the "<stage>" stage
    Then the events file should contain "[PIPELINE:<stage>]" followed by a timestamp

    Examples:
      | stage  |
      | review |
      | fix    |
      | check  |
      | diff   |

  # ── Optional PHASE Tag ─────────────────────────────────────────────────

  Scenario: PHASE tag for file changes
    Given the progress monitor preset is active
    When an item/started notification arrives with type "fileChange" for "src/auth.ts"
    Then the events file should contain "[PHASE] editing src/auth.ts"

  Scenario: PHASE tag for command execution
    Given the progress monitor preset is active
    When an item/started notification arrives with type "commandExecution" for "npm test"
    Then the events file should contain "[PHASE] running: npm test"

  # ── REVIEW Tag (Standalone Only) ───────────────────────────────────────

  Scenario: REVIEW tag format for standalone review
    When I run "codex-bridge review --scope working-tree"
    And the review completes with verdict "needs-attention" and 3 findings
    Then the events file should contain "[REVIEW] thr_xyz verdict: needs-attention | 3 findings"
    And the REVIEW block should list findings with severity and title
    And the REVIEW block should include "full:" line with the review JSON file path
    And the REVIEW block should include "actions:" section with a fix command

  Scenario: REVIEW tag does NOT appear during auto-pipeline
    Given auto_review is true in config
    When a task completes and the auto-pipeline runs the review stage
    Then no "[REVIEW]" tag should appear in the events file

  # ── Monitor Self-Termination ───────────────────────────────────────────

  Scenario Outline: Terminal tags cause Monitor to break
    When the events file receives a "<tag>" notification
    Then a Monitor process tailing the events file should self-terminate

    Examples:
      | tag          |
      | [DONE]       |
      | [ERROR]      |
      | [INCOMPLETE] |

  Scenario: Non-terminal tags do NOT cause Monitor to break
    When the events file receives a "[QUESTION]" notification
    Then a Monitor process tailing the events file should continue running

  Scenario: CONFIRMED tag does NOT cause Monitor to break
    When the events file receives a "[CONFIRMED]" notification
    Then a Monitor process tailing the events file should continue running

  # ── Multi-Line Event Writing ───────────────────────────────────────────

  Scenario: Multi-line events are written atomically
    When a "[DONE]" notification with multiple lines is written
    Then the entire block should be written in a single file append operation
    And each line of the block should be readable by the Monitor within 200ms

  # ── Encoding Safety ────────────────────────────────────────────────────

  Scenario: Event text does not contain null bytes
    When any notification is written to the events file
    Then the text should not contain null bytes
    And the text should be safe for "tail -f | while read" pipeline

  # ── Action Command Paths ───────────────────────────────────────────────

  Scenario: Action commands use absolute script path
    When any notification with actions is written
    Then each action command should use the full absolute path to codex-bridge.mjs
    And the path should be quoted if it contains spaces

  # ── NDJSON Tags Catalog ────────────────────────────────────────────────

  Scenario Outline: NDJSON entries have correct tags
    When a "<notification>" arrives from the app-server
    Then the NDJSON entry should have tag "<ndjson_tag>"

    Examples:
      | notification             | ndjson_tag       |
      | thread/started           | THREAD_STARTED   |
      | turn/started             | TURN_STARTED     |
      | turn/completed           | TURN_COMPLETED   |
      | item/started             | ITEM_STARTED     |
      | item/completed           | ITEM_COMPLETED   |
      | error                    | ERROR            |
      | item/tool/requestUserInput | QUESTION       |
      | serverRequest/resolved   | CONFIRMED        |

  # ── Artifact Files ─────────────────────────────────────────────────────

  Scenario: Diff file is overwritten at each pipeline stage
    When the auto-pipeline runs stage 1 (post-execution diff)
    Then "{threadId}.diff" should contain the execution changes
    When the auto-pipeline runs stage 2b (post-fix diff)
    Then "{threadId}.diff" should be overwritten with execution + fix changes
    When the auto-pipeline runs stage 4 (final diff)
    Then "{threadId}.diff" should contain the cumulative diff

  Scenario: Plan file written on plan detection
    When an item/completed notification arrives with type "plan" and text content
    Then "{threadId}.plan.md" should be written with the plan text

  Scenario: Review JSON written only for standalone review
    When I run "codex-bridge review --scope working-tree"
    Then "{threadId}.review.json" should be written with structured review output

  Scenario: Review JSON NOT written during auto-pipeline
    When the auto-pipeline runs the review stage
    Then no "{threadId}.review.json" should be created
