# Proposal: migrate pi beadwork extension to current-branch swarm execution

Date: 2026-05-06
Status: proposed migration path

---

## Background: what is pi?

**pi** is a terminal-based AI coding agent (TUI) built on LLMs. It runs interactively in the
terminal, reads/writes files, executes commands, and orchestrates work. It has an extension system
(loaded at runtime via jiti) that lets plugins hook into the agent lifecycle: injecting system prompt
content, handling slash commands, running background supervisors, and rendering TUI elements.

Pi is **not** an IDE plugin or a web service. It is a standalone CLI agent that can be configured
with different LLM providers and models, and multiple pi instances can run concurrently (e.g., in
tmux windows) against the same repository.

---

## Background: what is beadwork?

**beadwork** (invoked as `bw`) is a git-native issue/task tracker. Issues, dependencies, labels,
comments, and history are all stored directly in the git repository (in a `.beadwork/` directory),
committed alongside code. This means:

- Issue state travels with the branch and is available offline.
- `bw sync` flushes issue state changes to git.
- Dependency graphs between issues are first-class: `bw ready` returns only issues whose
  blockers are all resolved.
- Issues have statuses (open, in-progress, closed, deferred), priorities, types (task, epic),
  parent/child relationships, and labels.
- `bw start <id>` marks an issue in-progress; `bw close <id>` marks it done.
- Epics are parent issues whose children represent the decomposed work.

Because beadwork is git-native and travel with the repo, it functions as a **coordination protocol**
between agents: any pi instance (or human) can read/write issue state, and `bw sync` makes the
changes visible to others.

---

## Background: what is the pi beadwork extension?

The `@solvedbydev/pi-beadwork-extension` is a pi extension that turns beadwork into a **multi-agent
orchestration system**. It enables a single coordinator pi instance to:

1. **Detect** beadwork availability in the current repo (activation).
2. **Adopt plans** — convert markdown plans into beadwork epics with dependency graphs.
3. **Delegate work** — launch worker agents (other pi instances) to work individual tickets.
4. **Supervise workers** — track lifecycle, detect completion/failure, run validation/review.
5. **Land work** — verify, merge back, and clean up after workers finish.
6. **Run epic loops** — orchestrate an entire epic by iteratively launching ready tickets and
   supervising their completion until the scope is done or needs attention.

### Key commands

- `/bw status` — show activation state, session mode, worker summary.
- `/bw delegate <ticket-id>` — launch a single worker for one ticket.
- `/bw run` — start a bounded epic loop that launches workers for ready tickets.
- `/bw workers` — show active/completed/failed workers.
- `/bw landing` — request or inspect landing for a worker.
- `/bw adopt <plan>` — decompose a markdown plan into beadwork issues.
- `/bw scope <epic-id>` — set the active orchestration scope.

### Extension architecture

The extension is structured as:

```
packages/pi-beadwork-extension/src/
├── index.ts            # Extension entrypoint: wires all subsystems together
├── types.ts            # All type definitions (WorkerRuntime, BeadworkConfig, etc.)
├── orchestrator.ts     # Core orchestration: launch, inspect, review, remediate, run
├── worktree.ts         # Worktree lifecycle: prepare, validate, rebase, land, cleanup
├── tmux.ts             # tmux backend: session/window management for workers
├── handoff.ts          # Handoff prompt generation for workers
├── registry.ts         # Worker registry: JSON persistence of WorkerRuntime records
├── config.ts           # Configuration loading and defaults
├── bw.ts               # Beadwork CLI adapter (wraps `bw` commands)
├── prompt.ts           # System prompt appendix injection
├── session-state.ts    # Per-session state persistence (mode, scope, run options)
├── activation.ts       # Detect beadwork availability
├── plan-adoption.ts    # Markdown → beadwork issue decomposition
├── actions/            # Slash command handlers (delegate, run, workers, etc.)
└── tui/                # TUI rendering components
```

---

## Background: how worker orchestration works today

### Worker launch

When the coordinator delegates a ticket, it:

1. Calls `prepareTicketWorktree()` — creates a git worktree for the ticket with a dedicated branch.
2. Copies configured files into the worktree and runs setup commands.
3. Generates a handoff prompt telling the worker which ticket to work, in which worktree.
4. Writes the prompt and a launch script to a runtime directory.
5. Launches a tmux window with cwd set to the worktree, running the worker agent.
6. Records a `WorkerRuntime` record in the registry (JSON file at repo root).

### Worker execution

The worker pi instance:
- Reads the handoff prompt as its initial task.
- Works the ticket in its isolated worktree.
- Makes commits on its worktree branch.
- Closes the beadwork ticket (`bw close <id>`) and syncs (`bw sync`).
- Exits.

### Worker completion (the "landing" pipeline)

When the supervisor detects a worker has exited with a closed ticket, it runs:

1. **Verify** — check the worktree is clean, ticket is closed, branch has commits.
2. **Rebase** — rebase the worker branch onto the current repo HEAD.
3. **Validate** — run configured validation commands (lint, test, typecheck) in the worktree.
4. **Review** — launch a reviewer agent that examines the diff and produces findings.
5. **Triage** — the coordinator assesses review findings for validity and relevance.
6. **Remediate** (if needed) — relaunch the worker to fix validation/review issues.
7. **Land** — fast-forward merge the worker branch into the repo's current branch.
8. **Cleanup** — remove the worktree and runtime artifacts.

If any step fails, the worker is marked `attention` or `failed` and the coordinator stops.

