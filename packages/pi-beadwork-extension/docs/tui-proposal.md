# Beadwork TUI proposal

Date: 2026-04-19

## Goal

Replace the current notify-driven `/bw ...` command multiplexer with a real pi-native TUI workflow that:

- gives first-class worker visibility and actions
- makes ready work browsable and drillable
- supports delegating tickets and running epics from a modal instead of raw argument strings
- supports multiple active epic runs in the same parent session
- improves slash-command autocomplete with dedicated `bw:*` commands while preserving `/bw ...` compatibility

This proposal is grounded in:

- the current `packages/pi-beadwork-extension` implementation
- pi extension APIs in `docs/extensions.md` and `docs/tui.md`
- the current `pi-subagents` extension patterns for overlays, clarify UIs, live status, widgets, and slash-command autocomplete

---

## What exists today in the beadwork extension

### Current strengths

The extension already has the hard backend pieces needed for a richer UI:

- typed beadwork CLI adapter in `src/bw.ts`
- worker registry + summaries in `src/registry.ts`
- durable worker diagnostics in `src/worker-diagnostics.ts`
- tmux/worktree orchestration in `src/orchestrator.ts`
- worktree cleanup primitive in `src/worktree.ts`
- session statusline in `src/statusline.ts`
- persisted session state in `src/session-state.ts`

The worker/orchestration surface is already good enough for a UI to drive:

- `launchTicketWorker(...)`
- `inspectWorkerRuntime(...)`
- `requestWorkerLanding(...)`
- `stopWorkers(...)`
- `runBoundedEpicLoop(...)`
- `cleanupTicketWorktree(...)`

### Current UX limitations

The UX bottleneck is almost entirely at the command/TUI layer.

Today:

- all slash UX is behind one `pi.registerCommand(COMMAND_NAME, ...)` handler in `src/index.ts`
- there is no `getArgumentCompletions(...)`
- there is no `ctx.ui.custom(...)` usage in the beadwork extension
- most views are `ctx.ui.notify(...)` text dumps from `src/commands.ts`
- the only persistent UI is the footer status from `src/statusline.ts`

So the extension is operationally capable, but operator ergonomics are still text-command-heavy.

### Biggest architectural blocker for multi-epic runs

The current session model is single-scope and effectively single-run:

- `SessionState.scope` is a single ticket/epic/none
- `SessionState.runOptions` is singular
- background supervision in `src/index.ts` assumes at most one active epic run
- `buildBeadworkPromptAppendix(...)` in `src/prompt.ts` assumes one current scope

That is fine for `/bw run <one-epic>`, but it is the main thing that must change for “run on multiple epics simultaneously”.

---

## Relevant pi APIs and patterns

## Pi APIs that directly support this work

From pi’s extension API/docs, the important primitives are:

- `pi.registerCommand(name, { description, getArgumentCompletions, handler })`
- `ctx.ui.custom(...)` for custom full-screen or overlay components
- `ctx.ui.custom(..., { overlay: true, overlayOptions })` for modal overlays
- `ctx.ui.setStatus(...)` for footer state
- `ctx.ui.setWidget(...)` for persistent above-editor summaries
- `pi.registerMessageRenderer(...)` for richer result rendering if desired
- `ctx.ui.notify(...)`, `confirm(...)`, `input(...)`, `editor(...)` for simple dialogs

For TUI construction, pi already documents and ships reusable component patterns:

- `SelectList`
- `SettingsList`
- overlay modals
- bordered loaders
- searchable pickers
- keyboard-driven custom components

This means the beadwork upgrade does **not** need an external TUI stack. It should be built with pi-native overlays and components.

## Patterns from `pi-subagents` worth copying

`pi-subagents` is the best nearby example of “smart worker TUI integrations” in this ecosystem.

### 1. Dedicated slash commands, not one parser command

`pi-subagents/slash-commands.ts` registers:

- `/agents`
- `/run`
- `/chain`
- `/parallel`
- `/subagents-status`

and uses `getArgumentCompletions(...)` for agent-name completion.

That is a much better UX than a single `/subagent ...` parser command.

### 2. Overlay-first modal UX

`pi-subagents` opens real overlays with:

```ts
ctx.ui.custom(..., {
  overlay: true,
  overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" },
})
```

That is exactly the right shape for beadwork’s:

- worker manager
- ready issue browser
- run launcher
- delegate/land/cancel confirmation flows

### 3. A read-only status modal with auto-refresh

`SubagentsStatusComponent` is a strong model for a worker-status modal:

- periodic refresh timer
- selection retention across refreshes
- list pane + detail pane
- simple keybindings
- clean `dispose()` lifecycle

That pattern maps almost 1:1 to `/bw workers` becoming a real modal.

### 4. Clarify UI before execution

`ChainClarifyComponent` shows a more advanced pattern:

- preview/edit before launch
- keyboard discoverability in footer hints
- background toggle in the modal itself
- mode-aware rendering for single/parallel/chain

For beadwork, the analogous clarify modals are:

- delegate ticket
- run epic
- run multiple epics
- optional worker cleanup / land / cancel confirmations

### 5. Persistent lightweight widget + richer modal

`pi-subagents/render.ts` uses `ctx.ui.setWidget(...)` for quick background visibility while keeping full detail in overlays.

Beadwork should do the same:

- keep the footer statusline
- add a compact widget for active runs/workers/held items
- reserve the modal for drill-in and action taking

---

## Proposal: target UX

## Top-level interaction model

### `/bw`
Running bare `/bw` should open the main Beadwork dashboard overlay instead of just printing status.

That dashboard should replace the current common sequence of:

- `bw ready`
- inspect the list
- `/bw engage <epic-id>` or `/bw engage`
- `/bw run ...` or `/bw delegate ...`

More specifically:

- if beadwork is available in the repo, `/bw` should open the dashboard even when the current session is still neutral/not engaged
- in that neutral state, the dashboard should land on the issue explorer with a ready filter so the operator can choose an epic, scope to it, engage globally, or directly launch run/delegate flows
- if beadwork is truly unavailable (`no-git`, `no-bw`, or similar), `/bw` can fall back to the current status/help text
- if the repo is beadwork-capable but not initialized yet, `/bw` should prefer an onboarding/status view over a dead-end fallback

### Dedicated slash aliases

Keep `/bw ...` for backward compatibility, but also register dedicated commands:
- `/bw:status`
- `/bw:ready`
- `/bw:list`
- `/bw:show`
- `/bw:scope`
- `/bw:workers`
- `/bw:delegate`
- `/bw:land`
- `/bw:cancel`
- `/bw:cleanup`
- `/bw:run`
- `/bw:off`
- `/bw:adopt`
Why both?
- `/bw ...` preserves existing muscle memory
- `/bw:ready`, `/bw:list`, `/bw:run`, etc. give native slash-command autocomplete before the user types arguments
- `/bw` itself can expose subcommand completions via `getArgumentCompletions(...)`

---

## Proposed TUI surfaces

## 1. Beadwork dashboard overlay
Primary command: `/bw`

Purpose:
- one operator entry point
- replace the current `ready -> engage -> run/delegate` command dance
- summarize current scope, current single-epic run state, and workers needing attention
- route into deeper screens without requiring the user to exit the TUI to act

Suggested layout:

- header: repo + activation/session mode + current scope
- tabs:
  - Issues
  - Workers
  - Run
  - Scope
  - Actions
  - default tab: `Issues`
- footer: keybindings
Suggested first-pass keybindings:
- `←/→` or `tab` — switch tab
- `↑/↓` — move selection
- `enter` — open detail / drill in
- `backspace` or `h` — walk back up one level in the issue explorer
- `f` — change issue filters/status view
- `g` — engage beadwork globally without changing scope
- `s` — scope to selected issue/epic and engage if currently neutral
- `d` — delegate selected ticket
- `r` — run selected epic
- `l` — land selected worker
- `c` — cancel selected running worker
- `x` — cleanup selected landed worker when cleanup policy is `keep`
- `esc` — close
This should be implemented as a modal overlay, not as a replacement editor.

## 2. Issue explorer (ready-first, not ready-only)

Primary commands:
- `/bw:ready`
- `/bw:list`
- Issues tab inside `/bw`

Purpose:

