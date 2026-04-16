Feature: Configuration System
  As codex-bridge starting up,
  I need to load configuration from YAML with hardcoded fallbacks
  so that the system always works even with missing or broken config.

  Background:
    Given the codex-bridge CLI is available

  # ── Default Config Values ──────────────────────────────────────────────

  Scenario: All defaults are applied when no YAML exists
    Given no config.yaml file exists in the skill directory
    When codex-bridge starts
    Then the effective config should have mode "plan"
    And the effective config should have model "gpt-5.4"
    And the effective config should have effort "high"
    And the effective config should have auto_review set to true
    And the effective config should have allow_questions set to true
    And the effective config should have a non-empty post_task_prompt
    And the effective config should have session_dir "~/.codex-bridge/sessions"

  # ── YAML Loading ───────────────────────────────────────────────────────

  Scenario: YAML config overrides defaults
    Given a config.yaml file exists with:
      """
      codex_bridge:
        mode: "default"
        effort: "xhigh"
        auto_review: false
      """
    When codex-bridge starts
    Then the effective config should have mode "default"
    And the effective config should have effort "xhigh"
    And the effective config should have auto_review set to false
    And the effective config should have model "gpt-5.4" (unchanged default)

  Scenario: Missing YAML file uses defaults silently
    Given no config.yaml file exists in the skill directory
    When codex-bridge starts
    Then no error should be reported
    And the system should operate with hardcoded defaults

  Scenario: Malformed YAML file uses defaults silently
    Given a config.yaml file exists with invalid YAML content "{{invalid"
    When codex-bridge starts
    Then no error should crash the system
    And the system should operate with hardcoded defaults

  Scenario: Unknown keys in YAML are ignored
    Given a config.yaml file exists with:
      """
      codex_bridge:
        mode: "plan"
        unknown_future_key: "some value"
        another_unknown: 42
      """
    When codex-bridge starts
    Then the system should start normally
    And the unknown keys should be ignored

  # ── Config Resolution Order ────────────────────────────────────────────

  Scenario: YAML overrides hardcoded defaults
    Given the hardcoded default for effort is "high"
    And a config.yaml sets effort to "low"
    When codex-bridge starts
    Then the effective effort should be "low"

  Scenario: Codex user config inherits model if not overridden
    Given no model is set in config.yaml
    And the Codex user config has model "gpt-5.5"
    When codex-bridge starts
    Then the effective model should be "gpt-5.5"

  Scenario: YAML model takes precedence over Codex user config
    Given config.yaml sets model to "gpt-5.4"
    And the Codex user config has model "gpt-5.5"
    When codex-bridge starts
    Then the effective model should be "gpt-5.4"

  Scenario: Codex config unavailable uses our defaults
    Given no model is set in config.yaml
    And the Codex config/read RPC fails or is unavailable
    When codex-bridge starts
    Then the effective model should be the hardcoded default "gpt-5.4"

  # ── Session Directory ──────────────────────────────────────────────────

  Scenario: Session directory with tilde is expanded
    Given config has session_dir set to "~/.codex-bridge/sessions"
    When codex-bridge resolves the session directory
    Then the path should be expanded to the user's home directory
    And the directory should be created if it doesn't exist

  Scenario: Custom session directory is used
    Given config.yaml sets session_dir to "/tmp/codex-sessions"
    When codex-bridge starts
    Then session files should be written to "/tmp/codex-sessions"

  # ── Config Effects on Behavior ─────────────────────────────────────────

  Scenario: mode "plan" starts tasks in plan mode
    Given config has mode set to "plan"
    When I run "codex-bridge task --write 'Some task'"
    Then the task should start in plan mode with read-only sandbox

  Scenario: mode "default" starts tasks in default mode
    Given config has mode set to "default"
    When I run "codex-bridge task --write 'Some task'"
    Then the task should start in default mode with workspace-write sandbox

  Scenario: auto_review false skips pipeline review
    Given config has auto_review set to false
    When a task completes execution
    Then the auto-pipeline should skip the review stage

  Scenario: auto_review true enables pipeline review
    Given config has auto_review set to true
    When a task completes execution
    Then the auto-pipeline should run the review stage

  Scenario: Empty post_task_prompt skips completion check
    Given config has post_task_prompt set to ""
    When a task's auto-pipeline runs
    Then the completion check stage should be skipped

  Scenario: Custom post_task_prompt is used for completion check
    Given config has post_task_prompt set to "Is this task done? List missing items."
    When the auto-pipeline runs the completion check
    Then the prompt sent should be "Is this task done? List missing items."

  Scenario: allow_questions true enables questions in default mode
    Given config has allow_questions set to true
    When a task runs in default mode
    Then Codex should be able to ask questions via requestUserInput

  Scenario: allow_questions false disables questions in default mode
    Given config has allow_questions set to false
    When a task runs in default mode
    Then requestUserInput should not be available to Codex

  Scenario: Plan mode always allows questions regardless of config
    Given config has allow_questions set to false
    When a task runs in plan mode
    Then Codex should still be able to ask questions

  # ── Effort Config ──────────────────────────────────────────────────────

  Scenario: Plan mode always uses xhigh regardless of config effort
    Given config has effort set to "low"
    When a task starts in plan mode
    Then the plan turn should use reasoning effort "xhigh"

  Scenario: Execution mode uses config effort
    Given config has effort set to "high"
    When a plan is approved and execution starts
    Then the execution turn should use reasoning effort "high"

  Scenario: CLI --effort flag overrides config effort
    Given config has effort set to "high"
    When I run "codex-bridge task --write --effort xhigh 'Complex task'"
    Then the execution effort should be "xhigh"
