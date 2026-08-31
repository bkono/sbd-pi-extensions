# Removed / Migration

Beadwork no longer launches tmux workers. There is no tmux fallback.

Child execution is in-process minions (`orchestrate`) on a persistent Pi host. `/bw run <epic-id>`
injects a prompt; the standing appendix is policy. Shared checkout is default and coordination is
advisory. Quality commands are implementer/reviewer/repo-checkpoint work — there is no
`landing.validateCommands` gate.

Operator README: [../README.md](../README.md). Minions: [../../pi-minions/README.md](../../pi-minions/README.md).

## What replaced what

| Old (removed) | Now |
| ------------- | --- |
| tmux pane + `tmux.workerCommand` | minions child session in the parent Pi process |
| `/bw delegate <ticket>` | parent `orchestrate`s that ticket during `/bw run` (or interactive tools; no dedicated launch command) |
| `/bw run --workers N --until … --max-cycles …` | `/bw run <epic-id>` only. Flags **error**. |
| polling supervisor / `supervisor.pollIntervalMs` | coalesced parent packets from minions; standing appendix does not poll |
| `landing.policy` auto/deferred, `/bw land` | parent judges evidence and closes tickets; no merge-back orchestrator |
| `landing.validateCommands` | implementer/reviewer/repo-checkpoint commands in the child `task` or later CI |
| `landing.review` / `workerExecution.review` gates | review policy `ticket` \| `scope` \| `none` plus independent review children |
| `workerExecution.mode` current-branch/worktree | shared parent cwd; existing `cwd` only at group create |
| `/bw workers`, worker registry, `worker.log` | `list_minions` / `show_minion` |
| `/bw cancel` | `/halt <id\|all>` |
| `beadwork_delegate`, `beadwork_worker_done`, `beadwork_land_worker`, `beadwork_worker_check` | not registered. Use beadwork issue tools + minions `orchestrate`/`halt` |

## `orchestrate.role` was removed

Minions now uses the canonical `agent` selector on both foreground `spawn` and background
`orchestrate` tasks:

```diff
-{ "role": "worker", "taskType": "implementation" }
+{ "agent": "worker", "taskType": "implementation" }
```

There is no `role` compatibility alias. `agent` names a discovered template; `taskType` remains the
separate closed workflow-policy selector. Built-in `worker` and `investigate` definitions are the
lowest-precedence layer. User definitions override built-ins and project definitions override users.
Call `list_agents` to inspect the effective source and definition.

## Removed `/bw run` flags

These error (not ignored):

```text
--workers
--until
--max-cycles / --maxCycles
--no-spawn / --noSpawn
--dry-run / --dryRun
```

Usage is only:

```text
/bw run <epic-id>
```

Print/json hosts also error: `/bw run requires a persistent Pi host (tui or rpc)`.

## Leftover config is an error

If `.pi/beadwork-config.json` or `~/.pi/beadwork-config.json` still contains `tmux`, `worktrees`,
`landing`, `supervisor`, `workerExecution`, or `run.defaultWorkers` / `pollIntervalMs` / …, `/bw run`
refuses with a list of keys. Same for leftover `PI_BEADWORK_WORKER_*` / `PI_BEADWORK_TMUX_*` /
`PI_BEADWORK_LANDING_*` env vars.

Delete those families. Keep:

```json
{
  "ui": { "showInactiveStatus": false },
  "storage": { "sessionStateDir": ".pi/beadwork/session-state" },
  "review": { "policy": "ticket" }
}
```

Do **not** copy `landing.validateCommands` into a new beadwork validation key. Quality stays in
the implementer/reviewer `task` or a repo checkpoint.

## Removed tools

These tools are gone for parent and children:

- `beadwork_delegate`
- `beadwork_worker_done`
- `beadwork_land_worker`
- `beadwork_worker_check`

Children also cannot use parent mutation tools (`beadwork_start_issue`, `beadwork_close_issue`,
`beadwork_comment_issue`, …). Inspection only. Shell `bw close` from a child is still possible;
the parent refreshes `bw` before acceptance.

## Lifetime (was tmux pane)

Old workers could outlive a confused parent pane. New children cannot: they die with Pi.

- parent exit / `/new` / process death → children disposed
- leftover `mode=run` on disk is interrupted, not auto-resumed
- stuck child: `/halt`, then exit the parent process if needed

## Shared checkout (was worktree isolation)

The runtime does not create worktrees. Two children on one branch is the same class of risk as two
humans on one branch. Path intent and overlap notices are advisory. Commit exact paths; never
stash/reset/clean unrelated state. See [worker-conventions.md](./worker-conventions.md).

## Leftover slash aliases

`/bw:delegate`, `/bw:workers`, `/bw:land`, `/bw:cancel`, and `/bw:cleanup` are not registered.
They do not autocomplete and they do not launch tmux workers. Use `/bw run`, minions
inspect/halt, and beadwork issue commands.

## tmux worker launch (historical)

Previously, `/bw delegate <ticket-id>` prepared a worktree or current-branch checkout and launched
a tmux-backed `pi --mode json` worker; `/bw run --workers N` looped that launcher over `bw ready`.
That path, `src/tmux.ts`, the worker registry, and landing/merge-back are deleted. Do not
reintroduce tmux as a fallback.
