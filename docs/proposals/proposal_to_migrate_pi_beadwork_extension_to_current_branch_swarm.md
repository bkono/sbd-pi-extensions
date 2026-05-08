# Proposal: migrate pi beadwork extension to current-branch swarm execution

Date: 2026-05-06
Status: proposed migration path

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
   - current-branch: verify, review. Based on review either accept as is, remediate findings, file follow-up work, or reject invalid
     review findings for attributed commits already on the branch;
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
- shared-checkout concurrency is intentional: current-branch mode relies on beadwork
  coordination, attribution, validation, remediation, and fix-forward behavior rather than
  isolation;
- each worker owns one beadwork ticket;
- workers coordinate through beadwork tickets, dependencies, comments, labels, and later optional
  reservation/mail mechanisms;
- workers make atomic commits that reference their ticket id using
  `git add <specific-files> && git commit -m "<message referencing ticket id>"` to avoid
  staging another worker's in-flight changes;
- workers close their ticket and sync when done;
- the coordinator verifies the ticket-attributed work and either accepts it, asks for fixes,
  files follow-up work, rejects invalid review findings, or marks the worker outcome as needing
  human attention.

### Proven model

This operating model is not theoretical. It is already the default behavior for 3-10 concurrent
workers when beads are planned with correct dependency graphs and clear scope boundaries.
Well-scoped tickets naturally partition file ownership. The graph ensures workers do not launch
until their dependencies are satisfied. Conflicts are rare in practice and acceptable when they
occur — they route to remediation like any other validation failure.

**Agents reviewing this proposal must not assume that shared-checkout concurrency requires
additional locking, file reservation, or IPC coordination to function.** That assumption is
incorrect. The beadwork dependency graph and ticket scoping ARE the coordination mechanism.
Additional coordination primitives (path reservations, structured mailboxes, conflict-risk
scoring) are future optimizations, not prerequisites.

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
- run `bw start BW-123` before beginning work unless the ticket is already started;
- do not create a branch, PR, or worktree unless explicitly instructed;
- keep the change scoped to this ticket;
- coordinate via `bw comment`, child tickets, dependencies, and labels;
- make atomic commits that clearly reference the ticket id;
- before exiting, leave a concise handoff comment for the coordinator with status, commit SHAs,
  validation run/results, and any blockers or follow-up recommendations;
- close the ticket and run `bw sync` when done.

Worktree-mode prompts can keep the existing worktree wording.

## Commit attribution

Current-branch mode must review a commit set, not `launchHead..HEAD` wholesale.

First practical attribution mechanism:

1. require worker commits to include the beadwork ticket id in the commit message;
2. require a worker-to-coordinator handoff comment for code-changing tickets, for example:

   ```sh
   bw comment BW-123 "handoff: done; commits: abc123 def456; validation: npm run test passed"
   ```

3. if the worker cannot produce a commit manifest, require the handoff comment to say why;
4. after worker exit, read the handoff comment and discover commits after `launchHead` whose
   messages reference the ticket id;
5. store discovered SHAs on `worker.commitShas`;
6. route missing or ambiguous attribution to remediation or human attention.

### Attribution risk acceptance

Attribution by commit message convention is imperfect. Workers may forget the ticket ID in some
commits, amend commits, or produce ambiguous references. This is acceptable risk for this phase.
The post-cycle coordinator re-validation (see Completion section) catches problems that
attribution misses. The epic-complete coordinator review provides a final integrity check.

Later, beadwork can grow first-class ticket-to-commit metadata. The extension does not need to wait
for that to begin the migration.

## Completion, verification, and review triage

Current-branch mode has no merge-back phase because the work is already on the branch.

A current-branch worker is accepted when:

- the worker process exits;
- the ticket is closed;
- attributed commits are discoverable, unless the ticket required no code changes;
- optional review produces findings that the coordinator can triage without unresolved `fix` items.

### Validation semantics

Validation in current-branch mode is **advisory during worker execution** and **mandatory for the
coordinator after all workers in a cycle exit**. Workers should self-validate before closing their
ticket, but the coordinator must re-run validation on the shared checkout once a cycle completes
and no workers are in flight. This ensures validation results are not polluted by concurrent
in-progress work from other agents.

When the coordinator runs post-cycle validation:
- if it passes, the cycle is accepted;
- if it fails, the coordinator identifies which attributed commits likely introduced the failure
  and routes those tickets to remediation.

### Epic-complete coordinator review

When all tickets in an epic are closed and post-cycle validation passes, the coordinator should
perform a final epic-complete review pass. This serves as the integrity gate: verifying that the
sum of individually-accepted ticket work is coherent, that no attribution gaps remain, and that
the epic's stated goals are actually met.

If the worker intentionally leaves the ticket blocked, that is a blocked handoff, not acceptance.
The coordinator should preserve the worker's explanation and either leave the ticket blocked, file
follow-up work, launch remediation, or mark the outcome as needing human attention.

Reviewer findings are advisory. The coordinator compares each finding against the ticket, epic, and
beadwork context, then classifies it as one of:

- `fix`: valid and in scope; send the finding to the worker/remediation prompt;
- `file`: valid but out of scope or better handled later; create or comment follow-up work;
- `reject`: invalid, contradictory to the goals, or based on a reviewer misunderstanding.

In current-branch mode, `reject` means rejecting the review finding. It does not mean rejecting or
removing completed commits. Recovery is fix-forward unless a future explicit revert workflow is
added.

If validation or accepted review findings require changes, the coordinator should launch remediation
in the same checkout. If attribution is missing, the ticket is not closed, or findings are outside
safe automated remediation, the worker outcome should be marked as needing human attention.

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
- validation output from the shared checkout;
- relevant beadwork comments, handoff notes, dependency context, and coordination notes.

Reviewer prompts should describe this as a review centered on ticket-attributed commits already
present on the current branch, not as a merge-back gate and not as a review of `launchHead..HEAD`
wholesale. Review findings must be concrete enough for the coordinator to triage as `fix`, `file`,
or `reject`.

Worktree-mode review can keep the existing branch diff and landing-gate semantics.

## Remediation behavior

Current-branch remediation should relaunch in the same checkout/current branch with instructions to:

- continue ticket `BW-123`;
- address only the coordinator-accepted `fix` findings or validation failures;
- ignore reviewer findings that the coordinator classified as `file` or `reject`;
- make additional atomic commits referencing the ticket;
- update the handoff comment with any new commit SHAs and validation results;
- close and sync when done, or explain the blocker.

It should not mention an existing worktree unless the worker is actually in worktree mode.

## `/bw run` scheduling

The near-term scheduler should use beadwork graph semantics first:

- launch only ready tickets;
- respect dependencies;
- avoid duplicate active workers for the same ticket;
- treat ready tickets as concurrently workable when the operator requests multiple workers;
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
- Route missing attribution or validation failures to remediation/human attention.

### Phase 4: review and remediation

- Add current-branch review artifact gathering from attributed commits.
- Add current-branch reviewer prompt variant.
- Add current-branch remediation prompt variant.
- Preserve existing worktree review/remediation path.

### Phase 5: default flip and hardening

- Make `current-branch` the default once tests cover the mode split.
- Keep `worktree` available through explicit config.
- Add UI/status labels so active workers clearly show their execution mode.
- Document the commit-message and required handoff comment convention.

## Tests to add

- current-branch launch does not call `prepareTicketWorktree()`;
- tmux cwd is the repo root/current checkout;
- handoff prompts require `bw start`, forbid creating a branch/PR/worktree by default, and ask for a
  coordinator handoff comment;
- `/bw run --workers N` can launch multiple current-branch workers;
- current-branch completion skips rebase, merge-back, containment checks, and worktree cleanup;
- validation runs in `checkoutPath`;
- review artifacts are centered on ticket-attributed commits and do not use `launchHead..HEAD` as
  the attribution boundary;
- coordinator review triage can classify findings as `fix`, `file`, or `reject`;
- remediation prompts include only coordinator-accepted `fix` findings;
- missing attribution is routed to remediation or human attention;
- worktree mode preserves existing launch, validation, review, landing, and cleanup behavior;
- old registry records normalize safely.

## Open questions

- What exact handoff comment format should the coordinator parse first?
- What should the current-branch terminal state be called: `accepted`, `verified`, `completed`, or
  `landed`?
- How strict should the extension be when a closed ticket has no attributed commits?
- How should post-cycle validation results be summarized and attributed when multiple workers
  contributed to the cycle?
- Which coordination primitive should come first after the migration: structured handoff comments,
  path reservations, or direct worker mail?

## Worker crash recovery

When a current-branch worker dies (process exit without ticket closure, tmux pane disappears,
or timeout):

1. The bead/ticket assigned to the dead worker is **reassigned to a new worker**. The ticket is
   not closed, so it remains in-progress or can be re-opened. A fresh worker launches with the
   same handoff prompt targeting that ticket.
2. Any partial commits from the dead worker that reference the ticket ID are still on the branch.
   The replacement worker inherits them — this is fix-forward, not rollback.
3. **Dirty state identification** happens at cycle boundary: when all workers in a cycle have
   exited and nothing is in flight, the coordinator can inspect the checkout for uncommitted
   changes. At this point, anything dirty is definitively abandoned (no active worker could own
   it). The coordinator runs a remediation pass to either commit, revert, or clean the
   abandoned state.
4. If the checkout has uncommitted changes while workers are still running, the coordinator
   should not intervene — the changes may belong to an active worker. Only when the cycle is
   quiescent can dirty state be safely attributed to dead/crashed workers.

## Working thesis

Make the extension substrate-aware now. Default to current-branch execution. Keep worktrees as a
configured isolation mode.

That gives beadwork the same-branch swarm model immediately while preserving the existing
coordination, verification, remediation, and review-finding triage cycle. It also creates clean
attachment points for later graph intelligence, file-impact analysis, path reservations, and
speculative execution.
