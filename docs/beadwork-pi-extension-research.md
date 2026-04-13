# Beadwork + pi extension research

Date: 2026-04-13

## Goal

Understand the workflow beadwork is trying to teach agents via its prompt chain, then assess how that workflow could be baked deeply into a pi extension in this repo, using a tmux-based worker model first. Future bespoke terminal integrations (for example Ghostty or WezTerm) can stay possible, but they should not shape the initial architecture or dependency choices.

## Sources reviewed

### Beadwork

- `../../jallum/beadwork/docs/prompts/prompts.md`
- `../../jallum/beadwork/docs/prompts/agents.md`
- `../../jallum/beadwork/docs/prompts/prime.md`
- `../../jallum/beadwork/docs/prompts/start.md`
- `../../jallum/beadwork/prompts/agents.md`
- `../../jallum/beadwork/prompts/prime.md`
- `../../jallum/beadwork/prompts/start.md`
- `../../jallum/beadwork/README.md`
- `../../jallum/beadwork/docs/design.md`
- `../../jallum/beadwork/cmd/bw/prime.go`
- `../../jallum/beadwork/cmd/bw/start.go`
- `../../jallum/beadwork/cmd/bw/ready.go`

### pi extension architecture

- pi docs: `docs/extensions.md`, `docs/sdk.md`, `docs/tui.md`
- pi examples: `examples/extensions/subagent/index.ts`, `examples/extensions/README.md`
- this repo:
  - `packages/pi-answer-extension/src/index.ts`
  - `packages/pi-files-extension/src/index.ts`
  - `packages/pi-om-extension/src/index.ts`
  - `packages/pi-om-extension/src/agents.ts`
  - `package.json`

### Related projects

- `pasky/pi-side-agents`
  - `README.md`
  - `docs/architecture.md`
  - `extensions/side-agents.ts`
  - `skills/agent-setup/SKILL.md`
- `raine/workmux`
  - `README.md`

## Executive summary

Beadwork is not mainly a task runner. It is a durability layer for agent work.

Its core bet is:

1. agents will always lose context,
2. in-context plans are disposable scratch,
3. durable execution state must live in git,
4. the durable unit is the ticket graph,
5. the runtime unit is the worktree-bound worker.

So the workflow beadwork is teaching is:

- ask **how the work should land**,
- materialize any non-trivial plan into **tickets + dependencies**,
- execute from `bw ready`,
- claim a ticket with `bw start`,
- do the work in an isolated worktree,
- land it completely with **commit + close + sync**,
- leave comments as breadcrumbs,
- when delegating, give each sub-agent its own ticket and worktree.

That means beadwork provides the **durable orchestration model**, but not the live worker runtime. By contrast:

- `pi-side-agents` provides a strong **runtime worker launcher** for pi, but its durable source of truth is a local registry, not a ticket graph.
- `workmux` is still useful as a reference for multi-worktree orchestration ideas, but it should not be a near-term dependency.

The clean synthesis is layered:

- **Beadwork** = durable planning / ticket graph / ready queue / landing semantics
- **pi extension** = orchestration brain inside pi
- **tmux** = worker launcher + observability + cleanup substrate
- **child pi sessions** = actual workers

My recommendation is to build a new package in this repo around that layering, with beadwork as the source of truth, tmux as the initial runtime backend, and graceful no-op behavior when beadwork is not present or not initialized in the current repo.

---

## What workflow beadwork is actually encouraging

## 1. The boot chain matters

Beadwork’s prompt system is deliberately split into:

1. `agents.md` boot loader
2. `prime.md` mental model
3. `start.md` point-of-action briefing

The minimal always-on instruction is effectively:

- always run `bw prime` before starting work,
- committing / closing / syncing are part of completion.

That is important because beadwork does **not** try to cram all workflow rules into a tiny always-on instruction file. Instead it teaches an agent to fetch live workflow context dynamically.

## 2. The central problem is context loss, not issue tracking

The most important sentence in the whole system is the one repeated in different forms:

- compaction erases context,
- plans in context die,
- tickets in git survive.

So beadwork is not arguing “tickets are good because PMs like them.”
It is arguing “tickets are good because they survive memory loss.”

That framing changes agent behavior:

- planning in-context is fine,
- but before execution, plans must be materialized into durable tickets.

## 3. The first decision is delivery level

Beadwork’s strongest prompt insight is the delivery question:

> How should this land?

It teaches three modes:

- **Quick fix** → no ticket, working tree is fine
- **Branch/PR** → create ticket first, then worktree
- **Multi-step** → create epic + children + dependencies

This is crucial. The system is intentionally not “every change always gets a ticket.”
Instead it uses a user-facing decision to deterministically select the workflow level.

That gives the orchestrator a very clear first step:

1. ask how the user wants the work delivered,
2. choose the workflow tier,
3. only then start execution.

## 4. Plans are scratch, tickets are the durable execution graph

For multi-step work, beadwork wants the agent to:

1. create an epic,
2. create a child task for each step,
3. wire dependencies,
4. use `bw ready` as the execution loop.

This means the true orchestrator state is not an internal todo list or a hidden planning block. It is the beadwork issue graph.

Operationally, the graph looks like this:

- **epic** = container / umbrella objective
- **child tasks** = executable units
- **dependencies** = ordering constraints
- **comments** = breadcrumbs / progress notes / cross-session memory

So the orchestrator does not hold the project plan in memory. It keeps re-reading the durable graph and executing the next unblocked unit.

## 5. `bw ready` is the execution loop

This is subtle but very important.

Beadwork does not want the agent to hold a long linear plan in its head and walk it manually.
It wants the agent to repeatedly ask the durable system:

- what is ready now?

`bw ready` is therefore the practical “scheduler view” of the graph.

That means a beadwork-aware orchestrator should not merely know how to create tickets. It should center its loop around:

- inspect ready queue,
- pick ready work,
- claim / start it,
- land it,
- refresh ready queue.

## 6. `bw start` is the claim + briefing boundary

`bw start <id>` is where a worker crosses from planning into execution.

From the implementation and prompt template:

- it marks the issue `in_progress`,
- assigns it (default from `git user.name`),
- prints the issue summary / description / comments,
- prints issue-type-specific landing instructions.

The `start.md` rules matter:

- **epics** are containers; the worker should go through children via `bw ready`
- **tasks / bugs** get explicit landing instructions
- the model is **one ticket, one commit**

So `bw start` is effectively a worker bootstrap primitive.
A child worker that sees only `bw start` output should still know how to proceed.

## 7. Worktrees are not optional in delegated work

Prime’s workflow is explicit:

1. create worktree
2. `bw start <id>`
3. do work
4. commit → `bw close <id>` → `bw sync`
5. clean up worktree

And delegation guidance is even stronger:

- each delegated task gets its **own worktree**,
- each delegated task should get its **own ticket first**,
- the orchestrator must include workflow steps in the handoff,
- the orchestrator must verify the work landed.

So in beadwork’s mental model, a worker is not just “an agent.”
A worker is:

- a ticket-scoped unit,
- running in its own worktree,
- with explicit landing semantics.

## 8. Landing is part of doing, not a separate cleanup phase

This is repeated across prompts and onboarding text.

The unit of done is not:

- “the code change exists somewhere.”

The unit of done is:

- committed,
- ticket closed,
- synced,
- optionally worktree cleaned up.

That matters a lot for integration design. Any pi extension that “supports beadwork” but stops at spawning workers is only solving half the problem.

A good beadwork-aware extension needs to care about the full lifecycle:

- start,
- work,
- land,
- verify.

---

## The beadwork orchestrator model, made explicit

Reading the prompt chain as a whole, the intended operating model looks like this:

### Parent orchestrator

Responsibilities:

- ask delivery-level question,
- inspect repo hygiene / dirty state,
- detect whether beadwork is even configured here,
- read `bw prime` when beadwork is active,
- create epic / tasks / deps when needed,
- select work from `bw ready`,
- decide whether to do the work itself or delegate,
- for delegation, create a ticket per delegated task first,
- create a worktree per worker,
- hand each worker the exact `bw start`-driven workflow,
- verify work landed,
- continue the graph.

### Worker

Responsibilities:

- operate inside one worktree,
- claim one ticket with `bw start <id>`,
- make the change,
- commit referencing the ticket,
- close ticket,
- sync,
- report back.

### Durable state

Lives in beadwork’s git branch / issue graph:

- open / in_progress / closed / deferred
- parent-child structure
- dependencies
- comments
- due / deferred metadata

### Runtime state

Lives outside beadwork proper and needs a launcher/orchestrator:

- which worker process is running
- which worktree it owns
- which tmux window/pane it lives in
- whether it is waiting / failed / finished
- where its logs / backlog are

That split is the most important architectural insight for a pi extension.

Beadwork already solves durable planning state.
The extension should solve runtime worker orchestration.

---

## How this lines up with `pi-side-agents`

## What `pi-side-agents` already gets right

`pi-side-agents` is conceptually very close to beadwork’s worker model.

It already gives you:

- a command to spawn a child agent asynchronously,
- one child per worktree,
- one tmux window per child,
- runtime registry + status model,
- backlog capture,
- parent/child handoff prompt generation,
- lifecycle tools for parent orchestration:
  - `agent-start`
  - `agent-check`
  - `agent-wait-any`
  - `agent-send`
- project-local start/finish scripts,
- statusline visibility.

This matches beadwork’s worker isolation story extremely well.

## Where `pi-side-agents` differs from beadwork

The main differences are about **source of truth** and **workflow semantics**.

### `pi-side-agents` source of truth

Its durable-ish runtime state is in:

- `.pi/side-agents/registry.json`
- `.pi/side-agents/runtime/...`
- worktree locks

That is excellent for process management, but it is not the same as a durable project work graph.

### Beadwork source of truth

Its durable state is:

- the ticket graph on the `beadwork` branch
- plus comments / dependencies / statuses

That means `pi-side-agents` is good at “there is a child process doing something,” while beadwork is good at “this exact unit of work exists, is blocked/unblocked, and survives compaction.”

## The key synthesis

The best combination is not to replace beadwork with side-agents semantics.
It is to make side-agent runtime state **subordinate** to beadwork ticket state.

In other words:

- the side-agent registry says **who is currently running where**,
- beadwork says **what the work is and what state it is in**.

## Specific integration opportunities from `pi-side-agents`

### 1. Reuse its worker lifecycle shape

The `pi-side-agents` lifecycle maps nicely to beadwork tickets:

- allocating worktree
- spawning terminal session
- running
- waiting_user
- failed / crashed / done

A beadwork extension can keep a similar runtime state machine, but keyed by ticket ID.

### 2. Reuse its handoff approach

`pi-side-agents` already builds a kickoff prompt and can include a parent conversation summary.
For beadwork, that kickoff should become more structured:

- ticket ID
- worktree path / branch
- required first action: `bw start <id>`
- issue summary / comments / deps
- explicit landing checklist

### 3. Replace branch naming with beadwork naming

`pi-side-agents` uses branches like:

- `side-agent/<agentId>`

Beadwork prime explicitly teaches a branch naming convention like:

- `<ticket-id>/<short-description>`

A beadwork-native extension should adopt the beadwork convention, because it ties the branch directly to the durable work unit.

### 4. Make ticket creation precede worker spawn

`pi-side-agents` can spawn a worker from a task description.
Beadwork wants:

- ticket first,
- worker second.

That is a meaningful behavioral shift.
The extension should not treat worker spawn as an ad hoc command alone; it should default to spawning **against an existing ticket**.

### 5. Reuse statusline and `/agents` style observability

A beadwork extension should absolutely expose something like:

- active workers with ticket IDs
- ready queue count
- in-progress queue count
- worker wait / fail states
- worktree/window mapping

