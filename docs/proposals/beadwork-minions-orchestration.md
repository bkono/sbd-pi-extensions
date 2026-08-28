# Beadwork and Minions Orchestration

**Date:** 2026-08-28
**Status:** Baseline proposal. This is the single living spec.
**Scope:** `packages/pi-minions` + `packages/pi-beadwork-extension`
**Supersedes:**
- `docs/proposals/beadwork-minions-mission-control.md` (first pass; retained as history)
- `docs/proposals/beadwork-minions-native-orchestration.md` (second pass; deleted)

## Executive recommendation

Move orchestration mechanics into `pi-minions`. Reduce `pi-beadwork-extension` to a domain adapter for goals, tickets, metadata, and beadwork-specific tools.

Two contracts:

> **Creation metadata selects the parent nudge. Child output is unstructured evidence. The parent model judges and acts.**

> **Role selects behavior; task type selects workflow guidance; beadwork supplies domain context; minions owns live orchestration mechanics.**

Concretely:

1. Replace beadwork's tmux worker runtime with non-blocking, in-process Pi child sessions owned by `pi-minions`. Do not improve, preserve, or require tmux.
2. Keep child lifetime tied to the parent Pi process. Parent exit may kill children. No detached execution, restart recovery, leases, or orchestration journal.
3. Keep foreground `spawn`. Add a distinct `orchestrate` tool that returns handles immediately and reports later through coalesced parent packets.
4. Carry orchestration metadata on spawn/orchestrate: dynamic `role`, optional closed `taskType`, short `description`, optional domain fields (`source`, `scopeId`, `workItemId`, `title`). Minions stores and echoes this metadata. It does not interpret ticket semantics.
5. `taskType` selects deterministic lifecycle nudge text for the parent. No task type → role fallback nudge if present → generic nudge. Nudges never close tickets, spawn work, or adjudicate findings.
6. Child output is not schema-validated. A handoff shape may be encouraged in prompts. It is never enforced. There is no child result protocol tool.
7. Each meaningful child lifecycle change reaches the parent as one model-visible packet: the changed child, a snapshot of still-running children, and the selected nudge.
8. Deliver packets at a safe boundary. Never inject into an active parent turn. If the parent is idle, a coalesced packet may start a turn so an epic can continue unattended.
9. Direct agent-to-agent messages do not route through the parent. Path intent and overlap notices are advisory only.
10. Shared checkout is the default. A worktree or alternate cwd is an explicit user-supplied existing workspace on the group, never chosen by the runtime.
11. Per-ticket independent review is the beadwork default. The parent model adjudicates findings. Consequential decisions are collected for the final handoff rather than interrupting ordinary execution for approval.
12. Prove one epic end to end. Represent scope as `scopeIds: string[]` so multiple epics can be added later without changing minion mechanics.

The durable source of truth remains beadwork. The live orchestration runtime remains process-local.

---

## Lineage

The first pass (`beadwork-minions-mission-control.md`) established the product constitution: kill tmux, minions owns mechanics, beadwork becomes a goal adapter, parent model retains judgment, coordination is advisory, role is open, task type is closed.

The second pass (`beadwork-minions-native-orchestration.md`) correctly audited Pi APIs (settled vs `agent_end`, `sendMessage` follow-up, child shutdown, `print`/`json` host lifetime) and then overbuilt a workflow engine around those insights: typed result schemas, child report/wait tools, assignment permits, bind sagas, revision-token CAS, disk locks, machine-record protocols, and review-subject manifests.

This baseline keeps the constitution and the API insights. It discards the workflow engine. Future work must not reintroduce the rejected machinery named in **Do not**.

---

## Locked decisions

These are constraints, not prompts for re-litigation.

1. **Distinct tools.** `spawn` stays foreground and blocking. `orchestrate` is non-blocking, returns handles, and reports later through packets. They share session-creation machinery. They do not share return semantics.
2. **Metadata is the integration contract.** Domain context is data on the child record. Beadwork tools remain ordinary parent tools (`bw start`, close, comment, ready). There is no assignment permit, bind step, or semantic `operationId` protocol.
3. **Nudges, not schemas.** `taskType` / role / generic fallback choose parent instruction text. Child text is evidence. No `protocolStatus`, no required `SubmittedTaskResult`, no `minion_report_result`.
4. **Settlement is idle, not success.** A child is terminal after the Pi session is settled, aborted, or failed. That is not ticket acceptance.
5. **Turn ordering.** Never inject into an active parent turn. Coalesce pending updates into one packet. If the parent is idle, that packet may `triggerTurn`. Unattended epic continuation is the feature. A rare idle-vs-idle collision with a user submit is accepted. V1 does not detect compose-buffer state and does not build a user-priority queue.
6. **One cwd per group.** Set at group creation (default: parent cwd). Must already exist. Immutable for the group's life. No per-task override. Runtime never creates, switches, lands, or deletes worktrees.
7. **Advisory coordination only.** TTL path intent and overlap notices warn and suggest communication. They never lock, pause, reject writes, or claim safety.
8. **No real locks.** Two Pi sessions in one repo is best-effort, same class as two agents on one branch. No git-common-dir mutex, no mission lease, no PID-reclaim protocol.
9. **Review policy is beadwork's.** Default `ticket`; also `scope` and `none`. Independent review before close is the default. `file` is for nonblocking follow-up; blocking findings stay `fix` or `reject` unless the user explicitly waives. This lives in nudge text and beadwork policy, not in a parser of child JSON.
10. **Children are capability-limited, not sandboxed.** Orchestrated children do not receive `orchestrate`, `spawn`, group halt, or beadwork close/accept tools. Shell can still do damage. Parent refreshes authoritative `bw` state before acceptance. V1 does not claim OS isolation.
11. **`orchestrate` requires a persistent host.** Supported in Pi `tui` and `rpc`. Rejected synchronously in `print` and `json`, which dispose the parent after the prompt.
12. **One epic for V1.** `scopeIds` is an array; V1 validates exactly one epic.

