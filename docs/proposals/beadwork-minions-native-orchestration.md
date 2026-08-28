# Native In-Process Agent Orchestration for Pi Minions and Beadwork

**Status:** Revised proposal after architecture and API audit  
**Audience:** maintainers of `@solvedbydev/pi-minions` and `@solvedbydev/pi-beadwork-extension`  
**Decision type:** replacement architecture, not a compatibility-preserving internal refactor

---

## 1. Executive recommendation

Replace Beadwork's tmux-backed worker subsystem with a native, in-process orchestration runtime owned by `pi-minions`.

Keep the existing `spawn` tool for foreground fan-out. Add a distinct `orchestrate` tool for autonomous background work because its return and lifecycle semantics are materially different from foreground `spawn`:

- `spawn` waits and returns child results to the current tool call;
- `orchestrate` registers work, returns stable handles immediately, and reports later events through bounded parent update packets.

Beadwork should stop spawning, polling, landing, and owning worker processes. It should become a domain adapter around the parent Pi agent:

- Beadwork defines goals, ticket state, validation policy, review policy, and acceptance rules.
- The parent model chooses the next action and invokes tools.
- Minions owns child sessions, task state, communication, resource limits, and parent notifications.
- Child evidence never closes a ticket by itself.
- Beadwork remains authoritative for ticket acceptance and epic completion.

The target experience is:

1. The user enters or resumes an epic goal.
2. `/bw run EPIC-10 --workers 4` records a goal intent and wakes the parent model.
3. The parent model refreshes `bw ready`, chooses a ticket, marks it in progress, and calls `orchestrate` with an implementation task.
4. The child works in the selected existing checkout, reports structured evidence, and settles.
5. Minions emits a bounded completion packet whose code-owned task policy tells the parent what kind of action comes next.
6. The parent refreshes Beadwork state, applies validation and review policy, dispatches fixes or follow-up tickets, and accepts work only when the acceptance gate passes.
7. The loop ends only when the parent judges the epic complete from a fresh Beadwork snapshot.

This is intentionally session-scoped and process-local. It does not attempt durable execution across process death, distributed locking, daemon infrastructure, exactly-once delivery, or automatic worktree management.

---

## 2. Settled product decisions

These decisions are constraints for implementation.

### 2.1 Runtime and process model

- Orchestrated children run in-process through Pi `AgentSessionRuntime` objects.
- `orchestrate` is supported only in persistent Pi `tui` and `rpc` modes; `print` and `json` reject it synchronously.
- tmux is removed from the Beadwork execution path.
- There is no alternate worker backend and no tmux fallback mode.
- Live child sessions do not survive parent process death.
- Runtime ownership is scoped to one parent session generation, not only one OS process.
- Cancellation is cooperative. A fenced, unresponsive child may require parent process exit for a hard stop.

### 2.2 Workspace model

- Shared current-branch execution is the default.
- A group has exactly one immutable canonical `cwd`; task-level workspace overrides are not allowed in V1.
- Minions never automatically creates, switches, lands, rebases, cleans, or removes worktrees.
- Worktrees remain supported only as an explicit group workspace: the user supplies an already-existing `cwd`, and that checkout/branch is the goal target.
- Minions does not own integration from one checkout into another.
- Path coordination is advisory. It warns and suggests communication; it does not lock files, pause agents, or reject edits.

### 2.3 Orchestration authority

- The parent Pi agent is the sole goal driver.
- No hidden polling loop decides what ticket to launch next.
- Minions task policy determines the shape of the next parent instruction.
- Beadwork supplies domain facts and enforces domain acceptance; it does not run a second autonomous scheduler.
- The human is updated at meaningful state transitions, not on every internal event.
- One active Minions group is allowed per Beadwork goal and parent session generation.

### 2.4 Roles, task types, and review

- `role` selects a child agent profile: prompt/template, model defaults, tool requests, limits, and optional advisory completion guidance.
- `taskType` is a small, closed workflow enum owned by Minions runtime code.
- `taskType` outranks role completion guidance when choosing the next parent nudge.
- Review before ticket acceptance is the default Beadwork policy.
- Review is configurable as `ticket`, `scope`, or `none`.
- Every blocking review finding receives an explicit disposition: `fix` or `reject`; `file` is allowed only after the finding is classified nonblocking or the user grants an explicit risk waiver.

### 2.5 Communication and autonomy

- Parent/child and child/child messages use the in-process session runtime.
- Child/child sends are nonblocking queue submissions; a sender never waits for the recipient's LLM turn.
- High-level decisions and review dispositions are collected for retrospective review.
- No new synchronous approval gate is added for normal work.
- Existing Pi trust, permission, and tool safety boundaries remain in force; retrospective decision logging is not authorization.
- Attention/limit latches and acceptance overrides are exceptional user-only controls. The autonomous parent may request them but may not mint them.

### 2.6 Initial scope

- The first supported goal shape is one Beadwork epic with its descendants.
- The protocol represents scope as `scopeIds: string[]`, but V1 validates that the list contains exactly one epic.
- Multi-epic goals are a later policy extension, not a separate runtime architecture.

---

## 3. Current repository facts that drive the design

### 3.1 `pi-minions` is already the correct runtime base

The package already creates real Pi child sessions, stores JSONL transcripts, forwards steering, propagates aborts, tracks usage, mirrors tool activity, loads agent profiles, resolves model overrides, and enforces parent depth.

Relevant files:

- `packages/pi-minions/src/subsessions/manager.ts`
- `packages/pi-minions/src/subsessions/event-bus.ts`
- `packages/pi-minions/src/subsessions/observability.ts`
- `packages/pi-minions/src/subsessions/types.ts`
- `packages/pi-minions/src/spawn.ts`
- `packages/pi-minions/src/spawn/runner.ts`
- `packages/pi-minions/src/index.ts`

The current blocker is semantic, not architectural: foreground spawn awaits all child promises before returning.

### 3.2 Current Minions completion is only a run boundary

Current child execution calls `await session.prompt(task)` and then treats the final assistant output as completion. Pi's `agent_settled` event means that the agent is idle after retries, compaction, steering, and follow-ups. It does **not** prove domain success.

Therefore the new design must distinguish:

- session activity: active, idle, disposed;
- task state: running, waiting, succeeded, partial, blocked, failed, aborted;
- domain acceptance: pending, review/remediation, accepted.

It must not equate `agent_settled` with “ticket complete.”

### 3.3 The Pi runtime already provides the required child shutdown owner

`AgentSession.dispose()` alone aborts activity and invalidates resources without emitting child `session_shutdown`. Current Minions also binds child extensions with a no-op shutdown handler.

Pi's public `AgentSessionRuntime.dispose()` does emit `session_shutdown` before disposing its `AgentSession`. Orchestrated children must therefore be created and retained as `AgentSessionRuntime` instances, not bare sessions.

Shutdown uses a bounded sequence:

1. fence the child and close ingress;
2. request cooperative abort and terminate Minions-managed subprocess groups;
3. await `runtime.dispose()` within a grace deadline;
4. if an extension shutdown handler hangs, call `runtime.session.dispose()` as forced local cleanup and record `unresponsive` attention.

The resolved-extension allowlist remains a capability defense, not a substitute for lifecycle shutdown.

### 3.4 Beadwork currently owns too much worker machinery

The Beadwork package currently includes:

- tmux launch and pane inspection;
- worker runtime JSON files and logs;
- current-branch and worktree execution modes;
- worktree creation, reuse, cleanup, rebase, and merge-back;
- polling and supervision loops;
- worker attribution reconstruction;
- reviewer and remediation launch paths;
- landing validation;
- worker dashboard actions.

The concentration is visible in `packages/pi-beadwork-extension/src/orchestrator.ts`, which is over 6,000 lines.

This proposal replaces that subsystem. It does not wrap it with another abstraction.

### 3.5 Existing Beadwork semantics worth preserving

The replacement should preserve the valuable domain behavior already encoded in the package:

- `bw prime` guidance cache;
- scoped `bw ready` discovery;
- ticket start before work begins;
- handoff evidence with commits and validation;
- review and remediation before acceptance;
- `fix` / `file` / `reject` triage;
- final scope review;
- lint/test/typecheck validation defaults;
- user-visible issue, goal, and attention views.

### 3.6 Existing attribution is useful but too ambient

Current current-branch attribution already records launch HEAD, checks ancestry, scans ticket-referencing commits, reads Beadwork history, gathers touched paths, and warns on branch drift.

The replacement should reuse that logic but bind each review to an immutable evidence subject. Ambient `HEAD` or “everything since launch” is not a stable review target when several agents share a branch.

---

## 4. Architectural boundaries

### 4.1 Minions owns runtime truth

Minions is authoritative for:

- group IDs and child IDs;
- parent session generation ownership;
- child `AgentSessionRuntime` owners and `AgentSession` handles;
- active/idle/disposed session state;
- task state transitions;
- parent update event sequencing;
- peer mailboxes and direct message delivery;
- abort, timeout, and shutdown behavior;
- role resolution and tool ceilings;
- task-type result validation and next-action nudges;
- resource ceilings;
- process-local orchestration decision summaries.

There is exactly one live registry for these facts per parent extension instance.

### 4.2 Beadwork owns domain truth

Beadwork is authoritative for:

- issue and dependency state;
- goal intent and goal policy;
- ticket assignment records;
- evidence and validation records;
- review findings and dispositions;
- ticket acceptance;
- follow-up issue creation;
- epic closure;
- Beadwork-specific decision history.

These authoritative records are append-only, versioned machine records in Beadwork issue/epic history. Per-session JSON is only a rebuildable cache.

Child completion evidence is an input to Beadwork acceptance, not the acceptance decision.

### 4.3 The parent model owns orchestration decisions

The parent model decides:

- which ready ticket to start;
- whether two tickets should run concurrently;
- which role and task type to use;
- whether a blocker needs a message, investigation, or user attention;
- how to disposition review findings;
- whether more work is required;
- when the epic goal is complete.

Runtime and domain code provide facts, constraints, and deterministic next-action guidance. They do not silently replace this reasoning loop.

### 4.4 The human owns final interruption and override

The user can:

- halt one child or an entire group;
- change goal concurrency for future dispatch;
- resume an attention-latched group;
- grant a one-shot validation or acceptance override with an explicit reason;
- inspect and correct collected decisions;
- resume or abandon an interrupted goal in a new session.

Normal review dispositions remain autonomous. Exceptional gate bypasses and attention resumes are user-only commands/capabilities; the parent model may request one but cannot create or invoke it.

“User interruption wins” means the runtime immediately fences callbacks and rejects new work. Cancellation of in-process extension code is cooperative; an unresponsive child may require parent process exit for a hard stop.

---

## 5. Runtime object model

### 5.1 Parent session generation

Each extension activation creates an opaque `sessionGeneration` token.

Every group, child, callback, mailbox, event, and queued parent packet captures that token. A callback must verify both the token and open-state latch before it may mutate state or deliver work.

On parent `session_shutdown` for quit, reload, new, resume, or fork:

1. mark the generation closing and fence all callbacks;
2. reject new orchestration work and close mailbox ingress;
3. close the Minions event publisher; each consumer unregisters its own listeners in its shutdown handler;
4. request cooperative child abort and terminate Minions-managed subprocess groups;
5. perform bounded `AgentSessionRuntime.dispose()` for every child;
6. force bare-session disposal for hung shutdown handlers and record diagnostics;
7. drop queued parent deliveries and clear the registry.

Beadwork's own shutdown handler durably marks an active goal interrupted before its cache is discarded. No child from an old session generation may inject a message or event into a replacement session.

### 5.2 Group identity and lifecycle

A group is explicit, never inferred from “the current group.”

```ts
interface WorkspaceIdentity {
  cwd: string;               // canonical realpath
  gitCommonDir: string;
  branch: string;
  baselineRevision: string;
}

interface OrchestrationGroup {
  groupId: string;
  parentSessionId: string;
  sessionGeneration: string;
  workspace: WorkspaceIdentity;
  state: "open" | "attention" | "closing" | "closed";
  domain?: DomainContext;
  limits: GroupLimits;
  nextEventSeq: number;
  createdAt: string;
  closedAt?: string;
}
```

