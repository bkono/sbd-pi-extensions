# @solvedbydev/pi-minions

A Solved By Dev fork/port of the MIT-licensed [`pi-minions`](https://github.com/kalindudc/pi-minions) extension.

It keeps the newer foreground minion workflow from upstream while restoring the delegation-conscience behavior we missed: after enough parent-session tool calls, pi gets a contextual reminder to delegate independent work to minions.

## Tools

- `spawn` — run one foreground minion, or pass `tasks` for parallel foreground minions.
- `list_agents` / `list_minion_types` — discover available agent definitions.
- `list_minions` / `show_minion` — inspect current-session minion state.
- `halt` — abort one minion or all running minions.
- `learn_minions` — return concise usage guidance.

## Configuration

```json
{
  "pi-minions": {
    "allowEphemeral": true,
    "delegation": {
      "enabled": true,
      "toolCallThreshold": 16,
      "hintIntervalMinutes": 8,
      "acknowledgementRequired": false,
      "complexTaskKeywords": ["investigate", "audit", "review", "refactor", "analyze", "implement"],
      "message": "Optional custom reminder text. Use {toolCallCount} for the current count."
    },
    "display": {
      "outputPreviewLines": 20,
      "observabilityLines": 6,
      "showStatusHints": true
    },
    "toolSync": {
      "enabled": true,
      "maxWait": 5
    }
  }
}
```

Global settings come from `getAgentDir()/settings.json`; project settings in `<cwd>/.pi/settings.json` override them.
