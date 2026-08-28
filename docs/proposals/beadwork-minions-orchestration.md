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
3. Keep foreground `spawn`. Add a distinct `orchestrate` tool that returns handles immediately and reports later through coalesced parent packets. Foreground `spawn` is not part of an orchestration group and does not emit packets.
4. Carry orchestration metadata on spawn/orchestrate: dynamic `role`, optional closed `taskType`, required short `description`, optional domain fields (`source`, `scopeId`, `workItemId`, `title`). Minions stores and echoes this metadata. It does not interpret ticket semantics.
5. `taskType` selects deterministic lifecycle nudge text for the parent. No task type → role fallback nudge if present → generic nudge. Nudges never close tickets, spawn work, or adjudicate findings. Coalesced packets carry **per changed child** nudges, not one shared instruction.
6. Child output is not schema-validated. A handoff shape may be encouraged in prompts. It is never enforced. There is no child result protocol tool. The caller's `task` string is the complete child prompt; beadwork does not wrap child sessions.
7. Each meaningful child lifecycle change reaches the parent as one model-visible packet: the changed children, a snapshot of still-running orchestrated children, and a nudge per changed child.
8. Deliver packets at a safe boundary. Never inject into an active parent turn. Coalesce even when idle so simultaneous completions do not each start a turn. If the parent is idle after coalesce, the packet may start a turn so an epic can continue unattended.
9. Direct agent-to-agent messages do not route through the parent. Messages only succeed while the recipient is live. Path intent and overlap notices are advisory only.
10. Shared checkout is the default. A worktree or alternate cwd is an explicit user-supplied existing workspace on the group, never chosen by the runtime.
11. Per-ticket independent review is the beadwork default. The parent model adjudicates findings. Notable decisions are ordinary `bw` comments plus the parent's final recap — not a minions decision log.
12. Prove one epic end to end. Represent goal scope as `scopeIds: string[]` so multiple epics can be added later without changing minion mechanics.
13. `/bw run <epic>` enters goal mode and **injects a prompt** (epic metadata + “start orchestrating”) that starts a parent turn. Not a minions lifecycle packet. Persistent hosts only (`tui`/`rpc`). One goal and one open orchestration group per parent session. Leftover persisted `run` mode is interrupted, not auto-resumed. All supervisor CLI/config (`--workers`, `--until`, `--maxCycles`, `--noSpawn`, `--dryRun`, poll intervals, landing) is removed.

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
2. **Foreground spawn is outside orchestration.** `spawn` children are not in a group, do not emit parent packets, and while `spawn` is in flight the parent turn is blocked (queued packets wait as `followUp`). Fleet snapshots are orchestrated children only.
3. **Metadata is the integration contract.** Domain context is data on the child record. Beadwork tools remain ordinary parent tools (`bw start`, close, comment, ready). There is no assignment permit, bind step, or semantic `operationId` protocol.
4. **The `task` field is the child prompt.** The caller supplies the complete prompt. Beadwork does not intercept or wrap child session creation. Goal/parent prompt tells the parent what to put in `task`.
5. **`description` is required.** Short, fleet-readable. Do not infer it from `task`.
6. **Nudges, not schemas.** `taskType` / role / generic fallback choose parent instruction text. Child text is evidence. No `protocolStatus`, no required `SubmittedTaskResult`, no `minion_report_result`.
7. **Settlement is fully idle, not success.** A child is terminal after the Pi session is fully idle (the `agent_settled` / `waitForIdle` condition, including retries, compaction, and queued continuations), or aborted, or failed. First `agent_end` is too early. Idle is not ticket acceptance. V1 does not use `shouldStopAfterTurn`. Parent-packet event classes are `settled | aborted | failed | parentMessage`. Abort is not failure.
8. **Turn ordering.** Never inject into an active parent turn. Coalesce pending updates into one packet **including when the parent is idle** — fold events that arrive before the packet is submitted rather than one turn per child. After coalesce, if idle, the packet may `triggerTurn`. Unattended epic continuation is the feature. A rare idle-vs-idle collision with a user submit is accepted. V1 does not detect compose-buffer state and does not build a user-priority queue.
9. **Per-child nudges in coalesced packets.** One fleet snapshot; each changed child carries its own status, bounded output, and nudge. Do not pick a single nudge for mixed task types.
10. **One open orchestrated group per parent session in V1.** First `orchestrate` creates it. Later calls with omitted `groupId` join that group. A second group is deferred. The group has one cwd, set at creation (default: parent cwd), must already exist, immutable. No per-task override. Runtime never creates, switches, lands, or deletes worktrees.
11. **Advisory coordination only.** TTL path intent and overlap notices warn and suggest communication. They never lock, pause, reject writes, or claim safety.
12. **No real locks.** Two Pi sessions in one repo is best-effort, same class as two agents on one branch. No git-common-dir mutex, no mission lease, no PID-reclaim protocol.
13. **No parked children.** There is no wait state and no idle-but-alive mailbox. Peer and parent-directed messages succeed only while the recipient's run is live; they may `steer`/`followUp` into that child and may cause another turn (peer chat can postpone idle; user/parent `halt` if needed — not a keep-alive protocol, no timeout product). After settled/aborted/failed, dispose; further messages fail as recipient-terminal. “I'm blocked” is a parent-directed message during the run, or prose in the final output. Terminal vs inbound mail is a single winner: if settlement is committed, mail fails terminal; if mail was already accepted as child follow-up, wait until that continuation idles, then settle once.
14. **Review policy is beadwork's.** Default `ticket`; also `scope` and `none`. Independent review before close is the default. `file` is for nonblocking follow-up; blocking findings stay `fix` or `reject` unless the user explicitly waives. This lives in nudge text and beadwork policy, not in a parser of child JSON. Shared-branch reviewers may see unrelated dirty files; that is accepted. Prompt them at commits / ticket id / `git show`, not “read the whole workspace.” Do not start review of ticket A while A's implementer is still live.
15. **Quality commands are not a beadwork job.** `lint` / `test` / `typecheck` are ordinary project commands. Implementers should run them before declaring done; reviewers may confirm; the repo may run them at overall checkpoints. They are not a special per-ticket close gate, not a minions task type, and not a beadwork-owned command runner.
16. **No `--workers` coupling.** Beadwork does not set minions concurrency caps. The parent orchestrates against ready work; it will not mechanically need a second extension to limit fan-out. `/bw run` has no worker count flag.
17. **Child beadwork tools are an allowlist, applied to spawn and orchestrate children.** Do not exclude the whole extension. After bind, minions sets active tools. Beadwork child allowlist: `show`, `list_issues`, `issue_history`, `ready`, `blocked`, `status`, `prime`. Parent-only (not on children): start, close, reopen, create, update, comment, label, defer, undefer, dependencies, `beadwork_sync`. Deleted for everyone: `beadwork_delegate`, `beadwork_worker_done`, `beadwork_land_worker`, `beadwork_worker_check`. Minions is not loaded in children; parent injects bound comm tools only (`list` peers, send, announce) with runtime-attached identity — not the parent `send_minion_message` tool. Shell can still `bw close`. Parent refreshes `bw` before acceptance. V1 does not claim OS isolation.
18. **Effective child tools.** `(role allowlist if present, else parent coding tools) ∪ beadwork inspection allowlist ∪ injected comm tools − {start, close, reopen}`. Role cannot drop inspection/comm and cannot add close. Apply this to spawn children too.
19. **No beadwork fleet UI.** Beadwork TUI is issues/goal. Delete the workers tab, supervisor “run” copy (“bounded epic loop”), statusline worker fields, `SessionRunOptions`, and `trackedWorkerIds`. Live children are `list_minions` / `show_minion` / asking the parent. Do not import the live minions runtime from beadwork.
20. **`/bw run` injects a prompt.** Persistent `tui`/`rpc` only; reject `print`/`json`. After validating the epic and storing goal scope, inject a prompt that contains the epic metadata (id, title, review policy, scope) and the instruction to refresh `bw`, start ready work, and `orchestrate`. Standing prompt appendices are policy; they do not start a turn. Delivery: `followUp` if the parent is mid-turn, `triggerTurn` when idle — same safe-boundary rule as minions packets, but the payload is just a prompt, not a child-change packet. One goal per parent session: same epic again re-injects that prompt; a different epic is rejected until the current goal exits. Exit `run` when the scoped epic is closed or the user explicitly abandons goal mode. Halt of the minion group is not enough by itself.
21. **Stale `run` is interrupted.** Persisted session JSON must not auto-inject a prompt or recreate children after `/new`, reload, or process death. User runs `/bw run` again. Do not require a minions probe/ack; inject anyway if minions is missing — the parent turn fails in the open if `orchestrate` is absent.
22. **Supervisor flags and config are rejected.** `--workers`, `--until`, `--maxCycles`, `--noSpawn`, `--dryRun`, `pollIntervalMs`, `supervisor.*`, `landing.*`, `workerExecution.*`, `tmux.*`, managed `worktrees.*` — removed with actionable errors. Beadwork does not supervise.
23. **`orchestrate` requires a persistent host.** Supported in Pi `tui` and `rpc`. Rejected synchronously in `print` and `json`.
24. **One epic for V1.** Goal `scopeIds` is an array; V1 validates exactly one epic. Child metadata still carries a single `scopeId`.
25. **Notable decisions.** Parent recap plus ordinary `bw comment` when something is worth keeping. No minions decision log and no `record_orchestration_decision` tool in V1.
26. **Opaque `workItemId` uniqueness is optional convenience.** Rejecting a second **live** child with the same `domain.workItemId` in this process is string uniqueness, not ticket ownership. Cross-session doubles are a user problem.
27. **`orchestrate` `accepted` means registered, not running.** `state: "starting"` is not liveness. Start failure is a later `failed` packet.