The first `orchestrate` call may omit `groupId`; Minions creates one and returns it. Later calls that add work name the group explicitly.

A group becomes **quiescent** when it has no starting, running, waiting, or aborting child. Quiescence emits an event but does not close the group: dependency-ordered work, review, validation, and remediation all reuse it. Normal closure requires `close_minion_group`, successful goal completion, explicit halt, or parent session shutdown.

Normal close is an atomic reducer operation and rejects unless the group is quiescent and every child runtime is terminal/disposed. Halt enters `closing`, closes dispatch/mail ingress, fences detached startup callbacks, aborts/disposes live children, and waits for every child to become terminal/disposed. `group-closed` emits exactly once only after that drain. Dispatch, mailbox enqueue, and startup commit all reject while `closing`.

A parent may own several generic groups within session-wide ceilings. V1 permits only one open group per `(sessionGeneration, adapter, goalId)` and rejects a live `workItemId` anywhere in that session registry, not only within one group.

`attention` is a dispatch latch. New work is rejected until an explicit user `/minions resume <group>` action creates a one-shot resume token. A model-generated tool call cannot clear the latch.

### 5.3 Child identity and state

```ts
type ChildSessionState = "initializing" | "active" | "idle" | "disposed";

type ChildTaskState =
  | "starting"
  | "running"
  | "waiting"
  | "aborting"
  | "succeeded"
  | "partial"
  | "blocked"
  | "failed"
  | "aborted"
  | "unresponsive";

interface OrchestratedChild {
  childId: string;
  groupId: string;
  attemptId: string;       // generated by Minions
  workItemId?: string;
  assignmentId?: string;   // generated by a domain adapter
  role?: string;
  taskType?: TaskType;
  sessionPath?: string;
  sessionState: ChildSessionState;
  taskState: ChildTaskState;
  baselineRevision?: string;
  startedAt?: string;
  settledAt?: string;
  result?: RuntimeTaskResult;
  waitingFor?: WaitingDescriptor;
}
```

`attemptId` is immutable and is the runtime attribution key for one assignment. Retrying a work item creates a new attempt.

### 5.4 State transition and single-winner rules

```text
starting -> running | aborting | failed
running  -> waiting | aborting | succeeded | partial | blocked | failed
waiting  -> running | aborting | blocked
aborting -> aborted | unresponsive
```

Only one run may execute against a child session at a time. Restarting a waiting child is protected by a single-flight guard.

Each run has a `runEpoch` and one atomic protocol-disposition latch: `none | report | wait`. The first valid `minion_report_result` or `minion_wait` call wins; duplicate or conflicting calls return a structured conflict. User/group abort received before terminal commit overrides a pending report/wait, closes ingress, and enters `aborting`. Exactly one terminal event may be committed.

A timeout races through the same state reducer. If cooperative abort does not settle before the grace deadline, Minions fences the child, force-disposes local session resources, records `unresponsive`, and latches group attention. It cannot guarantee termination of arbitrary CPU-bound code or unmanaged subprocesses.

### 5.5 Settlement and turn-boundary authority

Pi settlement is an idle boundary. The task protocol determines whether the task is terminal.

Orchestrated children receive runtime-owned tools:

- `minion_report_result`
- `minion_wait`
- `minion_send_message`
- `minion_list_peers`

The orchestrated runner installs/composes Pi Agent's supported `shouldStopAfterTurn` hook. When a report, wait, or runtime mail boundary is set, the hook stops after the current assistant turn and tool batch complete but before Pi polls steering/follow-up queues or starts another model call. Protocol tools return `terminate: true` as an additional hint, but correctness does not rely on every tool in a parallel batch doing so.

`minion_report_result` closes mailbox ingress immediately and records a pending terminal result. The terminal transition occurs only after `session.prompt()` settles.

`minion_wait` closes the current run at the same safe turn boundary but remains nonterminal. After settlement, Minions retains the idle runtime. A valid peer or parent message restarts it through the single-flight guard.

If `session.prompt()` settles without a protocol disposition or runtime mail boundary:

- an untyped generic task may succeed with an unstructured final-text result;
- a typed task becomes `partial` with runtime protocol error `missing-structured-result`;
- a rejected prompt or unrecovered final provider error becomes `failed`;
- intermediate tool errors remain task evidence and do not force failure if the child later reports valid success;
- explicit abort follows the aborting path.

### 5.6 Terminal session cleanup

After terminal commit:

- the mailbox closes and queued peer messages receive terminal/undelivered outcomes;
- new messages and result reports are rejected;
- Minions emits exactly one terminal event;
- the child `AgentSessionRuntime` is shut down and disposed through the bounded sequence;
- transcript and summary metadata remain inspectable;
- remediation uses a new child and a new `attemptId`.

Waiting sessions remain live only until their waiting timeout, group halt, or parent shutdown.

---

## 6. Public Minions API

### 6.1 Keep foreground `spawn`

The existing `spawn` tool remains the concise API for foreground fan-out. It keeps the existing `agent` selector for compatibility.

The foreground path may reuse the new child runner internally, but it continues to await all child results and return them to the tool call.

### 6.2 Add a distinct `orchestrate` tool

A separate tool avoids an ambiguous return type and makes autonomous behavior explicit.

```ts
interface OrchestrateInput {
  operationId: string;
  sourceEventIds?: string[]; // required for autonomous parent packets
  groupId?: string;
  cwd?: string;                 // group creation only; defaults to parent cwd
  tasks: OrchestratedTaskInput[];
  domain?: DomainContext;       // immutable group context
  limits?: Partial<GroupLimits>; // group creation only; may only narrow session policy
}

interface OrchestratedTaskInput {
  task: string;
  role?: string;
  taskType?: TaskType;
  model?: string;
  workItemId?: string;
  assignmentId?: string;
  assignmentPermit?: string; // required and single-use for every task in a domain group
  pathIntents?: string[];
}

type OrchestrationRejectCode =
  | "invalid-input"
  | "unsupported-mode"
  | "capacity"
  | "attention-latched"
  | "duplicate-work-item"
  | "group-closed"
  | "workspace-mismatch"
  | "domain-conflict"
  | "invalid-assignment-permit"
  | "operation-conflict";

interface OrchestrateResult {
  groupId: string;
  accepted: Array<{
    childId: string;
    attemptId: string;
    assignmentId?: string;
    workItemId?: string;
    state: "starting";
  }>;
  rejected: Array<{
    index: number;
    code: OrchestrationRejectCode;
    detail: string;
  }>;
}
```

The tool returns after registration, not after session startup or task completion. `operationId` is a runtime/domain-issued semantic effect key, not an arbitrary model nonce. The same key and normalized payload returns the prior result; reuse with a different payload returns `operation-conflict`. Autonomous packets identify retained, eligible source events from which the runtime derives the key. Every task added to a group with `domain` context requires a matching unexpired one-use assignment/activity permit; omitting assignment fields does not make it generic. Generic work uses a separate generic group. Minions consumes the permit when it reserves the child and never copies it into the child prompt/transcript.

`orchestrate` rejects synchronously in Pi `print` and `json` modes because those hosts dispose the parent runtime after the prompt. V1 supports persistent `tui` and `rpc` hosts only.

### 6.3 Batch startup is explicitly nontransactional

A batch may partially start.

Minions must:

1. validate all descriptors it can validate synchronously;
2. reserve capacity and create child records in `starting` state;
3. return handles;
4. start sessions in detached promises with complete rejection handling;
5. emit `started` or terminal `failed` events per child.

It must not promise all-or-nothing batch startup.

The tool call's `AbortSignal` controls only the registration call. Child lifetime is owned by the group's independent controller.

### 6.4 Stable status and control surfaces

Parent-model tools:

- `list_minions`
- `show_minion`
- `message_minion`
- `close_minion_group` (`completionToken` required for a domain-owned goal group)

User/operator commands:

- halt one minion;
- halt a group;
- resume an attention-latched group;
- change a goal's scheduling concurrency within runtime capacity.

Halt and attention-resume are intentionally not ordinary child or autonomous-parent capabilities. Effectful parent tools require a runtime/domain-issued semantic `operationId`; `message_minion` also requires explicit group, child, body, and optional correlation ID.

For a Beadwork-owned group, `beadwork_complete_goal` returns a one-shot closure token after the domain gate passes; Minions validates that token before normal close. Generic groups retain direct user halt. A direct Minions halt on a Beadwork-owned group redirects to Beadwork `interrupt` so runtime fencing and durable goal state cannot diverge.

`show_minion` is the canonical way to retrieve full output, result payloads, mailbox outcomes, and event history omitted from bounded parent packets.

### 6.5 Provider-compatible task type schema

`taskType` must be a real closed enum in the tool schema, using the provider-compatible string-enum helper used by Pi rather than a loose string plus runtime check.

Initial values:

```ts
type TaskType =
  | "implementation"
  | "fix"
  | "reviewImplementation"
  | "reviewScope"
  | "investigateBlocker"
  | "validation";
```

Adding values is a protocol change and requires tests for result validation and parent nudges.

### 6.6 Resource ceilings

Minions owns generic runtime ceilings; Beadwork owns workflow retry and review limits.

```ts
interface SessionOrchestrationLimits {
  maxOpenGroups: number;
  maxActiveChildren: number;
  maxChildrenTotal: number;
  maxAutonomousWallTimeMs: number;
  maxAutonomousModelTurns: number;
  maxAutonomousTokens?: number;
  maxAutonomousCost?: number;
  maxEffectRecords: number;
}

interface GroupLimits {
  maxActiveChildren: number;
  maxChildrenTotal: number;
  maxAutonomousWallTimePerEpochMs: number;
  maxWaitingMs: number;
  maxWaitingTotalMs: number;
  maxChildRuntimeMs: number;
  maxParentNudgesWithoutUserTurn: number;
  maxMessageBytes: number;
  maxMailboxDepth: number;
  maxMessagesPerMinute: number;
  maxParentPacketBytes: number;
  maxEffectRecords: number;
}
```

Session ceilings prevent a model from bypassing limits by creating more groups. `limits` is accepted only while creating a group, is then immutable, and may only narrow session policy.

A parent nudge counts when Minions submits a model-visible autonomous packet. Cost/token/child counters include every orchestrated child run and autonomously triggered parent turn when telemetry is available; hard wall-time/turn limits remain mandatory when it is not.

Limits are classified:

- **absolute monotonic session counters** (`maxChildrenTotal`, cumulative autonomous wall time/model turns/tokens/cost, and effect records) never reset when a group closes or attention resumes; a user may raise a cap only below the immutable host safety cap, or create a genuinely new session;
- **absolute attempt counters** (`maxChildRuntimeMs` and `maxWaitingTotalMs`) accumulate across every mail/wait restart epoch of one attempt and never reset on group resume;
- **renewable authorization-epoch limits** (`maxParentNudgesWithoutUserTurn` and `maxAutonomousWallTimePerEpochMs`) are counted session-wide across all groups, with group values acting only as narrower sublimits; only a real user turn/command starts a new bounded epoch;
- concurrency, per-wait timeout, message, and packet bounds are instantaneous and never bypassable by resume.

Hitting a hard ceiling fences dispatch and latches runtime attention. Closing/replacing a group does not renew allowance. Resume cannot clear an absolute counter. Effect-record exhaustion also latches attention; live-group idempotency records are not evicted to make room.

Both session and group `maxChildrenTotal`/`maxEffectRecords` counters are monotonic for their respective lifetimes; creating another group does not reset the session counters.

Children cannot recursively call `orchestrate` in V1.

---

## 7. Roles, task policies, and result contracts

### 7.1 Role semantics

A role is an agent profile selected from existing project or global agent definitions.

It may request:

- a system-prompt fragment;
- a default model;
- tools;
- step and timeout limits;
- optional `completion_nudge` metadata.

Role metadata may narrow runtime capability. It may never grant a tool, model, path, or limit denied by parent policy.

`orchestrate.role` is new terminology. Existing foreground `spawn.agent` remains for compatibility; the two values resolve through the same profile loader internally.

### 7.2 Task type is a workflow contract, not a free-form label

`taskType` controls three code-owned properties:

1. the required result contract;
2. the default next parent instruction;
3. which lifecycle transitions or follow-up classes are valid.