- act as the default browsing surface for beadwork issues
- open in a ready-filtered view by default, because ready work is the most common operator starting point
- allow walking into epics and tasks, and walking back out again
- support scoping/engaging, running epics, delegating tickets, and triaging non-ready work without leaving the TUI

Behavior:

- default mode is `ready`, but the explorer should support switching filters/status views (`ready`, `open`, `in_progress`, `blocked`, `closed`, `deferred`, `all`, plus existing list filters where useful)
- breadcrumb state should allow moving both down and back up (`repo -> epic -> task`, then back out)
  - selecting an epic should allow:
  - `enter` to drill into that epic
  - `r` to open the run clarify modal
  - `s` to scope to that epic and engage if needed
  - selecting a task/ticket should allow:
  - `enter` to drill into/show the issue detail
  - `d` to open the delegate clarify modal
  - `s` to scope to that ticket and engage if needed
- there should be an explicit way to clear current scope / return to repo-wide browsing from the explorer

Recommended data sources:
- `adapter.ready(cwd, scopeId?)`
- `adapter.list(cwd, filters)`
- `adapter.show(cwd, id)`
Recommended enhancement:

- `/bw:ready` should open this explorer with the ready filter preselected
- `/bw:list` should open the same explorer with broader status/filter controls surfaced immediately
- the dashboard should land here even before session engagement, so operators can choose the right epic before activating beadwork for the run
## 3. Worker manager overlay

Primary commands:

- `/bw:workers`
- Workers tab inside `/bw`

Purpose:

- turn `/bw workers` from a text dump into a real worker operations console

Base display should reuse current worker diagnostics model:

- runtime status
- validation state/detail
- review state/detail
- landing state/detail
- cleanup state
- next follow-up guidance
Those are already normalized by `inspectWorker(...)` in `src/worker-diagnostics.ts`.

Recommended presentation:

- group workers by their current run/epic when they were launched as part of a run
- keep separately delegated/manual workers visible as their own section
- make it obvious which workers belong to the currently scoped epic versus background leftovers from earlier work

Suggested actions by state:
- `running` / `launching`
  - `c` cancel worker via `stopWorkers({ workerIds: [...] })`
  - `enter` detail view with log/tmux/runtime paths
- `held`
  - `l` request landing via `requestWorkerLanding(...)`
  - `c` cancel/discard worker process if still active
- `attention`
  - `enter` show full detail and next-action guidance
  - optionally `l` if landing retry is still valid
- `landed` + cleanup policy `keep`
  - `x` cleanup worktree/runtime/tmux artifacts manually
- `failed`
  - `enter` detail, logs, recovery hints
Important note: the backend already supports landing and stopping. Manual cleanup is the one operator action that needs a small action-layer wrapper around `cleanupTicketWorktree(...)`.

## 4. Run manager overlay (single-epic first)

Primary commands:
- `/bw:run`
- Run tab inside `/bw`

Purpose:

- show the state of the current single epic run model
- make bounded run state inspectable without relying on notifications
- let the operator launch, inspect, pause, and resume the currently selected/scoped epic flow

For the first implementation, this should stay aligned with the current backend model:

- one active supervised epic run per session
- issue explorer used to choose the epic first
- run panel focused on the currently selected/scoped/currently running epic

Per-run view should show:
- epic id/title
- run state: running / paused-blocked / paused-empty / paused-attention / complete
- worker counts
- last cycle number
- current run options (`workers`, `until`, etc.)
- recent cycle snapshots / stop reason

Run actions:

- `r` start a run for the selected/scoped epic
- `p` pause/stop supervising the current run
- `s` set scope to the run epic
- `enter` open run detail with recent cycle summaries
## 5. Delegate clarify modal

Primary entry points:
- `d` on ready ticket
- `/bw:delegate <ticket-id>`
Purpose:
- make delegation launch explicit and inspectable
- allow one-off model override without remembering raw syntax
Suggested fields:
- ticket id + title
- parent epic
- worker model override
- landing policy summary (`auto` vs `deferred`)
- cleanup policy summary (`keep` vs `cleanup-after-landing`)
- expected validation/review behavior
- launch in background (always yes in practice, but explicit in UI copy)
Backend mapping:
- `ensurePrime(...)`
- `launchTicketWorker(...)`
## 6. Run clarify modal