### The bounded epic loop (`runBoundedEpicLoop`)

For `/bw run`, the coordinator iterates:

1. Load the registry and inspect all workers for this epic.
2. Query beadwork for `ready` issues (dependencies satisfied, not started).
3. Launch workers for ready issues up to the concurrency limit.
4. Check stop conditions:
   - `completed` — epic closed or all children closed.
   - `attention` — any worker is failed/held/exited/attention.
   - `blocked` / `empty` — no ready work and no active workers.
   - `max-cycles` — iteration limit reached.
5. Sleep and repeat.

The loop is finite and returns a `RunSummary`. It is not a long-running daemon — the coordinator's
background supervisor calls it periodically.

### Current worker state vocabulary

Workers have a top-level `status` field with values:
`launching` | `running` | `exited` | `held` | `landed` | `failed` | `attention`

Plus secondary status fields for validation, review, remediation, cleanup, and landing verification.

### Current type surface (simplified)

```ts
type WorkerStatus = "launching" | "running" | "exited" | "held" | "landed" | "failed" | "attention";

type WorkerRuntime = {
  workerId: string;
  ticketId: string;
  epicId?: string;
  ticketTitle: string;
  branchName: string;
  worktreePath: string;          // <-- always present today
  backend: "tmux";
  tmuxSession: string;
  tmuxWindow: string;
  tmuxPane: string;
  runtimeDir: string;
  promptFile: string;
  scriptFile: string;
  logFile: string;
  stateFile: string;             // written by launch script: "running" / "exited" / "failed"
  exitCodeFile: string;
  finishedAtFile: string;
  launchCommand: string;
  workerCommand: string;
  cleanupPolicy: "keep" | "cleanup-after-landing";
  landingPolicy?: "auto" | "deferred";
  validationStatus?: "pending" | "passed" | "failed";
  remediationStatus?: "running" | "failed" | "exhausted";
  reviewStatus?: "pending" | "approved" | "nits-only" | "changes-requested" | ...;
  reviewVerdict?: "approve" | "approve-with-nits" | "request-changes";
  status: WorkerStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  lastError?: string;
  // ... ~60 fields total covering validation, review, remediation, landing, cleanup
};
```

### Current config surface (simplified)

```ts
type BeadworkConfig = {
  ui: { showInactiveStatus: boolean };
  storage: { sessionStateDir; workerRegistryFile; runtimeDir };
  tmux: { sessionName; workerCommand; workerProvider?; workerModel? };
  worktrees: { baseDir?; cleanup; copyFiles; setupCommands; rerunSetupOnReuse };
  run: { defaultWorkers; defaultUntil; defaultMaxCycles; pollIntervalMs };
  landing: {
    policy: "auto" | "deferred";
    validateCommands: string[];
    commandTimeoutMs: number;
    review: { enabled; provider?; model?; commandTimeoutMs; maxRemediationAttempts; maxArtifactChars };
  };
  supervisor: { pollIntervalMs };
};
```

---

## Background: the current handoff prompt

When a worker launches today, it receives a prompt like:

```
You are working one beadwork ticket in one worktree.

Ticket: BW-123 Implement the widget parser
Epic: BW-100 Build widget system
Worktree: /path/to/repo/.beadwork-worktrees/bw-123-implement-the-widget-parser
Branch: bw-123-implement-the-widget-parser

Required first step:
- Run `bw start BW-123`

Rules:
- Stay scoped to this ticket.
- Do not expand into unrelated cleanup unless required to land this ticket.
- Land the work completely: commit your changes, run `bw close BW-123`, then `bw sync`.
- If you need scratch notes or generated context files, keep them out of git-tracked worktree paths.
- If blocked, stop and report the blocker clearly.
- Use `/path/to/runtime/scratch` for transient artifacts like context.md.

Ticket context:
[ticket description]

Epic context:
[epic description]
```

---

## Background: what makes beadwork orchestration compelling

The combination of git-native issue tracking + LLM workers + tmux isolation creates a system where:

1. **Plans become executable** — a markdown plan adopted into beadwork becomes a dependency graph
   that the coordinator can automatically work through.
2. **Coordination is durable** — because issues/comments/dependencies live in git, state survives
   compaction, session boundaries, and context loss.
3. **Workers are independent agents** — each worker is a full pi instance with its own context
   window, tools, and judgment.
4. **The coordinator is also an LLM** — triage, review assessment, remediation decisions, and
   scope-completion review are all LLM judgment, not rigid code paths.
5. **Scale is practical** — 3-10 concurrent workers on well-scoped epics is the normal operating
   range today.

---

## The problem: worktrees as mandatory substrate

The current implementation **requires** a worktree for every worker. This creates several issues:

1. **Unnecessary isolation for same-branch work** — when all workers are contributing to the same
   branch (the common case), creating per-worker branches and worktrees adds complexity without
   proportional benefit. The beadwork dependency graph already prevents workers from stepping on
   each other.

2. **Merge-back overhead** — every worker's branch must be rebased and fast-forward merged back,
   even when all workers are targeting the same integration branch. This creates serialization
   points and failure modes (rebase conflicts) that don't exist if workers commit directly to the
   shared branch.

3. **Worktree as identity** — the current code conflates the worker's *execution environment*
   (where does it run?) with its *work identity* (what ticket is it working?). A worker is
   identified by its worktree path, branch name, and `launchHead..HEAD` range rather than by its
   beadwork ticket and attributed commits.