This makes the next instruction deterministic without moving Beadwork policy into Minions.

### 7.3 Nudge precedence

```text
1. taskType policy from Minions code
2. advisory completion_nudge from the resolved trusted role profile
3. generic Minions fallback
```

Task text and child output never supply the parent nudge.

Examples:

```text
implementation:
  “Assess the evidence, run the active domain validation/review policy, then either
   accept the work, dispatch a fix, or request attention.”

fix:
  “Re-review and revalidate the affected evidence before acceptance.”

reviewImplementation:
  “Disposition every finding as fix, file, or reject. Blocking findings require fix or
   reject unless the user waives risk; persist nonblocking follow-up work.”

reviewScope:
  “Disposition every scope finding, create follow-up work where required, and
   refresh the goal state before judging completion.”

investigateBlocker:
  “Use the investigation evidence to unblock, re-plan, or escalate; do not treat
   investigation completion as implementation completion.”

validation:
  “Record the validation result against its exact revision. On failure, dispatch
   remediation or request attention.”
```

These names describe generic workflow stages, not Beadwork mutations. Minions validates result shape and emits the nudge; trusted Beadwork context defines how `fix`, `file`, `reject`, acceptance, and follow-up issue creation are applied.

If neither task type nor role guidance applies:

```text
“A background task settled. Inspect its result and decide the next action.”
```

### 7.4 Submitted and runtime result envelopes

Typed handoffs are required in V1 for typed tasks. Child-submitted claims and runtime-owned protocol metadata are separate.

```ts
type SubmittedTaskOutcome = "succeeded" | "partial" | "blocked";

interface SubmittedTaskResult {
  schemaVersion: 1;
  outcome: SubmittedTaskOutcome;
  summary: string;
  artifacts?: Array<{
    kind: "commit" | "path" | "command" | "url" | "note";
    ref: string;
    detail?: string;
  }>;
  noArtifactReason?: string;
  validationClaims?: Array<{
    command: string;
    outcome: "passed" | "failed" | "not-run";
    detail?: string;
  }>;
  findings?: Array<{
    localId: string;
    claim: string;
    severity: "blocking" | "nonblocking";
    evidence: Array<{
      path?: string;
      line?: number;
      detail: string;
    }>;
    recommendation?: string;
  }>;
  conclusion?: string;
  blockers?: string[];
  followUps?: string[];
  domainPayload?: unknown;
}

interface RuntimeTaskResult {
  submitted?: SubmittedTaskResult;
  protocolStatus: "valid" | "unstructured" | "invalid";
  protocolErrorCode?:
    | "missing-structured-result"
    | "schema-invalid"
    | "task-contract-invalid"
    | "duplicate-disposition";
  finalTextRef?: string;
}
```

Minions validates the common envelope and task-type-specific requirements:

- implementation/fix require evidence or `noArtifactReason`;
- review tasks require a `findings` array, including an empty array for approval;
- validation requires at least one validation claim;
- blocker investigation requires `conclusion` or an explicit blocker.

Validation claims are child evidence only. Beadwork acceptance requires a domain-owned validation record captured by the configured command runner.

Domain adapters validate `domainPayload` separately. Child-provided IDs and domain data are untrusted input.

### 7.5 Result acceptance is not runtime completion

A `succeeded` Minions task means the child produced a protocol-valid result. It does not mean:

- a commit belongs to the ticket;
- validation is current;
- review findings are correct;
- a Beadwork ticket can close;
- a goal is complete.

Those are parent/domain decisions.

---

## 8. Runtime event protocol

### 8.1 Event envelope

```ts
interface OrchestrationEvent<TKind extends OrchestrationEventKind> {
  schemaVersion: 1;
  sessionGeneration: string;
  eventId: string;
  sequence: number;
  timestamp: string;
  groupId: string;
  childId?: string;
  attemptId?: string;
  assignmentId?: string;
  workItemId?: string;
  goalId?: string;
  kind: TKind;
  payload: EventPayloadByKind[TKind];
}

type OrchestrationEventKind =
  | "group-created"
  | "child-started"
  | "progress"
  | "mail-outcome"
  | "waiting"
  | "quiescent"
  | "succeeded"
  | "partial"
  | "blocked"
  | "failed"
  | "aborted"
  | "unresponsive"
  | "attention"
  | "group-closed";
```

Each event kind has a closed, runtime-validated payload schema. Sequence is monotonic per group. Event IDs are unique within the session generation. Every event is self-identifying by generation and domain goal so consumers do not depend on a single binding event.

### 8.2 Event retention and coalescing

The runtime retains a bounded process-local event window per group.

Coalescing rules:

- progress is latest-wins per child;
- repeated path-overlap notices use a cooldown;
- terminal events are never discarded before parent submission;
- waiting and attention events are never replaced by progress;
- oversized output is stored by reference and retrieved with `show_minion`.

When memory bounds are reached, Minions drops old progress first and emits one attention summary. It does not silently drop terminal state.

### 8.3 Parent delivery uses one race-safe Pi message form

The background runtime never captures `onUpdate` or a tool-call context after `orchestrate` returns.

For every meaningful packet, after generation/open-state checks, it calls:

```ts
pi.sendMessage(
  {
    customType: "minions-orchestration",
    content: packetContent,
    display: true,
    details: packetDetails,
  },
  {
    triggerTurn: true,
    deliverAs: "followUp",
  },
);
```

Using one form avoids an idle/streaming time-of-check race: Pi triggers immediately when idle and queues a follow-up when streaming. Progress-only events update TUI state and normally do not submit a model packet.

### 8.4 Delivery guarantee is intentionally weak and accurate

Pi `sendMessage` returns `void` and exposes neither enqueue acknowledgement nor consume acknowledgement. V1 therefore does **not** promise retries, exactly-once delivery, at-most-once enqueue, or strict user-first ordering.

The safety contract is instead:

- each event has stable generation/group/sequence identity;
- one live extension instance calls `sendMessage` once per coalesced packet and then marks it locally submitted;
- session replacement fences all old callbacks;
- every autonomous packet includes effect slots derived from `(sessionGeneration, groupId, source event sequence/IDs, effect kind, target, expected domain generation)`;
- effectful tools recompute/validate that semantic key rather than trusting an arbitrary model nonce;
- claimed source events must exist in the retained event ledger, match the packet/target/generation, and be eligible for that effect kind;
- retrying the same slot and payload returns the previous result; reusing the slot with different payload conflicts;
- domain effects persist their key; generic Minions effects retain keys until group closure/session shutdown under a hard effect-record ceiling;
- state preconditions prevent a second disposition/assignment even if a model proposes a different effect;
- the model can inspect current truth with `list_minions`, `show_minion`, and domain tools.

User-initiated effects without a source event receive a one-shot invocation nonce from the host turn. If the bounded generic effect-key store fills, Minions latches attention rather than evicting live-group idempotency.

A user prompt racing an autonomous follow-up may be ordered by Pi's queue semantics. V1 chooses autonomous continuation and documents that race. Attention/limit latches still require a subsequent real user action.

### 8.5 Bounded parent packet

A model-visible packet contains structured custom-message `details` plus separately delimited content:

```text
[minions runtime policy]
- group and sequence range
- code-owned next-action nudge
- affected child/work item states

[untrusted child evidence]
- bounded summaries
- finding counts and IDs
- blocker summaries
- references for full output

[domain context]
- adapter and goal identifiers
- cached identifiers only; parent must refresh authoritative domain state
```

Large transcripts, command logs, and full findings stay behind `show_minion` or domain tools.

Runtime policy and child content must never be concatenated into one undifferentiated instruction block.

---

## 9. Direct messaging protocol

### 9.1 Goals

Direct messaging should enable coordination without creating a second scheduler or a wait-for deadlock system.

Supported use cases:

- “I am editing this shared path; can you take the other file?”
- “What export name did you settle on?”
- “Your change affects the test I am writing.”
- “The parent answered your blocker.”

### 9.2 Nonblocking send

`minion_send_message` and parent-only `message_minion` submit to the same runtime mailbox and return immediately.

```ts
interface DirectMessage {
  messageId: string;
  groupId: string;
  from: { kind: "child"; childId: string } | { kind: "parent" };
  toChildId: string;
  correlationId?: string;
  body: string;
  createdAt: string;
  expiresAt: string;
}

type SendResult =
  | { status: "accepted"; messageId: string }
  | { status: "recipient-terminal" }
  | { status: "mailbox-full" }
  | { status: "rate-limited" }
  | { status: "invalid-recipient" }
  | { status: "group-not-open" };
```

The sender never awaits the recipient's `prompt()` or response.

### 9.3 Identity and ACL

The child tool attaches sender identity through a closure. The child cannot supply or forge it. The parent tool is not exposed to children.

V1 rules:

- same group only;
- no broadcast;
- no cross-session delivery;
- no delivery after terminal-pending, aborting, or terminal state;
- no child ability to halt or steer another child directly;
- all bodies are size, depth, rate, and TTL bounded.

### 9.4 Recipient delivery and turn boundaries

Minions retains messages in its own mailbox while a recipient run is active; it does not surrender ownership to Pi's steering/follow-up queue.

At Pi's post-turn safe boundary:

- a pending terminal report wins and queued mail becomes undelivered;
- a wait report settles the run, after which non-expired mail may immediately restart it;
- if there is mail but no report/wait, the runtime stops at a `mail` boundary, keeps the task `running`, and starts the next single-flight prompt with a delimited batch of non-expired messages;
- if there is neither mail nor a protocol disposition, normal task settlement remains provisional until one final mailbox recheck.

The final mailbox recheck, message enqueue, and terminal commit share one serialized reducer. Mail arriving after the post-turn hook but before `prompt()` resolution is therefore either claimed for the next epoch or receives a terminal-undelivered outcome; it cannot be silently stranded.

Expired mail is dropped before dequeue, never wakes a child, and gets an inspectable `expired` outcome. A waiting-child restart failure transitions to `blocked`; a running mail-boundary restart failure transitions to `failed`. Both close the mailbox, record delivery-failed outcomes, emit exactly one terminal event, dispose the runtime, and may additionally latch attention. The original sender's accepted tool result is not retroactively changed.

### 9.5 Waiting is explicit and bounded

A child that needs an answer calls `minion_wait` with reason, expected responder, optional correlation ID, and remaining work.

Waiting does not count as completion. Waiting timeout transitions the task to `blocked` and wakes the parent. Parent replies use `message_minion` with the correlation ID.

There is no synchronous `waitForReply` tool, so two children cannot hold each other's tool calls open. Minions may detect a logical wait-for cycle and emit early attention, but it does not automatically choose a victim.

### 9.6 Messages are untrusted task input

Peer and parent message bodies are delimited as task input. They cannot change runtime policy, tool capability, group identity, task type, or acceptance rules.

---

## 10. Capability, trust, and prompt boundaries

Background autonomy expands the blast radius of prompt mistakes. The runtime must define a real capability boundary rather than relying on friendly prompts.

### 10.1 Parent-only model-visible capabilities

Orchestrated children do not receive model-visible access to:

- `orchestrate` or foreground `spawn`;
- group halt, resume, close, or cross-child steering;
- parent session replacement/reload commands;
- Beadwork ticket close, epic close, goal acceptance, or override tools;
- worktree creation/landing/cleanup tools;
- global reset, stash, clean, or destructive coordination helpers.

Children may receive a self-abort/report tool. This is a tool-visibility boundary, not an OS authorization claim.

Pi's event bus has no sender identity or authenticated provenance. V1 therefore treats every extension loaded into the **parent** session as trusted host code; “user-only” means no model-visible tool or child capability exposes the control event. A malicious parent extension can emit these channels just as it can register privileged tools or use the user's filesystem authority. Do not claim the event seam authenticates Beadwork.

### 10.2 Effective child tools

```text
effective tools =
  (role-requested tools ∩ parent-allowed tools ∩ orchestrated-child ceiling)
  ∪ required Minions protocol tools
```

Required protocol tools are narrowly scoped and cannot mutate parent/domain state directly. The child extension loader uses resolved extension IDs and an explicit allowlist. Dynamically registered child tools are re-filtered and cannot re-enable a denied capability.

### 10.3 Shell and process authority caveat