---

## Do not

Do not reintroduce any of the following. They were considered in the native pass and rejected.

- Child result / exit protocol tools (`minion_report_result`, `minion_wait`, `protocolStatus`, typed handoff enforcement, `partial` because a tool was forgotten).
- Assignment permits, `beadwork_bind_attempt`, three-step prepare/orchestrate/bind sagas.
- Semantic effect keys, revision-token CAS, start/close sagas (`accept-prepared` → `bw close` → `accept-committed`).
- Git-common-dir or other disk locks for goal ownership.
- Machine-record protocols stuffed into `bw comment` as an orchestration log.
- Immutable Git review-subject manifests, OID/mode dependency graphs, or `dependency-set` coverage modes.
- Official validation identity based on executable hashes, locale/PATH/toolchain hashing as acceptance inputs.
- Attention latches the model cannot clear, one-shot resume tokens, or `completionToken` gates on group close.
- Versioned `pi.events` handshake (`minions:v1:probe`, permit register/revoke, user-control ack) as the integration fabric.
- Frozen `allowedRoles` profile-hash snapshots as a V1 dispatch requirement.
- Four classes of resource-limit lifetime, effect-record ceilings, or a Temporal-style reducer in minions.
- Tmux fallback, worker-registry shims, or wrapping `orchestrator.ts` instead of deleting the worker runtime.
- Automatic worktrees, landing, rebase, or merge-back.
- Detached children, durable mailboxes, exactly-once parent delivery, or replay of live orchestration across process death.
- A closed enum of roles.
- A second issue graph inside minions.
- Concatenating role guidance onto task-type guidance.
- Treating settlement, a typed workflow, or a child handoff as ticket acceptance.

**Deprecated:** beadwork tmux/worker/landing/supervisor runtime, `beadwork_delegate`, `beadwork_worker_done` as process control.
**Replacement:** minions `orchestrate` + beadwork goal/domain tools.
**Status:** delete at cutover, not later, and not behind a compatibility façade.

---

## 1. Normalized feature intent

### Desired workflow

A parent Pi session delegates several related tasks without blocking, stays interactive, and receives enough context to make the next orchestration decision when a child changes state.

For every completion, failure, or parent-directed child message, the parent should know:

- which child changed;
- what it was asked to do (`description`);
- which role and task type it used;
- what it said (unstructured evidence);
- which other children are still running;
- which workflow-specific judgment the nudge is asking for.

The same mechanics work for beadwork tickets, a one-off code task, a review, or a future domain adapter. Beadwork is a client of minions, not a second runtime.

### Hard constraints

- **No tmux.** First integrated replacement uses Pi child sessions directly.
- **No automatic worktrees.** User supplies an already-existing cwd if isolation is wanted.
- **Shared checkout is normal.** Improve awareness; do not pretend to eliminate conflicts.
- **Coordination is advisory.** Notices and messages only. No locks, pauses, or rejected edits.
- **Shared lifetime.** Parent crash may terminate children.
- **Models retain judgment.** Code selects context and nudge text. The parent evaluates evidence and chooses actions.
- **Roles stay open.** Prompt/template names are data.
- **Task types stay closed.** A task type exists only when lifecycle changes need a constrained parent instruction.

### Desired outcome

One orchestration implementation in `pi-minions`. Beadwork does not maintain a worker registry, polling supervisor, completion notification path, or process launcher. `/bw run <epic>` enters a domain-aware goal: beadwork supplies intent and the work graph; the parent model and minions drive live work.

---

## 2. Problem and success criteria

### Current problem

Two overlapping approaches exist today:

- `pi-minions` creates real in-process child `AgentSession`s, tracks them in `AgentTree`, exposes steer/abort, and persists transcripts, but `executeSpawn()` awaits `Promise.allSettled()`, so the tool is foreground/blocking.
- `pi-beadwork-extension` can launch work without blocking the parent, but does so through tmux, runtime marker files, polling, a separate worker registry, and beadwork-owned lifecycle logic. `orchestrator.ts` is a multi-thousand-line supervisor (`runBoundedEpicLoop`). `beadwork_delegate` is explicitly tmux-backed.

Consequences:

1. Beadwork is unusable without tmux.
2. Foreground minions cannot be the shared backend because spawn blocks.
3. Two worker identities, status models, and completion paths.
4. UI toasts do not give the parent model the state and nudge it needs.
5. Minion completion is observed on `agent_end`, which is too early (retries, compaction, follow-ups).
6. Worktree/landing/tmux assumptions leak into ordinary shared-branch work.
7. Review classification and scheduling live inside beadwork orchestration instead of a reusable workflow nudge plus parent judgment.

### V1 success criteria

1. `orchestrate` returns a stable handle without waiting for child completion.
2. The parent remains available for user input and further tool calls while children run.
3. A child is terminal only after settled, aborted, or failed — not on premature `agent_end`.
4. Each meaningful lifecycle change yields one safe-boundary parent packet, not merely a UI toast.
5. The packet includes the changed child, a fresh snapshot of still-running orchestrated children, and the selected nudge.
6. Optional `taskType` deterministically selects that nudge.
7. Without a task type, role fallback or generic guidance applies.
8. Direct peer messages reach the addressed child without a parent turn.
9. The parent can inspect peer identities and communication metadata.
10. One beadwork epic can be implemented and reviewed through minions on a machine without tmux.
11. Shared checkout remains default; no worktree is created without explicit user input.
12. Overlap notices are informational.
13. Ticket review defaults to occurring before close; the parent model judges findings, not a keyword classifier.
14. Configured validation (lint, tests, typecheck by default) still gates accepted outcomes, as a parent/beadwork concern, not as a minions protocol.
15. Child output is accepted as prose. Missing a “handoff format” or result tool does not fail the child.

