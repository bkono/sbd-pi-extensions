# @solvedbydev/pi-minions

A Solved By Dev fork/port of the MIT-licensed [`pi-minions`](https://github.com/kalindudc/pi-minions)
extension.

Two execution APIs:

- **`spawn`** — foreground. Blocks the parent turn until the child finishes. Not in an
  orchestration group. Does not emit parent lifecycle packets.
- **`orchestrate`** — background. Registers children and returns handles immediately.
  Persistent hosts only (`tui` / `rpc`). Results arrive later as coalesced parent packets.

Children are **process-local**. They die with the parent Pi process. A stuck child may require
`/halt` or process exit. There is no detached execution, restart recovery, or orchestration
journal.

For Beadwork epic runs, enable this extension alongside
[`@solvedbydev/pi-beadwork-extension`](../pi-beadwork-extension/README.md) and use `/bw run <epic>`
on tui. Beadwork injects the goal prompt; this package owns live child sessions.

## Tools

| Tool | Behavior |
| ---- | -------- |
| `spawn` | One foreground minion, or `tasks` for parallel foreground minions. **Blocks.** |
| `orchestrate` | Register background work. Returns `{ groupId, accepted, rejected }`. `accepted[].state` is `"starting"` — registered, not liveness. |
| `list_agents` / `list_minion_types` | Discover named agent/minion definitions. |
| `list_minions` / `show_minion` | Inspect spawn and orchestrated state (role, taskType, group, output, messages, path intent). |
| `halt` | Abort one minion, an orchestration group, or all. Halt group forgets the open group. Also `/halt <id\|name\|group\|all>`. |
| `learn_minions` | Concise usage guidance. |

Slash commands: `/spawn`, `/minions`, `/halt`.

### `orchestrate` vs `spawn`

Use `orchestrate` when the parent must keep talking to the user or continue an epic unattended.
Use `spawn` when you intend to wait.

`orchestrate` requires a persistent host. It is rejected in print and json.

Each orchestrated task needs:

- `task` — complete child prompt. The caller supplies it; minions does not wrap it.
- `description` — required short fleet-readable summary. Do not infer from `task`.
- optional `role` — open agent/template name (same loader as spawn `agent`)
- optional `taskType` — closed: `implementation`, `fix`, `reviewImplementation`,
  `reviewScope`, `investigateBlocker`. Selects parent nudge text. Omit for untyped work.
- optional `model`
- optional `domain` — opaque `{ source, scopeId, workItemId, title }`. Minions stores and
  echoes; it does not interpret tickets. Beadwork uses `source: "beadwork"`.

One **open group** per parent session. Omit `groupId` to create it (or join the open group).
A second group is rejected. `cwd` is group-create only, must already exist, and cannot change
later. Default: parent cwd. The runtime never creates worktrees.

### Child tools

Every child (spawn and orchestrate) gets Beadwork **inspection** tools if the parent loaded
beadwork:

`beadwork_show`, `beadwork_list_issues`, `beadwork_issue_history`, `beadwork_ready`,
`beadwork_blocked`, `beadwork_status`, `beadwork_prime`.

Children do **not** get start / close / reopen / create / update / comment / label / deps /
`beadwork_sync`. The parent mutates tickets.

Minions is not loaded inside children. Orchestrated children may receive bound comm tools from
the parent; spawn children do not.

### Lifetime

- `session_shutdown` / `/new` / parent process exit disposes children
- `/halt` aborts live children; it does not by itself exit Beadwork goal mode
- if a child is stuck after halt, exit the parent Pi process
- shared-checkout overlap is advisory (warn, do not lock)

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

Global settings come from `getAgentDir()/settings.json`; project settings in `<cwd>/.pi/settings.json`
override them.

Delegation reminders are injected into the system prompt, never as synthetic user messages. The
`acknowledgementRequired` setting is kept for backward compatibility but no longer adds mandatory
acknowledgement text; custom `message` values are used verbatim.

## Beadwork pairing

On tui with both extensions enabled:

```text
/bw run EPIC_ID
```

Beadwork injects a goal prompt. The parent should `orchestrate` ready work with domain metadata.
Do not use tmux, `/bw delegate`, or `spawn` as the epic runtime. `spawn` remains valid for
foreground one-off waits outside that loop.