This is one of the best lessons from `pi-side-agents`.

## What I would not copy directly

I would not make the runtime registry the primary task tracker.
That would duplicate beadwork and eventually drift from it.

The registry should be treated as ephemeral runtime metadata keyed by ticket.

---

## What to borrow from `workmux`, without depending on it yet

`workmux` is still useful as a design reference even if it is too heavy for the first shipping version.

The main ideas worth borrowing are:

- one worktree per task,
- one terminal surface per task,
- clean create / inspect / cleanup lifecycle,
- explicit hooks around worker start and finish,
- a dashboard mindset for multi-worker visibility,
- backend abstraction if bespoke launchers are added later.

What should **not** happen in the first implementation:

- no hard dependency on `workmux`,
- no attempt to support tmux + WezTerm + Ghostty + others at launch,
- no architectural detour just to preserve optionality that is not immediately needed.

So the role of `workmux` in this document is mainly as a reference for future backend shape, not as a proposed first dependency.

---

## What “deeply baked into a pi extension” should mean

A shallow integration would just add a few `bw` wrapper tools.
That would be useful, but it would miss the core behavior beadwork is trying to induce.

A deep integration should mean the extension changes the agent’s operating model in pi by default, **when beadwork is active for the repo**.

Concretely, that means:

## 1. Clear activation and no-op behavior

Because pi extensions are always running, the extension needs an explicit activation policy.

It should:

- detect whether `bw` is installed,
- detect whether the current repo is beadwork-initialized,
- stay quiet when beadwork is unavailable,
- avoid forcing the beadwork flow on repos that do not use it,
- expose a lightweight status indicator so the user knows whether beadwork mode is active.

This is not just ergonomics; it is architectural correctness.
The extension should be safe to install globally and harmless in non-beadwork repos.

## 2. Ticket awareness before coding

Before multi-step work begins, the extension should steer the agent toward:

- asking delivery level,
- materializing plan into tickets,
- pulling from `bw ready`.

## 3. Ticket-aware delegation

Subagent spawn should be ticket-native:

- choose a ready ticket,
- allocate a worktree,
- launch a child into that ticket,
- track runtime state against the ticket.

## 4. Landing-aware completion

The extension should model completion as:

- code committed for the ticket,
- `bw close <id>` run,
- `bw sync` run,
- optional merge / PR / cleanup done.

## 5. Runtime observability in pi UI

The extension should use pi’s UI capabilities:

- footer status via `ctx.ui.setStatus()`
- widgets / dashboard overlays via `ctx.ui.setWidget()` / `ctx.ui.custom()`
- commands for operator inspection and control

## 6. Session persistence / orchestration state

pi gives several persistence mechanisms:

- session entries via `pi.appendEntry()`
- project-local files under `.pi/`
- external CLI state via beadwork

A deep integration needs both:

- beadwork for durable task graph
- local `.pi/...` registry for ephemeral runtime worker bookkeeping

---

## Proposed architecture for a beadwork-aware pi extension

## Recommended package shape

A likely new workspace package here would be:

- `packages/pi-beadwork-extension`

Potential modules:

- `src/index.ts` — extension entrypoint
- `src/activation.ts` — detect beadwork availability / repo initialization / config
- `src/bw.ts` — beadwork CLI adapter
- `src/backend.ts` — launcher backend interface
- `src/backends/tmux.ts` — tmux backend
- `src/state.ts` — runtime registry keyed by ticket / worker id
- `src/handoff.ts` — worker kickoff prompt builder
- `src/dashboard.ts` — status widget / overlay
- `src/policy.ts` — delivery-level / workflow decision helpers
- `src/types.ts`

## Layer 1: activation + repo detection

Responsibilities:

- detect whether current cwd is inside a git repo
- detect whether `bw` is installed
- detect whether beadwork is initialized for the repo
- expose a simple mode like:
  - `inactive` — no git repo or `bw` missing
  - `available` — `bw` installed but repo not initialized
  - `active` — beadwork repo detected and commands enabled
