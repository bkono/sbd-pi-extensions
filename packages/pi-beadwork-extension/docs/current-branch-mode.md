# Current-branch mode

**Removed.** `workerExecution.mode` and tmux current-branch workers are gone.

Shared parent checkout is now the default for in-process minions, not a launch mode. Coordination
is advisory. See [migration.md](./migration.md) and [worker-conventions.md](./worker-conventions.md).
