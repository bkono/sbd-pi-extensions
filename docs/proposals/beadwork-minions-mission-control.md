# Revised Proposal: Minions Orchestration Core with a Beadwork Goal Adapter

**Date:** 2026-08-27
**Status:** Revised repo-grounded proposal for review
**Scope:** `packages/pi-minions` + `packages/pi-beadwork-extension`
**Supersedes:** The earlier tmux-migration and detached Mission Control design in this file

## Executive recommendation

Move orchestration mechanics into `pi-minions` and reduce `pi-beadwork-extension` to a domain adapter for goals, tickets, metadata, and beadwork-specific interactions.

The design rests on two contracts:

> **The task type makes the next instruction deterministic; the parent model still judges the evidence and chooses the action.**

> **Role selects behavior; task type selects workflow; beadwork supplies domain context; minions owns orchestration mechanics.**

Concretely:

1. Replace beadwork's tmux worker runtime with non-blocking, in-process Pi child sessions managed by `pi-minions`. Do not improve, preserve, or require the tmux path.
2. Keep child lifetime tied to the parent Pi process. If the parent exits, its children may exit too. Do not build detached execution, restart recovery, controller leases, or a durable orchestration journal for V1.
3. Extend minion spawning with orchestration metadata: a dynamic `role`, an optional closed `taskType`, a short task description, and optional domain metadata.
4. Let `taskType` select deterministic lifecycle guidance. When no task type is present, use the role template's best-effort guidance if available, then fall back to generic guidance.
5. Deliver each meaningful child lifecycle change to the parent as one model-visible orchestration update containing the changed child, a snapshot of all still-running children, and the applicable nudge.
6. Add direct agent-to-agent messaging and parent-visible communication metadata to minions. Agents should not need to route messages through the parent.
7. Treat path intent, TTL reservations, and overlap detection as advisory communication only. Never block writes, pause workers, or claim conflict elimination.
8. Keep the shared checkout as the normal execution environment. A worktree or alternate checkout is an explicit user-selected workspace and must never be chosen dynamically by the runtime.
9. Make per-ticket independent review the beadwork default, while allowing explicit scope-level or disabled review policies.
10. Start review adjudication autonomously and collect consequential decisions for the final handoff instead of interrupting ordinary execution for approval.
11. Prove one epic end to end first, while using a scope representation that can naturally expand to multiple epics later.

This is intentionally smaller than the previous proposal. The durable source of truth remains beadwork; the live orchestration runtime remains process-local.

---

## 1. Normalized feature intent

### Desired workflow

A parent Pi session should be able to delegate several related tasks without blocking, continue interacting with the user, and receive enough structured context to make the next orchestration decision whenever a child changes state.

For every completion, failure, blocker, or explicit handoff, the parent should immediately know:

- which child changed;
- what that child was asked to do;
- which role/prompt it used;
- whether it participated in a known workflow;
- what result or handoff it produced;
- which other children are still running;
- what workflow-specific judgment should happen next.

The mechanism must work whether work originated from beadwork, a one-off code task, a review workflow, or another future domain adapter.

### Hard constraints

- **No tmux dependency.** Beadwork is currently unusable on machines where tmux is absent. The first integrated replacement must use Pi child sessions directly.
- **No automatic worktrees.** Worktrees are a per-scenario, user-selected opt-in. The runtime must never infer, recommend through enforcement, or dynamically move feature work into one.
- **Shared checkout is normal.** Most work occurs on one branch shared by many agents. The system should improve awareness and communication without pretending it can eliminate conflicts.
- **Coordination is advisory.** TTL intent and overlap detection may generate messages, but cannot reject edits, pause workers, or impose locks.
- **Parent and children share a lifetime.** A parent process crash may terminate its children. Durable child-process continuation is not a requirement.
- **Models retain judgment.** Deterministic code selects context and guidance; the parent model evaluates evidence and chooses actions.
- **Roles remain open.** Agent prompt/template names evolve independently of the orchestration protocol.
- **Task types remain closed.** A task type opts a child into a known workflow contract with deterministic lifecycle nudges.

### Desired outcome

There is one reusable orchestration implementation in `pi-minions`. Beadwork no longer maintains a competing process runtime, worker registry, completion notification system, or supervision loop. Instead, beadwork behaves like a domain-specific goal mode: it supplies an epic's intent and work graph while the parent model and minions runtime drive the live work.

---

## 2. Problem and success criteria

### Current problem

The repository contains two overlapping approaches:

- `pi-minions` creates real in-process child `AgentSession`s, tracks them in `AgentTree`, exposes steer/abort handles, and persists child session transcripts, but its `spawn` tool waits for all children before returning.
- `pi-beadwork-extension` can launch work without blocking the parent, but does so through tmux, runtime marker files, polling, a separate worker registry, and beadwork-owned lifecycle logic.

The split produces several problems:

1. Beadwork requires an external terminal multiplexer that is not available on every target machine.
2. Foreground minions cannot be used as the shared orchestration backend because the current tool call blocks.
3. Beadwork and minions maintain different worker identities, status models, inspection surfaces, and completion paths.
4. UI notifications tell the user that something changed but do not reliably give the parent model the state and guidance needed for its next decision.
5. Existing minion completion can be marked on `agent_end`; Pi's settled lifecycle should be used so retries, continuation, or compaction do not produce premature terminal updates.
6. The current worker runtime carries worktree, landing, process, and tmux assumptions into ordinary shared-branch execution.
7. Review behavior is encoded in beadwork orchestration rather than represented as a generic workflow that can be reused outside beadwork.