4. **Review artifacts are branch-range-based** — the reviewer sees the diff between launch head
   and worker head on the worktree branch, rather than the specific commits attributed to a ticket.
   In a same-branch world, `launchHead..HEAD` includes other workers' commits and is useless as
   a review boundary.

5. **Cleanup burden** — worktrees must be created, copied into, set up, and then cleaned up after
   landing. This is significant disk and time overhead for small tasks.

The beadwork extension already proves that concurrent workers work well. The remaining issue is that
the substrate forces unnecessary worktree machinery on the common case.

---

## What this proposal solves

This proposal makes **the beadwork ticket plus its attributed commit set** the durable worker unit,
and makes **current-branch execution** (workers run in the repo checkout, commit directly to the
shared branch) the default mode. Worktrees remain available as an explicit higher-isolation option.

The migration preserves the existing coordination, verification, remediation, and review-finding
triage behaviors. It changes *where* workers execute and *how* their work is identified, not the
orchestration logic itself.

---

## Purpose

Define a practical migration path from the pi beadwork extension's current worktree-centric
orchestration model to a **current-branch default** model for same-branch worker swarms.

This proposal builds on the existing current-branch sketch and the beadwork/beads_viewer review,
but intentionally narrows scope to the extension migration needed now. It preserves delegation,
coordination, verification, remediation, and review finding triage without forcing every worker
into an isolated worktree.

## Decision summary

The extension should treat **the beadwork ticket plus its attributed commit set** as the durable
worker unit.

It should no longer treat `launchHead..HEAD`, a per-ticket branch, or a worktree path as the core
unit of delegated work. In a same-branch swarm, multiple workers may commit to the same branch while
a worker is running, so a branch range is not a reliable attribution boundary.

Immediate direction:

1. Add an execution substrate abstraction.
2. Make `current-branch` the default worker execution mode.
3. Keep existing worktree behavior as explicit `worktree` mode.
4. Split post-worker orchestration into mode-specific paths:
   - current-branch: attribute the ticket's commits, run the normal review/triage loop, mark the
     ticket work verified when it passes, or remediate/file/reject reviewer findings;
   - worktree: keep the existing validate, review, rebase, merge-back, and cleanup pipeline.
5. Defer graph intelligence, path impact analysis, speculative execution, and richer scheduling
   heuristics until the substrate split is complete.

The default must flip only as part of a coherent release containing launch, verification, registry
normalization, review/remediation, scope completion, UI/diagnostics, and legacy worktree preservation.
Do not expose a half-migrated current-branch default.

## Non-goals

This proposal does not implement the broader beads_viewer-inspired roadmap yet.

Out of scope for the first migration:

- graph-ranked scheduling;
- file impact reverse indexes;
- path reservation enforcement;
- speculative execution;
- drift and velocity analytics;
- HTML graph export;
- recipes;
- multi-repo workspace support;
- mandatory worktree conflict gates.

Those ideas remain useful later, but they should not block current-branch delegation.

## Operating model

The desired default is a single-branch swarm:

- many workers may run concurrently in the same checkout and on the same branch;
- shared-checkout concurrency is intentional: current-branch mode relies on beadwork
  coordination, attribution, validation, remediation, and fix-forward behavior rather than
  isolation;
- each worker owns one beadwork ticket;
- workers coordinate through beadwork tickets, dependencies, comments, labels, and later optional
  reservation/mail mechanisms;
- workers make atomic commits referencing their ticket id using
  `git commit <specific-files> -m "<message referencing ticket id>"` — this avoids contamination
  from the shared index;
- workers close their ticket and sync when done;
- the coordinator verifies the ticket-attributed work and either marks the work verified, asks for
  fixes, files follow-up work, rejects invalid review findings, or marks the worker outcome as
  needing human attention.

### Proven model

This operating model is not theoretical. It is already the default behavior for 3-10 concurrent
workers when beads are planned with correct dependency graphs and clear scope boundaries.
Well-scoped tickets naturally partition file ownership. The graph ensures workers do not launch
until their dependencies are satisfied. Conflicts are rare in practice and acceptable when they
occur — they route to remediation like any other validation failure.

**This is a product premise, not an open risk to re-litigate during this migration.**
Shared-checkout concurrency is already proven for the intended operating range. The migration
should preserve that model and remove worktree-shaped overhead around it.

Agents reviewing or implementing this proposal must not assume that same-branch workers require
additional locking, file reservation, IPC coordination, deterministic path ownership, or
pre-launch conflict gates to function. That assumption is incorrect for this system.

The beadwork dependency graph, ticket scope, worker judgment, atomic ticket-referenced commits,
review, remediation, and fix-forward behavior are the coordination mechanism. Additional
coordination primitives may become useful advisory features later, but they are not prerequisites,
and they must not block, serialize, or dilute current-branch delegation in this migration.

Worktrees remain available, but only as an explicit higher-isolation mode.

## Current implementation constraints

The existing `packages/pi-beadwork-extension` lifecycle is worktree-shaped:

- worker launch prepares a per-ticket worktree;
- tmux runs in that worktree;
- handoff language tells the worker it owns a ticket worktree;
- remediation prompts tell the worker to continue in the existing worktree;
- review artifacts are built from worktree branch diffs;
- landing means rebase, validate, review, merge back, and verify containment;
- successful cleanup removes the worker worktree.

That model is coherent for isolated delegation, but it makes worktrees the substrate rather than one
available execution mode.

## Proposed architecture

Introduce an execution substrate abstraction with mode-specific invariants instead of pretending every
worker has a worktree:

```ts
type WorkerExecutionMode = "current-branch" | "worktree";

type CurrentBranchCheckout = {
  executionMode: "current-branch";
  checkoutPath: string; // repo root / current checkout
  branchName: string; // branch recorded at launch
  launchHead: string; // required: attribution starts here
};

type WorktreeCheckout = {
  executionMode: "worktree";
  checkoutPath: string; // worker worktree path
  branchName: string;
  worktreePath: string;
};

type WorkerCheckout = CurrentBranchCheckout | WorktreeCheckout;
```

Represent runtime checkout data as the same discriminated shape, not as optional worktree fields:

```ts
type BaseWorkerRuntime = {
  workerId: string;
  ticketId: string;
  epicId?: string;

  // Existing tmux/runtime/log/review/validation fields remain.
};

type WorkerRuntime = BaseWorkerRuntime & WorkerCheckout;
```

For `current-branch`, `launchHead` is required. For `worktree`, `worktreePath` is required.
Use `executionMode` as the single discriminant everywhere: registry records, summaries, TUI labels,
orchestration branching, diagnostics, launch, verification, landing, and cleanup.

`worktreePath` should remain only for legacy registry records and `worktree` workers. Current-branch
workers must not fake `worktreePath = repoRoot`; cleanup, landing, and diagnostics code should branch
on `executionMode` before touching worktree-only fields.

## Configuration

Add a neutral worker execution block:

```json
{
  "workerExecution": {
    "mode": "current-branch",
    "maxLifetime": null
  }
}
```

Supported initial modes:

- `current-branch` — default;
- `worktree` — existing behavior, explicit isolation mode.

`maxLifetime` is the optional per-worker timeout for crash detection (default: `null` / no limit).
Supervisor polling detects exit/disappearance regardless of whether a timeout is configured.

Add an environment override:

```sh
PI_BEADWORK_WORKER_EXECUTION_MODE=current-branch
```

The existing `worktrees` config should remain, but it should only apply when `mode` is `worktree`.

Current-branch worker review should default to on. Treat absent review configuration as enabled for
current-branch verification; disable it only when config explicitly says review is off.

Do not let worktree landing defaults leak into current-branch verification. In particular:

- `worktrees.copyFiles`, `worktrees.setupCommands`, `worktrees.cleanup`, and
  `worktrees.rerunSetupOnReuse` are ignored in `current-branch` mode;
- worktree landing review defaults do not decide whether current-branch review runs;
- current-branch review is enabled unless explicitly disabled;
- current-branch does not use landing cleanup, containment, rebase, or merge-back settings.

## Launch migration

Replace direct calls to `prepareTicketWorktree()` with a generic `prepareWorkerCheckout()`.

In `current-branch` mode, launch should:

1. resolve the repository root/current checkout;
2. confirm beadwork is active in that checkout;
3. reject detached HEAD unless explicitly configured;
4. record current branch and required `launchHead`;
5. create worker runtime/log/scratch directories;
6. launch tmux with cwd set to the repo root;
7. use a current-branch-specific handoff prompt;
8. never create a branch or worktree.

Current-branch launch must not require a clean checkout. Uncommitted or untracked state may belong
to active workers. The coordinator should not block launch, stash, reset, discard, or otherwise
intervene in dirty state while workers are running. Cleanliness is checked only when the scope is
quiescent and integrated validation/review is about to begin.

Current-branch runtime invariants:

- do not launch in detached HEAD unless explicitly configured;
- record both `branchName` and `launchHead` before tmux launch;
- do not treat dirty/untracked state as a launch failure in current-branch mode;
- at verification time, confirm the checkout is still on the recorded `branchName`, unless an
  explicit coordinator action intentionally changed branches;
- at verification time, confirm attributed SHAs are still ancestors of HEAD with
  `git merge-base --is-ancestor <sha> HEAD`. If ancestry is lost (force-push, reset, rewrite),
  do not silently verify — route to attention or ask for a fix-forward explanation.

In `worktree` mode, `prepareWorkerCheckout()` can delegate to the existing worktree preparation
logic.

## Handoff prompt changes

Current-branch worker prompts should say:

- you are working ticket `BW-123` in the current checkout/current branch;
- run `bw start BW-123` before beginning work unless the ticket is already started;
- do not create a branch, PR, or worktree unless explicitly instructed;
- keep the change scoped to this ticket;
- coordinate via `bw comment`, child tickets, dependencies, and labels;
- make atomic commits that clearly reference the ticket id;
- stage and commit only the specific files intentionally changed for this ticket;
- avoid broad staging commands such as `git add -A`, `git add .`, and `git commit -a` unless the
  ticket scope truly requires every affected path and you have inspected the resulting diff;
- do not stash, reset, clean, discard, or otherwise manipulate unrelated checkout state; it may
  belong to another active worker;
- inspect `git diff -- <specific-files>` and `git status --short` before committing so the commit
  contains only ticket-scoped work;
- before exiting, leave a concise beadwork handoff comment for the coordinator with status, commit SHAs,
  validation run/results, and any blockers or follow-up recommendations;
- close the ticket and run `bw sync` when done.

Worktree-mode prompts can keep the existing worktree wording.

## Commit attribution

Current-branch mode must review a commit set, not `launchHead..HEAD` wholesale.

Attribution is LLM work, not parser work. The coordinator gathers evidence and resolves what's
attributed to the ticket:

**Worker responsibilities:**

