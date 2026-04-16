Feature: Timeout and Stuck Detection
  As the codex-bridge resilience layer,
  I need timeouts at every blocking wait point
  so that the system never gets permanently stuck.

  Background:
    Given the codex-bridge CLI is available
    And the Codex app-server is running and authenticated

  # ── Plan Turn Timeout ──────────────────────────────────────────────────

  Scenario: Plan turn exceeds timeout
    Given a task is running in plan mode on thread "thr_abc"
    When the plan turn runs for more than 300 seconds without completing
    Then the turn should be interrupted
    And the events file should contain "[ERROR] thr_abc failed | ClientTimeout"
    And the ERROR notification should contain "Plan turn exceeded 300s"
    And the ERROR notification should contain "phase: plan"

  # ── Execution Turn Timeout ─────────────────────────────────────────────

  Scenario: Execution turn exceeds timeout
    Given a task is executing in default mode on thread "thr_abc"
    When the execution turn runs for more than 600 seconds without completing
    Then the turn should be interrupted
    And the events file should contain "[ERROR] thr_abc failed | ClientTimeout"
    And the ERROR notification should contain "Execution turn exceeded 600s"

  # ── Question Timeout ───────────────────────────────────────────────────

  Scenario: Question unanswered for timeout period
    Given a task is running on thread "thr_abc"
    And Codex asks a question via requestUserInput
    When the question remains unanswered for 300 seconds
    Then an empty response "{answers: {}}" should be sent to the app-server
    And the pending request should be removed from the store
    And the turn should resume (Codex continues with defaults or re-asks)
    And a warning should be logged to NDJSON

  Scenario: Answering question before timeout cancels the timeout
    Given a task is running on thread "thr_abc"
    And Codex asks a question via requestUserInput
    When I answer the question within 300 seconds
    Then the timeout timer should be cancelled
    And no timeout error should be produced

  Scenario: Question timeout sends empty answers which is safe
    Given a task is running on thread "thr_abc"
    And Codex asks a question via requestUserInput
    When the question timeout fires and sends "{answers: {}}"
    Then the app-server should accept the empty answer
    And the turn should not crash

  # ── Auto-Review Timeout ────────────────────────────────────────────────

  Scenario: Auto-review turn exceeds timeout
    Given the auto-pipeline is running the review stage on thread "thr_abc"
    When the review turn runs for more than 300 seconds
    Then the pipeline should abort
    And the events file should contain "[ERROR] thr_abc failed | ClientTimeout"
    And the ERROR notification should contain "Auto-review exceeded 300s"

  # ── Auto-Fix Timeout ───────────────────────────────────────────────────

  Scenario: Auto-fix turn exceeds timeout
    Given the auto-pipeline is running the fix stage on thread "thr_abc"
    When the fix turn runs for more than 300 seconds
    Then the pipeline should abort
    And the events file should contain "[ERROR] thr_abc failed | ClientTimeout"
    And the ERROR notification should contain "Auto-fix exceeded 300s"

  # ── Completion Check Timeout ───────────────────────────────────────────

  Scenario: Completion check exceeds timeout
    Given the auto-pipeline is running the completion check on thread "thr_abc"
    When the completion check runs for more than 120 seconds
    Then the pipeline should abort
    And the events file should contain "[ERROR] thr_abc failed | ClientTimeout"
    And the ERROR notification should contain "Completion check exceeded 120s"

  # ── Pipeline Total Timeout ─────────────────────────────────────────────

  Scenario: Entire auto-pipeline exceeds total timeout
    Given the auto-pipeline is running on thread "thr_abc"
    When the total pipeline time exceeds 900 seconds
    Then the pipeline should abort
    And the events file should contain "[ERROR] thr_abc failed | ClientTimeout"
    And the ERROR notification should contain "Auto-pipeline exceeded 900s"
    And the ERROR notification should list which stages completed before the timeout

  # ── Idle Watchdog ──────────────────────────────────────────────────────

  Scenario: No events received for idle timeout period
    Given a task is running on thread "thr_abc"
    When no app-server notifications are received for 120 seconds
    Then the events file should contain "[ERROR] thr_abc failed | ClientTimeout"
    And the ERROR notification should contain "No events received for 120s (possible stuck)"

  Scenario: Each notification resets the idle watchdog
    Given a task is running on thread "thr_abc"
    When 100 seconds pass with no events
    And then a notification arrives
    Then the idle watchdog timer should reset to 120 seconds
    And no idle timeout error should be produced

  Scenario: will_retry error resets the idle watchdog
    Given a task is running on thread "thr_abc"
    When an error notification arrives with will_retry set to true
    Then the idle watchdog should be reset
    And the system should wait for the retry to complete

  # ── Process Death Detection ────────────────────────────────────────────

  Scenario: App-server process exits unexpectedly
    Given a task is running on thread "thr_abc"
    When the Codex app-server process exits before the turn completes
    Then the events file should contain "[ERROR] thr_abc failed | ProcessDeath"
    And the ERROR notification should contain "Codex app-server exited before turn completed"

  # ── Timeout During Auto-Pipeline ───────────────────────────────────────

  Scenario: Timeout during pipeline reports partial progress
    Given the auto-pipeline completed the review stage
    And the auto-pipeline is running the fix stage
    When the pipeline total timeout fires
    Then the ERROR notification should indicate that "review" was completed
    And the ERROR notification should indicate that "fix" was in progress

  # ── Multiple Timeouts ──────────────────────────────────────────────────

  Scenario: First timeout wins when multiple fire simultaneously
    Given a turn timeout and an idle timeout are both approaching
    When both timeouts fire at approximately the same time
    Then only one "[ERROR]" should be written to the events file
    And the resolved flag should prevent the second timeout from firing

  # ── Turn Interrupt on Timeout ──────────────────────────────────────────

  Scenario: Turn is interrupted when timeout fires
    Given a task is running on thread "thr_abc" with turn "turn_456"
    When the turn timeout fires
    Then a turn/interrupt request should be sent to the app-server
    And the interrupt should have a 5-second response timeout

  Scenario: Turn interrupt itself fails
    Given a task is running on thread "thr_abc" with turn "turn_456"
    When the turn timeout fires
    And the turn/interrupt request fails or times out
    Then an additional error should be logged
    And the system should not hang waiting for the interrupt

  # ── Timeout Values Table ───────────────────────────────────────────────

  Scenario Outline: Correct timeout values for each phase
    When the "<phase>" timeout is configured
    Then the default timeout value should be <seconds> seconds

    Examples:
      | phase              | seconds |
      | plan turn          | 300     |
      | execution turn     | 600     |
      | question unanswered| 300     |
      | auto-review turn   | 300     |
      | auto-fix turn      | 300     |
      | completion check   | 120     |
      | auto-pipeline total| 900     |
      | no-event idle      | 120     |