### Failure criteria

Implementation has failed if it:

- keeps tmux as required, fallback, or first milestone;
- adds detached children or requires survival after parent death;
- automatically creates or routes work to worktrees;
- blocks editing because of path intent or overlap;
- encodes roles as a closed union;
- lets role guidance override a provided task type;
- enforces a child result schema or exit tool;
- automatically accepts a ticket because a workflow completed;
- leaves beadwork and minions with separate live worker registries or duplicate model-visible completion messages;
- wakes the parent once per child when updates could be coalesced;
- injects an orchestration packet into an active parent turn;
- makes peer communication depend on parent mediation;
- introduces permits, bind sagas, disk locks, or effect-key CAS.

---

## 3. V1 scope, non-goals, and deferred scope

### In scope

- process-local, non-blocking `orchestrate`;
- preserved foreground `spawn`;
- settled/aborted/failed lifecycle;
- orchestration groups with one immutable cwd;
- role, task type, description, and domain metadata transport;
- deterministic nudge selection;
- safe-boundary packets and coalescing;
- idle autonomous continuation;
- direct addressed peer messaging;
- parent-visible communication metadata;
- advisory TTL path intent and overlap notices;
- one-epic beadwork goal mode;
- parent-judged review and `fix | file | reject` guidance;
- notable-decision collection for final handoff;
- removal of beadwork's tmux execution path.

### Explicit non-goals

Everything in **Do not**, plus:

- detached or daemonized children;
- restart-resumable live orchestration;
- durable message delivery;
- a mission event journal;
- automatic conflict remediation;
- a mail/IRC/SQLite/web coordination product;
- scripts that replace parent judgment;
- multi-host agent networking;
- OS-level sandboxing;
- proof that shell writes are observed.

### Deferred

- multiple epic scopes in one goal;
- custom task-type registration by third-party adapters;
- richer threads or broadcast channels;
- long-lived resumption after `/new` or process restart;
- historical analytics;
- automated ranking by dependency unlock value;
- remote or process-isolated minion backends;
- compose-buffer-aware turn ordering;
- observing path overlap from minions-managed edit tools, if cheap and still advisory.

---

## 4. Current repository context

### Confirmed `pi-minions`

- `packages/pi-minions/src/tools/spawn.ts` — `task` / `agent` / `model` or batch `tasks`; `executeSpawn()` awaits `Promise.allSettled()`.
- `packages/pi-minions/src/subsessions/manager.ts` — file-backed child `AgentSession`s, steer/abort handles, local event bus. Completion currently on `agent_end`. Child extensions bound with a no-op `shutdownHandler`.
- `packages/pi-minions/src/tree.ts` — process-local fleet registry (identity, agent, task, status, activity, usage, model, parent/child).
- `packages/pi-minions/src/agents.ts` — dynamic project/user agent discovery; `AgentConfig.name` is already an open role identity.
- `list_minions`, `show_minion`, `halt` already exist.

### Confirmed beadwork

- `packages/pi-beadwork-extension/src/orchestrator.ts` — tmux launch, polling, landing, review, remediation, worker lifecycle; `runBoundedEpicLoop` is a cycle supervisor.
- `types.ts` / `config.ts` — tmux pane fields, worktree, landing, supervisor polling.
- `beadwork_delegate` — tmux-backed worker launch.
- `beadwork_worker_done` — evidence + self-review + close/sync + shutdown.
- `bw.ts` already has the durable domain primitives: tickets, dependencies, readiness, comments, labels, history, scope, status transitions.

### Preserve

- in-process child sessions, not shell-out to another agent binary;
- agent role definitions in user/project prompt files;
- `AgentTree` as the live fleet registry (extended, not forked);
- Pi safe-boundary delivery (`sendMessage` follow-up), never mid-turn injection;
- `bw` as durable work-graph truth;
- explicit user-selected cwd;
- model judgment for decomposition, review, and adjudication.

### Remove

- tmux launch and inspection;
- process marker files and pane discovery;
- beadwork-owned live worker registry;
- polling as the child lifecycle mechanism;
- automatic landing for shared-branch work;
- runtime-selected worktrees;
- UI-only completion notices;
- regex-only review classification;
- worker completion implying ticket acceptance.

---

## 5. Core mental model

### Three owners

**`pi-minions` — orchestration mechanics**

- child session creation and lifetime;
- process-local identity and status;
- foreground `spawn` and non-blocking `orchestrate`;
- group membership and group cwd;
- role, task type, description, domain metadata transport;
- lifecycle observation (settled / aborted / failed);
- fleet snapshots, nudge selection, coalescing, parent packet delivery;
- direct messaging, steering, cancellation, inspection;
- advisory path intent and overlap notices.

Minions does not understand tickets, readiness, review policy, or acceptance.

**`pi-beadwork-extension` — domain context**

- activation and project detection;
- tickets, epics, dependencies, readiness;
- goal scope and epic intent;
- issue start, close, reopen, comment, label, dependency operations;
- beadwork metadata attached at orchestrate time;
- beadwork-specific prompt appendices;
- review and ticket-close policy;
- whether the selected epic is complete;
- durable comments and follow-up tickets.

Beadwork does not own child processes, a worker registry, fleet monitoring, completion delivery, peer messaging, or a generic orchestration loop.