- include the beadwork ticket id in commit messages;
- leave a handoff comment with status, commit SHAs when known, and validation results;
- if the worker cannot identify its commits, explain why in the comment.

**Coordinator responsibilities after worker exit:**

Build a small LLM-readable attribution evidence pack for the coordinator/reviewer. The pack should
include:

- ticket context (description, parent epic goal);
- beadwork comments/history for the ticket;
- worker handoff comments;
- candidate commits after `launchHead` that reference the ticket id;
- ancestry-check results (`git merge-base --is-ancestor`);
- pointers to logs/runtime artifacts.

The evidence pack is context, not a schema. Do not build a deterministic attribution parser, do not
require a rigid handoff-comment format, and do not classify free text with brittle rules. The
coordinator/LLM reads the evidence and git history and makes the judgment. If it cannot confidently
resolve attribution, that is an `attention` or remediation condition, not a parsing failure to handle
with more code.

### Attribution risk acceptance

Attribution by commit message convention plus LLM handoff interpretation is intentionally fuzzy.
Workers may forget the ticket ID in some commits, amend commits, or produce ambiguous references.
This is acceptable risk for this phase. The per-worker review loop and final scope-completion review
catch problems that attribution misses.

If a worker produced valid ticket-scoped commits but omitted the ticket id from some commit messages,
prefer fix-forward attribution repair: add or request a beadwork comment that names the relevant
SHAs and explains the relationship to the ticket. Do not amend, rebase, or rewrite current-branch
history merely to satisfy the commit-message convention unless a human or explicit future workflow
chooses that path.

Later, beadwork can grow first-class ticket-to-commit metadata. The extension does not need to wait
for that to begin the migration.

## Completion, verification, and review triage

Current-branch mode has no merge-back phase because the work is already on the branch. The right
terminal concept is **verified**, not accepted: the worker claims the task is done, then the
coordinator verifies the ticket-attributed work.

Current-branch verification should separate per-worker review from integrated validation:

- per-worker completion review is ticket/commit-centered and runs for each exited worker unless
  review is explicitly disabled;
- full configured validation commands run at quiescent scope completion, when there are no active
  workers and no exited-unverified workers;
- standalone `/bw delegate <ticket>` treats the single ticket as the scope and runs configured
  validation once after the worker-completion review.

Do not run the full integrated validation suite after every current-branch worker by default. That
is expensive and has the wrong semantic boundary when other workers may still be active. Workers may
still report validation they ran in their handoff comments, and reviewers may request targeted checks
when useful.

### Runtime state recommendation

Keep the persisted top-level worker state as close to the existing code model as possible. Do **not**
add new top-level states such as `accepted`, `verifying`, `remediating`, `crashed`, `reassigned`, or
`blocked` just for bookkeeping.

Recommended minimal state changes:

- keep existing active/process states: `launching`, `running`, `exited`, `failed`, `attention`;
- add one current-branch terminal state: `verified`;
- reuse existing review/remediation fields for intermediate work rather than adding new fields;
- represent blocked/incomplete worker handoff as `attention` plus ticket/comment context, not a new
  top-level worker status;
- represent reassignment as a relationship/action on worker records, not a durable status required
  for scheduling.

Adding `verified` is a real state-model change that ripples through the full status surface
(registry, summaries, notices, diagnostics, action gating, normalization).

Add a derived successful-terminal concept for UI and orchestration summaries:

- current-branch successful terminal state: `verified`;
- worktree successful terminal state: `landed`;
- aggregate summaries may display both as complete/successful, but persisted worker status should
  remain mode-specific.

Do not rename `landed` to fit current-branch mode, and do not use `verified` for worktree workers
unless a later migration explicitly changes the worktree lifecycle.

The normal current-branch flow becomes:

```text
launching → running → exited → verified
                         ↘ launching → running  # coordinator-approved remediation relaunch
                         ↘ attention             # unresolved blocker / ambiguity / unsafe automation
                         ↘ failed                # infrastructure failure
```

`verified` means:

- the worker process exited;
- the ticket is closed, unless the worker explicitly handed off a blocker;
- attributed commits are discoverable, unless the ticket required no code changes;
- the per-worker review pass completed;
- any targeted checks requested during worker-level review were resolved or triaged;
- the coordinator triaged all review findings as `fix`, `file`, or `reject`;
- no unresolved `fix` finding remains for that ticket.

If the worker intentionally leaves the ticket blocked, that is not verified work. The coordinator
should preserve the explanation and either leave the ticket blocked, launch remediation, or mark the
worker outcome as needing human attention.

### Per-worker review triage

Review is a first-class part of every worker completion. For current-branch workers, the reviewer
receives a **list of commits** — not the full patch content — and uses subagents to inspect the
actual code changes as needed.

The reviewer receives the ticket description, epic/scope goal, attributed commit SHAs with
one-line messages, worker handoff comments, and relevant coordination context. The reviewer uses
its own tools (read, grep, git show, etc.) to inspect commits in detail. This keeps the review
prompt small and lets the reviewer focus effort proportionally.

Do not generate a truncated diff bundle or token-budgeted patch artifact for current-branch review.
The reviewer is an agent in the checkout and should inspect commits directly with git and repository
tools. `maxArtifactChars` may still apply to log excerpts or legacy worktree artifacts, but it should
not turn current-branch review into a lossy prompt-diff exercise.

Reviewer prompts should describe this as a review centered on ticket-attributed commits already
present on the current branch, not as a merge-back gate and not as a review of `launchHead..HEAD`
wholesale. Review findings must be concrete enough for the coordinator to triage as one of:

