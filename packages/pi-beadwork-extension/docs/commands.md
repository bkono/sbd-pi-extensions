# Commands and tools

## Slash command reference

All commands are exposed under `/bw`.

## Session + workflow commands

| Command | Purpose |
| --- | --- |
| `/bw status` | Show activation, mode, scope, counts, and worker summary. |
| `/bw engage [scope]` | Enter beadwork interactive mode, optionally scoped to a ticket or epic. |
| `/bw off [--stop-workers] [--all-workers] [--leave-workers]` | Return to neutral mode and optionally stop active workers. |
| `/bw prime [--refresh]` | Show cached or refreshed `bw prime` guidance. |
| `/bw ready [scope]` | Show ready work, optionally scoped. |
| `/bw blocked` | List currently blocked work. |
| `/bw workers [epic-id]` | Show delegated worker diagnostics and next actions. |
| `/bw delegate <ticket-id> [--model provider/model]` | Launch one ticket into a tmux-backed delegated worker, optionally with a one-off worker model override. |
| `/bw land <ticket-id|worker-id>` | Resume merge-back for a deferred worker. |
| `/bw run <epic-id> [--workers n] [--until blocked|empty] [--max-cycles n] [--dry-run] [--no-spawn]` | Run bounded orchestration over an epic. |
| `/bw adopt [markdown] [--file path] [--title ...] [--land quick|branch|multi] [--apply]` | Turn an explicit markdown plan into a beadwork-aware preview or graph-materialization flow. |

## Issue-management commands

| Command | Purpose |
| --- | --- |
| `/bw list [--all --status ... --type ... --parent ... --priority n --assignee ... --grep ... --limit n --deferred --overdue]` | Filtered issue listing. |
| `/bw history <id> [--limit n]` | Show git-backed issue history. |
| `/bw show <id>` | Show one issue and its children. |
| `/bw create <title> [--type ... --description ... --priority n --parent id]` | Create a task or epic. |
| `/bw update <id> [--title ... --description ... --priority n --assignee ... --status ... --type ... --parent id \| --clear-parent --defer when --due when \| --clear-due]` | Update mutable issue fields. |
| `/bw dep <add|remove> <blocker-id> [blocks] <blocked-id>` | Add or remove dependency edges. |
| `/bw comment <id> <text> [--author name]` | Add a comment. |
| `/bw label <id> +label [-label]...` | Apply label mutations. |
| `/bw start <id> [--assignee name]` | Run `bw start` for one issue. |
| `/bw close <id> [--reason text]` | Close one issue. |
| `/bw reopen <id>` | Reopen one issue. |
| `/bw defer <id> <when>` | Defer one issue. |
| `/bw undefer <id>` | Restore a deferred issue. |
| `/bw sync` | Run `bw sync`. |

## `/bw delegate`

Usage:

```text
/bw delegate <ticket-id>
/bw delegate <ticket-id> --model cursor/composer-2
```

Notes:

- `--model provider/model` only affects that delegated worker launch
- repo/global `tmux.workerProvider` and `tmux.workerModel` defaults are left unchanged
- reviewer fallback still follows the launched worker when dedicated reviewer settings are not set

What it does:

- creates or reuses the ticket worktree
- applies worktree bootstrap config
- launches the worker in tmux without stealing operator focus
- records registry + runtime state
- tracks the worker in the parent session for later notifications

The launch notice includes:

- worker ID
- worktree path
- `worker.log` path
- supervisor cadence
- whether completion means automatic landing or deferred hold

## `/bw workers`

Usage:

```text
/bw workers
/bw workers <epic-id>
```

Each worker entry shows:

- worker/ticket identity
- tmux pane
- ticket status
- validation summary
- review summary
- landing summary
- cleanup summary
- `Next:` operator guidance

## `/bw land`

Usage:

```text
/bw land <ticket-id|worker-id>
```

This is primarily for `landing.policy: "deferred"`.

The command:

- locates the held worker
- re-enters orchestrator merge-back logic
- refreshes/rebases if needed
- returns updated inspection output

## `/bw run`

Usage:

```text
/bw run <epic-id> [--workers n] [--until blocked|empty] [--max-cycles n] [--dry-run] [--no-spawn]
```

Notes:

- the target must be an epic
- `--dry-run` evaluates the queue without persisting run mode
- `--no-spawn` lets you inspect behavior without starting new workers
- background continuation is session-local, not daemonized

