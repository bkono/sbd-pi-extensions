# @solvedbydev/pi-beadwork-extension

A [pi coding-agent](https://github.com/badlogic/pi-mono) extension that makes pi beadwork-aware for human-led planning, ticket operations, explicit plan adoption, and tmux-backed delegated workers.

This package is meant to make the real beadwork workflow usable inside pi:

- engage a session around a repo, epic, or ticket
- inspect and mutate beadwork issues without leaving pi
- turn an explicit markdown plan into an epic/task graph
- delegate one ticket into either a worktree-backed or current-branch worker
- let the orchestrator supervise worker exit, validation/review, current-branch verification, worktree merge-back, and cleanup
- optionally hold validated worktree work for later `/bw land` instead of merging immediately

## Status

This extension is now in a practical dogfooding state for:

- human-led beadwork sessions
- explicit markdown-plan adoption
- delegated `/bw delegate` worker flows with streamed logs + notifications
- configurable worktree/current-branch worker execution modes
- orchestrator-owned validation / remediation / current-branch verification / worktree merge-back
- deferred worktree landing and reviewer-gated landing modes
- bounded `/bw run` orchestration over an epic

Truths to keep in mind:

- the worker backend is tmux-first today
- background supervision is **session-local**, not a standalone daemon
- supervisor work happens while the parent pi session is alive and idle enough to process turns
- post-worker checks run synchronously: worktree mode validates/reviews/merges delegated worktrees; current-branch mode verifies the current checkout in place
- large repos can still take a while after a worker exits because those checks run before final notification
- `/bw adopt` now expects an **explicit** markdown source (inline, file, or editor text), not scraped chat history

## Install

### Workspace dependency

```json
{
  "dependencies": {
    "@solvedbydev/pi-beadwork-extension": "*"
  }
}
```

### Register with pi

Add the extension entrypoint to `settings.json`:

```json
{
  "extensions": [
    "/path/to/sbd-pi-extensions/packages/pi-beadwork-extension/src/index.ts"
  ]
}
```

## Quickstart

### 1. Start with the dashboard-first workflow

```text
/bw
/bw status
/bw:workers
```
- bare `/bw` opens the beadwork dashboard when beadwork is active or available in the repo
- the default **Issues** tab is ready-first, so you can browse and choose work before explicitly engaging
- inside the Issues tab: `s` scopes the current issue, `x` clears scope, `d` opens delegate clarify for a ticket, and `r` opens run clarify for an epic
- `tab` / `shift+tab` (or `←` / `→`) move between the Issues, Workers, Run, Scope, and Actions tabs
- dedicated aliases like `/bw:status`, `/bw:scope`, `/bw:delegate`, `/bw:run`, `/bw:workers`, `/bw:land`, `/bw:cancel`, and `/bw:cleanup` stay registered for faster slash-command discovery

Or scope the session immediately from text commands:

```text
/bw engage sbdpi-swx.6
/bw:scope sbdpi-swx.6
```
### 2. Inspect the queue

```text
/bw ready
/bw show sbdpi-swx.6
/bw:ready
/bw:list
```

### 3. Materialize a plan from explicit markdown

Preview first:

```text
/bw adopt --file docs/plan.md --title "Worker landing polish" --land multi
```

Apply once the preview looks right:

```text
/bw adopt --file docs/plan.md --title "Worker landing polish" --land multi --apply
```

`/bw adopt` accepts:

- inline markdown
- `--file path/to/plan.md`
- markdown in the editor

### 4. Delegate one ready ticket

```text
/bw delegate sbdpi-swx.6.4.2
/bw delegate sbdpi-swx.6.4.2 --model cursor/composer-2
```

Use `--model provider/model` for a one-off worker override without changing the
repo or global beadwork defaults.

What happens:

1. the extension prepares the configured worker checkout (`workerExecution.mode`)
2. it launches a tmux-backed worker in the background
3. the worker writes streamed activity to `worker.log`
4. the parent session stays in place and polls on the configured supervisor interval
5. after worker exit, the orchestrator handles the mode-specific verification or landing flow

Use `/bw workers` any time for the full breakdown.

### Current-branch worker conventions

Current-branch mode runs a worker in the same checkout and branch as the parent session:

```json
{
  "workerExecution": {
    "mode": "current-branch"
  }
}
```

The built-in package default is now `current-branch`. Repos can opt back into worktree isolation
with project config or `PI_BEADWORK_WORKER_EXECUTION_MODE=worktree`. In current-branch mode the
target is the current checkout/current branch; no ticket branch or worktree is created.
Use explicit worktree fallback when a task needs isolation:

```json
{
  "workerExecution": {
    "mode": "worktree"
  }
}
```

Current-branch workers must be easy to attribute:

- include the beadwork ticket id in commit messages, for example
  `docs(pi-beadwork): document worker conventions sbdpi-qmd.5.4`
- make atomic commits with exact paths:
  `git commit <specific-files> -m "docs(pi-beadwork): ... sbdpi-qmd.5.4"`
- avoid broad shared-index operations such as `git add -A`, `git add .`, and `git commit -a`
- leave a final `bw comment <ticket-id> ...` handoff with status, commit SHAs when known,
  validation results, blockers, and useful follow-up
- keep the handoff natural; it is LLM-readable context, not a rigid schema
- fix forward with clarifying comments or follow-up tickets when attribution is imperfect instead
  of rewriting shared history
- never stash, reset, clean, or discard unrelated checkout state because it may belong to another
  active worker

Detached HEAD is rejected for current-branch launch unless
`workerExecution.allowDetachedHead: true` (or `PI_BEADWORK_WORKER_ALLOW_DETACHED_HEAD=1`) is set.
See [docs/current-branch-mode.md](./docs/current-branch-mode.md),
[docs/worker-conventions.md](./docs/worker-conventions.md), and
[docs/execution-modes.md](./docs/execution-modes.md) for the full details.

### 5. Choose your landing policy

#### Auto landing

With the default policy:

```json
{
  "landing": {
    "policy": "auto"
  }
}
```

In worktree mode, a validated worker is merged back automatically once review/remediation is satisfied. Current-branch workers are verified in place instead of merged back.

#### Deferred landing

```json
{
  "landing": {
    "policy": "deferred"
  }
}
```

In deferred worktree mode, the orchestrator validates the work, confirms current mergeability, then holds it unmerged until you explicitly say:

```text
/bw land sbdpi-swx.6.4.1
```

### 6. Run an epic with bounded orchestration

```text
/bw run sbdpi-swx.6 --workers 2 --until blocked --max-cycles 12
```

If the bounded run stops because it hit `--max-cycles`, the same session keeps background supervision armed and continues on later idle turns.

## Recommended config examples

Config resolution order:

1. environment variables
2. `<repo>/.pi/beadwork-config.json`
3. `~/.pi/beadwork-config.json`
4. built-in defaults

### Example: worker on one model, reviewer on GPT-5.4 high

```json
{
  "tmux": {
    "workerProvider": "anthropic",
    "workerModel": "claude-opus-4.1"
  },
  "landing": {
    "review": {
      "enabled": true,
      "provider": "openai",
      "model": "gpt-5.4:high",
      "commandTimeoutMs": 1800000,
      "maxArtifactChars": 16000
    }
  }
}
```

Notes:

- reviewer provider/model are independent from worker provider/model
- reviewer timeout now defaults to **30 minutes** (`1800000` ms)
- reviewer runs now behave like normal exploratory agents by default; pi reviewers keep their usual tools/extensions/skills unless your base command disables them
- reviewer handoff ends with a parseable `<review_report>` block using `APPROVE`, `APPROVE WITH NITS`, or `REQUEST CHANGES`; the orchestrator then normalizes and filters findings against ticket intent
- `maxArtifactChars` caps the diff/commit artifacts sent to the reviewer; it does **not** cap the entire review prompt
- legacy `maxContextChars` / `PI_BEADWORK_REVIEW_MAX_CONTEXT_CHARS` are still accepted for compatibility

### Example: deferred landing with review gating

```json
{
  "landing": {
    "policy": "deferred",
    "validateCommands": [
      "npm run lint",
      "npm run test",
      "npm run typecheck"
    ],
    "review": {
      "enabled": true,
      "provider": "openai",
      "model": "gpt-5.4:high",
      "commandTimeoutMs": 1800000,
      "maxRemediationAttempts": 1,
      "maxArtifactChars": 12000
    }
  },
  "supervisor": {
    "pollIntervalMs": 30000
  }
}
```

### Example: worktree bootstrap

```json
{
  "worktrees": {
    "cleanup": "cleanup-after-landing",
    "copyFiles": [
      ".env",
      ".mise.local.toml",
      { "from": ".env.local", "to": ".env.local", "required": false }
    ],
    "setupCommands": ["mise trust", "npm install"],
    "rerunSetupOnReuse": false
  }
}
```

## Command overview

Core human workflow:

- `/bw status`
- `/bw engage [scope]`
- `/bw ready [scope]`
- `/bw show <id>`
- `/bw adopt [markdown] [--file path] [--title ...] [--land quick|branch|multi] [--apply]`
- `/bw delegate <ticket-id> [--model provider/model]`
- `/bw workers [epic-id]`
- `/bw land <ticket-id|worker-id>`
- `/bw run <epic-id> [--workers n] [--until blocked|empty] [--max-cycles n] [--dry-run] [--no-spawn]`
- `/bw off [--stop-workers] [--all-workers] [--leave-workers]`

Issue-management coverage:

- `/bw blocked`
- `/bw list ...`
- `/bw history <id> [--limit n]`
- `/bw create ...`
- `/bw update ...`
- `/bw dep <add|remove> ...`
- `/bw comment ...`
- `/bw label ...`
- `/bw start <id>`
- `/bw close <id> [--reason ...]`
- `/bw reopen <id>`
- `/bw defer <id> <when>`
- `/bw undefer <id>`
- `/bw sync`

For the full reference, see [docs/commands.md](./docs/commands.md).

## Config defaults

Current built-in defaults:

```json
{
  "ui": {
    "showInactiveStatus": false
  },
  "storage": {
    "sessionStateDir": ".pi/beadwork/session-state",
    "workerRegistryFile": ".pi/beadwork/workers/registry.json",
    "runtimeDir": ".pi/beadwork/workers/runtime"
  },
  "tmux": {
    "sessionName": "pi-bw",
    "workerCommand": "pi"
  },
  "worktrees": {
    "cleanup": "keep",
    "copyFiles": [],
    "setupCommands": [],
    "rerunSetupOnReuse": false
  },
  "workerExecution": {
    "mode": "current-branch",
    "maxLifetime": null,
    "allowDetachedHead": false,
    "review": {
      "enabled": true
    },
    "selfReview": {
      "enabled": true
    }
  },
  "run": {
    "defaultWorkers": 2,
    "defaultUntil": "blocked",
    "defaultMaxCycles": 12,
    "pollIntervalMs": 2000
  },
  "landing": {
    "policy": "auto",
    "validateCommands": ["npm run lint", "npm run test", "npm run typecheck"],
    "commandTimeoutMs": 600000,
    "maxRebaseAttempts": 2,
    "review": {
      "enabled": false,
      "commandTimeoutMs": 1800000,
      "maxRemediationAttempts": 1,
      "maxArtifactChars": 12000
    }
  },
  "supervisor": {
    "pollIntervalMs": 30000
  }
}
```

Important behavior notes:

- a bare `tmux.workerCommand: "pi"` is normalized to `pi --mode json`
- if `tmux.workerCommand` includes `--print`, that flag is stripped so worker output still uses JSON mode cleanly
- `tmux.workerProvider` / `tmux.workerModel` only affect delegated workers, not the current parent session
- reviewer provider/model fall back to the worker provider/model when not set explicitly
- `workerExecution.mode` selects `current-branch` by default
- set `workerExecution.mode: "worktree"` explicitly for isolated worktree execution
- `workerExecution.maxLifetime` accepts `null` or non-negative milliseconds; it is parsed/stored, while current supervision still primarily follows tmux/runtime exit state
- `workerExecution.allowDetachedHead` is false by default and must be explicitly enabled for current-branch launch from detached HEAD
- `workerExecution.review.enabled` controls current-branch per-worker review and is on by default; set it to `false` to skip that pass
- `workerExecution.selfReview.enabled` controls the in-worker completion gate; when on, the first `beadwork_worker_done` call returns a same-session self-review prompt and the second call closes/syncs and shuts the worker down
- `landing.review.enabled` only controls worktree landing review and does not disable current-branch worker review
- `worktrees.cleanup: "cleanup-after-landing"` removes the worktree and tmux window after successful orchestrator landing
- a worktree worker only counts as `landed` when the parent branch actually contains the worker head; equivalent diff heuristics alone do not count as landed

For the full config reference and all environment variables, see [docs/configuration.md](./docs/configuration.md).

## Docs

- [docs/README.md](./docs/README.md) — docs index
- [docs/workflows.md](./docs/workflows.md) — dashboard-first operator workflow, delegated worker lifecycle, deferred landing, reviewer gating, `/bw run`
- [docs/current-branch-mode.md](./docs/current-branch-mode.md) — current-branch worker execution, attribution, detached HEAD behavior, and fallback
- [docs/worker-conventions.md](./docs/worker-conventions.md) — commit, handoff, validation, and shared-checkout conventions
- [docs/execution-modes.md](./docs/execution-modes.md) — comparison of current-branch and worktree execution modes
- [docs/current-branch-e2e.md](./docs/current-branch-e2e.md) — deterministic smoke scripts, artifact layout, failure debugging, and current-branch/worktree coverage
- [docs/configuration.md](./docs/configuration.md) — config keys, environment variables, examples, compatibility aliases
- [docs/commands.md](./docs/commands.md) — slash command reference, dashboard controls, worker states, and tool surface
- [docs/tui-proposal.md](./docs/tui-proposal.md) — design notes and follow-on TUI backlog beyond the shipped dashboard/workflow

## Tool surface

The extension also exposes beadwork-aware tools to the model, including:

- status / prime / ready / blocked / list / show / history
- create / update / dependency add-remove
- start / close / reopen / comment / label / defer / undefer / sync
- delegated worker launch (`beadwork_delegate`)
- worker follow-up (`beadwork_land_worker`) for deferred worktree landing or current-branch verification/retry
- worker inspection (`beadwork_worker_check`)

See [docs/commands.md](./docs/commands.md#tool-reference) for the full list.