---

## Do not

Do not reintroduce any of the following. They were considered in the native pass and rejected.

- Child result / exit protocol tools (`minion_report_result`, `minion_wait`, `protocolStatus`, typed handoff enforcement, `partial` because a tool was forgotten).
- `shouldStopAfterTurn` as a required orchestration hook; parked-wait child sessions; idle-alive mailboxes.
- Assignment permits, `beadwork_bind_attempt`, three-step prepare/orchestrate/bind sagas.
- Semantic effect keys, revision-token CAS, start/close sagas (`accept-prepared` → `bw close` → `accept-committed`).
- Git-common-dir or other disk locks for goal ownership.
- Machine-record protocols stuffed into `bw comment` as an orchestration log.
- Immutable Git review-subject manifests, OID/mode dependency graphs, or `dependency-set` coverage modes.
- A `validation` task type, beadwork-owned per-ticket validation runner, or acceptance identity based on executable/env hashing.
- `--workers` or any other beadwork flag that configures minions resource ceilings.
- Beadwork fleet/worker UI, or beadwork importing the live minions `AgentTree`.
- Attention latches the model cannot clear, one-shot resume tokens, or `completionToken` gates on group close.
- Versioned `pi.events` handshake (`minions:v1:probe`, permit register/revoke, user-control ack) as the integration fabric.
- Frozen `allowedRoles` profile-hash snapshots as a V1 dispatch requirement.
- Four classes of resource-limit lifetime, effect-record ceilings, or a Temporal-style reducer in minions.
- Tmux fallback, worker-registry shims, or wrapping `orchestrator.ts` instead of deleting the worker runtime.
- Automatic worktrees, landing, rebase, or merge-back.
- Supervisor loops, poll intervals, `maxCycles`, `until`, `noSpawn`, `dryRun`, or `defaultWorkers`.
- Detached children, durable mailboxes, exactly-once parent delivery, or replay of live orchestration across process death.
- A closed enum of roles.
- A second issue graph inside minions.
- Concatenating role guidance onto task-type guidance.
- Treating settlement, a typed workflow, or a child handoff as ticket acceptance.
- Excluding the entire beadwork extension from children (inspection is required).
- Inferring `description` from `task`.
- Auto-kickoff or child resurrection from persisted `run` session JSON.
- A minions probe/ack handshake as `/bw run` preflight.
- More than one open orchestrated group per parent session in V1.

**Deprecated:** beadwork tmux/worker/landing/supervisor runtime, `beadwork_delegate`, `beadwork_worker_done`, `beadwork_land_worker`, `beadwork_worker_check`, `runBoundedEpicLoop`, worker dashboard / “bounded epic loop” copy, statusline worker fields, `SessionRunOptions`, `trackedWorkerIds`, supervisor CLI flags.
**Replacement:** minions `orchestrate` + beadwork goal/domain tools + `/bw run` kickoff.
**Status:** delete at cutover, not later, and not behind a compatibility façade.

---

## 1. Normalized feature intent

### Desired workflow

A parent Pi session delegates several related tasks without blocking, stays interactive, and receives enough context to make the next orchestration decision when a child changes state.

`/bw run <epic>` sets goal context and kicks the parent. The parent refreshes `bw`, chooses ready work, starts tickets, and calls `orchestrate`. Children run in-process. When they settle (or ask the parent a question while still live), the parent gets a packet and continues. The user can talk to the parent the whole time.

For every completion, failure, or parent-directed child message, the parent should know:

- which child changed;
- what it was asked to do (`description`);
- which role and task type it used;
- what it said (unstructured evidence);
- which other orchestrated children are still running;
- which workflow-specific judgment that child's nudge is asking for.

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
- **Beadwork does not supervise.** No poll loop, worker count, cycle cap, or landing pipeline.

### Desired outcome