Tool filtering cannot prevent a coding child with shell access from invoking external CLIs, reading user-accessible credentials, or making destructive filesystem/Git/network calls. A child could run `bw close` outside extension tools.

Therefore:

- V1 does not claim OS-level sandboxing;
- background children inherit Pi's current project-trust and noninteractive shell/tool policy;
- Minions terminates subprocess groups it launches or tracks, but cannot guarantee control of arbitrary unmanaged processes;
- child prompts prohibit domain closure and destructive shared-checkout operations;
- Beadwork refreshes authoritative state before acceptance and flags out-of-band closure;
- with unrestricted shell, a coding child must be treated as having the user's repository authority;
- stronger enforcement requires sandboxing or CLI-level authorization and is outside this proposal.

### 10.4 Prompt layering

Child prompts are assembled in this order:

1. runtime protocol and safety ceiling;
2. role profile guidance;
3. delimited domain facts;
4. delimited peer messages;
5. task text.

Role prompts augment runtime safety; they never replace it.

Parent packets similarly separate runtime policy from untrusted child evidence and ticket text.

### 10.5 Profile and policy trust

Project-local profiles are user-controlled at goal creation but writable by coding children afterward. Goal creation therefore snapshots and hashes:

- Beadwork goal/review/validation policy;
- Minions limits and extension allowlist;
- role profiles used by the goal;
- model policy;
- validation command definitions.

Later autonomous dispatch resolves against the snapshot. A changed on-disk policy/profile hash latches attention and requires a real user turn before adoption. Role `completion_nudge` remains advisory, size bounded, and used only when no task type policy applies. Untrusted ticket descriptions and child output may not define a nudge.

### 10.6 Model and cost boundaries

Role model defaults and per-task model overrides are resolved through the existing model registry, then checked against the frozen orchestration policy. Session and group ceilings apply regardless of model.

---

## 11. Shared-checkout coordination

### 11.1 Workspace identity

Every group has one immutable canonical workspace identity: realpath `cwd`, Git common directory, branch, and baseline revision.

The initial `orchestrate.cwd` defaults to the parent cwd or may name an explicit existing checkout/worktree. All tasks in that group use it. Later workspace mismatch is rejected. For Beadwork goal mode, that checkout and branch are the goal target; V1 does not run work in one checkout and land it into another.

### 11.2 Path intents

Each task may declare expected path intents such as:

```json
{
  "pathIntents": ["packages/pi-minions/src/**", "packages/pi-minions/test/**"]
}
```

The runtime also observes exact paths from Minions-managed edit/write tool calls when available.

It compares:

- declared intent vs declared intent;
- observed path vs declared intent;
- observed path vs observed path.

### 11.3 Advisory overlap notices

On likely overlap, Minions:

1. emits one deduplicated notice;
2. updates the TUI;
3. suggests a direct message;
4. informs the parent on repeated or unresolved overlap.

It does **not**:

- reject the edit;
- pause either child;
- reserve a path;
- choose a winner;
- stash or reset files.

### 11.4 Accuracy limits

Shell writes, generated files, symlink tricks, external processes, and edits outside Minions-managed tools may be invisible.

The system must describe coordination as advisory and process-local, never comprehensive.

### 11.5 Shared-branch commit discipline

Beadwork implementation and fix prompts retain the repository's existing rules:

- start the ticket before work;
- keep scope narrow;
- inspect status and targeted diffs;
- stage only intended files;
- make atomic ticket-referencing commits;
- never stash/reset/clean unrelated shared state;
- report commits and validation.

This discipline remains necessary even with path notices.

---

## 12. Beadwork goal mode

### 12.1 Authoritative durable records

Beadwork owns durable workflow truth. It stores append-only, versioned machine records in the relevant epic or ticket history through structured `bw comment` entries. Human-readable text remains visible, with a bounded machine payload such as:

```ts
interface BeadworkGoalRecord<T> {
  schemaVersion: 1;
  recordType:
    | "goal"
    | "assignment"
    | "attempt-binding"
    | "evidence"
    | "validation"
    | "review-subject"
    | "review-result"
    | "finding-disposition"
    | "acceptance"
    | "decision";
  recordId: string;
  operationId: string;
  goalId: string;
  ticketId?: string;
  assignmentId?: string;
  attemptId?: string;
  supersedes?: string;
  createdAt: string;
  data: T;
}
```

Record IDs and operation IDs are idempotency keys. Duplicate same-payload writes return the existing record; conflicting reuse fails. Supersession is explicit and old records are never rewritten.

Epic labels provide coarse discovery (`pi-goal-active`, `pi-goal-attention`, `pi-goal-interrupted`); history records remain authoritative. Per-session JSON stores only a rebuildable projection and UI preferences.

The record format is consistency-checked and written only by parent Beadwork tools in the intended workflow. It is not tamper-proof against a child with unrestricted same-user shell access; that limitation follows the trust model in §10.3.

### 12.2 Goal intent and kickoff

`/bw run EPIC-10 --workers 4` no longer enters a polling loop. It preflights, records a durable goal, and submits one kickoff packet to the parent agent.

Preflight verifies:

- persistent Pi `tui` or `rpc` mode;
- a compatible Minions V1 handshake;
- target issue exists, is an open epic, and has a traversable descendant scope;
- canonical cwd/branch/baseline are attached and allowed;
- no conflicting active goal record exists;
- requested concurrency is within runtime capacity;
- frozen role, model, extension, review, and validation policy hashes are valid.

```ts
interface GoalIntent {
  schemaVersion: 1;
  goalId: string;
  scopeIds: [string];
  groupId?: string;
  ownerSessionGeneration: string;
  ownerProcess: { pid: number; startFingerprint: string };
  workspace: WorkspaceIdentity;
  maxConcurrency: number;
  reviewPolicy: "ticket" | "scope" | "none";
  policyHash: string;
  allowedRoles: Record<
    string,
    { profileHash: string; modelRef: string; allowedTaskTypes: TaskType[] }
  >;
  startedAt: string;
  status:
    | "pending-kickoff"
    | "active"
    | "attention"
    | "interrupted"
    | "abandoned"
    | "superseded"
    | "completed";
}
```

Goal policy uses Beadwork `maxAttemptsPerTicket` and `review.maxRounds`; generic Minions runtime ceilings only bound live resources. `allowedRoles` is the frozen role set for the goal, not merely a policy hash: every assignment selects from it, and adding or changing a role/model/profile requires a user-authorized goal-policy generation.

Goal creation uses a **short repository-local critical-section lock**, not a long-lived mission lease. Before checking/writing ownership, `/bw run` atomically creates a lock directory under the canonical Git common directory containing an owner nonce, PID, process-start fingerprint, session generation, and acquisition time. It verifies the nonce before each mutation; a lock is reclaimable only when PID/start identity proves the owner process dead. Lock acquisition is bounded, and unsupported/non-atomic filesystems fail preflight rather than weakening the claim.

While holding the lock, `/bw run` rereads all nonterminal intents, appends `pending-kickoff`, rereads, and appends `active` for the sole owner or records `superseded`. It releases the lock before creating a domain group, issuing permits, or sending kickoff. Resume/abandon ownership transitions use the same lock. Reconciliation retains deterministic history ordering only for legacy/corrupt duplicate records; it does not claim an unlocked timestamp election prevents races.

The kickoff tells the parent to refresh Beadwork and Minions state, choose ready work within capacity, prepare an assignment, and call `orchestrate` with `taskType: "implementation"`.

`pi.sendMessage` provides no enqueue acknowledgement. The goal is already durably `active` before the synchronous send; the user may safely run `/bw resume <goal>` to resubmit an idempotent kickoff if no turn occurred. A crash between activation and send is reconciled as an interrupted owner generation. Missing Minions or preflight/lock failure never creates an active goal.

### 12.3 No hidden scheduler

After kickoff, continuation occurs only through model turns caused by a meaningful Minions packet, a user prompt, or an explicit command.

Before every assignment, disposition, acceptance, or goal-completion action, the parent refreshes authoritative Beadwork records and current Minions state. Cached projection is never sufficient for effects.

### 12.4 Domain context

```ts
interface DomainContext {
  adapter: "beadwork";
  schemaVersion: 1;
  goalId: string;
  scopeIds: [string];
  policyHash: string;
}
```

This context is immutable at group level and appears on every event. Per-task `workItemId` and `assignmentId` identify the ticket and domain assignment. Minions stores and echoes these identifiers but does not interpret issue semantics.

### 12.5 Complete model-facing effect API

Every autonomous effect tool requires a domain-issued semantic `operationId`, the expected goal and ticket revision tokens, and relevant source event IDs. It recomputes both tokens inside the mutation queue immediately before the effect:

- `goalRevision = hash(canonical goal status + ordered active machine-record IDs + policy generation)`;
- `ticketRevision = hash(normalized issue status/parent/dependencies/assignee + latest issue history commit + canonical assignment/evidence generation)`.

The tool rejects stale expectations and returns current tokens. These are optimistic preconditions, not a false claim of distributed CAS; cross-process drift detected after an external `bw` command is handled by the acceptance saga and reconciliation.

- `beadwork_prepare_assignment`
- `beadwork_prepare_activity` (review/scope-review/investigation/validation-child permits)
- `beadwork_bind_attempt`
- `beadwork_record_evidence`
- `beadwork_create_review_subject`
- `beadwork_record_review_result`
- `beadwork_disposition_finding`
- `beadwork_run_validation`
- `beadwork_accept_ticket`
- `beadwork_reconcile_goal`
- `beadwork_complete_goal`

User/operator commands, not autonomous model tools, perform:

- goal interruption, abandonment, and resume;
- attention-latch resume;
- validation/acceptance risk override;
- explicit exclusion of an in-scope issue from goal completion.

Ordinary Minions lifecycle events only update a read-only projection. They do not mutate Beadwork records behind the model. The only non-projection protocol messages are explicit user-control request/ack messages and one-use assignment-permit registration described in §13; neither schedules work or mutates issue state. Parent packets name the next required effect, and duplicate packets are safe because semantic effect keys and record preconditions are idempotent.

All status-changing entry points—`/bw close`, `beadwork_close_issue`, generic status update, ticket acceptance, and epic completion—route through one goal-ownership guard. Out-of-band shell use remains detectable but not preventable.

### 12.6 Assignment protocol

Beadwork distinguishes canonical ticket work from auxiliary workflow activity:

```ts
type DomainAssignmentKind =
  | "implementation"
  | "fix"
  | "ticket-review"
  | "scope-review"
  | "investigation"
  | "validation-child";
```

`implementation`/`fix` assignments own ticket status and are bound to `{goalId, ticketId, goalRevision, ticketRevision, policyHash}`. Auxiliary assignments never call `bw start`/close or become canonical ticket ownership; their permits bind the goal plus exact review subject, finding, validation, or investigation activity ID/digest, and optionally a ticket revision.

- Beadwork creates `assignmentId`, records `prepared`, and registers a random one-use permit for that exact assignment kind/subject.
- The parent passes that permit to `orchestrate`; Minions validates/consumes it and creates `attemptId` and `childId`.
- The parent calls `beadwork_bind_attempt` to persist `{assignmentId, attemptId, childId, groupId}`.

```text
prepared -> bound -> terminal
    |         |
    +-> cancelled/superseded
```

The mapping is one-to-one and immutable: one assignment binds at most one `(attemptId, childId, groupId)` tuple; one attempt and one child bind to at most one assignment; `workItemId` must equal the assignment's runtime work item (ticket ID for ticket work, subject/activity ID for auxiliary work); assignment kind/task type, group domain identity, and policy hash must match. Same-payload rebinding is idempotent. Any other reuse is a conflict and fences the affected attempt.

`beadwork_prepare_assignment` performs a fresh recursive-scope/readiness check and handles ticket states explicitly:

- open and ready: start and prepare;
- in progress with the same canonical assignment: return it idempotently;
- in progress with another assignment: attention/collision;
- blocked, deferred, closed, out of scope, or epic: reject with a closed code;
- legacy `in_progress` with no native canonical assignment: reject as `legacy-unowned` and require the migration workflow in §17.4;
- configured assignee: preserve or validate it according to Beadwork policy.

