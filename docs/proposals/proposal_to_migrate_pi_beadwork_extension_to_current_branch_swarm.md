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
   - current-branch: attribute the ticket's commits, run the normal review/triage loop, mark the
     ticket work verified when it passes, or remediate/file/reject reviewer findings;
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

Introduce an execution substrate abstraction with mode-specific invariants instead of pretending every
worker has a worktree:

```ts
type WorkerExecutionMode = "current-branch" | "worktree";

type CurrentBranchCheckout = {
  mode: "current-branch";
  checkoutPath: string; // repo root / current checkout
  branchName: string;
  launchHead: string; // required: attribution starts here
};

type WorktreeCheckout = {
  mode: "worktree";
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

## Launch migration

Replace direct calls to `prepareTicketWorktree()` with a generic `prepareWorkerCheckout()`.

In `current-branch` mode, launch should:

1. resolve the repository root/current checkout;
2. record current branch and required `launchHead`;
3. create worker runtime/log/scratch directories;
4. launch tmux with cwd set to the repo root;
5. use a current-branch-specific handoff prompt;
6. never create a branch or worktree.

Current-branch runtime invariants:

- do not launch in detached HEAD unless explicitly configured;
- record both `branchName` and `launchHead` before tmux launch;
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

- gather beadwork comments/history for the ticket;
- find commits after `launchHead` whose messages reference the ticket id;
- confirm candidate SHAs still exist on active branch ancestry;
- resolve the attributed commit set from that evidence;
- if attribution is unclear, contradictory, or SHAs are missing from ancestry, route to
  remediation or human attention.

Do not build a deterministic attribution parser. The coordinator/LLM reads the handoff context
and git history and makes the judgment. If it cannot confidently resolve attribution, that is an
`attention` condition, not a parsing failure to handle with more code.

### Attribution risk acceptance

Attribution by commit message convention plus LLM handoff interpretation is intentionally fuzzy.
Workers may forget the ticket ID in some commits, amend commits, or produce ambiguous references.
This is acceptable risk for this phase. The per-worker review loop and final scope-completion review
catch problems that attribution misses.

Later, beadwork can grow first-class ticket-to-commit metadata. The extension does not need to wait
for that to begin the migration.

## Completion, verification, and review triage

Current-branch mode has no merge-back phase because the work is already on the branch. The right
terminal concept is **verified**, not accepted: the worker claims the task is done, then the
coordinator verifies the ticket-attributed work.

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

- `fix`: create/comment the follow-up beadwork task and launch a new worker when safe;
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

Do not require file reservations before same-branch concurrency works. Reservations, touched-path
tracking, and conflict-risk scoring can be added later as advisory scheduling inputs.

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

- Confirm `current-branch` is the active default execution mode (set in Phase 1, operational since
  Phase 2-4 shipped together).
- Keep `worktree` available through explicit config.
- Add UI/status labels so active workers clearly show their execution mode.
- Document the commit-message and handoff-comment conventions.

## Tests to add

- current-branch launch does not call `prepareTicketWorktree()`;
- tmux cwd is the repo root/current checkout and the tmux API names this as `cwd`/`checkoutPath`, not
  `worktreePath`;
- current-branch workers do not fake `worktreePath = repoRoot`;
- registry normalization preserves legacy worktree records and accepts current-branch records with
  `verified` status;
- handoff prompts require `bw start`, forbid creating a branch/PR/worktree by default, ask for atomic
  ticket-referenced commits, and ask for a coordinator handoff comment;
- `/bw run --workers N` can launch multiple current-branch workers;
- current-branch verification skips rebase, merge-back, containment checks, and worktree cleanup;
- every current-branch worker completion triggers reviewer context centered on ticket-attributed
  commits, not `launchHead..HEAD` wholesale;
- coordinator review triage can classify findings as `fix`, `file`, or `reject`;
- current-branch review defaults to on and is skipped only when config explicitly disables it;
- remediation prompts include only coordinator-approved `fix` findings and cap at 2 attempts;
- missing attribution is routed to remediation or human attention;
- `/bw run` does not stop as `completed` while workers are still active, exited-but-unverified, or
  scope-level validation/review has unresolved `fix` findings;
- scope-complete validation/review runs once for epic/scope runs after quiescence;
- scope-level `fix` findings create fix-forward beadwork work and do not mutate already verified worker
  records back into worker-level remediation;
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

**Verification hook:** current-branch verification should run inside `inspectWorkerRuntime`, mirroring
the existing `autoLandCompletedWorker` pattern for worktree mode. When inspection detects a
closed-ticket exited current-branch worker, it should trigger `verifyCurrentBranchWorker` (or
equivalent). Reuse the existing orchestration-lock pattern (promise deduplication per worker) to
prevent double-verification when concurrent inspection calls race. This ensures only *problematic*
exited workers remain to trigger the loop's `attention` stop condition.

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
