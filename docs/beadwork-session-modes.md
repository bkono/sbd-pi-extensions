# Beadwork session modes and slash-command engagement model

Date: 2026-04-13

## Goal

Define how a pi beadwork extension should expose explicit, session-level engagement modes so the user can move cleanly between:

1. normal non-beadwork work,
2. interactive human-led beadwork work,
3. agent-led multi-worker orchestration over an existing epic.

This document also confirms an important planning constraint:

- planning may begin either in **neutral** mode or **interactive** beadwork mode,
- and in either case the session can later transition into **run** mode once the plan is ready and durable tickets exist.

That transition model is intentional and should be part of the design.

---

## Executive summary

The extension should separate three concerns:

- **repo activation** — whether beadwork is available and initialized in the current repo
- **session mode** — how beadwork-opinionated the current pi session should be
- **scope** — whether the current session is focused on a specific ticket or epic

The default session behavior should remain **neutral**.

When the user wants beadwork behavior, they should opt in explicitly through a single slash command with subcommands:

- `/bw status`
- `/bw engage [scope]`
- `/bw run <epic-id> [options]`
- `/bw off`
- optionally `/bw adopt` or `/bw plan-to-tickets`

This gives a clean 3-scenario model:

### Scenario 1: non-beadwork work

Use **neutral** mode.

Examples:
- docs
- chores
- repo exploration
- design discussion
- one-off work that does not need ticketing or worktrees

### Scenario 2: interactive human-led beadwork work

Use **interactive** mode, usually entered via `/bw engage`.

Examples:
- planning in beadwork posture
- asking delivery-level questions
- reviewing `bw ready`
- creating an epic and children
- launching a worker only when requested

### Scenario 3: agent-led orchestration over an epic

Use **run** mode, entered via `/bw run <epic-id>`.

Examples:
- execute a prepared epic
- supervise workers over scoped `ready`
- continue until blocked or complete
- behave as orchestrator rather than conversational copilot

The most important design feature is that **planning can start in either neutral or interactive mode**. The extension should support both:

- plan in neutral, then explicitly convert the plan into beadwork tickets
- or engage interactive mode first, then plan directly into beadwork artifacts

Either path can later transition into `/bw run <epic-id>` once the user is satisfied with the durable graph.

---

## Core design principle

The extension should not assume:

- every repo uses beadwork,
- every task in a beadwork repo should use beadwork,
- every beadwork task should immediately become autonomous.

So the extension should be:

- **safe by default**,
- **explicit when opinionated**,
- **strongly guided when engaged**,
- **fully orchestral only when told to run**.

This is especially important because pi extensions are always running.

---

## State model

## 1. Repo activation state

Determined automatically by the extension.

Possible states:

- `inactive`
  - `bw` not installed, or
  - not inside a git repo, or
  - other hard preconditions fail
- `available`
  - `bw` installed, but current repo is not beadwork-initialized
- `active`
  - beadwork is available and initialized in the current repo

This state controls whether beadwork commands are usable.
It does **not** itself force the session into beadwork mode.

## 2. Session mode

Chosen explicitly by the user, or left at default.

Possible modes:

- `neutral`
- `interactive`
- `run`

This state controls how the extension should shape the session’s behavior.

## 3. Session scope

Optional session-local focus.

Possible scopes:

- none
- ticket id
- epic id

This determines whether commands like `ready`, `block`, `show`, and dashboard views should be filtered.

## Effective session state

The useful combined state is:

- repo activation: `inactive | available | active`
- session mode: `neutral | interactive | run`
- scope: `none | ticket | epic`

Examples:

- `available / neutral / none`
- `active / interactive / epic 124`
- `active / run / epic 124`

This model matches the three user scenarios cleanly.

---

## Session mode semantics

## Neutral mode

Neutral mode is the default and should feel like normal pi.

### Intended use

- docs
- chores
- exploration
- open-ended discussion
- planning that is not yet ready to become beadwork state
- quick fixes that do not need ticketization

### Behavior

- no automatic `bw prime`
- no automatic `bw ready` steering
- no assumption that tickets/worktrees are desired
- beadwork commands remain available if repo activation is `active`, but not pushed
- UI should remain quiet or minimal

### Important planning implication

Neutral mode may still contain substantial planning work.
That planning is allowed to remain informal until the user decides to materialize it.

This is important because some work begins as ideation or exploration and only later becomes concrete enough to turn into an epic and tickets.

## Interactive mode

Interactive mode means:

> “Help me work beadwork-style, but I am still driving.”

### Intended use

- planning with beadwork semantics in mind
- asking delivery-level questions
- creating epics / tasks / dependencies
- reviewing scoped `ready`
- human-led delegation decisions
- beadwork-aware coding with explicit checkpoints

### Behavior

- load or refresh `bw prime` when entering mode
- encourage delivery-level selection when relevant
- nudge toward durable ticket creation for non-trivial plans
- allow planning directly into epic/child ticket structure
- show scoped `ready` / in-progress / blocked context when helpful
- do not start autonomous queue execution
- do not spawn workers unless requested or clearly approved