Primary entry points:
- `r` on epic
- `/bw:run <epic-id>`
Purpose:

- configure run options without remembering flags

Suggested fields:
- epic id + title
- `workers`
- `until`
- `maxCycles`
- `dryRun`
- `noSpawn`
Backend mapping:
- `buildRunOptions(...)`
- `runBoundedEpicLoop(...)`
---

## Future state: multi-epic orchestration (explicitly deferred)

The earlier investigation surfaced useful learnings for a future multi-epic design, but this proposal should not treat that as part of the first actionable implementation.

What we learned:

- the current session model conflates operator scope, prompt scope, and the single active background-supervised run
- a true multi-epic design would likely split operator focus from automation state
- the supervisor would likely need to track multiple active epic runs rather than a single `runOptions` slot

That is worth preserving as future-state guidance, but it is intentionally out of scope for the current implementation plan. The near-term goal is to nail the single-epic TUI and workflows first.

---

## Command and action layer refactor

Before building TUI screens, the extension should extract command-side behavior from `src/index.ts` into reusable actions.

Recommended new layer:

- `actions/status.ts`
- `actions/scope.ts`
- `actions/ready.ts`
- `actions/delegate.ts`
- `actions/workers.ts`
- `actions/run.ts`
- `actions/landing.ts`
- `actions/cleanup.ts`

Why this matters:

- `/bw ...` and `/bw:*` aliases can share the same logic
- TUI button/key actions can call the same implementation
- tests become much easier than testing one giant slash-command parser

The current monolithic command handler in `src/index.ts` is serviceable, but it is the wrong shape for a modal UI.

---

## Slash command strategy

## Backward-compatible command plan

### Keep

- `/bw status`
- `/bw ready`
- `/bw list`
- `/bw workers`
- `/bw delegate ...`
- `/bw run ...`
- etc.

### Add
- `/bw:status`
- `/bw:ready`
- `/bw:list`
- `/bw:workers`
- `/bw:delegate`
- `/bw:run`
- `/bw:land`
- `/bw:cancel`
- `/bw:cleanup`
- `/bw:scope`
### Improve `/bw` itself

Add `getArgumentCompletions(...)` so `/bw ` suggests:
- status
- ready
- list
- workers
- delegate
- land
- run
- scope
- adopt
- off

Then add subcommand-specific completions in the dedicated `bw:*` commands:
- `/bw:run` -> epic ids only
- `/bw:delegate` -> ready non-epic ids
- `/bw:list` -> useful status/filter presets when possible
- `/bw:land` -> held worker ticket ids or worker ids
- `/bw:cancel` -> active worker ids/ticket ids
- `/bw:scope` -> issue ids

This is the fastest way to fix the autocomplete complaint even before the full modal lands.

---

## Proposed implementation phases

## Phase 1: action extraction + autocomplete aliases
Deliver:
- split command logic out of `src/index.ts`
- add `/bw:*` aliases
- add `getArgumentCompletions(...)`
- keep `/bw ...` compatibility
Why first:
- low risk
- immediately improves UX
- creates the right architecture for the TUI
## Phase 2: dashboard + issue explorer + worker manager

Deliver:

- `/bw` dashboard overlay
- issue explorer as the default tab, with ready-first behavior
- breadcrumb navigation in and back out of epics/tasks
- status/filter switching for triage beyond ready-only work
- worker manager grouped by run/epic where possible
- direct in-TUI actions for scope/engage, delegate, run, land, and cancel

Important constraint:

- this should not ship as a read-only-only release
- the value comes from seeing state and acting on it in the same surface

## Phase 3: clarify modals + single-run panel + cleanup

Deliver:

- delegate clarify modal
- run clarify modal
- single-epic run panel/tab
- scope clear/retarget flows
- cleanup action for landed workers when policy is `keep`
- confirmations, notices, and detail views for logs/runtime paths

Requires:
- small cleanup action wrapper around `cleanupTicketWorktree(...)`
- targeted worker lookup helpers
- current-run helpers shared by slash commands and the TUI

## Phase 4: polish the first actionable release

Deliver:

- keyboard consistency and footer hint polish
- optional persistent widget/status improvements
- test coverage and docs cleanup
- package docs updated to describe the new default `/bw` workflow

