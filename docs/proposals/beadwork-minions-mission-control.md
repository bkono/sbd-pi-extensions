# Initial Proposal: Beadwork Mission Control on a Minion Runtime

**Date:** 2026-08-27
**Status:** Initial repo-grounded proposal for review
**Scope:** `packages/pi-minions` + `packages/pi-beadwork-extension`
**Working name:** Mission Control

## Executive recommendation

Do not merge beadwork and minions into one large extension, and do not port Oh My Pi's harness or MCP Agent Mail wholesale.

Instead:

1. Evolve `pi-minions` from a foreground delegation tool into a small, reusable agent runtime with foreground and detached modes, versioned lifecycle events, steering, cancellation, settled-state completion, and parent-safe result delivery.
2. Refactor `pi-beadwork-extension` into a client of that runtime. Beadwork remains the durable work graph and semantic source of truth; minions owns live agent sessions.
3. Replace periodic prompt reminders and UI-only worker notices with an event-driven **obligation engine**. Each meaningful event creates a typed next action for the orchestrator: assess completion, answer a worker, adjudicate review findings, dispatch remediation, create follow-up work, launch newly ready tickets, or escalate.
4. Use frontier models for judgment, not mechanics. Deterministic code owns lifecycle, ancestry, schemas, idempotency, concurrency limits, and safety invariants. Models own decomposition, review, attribution ambiguity, `fix | file | reject` decisions, and recovery choices.
5. Add **advisory workspace claims**, not mandatory locks: declared edit intent, observed paths, overlap warnings, scheduler bias, and optional tool/commit guards. Worktrees remain the explicit isolation option.
6. Keep the current tmux worker path as a migration fallback until the minion runtime proves restart, cancellation, and completion delivery under fault tests.

The result should feel autonomous without becoming a daemon-heavy distributed system: the parent remains available to the user, workers finish into a reliable inbox, guidance is derived from current state, and every review or failure naturally creates the right next orchestrator action.

---

## 1. Normalized feature intent

### What we want

A user should be able to point a Pi session at one or more beadwork epics and say, in effect:

> Drive this work to a verified outcome. Decompose or refine the graph when needed, dispatch independent work, monitor it, review it, fix or file valid findings, reject bad findings, avoid workers trampling one another, and bring me in only for real decisions.

The parent/orchestrator session must remain usable while agents run. It should:

- keep talking with the user;
- receive timely worker completion and blocker signals;
- know the correct next orchestration action without the user restating the workflow;
- inspect and steer workers;
- coordinate overlapping work;
- review outcomes in the context of the ticket, epic, and project;
- drive bounded remediation and re-review loops;
- preserve durable state across compaction, session boundaries, and partial failures.

### Why now

The original beadwork extension was designed when model judgment was less reliable and Pi lacked several current primitives. The repository now has:

- frontier models capable of strong decomposition, review, and adjudication;
- Pi 0.84.3 lifecycle events including `agent_settled`;
- `pi.sendMessage(..., { deliverAs, triggerTurn })` for safe-boundary delivery;
- in-process child `AgentSession`s;
- a shared extension event bus;
- a local `pi-minions` implementation;
- a mature, but very large, beadwork orchestration prototype.

The opportunity is to move policy back toward model judgment while giving that judgment reliable runtime primitives and state-derived guidance.

### Source ideas to adapt, not copy

| Source | Principle to adapt | Literal interpretation to reject |
| --- | --- | --- |
| Beadwork | Durable graph, `ready` as scheduler, ticket-scoped completion | Treating the issue graph as a live process manager |
| Current beadwork extension | Full lifecycle, verification, remediation, scope review | Keeping tmux polling and a 6,900-line orchestrator as the permanent center |
| `pi-minions` | In-process isolated contexts and persistent child sessions | Foreground-only, tool-blocking execution |
| Oh My Pi | Strong orchestration prompts, background task delivery, agent hub, typed yield, reviewer/advisor roles | Forking or recreating its full harness |
| MCP Agent Mail | Explicit identities, threaded coordination, TTL claims, durable delivery cursors | A second server, SQLite/Git mail archive, contacts, 40 tools, and a web console |
| Pi subagent ecosystem | Background handles, steering, event RPC, completion consumption, fleet UI | Depending directly on another extension's private runtime |
| Gas Town | Observe → nudge → escalate, dedicated merge/verification responsibility | Mayor/Witness/Deacon/Refinery role hierarchy for a local Pi extension |

### Key assumptions

- Beadwork remains the durable task graph.
- A worker attempt settling is not the same as the ticket being accepted.
- The normal scale is a handful of concurrent agents, not hundreds.
- Current-branch concurrency remains valuable, but it should become better informed and observable.
- A parent Pi process may disappear; durable work meaning must survive even if the live child process does not.
- User input outranks autonomous continuation.

---

## 2. Problem and success criteria

### Current problem

The project has two complementary but disconnected systems:

- `pi-minions` has the right in-process session primitive but blocks the parent until every child finishes.
- `pi-beadwork-extension` can run epics in the background, but it owns its own tmux/process/runtime layer, relies heavily on polling, and often notifies only the UI rather than waking the orchestrator model with the right obligation.

This produces several concrete gaps.

1. **The parent does not reliably react to completion.** Beadwork supervision emits `ctx.ui.notify()` messages, not model-visible completion obligations.
2. **Model-initiated delegation can be under-supervised.** The `beadwork_delegate` tool launches a worker but does not call the session tracking path used by the slash-command delegate action.
3. **Minion completion is detected too early.** `SubsessionManager` treats the first `agent_end` as terminal even though Pi 0.84.3 documents `agent_settled` as the no-more-retry/compaction/continuation event.
4. **Review adjudication is less agentic than the design claims.** Current-branch `fix | file | reject` is selected by keyword regexes in `classifyReviewFinding()`.
5. **Runtime truth is fragmented.** Ticket state, git commits, tmux, runtime marker files, a flat worker registry, per-session tracking, and UI notices can disagree.
6. **Shared-checkout conflicts are accepted but not coordinated.** Current tests prohibit reservation, lock, or clean-checkout prerequisites for launch; the implementation has no advisory overlap observation or supported exact-write ownership boundary after launch.
7. **The orchestrator's next step is implicit.** Prompt guidance describes modes, but no typed, durable obligation says “this review now requires adjudication” or “this blocker needs a user decision.”

### V1 success criteria

A successful first coherent release should make this workflow reliable:

1. `/bw run <epic>` or a model tool starts a mission and returns control immediately.
2. The parent remains available for user messages and unrelated work.
3. Workers launch through minions, report progress, ask blocking questions, and settle without polling as the primary mechanism.
4. Each worker completion produces an evidence-bearing attempt result, not an automatic claim of success.
5. The parent receives a deduplicated, model-visible next-action nudge at a safe boundary.
6. Independent review produces structured findings with evidence.
7. A model adjudicates each finding against ticket + epic + project intent as `fix`, `file`, or `reject`.
8. `fix` resumes or remediates the original context when possible; `file` creates a real deduplicated ticket; `reject` records rationale.
9. Newly ready tickets launch up to capacity without requiring manual polling.
10. A stalled or vanished worker follows a bounded observe → nudge → resume/replace → attention ladder.
11. Replaying duplicate events or restarting the parent does not duplicate launches, remediation, follow-up tickets, or model-visible completion delivery.
12. Full lint, test, typecheck, and configured scope validation still gate mission completion.

### Failure criteria

The design is not successful if:

- background work blocks the parent tool call;
- a worker can be reported complete before `agent_settled`;
- a completion can wake the wrong/replaced parent session;
- duplicate completion messages cost extra model turns;
- two orchestrators can launch the same ticket without detection;
- a restart loses results or repeats irreversible actions;
- reviewers inspect a moving, unattributed `HEAD` range;
- path coordination becomes a mandatory lock system that deadlocks ordinary work;
- the new system retains both full beadwork worker orchestration and full minion orchestration indefinitely.

---

## 3. Program scope, first-release boundary, non-goals, and deferred scope

### Target program scope, delivered incrementally

- detached/background minion sessions;
- foreground mode preserved;
- versioned cross-extension lifecycle/RPC protocol;
- reliable settled completion and consumption receipts;
- parent-safe completion and blocker delivery;
- single-epic mission controller;
- model-driven review adjudication;
- context-preserving remediation;
- typed orchestration obligations and dynamic nudges;
- advisory path intent and overlap warnings;
- event-driven quiescence with polling as reconciliation fallback;
- migration from tmux workers without removing the tmux fallback immediately;
- failure-injection and real in-process integration tests.

These items describe the target Mission Control program, not one indivisible release. Section 12 begins with two small improvements on the existing tmux path, then introduces minions and mission control through independently useful vertical slices.

### Explicit non-goals for V1

- no MCP server;
- no SQLite mail database;
- no Git-backed inbox/outbox archive;
- no general peer chat room;
- no cross-machine agent network;
- no Gas Town-style permanent role hierarchy;
- no speculative execution of blocked tickets;
- no automatic branch/PR fleet manager;
- no mandatory file locks;
- no second issue/dependency graph;
- no rewrite of the `bw` CLI;
- no multi-epic portfolio scheduler in the first implementation slice unless the user makes it a release requirement.

