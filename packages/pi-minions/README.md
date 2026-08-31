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
or `beadwork_start_goal({ epic_id })` on tui. Beadwork injects the manager-only goal prompt; this
package owns live child sessions.

## Tools

| Tool | Behavior |
| ---- | -------- |
| `spawn` | One foreground minion, or `tasks` for parallel foreground minions. **Blocks.** |
| `orchestrate` | Register background work. Returns `{ groupId, accepted, rejected }`. `accepted[].state` is `"starting"` — registered, not liveness. |
| `list_agents` / `list_minion_types` | Discover named agent/minion definitions. |
| `list_minions` / `show_minion` | Inspect spawn and orchestrated state (agent, taskType, group, output, messages, path intent). |
| `halt` | Abort one minion, an orchestration group, or all. Halt group forgets the open group. Also `/halt <id\|name\|group\|all>`. |
| `learn_minions` | Concise usage guidance. |

Slash commands: `/spawn`, `/minions`, `/halt`.

### `orchestrate` vs `spawn`

Use `orchestrate` when the parent must keep talking to the user or continue an epic unattended.
Use `spawn` when you intend to wait.

`orchestrate` requires a persistent host. It is rejected in print and json.

### Cooperative sidecar

Use `orchestrate` only for slices independent of the parent's continuing work. Once scope is
delegated, the parent must not edit that delegated scope while the child is live; message or halt
the child instead. The parent may continue user interaction, inspection, planning, or
non-overlapping work.

Path intent and overlap notices are advisory, not locks. A parent turn ending while children run
is normal. Do not represent delegated work as complete while children are live.

Each orchestrated task needs:

- `task` — complete child prompt. The caller supplies it; minions does not wrap it.
- `description` — required short fleet-readable summary. Do not infer from `task`.
- optional `agent` — discovered agent/template name (same loader as spawn). Built-in
  `worker` and `investigate` are always available; user/project definitions override them.
  Call `list_agents` if unsure. Not a closed enum.
- optional `taskType` — closed: `implementation`, `fix`, `reviewImplementation`,
  `reviewScope`, `investigateBlocker`. Selects parent nudge text. Omit for untyped work.
  Never collapse agent and taskType.
- optional `model`
- optional `domain` — opaque `{ source, scopeId, workItemId, title }`. Minions stores and
  echoes; it does not interpret tickets or enforce `workItemId` uniqueness. Multiple live children
  may intentionally share one work item id. Beadwork uses `source: "beadwork"`.

One **open group** per parent session. Omit `groupId` to create it (or join the open group).
A second group is rejected. `cwd` is group-create only, must already exist, and cannot change
later. Default: parent cwd. The runtime never creates worktrees.

### Agent discovery and migration

`agent` is the only named-agent selector for both `spawn` and `orchestrate`. It is a discovered
agent/template name; it is independent from the closed `taskType` workflow-policy field. Discovery
merges layers in this order, with later definitions winning:

1. package built-ins
2. user definitions under Pi/agent minion directories
3. project definitions under `.pi/agents`, `.pi/minions`, `.agents/agents`, or `.agents/minions`

The package always supplies `worker` (routine scoped implementation, medium thinking) and
`investigate` (evidence-first investigation, high thinking). Neither pins a provider or model.
Project `worker` overrides user `worker`, which overrides the built-in.

**Migration:** replace `orchestrate.tasks[].role` with `orchestrate.tasks[].agent`. `role` was removed,
not retained as an alias. Do not move semantic workflow values into `agent`; keep values such as
`reviewImplementation` in `taskType`.

### Registration, liveness, activity, and settlement

These are separate boundaries:

1. `orchestrate` returns `accepted[].state: "starting"` after registration. The tree state is pending.
2. A child becomes running only after its live session handle exists. The internal `started` event does
   not wake the parent model.
3. Trusted runtime events project `starting`, `thinking`, `tool`, and `settling` activity. Turn count
   is metadata, not the displayed activity.
4. Settlement means the child is fully idle, including accepted parent-to-child mail. A
   child-to-parent notification does not park the child or wait for a reply. Settlement is evidence,
   not acceptance.

While children are pending/running, a persistent fleet widget appears above the editor without taking
focus. It shows a bounded activity summary and clears after the final active child. `/minions` remains
the interactive drill-down; `list_minions` and `show_minion` are the model inspection surfaces.

Real lifecycle events produce bounded, coalesced parent packets. A final active-to-idle transition adds
one `Group idle` boundary telling the parent to inspect evidence and decide the next action. Idle does
not mean success, ticket closure, or goal completion. Spawn children never appear in orchestrated group
packets. There are no heartbeat/progress wakes. Static `orchestrate` guidance defines the live-work
invariant; runtime truth comes from registration/results, lifecycle packets, inspection, and halt—not
dynamic system-prompt state.

### Child tools

Every child (spawn and orchestrate) gets Beadwork **inspection** tools if the parent loaded
beadwork:

`beadwork_show`, `beadwork_list_issues`, `beadwork_issue_history`, `beadwork_ready`,
`beadwork_blocked`, `beadwork_status`, `beadwork_prime`.

Children do **not** get start / close / reopen / create / update / comment / label / deps /
`beadwork_sync`. The parent mutates tickets.

Minions is not loaded inside children. Orchestrated children may receive bound comm tools from
the parent; spawn children do not. `send_minion_peer` is a nonblocking notification: sending to the
parent may wake it through a lifecycle packet, but does not park the child, require a reply, or delay
ordinary settlement. Path-intent announcements keep pairwise overlap evidence but coalesce live overlap
notices to one delivery per peer per announcement.

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
default reminder mentions both `spawn` (wait) and `orchestrate` (background). The
`acknowledgementRequired` setting is kept for backward compatibility but no longer adds mandatory
acknowledgement text; custom `message` values are used verbatim.

## Beadwork pairing

On tui with both extensions enabled:

```text
/bw run EPIC_ID
```

Beadwork injects a manager-only goal prompt. The parent should `orchestrate` ready work with
domain metadata and must not implement a delegated ticket concurrently with its live child.
Do not use tmux, `/bw delegate`, or `spawn` as the epic runtime. `spawn` remains valid for
foreground one-off waits outside that loop.