**Parent model — orchestration policy**

- which work to start, which role and task type, how much concurrency;
- whether child output satisfies a ticket;
- finding dispositions;
- remediation, follow-up, rejection, escalation;
- when the goal is complete.

Deterministic code gives the parent the right state and the next question. It does not answer the question.

### The central distinction

- **Role:** how should this agent work?
- **Task type:** what workflow question should the parent ask when this child changes state?

Visible in types, prompts, UI, and tests. Never collapsed into one field.

---

## 6. Role contract

A role is an unrestricted string naming an agent prompt/template (`reviewer`, `hard_problem_coder`, `security_specialist`, or a project-specific name unknown at build time).

Foreground `spawn` keeps `agent` as the public selector for compatibility. `orchestrate` and fleet snapshots use `role`. Both resolve through the same profile loader.

A role may optionally define `completion_nudge` in frontmatter. That text applies only when no `taskType` is present.

```yaml
---
name: reviewer
description: Independently review completed work
completion_nudge: Assess the feedback against the task and project intent; do not accept findings mechanically.
---
```

Unknown roles, and roles without guidance, are valid. They receive the generic nudge.

Role guidance is best effort. The same role may review a ticket, an epic, a design, or a one-off. It must not imply a guaranteed workflow transition.

---

## 7. Task-type contract

### Optional closed enum

`taskType` opts a child into known parent guidance. At the tool boundary it is a literal union so models see valid values and the runtime does not fuzzy-match.

```ts
export type TaskType =
  | "implementation"
  | "fix"
  | "reviewImplementation"
  | "reviewScope"
  | "investigateBlocker"
  | "validation";
```

Add a value only when a lifecycle change needs a meaningfully different parent instruction. Ordinary research, exploration, and untyped delegation omit `taskType`.

These names are workflow stages, not beadwork worker fossils, and not role names.

### Task type selects guidance, not capability

```ts
{ role: "hard_problem_coder", taskType: "fix", description: "Fix the race in completion delivery" }
```

The role shapes how the child works. `fix` tells the parent, on settlement, to verify and send the change through independent re-review.

```ts
{ role: "security_specialist", taskType: "reviewImplementation", description: "Review BW-123 authentication changes" }
```

The child uses a security prompt. Settlement still invokes the generic finding-adjudication nudge.

```ts
{ role: "reviewer", description: "Review the registry refactor" }
```

No task type → reviewer fallback nudge, not the stronger `fix | file | reject` contract.

### Nudge precedence

1. If `taskType` is present, use that policy text.
2. Else if the resolved role defines `completion_nudge`, use it.
3. Else generic: “A background task settled. Inspect its result and decide the next action.”

Do not concatenate role guidance onto task-type guidance. Per-spawn task text is evidence, not a nudge override.

Policies may vary by lifecycle event (`completed`, `failed`, optional `blocked` when a parent-directed child message arrives). They remain strings.

| Task type | Completion nudge intent |
| --- | --- |
| `implementation` | Assess the evidence. Apply the active domain validation/review policy. Accept, dispatch a fix, or ask the user. Do not close a ticket solely because the child settled. |
| `fix` | Verify the fix against the original finding. Send the changed behavior through independent re-review before acceptance. |
| `reviewImplementation` | Disposition every finding as `fix`, `file`, or `reject`. Blocking findings require `fix` or `reject` unless the user waives. `file` is for nonblocking follow-up. Persist rationale. Unresolved required fixes block acceptance. |
| `reviewScope` | Adjudicate cross-ticket findings and judge whether the goal meets acceptance criteria. |
| `investigateBlocker` | Apply the answer to blocked work, or record why escalation remains necessary. Investigation completion is not implementation completion. |
| `validation` | Address failures, or record that the validation gate passed with evidence. Child-claimed command output is not official acceptance. |

Nudges instruct. They do not close, spawn, accept, or disposition automatically.

### Child output is unstructured

Encourage children, in the prompt, to report summary, commits, validation, blockers, and follow-ups. Do not validate that shape. Do not fail settlement if they paste prose. Beadwork reconstructs what it needs from Git and `bw` when the parent decides to record or accept.

This is the standing contract, not a temporary gap waiting for schemas.

---

## 8. Spawn and orchestrate

### Foreground `spawn`

Unchanged product behavior: start children, wait, return results to the current tool call. Keep `agent` for compatibility. Internally reuse the same session factory as `orchestrate`.

### `orchestrate`

Starts one or more children, registers them in a group, returns handles immediately. Later events arrive as parent packets.

```ts
interface OrchestrateInput {
  groupId?: string; // omit on first call to create a group
  cwd?: string;     // group creation only; default parent cwd; must already exist
  tasks: OrchestratedTaskDescriptor[];
}

interface OrchestratedTaskDescriptor {
  task: string;          // complete child prompt
  description: string;   // short fleet-readable summary; do not infer from `task`
  role?: string;
  taskType?: TaskType;
  model?: string;
  domain?: {
    source: string;      // e.g. "beadwork"
    scopeId?: string;    // e.g. "EPIC-10"
    workItemId?: string; // e.g. "BW-123"
    title?: string;
  };
}

interface OrchestrateResult {
  groupId: string;
  accepted: Array<{ childId: string; description: string; state: "starting" }>;
  rejected: Array<{ index: number; reason: string }>;
}
```

Requirements:

- Return after registration, not after session startup or completion.
- Batch startup may be partial: preserve successful handles, fail the rest clearly.
- The tool call's `AbortSignal` cancels registration, not the children. Child lifetime belongs to the group.
- Reject in `print` and `json` hosts.
- `domain` is opaque transport. Minions does not parse ticket IDs.
- First call may create the group. Later calls name `groupId`. There is no separate “begin orchestration” scheduler.
- A group has exactly one cwd. Later `cwd` mismatch rejects. Tasks cannot override it.

