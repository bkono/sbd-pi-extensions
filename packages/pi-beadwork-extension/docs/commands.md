# Commands and tools

Bare `/bw` opens the dashboard when beadwork is active or available in the repo. All text commands
remain exposed under `/bw ...`. Common flows also have dedicated `/bw:*` aliases.

## Session + workflow commands

| Command | Purpose |
| ------- | ------- |
| `/bw` | Open the dashboard when beadwork is available; text status only when unavailable. |
| `/bw status` / `/bw:status` | Show activation, mode, scope, and counts. |
| `/bw engage [scope]` | Enter interactive mode, optionally scoped to a ticket or epic. |
| `/bw scope <issue-id\|clear>` / `/bw:scope ...` | Retarget or clear interactive scope. |
| `/bw off` / `/bw:off` | Return to neutral mode and queue a group halt. |
| `/bw prime` | Run `bw prime` and show its current guidance. |
| `/bw ready [scope]` / `/bw:ready [scope]` | Show ready work, optionally scoped. |
| `/bw blocked` | List currently blocked work. |
| `/bw run <epic-id>` / `/bw:run ...` | Enter goal mode: inject a prompt; standing appendix is policy. Persistent host only. |
| `/bw abandon` / `/bw:abandon` | Exit goal mode and halt the minion group without closing the epic. |
| `/bw adopt [markdown] [--file path] [--title ...] [--land quick\|branch\|multi] [--apply]` / `/bw:adopt ...` | Turn an explicit markdown plan into a preview or graph-materialization flow. |

## Dashboard controls

Bare `/bw` lands on the ready-first **Issues** tab. Tabs: Issues, Run, Scope.

- `↑/↓` or `j/k` — move through the current issue list
- `enter` — drill into the selected issue
- `backspace` or `h` — back out one breadcrumb level
- `s` / `x` — scope the selected issue or clear scope
- `r` — start `/bw run` for the selected epic (no supervisor-flag modal)
- `tab` / `shift+tab` (or `←` / `→`) — switch tabs
- `esc` / `q` — close the overlay

Live children are minions (`list_minions` / `show_minion` / `/halt`), not a Workers tab.

## Issue-management commands

| Command | Purpose |
| ------- | ------- |
| `/bw list [--all --status ... --type ... --parent ... --priority n --assignee ... --grep ... --limit n --deferred --overdue]` | Filtered issue listing. |
| `/bw history <id> [--limit n]` | Show git-backed issue history. |
| `/bw show <id>` | Show one issue and its children. |
| `/bw create <title> [--type ... --description ... --priority n --parent id]` | Create a task or epic. |
| `/bw update <id> [--title ... --description ... --priority n --assignee ... --status ... --type ... --parent id \| --clear-parent --defer when --due when \| --clear-due]` | Update mutable issue fields. |
| `/bw dep <add \| remove> <blocker-id> [blocks] <blocked-id>` | Add or remove dependency edges. |
| `/bw comment <id> <text> [--author name]` | Add a comment. |
| `/bw label <id> +label [-label]...` | Apply label mutations. |
| `/bw start <id> [--assignee name]` | Run `bw start` for one issue. |
| `/bw close <id> [--reason text]` | Close one issue. |
| `/bw reopen <id>` | Reopen one issue. |
| `/bw defer <id> <when>` | Defer one issue. |
| `/bw undefer <id>` | Restore a deferred issue. |
| `/bw sync` | Run `bw sync`. |

## `/bw run`

```text
/bw run <epic-id>
```

Notes:

- the target must be an **open epic with descendants**
- persistent host (`tui` or `rpc`) required; print/json **error**
- injects a prompt (ids + review policy + refresh/`orchestrate`); does not freeze ready
- standing appendix is policy and does not start a turn
- manager-only: parent owns tickets/reviews; does not implement delegated scope while the child is live
- `--workers`, `--until`, `--max-cycles`, `--dry-run`, `--no-spawn` **error**
- leftover supervisor config **error**
- one goal per parent session; a second epic is rejected until the current goal exits
- children die with Pi; stuck child → `/halt` or process exit
- the parent-model equivalent is `beadwork_start_goal({ epic_id })` — same domain operation, no slash-command synthesis

