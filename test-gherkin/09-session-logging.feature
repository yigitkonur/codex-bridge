Feature: Session Logging — NDJSON and Artifacts
  As the codex-bridge logging system,
  I need to capture every notification to NDJSON and manage artifact files
  so that retrospective analysis and the summary command work correctly.

  Background:
    Given the codex-bridge CLI is available
    And the Codex app-server is running and authenticated
    And a task is running on thread "thr_abc"

  # ── NDJSON File Structure ──────────────────────────────────────────────

  Scenario: NDJSON entries have required fields
    When any app-server notification is received
    Then the NDJSON entry should be a single JSON object on one line
    And the entry should have field "ts" with an ISO 8601 timestamp
    And the entry should have field "tag" with a string value
    And the entry should have field "method" with the notification method name
    And the entry should have field "threadId" with the thread ID
    And the entry should have field "data" with the notification payload

  Scenario: NDJSON file is append-only
    When multiple notifications are received
    Then each notification should be appended as a new line
    And earlier entries should not be modified or removed

  Scenario: Every notification type is logged to NDJSON
    When the following notifications arrive:
      | method               |
      | thread/started       |
      | turn/started         |
      | turn/completed       |
      | item/started         |
      | item/completed       |
      | error                |
      | turn/diff/updated    |
    Then each should have a corresponding NDJSON entry

  # ── NDJSON Tag Values ──────────────────────────────────────────────────

  Scenario Outline: Notifications map to correct NDJSON tags
    When a "<method>" notification is received
    Then the NDJSON entry should have tag "<tag>"

    Examples:
      | method                          | tag              |
      | thread/started                  | THREAD_STARTED   |
      | turn/started                    | TURN_STARTED     |
      | turn/completed                  | TURN_COMPLETED   |
      | item/started                    | ITEM_STARTED     |
      | item/completed                  | ITEM_COMPLETED   |
      | error                           | ERROR            |
      | item/tool/requestUserInput      | QUESTION         |
      | serverRequest/resolved          | CONFIRMED        |

  Scenario: Plan item/completed gets PLAN tag
    When an item/completed notification arrives with item.type "plan"
    Then the NDJSON entry should have tag "PLAN"

  Scenario: Review events get specific tags
    When a review starts
    Then the NDJSON entry should have tag "REVIEW_START"
    When the review ends
    Then the NDJSON entry should have tag "REVIEW_END"

  Scenario: Git diff capture gets DIFF tag
    When a git diff is captured during the pipeline
    Then the NDJSON entry should have tag "DIFF"

  Scenario: Pipeline stage transitions get PIPELINE_STAGE tag
    When the auto-pipeline transitions between stages
    Then the NDJSON entry should have tag "PIPELINE_STAGE"

  Scenario: Client-side timeouts get TIMEOUT tag
    When a client-side timeout fires
    Then the NDJSON entry should have tag "TIMEOUT"

  Scenario: Generic notifications get NOTIFICATION tag
    When a notification arrives that doesn't match any specific tag
    Then the NDJSON entry should have tag "NOTIFICATION"

  # ── File Layout ────────────────────────────────────────────────────────

  Scenario: Session files follow naming convention
    When a task starts on thread "thr_abc"
    Then the session directory should contain:
      | file              | purpose                 |
      | thr_abc.ndjson    | Full structured log     |
      | thr_abc.events    | Monitor-friendly events |

  Scenario: Artifact files are created at appropriate times
    When a plan is produced
    Then "thr_abc.plan.md" should exist in the session directory
    When the auto-pipeline captures a diff
    Then "thr_abc.diff" should exist in the session directory

  Scenario: Review JSON file only for standalone review
    When I run "codex-bridge review --scope working-tree"
    Then a ".review.json" file should be created in the session directory
    But during auto-pipeline review, no ".review.json" file should be created

  # ── NDJSON Parsing for Summary ─────────────────────────────────────────

  Scenario: NDJSON supports jq filtering by tag
    Given a task on thread "thr_abc" has completed with NDJSON log
    When I filter NDJSON entries by tag "ERROR"
    Then only error entries should be returned

  Scenario: NDJSON supports timeline reconstruction
    Given a task on thread "thr_abc" has completed with NDJSON log
    When I read NDJSON entries in order
    Then they should be in chronological order by timestamp
    And turn boundaries should be identifiable by TURN_STARTED tags

  # ── Diff File Lifecycle ────────────────────────────────────────────────

  Scenario: Diff file is overwritten at each pipeline stage
    When the execution turn completes
    Then "thr_abc.diff" should contain the execution diff
    When the fix turn completes
    Then "thr_abc.diff" should be overwritten with execution + fix diff
    When the pipeline finishes
    Then "thr_abc.diff" should contain the final cumulative diff

  Scenario: Diff file uses git diff format
    When a diff is captured
    Then "thr_abc.diff" should contain unified diff format

  # ── Plan File Lifecycle ────────────────────────────────────────────────

  Scenario: Plan file written on plan detection
    When an item/completed notification arrives with type "plan"
    Then "thr_abc.plan.md" should contain the plan text in markdown format

  Scenario: Plan file overwritten on revision
    Given a plan was written to "thr_abc.plan.md"
    When a revised plan arrives via another item/completed with type "plan"
    Then "thr_abc.plan.md" should be overwritten with the new plan text

  # ── Malformed NDJSON Handling ──────────────────────────────────────────

  Scenario: Malformed NDJSON lines are skipped during parsing
    Given the NDJSON file contains a corrupted line
    When the summary command reads the NDJSON
    Then the corrupted line should be skipped
    And valid entries should still be parsed correctly