### V1 success criteria

V1 succeeds when all of the following are true:

1. An orchestrated minion spawn returns a stable handle without waiting for child completion.
2. The parent remains available for user input and further tool calls while children run.
3. A child is terminal only after the underlying Pi session is settled, aborted, or failed.
4. Each meaningful lifecycle change yields one safe-boundary parent update, not merely a UI toast.
5. The update includes the changed child and a fresh snapshot of all still-running orchestrated children.
6. An optional typed task type deterministically selects the parent nudge.
7. Without a task type, a dynamic role may supply best-effort guidance.
8. Direct peer messages reach the addressed child without requiring a parent turn.
9. The parent can inspect peer identities and communication metadata.
10. Beadwork can run one epic to completion using minions, with no tmux runtime or fallback.
11. Shared-checkout execution remains the default, and no worktree is created or selected without explicit user input.
12. Overlap notices remain informational; agents can communicate and sort out conflicts themselves.
13. Ticket review defaults to occurring before close, and review findings are judged by the parent model rather than a keyword classifier.
14. Lint, tests, typecheck, and configured validation continue to gate accepted outcomes.

### Failure criteria

The proposal has failed if implementation:

- keeps tmux as a required dependency, fallback backend, or first migration milestone;
- adds detached children or requires workers to survive parent-process death;
- automatically creates, selects, or routes work to worktrees;
- blocks editing because of reservations or overlap detection;
- encodes role names as a closed union;
- lets role guidance override a provided task type;
- automatically accepts evidence merely because a typed workflow completed;
- leaves beadwork and minions with separate live worker registries or model-visible completion messages;
- wakes the parent once per child when several updates could safely be coalesced;
- makes peer communication depend on parent mediation.

---

## 3. V1 scope, non-goals, and deferred scope

### In scope

- process-local, non-blocking minion execution;
- settled-state lifecycle tracking;
- orchestration groups and fleet snapshots;
- dynamic role metadata;
- optional closed task-type enum;
- deterministic task-type lifecycle nudges;
- role-level fallback completion nudges;
- safe-boundary parent updates and coalescing;
- direct addressed peer messaging;
- parent-visible peer and message metadata;
- advisory TTL path intent and overlap notices;
- explicit workspace/cwd selection only;
- one-epic beadwork goal mode;
- worker completion evidence and independent review;
- autonomous `fix | file | reject` adjudication;
- notable-decision collection for final handoff;
- removal of beadwork's tmux execution path.

### Explicit non-goals

- detached or daemonized child execution;
- child survival after parent exit;
- restart-resumable orchestration;
- cross-process controller leases;
- durable message delivery guarantees;
- a mission event journal or exactly-once effects;
- mandatory reservations, file locks, or edit guards;
- automatic conflict remediation;
- automatic worktree selection or creation;
- a second issue/dependency graph inside minions;
- a mail server, IRC server, SQLite coordination database, or web console;
- deterministic scripts that replace parent-model judgment;
- multi-host or cross-machine agent networking;
- a closed list of agent roles.

### Deferred

- multiple epic scopes in one goal;
- custom task-type registration by third-party domain adapters;
- typed handoff schemas per task type;
- richer communication threads or broadcast channels;
- long-lived orchestration resumption after `/new` or process restart;
- historical analytics across orchestration groups;
- automated ranking by dependency unlock value;
- remote or process-isolated minion backends.

---

## 4. Current repository context

### Confirmed `pi-minions` behavior

- `packages/pi-minions/src/tools/spawn.ts` accepts `task`, optional `agent`, optional `model`, or a batch `tasks` array.
- `executeSpawn()` starts child sessions concurrently but awaits `Promise.allSettled()`, making the tool foreground/blocking.
- `packages/pi-minions/src/subsessions/manager.ts` creates file-backed child `AgentSession`s and retains active session handles for steer and abort.
- `SubsessionManager` emits progress and completion through a local event bus.
- Completion is currently observed on `agent_end` as well as the `session.prompt()` promise, which is too early for the proposed settled contract.
- `packages/pi-minions/src/tree.ts` already provides the basis of a process-local fleet registry: identity, agent name, task, status, activity, usage, model, and parent/child relationships.
- Agent prompt definitions are discovered dynamically from project and user directories. `AgentConfig.name` is therefore already an open, data-driven role identity rather than a TypeScript enum.
- `list_minions`, `show_minion`, and `halt` already expose useful inspection and cancellation surfaces.

### Confirmed beadwork behavior

- `packages/pi-beadwork-extension/src/orchestrator.ts` owns tmux launch, polling, landing, review, remediation, and worker lifecycle orchestration.
- `packages/pi-beadwork-extension/src/types.ts` embeds tmux session/window/pane fields in every worker runtime and maintains a second worker status model.
- `packages/pi-beadwork-extension/src/config.ts` carries tmux, worktree setup, landing, worker execution, and supervisor polling configuration.
- `packages/pi-beadwork-extension/src/index.ts` is currently a large combined command, tool, session-mode, supervisor, and worker runtime entry point.
- `beadwork_delegate` explicitly launches a tmux-backed worker.
- `beadwork_worker_done` currently combines worker evidence, self-review, close/sync, and shutdown behavior.
- Beadwork already has the correct durable domain primitives: tickets, dependencies, readiness, comments, labels, history, scope, and issue status transitions.

### Existing patterns to preserve