One orchestration implementation in `pi-minions`. Beadwork does not maintain a worker registry, polling supervisor, completion notification path, process launcher, or fleet UI. `/bw run <epic>` enters a domain-aware goal: beadwork supplies intent and the work graph; the parent model and minions drive live work.

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
2. The parent remains available for user input and further tool calls while orchestrated children run.
3. A child is terminal only after fully idle, aborted, or failed — not on premature `agent_end`.
4. Each meaningful lifecycle change yields one safe-boundary parent packet, not merely a UI toast.
5. The packet includes the changed children, a fresh snapshot of still-running **orchestrated** children, and a nudge per changed child.
6. Optional `taskType` deterministically selects that child's nudge.
7. Without a task type, role fallback or generic guidance applies, and that guidance matches the event (`settled` / `aborted` / `failed` / `parentMessage`).
8. Near-simultaneous completions on an idle parent produce one coalesced turn, not one turn per child.
9. Direct peer messages reach a **live** addressed child without a parent turn, and fail clearly once that child is terminal.
10. The parent can inspect peer identities and communication metadata via minions tools.
11. `/bw run <epic>` kickoff starts parent work with no tmux, no polling supervisor, and no worker flags; rejected in `print`/`json`; stale persisted `run` does not auto-kickoff.
12. One beadwork epic can be implemented and reviewed through minions on a machine without tmux.
13. Shared checkout remains default; no worktree is created without explicit user input.
14. Overlap notices are informational.
15. Ticket review defaults to occurring before close; the parent model judges findings, not a keyword classifier.
16. Child output is accepted as prose. Missing a “handoff format” or result tool does not fail the child.
17. Spawn and orchestrated children can inspect the beadwork tree (including closed issues) and cannot close/start tickets through extension tools.
18. Foreground `spawn` still blocks and does not appear in orchestration fleet snapshots.

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
- wakes the parent once per child when updates could be coalesced, including when idle;
- injects an orchestration packet into an active parent turn;
- makes peer communication depend on parent mediation;
- delivers messages to disposed children by keeping parked sessions;
- introduces permits, bind sagas, disk locks, or effect-key CAS;
- keeps supervisor flags/config (`workers`, `until`, `maxCycles`, `noSpawn`, `dryRun`, poll, landing);
- builds a beadwork fleet UI or imports the live minions runtime;
- makes lint/test/typecheck a beadwork-owned per-ticket gate or a `validation` task type;
- auto-resumes a goal from persisted `run` state;
- creates a second orchestrated group in V1;
- uses `completed` as the settlement event class or treats abort as failure.

---

## 3. V1 scope, non-goals, and deferred scope

### In scope

- process-local, non-blocking `orchestrate`;
- preserved foreground `spawn` outside groups;
- fully-idle / aborted / failed lifecycle;
- orchestration groups with one immutable cwd;
- role, task type, required description, and domain metadata transport;
- deterministic per-child nudge selection, including live parent-directed questions;
- safe-boundary packets, idle coalescing, idle continuation;
- `/bw run` injected prompt (epic metadata + go orchestrate);
- direct addressed peer messaging to live children;
- parent-visible communication metadata;
- advisory TTL path intent and overlap notices;
- one-epic beadwork goal mode;
- parent-judged review and `fix | file | reject` guidance;
- child beadwork inspection tools;
- removal of beadwork's tmux, landing, and supervisor paths.

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
- proof that shell writes are observed;
- beadwork-owned command runners for project quality gates;
- minions concurrency ceilings configured by beadwork.

### Deferred

- multiple epic scopes in one goal;
- custom task-type registration by third-party adapters;
- richer threads or broadcast channels;
- long-lived resumption after `/new` or process restart;
- historical analytics;
- automated ranking by dependency unlock value;
- remote or process-isolated minion backends;
- compose-buffer-aware turn ordering;
- observing path overlap from minions-managed edit tools, if cheap and still advisory;
- linking beadwork TUI to live minion rows.

---

## 4. Current repository context

### Confirmed `pi-minions`

- `packages/pi-minions/src/tools/spawn.ts` — `task` / `agent` / `model` or batch `tasks`; `executeSpawn()` awaits `Promise.allSettled()`.
- `packages/pi-minions/src/subsessions/manager.ts` — file-backed child `AgentSession`s, steer/abort handles, local event bus. Completion currently on `agent_end`. Child extensions bound with a no-op `shutdownHandler`. Child extension filter currently excludes only `pi-minions` and `pi-om-extension` (beadwork **does** load in children today, including mutating tools).
- `packages/pi-minions/src/tree.ts` — process-local fleet registry (identity, agent, task, status, activity, usage, model, parent/child).
- `packages/pi-minions/src/agents.ts` — dynamic project/user agent discovery; `AgentConfig.name` is already an open role identity.
- `list_minions`, `show_minion`, `halt` already exist.

### Confirmed beadwork

- `packages/pi-beadwork-extension/src/orchestrator.ts` — tmux launch, polling, landing, review, remediation, worker lifecycle; `runBoundedEpicLoop` is a cycle supervisor.
- `types.ts` / `config.ts` — tmux pane fields, worktree, landing, supervisor polling, `run.defaultWorkers`, `noSpawn`, `maxCycles`.
- `actions/run.ts` / session modes — `/bw run` enters `run` mode and the supervisor launches workers.
- `beadwork_delegate` — tmux-backed worker launch.
- `beadwork_worker_done` — evidence + self-review + close/sync + shutdown.
- `bw.ts` already has the durable domain primitives: tickets, dependencies, readiness, comments, labels, history, scope, status transitions.
- `attribution.ts` — useful domain helpers (launch HEAD, ticket-referencing commits, touched paths). Keep as domain code, not worker runtime.

### Preserve

- in-process child sessions, not shell-out to another agent binary;
- agent role definitions in user/project prompt files;
- `AgentTree` as the live fleet registry (extended, not forked);
- Pi safe-boundary delivery (`sendMessage` follow-up), never mid-turn injection into the **parent**;
- `bw` as durable work-graph truth;
- explicit user-selected cwd;
- model judgment for decomposition, review, and adjudication;
- beadwork inspection tools on children;
- attribution helpers for parent accept/review context.

### Remove

- tmux launch and inspection;
- process marker files and pane discovery;
- beadwork-owned live worker registry;
- polling as the child lifecycle mechanism (`runBoundedEpicLoop`);
- automatic landing for shared-branch work;
- runtime-selected worktrees;
- UI-only completion notices;
- regex-only review classification;
- worker completion implying ticket acceptance;
- supervisor CLI/config: `workers`, `until`, `maxCycles`, `noSpawn`, `dryRun`, poll intervals;
- `landing.*`, `workerExecution.*`, `tmux.*`, managed `worktrees.*`;
- beadwork worker dashboard land/cleanup / fleet views;
- `beadwork_delegate`, `beadwork_worker_done`, `beadwork_land_worker`, `beadwork_worker_check`;
- dashboard workers tab, “bounded epic loop” command copy, statusline worker fields, `SessionRunOptions`, `trackedWorkerIds`.

---

## 5. Core mental model

### Three owners

**`pi-minions` — orchestration mechanics**

- child session creation and lifetime;
- process-local identity and status;
- foreground `spawn` and non-blocking `orchestrate`;
- group membership and group cwd;
- role, task type, description, domain metadata transport;
- lifecycle observation (fully idle / aborted / failed);
- fleet snapshots, per-child nudge selection, coalescing, parent packet delivery;
- direct messaging, steering, cancellation, inspection;
- advisory path intent and overlap notices.

Minions does not understand tickets, readiness, review policy, or acceptance. Optional live `workItemId` uniqueness is opaque string matching.

**`pi-beadwork-extension` — domain context**

- activation and project detection;
- tickets, epics, dependencies, readiness;
- goal scope and epic intent;
- issue start, close, reopen, comment, label, and dependency operations (parent-visible; children get the inspection allowlist only);
- beadwork metadata attached at orchestrate time by the parent;
- parent prompt appendix for goal mode;
- review policy;
- whether the selected epic is complete;
- durable comments and follow-up tickets.

Beadwork does not own child processes, a worker registry, fleet monitoring, completion delivery, peer messaging, a generic orchestration loop, project quality-command execution, or a live minion UI.

**Parent model — orchestration policy**

- which work to start, which role and task type, how much concurrency;
- composing the child `task` prompt;
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

A role may optionally define `completion_nudge` in frontmatter. That text applies only when no `taskType` is present, and only for `settled`/`failed` — not for `aborted` or `parentMessage`.