A `fix` may supersede a **terminal** canonical implementation/fix assignment and increment the ticket evidence generation; it rejects while prior ticket work is active. `beadwork_prepare_activity` independently checks its subject generation and frozen role/task policy without changing issue status, so ticket and scope reviewers can run while the reviewed ticket remains `in_progress` or already accepted as policy permits.

Starting an open issue is itself a small recoverable saga: persist `assignment-start-prepared` with both revision tokens, run `bw start`, reread the issue/history and goal records, then persist canonical `prepared` and register the permit. A crash or post-start drift is reconciled by operation key; it never returns a permit from an unverified `in_progress` state.

If `orchestrate` rejects or the parent never binds the attempt, reconciliation first queries a fresh Minions snapshot by `assignmentId`. A unique matching child is bound idempotently. To cancel/reopen a consumed assignment, Beadwork waits for acknowledged revoke/fence and terminal drain; only then may it return the ticket to open when the assignment is still canonical, no later assignment exists, and issue state still matches. Missing/stale/conflicting runtime state enters attention. After process death, session-generation fencing proves no process-local child remains. Reconciliation never reopens merely because the durable binding write is absent.

Within one session, Minions rejects a live duplicate work item registry-wide. Across processes, V1 remains best effort rather than claiming a distributed lease. If two assignments race, the canonical record is the earliest valid Beadwork history order `(record timestamp, history commit hash, recordId)`. A session discovering that its assignment lost immediately fences its local child and blocks acceptance. Some edits may already have occurred before detection; that is an explicit multi-session limitation.

### 12.7 Worker prompts and evidence attribution

Implementation children no longer run `bw start` or close tickets. The parent has already prepared the assignment.

The prompt includes ticket/epic facts, assignment and runtime attempt IDs, baseline revision, shared-checkout discipline, expected evidence, structured report requirements, and a prohibition on domain closure.

A child result is only a claim. `beadwork_record_evidence` constructs evidence from Git and Beadwork state:

```ts
interface EvidenceSubject {
  evidenceId: string;
  assignmentId: string;
  attemptId: string;
  ticketId: string;
  baselineRevision: string;
  orderedCommitShas: string[];
  commitPatchIds: string[];
  touchedPaths: string[];
  targetHeadAtCapture: string;
  targetTreeAtCapture: string;
  dirtyEvidencePaths: string[];
  capturedAt: string;
}
```

Attribution rules:

- every claimed commit resolves and is an ancestor of the goal target branch;
- the assignment baseline is an ancestor of each normal claimed commit;
- the ticket ID appears in the commit subject/body or structured trailer;
- commit paths and patch IDs are derived from Git objects, never trusted from child text;
- a commit may not already be claimed by an incompatible assignment;
- merge commits and mixed-ticket commits require an explicit recorded attribution decision;
- history rewrite, missing commits, or incoherent ordering route to attention.

This is strong evidence, not cryptographic worker identity. The parent remains responsible for adjudicating ambiguous attribution.

### 12.8 Ticket acceptance gate

Issue status remains open/in-progress/closed. Acceptance readiness is derived from append-only assignment, evidence, validation, review, finding, and decision records rather than a second mutable phase field.

Normal `beadwork_accept_ticket` requires:

- the current bound implementation/fix attempt is `succeeded`;
- the runtime result protocol is valid with no protocol error;
- the canonical evidence generation belongs to that assignment;
- claimed commits remain ancestors of the goal target branch;
- required domain-owned validation covers the applicable exact tree/revision;
- no current blocker, attention state, or newer assignment supersedes the evidence;
- no dirty working-tree state invalidates the applicable review/validation record;
- review requirements for the selected policy are satisfied.

`partial`, `blocked`, `failed`, `aborted`, and `unresponsive` attempts are never normally acceptable.

A ticket is assignable only when every in-goal dependency has `accept-committed`, not merely when `bw ready` observes a closed issue. This prevents a close side effect from unlocking dependents before its acceptance saga commits.

Under `ticket` review policy, acceptance additionally requires a current ticket review, all blocking fixes resolved and re-reviewed, nonblocking filed work persisted, and every rejected finding justified.

Under `scope` policy, tickets may be accepted after common evidence/validation requirements and are independently reviewed as one immutable scope before epic closure.

Under `none`, independent reviewer tasks are skipped; evidence and configured validation are not.

Acceptance is a recoverable saga: append `accept-prepared` with a deterministic operation key and expected goal/ticket revisions; run `bw close`; reread issue, repository, and machine records; then append `accept-committed` with the observed close-history token. On crash, reconciliation resumes by operation key. If postconditions drift after close, it reopens only when that exact close token is still the latest status transition, no dependent has started/closed, and no later mutation relies on closure; otherwise it enters attention. The CLI is not treated as a distributed CAS.

An autonomous parent cannot bypass the gate. It may request a user override. A user command creates a one-shot, goal/ticket/revision-bound capability with durable rationale; reuse or revision mismatch fails.

### 12.9 Immutable ticket and scope review subjects

A review is bound to a canonical subject and submitted result, not ambient files or a prose claim:

```ts
type GitEntryState = { oid: string | null; mode: string | null };

type GitEntryDelta = {
  path: string;
  baseline: GitEntryState;
  target: GitEntryState;
};
interface TicketReviewSubject {
  subjectId: string;
  evidenceId: string;
  reviewGeneration: number;
  baselineTree: string;
  targetHead: string;
  targetTree: string;
  canonicalPatchDigest: string;
  orderedCommitShas: string[];
  changedEntryManifest: GitEntryDelta[];
  dependencyEntryManifest: Array<{ path: string; target: GitEntryState }>;
  coverageMode: "exact-tree" | "dependency-set";
  dependencyResolverId: string;
  dependencyGraphDigest: string;
}

interface ScopeReviewSubject {
  subjectId: string;
  goalId: string;
  reviewGeneration: number;
  baselineTree: string;
  targetHead: string;
  targetTree: string;
  canonicalAggregateDiffDigest: string;
  acceptedEvidenceIds: string[];
  validationRecordIds: string[];
}

interface ReviewResultBinding {
  subjectId: string;
  subjectDigest: string;
  policyHash: string;
  reviewerAssignmentId: string;
  reviewerAttemptId: string;
  findingDigest: string;
}
```

Reviewer prompts provide the complete manifest and Git object references and instruct inspection through `git show`/object IDs, not mutable workspace reads alone. Null OIDs/modes are tombstones, and mode captures executable, symlink, and submodule changes. The structured child evidence must include `ReviewResultBinding`; `beadwork_submit_review` recomputes it and rejects a wrong subject, reviewer assignment/attempt, policy, incomplete manifest, or stale entry.

A dependency manifest is complete only if a versioned resolver closes changed paths over language imports/re-exports, TypeScript project references, package exports/workspace manifests, lockfiles, build/test/lint/typecheck configuration, generated-schema sources, and every path explicitly inspected or cited by the reviewer. Any unresolved dynamic import, generated input, opaque script edge, or unsupported language forces `coverageMode: "exact-tree"` (whole-tree drift check). Otherwise `dependency-set` permits acceptance after unrelated commits only when changed/dependency entry OIDs, absence tombstones, modes, and resolver graph digest remain identical. Accepted reviews are historical evidence and are not retroactively invalidated by later work. Dirty changes in any covered path block acceptance. Scope review is always valid only for its exact target tree.

### 12.10 Review findings, dispositions, and convergence

Review tasks use `taskType: "reviewImplementation"` or `"reviewScope"` and return structured findings.

After creating the immutable subject, the parent calls `beadwork_prepare_activity` to obtain a subject-bound `ticket-review` or `scope-review` permit. Reviewer activity is one-to-one bound like ticket work but does not alter issue status.

Beadwork assigns:

- an occurrence ID bound to one review subject/generation;
- a stable finding-family ID from normalized claim, class, and evidence location independent of generation.

The family ID supports cross-generation deduplication; occurrence IDs preserve history. A disposition carries forward only when the family and relevant Git entries (OID/absence/mode) are unchanged.

```ts
type FindingDisposition =
  | { kind: "fix"; remediationAssignmentId: string; rationale: string }
  | { kind: "file"; followUpIssueId: string; rationale: string }
  | { kind: "reject"; rationale: string };
```

- `fix` creates a new assignment with `taskType: "fix"`; completion requires re-review and applicable revalidation.
- `file` is valid for nonblocking work. A blocking finding must first be reclassified or receive a user-only risk waiver. A filed issue under the active epic becomes in-scope and blocks epic completion; an explicitly external follow-up does not.
- `reject` resolves the occurrence only after the autonomous parent persists why it is invalid, out of scope, or unsupported.

Under scope review, a blocking fix either reopens/invalidation-marks an accepted ticket or creates a mandatory in-scope remediation descendant. Affected validation and scope review are rerun before epic closure.

Beadwork owns `maxAttemptsPerTicket` and `review.maxRounds`. Identical findings deduplicate; remediation creates a new evidence/review generation; exhausting either limit latches **goal** attention. It does not latch the generic Minions group. Beadwork stops issuing **all** ticket/activity permits and acknowledged-revokes every outstanding permit while attention is active, so every task in the domain group rejects but unrelated generic groups are not conflated with the goal. Only a user resume/override can authorize a new bounded goal generation.

### 12.11 Domain-owned validation

Child `validationClaims` are informative only. Official acceptance validation runs in a deny-by-default environment assembled from fixed deterministic variables plus an explicit allowlist; inherited variables outside it are removed. `beadwork_run_validation` stores a replayable `ValidationRunManifest`: ordered argv/shell commands, cwd, timeout, runner/platform identity, the complete effective environment (secret values as keyed hashes), resolved executable/shell absolute paths, executable hashes/versions and shell options, locale/timezone/PATH, lockfile/config blob hashes, canonical policy generation/hash, branch/HEAD/tree, before/after repository fingerprints, covered evidence IDs, start/end timestamps, exit statuses, and stdout/stderr artifact digests. Acceptance rebuilds and compares policy/tree/environment/toolchain/config identities and rejects or reruns any mismatch. `policyHash` is canonical serialization of the policy inputs, not a caller label.

```ts
interface BeadworkGoalConfig {
  run: {
    defaultWorkers: number;
    maxAttemptsPerTicket: number;
  };
  review: {
    policy: "ticket" | "scope" | "none";
    role: string;
    model?: string;
    maxRounds: number;
    maxArtifactChars: number;
    /** @deprecated input alias; normalized away after load */
    maxContextChars?: number;
  };
  validation: {
    repositoryCommands: string[];
    ticketCommands: Array<{
      command: string;
      dependencyPaths: string[];
    }>;
    commandTimeoutMs: number;
    environmentAllowlist: string[];
    fixedEnvironment: Record<string, string>;
  };
}
```

The loader keeps the existing `landing.review.maxContextChars` key as a one-release compatibility alias for `maxArtifactChars`; when both are present, `maxArtifactChars` wins and a deprecation diagnostic identifies the source. Environment parsing and resolved config emit only `maxArtifactChars`. This matches the current loader behavior instead of silently dropping existing repositories.

The existing `landing.validateCommands` defaults migrate to `validation.repositoryCommands`:

```text
npm run lint
npm run test
npm run typecheck
```

Repository-wide commands are valid only for the exact tested tree. They run at a quiescent point with no active goal child and a clean tracked/untracked workspace except explicitly allowlisted validation artifacts. The runner records HEAD, index, tracked worktree, and untracked-set fingerprints before and after; any concurrent change discards the run and routes to retry/attention. No automatic stash, reset, or cleanup is allowed.

The default runner sets a deterministic locale/timezone and temporary HOME/cache roots. Repositories that require credentials or other environment inputs must name them in `environmentAllowlist`; they are passed to the process but only keyed hashes are persisted. PATH is explicit, and command executables are resolved before launch.

One exact-tree repository validation record may cover several candidate tickets in the same completed wave. Final goal completion requires repository validation for the final scope tree.

Path-scoped ticket commands may run concurrently only when configuration declares a dependency path closure and no covered path changes during the run. Without such a declaration, the command is conservatively repository-scoped. Relevant-path heuristics alone never validate the default whole-repository commands.

### 12.12 Goal completion

Minions quiescence does not imply epic completion.

