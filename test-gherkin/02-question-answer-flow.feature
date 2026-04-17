Feature: Question-Answer Flow
  As Claude Code monitoring a Codex task,
  I need to receive questions, answer them, and have Codex resume
  so that interactive planning and execution work correctly.

  Background:
    Given the codex-bridge CLI is available
    And the Codex app-server is running and authenticated
    And a task is running in plan mode on thread "thr_abc"

  # ── Question Notification Format ───────────────────────────────────────

  Scenario: Single-choice question produces QUESTION notification
    When Codex sends a requestUserInput with:
      | field     | value                                           |
      | threadId  | thr_abc                                         |
      | turnId    | turn_456                                        |
      | itemId    | item_789                                        |
    And the question has id "q1", header "Auth Strategy", text "Which authentication strategy should I use?"
    And the question has options:
      | label   | description                                |
      | jwt     | JSON Web Tokens with refresh rotation      |
      | session | Server-side sessions with Redis            |
      | oauth   | OAuth 2.0 with external provider           |
    And isOther is true
    Then the events file should contain a "[QUESTION]" tag
    And the QUESTION notification should contain the thread ID "thr_abc"
    And the QUESTION notification should contain a request ID
    And the QUESTION notification should contain the question text in quotes
    And the QUESTION notification should list option "(a) jwt"
    And the QUESTION notification should list option "(b) session"
    And the QUESTION notification should list option "(c) oauth"
    And the QUESTION notification should contain "[other: custom answer allowed]"
    And the QUESTION notification should contain a respond command with the request ID

  Scenario: Question without isOther omits the other line
    When Codex sends a requestUserInput with isOther set to false
    Then the QUESTION notification should NOT contain "[other:"

  Scenario: Multi-question requestUserInput produces multiple question blocks
    When Codex sends a requestUserInput with 2 questions:
      | id | header    | question              |
      | q1 | Framework | Which test framework? |
      | q2 | Coverage  | Include coverage?     |
    Then the QUESTION notification should contain blocks for both questions
    And the respond command should reference each question ID

  Scenario: All questions must have options (API-enforced)
    # This is an API invariant, not something we validate, but we depend on it
    When Codex sends a requestUserInput
    Then every question in the request should have at least one option

  # ── Respond Command ────────────────────────────────────────────────────

  Scenario: Respond with option label
    Given a "[QUESTION]" notification is pending with request ID "req-abc1-k9x"
    And the question has id "q1" and options "jwt", "session", "oauth"
    When I run "codex-bridge respond req-abc1-k9x --question-id q1 --answer jwt"
    Then the exit code should be 0
    And a JSON-RPC response should be sent with answers {"q1": {"answers": ["jwt"]}}
    And the pending request "req-abc1-k9x" should be removed from the store
    And stdout should contain "Responded to req-abc1-k9x"

  Scenario: Respond with custom text when isOther is true
    Given a "[QUESTION]" notification is pending with request ID "req-abc1-k9x"
    And the question has isOther set to true
    When I run "codex-bridge respond req-abc1-k9x --question-id q1 --answer 'Use SAML for enterprise SSO'"
    Then a JSON-RPC response should be sent with answers {"q1": {"answers": ["Use SAML for enterprise SSO"]}}

  Scenario: Respond defaults to first question ID when --question-id omitted
    Given a "[QUESTION]" notification is pending with request ID "req-abc1-k9x"
    And the question has id "q1"
    When I run "codex-bridge respond req-abc1-k9x --answer jwt"
    Then a JSON-RPC response should be sent with question ID "q1"

  Scenario: Respond with raw JSON payload (escape hatch)
    Given a "[QUESTION]" notification is pending with request ID "req-abc1-k9x"
    When I run "codex-bridge respond req-abc1-k9x --json-payload '{\"answers\":{\"q1\":{\"answers\":[\"jwt\"]},\"q2\":{\"answers\":[\"yes\"]}}}'"
    Then the raw JSON payload should be sent as-is to the app-server

  Scenario: Respond to nonexistent request shows error
    When I run "codex-bridge respond req-nonexistent --question-id q1 --answer jwt"
    Then the exit code should be non-zero
    And stderr should contain "No pending request found: req-nonexistent"

  Scenario: Respond to already-answered request shows error
    Given a "[QUESTION]" was pending with request ID "req-abc1-k9x"
    And the request was already answered
    When I run "codex-bridge respond req-abc1-k9x --question-id q1 --answer jwt"
    Then the exit code should be non-zero
    And stderr should contain "No pending request found"

  Scenario: Respond without --answer shows error
    Given a "[QUESTION]" notification is pending with request ID "req-abc1-k9x"
    When I run "codex-bridge respond req-abc1-k9x --question-id q1"
    Then the exit code should be non-zero
    And stderr should contain "requires --answer"

  # ── CONFIRMED Notification ─────────────────────────────────────────────

  Scenario: Successful respond triggers CONFIRMED notification
    Given a "[QUESTION]" notification is pending with request ID "req-abc1-k9x"
    When I run "codex-bridge respond req-abc1-k9x --question-id q1 --answer jwt"
    And the app-server sends a serverRequest/resolved notification
    Then the events file should contain a "[CONFIRMED]" tag
    And the CONFIRMED notification should contain the thread ID
    And the CONFIRMED notification should contain the request ID
    And the CONFIRMED notification should contain "codex resumed"

  # ── Question During Plan Mode ──────────────────────────────────────────

  Scenario: Question during planning is expected and answerable
    Given a task is running in plan mode on thread "thr_abc"
    When Codex asks a question via requestUserInput
    Then a "[QUESTION]" notification appears in the events file
    And after answering with respond, Codex continues planning
    And eventually a "[PLAN]" notification is produced

  Scenario: Multiple questions before plan
    Given a task is running in plan mode on thread "thr_abc"
    When Codex asks question 1 and I answer it
    And Codex asks question 2 and I answer it
    Then Codex should continue planning with both answers
    And a "[PLAN]" notification should eventually be produced

  # ── Question During Execution Mode ─────────────────────────────────────

  Scenario: Questions during execution depend on config
    Given the config has allow_questions set to true
    And the config has default_mode_request_user_input set to true
    And a task is executing in default mode on thread "thr_abc"
    When Codex asks a question via requestUserInput
    Then a "[QUESTION]" notification appears in the events file

  Scenario: Questions disabled during execution when allow_questions is false
    Given the config has allow_questions set to false
    And a task is executing in default mode on thread "thr_abc"
    Then Codex should NOT send requestUserInput during execution

  # ── Concurrent Requests ────────────────────────────────────────────────

  Scenario: Multiple pending questions have unique request IDs
    Given Codex sends requestUserInput for question A with request ID "req-a"
    And Codex sends requestUserInput for question B with request ID "req-b"
    When I respond to "req-a" with answer "jwt"
    And I respond to "req-b" with answer "yes"
    Then both responses should be sent successfully
    And both pending requests should be removed from the store

  Scenario: First respond wins on concurrent calls
    Given a "[QUESTION]" notification is pending with request ID "req-abc1-k9x"
    When two respond calls are made simultaneously for "req-abc1-k9x"
    Then the first call should succeed
    And the second call should receive "No pending request found"

  # ── Request ID Mapping ─────────────────────────────────────────────────

  Scenario: Internal request ID maps to JSON-RPC numeric ID
    Given a requestUserInput arrives with JSON-RPC numeric ID 42
    Then the pending request store should map a human-readable internal ID to RPC ID 42
    And the "[QUESTION]" notification should use the human-readable internal ID
    And when I respond using the internal ID, the JSON-RPC response should use numeric ID 42

  # ── NDJSON Logging ─────────────────────────────────────────────────────

  Scenario: Question and response are logged to NDJSON
    Given a "[QUESTION]" notification is pending with request ID "req-abc1-k9x"
    When I run "codex-bridge respond req-abc1-k9x --question-id q1 --answer jwt"
    Then the NDJSON file should contain a "QUESTION" tagged entry
    And the NDJSON file should contain a "SERVER_RESPONSE" tagged entry with the answer payload

  # ── Secret Questions ───────────────────────────────────────────────────

  Scenario: Secret question (isSecret: true) is handled like normal
    When Codex sends a requestUserInput with isSecret set to true
    Then the question should still appear in the events file
    And the respond command should work the same way
    # Note: isSecret is advisory for UI masking, not enforced in CLI