- Use child `AgentSession`s rather than shelling out to another agent process.
- Keep agent role definitions in user/project prompt files.
- Reuse `AgentTree` as the canonical process-local fleet registry.
- Reuse Pi safe-boundary message delivery rather than injecting into an active model turn.
- Keep `bw` as the durable work graph and ticket source of truth.
- Preserve explicit user-selected current-checkout or alternate-cwd execution.
- Preserve model judgment for decomposition, review, and finding adjudication.

### Stale patterns to remove

- tmux launch and inspection;
- process marker files and pane discovery;
- beadwork-owned live worker registry;
- polling as the primary child lifecycle mechanism;
- automatic landing assumptions for ordinary shared-branch work;
- runtime-selected worktree behavior;
- UI-only completion notices;
- regex-only review finding classification;
- worker completion automatically implying ticket acceptance.

---

## 5. Core mental model

### Three owners

#### `pi-minions`: orchestration mechanics

Minions owns:

- child session creation and lifetime;
- process-local agent identity and status;
- foreground and non-blocking orchestrated spawn modes;
- orchestration group membership;
- role and task-type metadata;
- task descriptions and domain metadata transport;
- lifecycle events;
- fleet snapshots;
- task-type and role nudge selection;
- safe-boundary parent delivery;
- coalescing pending updates;
- direct messaging, steering, cancellation, and inspection;
- advisory path intent and overlap notices.

#### `pi-beadwork-extension`: domain context

Beadwork owns:

- activation and project detection;
- tickets, epics, dependencies, and readiness;
- goal scope and epic intent;
- issue start, close, reopen, comment, label, and dependency operations;
- beadwork metadata attached to minion work;
- beadwork-specific prompt appendices and completion evidence;
- review and ticket-close policy;
- deciding whether the selected epic is complete;
- durable comments and follow-up tickets.

Beadwork does not own child processes, a worker registry, fleet monitoring, completion delivery, peer messaging, or a generic orchestration loop.

#### Parent model: orchestration policy

The parent model owns:

- selecting work;
- selecting roles and task types;
- choosing how much work to run concurrently;
- interpreting evidence and handoffs;
- deciding whether a worker outcome satisfies a ticket;
- adjudicating findings;
- choosing remediation, follow-up, rejection, or escalation;
- deciding when the goal is complete.

Deterministic code gives the parent the right state and instruction. It does not replace the judgment.

### The central distinction

- **Role answers:** “How should this agent work?”
- **Task type answers:** “What workflow transition should follow this work?”

This distinction must remain visible in types, prompt construction, UI, and tests.

---

## 6. Role contract

### Role is dynamic

A role is an unrestricted string naming the selected agent prompt/template, for example:

- `reviewer`;
- `debugger`;
- `hard_problem_coder`;
- `general_coder`;
- `security_specialist`;
- a project-specific role unknown to the package at build time.

The current `agent` field already selects this dynamic prompt definition. The implementation may either rename the public field to `role` or retain `agent` as a compatibility alias, but orchestration records and model-visible fleet snapshots should use the term `role`.

A role may optionally define fallback completion guidance in its prompt metadata. This guidance is advisory and applies only when no task type is provided.

Illustrative agent frontmatter:

```yaml
---
name: reviewer
description: Independently review completed work
completion_nudge: Assess the feedback against the task and project intent; do not accept findings mechanically.
---
```

An unknown role or a role without completion guidance remains valid and receives the generic nudge.

### Role guidance is best effort

Role guidance should describe general judgment appropriate to the role. It must not imply a guaranteed workflow transition because the same role may be used for many purposes.

For example, `reviewer` can remind the parent to assess reviewer feedback in project context, but it cannot know whether the review concerns a ticket, a full epic, a design document, or a one-off investigation.

---

## 7. Task-type contract

### Task type is an optional closed enum

Task type opts a child into a known orchestration workflow. At the tool/API boundary it should be a literal union so models see the valid values and the runtime can select guidance without fuzzy matching.

Illustrative initial enum:

```ts
export type TaskType =
  | "implement"
  | "fix"
  | "reviewWorkerCompletion"
  | "reviewScope"
  | "investigateBlocker"
  | "validate";
```

The exact vocabulary should be challenged during planning, but the inclusion rule is firm:

> Add a task type only when lifecycle changes require a meaningfully constrained orchestration response.

Unstructured research, exploration, advice, and ordinary delegation can omit `taskType`.

### Task type selects workflow, not agent capability

Examples:

```ts
{
  role: "hard_problem_coder",
  taskType: "fix",
  description: "Fix the race in worker completion delivery"
}
```

The role shapes how the child approaches the code. The `fix` task type determines that completion should be assessed and sent through independent review or validation.

```ts
{
  role: "security_specialist",
  taskType: "reviewWorkerCompletion",
  description: "Review the completed authentication ticket"
}
```

The child uses a security-oriented prompt, but completion invokes the generic worker-review adjudication workflow.

```ts
{
  role: "reviewer",
  description: "Review the registry refactor"
}
```

With no task type, the parent receives the reviewer's general fallback guidance rather than the stronger `fix | file | reject` contract.

### Nudge precedence

Nudge selection is deterministic:

1. If `taskType` is present, use the matching task-type policy.
2. Otherwise, if the resolved role defines lifecycle guidance, use that guidance.
3. Otherwise, use generic orchestration guidance.

Do not concatenate role guidance onto task-type guidance. A task type is the authoritative workflow instruction; the role remains context displayed in the update.

Per-spawn context may be appended as evidence or constraints, but it must not silently override the task-type policy.

### Event-specific policies

Task-type guidance should be modeled by lifecycle event rather than a single completion string:

```ts
export interface TaskTypePolicy {
  started?: string;
  blocked?: string;
  handedOff?: string;
  completed: string;
  failed?: string;
}
```

Illustrative policy intent:

| Task type | Completion guidance |
| --- | --- |
| `implement` | Assess completion evidence and dispatch review according to the active policy. |
| `fix` | Verify the fix and send the changed behavior through independent re-review. |
| `reviewWorkerCompletion` | Resolve every finding as `fix`, `file`, or `reject`; keep unresolved fixes blocking acceptance. |
| `reviewScope` | Adjudicate cross-ticket findings and determine whether the goal satisfies its acceptance criteria. |
| `investigateBlocker` | Apply the answer to blocked work or record why escalation remains necessary. |
| `validate` | Address failures or record the validation gate as passed with evidence. |

Task-type policies select the next instruction. They do not close tickets, launch workers, accept findings, or perform other actions automatically.

### Future typed handoffs

A later version may associate task types with expected result schemas. For example, a worker review could return structured findings and validation could return command/result pairs. This is deferred until lifecycle nudges prove useful; V1 should not turn every child response into a rigid protocol.

---

## 8. Orchestrated spawning

### Preserve direct foreground delegation

Existing foreground `spawn` remains useful for a one-off task where the parent intentionally waits for the result. Its behavior should remain available.

### Add a non-blocking orchestrated mode

An orchestrated spawn starts one or more child sessions, registers them in an orchestration group, and immediately returns handles. The exact public spelling can be finalized during planning:

- an `orchestrate` tool; or
- an orchestration block/mode on `spawn`.

The recommended implementation is to extend the shared spawn machinery rather than create another runtime. Whether the public entry point is one tool or two, both foreground and orchestrated execution must call the same session manager and registry.

Illustrative descriptor:

```ts
interface OrchestratedTaskDescriptor {
  task: string;
  description: string;
  role?: string;
  taskType?: TaskType;
  model?: string;
  domain?: {
    source: string;
    scopeId?: string;
    workItemId?: string;
    title?: string;
  };
}
```

Requirements:

- `task` is the complete child prompt;
- `description` is a short fleet-readable summary and should not be inferred from a large prompt;
- `role` is dynamic and selects a named prompt/template when supplied;
- `taskType` is optional and selects deterministic lifecycle guidance;
- `domain` transports metadata without making minions understand beadwork;
- the parent receives a stable child ID and orchestration group ID immediately.

The first orchestrated spawn may implicitly establish the current orchestration group. A separate explicit “begin orchestration” action is optional; it must not create a second scheduler or graph.

### Process lifetime

Orchestrated children are background relative to the parent turn, not detached from the process.

- Parent shutdown aborts or abandons active child sessions.
- No child continuation is promised after process death.
- On a later session, persisted child transcripts may be inspected, but the runtime should not report stale children as live.
- Beadwork tickets remain durable and may still show interrupted work that a later parent must inspect or restart.

This deliberately avoids process heartbeats, recovery leases, replay logs, and durable completion delivery.

---

## 9. Parent orchestration updates

### Update contents

A meaningful lifecycle change produces one structured model-visible packet with three sections.

#### 1. What changed

- child ID and display name;
- role;
- task type, when present;
- short description;
- domain metadata;
- new status;
- result, handoff, blocker, or failure evidence.

#### 2. Current fleet

For every still-running child in the orchestration group:

- ID;
- role;
- task type;
- short description;
- state;
- optionally elapsed time and most recent activity summary.

#### 3. Next instruction

The deterministic task-type nudge, role fallback, or generic guidance selected by the precedence rules above.

Illustrative packet:

```text
Orchestration update

Changed:
- mn-12 completed
- role: security_specialist
- taskType: reviewWorkerCompletion
- task: Review BW-123 authentication changes
- result: 2 findings attached

Still running:
- mn-13 [hard_problem_coder / fix] Fix token refresh race
- mn-14 [general_coder / implement] Add session expiry tests

Required judgment:
Resolve every review finding as fix, file, or reject. Record evidence and rationale.
Do not accept BW-123 while a required fix remains unresolved.
```

### Delivery rules

- Persist the child result/session transcript before notifying the parent within the live process.
- Deliver at a safe model boundary; never inject into an active turn.
- A UI toast may accompany the update but cannot replace it.
- If several changes accumulate before delivery, coalesce them into one packet with one fresh fleet snapshot.
- Each lifecycle event should be consumed once within the parent process to avoid duplicate model turns.
- User input outranks autonomous continuation. Pending orchestration updates should wait for an appropriate boundary rather than interrupting the user.

### Handoffs and blockers

Children should be able to produce meaningful non-terminal signals in addition to final completion:

- progress;
- blocker/question;
- handoff;
- completion;
- failure.

A blocker or handoff may trigger a parent update while leaving the child available for steering. The task-type policy determines the contextual nudge when one exists.

---

## 10. Direct agent communication

### Generic minion hub

Minions should expose process-local communication modeled on the useful parts of OMP's agent hub/IRC and Agent Mail, without adopting their infrastructure.

Agents should be able to:

- list peers in their orchestration group;
- inspect peer ID, role, task type, description, and state;
- send an addressed message directly to a peer;
- send a message or question to the parent;
- declare advisory path intent with a TTL;
- inspect current advisory path intent.

### Delivery behavior

- A peer message is delivered directly to the addressed child's safe boundary, using the runtime's child session handle.
- The parent does not need to receive and retransmit the message.
- Sending a peer message does not force a parent model turn.
- The parent can inspect message metadata and communication history through minion status tools or UI.
- Message metadata should include sender, recipient, timestamp, and delivery state.
- Communication is process-local and best effort; no durable mailbox guarantee is required.