The parent may complete the goal only after a fresh recursive traversal proves:

- the goal group is open and quiescent, with no active/waiting/aborting/unresponsive child;
- every in-scope non-epic descendant has a canonical accepted generation and is closed, or has a user-authored explicit exclusion;
- no blocked, deferred, reopened, orphaned, out-of-band-closed, or newly created in-scope issue remains unreconciled;
- no unresolved blocking finding or attention state remains;
- final repository validation covers the exact scope tree;
- under `scope` policy, the independent scope review covers that same tree;
- under `ticket` policy, ticket reviews are complete; an additional independent scope review is not implied;
- follow-up issues attached under the active epic are included in the traversal.

`beadwork_complete_goal` uses the same prepared/external-command/reread/committed saga as ticket acceptance. Only `goal-close-committed` returns a one-shot domain closure token for normal Minions group closure. Reconciliation resumes prepared closes and never infers success merely from the epic's closed status.

### 12.13 Decision collection and interruption

Beadwork persists important decisions when they occur: finding dispositions, user risk overrides, attribution adjudication, retry exhaustion, collision ownership, out-of-band reconciliation, issue exclusion, follow-up scope placement, and final acceptance.

Explicit `interrupt` and `abandon` first send an acknowledged user-control request that makes Minions fence dispatch/mail/startup for the domain group. Only after Minions acknowledges `closing` does Beadwork persist interruption; abandon waits for drained closure before final abandonment. Timeout does not claim success: it records `interrupt-pending` attention and issues no new permits. `resume` creates a new bounded goal-policy generation and, after restart, a new Minions group; it cannot clear absolute runtime counters. Parent/session shutdown uses the same best-effort fence and records a recoverable interrupted marker. A new session rebuilds from Beadwork history, reconciles prepared/bound orphans and pending controls, and never fabricates live children from old metadata.

The final goal report summarizes decisions for user review; it is not their first durable record.

---

## 13. Extension-to-extension integration contract

### 13.1 Use a versioned, runtime-validated Pi event seam

Beadwork must not read Minions private maps, transcript files, or internal classes.

Minions and Beadwork communicate through closed `pi.events` channels:

```text
minions:v1:probe
minions:v1:hello
minions:v1:child-event
minions:v1:snapshot-request
minions:v1:snapshot-response
beadwork:v1:assignment-permit      # register | revoke
minions:v1:assignment-permit-ack
beadwork:v1:user-control-request
minions:v1:user-control-ack
```

At session start Beadwork emits a probe; Minions responds with protocol version, session generation, supported mode, feature flags, and frozen runtime-capacity summary. `/bw run` rejects if no compatible hello is present.

Every lifecycle event is self-identifying by `sessionGeneration`, `groupId`, `goalId`, and sequence. Runtime validators reject malformed, unknown-version, stale-generation, or conflicting-domain payloads. Exported TypeScript types alone are not treated as validation.

Pi event emission does not await asynchronous subscribers. Beadwork's lifecycle projection reducer is therefore synchronous, generation-fenced, sequence-aware, and side-effect free. A sequence gap marks the projection stale and requests a read-only snapshot; it never silently reasons from an incomplete projection.

Permit registration is a narrow capability handshake: after persisting `prepared`, Beadwork emits a random, short-lived, one-use permit bound to exact revisions and waits for an ack before returning it to the model. Minions may store/consume it but cannot schedule from it. Missing ack cancels/reconciles the prepared assignment.

Permit consume and revoke share one serialized reducer. Revoke is acknowledged as `revoked-unused`, `consumed-fenced { attemptId, childId }`, `unknown`, or `conflict`. A consumed match closes that attempt's startup/mail ingress before ack and then drains/disposes it; Beadwork does not reopen/supersede until terminal drain is observed. Canceled, stale, interrupted, or attention-latched transitions wait for revoke/fence acknowledgement; timeout enters attention. Expiry is only a backstop.

User control is a second explicit exception. A Beadwork command registers a pending request promise, emits `{requestId, action, sessionGeneration, groupId, goalId}`, and waits with a bound. Minions synchronously enters `closing`/fences ingress before acking `accepted`; drain completion is observed through lifecycle events. Stale, duplicate, or mismatched requests reject idempotently. The channels are not model tools, but—as §10.1 states—the Pi event bus does not authenticate their extension origin.

### 13.2 Model tools remain the normal effect boundary

Beadwork does not invoke Minions through an internal scheduler API. The parent model calls `orchestrate` and Beadwork effect tools. Minions never invokes Beadwork mutation APIs.

The only cross-extension non-projection effects are the permit registry and acknowledged first-party user-command group control above. Neither can start work or close an issue. All autonomous scheduling, evidence, review, validation, disposition, and acceptance remain explicit idempotent model-visible operations. The boundary is capability exposure to the model, not authentication between trusted parent extensions.

### 13.3 Goal/group identity

`/bw run` creates `goalId`; the first `orchestrate` call includes immutable domain context. Every subsequent event repeats goal identity, so binding is derived idempotently rather than depending on one `group-created` event. A second open group for the same session/goal or conflicting context is rejected.

### 13.4 Shared protocol types and versioning

Public request, response, event, payload, and runtime-validator definitions live in a side-effect-free export:

```text
@solvedbydev/pi-minions/protocol
```

`pi-minions` adds that package export. Beadwork declares a compatible-major optional peer dependency and fails goal preflight cleanly when the extension/protocol is absent or skewed.

---

## 14. Package changes

### 14.1 `packages/pi-minions`

Add:

```text
src/orchestration/
  registry.ts
  lifecycle.ts
  runner.ts
  events.ts
  delivery.ts
  messages.ts
  policies.ts
  results.ts
  coordination.ts
  limits.ts
  protocol.ts
  tools.ts
```

Refactor existing child session code so foreground and orchestrated execution share:

- session creation;
- model/profile resolution;
- tool policy;
- transcript creation;
- usage and activity hooks;
- abort/shutdown behavior;
- result extraction.

Avoid parallel implementations of child execution.

### 14.2 `packages/pi-beadwork-extension`

Add or reshape:

```text
src/goal/
  intent.ts
  assignments.ts
  projection.ts
  evidence.ts
  acceptance.ts
  review.ts
  validation.ts
  decisions.ts
  prompts.ts
```

Retain:

- activation and config loading;
- `bw` adapter and mutation retry queue;
- issue browsing and scope context;
- `bw prime` cache;
- status/dashboard infrastructure;
- attribution helpers that remain useful;
- session-state projection/cache loading for goal UI and summaries;

Remove after cutover:

- tmux launch/control;
- worker registry/state/log files as execution truth;
- worker wrapper scripts;
- managed worktree lifecycle and landing code;
- supervisor polling loop;
- worker process inspection;
- tmux/worktree-specific dashboard actions;
- alternate worker execution modes.

### 14.3 Simplify `orchestrator.ts`

Do not incrementally append another path to the existing 6,000-line file.

Move retained domain logic into goal modules and delete worker-runtime branches. Because this is a major-version cutover, do not retain a worker-shaped compatibility façade that depends on deleted registry semantics.

### 14.4 Scripts and generated context

The current tmux bootstrap and worker wrapper scripts become dead code and should be removed after tests migrate.

Generated `context.md` may remain as a debugging artifact, but it must not be the authoritative child instruction. The direct prompt is canonical.

---

## 15. TUI and user-visible state

### 15.1 Two views, one runtime truth

The Minions fleet view and Beadwork goal view serve different questions.

Minions fleet:

- groups;
- child role/model/task type;
- active/idle/waiting/terminal state;
- duration, turns, usage;
- latest activity;
- mailbox and overlap notices;
- halt controls.

Beadwork goal:

- epic and issue counts;
- assignments and attempts;
- evidence/validation/review phase;
- findings and dispositions;
- accepted and attention tickets;
- goal decisions;
- goal completion state.

Beadwork filters the runtime-validated Minions projection by `goalId`; it does not maintain a second worker registry. On sequence gaps it marks runtime data stale until a snapshot response arrives.

### 15.2 Replace obsolete worker actions

Remove dashboard actions that imply landing or cleanup.

Minions fleet owns inspect, message, halt, and group controls. Beadwork goal view links to that fleet and owns:

For a Beadwork-owned group, the fleet's halt action is labeled **Interrupt goal** and invokes/redirects to the acknowledged Beadwork user-control path; it never performs an unrecorded domain halt.

- open the Minions fleet view for child inspection/controls;
- inspect durable ticket evidence and assignment bindings;
- disposition findings;
- retry/reconcile assignment;
- request user override;
- interrupt, abandon, or resume goal.

Document replacements for worker tab labels, keybindings, commands, statusline fields, and stale legacy records.

### 15.3 Event granularity

Status/TUI may update on progress. Model-visible and user-notification updates should normally occur only for:

- waiting/question;
- terminal result;
- repeated coordination concern;
- resource ceiling;
- review finding set;
- validation failure;
- goal attention;
- goal completion.

---

## 16. Persistence and crash semantics

### 16.1 Process-local runtime

No live child session or mailbox survives process death.

Transcript JSONL and bounded summaries may survive for diagnosis. They are not a durable job queue and do not authorize automatic restart.

### 16.2 Goal records survive; execution does not

Authoritative goal, assignment, evidence, review, validation, disposition, and decision records live in Beadwork history. Session JSON is only a cache.

On orderly parent shutdown/session replacement, an active goal is fenced before being marked `interrupted`; a control timeout records `interrupt-pending`. After process death, the persisted PID/start fingerprint proves the old process-local children dead, so a new lock holder may reconcile the stale active generation to `interrupted`. It discovers active/interrupted goal labels, rebuilds from history, and runs reconciliation:

1. refresh recursive issues and machine records;
2. inspect target branch and claimed Git objects;
3. identify prepared-but-unbound and bound-orphan assignments;
4. preserve valid terminal evidence;
5. require explicit retry, accept, reset, exclusion, or abandonment decisions where ambiguity remains;
6. create a new Minions group and new attempts only after user resume.

Do not fabricate live children from stale metadata or auto-restart work merely because an assignment was previously bound.

### 16.3 Multi-session behavior

Two Pi sessions may still operate in one repository.

V1 offers:

- per-session runtime ownership;
- Beadwork mutation serialization/retry within each process;
- a short same-host Git-common-dir critical-section lock for goal ownership transitions;
- assignment IDs and attempt comments;
- fresh state checks before start and close;
- visible collision/attention handling.

V1 does not offer:

- a long-lived/global mission lease or cross-host/NFS ownership protocol;
- cross-process child discovery;
- exactly-once dispatch;
- distributed path coordination.

The UI and docs must state this honestly.

---

## 17. Compatibility and cutover

This is a breaking redesign and should ship as a coordinated major-version change for the affected packages.

### 17.1 Compatibility matrix

| Existing surface | Cutover behavior |
|---|---|
| foreground `spawn` / `spawn.agent` | preserved |
| `beadwork_delegate` | removed; use goal assignment + `orchestrate` |
| `beadwork_worker_done` | removed; use structured result + Beadwork evidence effects |
| old worktree/worker records | read-only migration diagnostic only; never runtime truth |
| tmux configuration | rejected with an actionable removal error |
| `workerExecution.mode` | removed |
| managed `worktrees.*` | removed; one explicit existing group `cwd` replaces them |
| `landing.validateCommands` | migrated to `validation.repositoryCommands` |
| worker/landing reviewer settings | migrated only where mapping is unambiguous |
| worker dashboard land/cleanup actions | removed/replaced |
| `/bw run` | new parent-driven goal intent semantics |

### 17.2 No worker-shaped shims

This is a major-version replacement. Do not retain shims whose names or return values imply an external worker, landing, or worker registry. A migration diagnostic may explain stale records, but it may not execute them.

### 17.3 Field-by-field configuration migration

