# Beadwork + pi extension research

Date: 2026-04-13

## Goal

Understand the workflow beadwork is trying to teach agents via its prompt chain, then assess how that workflow could be baked deeply into a pi extension in this repo, potentially using a tmux / Ghostty / WezTerm style spawning model similar to `pi-side-agents` and `workmux`.

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
- `workmux` provides a stronger and more backend-flexible **worktree/window orchestration substrate**, but it does not provide ticket semantics.

The clean synthesis is layered:

- **Beadwork** = durable planning / ticket graph / ready queue / landing semantics
- **pi extension** = orchestration brain inside pi
- **tmux / workmux / terminal backend** = worker launcher + observability + cleanup
- **child pi sessions** = actual workers

My recommendation is to build a new package in this repo around that layering, with the extension treating beadwork as the source of truth and treating a launcher backend (`tmux`, `workmux`, maybe direct terminal launch) as replaceable runtime infrastructure.

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
- read `bw prime`,
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
- which terminal window/tab it lives in
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

## How this lines up with `workmux`

## What `workmux` contributes

`workmux` is more general and more infrastructure-oriented than `pi-side-agents`.

It contributes a mature answer to:

- worktree creation
- terminal/window backend abstraction
- prompt injection into agent panes
- lifecycle hooks (`post_create`, `pre_merge`, `pre_remove`)
- automated file ops / bootstrapping
- background creation
- worker pools / batched multi-worktree generation
- merge/remove cleanup
- dashboard / sidebar / status tracking
- multiple backends:
  - tmux
  - WezTerm
  - Kitty
  - Zellij

It does **not** contribute durable ticket semantics.

## Why `workmux` may be the better substrate for terminal orchestration

If the goal is only “spawn pi workers in tmux,” `pi-side-agents` is already a strong reference.

If the goal is “support tmux today, but also support WezTerm and maybe other terminal orchestrators later,” `workmux` is a better architectural reference because it already treats the multiplexer/windowing layer as configurable infrastructure.

That suggests an important design choice:

- do **not** hardwire the beadwork extension to tmux if multi-backend support matters.

Instead, define a launcher backend interface and implement:

- `tmux` backend first,
- `workmux` backend second or instead,
- optional direct terminal backends later.

## Important caveat on Ghostty

From the workmux materials reviewed, `workmux` documents first-class alternative backends for:

- Kitty
- WezTerm
- Zellij

I did **not** see Ghostty documented as a first-class workmux backend in the material reviewed.

So if Ghostty is desired, there are two realistic interpretations:

1. Ghostty is just the terminal emulator hosting tmux, which is easy.
2. Ghostty itself should be a first-class launcher target, which would likely require bespoke backend work outside current workmux support.

That makes a backend abstraction even more important.

## How workmux and beadwork complement each other

`workmux` already has the mental model:

- one worktree per task,
- one window per task,
- clean merge/remove lifecycle,
- prompt injection into agent panes,
- batch worker generation.

Beadwork can supply the missing task semantics:

- which tasks exist,
- which are ready,
- what blocks what,
- which worker should be launched next,
- when a task is really done.

So the clean relationship is:

- workmux = worktree/window operating system
- beadwork = durable work graph
- pi extension = glue + behavior enforcement

---

## What “deeply baked into a pi extension” should mean

A shallow integration would just add a few `bw` wrapper tools.
That would be useful, but it would miss the core behavior beadwork is trying to induce.

A deep integration should mean the extension changes the agent’s operating model in pi by default.

Concretely, that means:

## 1. Ticket awareness before coding

Before multi-step work begins, the extension should steer the agent toward:

- asking delivery level,
- materializing plan into tickets,
- pulling from `bw ready`.

## 2. Ticket-aware delegation

Subagent spawn should be ticket-native:

- choose a ready ticket,
- allocate a worktree,
- launch a child into that ticket,
- track runtime state against the ticket.

## 3. Landing-aware completion

The extension should model completion as:

- code committed for the ticket,
- `bw close <id>` run,
- `bw sync` run,
- optional merge / PR / cleanup done.

## 4. Runtime observability in pi UI

The extension should use pi’s UI capabilities:

- footer status via `ctx.ui.setStatus()`
- widgets / dashboard overlays via `ctx.ui.setWidget()` / `ctx.ui.custom()`
- commands for operator inspection and control

## 5. Session persistence / orchestration state

pi gives several persistence mechanisms:

- session entries via `pi.appendEntry()`
- project-local files under `.pi/`
- external CLI state via beadwork and/or workmux

A deep integration likely needs both:

- beadwork for durable task graph
- local `.pi/...` registry for ephemeral runtime worker bookkeeping

---

