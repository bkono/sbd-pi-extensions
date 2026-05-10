# Current-branch mode

Current-branch mode runs a delegated worker in the same repository checkout and branch as the
parent pi session. It is intended for swarms that coordinate through beadwork and shared git state
instead of per-ticket worktree isolation.

```json
{
  "workerExecution": {
    "mode": "current-branch"
  }
}
```

Or for one shell:

```sh
PI_BEADWORK_WORKER_EXECUTION_MODE=current-branch pi
```

The built-in package default is now `current-branch`. Set `workerExecution.mode: "worktree"`
or `PI_BEADWORK_WORKER_EXECUTION_MODE=worktree` when a project needs isolated worktree workers.

## What launches

When `/bw delegate <ticket-id>` runs with `workerExecution.mode: "current-branch"`:

- the worker tmux window starts with cwd set to the repo root/current checkout;
- no ticket branch or worktree is created;
- the worker handoff says to stay on the current branch and not create alternate checkouts;
- runtime files still live under `.pi/beadwork/workers/runtime/<worker-id>/`;
- the registry records `executionMode=current-branch`, `checkoutPath`, `branchName`, and
  `launchHead`.

After the worker exits and the ticket is closed, the orchestrator runs current-branch verification.
That verification gathers attribution evidence from commits on the current branch, can run the
current-branch reviewer gate, triages reviewer findings, and marks the worker `verified` when
attribution, review triage, and ticket closure pass. It does not perform worktree rebase,
merge-back, branch-containment checks, or worktree cleanup.

## Worker expectations

Current-branch workers must make their own result attributable:

```sh
bw start sbdpi-qmd.5.4
# edit files
npm run lint -w @solvedbydev/pi-beadwork-extension
npm run test -w @solvedbydev/pi-beadwork-extension

git status --short
git diff -- packages/pi-beadwork-extension/README.md

git commit packages/pi-beadwork-extension/README.md \
  packages/pi-beadwork-extension/docs/current-branch-mode.md \
  -m "docs(pi-beadwork): document current-branch mode sbdpi-qmd.5.4"

bw comment sbdpi-qmd.5.4 "Implemented current-branch worker docs in <sha>. Lint passed. No blockers."
bw close sbdpi-qmd.5.4
bw sync
```

Use ticket ids in commit messages. Prefer `git commit <specific-files> -m ...` over `git add -A`,
`git add .`, or `git commit -a`, because a shared checkout may contain another worker's dirty files.

## Handoff comments

Before exiting, leave a concise `bw comment <ticket-id> ...` with the useful facts a coordinator or
reviewer needs:

- status (`done`, `blocked`, `docs-only`, `no-code`, etc.);
- commit SHAs when known;
- validation commands and results;
- blockers or risks;
- follow-up recommendations.

There is no rigid schema. The comments are LLM-readable coordination context, not a parser contract.
If attribution is imperfect, fix forward: add a clarifying comment or follow-up ticket instead of
rewriting shared history unless a human explicitly asks for history surgery.

## Shared checkout etiquette

Current-branch mode is cooperative, not isolated.

Do:

- inspect `git status --short` before editing and before committing;
- stage or commit only the files intentionally changed for the ticket;
- coordinate scope changes with `bw comment`, dependencies, labels, or child issues;
- use the worker runtime scratch dir for transient artifacts.

Do not:

- stash, reset, clean, checkout away, or discard unrelated files;
- create another branch or worktree unless explicitly instructed;
- commit unrelated opportunistic cleanup;
- assume every dirty path belongs to you.

## Detached HEAD behavior

Current-branch launch rejects detached HEAD by default:

```text
Cannot prepare current-branch worker checkout from detached HEAD. Checkout a branch or set workerExecution.allowDetachedHead=true.
```

Opt in only when you understand the attribution trade-off:

```json
{
  "workerExecution": {
    "mode": "current-branch",
    "allowDetachedHead": true
  }
}
```

Or:

```sh
PI_BEADWORK_WORKER_EXECUTION_MODE=current-branch \
PI_BEADWORK_WORKER_ALLOW_DETACHED_HEAD=1 \
pi
```

When detached HEAD is allowed, branch-name drift assumptions are weaker because the recorded branch
name is `HEAD`.

## Review config separation

Current-branch review and worktree landing review are separate switches:

```json
{
  "workerExecution": {
    "review": {
      "enabled": true
    }
  },
  "landing": {
    "review": {
      "enabled": false
    }
  }
}
```

- `workerExecution.review.enabled` controls the per-worker current-branch reviewer gate.
- `landing.review.enabled` controls reviewer gating during worktree landing.

Disabling one does not disable the other.

## Worktree fallback

If the shared checkout is too noisy for a ticket, use worktree mode explicitly:

```json
{
  "workerExecution": {
    "mode": "worktree"
  },
  "worktrees": {
    "cleanup": "keep",
    "copyFiles": [".env", ".mise.local.toml"],
    "setupCommands": ["mise trust", "npm install"]
  }
}
```

Or for one launch session:

```sh
PI_BEADWORK_WORKER_EXECUTION_MODE=worktree \
PI_BEADWORK_WORKTREE_BASE_DIR=../sbd-pi-extensions-worktrees \
pi
```

Worktree mode restores the older isolated branch/worktree lifecycle, including validation,
review/merge-back when enabled, and optional worktree cleanup.

For broader design background, see
[`docs/proposals/proposal_current_branch_swarm_self_contained.md`](../../../docs/proposals/proposal_current_branch_swarm_self_contained.md).