### Deferred

- multi-epic missions and fairness across epics;
- cross-project/product missions;
- first-class ticket-to-commit metadata in beadwork itself;
- tool-layer hard enforcement of workspace claims;
- scheduler ranking by dependency unlock value and learned path conflict risk;
- reusable deterministic workflow scripts beyond the beadwork graph;
- remote or process-isolated minion backends.

---

## 4. Current repository context

### Confirmed architecture

#### `packages/pi-minions`

The package currently provides:

- named and ephemeral agent discovery;
- foreground single and batch spawning;
- in-process `AgentSession` creation;
- file-based child session persistence plus metadata sidecars;
- live activity, usage, footer, and management UI;
- steering and abort handles internally;
- delegation reminders through `before_agent_start`.

Key boundaries:

- `src/tools/spawn.ts` awaits `Promise.allSettled()` for all children, so the parent model is blocked.
- `src/subsessions/manager.ts` owns child sessions but completes on `agent_end` rather than true settled state.
- `src/subsessions/event-bus.ts` is private and separate from `pi.events`; `MINION_COMPLETE_CHANNEL` has no parent completion-delivery consumer.
- `src/index.ts` exports only the extension entrypoint, not a stable runtime API.
- child session shutdown/disposal and replaced-parent recovery are incomplete.
- restored `running` metadata does not prove a live session exists.
- automated tests currently focus on delegation hints and helper behavior, not real child-session lifecycle.

#### `packages/pi-beadwork-extension`

The package currently provides:

- activation, session mode, scope, and cached `bw prime` context;
- issue CRUD and plan adoption;
- current-branch and worktree workers;
- tmux launch and runtime marker files;
- bounded epic scheduling;
- crash replacement;
- current-branch attribution/review/remediation/verification;
- worktree validation/rebase/review/landing/cleanup;
- quiescent dirty-state remediation;
- scope validation and scope review;
- dashboard and worker diagnostics.

Key boundaries:

- `src/index.ts` is about 2,200 lines and owns tools, commands, session state, polling, tracking, notices, and prompt enrichment.
- `src/orchestrator.ts` is about 6,900 lines and owns launch, runtime inspection, review, remediation, crash recovery, landing, scope validation, and scheduling.
- `BaseWorkerRuntime` has dozens of optional lifecycle fields; legal state combinations are mostly implicit.
- background supervision is a session-local interval that runs only while the parent is alive and idle.
- worker transition notifications are UI toasts; they do not automatically create a model turn.
- current-branch attribution is mechanically assembled, while finding disposition is deterministic keyword classification.
- a `file` disposition currently adds a comment to the same ticket rather than reliably creating a follow-up issue.
- standalone tool delegation does not join the same session-tracking path as slash-command delegation.
- process-local launch and registry queues do not provide cross-process compare-and-swap.

### Existing patterns to preserve

- activation is quiet in non-beadwork repositories;
- beadwork graph is canonical, runtime registry is not;
- current-branch and worktree outcomes remain semantically different (`verified` vs `landed`);
- current-branch commits are fix-forward;
- worktree landing requires truthful containment, not equivalent-diff heuristics;
- integrated validation occurs at a quiescent scope boundary;
- worktree mode remains available for risky or strongly overlapping work;
- worker and reviewer models remain independently configurable;
- all significant logic requires tests and full quality gates.

### Stale assumptions to remove

- “tmux is the runtime” should become “tmux is one fallback runtime.”
- “worker completion is process exit + closed ticket” should become “an attempt settled and submitted evidence.”
- “review triage can be inferred from keywords” should become model adjudication with deterministic constraints.
- “current-branch safety must have no reservation concept” should narrow to “current-branch launch must not require mandatory locking.” Advisory claims are compatible with that premise.
- “notifications are enough” should distinguish user-visible status from model-visible obligations.

---

## 5. Research findings and repo-native adaptations

### Oh My Pi v18.0.8

**Repository:** `can1357/oh-my-pi`
**Tag/commit:** `v18.0.8` / `caefa610239e9611e7a8920e91b38b30a58efa73`
**Release:** 2026-08-27

OMP's success comes from a combination of prompt policy and harness primitives.

#### Prompt policy that matters

`orchestrate-notice.md` supplies a strong closure contract:

- enumerate the entire work surface;
- dispatch disjoint work in parallel;
- give self-contained target/change/acceptance prompts;
- verify each phase centrally;
- dispatch corrective workers instead of silently fixing their work;
- do not yield between phases;
- run integrated format/lint/test once across the union.

`workflow-notice.md` adds useful patterns:

- adversarial verification;
- judge panels;
- completeness critics;
- loop-until-dry discovery;
- structured outputs rather than prose parsing.

These policies are highly portable. They do not require OMP's entire runtime.

#### Harness primitives that matter

- background `task` jobs return immediately;
- `AsyncJobManager` routes results to the owning agent;
- delivery has retry, suppression, watch, acknowledge, and consume semantics;
- `hub` combines worker messaging, waits, cancellation, and process supervision;
- `AgentRegistry` tracks `running | idle | parked | aborted` sessions;
- finished agents can remain live, park after a TTL, and revive from persisted sessions;
- subagents must finish through a structured `yield` contract;
- Agent Hub exposes live transcripts, steering, revival, and kill;
- advisor notes use severity-sensitive delivery (`nit`, `concern`, `blocker`) and safe-boundary steering;
- orchestration guidance distinguishes worker-local proof from integrated parent validation.

#### Evidence that OMP is not solved end to end

Current open issues are useful warnings:

- [#8711](https://github.com/can1357/oh-my-pi/issues/8711): background subagents can freeze or disappear, leaving stale running state and no failure result.
- [#9747](https://github.com/can1357/oh-my-pi/issues/9747): the main agent can clobber files owned by in-flight subagents because ownership is only implied.
- [#6032](https://github.com/can1357/oh-my-pi/issues/6032): peer waits can deadlock until timeout.
- [#6947](https://github.com/can1357/oh-my-pi/issues/6947): durable workflow DAGs still need a shared task dispatch boundary and explicit restart semantics.
- [#8874](https://github.com/can1357/oh-my-pi/issues/8874): prompt closure rules can still be defeated by terminal text-only stops and compaction.

**Adaptation:** copy the closure contract, owner-routed completion, safe-boundary delivery, typed yield/evidence, and observability. Do not copy the whole harness, general IRC, or role ecology.

### MCP Agent Mail Rust v0.3.30

**Repository:** `Dicklesworthstone/mcp_agent_mail_rust`
**Tag/commit:** `v0.3.30` / `e99e28902eac8c71322b697cf009afccd0c4c57a`
**Release:** 2026-08-23

The useful conceptual split is explicit:

- Beads owns tasks, priorities, and dependencies.
- Agent Mail owns identities, messages, acknowledgements, and advisory leases.
- Shared issue IDs connect tickets, message threads, claims, and commits.

Useful mechanics:

- TTL-based advisory file reservations;
- symmetric path overlap;
- explicit recipients rather than default broadcast;
- acknowledgements and delivery receipts;
- durable per-recipient inbox event cursors;
- build slots for expensive shared resources;
- pre-commit guard as an optional enforcement layer;
- human-readable audit records distinct from live query state.

The project also demonstrates the cost of generality. It has 40 MCP tools, 25 resources, many crates, SQLite + Git dual persistence, a server, TUI, web UI, search, contacts, recovery, and extensive failure modes. Recent issues cover reservation drift, corrupted/reconstructed live state, hot-path write barriers, cursor semantics, identity mismatches, unbounded artifacts, and daemon health.

**Adaptation:** implement a small project-local coordination board with ticket-linked signals and expiring path intent. No mail server, contacts, search index, web UI, or dual durable ledger.

### `@tintinweb/pi-subagents` v0.19.0

**Tag/commit:** `v0.19.0` / `4f572eaa04c09d3dbc16e4a5f13a16b295e84e14`
**Release:** 2026-08-27

Relevant ideas:

- background by default with foreground as an option;
- separate concurrency pools;
- queueing and bounded fan-out;
- live conversation view and mid-run steering;
- persisted sessions and resume;
- worktree isolation as an explicit mode;
- lifecycle events on `pi.events`;
- versioned cross-extension RPC;
- result consumption to suppress duplicate delivery;
- grouped completion with partial timeout release;
- deterministic workflow scripts that reuse one agent manager.

Open issues reveal an important unresolved delivery tradeoff:

- [#188](https://github.com/tintinweb/pi-subagents/issues/188) asks to deliver unread completions at the next safe parent boundary via `steer`.
- [#185](https://github.com/tintinweb/pi-subagents/issues/185) asks to delay until settled so results consumed later do not produce redundant post-answer turns.
- [#103](https://github.com/tintinweb/pi-subagents/issues/103) asks for a reliable query API for active background agents.

**Adaptation:** create an explicit completion inbox with consumption receipts and a policy-driven delivery scheduler instead of choosing one fixed timing for every completion.

### `pi-collaborating-agents` v0.4.3

**Tag/commit:** `v0.4.3` / `58a2600e7a9da28c1b78ca07a3045ad4da650b59`

Relevant ideas:

- all sessions register automatically;
- direct and urgent messages use different Pi delivery modes;
- file reservations are checked in edit/write hooks;
- completed child outputs route automatically to the parent;
- user-facing Agents/Feed/Reservations/Chat views share one model.

**Adaptation:** use direct ticket-linked signals and tool-boundary overlap warnings. Avoid global broadcast and a machine-global unscoped registry.

### `pi-intercom` v0.12.0

**Tag/commit:** `v0.12.0` / `ef95f194de635a01abb6ec8f485c3d4ab6bfc644`

Relevant ideas:

- local session registry and targeted one-to-one delivery;
- busy recipients receive safe steering rather than abrupt cancellation;
- blocking `ask`, non-blocking `send`, reply correlation, cancellation, supersession, and receipts;
- child-only `contact_supervisor` with typed reasons: decision, interview, progress;
- duplicate IDs are acknowledged but injected at most once;
- broker heartbeat detects half-open sessions;
- extension channels separate non-conversational coordination from transcript-visible messages.

**Adaptation:** use the typed supervisor-contact idea inside minions. A general broker is unnecessary while children live in the same Pi process.

### `pi-side-agents` v1.1.3

**Tag/commit:** `v1.1.3` / `6ce7b666888e96b499056651d12b5d3506089681`

Its strongest lesson is deliberate simplicity: one child, one tmux window, one worktree, one short-lived branch, explicit `wait-any`, `send`, and human “LGTM” landing. It is a useful fallback model and a reminder not to make every worker a permanent team member.

### Gas Town v1.2.1

**Tag/commit:** `v1.2.1` / `319d33a91b2deca59bba6dd26be6b9daf8eaacf6`

Useful ideas:

- durable work survives agent sessions;
- worker identity can persist while sessions remain ephemeral;
- monitor roles observe, nudge, recover, and escalate;
- integration verification belongs in a dedicated merge/refinery boundary;
- scheduler capacity and watchdogs are explicit;
- problem views distinguish stalled, zombie, working, and idle agents.

**Adaptation:** use the recovery ladder and separate implementation acceptance from worker completion. Do not import the role hierarchy or daemon fleet.

### Pi 0.84.3 primitives

Pi itself now supplies the needed foundation:

- `agent_settled` is the terminal no-more-automatic-work event;
- `pi.sendMessage` supports `steer`, `followUp`, `nextTurn`, and `triggerTurn`;
- `AgentSession` supports `steer`, `followUp`, `abort`, persistence, and event subscription;
- `createEventBus()` can be shared with child resource loaders;
- `session_shutdown` is the cleanup boundary;
- custom session entries can store local durable orchestration state without entering model context;
- project-local tools can participate in `withFileMutationQueue()`.

The main work is composing these primitives correctly, not inventing a new process fabric.

---

## 6. Repo-native mental model

### Four planes

```text
┌─────────────────────────────────────────────────────────────────┐
│ User + parent Pi session                                        │
│ conversation, pause/resume, real decisions, mission dashboard   │
└───────────────────────────────┬─────────────────────────────────┘
                                │ typed obligations + safe delivery
┌───────────────────────────────▼─────────────────────────────────┐
│ Beadwork mission controller                                     │
│ scheduler, reducer, guidance compiler, review adjudication      │
└───────────────┬───────────────────────────────┬─────────────────┘
                │ durable work meaning          │ runtime commands/events
┌───────────────▼────────────────┐   ┌──────────▼──────────────────┐
│ Beadwork + Git                 │   │ Pi Minion Runtime           │
│ issues, deps, status, comments │   │ sessions, progress, steer,  │
│ commits and validation facts  │   │ settle, resume, cancel      │
└────────────────────────────────┘   └──────────┬──────────────────┘
                                               │
                                    ┌──────────▼──────────────────┐
                                    │ Workspace coordination      │
                                    │ path intent, overlap, slots │
                                    └─────────────────────────────┘
```

### Source-of-truth rules

| Concern | Source of truth |
| --- | --- |
| What work exists | Beadwork issue graph |
| What is ready | `bw ready` |
| Ticket status/dependencies | Beadwork |
| Code result | Git commits/current checkout/worktree branch |
| Live session state | Minion runtime |
| Worker attempt evidence | Minion result + git + beadwork history |
| Review finding disposition | Beadwork comment/follow-up + local attempt record |
| Parent delivery/consumption | Parent session entries + minion delivery receipt |
| Path edit intent | Ephemeral/advisory coordination board |
| Integrated acceptance | Mission controller after validation + review |

### The key distinction: attempt vs outcome

A minion attempt can be:

- queued;
- running;
- settled;
- stopped;
- lost/interrupted.

A ticket outcome can independently be:

- awaiting evidence review;
- accepted;
- needs remediation;
- blocked;
- follow-up filed;
- needs attention.

Do not overload one flat `status` to represent both.

### The key innovation: typed orchestration obligations

Every important transition creates an obligation with a stable key:

```ts
type OrchestrationObligation =
  | { kind: "answer-worker"; attemptId: string; questionId: string }
  | { kind: "assess-completion"; attemptId: string }
  | { kind: "adjudicate-review"; reviewId: string }
  | { kind: "dispatch-remediation"; findingSetId: string }
  | { kind: "create-follow-up"; findingId: string }
  | { kind: "launch-ready"; epicId: string }
  | { kind: "resolve-overlap"; claimIds: string[] }
  | { kind: "recover-stalled"; attemptId: string }
  | { kind: "validate-scope"; missionId: string }
  | { kind: "ask-user"; decisionId: string };
```

An obligation is not another task graph. It is a short-lived controller responsibility derived from the durable graph and runtime events.

This directly solves the requested review example: reviewer completion creates `adjudicate-review`; its guidance says to assess findings against ticket/epic/project intent and resolve every finding as `fix`, `file`, or `reject`. The controller cannot claim the review is handled while a finding lacks a disposition.

---

## 7. Proposed V1 behavior

### 7.1 Start a mission

Human path:

```text
/bw run EPIC-123 --workers 4
```

Model path:

```ts
beadwork_run_mission({ epic_id: "EPIC-123", workers: 4 })
```

Behavior:

1. Validate epic scope and activation.
2. Load `bw prime` and repo/project instructions.
3. Create a session-scoped mission lens over the epic; do not duplicate its task graph.
4. Query `bw ready`.
5. Select ready tickets up to capacity.
6. Check active attempts, dependency constraints, and advisory overlap risk.
7. Spawn detached minions and return control immediately.
8. Show the mission in the statusline/dashboard.

### 7.2 Parent remains interactive

While workers run:

- user messages are accepted normally;
- routine progress updates only refresh UI/runtime state;
- no background model turn starts while user input is queued or the user has paused autonomy;
- worker questions and blockers appear as explicit cards/obligations;
- the user can inspect, steer, pause, stop, or reassign workers;
- mission continuation drains at most one bounded obligation batch per automatic turn.

Commands:

```text
/bw mission pause
/bw mission resume
/bw mission status
/bw mission stop --leave-workers
/bw mission stop --stop-workers
```

### 7.3 Worker communication

Workers get a small child-only tool or runtime API:

```ts
beadwork_signal({
  kind: "progress" | "need-decision" | "blocker" | "scope-change" | "done",
  message: string,
  question?: { id: string; options?: string[] },
  touched_paths?: string[],
});
```

Policy:

- `progress`: runtime/UI only unless it changes the plan;
- `need-decision`: creates a parent obligation and may block the worker;
- `blocker`: durable beadwork comment + parent obligation;
- `scope-change`: parent must approve or file child/follow-up work;
- `done`: worker submits completion evidence; it does not close the ticket or mission by itself.

Parent-to-worker guidance uses safe-boundary steering and includes sequence/ack metadata. Stale guidance is ignored.

### 7.4 Worker completion evidence

A worker's final result should be structured and validated:

```ts
type CompletionEvidence = {
  outcome: "completed" | "blocked" | "partial";
  summary: string;
  commitShas: string[];
  touchedPaths: string[];
  validation: Array<{
    command: string;
    status: "passed" | "failed" | "not-run";
    detail?: string;
  }>;
  blockers: string[];
  followUps: string[];
  confidence?: number;
};
```

Deterministic checks:

- attempt truly reached `agent_settled`;
- evidence schema is valid;
- listed commits exist and remain ancestors of expected HEAD;
- touched paths agree with commit evidence when commits exist;
- ticket lifecycle is coherent;
- no unresolved blocking signal exists.

The controller then creates `assess-completion`.

#### Canonical ticket transitions

The worker never closes its own ticket in the new protocol. Closing an implementation ticket is the controller's acceptance action because `bw close` can unblock dependents.

| Evidence/outcome | Ticket action | Next controller action |
| --- | --- | --- |
| attempt running | keep `in_progress` | monitor/signals |
| completed evidence, review required | keep `in_progress` | independent review |
| blocking `fix` disposition | keep `in_progress` | resume/remediation |
| valid `file` or `reject` only | keep `in_progress` until other gates pass | persist dispositions |
| evidence + required review + targeted validation pass | close + sync | refresh `bw ready` |
| worker blocked/partial | comment; leave open or return to `open` by policy | answer, reassign, or attention |
| remediation after legacy early close | reopen once with operation ID | remediate, then close after acceptance |

`beadwork_worker_done` must therefore change from “close/sync/shutdown” to “persist evidence/signal settle/shutdown.” During migration, old tmux workers that close early are treated as provisional: the controller must finish review before considering dependent work safely launchable, and may reopen on blocking findings.

### 7.5 Review, adjudication, and remediation

#### Review

Spawn an independent reviewer minion with:

- ticket goal and acceptance criteria;
- epic goal;
- attributed immutable commit set or isolated branch;
- relevant project instructions;
- validation evidence;
- explicit instruction to inspect consumers beyond the diff;
- structured finding schema.

Finding shape:

```ts
type ReviewFinding = {
  findingId: string;
  priority: "P0" | "P1" | "P2" | "P3";
  claim: string;
  impact: string;
  evidence: Array<{ path: string; line?: number; commit?: string }>;
  suggestedFix: string;
  confidence: number;
};
```

#### Adjudication

The parent or a focused adjudicator minion evaluates each finding with the full ticket/epic/project context:

```ts
type FindingDisposition = {
  findingId: string;
  action: "fix" | "file" | "reject";
  rationale: string;
  blocksAcceptance: boolean;
  followUpTitle?: string;
};
```

Rules:

- deterministic code never infers disposition from phrases such as “nice to have” or “false positive”;
- every finding receives exactly one disposition;
- `fix` must be in scope and concrete; it blocks acceptance;
- `file` creates or links a real follow-up issue using a stable finding signature;
- `reject` records rationale and preserves raw reviewer evidence;
- high-impact/low-confidence findings may get an adversarial verifier before disposition;
- parent/user policy may require human approval for selected priorities or security-sensitive actions.

Finding identity must be stable across reviewer reruns. Compute a canonical fingerprint from the ticket ID, reviewed commit/tree identity, normalized claim, and sorted evidence locations; reviewer-generated IDs are display aliases only. Persist the raw finding and its disposition before executing `fix`, creating a follow-up, or recording rejection. A `file` issue is normally a child of the active epic, does not block the current ticket unless the adjudicator explicitly sets `blocksAcceptance`, and carries the fingerprint for deduplication.

#### Remediation

Preferred order:

1. steer the original live minion;
2. resume its persisted session;
3. launch a fresh remediation minion with prior context and accepted findings.

The remediation prompt contains only `fix` findings. After it settles:

- rerun targeted checks;
- re-review the changed commit set;
- cap attempts;
- route non-convergence to attention.

### 7.6 Newly ready work

After an attempt is accepted or a follow-up dependency changes:

1. refresh `bw ready`;
2. create `launch-ready` if capacity exists;
3. compute advisory conflict risk;
4. launch disjoint work;
5. serialize only known shared mutation boundaries.

No internal linear plan is advanced from memory. The graph is reread each time.

### 7.7 Workspace overlap

Workers publish planned path intent as soon as they know it:

```ts
type WorkspaceClaim = {
  claimId: string;
  attemptId: string;
  ticketId: string;
  patterns: string[];
  mode: "read" | "edit";
  confidence: "declared" | "observed";
  expiresAt: string;
};
```

The V1 safety policy has two levels:

- **Broad claims are advisory.** Glob/directory overlap warns workers and biases scheduling; overlapping reads remain allowed.
- **Exact active writes are owned.** For tool-managed `edit`/`write`, an exact overlap pauses the younger attempt and creates `resolve-overlap`; the parent must sequence, re-scope, or move one attempt to a worktree before mutation continues.
- Claims expire and renew with meaningful activity; observed tool paths and commit evidence refine declared intent.
- A shared contract file should have one integration owner.
- Shell-heavy generators/codemods cannot be reliably guarded at edit hooks, so tickets expected to mutate broad/unknown surfaces should use worktree isolation by default.
- An optional commit guard can catch additional shell-generated overlap, with `.beadwork/**` and coordination metadata exempt and an explicit operator bypass.

This does not make reservations a prerequisite for current-branch launch. It does make known exact write contention a deterministic stop rather than a warning the workers may ignore. V1 can claim prevention for detected tool-managed exact overlaps; it must not claim complete lost-edit prevention for opaque shell writes.

### 7.8 Stall and crash recovery

Use meaningful activity, not only process existence:

```text
active work/tool progress
  → observe
quiet beyond soft threshold
  → gentle status/wrap-up nudge
still quiet
  → explicit progress or blocker request
no response / session non-live
  → resume if possible
resume impossible or fails
  → replacement attempt with evidence
attempt cap exhausted
  → attention/user decision
```

Safeguards:

- do not nudge while a known long-running tool is within its own timeout;
- cooldown and deduplicate nudge messages;
- distinguish user pause from worker stall;
- use process/session generation, not PID alone;
- retain partial transcript and commit evidence;
- replacement is fix-forward; never reset unrelated current-branch state.

### 7.9 Scope completion

A mission reaches integrated verification only when:

- no relevant ready work remains;
- all relevant tickets are terminal;
- no attempts are queued/running/settled-unassessed;
- no blocking review disposition remains;
- no unresolved parent question remains.

Then:

1. reconcile quiescent dirty state;
2. run configured validation once;
3. if validation fails, create attributed fix-forward work or attention;
4. run scope review against the epic goal;
5. adjudicate findings;
6. continue if new blocking fix work is created;
7. mark mission completed only after convergence.

---

## 8. Recommended implementation architecture

### 8.1 Package boundary

#### `pi-minions` owns

- child `AgentSession` lifecycle;
- foreground and detached spawn;
- model/tool/skill scoping;
- progress/activity events;
- settle detection;
- steer/follow-up/stop/resume;
- result artifact/transcript and durable result availability;
- concurrency queues;
- generic completion delivery/consumption for direct, non-mission spawns;
- human-facing minion/fleet UI.

#### `pi-beadwork-extension` owns

- activation and `bw` adapter;
- mission scope/policy;
- ready scheduling;
- ticket-to-attempt mapping;
- orchestration obligations;
- worker handoff/guidance;
- completion assessment;
- the sole parent-message delivery path for mission-owned attempts;
- review/adjudication/remediation policy;
- integrated validation/scope review;
- beadwork dashboard and durable comments/follow-ups.

A minion spawn declares its `deliveryOwner`. For direct spawns, minions may inject the generic result. For `deliveryOwner: "beadwork:<missionId>"`, minions only persists the result and emits a wake-up event; beadwork creates and delivers the mission-specific obligation. There must never be both a generic minion completion and a beadwork completion nudge for the same attempt.

#### Neither owns

- a second task graph;
- a general mail service;
- an unbounded daemon fleet;
- arbitrary cross-project agent discovery.

### 8.2 Minion Runtime V2 protocol

Expose a public, versioned protocol over `pi.events` and export its TypeScript types.

`pi.events` is a best-effort in-process notification bus, not a durable or at-least-once transport. It is used to wake consumers after state has been persisted. Mission reliability comes from the write-ahead journal described in section 10; startup reconciliation recovers events/effects the bus never delivered.

Example channels:

```text
minions:ready
minions:rpc:ping
minions:rpc:spawn
minions:rpc:steer
minions:rpc:inspect
minions:rpc:stop
minions:rpc:consume
minions:started
minions:progress
minions:signal
minions:settled
minions:failed
minions:delivery
```

Envelope:

```ts
type MinionEvent<T> = {
  protocolVersion: 1;
  eventId: string;
  sequence: number;
  occurredAt: string;
  parentSessionId: string;
  parentSessionGeneration: number;
  agentSessionId: string;
  attemptId?: string;
  ownerId: string;
  payload: T;
};
```

Properties:

- live `pi.events` delivery is best effort; durable attempt results are replayable from the owning store;
- effects are idempotent by `eventId`/operation key;
- completion is based on `agent_settled` and `prompt()` resolution;
- owner checks prevent one mission from stopping another mission's child;
- result delivery can be consumed to suppress a redundant parent message;
- RPC replies use request-scoped channels and explicit success/error envelopes;
- child sessions share Pi's event bus rather than a private duplicate bus;
- session shutdown aborts/disposes or parks children according to policy.

### 8.3 Foreground and detached spawn

Keep today's `spawn` behavior by default during migration, then consider making detached the agentic default after UX validation.

```ts
spawn({
  task,
  agent,
  model,
  mode: "foreground" | "detached",
  ownerId,
  attemptId,
  tools,
  cwd,
});
```

Detached spawn returns only after startup is confirmed:

```ts
{ id, sessionPath, status: "queued" | "running" }
```

A failed startup is an error, not a successful handle.

### 8.4 Parent-safe completion inbox

A fixed `followUp` or fixed `steer` policy cannot satisfy both fast reaction and duplicate suppression. Use an inbox.

State per completion:

```ts
type CompletionDelivery = {
  eventId: string;
  attemptId: string;
  targetSessionId: string;
  targetGeneration: number;
  state: "pending" | "queued" | "delivered" | "consumed" | "expired";
  urgency: "routine" | "action-needed" | "blocking";
};
```

Delivery policy:

- routine progress: UI/runtime only;
- routine completion in interactive mode: short hold, group nearby events, trigger when idle;
- completion while an autonomous mission turn is active: safe-boundary `steer` when the result creates a new obligation;
- blocking worker question: safe-boundary `steer` unless the user has explicitly interrupted/paused autonomy;
- user-interrupt latch: preserve as a card/next-turn item; never surprise-resume;
- consumed result: no later duplicate message;
- replaced session generation: do not inject into the new session unless mission recovery explicitly rebinds it.

### 8.5 Mission controller as reducer + effect runner

Split decision from side effects.

```ts
type MissionEvent =
  | { type: "attempt-started"; ... }
  | { type: "attempt-progress"; ... }
  | { type: "worker-signal"; ... }
  | { type: "attempt-settled"; ... }
  | { type: "review-settled"; ... }
  | { type: "finding-disposed"; ... }
  | { type: "validation-settled"; ... }
  | { type: "user-paused" | "user-resumed"; ... };

type MissionEffect =
  | { type: "spawn-attempt"; ... }
  | { type: "deliver-parent-message"; ... }
  | { type: "steer-worker"; ... }
  | { type: "comment-ticket"; ... }
  | { type: "create-follow-up"; ... }
  | { type: "run-review"; ... }
  | { type: "run-validation"; ... }
  | { type: "request-user-decision"; ... };
```

Benefits:

- reducer tests can prove every transition;
- duplicate events produce no duplicate effects;
- model judgment arrives as another validated event;
- side effects carry stable operation IDs;
- restart reconciliation can replay evidence without replaying completed effects.

### 8.6 Attempt records, not one flat worker object

Recommended shape:

```ts
type AgentAttempt = {
  identity: {
    attemptId: string;
    missionId: string;
    ticketId: string;
    role: "implementer" | "reviewer" | "adjudicator" | "remediator" | "scope-reviewer";
  };
  runtime: {
    agentSessionId?: string;
    mode: "minion" | "tmux";
    state: "queued" | "running" | "settled" | "stopped" | "interrupted";
    startedAt?: string;
    settledAt?: string;
    lastMeaningfulActivityAt?: string;
  };
  evidence?: CompletionEvidence;
  reviews: ReviewRound[];
  deliveries: DeliveryReceipt[];
  lineage?: { replacesAttemptId?: string; resumedFromAttemptId?: string };
};
```

This replaces optional-field combinations such as “status running + review remediation in progress + ticket closed + validation passed.”

### 8.7 Dynamic guidance compiler

Compile guidance from current state instead of appending one static prompt.

Layers:

1. **Minimal invariant layer** — beadwork durability, scope discipline, completion evidence.
2. **Role layer** — implementer, reviewer, adjudicator, remediator.
3. **Mission context** — ticket, epic, dependencies, project rules.
4. **State delta** — only changes since the agent's acknowledged sequence.
5. **Current obligation** — exactly what must happen next and what actions are allowed.

Parent example:

```text
[MISSION OBLIGATIONS]
1. Review attempt A-17 settled for BW-123. Assess evidence before acceptance.
2. Reviewer R-4 returned 3 findings. Every finding needs fix/file/reject.
3. Capacity: 1 slot. BW-128 became ready after BW-123 closed.

Required next step:
- Adjudicate R-4 against BW-123 + EPIC-10 intent.
- Dispatch only accepted fixes; create real tickets for file dispositions.
- Do not mark BW-123 accepted while a fix disposition is unresolved.
```

Worker example:

```text
[GUIDANCE DELTA seq=8]
- Parent approved API shape X.
- Sibling BW-125 now owns src/shared/types.ts; coordinate before editing it.
- Reviewer fixes F-1 and F-3 are accepted. F-2 was rejected; do not address it.
```

### 8.8 Workspace coordination board

Keep this intentionally small.

Storage tiers:

- same-process minions: live in-memory board + event stream;
- restart diagnostics: compact local snapshot under `.pi/beadwork/coordination/`;
- durable decisions: beadwork comment/dependency/follow-up only when semantically important.

No message archive is required. No general inbox is required. Claims can be reconstructed from active attempts and observed tool/git paths.

### 8.9 Cross-process ownership

The existing process-local locks are insufficient if two parent Pi sessions operate the same epic. A fenced single-controller lease is a V1 prerequisite, not an optional policy.

- Lease scope is the normalized mission scope (for V1, one epic ID).
- Acquisition is atomic under a cross-process OS/file lock; checking JSON existence is not sufficient.
- The lease record contains `missionId`, owner parent session ID, parent generation, a monotonically increasing fencing token, renewal timestamp, and expiry.
- Every mutating mission effect carries the fencing token and refuses to commit if the controller no longer owns the current token.
- A second parent opens read-only status by default. It may take over only after expiry or an explicit operator-approved handoff that increments the token.
- Renewal uses a same-machine bounded lease and stops on parent shutdown. A crashed parent is fenced when the lease expires.
- Minion/tmux attempts may continue after controller loss, but their results enter the durable mission journal; they cannot dispatch follow-up effects until a controller owns the lease.

This prevents dual dispatch while keeping the lease a controller invariant rather than a path-reservation prerequisite.

### 8.10 Controller recovery and session rebinding

`beadwork_resume_mission(missionId)` performs a deterministic recovery sequence:

1. load the mission journal and latest checkpoint;
2. acquire a new fenced controller lease or remain read-only;
3. invalidate delivery entries targeting an older parent session generation;
4. inspect minion sessions and tmux workers referenced by open attempts;
5. mark an in-process attempt `interrupted` unless a live handle proves it is still running;
6. persist any settled result that was written before the parent disappeared;
7. reconcile every `effect-planned` entry against beadwork, git, minion runtime, and finding fingerprints;
8. mark effects committed, safely retry idempotent effects, or create an `ask-user` obligation when the outcome is uncertain;
9. rebind pending obligations and undelivered completion cards to the new parent generation;
10. only then refresh `bw ready` and dispatch new work.

Lifecycle policy is explicit:

- `/reload`: same mission/session generation when Pi preserves the session; rebind runtime handlers.
- `/new` or switch to another session: pause the mission and release its controller lease unless the user explicitly leaves it supervised elsewhere.
- graceful quit: persist checkpoint, stop or detach attempts according to runtime policy, release lease.
- process crash: lease expiry fences the old controller; recovery never assumes in-memory events were delivered.

### 8.11 Judgment boundaries

| Decision | Deterministic | Model |
| --- | --- | --- |
| Issue ready | Yes | No |
| Concurrency slot | Yes | No |
| Agent truly settled | Yes | No |
| Commit exists/ancestry | Yes | No |
| Schema/result valid | Yes | No |
| Duplicate event/effect | Yes | No |
| Finding is correct | Evidence checks only | Yes |
| Finding is in ticket scope | Guardrails only | Yes |
| `fix | file | reject` | Validate allowed action | Yes |
| Worker blocker vs recoverable ambiguity | Mechanical evidence | Yes |
| Scope goal actually met | Validation facts | Yes |
| User approval required | Policy | User/model prepares question |

---

## 9. Likely files and modules affected

### `packages/pi-minions`

| File/module | Expected change | Confidence |
| --- | --- | --- |
| `src/subsessions/manager.ts` | Switch completion to settled semantics; child shutdown; shared event bus; robust persisted-state normalization | confirmed |
| `src/subsessions/types.ts` | Public detached handle, attempt/owner/session generation, result evidence | confirmed |
| `src/tools/spawn.ts` | Add foreground/detached mode, bounded concurrency, partial-result preservation | confirmed |
| `src/spawn.ts` | Separate execution from foreground waiting; graceful settle and usage capture | confirmed |
| `src/index.ts` | Runtime wiring, events, RPC, completion delivery, shutdown | confirmed |
| `src/subsessions/event-bus.ts` | Remove or adapt to Pi's shared `pi.events` | confirmed |
| `src/tree.ts` / UI modules | queued, running, waiting, settled, consumed states | inferred |
| `src/runtime/protocol.ts` | New versioned public event/RPC contracts | speculative new file |
| `src/runtime/delivery.ts` | Completion inbox, grouping, consume receipts | speculative new file |
| `src/runtime/manager.ts` | Exported runtime API independent of tool UX | speculative new file |
| `src/tools/steer.ts`, `wait.ts`, `consume.ts` | Model-facing lifecycle controls if useful | speculative new files |
| `src/__tests__/` | Real child lifecycle, retry/settle, cancellation, duplicate delivery, replacement | confirmed |

### `packages/pi-beadwork-extension`

| File/module | Expected change | Confidence |
| --- | --- | --- |
| `src/index.ts` | Consume minion protocol, mission lifecycle, model-visible obligations, unified tracking for command/tool delegation | confirmed |
| `src/orchestrator.ts` | Strangler refactor; eventually remove live session/process orchestration | confirmed |
| `src/types.ts` | Mission, attempt, evidence, review round, obligation, delivery receipt | confirmed |
| `src/prompt.ts` | Dynamic guidance compiler instead of only mode appendix | confirmed |
| `src/handoff.ts` | Role-specific contracts and guidance deltas | confirmed |
| `src/registry.ts` | Migration adapter; stop being primary live process owner | inferred |
| `src/session-state.ts` | Mission pause/resume, session generation, pending obligations | confirmed |
| `src/bw.ts` | Stable operation IDs/dedupe helpers if CLI allows; no generic passthrough | inferred |
| `src/attribution.ts` | Consume explicit commit evidence first; heuristic fallback only | confirmed |
| `src/worker-diagnostics.ts` | Attempt/outcome distinction and next obligation | confirmed |
| `src/config.ts` | Runtime, delivery, autonomy, stall, claims, review policy | confirmed |
| `src/controller/*` | Reducer, effect runner, scheduler, obligation engine | speculative new directory |
| `src/review/*` | reviewer, adjudication, disposition, remediation | speculative extraction |
| `src/coordination/*` | advisory claims and overlap analysis | speculative extraction |
| `src/__tests__/` | reducer, integration, restart, duplicate effects, shared checkout | confirmed |

### Package dependency direction

`pi-beadwork-extension` should communicate through the versioned event protocol. It may import protocol types from `@solvedbydev/pi-minions` as a type/runtime compatibility package, but it should not import private manager classes.

When minions is not loaded or protocol negotiation fails:

- commands explain the missing runtime;
- foreground/manual beadwork tools remain usable;
- the existing tmux backend may remain available during migration.

---

## 10. Data, persistence, and compatibility

### Write-ahead mission journal

Mission reliability requires one project-local control journal, separate from the durable task graph:

```text
.pi/beadwork/missions/<mission-id>/
  journal.jsonl
  checkpoint.json
  controller-lease.json
```

The journal records runtime control facts, not duplicate task truth:

- mission created/paused/resumed;
- controller lease/fencing token;
- attempt planned/started/settled/interrupted;
- completion evidence persisted;
- obligation created/resolved;
- effect planned/committed/uncertain;
- parent delivery queued/delivered/consumed/expired.

Ordering rule: persist and flush the new attempt/result/obligation/effect state before emitting `pi.events` or injecting a parent message. `pi.events` is only the fast wake-up channel. `checkpoint.json` is an atomically replaced compact projection of the append-only journal.

For an external side effect, append `effect-planned` before execution and `effect-committed` after verification. Recovery reconciles a stranded planned effect using its operation ID. If the external operation cannot prove whether it happened, do not retry blindly; mark it uncertain and ask the controller/user. Pi custom session entries may mirror mission UI state but are not the authoritative effect journal.

### State lifetime

| State | Lifetime | Persistence |
| --- | --- | --- |
| Beadwork graph | project durable | beadwork/git |
| Git result | project durable | git |
| Mission control/effect journal | local durable | `.pi/beadwork/missions/<id>/journal.jsonl` + checkpoint |
| Mission scope/policy | mission durable | mission journal; parent session entry is a projection |
| Agent session/transcript | local durable | Pi session JSONL |
| Live runtime handle | process local | reconstructed from session metadata |
| Attempt result/lineage | mission durable | mission journal + minion result artifact; significant outcome mirrored to beadwork |
| Delivery receipt | parent session generation | mission journal for mission attempts; minion store for direct spawns |
| Workspace claim | ephemeral lease | in-memory + compact local snapshot |
| Finding and disposition | mission durable; project durable when actionable | mission journal/review artifact + beadwork comment/follow-up |

### Idempotency

Every mutating controller effect gets an operation key, for example:

```text
mission:<mission-id>:ticket:<ticket-id>:attempt:<n>:spawn
review:<review-id>:finding:<finding-id>:file
attempt:<attempt-id>:delivery:<event-id>
scope:<epic-id>:validation:<failure-signature>:follow-up
```

Before replaying an effect, reconcile actual state:

- active attempt already exists;
- ticket already closed/reopened;
- follow-up with finding signature already exists;
- completion already consumed;
- commit already present;
- review round already resolved.

Durable write-ahead state plus best-effort wake-up events and idempotent effects are the target. Exactly-once delivery should not be claimed.

An operation ID is useful only if every owner honors it. Minion spawn deduplicates `attemptId`; follow-up creation searches the canonical finding fingerprint; delivery consumption is keyed by event ID and parent generation. For `effect-planned` entries left by a crash, recovery verifies actual external state before retrying.

### Registry migration

The current worker registry should be supported during a transition:

1. Existing tmux records continue to display and land.
2. New minion attempts use the new attempt model.
3. Dashboard aggregates both through a normalized view.
4. Once tmux missions have drained and fault tests pass, stop creating old-style records for minion-backed attempts.
5. Retain a read-only legacy normalizer for old records.

---

## 11. API, CLI, UI, and config surfaces

### Proposed model tools

Runtime tools can remain under minions:

- `spawn` with `mode`;
- `minion_status` / existing list/show;
- `minion_steer`;
- `minion_wait` with abortable bounded wait;
- `minion_stop`;
- `minion_consume_result`.

Beadwork should expose higher-level intent:

- `beadwork_run_mission`;
- `beadwork_pause_mission`;
- `beadwork_resume_mission`;
- `beadwork_mission_status`;
- `beadwork_signal` for workers;
- `beadwork_resolve_finding` if the parent is explicitly resolving review output;
- existing issue CRUD tools.

Avoid exposing raw runtime choreography to the orchestrator when a high-level beadwork action exists.

### Proposed dashboard additions

Mission tab:

- epic(s), autonomy state, concurrency, current phase;
- pending obligations, ordered by urgency;
- ready/capacity summary;
- last automatic action and next safe action.

Workers tab:

- attempt role and ticket;
- runtime state vs outcome state;
- current activity/current tool;
- last meaningful activity;
- pending question/blocker;
- declared and observed paths;
- review/remediation lineage;
- steer/stop/resume/review actions.

Review tab or detail pane:

- findings and evidence;
- disposition status;
- rationale;
- linked remediation/follow-up;
- unresolved blocking findings.

Coordination indicators:

- exact overlap;
- broad possible overlap;
- build slot contention;
- one-click sequence/isolate/allow choices.

### Config sketch

```json
{
  "minions": {
    "backgroundByDefault": false,
    "maxConcurrent": 4,
    "completionGroupingMs": 750,
    "completionGroupMaxWaitMs": 10000,
    "settledRetentionMs": 600000
  },
  "mission": {
    "autoContinue": true,
    "maxAutomaticTurns": 20,
    "controllerLeaseMs": 60000,
    "delivery": {
      "completionWhileBusy": "safe-boundary",
      "routineWhileIdle": "trigger",
      "afterUserInterrupt": "next-turn"
    },
    "stall": {
      "softIdleMs": 300000,
      "hardIdleMs": 900000,
      "maxNudges": 2
    },
    "review": {
      "enabled": true,
      "maxRemediationAttempts": 2,
      "requireHumanFor": ["P0"]
    },
    "coordination": {
      "claims": "hybrid",
      "schedulerBias": true,
      "exactEditGuard": true,
      "commitGuard": false
    }
  }
}
```

Names should be finalized only after implementation boundaries settle.

---

## 12. Integration and sequencing

The program should ship as vertical, independently useful increments. The full Mission Control vision is a direction, not one release-sized rewrite.

### Release A — Fix today's tmux orchestration seams

- make model-tool `beadwork_delegate` use the same tracking/supervision path as slash-command delegation;
- persist a controller obligation for worker completion and deliver it model-visibly instead of only using `ctx.ui.notify()`;
- replace regex `fix | file | reject` with structured model adjudication;
- make `file` create/link a real fingerprinted follow-up issue;
- change new worker completion semantics so evidence is submitted before ticket closure where practical;
- add duplicate-notice and early-dependent-unlock regressions.

Exit criterion: the current tmux path reacts to completion and handles review findings correctly without waiting for the minion rewrite.

### Release B — Reliability foundation in minions

- complete on `agent_settled`/`prompt()` resolution, not first `agent_end`;
- inspect assistant stop reasons and failures;
- guarantee child `session_shutdown` and disposal;
- bind parent/child session lineage correctly;
- use a shared Pi event bus;
- make restored `running` state become `interrupted` unless a live handle proves otherwise;
- add real `AgentSession` lifecycle tests;
- add bounded concurrency.

Exit criterion: a foreground minion can retry/compact, settle once, cancel cleanly, and leave no false-running metadata.

### Release C — Detached Minion Runtime V2

- exported runtime manager/API;
- detached spawn and startup confirmation;
- versioned event/RPC protocol;
- inspect/steer/stop/resume;
- durable result availability, generic direct-spawn delivery, grouping, and consumption;
- parent session generation and user-interrupt latch;
- fleet UI updates.

Exit criterion: the parent can keep interacting while two direct minions run, receive one completion each, consume results without duplicates, and survive `/new`/reload without wrong-session injection.

### Release D — One beadwork ticket through the minion backend

- introduce a narrow runtime adapter (`spawn`, `inspect`, `steer`, `stop`, `resume`);
- map one ticket to one attempt ID;
- keep beadwork as the sole mission delivery owner;
- preserve tmux fallback;
- separate attempt settle from controller-owned ticket acceptance;
- run implement → review → adjudicate → remediate → close end to end.

Do not introduce the full reducer/journal abstraction merely to make this slice compile. Record operation IDs and the smallest durable attempt state needed; extract the reducer only when the next release demonstrates repeated transition logic.

Exit criterion: one ticket completes through minions with no tmux polling and no duplicate parent delivery.

### Release E — Single-epic mission journal and obligation engine

- fenced controller lease;
- write-ahead mission journal and recovery command;
- reducer/effect runner over demonstrated transitions;
- typed worker signals;
- dynamic parent/worker guidance;
- ready dispatch after controller-owned ticket acceptance;
- pause/resume and bounded automatic turns;
- context-preserving remediation;
- quiescent validation and scope review.

Exit criterion: one epic progresses through dependency waves, survives parent restart without duplicate effects, and remains user-interactive.

### Release F — Workspace coordination safety

- broad advisory claims and overlap UI;
- exact edit/write ownership guard;
- scheduler bias and worktree fallback for broad/opaque writes;
- optional commit guard;
- stall/recovery ladder;
- dedicated shared-checkout fault tests.

Exit criterion: detected tool-managed exact overlaps serialize or isolate without lost edits; opaque shell-write limits are explicit and tested.

### Release G — Multi-epic missions, if required

- mission scope accepts multiple epic IDs;
- shared capacity and fairness;
- per-epic quiescence and final review;
- portfolio-level pause/attention UI;
- no cross-epic graph duplication.

The target vision supports one or more epics. The first release intentionally proves one epic; whether plural scope moves into the V1 release is a product decision below.

---

## 13. Compatibility, rollout, and backout

### Strangler migration

Do not rewrite the current orchestrator in one cut.

- introduce normalized attempt events alongside current worker inspection;
- run selected tickets through minions behind config;
- compare resulting artifacts/status with tmux path;
- retain explicit tmux/worktree fallback;
- move functions out of `orchestrator.ts` only when the new boundary has tests;
- delete old creation paths only after no active registry records need them.

### Compatibility promises

- existing issue tools and commands continue to work;
- `/bw delegate` and `/bw run` retain recognizable behavior;
- worktree execution remains available;
- old worker records remain readable;
- inactive repos stay quiet;
- foreground `spawn` remains available;
- model/provider overrides remain independent by role.

### Backout

A repo-level config should be able to select:

```json
{
  "mission": { "runtime": "tmux" }
}
```

until the migration is proven. Backout must not require issue graph migration because beadwork remains the source of truth throughout.

---

## 14. Security, trust, and safety boundaries

### Tool capability policy

Minions should not blindly inherit every parent extension/tool.

Role defaults:

- implementer: repo tools + ticket signal + scoped beadwork completion;
- reviewer: read/search/git/test, no edit by default;
- adjudicator: read ticket/review evidence, no code mutation;
- remediator: implementer tools but only approved finding context;
- scope reviewer: read/search/git/test, no edit.

Explicitly deny unless needed:

- recursive mission launch;
- raw issue graph mutation by ordinary workers;
- global cleanup/reset/stash;
- parent UI commands;
- stop/consume of attempts owned by another mission.

### Prompt/project trust

Project-defined agents, skills, claim policies, and commands are executable or model-shaping configuration. Respect Pi's project trust state before loading them into child sessions.

### User priority

- user interrupt pauses surprise auto-resume;
- user messages outrank pending mission continuation;
- destructive remediation and high-severity security decisions can require human approval;
- “automatic” never means unbounded turns or attempts.

### Current-branch safety

- never reset, clean, or stash unrelated state;
- commit only explicit paths;
- broad path claims are advisory; exact tool-managed edit/write ownership is guarded by default;
- integrated validation waits for quiescence;
- use worktree mode when isolation is the safer choice;
- a reviewer inspects immutable attributed commits, not ambient moving `HEAD`.

---

## 15. Error handling and failure modes

| Failure | Required behavior |
| --- | --- |
| Child retries/compacts | Do not complete until settled |
| Child startup fails | Return error; no false running attempt |
| Parent busy | Queue by urgency; deliver at safe boundary |
| User interrupts | Pause auto-resume; preserve obligation visibly |
| Duplicate event | Reducer emits no duplicate effect |
| Parent session replaced | Reject stale-generation delivery |
| Parent process exits | Mark in-process attempts interrupted on recovery; tmux fallback may continue |
| Worker question unanswered | Keep explicit blocking obligation; do not classify as crash |
| Worker silent in long tool | Respect tool deadline before stall nudge |
| Worker vanishes | Resume/replacement ladder with bounded attempts |
| Review output malformed | One schema repair attempt, then attention; preserve raw output |
| Reviewer finding ambiguous | Adversarial verify or user decision |
| Follow-up already exists | Link it; do not duplicate |
| Same-path overlap | Warn/coordinate/serialize/isolate according to policy |
| Claim expires | Notify owner and lower confidence; do not silently hard-block |
| Two controllers target epic | Lease/takeover policy; no dual dispatch |
| Validation fails | Attributed fix-forward work or attention; no scope review yet |
| Remediation cap exhausted | Attention with complete evidence |
| Runtime protocol unavailable | Explain and use configured fallback |

Debuggability requirements:

- every event/effect has IDs and timestamps;
- attempt detail links child transcript and artifacts;
- review detail preserves raw/parsed/disposition data;
- dashboard reports the exact next obligation;
- failure summaries name whether the problem is graph, runtime, evidence, judgment, delivery, or workspace conflict.

---

## 16. Testing strategy

### `pi-minions` unit/integration coverage

- `agent_end` followed by retry does not complete;
- `agent_end` followed by compaction does not complete;
- only one settled event is emitted;
- assistant error/abort is not success;
- detached spawn returns after startup, not after completion;
- queued cancellation settles and releases capacity;
- active cancellation waits for actual session settlement;
- `session_shutdown` runs and child resources dispose;
- parent `/new`, resume, fork, and reload reject stale deliveries;
- duplicate events inject once;
- consumed completion never injects later;
- grouped completion flushes complete and partial groups correctly;
- foreground and background results preserve partial successes;
- event RPC enforces ownership and protocol version;
- restored running metadata becomes interrupted without a live handle.

### Beadwork reducer/property coverage

For every event:

- duplicate replay is idempotent;
- illegal state transition is rejected;
- exactly the expected obligation is created;
- obligation resolution removes it once;
- effect keys remain stable across restart;
- accepted tickets cannot retain unresolved blocking findings;
- scope completion cannot occur with active/unassessed attempts.

### Fault harness

Simulate:

- duplicate completion;
- dropped progress;
- dropped completion followed by reconciliation;
- parent restart before/after delivery;
- parent restart between follow-up creation and receipt persistence;
- child stuck in a tool;
- child process/session death;
- worker asks parent while parent is busy;
- user interrupts before a blocker message arrives;
- reviewer returns malformed output;
- reviewer returns false positive and valid finding together;
- remediation succeeds/fails/exhausts;
- two controllers race to launch one ticket;
- two workers declare and then discover overlapping paths;
- same-file edit through edit/write;
- shell-generated overlapping file change;
- validation reads transient state before quiescence (must be prevented);
- worktree fallback and landing preservation.

### End-to-end scenarios

1. Two ready tickets, two detached minions, one parent conversation.
2. Worker completion while user is actively chatting.
3. Worker blocker → parent answer → same worker resumes.
4. Worker result → review → mixed fix/file/reject → remediation → re-review → accepted.
5. Worker crash → persisted-session resume or replacement → accepted.
6. Exact tool-managed overlap → younger attempt pauses or isolates → no lost edit on the guarded surface.
7. Scope validation failure → deduplicated fix-forward child → mission completes.
8. Parent restart mid-mission → no duplicate launch or result.
9. Explicit worktree attempt → validation/review/landing still works.
10. Multi-model role routing with independent worker/reviewer/adjudicator models.

### Quality gates

Every implementation slice must pass:

```sh
npm run lint
npm run test
npm run typecheck
```

Real-agent dogfood should supplement, not replace, deterministic tests.

---

## 17. Metrics and acceptance evidence

Track enough to decide whether the redesign is actually better.

### Reliability

- duplicate model-visible completion rate: target 0;
- wrong-session delivery rate: target 0;
- false-running attempts after restart: target 0;
- duplicate launch/remediation/follow-up rate: target 0;
- unresolved worker exits without parent obligation: target 0.

### Responsiveness

- worker settle → parent obligation latency;
- blocker signal → parent/user visibility latency;
- parent remains available while workers run;
- percentage of mission progress driven without manual `/bw workers` polling.

### Efficiency

- integrated validation runs per mission;
- review/remediation model calls per accepted ticket;
- cold replacement vs context-preserving resume rate;
- progress events coalesced vs injected into model context;
- conflict warnings that prevented overlap vs false-positive warnings.

### Outcome quality

- accepted review findings later shown invalid;
- rejected findings later shown valid;
- missions completing with unmet epic acceptance criteria;
- follow-up issues created per review and deduplication rate;
- current-branch conflict/lost-edit rate compared with pre-claims baseline.

---

## 18. Material risks and open design questions

### Material risks

1. **A hidden rewrite.** Calling this “integration” while retaining both complete orchestrators would increase complexity. The migration needs deletion milestones.
2. **Completion timing.** Fast safe-boundary delivery and late duplicate suppression pull in opposite directions. The inbox/consume model must be tested under real Pi scheduling.
3. **In-process durability.** Child sessions can persist, but running computation does not survive parent process death.
4. **Cross-process ownership.** Multiple parent sessions need an explicit policy; process-local maps are insufficient.
5. **Moving shared checkout.** Review and validation need immutable evidence and quiescent boundaries.
6. **Claims becoming locks.** Broad claims must stay advisory; exact tool-managed ownership is a narrow deterministic guard, not a second general scheduler.
7. **Frontier-model over-trust.** Better models still produce bad review and false completion. Evidence and bounded loops remain mandatory.
8. **Prompt accumulation.** Dynamic guidance must be delta-based and sequence-aware or it will become stale context noise.
9. **Extension/tool privilege.** Child sessions must not inherit orchestration authority accidentally.
10. **UI work outrunning semantics.** Build the event/obligation contracts before redesigning dashboards around them.

### High-leverage questions for product direction

1. **Durability target:** Must a running worker continue executing after the parent Pi process exits, or is it sufficient that its session/evidence can be recovered and resumed when the parent returns? This decides whether in-process minions can become the default runtime or tmux/child processes must remain first-class.
2. **Workspace safety contract:** Is detected-overlap prevention enough, with shell-heavy/unknown writes routed to worktrees, or do you want a stronger default that isolates any ticket without a trustworthy declared edit surface?
3. **Autonomy authority:** May the orchestrator automatically execute all `fix | file | reject` dispositions, or should selected categories (for example P0/security, rejection of high-confidence findings, destructive cleanup) require human confirmation?
4. **Ticket acceptance gate:** Must every implementation ticket remain `in_progress` and pass independent review before `bw close` unlocks dependents, or may some tickets close on worker evidence and rely on wave/scope review? The former is safer and slower; the latter preserves more current beadwork throughput.
5. **Multi-epic boundary:** Is support for a set of epics a V1 release requirement, or should the first mission release prove one epic end to end and add portfolio scheduling immediately afterward?

### Recommended provisional answers

Until the user decides:

- recoverable/resumable execution is sufficient; tmux remains the continue-after-parent-exit fallback;
- broad claims are advisory, exact tool-managed edit/write ownership is guarded, and opaque shell-heavy writes use worktrees;
- P0/security and destructive actions require human confirmation; ordinary fix/file/reject can be autonomous and auditable;
- implementation tickets stay `in_progress` until required review and targeted validation pass, so dependents do not unlock on provisional worker claims;
- single epic ships first with a singular V1 API; plural mission scope is added without changing beadwork graph semantics.

---

## 19. Alternatives considered

### Keep beadwork orchestration and only improve prompts

This would help immediately but leaves parent responsiveness, duplicate delivery, lifecycle ownership, and worker control unresolved.

### Replace beadwork workers directly with today's foreground minions

Rejected. It would block the parent and lose current background/restart behavior.

### Adopt `@tintinweb/pi-subagents` directly

It is strong prior art, but the project already owns `pi-minions`, needs package-specific policy, and should not make durable beadwork orchestration depend on another extension's evolving RPC contract.

### Adopt MCP Agent Mail

Rejected for V1. Its features exceed the local same-process need and its operational surface is substantial. Its concepts should inform a smaller coordination board.

### Make worktrees mandatory again

Rejected as the default. They remain the strongest isolation tool and should be selected for high-overlap/risky tickets, not imposed on every task.

### Build a new all-in-one orchestration package

Rejected. This would repeat the current concentration problem and obscure ownership. The runtime belongs in minions; durable mission policy belongs in beadwork.

---

## 20. Handoff to planning workflow

Reviewers should scrutinize these decisions first:

1. completion inbox timing and consumption semantics;
2. child-session durability expectations;
3. cross-parent controller ownership;
4. attempt/outcome data model and migration from `WorkerRuntime`;
5. whether advisory claims are enough for the intended shared-checkout scale;
6. exact model-vs-deterministic boundary for attribution and finding disposition;
7. deletion plan for old tmux orchestration code.

A competing plan would be most valuable if it can provide the same parent responsiveness and restart/idempotency guarantees with fewer new concepts.

This proposal is ready for `planning-workflow` review, adversarial challenge, and stabilization. It is intentionally not yet a bead/task graph.

---

## Appendix A: Evidence pointers

### Current repo

- `packages/pi-minions/README.md`
- `packages/pi-minions/src/index.ts`
- `packages/pi-minions/src/tools/spawn.ts`
- `packages/pi-minions/src/spawn.ts`
- `packages/pi-minions/src/subsessions/manager.ts`
- `packages/pi-minions/src/subsessions/event-bus.ts`
- `packages/pi-minions/src/subsessions/types.ts`
- `packages/pi-minions/src/delegation.ts`
- `packages/pi-beadwork-extension/README.md`
- `packages/pi-beadwork-extension/docs/workflows.md`
- `packages/pi-beadwork-extension/docs/current-branch-e2e.md`
- `packages/pi-beadwork-extension/src/index.ts`
- `packages/pi-beadwork-extension/src/orchestrator.ts`
- `packages/pi-beadwork-extension/src/types.ts`
- `packages/pi-beadwork-extension/src/prompt.ts`
- `packages/pi-beadwork-extension/src/handoff.ts`
- `packages/pi-beadwork-extension/src/registry.ts`
- `packages/pi-beadwork-extension/src/session-state.ts`
- `packages/pi-beadwork-extension/src/attribution.ts`
- `packages/pi-beadwork-extension/src/bw.ts`
- `packages/pi-beadwork-extension/src/__tests__/unit/substrate-invariants.test.ts`
- `packages/pi-beadwork-extension/src/__tests__/unit/scope-completion.test.ts`
- `docs/beadwork-pi-extension-research.md`
- `docs/pi-beadwork-extension-implementation-plan.md`
- `docs/proposals/proposal_current_branch_swarm_self_contained.md`

### Pi 0.84.3

- `@earendil-works/pi-coding-agent/docs/extensions.md`
- `@earendil-works/pi-coding-agent/docs/sdk.md`
- `@earendil-works/pi-coding-agent/examples/extensions/subagent/`

### External source research

- OMP: [github.com/can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) at `v18.0.8`
  - `docs/tools/task.md`
  - `docs/tools/hub.md`
  - `docs/agent-hub.md`
  - `docs/advisor-watchdog.md`
  - `packages/coding-agent/src/prompts/system/orchestrate-notice.md`
  - `packages/coding-agent/src/prompts/system/workflow-notice.md`
  - `packages/coding-agent/src/async/job-manager.ts`
  - `packages/coding-agent/src/irc/bus.ts`
  - `packages/coding-agent/src/registry/agent-registry.ts`
  - `packages/coding-agent/src/registry/agent-lifecycle.ts`
  - `packages/coding-agent/src/task/executor.ts`
- MCP Agent Mail Rust: [github.com/Dicklesworthstone/mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust) at `v0.3.30`
- Tintin Pi Subagents: [github.com/tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) at `v0.19.0`
- Pi Collaborating Agents: [github.com/baochunli/pi-collaborating-agents](https://github.com/baochunli/pi-collaborating-agents) at `v0.4.3`
- Pi Intercom: [github.com/nicobailon/pi-intercom](https://github.com/nicobailon/pi-intercom) at `v0.12.0`
- Pi Side Agents: [github.com/pasky/pi-side-agents](https://github.com/pasky/pi-side-agents) at `v1.1.3`
- Gas Town: [github.com/gastownhall/gastown](https://github.com/gastownhall/gastown) at `v1.2.1`

## Appendix B: Idea-wizard shortlist

The strongest ideas after generating and winnowing a larger set were:

1. event-driven completion with consumption receipts;
2. beadwork-authoritative lifecycle reducer;
3. ticket-linked parent/worker signals;
4. state-derived guidance compiler;
5. durable finding dispositions;
6. context-preserving remediation;
7. adaptive stall recovery;
8. advisory path intent;
9. versioned minion runtime protocol;
10. detached minion handles.

Ideas intentionally cut from V1:

- full mail/archive service;
- permanent agent hierarchy;
- hard mandatory locks;
- speculative execution;
- general workflow DSL;
- multi-repo federation;
- multi-epic portfolio scheduler unless required by product direction.
