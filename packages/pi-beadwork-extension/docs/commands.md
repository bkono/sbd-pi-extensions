# Commands and tools

## Slash command reference

Bare `/bw` opens the dashboard when beadwork is active or available in the repo. All text commands remain exposed under `/bw ...`, and the most common operator flows also have dedicated `/bw:*` aliases.

## Session + workflow commands
| Command                                                                                              | Purpose                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `/bw`                                                                                                 | Open the dashboard shell when beadwork is available; fall back to status text only when beadwork is unavailable. |
| `/bw status` / `/bw:status`                                                                           | Show activation, mode, scope, counts, and worker summary.                                               |
| `/bw engage [scope]`                                                                                  | Enter beadwork interactive mode, optionally scoped to a ticket or epic.                                 |
| `/bw scope <issue-id\|clear>` / `/bw:scope ...`                                                      | Retarget or clear the current interactive scope.                                                        |
| `/bw off [--stop-workers] [--all-workers] [--leave-workers]` / `/bw:off ...`                         | Return to neutral mode and optionally stop active workers.                                              |
| `/bw prime [--refresh]`                                                                               | Show cached or refreshed `bw prime` guidance.                                                           |
| `/bw ready [scope]` / `/bw:ready [scope]`                                                             | Show ready work, optionally scoped.                                                                     |
| `/bw blocked`                                                                                         | List currently blocked work.                                                                            |
| `/bw workers [epic-id]` / `/bw:workers [epic-id]`                                                     | Show delegated worker diagnostics and next actions; with no explicit epic id and UI available, open the worker console overlay. |
| `/bw delegate <ticket-id> [--model provider/model]` / `/bw:delegate ...`                             | Launch one ticket into a tmux-backed delegated worker using `workerExecution.mode`, optionally with a one-off worker model override. |
| `/bw land <ticket-id\|worker-id>` / `/bw:land ...`                                                   | Run explicit worker follow-up: land/merge-back held worktree workers or rerun current-branch verification/retry. |
| `/bw cancel <ticket-id\|worker-id>` / `/bw:cancel ...`                                               | Stop an active worker by ticket id or worker id.                                                        |
| `/bw cleanup <ticket-id\|worker-id>` / `/bw:cleanup ...`                                             | Remove landed worker worktree/runtime artifacts when cleanup is safe.                                   |
| `/bw run <epic-id> [--workers n] [--until blocked\|empty] [--max-cycles n] [--dry-run] [--no-spawn]` / `/bw:run ...` | Run bounded orchestration over an epic.                                                                 |
| `/bw adopt [markdown] [--file path] [--title ...] [--land quick\|branch\|multi] [--apply]` / `/bw:adopt ...` | Turn an explicit markdown plan into a beadwork-aware preview or graph-materialization flow.             |

## Dashboard controls

Bare `/bw` lands on the ready-first **Issues** tab.

Core in-dashboard actions:

- `↑/↓` or `j/k` — move through the current issue or worker list
- `enter` — drill into the selected issue inside the Issues tab
- `backspace` or `h` — back out one breadcrumb level in the Issues tab
- `s` / `x` — scope the selected issue or clear scope from the Issues tab
- `d` — open delegate clarify for the selected ticket
- `r` — open run clarify for the selected epic
- `tab` / `shift+tab` (or `←` / `→`) — switch between Issues, Workers, Run, Scope, and Actions
- `esc` / `q` — close the current overlay

Use `/bw:workers` when you want the dedicated worker console instead of the compact Workers dashboard tab.
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

- prepares the configured execution target:
  - `workerExecution.mode: "worktree"` creates or reuses the ticket worktree and applies worktree bootstrap config
  - `workerExecution.mode: "current-branch"` uses the repo root/current branch and creates no worktree
- launches the worker in tmux without stealing operator focus
- records registry + runtime state
- tracks the worker in the parent session for later notifications

The launch notice includes:

- worker ID
- execution mode
- worktree path for worktree workers, or checkout path for current-branch workers
- `worker.log` path
- supervisor cadence
- whether completion means automatic landing/deferred hold (worktree) or current-branch verification

### Execution-mode config

`/bw delegate` does not take a mode flag. Select mode through config or environment:

```json
{
  "workerExecution": {
    "mode": "current-branch",
    "allowDetachedHead": false,
    "review": {
      "enabled": true
    },
    "selfReview": {
      "enabled": true
  }
}
```

Explicit worktree fallback:

```json
{
  "workerExecution": {
    "mode": "worktree"
  },
  "worktrees": {
    "baseDir": "../sbd-pi-extensions-worktrees"
  }
}
```

One-shell fallback:

```sh
PI_BEADWORK_WORKER_EXECUTION_MODE=worktree \
PI_BEADWORK_WORKTREE_BASE_DIR=../sbd-pi-extensions-worktrees \
pi
```

`workerExecution.review.enabled` controls current-branch per-worker review.
`landing.review.enabled` controls worktree landing review; it does not disable current-branch review.
`workerExecution.selfReview.enabled` controls the same-worker completion review gate; set `PI_BEADWORK_WORKER_SELF_REVIEW_ENABLED=0` to disable it.
Current-branch launch rejects detached HEAD unless `workerExecution.allowDetachedHead` is true.

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

