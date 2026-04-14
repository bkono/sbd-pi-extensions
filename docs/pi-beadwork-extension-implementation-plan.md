# `packages/pi-beadwork-extension` implementation plan

Date: 2026-04-13

## Goal

Turn the beadwork research and session-mode design into a concrete implementation plan for a new installable pi extension package in this repo.

This plan is intentionally biased toward the first version that is actually usable:

- safe as an always-running extension
- quiet in non-beadwork repos
- explicit session engagement via `/bw ...`
- tmux-backed worker orchestration
- ticket-first delegation
- end-to-end enough to support real interactive and run-mode workflows

This is the package the prior docs were converging on:

- durable source of truth: beadwork
- runtime worker substrate: tmux
- orchestration behavior: pi extension
- execution workers: child pi sessions in worktrees

---

## Scope of this implementation plan

This document covers:

- package layout
- command and tool surface
- session state storage
- activation detection
- beadwork adapter responsibilities
- tmux launcher contract
- run-loop boundaries
- MVP sequencing
- test plan
- acceptance criteria for each milestone

This document does **not** assume workmux or other backends in the initial release.

---

## Product contract

The extension must support three session scenarios:

1. **neutral** — normal pi work, no beadwork behavior forced
2. **interactive** — human-led beadwork-aware work
3. **run** — agent-led orchestration over an existing epic

The extension must also support both planning entry paths:

- **neutral-first planning** → later adopt/convert into tickets → then run
- **interactive-first planning** → plan directly into beadwork → then run

That means the extension cannot assume all planning starts in beadwork mode, but it must make switching into beadwork mode explicit and smooth.

---

## Package definition

## Workspace package name

Recommended package:

- `packages/pi-beadwork-extension`

Recommended npm package name:

- `@solvedbydev/pi-beadwork-extension`

## Package responsibilities

The package should:

- detect whether beadwork is available and initialized
- expose session-level slash commands under `/bw`
- store lightweight session mode/scope state
- wrap the `bw` CLI with a typed adapter
- manage tmux-backed worker lifecycle
- maintain ephemeral runtime worker state under `.pi/`
- expose high-level LLM-callable tools for beadwork orchestration
- remain non-intrusive in repos where beadwork is not active

## Non-goals for the first release

Do **not** include initially:

- workmux integration
- WezTerm / Ghostty direct launchers
- a full graph visualization UI
- aggressive automatic mode switching based on inference alone
- a second task graph separate from beadwork

---

## Proposed package layout

```text
packages/pi-beadwork-extension/
  package.json
  README.md
  tsconfig.json
  tsdown.config.ts
  vitest.config.ts
  src/
    index.ts
    types.ts
    constants.ts

    activation.ts
    config.ts
    session-state.ts
    registry.ts

    bw.ts
    bw-parse.ts
    bw-scope.ts

    policy.ts
    adopt.ts
    handoff.ts
    statusline.ts
    dashboard.ts

    tmux.ts
    worktree.ts
    run-loop.ts
    commands.ts
    tools.ts
  test/
    activation.test.ts
    session-state.test.ts
    bw.test.ts
    bw-parse.test.ts
    policy.test.ts
    handoff.test.ts
    registry.test.ts
    tmux.test.ts
    run-loop.test.ts
    commands.test.ts
```

## File responsibility summary

### `src/index.ts`
Extension entrypoint. Registers hooks, slash commands, tools, statusline updater, and any startup wiring.

### `src/types.ts`
Central type definitions for activation state, session mode, scope, ticket refs, worker refs, run-loop events, and config.

### `src/constants.ts`
Shared constants for file names, default paths, status labels, and configuration defaults.

### `src/activation.ts`
Detects whether beadwork is usable in the current cwd.

### `src/config.ts`
Loads extension config from env/project/global config sources.

### `src/session-state.ts`
Stores per-session mode/scope state.

### `src/registry.ts`
Stores ephemeral runtime worker registry keyed by ticket/worker id.

### `src/bw.ts`
Main beadwork CLI adapter.

### `src/bw-parse.ts`
Output parsing and normalization helpers for `bw` commands when JSON is not available.

### `src/bw-scope.ts`
Helpers for scoped ready/block/show operations at repo, epic, and ticket granularity.