### Planning implication

Interactive mode is a valid place to both:

- shape the plan in conversation, and
- progressively distill it into beadwork artifacts.

This mode is the “beadwork-aware copilot” posture.

## Run mode

Run mode means:

> “Act as the orchestrator for this epic.”

### Intended use

- execute an existing epic
- supervise multiple workers
- drive scoped `ready` / `block` loops
- continue until blocked, complete, interrupted, or policy-limited

### Behavior

- requires repo activation `active`
- requires explicit epic scope
- parent session acts as scheduler/orchestrator
- repeatedly consults scoped `ready`
- launches workers against existing tickets
- verifies ticket landing
- updates status / comments as needed
- stops on clear stopping conditions

### Planning implication

Run mode is not the primary planning space.
It assumes planning has already been made durable enough to execute.

That durable state may have come from:

- prior interactive beadwork planning, or
- prior neutral planning that was later converted into tickets.

---

## Slash command design

A single slash namespace is the right UX.

## `/bw status`

Shows:

- repo activation state
- why activation is inactive or available if not active
- current session mode
- current scope
- ready / blocked / in-progress counts if active
- active workers if any

### Purpose

- visibility
- debugging
- orientation before switching modes

## `/bw engage [scope]`

Moves the session into **interactive** mode.

### Inputs

Optional scope:
- epic id
- ticket id

### Behavior

- verify repo activation is `active`
- load/refresh `bw prime`
- set session mode to `interactive`
- optionally set scope
- update statusline/widget
- summarize what interactive mode means

### Resulting contract

The session should now:

- ask delivery-level questions when needed
- help plan in beadwork terms
- encourage ticketization for non-trivial work
- stay human-led

### Example uses

- `/bw engage`
- `/bw engage epic-124`
- `/bw engage 124`

## `/bw run <epic-id> [options]`

Moves the session into **run** mode.

### Required input

- an epic id

### Suggested options

- `--workers <n>`
- `--until blocked`
- `--until empty`
- `--dry-run`
- `--max-cycles <n>`
- `--no-spawn` for a scheduler-only preview mode

### Behavior

- verify repo activation is `active`
- verify the id refers to an epic or accepted container ticket type
- set scope to that epic
- set session mode to `run`
- load relevant graph context
- begin orchestrator loop over scoped `ready`

### Resulting contract

The session should now:

- act with more initiative
- prefer existing ticket graph over conversational replanning
- delegate against ready child tickets
- stop only at defined boundaries

## `/bw off`

Returns the session to **neutral** mode.

### Behavior

- clear interactive or run mode
- optionally clear scope, or preserve it as passive context depending on UX preference
- stop autonomous orchestration loops if running
- reduce UI back to minimal state

### Purpose

This makes engagement reversible and explicit.

## Optional `/bw adopt` or `/bw plan-to-tickets`

This command is highly compatible with the planning model you want.

### Purpose

Convert an in-session plan into beadwork artifacts after planning happened in neutral mode.

### Behavior

- inspect the current conversation’s working plan or a provided plan block
- ask the user how the work should land:
  - quick fix
  - branch/PR
  - multi-step
- for multi-step:
  - create epic
  - create child tasks
  - wire dependencies
- optionally move the session into interactive mode after ticket creation
- optionally suggest `/bw run <epic-id>` once durable state exists

### Why it matters

This command makes neutral-first planning a first-class workflow rather than an accidental side path.

---

## Planning flows

This is the most important part to make explicit.

## Flow A: plan in neutral, then adopt into beadwork

This flow should be intentionally supported.

### Example

1. user and pi discuss a feature in normal conversation
2. plan emerges informally during exploration
3. user decides the work should now become beadwork-managed
4. user runs `/bw adopt` or `/bw engage` followed by “turn this into an epic and children”
5. extension creates durable ticket graph
6. user reviews and adjusts it
7. user runs `/bw run <epic-id>` when ready

### Why this flow matters

It preserves the very common pattern of:

- explore first,
- structure later,
- execute last.

The extension should not force early ticketization before the user has enough clarity.

## Flow B: engage interactive mode first, then plan directly into beadwork

This flow should also be intentionally supported.

### Example

1. user knows from the outset this is beadwork work
2. user runs `/bw engage`
3. extension loads prime context
4. session asks delivery-level questions
5. plan is formed directly as epic + child tasks + dependencies
6. user reviews graph and ready queue
7. user runs `/bw run <epic-id>` when ready

### Why this flow matters

It supports the stronger beadwork posture from the start, which is often right for substantial implementation work.

## Flow C: direct run on an existing epic

This flow is the shortest path when the durable graph already exists.

### Example

1. beadwork epic already exists
2. user says “run this epic”
3. user runs `/bw run <epic-id>`
4. extension becomes orchestrator immediately

