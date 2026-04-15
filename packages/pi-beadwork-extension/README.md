# @solvedbydev/pi-beadwork-extension

A [pi coding-agent](https://github.com/badlogic/pi-mono) extension for beadwork-aware session engagement, ticket inspection, plan adoption, and tmux-backed worker orchestration.

## Current state

This package is now usable for **human-led beadwork workflow feedback** and an initial tmux-backed `/bw run` loop over existing epics.

Implemented:

- beadwork activation detection
- persisted session mode, scope, and cached `bw prime`
- prompt enrichment in engaged sessions
- typed beadwork adapter for `prime`, `ready`, `blocked`, `list`, `show`, `create`, `dep`, `start`, `close`, and `sync`
- richer `/bw status`
- `/bw engage [scope]`
- `/bw prime [--refresh]`
- `/bw ready [scope]`
- `/bw show <id>`
- `/bw start <id>`
- `/bw close <id>`
- `/bw sync`
- `/bw adopt [plan-text] [--file path] [--title ...] [--land quick|branch|multi] [--apply]`
- `/bw workers [epic-id]` with validation/landing/cleanup diagnostics and explicit `Next` follow-up actions
- `/bw delegate <ticket-id>`
- delegated-worker completion tracking in the parent session, including terminal-state notifications on later turns
- orchestrator-owned post-worker handling: auto-validate, rebase on drift when possible, fast-forward land, and optionally clean up delegated worktrees
- `/bw run <epic-id> [--workers n] [--until blocked|empty] [--max-cycles n] [--dry-run] [--no-spawn]`
- `/bw off [--stop-workers] [--all-workers] [--leave-workers]`
- tmux-backed worker launch with per-ticket worktree creation; successful worker processes now exit cleanly instead of idling in a shell
- optional worker-specific `--provider` / `--model` launch config separate from the orchestrator session
- orchestrator-driven landing that runs required quality gates before landing, retries through repo drift with a rebase flow, and verifies the final landed state
- optional post-landing worktree + tmux cleanup when `worktrees.cleanup` is set to `cleanup-after-landing`
- configurable worktree bootstrap: file copies (for `.env`, `.mise.local.toml`, etc.) and post-create setup commands (`mise trust`, `npm install`, etc.)
- local worker registry and runtime artifacts under `.pi/beadwork/workers/`
- bounded run-loop orchestration over an epic’s scoped `bw ready` queue
- LLM-callable tools for beadwork status, reads, mutations, delegation, and structured worker inspection diagnostics
- lightweight statusline updates including active worker counts

Still conservative / incomplete:

- landing verification is still conservative for work that was integrated outside the orchestrator, but now recognizes some squash/cherry-pick/rebase-style landings via reverse-applicable worker diffs
- quality gates currently run synchronously during worker inspection / `/bw run`, so large repos may feel this on the next parent-session turn after a worker exits
- no background daemonized run supervisor beyond the bounded `/bw run` invocation

## Install

### Workspace use

```json
{
  "dependencies": {
    "@solvedbydev/pi-beadwork-extension": "*"
  }
}
```

### Register with pi

Via `settings.json`:

```json
{
  "extensions": [
    "/path/to/sbd-pi-extensions/packages/pi-beadwork-extension/src/index.ts"
  ]
}
```

## Suggested first-use flow

1. Open a beadwork-enabled repo.
2. Run `/bw status`.
3. Run `/bw engage` or `/bw engage <epic-id>`.
4. Inspect state with `/bw ready` and `/bw show <id>`.
5. Provide an explicit plan source with `/bw adopt --file path/to/plan.md --title "..."` (or inline plan text/editor text).
6. Re-run `/bw adopt ... --apply` once the preview looks right.
7. For multi-ticket decomposition, ask the model to call `beadwork_create_issue` and `beadwork_add_dependency` tools explicitly.
8. Launch one worker manually with `/bw delegate <ticket-id>`, or run the bounded orchestrator with `/bw run <epic-id>`.
9. Keep working in the parent session; when a worker exits after closing its ticket, the orchestrator will try to validate, rebase, land, and clean it up automatically.
10. Watch for parent-session notifications on later turns, or inspect the full validation/landing/cleanup breakdown with `/bw workers`.

## Config

Optional config resolution order:

1. environment variables
2. `<repo>/.pi/beadwork-config.json`
3. `~/.pi/beadwork-config.json`
4. built-in defaults

Current config keys:

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
    "validateCommands": ["npm run lint", "npm run test", "npm run typecheck"],
    "commandTimeoutMs": 600000,
    "maxRebaseAttempts": 2
  }
}
```

Notes:

- `tmux.workerProvider` and `tmux.workerModel` are optional; when set, the extension appends `--provider` / `--model` to the worker `pi` launch command without changing the current orchestrator session model.
- `copyFiles` paths are resolved relative to the repo root and copied into the same relative path inside the worktree by default.
- String entries in `copyFiles` are optional by default, so missing `.env`-style files are skipped quietly.
- Use object form with `required: true` if a copied file must exist.
- `setupCommands` run inside the worktree after creation.
- `worktrees.cleanup: "cleanup-after-landing"` removes the worktree and tmux window after orchestrator landing succeeds.
- `landing.validateCommands` defaults to the repo quality gates (`npm run lint`, `npm run test`, `npm run typecheck`) and runs inside the delegated worktree before landing.
- `landing.commandTimeoutMs` applies to each validation command.
- `landing.maxRebaseAttempts` controls how many times the orchestrator will retry a drifted worker through rebase + validation + landing before leaving it in an explicit attention state.
- `rerunSetupOnReuse: true` re-applies file copies and setup commands when an existing worktree is reused.

Environment overrides:

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
