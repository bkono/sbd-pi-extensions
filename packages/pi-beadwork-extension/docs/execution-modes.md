# Worker execution modes

`workerExecution.mode` selects where delegated workers run.

```json
{
  "workerExecution": {
    "mode": "worktree"
  }
}
```

Valid values:

- `worktree` — create or reuse a per-ticket git worktree and branch.
- `current-branch` — run in the parent session's current checkout/current branch.

The built-in default in this package is `worktree`. Repos that want current-branch swarming should
set `workerExecution.mode: "current-branch"` in `.pi/beadwork-config.json` or use the environment
override.

## Comparison

| Behavior | `current-branch` | `worktree` |
| --- | --- | --- |
| Checkout | Parent repo root/current branch | Per-ticket worktree |
| Branch creation | None | Ticket branch/worktree created or reused |
| Worker cwd | `checkoutPath` is repo root | `checkoutPath`/`worktreePath` is the ticket worktree |
| Main attribution | Commit evidence and beadwork history | Worker branch head and worktree state |
| Post-exit success state | `verified` | `landed` or `held` |
| Merge-back | Not run | Run for `landing.policy: "auto"`; held for `deferred` |
| Validation | Attribution/review/ticket-closure verification; workers should run and report validation | Orchestrator runs `landing.validateCommands` in the worktree |
| Review switch | `workerExecution.review.enabled` | `landing.review.enabled` |
| Cleanup | Runtime cleanup only | Optional worktree/tmux cleanup via `worktrees.cleanup` |
| Best for | Shared-branch swarms with disciplined commit conventions | Strong isolation, risky changes, noisy checkout state |

## Current-branch target default

In current-branch mode, the target is always the current checkout/current branch at launch time. The
implementation records the launch branch and `HEAD` SHA, then starts the tmux worker in the repo
root. It does not create a branch, does not create a worktree, and does not later merge a worker
branch back.

Example repo config for a project that wants current-branch workers by default:

```json
{
  "workerExecution": {
    "mode": "current-branch",
    "allowDetachedHead": false,
    "review": {
      "enabled": true
    }
  }
}
```

Equivalent environment override:

```sh
PI_BEADWORK_WORKER_EXECUTION_MODE=current-branch \
PI_BEADWORK_WORKER_REVIEW_ENABLED=true \
pi
```

## Worktree fallback

Use explicit worktree fallback when the shared checkout is too risky, a task needs isolation, or a
current-branch launch is rejected from detached HEAD and you do not want to opt in.

Repo config:

```json
{
  "workerExecution": {
    "mode": "worktree"
  },
  "worktrees": {
    "baseDir": "../sbd-pi-extensions-worktrees",
    "cleanup": "keep",
    "copyFiles": [".env", ".mise.local.toml"],
    "setupCommands": ["mise trust", "npm install"],
    "rerunSetupOnReuse": false
  }
}
```

One shell:

```sh
PI_BEADWORK_WORKER_EXECUTION_MODE=worktree \
PI_BEADWORK_WORKTREE_BASE_DIR=../sbd-pi-extensions-worktrees \
pi
```

Because `worktree` is the built-in default today, omitting `workerExecution.mode` also falls back to
worktree unless a global/project config or environment variable overrides it.

## Detached HEAD

Current-branch mode rejects detached HEAD unless explicitly allowed:

```json
{
  "workerExecution": {
    "mode": "current-branch",
    "allowDetachedHead": true
  }
}
```

Environment override:

```sh
PI_BEADWORK_WORKER_EXECUTION_MODE=current-branch \
PI_BEADWORK_WORKER_ALLOW_DETACHED_HEAD=1 \
pi
```

Leave `allowDetachedHead` false for normal branch workflows. Opting in records `branchName=HEAD`,
which limits normal branch-drift assumptions during attribution.

## Review settings are intentionally separate

`workerExecution.review.enabled` and `landing.review.enabled` are not aliases.

```json
{
  "workerExecution": {
    "review": {
      "enabled": true
    }
  },
  "landing": {
    "review": {
      "enabled": true,
      "provider": "openai",
      "model": "gpt-5.4:high"
    }
  }
}
```

- Current-branch workers use `workerExecution.review.enabled` for their per-worker review gate.
- Worktree workers use `landing.review.enabled` during landing review before merge-back or deferred
  ready-to-land state.
- Reviewer provider/model/timeout settings are shared reviewer-agent settings, but artifact limits are
  not shared across modes: `landing.review.maxArtifactChars` caps worktree landing review artifacts
  only. Current-branch review does not build a `maxArtifactChars`-bounded diff artifact.

## `maxLifetime`

`workerExecution.maxLifetime` accepts `null` or a non-negative millisecond value and can also be set
with `PI_BEADWORK_WORKER_MAX_LIFETIME`. The current implementation parses and stores the config but
worker supervision still primarily detects process exit/disappearance through tmux/runtime state;
do not rely on `maxLifetime` as an enforced kill switch unless the implementation changes.
