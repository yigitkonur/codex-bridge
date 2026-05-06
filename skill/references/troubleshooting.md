# Troubleshooting

## Hook bypass

Set `CODEX_BRIDGE_HOOK_DISABLE=<name>` for one session, or `CODEX_BRIDGE_HOOK_DISABLE=all` to bypass every codex-bridge hook.

Hook names:

- `session-start`
- `session-end`
- `pre-tool-agent`
- `post-tool-bash`
- `user-prompt-submit`
- `subagent-stop`
- `stop-gate`

## Monitor defaults

The default Monitor hint uses `--exclude HEARTBEAT`, `--timeout-ms 1800000`, and `persistent: false`.

- `--exclude HEARTBEAT` keeps 60-second liveness pulses out of the LLM window while allowing future tags through.
- `--timeout-ms 1800000` matches the 30-minute turn ceiling used by long write-mode tasks.
- `persistent: false` lets Monitor self-terminate on `[DONE]`, `[ERROR]`, `[INCOMPLETE]`, or `[PLAN]`.

Use `events --help`, `wait --help`, and `config show --json` before overriding these defaults.