### `src/policy.ts`
Delivery-mode logic and workflow policy helpers.

### `src/adopt.ts`
Converts conversational plans into beadwork epics/tasks/dependencies.

### `src/handoff.ts`
Builds child-worker kickoff prompts and landing checklists.

### `src/statusline.ts`
Calculates and updates `ctx.ui.setStatus()` output.

### `src/dashboard.ts`
Optional widget/overlay rendering for `/bw status` and future richer UI.

### `src/tmux.ts`
Tmux interaction layer for sessions/windows/panes and process dispatch.

### `src/worktree.ts`
Worktree creation, naming, cleanup, and branch naming helpers.

### `src/run-loop.ts`
Autonomous orchestration loop for `/bw run`.

### `src/commands.ts`
Slash command implementations.

### `src/tools.ts`
High-level LLM-callable tool definitions.

---

## Package manifest plan

## `package.json`

Use the same workspace pattern as the other packages.

Recommended shape:

- `type: "module"`
- `main: "dist/index.mjs"`
- `types: "dist/index.d.mts"`
- `pi.extensions: ["./src/index.ts"]`
- peer deps on `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent`
- dev deps mirroring the existing workspace packages

Possible package-level dependencies:

- ideally none beyond pi runtime deps and small utilities
- avoid adding a tmux wrapper library unless it clearly reduces complexity
- prefer direct `spawn` / `execFile` wrappers for tmux commands to keep control explicit

## Root `package.json`

Update root `pi.extensions` to include:

- `packages/pi-beadwork-extension/src/index.ts`

This should happen when the package becomes usable enough to load by default in the workspace.

---

## Activation model

Activation is repo-level capability detection, not mode selection.

## Activation states

```ts
type ActivationState =
  | { kind: "inactive"; reason: "no-git" | "no-bw" | "cwd-unavailable" | "error"; detail?: string }
  | { kind: "available"; reason: "repo-not-initialized" | "repo-not-configured"; detail?: string }
  | { kind: "active"; repoRoot: string; detail?: string };
```

## Detection responsibilities

The activation detector should answer:

1. are we inside a git repo?
2. is `bw` installed and executable?
3. is this repo beadwork-initialized?
4. if not active, why not?

## Recommended detection strategy

### Step 1: detect git repo root

Use `git rev-parse --show-toplevel`.

If it fails:
- activation = `inactive/no-git`

### Step 2: detect `bw`

Use `bw --help` or `command -v bw`.

If it fails:
- activation = `inactive/no-bw`

### Step 3: detect beadwork initialization

This likely needs a dedicated helper because “repo uses beadwork” is the most important soft-failure state.

Recommended order:

1. ask beadwork directly if there is a stable command for repo state detection
2. otherwise probe for expected beadwork branch/state artifacts
3. otherwise treat command failure from a harmless read operation as `available`, not `inactive`

Target outcome:
- if `bw` exists but the repo is not initialized, return `available`
- do not treat this as an error

## Activation refresh points

Refresh activation state on:

- session start
- cwd changes if pi exposes them cleanly
- `/bw status`
- `/bw engage`
- `/bw run`
- selected tool calls that require active beadwork

## UX contract

Activation alone must not:

- auto-enter interactive mode
- auto-run `bw prime`
- show heavy UI continuously

It only enables the `/bw` surface.

---

## Session state model

Session state is distinct from beadwork state and must stay lightweight.

## Types

```ts
type SessionMode = "neutral" | "interactive" | "run";

type SessionScope =
  | { kind: "none" }
  | { kind: "ticket"; id: string }
  | { kind: "epic"; id: string };

type SessionState = {
  mode: SessionMode;
  scope: SessionScope;
  lastPrimeAt?: string;
  lastPrimeSummary?: string;
  currentRun?: {
    epicId: string;
    startedAt: string;
    workerLimit: number;
    stopPolicy: "blocked" | "empty" | "manual";
    cycles: number;
  };
};
```

## Storage location

Recommended:

- per-session in memory for primary operation
- persisted under `.pi/beadwork/session-state/<session-id>.json` for recovery and tooling

Why both:
- in-memory is fastest and simplest during one session
- persisted copy helps recovery, debugging, and command continuity if pi restarts or reloads extensions

