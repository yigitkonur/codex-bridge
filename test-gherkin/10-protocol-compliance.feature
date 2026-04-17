Feature: Protocol Compliance — JSON-RPC and App-Server API
  As codex-bridge communicating with the Codex app-server,
  I need to send correctly structured JSON-RPC messages
  so that the protocol is respected and operations work reliably.

  Background:
    Given the codex-bridge CLI is available
    And the Codex app-server is running and authenticated

  # ── Initialize ─────────────────────────────────────────────────────────

  Scenario: Initialize uses experimentalApi true
    When codex-bridge connects to the app-server
    Then the initialize request should include "experimentalApi: true"
    # Note: the official plugin uses false, but codex-bridge needs true for full API access

  # ── Thread Start ───────────────────────────────────────────────────────

  Scenario: thread/start uses string sandbox
    When a new task starts a thread
    Then the thread/start request should include sandbox as a string
    And the sandbox value should be "read-only" or "workspace-write"
    # Note: sandbox on thread/start is a string, NOT a tagged object

  Scenario: thread/start includes required fields
    When a new task starts a thread
    Then the thread/start request should include:
      | field            | type   |
      | cwd              | string |
      | model            | string |
      | approvalPolicy   | string |
      | sandbox          | string |
      | collaborationMode| object |
      | serviceName      | string |
      | ephemeral        | boolean|
    And approvalPolicy should be "never"
    And serviceName should be "codex_bridge"

  # ── Turn Start ─────────────────────────────────────────────────────────

  Scenario: collaborationMode is sent on turn/start NOT thread/start
    When a new turn is started on an existing thread
    Then the turn/start request should include the collaborationMode object
    # Note: collaborationMode goes on turn/start, not thread/start

  Scenario: sandboxPolicy on turn/start is a tagged object
    When a new turn is started
    Then the sandboxPolicy should be a tagged object like {"type": "readOnly"}
    And it should NOT be a plain string
    # Note: this is different from sandbox on thread/start which IS a string

  Scenario: Plan mode turn uses correct parameters
    When a plan mode turn is started
    Then the collaborationMode should have mode "plan"
    And the settings should have reasoning_effort "xhigh"
    And the settings should have developer_instructions with plan-enforcement.md content
    # Note: plan-mode enforcement overrides Codex's brainstorming skill, which
    # previously leaked into plan turns when developer_instructions was null.
    And the sandboxPolicy should be {"type": "readOnly"}

  Scenario: Default mode turn uses correct parameters
    When a default mode turn is started for execution
    Then the collaborationMode should have mode "default"
    And the settings should have reasoning_effort from config
    And the settings should have developer_instructions with execute-instructions.md content
    And the sandboxPolicy should be {"type": "workspaceWrite"}

  Scenario: Execute-style turn uses default mode with custom instructions
    When a fix or completion check turn is started
    Then the collaborationMode should have mode "default"
    And the settings should have developer_instructions with execute.md content
    # Note: "execute" mode is unreachable via API (alias maps to "default")

  # ── Plan Detection ─────────────────────────────────────────────────────

  Scenario: Plan detected from item/completed with type "plan"
    When an item/completed notification arrives with item.type "plan"
    Then the system should recognize this as a plan
    And a "[PLAN]" notification should be written to events

  Scenario: turn/plan/updated is NOT used for plan detection
    When a turn/plan/updated notification arrives
    Then it should NOT trigger a "[PLAN]" notification
    # Note: turn/plan/updated is from update_plan tool only, not proposed_plan

  # ── requestUserInput ───────────────────────────────────────────────────

  Scenario: requestUserInput response uses original JSON-RPC ID
    Given a requestUserInput server request arrives with JSON-RPC ID 42
    When the respond command sends the answer
    Then the JSON-RPC response should use ID 42 (not an internal ID)

  Scenario: requestUserInput response format matches schema
    When responding to a requestUserInput
    Then the response payload should match:
      """
      {
        "answers": {
          "<questionId>": {
            "answers": ["<answerText>"]
          }
        }
      }
      """

  Scenario: Empty answer response on question timeout
    When a question timeout fires
    Then the response sent should be {"answers": {}}
    And this should be accepted by the app-server without crashing

  # ── Command Approval ───────────────────────────────────────────────────

  Scenario: Command execution approval auto-accepted
    When an item/commandExecution/requestApproval server request arrives
    Then codex-bridge should auto-accept it
    # Note: approvalPolicy "never" prevents these, but if they arrive, auto-accept

  Scenario: File change approval auto-accepted
    When an item/fileChange/requestApproval server request arrives
    Then codex-bridge should auto-accept it

  # ── Turn Steer ─────────────────────────────────────────────────────────

  Scenario: turn/steer sends correct payload
    When a steer command is executed
    Then the turn/steer RPC should include:
      | field          | type   |
      | threadId       | string |
      | input          | array  |
      | expectedTurnId | string |
    And input should contain a text content item

  # ── Turn Interrupt ─────────────────────────────────────────────────────

  Scenario: Turn interrupt on timeout sends correct RPC
    When a turn timeout fires and interrupt is needed
    Then a turn/interrupt RPC should be sent with threadId and turnId

  # ── Review Start ───────────────────────────────────────────────────────

  Scenario: Auto-review uses review/start RPC
    When the auto-pipeline starts the review stage
    Then a review/start RPC should be sent with scope "auto"

  # ── Structured Completion Check ────────────────────────────────────────

  Scenario: Completion check uses outputSchema for structured response
    # TODO: plan ambiguity — the auto-pipeline plan mentions outputSchema
    # for structured JSON { complete: boolean, missing_items: string[] }
    # but the implementation details show heuristic text parsing instead.
    # Best interpretation: if outputSchema is available, use it for
    # deterministic parsing; fall back to text heuristics otherwise.
    When the completion check turn is started
    Then it should request a structured response indicating completeness
