## Assessment

The feedback identifies real problems, but several proposed remedies target the wrong layer.

### 1. `role` semantics and validation — valid

`orchestrate.role` is described as an “open string,” but it must resolve to a discovered agent definition (`tools/orchestrate.ts:122-133`). That wording encourages semantic values such as `worker`, which then fail as `unknown role`.

Recommended direction:

- Canonicalize on **`agent`** across `spawn` and `orchestrate`.
- Keep `taskType` separate; it is workflow policy, not an agent template.
- Describe `agent` as “a discovered agent/template name,” not merely an open string.
- Add bundled, lowest-precedence defaults:
  - `worker` — equivalent to the current `general-coder`.
  - `investigate` — evidence-gathering, non-mutating unless explicitly instructed.
- Let project definitions override built-ins.

If compatibility matters, accept `role` temporarily as a deprecated alias, but store only the canonical field. Otherwise, given the early package version, a clean rename is preferable to carrying both concepts indefinitely.

### 2. Misleading success reporting — valid and broader than the feedback suggests

The textual result correctly says “starting” and “rejected,” but `orchestrate` uses the spawn renderer even though its result shape is not `SpawnToolDetails` (`index.ts:109-110`, `render.ts:96-170`). Fallback rendering can label entries `completed` whenever the tool itself did not throw.

There is also a state-model error:

- Registration inserts nodes as `running`.
- `accepted[].state` says `starting`.
- A later `started` lifecycle event exists but is ignored by packet dispatch.
- Therefore inspection can report “running” before a child session is live.

Recommended:

- Give `orchestrate` a dedicated renderer: **registered / starting / rejected**, never completed.
- Register nodes as `pending`; transition to `running` only after `startChild` returns a handle.
- Consume `started` locally without waking the parent.
- Treat all-rejected registration as an error or unmistakable rejection outcome.

Additional bug: group creation currently happens before task validation. An all-rejected batch leaves an empty open group with an immutable `cwd`. Group creation should commit only when at least one task is accepted.

### 3. Parent progress visibility — valid; solve human and model visibility separately

The existing plumbing is sufficient but rendered poorly:

- Tool starts, text deltas, and turn counts already reach `AgentTree`.
- `turn N` overwrites more useful activity.
- `lastSaid` is not actually “said”; it returns `lastActivity` first.
- The persistent status shows only counts.
- `/minions` provides detail, but only after explicit operator interaction.

Recommended design:

#### Human operator

Use a persistent `setWidget()` fleet summary above the editor while children are active:

```text
3 active · group grp-1234
otto  implementation       Add auth guard        → npm test
mel   reviewImplementation Review auth commit    reading src/auth.ts
lola  investigateBlocker   Trace retry failure   waiting on parent
```

- Cap visible rows and show `+N more`; do not add configuration initially.
- Keep `/minions` as the interactive drill-down.
- Do not replace the footer or use a focus-stealing overlay.
- Render using the supplied component width and ANSI-aware truncation.

#### Parent model

Do not send periodic progress messages—they would wake turns, increase cost, and recreate polling.

Instead:

- Preserve meaningful snapshots in `list_minions`.
- Include the fleet snapshot in real lifecycle packets.
- **Superseded:** The initial recommendation was to inject current live-group state into active parent turns. Do not implement that design. State-driven system-prompt changes create provider cache churn, and Pi queued continuations can retain a frozen prompt override that makes the state stale or contradictory. The replacement is cache-stable static conditional `orchestrate` guidance; lifecycle registration/results, state-change and terminal packets, explicit inspection, and halt are authoritative.
- Emit an explicit **group idle** indication when the final child settles. Idle means “ready for adjudication,” not success.

Internally, use a small structured live activity state—`starting`, `thinking`, `tool`, `waiting`, `settling`—derived from runtime events. This is not the rejected structured terminal-result contract. Avoid treating arbitrary streamed prose as canonical progress.

### 4. Parent-induced semantic churn — valid

Core guidance currently says background work should not block the parent, but does not say what the parent may safely continue doing. That invites concurrent edits to delegated scope.

Two operating patterns need explicit guidance:

- **Cooperative sidecar:** the parent may continue independent work but must not edit delegated scope while its child is live.
- **Manager-only:** the parent dispatches, adjudicates, reviews, and keeps work in flight; it does not concurrently implement delegated tickets.

Beadwork run mode is manager-only but does not say so strongly enough in `pi-beadwork-extension/src/prompt.ts`.

I would **not add a group mode field yet**. First encode the policy where it is known:

- General minions guidance defines sidecar boundaries.
- `/bw run` explicitly defines manager-only behavior.

If later tooling or enforcement genuinely needs this distinction, add immutable `operatingMode: "sidecar" | "manager"` group metadata. Do not infer it from `domain.source`; domain metadata is intentionally opaque.