- `fix`: valid and in scope; send the finding to the worker/remediation prompt immediately;
- `file`: valid but out of scope or better handled later; create/comment follow-up work in beadwork;
- `reject`: invalid, contradictory to the goals, or based on a reviewer misunderstanding.

`reject` means rejecting the review finding. It does not mean rejecting or removing completed
commits. Recovery is fix-forward unless a future explicit revert workflow is added.

This triage does not need a new persistence subsystem. Durable coordination remains beadwork issues,
beadwork comments/history, git commits, and worker logs. Persist only the worker summary/status
needed for supervision and UI continuity.

For current-branch mode, this per-worker review is enabled by default. It should be skipped only when
review is explicitly disabled in config, not merely because older worktree landing review defaults were
off.

### Remediation behavior

Reuse the existing review-remediation concept from worktree mode: when the reviewer produces
coordinator-approved `fix` findings, relaunch the worker with a remediation prompt. The
substrate-specific differences are only cwd, artifact construction, and the absence of merge-back.

Current-branch remediation should relaunch in the same checkout/current branch with instructions to:

- continue ticket `BW-123`;
- address only the coordinator-approved `fix` findings or validation failures;
- ignore reviewer findings that the coordinator classified as `file` or `reject`;
- make additional atomic commits referencing the ticket;
- update the handoff comment with any new commit SHAs and validation results;
- close and sync when done, or explain the blocker.

Increase the remediation cap to **2 attempts** per ticket. If remediation does not converge after 2
attempts — or if attribution is missing, the ticket is not closed, or findings are outside safe
automated remediation — the worker outcome should be marked as needing human attention.

### Scope completion validation and review

A live epic/scope run may enter scope-completion verification only when:

- the target epic/scope has no remaining assignable ready work;
- all relevant tickets have reached a terminal beadwork state;
- no workers are still launching/running;
- no exited worker remains unverified.

The run should return `completed` only after integrated validation and scope-complete review finish
with no unresolved `fix` findings. This is a required behavior change from the current run loop, which
can stop as `completed` when all children are closed without also proving that no worker is still in
flight.

At scope completion, run the configured validation commands once on the integrated current checkout.
Then run a scope-complete review pass that explicitly names the epic/scope goal. The scope reviewer
receives the epic description, the list of all verified tickets with their attributed commit SHAs,
validation output, and any coordination notes. Like per-worker review, the scope reviewer uses
subagents to inspect actual code — the prompt stays small.

Scope-complete review is fix-forward. Previously verified worker records stay verified; new findings
create new work instead of reopening old worker-level completion:

- `fix`: create/comment a follow-up beadwork task, preferably as a child of the active epic/scope,
  with the reviewer finding, coordinator triage rationale, likely related ticket(s), and any relevant
  commit SHAs; launch a new worker when safe;
- `file`: create/comment follow-up work in beadwork without blocking the completed scope;
- `reject`: discard as invalid reviewer feedback.

If scope-level `fix` work is created, the scope is not complete yet; the scheduler should continue
with the new beadwork task(s). If it cannot safely launch them (e.g., remediation cap exhausted or
ambiguous attribution), stop with `attention`. Cap scope-level fix iterations at 2 rounds; route to
human attention if not converged.

For standalone `/bw delegate <ticket>`, the scope is the single ticket. Run configured validation once
on the current checkout as the single-ticket scope validation, but do not run an additional
scope-complete review beyond the normal worker-completion review.

Current-branch completion must not run:

- rebase;
- merge-back;
- worktree containment checks;
- worktree cleanup.

Reserve the word `landing` for worktree mode. For current-branch mode, prefer `verification`,
`verified`, or `completion`.

## `/bw run` scheduling

The near-term scheduler should use beadwork graph semantics first:

- launch only ready tickets;
- respect dependencies;
- avoid duplicate active workers for the same ticket;
- treat ready tickets as concurrently workable when the operator requests multiple workers;
- allow N current-branch workers when the operator requests N workers.

Do not infer path conflicts, require reservations, or block ready tickets based on guessed file
overlap in this migration. The beadwork dependency graph and ticket scope are the scheduling model.
Reservations, touched-path tracking, and conflict-risk scoring can be added later only as advisory
inputs, not as prerequisites or default concurrency gates.

## Implementation phases

### Phase 1: substrate foundation

- Add `workerExecution.mode` config and env parsing with `current-branch` as the target default.
- The phases below are a development ordering guide, not a deployment cadence. All phases ship together
  as one coherent implementation slice. Do not expose a half-migrated default: the actual runtime default
  must not flip to `current-branch` until launch (Phase 2), verification (Phase 3), registry
  normalization, and UI/diagnostic support are all present in the same release.
- Add `executionMode`, discriminated checkout fields, required current-branch `launchHead`, and
  checkout state.
- Add the `verified` worker status and update registry normalization, summaries, tracking/notices,
  diagnostics, worker-manager action gating, and old-record normalization tests.
- Normalize old registry records as `worktree` workers.
- Add `prepareWorkerCheckout()` while preserving existing worktree behavior.

### Phase 2: current-branch launch

- Make `launchTicketWorker()` branch by execution mode.
- Use repo root as tmux cwd in current-branch mode.
- Add current-branch handoff text.
- Update delegate/run/user-facing status text to say `checkout` or `current branch` instead of
  assuming `worktree`.

### Phase 3: current-branch verification path