- keep commands/statusline/widgets quiet unless the mode is `active`

This is the foundation for making an always-running extension feel correct.

## Layer 2: beadwork adapter

Responsibilities:

- shell out via `pi.exec("bw", ...)`
- parse JSON where available
- normalize core operations:
  - `prime`
  - `ready`
  - `show`
  - `create`
  - `start`
  - `comment`
  - `close`
  - `sync`
  - `dep add`
- surface clear capability errors when beadwork is unavailable in the current repo

Important note: beadwork output is markdown-native and some flows are optimized for human/agent reading, not pure machine APIs. The extension may need a mix of:

- `--json` where supported,
- `bw export` / `bw list --json`,
- or thin parsing wrappers for specific commands.

## Layer 3: workflow policy engine

Responsibilities:

- ask / remember the delivery tier for the current request
- determine whether work should be:
  - quick fix in place
  - ticket + worktree
  - epic + children + deps
- enforce / encourage one-ticket-one-worktree behavior
- generate delegation checklist

This is where the “beadwork mental model” lives inside pi.

## Layer 4: launcher backend interface

Something like:

```ts
interface WorkerBackend {
  allocate(ticket: TicketRef, options: LaunchOptions): Promise<LaunchResult>
  send(workerId: string, input: string): Promise<void>
  inspect(workerId: string): Promise<WorkerStatus>
  waitAny(workerIds: string[]): Promise<WorkerEvent>
  cleanup(workerId: string, mode: "remove" | "keep-worktree"): Promise<void>
}
```

### Initial backend: tmux-native

Pros:

- closest to `pi-side-agents`
- easiest first implementation
- full control
- aligns with the most realistic path to a usable first release

Cons:

- tmux-only
- some orchestration plumbing must be implemented directly

### Future backends: bespoke, only if needed

Possible later directions:

- direct WezTerm launcher
- direct Ghostty launcher
- other terminal-native integrations

Those should only be added after the tmux path proves the workflow.

## Layer 5: runtime registry

This should be runtime-only metadata, not a replacement for beadwork.

Suggested contents:

- worker ID
- ticket ID
- parent epic ID
- branch name
- worktree path
- backend kind (`tmux`)
- backend handle (`session`, `window`, `pane`, etc.)
- pi child session ID if known
- status (`allocating`, `running`, `waiting_user`, `failed`, `done`)
- started/updated/finished timestamps
- last known prompt / backlog path

Canonical location:

- `.pi/beadwork-workers/registry.json`

Rule:

- beadwork remains the canonical durable task system,
- registry is ephemeral runtime state only.

## Layer 6: ticket-native handoff prompt builder

This is one of the most important pieces.

A worker kickoff should include:

- ticket ID and title
- branch / worktree path
- dependencies / blockers
- comments / breadcrumbs
- exact first action: `bw start <id>`
- exact landing steps:
  - commit referencing ticket
  - `bw close <id>`
  - `bw sync`
  - optional repo-specific finish step if configured

This is where beadwork’s `start.md` and `prime.md` ideas should be encoded into the runtime handoff.

## Layer 7: pi UI integration

pi has enough extension UI surface to make this feel native.

### Status line

Show, when active:

- activation state
- active ticket workers
- waiting workers
- failed workers
- ready queue count

Example:

- `bw: active · 3 ready · 2 wip · bw-a1b@3 wait · bw-c4d@5 run`

When beadwork is unavailable or uninitialized, prefer something minimal or nothing at all.

### Widget / overlay

Possible live widget sections:

- ready issues
- in-progress issues
- active workers
- blocked workers
- activation / setup hints when the repo is not beadwork-enabled

### Commands

Good operator-facing commands might include:

- `/bw` — open beadwork dashboard overlay
- `/bw-status` — show activation status and repo detection
- `/bw-prime` — show latest prime context
- `/bw-ready` — show / pick ready work
- `/bw-start <id>` — claim ticket and optionally launch worker
- `/bw-delegate <id>` — launch worker for ticket
- `/bw-workers` — inspect runtime workers
- `/bw-adopt-plan` — convert current plan into epic + tasks