For Beadwork shared-checkout work, implementation prompts should explicitly require an atomic commit and return its SHA. Reviewers should inspect that SHA after the implementer settles. Commit detection by minions would be unreliable attribution in a shared checkout.

### 5. Completion barrier — concern valid, proposed structured result is not

Child settlement already waits for true idle, including queued mail and trailing events. Lifecycle packets use follow-up delivery. The missing boundary is at the **group/goal level**, not the child return shape.

Correct barrier:

1. A parent turn may end while children run.
2. The parent must not claim completion while the group is active.
3. Final-child settlement emits a group-idle continuation.
4. The parent then evaluates Git, Beadwork state, reviews, and acceptance.
5. Only that adjudication permits goal completion.

Do not add polling, an `await_group` tool, or synchronous waiting to `orchestrate`; that would duplicate `spawn` and defeat the nonblocking design.

### 6. Agents cannot explicitly enter Beadwork goal mode — valid missing capability

`/bw run <epic-id>` is currently a human-only command. It validates the host and epic, persists the v1 goal and review policy, arms the standing manager appendix, and queues a continuation. A parent model can independently decide to execute a decomposed epic, but the tool API exposes only the lower-level ticket operations. The model can imitate a run by calling `beadwork_ready`, `beadwork_start_issue`, and `orchestrate`, but it cannot establish the durable goal lifecycle and therefore misses conflict protection, interrupted-run handling, automatic exit, and persistent manager-only policy.

Recommended tool: **`beadwork_start_goal`** with required `{ epic_id }`.

Why this name:

- `start_goal` describes the actual state transition and fits the existing `beadwork_*` tool namespace.
- `run_epic` sounds synchronous or implies the tool executes the entire epic itself.
- `impl_epic` / `implement_epic` is incorrect: the parent manages dispatch, evidence, review, and ticket lifecycle while children implement.
- `enter_goal_mode` is accurate but exposes internal terminology and is less action-oriented.

The tool and `/bw run` should share one goal-start domain operation, not call each other through synthetic command text or duplicate validation. The tool must preserve the command's active-repository, persistent-host, open-epic, descendant, config, review-policy, same-goal retry, conflicting-goal, state-persistence, and continuation semantics.

When called by a busy parent model, it should queue the existing continuation as `followUp`. Its result should truthfully report `started` or `resumed`, the goal and review policy, and whether continuation was queued; it must not claim implementation or orchestration has completed. Starting a goal must not itself select ready work, start tickets, or launch children.

This remains an intentional transition, not automatic behavior. The model should use it after choosing to execute an already-decomposed epic. Merely discovering an epic or creating a graph must not silently start goal mode.

## Additional findings

- `lastSaid` conflates activity, messages, and output. These should be separate fields.
- `activityHistory` grows without a bound. Keep a small ring buffer; the full transcript is canonical.
- Live tool activity omits formatted arguments even though transcript rehydration uses `formatToolCall()`.
- Raw streamed child text can contain control sequences and is not suitable for an always-visible status line.
- Beadwork’s current contract remains parent-owned: children cannot claim/start/close tickets. Feedback suggesting child ticket mutation conflicts with the locked V1 boundary.

## Suggested order

1. Normalize `agent`/`role`; add built-in `worker` and `investigate`.
2. Correct registration state and dedicated `orchestrate` rendering.
3. Expose `beadwork_start_goal` so parent models can intentionally enter the same goal lifecycle as `/bw run`.
4. Replace `turn N` with runtime-derived activity phases.
5. Add the persistent fleet widget and explicit group-idle presentation.
6. Tighten sidecar and Beadwork manager-only prompt guidance, including when to start a goal.
7. Consider explicit group mode only if the prompt boundary proves insufficient.

## Decision Ledger

**Recommended**
- Canonical `agent`, separate `taskType`.
- Runtime-derived progress, persistent fleet widget, group-idle continuation.
- Prompt-level sidecar/manager distinction first.
- Agent-callable `beadwork_start_goal` sharing `/bw run` lifecycle semantics.

**Closed doors**
- Structured terminal-result objects.
- Polling or synchronous orchestration barriers.
- Inferring operating mode from opaque domain metadata.
- Auto-starting goal mode merely because an epic exists or is ready.
- Naming the transition `run_epic` or `implement_epic`, which implies synchronous execution or wrong ownership.
- Commit attribution heuristics in a shared checkout.

**Invariant**
- Settlement is evidence, not acceptance.
- Registration is not liveness.
- Ending a parent turn is not ending an active orchestration goal.
- Starting a goal establishes manager intent and persistent policy; it does not itself dispatch or complete work.

## Handoff

- **Status:** Recommendation expanded and Beadwork implementation graph created; no production implementation performed.
- **Validation:** Source review plus Beadwork dependency/ready-set validation.
- **Next step:** Implement from the ready frontier, beginning with the canonical agent cutover.