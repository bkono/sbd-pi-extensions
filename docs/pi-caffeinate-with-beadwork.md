# pi-caffeinate with beadwork

Date: 2026-04-18

## Goal

Capture whether `pi-caffeinate` is a good fit for keeping beadwork-driven work awake, and turn that assessment into concrete guidance for implementing a native caffeinate feature inside the beadwork extension.

## Short answer

`pi-caffeinate` is a **partial fit**, not a complete solution.

It should help during the time an actual delegated `pi` worker is actively running, because the beadwork extension currently launches delegated workers with `pi` by default and normalizes that command to `pi --mode json`.

It does **not** reliably cover the full beadwork lifecycle, because beadwork work is not just "a pi agent is running." The extension also relies on:

- parent-session background supervision and polling
- plain subprocess validation commands
- merge-back / landing checks
- cleanup and worktree management
- reviewer runs that explicitly disable extensions

So installing `pi-caffeinate` would likely keep the machine awake for the **active worker-runtime slice** of the lifecycle, but not for the full delegated `/bw delegate` or bounded `/bw run` orchestration story.

---

## What `pi-caffeinate` does

The relevant behavior of `pi-caffeinate` is:

- it engages when a `pi` agent run starts
- it disengages when the agent ends or the session shuts down
- it keeps the machine awake via an OS-specific inhibition mechanism:
  - macOS: `caffeinate -i`
  - Linux: `systemd-inhibit --what=idle ... sleep infinity`
  - Windows: a PowerShell loop using `SetThreadExecutionState`

That design is a good match for **"keep the machine awake while this pi agent is actively running"**.

It is not, by itself, a match for **"keep the machine awake for the entire beadwork orchestration lifecycle, including non-agent phases"**.

---

## How beadwork currently runs work

The current beadwork extension is built around a tmux-backed worker model.

Important implementation facts from this repo:

- delegated workers use `tmux` windows/panes
- the default worker command is `pi`
- a bare `pi` worker command is normalized to `pi --mode json`
- worker activity is streamed into `worker.log`
- `/bw run` uses the same worker backend/orchestration model as delegation
- background supervision is session-local and polling-based, not a standalone daemon
- after a worker exits, the orchestrator performs validation, review, merge-back, and cleanup

The repo documentation already calls out a few of these boundaries explicitly:

- background supervision is **session-local**
- supervision is periodic **polling**
- validation runs synchronously in delegated worktrees
- reviewer gating is a separate post-worker step when enabled

---

## Where `pi-caffeinate` would help

### 1. Active delegated worker execution

This is the strongest fit.

When beadwork launches a delegated worker and the worker command resolves to `pi`, the extension runs that worker as `pi --mode json` in tmux. That should allow `pi-caffeinate` to engage for the lifetime of that active worker process.

This means:

- `/bw delegate <ticket>` should likely stay awake while the delegated `pi` worker is actively running
- `/bw run <epic>` should likely stay awake during the active runtime of each spawned delegated `pi` worker

If the only requirement were "prevent sleep while a child `pi` worker is executing," `pi-caffeinate` would be a reasonable plug-in answer.

---

## Where `pi-caffeinate` would not be enough

### 1. Parent-session supervision and polling

The beadwork extension keeps supervising workers from the parent session.

That supervision is not the same thing as an actively running child `pi` worker. It is periodic orchestration logic in the parent extension. The extension README and workflow docs are clear that this is session-local polling rather than a daemon.

So there can be important periods where:

- no child worker is actively running anymore
- but beadwork still has unfinished orchestration work to do

`pi-caffeinate` does not obviously cover that parent-owned orchestration state.

### 2. Post-worker validation

After a worker exits, beadwork runs validation commands such as:

- `npm run lint`
- `npm run test`
- `npm run typecheck`

Those are plain subprocesses launched by the orchestrator, not extension-enabled child `pi` sessions. If the machine slept during this stage, `pi-caffeinate` would not be the thing keeping it awake.

### 3. Landing and merge-back

After validation, beadwork can still perform additional non-worker work:

- landing verification
- rebase / fast-forward checks
- merge-back
- runtime/worktree cleanup

These are orchestration steps driven by the beadwork extension and git/bash subprocesses, not by an actively running delegated `pi` worker.

Again, this falls outside the core protection model of `pi-caffeinate`.

### 4. Reviewer gating explicitly disables extensions

This is the biggest hard boundary.

The beadwork extension builds reviewer commands by taking the `pi` command and appending:

- `--no-tools`
- `--no-extensions`
- `--no-skills`

So even when the reviewer is still a `pi` process, it is intentionally launched in a mode that disables extensions. That means `pi-caffeinate` would not be available during reviewer gating.

This matters because reviewer gating is part of the delegated lifecycle in the current extension design.

### 5. Full `/bw run` semantics are broader than worker runtime

`/bw run` is not just "spawn a worker and wait."

It is a bounded orchestration loop that can:

- read the ready queue
- spawn workers
- supervise running workers
- continue later on idle turns
- react to exits
- run post-worker landing logic

Only some of that is active child `pi` runtime. `pi-caffeinate` only addresses that subset.

---

## Lifecycle coverage matrix

| Lifecycle phase | Covered by `pi-caffeinate`? | Why |
| --- | --- | --- |
| Active delegated worker in tmux | Yes, probably | Default worker command is `pi`, normalized to `pi --mode json` |
| `/bw delegate` while worker is actively coding | Yes, probably | Same reason as above |
| `/bw run` while a worker is actively coding | Yes, probably | Same worker backend/path |
| Parent-session polling/supervision | No / not reliably | Parent extension logic is not the same as an active worker agent run |
| Validation commands (`lint`, `test`, `typecheck`) | No | These are plain subprocesses |
| Landing verification / merge-back | No | These are orchestrator-owned git/bash steps |
| Reviewer gating | No | Reviewer runs explicitly disable extensions |
| Cleanup after landing | No | Cleanup is orchestrator-owned, not worker-owned |
| Entire delegated lifecycle from launch to final landing | No | Only the active worker slice is covered |

---

## Conclusion

`pi-caffeinate` is useful evidence that "keep awake while work is active" is a real need, but it is not sufficient as the implementation strategy for beadwork.

If the goal is:

> keep the machine awake until a delegated worker or `/bw run` lifecycle is truly done

then the correct ownership boundary is **inside the beadwork extension itself**, not only inside child `pi` agents.

Beadwork needs a native caffeinate/inhibit capability that is aware of the full orchestration lifecycle.

---

## What a native beadwork caffeinate feature should do

A beadwork-native implementation should treat wake inhibition as an **orchestrator resource**, not just an agent runtime hook.

### Core requirement

Hold the machine awake from the moment beadwork starts meaningful delegated orchestration until all relevant post-worker work is complete.

That means covering:

1. active delegated worker runtime
2. parent-session supervision while work is still in flight
3. post-worker validation
4. reviewer gating
5. landing / merge-back
6. cleanup when configured

### Desired behavior

#### 1. Reference-counted lifecycle ownership

If multiple workers are active, or one worker finishes while another is still validating, the system should keep the inhibit lock until **all tracked work** is done.

This suggests a small internal manager with acquire/release semantics rather than ad hoc process spawning.

#### 2. Parent-owned inhibition, not worker-owned inhibition

The parent beadwork extension should own the wake lock.

That avoids gaps between:

- worker exit
- validation start
- reviewer execution
- merge-back completion

It also avoids relying on child workers to clean up correctly.

#### 3. OS-specific backends behind one abstraction

Mirror the same broad platform targets as `pi-caffeinate`:

- macOS via `caffeinate`
- Linux via `systemd-inhibit` when available
- Windows via a PowerShell / `SetThreadExecutionState` strategy

But expose that through a beadwork-local abstraction such as `WakeInhibitor`.

#### 4. Configurable policy

Likely config knobs:

```json
{
  "power": {
    "keepAwake": "off | delegated | run | always",
    "reason": "Optional operator-visible string"
  }
}
```

