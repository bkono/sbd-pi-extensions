# @solvedbydev/pi-minions

A Solved By Dev fork/port of the MIT-licensed [`pi-minions`](https://github.com/kalindudc/pi-minions) extension.

It keeps the newer foreground minion workflow from upstream while restoring the delegation-conscience behavior we missed: after enough parent-session tool calls, pi gets a system-prompt reminder to delegate independent work to minions.

## Tools

- `spawn` — run one foreground minion, or pass `tasks` for parallel foreground minions.
- `list_agents` / `list_minion_types` — discover available agent definitions.
- `list_minions` / `show_minion` — inspect spawn and orchestrated minion state (role, taskType, group, output, messages, path intent).
- `halt` — abort one minion, an orchestration group, or all running minions. Halt group forgets the open group.
- `learn_minions` — return concise usage guidance.

## Configuration

```json
{
  "pi-minions": {
    "allowEphemeral": true,
    "delegation": {
      "enabled": true,
      "toolCallThreshold": 16,
      "promptLengthThreshold": 4000,
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

Delegation reminders are injected into the system prompt, never as synthetic user messages. The `acknowledgementRequired` setting is kept for backward compatibility but no longer adds mandatory acknowledgement text; custom `message` values are used verbatim.
