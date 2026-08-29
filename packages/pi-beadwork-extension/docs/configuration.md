# Configuration

Config is merged in this order:

1. environment variables
2. `<repo>/.pi/beadwork-config.json`
3. `~/.pi/beadwork-config.json`
4. built-in defaults

`/bw run` calls `assertGoalModeConfig`. Leftover supervisor keys and env vars are **errors**, not
ignored. See [migration.md](./migration.md). Do not migrate `landing.validateCommands` into a
validation gate.

## Full config shape

```json
{
  "ui": {
    "showInactiveStatus": false
  },
  "storage": {
    "sessionStateDir": ".pi/beadwork/session-state"
  },
  "review": {
    "policy": "ticket"
  }
}
```

Built-in defaults match that object (`review.provider` / `review.model` unset).

## Key details

### `ui.showInactiveStatus`

- default: `false`
- when true, keeps a statusline visible even when beadwork is not active

Environment: `PI_BEADWORK_SHOW_INACTIVE_STATUS=1`

### `storage.sessionStateDir`

Per-session mode/scope/prime/goal state. Default: `.pi/beadwork/session-state`.

Environment: `PI_BEADWORK_SESSION_STATE_DIR`

`storage.workerRegistryFile` and `storage.runtimeDir` are rejected leftovers.

### `review.policy`

Values: `ticket` (default), `scope`, `none`.

This is the policy `/bw run` stores on the goal and injects into the prompt. The standing appendix
repeats it. It is not a structured-result gate and not a keyword classifier.

| Policy   | Parent behavior |
| -------- | --------------- |
| `ticket` | Independent `reviewImplementation` child before close. Settlement is not acceptance. |
| `scope`  | Close tickets from evidence. `reviewScope` before epic complete. Dependents may start before aggregate review. |
| `none`   | No independent review children. Still judge from git and `bw` before close. |

Environment: `PI_BEADWORK_REVIEW_POLICY`

Invalid values error (`must be "ticket", "scope", or "none"`).

### `review.provider` / `review.model`

Optional stored preferences. They do **not** launch a landing reviewer, do not run
`validateCommands`, and are not auto-applied to `orchestrate` children. Pass `model` on each
orchestrated task when a child should use a specific model.

Environment: `PI_BEADWORK_REVIEW_PROVIDER`, `PI_BEADWORK_REVIEW_MODEL`

## Environment variables

Supported:

- `PI_BEADWORK_SHOW_INACTIVE_STATUS`
- `PI_BEADWORK_SESSION_STATE_DIR`
- `PI_BEADWORK_REVIEW_POLICY`
- `PI_BEADWORK_REVIEW_PROVIDER`
- `PI_BEADWORK_REVIEW_MODEL`

## Rejected leftovers

Any of these present in project/global JSON or the environment causes `/bw run` to error with
`SupervisorConfigError` listing every leftover:

JSON families: `tmux`, `worktrees`, `landing`, `supervisor`, `workerExecution`.

JSON keys: `run.defaultWorkers`, `run.defaultUntil`, `run.defaultMaxCycles`, `run.pollIntervalMs`,
`storage.workerRegistryFile`, `storage.runtimeDir`.

Env vars (non-exhaustive of the code list; the error prints the exact names):

- `PI_BEADWORK_TMUX_SESSION_NAME`, `PI_BEADWORK_WORKER_COMMAND`, `PI_BEADWORK_WORKER_*`
- `PI_BEADWORK_WORKTREE_BASE_DIR`, `PI_BEADWORK_WORKER_EXECUTION_MODE`
- `PI_BEADWORK_DEFAULT_WORKERS`, `PI_BEADWORK_DEFAULT_MAX_CYCLES`, `PI_BEADWORK_POLL_INTERVAL_MS`
- `PI_BEADWORK_LANDING_POLICY`, `PI_BEADWORK_VALIDATE_TIMEOUT_MS`
- `PI_BEADWORK_REVIEW_ENABLED`, `PI_BEADWORK_REVIEW_TIMEOUT_MS`,
  `PI_BEADWORK_REVIEW_MAX_REMEDIATION_ATTEMPTS`, `PI_BEADWORK_REVIEW_MAX_ARTIFACT_CHARS`,
  `PI_BEADWORK_REVIEW_MAX_CONTEXT_CHARS`
- `PI_BEADWORK_SUPERVISOR_POLL_INTERVAL_MS`

Error text includes: `/bw run is a standing appendix plus injected prompt, not a polling
supervisor.` and `Do not migrate landing.validateCommands into a validation gate.`

## Example: ticket review (default)

```json
{
  "review": {
    "policy": "ticket"
  }
}
```

## Example: scope review

```json
{
  "review": {
    "policy": "scope"
  }
}
```

## Example: no independent review children

```json
{
  "review": {
    "policy": "none"
  }
}
```
