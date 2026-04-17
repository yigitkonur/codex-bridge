Feature: Error Classification and Recovery
  As the codex-bridge error handling layer,
  I need to classify errors correctly and emit appropriate notifications
  so that Claude Code can make informed recovery decisions.

  Background:
    Given the codex-bridge CLI is available
    And the Codex app-server is running and authenticated
    And a task is running on thread "thr_abc"

  # ── will_retry Suppression ─────────────────────────────────────────────

  Scenario: Error with will_retry true is NOT written to events
    When an error notification arrives with:
      | field           | value              |
      | codexErrorInfo  | ServerOverloaded   |
      | will_retry      | true               |
      | message         | Server busy        |
    Then the events file should NOT contain "[ERROR]"
    And the NDJSON file should contain an "ERROR" tagged entry
    And the idle watchdog should be reset

  Scenario: Error with will_retry false IS written to events
    When an error notification arrives with:
      | field           | value              |
      | codexErrorInfo  | ServerOverloaded   |
      | will_retry      | false              |
      | message         | Server busy        |
    Then the events file should contain "[ERROR] thr_abc failed | ServerOverloaded"

  Scenario: Retryable error followed by non-retryable error
    When an error notification arrives with will_retry true
    And then another error arrives with will_retry false
    Then only the second error should be written to the events file

  Scenario: Retryable error followed by successful completion
    When an error notification arrives with will_retry true
    And then the turn completes successfully
    Then no "[ERROR]" should appear in the events file
    And the task should continue normally

  # ── CodexErrorInfo Mapping ─────────────────────────────────────────────

  Scenario Outline: Error type maps to correct ERROR code
    When an error notification arrives with codexErrorInfo "<codexError>"
    Then the events file should contain "[ERROR] thr_abc failed | <errorCode>"

    Examples:
      | codexError                          | errorCode              |
      | ContextWindowExceeded               | ContextWindowExceeded  |
      | UsageLimitExceeded                  | UsageLimitExceeded     |
      | ResponseTooManyFailedAttempts       | TooManyRetries         |
      | Unauthorized                        | Unauthorized           |
      | BadRequest                          | BadRequest             |
      | SandboxError                        | SandboxError           |
      | InternalServerError                 | InternalServerError    |
      | ActiveTurnNotSteerable              | NotSteerable           |
      | Other                               | Other                  |

  Scenario: Error with no codexErrorInfo maps to "Unknown"
    When an error notification arrives without a codexErrorInfo field
    Then the events file should contain "[ERROR] thr_abc failed | Unknown"

  # ── Conditional Events (will_retry dependent) ──────────────────────────

  Scenario Outline: Retryable errors suppress events when will_retry is true
    When an error notification arrives with codexErrorInfo "<error>" and will_retry true
    Then the events file should NOT contain "[ERROR]"

    Examples:
      | error                            |
      | ServerOverloaded                 |
      | HttpConnectionFailed             |
      | ResponseStreamConnectionFailed   |
      | ResponseStreamDisconnected       |

  Scenario Outline: Fatal errors always emit to events
    When an error notification arrives with codexErrorInfo "<error>" and will_retry false
    Then the events file should contain "[ERROR]"

    Examples:
      | error                          |
      | ContextWindowExceeded          |
      | ResponseTooManyFailedAttempts  |
      | Unauthorized                   |
      | BadRequest                     |

  # ── ERROR Notification Content ─────────────────────────────────────────

  Scenario: ERROR notification includes phase information
    Given the task is in the "execution" phase
    When an error notification arrives with codexErrorInfo "ContextWindowExceeded"
    Then the ERROR block should include "phase: execution"

  Scenario: ERROR notification includes error message
    When an error notification arrives with message "Context window exceeded after 12 tool calls"
    Then the ERROR block should include the text "Context window exceeded after 12 tool calls"

  Scenario: ERROR notification includes recovery actions
    When an error notification arrives
    Then the ERROR block should include "actions:" section
    And the actions should include "retry:" with a send command
    And the actions should include "log:" with a result command
    And the actions should include "cancel:" with a cancel command

  # ── Client-Generated Errors ────────────────────────────────────────────

  Scenario Outline: Timeout errors use ClientTimeout code
    When a "<timeout_type>" timeout fires
    Then the events file should contain "[ERROR] thr_abc failed | ClientTimeout"
    And the ERROR notification should contain "<message_fragment>"

    Examples:
      | timeout_type       | message_fragment                              |
      | turn               | Turn exceeded                                 |
      | idle               | No events received for                        |
      | question           | Question unanswered for                       |
      | pipeline           | Auto-pipeline exceeded                        |

  Scenario: Process death uses ProcessDeath code
    When the app-server process exits unexpectedly
    Then the events file should contain "[ERROR] thr_abc failed | ProcessDeath"
    And the ERROR notification should contain "app-server exited"

  # ── Error During Auto-Pipeline ─────────────────────────────────────────

  Scenario: Error during pipeline includes stage context
    Given the auto-pipeline is running the review stage
    When an unrecoverable error occurs
    Then the "[ERROR]" notification should indicate the error occurred during the pipeline
    And the notification should mention the current pipeline stage

  Scenario: Error after turn/completed does not overwrite DONE
    Given a task completed and "[DONE]" was written to events
    When a late error notification arrives
    Then the "[DONE]" notification should not be removed or overwritten
    And the error should be logged to NDJSON only

  # ── All Errors Logged to NDJSON ────────────────────────────────────────

  Scenario: All errors are logged to NDJSON regardless of will_retry
    When an error notification arrives with will_retry true
    Then the NDJSON file should contain an entry with tag "ERROR"
    And the entry should include the full error details

  Scenario: Client-generated errors are logged to NDJSON
    When a ClientTimeout error is generated
    Then the NDJSON file should contain an entry with tag "TIMEOUT"

  # ── JSON-RPC Error Codes ───────────────────────────────────────────────

  Scenario: Server overloaded RPC error (-32001)
    When a JSON-RPC error response arrives with code -32001
    Then it should be treated as a server overloaded condition

  Scenario: Invalid request RPC error (-32600)
    When a JSON-RPC error response arrives with code -32600
    Then it should be treated as an invalid request (e.g., steer during review)

  Scenario: Method not found RPC error (-32601)
    When a JSON-RPC error response arrives with code -32601
    Then it should be treated as an unsupported method error

  # ── Error Message Truncation ───────────────────────────────────────────

  Scenario: Very long error message is truncated in events
    When an error notification arrives with a message longer than 200 characters
    Then the events file should contain the first 200 characters of the message
    And the NDJSON file should contain the full message
