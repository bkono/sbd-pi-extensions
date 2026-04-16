# Workflows

This extension is designed around a **human-led beadwork session** with optional delegated workers.

The important split is:

- you drive planning, scoping, and operator decisions
- delegated workers execute one ticket at a time in isolated worktrees
- the orchestrator owns the post-worker lifecycle: validation, review, merge-back, and cleanup

## Session modes

The persisted session state can be:

- `neutral` — no beadwork workflow is engaged
- `interactive` — beadwork-aware human-led mode for a repo, ticket, or epic
- `run` — bounded `/bw run` mode for an epic, with background continuation while the session stays alive

Typical flow:

```text
/bw status
/bw engage
/bw engage sbdpi-swx.6
```

Use `/bw off` to return to neutral mode.

If workers are still active, `/bw off` will make you choose:

- `/bw off --stop-workers`
- `/bw off --leave-workers`
- `/bw off --stop-workers --all-workers`

## Planning and `/bw adopt`

`/bw adopt` is now built around an **explicit markdown source**. It no longer depends on scraping prior chat text.

Supported sources:

- inline markdown passed directly to `/bw adopt`
- `--file path/to/plan.md`
- markdown currently open in the editor

Preview first:

```text
/bw adopt --file docs/worker-plan.md --title "Worker landing polish" --land multi
```

Apply after review:

```text
/bw adopt --file docs/worker-plan.md --title "Worker landing polish" --land multi --apply
```

Land modes:

- `quick` — preview only; no beadwork mutations
- `branch` — create beadwork artifacts directly from the explicit plan
- `multi` — queue an LLM-guided decomposition turn that materializes the epic/tasks/dependencies through beadwork tools

Use `multi` when the markdown describes the intent but the graph still benefits from model decomposition.

## Delegated worker lifecycle

`/bw delegate <ticket-id>` launches one ticket into its own worktree-backed tmux worker.

### What delegation does

1. resolves ticket + optional epic context
2. ensures `bw prime` context is available
3. creates or reuses the ticket worktree
4. applies configured file copies and setup commands
5. launches a tmux-backed worker in the background
6. writes worker output to `worker.log`
7. tracks the worker in the local registry and session state
8. lets the parent session continue while supervision runs on the configured interval

### What the operator should expect

Immediately after `/bw delegate`, the extension tells you:

- which worker ID was launched
- where the worktree lives
- where `worker.log` lives
- how often supervision checks the worker
- whether completion will mean automatic landing or a held deferred state

Use these as your primary inspection paths:

- `worker.log` for streamed worker activity
- `/bw workers` for full lifecycle diagnostics
- later parent-session notifications for worker exit / remediation / completion / attention

### Worker status values

High-level runtime status:

- `launching`
- `running`
- `exited`
- `held`
- `landed`
- `failed`
- `attention`

Important interpretation:

- `running` means the delegated process still exists
- `exited` means the worker process finished, but landing is not yet complete
- `held` means deferred landing intentionally stopped before merge-back
- `landed` means the parent branch actually contains the worker head and validation/review conditions are satisfied
- `attention` means operator involvement is needed

## Validation, remediation, review, and merge-back

After a worker exits and the ticket is closed, the orchestrator handles post-worker work.

### Validation

The orchestrator runs `landing.validateCommands` inside the delegated worktree.

Default commands:

```json
["npm run lint", "npm run test", "npm run typecheck"]
```

### Automatic remediation

If validation fails, the orchestrator does **one bounded remediation pass** by default.

That means:

- it does not loop forever retrying the same failure blindly
- remediation state is surfaced in worker diagnostics
- exhausted remediation moves the worker into `attention`

### Reviewer gating

If `landing.review.enabled` is true, the orchestrator runs a reviewer-agent pass before merge-back or before declaring a deferred worker ready to land.

Explicit reviewer verdicts are:

- `approve`
- `approve-with-nits`
- `request-changes`

The orchestrator does **not** blindly obey the reviewer. It filters feedback against the bead intent and ticket goals.

Operator-visible review states include:

- `approved`
- `nits-only`
- `changes-requested`
- `remediation-in-progress`
- `review-blocked`

### Merge-back truthfulness

A worker is only treated as landed when the parent branch truly contains the worker head.