## Persistence rules

Persist on:

- session start (initialize)
- `/bw engage`
- `/bw run`
- `/bw off`
- run-loop state transitions
- session shutdown

## Recovery behavior

On session restart or extension reload:

- restore the last known mode/scope if the session id matches and the state file exists
- if restored state is `run`, do **not** silently resume orchestration; instead mark the session as run-mode paused and require explicit resume

That keeps autonomous behavior intentional.

---

## Runtime worker registry

The worker registry tracks live runtime bindings, not project truth.

## Registry location

Recommended:

- `.pi/beadwork-workers/registry.json`

Optional per-worker detail files:

- `.pi/beadwork-workers/<worker-id>.json`

## Worker record

```ts
type WorkerStatus =
  | "allocating"
  | "launching"
  | "running"
  | "waiting_user"
  | "failed"
  | "landed"
  | "cleaning_up"
  | "done";

type WorkerRecord = {
  workerId: string;
  ticketId: string;
  epicId?: string;
  sessionId?: string;
  branch: string;
  worktreePath: string;
  backend: "tmux";
  tmuxSession?: string;
  tmuxWindow?: string;
  tmuxPane?: string;
  status: WorkerStatus;
  createdAt: string;
  updatedAt: string;
  lastEvent?: string;
  backlogPath?: string;
  landedCommit?: string;
  finishPolicy?: "close-sync" | "close-sync-cleanup" | "custom";
};
```

## Registry rules

- keyed primarily by `workerId`
- enforce uniqueness for active `ticketId`
- if a ticket already has an active worker, prevent duplicate launch unless explicitly forced
- never use registry status as a replacement for beadwork ticket state

---

## Beadwork adapter plan

The adapter should be opinionated and typed.
It should not expose a generic “run any bw command” API to the rest of the package.

## Core adapter interface

```ts
interface BeadworkAdapter {
  getActivation(cwd: string): Promise<ActivationState>;
  prime(cwd: string): Promise<{ markdown: string; summary: string }>;
  ready(args: ReadyArgs): Promise<ReadyResult>;
  show(id: string, cwd: string): Promise<TicketDetails>;
  createEpic(input: CreateEpicInput): Promise<TicketRef>;
  createTask(input: CreateTaskInput): Promise<TicketRef>;
  addDependency(input: AddDependencyInput): Promise<void>;
  start(id: string, cwd: string): Promise<StartResult>;
  comment(input: CommentInput): Promise<void>;
  close(input: CloseInput): Promise<void>;
  sync(cwd: string): Promise<void>;
}
```

## Required operations for MVP

### Read operations

- activation detection
- `prime`
- `ready`
- `show`

### Write operations

- create epic
- create task
- add dependency
- start
- comment
- close
- sync

## Parsing strategy

Prefer, in order:

1. structured output from beadwork if available
2. stable markdown parsing where the prompt output is intentionally shaped
3. defensive wrappers that preserve raw output for debugging

Never let parsing errors silently mutate work.

If a parser fails:
- return a typed error
- include raw stdout/stderr for operator-visible debugging where appropriate

---

## Workflow policy plan

The policy layer should encode only the workflow rules this extension actually needs.
It should not become a second planner.

## Policy responsibilities

- identify delivery mode when asked
- tell commands/tools whether ticketization is expected
- decide whether a worker can be launched directly
- provide standard landing checklist text
- help `/bw adopt` convert plans into epics/tasks/dependencies

## Delivery-mode model

```ts
type DeliveryMode = "quick-fix" | "branch-pr" | "multi-step";
```

## Rules

- `quick-fix`
  - no ticket required
  - no worktree required
  - no `/bw run`
- `branch-pr`
  - ticket required
  - worktree usually required
  - may still be user-led
- `multi-step`
  - epic + child tasks + dependencies required
  - run mode becomes available once the graph exists

---

## Slash command surface

Use a single namespace: `/bw`

## Commands for MVP

### `/bw status`

Purpose:
- show activation state
- show session mode/scope
- show scoped ready/in-progress/blocked counts if active
- show worker registry summary if relevant

Output contract:
- always safe to run
- useful in inactive, available, and active repos