## `beadwork_start_goal`

```text
beadwork_start_goal({ epic_id: "BW-100" })
```

Parent-only. Call it only after deliberately choosing to execute a ready, already-decomposed open epic. Human `/bw run` and this tool share the same lifecycle. Do not auto-start because an epic exists, becomes ready, or was just created. Do not infer an epic or treat the tool as a synchronous run wrapper.

- same persisted goal/scope/review-policy state and continuation as `/bw run`
- busy parent turns get `followUp` exactly once; the next turn receives the standing run appendix
- same-epic retry resumes/re-arms without changing goal identity or start time
- result vocabulary is `started` / `resumed` plus `queued_follow_up` / `triggered_turn`
- does not dispatch children, mutate tickets, or claim completion

## `/bw adopt`

```text
/bw adopt [markdown-plan] [--file path/to/plan.md] [--title ...] [--land quick|branch|multi] [--apply]
```

- only uses explicit markdown sources
- previews by default
- `quick` does not mutate beadwork
- `branch` applies the graph directly
- `multi` queues an LLM-guided decomposition turn via beadwork tools

`--land` here is plan-adoption shape, not worker merge-back.

## Tool reference

| Tool | Purpose |
| ---- | ------- |
| `beadwork_status` | Activation, mode, counts, scope. |
| `beadwork_prime` | Run `bw prime` and return its current guidance. |
| `beadwork_ready` | Ready issue listing, optionally scoped. |
| `beadwork_blocked` | Blocked issue listing. |
| `beadwork_list_issues` | Filtered issue listing. |
| `beadwork_issue_history` | Git-backed issue history for one issue. |
| `beadwork_show` | Show one issue and its children. |
| `beadwork_create_issue` | Create a task or epic. **Parent only.** |
| `beadwork_update_issue` | Update mutable issue fields. **Parent only.** |
| `beadwork_add_dependency` | Add a dependency edge. **Parent only.** |
| `beadwork_remove_dependency` | Remove a dependency edge. **Parent only.** |
| `beadwork_start_issue` | Start one issue. **Parent only.** |
| `beadwork_close_issue` | Close one issue. **Parent only.** |
| `beadwork_reopen_issue` | Reopen one issue. **Parent only.** |
| `beadwork_comment_issue` | Add a comment. **Parent only.** |
| `beadwork_label_issue` | Apply label mutations. **Parent only.** |
| `beadwork_defer_issue` | Defer one issue. **Parent only.** |
| `beadwork_undefer_issue` | Undefer one issue. **Parent only.** |
| `beadwork_sync` | Run `bw sync`. **Parent only.** |
| `beadwork_start_goal` | Start manager-only goal mode for an explicit open epic and queue the parent continuation. **Parent only.** Does not implement the epic or dispatch children. |

Child inspection allowlist (spawn and orchestrate): `beadwork_show`, `beadwork_list_issues`,
`beadwork_issue_history`, `beadwork_ready`, `beadwork_blocked`, `beadwork_status`,
`beadwork_prime`.

Background work: minions `orchestrate`. Foreground wait: minions `spawn`.

## Operator-facing truths

- `/bw run` injects a prompt; the appendix does not start a turn
- child settlement is evidence, not acceptance
- shared-checkout coordination is advisory
- quality commands are not a beadwork close gate
- removed supervisor flags/tools/config are errors or absent, not silently ignored

## Removed / Migration

`/bw delegate`, `/bw workers`, `/bw land`, `/bw cancel`, and `/bw cleanup` are not registered.
See [migration.md](./migration.md).