## `/bw adopt`

Usage:

```text
/bw adopt [markdown-plan] [--file path/to/plan.md] [--title ...] [--land quick|branch|multi] [--apply]
```

Important behavior:

- only uses explicit markdown sources
- previews by default
- `quick` does not mutate beadwork
- `branch` applies the graph directly
- `multi` queues an LLM-guided decomposition turn that materializes beadwork artifacts via tools

## Worker state reference

### Runtime `status`

| Status | Meaning |
| --- | --- |
| `launching` | Worker process is being created. |
| `running` | Worker process is still alive. |
| `exited` | Worker finished, but landing is not complete yet. |
| `held` | Deferred landing intentionally stopped before merge-back. |
| `landed` | Parent branch contains the worker head and post-worker checks passed. |
| `failed` | Worker process failed outright. |
| `attention` | Operator action is required before the worker can finish landing. |

### Validation states

| State | Meaning |
| --- | --- |
| `not-run` | Validation has not started yet. |
| `pending` | Validation is in progress or still unresolved. |
| `passed` | Validation succeeded. |
| `failed` | Validation failed. |

### Review states

| State | Meaning |
| --- | --- |
| `not-run` | Reviewer gating is disabled or has not started yet. |
| `pending` | Review is still pending. |
| `approved` | Reviewer approved. |
| `nits-only` | Reviewer approved with non-blocking nits. |
| `changes-requested` | Reviewer requested valid in-scope changes. |
| `remediation-in-progress` | Reviewer-driven remediation is running. |
| `review-blocked` | Review could not reach a mergeable state without operator help. |

Reviewer verdicts are normalized to:

- `approve`
- `approve-with-nits`
- `request-changes`

### Landing states from worker inspection

| State | Meaning |
| --- | --- |
| `waiting-ticket-close` | Ticket is not closed yet, so landing work cannot start. |
| `verified` | Landing has been verified against the parent branch. |
| `validated-and-held` | Deferred mode validated the work and intentionally held it. |
| `ready-to-land` | Deferred mode held the work and it is currently merge-ready. |
| `needs-refresh` | Deferred work drifted and must be refreshed before merge-back. |
| `pending-review` | Ticket is closed, but landing/review details are still pending. |
| `verification-failed` | Landing verification failed. |
| `needs-attention` | Operator attention is required. |

## Tool reference

The extension also exposes beadwork-aware tools to the model.

| Tool | Purpose |
| --- | --- |
| `beadwork_status` | Activation, mode, counts, scope, and worker summary. |
| `beadwork_prime` | Cached or refreshed `bw prime` guidance. |
| `beadwork_ready` | Ready issue listing, optionally scoped. |
| `beadwork_blocked` | Blocked issue listing. |
| `beadwork_list_issues` | Filtered issue listing. |
| `beadwork_issue_history` | Git-backed issue history for one issue. |
| `beadwork_show` | Show one issue and its children. |
| `beadwork_create_issue` | Create a task or epic. |
| `beadwork_update_issue` | Update mutable issue fields. |
| `beadwork_add_dependency` | Add a dependency edge. |
| `beadwork_remove_dependency` | Remove a dependency edge. |
| `beadwork_start_issue` | Start one issue. |
| `beadwork_close_issue` | Close one issue. |
| `beadwork_reopen_issue` | Reopen one issue. |
| `beadwork_comment_issue` | Add a comment. |
| `beadwork_label_issue` | Apply label mutations. |
| `beadwork_defer_issue` | Defer one issue. |
| `beadwork_undefer_issue` | Undefer one issue. |
| `beadwork_delegate` | Launch a delegated worker for a ticket, optionally with a one-off model override. |
| `beadwork_land_worker` | Explicitly request merge-back for a held worker. |
| `beadwork_worker_check` | Inspect worker runtime/diagnostic state. |
| `beadwork_sync` | Run `bw sync`. |

## Operator-facing truths

A few semantics are intentionally strict:

- `landed` means actual parent-branch containment, not just a clean worktree or equivalent diff
- deferred workers are not abandoned; `/bw land` re-enters orchestrator-owned landing
- reviewer feedback is filtered against ticket intent rather than treated as absolute truth
- `/bw workers` is the durable source of truth when notifications and logs are not enough