| Old field group | Migration |
|---|---|
| `ui.showInactiveStatus` | keep |
| `storage.sessionStateDir` | keep for cache only |
| `storage.workerRegistryFile`, `storage.runtimeDir` | remove with warning |
| all `tmux.*` | reject as removed |
| all `worktrees.*` | reject as removed; user supplies group cwd |
| `workerExecution.mode`, `allowDetachedHead` | reject as removed |
| numeric `workerExecution.maxLifetime` | migrate to default `maxChildRuntimeMs`; keep null as default |
| `workerExecution.review.enabled` | true maps to `review.policy: "ticket"`; false maps to `none` only if no other review setting conflicts |
| `workerExecution.selfReview.enabled` | remove with warning; no automatic mapping to independent review |
| `run.defaultWorkers` | migrate to `run.defaultWorkers` |
| `run.defaultUntil`, `defaultMaxCycles`, `pollIntervalMs` | remove with explanation; event-driven goal mode has no poll cycles |
| `landing.validateCommands` | migrate to exact-tree `validation.repositoryCommands` |
| `landing.commandTimeoutMs` | migrate to `validation.commandTimeoutMs` |
| `landing.policy`, `maxRebaseAttempts` | reject as removed |
| `landing.review.enabled` | maps to ticket review only when it agrees with worker review; otherwise require correction |
| `landing.review.provider` + `model` | migrate to one model reference; reviewer role must be explicit/defaulted visibly |
| `landing.review.commandTimeoutMs` | migrate to review-child runtime limit |
| `landing.review.maxRemediationAttempts` | migrate to `run.maxAttemptsPerTicket` only with warning and explicit confirmation |
| `landing.review.maxArtifactChars` | migrate to `review.maxArtifactChars` |
| `landing.review.maxContextChars` | accept as a deprecated one-release alias; `maxArtifactChars` wins if both exist |
| all `supervisor.*` | remove with explanation |

The same rule applies to every corresponding `PI_BEADWORK_*` environment variable: kept values map explicitly; removed execution/tmux/worktree/polling variables cause actionable startup diagnostics rather than being ignored.

Exact environment handling:

- keep `PI_BEADWORK_SHOW_INACTIVE_STATUS`, `PI_BEADWORK_SESSION_STATE_DIR`, and `PI_BEADWORK_DEFAULT_WORKERS`;
- rename `PI_BEADWORK_WORKER_MAX_LIFETIME` to the new child-runtime limit with a deprecation diagnostic;
- rename `PI_BEADWORK_VALIDATE_TIMEOUT_MS`, `PI_BEADWORK_REVIEW_MODEL`, `PI_BEADWORK_REVIEW_TIMEOUT_MS`, and `PI_BEADWORK_REVIEW_MAX_ARTIFACT_CHARS` to their new validation/review equivalents;
- accept `PI_BEADWORK_REVIEW_MAX_CONTEXT_CHARS` only as the deprecated alias for artifact size during one migration window;
- reject `PI_BEADWORK_WORKER_REGISTRY_FILE`, `PI_BEADWORK_RUNTIME_DIR`, `PI_BEADWORK_TMUX_SESSION_NAME`, `PI_BEADWORK_WORKER_COMMAND`, `PI_BEADWORK_WORKER_PROVIDER`, `PI_BEADWORK_WORKER_MODEL`, `PI_BEADWORK_WORKTREE_BASE_DIR`, `PI_BEADWORK_WORKER_EXECUTION_MODE`, `PI_BEADWORK_WORKER_ALLOW_DETACHED_HEAD`, `PI_BEADWORK_WORKER_SELF_REVIEW_ENABLED`, `PI_BEADWORK_DEFAULT_MAX_CYCLES`, `PI_BEADWORK_POLL_INTERVAL_MS`, `PI_BEADWORK_MAX_REBASE_ATTEMPTS`, `PI_BEADWORK_LANDING_POLICY`, and `PI_BEADWORK_SUPERVISOR_POLL_INTERVAL_MS`;
- migrate `PI_BEADWORK_WORKER_REVIEW_ENABLED`, `PI_BEADWORK_REVIEW_ENABLED`, `PI_BEADWORK_REVIEW_PROVIDER`, and `PI_BEADWORK_REVIEW_MAX_REMEDIATION_ATTEMPTS` only under the same conflict/confirmation rules as their JSON fields.

Malformed JSON, unknown removed keys, and conflicting review settings must not be silently swallowed. Configuration loading returns all migration errors together and never silently selects a backend or duplicates repository commands into multiple validation phases.

### 17.4 Legacy in-progress issue migration

Native mode preflight inventories legacy registry entries and every `in_progress` descendant without a canonical native assignment. It refuses to schedule or accept those tickets and prints a deterministic migration report. The user must choose per ticket:

1. finish/stop it under the old release before cutover;
2. `adopt-evidence`: only for a terminal legacy worker whose commits/tree/path attribution can be independently verified; write an explicit synthetic `legacy-migration` assignment/evidence record and still require current native review/validation;
3. `return-open`: after confirming no live process and no unmerged worktree changes, record the old state as superseded and move the issue back to open;
4. exclude/defer/abandon through an explicit Beadwork decision.

The migration command never runs a stale worker record, lands a worktree, invents a live child, or silently adopts `in_progress`. Active legacy processes and dirty/unmerged worktrees are hard blockers until the user resolves them. Every choice is idempotent and stored in issue history so a later session rebuilds the same ownership state.

### 17.5 Documentation migration

Update:

- both package READMEs;
- root examples;
- agent/tool descriptions;
- screenshots and TUI labels;
- configuration reference;
- migration guide;
- any scripts or tests referring to tmux, landing, worktree cleanup, or worker registry files.

---

## 18. Failure semantics

| Failure | Required behavior |
|---|---|
| descriptor invalid/unsupported host mode | reject synchronously with closed code |
| partial batch startup | preserve started handles; emit failures for the rest |
| child creation fails | terminal `failed`; reconcile Beadwork assignment |
| report/wait conflict | first valid latch wins; later call returns conflict |
| terminal report races mail | terminal-pending closes ingress; mail gets undelivered outcome |
| child settles without typed result | `partial` protocol violation; no acceptance |
| mail arrives after post-turn hook, before resolution | serialized final recheck claims it or records terminal-undelivered |
| waiting/running mail restart fails | transition `blocked`/`failed`, close mailbox, emit one terminal event, dispose runtime |
| child waits too long | atomically transition waiting to blocked, close/dispose the runtime, wake parent |
| cooperative abort hangs | fence, force local disposal, mark unresponsive/attention |
| parent session shuts down | fence callbacks, close queues, bounded runtime disposal, no late injection |
| parent process dies | children die; durable goal is interrupted on next load |
| parent delivery ambiguity | no retry claim; rely on idempotent effects and current-truth tools |
| model invents fresh IDs for one autonomous effect | semantic key recomputation returns the prior result or rejects conflicting payload |
| generic effect-key ceiling reached | latch runtime attention; never evict live-group keys |
| malformed/reordered event | reject or mark projection stale and request snapshot |
| mailbox full/rate limited/expired | bounded sender/outcome record; no synchronous wait |
| recipient terminal | reject message |
| duplicate work item/session goal group | reject registration |
| duplicate work across processes | canonical history ordering; losing local attempt fences; attention |
| concurrent goal intents for one epic | same-host Git-common-dir lock serializes active-owner creation; timeout/failure rejects |
| permit revoke races consume | serialized ack returns revoked or consumed-fenced; no silent start |
| claimed commit missing/non-ancestor/mixed | attention; block acceptance pending attribution decision |
| relevant path changed after ticket review | invalidate affected review |
| repository changes during validation | discard exact-tree validation result |
| unallowlisted inherited environment could affect validation | remove it before launch; compare complete effective environment |
| partial/blocked/failed attempt | never normally acceptable |
| validation fails | remediation or attention within Beadwork attempt ceiling |
| review does not converge | attention after Beadwork max rounds |
| scope fix targets accepted ticket | reopen/invalidate or create mandatory in-scope remediation |
| out-of-band ticket close | reconcile explicitly; never assume accepted |
| blocked/deferred open descendant | block goal completion unless user excludes it |
| path overlap | advisory notice only |
| shell write invisible | no prevention claim |
| policy/profile changes mid-goal | hash mismatch latches attention; user may adopt on resume |
| Beadwork interrupt control ack times out | record `interrupt-pending` attention; issue no permits; do not claim halted |
| crash/drift between `bw close` and commit record | reconcile prepared saga by close token; safe reopen or attention |
| legacy `in_progress` lacks canonical assignment | block native dispatch until explicit migration |

---

## 19. Test strategy

The redesign needs unit, race, integration, and full-workflow coverage.

### 19.1 Minions lifecycle tests

- `orchestrate` accepts in TUI/RPC and rejects print/JSON;
- return occurs before child startup/completion;
- autonomous semantic-key recomputation rejects fresh-nonce duplicate effects and enforces the effect-record ceiling;
- nontransactional partial startup preserves successful handles;
- report, wait, mail-boundary, abort, timeout, and startup/halt races have one winner;
- the runtime composes rather than overwrites any existing `shouldStopAfterTurn` hook;
- duplicate reports and report+wait conflicts are rejected;
- typed task without report becomes partial/protocol-invalid;
- intermediate tool error may recover, while final prompt/provider failure fails;
- duplicate work item and duplicate goal group are registry-wide rejections;
- quiescence does not close a group;
- explicit close rejects later dispatch;
- normal close rejects non-quiescent groups; halt fences ingress, drains/disposes all children, and emits `group-closed` exactly once after disposal;
- session/group/autonomy ceilings latch attention and only a real user command resumes;
- closing/creating groups or supplying later `limits` cannot reset/widen session counters or authorization epochs;
- child runtime/wait totals accumulate across mail epochs and do not reset on resume;
- cooperative abort grace expiry records unresponsive and fences callbacks.

### 19.2 Session-generation and shutdown races

- parent `/new`, `/resume`, `/fork`, reload, and quit invalidate old callbacks/events;
- shutdown during startup, active prompt, wait, and mailbox restart;
- `AgentSessionRuntime.dispose()` emits child shutdown;
- deliberately hung child shutdown handler triggers bounded force-dispose;
- unmanaged/unresponsive work cannot mutate registry after fencing;
- stale extension listeners and protocol probes are removed.

### 19.3 Parent delivery and protocol-seam tests

- `{triggerTurn: true, deliverAs: "followUp"}` works across idle/streaming transition races;
- progress coalesces while terminal/wait/attention remains;
- packet size and event retention are bounded;
- no retry/ack guarantee is asserted;
- duplicate/reordered packets cannot duplicate effects because operation IDs/preconditions are idempotent;
- malformed, stale-generation, unknown-version events are rejected;
- sequence gap marks projection stale and snapshot response repairs it;
- Minions absent/version skew makes `/bw run` preflight fail;
- user/autonomous message race remains recoverable.
- assignment-permit register/revoke and user-control request/ack channels reject stale, duplicate, wrong-goal, and unacknowledged requests;
- revoke/consume races return `revoked-unused` or `consumed-fenced` and never leave a detached starter live;
- tests document that Pi events authenticate no sender and loaded parent extensions remain trusted.

### 19.4 Direct messaging tests

- child and parent sends are same-group, identity-authenticated, and nonblocking;
- cross-group, forged sender, terminal-pending, closed-group sends reject;
- active recipient mail stops at a safe boundary and starts one next run;
- report wins against queued mail; waiting child may restart exactly once;
- parent reply correlation works;
- queue byte/depth/rate/TTL limits and expired outcomes work;
- simultaneous messages do not start concurrent prompts;
- post-hook/pre-resolution mailbox race cannot strand accepted mail;
- waiting/running restart failure emits one terminal event and disposes the runtime;
- logical wait cycle emits attention without synchronous deadlock.

### 19.5 Capability and trust tests

- child cannot see orchestration, group-control, Beadwork close/accept, or override tools;
- role/child extension cannot grant or dynamically re-register a denied tool;
- required protocol tools remain available;
- role prompt cannot replace runtime safety prompt;
- child/peer content cannot inject a task nudge or identity;
- policy/profile/config hash drift latches attention;
- a model tool call cannot mint a user override/resume token;
- a goal task cannot select a role/model/profile outside frozen `allowedRoles`;
- shell caveat is documented and inherited trust policy is applied.
- a domain group rejects every task without a valid ticket/activity permit; permitless generic work must use another group;

### 19.6 Beadwork record and assignment tests