```yaml
---
name: reviewer
description: Independently review completed work
completion_nudge: Assess the feedback against the task and project intent; do not accept findings mechanically.
---
```

Unknown roles, and roles without guidance, are valid. They receive the generic nudge for that event class.

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
  | "investigateBlocker";
```

There is no `validation` value. Running the project's lint/test/typecheck is ordinary work inside implementation, fix, or review — not a distinct orchestration workflow.

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

1. If `taskType` is present, use that policy text for the **event class**.
2. Else if the event is `settled` or `failed` and the resolved role defines `completion_nudge`, use it.
3. Else the generic string for that event class.

Do not concatenate role guidance onto task-type guidance. Per-spawn task text is evidence, not a nudge override.

### Event classes

```ts
type NudgeEvent = "settled" | "aborted" | "failed" | "parentMessage";
```

`parentMessage` is a live child → parent question/blocker. The child is still running. That nudge must not say the task settled. `aborted` is user/parent halt, not a crash; do not retry unless the user asks.

| Task type | `settled` intent | `failed` intent | `aborted` intent | `parentMessage` intent |
| --- | --- | --- | --- | --- |
| `implementation` | Assess evidence. Apply review policy. Accept, dispatch a fix, or ask the user. Do not close a ticket solely because the child settled. | Inspect the failure, decide retry/fix/escalate. | Do not retry unless the user asks. | The child is still running. Answer via parent→child message or halt; do not treat this as settlement. |
| `fix` | Verify against the original finding. Independent re-review before acceptance. | Inspect failure; decide retry or escalate. | Same abort rule. | Same live-child rule. |
| `reviewImplementation` | Disposition every finding as `fix`, `file`, or `reject`. Blocking findings require `fix` or `reject` unless the user waives. `file` is for nonblocking follow-up. Unresolved required fixes block acceptance. | Inspect failure; decide re-review or escalate. | Same abort rule. | Same live-child rule. |
| `reviewScope` | Adjudicate cross-ticket findings and judge whether the goal meets acceptance criteria. | Inspect failure; decide re-review or escalate. | Same abort rule. | Same live-child rule. |
| `investigateBlocker` | Apply the answer to blocked work, or record why escalation remains necessary. Investigation settlement is not implementation settlement. | Inspect failure; decide retry or escalate. | Same abort rule. | Same live-child rule. |
| *(none)* | Role fallback or “A background task settled. Inspect its result and decide the next action.” | “A background task failed. Inspect the error and decide the next action.” | “A background task was aborted. Do not retry unless the user asks.” | “A running child sent a question. Answer or halt; it has not settled.” |

Nudges instruct. They do not close, spawn, accept, or disposition automatically.

### Child output is unstructured

Encourage children, in the prompt, to report summary, commits, commands they ran, blockers, and follow-ups. Do not validate that shape. Do not fail settlement if they paste prose. The parent uses Git, `bw`, and ordinary project commands when it decides to record or accept.

This is the standing contract, not a temporary gap waiting for schemas.

---

## 8. Spawn and orchestrate

### Foreground `spawn`

Unchanged product behavior: start children, wait, return results to the current tool call. Keep `agent` for compatibility. Internally reuse the same session factory as `orchestrate`.

`spawn` children:

- are not members of an orchestration group;
- do not emit orchestration packets;
- do not appear in orchestrated fleet snapshots;
- block the parent tool call, so packets queue as `followUp` until spawn returns;
- still get the same child tool filter as orchestrated children (inspection allowlist, no start/close/reopen, no parent minions tools).

### `orchestrate`

Starts one or more children, registers them in a group, returns handles immediately. Later events arrive as parent packets.

```ts
interface OrchestrateInput {
  groupId?: string; // omit: create if none open, else join the one open group
  cwd?: string;     // group creation only; default parent cwd; must already exist
  tasks: OrchestratedTaskDescriptor[];
}

interface OrchestratedTaskDescriptor {
  task: string;          // complete child prompt; beadwork does not wrap this
  description: string;   // required short fleet-readable summary
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
  accepted: Array<{ childId: string; description: string; state: "starting" }>; // registered, not running
  rejected: Array<{ index: number; reason: string }>;
}
```

Requirements:

- Return after registration, not after session startup or completion.
- Batch startup may be partial: preserve successful handles, fail the rest clearly.
- The tool call's `AbortSignal` cancels registration, not the children. Child lifetime belongs to the group.
- Reject in `print` and `json` hosts.
- `domain` is opaque transport. Minions does not parse ticket IDs. Optional live duplicate rejection is equality on `workItemId` strings in this process.
- V1 allows one open group per parent session. Omit `groupId` to create or join it. Passing a different `groupId` rejects. There is no separate “begin orchestration” scheduler.
- A group has exactly one cwd. Later `cwd` mismatch rejects. Tasks cannot override it.
- `accepted` / `starting` means registered. A subsequent `failed` packet means start never became a live run.

### Process lifetime

Children are background relative to the parent turn, not detached from the process.

- Parent `session_shutdown` (quit, `/new`, resume, fork, reload) aborts and disposes active children. Own a real child runtime so shutdown is not a no-op handler on a bare session.
- No continuation after process death.
- Persisted transcripts may remain inspectable. They are not live children and must not be shown as running after restart.
- Beadwork tickets remain durable. A later session inspects `bw` and decides whether to restart work.
- After terminal, dispose. Do not retain the session so mail can be delivered later.
- Settlement vs inbound child mail: one winner. Committed settlement → later mail is `recipient-terminal`. Already-accepted mail → that continuation must go idle before a single `settled` packet.

No heartbeats, recovery leases, replay logs, or generation-token protocols. Shutdown abort is hygiene, not a distributed session-generation CAS.

---

## 9. Parent packets and turn ordering

### Packet contents

One structured model-visible packet:

1. **Changed children** — for each: id, role, task type, description, domain metadata, event class, bounded output/error, **that child's nudge**. Full transcript via `show_minion`.
2. **Current fleet** — every still-running **orchestrated** child in the group: id, role, task type, description, state, optional elapsed time and latest activity. Not foreground `spawn` children.
3. Runtime nudge text is delimited from untrusted child output so the child cannot overwrite the instruction.

```text
Orchestration update

Changed:
- mn-12 settled
  role: security_specialist
  taskType: reviewImplementation
  description: Review BW-123 authentication changes
  output: (bounded child text)
  Required judgment: Disposition every finding as fix, file, or reject. ...

- mn-13 settled
  role: general_coder
  taskType: implementation
  description: Add session expiry tests
  output: (bounded child text)
  Required judgment: Assess the evidence. Apply the active review policy. ...