Optional in-process duplicate guard: reject a second **live** child with the same `domain.workItemId` in this parent process. That is a convenience, not a distributed lock, and not a permit system. Cross-session doubles are a user problem.

### Process lifetime

Children are background relative to the parent turn, not detached from the process.

- Parent `session_shutdown` (quit, `/new`, resume, fork, reload) aborts and disposes active children. Own a real child runtime so shutdown is not a no-op handler on a bare session.
- No continuation after process death.
- Persisted transcripts may remain inspectable. They are not live children and must not be shown as running after restart.
- Beadwork tickets remain durable. A later session inspects `bw` and decides whether to restart work.

No heartbeats, recovery leases, replay logs, or generation-token protocols. Shutdown abort is hygiene, not a distributed session-generation CAS.

---

## 9. Parent packets and turn ordering

### Packet contents

One structured model-visible packet with three sections.

**1. What changed** — child id, role, task type, description, domain metadata, new status, and the child's output/error (bounded; full transcript via `show_minion`).

**2. Current fleet** — every still-running child in the group: id, role, task type, description, state, optional elapsed time and latest activity.

**3. Next instruction** — the nudge selected by precedence.

```text
Orchestration update

Changed:
- mn-12 settled
- role: security_specialist
- taskType: reviewImplementation
- task: Review BW-123 authentication changes
- output: (bounded child text)

Still running:
- mn-13 [hard_problem_coder / fix] Fix token refresh race
- mn-14 [general_coder / implementation] Add session expiry tests

Required judgment:
Disposition every finding as fix, file, or reject. Blocking findings require
fix or reject unless the user waives. Do not accept BW-123 while a required
fix remains unresolved.
```

Separate runtime nudge text from untrusted child output in the packet so the child cannot overwrite the instruction.

### What counts as a parent-waking event

- child settled, aborted, or failed;
- child → parent message (question/blocker); the child keeps running and can be steered.

Progress, peer messages, and path notices update TUI / inspection surfaces. They do not, by themselves, start a parent turn. Repeated unresolved overlap may be included as metadata on the next real packet, not as a spam wake.

### Delivery and turn ordering

Pi `sendMessage` with `{ triggerTurn: true, deliverAs: "followUp" }` is the delivery mechanism.

Locked behavior:

1. **Never inject into an active parent turn.** `followUp` waits until the current turn finishes. Do not use `steer` for orchestration packets.
2. **Coalesce.** If several children change while the parent is busy, send one packet with every change and one fresh fleet snapshot.
3. **Idle continuation is allowed.** If the parent is idle, the coalesced packet may start a turn. That is how `/bw run` proceeds when the user is not babysitting.
4. **Do not wait for an unsent keystroke.** Compose-buffer detection is out of V1.
5. **Idle-vs-idle user submit vs packet** is accepted. Pi orders it. Do not build a priority queue.
6. A UI toast may accompany the packet. It cannot replace it.
7. Consume each coalesced packet once in-process so the same events do not start duplicate turns.

This is “safe-boundary delivery + idle continuation.” It is not “user always wins” and not “autonomous always wins.”

---

## 10. Direct agent communication

Process-local, best effort. Inspired by useful parts of agent hubs, without adopting their infrastructure.

Agents can:

- list peers in their group (id, role, task type, description, state);
- send an addressed message to a peer;
- send a message to the parent (this *is* a parent-waking event, coalesced);
- announce advisory path intent with a TTL;
- inspect current path intent.

Rules:

- Same group only. No broadcast in V1. No cross-session delivery.
- Sender identity is attached by the runtime, not supplied by the child.
- Send returns immediately. The sender never waits for the recipient's model turn.
- Peer delivery uses the child's session handle at a safe child boundary (steer/follow-up into the child). Failed delivery is reported to the sender; it is not silently rerouted through the parent.
- Peer messages do not start a parent turn. The parent can inspect metadata (`list_minions` / `show_minion` / a small message listing surface).
- Bodies are size-bounded. Queues are best effort; mailbox-full fails clearly.
- No durable mailbox, no exactly-once, no wait-for-reply tool, no child wait state machine.

Parent-visible does not mean parent-mediated.

---

## 11. Advisory workspace coordination

Agents normally share one cwd and branch. Make that legible. Do not impose isolation.

```ts
interface PathIntent {
  agentId: string;
  paths: string[];
  note?: string;
  expiresAt: number;
}
```

Path intent is advisory, TTL-expired, visible to peers and parent, never proof of ownership.

On overlap of declared (or, later, observed) paths:

1. notify the affected agents;
2. name the other agent and its description;
3. encourage a direct message;
4. surface overlap as parent-inspectable metadata;
5. continue.

The runtime must not reject edits, pause children, reorder work, create a worktree, require declarations before spawn, or claim undeclared shell writes are safe.

If the user wants isolation, they create a checkout/worktree themselves and pass that existing path as the group `cwd`. The runtime never selects it from heuristics.

---

## 12. Beadwork as a goal adapter

### `/bw run`

Enters a domain-aware goal. It does not launch a private fleet or a polling supervisor.

It should:

1. validate the target is an open epic with traversable descendants;
2. store goal scope and review/validation policy in ordinary session/beadwork state;
3. load prime/guidance into the parent prompt;
4. tell the parent to refresh `bw`, choose ready work, `bw start` when it assigns work, and `orchestrate` with domain metadata and the right `taskType`;
5. expose ready, blocked, and in-progress tickets through existing beadwork tools;
6. define ticket review, acceptance, and epic-completion policy in the prompt.

