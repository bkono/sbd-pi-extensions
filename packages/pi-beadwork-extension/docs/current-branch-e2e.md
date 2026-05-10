# Current-branch e2e smoke scripts

The smoke scripts exercise current-branch orchestration behavior in deterministic fixture
repositories. They create timestamped throwaway git repos and run real `git` and `bw` commands.
The delegate and worktree-preservation scenarios now drive the real launch/inspection paths with a
scripted fake worker command: `runBoundedEpicLoop`/`launchTicketWorker` write the worker runtime,
the fake tmux backend executes the generated worker script, and `inspectWorkerRuntime` performs
current-branch verification or worktree validation/fast-forward landing. Reviewer/coordinator-heavy
swarm checks remain deterministic fake-command coverage. The console stays short; the artifact
directory is the source of truth for debugging.

The default smoke path does **not** need LLM credentials. The scripts from `sbdpi-qmd.5.6` do not
implement a real-agent mode, and `PI_BEADWORK_E2E_REAL_AGENT=1` is not read by these scripts today.
Do not set it expecting real workers or reviewers to launch.

For operator conventions that the fixtures assert, see
[`current-branch-mode.md`](./current-branch-mode.md) and
[`worker-conventions.md`](./worker-conventions.md).

## Run deterministic fake-worker/fake-reviewer mode

Run from the repository root:

```sh
npm run e2e:current-branch-delegate -w @solvedbydev/pi-beadwork-extension
npm run e2e:current-branch-swarm -w @solvedbydev/pi-beadwork-extension
npm run e2e:worktree-preservation -w @solvedbydev/pi-beadwork-extension
npm run e2e:current-branch-all -w @solvedbydev/pi-beadwork-extension
```

The package scripts map exactly to:

| npm script | File | Coverage |
| --- | --- | --- |
| `e2e:current-branch-delegate` | `scripts/e2e-current-branch-delegate.mjs` | `runBoundedEpicLoop` launches one current-branch worker in the repo root through the real launch path; a scripted worker commits/closes the ticket, then `inspectWorkerRuntime` verifies attribution. |
| `e2e:current-branch-swarm` | `scripts/e2e-current-branch-swarm.mjs` | Two current-branch workers share one checkout, tolerate unrelated dirty state, prove commit/comment attribution, run reviewer triage, replace a crashed worker, create fix-forward validation work, and prove idempotency. |
| `e2e:worktree-preservation` | `scripts/e2e-worktree-preservation.mjs` | `launchTicketWorker` creates a linked worktree, the scripted worker commits/closes there, and `inspectWorkerRuntime` exercises validation plus the real fast-forward landing helper to reach `landed`. |
| `e2e:current-branch-all` | `scripts/e2e-current-branch-all.mjs` | Runs the three deterministic scripts above in order. |

The scripts use the seed `sbdpi-qmd.5.6` by default. Override only when you need to label a run:

```sh
PI_BEADWORK_E2E_SEED=my-investigation \
  npm run e2e:current-branch-all -w @solvedbydev/pi-beadwork-extension
```

## Default-mode and explicit worktree checks

Since `f9fe235`, the built-in package default is `workerExecution.mode = "current-branch"`.
The delegate and swarm smoke scripts assert that package default directly: they resolve worker
mode without `PI_BEADWORK_WORKER_EXECUTION_MODE` and without a `workerExecution.mode` fixture
override. In `scenario-result.json`, delegate records that resolved default under `resolvedMode`;
swarm records it under `resolved`. In both cases, the value should resolve to `current-branch`
with source `default`.

Earlier smoke runs used an explicit `.pi/beadwork-config.json` override with
`workerExecution.mode: "current-branch"` to emulate this default. That pattern is no longer how
the default-mode assertions run. The swarm scenario still includes a `configToCurrentBranch`
diagnostic for that compatibility path.

The worktree-preservation script is the explicit fallback coverage. It writes
`workerExecution.mode: "worktree"` and `worktrees.cleanup: "keep"`, then proves the worker checkout
is not the repo root and the linked worktree appears in `git worktree list`.

## Artifact directories

Each run writes a timestamped artifact directory under the package `tmp/` directory:

```text
packages/pi-beadwork-extension/tmp/<artifact-group>/<run-id>/
```

Current artifact groups are:

- `e2e-current-branch-delegate`
- `e2e-current-branch-swarm`
- `e2e-worktree-preservation`

A run id looks like `YYYYMMDDhhmmss-<pid>-<scenario>`, for example:

```text
packages/pi-beadwork-extension/tmp/e2e-current-branch-swarm/20260509021139-12345-current-branch-swarm/
```

The fixture repository for that run is inside the artifact directory at `repo/`. Do not edit or
clean it during failure analysis; it is preserved intentionally.

## How to read artifacts

Start with `report.md`, then use `summary.json` to jump to the exact files.

