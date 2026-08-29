# @solvedbydev/pi-beadwork-extension

A [pi coding-agent](https://github.com/badlogic/pi-mono) extension that makes pi beadwork-aware for
human-led planning, ticket operations, explicit plan adoption, and **goal-mode epic runs**.

Child execution is **in-process minions**, not tmux. Enable
[`@solvedbydev/pi-minions`](../pi-minions/README.md) in the same parent Pi session. `/bw run`
injects a prompt; the standing appendix is policy only.

## Status

Use this package for:

- human-led beadwork sessions (`/bw engage`, dashboard, ticket tools)
- explicit markdown-plan adoption (`/bw adopt`)
- `/bw run <epic-id>` goal mode on a persistent Pi host (`tui` or `rpc`)

Truths to keep in mind:

- `/bw run` **injects a prompt** that asks the parent to refresh `bw` and `orchestrate`. It does
  not start a polling supervisor or freeze a ready list.
- The standing beadwork appendix is **policy**. It does not start a turn.
- Children are **process-local**. They die with the parent Pi process. A stuck child may require
  `/halt` or process exit. There is no daemon and no restart recovery.
- Shared checkout is the default. Coordination (path intent, overlap notices) is **advisory** —
  warn and suggest communication; never lock, pause, or isolate.
- Removed supervisor flags, leftover config, and leftover env vars are **errors**, not ignored.
- There is **no** `landing.validateCommands` gate. Quality commands (`lint` / `test` /
  `typecheck`, or whatever the repo uses) are implementer, reviewer, and repo-checkpoint work.
- Review policy is `ticket` (default), `scope`, or `none`.
- Minions `orchestrate` is the background API. `spawn` still blocks.
- Inspection beadwork tools only on children. The parent mutates tickets (start, close, comment).

## Install

Register **both** extensions. `/bw run` needs minions `orchestrate` on a live `tui`/`rpc` process.

### Workspace dependency

```json
{
  "dependencies": {
    "@solvedbydev/pi-beadwork-extension": "*",
    "@solvedbydev/pi-minions": "*"
  }
}
```

### Register with pi

Add both entrypoints to `settings.json` (global `getAgentDir()/settings.json`, or
`<repo>/.pi/settings.json`):

```json
{
  "extensions": [
    "/path/to/sbd-pi-extensions/packages/pi-minions/src/index.ts",
    "/path/to/sbd-pi-extensions/packages/pi-beadwork-extension/src/index.ts"
  ]
}
```

Start **tui** (not `--print` / json):

```text
pi
```

`/bw run` and `orchestrate` are rejected in print and json hosts.

## Quickstart: `/bw run` an epic

### 1. Confirm beadwork is active

```text
/bw
/bw status
```

- bare `/bw` opens the dashboard when beadwork is active or available
- the default **Issues** tab is ready-first
- `tab` / `shift+tab` (or `←` / `→`) move between Issues, Run, and Scope
- `s` scopes the selected issue, `x` clears scope
- `r` on an epic starts goal mode (same as `/bw run <epic-id>`)

Or scope from text:

```text
/bw engage sbdpi-vur.4
/bw:scope sbdpi-vur.4
```

### 2. Inspect the graph

```text
/bw ready
/bw show sbdpi-vur.4
```

`/bw run` requires an **open epic with descendants**.

### 3. Start goal mode

```text
/bw run sbdpi-vur.4
```

What happens:

1. the extension stores one v1 goal (that epic + the configured review policy)
2. it injects a prompt: identifiers, policy, “refresh `bw` and `orchestrate`”
3. if the parent is idle, that prompt starts a turn; if busy, it is delivered as follow-up
4. the standing appendix stays armed as policy for later turns
5. the parent starts ready work, composes each child’s `task`, and calls minions `orchestrate`

Do **not** pass `--workers`, `--until`, `--max-cycles`, `--dry-run`, or `--no-spawn`. Those flags
error.

Stay in the tui session. Children live in this Pi process.

### 4. What you should see

- Goal mode notify: `Goal mode started for <epic>. The parent was asked to orchestrate.`
- Parent uses `orchestrate` (returns handles immediately; `accepted` means **starting**, not live)
- Inspect children with minions `list_minions` / `show_minion` (or `/minions`, `/halt`)
- Child settlement is **evidence**, not acceptance. The parent closes tickets after it judges.

When the scoped epic is closed through beadwork tools, goal mode exits. `/bw abandon` exits goal
mode and queues a group halt without closing the epic. `/bw off` returns the session to
neutral. There is no tmux pane to inspect.

## Review policy

Set in `<repo>/.pi/beadwork-config.json` or `~/.pi/beadwork-config.json`:

```json
{
  "review": {
    "policy": "ticket"
  }
}
```

| Policy   | Meaning |
| -------- | ------- |
| `ticket` | Default. Independent `reviewImplementation` child before closing that ticket. Do not close from implementer settlement alone. |
| `scope`  | Close individual tickets from evidence. Launch `reviewScope` before declaring the epic complete. Dependents may start before aggregate review finds a problem. |
| `none`   | Skip independent review children. Still judge from git and `bw` before close. |

Environment: `PI_BEADWORK_REVIEW_POLICY=ticket|scope|none`.

On settle of `reviewImplementation`, the parent dispositions every finding as **fix** | **file** |
**reject** by judgment (no keyword classifier). Fix is blocking; file is a durable nonblocking
follow-up unless the user waives a blocker; reject records why.

Optional `review.provider` / `review.model` are stored preferences only. They are not a landing
reviewer gate and do not auto-launch children. Pass `model` on `orchestrate` when a child should
use a specific model.

## Shared checkout

Children share the parent cwd/branch unless you pass an **already existing** `cwd` when the
orchestration group is created. The runtime never creates worktrees, switches branches, or lands
isolated checkouts.

Coordination is advisory:

- include the ticket id in commit messages
- commit exact paths; avoid `git add -A`, `git add .`, and `git commit -a`
- do not stash, reset, clean, or discard unrelated checkout state
- overlap notices warn; they do not pause or lock

See [docs/worker-conventions.md](./docs/worker-conventions.md).

## Lifetime

- children are in-process Pi sessions owned by minions
- parent exit, `/new`, or process death disposes children
- leftover disk `mode=run` is **interrupted**, not auto-resumed — run `/bw run <epic-id>` again
- `/bw abandon` exits goal mode and queues `/halt group`; the epic stays open
- a stuck child: `/halt <id|all>`. If that is not enough, exit the parent Pi process
- one goal and one open orchestration group per parent session

## Quality commands

Project `lint` / `test` / `typecheck` (or the repo’s equivalent) belong in the implementer task,
the reviewer task, or a later repo checkpoint. Beadwork does not run them as a close gate.
Do not put `landing.validateCommands` in config; that family is rejected.

## Recommended config

Resolution order:

1. environment variables
2. `<repo>/.pi/beadwork-config.json`
3. `~/.pi/beadwork-config.json`
4. built-in defaults

```json
{
  "ui": {
    "showInactiveStatus": false
  },
  "storage": {
    "sessionStateDir": ".pi/beadwork/session-state"
  },
  "review": {
    "policy": "ticket"
  }
}
```

`/bw run` **errors** if leftover supervisor config is present (`tmux`, `worktrees`, `landing`,
`supervisor`, `workerExecution`, `run.defaultWorkers`, …). Remove those keys. See
[docs/migration.md](./docs/migration.md) and [docs/configuration.md](./docs/configuration.md).

## Command overview

Core human workflow:

- `/bw` — dashboard (Issues / Run / Scope)
- `/bw status`
- `/bw engage [scope]`
- `/bw ready [scope]`
- `/bw show <id>`
- `/bw adopt [markdown] [--file path] [--title ...] [--land quick|branch|multi] [--apply]`
- `/bw run <epic-id>`
- `/bw abandon` — exit goal mode and halt the minion group; does not close the epic
- `/bw off`

Issue-management coverage: `blocked`, `list`, `history`, `create`, `update`, `dep`, `comment`,
`label`, `start`, `close`, `reopen`, `defer`, `undefer`, `sync`.

Dedicated aliases such as `/bw:status`, `/bw:scope`, `/bw:run`, `/bw:abandon`, `/bw:off`, and
`/bw:adopt` stay registered.

Full reference: [docs/commands.md](./docs/commands.md).

## Docs

- [docs/README.md](./docs/README.md) — docs index
- [docs/workflows.md](./docs/workflows.md) — dashboard-first operator flow, `/bw run`, review, checkout
- [docs/configuration.md](./docs/configuration.md) — config keys and environment variables
- [docs/migration.md](./docs/migration.md) — removed tmux workers, flags, tools, and leftover config
- [docs/commands.md](./docs/commands.md) — slash commands, dashboard controls, tool surface
- [docs/worker-conventions.md](./docs/worker-conventions.md) — shared-checkout attribution habits

## Tool surface

Parent beadwork tools (inspection **and** mutation):

- status / prime / ready / blocked / list / show / history
- create / update / dependency add-remove
- start / close / reopen / comment / label / defer / undefer / sync

Children spawned or orchestrated by minions get **inspection only**: `beadwork_show`,
`beadwork_list_issues`, `beadwork_issue_history`, `beadwork_ready`, `beadwork_blocked`,
`beadwork_status`, `beadwork_prime`. They do not get start/close/create/comment. The parent
mutates tickets after it judges evidence.

Deleted for everyone: `beadwork_delegate`, `beadwork_worker_done`, `beadwork_land_worker`,
`beadwork_worker_check`.

Background work uses minions `orchestrate`. Foreground `spawn` still blocks until the child
finishes.

## Removed / Migration

tmux-backed `/bw delegate` workers, worktree landing, and the bounded `--workers` run loop are
**gone**. They are not a fallback.

| Removed | What to use |
| ------- | ----------- |
| `/bw delegate`, tmux panes, `beadwork_delegate` | `/bw run <epic>` + minions `orchestrate` |
| `/bw run --workers/--until/--max-cycles/--dry-run/--no-spawn` | `/bw run <epic-id>` only (flags error) |
| `landing.validateCommands`, reviewer landing gate | implementer/reviewer/repo-checkpoint commands |
| `workerExecution.mode` worktree/current-branch | shared parent checkout; existing `cwd` only at group create |
| `/bw workers`, `/bw land`, `/bw cancel` | `list_minions` / `show_minion` / `/halt` |

See [docs/migration.md](./docs/migration.md).