### `/bw engage [scope]`

Purpose:
- switch current session to interactive mode
- optionally scope to a ticket or epic
- refresh `bw prime`

Behavior:
- requires activation `active`
- stores `lastPrimeAt` and `lastPrimeSummary`
- updates session mode to `interactive`

### `/bw run <epic-id> [options]`

Purpose:
- switch current session to run mode
- start autonomous orchestration over that epic

MVP options:
- `--workers <n>` default 2
- `--until blocked|empty` default `blocked`
- `--dry-run`
- `--max-cycles <n>` default safe small limit for first release

Behavior:
- requires activation `active`
- validates epic exists
- validates run eligibility
- enters run mode and kicks off the run loop

### `/bw off`

Purpose:
- return to neutral mode
- stop any active run loop

Behavior:
- if workers are active, do not kill them automatically unless future policy says so
- clearly summarize what remains running

### `/bw adopt`

Purpose:
- convert an in-session plan into beadwork artifacts

Behavior:
- available in neutral or interactive mode
- can inspect a provided plan block or use recent session context heuristically
- asks delivery-mode questions as needed
- for `multi-step`, creates epic + children + dependencies
- suggests next step: continue interactive or switch to `/bw run <epic-id>`

## Commands deferred beyond MVP

Possible later commands:

- `/bw workers`
- `/bw ready`
- `/bw show <id>`
- `/bw resume`
- `/bw cleanup`

These can be implemented later if `/bw status` and `/bw run` already expose enough functionality.

---

## Tool surface plan

The extension should expose a small, opinionated tool set for the LLM.

## MVP tools

### `beadwork_status`
Returns activation, session mode, scope, and worker summary.

### `beadwork_ready`
Returns ready work, optionally scoped by epic/ticket.

### `beadwork_show`
Returns normalized ticket details.

### `beadwork_adopt_plan`
Creates beadwork artifacts from a plan.

### `beadwork_delegate`
Launches a tmux-backed worker for a specific existing ticket.

### `beadwork_worker_check`
Returns worker runtime state from the registry/tmux.

### `beadwork_worker_wait_any`
Waits or polls for worker events.

## Tools deferred beyond MVP

- `beadwork_worker_send`
- `beadwork_cleanup_worker`
- lower-level raw beadwork passthrough tools

The LLM should be encouraged to use high-level workflow-aware tools, not shell-level escape hatches.

---

## `/bw adopt` implementation contract

This command is important because it supports neutral-first planning.

## Inputs

Possible inputs:

- no argument: use current session context and ask confirmation
- pasted plan text
- selected conversation segment if pi exposes it conveniently later

## Output behavior

### For quick-fix

- explain no ticket graph is necessary
- remain in current mode unless user wants otherwise

### For branch-pr

- create one ticket
- optionally switch to interactive mode scoped to that ticket

### For multi-step

- create epic
- create one child task per implementation unit
- wire dependencies
- summarize resulting graph
- suggest:
  - stay in interactive mode to refine further, or
  - run `/bw run <epic-id>`

## Important guardrail

`/bw adopt` should never silently generate a large graph without confirmation.
The user should see a summary of what will be created before mutation occurs.

---

## Tmux backend contract

Tmux is the only runtime backend in the initial implementation.

## Responsibilities

- create/find a tmux session for beadwork workers
- create a window or pane per worker
- launch a child pi session in the target worktree
- inject the handoff prompt
- capture identifiers for later inspection
- support status checks and optional cleanup actions

## Proposed interface

```ts
interface TmuxBackend {
  ensureSession(input: { repoRoot: string }): Promise<{ sessionName: string }>;
  launchWorker(input: LaunchWorkerInput): Promise<LaunchWorkerResult>;
  inspectWorker(input: InspectWorkerInput): Promise<InspectWorkerResult>;
  sendInput(input: SendWorkerInput): Promise<void>;
  cleanupWorker(input: CleanupWorkerInput): Promise<void>;
}

type LaunchWorkerInput = {
  repoRoot: string;
  worktreePath: string;
  workerId: string;
  sessionName?: string;
  title: string;
  prompt: string;
};

type LaunchWorkerResult = {
  sessionName: string;
  windowName: string;
  paneId: string;
  launchCommand: string;
};
```