### Why this flow matters

It supports ongoing work that was planned in a prior session or by another session.

---

## Transition rules

The extension should support these mode transitions.

## Allowed transitions

- `neutral -> interactive`
- `neutral -> run` only if an existing epic already exists and user explicitly requests it
- `interactive -> run`
- `run -> interactive`
- `interactive -> neutral`
- `run -> neutral`

## Recommended constraints

### `neutral -> run`

Allow it only when:

- repo activation is `active`, and
- an explicit epic id is provided, and
- the user is clearly asking for orchestration rather than planning

This supports the “just run everything for existing epic X” case.

### `interactive -> run`

This should be the most natural transition.

Interactive mode is where the user may:

- review the epic,
- adjust children,
- wire dependencies,
- inspect `ready`,
- then decide it is time to execute.

### `run -> interactive`

Useful when:

- the agent hits ambiguity,
- new planning is required,
- a blocked graph needs restructuring,
- the user wants to temporarily resume direct control.

### `run -> neutral`

Useful when:

- orchestration is complete,
- the user wants to go back to docs/chore/discussion mode,
- the epic is blocked and further planning is deferred.

---

## Scoped behavior

Because beadwork supports `ready` and `block` in scoped ways, scope should be part of the session contract.

## Scope in interactive mode

If scope is an epic:

- show scoped ready children
- show blocked children and blockers
- show in-progress children
- center planning and discussion around that epic

If scope is a ticket:

- show ticket details
- show blockers / dependents / comments
- keep the session focused on that work item

## Scope in run mode

Scope should normally be an epic.

That scope becomes:

- the ready queue boundary
- the worker spawning boundary
- the completion boundary
- the summary boundary

This avoids the orchestrator accidentally roaming across unrelated project work.

---

## Stop conditions for run mode

Run mode needs explicit stop conditions so it feels intentional and controllable.

## Primary stop conditions

- epic is complete
- scoped ready queue is empty and all remaining work is blocked
- user interrupts or runs `/bw off`
- configured worker limit / failure policy triggers a stop
- unresolved ambiguity requires human input

## Recommended end-of-run summary

When run mode stops, the extension should summarize:

- epic id and title
- tickets completed in this run
- tickets still in progress
- tickets blocked and by what
- worker outcomes
- next recommended action

This makes run mode feel like a bounded orchestration pass, not a vague background behavior.

---

## UI and statusline behavior

## In neutral mode

- ideally minimal or hidden beadwork UI
- `/bw status` remains available
- if repo activation is not active, the extension should stay quiet

## In interactive mode

Statusline can show something like:

- `bw: interactive · epic 124 · 3 ready · 1 blocked`

Widget can show:

- current scope
- ready children
- blocked children
- in-progress children
- suggested next actions

## In run mode

Statusline can show something like:

- `bw: run · epic 124 · 2 ready · 3 active workers · 1 wait`

Widget can show:

- active workers
- ready queue
- recently completed tickets
- blocked tickets
- stop condition / run progress notes

The UI should make the difference between interactive and run unmistakable.

---

## Why explicit command-based engagement is necessary

## It solves the always-running extension problem

Because the extension is always loaded, it cannot infer too much from repo activation alone.

Repo activation only means:

- beadwork can be used here

It does not mean:

- beadwork should shape this session right now

Slash commands provide that missing intent boundary.

## It preserves normal pi work

Users should still be able to:

- explore code
- write docs
- brainstorm
- do chores

without being forced into ticket/worktree/orchestrator behavior.

## It makes autonomous orchestration safe

Run mode is significantly stronger than normal interactive assistance.
It should therefore require an explicit user action.

## It supports both planning styles

This is the key design win.

The model naturally supports:

- **neutral-first planning**, then ticket adoption
- **interactive-first planning**, then ticket execution
- **direct orchestration** over an existing epic

That flexibility is exactly what the extension needs.

---

## Recommendation

Ship the engagement model with:

- `/bw status`
- `/bw engage [scope]`
- `/bw run <epic-id> [options]`
- `/bw off`
- and strongly consider `/bw adopt` or `/bw plan-to-tickets`

Treat the modes as different contracts:

### Neutral contract

> “Behave like normal pi.”

### Interactive contract

> “Help me work beadwork-style.”

### Run contract

> “Act as orchestrator for this epic.”

And explicitly support the planning lifecycle:

- plan in neutral, then adopt into beadwork, then run
- or engage first, plan directly into beadwork, then run
- or directly run an already-prepared epic

This is the cleanest way to preserve flexibility while still giving the extension strong, explicit operating modes.

---

## Suggested next implementation doc

The next concrete design pass should define:

- exact command signatures
- how session mode/scope is stored
- how `bw prime` is cached or refreshed on engage
- how `/bw adopt` discovers the plan to ticketize
- how run mode loop boundaries are implemented
- how worker spawning limits and failure policies are configured
- what transitions are permitted while active workers are running
