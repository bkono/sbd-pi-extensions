# @solvedbydev/pi-beadwork-extension

A [pi coding-agent](https://github.com/badlogic/pi-mono) extension for beadwork-aware session engagement and orchestration.

## Current milestone

This package currently implements the first installable milestone:

- beadwork activation detection
- persisted session mode/scope state
- `/bw status`
- `/bw off`
- lightweight statusline updates

Future milestones will add:

- `/bw engage`
- `/bw adopt`
- `/bw run`
- typed beadwork CLI adapters
- tmux-backed worker orchestration

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
