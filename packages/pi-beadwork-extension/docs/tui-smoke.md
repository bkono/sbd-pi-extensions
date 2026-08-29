# Cutover TUI smoke + quality gate

Manual checklist for the published tmux-free cutover. Operator README:
[../README.md](../README.md). This file does not replace it.

Do **not** reintroduce tmux workers, shims, or supervisor flags to make this pass.

## Repo quality gate

CI and local sign-off for this package/repo:

```sh
npm run lint && npm run test && npm run typecheck && npm run build
```

Package-scoped `npm run lint -w @solvedbydev/pi-beadwork-extension` (and test/typecheck) is
fine while iterating. The published cutover gate is the four-command chain above from the
repo root.

## TUI smoke

Use a persistent `pi` tui host with **both** beadwork and minions registered. Do not use
`--print` / json.

### 1. Parent stays interactive

1. `/bw run <epic-id>` on an open epic with descendants.
2. Let the parent `orchestrate` at least one implementation child.
3. While the child is running, keep typing in the parent tui (a short question or `/minions`).

Pass: the parent prompt remains usable. Fail: parent blocked until the child finishes, or a
tmux pane appears.

### 2. One packet after several idle settlements

1. Orchestrate two or more children.
2. Leave the parent **idle** (no in-flight turn).
3. Let several children settle close together.

Pass: **one** parent turn / lifecycle packet covering the idle settlements (coalesced), not
one turn per child. Fail: a parent turn per settlement, or no packet at all.

### 3. `/bw run` does not spawn tmux

1. Confirm `tmux ls` (or Activity Monitor / `ps`) before the run; note existing sessions.
2. `/bw run <epic-id>` and orchestrate work.
3. Re-check tmux.

Pass: no new tmux session/window/pane from beadwork. Children are in-process minions on this
Pi process. Fail: `tmux.workerCommand`, a worker pane, or a worktree checkout created by
beadwork.

### 4. `/bw run --workers` rejects

```text
/bw run <epic-id> --workers 2
```

Pass: error, no inject, no children. Same for `--until`, `--max-cycles` / `--maxCycles`,
`--no-spawn` / `--noSpawn`, `--dry-run` / `--dryRun`.

## Related automated coverage

- Grep/import tripwire: `src/__tests__/unit/runtime-removal.test.ts`
- In-process e2e (scripted parent, no paid LLM): `src/__tests__/e2e/`
- On e2e failure the 4.2 harness dumps packets, fleet, `bw ready` / `bw show`, child tools,
  and removed-symbol probes. That dump is harness-only, not production telemetry.