## Proposed architecture for a beadwork-aware pi extension

## Recommended package shape

A likely new workspace package here would be:

- `packages/pi-beadwork-extension`

Potential modules:

- `src/index.ts` — extension entrypoint
- `src/bw.ts` — beadwork CLI adapter
- `src/backend.ts` — launcher backend interface
- `src/backends/tmux.ts` — tmux backend
- `src/backends/workmux.ts` — workmux backend
- `src/state.ts` — runtime registry keyed by ticket / worker id
- `src/handoff.ts` — worker kickoff prompt builder
- `src/dashboard.ts` — status widget / overlay
- `src/policy.ts` — delivery-level / workflow decision helpers
- `src/types.ts`

## Layer 1: beadwork adapter

Responsibilities:

- detect beadwork repo / availability
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

Important note: beadwork output is markdown-native and some flows are optimized for human/agent reading, not pure machine APIs. The extension may need a mix of:

- `--json` where supported,
- `bw export` / `bw list --json`,
- or thin parsing wrappers for specific commands.

## Layer 2: workflow policy engine

Responsibilities:

- ask / remember the delivery tier for the current request
- determine whether work should be:
  - quick fix in place
  - ticket + worktree
  - epic + children + deps
- enforce / encourage one-ticket-one-worktree behavior
- generate delegation checklist

This is where the “beadwork mental model” lives inside pi.

## Layer 3: launcher backend interface

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

### Backend option A: tmux-native

Pros:

- closest to `pi-side-agents`
- easiest first implementation
- full control

Cons:

- tmux-only
- you end up re-implementing a lot of orchestration plumbing

### Backend option B: workmux-backed

Pros:

- terminal backend flexibility
- existing lifecycle hooks / merge/remove / prompt injection
- strong batch-worker story
- existing dashboard semantics to borrow from

Cons:

- more coupling to external CLI behavior
- may need separate worker inspection plumbing
- Ghostty still not obviously first-class

### Backend option C: direct terminal launcher

Spawn Ghostty / WezTerm windows directly.

Pros:

- native UX for people living in those terminals

Cons:

- likely the most bespoke and least portable
- more backend-specific maintenance
- weaker common observability story

### Recommendation

If shipping incrementally:

1. start with **tmux backend** or **workmux backend**,
2. keep backend abstraction clean,
3. leave Ghostty-specific launching as a later backend.

If multi-backend support is a priority from day one, I would lean toward **workmux as the substrate** rather than cloning all of its window/worktree concerns into the extension.

## Layer 4: runtime registry

This should be runtime-only metadata, not a replacement for beadwork.

Suggested contents:

- worker ID
- ticket ID
- parent epic ID
- branch name
- worktree path
- backend kind (`tmux`, `workmux`, etc.)
- backend handle (`windowId`, `session`, `pane`, etc.)
- pi child session ID if known
- status (`allocating`, `running`, `waiting_user`, `failed`, `done`)
- started/updated/finished timestamps
- last known prompt / backlog path

Canonical location:

- `.pi/beadwork-workers/registry.json`

Rule:

- beadwork remains the canonical durable task system,
- registry is ephemeral runtime state only.

## Layer 5: ticket-native handoff prompt builder

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
  - maybe backend-specific merge / PR / cleanup

This is where beadwork’s `start.md` and `prime.md` ideas should be encoded into the runtime handoff.

## Layer 6: pi UI integration

pi has enough extension UI surface to make this feel native.

### Status line

Show:

- active ticket workers
- waiting workers
- failed workers
- ready queue count

Example:

- `bw: 3 ready · 2 wip · bw-a1b@3 wait · bw-c4d@5 run`

### Widget / overlay

Possible live widget sections:

- ready issues
- in-progress issues
- active workers
- blocked workers
- overdue / deferred reminders

### Commands

Good operator-facing commands might include:

- `/bw` — open beadwork dashboard overlay
- `/bw-prime` — show latest prime context
- `/bw-ready` — show / pick ready work
- `/bw-start <id>` — claim ticket and optionally launch worker
- `/bw-delegate <id>` — launch worker for ticket
- `/bw-workers` — inspect runtime workers
- `/bw-adopt-plan` — convert current plan into epic + tasks

### LLM-callable tools

Possible tool set:

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
- parent asks delivery level
- parent materializes plan into tickets when needed
- parent delegates selected tickets to workers
- workers run in separate worktrees / windows
- parent supervises via statusline / dashboard

### For agent-led multi-worker work

- parent agent uses beadwork graph as scheduler
- spawns workers only for ready child tickets
- waits for worker yields / completion
- verifies landing
- updates comments / graph
- launches next ready ticket

This is essentially “beadwork as planner, side-agents/workmux as execution fabric.”

