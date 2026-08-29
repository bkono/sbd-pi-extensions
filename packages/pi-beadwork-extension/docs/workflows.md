# Workflows

This extension is a **beadwork goal adapter**. You drive planning and ticket operations. In run
mode the parent Pi session orchestrates in-process minions. Enable `@solvedbydev/pi-minions` on
the same tui/rpc host.

The important split:

- you (and the parent model) own beadwork graph mutations
- minions `orchestrate` runs children in the background; `spawn` still blocks
- children inspect beadwork; they do not close tickets
- shared checkout is default; coordination is advisory
- quality commands are implementer/reviewer/repo-checkpoint work

## Session modes

Persisted session state:

- `neutral` — no beadwork workflow is engaged
- `interactive` — human-led beadwork; standing appendix is policy; wait for the user
- `run` — goal mode for one epic; standing appendix is policy; `/bw run` injects the start prompt

Typical dashboard-first flow:

```text
/bw
/bw status
/bw run <epic-id>
```

What that gives you:

- bare `/bw` opens the dashboard when beadwork is available
- the default **Issues** tab starts with the `ready` filter
- from Issues, `s` scopes, `x` clears, `r` starts goal mode for an epic
- `tab` / `shift+tab` (or `←` / `→`) moves between Issues, Run, and Scope

Use `/bw engage [scope]` or `/bw:scope <issue-id>` to jump straight into a text-command scope.
Use `/bw abandon` to leave goal mode without closing the epic. Use `/bw off` to return to
neutral.

## Planning and `/bw adopt`

`/bw adopt` uses an **explicit markdown source**. It does not scrape chat history.

Supported sources:

- inline markdown passed directly to `/bw adopt`
- `--file path/to/plan.md`
- markdown currently open in the editor

Preview first:

```text
/bw adopt --file docs/plan.md --title "Goal-mode cutover" --land multi
```

Apply after review:

```text
/bw adopt --file docs/plan.md --title "Goal-mode cutover" --land multi --apply
```

Land modes (plan adoption, not worker merge-back):

- `quick` — preview only; no beadwork mutations
- `branch` — create beadwork artifacts directly from the explicit plan
- `multi` — queue an LLM-guided decomposition turn that materializes the epic/tasks/dependencies
  through beadwork tools

Use `multi` when the markdown describes intent but the graph still benefits from model
decomposition.

## `/bw run` goal mode

```text
/bw run sbdpi-vur.4
```

Requires:

- persistent host (`tui` or `rpc`) — print/json **error**
- beadwork active
- an open epic with traversable descendants
- no leftover supervisor config (those **error**)
- no `--workers` / `--until` / `--max-cycles` / `--dry-run` / `--no-spawn` (those **error**)
- minions enabled so `orchestrate` exists

What it does:

1. stores one v1 goal (`scopeIds: [epic]`, configured `review.policy`)
2. **injects a prompt** with epic id/title, review policy, and “refresh `bw` then `orchestrate`”
3. does **not** freeze a ready list
4. standing appendix stays armed as policy for later turns — it does not start a turn

If the parent is mid-turn, the inject is follow-up. If idle, it triggers a turn.

Same epic again re-injects that prompt. A different epic is rejected until the current goal exits.
Goal mode exits when the scoped epic is closed via beadwork tools, when you `/bw abandon`
(halt the group, leave the epic open), or when you `/bw off`.

Disk `mode=run` after `/new` or process death is interrupted, not auto-resumed. Run `/bw run`
again.

### Parent loop (model)

When a turn runs:

1. refresh `bw ready` / `bw show`
2. `beadwork_start_issue` on work about to begin
3. compose each child’s complete `task` (beadwork does not wrap it)
4. `orchestrate` with domain `{ source: "beadwork", scopeId, workItemId, title }` and a `taskType`
5. on settlement: judge evidence; apply review policy; parent closes

`orchestrate` `accepted` means starting, not liveness. Do not poll.

### Review

- `ticket` (default): independent `reviewImplementation` before close
- `scope`: close from evidence; `reviewScope` before epic complete; dependents may start first
- `none`: no independent review children

Disposition findings as fix | file | reject by judgment. No keyword classifier.

Do not start review of ticket A while A’s implementer is still live. That is an instruction, not
a lock. Reviewer tasks should name commits, the ticket id, and `git show` — not “read the whole
dirty workspace.”

### Quality

Tell implementers (and reviewers, if useful) to run the repo’s `lint` / `test` / `typecheck`.
Beadwork does not own a validation gate.

## Lifetime and stuck children

Children die with Pi. `/halt <id|all>` aborts live minions. If a child is still stuck, exit the
parent process. Halt alone does not exit goal mode.

Inspect with `list_minions` / `show_minion`, not a worker registry.

## Shared checkout

Default cwd is the parent checkout. Overlap notices are advisory. See
[worker-conventions.md](./worker-conventions.md).

## Interactive mode

`/bw engage` is human-led. The appendix tells the model not to autonomously launch children.
Use run mode when you want the parent to orchestrate the epic.
