# Operator TUI smoke + quality gate

Manual checklist for the tmux-free, agent-friendly orchestration surface. Operator README:
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

### 1. Enter goal mode from the parent model

1. Use an open, already-decomposed epic with at least two ready children.
2. During an active parent-model turn, have the parent call
   `beadwork_start_goal({ epic_id: "<epic-id>" })`.
3. Confirm the tool reports `started` or `resumed` and `queued_follow_up`, then the queued continuation
   presents the same manager-only run guidance as `/bw run <epic-id>`.
4. Confirm no ticket or child starts in the goal-entry tool call itself.

Pass: one queued continuation, persisted goal/scope/review policy, and no implicit dispatch. Fail:
synchronous epic execution, an inferred epic, ticket mutation, or automatic planning-to-run entry.

### 2. Persistent fleet surface and idle boundary

1. Orchestrate at least two children, including canonical `agent: "worker"`.
2. Without first opening `/minions`, confirm the fleet widget appears above the editor and the parent
   input remains focused.
3. Exercise meaningful activity (for example a tool call and a child question). Confirm the widget
   shows useful tool/waiting/settling state rather than `turn N`.
4. Open `/minions`; confirm drill-down still works while the ambient widget remains usable.
5. Resize to a narrow terminal and confirm every line remains bounded and retains useful identity.
6. Let the final children settle close together while the parent is idle.

Pass: the widget updates without transcript spam or focus capture, clears after the final active child,
and one final coalesced packet says `Group idle` and tells the parent to inspect/decide. It must not say
the goal completed or mutate Beadwork. Fail: one wake per final child, spawn children in group packets,
or idle presented as success.

### 3. `/bw run` does not spawn tmux

1. Confirm `tmux ls` (or Activity Monitor / `ps`) before the run; note existing sessions.
2. `/bw run <epic-id>` and orchestrate work.
3. Re-check tmux.

Pass: no new tmux session/window/pane from beadwork. Children are in-process minions on this
Pi process. Fail: `tmux.workerCommand`, a worker pane, or a worktree checkout created by
beadwork.

### 4. Theme and lifecycle invalidation

1. With an active widget, switch between visibly different themes or otherwise invalidate rendering.
2. Confirm colors update without stale ANSI, overflow, or terminal-control payloads.
3. Start another active child, then exercise `/reload` (and, when relevant, `/new` or resume/fork).

Pass: the old widget clears, stale sessions do not update it, and the replacement session owns any new
widget. Record terminal width, theme transition, lifecycle action, and observed result in the issue
handoff.

### 5. `/bw run --workers` rejects

```text
/bw run <epic-id> --workers 2
```

Pass: error, no inject, no children. Same for `--until`, `--max-cycles` / `--maxCycles`,
`--no-spawn` / `--noSpawn`, `--dry-run` / `--dryRun`.

## Related automated coverage

- Grep/import tripwire: `src/__tests__/unit/runtime-removal.test.ts`
- Integrated agent-friendly acceptance (scripted parent and fake child sessions, no paid model):
  `src/__tests__/e2e/in-process-agent-friendly.test.ts`
- On e2e failure the shared in-process harness dumps persisted goal/scope state, prompt appendix, packets,
  last fleet snapshot, `bw ready` / `bw show`, child tools, and removed-symbol probes. Diagnostics remain
  harness-only, not production telemetry.