- Split post-exit orchestration into current-branch verification and worktree landing.
- Discover ticket-attributed commits from beadwork handoff context plus git history.
- Run the per-worker review pass for every completed current-branch worker by default unless review is
  explicitly disabled.
- Apply coordinator triage (`fix`, `file`, `reject`) to all reviewer findings.
- Reuse the existing review-remediation relaunch path for coordinator-approved per-worker `fix`
  findings.
- Mark successful current-branch workers as `verified`.
- Skip rebase, merge-back, containment, and worktree cleanup in current-branch mode.
- Route missing attribution, unclosed tickets, unresolved fixes, and unsafe ambiguity to human
  attention.

### Phase 4: scope-completion validation and review

- Change `/bw run` completion detection so scope-completion verification starts only when there are no
  in-flight workers and no exited unverified workers, and `completed` is returned only after integrated
  validation and scope review have no unresolved `fix` findings.
- Run configured validation once at quiescent scope completion.
- Run scope-complete review with explicit epic/scope context.
- Treat scope-level `fix` findings as new fix-forward work: create/comment beadwork tasks and launch
  new workers when safe, rather than invalidating already verified worker records.
- Apply the same `fix`, `file`, `reject` coordinator triage to scope-level findings.

### Phase 5: hardening

- Confirm `current-branch` is the active default execution mode only after the launch,
  verification, review/remediation, registry normalization, scope-completion, UI/diagnostic, and
  legacy worktree tests pass as one coherent implementation slice.
- Keep `worktree` available through explicit config.
- Add UI/status labels so active workers clearly show their execution mode.
- Document the commit-message and handoff-comment conventions.

## Tests to add

- current-branch launch does not call `prepareTicketWorktree()`;
- tmux cwd is the repo root/current checkout and the tmux API names this as `cwd`/`checkoutPath`, not
  `worktreePath`;
- current-branch workers do not fake `worktreePath = repoRoot`;
- current-branch launch does not fail solely because the checkout has dirty or untracked files;
- current-branch launch rejects detached HEAD unless explicitly configured;
- current-branch verification detects branch drift from the recorded launch branch;
- registry normalization preserves legacy worktree records and accepts current-branch records with
  `verified` status;
- handoff prompts require `bw start`, forbid creating a branch/PR/worktree by default, ask for atomic
  ticket-referenced commits, and ask for a coordinator handoff comment;
- handoff prompts discourage broad staging commands and instruct workers to commit specific files;
- `/bw run --workers N` can launch multiple current-branch workers;
- current-branch verification skips rebase, merge-back, containment checks, and worktree cleanup;
- every current-branch worker completion triggers reviewer context centered on ticket-attributed
  commits, not `launchHead..HEAD` wholesale;
- current-branch review does not construct or pass a token-budgeted/truncated patch bundle as the
  primary review artifact;
- coordinator review triage can classify findings as `fix`, `file`, or `reject`;
- current-branch review defaults to on and is skipped only when config explicitly disables it;
- remediation prompts include only coordinator-approved `fix` findings and cap at 2 attempts;
- missing attribution is routed to remediation or human attention;
- valid commits missing ticket ids can be attributed through beadwork handoff/comment evidence
  without rewriting current-branch history;
- repeated verification after supervisor polling or coordinator restart does not duplicate
  remediation launches or follow-up beadwork tasks;
- `/bw run` does not stop as `completed` while workers are still active, exited-but-unverified, or
  scope-level validation/review has unresolved `fix` findings;
- scope-complete validation/review runs once for epic/scope runs after quiescence;
- scope-level `fix` findings create fix-forward beadwork work and do not mutate already verified worker
  records back into worker-level remediation;
- quiescent dirty-state remediation runs before scope-completion validation and never while workers
  are still active;
- standalone `/bw delegate <ticket>` treats the ticket as the scope, runs configured validation once,
  and does not run an extra scope-complete review beyond the normal worker-completion review;
- worktree mode preserves existing launch, validation, review, landing, and cleanup behavior;
- old registry records normalize safely.

## Decisions (previously open questions)

**Handoff comments:** beadwork comments are first-class coordination, not a deterministic mini-format
to parse. Workers should leave concise comments that include status, commit SHAs when known,
validation claims, and blockers. A `handoff:` prefix is recommended for readability, but the
coordinator should gather ticket comments/history and use them as LLM-readable handoff evidence.

**Current-branch terminal state:** `verified`. Do not use `accepted`. Reserve `landed` for worktree
mode. Avoid adding `verifying`, `remediating`, `crashed`, `reassigned`, or `blocked` as top-level
worker statuses unless implementation proves they are necessary; existing fields already represent
most of those concepts.

**Closed ticket with no attributed commits:** if comments/history explain why no code changes were
needed (research, investigation, already-complete task, configuration outside this repo), mark the
work verified. If there is no explanation and no attributed commits, route to attention.

**Review-finding triage persistence:** do not add a separate persistence subsystem for triage.
Durable coordination should stay in beadwork issues/comments/history, git commits, worker logs, and
minimal worker runtime status needed by the supervisor/UI.

**Reassignment lineage:** do not add structured lineage fields unless implementation needs them for a
specific behavior. For now, carry the dead worker's `launchHead`, known commit evidence, and relevant
comments/log context into the replacement prompt and beadwork comments. Add fields such as
`replacesWorkerId` only if UI, remediation caps, or recovery logic cannot work from that context.

