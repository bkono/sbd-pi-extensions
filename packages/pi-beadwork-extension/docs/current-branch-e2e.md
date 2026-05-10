# Current-branch swarm e2e smoke scripts

These scripts exercise deterministic current-branch swarm workflows without paid model calls. They build isolated temporary git repositories, use real `git` and `bw` commands when available, and simulate workers/reviewers/coordinators with fixture prompts and assertions.

Run from the repository root:

```sh
npm run e2e:current-branch-delegate -w @solvedbydev/pi-beadwork-extension
npm run e2e:current-branch-swarm -w @solvedbydev/pi-beadwork-extension
npm run e2e:worktree-preservation -w @solvedbydev/pi-beadwork-extension
npm run e2e:current-branch-all -w @solvedbydev/pi-beadwork-extension
```

Artifact directories are timestamped under `packages/pi-beadwork-extension/tmp/`, for example `tmp/e2e-current-branch-swarm/<run-id>/`. Each run writes `summary.json`, `events.jsonl`, command logs, registry/BW/git snapshots, generated prompts, validation outputs, and `report.md`.

The deterministic swarm script covers current-branch two-worker completion, dirty checkout tolerance, commit attribution with and without ticket ids, review triage, crash replacement, validation fix-forward, idempotency, config overrides, and default-flip readiness through an explicit current-branch override. The worktree script proves `workerExecution.mode = "worktree"` still uses a linked worktree and reaches `landed`.

On failure, the console prints the artifact directory and report path. Start with `report.md`, then inspect `events.jsonl` and `commands/*.json` for exact command stdout/stderr and timings.