### Parent visibility

Parent-visible does not mean parent-mediated. The parent should be able to answer:

- who communicated;
- when communication occurred;
- whether delivery succeeded;
- what paths agents believe they are touching;
- whether an overlap notice is active.

The parent may inspect full message contents when debugging or coordinating, but routine peer messages should not consume parent turns.

---

## 11. Advisory workspace coordination

### Shared checkout is the standard case

Agents normally operate in the same cwd and branch. The runtime should make this state more legible, not impose an isolation model that conflicts with real usage.

### Path intent

An agent may announce:

```ts
interface PathIntent {
  agentId: string;
  paths: string[];
  note?: string;
  expiresAt: number;
}
```

Path intent is:

- advisory;
- automatically expired by TTL;
- visible to peers and parent;
- useful for warnings and communication;
- never proof of ownership.

### Overlap behavior

When declared or observed paths overlap:

1. notify the affected agents;
2. identify the other agent and its task description;
3. encourage direct communication;
4. surface the overlap to the parent as metadata;
5. continue execution.

The runtime must not:

- reject an edit or write;
- pause or cancel either child;
- reorder work automatically;
- create a worktree;
- claim that undeclared shell writes are safe;
- require path declarations before spawning.

### Explicit alternate workspaces

A user may deliberately start an orchestration group or child in a different cwd/worktree for isolation, reproduction, or exploration. That workspace must be explicitly provided by the user or calling domain adapter based on an explicit user choice. The scheduler cannot change it after launch or select it based on task heuristics.

---

## 12. Beadwork as a goal adapter

### Goal-mode behavior

`/bw run <epic>` should behave more like entering a domain-aware goal than launching a private worker fleet.

It should:

1. validate and store the selected epic scope;
2. load epic/ticket metadata and beadwork guidance;
3. add run-to-completion intent to the parent prompt;
4. expose ready, blocked, and in-progress tickets through beadwork tools;
5. instruct the parent to use minions for live delegation;
6. attach beadwork domain metadata to orchestrated children;
7. define ticket review, acceptance, and final goal-completion policy.

It should not:

- create tmux panes;
- maintain a worker registry;
- poll external processes;
- deliver separate child completion notifications;
- decide workspace isolation;
- own peer messaging;
- run a second generic orchestration reducer.

### Beadwork domain metadata

A ticket child may carry:

```ts
{
  source: "beadwork",
  scopeId: "EPIC-10",
  workItemId: "BW-123",
  title: "Fix authentication refresh race"
}
```

Minions transports and displays this metadata without understanding ticket semantics. Beadwork uses it to recover ticket context, build prompts, record evidence, and perform issue operations.

### Completion evidence

A child settling is evidence, not ticket acceptance. For beadwork work, the handoff should include at least:

- outcome summary;
- touched paths or commits when available;
- validation performed;
- blockers or incomplete work;
- recommended follow-ups.

`beadwork_worker_done` should not remain a shutdown/process-control tool. It can be removed or narrowed into a beadwork-specific evidence submission interaction; minions owns child settlement and the parent owns acceptance.

### Review policy

The beadwork goal adapter should support a small explicit policy:

```ts
type ReviewPolicy = "ticket" | "scope" | "none";
```

- `ticket` — default; independently review implementation work before closing its ticket.
- `scope` — accept/close individual work from evidence, then review the aggregate scope before declaring the epic complete.
- `none` — no automatic independent review.

`scope` is intentionally less conservative: dependents may begin before aggregate review discovers a problem. The configuration should state that tradeoff clearly rather than pretending the modes provide the same protection.

### Review adjudication

A `reviewWorkerCompletion` task type gives the parent deterministic guidance to assess every finding against ticket, epic, and project intent as:

- `fix` — valid and required now; keep acceptance blocked and dispatch remediation;
- `file` — valid but not required for current acceptance; create or link durable follow-up work;
- `reject` — invalid, irrelevant, duplicate, or contrary to intent; record rationale.

The task type locks in the adjudication instruction. The model still judges each finding and chooses the disposition.

### Notable autonomous decisions

Autonomous execution should be the default. Instead of interrupting for every high-concern decision, the orchestration group should collect notable decisions for the final handoff, including:

- decision and rationale;
- affected ticket or finding;
- concern level;
- evidence considered;
- action taken;
- scope expansion;
- rejected high-confidence review feedback;
- security-sensitive or destructive actions.

The final beadwork handoff should summarize these decisions for optional human review. Beadwork may also persist domain-significant decisions as ticket comments.

### Epic scope

V1 acceptance should prove one epic end to end. Internal scope metadata may use `scopeIds: string[]` so adding multiple epics later does not require changing minion orchestration semantics. Multi-epic scheduling is not required for the first release.

---

## 13. Recommended package and module changes

### `packages/pi-minions`

Likely changes:

- `src/types.ts`
  - add role, task type, orchestration group, domain metadata, messages, path intent, and lifecycle update types;
- `src/tools/spawn.ts`
  - add non-blocking orchestration descriptors and handles while preserving foreground spawn;
- `src/spawn/*`
  - separate session start from foreground result waiting;
- `src/subsessions/manager.ts`
  - use settled completion, expose safe steering/messaging, and avoid premature `agent_end` completion;
- `src/tree.ts`
  - become the canonical process-local fleet registry with role/task-type/description/group metadata;
- new `src/orchestration/`
  - group state, lifecycle normalization, fleet snapshots, nudge selection, coalescing, and parent delivery;
