# Worker execution modes

**Removed.** `workerExecution.mode` (`current-branch` / `worktree`) and managed worktree launch
are gone.

The runtime does not create worktrees. An orchestration group may use an already existing `cwd`
at create time only. See [migration.md](./migration.md).