### LLM-callable tools

Possible tool set:

- `beadwork_status`
- `beadwork_ready`
- `beadwork_show`
- `beadwork_create`
- `beadwork_start`
- `beadwork_comment`
- `beadwork_close`
- `beadwork_sync`
- `beadwork_delegate`
- `beadwork_worker_check`
- `beadwork_worker_send`
- `beadwork_worker_wait_any`

These should be high-level, opinionated tools, not just raw CLI passthrough.

---

## The architecture I would recommend

## Source of truth split

### Durable truth

Use beadwork for:

- issue graph
- dependencies
- comments
- status transitions
- ready queue

### Runtime truth

Use extension-local state for:

- live workers
- worktree/window bindings
- transient logs and handles

That keeps the system understandable.

## Preferred execution model

### For interactive human-led work

- operator in parent pi session
- parent detects whether beadwork is active for this repo
- if active, parent asks delivery level
- parent materializes plan into tickets when needed
- parent delegates selected tickets to workers
- workers run in separate worktrees / tmux windows
- parent supervises via statusline / dashboard

### For agent-led multi-worker work

- parent agent uses beadwork graph as scheduler
- spawns workers only for ready child tickets
- waits for worker yields / completion
- verifies landing
- updates comments / graph
- launches next ready ticket

This is essentially “beadwork as planner, tmux-backed side-agents as execution fabric.”

## My concrete recommendation

### Best long-term architecture

Build a **beadwork-native pi extension** that:

1. uses beadwork as the durable work graph,
2. uses a small **activation layer** so it is safe as an always-running extension,
3. uses a **tmux backend** first,
4. makes delegation **ticket-first**, not task-string-first,
5. exposes native pi commands/tools/widgets for the orchestration loop,
6. keeps room for future bespoke terminal backends without paying their cost up front.

### Best practical starting point

If trying to ship the first useful version quickly:

1. add a new extension package in this repo,
2. implement activation detection + beadwork CLI wrapper,
3. implement a tmux-backed worker launcher inspired by `pi-side-agents`,
4. key everything by beadwork ticket ID,
5. make child kickoff prompt always start with `bw start <id>`,
6. include the full landing path (`commit` + `bw close` + `bw sync`),
7. add statusline + `/bw-workers` + `/bw-status` commands.

That is the shortest path to something installable, runnable, and actually aligned with the beadwork workflow.

---

## A concrete combined workflow

Here is what the combined system should feel like when it is working well.

## Example: multi-step feature

User asks:

- “Refactor auth and add audit logging.”

### Parent pi orchestrator

1. checks whether beadwork is active in this repo
2. if active, runs / loads beadwork prime context
3. asks: quick fix, branch/PR, or multi-step?
4. user says multi-step
5. parent creates:
   - epic `Refactor auth and add audit logging`
   - child tasks:
     - `Extract auth service`
     - `Update callers`
     - `Add audit log model`
     - `Emit audit events`
     - `Add regression tests`
   - dependencies between them
6. parent inspects `bw ready`
7. parent launches workers for the ready children only

### Worker launch

For each ticket:

1. tmux backend creates worktree / branch named like `<ticket-id>/<slug>`
2. opens a tmux window or pane
3. starts child pi session
4. injects kickoff prompt:
   - run `bw start <id>`
   - here is the ticket context
   - land with commit + `bw close` + `bw sync`

### Worker behavior

1. child runs `bw start <id>`
2. makes scoped change
3. commits referencing ticket
4. closes ticket
5. syncs beadwork
6. optionally runs repo-specific finish step
7. yields or exits

### Parent behavior after return

1. checks worker state / diff / landed commit
2. comments on ticket if needed
3. refreshes ready queue
4. launches next unblocked work

### Behavior in a non-beadwork repo

1. extension detects that beadwork is not initialized here
2. no beadwork dashboard or ready queue is shown by default
3. `/bw-status` explains why the extension is inactive
4. normal pi usage continues unchanged