- new `src/task-types.ts`
  - closed enum/literal union and deterministic policies;
- `src/agents.ts` and `src/types.ts`
  - parse optional role fallback guidance from agent prompt metadata;
- new `src/messaging/`
  - peer directory, direct queues/delivery, parent message path, and inspection;
- new `src/coordination/`
  - advisory TTL path intent and overlap metadata;
- `src/index.ts`
  - register the new tools/events and update prompt guidance;
- `src/renderers/`, `src/status.ts`, and command surfaces
  - show orchestration groups, task types, fleet updates, and messages;
- tests
  - add lifecycle, delivery, precedence, messaging, coalescing, and child-lifetime coverage.

### `packages/pi-beadwork-extension`

Likely changes:

- `src/index.ts`
  - reduce worker runtime responsibilities and retain domain tools, scope, prompts, and goal mode;
- `src/prompt.ts`
  - express run-to-completion goal policy and minion usage;
- `src/types.ts`
  - remove tmux-backed worker runtime types; add goal/review/evidence/domain metadata types;
- `src/config.ts` and `src/constants.ts`
  - remove tmux, supervisor polling, automatic landing, and automatic worktree-selection configuration;
- `src/orchestrator.ts`
  - delete or decompose; generic live orchestration moves to minions;
- `src/tmux.ts` and process/runtime marker support
  - remove;
- `src/registry.ts`
  - remove live worker registry responsibilities; retain only domain state that remains necessary;
- `src/worktree.ts`
  - retain only explicit user-requested workspace behavior if still needed; no scheduler calls it;
- `src/handoff.ts`
  - focus on beadwork evidence and domain prompt context rather than process shutdown;
- actions and TUI
  - replace worker-runtime views with minion orchestration views or links, while keeping issue/goal views;
- tests and scripts
  - replace tmux/current-branch swarm e2e coverage with in-process minion/beadwork integration scenarios.

### Dependency direction

`pi-minions` must not import beadwork.

Beadwork may depend on a stable minions orchestration API or communicate through a typed in-process extension contract. The contract should allow beadwork to:

- add domain metadata to spawns;
- observe relevant child lifecycle events;
- provide beadwork prompt context;
- query group state when rendering status.

It must not create a second message-delivery path. Minions is the sole owner of model-visible child lifecycle updates.

---

## 14. API and tool surface sketch

The exact tool names remain subject to planning review, but the conceptual surfaces are:

### Existing tools to evolve

- `spawn`
  - retain foreground behavior;
  - accept role terminology or compatibility aliasing;
  - share all session-creation machinery with orchestration mode.
- `list_minions`
  - include role, task type, description, group, domain metadata, and communication indicators.
- `show_minion`
  - include lifecycle, task policy, messages, path intent, and current activity.
- `halt`
  - continue to abort one child or a group.

### New generic orchestration surfaces

Potential tools:

- `orchestrate` or `spawn` orchestration mode
  - non-blocking spawn and group creation;
- `send_minion_message`
  - addressed parent-to-child or child-to-child message;
- `list_minion_messages`
  - inspect communication history/metadata;
- `announce_minion_paths`
  - declare or refresh advisory TTL intent;
- `record_orchestration_decision`
  - append a notable decision for final handoff.

Tool count should remain small. Messaging and coordination operations may be grouped if that improves model usability, but their semantics must remain explicit.

### Beadwork surfaces

- `/bw run <epic>` or equivalent model tool enters beadwork goal mode;
- beadwork issue CRUD and dependency tools remain;
- generic minion spawning replaces `beadwork_delegate`;
- evidence submission, if retained, is beadwork-specific and does not control the child process;
- worker inspection/landing tools disappear or become domain views over minion state where still useful.

---

## 15. State and persistence

### Process-local state

Minions owns in-memory live state for:

- orchestration groups;
- active child handles;
- pending parent updates;
- message delivery queues;
- path intent TTLs;
- consumed lifecycle notifications;
- notable orchestration decisions.

Child session transcripts may continue to use Pi's existing file-backed session machinery for inspection, but V1 does not promise orchestration replay or child recovery.

### Durable domain state

Beadwork remains durable for:

- issue and epic state;
- dependencies and readiness;
- comments and history;
- accepted follow-up work;
- domain-significant evidence or decisions that are explicitly recorded.

### Parent death

If the parent exits unexpectedly:

- active children may terminate;
- in-memory messages and pending orchestration updates may be lost;
- no controller takeover occurs;
- the next session treats prior “running” runtime metadata as interrupted/stale, not live;
- durable beadwork tickets remain available for inspection and manual/model-driven restart.

This is an accepted tradeoff, not a degraded implementation of detached durability.

---

## 16. Integration and sequencing

No product release should improve or continue depending on the tmux runtime. The phases below describe implementation order on the cutover branch, not separately shippable beadwork milestones. The first release containing this work must include Phases A and B together and leave beadwork running through minions without tmux.

### Phase A — Minimum orchestration core in minions

- split child start from foreground waiting;
- introduce orchestration groups and descriptors;
- extend `AgentTree` metadata;
- normalize lifecycle around settled/aborted/failed;
- return stable handles immediately;
- add the closed task-type union and policy table;
- parse role fallback guidance;
- implement strict nudge precedence;
- deliver coalesced changed-child and fleet-state packets;
- preserve existing foreground spawn.

Exit criteria: generic orchestrated children run concurrently while the parent remains interactive; `fix` and `reviewWorkerCompletion` produce deterministic, distinct parent instructions regardless of role.

### Phase B — Beadwork cutover and tmux removal