It should not create tmux panes, maintain a worker registry, poll processes, deliver a second completion channel, pick worktrees, own peer messaging, or run a hidden scheduler.

If two sessions both `/bw run` the same epic, V1 does not lock. Durable `bw` state is the recovery surface. The user inspects and continues. Same class as two agents on one branch.

### Domain metadata

```ts
{
  source: "beadwork",
  scopeId: "EPIC-10",
  workItemId: "BW-123",
  title: "Fix authentication refresh race"
}
```

The parent (not minions) is responsible for calling `bw start` before or as it dispatches, using ordinary beadwork tools. Implementation children should be told not to close tickets. The parent closes after it judges evidence.

### Evidence and acceptance

Child settlement is evidence, not acceptance. The parent refreshes Git and `bw`, then uses beadwork tools to comment, file follow-ups, or close.

Prompt-encourage handoff content (summary, commits, validation, blockers, follow-ups). Do not keep `beadwork_worker_done` as a shutdown or “done” tool — children will forget it, and minions already owns settlement. Delete it at cutover.

Acceptance remains a parent/beadwork decision. Configured repo validation still runs as a beadwork/parent action (existing lint/test/typecheck defaults), against current tree state, not as a child protocol claim.

### Review policy

```ts
type ReviewPolicy = "ticket" | "scope" | "none";
```

- `ticket` — default. Independent review before closing that ticket.
- `scope` — close individual tickets from evidence; independent review of the aggregate before declaring the epic complete. Dependents may start before aggregate review finds a problem. Say that tradeoff in config/docs.
- `none` — no automatic independent review.

The parent launches review children with `taskType: "reviewImplementation"` or `"reviewScope"` and the configured reviewer role. Adjudication is model judgment guided by the nudge. No keyword classifier.

Blocking finding → `fix` (remediate, re-review) or `reject` (record why). `file` creates durable follow-up and is for nonblocking work unless the user explicitly waives a blocking finding. That policy is prompt/nudge text plus parent use of beadwork tools. It is not a structured-result gate.

### Notable decisions

Autonomous by default. Collect consequential decisions for the final handoff (dispositions, scope expansion, rejected high-confidence review, security-sensitive actions). Beadwork may also persist important ones as ordinary ticket comments. No new approval gate on ordinary work.

### Epic completion

Minions quiescence is not epic completion. The parent judges from a fresh `bw` snapshot: in-scope descendants closed or explicitly excluded, no unresolved required fixes, validation policy satisfied. Then it closes the epic with beadwork tools. The user or parent may halt the minion group; group close is not gated on a domain completion token.

---

## 13. Capability boundary (light)

Background children expand blast radius. Keep this small.

Orchestrated children do not receive model-visible:

- `orchestrate` or `spawn`;
- group halt / close / cross-child abort;
- beadwork ticket close, epic close, or acceptance tools;
- worktree create/land/cleanup tools.

They may receive peer messaging, path announce, and ordinary coding tools allowed by parent policy ∩ role allowlist. Required communication tools are added, not used to smuggle parent capabilities.

This is a tool-visibility boundary. A child with shell can still `bw close` or destroy the checkout. Prompts should forbid domain closure and destructive shared-checkout operations. The parent must refresh `bw` before accept and treat out-of-band closes as something to notice, not something V1 can prevent.

Role metadata may request tools, model, and limits. It may not grant what parent policy denies.

---

## 14. Package and module changes

### `packages/pi-minions`

- `src/types.ts` — role, task type, group, domain metadata, messages, path intent, packet types.
- `src/tools/spawn.ts` — unchanged foreground contract.
- new `src/tools/orchestrate.ts` — non-blocking registration and handles.
- `src/spawn/*` and `src/subsessions/manager.ts` — share session factory; split start from wait; settled completion; real runtime dispose on shutdown; no `agent_end` terminal.
- `src/tree.ts` — canonical live registry with group/role/taskType/description/domain.
- new `src/orchestration/` — groups, nudge selection, coalescing, parent delivery.
- new `src/task-types.ts` — closed union and policy strings.
- `src/agents.ts` — optional role `completion_nudge`.
- new `src/messaging/` — peer directory, direct send, parent-message path, inspection.
- new `src/coordination/` — advisory TTL intent and overlap notices.
- commands/status/renderers — groups, task types, packets, messages.
- tests — lifecycle, delivery/coalescing, precedence, messaging, shutdown, no-schema settlement.

### `packages/pi-beadwork-extension`

- `src/index.ts` — drop worker runtime; keep domain tools, scope, prompts, goal mode.
- `src/prompt.ts` — run-to-completion goal policy and minion usage.
- `src/types.ts` / `src/config.ts` — remove tmux, supervisor polling, automatic landing, automatic worktree selection.
- `src/orchestrator.ts` — delete or strip to any remaining domain helpers. Do not wrap it.
- `src/tmux.ts`, worker markers, live `registry.ts` as execution truth — remove.
- `src/worktree.ts` — no scheduler calls. Delete managed lifecycle. User-supplied cwd only.
- `src/handoff.ts` — prompt context / evidence hints, not process shutdown.
- TUI — issue/goal views remain; worker land/cleanup actions go; link to minions fleet for live children.
- tests/e2e — replace tmux swarm with in-process minion + beadwork scenarios.

### Dependency direction

`pi-minions` must not import beadwork.

Beadwork may take a small public minions inspection/types dependency if that is the cleanest way to render goal UI from live child records filtered by `domain.source` / `scopeId`. It must not become a second parent-message path. Minions owns model-visible lifecycle packets.

No required event-bus handshake to activate a goal. If minions is absent, `/bw run` fails with a clear “install/enable pi-minions” message.