Still running:
- mn-14 [hard_problem_coder / fix] Fix token refresh race
```

### What counts as a parent-waking event

- orchestrated child `settled`, `aborted`, or `failed`;
- live orchestrated child → parent message (`parentMessage`).

Progress, peer messages, and path notices update TUI / minions inspection. They do not, by themselves, start a parent turn. Repeated unresolved overlap may be included as metadata on the next real packet, not as a spam wake.

`/bw run` injects a prompt that starts a parent turn. That is not a minions lifecycle packet: no changed-child list, no fleet snapshot, no task-type nudge. It is the epic record plus instructions. Child settlements still arrive later as minions packets.

### Delivery and turn ordering

Pi `sendMessage` with `{ triggerTurn: true, deliverAs: "followUp" }` is the delivery mechanism for parent packets.

Locked behavior:

1. **Never inject into an active parent turn.** `followUp` waits until the current parent turn finishes. Do not use `steer` for parent orchestration packets.
2. **Coalesce, including when idle.** Fold every waking event that arrives before the packet is submitted into one packet with one fleet snapshot. An idle parent plus four near-simultaneous settlements is one turn, not four. Implementation may use an in-process queue plus “submit only when no further events are already pending,” not a user-visible timer product.
3. **Idle continuation is allowed.** After submit, if the parent is idle, the packet may start a turn. That is how `/bw run` proceeds when the user is not babysitting.
4. **Do not wait for an unsent keystroke.** Compose-buffer detection is out of V1.
5. **Idle-vs-idle user submit vs packet** is accepted. Pi orders it. Do not build a priority queue.
6. A UI toast may accompany the packet. It cannot replace it.
7. Consume each submitted packet once in-process so the same events do not start duplicate turns.

Parent is protected from mid-turn injection. **Children are not:** peer and parent→child messages may `steer`/`followUp` into a live child. That is intentional.

This is “safe-boundary delivery + idle continuation + idle coalesce.” It is not “user always wins” and not “autonomous always wins.”

---

## 10. Direct agent communication

Process-local, best effort. Inspired by useful parts of agent hubs, without adopting their infrastructure.

Minions is not loaded as a child extension (prevents recursive `orchestrate`/`spawn`/`halt`). The parent runtime injects **bound** child-facing comm tools into **orchestrated** sessions (not the parent tools). Spawn children do not get comm tools; they do get the beadwork inspection filter.

Injected child tools (names may vary; identity is a closure, not a parameter):

- list peers in the group (id, role, task type, description, state);
- send an addressed message to a **live** peer, or to the parent;
- announce advisory path intent with a TTL;
- inspect current path intent.

Rules:

- Same group only. No broadcast in V1. No cross-session delivery.
- Sender identity is attached by the runtime, not supplied by the child. Do not install parent `send_minion_message` on the child.
- Send returns immediately. The sender never waits for the recipient's model turn.
- Live recipient: deliver at a safe **child** boundary (`steer`/`followUp`). That may cause another child turn and postpone idle. Intended, not a keep-alive protocol. Halt if chatter runs on. No timeout product in V1.
- Terminal recipient: fail clearly (`recipient-terminal`). Do not keep the session alive to drain mail. Do not reroute through the parent.
- Peer messages do not start a parent turn. Parent inspects via `list_minions` / `show_minion` (those tools are not on the child).
- Bodies are size-bounded. Queues are best effort; mailbox-full fails clearly.
- No durable mailbox, no exactly-once, no wait-for-reply tool, no parked-wait state machine.

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

1. notify the affected **live** agents;
2. name the other agent and its description;
3. encourage a direct message;
4. surface overlap as parent-inspectable metadata;
5. continue.

The runtime must not reject edits, pause children, reorder work, create a worktree, require declarations before spawn, or claim undeclared shell writes are safe.

If the user wants isolation, they create a checkout/worktree themselves and pass that existing path as the group `cwd`. The runtime never selects it from heuristics.

Shared-branch review limitation (accepted): a reviewer may see dirty or unrelated files from other live tickets. Prompt review children to inspect the named commits / ticket references. Do not spawn review of A while A's implementer is still running. Do not build review-subject manifests.

---

## 12. Beadwork as a goal adapter

### Goal record

V1 stores a small ordinary session/beadwork goal, not a machine-record protocol:

```ts
interface BeadworkGoal {
  goalId: string;
  scopeIds: string[]; // V1: exactly one epic id
  reviewPolicy: "ticket" | "scope" | "none";
  startedAt: string;
}
```

### `/bw run`

```text
/bw run <epic>
```

No `--workers`, `--until`, `--maxCycles`, `--noSpawn`, `--dryRun`. Those flags are rejected. Reject in Pi `print`/`json` the same as `orchestrate`.

It should:

1. validate persistent host and that the target is an open epic with traversable descendants;
2. store the goal record (exactly one `scopeId`);
3. set session `run` mode as goal mode: standing parent prompt appendix with run-to-completion intent, review policy, and “use `orchestrate` + beadwork tools; do not poll; do not close from child settlement”;
4. load prime/guidance into the standing appendix;
5. inject a prompt that starts a turn, including the epic id/title, review policy, and: refresh `bw`, choose ready work, `beadwork_start_issue` when assigning, compose the child `task`, `orchestrate` with domain metadata and the right `taskType`. Use `followUp` if the parent is mid-turn; `triggerTurn` when idle. `sendUserMessage` or `sendMessage` are both fine; do not invent a second packet schema.

Do not probe minions. If `orchestrate` is not registered, that injected turn fails in the open.

Same session, same epic: re-inject the prompt (retry). Same session, different epic while a goal is active: reject until the current goal exits. Two Pi sessions on one epic: no lock; `bw` is the recovery surface.

Exit `run` (drop the goal appendix) when the scoped epic is closed, or when the user explicitly abandons goal mode. `halt` of the minion group does not by itself leave goal mode.

Persisted `mode: "run"` after `/new`, reload, or process death is **interrupted**. Do not auto-kickoff and do not recreate children. The user runs `/bw run` again. Drop `trackedWorkerIds` / `runOptions` with the supervisor.

It should not create tmux panes, maintain a worker registry, poll processes, deliver a second completion channel, pick worktrees, own peer messaging, run a hidden scheduler, cap minions concurrency, or show a fleet UI.

`interactive` mode stays human-led (no injected go-prompt). `neutral` stays inactive. `run` is standing appendix + injected prompt.

### Domain metadata

```ts
{
  source: "beadwork",
  scopeId: "EPIC-10",
  workItemId: "BW-123",
  title: "Fix authentication refresh race"
}
```

The parent (not minions, not a beadwork wrap hook) composes `task` and calls `bw start` with ordinary tools. Implementation children are told in that prompt not to close tickets. The parent closes after it judges evidence.

Leftover `in_progress` with no live child is visible in `bw`; the parent or user re-dispatches. No start/close saga.

### Evidence and acceptance

Child settlement is evidence, not acceptance. The parent refreshes Git and `bw`, may use preserved attribution helpers, then comments, files follow-ups, or closes with beadwork tools.

Prompt-encourage handoff content. Delete `beadwork_worker_done` at cutover.

Project quality commands (`npm run lint` / `test` / `typecheck` in this repo, or whatever the project uses) are the implementer's and reviewer's problem, and may be run at overall checkpoints. Beadwork does not own a per-ticket validation pipeline and does not migrate `landing.validateCommands` into a new gate.

### Review policy

```ts
type ReviewPolicy = "ticket" | "scope" | "none";
```

- `ticket` — default. Independent review before closing that ticket.
- `scope` — close individual tickets from evidence; independent review of the aggregate before declaring the epic complete. Dependents may start before aggregate review finds a problem. Say that tradeoff in config/docs.
- `none` — no automatic independent review.

The parent launches review children with `taskType: "reviewImplementation"` or `"reviewScope"` and the configured reviewer role. Adjudication is model judgment guided by the nudge. No keyword classifier.

Blocking finding → `fix` (remediate, re-review) or `reject` (record why). `file` creates durable follow-up and is for nonblocking work unless the user explicitly waives a blocking finding (ordinary user turn; no override-token machinery).

### Notable decisions

Autonomous by default. The parent recaps consequential decisions at the end of the goal. Persist anything durable with ordinary `bw comment`. No minions-side decision list.

### Epic completion

Minions quiescence is not epic completion. The parent judges from a fresh `bw` snapshot: in-scope descendants closed or explicitly excluded, no unresolved required fixes. Then it closes the epic with beadwork tools. Closing the scoped epic exits `run` mode. Halt of the minion group is a minions/user action, not gated on a domain token, and does not by itself exit goal mode.

---

## 13. Capability boundary (light)

Background children expand blast radius. Keep this small.

**Minions in children:** do not load the minions extension (avoids recursive `orchestrate`/`spawn`/`halt`). Inject bound comm/path tools into orchestrated sessions only.

**Beadwork in children (spawn and orchestrate):** load it. After `bindExtensions`, minions sets active tools. Child **allowlist** of beadwork tools:

- `beadwork_show`
- `beadwork_list_issues`
- `beadwork_issue_history`
- `beadwork_ready`
- `beadwork_blocked`
- `beadwork_status`
- `beadwork_prime`

Everything else beadwork remains parent-only, including start/close/reopen/create/update/comment/label/defer/undefer/dependencies/`beadwork_sync`. Deleted for all sessions: `beadwork_delegate`, `beadwork_worker_done`, `beadwork_land_worker`, `beadwork_worker_check`.

Effective tools:

```text
(role allowlist if present, else parent coding tools)
  ∪ beadwork inspection allowlist
  ∪ injected comm tools (orchestrated only)
  − {beadwork_start_issue, beadwork_close_issue, beadwork_reopen_issue}