## Launch strategy

Preferred launch approach:

1. create or reuse a tmux session like `pi-bw`
2. create a new window named from ticket id/slug
3. start a shell in the worktree path
4. launch a child pi session there
5. inject the kickoff prompt

The exact child process command may evolve, but the contract should preserve:

- worktree cwd
- child pi session identity if obtainable
- prompt injection reliability

## Important implementation note

Do not over-abstract tmux in the first version.
A small explicit command layer is enough:

- `tmux has-session`
- `tmux new-session`
- `tmux new-window`
- `tmux send-keys`
- `tmux list-panes`
- `tmux display-message`
- `tmux kill-window` or `kill-session` as needed

---

## Worktree management contract

Each delegated ticket gets its own worktree.

## Responsibilities

- create branch name from ticket id + slug
- create worktree path in a stable location
- validate clean preconditions if needed
- optionally clean up after landing based on finish policy

## Branch naming

Use beadwork-native naming:

- `<ticket-id>/<slug>`

## Worktree path

Recommended default:

- sibling worktree directory near repo root, or
- configurable base path in extension config

Example:

- `<repo-parent>/<repo-name>-worktrees/<ticket-id>-<slug>`

This should not be hidden inside `.pi/` because worktrees are real git workspaces.

## Cleanup policy for MVP

Support at least:

- `keep` — leave worktree intact
- `cleanup-after-landing` — remove only after landing is verified

Default conservatively to `keep` until the first release proves reliable.

---

## Worker handoff contract

The handoff prompt is the most important runtime behavior besides the run loop itself.

## Required contents

Every worker kickoff should include:

- ticket id and title
- epic id if any
- branch name
- worktree path
- dependency/blocker summary
- recent ticket comments if useful
- exact required first action: `bw start <id>`
- exact landing checklist:
  - make the scoped change
  - commit referencing ticket
  - `bw close <id>`
  - `bw sync`
  - report status back

## Suggested handoff shape

```text
You are working one beadwork ticket in one worktree.

Ticket: BW-123 Fix auth token refresh
Epic: BW-100 Auth refactor
Worktree: /path/to/worktree
Branch: BW-123/fix-auth-token-refresh

Required first step:
- Run `bw start BW-123`

Rules:
- Stay scoped to this ticket
- Do not expand into unrelated work
- Land the work completely: commit, `bw close BW-123`, `bw sync`
- If blocked, explain the blocker clearly

Context:
- ...summary...
```

## Prompt builder responsibilities

- truncate/summarize safely if ticket context is long
- prefer normalized adapter output over raw CLI paste where possible
- include enough context for the worker to proceed even if detached from parent conversation

---

## Run-loop plan

Run mode is the orchestration loop over a scoped epic.

## Core loop

For each cycle:

1. read scoped `ready`
2. compare ready tickets against active worker registry
3. choose launchable tickets
4. launch workers up to configured concurrency limit
5. inspect existing workers for status changes
6. verify landed tickets where possible
7. update run state and summarize progress
8. determine whether to continue or stop

## MVP constraints

Keep the first run loop conservative.

Recommended defaults:

- max workers: 2
- stop policy default: `blocked`
- max cycles: small bounded default unless user overrides
- no automatic aggressive cleanup of worktrees

## Stop conditions

Stop when:

- epic is complete
- no scoped ready work exists and remaining work is blocked
- user interrupts or runs `/bw off`
- too many worker failures occur
- max cycles reached
- ambiguous graph state requires human input

## Verification behavior

For MVP, verification can be pragmatic rather than perfect.

A ticket can be considered “apparently landed” when:

- worker reports successful completion, and
- registry marks a landed commit or the finish steps completed, and/or
- beadwork status reflects closure after sync

Improve verification depth later, but do not block the first release on perfect provenance capture.

---

## UI plan

## Statusline

Statusline should be enough for the MVP.

### Neutral examples

- hidden, or
- `bw: off`

### Interactive examples

- `bw: interactive · epic 124 · 3 ready · 1 blocked`

### Run examples

- `bw: run · epic 124 · 2 ready · 2 workers · 1 wait`

## `/bw status` output