- make `/bw run` establish a beadwork goal rather than a tmux supervisor;
- attach epic/ticket metadata to generic orchestrated children;
- move completion delivery entirely to minions;
- replace worker process completion with evidence submission;
- remove tmux launch, polling, pane inspection, runtime markers, and worker configuration;
- remove or rewrite tmux-dependent e2e tests.

Exit criteria: one beadwork ticket can be implemented and reviewed through minions on a machine without tmux, and no production beadwork path references the removed runtime.

### Phase C — Direct communication and advisory coordination

- peer discovery;
- addressed messages;
- safe child delivery;
- parent-visible metadata;
- TTL path intent;
- overlap notices without enforcement.

Exit criteria: two children can notice overlap, message one another directly, and continue without a parent relay or runtime lock.

### Phase D — One epic to verified completion

- drive ready tickets through the parent model and generic orchestration core;
- apply default ticket-level review;
- adjudicate findings as `fix | file | reject`;
- launch remediation/re-review through typed workflows;
- collect notable decisions;
- validate scope and produce a final handoff.

Exit criteria: one epic reaches a verified outcome with no competing beadwork worker runtime.

### Phase E — Optional policies

- scope-level review mode;
- explicit alternate workspace support where user-selected;
- multiple epic scopes if desired;
- typed handoff schemas if lifecycle evidence shows value.

---

## 17. Error handling and failure modes

### Child fails to start

- Mark the child failed in `AgentTree`.
- Include role, task type, description, and error in the parent update.
- Do not report a running handle as successful.

### Child terminates early

- Distinguish aborted, failed, and settled completion.
- Apply the task-type failure nudge when present.
- Preserve partial output for parent judgment.

### Parent is busy when several children finish

- Queue lifecycle changes process-locally.
- Coalesce them at the next safe boundary.
- Send one fresh fleet snapshot rather than stale per-child snapshots.

### Peer is unavailable

- Return a clear delivery failure to the sender.
- Record failed message metadata for inspection.
- Do not silently reroute through the parent.

### Path intent expires

- Remove it automatically.
- Do not infer that the agent stopped touching the path; TTL intent is advisory metadata only.

### Child and parent edit the same file

- The runtime may warn if it has enough information.
- It does not block either actor or claim a safe resolution.
- Agents/parent inspect current state and coordinate explicitly.

### Parent exits

- Children may stop.
- Pending messages and updates may be lost.
- Beadwork domain state survives.
- A later session reports stale prior runtime state as interrupted rather than attempting automatic recovery.

### Task type and role disagree

- Use task-type guidance.
- Display both values so the parent can recognize a poor role selection.
- Do not merge contradictory nudges.

### Review output is ambiguous

- The parent model requests clarification, dispatches another reviewer, or rejects unsupported claims.
- No keyword classifier silently decides the disposition.

---

## 18. Testing strategy

### `pi-minions` unit coverage

- task-type schema accepts only known values;
- role accepts arbitrary strings;
- task type takes precedence over role guidance;
- missing task type falls back to role guidance;
- missing role guidance falls back to generic guidance;
- task-type policy varies by lifecycle event;
- `AgentTree` preserves group, role, task type, description, and domain metadata;
- fleet snapshots include all and only relevant running children;
- multiple pending updates coalesce deterministically;
- consumed updates do not trigger duplicate parent turns;
- TTL path intent expires without blocking work;
- overlap detection creates notices but no enforcement action;
- direct messages preserve sender/recipient metadata;
- messages to missing peers fail clearly.

### Minion integration coverage

- foreground spawn continues to block and return its result;
- orchestrated spawn returns handles before completion;
- parent remains interactive while children run;
- settled completion is not emitted on a premature `agent_end`;
- abort and failure produce correct terminal states;
- several children completing near-simultaneously produce one parent packet;
- direct child-to-child messages arrive at a safe boundary;
- parent can inspect communication metadata without receiving a model turn for every peer message;
- parent shutdown does not promise child continuation;
- stale persisted session metadata is not shown as a live process after restart.

### Beadwork integration coverage

- `/bw run <epic>` sets goal context without starting tmux or a polling supervisor;
- generic minion descriptors carry ticket and epic metadata;
- child completion does not automatically close the ticket;
- default ticket policy launches review before close;
- `reviewWorkerCompletion` instructs `fix | file | reject` adjudication;
- `fix` remains blocking until remediation and review pass;
- `file` creates or links durable follow-up work;
- `reject` records rationale;
- scope policy allows explicit aggregate review behavior;
- notable decisions appear in the final handoff;
- one epic reaches validated completion;
- the complete flow works when tmux is unavailable;
- no worktree is created without explicit user selection.

### Removal regressions

- no production source imports beadwork's `tmux.ts`;
- no beadwork tool description promises tmux-backed workers;
- no runtime config requires tmux session/window/pane values;
- no scheduler selects `worktree` based on task content or overlap;
- no reservation or path-intent state rejects edit/write activity;
- beadwork emits no duplicate model-visible lifecycle message for a minion-owned child.

### Quality gates

Every implementation slice must pass:

```sh
npm run lint
npm run test
npm run typecheck
```

Logic changes require focused tests in the affected workspace in addition to the repository-wide gates.

---

## 19. Material risks and mitigations

### Task-type proliferation

**Risk:** The enum becomes a taxonomy of job names and duplicates roles.

**Mitigation:** Add a value only when it defines a distinct workflow response to lifecycle events. Keep ordinary work untyped.

### Prompt conflicts

**Risk:** Role and workflow guidance provide contradictory instructions.

