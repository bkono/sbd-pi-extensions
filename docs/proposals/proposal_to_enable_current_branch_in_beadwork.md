# Proposal: enable current-branch workers in the pi beadwork extension

Date: 2026-05-05
Status: exploratory proposal, not yet actionable implementation plan

## Purpose

Capture the current thinking for unwinding the pi beadwork extension's hard dependency on
per-ticket worktrees and moving toward current-branch worker execution as the default.

This document is intentionally a proposal sketch. It records the architecture direction,
important constraints, and places where the current implementation is worktree-shaped. It is
not yet a detailed task breakdown.

## Corrected operating model

The desired default is **same-branch concurrent agents**:

- many workers can run at the same time in the same checkout and on the same branch;
- each worker owns one beadwork ticket, makes atomic commits, closes the ticket, and syncs;
- bead dependencies, ticket scope, comments, and eventually reservations/agent mail coordinate
  the swarm;
- worktrees are optional isolation/speculation tooling, not the default worker substrate.

This means current-branch mode is not a degraded fallback and should not be treated as unsafe
by definition. It is the primary workflow the extension should learn to orchestrate.

The prior framing of `baseHead..currentHead` as the main review/landing unit is wrong for this
model. In a same-branch swarm, other workers may commit between launch and completion. The
stable unit is not "everything since the worker started"; it is the set of commits attributed
to a ticket/worker.

## Current implementation shape

The current `packages/pi-beadwork-extension` delegated-worker flow is worktree-mandatory:

- `launchTicketWorker()` prepares a per-ticket worktree before launching the worker.
- tmux launches the worker with its cwd set to the prepared worktree path.
- worker handoff language says the agent is working one ticket in one worktree.
- remediation prompts tell workers to continue in the existing worktree.
- review artifacts are built from repo-head vs worker-head diffs in that worktree.
- landing means rebase/validate/review/merge-back/verify containment.
- cleanup means removing retained worktree/runtime artifacts when safe.

That architecture is coherent for isolated branch/worktree delegation, but it makes worktrees
the substrate rather than one execution mode.

## Desired architecture shift

Introduce an execution substrate abstraction and make current-branch mode the default.

Conceptually:

```ts
type WorkerExecutionMode = "current-branch" | "worktree";

interface WorkerCheckout {
  mode: WorkerExecutionMode;
  checkoutPath: string;
  branchName: string;
  // Observational only in current-branch mode. Not an ownership range.
  launchHead?: string;
}
```

Then replace worktree-specific launch/orchestration assumptions with mode-specific behavior:

- current-branch mode uses the repo checkout as the worker cwd;
- worktree mode creates/reuses the per-ticket worktree as it does today;
- handoff, remediation, validation, review, landing, and cleanup branch by execution mode;
- runtime state records the mode so existing workers remain interpretable.

## Runtime model

Today worker runtime state is effectively a worktree runtime. It records fields like
`worktreePath`, `branchName`, tmux coordinates, log paths, cleanup policy, validation state,
landing state, and review state.

A current-branch-capable runtime should separate generic worker state from substrate-specific
state:

```ts
interface WorkerRuntime {
  workerId: string;
  ticketId: string;
  epicId?: string;
  executionMode: "current-branch" | "worktree";
  checkoutPath: string;
  branchName: string;

  // Useful for observability, but not attribution.
  launchHead?: string;
  lastObservedHead?: string;

  // The durable attribution unit in current-branch mode.
  commitShas?: string[];

  // Coordination signals, initially advisory.
  reservedPaths?: string[];
  touchedPaths?: string[];

  runtimeDir: string;
  logFile: string;
  stateFile: string;
  tmuxSession: string;
  tmuxWindow: string;
  tmuxPane: string;

  validationStatus?: "not-run" | "passed" | "failed";
  reviewStatus?: "not-run" | "pending" | "approved" | "changes-requested" | "blocked";
  completionStatus?: "running" | "closed" | "needs-attention" | "completed";
}
```

For backward compatibility, `worktreePath` can remain as a deprecated alias or as part of a
`worktree` detail object for worktree-mode workers. New orchestration should prefer
`checkoutPath` + `executionMode`.

## Launch behavior

### Current-branch mode

Worker launch should not call `prepareTicketWorktree()`.

It should:

1. resolve the repo root/current checkout;
2. record the current branch and launch head as observational metadata;
3. create the worker runtime/log directory;
4. launch tmux with cwd set to the repo checkout;
5. hand the worker a current-branch-specific brief.

The handoff should say, in plain language:

- you are working ticket `BW-123` in the current checkout/current branch;
- do not create a branch, PR, or worktree unless explicitly instructed;
- keep the change scoped to the ticket;
- coordinate with sibling workers through `bw comment`, child tickets, and any reservation/mail
  mechanism available;
- make one or more atomic commits that clearly reference the ticket id;
- close the ticket and run `bw sync` when done.

### Worktree mode

Worktree mode can keep the current behavior:

- prepare/reuse a per-ticket worktree;
- launch tmux in that worktree;
- validate/review/land through merge-back;
- cleanup retained worktree artifacts according to policy.

The important change is that this becomes an explicit mode, not the hidden invariant behind all
delegation.

## `/bw run` swarm behavior

`/bw run` should be able to launch N same-branch workers by default.

The scheduler should use beadwork's existing graph semantics first:

- only launch ready tickets;
- respect dependencies;
- avoid launching duplicate workers for the same ticket;
- prefer independent graph tracks when capacity is available.

Then it can layer in coordination signals:

- ticket descriptions and labels;
- recent `bw comment` coordination notes;
- optional file/path reservations;
- observed touched paths from active workers;
- risk heuristics from prior commits or static analysis.

Same-branch concurrency should not be artificially capped to one worker. If the graph and the
operator allow N workers, the extension should support N workers sharing the checkout.

## Commit attribution, not branch-range attribution

Current-branch mode needs a commit-set model.

Possible attribution signals, from weakest to strongest:

1. commit message contains the ticket id (`BW-123`, `Fixes BW-123`, etc.);
2. worker posts `bw comment BW-123 "commits: <sha> ..."` before closing;
3. extension records new commits whose message references the ticket while the worker was alive;
4. beadwork grows first-class ticket/commit metadata;
5. extension or agent-mail layer records worker-authored commit manifests.

The orchestrator should review and summarize those attributed commits with commands like:

```sh
git show --stat --patch <sha>
git show --name-only --format=fuller <sha>
```

It should not assume that every commit between launch head and current HEAD belongs to the
worker. In a same-branch swarm, that assumption is false by design.

Open design question: how strict should attribution be before first-class beadwork support
exists? A practical first version may require commit messages to include the ticket id and ask
workers to comment their commit SHAs before closing.

## Completion and landing semantics

Current-branch mode does not have a merge-back phase. The work is already on the branch.

So "landing" should split into two mode-specific meanings:

### Current-branch completion

A current-branch worker is complete when:

- the worker process exits successfully;
- the ticket is closed or intentionally left with an explained blocked state;
- attributed commits are discoverable;
- required validation passes, or failures are captured and routed to attention/remediation;
- optional review approves the attributed commit set.

No rebase, merge-back, worktree containment check, or worktree cleanup should run.

### Worktree landing

A worktree worker is landed when the existing merge-back pipeline verifies that the worker
branch is integrated into the parent branch and cleanup policy has been applied or retained.

## Review semantics

Review should also be mode-specific.

For current-branch workers, reviewer context should be built from the attributed commit set:

- ticket id and ticket description;
- commit SHAs attributed to the ticket/worker;
- `git show` output for those SHAs;
- touched-path summary;
- validation output;
- relevant comments/reservations/coordination notes.

For worktree workers, the existing repo-head/worker-head diff review can remain.

Reviewer prompts should stop talking about merge-back gates when reviewing current-branch
workers. The review gate is about whether the attributed commits satisfy the ticket and avoid
regressions, not whether a worktree branch is safe to merge.

## Remediation semantics

Current-branch remediation should relaunch or continue the worker in the same checkout/current
branch, with a prompt like:

- continue ticket `BW-123` on the current branch;
- address the validation/review findings below;
- make additional atomic commit(s) referencing the ticket;
- comment the new commit SHAs if required;
- close/sync when done.

It should not mention an existing worktree unless the worker is actually in worktree mode.

## Coordination and reservations

File reservations should be treated as cooperative swarm coordination, not as a prerequisite
for same-branch workers.

Near-term coordination can use beadwork-native artifacts:

- child tickets for decomposition;
- dependencies for ordering;
- `bw comment` for active intent and handoff notes;
- ticket labels for ownership/risk/status;
- worker runtime state for active ticket/paths.

Future deeper integration could add:

- path reservations with TTLs;
- conflict-risk scoring for ready tickets;
- agent-mail style direct worker coordination;
- explicit worker manifests containing planned paths, touched paths, and commit SHAs;
- scheduler awareness of current worker reservations and likely overlap.

Those features improve scheduling quality, but the basic current-branch worker mode should not
wait on all of them.

## Configuration shape

Potential config surface:

```json
{
  "workers": {
    "executionMode": "current-branch"
  },
  "worktrees": {
    "cleanup": "keep"
  }
}
```

Or, if preserving the existing top-level `worktrees` block is preferable:

```json
{
  "workerExecution": {
    "mode": "current-branch"
  }
}
```

Possible environment override:

```sh
PI_BEADWORK_WORKER_EXECUTION_MODE=current-branch
```

Supported modes should probably start as:

- `current-branch` — default;
- `worktree` — existing behavior, explicit isolation mode.

Future modes could include speculative worktrees, PR mode, or remote/session-backed workers,
but those should not block the initial split.

## Implementation seams to inspect/change

Likely seams in `packages/pi-beadwork-extension`:

- worker launch entrypoint: replace direct `prepareTicketWorktree()` dependency with
  `prepareWorkerCheckout()`;
- handoff builder: add current-branch prompt variant;
- tmux backend call site: pass generic `checkoutPath` cwd instead of assuming worktree path;
- runtime normalization: persist `executionMode` and `checkoutPath`;
- orchestrator: split post-exit handling into current-branch completion vs worktree landing;
- validation: run in `checkoutPath` for both modes;
- review artifact gathering: commit-set artifacts for current-branch, branch diff for worktree;
- remediation relaunch: mode-specific prompts and cwd;
- cleanup actions: never run `git worktree remove` for current-branch workers;
- worker manager UI: label mode clearly and avoid worktree-only wording.

## Migration strategy

A safe migration can be incremental:

1. Add `executionMode`/`checkoutPath` while preserving existing worktree behavior.
2. Rename internal concepts from worktree-specific to checkout/substrate-specific where they
   cross mode boundaries.
3. Add current-branch launch behind an explicit config flag.
4. Teach handoff/remediation/review/completion paths about current-branch mode.
5. Add commit attribution requirements and tests.
6. Flip the default to current-branch once behavior is validated.
7. Keep worktree mode available for explicit isolation and speculative execution.

## Tests to add

Important tests should lock in the new semantics:

- current-branch delegate launches without calling `prepareTicketWorktree()`;
- tmux cwd is repo root/current checkout in current-branch mode;
- handoff says not to create a branch/worktree/PR by default;
- multiple ready tickets can launch concurrently in current-branch mode;
- current-branch completion does not run worktree rebase/merge-back/containment checks;
- current-branch cleanup removes runtime artifacts only;
- review artifacts include only ticket-attributed commits, not `launchHead..HEAD` wholesale;
- worktree mode still preserves the existing prepare/validate/review/land/cleanup behavior;
- persisted old worker runtime records normalize correctly.

## Open questions

- What should be the first reliable commit-attribution mechanism: commit message convention,
  `bw comment` manifest, first-class beadwork metadata, or extension-maintained manifest?
- Should `/bw delegate` default to current-branch immediately, or should the first release hide
  it behind config while `/bw run` is adapted?
- How should validation be scheduled when many same-branch workers finish close together?
- What minimum reservation/coordination signal is needed for useful scheduling, if any?
- How should worker identity map to commits when multiple agents share the same git author?
- Should reviewer agents be current-branch read-only processes, or should review run outside the
  checkout to avoid accidental edits?
- What terminology should replace "landing" in current-branch mode: completion, acceptance,
  verification, or something else?

## Working thesis

The extension should stop treating worktrees as the definition of delegated work. The durable
unit is the beadwork ticket, and in same-branch swarm mode the reviewable unit is the ticket's
attributed commit set.

Worktrees remain useful for explicit isolation, PR-style flows, or speculative downstream work.
But the default path should let beadwork do what it is good at: coordinate many agents on the
same branch through tickets, dependencies, comments, and atomic commits.
