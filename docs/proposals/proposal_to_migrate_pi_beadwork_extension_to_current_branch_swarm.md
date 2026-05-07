# Proposal: migrate pi beadwork extension to current-branch swarm execution

Date: 2026-05-06
Status: proposed migration path

## Purpose

Define a practical migration path from the pi beadwork extension's current worktree-centric
orchestration model to a **current-branch default** model for same-branch worker swarms.

This proposal builds on the existing current-branch sketch and the beadwork/beads_viewer review,
but intentionally narrows scope to the extension migration needed now. It preserves delegation,
coordination, verification, remediation, and rejection cycles without forcing every worker into an
isolated worktree.

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
   - current-branch: verify, review, accept, remediate, or reject attributed commits already on the
     branch;
   - worktree: keep the existing validate, review, rebase, merge-back, and cleanup pipeline.
5. Defer graph intelligence, path impact analysis, speculative execution, and richer scheduling
   heuristics until the substrate split is complete.

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
- each worker owns one beadwork ticket;
- workers coordinate through beadwork tickets, dependencies, comments, labels, and later optional
  reservation/mail mechanisms;
- workers make atomic commits that reference their ticket id;
- workers close their ticket and sync when done;
- the coordinator verifies the ticket-attributed work and either accepts it, asks for fixes, or
  marks it as needing attention/rejection.

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

Introduce an execution substrate abstraction:

```ts
type WorkerExecutionMode = "current-branch" | "worktree";

type WorkerCheckout = {
  mode: WorkerExecutionMode;
  checkoutPath: string;
  branchName: string;
  launchHead?: string;
};
```

Extend worker runtime state with generic checkout fields:

```ts
type WorkerRuntime = {
  workerId: string;
  ticketId: string;
  epicId?: string;

  executionMode: WorkerExecutionMode;
  checkoutPath: string;
  branchName: string;
  launchHead?: string;
  lastObservedHead?: string;

  commitShas?: string[];
  touchedPaths?: string[];
  reservedPaths?: string[];

  // Existing tmux/runtime/log/review/validation fields remain.
};
```

Keep `worktreePath` temporarily for compatibility with existing registry records and worktree-mode
workers. New code should prefer `executionMode` and `checkoutPath`.

## Configuration

Add a neutral worker execution block:

```json
{
  "workerExecution": {
    "mode": "current-branch"
  }
}
```

Supported initial modes:

- `current-branch` — default;
- `worktree` — existing behavior, explicit isolation mode.

Add an environment override:

```sh
PI_BEADWORK_WORKER_EXECUTION_MODE=current-branch
```

The existing `worktrees` config should remain, but it should only apply when `mode` is `worktree`.

## Launch migration

Replace direct calls to `prepareTicketWorktree()` with a generic `prepareWorkerCheckout()`.

In `current-branch` mode, launch should:

1. resolve the repository root/current checkout;
2. record current branch and `launchHead` as observational metadata;
3. create worker runtime/log/scratch directories;
4. launch tmux with cwd set to the repo root;
5. use a current-branch-specific handoff prompt;
6. never create a branch or worktree.

In `worktree` mode, `prepareWorkerCheckout()` can delegate to the existing worktree preparation
logic.

## Handoff prompt changes

Current-branch worker prompts should say:

- you are working ticket `BW-123` in the current checkout/current branch;
- do not create a branch, PR, or worktree unless explicitly instructed;
- keep the change scoped to this ticket;
- coordinate via `bw comment`, child tickets, dependencies, and labels;
- make atomic commits that clearly reference the ticket id;
- close the ticket and run `bw sync` when done;
- if possible, leave a comment listing commit SHAs before exiting.

Worktree-mode prompts can keep the existing worktree wording.

## Commit attribution

Current-branch mode must review a commit set, not `launchHead..HEAD` wholesale.

First practical attribution mechanism:

1. require worker commits to include the beadwork ticket id in the commit message;
2. ask workers to leave a commit manifest comment, for example:

   ```sh
   bw comment BW-123 "commits: abc123 def456"
   ```

3. after worker exit, discover commits after `launchHead` whose messages reference the ticket id;
4. store discovered SHAs on `worker.commitShas`;
5. route missing or ambiguous attribution to attention/remediation.

Later, beadwork can grow first-class ticket-to-commit metadata. The extension does not need to wait
for that to begin the migration.

## Completion, verification, and rejection

Current-branch mode has no merge-back phase because the work is already on the branch.

A current-branch worker is accepted when:

- the worker process exits;
- the ticket is closed or intentionally left blocked with an explanation;
- attributed commits are discoverable, unless the ticket required no code changes;
- required validation passes in the shared checkout;
- optional review approves the attributed commit set.