**Mitigation:** Task type has strict precedence; do not concatenate role guidance when typed.

### Parent update noise

**Risk:** Several children create repeated model turns and context churn.

**Mitigation:** Coalesce pending changes and always send one current fleet snapshot.

### Over-automation

**Risk:** Deterministic task types are mistaken for deterministic decisions.

**Mitigation:** Policies produce instructions only. Tests must prove they do not close, spawn, or adjudicate automatically.

### Beadwork remains a hidden orchestrator

**Risk:** Old supervisor, registry, landing, and notification paths remain alongside minions.

**Mitigation:** Define one lifecycle owner, remove tmux runtime modules, and add duplicate-delivery regressions.

### Shared-checkout conflicts

**Risk:** Concurrent agents still overwrite or invalidate one another's assumptions.

**Mitigation:** Improve peer visibility, direct messaging, and TTL intent while explicitly accepting that coordination is best effort.

### Dynamic role quality

**Risk:** A project role supplies poor or missing fallback guidance.

**Mitigation:** Use task types for workflows that require reliable nudges and generic guidance otherwise.

### Extension integration coupling

**Risk:** Beadwork depends on private minions internals or creates circular imports.

**Mitigation:** Publish a small typed orchestration contract; minions never imports beadwork.

---

## 20. Decisions recorded and remaining questions

### Recorded decisions

1. Tmux removal is a fundamental requirement; no incremental tmux improvement or fallback is acceptable.
2. Worktrees are explicit user-selected options only.
3. Shared-branch coordination is best effort and communication-driven.
4. Parent death may terminate children; detached durability is unnecessary.
5. Review adjudication begins autonomous, with consequential decisions collected for final review.
6. Ticket-level review before close is the default; scope-level review remains an explicit option.
7. One epic end to end is sufficient for the first release.
8. Direct agent messaging should not require parent routing.
9. Beadwork becomes a goal/domain adapter; minions owns generic orchestration.
10. Role is dynamic, task type is an optional enum, and task type takes precedence.

### Questions for planning review

These do not block this proposal, but planning should settle them before implementation:

1. Should the public non-blocking entry point be a distinct `orchestrate` tool or a mode on `spawn`?
2. Should `agent` be renamed to `role`, retained as a compatibility alias, or remain the public selector while runtime records call it `role`?
3. Is the initial task-type vocabulary appropriately small, particularly the boundary between `implement`, `fix`, `validate`, and untyped work?
4. Should role fallback nudges live in agent frontmatter, a separate role registry, or both with a clear precedence rule?
5. What minimum message history should remain parent-inspectable within a session without turning minions into a durable mail system?

---

## 21. Handoff to planning workflow

The next planning pass should focus on implementation shape rather than reopening settled product constraints.

Reviewers should scrutinize:

1. how to separate non-blocking child start from the current foreground `Promise.allSettled()` flow without duplicating session code;
2. how Pi's settled and safe-boundary APIs should be wired and tested;
3. whether one tool or two gives the clearest foreground/orchestrated spawn contract;
4. how beadwork registers domain context without importing minions internals or creating duplicate parent messages;
5. which beadwork runtime modules can be deleted outright at cutover;
6. how direct child messaging is exposed inside child sessions without enabling recursive orchestration;
7. whether the proposed task-type names represent workflow transitions rather than roles;
8. how to coalesce updates while preserving every result and blocker;
9. how the explicit alternate-cwd/worktree option is represented without allowing runtime selection;
10. how ticket-level and scope-level review policies map to existing beadwork status transitions.

The implementation plan should preserve this invariant throughout:

> **Role selects behavior; task type selects workflow; beadwork supplies domain context; minions owns orchestration mechanics.**

---

## Appendix A: Evidence pointers

### `pi-minions`

- `packages/pi-minions/src/tools/spawn.ts`
  - current tool schema and foreground `Promise.allSettled()` behavior;
- `packages/pi-minions/src/subsessions/manager.ts`
  - child `AgentSession` creation, lifecycle subscription, steer/abort handles, and current `agent_end` completion;
- `packages/pi-minions/src/tree.ts`
  - existing process-local fleet registry;
- `packages/pi-minions/src/agents.ts`
  - dynamic project/user agent discovery and frontmatter parsing;
- `packages/pi-minions/src/types.ts`
  - current agent config, status, result, and tree-node types;
- `packages/pi-minions/src/index.ts`
  - tool registration, session startup, event bus, and parent status surfaces.

### `pi-beadwork-extension`

- `packages/pi-beadwork-extension/src/orchestrator.ts`
  - current tmux/process/worker orchestration center;
- `packages/pi-beadwork-extension/src/tmux.ts`
  - tmux-specific launch and inspection;
- `packages/pi-beadwork-extension/src/types.ts`
  - tmux-backed worker runtime and duplicate lifecycle model;
- `packages/pi-beadwork-extension/src/config.ts`
  - tmux, worktree, landing, and supervisor configuration;
- `packages/pi-beadwork-extension/src/index.ts`
  - combined goal, tool, worker, supervisor, and notification behavior;
- `packages/pi-beadwork-extension/src/prompt.ts`
  - current beadwork orchestration prompt surface;
- `packages/pi-beadwork-extension/src/bw.ts`
  - durable beadwork domain adapter and issue operations.

### Repository quality requirements

- `AGENTS.md`
  - atomic commits and required lint/test/typecheck gates;
- package tests under:
  - `packages/pi-minions/src/__tests__/`;
  - `packages/pi-beadwork-extension/src/__tests__/`.