---

## 15. API surface

### Minions

| Surface | Behavior |
| --- | --- |
| `spawn` | Foreground, blocking, `agent` selector preserved. |
| `orchestrate` | Non-blocking. Metadata in, handles out. |
| `list_minions` | Include role, task type, description, group, domain, communication indicators. |
| `show_minion` | Full output, messages, path intent, activity. Canonical place for large text. |
| `halt` | Abort one child or a group. User/parent. Children do not halt peers. |
| `send_minion_message` | Parent → child, or (child tool) child → peer / parent. |
| `announce_minion_paths` | Advisory TTL intent. |

Keep the tool count small. Messaging and path announce may be combined only if semantics stay obvious.

### Beadwork

- `/bw run <epic>` enters goal mode (no supervisor loop).
- Existing issue CRUD, ready, start, close, comment remain.
- `beadwork_delegate` removed; parent uses `orchestrate`.
- `beadwork_worker_done` removed.
- Landing/worker inspection tools removed or replaced by domain views over minion state plus `bw`.

### Config cutover

Major-version cutover. No worker-shaped shims.

- Reject `tmux.*`, managed `worktrees.*`, `workerExecution.mode`, supervisor poll intervals, with actionable removal errors.
- Keep UI/session-cache knobs that are still meaningful.
- Migrate `landing.validateCommands` to ordinary goal validation commands (same default: lint, test, typecheck).
- Map review enabled/disabled onto `ticket` / `none` only when unambiguous; otherwise require a visible correction rather than guessing.
- Do not silently select a backend.

---

## 16. State and persistence

**Process-local (minions):** groups, child handles, pending packets, in-memory message queues, path TTLs, consumed notifications, optional notable-decision list for the session handoff.

**File-backed:** child session transcripts via existing Pi session files, for inspection only.

**Durable (beadwork):** issues, dependencies, comments, labels, history. No parallel orchestration log format.

**Parent death:** children die; in-memory messages and packets are lost; no takeover; next session treats prior runtime as interrupted; tickets are still in `bw`.

This is an accepted tradeoff, not a degraded implementation of detached durability.

---

## 17. Integration sequencing

No published beadwork release keeps tmux as fallback after cutover, and no published release removes tmux before an in-process ticket can run. Implementation may still land in slices.

### Phase A — Orchestration core in minions

- split child start from foreground wait;
- `orchestrate` handles, groups, one cwd;
- extend `AgentTree`;
- settled/aborted/failed;
- task-type union and nudge table;
- role fallback parsing;
- coalesced packets + idle continuation + no mid-turn injection;
- shutdown abort/dispose;
- preserve `spawn`.

**Exit:** generic orchestrated children run while the parent stays interactive; `fix` vs `reviewImplementation` produce distinct nudges regardless of role; a typed child that emits prose still settles successfully.

### Phase B — Beadwork cutover

- `/bw run` is goal context, not a tmux supervisor;
- domain metadata on orchestrated children;
- completion packets come only from minions;
- delete `beadwork_delegate` / `beadwork_worker_done`;
- remove tmux, polling, pane inspection, runtime markers, worker config;
- rewrite tmux e2e to in-process scenarios.

**Exit:** one ticket implement + optional review through minions without tmux; no production beadwork path references the old runtime.

### Phase C — Messaging and advisory coordination

- peer discovery and addressed messages;
- parent-directed child messages as coalesced wakes;
- TTL path intent and overlap notices.

**Exit:** two children notice overlap, message each other, continue; no parent relay; no lock.

### Phase D — One epic

- parent drives ready tickets through `orchestrate`;
- default ticket review;
- `fix | file | reject` as parent judgment;
- remediation via typed `fix` / re-review;
- notable decisions on the final handoff;
- configured validation still gates accept.

**Exit:** one epic reaches a verified outcome with a single live orchestration runtime.

### Phase E — later

- scope-level review mode polish;
- multi-epic `scopeIds`;
- optional observed path overlap from edit tools;
- nothing in **Do not**.

---

## 18. Error handling

| Failure | Behavior |
| --- | --- |
| Invalid descriptor / unsupported host | Synchronous reject. |
| Partial batch start | Keep successful handles; fail the rest. |
| Child fails to start | Terminal failed; packet with error. Do not report a running handle as success. |
| Child dies early | Distinguish aborted vs failed vs settled. Apply failure nudge if typed. Keep partial output. |
| Parent busy, several children finish | Coalesce; one fleet snapshot. |
| Peer unavailable | Clear delivery failure to sender; inspectable metadata; no parent reroute. |
| Path TTL expires | Drop the notice. Do not infer the agent stopped touching the path. |
| Same file, two editors | Warn if known. Do not block. |
| Parent exits | Children may die. Packets/messages lost. `bw` survives. |
| Task type vs role disagree | Task-type nudge wins. Show both values. |
| Review output is messy prose | Parent asks, re-reviews, or rejects claims. No classifier. |
| Child forgets any handoff format | Still settled. Parent reads the text and Git. |
| Two sessions `/bw run` one epic | No lock. User/model reconcile from `bw`. |
| Child `bw close` via shell | Parent refresh should notice. V1 cannot prevent it. |

---

## 19. Testing strategy

### Minions unit

- task-type schema accepts only known values; role accepts arbitrary strings;
- nudge precedence: task type > role > generic; no concatenation;
- `AgentTree` preserves group, role, task type, description, domain;
- fleet snapshots include all and only running group children;
- coalescing is deterministic; consumed packets do not double-wake;
- TTL intent expires without blocking;
- overlap creates notices, never enforcement;
- messages preserve sender/recipient; missing peers fail clearly;
- prose-only typed child still settles (no schema failure).

