# @solvedbydev/pi-beadwork-extension

A [pi coding-agent](https://github.com/badlogic/pi-mono) extension that makes pi beadwork-aware for human-led planning, ticket operations, explicit plan adoption, and tmux-backed delegated workers.

This package is meant to make the real beadwork workflow usable inside pi:

- engage a session around a repo, epic, or ticket
- inspect and mutate beadwork issues without leaving pi
- turn an explicit markdown plan into an epic/task graph
- delegate one ticket into an isolated worktree-backed worker
- let the orchestrator supervise worker exit, validation, review, merge-back, and cleanup
- optionally hold validated work for later `/bw land` instead of merging immediately

## Status

This extension is now in a practical dogfooding state for:

- human-led beadwork sessions
- explicit markdown-plan adoption
- delegated `/bw delegate` worker flows with streamed logs + notifications
- orchestrator-owned validation / remediation / merge-back
- deferred landing and reviewer-gated landing modes
- bounded `/bw run` orchestration over an epic

Truths to keep in mind:

- the worker backend is tmux-first today
- background supervision is **session-local**, not a standalone daemon
- supervisor work happens while the parent pi session is alive and idle enough to process turns
- validation runs synchronously in delegated worktrees, so large repos can still take a while after a worker exits
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

1. the extension creates or reuses a per-ticket worktree
2. it launches a tmux-backed worker in the background
3. the worker writes streamed activity to `worker.log`
4. the parent session stays in place and polls on the configured supervisor interval
5. after worker exit, the orchestrator handles validation / review / merge-back / cleanup

Use `/bw workers` any time for the full breakdown.

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

A validated worker is merged back automatically once review/remediation is satisfied.

#### Deferred landing

```json
{
  "landing": {
    "policy": "deferred"
  }
}
```

In deferred mode, the orchestrator validates the work, confirms current mergeability, then holds it unmerged until you explicitly say:

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
    "mode": "worktree",
    "maxLifetime": null,
    "allowDetachedHead": false,
    "review": {
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
- `workerExecution.review.enabled` controls current-branch per-worker review and is on by default; set it to `false` to skip that pass
- `landing.review.enabled` only controls worktree landing review and does not disable current-branch worker review
- `worktrees.cleanup: "cleanup-after-landing"` removes the worktree and tmux window after successful orchestrator landing
- a worker only counts as `landed` when the parent branch actually contains the worker head; equivalent diff heuristics alone do not count as landed

For the full config reference and all environment variables, see [docs/configuration.md](./docs/configuration.md).

## Docs

- [docs/README.md](./docs/README.md) — docs index
- [docs/workflows.md](./docs/workflows.md) — dashboard-first operator workflow, delegated worker lifecycle, deferred landing, reviewer gating, `/bw run`
- [docs/configuration.md](./docs/configuration.md) — config keys, environment variables, examples, compatibility aliases
- [docs/commands.md](./docs/commands.md) — slash command reference, dashboard controls, worker states, and tool surface
- [docs/tui-proposal.md](./docs/tui-proposal.md) — design notes and follow-on TUI backlog beyond the shipped dashboard/workflow

## Tool surface

The extension also exposes beadwork-aware tools to the model, including:

- status / prime / ready / blocked / list / show / history
- create / update / dependency add-remove
- start / close / reopen / comment / label / defer / undefer / sync
- delegated worker launch (`beadwork_delegate`)
- deferred explicit landing (`beadwork_land_worker`)
- worker inspection (`beadwork_worker_check`)

See [docs/commands.md](./docs/commands.md#tool-reference) for the full list.