This handles explicit worker follow-up. For held worktree workers, it resumes deferred landing/merge-back. For current-branch workers, it reruns verification/retry steps when applicable.

The command:

- locates the worker by ticket id or worker id
- re-enters orchestrator landing/merge-back logic for held worktree workers
- refreshes/rebases/revalidates if needed
- reruns current-branch verification/retry when applicable
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

| Status      | Meaning                                                               |
| ----------- | --------------------------------------------------------------------- |
| `launching` | Worker process is being created.                                      |
| `running`   | Worker process is still alive.                                        |
| `exited`    | Worker finished, but landing is not complete yet.                     |
| `held`      | Deferred landing intentionally stopped before merge-back.             |
| `landed`    | Parent branch contains the worktree worker head and post-worker checks passed. |
| `verified`  | Current-branch worker passed attribution/review/ticket-closure verification. |
| `failed`    | Worker process failed outright.                                       |
| `attention` | Operator action is required before the worker can finish landing.     |

### Validation states

| State     | Meaning                                        |
| --------- | ---------------------------------------------- |
| `not-run` | Validation has not started yet.                |
| `pending` | Validation is in progress or still unresolved. |
| `passed`  | Validation succeeded.                          |
| `failed`  | Validation failed.                             |

### Review states

| State                     | Meaning                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `not-run`                 | Reviewer gating is disabled or has not started yet.             |
| `pending`                 | Review is still pending.                                        |
| `approved`                | Reviewer approved.                                              |
| `nits-only`               | Reviewer approved with non-blocking nits.                       |
| `changes-requested`       | Reviewer requested valid in-scope changes.                      |
| `remediation-in-progress` | Reviewer-driven remediation is running.                         |
| `review-blocked`          | Review could not reach a mergeable state without operator help. |

Reviewer verdicts are normalized from the reviewer handoff report:

- `APPROVE` → `approve`
- `APPROVE WITH NITS` → `approve-with-nits`
- `REQUEST CHANGES` → `request-changes`

The orchestrator parses the reviewer’s final `<review_report>` block, then filters findings against ticket intent before deciding whether anything should actually block landing.

### Landing states from worker inspection

| State                  | Meaning                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `waiting-ticket-close` | Ticket is not closed yet, so landing work cannot start.         |
| `verified`             | Landing has been verified against the parent branch.            |
| `validated-and-held`   | Deferred mode validated the work and intentionally held it.     |
| `ready-to-land`        | Deferred mode held the work and it is currently merge-ready.    |
| `needs-refresh`        | Deferred work drifted and must be refreshed before merge-back.  |
| `pending-review`       | Ticket is closed, but landing/review details are still pending. |
| `verification-failed`  | Landing verification failed.                                    |
| `needs-attention`      | Operator attention is required.                                 |

## Tool reference

The extension also exposes beadwork-aware tools to the model.

| Tool                         | Purpose                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `beadwork_status`            | Activation, mode, counts, scope, and worker summary.                              |
| `beadwork_prime`             | Cached or refreshed `bw prime` guidance.                                          |
| `beadwork_ready`             | Ready issue listing, optionally scoped.                                           |
| `beadwork_blocked`           | Blocked issue listing.                                                            |
| `beadwork_list_issues`       | Filtered issue listing.                                                           |
| `beadwork_issue_history`     | Git-backed issue history for one issue.                                           |
| `beadwork_show`              | Show one issue and its children.                                                  |
| `beadwork_create_issue`      | Create a task or epic.                                                            |
| `beadwork_update_issue`      | Update mutable issue fields.                                                      |
| `beadwork_add_dependency`    | Add a dependency edge.                                                            |
| `beadwork_remove_dependency` | Remove a dependency edge.                                                         |
| `beadwork_start_issue`       | Start one issue.                                                                  |
| `beadwork_close_issue`       | Close one issue.                                                                  |
| `beadwork_reopen_issue`      | Reopen one issue.                                                                 |
| `beadwork_comment_issue`     | Add a comment.                                                                    |
| `beadwork_label_issue`       | Apply label mutations.                                                            |
| `beadwork_defer_issue`       | Defer one issue.                                                                  |
| `beadwork_undefer_issue`     | Undefer one issue.                                                                |
| `beadwork_delegate`          | Launch a delegated worker for a ticket, optionally with a one-off model override. |
| `beadwork_land_worker`       | Request worktree merge-back or current-branch verification/retry for a worker.    |
| `beadwork_worker_check`      | Inspect worker runtime/diagnostic state.                                          |
| `beadwork_sync`              | Run `bw sync`.                                                                    |

## Operator-facing truths

A few semantics are intentionally strict:

- `landed` means actual parent-branch containment for worktree workers, not just a clean worktree or equivalent diff
- current-branch workers verify attribution/review/ticket closure and do not run worktree merge-back
- deferred workers are not abandoned; `/bw land` re-enters orchestrator-owned landing
- reviewer feedback is filtered against ticket intent rather than treated as absolute truth
- `/bw workers` is the durable source of truth when notifications and logs are not enough