This command is the main operator dashboard for MVP.

It should include:

- activation state and reason/detail
- session mode and scope
- prime freshness if interactive/run mode
- scoped ready/in-progress/blocked counts if active
- worker list with statuses
- recommended next action

## Widget / overlay

Treat as optional for MVP.
If simple to add, use it for `/bw status`; otherwise text output is enough.

---

## Config plan

Support config from:

1. env vars
2. project config: `<repo>/.pi/beadwork-config.json`
3. global config: `~/.pi/beadwork-config.json`
4. defaults

## Suggested config shape

```json
{
  "tmux": {
    "sessionName": "pi-bw"
  },
  "run": {
    "defaultWorkers": 2,
    "defaultStopPolicy": "blocked",
    "defaultMaxCycles": 20
  },
  "worktrees": {
    "baseDir": "../_worktrees",
    "cleanupPolicy": "keep"
  },
  "ui": {
    "showInactiveStatus": false
  }
}
```

## MVP knobs

Implement only the knobs that matter immediately:

- tmux session name
- default worker limit
- default stop policy
- worktree base dir
- cleanup policy
- inactive status visibility

---

## Testing plan

The first implementation should be heavily unit-tested with thin integration seams.

## Unit tests

### `activation.test.ts`

Cover:
- no git repo
- `bw` missing
- repo not initialized
- active repo
- command failures

### `session-state.test.ts`

Cover:
- mode transitions
- scope transitions
- persistence and restore
- paused-run restore behavior

### `bw.test.ts` / `bw-parse.test.ts`

Cover:
- normalized parsing of `prime`, `ready`, `show`, `start`
- parse failure handling
- raw output preservation on error

### `policy.test.ts`

Cover:
- delivery mode selection helpers
- eligibility rules for ticketization and run mode

### `adopt.test.ts`

Cover:
- converting plan outlines into epic/tasks/dependencies
- confirmation summary generation

### `handoff.test.ts`

Cover:
- required prompt sections
- truncation behavior
- blocker/comment inclusion

### `registry.test.ts`

Cover:
- worker insert/update/remove
- duplicate ticket prevention
- status transitions

### `tmux.test.ts`

Cover:
- command construction
- parse of pane/window identifiers
- cleanup commands

Mock tmux subprocesses rather than requiring real tmux for unit tests.

### `run-loop.test.ts`

Cover:
- ready queue scheduling
- concurrency limits
- stop on blocked
- stop on empty
- failure threshold behavior
- worker reuse prevention

### `commands.test.ts`

Cover:
- `/bw status`
- `/bw engage`
- `/bw run`
- `/bw off`
- `/bw adopt`

## Integration tests

Later, add a small fake-adapter harness that simulates:

- beadwork graph state
- tmux launcher responses
- worker events

This will let the run loop be tested end-to-end without depending on a real beadwork repo or live tmux.

## Live smoke tests

After MVP, add an opt-in smoke script similar to the OM extension:

- temp git repo
- temp beadwork repo setup if practical
- temp tmux session
- launch a child pi worker
- verify registry/status flow

This can come after core implementation if setup is expensive.

---

## Implementation sequence

The build order should target the first installable, runnable version as quickly as possible.

## Milestone 1: package scaffold + passive activation

Deliver:

- package scaffold
- manifest + build config
- activation detection
- config loading
- session-state persistence
- `/bw status`
- minimal statusline behavior

Acceptance criteria:

- package builds
- extension loads safely in all repos
- `/bw status` explains inactive/available/active correctly
- no noisy behavior in neutral mode

## Milestone 2: beadwork adapter + interactive session mode

Deliver:

- typed beadwork adapter
- `prime`, `ready`, `show`, `create`, `dep`, `start`, `close`, `sync`
- `/bw engage [scope]`
- session mode and scope transitions
- prime refresh/caching
- improved `/bw status`

Acceptance criteria:

- can enter interactive mode only in active repos
- `bw prime` loads and is reflected in session state
- scope is shown and respected
- extension remains quiet unless engaged

## Milestone 3: neutral-first adoption path

Deliver:

- `/bw adopt`
- plan summary/confirmation flow
- epic/task/dependency creation helpers
- recommendation to remain interactive or switch to run mode