Possible meanings:

- `off` — never inhibit sleep
- `delegated` — inhibit during `/bw delegate` lifecycles
- `run` — inhibit during `/bw run` orchestration
- `always` — inhibit for any beadwork-owned background orchestration

#### 5. Strong crash/cleanup handling

The extension should clean up inhibition when:

- the parent session shuts down
- all tracked workers are done
- orchestration is cancelled
- a fatal error occurs during landing

It should also tolerate stale state and recover safely if a previous inhibitor process died or the session ended unexpectedly.

#### 6. Operator visibility

The feature should surface state in:

- `/bw status`
- `/bw workers`
- notifications/logs

Operators should be able to see whether beadwork believes wake inhibition is active, and why.

---

## Proposed epic shape

Epic title:

**Add native keep-awake / caffeinate support to the beadwork extension**

Epic goal:

Make delegated beadwork work and bounded `/bw run` orchestration able to keep the host machine awake until the beadwork-owned lifecycle is actually complete, including post-worker validation, review, landing, and cleanup.

### Suggested beads

#### 1. Design wake-inhibition lifecycle and config

Define:

- the lifecycle boundaries that acquire/release inhibition
- the config schema and defaults
- how wake state is represented in runtime/session state
- what counts as "done"

Acceptance notes:

- explicitly cover delegate, run, validation, review, landing, cleanup
- explicitly document what is out of scope

#### 2. Implement wake-inhibitor abstraction

Build a small internal module, for example:

- `src/power.ts`
- `acquireWakeLock()`
- `releaseWakeLock()`
- backend detection per OS

Acceptance notes:

- no beadwork flow logic inside the backend layer
- testable with mocked process runners

#### 3. Add macOS/Linux/Windows backends

Implement OS-specific inhibition strategies modeled after the practical approach used by `pi-caffeinate`.

Acceptance notes:

- graceful degradation when an OS backend is unavailable
- clear operator-visible error messages
- no orphaned inhibitor processes on normal shutdown

#### 4. Integrate wake ownership with delegated worker lifecycle

Acquire inhibition when delegated work starts and keep it across:

- worker launch
- worker runtime
- worker exit
- validation
- review
- landing
- cleanup

Acceptance notes:

- no gap between child worker exit and post-worker orchestration
- multiple concurrent workers remain reference-counted correctly

#### 5. Integrate with `/bw run` orchestration state

Make `/bw run` hold wake inhibition while it is actively orchestrating a scoped epic, including background continuation in the parent session.

Acceptance notes:

- bounded run + later idle-turn continuation remain covered
- inhibition ends when the run is truly quiescent/finished, not merely when a single cycle ends

#### 6. Add observability and docs

Expose wake-inhibition state in:

- status output
- worker diagnostics
- docs/configuration
- workflow docs

Acceptance notes:

- operators can tell why wake inhibition is active
- docs clearly explain lifecycle coverage and limitations

#### 7. Add tests for lifecycle edges

Key cases:

- worker active
- worker exited, validation running
- reviewer enabled
- deferred landing
- multiple workers
- fatal error during landing
- parent session shutdown cleanup
- backend unavailable

Acceptance notes:

- unit tests for backend/process behavior
- unit/integration coverage for lifecycle ownership decisions

---

## Recommended implementation stance

Do **not** implement this as "install `pi-caffeinate` and call it done."

Instead:

- borrow the OS inhibition ideas
- keep lifecycle ownership in beadwork
- make the parent extension responsible for the wake lock
- treat child `pi` workers as only one phase of the larger lifecycle

That gives beadwork the semantics users actually want:

> If beadwork is still doing meaningful delegated work, the machine should stay awake.

---

## Decision

For beadwork, `pi-caffeinate` should be treated as:

- a useful reference implementation for OS-specific keep-awake techniques
- a partial runtime aid for active child workers
- **not** the final answer for full delegated or `/bw run` lifecycle coverage

The real feature should be implemented directly in the beadwork extension.