**Post-scope validation attribution:** cross-reference failing files/tests against the ticket commit
sets and handoff context. The coordinator/LLM creates fix-forward follow-up work for
likely-responsible areas. Previously verified worker records remain verified. If attribution is
ambiguous or unsafe to automate, flag for human attention.

## Worker crash recovery

When a current-branch worker dies (process exit without ticket closure, tmux pane disappears,
or configurable `workerExecution.maxLifetime` timeout — default: no limit, supervisor polling
detects exit/disappearance):

**Crash vs. blocked:** after worker exit, the coordinator gathers ticket comments/history and
evaluates whether the worker crashed (no actionable handoff context) or deliberately blocked
(handoff comment explains the blocker). This is coordinator judgment, not deterministic parsing.
Crashed workers are auto-reassigned; blocked workers route to `attention` for coordinator triage.

Closed-ticket exited workers are not crash-reassigned. They enter current-branch verification. If
verification finds unresolved `fix` findings, missing attribution, or ambiguity, use the normal
remediation/attention path.

Exited workers with an open or in-progress ticket are handled by coordinator judgment:

- actionable blocker handoff: preserve the explanation in beadwork and route to `attention`;
- no actionable handoff: reassign the same ticket to a replacement worker;
- partial ticket-referenced commits: replacement inherits them and fixes forward;
- ambiguous but likely relevant commits: replacement may clarify attribution by beadwork comment;
- do not reset, stash, revert, amend, or rewrite partial current-branch work as part of crash
  recovery unless a future explicit revert workflow is added.

**Verification hook:** current-branch verification should run inside `inspectWorkerRuntime`, mirroring
the existing `autoLandCompletedWorker` pattern for worktree mode. When inspection detects a
closed-ticket exited current-branch worker, it should trigger `verifyCurrentBranchWorker` (or
equivalent). Reuse the existing orchestration-lock pattern (promise deduplication per worker) to
prevent double-verification when concurrent inspection calls race. This ensures only *problematic*
exited workers remain to trigger the loop's `attention` stop condition.

Verification must also be idempotent across repeated supervisor polls and coordinator restarts. Do
not add a separate durable lock system for this phase. Instead, make `verifyCurrentBranchWorker`
safe to repeat:

- return immediately for workers already marked `verified`;
- rederive attribution evidence from beadwork history and git;
- avoid duplicate remediation launches for the same unresolved finding;
- check for existing follow-up beadwork tasks/comments before creating new ones;
- preserve prior review summaries unless new evidence changes the coordinator judgment.

1. Reassign the same bead/ticket to a replacement worker outside the normal ready-only scheduler
   path. A crashed/in-progress ticket is not "ready" in the usual beadwork sense, but it is still
   eligible for explicit replacement because ownership by the dead worker has ended.
2. The replacement worker inherits the dead worker's `launchHead` so commit attribution covers both
   the original and replacement attempts.
3. The replacement handoff prompt must include:
   - existing attributed commits for this ticket, if any;
   - the dead worker's last known state;
   - any handoff/comment fragments left by the dead worker;
   - instruction to verify existing commits before starting new work.
4. Partial commits from the dead worker that reference the ticket ID remain on the branch. The
   replacement inherits and fixes forward from them.
5. Do not have the coordinator pre-inspect or classify dirty state before replacement. The replacement
   worker operates in the checkout and can make the local ticket-scoped judgment as part of normal
   handoff execution.
6. If the checkout has uncommitted changes while workers are still running, the coordinator should
   not intervene — the changes may belong to an active worker.
7. When the bounded loop is quiescent (no assignable work and no in-flight workers), any remaining
   dirty/untracked state is abandoned state. **This runs before scope-completion validation** — the
   checkout must be confirmed clean before integrated validation/review makes sense. Run one
   LLM-based "take care of it" remediation pass in the checkout to commit/fix/discard/escalate and
   leave the checkout clean if safe. If the LLM cannot safely resolve it, mark human attention and
   do not proceed to scope-completion validation.

This dirty-state pass is not a file-locking system, conflict detector, or active-worker guard. It is
only a quiescent cleanup step. While workers are active, the coordinator should observe and record
state but not attempt to classify or mutate uncommitted checkout contents.

### Current-branch state flow

Use the existing worker-state vocabulary plus one terminal state:

```text
launching → running → exited → verified
                         ↘ launching → running  # coordinator-approved remediation relaunch
                         ↘ attention             # blocker, ambiguous attribution, unresolved fix, unsafe dirty state
                         ↘ failed                # infrastructure failure
```

Do not introduce top-level `accepted`, `verifying`, `remediating`, `crashed`, `reassigned`, or
`blocked` states for current-branch mode. Verification is an orchestration step performed after
`exited`; remediation is represented by relaunching the worker and existing review/remediation fields;
reassignment is an action/relationship; blockers route through beadwork ticket state plus `attention`.

The bounded epic loop must be tightened for current-branch mode: scope-completion verification should
start only when all scoped tickets are terminal, no workers are active, and no exited worker remains
unverified. The loop should return `completed` only after integrated validation and scope-complete
review have no unresolved `fix` findings.

## Working thesis

Make the extension substrate-aware now. Ship current-branch as the default execution mode once the
current-branch launch, verification, registry, and UI/diagnostic slice is coherent. Keep worktrees as
a configured isolation mode.

That gives beadwork the same-branch swarm model without a half-migrated default while preserving the
existing coordination, verification, remediation, and review-finding triage cycle. It also creates clean
attachment points for later graph intelligence, file-impact analysis, path reservations, and
speculative execution.