- machine history records are versioned, idempotent, superseding, and cache-rebuildable;
- goal preflight checks epic, cwd/branch, Minions handshake, policy, and conflicts;
- kickoff retry is idempotent;
- concurrency barriers prove the short goal lock serializes `/bw run`, crash-stale recovery checks PID/start identity, and no loser issues permits;
- assignment handles every issue state and starts before orchestration;
- Beadwork assignment ID binds idempotently to Minions attempt/child/group IDs;
- stale goal/ticket revision tokens reject immediately before assignment/acceptance effects;
- assignment permits are exact and single-use; missing, replayed, wrong-ticket, or wrong-policy permits reject;
- one assignment/attempt/child cannot bind to a second counterpart or wrong work item;
- prepared-but-unbound reconciliation affects only its own canonical record;
- consumed-but-unbound assignment binds the unique snapshot match or fences/drains before reopen; unknown/conflict enters attention;
- ticket-review, scope-review, investigation, and validation-child activities bind subjects without mutating ticket status;
- fix work may supersede only terminal canonical ticket work;
- same-session duplicates reject; simulated cross-session race chooses canonical history order and fences loser;
- all close/update entry points route through the goal guard;
- fresh-nonce duplicates cannot repeat autonomous scheduling, messaging, disposition, acceptance, or close effects;
- child completion alone never closes a ticket.

### 19.7 Evidence and review tests

- commit attribution uses assignment baseline, ticket references, derived paths, and patch IDs;
- non-ancestor, merge, mixed-scope, duplicate-claim, and rewritten evidence route correctly;
- partial/blocked/failed/aborted/unresponsive attempts cannot normally accept;
- ticket and scope reviewers receive exact immutable object manifests;
- exact-tree review invalidates on any later commit, while proven dependency-set review tolerates only drift outside changed/dependency entries;
- wrong subject/reviewer assignment/attempt/policy and incomplete review entry manifests reject;
- deletion tombstones and executable/symlink/submodule mode drift invalidate affected review;
- occurrence and family finding IDs deduplicate across generations correctly;
- blocking `file` is rejected without user waiver/reclassification;
- fix triggers new assignment, re-review, and applicable revalidation;
- filed follow-up scope placement affects completion as defined;
- scope fix reopens/invalidates or creates mandatory in-scope work;
- review/attempt ceilings latch attention.
- review exhaustion stops assignment permits without latching the generic runtime group;
- ticket/epic acceptance sagas survive faults before close, after close, after reread, and before commit without false success;
- explicit interrupt/abandon waits for runtime fence/drain ack; timeout remains attention, never false halted success;

### 19.8 Validation tests

- old landing command list migrates once to repository commands;
- child validation claims cannot satisfy acceptance;
- official records capture command-policy hash, exact tree, output, and before/after state;
- command, environment, executable/toolchain, lockfile/config, or policy drift invalidates the validation manifest;
- validation launches with an allowlist-only effective environment and records PATH, locale, timezone, shell options, executable hashes, and keyed secret hashes;
- repository validation requires quiescent clean workspace;
- mid-command HEAD/index/tracked/untracked change discards the run;
- one exact-tree record may cover a candidate wave;
- path-scoped command requires declared dependency closure and invalidates on covered drift;
- timeout/failure routes to remediation or attention;
- final scope tree receives repository validation.

### 19.9 Full epic integration tests

Use deterministic temporary Git/Beadwork repositories, scripted parent turns, controlled AgentSessions, concurrency barriers, and real commit/dirty-state mutations.

The default ticket-policy fixture proves:

1. epic with parallel and dependent tickets;
2. goal preflight/kickoff and one explicit open group;
3. two shared-branch implementation children;
4. advisory overlap plus peer/parent messaging and one wait/restart;
5. assignment binding and structured evidence persistence;
6. one clean ticket review and one with fix/file/reject findings;
7. fix assignment and re-review;
8. quiescent exact-tree repository validation covering a wave;
9. ticket acceptance unlocks dependencies only after the gate;
10. recursive final completion and explicit group close;
11. group closure event occurs only after every child runtime is terminal and disposed;
12. no tmux, managed worktree, landing, supervisor, worker registry, or old worker tool path.

A separate scope-policy fixture accepts tickets without ticket reviewers, builds one immutable scope subject, exercises scope remediation, reruns final review/validation, and closes the epic. It does not ambiguously combine both policies.

### 19.10 Compatibility tests

- foreground spawn remains unchanged;
- delegate/worker-done tools are no longer registered, and migration docs/config diagnostics name their replacements;
- exact JSON and environment migration table is enforced;
- malformed/removed/conflicting config reports all actionable errors;
- validation commands are not duplicated across phases;
- stale worker records are diagnostics only.
- existing `maxContextChars` input normalizes to `maxArtifactChars`, with the latter winning conflicts;
- every unowned legacy `in_progress` migration choice is explicit, idempotent, and blocks unsafe adoption.
- active legacy processes and dirty/unmerged legacy worktrees hard-block cutover.

### 19.11 Repository quality gates

Every implementation phase must pass:

```sh
npm run lint
npm run test
npm run typecheck
```

The cutover also requires `npm run build` and a manual TUI smoke test.

---

## 20. Implementation sequencing

The implementation may be developed in phases, but Phases A-D form one cutover train. Do not publish a Beadwork release that removes tmux before the full in-process epic test passes, and do not publish a release that retains tmux as fallback after cutover.

### Phase A — Prove runtime lifecycle and safety

- refactor child creation around `AgentSessionRuntime`;
- prototype bounded shutdown, hung-handler force-dispose, and session-generation fencing;
- add persistent-host mode gate;
- add explicit group/quiescence/close and child state reducers;
- add capability/extension allowlists and session-wide ceilings;
- preserve foreground spawn.

**Exit:** lifecycle, shutdown, mode, capability, race, and foreground compatibility tests pass. This phase resolves the safety release gates before broad implementation.

### Phase B — One-ticket vertical slice

- add `orchestrate` registration and operation idempotency;
- add one typed implementation result and one bounded parent packet;
- add protocol probe/hello/event schemas;
- add Beadwork durable goal/assignment/binding/evidence records;
- add the short repository-local goal lock, revision tokens, ticket-work permits, acknowledged revoke/fence, and recoverable start/close sagas;
- complete one ticket under `review.policy: "none"` with official validation and guarded acceptance;
- prove interruption/reconciliation.

**Exit:** one real Beadwork ticket runs in-process from `/bw run` through accepted close with no tmux, worker registry, polling, or landing path.

### Phase C — Full V1 workflow semantics

- add all task types and nudge policies;
- add wait/mail-boundary direct messaging and parent reply;
- add advisory path coordination and Minions fleet UI;
- add immutable ticket/scope review subjects;
- add subject-bound auxiliary activity permits for review/investigation/validation children;
- add finding family/occurrence IDs and fix/file/reject handling;
- add exact-tree validation wave behavior;
- add review/attempt/attention ceilings and user-only overrides;
- add recursive goal completion and Beadwork goal TUI.

**Exit:** messaging, security, evidence, review, validation, autonomy-limit, and both policy-specific epic fixtures pass.

### Phase D — Single cutover and deletion

- delete old delegate/worker-done tools rather than shim them;
- delete tmux, worker registry, managed worktree, landing, and supervisor paths;
- simplify `orchestrator.ts` into goal modules;
- enforce field-by-field config/environment migration;
- migrate docs/tests/TUI labels;
- run full epic integration tests, lint, test, typecheck, build, and manual TUI smoke test.

**Exit:** no production Beadwork path invokes tmux or managed worktrees; full epic workflows succeed and old worker APIs produce migration guidance only.

### Phase E — Later extensions

Only after V1 is stable:

- more task types;
- multi-epic goals;
- optional stricter approval policies;
- optional durable external execution;
- richer path-intent inference;
- optional managed workspace adapters.

These are not V1 prerequisites.

---

## 21. Non-goals

V1 does not provide:

- durable workers across process death;
- exactly-once parent message consumption;
- a distributed ticket lease;
- cross-process peer messaging;
- OS-level sandboxing;
- hard file locks;
- automatic worktree creation or landing;
- hidden deterministic ticket scheduling;
- unlimited autonomous review/remediation;
- proof that shell writes are observed.

These exclusions are deliberate and should remain visible in user documentation.

---

## 22. Primary risks and mitigations

### Risk: idle is mistaken for success

Mitigation: explicit report/wait protocol, separate session and task states, typed tasks without reports become partial.

### Risk: background child extensions leak resources

Mitigation: own `AgentSessionRuntime`, await bounded runtime disposal, force bare-session disposal for a hung handler, fence callbacks, and constrain extension loading.

### Risk: parent gets duplicate, late, or misordered updates

Mitigation: session-generation fencing, runtime-validated sequences, bounded queues, snapshot repair, source-derived semantic effect keys, and idempotent domain effects. Do not claim delivery acknowledgement.

### Risk: direct messaging deadlocks the runtime

Mitigation: nonblocking mailbox submission, no synchronous reply waits, single-flight recipient restart, bounded queues/timeouts.

### Risk: role or child content escalates authority

Mitigation: code-owned task policy, capability intersections, parent-only tools, prompt separation, child/peer data treated as untrusted.

### Risk: shared-branch review examines the wrong code

Mitigation: immutable evidence/review subjects, reported commit ancestry, OID/absence/mode entry manifests with conservative exact-tree fallback, and dirty-path acceptance guard.

### Risk: Beadwork closes work before review

Mitigation: derive readiness from durable records, centralize all status transitions behind one goal guard, and make exceptional bypass a user-only one-shot capability.

### Risk: validation disappears with landing code

Mitigation: migrate it to goal validation configuration before deleting landing.

### Risk: two sessions launch the same ticket

Mitigation: durable assignment records, session-wide duplicate rejection, deterministic canonical-history reconciliation, immediate loser fencing, and explicit acknowledgement that V1 has no distributed lease.

Concurrent goal intents are serialized by a short same-host Git-common-dir critical section before either session may issue a permit. The lock is released immediately after ownership mutation and is not a long-lived mission lease.

### Risk: autonomous loops run away

Mitigation: session and group ceilings, Beadwork attempt/review limits, autonomous turn/wall-time budgets, attention latch, and user-only resume.

### Risk: migration strands users

Mitigation: major-version cutover, explicit compatibility matrix, deterministic config migration, full epic test before release, no silent backend selection.

---

## 23. Remaining implementation questions

The architectural release gates are settled. Implementation planning should still choose and document:

1. exact default numeric values for session/group ceilings, abort grace, mailbox limits, and packet retention;
2. the default resolved child-extension allowlist;
3. the concrete machine-comment serialization and maximum Beadwork record size;
4. the one-shot user override token's CLI syntax and expiry;
5. the role metadata file syntax for advisory `completion_nudge`;
6. the default reviewer role and exact mapping for ambiguous old reviewer settings;
7. which language/build graph resolvers may emit `dependency-set` review coverage in V1 (all others fall back to exact-tree);
8. the fixed validation environment and default inherited-variable allowlist;
9. the cross-platform atomic-directory lock implementation and supported local filesystem probe;
10. whether optional generic (non-Beadwork) decision notes remain process-local or are omitted from V1.

These are bounded implementation choices, not unresolved ownership or lifecycle architecture. None requires tmux, automatic worktree management, or a hidden scheduler.

---

## 24. Final recommendation

Proceed with the redesign as a coordinated major-version cutover.

The core architectural rule is:

> Minions owns live agent execution and communication; the parent model owns orchestration decisions; Beadwork owns domain acceptance.

The design is only sound if implementation preserves the distinctions this audit made explicit:

- Pi settlement is idle, not success;
- post-turn control, report/wait/mail latches, and terminal state have one winner;
- runtime completion is evidence, not ticket acceptance;
- child runtimes and parent deliveries are fenced by session generation;
- direct messaging is nonblocking, externally queued, and bounded;
- task types are code-owned workflow contracts;
- role/policy snapshots are advisory and capability-limited;
- shared-branch review binds to immutable Git evidence;
- official validation binds to an exact repository tree;
- Beadwork workflow records are durable and idempotent;
- exceptional overrides/resumes are user-only;
- no compatibility path silently revives tmux.

With those constraints, the result is substantially simpler than the current worker subsystem while still supporting autonomous, multi-agent, end-to-end epic execution inside Pi.