| Artifact | Produced path | How to use it |
| --- | --- | --- |
| Markdown report | `report.md` | Human-readable status, run id, artifact dir, covered scenario ids, command list, failures, and top-level artifact locations. Attach this first in bug reports. |
| Summary | `summary.json` | Machine-readable run record: `status`, `runId`, `seed`, `repoPath`, `coverage`, `commands`, `timings`, `artifacts`, `failures`, and optional `error`. Use command entries here to find stdout/stderr logs. |
| Event stream | `events.jsonl` | Chronological JSON lines for `run.start`, `step`, `command`, `registry.snapshot`, `run.error`, and `run.finish`. Use it to reconstruct what happened before a failure. |
| Command records | `commands/*.json` | One JSON record per real or fake command with `label`, `cwd`, command/args or fake kind, `exitCode`, duration, and stdout/stderr paths. |
| Command stdout/stderr | `commands/*.stdout.log`, `commands/*.stderr.log` | Raw command output. For `bw` or `git` failures, these logs usually contain the actionable error. |
| Registry snapshots | `snapshots/*-registry.json` | Worker registry snapshots at named milestones such as `after-orchestrator-launch`, `after-verify`, `before-poll-1`, `after-poll-2`, `final`, or `after-landing`. Check worker ids, modes, checkout paths, launch heads, commits, and statuses. |
| Beadwork snapshots | `commands/*bw-*.json` plus stdout logs | `snapshotBwCli()` records `bw ready --json`, `bw show <id> --json`, and `bw history <id> --json` as command logs. Read the matching stdout logs for ticket state and comments. |
| Git snapshots | `commands/*-git-status.json`, `commands/*-git-log.json`, `commands/*-git-head.json`, `commands/*-git-show-stat.json` plus stdout logs | `snapshotGit()` records status, recent log, current HEAD, and stat output. Use these for dirty checkout, attribution, and landing assertions. |
| Prompt artifacts | `prompts/*.md` | Captured fake reviewer/coordinator prompts in swarm-style checks, including attribution reviews, scope reviews, triage, crash recovery, validation fix-forward, and worktree landing review. Launch-driven scenarios also preserve generated worker handoff files under the worker runtime directory in `repo/.pi/beadwork/workers/runtime/`. |
| Validation output | `validation/*.json` plus referenced command logs | Validation records for commands such as `delegate-npm-test`, `alpha-test`, `beta-test`, `final-npm-test`, `final-npm-lint`, and `worktree-npm-test`. Open the referenced stdout/stderr paths when validation fails. |
| Scenario result | `scenario-result.json` | Scenario-specific data: defaults/resolved mode (`resolvedMode` for delegate, `resolved` for swarm and worktree), ticket ids, workers, commits, dirty-state evidence, triage decisions, or worktree list output. |
| Idempotency result | `idempotency-result.json` | Swarm-only proof that a repeated remediation key is not duplicated. |

Some harness helpers can write `snapshots/*-bw-ready.json`, `snapshots/*-bw-show-<id>.json`, and
`snapshots/*-bw-history-<id>.json`, but the current scripts use the real `bw` CLI snapshot helper.
For the scripts listed above, beadwork snapshots are therefore found in `commands/` records and
stdout logs, not standalone `snapshots/*-bw-*.json` files.

## Failure preservation and bug reports

On failure, the script sets a non-zero exit code and still writes `summary.json`, `report.md`,
`events.jsonl`, and all artifacts produced before the failing step. The console prints the artifact
directory plus the report path. Preserve that whole directory when filing an issue.

Recommended bug report payload:

1. `report.md`
2. `summary.json`
3. `events.jsonl`
4. the failing `commands/*.json` record and its `.stdout.log` / `.stderr.log`
5. relevant `snapshots/*-registry.json`, `prompts/*.md`, and `validation/*.json`
6. the entire artifact directory as an archive when the failure involves ordering, attribution, or
   checkout state

## Troubleshooting guide

| Symptom | Start here | Why |
| --- | --- | --- |
| Script exits before fixture setup completes | `summary.json`, `events.jsonl`, `commands/*git-init*.stderr.log`, `commands/*bw-init*.stderr.log` | Confirms whether `git` or `bw` was missing or failed during initialization. |
| A `bw` command fails | failing `commands/*bw-*.json` and matching stdout/stderr logs | Shows the exact `bw` subcommand, exit code, and JSON/text output. |
| Worker did not run in the expected checkout | `snapshots/*-registry.json`, `scenario-result.json`, `commands/*launch-head*.stdout.log` | Registry snapshots contain worker mode/path metadata; launch-head logs show the git head used for attribution. |
| Dirty checkout assertion fails | `commands/*dirty-status-at-launch*.stdout.log`, `prompts/dirty-state-remediation.md` | Shows the intentionally dirty files and the remediation prompt. |
| Commit attribution fails | `commands/*attribution-log*.stdout.log`, `commands/*history-attribution*.stdout.log`, `scenario-result.json` | Shows commit messages and beadwork comments used as attribution evidence. |
| Reviewer triage or fix-forward behavior looks wrong | `prompts/reviewer-triage.md`, `prompts/validation-failure-fix-forward.md`, `scenario-result.json`, `idempotency-result.json` | Contains the deterministic triage decisions and remediation/idempotency data. |
| Validation fails | `validation/*.json`, referenced `commands/*validation-*.stdout.log`, referenced `commands/*validation-*.stderr.log` | Validation JSON points at raw logs for the failing command. |
| Worktree preservation fails | `commands/*worktree-launch-git*.stderr.log`, `commands/*git-worktree-list*.stdout.log`, `snapshots/after-landing-registry.json`, `scenario-result.json` | Confirms linked worktree creation, checkout path, real `git merge --ff-only` landing, and landed status. |
| Runtime mode resolution behaves unexpectedly | `scenario-result.json`, `default-mode-resolution.json`, `summary.json`, and `repo/.pi/beadwork-config.json` when present | Shows `defaultMode`, delegate `resolvedMode`, swarm `resolved`, and any explicit fixture config used for the run. |

Keep console output concise in CI logs. Link or upload the artifact directory for the exhaustive
record.