If validation or review fails, the coordinator should launch remediation in the same checkout. If
attribution is missing, the ticket is not closed, or findings are outside safe remediation, the worker
should be marked as needing attention/rejection.

Current-branch completion must not run:

- rebase;
- merge-back;
- worktree containment checks;
- worktree cleanup.

Reserve the word `landing` for worktree mode where possible. For current-branch mode, prefer
`verification`, `acceptance`, or `completion`.

## Review behavior

Review should be mode-specific.

For current-branch workers, build artifacts from attributed commits:

```sh
git show --stat --patch <sha>
git show --name-only --format=fuller <sha>
```

Reviewer context should include:

- ticket title and description;
- attributed commit SHAs;
- patch/stat/name-only output for those SHAs;
- touched path summary;
- validation output;
- relevant beadwork comments or coordination notes.

Reviewer prompts should describe this as a review of ticket-attributed commits already present on the
current branch, not as a merge-back gate.

Worktree-mode review can keep the existing branch diff and landing-gate semantics.

## Remediation behavior

Current-branch remediation should relaunch in the same checkout/current branch with instructions to:

- continue ticket `BW-123`;
- address the validation/review findings;
- make additional atomic commits referencing the ticket;
- update the commit manifest/comment if required;
- close and sync when done, or explain the blocker.

It should not mention an existing worktree unless the worker is actually in worktree mode.

## `/bw run` scheduling

The near-term scheduler should use beadwork graph semantics first:

- launch only ready tickets;
- respect dependencies;
- avoid duplicate active workers for the same ticket;
- preserve epic-level launch serialization where useful;
- allow N current-branch workers when the operator requests N workers.

Do not require file reservations before same-branch concurrency works. Reservations, touched-path
tracking, and conflict-risk scoring can be added later as advisory scheduling inputs.

## Implementation phases

### Phase 1: substrate foundation

- Add `workerExecution.mode` config and env parsing.
- Add `executionMode`, `checkoutPath`, `launchHead`, and optional attribution fields to runtime
  state.
- Normalize old registry records as `worktree` workers.
- Add `prepareWorkerCheckout()` while preserving existing worktree behavior.

### Phase 2: current-branch launch

- Make `launchTicketWorker()` branch by execution mode.
- Use repo root as tmux cwd in current-branch mode.
- Add current-branch handoff text.
- Update delegate/run/user-facing status text to say `checkout` or `current branch` instead of
  assuming `worktree`.

### Phase 3: current-branch completion path

- Split post-exit orchestration into current-branch verification and worktree landing.
- Discover ticket-attributed commits.
- Run validation in `checkoutPath`.
- Skip rebase, merge-back, containment, and worktree cleanup in current-branch mode.
- Route missing attribution or validation failures to remediation/attention.

### Phase 4: review and remediation

- Add current-branch review artifact gathering from attributed commits.
- Add current-branch reviewer prompt variant.
- Add current-branch remediation prompt variant.
- Preserve existing worktree review/remediation path.

### Phase 5: default flip and hardening

- Make `current-branch` the default once tests cover the mode split.
- Keep `worktree` available through explicit config.
- Add UI/status labels so active workers clearly show their execution mode.
- Document the commit-message and optional `bw comment` manifest convention.

## Tests to add

- current-branch launch does not call `prepareTicketWorktree()`;
- tmux cwd is the repo root/current checkout;
- handoff forbids creating a branch, PR, or worktree by default;
- `/bw run --workers N` can launch multiple current-branch workers;
- current-branch completion skips rebase, merge-back, containment checks, and worktree cleanup;
- validation runs in `checkoutPath`;
- review artifacts include only ticket-attributed commits;
- missing attribution is routed to attention/remediation;
- worktree mode preserves existing launch, validation, review, landing, and cleanup behavior;
- old registry records normalize safely.

## Open questions

- Should commit-message ticket references be mandatory in current-branch mode, or should manifest
  comments be enough?
- What should the current-branch terminal state be called: `accepted`, `verified`, `completed`, or
  `landed`?
- How strict should the extension be when a closed ticket has no attributed commits?
- Should reviewer agents be read-only in current-branch mode?
- How should validation be batched when several workers finish close together?
- Which coordination primitive should come first after the migration: manifest comments, path
  reservations, or direct worker mail?

## Working thesis

Make the extension substrate-aware now. Default to current-branch execution. Keep worktrees as a
configured isolation mode.

That gives beadwork the same-branch swarm model immediately while preserving the existing
coordination, verification, remediation, and rejection cycle. It also creates clean attachment points
for later graph intelligence, file-impact analysis, path reservations, and speculative execution.
