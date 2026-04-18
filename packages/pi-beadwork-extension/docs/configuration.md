# Configuration

Config is merged in this order:

1. environment variables
2. `<repo>/.pi/beadwork-config.json`
3. `~/.pi/beadwork-config.json`
4. built-in defaults

## Full config shape

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
    "workerCommand": "pi",
    "workerProvider": "anthropic",
    "workerModel": "claude-opus-4.1"
  },
  "worktrees": {
    "baseDir": "../sbd-pi-extensions-worktrees",
    "cleanup": "keep",
    "copyFiles": [
      ".env",
      ".mise.local.toml",
      { "from": ".env.local", "to": ".env.local", "required": false }
    ],
    "setupCommands": ["mise trust", "npm install"],
    "rerunSetupOnReuse": false
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

## Key details

### `ui.showInactiveStatus`

- default: `false`
- when true, keeps a statusline visible even when beadwork is not active

### `storage.*`

Storage defaults live under `.pi/beadwork/`.

- `sessionStateDir` stores per-session mode/scope/prime/tracking state
- `workerRegistryFile` stores the durable worker registry
- `runtimeDir` stores per-worker runtime artifacts such as prompt/script/log/state files

### `tmux.*`

- `sessionName` names the shared tmux session used for delegated workers
- `workerCommand` is the base agent command used for workers and reviewer passes
- `workerProvider` / `workerModel` override the provider/model for delegated worker launches

#### Worker command normalization

When `workerCommand` resolves to `pi`, the extension normalizes it to JSON mode so progress can be streamed into `worker.log`.

Examples:

- `pi` → `pi --mode json`
- `pi --print` → `pi --mode json`
- `pi --print --mode text` → `pi --mode text`

The extension strips `--print` when normalizing, because worker logging depends on JSON-mode output rather than print-mode transcripts.

### `worktrees.*`

#### `baseDir`

Optional custom parent directory for delegated worktrees.

#### `cleanup`

Values:

- `keep`
- `cleanup-after-landing`

`cleanup-after-landing` only applies after successful orchestrator-owned landing.

#### `copyFiles`

Supports string or object entries.

String example:

```json
[".env", ".mise.local.toml"]
```

Object example:

```json
[
  { "from": ".env.local", "to": ".env.local", "required": false },
  { "from": ".npmrc", "required": true }
]
```

Rules:

- paths are resolved relative to the repo root
- by default the same relative path is used inside the worktree
- string entries are optional by default
- object entries can mark files as `required: true`

#### `setupCommands`

Commands run inside the delegated worktree after creation.

Common examples:

```json
["mise trust", "npm install"]
```

#### `rerunSetupOnReuse`

- default: `false`
- when true, `copyFiles` and `setupCommands` run again even when an existing worktree is reused

### `run.*`

These control bounded `/bw run` behavior.

- `defaultWorkers` — default worker concurrency
- `defaultUntil` — default stop condition (`blocked` or `empty`)
- `defaultMaxCycles` — max cycles before the current invocation stops
- `pollIntervalMs` — loop sleep interval inside the active bounded run

This is separate from background supervisor polling.

### `landing.*`

#### `landing.policy`

Values:

- `auto`
- `deferred`

`auto` merges back as soon as validation/review conditions are satisfied.

`deferred` validates and holds the worker unmerged until `/bw land` is requested.

#### `landing.validateCommands`

Runs inside the delegated worktree after worker exit.

Default:

```json
["npm run lint", "npm run test", "npm run typecheck"]
```

#### `landing.commandTimeoutMs`

Timeout for each validation command.

#### `landing.maxRebaseAttempts`

How many times the orchestrator will try to refresh a drifted worker through rebase + validation + merge-back before moving to `attention`.

### `landing.review.*`

#### `enabled`

Turns on reviewer-agent gating before merge-back or before declaring a deferred worker ready to land.

Reviewer runs are exploratory by default. When the base command is `pi`, the orchestrator keeps the normal tool/extension/skill surface instead of forcing reviewer isolation flags.

#### `provider` / `model`

Reviewer-specific provider/model overrides.

If unset, they fall back to:

- `tmux.workerProvider`
- `tmux.workerModel`

This lets you do things like:

- worker: `claude-opus-4.1`
- reviewer: `gpt-5.4:high`

#### `commandTimeoutMs`

Default: `1800000` ms (**30 minutes**).

This was intentionally raised so slower, larger `gpt-5.4:high` reviews can complete without getting killed early.

#### `maxRemediationAttempts`

How many orchestrator remediation passes are allowed after valid reviewer-requested changes.

#### `maxArtifactChars`

Caps the review artifacts bundled into the reviewer prompt, especially:

The reviewer prompt still includes ticket/epic context, the mandatory validation commands, and instructions to finish with a machine-readable `<review_report>` handoff.

- commit summaries
- diff stats
- unified diff content

This does **not** cap all prompt content. Ticket descriptions, epic descriptions, and other structured context are bounded separately.

##### Compatibility alias

The extension still accepts the legacy field:

```json
{
  "landing": {
    "review": {
      "maxContextChars": 12000
    }
  }
}
```

But `maxArtifactChars` is the preferred name now.

### `supervisor.pollIntervalMs`

Default: `30000` ms.

This controls the parent session's periodic background supervision interval for:

- tracked delegated workers
- persisted `/bw run` state

It is different from `run.pollIntervalMs`, which is the inner sleep interval of an actively executing bounded `/bw run` command.

## Environment variables

Supported environment overrides:

- `PI_BEADWORK_SHOW_INACTIVE_STATUS`
- `PI_BEADWORK_SESSION_STATE_DIR`
- `PI_BEADWORK_WORKER_REGISTRY_FILE`
- `PI_BEADWORK_RUNTIME_DIR`
- `PI_BEADWORK_TMUX_SESSION_NAME`
- `PI_BEADWORK_WORKER_COMMAND`
- `PI_BEADWORK_WORKER_PROVIDER`
- `PI_BEADWORK_WORKER_MODEL`
- `PI_BEADWORK_WORKTREE_BASE_DIR`
- `PI_BEADWORK_DEFAULT_WORKERS`
- `PI_BEADWORK_DEFAULT_MAX_CYCLES`
- `PI_BEADWORK_POLL_INTERVAL_MS`
- `PI_BEADWORK_VALIDATE_TIMEOUT_MS`
- `PI_BEADWORK_MAX_REBASE_ATTEMPTS`
- `PI_BEADWORK_LANDING_POLICY`
- `PI_BEADWORK_REVIEW_ENABLED`
- `PI_BEADWORK_REVIEW_PROVIDER`
- `PI_BEADWORK_REVIEW_MODEL`
- `PI_BEADWORK_REVIEW_TIMEOUT_MS`
- `PI_BEADWORK_REVIEW_MAX_REMEDIATION_ATTEMPTS`
- `PI_BEADWORK_REVIEW_MAX_ARTIFACT_CHARS`
- `PI_BEADWORK_SUPERVISOR_POLL_INTERVAL_MS`

Legacy compatibility alias:

- `PI_BEADWORK_REVIEW_MAX_CONTEXT_CHARS`

## Example profiles

### Minimal practical dogfood config

```json
{
  "worktrees": {
    "copyFiles": [".env", ".mise.local.toml"],
    "setupCommands": ["mise trust", "npm install"]
  },
  "landing": {
    "validateCommands": ["npm run lint", "npm run test", "npm run typecheck"]
  }
}
```

### Deferred landing + human testing gate

```json
{
  "landing": {
    "policy": "deferred"
  },
  "worktrees": {
    "cleanup": "keep"
  }
}
```

### Independent reviewer model

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

### Faster background supervision

```json
{
  "supervisor": {
    "pollIntervalMs": 10000
  }
}
```

Use this carefully. Shorter intervals mean more frequent parent-session work while the session is idle.