Acceptance criteria:

- neutral-first planning can be converted into durable tickets
- graph creation is previewed before mutation
- resulting epic id is surfaced clearly

## Milestone 4: tmux + worktree worker launch

Deliver:

- worktree manager
- tmux backend
- worker registry
- handoff prompt builder
- `beadwork_delegate` tool
- ability to launch one ticket worker manually

Acceptance criteria:

- given an existing ticket, the extension can create a worktree and launch a child pi worker in tmux
- registry tracks worker location and status
- worker prompt includes `bw start <id>` and landing checklist

## Milestone 5: run loop MVP

Deliver:

- `/bw run <epic-id>`
- bounded run loop
- concurrency limits
- worker inspection/polling
- stop conditions
- run-mode statusline

Acceptance criteria:

- can orchestrate over an existing epic
- launches ready tickets up to configured limit
- stops cleanly when blocked or empty per policy
- returns a useful end-of-run summary

## Milestone 6: landing verification and cleanup polish

Deliver:

- pragmatic landing verification
- optional cleanup policies
- better failure/wait-state reporting
- maybe `/bw off` handling for active worker cases

Acceptance criteria:

- parent can distinguish landed vs failed vs waiting workers reliably enough for real use
- cleanup behavior is conservative and understandable

---

## Recommended MVP cut

If we want the first version to be truly usable, the MVP should include:

- milestone 1
- milestone 2
- milestone 3
- milestone 4
- milestone 5

That is a larger MVP than a typical scaffold-first package, but it aligns with the earlier conclusion: there is little value in shipping a half-built extension that cannot actually perform the intended workflow.

The smallest meaningful first release is:

- safe activation/no-op behavior
- explicit session engagement
- plan adoption
- manual ticket worker launch
- run mode over an existing epic

---

## Risks and mitigations

## Risk: beadwork initialization detection is fuzzy

Mitigation:
- isolate repo detection in `activation.ts`
- expose clear reason/detail strings
- treat uncertainty as `available`, not `active`

## Risk: `bw` output is hard to parse consistently

Mitigation:
- keep parsing localized
- favor stable read operations first
- log raw outputs for debugging
- avoid parsing complexity in mutation flows unless necessary

## Risk: tmux worker launch is brittle

Mitigation:
- keep the contract small
- record launch commands and pane ids in the registry
- unit-test command construction heavily
- default to manual cleanup over aggressive automation

## Risk: run mode becomes too autonomous too early

Mitigation:
- bound by default worker count and cycles
- stop on ambiguity or repeated failures
- require explicit `/bw run`
- restore paused, not resumed, after reload

## Risk: extension becomes noisy in non-beadwork repos

Mitigation:
- neutral default
- passive activation only
- configurable inactive status visibility
- no automatic engage/run transitions

---

## Suggested first implementation steps in code

The practical first coding order should be:

1. scaffold `packages/pi-beadwork-extension`
2. add `activation.ts`, `config.ts`, `session-state.ts`, `types.ts`
3. implement `/bw status`
4. implement `bw.ts` read-only operations first: activation, `prime`, `ready`, `show`
5. implement `/bw engage`
6. implement `bw.ts` write operations: create, dep, start, close, sync
7. implement `/bw adopt`
8. implement `worktree.ts`, `tmux.ts`, `registry.ts`, `handoff.ts`
9. implement manual delegate path for one ticket
10. implement `run-loop.ts` and `/bw run`
11. add landing verification polish and cleanup controls

This order gets the highest-risk architectural seams under test early without overcommitting to UI polish.

---

## Bottom line

The correct first implementation is a **tmux-first, ticket-first, explicitly engaged beadwork extension**.

Concretely, `packages/pi-beadwork-extension` should:

- stay passive unless beadwork is active **and** the user engages it
- expose `/bw status`, `/bw engage`, `/bw adopt`, `/bw run`, `/bw off`
- persist lightweight session mode/scope state
- wrap beadwork in a typed adapter
- maintain a runtime worker registry under `.pi/`
- launch child pi workers in tmux-backed worktrees
- run a bounded epic-scoped orchestrator loop when explicitly asked

That is the shortest path to a first version that matches the mental model you want and is actually worth installing and using.