```

Role cannot omit inspection/comm and cannot add close. Shell `bw close` / `bw comment` remains possible; parent refresh notices it.

This is a tool-visibility boundary, not a sandbox.

---

## 14. Package and module changes

### `packages/pi-minions`

- `src/types.ts` — role, task type, group, domain metadata, messages, path intent, packet types, nudge events.
- `src/tools/spawn.ts` — unchanged foreground contract; still not grouped.
- new `src/tools/orchestrate.ts` — non-blocking registration and handles.
- `src/spawn/*` and `src/subsessions/manager.ts` — share session factory; split start from wait; fully-idle completion; real runtime dispose on shutdown; no `agent_end` terminal; inject bound comm tools on orchestrated children; **do not** exclude beadwork wholesale; after bind, apply the inspection allowlist ∪ comm ∪ coding/role formula to **both** spawn and orchestrate children.
- `src/tree.ts` — canonical live registry with group/role/taskType/description/domain; distinguish orchestrated vs spawn nodes.
- new `src/orchestration/` — groups, per-child nudge selection, idle coalescing, parent delivery.
- new `src/task-types.ts` — closed union (no `validation`) and policy strings per event class.
- `src/agents.ts` — optional role `completion_nudge`.
- new `src/messaging/` — peer directory, live-only delivery, parent-message path, inspection.
- new `src/coordination/` — advisory TTL intent and overlap notices.
- commands/status/renderers — groups, task types, packets, messages (minions UI, not beadwork).
- tests — lifecycle, idle coalescing, precedence per event, messaging to live vs terminal, shutdown, prose settlement, spawn-not-in-fleet.

How beadwork tools are filtered: the child `ResourceLoader` still loads beadwork; minions, after bind, applies `setActiveToolsByName` (or equivalent) using the formula in §13. Beadwork does not need a child-mode. Do not rely on “beadwork isn't installed.”

### `packages/pi-beadwork-extension`

- `src/index.ts` — drop worker runtime and supervisor; keep domain tools, scope, prompts, goal mode; `/bw run` validates + stores goal + injects the go-prompt.
- `src/prompt.ts` — goal-mode policy and minion usage; how to compose child `task` strings; inspection vs close rules for children.
- `src/types.ts` / `src/config.ts` / `src/session-state.ts` — remove tmux, supervisor, landing, worktree, `RunOptions` worker/until/cycles/noSpawn/dryRun. Goal record + review policy only.
- `src/orchestrator.ts` — delete. Do not wrap it. Move any remaining domain helpers (attribution, prompt fragments) out first if still needed.
- `src/tmux.ts`, worker markers, live `registry.ts` as execution truth — remove.
- `src/worktree.ts` — delete managed lifecycle.
- `src/handoff.ts` — prompt context / evidence hints, not process shutdown.
- `src/attribution.ts` — keep as domain helper for parent context.
- TUI — issue/goal views remain; **delete** worker manager, land/cleanup, workers tab. No minion rows in beadwork. Command/statusline copy must not say “bounded epic loop” or show worker counts.
- CLI/completions — `/bw run` takes an epic id only; reject supervisor flags and `print`/`json`.
- tests/e2e — replace tmux swarm with in-process minion + beadwork scenarios; drop supervisor-flag tests.

### Dependency direction

`pi-minions` must not import beadwork.

Beadwork must not import the live minions runtime. Types-only is allowed if needed and does not construct a second `AgentTree`. The parent model and minions tools are how anyone inspects the fleet.

If minions is absent, `/bw run` still kickoffs; the parent turn fails when it calls `orchestrate`. No probe/ack. Optional warn only if the parent tool registry is enumerable.

---

## 15. API surface

### Minions

| Surface | Behavior |
| --- | --- |
| `spawn` | Foreground, blocking, `agent` selector preserved. Not grouped. Same inspection allowlist as orchestrated children. |
| `orchestrate` | Non-blocking. Metadata in, handles out. One open group per session. `accepted` is registered, not running. |
| `list_minions` | Include role, task type, description, group, domain, communication indicators. Distinguish spawn vs orchestrated. |
| `show_minion` | Full output, messages, path intent, activity. Canonical place for large text. |
| `halt` | Abort one child or a group. User/parent. Children do not halt peers. Abort emits `aborted`, not `failed`. |
| `send_minion_message` | **Parent** → live child. Not installed on children. |
| injected child list-peers / send / announce | Bound closures on orchestrated children only. |

Keep the tool count small.

### Beadwork

- `/bw run <epic>` — goal mode + injected prompt. No supervisor flags. Persistent hosts only. Same-epic retry; different-epic reject while a goal is active. Explicit abandon or scoped-epic close exits `run`.
- Existing issue CRUD, ready, start, close, comment, `beadwork_sync` remain on the **parent**.
- Children get the inspection allowlist in §13.
- Deleted: `beadwork_delegate`, `beadwork_worker_done`, `beadwork_land_worker`, `beadwork_worker_check`.
- Worker inspection/landing tools and TUI actions removed.

### Config cutover

Major-version cutover. No worker-shaped shims. Load config, report **all** migration errors together, refuse to start goal mode on supervisor leftovers.

Reject with an actionable removal error (JSON keys and corresponding `PI_BEADWORK_*` env vars):

- all `tmux.*`
- all `worktrees.*`
- all `landing.*` (including `validateCommands` — not migrated into a new gate)
- all `supervisor.*`
- `workerExecution.*`
- `run.defaultWorkers`, `run.defaultUntil`, `run.defaultMaxCycles`, `run.pollIntervalMs`
- `storage.workerRegistryFile`, `storage.runtimeDir`

Keep only what still means something without a supervisor: UI/status display knobs, session-state cache directory, review policy (`ticket` / `scope` / `none`) and reviewer role/model if those exist as unambiguous display/prompt settings.

Do not silently select a backend. Do not map old worker-review flags onto a validation runner.

---

## 16. State and persistence

**Process-local (minions):** groups, child handles, pending packets, in-memory message queues, path TTLs, consumed notifications.

**File-backed:** child session transcripts via existing Pi session files, for inspection only.

**Durable (beadwork):** issues, dependencies, comments, labels, history. Goal record in ordinary session state. No parallel orchestration log format. No minions decision journal.

**Parent death / session replacement:** children die; in-memory messages and packets are lost; no takeover; persisted `run` is interrupted and must not auto-kickoff; tickets are still in `bw`.

This is an accepted tradeoff, not a degraded implementation of detached durability.

---

## 17. Integration sequencing

No published beadwork release keeps tmux as fallback after cutover, and no published release removes tmux before an in-process ticket can run. Implementation may still land in slices. Phase B is a **development** exit, not a user release, until review-default epic flow in Phase D exists.

### Phase A — Orchestration core in minions

- split child start from foreground wait;
- `orchestrate` handles, groups, one cwd;
- extend `AgentTree` (orchestrated vs spawn);
- fully-idle / aborted / failed;
- task-type union (no `validation`) and per-event nudge table;
- role fallback parsing;
- coalesced packets including idle fold + no mid-turn parent injection;
- shutdown abort/dispose;
- child comm tools injected on orchestrated sessions; minions extension not loaded in children; inspection allowlist applied to spawn and orchestrate;
- one open group per parent session; `accepted` is registered not running;
- settlement vs inbound mail single-winner; `aborted` ≠ `failed`;
- preserve `spawn`.

**Exit:** generic orchestrated children run while the parent stays interactive; `fix` vs `reviewImplementation` produce distinct per-child nudges; a typed child that emits prose still settles; four idle completions → one parent turn; `spawn` does not appear in the orchestrated fleet.

### Phase B — Beadwork cutover (dev slice)

- `/bw run <epic>` is goal + kickoff, not a tmux supervisor;
- reject supervisor flags/config;
- domain metadata on orchestrated children; parent composes `task`;
- completion packets come only from minions;
- delete `beadwork_delegate` / `beadwork_worker_done` / `beadwork_land_worker` / `beadwork_worker_check` / `runBoundedEpicLoop`;
- remove tmux, polling, pane inspection, runtime markers, landing, worktree manager, workers TUI;
- child beadwork inspection allowlist after bind;
- `/bw run` persistent-host only; same-epic kickoff retry; stale `run` not auto-resumed;
- rewrite tmux e2e to in-process scenarios.

**Exit:** one ticket implement through minions without tmux; no production beadwork path references the old runtime. Not a published cutover until Phase D.

### Phase C — Messaging and advisory coordination

- peer discovery and addressed messages to live children;
- parent-directed child messages as coalesced wakes with `parentMessage` nudges;
- TTL path intent and overlap notices;
- terminal recipient fails; no parked sessions;
- mail vs settle single-winner; bound child send (not parent tool).

**Exit:** two live children notice overlap, message each other, continue; no parent relay; no lock; message after settle fails; mail-before-idle yields one later `settled`.

### Phase D — One epic (published cutover)

- parent drives ready tickets through `orchestrate`;
- default ticket review;
- `fix | file | reject` as parent judgment;
- remediation via typed `fix` / re-review;
- notable decisions as recap/`bw comment`;
- implementers/reviewers run project quality commands as ordinary work.

**Exit:** one epic reaches a verified outcome with a single live orchestration runtime; tmux gone in the published packages.

### Phase E — later

- scope-level review mode polish;
- multi-epic `scopeIds`;
- optional observed path overlap from edit tools;
- optional beadwork TUI link to minion status;
- nothing in **Do not**.

---

## 18. Error handling

| Failure | Behavior |
| --- | --- |
| Invalid descriptor / unsupported host | Synchronous reject. |
| Missing `description` | Synchronous reject. |
| Partial batch start | Keep successful handles; fail the rest. |
| Child fails to start | Terminal failed; packet with error. Do not report a running handle as successful. |
| Child dies early | Distinguish `aborted` vs `failed` vs `settled`. Keep partial output. |
| Child aborted | `aborted` nudge; do not retry unless the user asks. |
| Mail after settlement committed | `recipient-terminal`; no second settled packet. |
| Mail accepted before idle | Continuation runs; one `settled` after it idles. |
| Omit groupId with one open group | Join it. Second group id rejects. |
| `/bw run` in print/json | Synchronous reject. |
| `/bw run` different epic while goal active | Reject until current goal exits. |
| `/bw run` same epic | Resend kickoff. |
| Stale persisted `run` | Interrupted; no auto-kickoff. |
| Injected `/bw run` prompt with minions absent | No probe; parent turn fails on `orchestrate`. |
| Parent busy or idle, several children finish | Coalesce; one fleet snapshot; per-child nudges. |
| Peer unavailable / terminal | Clear delivery failure to sender; inspectable metadata; no parent reroute; do not keep the session. |
| Path TTL expires | Drop the notice. Do not infer the agent stopped touching the path. |
| Same file, two editors | Warn if known. Do not block. |
| Parent exits | Children may die. Packets/messages lost. `bw` survives. |
| Task type vs role disagree | Task-type nudge wins. Show both values. |
| Review output is messy prose | Parent asks, re-reviews, or rejects claims. No classifier. |
| Child forgets any handoff format | Still settled. Parent reads the text and Git. |
| Two sessions `/bw run` one epic | No lock. User/model reconcile from `bw`. |
| Child `bw close` via shell | Parent refresh should notice. V1 cannot prevent it. |
| Supervisor flag/config present | Actionable reject; do not start goal mode. |
| Minions extension absent | Kickoff still sent; parent fails when calling `orchestrate`. No probe. |
| `in_progress` ticket with no live child | Visible in `bw`; parent re-dispatches or user fixes. No saga. |
| Reviewer sees dirty unrelated files | Accepted shared-checkout limitation. |

---

## 19. Testing strategy

### Minions unit

- task-type schema accepts only the five values; rejects `validation` and unknown strings; role accepts arbitrary strings;
- `description` required;
- nudge precedence: task type > role > generic; no concatenation; `parentMessage` and `aborted` never use the settled generic;
- coalesced mixed task types keep per-child nudges;
- `AgentTree` preserves group, role, task type, description, domain; spawn nodes are not in orchestrated snapshots;
- idle and busy coalescing: several events → one packet;
- consumed packets do not double-wake;
- TTL intent expires without blocking;
- overlap creates notices, never enforcement;
- messages preserve sender/recipient; missing and terminal peers fail clearly;
- second `groupId` rejects; omitted `groupId` joins the one open group;
- `accepted`/`starting` is not treated as running;
- prose-only typed child still settles.

### Minions integration

- `spawn` still blocks and returns results, is absent from orchestrated fleet snapshots, and gets the inspection allowlist (no close);
- `orchestrate` returns before completion; rejected in print/json;
- halt emits `aborted` not `failed`;
- mail-after-settle fails; mail-before-idle extends then one `settled`;
- parent interactive while children run;
- settlement is not emitted on premature `agent_end`;
- abort/failure terminal states;
- several near-simultaneous completions on an **idle** parent → one packet / one turn;
- packet not delivered as `steer` into an active parent turn;
- idle parent + packet → turn starts;
- peer messages at a safe child boundary without a parent turn;
- child → parent message is a `parentMessage` packet and the child is still running;
- message after dispose fails;
- parent shutdown does not leak runnable children;
- stale transcripts are not shown as live after restart.

### Beadwork integration

- `/bw run <epic>` kickoff without tmux, polling, or worker flags; rejected in print/json;
- same-epic `/bw run` resends kickoff; different epic rejected while goal active;
- closing the scoped epic exits `run`; halt alone does not;
- persisted `run` after `/new` does not auto-kickoff;
- supervisor flags/config rejected;
- `beadwork_land_worker` / `beadwork_worker_check` unregistered;
- descriptors carry ticket/epic metadata;
- parent-composed `task` is what the child sees (no secret wrap);
- settlement does not close the ticket;
- default ticket policy asks the parent to review before close;
- `reviewImplementation` nudge asks `fix | file | reject`;
- children can `beadwork_show` a closed issue and cannot call `beadwork_close_issue`;
- notable decisions appear as recap and/or `bw comment`;
- one epic can complete;
- works when tmux is absent;
- no worktree without explicit user cwd;
- no beadwork fleet UI / no live `AgentTree` import.

### Removal regressions

- no production import of beadwork `tmux.ts`;
- no tool description promises tmux workers;
- no config requires tmux session/window/pane or `landing.validateCommands`;
- no scheduler selects `worktree`;
- no path intent rejects writes;
- beadwork emits no duplicate model-visible lifecycle message for a minion-owned child;
- no permit/bind/report-result/`shouldStopAfterTurn` orchestration symbols in production source;
- no `runBoundedEpicLoop`, `defaultWorkers`, `maxCycles`, `noSpawn` in the live CLI;
- no `beadwork_land_worker` / `beadwork_worker_check`;
- no auto-kickoff from session JSON.

### Quality gates

Every slice:

```sh
npm run lint
npm run test
npm run typecheck
```

Logic changes need focused tests in the affected workspace. Cutover also needs `npm run build` and a manual TUI smoke: parent stays interactive, one packet after several children settle while idle, `/bw run` does not spawn tmux and does not accept `--workers`.

---

## 20. Risks

**Task-type proliferation.** Mitigation: add a value only for a distinct parent question. Keep ordinary work untyped. `validation` stays gone.

**Prompt conflicts between role and workflow.** Mitigation: strict precedence; never concatenate; event class is part of selection.

**Parent-turn noise and cost.** The supervisor is now an LLM. Idle coalescing is a cost feature. Packets stay bounded; `show_minion` holds the rest.

**Over-automation.** Nudges are instructions. Tests must prove they do not close, spawn, or adjudicate.

**Beadwork remains a hidden orchestrator.** One lifecycle owner. Delete tmux/supervisor modules. Duplicate-delivery regressions. No `--workers` backdoor into minions.

**Shared-checkout conflicts and dirty review trees.** Visibility, messaging, commit-oriented review prompts; explicitly best effort.

**In-process blast radius.** A stuck child can require Pi exit. Cooperative cancel only. Document this; it is the price of dropping tmux. Shutdown dispose is mandatory hygiene.

**Child shell closes tickets.** Tool hiding plus prompt plus parent refresh. Not OS enforcement.

**Parent forgets `bw start` or over-spawns.** Accepted. Ready/in-progress state is visible; no mechanical fan-out cap from beadwork.

**Dynamic role quality.** Use task types when the parent question must be reliable.

**Extension coupling.** No live runtime import; no event-handshake product; no `/bw run` probe.

**Stale goal JSON.** Persisted `run` must not resurrect a fleet. Interrupted, user re-runs `/bw run`.

---

## 21. Remaining implementation questions

Product and architecture are locked. Implementation planning may still choose:

1. default numeric bounds that are **minions-local** (message bytes, packet output bounds, path-intent TTL) — not beadwork-configured;
2. exact child-facing tool names for list-peers / send / announce (identity stays a bound closure);
3. exact in-process coalesce mechanic (queue drain vs short fold window) as long as idle multi-complete is one turn;
4. default reviewer role name for goal prompt text;
5. the explicit user command spelling for abandoning goal mode (`/bw` subcommand vs existing halt-plus-mode).

None of these reopens tmux, schemas, permits, locks, hidden schedulers, `--workers` coupling, validation task types, or beadwork fleet UI.

---

## 22. Handoff

Implement from this file only.

**Invariant:** Role selects behavior; task type selects workflow guidance; beadwork supplies domain context; minions owns orchestration mechanics; child output is unstructured evidence; the parent model judges; beadwork does not supervise.

Planning should focus on wiring, not re-opening the constitution:

1. split non-blocking start from `Promise.allSettled()` without duplicating session code;
2. fully-idle vs `agent_end`, and real child runtime dispose on parent shutdown;
3. packet delivery with `followUp` + idle `triggerTurn` + idle coalescing tests;
4. `/bw run` injected prompt; parent-composed `task`; domain metadata without a second completion channel;
5. which beadwork runtime modules delete outright at cutover, including supervisor flags;
6. child messaging tools without exposing `orchestrate`; beadwork inspection without start/close;
7. one open group per session, one cwd; spawn excluded from fleet snapshots;
8. ticket vs scope review as prompt/policy, not a second scheduler.

---

## Appendix A: Evidence pointers

### `pi-minions`

- `packages/pi-minions/src/tools/spawn.ts` — foreground `Promise.allSettled()`
- `packages/pi-minions/src/subsessions/manager.ts` — child sessions, `agent_end` completion, no-op shutdown, extension exclude list
- `packages/pi-minions/src/tree.ts` — live fleet registry
- `packages/pi-minions/src/agents.ts` — dynamic roles
- `packages/pi-minions/src/index.ts` — registration and parent surfaces

### `pi-beadwork-extension`

- `src/orchestrator.ts` — tmux/process supervisor (`runBoundedEpicLoop`)
- `src/tmux.ts` — launch/inspection
- `src/types.ts` / `src/config.ts` / `src/session-state.ts` — worker runtime, supervisor flags; persisted `run` / `trackedWorkerIds` must not auto-resume
- `src/actions/run.ts` — `/bw run` currently starts the supervisor
- `src/index.ts` — `beadwork_delegate`, `beadwork_worker_done`, `beadwork_land_worker`, `beadwork_worker_check`, mutating tools
- `src/tui/dashboard.ts` / `src/tui/worker-manager.ts` — workers tab / worker UI to delete
- `src/command-aliases.ts` — “bounded epic loop” copy
- `src/prompt.ts` — current orchestration prompt
- `src/bw.ts` — durable domain adapter
- `src/attribution.ts` — domain helpers to keep

### Pi APIs this design relies on

- `pi.sendMessage(..., { triggerTurn, deliverAs: "followUp" })` — idle wake, in-turn wait, kickoff, packets
- Child fully idle (`agent_settled` / `waitForIdle` / `prompt()` after continuations drain) — terminal, not success
- child session dispose on parent `session_shutdown`
- persistent `tui` / `rpc` vs `print` / `json` host lifetime
- `session.setActiveToolsByName` (or equivalent) for child tool filtering

Not required: `shouldStopAfterTurn`.

### Quality

- `AGENTS.md` — atomic commits; lint / test / typecheck
- package tests under `packages/pi-minions/src/__tests__/` and `packages/pi-beadwork-extension/src/__tests__/`