## My concrete recommendation

### Best long-term architecture

Build a **beadwork-native pi extension** that:

1. uses beadwork as the durable work graph,
2. uses a **launcher backend abstraction**,
3. offers a **tmux backend** first if speed matters,
4. or a **workmux backend** first if multi-backend support matters more,
5. makes delegation **ticket-first**, not task-string-first,
6. exposes native pi commands/tools/widgets for the orchestration loop.

### Best practical starting point

If trying to ship the first useful version quickly:

1. add a new extension package in this repo,
2. implement beadwork CLI wrapper + ready/start/show/create helpers,
3. implement a tmux-backed worker launcher inspired by `pi-side-agents`,
4. key everything by beadwork ticket ID,
5. make child kickoff prompt always start with `bw start <id>`,
6. add statusline + `/bw-workers` command,
7. later add a `workmux` backend.

That gives the fastest path to validating the workflow while keeping the architecture open.

---

## A concrete combined workflow

Here is what the combined system should feel like when it is working well.

## Example: multi-step feature

User asks:

- “Refactor auth and add audit logging.”

### Parent pi orchestrator

1. runs / loads beadwork prime context
2. asks: quick fix, branch/PR, or multi-step?
3. user says multi-step
4. parent creates:
   - epic `Refactor auth and add audit logging`
   - child tasks:
     - `Extract auth service`
     - `Update callers`
     - `Add audit log model`
     - `Emit audit events`
     - `Add regression tests`
   - dependencies between them
5. parent inspects `bw ready`
6. parent launches workers for the ready children only

### Worker launch

For each ticket:

1. backend creates worktree / branch named like `<ticket-id>/<slug>`
2. opens tmux/workmux/terminal window
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
6. optionally merges / opens PR / cleans up based on repo policy
7. yields or exits

### Parent behavior after return

1. checks worker state / diff / landed commit
2. comments on ticket if needed
3. refreshes ready queue
4. launches next unblocked work

That is exactly the orchestrator + tickets + worktree-bound workers model the beadwork prompts are trying to push the agent toward.

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
This is another place where `workmux`-style hooks or `pi-side-agents`-style finish scripts are useful.

## 4. Terminal backend complexity can explode

A direct Ghostty / WezTerm / tmux implementation matrix will get messy quickly.
A backend abstraction is mandatory.

## 5. Do not confuse worker orchestration with permission to mutate

The parent should still be able to supervise and gate risky landing actions.
`pi-side-agents` has the right instinct here: workers can do work asynchronously, but that does not mean totally autonomous merges without review.

---

## Suggested phased rollout

## Phase 1: beadwork-aware parent tooling

- beadwork adapter
- status widget / ready queue visibility
- commands to inspect / start / delegate tickets
- no child spawning yet, or minimal tmux spawning

## Phase 2: ticket-native worker launcher

- tmux backend
- per-ticket worktree launch
- kickoff prompt generation
- runtime registry
- worker inspection / control tools

## Phase 3: landing policy + finish hooks

- configurable finish policies
- PR / merge / sync flows
- repo-local hook or skill scaffolding

## Phase 4: workmux backend

- backend using `workmux add/open/merge/remove`
- leverage workmux’s multi-backend support and dashboard ideas

## Phase 5: richer native UI

- overlay dashboard
- ready queue picker
- worker control panel
- maybe graph view of epic / children / deps

---

## Bottom line

The most faithful way to combine these systems is:

- let **beadwork own the durable work graph**,
- let a **pi extension own the orchestration behavior**,
- let **tmux/workmux/terminal backends own worker execution surfaces**,
- let **child pi sessions own ticket-scoped implementation work**.

That gives you a system where:

- plans survive compaction,
- workers stay isolated,
- runtime status is visible,
- the queue is dependency-aware,
- and “done” includes landing, not just coding.

In short:

- beadwork gives the workflow meaning,
- `pi-side-agents` shows how to run the workers,
- `workmux` shows how to generalize the worktree/window substrate,
- a new pi extension in this repo could tie them together cleanly.

## Non-blocking open questions

These do not block the research conclusion, but they would matter before implementation:

1. Should the first shipping backend be **tmux-native** or **workmux-backed**?
2. Is Ghostty meant merely as the host terminal for tmux, or as a true first-class launcher backend?
3. Should worker completion land through:
   - pure beadwork (`commit` + `bw close` + `bw sync`),
   - workmux merge/remove,
   - PR creation,
   - or repo-configurable finish scripts?
4. Which beadwork commands should be treated as the stable machine interface vs wrapped human output?
5. Should the extension proactively inject beadwork policy into the system prompt on session start, or stay command/tool-driven and less opinionated?