That means the extension avoids claiming success just because:

- the ticket was closed
- the worktree is clean
- the diff looks equivalent

## Landing policies

### `landing.policy: "auto"`

This is the default.

Flow:

1. worker exits
2. ticket is confirmed closed
3. validation runs
4. remediation/re-review runs if needed
5. merge-back happens when valid
6. landing is verified against the parent branch
7. optional cleanup runs

Best when you want the orchestrator to finish the full lifecycle without another explicit operator command.

### `landing.policy: "deferred"`

Deferred landing keeps the orchestrator in charge, but intentionally stops before merge-back.

Flow:

1. worker exits
2. ticket is confirmed closed
3. validation runs
4. review/remediation runs if configured
5. work is held unmerged
6. `/bw workers` reports a truthful held state
7. you later run `/bw land <ticket-id|worker-id>`

Deferred landing states surfaced in diagnostics:

- `validated-and-held`
- `ready-to-land`
- `needs-refresh`
- `needs-attention`

Use deferred mode when you want:

- manual human testing before merge-back
- an explicit operator-controlled checkpoint
- review of the isolated worktree before integration

## `/bw land`

`/bw land` explicitly resumes a deferred worker's merge-back flow.

```text
/bw land sbdpi-swx.6.4.1
```

Or by worker ID:

```text
/bw land sbdpi-swx.6.4.1-mtr7z7-abc123
```

What it does:

- finds the held worker by ticket ID or worker ID
- re-checks landability in the current repo state
- refreshes/rebases if needed
- runs the remaining orchestrator merge-back flow
- returns updated diagnostics

## `/bw workers`

`/bw workers` is the main operator-facing diagnostic view.

```text
/bw workers
/bw workers sbdpi-swx.6
```

Each worker entry summarizes:

- worker ID and tmux pane
- ticket state
- validation state
- review state
- landing state
- cleanup state
- the next operator action

Use it when you need the durable truth, not just a transient notification.

## `/bw run`

`/bw run` launches a bounded orchestration loop for a scoped epic.

```text
/bw run sbdpi-swx.6 --workers 2 --until blocked --max-cycles 12
```

Behavior:

- only works on an epic
- launches up to `--workers` ready tickets
- respects `--until blocked|empty`
- stops after `--max-cycles`
- can run in `--dry-run` mode
- can avoid spawning new workers with `--no-spawn`

### Background continuation

If a non-dry `/bw run` stops because it reached `max-cycles`, the session persists enough run state to continue supervision in the background on later idle turns.

This is **not** a daemon. It depends on the parent session remaining alive.

## Notifications and logs

Delegated-worker UX is intentionally split across two channels:

### 1. `worker.log`

This includes:

- worker start metadata
- the exact worker command used
- streamed worker activity from `pi --mode json`
- orchestrator progress lines for post-exit validation/review/landing

### 2. parent-session notifications

The parent session emits later notices for meaningful transitions such as:

- worker closed the ticket and is waiting for process exit
- validation remediation started
- reviewer remediation started
- worker completed successfully and merged back
- worker needs operator attention

## Cleanup behavior

Cleanup is controlled by `worktrees.cleanup`:

- `keep` — leave the worktree and tmux artifacts alone after success
- `cleanup-after-landing` — remove the worktree and tmux window after successful landing

Cleanup only happens after successful orchestrator-owned landing. Failed or attention states preserve artifacts for debugging.

## Recommended dogfood workflow

For the current feature set, the practical operator flow is:

1. `/bw engage <epic-or-ticket>`
2. `/bw ready`
3. `/bw delegate <ticket-id>` for one ticket, or `/bw run <epic-id>` for bounded orchestration
4. keep working in the parent session
5. watch `worker.log` if you want live detail
6. rely on parent notices for stage changes
7. use `/bw workers` when you want the durable exact status
8. if using deferred mode, run `/bw land <ticket-id|worker-id>` when ready

## Known boundaries

These are documented behaviors, not hidden gotchas:

- tmux is the only worker backend today
- supervision is periodic polling, not file-watch or a repo-wide daemon
- background supervision is tied to the parent session lifecycle
- validation time still depends on your repo's actual quality gates
- review prompts use bounded diff artifacts; `maxArtifactChars` is the cap for those artifacts, not the whole prompt