## Deferred future phase: multi-epic run state + supervisor v2

This remains a future concern.

Keep the learnings from the investigation, but do not make it a dependency of the first TUI implementation. The immediate goal is to finish the single-epic workflow end-to-end before revisiting session-state and supervisor changes for multiple concurrent epic runs.

---

## Suggested file layout additions

```text
packages/pi-beadwork-extension/src/
  actions/
    status.ts
    scope.ts
    issues.ts
    delegate.ts
    run.ts
    landing.ts
    workers.ts
    cleanup.ts
  tui/
    dashboard.ts
    issue-explorer.ts
    worker-manager.ts
    run-manager.ts
    issue-detail.ts
    delegate-clarify.ts
    run-clarify.ts
    common.ts
  command-aliases.ts
  command-completions.ts
```

The important design choice is to keep TUI rendering separate from orchestration/business logic.

---

## Tests that should accompany this work
## Unit tests
- command alias registration and argument completion behavior
- `/bw` neutral-session behavior: dashboard opens and defaults to the issue explorer instead of dumping text status
- issue explorer state transitions:
  - ready-first default
  - filter/status switching
  - breadcrumb drill-in and walk-back-out behavior
  - scope set / scope clear behavior
- worker action guards:
  - cannot cleanup running worker
  - cannot cleanup before verified/landed state
  - land button enabled only for valid states
  - cancel enabled only for active workers
- single-run action guards and state transitions for the current epic run
- prompt appendix / scope behavior still aligned to the current single-scope model

## Component/input tests

For the new TUI components, at least cover:
- selection movement
- refresh retention of selected worker/current run row
- grouped worker rendering by run/epic where metadata exists
- action enable/disable by state
- drill-in, breadcrumb transitions, and returning to repo-wide browsing

## Integration tests

- `/bw` opens the dashboard overlay in a beadwork-capable repo even before session engagement
- selecting an epic from the issue explorer can scope/engage it and launch the run clarify modal
- selecting a ticket from the issue explorer can launch the delegate clarify modal
- `/bw:run` and `/bw:delegate` use shared action handlers with the dashboard/TUI flows
- worker manager land/cancel/cleanup actions call the shared orchestration layer correctly
- current run panel reflects the active single-epic run state and recent cycle summary

## Deferred future-state tests

When multi-epic support is revisited later, add dedicated migration/supervisor tests then rather than mixing that work into the first TUI milestone.

---

## Recommended scope for the first actionable TUI release

The first ship should include the full operator loop, not just read-only visibility:
1. `/bw:*` alias commands with completions
2. `/bw` dashboard that opens even in neutral sessions
3. issue explorer with ready-first default, breadcrumb navigation, status filters, and scope clear/retarget behavior
4. worker manager with grouping, land/cancel actions, and cleanup for landed workers
5. delegate and run clarify modals
6. current single-epic run panel/tab

And explicitly defer:

- multi-epic supervision/state redesign
- round-robin background orchestration across multiple epics

That gives a workflow-complete first release: open `/bw`, inspect work, choose scope, launch run/delegate, manage workers, and stay in one operating surface.

---

## Bottom line

The current beadwork extension already has enough backend depth to justify a real TUI.

The right implementation path is:
- stop treating `/bw` as one raw parser command
- add dedicated `bw:*` slash commands with autocomplete
- make `/bw` open an actionable dashboard even before session engagement
- use an issue explorer as the default surface, with ready as the default filter rather than the only view
- build worker and run surfaces that let the operator act without leaving the TUI
- keep the first implementation focused on the current single-epic run model
- preserve the multi-epic design learnings as future-state guidance, but defer that redesign until after the single-epic workflow feels solid

Concretely:

- **Issues** should become a drillable explorer with breadcrumb navigation, filter switching, scope/engage actions, and delegate/run launch points
- **Workers** should get a modal like subagents-status, but actionable and grouped by run where possible
- **Delegate/run** should get clarify modals like subagents’ chain clarify flow
- **Run** should model the current single-epic session cleanly first

That gets beadwork from “useful backend with stringly operator UX” to a real pi-native operating surface without overreaching on the first implementation.
