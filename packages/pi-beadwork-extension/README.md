# @solvedbydev/pi-beadwork-extension

A [pi coding-agent](https://github.com/badlogic/pi-mono) extension for beadwork-aware session engagement, ticket inspection, and plan adoption.

## Current state

This package is now usable for **human-led beadwork workflow feedback**.

Implemented:

- beadwork activation detection
- persisted session mode, scope, and cached `bw prime`
- prompt enrichment in engaged sessions
- typed beadwork adapter for `prime`, `ready`, `blocked`, `list`, `show`, `create`, `dep`, `start`, `close`, and `sync`
- richer `/bw status`
- `/bw engage [scope]`
- `/bw prime [--refresh]`
- `/bw ready [scope]`
- `/bw show <id>`
- `/bw start <id>`
- `/bw close <id>`
- `/bw sync`
- `/bw adopt [--title ...] [--land quick|branch|multi] [--apply]`
- LLM-callable tools for beadwork status, reads, and mutations
- lightweight statusline updates

Still not implemented:

- `/bw run`
- tmux/worktree worker orchestration
- autonomous epic run loop

## Install

### Workspace use

```json
{
  "dependencies": {
    "@solvedbydev/pi-beadwork-extension": "*"
  }
}
```

### Register with pi

Via `settings.json`:

```json
{
  "extensions": [
    "/path/to/sbd-pi-extensions/packages/pi-beadwork-extension/src/index.ts"
  ]
}
```

## Suggested first-use flow

1. Open a beadwork-enabled repo.
2. Run `/bw status`.
3. Run `/bw engage` or `/bw engage <epic-id>`.
4. Inspect state with `/bw ready` and `/bw show <id>`.
5. Convert a conversational plan with `/bw adopt --title "..."`.
6. Re-run `/bw adopt ... --apply` once the preview looks right.

## Config

Optional config resolution order:

1. environment variables
2. `<repo>/.pi/beadwork-config.json`
3. `~/.pi/beadwork-config.json`
4. built-in defaults

Current config keys:

```json
{
  "ui": {
    "showInactiveStatus": false
  },
  "storage": {
    "sessionStateDir": ".pi/beadwork/session-state"
  }
}
```

Environment overrides:

- `PI_BEADWORK_SHOW_INACTIVE_STATUS`
- `PI_BEADWORK_SESSION_STATE_DIR`