That keeps the extension installable across repos without making every session pay for the full beadwork workflow.

---

## Risks and implementation concerns

## 1. Avoid duplicating the beadwork graph

The extension should not invent its own dependency graph or task state machine.
That would inevitably diverge.

## 2. Beware parsing human-oriented CLI output

Beadwork is agent-friendly, but not every command is guaranteed to be ideal machine JSON.
The adapter layer needs careful design.

## 3. Landing semantics must stay configurable

Some repos will want:

- local merge,
- PR creation,
- draft PR first,
- no automatic merge.

The extension should not hardcode a single finish policy.
A simple repo-local finish hook or config slot is enough for an initial version.

## 4. Always-running extensions must fail soft

Because the extension is always loaded, beadwork absence cannot be treated as an error state.
It needs to degrade cleanly when:

- `bw` is not installed,
- the cwd is not a git repo,
- the repo does not use beadwork,
- the beadwork branch/state is missing or uninitialized.

## 5. Terminal backend complexity can still explode later

Even if tmux is the only initial backend, future direct launcher support can become messy quickly.
That is why a minimal backend interface is still worth keeping.

## 6. Do not confuse worker orchestration with permission to mutate

The parent should still be able to supervise and gate risky landing actions.
`pi-side-agents` has the right instinct here: workers can do work asynchronously, but that does not mean totally autonomous merges without review.

---

## Suggested phased rollout

The rollout should start at the first version that is actually installable and operational, not at an internal-only half phase.

## Phase 1: usable beadwork runtime for pi

Ship a version that can genuinely be installed and used:

- activation / no-op detection
- beadwork adapter
- delivery-level policy helpers
- tmux-backed per-ticket worker launch
- per-ticket worktree creation
- kickoff prompt generation
- runtime registry
- basic statusline and `/bw-status`, `/bw-ready`, `/bw-workers`, `/bw-delegate`

This is the real minimum viable product.
Anything smaller is mostly scaffolding.

## Phase 2: complete the landing path

Make the workflow fully faithful to beadwork completion semantics:

- finish policy configuration
- `commit` + `bw close` + `bw sync` verification
- worker completion checks
- optional repo-local start/finish hooks
- better failure / wait-state handling

This is likely part of the first genuinely satisfying release, not an optional extra.

## Phase 3: richer operator UX

Once the core workflow works end to end:

- overlay dashboard
- ready queue picker
- worker control panel
- better ticket / worker summaries
- maybe graph-oriented visibility for epic / child relationships

## Phase 4: additional bespoke launchers if demand proves out

Only after the tmux workflow is validated:

- direct WezTerm backend
- direct Ghostty backend
- other terminal-native integrations

---

## Bottom line

The most faithful way to combine these systems is:

- let **beadwork own the durable work graph**,
- let a **pi extension own the orchestration behavior**,
- let **tmux own the initial worker execution surface**,
- let **child pi sessions own ticket-scoped implementation work**.

That gives you a system where:

- plans survive compaction,
- workers stay isolated,
- runtime status is visible,
- the queue is dependency-aware,
- the extension is safe to leave installed everywhere,
- and “done” includes landing, not just coding.

In short:

- beadwork gives the workflow meaning,
- `pi-side-agents` shows how to run the workers,
- `workmux` is useful background inspiration but not a first dependency,
- a new pi extension in this repo could tie them together cleanly.

## Non-blocking open questions

These do not block the research conclusion, but they would matter before implementation:

1. What is the cleanest repo-level signal for “beadwork is initialized here”?
2. Should inactive repos show a tiny `bw: off` indicator, or should the extension stay completely invisible until activated?
3. Which beadwork commands should be treated as the stable machine interface vs wrapped human output?
4. Should the extension proactively inject beadwork policy into the session at activation time, or stay mostly command/tool-driven?
5. What is the smallest useful repo-level finish-policy surface for phase 2: config file, hook script, or both?