### Minions integration

- `spawn` still blocks and returns results;
- `orchestrate` returns before completion; rejected in print/json;
- parent interactive while children run;
- settlement is not emitted on premature `agent_end`;
- abort/failure terminal states;
- several near-simultaneous completions → one packet;
- packet not delivered as `steer` into an active turn;
- idle parent + packet → turn starts;
- peer messages at a safe child boundary without a parent turn;
- child → parent message is included in a packet;
- parent shutdown does not leak runnable children;
- stale transcripts are not shown as live after restart.

### Beadwork integration

- `/bw run` sets goal context without tmux or a polling supervisor;
- descriptors carry ticket/epic metadata;
- settlement does not close the ticket;
- default ticket policy asks the parent to review before close;
- `reviewImplementation` nudge asks `fix | file | reject`;
- `fix` stays blocking until the parent remediates and re-reviews;
- `file` is treated as nonblocking follow-up in guidance;
- `reject` records rationale via ordinary comments;
- notable decisions appear in the final handoff;
- one epic can complete;
- works when tmux is absent;
- no worktree without explicit user cwd.

### Removal regressions

- no production import of beadwork `tmux.ts`;
- no tool description promises tmux workers;
- no config requires tmux session/window/pane;
- no scheduler selects `worktree`;
- no path intent rejects writes;
- beadwork emits no duplicate model-visible lifecycle message for a minion-owned child;
- no permit/bind/report-result symbols in production source.

### Quality gates

Every slice:

```sh
npm run lint
npm run test
npm run typecheck
```

Logic changes need focused tests in the affected workspace. Cutover also needs `npm run build` and a manual TUI smoke: parent stays interactive, packet arrives after a child settles, `/bw run` does not spawn tmux.

---

## 20. Risks

**Task-type proliferation.** Mitigation: add a value only for a distinct parent question. Keep ordinary work untyped.

**Prompt conflicts between role and workflow.** Mitigation: strict precedence; never concatenate.

**Parent-turn noise and cost.** The supervisor is now an LLM. Coalescing is a cost feature, not only a correctness feature. Packets stay bounded; `show_minion` holds the rest.

**Over-automation.** Nudges are instructions. Tests must prove they do not close, spawn, or adjudicate.

**Beadwork remains a hidden orchestrator.** One lifecycle owner. Delete tmux modules. Duplicate-delivery regressions.

**Shared-checkout conflicts.** Visibility and messaging; explicitly best effort.

**In-process blast radius.** A stuck child can require Pi exit. Cooperative cancel only. Document this; it is the price of dropping tmux. Shutdown dispose is mandatory hygiene.

**Child shell closes tickets.** Tool hiding plus prompt plus parent refresh. Not OS enforcement.

**Dynamic role quality.** Use task types when the parent question must be reliable.

**Extension coupling.** Small public inspection API if needed; minions never imports beadwork; no event-handshake product.

---

## 21. Remaining implementation questions

Product and architecture are locked. Implementation planning may still choose:

1. default numeric caps (max active children, message bytes, packet output bounds, path-intent TTL);
2. whether `description` is strictly required or warned when missing;
3. child-facing tool names for peer send vs parent send;
4. how beadwork goal TUI reads minion state (public list API vs duplicated ids in session JSON as a cache);
5. exact config key mapping for unambiguous review/validation migration;
6. default reviewer role name.

None of these reopens tmux, schemas, permits, locks, or hidden schedulers.

---

## 22. Handoff

Implement from this file only.

**Invariant:** Role selects behavior; task type selects workflow guidance; beadwork supplies domain context; minions owns orchestration mechanics; child output is unstructured evidence; the parent model judges.

Planning should focus on wiring, not re-opening the constitution:

1. split non-blocking start from `Promise.allSettled()` without duplicating session code;
2. settled vs `agent_end`, and real child runtime dispose on parent shutdown;
3. packet delivery with `followUp` + idle `triggerTurn`, plus coalescing tests;
4. beadwork metadata on `orchestrate` without a second completion channel;
5. which beadwork runtime modules delete outright at cutover;
6. child messaging tools without exposing `orchestrate` to children;
7. one-cwd group representation;
8. ticket vs scope review as prompt/policy, not a second scheduler.

---

## Appendix A: Evidence pointers

### `pi-minions`

- `packages/pi-minions/src/tools/spawn.ts` — foreground `Promise.allSettled()`
- `packages/pi-minions/src/subsessions/manager.ts` — child sessions, `agent_end` completion, no-op shutdown
- `packages/pi-minions/src/tree.ts` — live fleet registry
- `packages/pi-minions/src/agents.ts` — dynamic roles
- `packages/pi-minions/src/index.ts` — registration and parent surfaces

### `pi-beadwork-extension`

- `src/orchestrator.ts` — tmux/process supervisor
- `src/tmux.ts` — launch/inspection
- `src/types.ts` / `src/config.ts` — worker runtime and tmux config
- `src/index.ts` — `beadwork_delegate`, `beadwork_worker_done`
- `src/prompt.ts` — current orchestration prompt
- `src/bw.ts` — durable domain adapter

### Pi APIs this design relies on

- `pi.sendMessage(..., { triggerTurn, deliverAs: "followUp" })` — idle wake and in-turn wait
- `shouldStopAfterTurn` / settled idle — not used as success
- child session dispose on parent `session_shutdown`
- persistent `tui` / `rpc` vs `print` / `json` host lifetime

### Quality

- `AGENTS.md` — atomic commits; lint / test / typecheck
- package tests under `packages/pi-minions/src/__tests__/` and `packages/pi-beadwork-extension/src/__tests__/`
