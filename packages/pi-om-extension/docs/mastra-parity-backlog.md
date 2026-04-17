# Mastra parity backlog for `@solvedbydev/pi-om-extension`

**Date:** 2026-04-17  
**Status:** Proposed backlog  
**Audience:** maintainers of the single-session pi OM port

## Goal

Translate the earlier Mastra-vs-pi OM comparison into a practical backlog for this repo.

This backlog is intentionally filtered through the product we actually want to build:

- a **pi extension**
- optimized for **single sessions first**
- preserving the current preference to **avoid mid-turn prompt swaps**
- borrowing the Mastra ideas that most improve real long-session behavior
- **not** blindly porting the full Mastra subsystem

## Reconciliation with the maintainer notes

Your notes and my earlier assessment line up very closely.

### Where we strongly agree

These should be treated as the highest-value parity work:

- **better temporal reasoning**, especially converting stale relative references into durable absolute/ranged anchors
- **completion markers / completed-observation tracking**
- **preserving list structure, item distinctions, and exact numbers**
- **making the injected observation block more cache-friendly and stable**
- **some form of continuous/background observation** to improve extraction quality during long turns

### The important design reconciliation

The biggest design question is continuous observation.

I agree with your objection to the Mastra/OpenCode-style “observe + inject mid-turn” behavior. In pi, that risks exactly the failure mode you described: the model loses raw context during a run and re-reads files or repeats tool work.

So the parity target should **not** be “full Mastra mid-turn swap behavior.”

It should be:

> **observe continuously, publish discretely**

Meaning:

- do **background/incremental observation work during long turns**
- keep those results in a **staged buffer**
- do **not** advance the public pruning cursor or replace the injected observations mid-run
- only **publish** the staged observations when the turn completes and the next turn starts

That gives us most of the observation-quality win without reintroducing the context-loss problem.

### Where I would rank lower than a full Mastra port

These are real Mastra capabilities, but lower priority for this repo unless product goals expand:

- cross-thread / cross-resource memory
- thread titles and thread attribution
- global retrieval/provenance machinery
- DB-backed storage and search infra
- the full buffering/activation stack as a literal port

For pi OM, those belong behind the single-session improvements and likely behind an explicit opt-in project-memory design.

---

## Tier definitions

### Tier 1 — High practical impact, should drive the next parity work

These materially improve long-session quality in the current single-session pi model.

### Tier 2 — Worth doing after Tier 1

Useful parity work, but either lower leverage or dependent on Tier 1 foundations.

### Tier 3 — Later / optional / only if product scope expands

Good ideas, but not important enough to shape the next iteration of the single-session port.

---

## Tier 1 — Highest-value parity work

### 1. Temporal reasoning overhaul

**Mastra idea:** stronger time handling, relative-time interpretation, better chronology preservation.

**Why this is Tier 1:** relative references absolutely go stale in multi-day sessions. If memory keeps only words like “tomorrow” or “last week”, later turns can misread them as still-current. This is one of the biggest practical gaps today, and you explicitly called it out as something to fully embrace.

**Target behavior:** preserve the original phrasing for nuance, but attach a normalized time anchor so the memory still makes sense days later.

**Backlog items:**

- Normalize relative references into absolute dates or date ranges when confidence is high.
  - Examples:
    - “tomorrow” → target date
    - “next Friday” → target date
    - “earlier today” → same-day past reference
    - “last week” → prior-week date range
- Preserve both:
  - **when the statement was recorded**, and
  - **what time period the statement refers to**, when inferable.
- Add explicit handling for ambiguous or low-confidence phrases.
  - Do **not** invent fake precision.
  - Prefer coarse anchors like:
    - week of `2026-04-06`
    - late April 2026
    - upcoming week relative to `recordedAt`
- Improve rendering of time in the observation block so later turns can reason about recency without ambiguity.
  - Sweet-spot examples:
    - `tomorrow (target: 2026-04-18)`
    - `last week (week of 2026-04-06)`
    - `next week (approx: 2026-04-20..2026-04-26)`
- Preserve time-sensitive state changes explicitly.
  - Example: “User will switch from X to Y next week” should remain a future planned change, not collapse into a present completed fact.
- Add explicit handling for elapsed-time and gap reasoning.
  - Examples: long silence, resumed work, “this was blocked earlier but is now done”.
- Add tests that simulate multi-day sessions so stale relative references are caught as regressions.
- Good overall examples:
  - `🔴 (21:13) User said they plan to revisit reflection robustness tomorrow (target: 2026-04-18).`
  - `🟡 (09:42) Error pattern appears to have started last week (week of 2026-04-06).`
  - `🔴 (14:10) Waiting for user reply; follow-up was deferred until 2026-04-18.`

**Recommended pi-specific implementation:**

- keep the current date-grouped style for human readability
- enrich each observation with a small temporal metadata model, e.g. a type `TemporalAnchor`:
  - `recordedAt`: when the observation was created
  - `referencedStart` / `referencedEnd`: the anchored time or range
  - `precision`: exact / day / week / month / approximate
  - `relation`: past / current / future / ongoing
  - `originalPhrase`: the original relative wording when present
- add a formatter that renders the original phrase plus the normalized anchor before it becomes durable memory
- prefer preserving uncertainty over overspecifying dates

**Useful Mastra references:**

- [`observer-agent.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/memory/src/processors/observational-memory/observer-agent.ts) — temporal anchoring rules for relative phrases like “tomorrow”, “next week”, and “last week”, including the rule that inferred dates belong at the end of each observation.
- [`date-utils.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/memory/src/processors/observational-memory/date-utils.ts) — relative-time expansion, inline estimated-date rendering, and gap-marker helpers.
- [`observational-memory.mdx`](https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/docs/memory/observational-memory.mdx) — public-facing examples of anchored date rendering in OM output.

---

### 2. Continuous/background observation, but only next-turn publication

**Mastra idea:** continuous observation/compression during the run.

**Why this is Tier 1:** this is the best way to improve extraction quality in 50k–100k token turns without reintroducing mid-turn context loss.

**Backlog items:**

- Introduce a **staged observation buffer** separate from the published observation block.
- Observe large new message ranges incrementally during a long agent loop.
- Allow staged observations to accumulate in smaller chunks instead of waiting for one giant end-of-turn extract.
- Keep the **public** cursor and injected block frozen during the loop.
- On `agent_end`, reconcile and publish staged observations into the durable session state.
- On the next `before_agent_start`, inject only the published block.

**Recommended pi-specific implementation shape:**

- `draftObservations` / `draftCurrentTask` / `draftSuggestedResponse`
- optional staged cursor distinct from `lastObservedEntryId` / `lastObservedTimestamp`
- publish step at turn boundary only
- reflection may run on staged content, but publication still waits for turn completion

**Useful Mastra references:**

- [`buffering-coordinator.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/memory/src/processors/observational-memory/buffering-coordinator.ts) — buffering state machine, token boundaries, and activation bookkeeping.
- [`observation-strategies/async-buffer.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/memory/src/processors/observational-memory/observation-strategies/async-buffer.ts) — how buffered observations are accumulated separately from active observations.
- [`mid-loop-observation.test.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/memory/src/processors/observational-memory/__tests__/mid-loop-observation.test.ts) — explicit coverage of threshold-triggered observation during a multi-step run.

**Important non-goal:**

- do **not** prune raw context or mutate the system prompt mid-turn

---

### 3. Lower / earlier observation thresholds and smaller observation chunks

**Mastra idea:** start managing context earlier instead of waiting until it is already huge.

**Why this is Tier 1:** even with staged observation, thresholds that are too high still make the observer do low-quality “giant dump” extraction.

**Backlog items:**

- lower the default observation trigger from the current very-late threshold
- consider a smaller-chunk incremental policy during long runs
- allow separate thresholds for:
  - staging observation work
  - publishing observations
  - reflection/consolidation
- add heuristics based on message count / tool-output weight, not only token totals

**Recommended direction:**

- keep defaults conservative enough for cost, but move materially earlier than current `70k` message-token behavior
- prefer multiple smaller observations over one huge pass

---

### 4. Prompt and output-structure upgrades for specificity preservation

**Mastra idea:** more opinionated extraction rules that preserve exactness.

**Why this is Tier 1:** this directly addresses the long-session failures you called out: flattened lists, lost item distinctions, lost numbers, vague summaries.

**Backlog items:**

- strengthen observer instructions around:
  - exact numbers
  - counts
  - itemized lists
  - distinguishing attributes
  - constraints
  - rejected alternatives
  - file paths / line numbers / command outputs when they matter
- strengthen reflector instructions to preserve the same structure during consolidation
- preserve explicit outcome markers instead of flattening “planned / in-progress / done” into one vague memory
- add tests for list-preservation and exact-number preservation

**Implementation note:**

The current prompts already ask for specifics, but Mastra-style parity here means becoming much stricter and more test-driven about it.

**Useful Mastra references:**

- [`observer-agent.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/memory/src/processors/observational-memory/observer-agent.ts) — strong extraction guidance for split multi-event observations, exact wording, recommendation lists, identifiers/handles, technical results, quantities/counts, constraints, and distinguishing attributes per list item.
- [`reflector-agent.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/memory/src/processors/observational-memory/reflector-agent.ts) — consolidation rules that explicitly preserve dates/times, ✅ markers, names, decisions, errors, and architectural choices instead of flattening them.
- [`long-session.test.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/memory/src/processors/observational-memory/__tests__/long-session.test.ts) — integration coverage for long-run observation/reflection behavior where specificity loss tends to show up.

---

### 5. Completion markers and completed-observation lifecycle

**Mastra idea:** explicit completion tracking, not just current-state snapshots.

**Why this is Tier 1:** this was one of the clearest practical wins in the earlier comparison, and you called it out directly.

**Backlog items:**

- add explicit completion markers for tasks, subgoals, and milestones
- track when an item moved from active to completed
- preserve “done” status through reflection instead of silently dropping it
- teach the observer/reflector to distinguish:
  - planned
  - active
  - blocked
  - completed
  - abandoned / superseded
- improve `currentTask` maintenance so completed work exits the active block cleanly
- add tests ensuring completed items are not lost during reflection

**Possible structure options:**

- inline markers like `✅`
- explicit completion phrasing in observations
- a small structured completion section if it proves more stable than inline markers

**Useful Mastra references:**

- [`observer-agent.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/memory/src/processors/observational-memory/observer-agent.ts) — guidance on when a task/subtask should earn a ✅ marker and why that prevents repeated work.
- [`reflector-agent.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/memory/src/processors/observational-memory/reflector-agent.ts) — repeated instructions to preserve ✅ completion markers and the concrete resolved outcome they represent.
- [`markers.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/memory/src/processors/observational-memory/markers.ts) and [`markers.test.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/memory/src/processors/observational-memory/__tests__/markers.test.ts) — useful if we decide to mirror explicit observation/reflection lifecycle markers in pi diagnostics or stored state.

---

### 6. Stable, cache-friendly observation block layout

**Mastra idea:** make the injected memory block more reusable and less churny.

**Why this is Tier 1:** you called this out directly, and it matters a lot in practice because system-prompt churn weakens prompt caching and increases instability.

**Backlog items:**

- minimize unnecessary rewriting of the full observations block
- keep section ordering stable across turns
- separate highly volatile content from mostly-stable content
- avoid reflowing or reformatting unchanged observations
- make `current-task` / `suggested-response` updates small and localized
- normalize whitespace and formatting so semantically unchanged memory remains byte-stable when possible
- prefer multiple injected system-message chunks over one monolithic rewritten block when pi’s hook surface allows it
- split injected memory into stable sections such as:
  - durable observations
  - active task state
  - suggested response / next action
  - continuation reminder

**Recommended pi-specific direction:**

- optimize for stable prompt prefixes and smaller deltas turn-to-turn
- keep the durable observations block mostly append-only until reflection
- make reflection output stable in ordering so it does not churn needlessly
- if possible, inject memory as multiple cache-stable system messages/chunks instead of one giant appended string:
  - base assistant system prompt
  - durable observation history
  - active task state
  - suggested response / immediate next action
  - continuation reminder
- if pi currently only exposes a single mutable system-prompt string at this hook point, preserve the same segmentation logically inside one deterministic injected region so the later migration to true multi-message injection is straightforward

**Useful Mastra references:**

- [`processor.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/memory/src/processors/observational-memory/processor.ts) — explicitly injects system messages “one per cache-stable chunk” plus a continuation message, which is the clearest reference for the stability/cacheability design you called out.
- [`observational-memory.mdx`](https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/docs/memory/observational-memory.mdx) — documents prompt-caching benefits from stable observational-memory context.

---

## Tier 2 — Important, but after the Tier 1 foundation

### 7. Reflection robustness and retry ladder

**Mastra idea:** more resilient reflection behavior when compression goes wrong.

**Why this is Tier 2:** valuable, but you already framed it correctly as more of a nice-to-have for now.

**Backlog items:**

- detect empty / degenerate / obviously lossy reflector outputs
- retry with a stricter prompt when needed
- optionally retry with a fallback model or lower compression target
- preserve the pre-reflection observations when the retry path still fails
- add targeted tests for bad reflector behavior

**Examples of degenerate cases to catch:**

- near-empty observation output
- loss of `current-task`
- collapsed chronology
- disappearance of explicit completions or constraints

---

### 8. Gap markers and session-phase organization

**Mastra idea:** richer organization of memory windows and chronology.

**Why this is Tier 2:** helpful for readability and temporal reasoning, but secondary to getting the raw observation quality right.

**Backlog items:**

- add explicit gap markers for long pauses or resumed work
- mark major session phase shifts
  - research → implementation
  - implementation → testing
  - blocked → resumed
- consider lightweight headers for major state transitions without introducing full multi-thread semantics

**pi-specific note:**

Because this extension is single-session-first, this should be framed as **session phases**, not thread management.

---

### 9. Better in-session provenance for important observations

**Mastra idea:** stronger provenance and traceability.

**Why this is Tier 2:** useful when reconstructing why something is believed, but less urgent than the memory-quality improvements above.

**Backlog items:**

- preserve source cues for high-value observations when helpful:
  - file path
  - command/tool name
  - error/result summary
  - relevant quoted phrase
- add provenance only where it improves recoverability
- avoid turning the observation block into a verbose trace log

**Recommended boundary:**

- keep provenance lightweight and selective
- do not port Mastra’s broader retrieval/provenance stack wholesale

---

### 10. Stronger observer/reflector validation and post-processing

**Mastra idea:** tighter output quality control.

**Why this is Tier 2:** this becomes much more valuable once Tier 1 prompt/structure upgrades land.

**Backlog items:**

- validate required sections more aggressively
- reject malformed XML-like output more deliberately
- post-process minor structural issues without inventing new content
- add sanity checks for:
  - missing observations with present task blocks
  - invalid ordering
  - duplicate current-task sections
  - obvious collapse of list structure

---

### 11. Better current-task / suggested-response lifecycle management

**Mastra idea:** more disciplined task-state continuity.

**Why this is Tier 2:** today the fields are useful, but they are still relatively blunt compared with the richer lifecycle handling in Mastra.

**Backlog items:**

- clarify when `currentTask` should be replaced vs merged vs cleared
- better differentiate:
  - primary user goal
  - secondary pending items
  - waiting-for-user state
  - assistant next-action guidance
- preserve completed secondary tasks without polluting active state
- add stronger tests around supersession and “waiting for user” transitions

---

## Tier 3 — Later, forward looking

### 12. Opt-in project-level / cross-session memory

**Mastra-adjacent idea:** memory beyond one live session.

**Why this is Tier 3:** valuable, and you explicitly want it, but it should be a second system—not something that complicates the single-session core before the core is solid.

**Backlog items:**

- create a separate opt-in project-memory store
- use different observer/reflector prompts for project memory vs session memory
- prefer retrieval/search over always injecting the whole project memory
- keep project memory denser, slower-moving, and more curated than session memory
- preserve clear separation between:
  - live session continuity
  - long-lived project knowledge

**Recommended design constraint:**

- do not mix project memory into the current session-state JSON model by default

---

### 13. Retrieval/search over project memory

**Mastra idea:** richer retrieval rather than blind injection.

**Why this is Tier 3:** only makes sense once project memory exists.

**Backlog items:**

- indexed retrieval of project-level observations
- selective recall into session context
- search tools or commands instead of unconditional prompt injection
- optional provenance on retrieved memories

---

## Tier 4: Out of scope, not currently relevant

### 14. Thread/resource scope and multi-thread attribution

**Mastra idea:** thread-aware and resource-aware memory organization.

**Why this is Tier 3:** this repo’s OM port is intentionally single-session. Direct parity here is not very valuable unless pi usage expands to true multi-thread memory orchestration.

**Backlog items:**

- thread IDs / titles
- thread attribution in observations
- cross-thread retrieval
- resource-scoped memory separation

**Current recommendation:**

- do not prioritize this for the present port
- only revisit if pi gains a concrete multi-thread memory product surface

---

### 15. DB-backed storage / heavier memory infrastructure

**Mastra idea:** richer storage and operational infrastructure.

**Why this is Tier 3:** not needed for the current file-backed pi extension.

**Backlog items:**

- alternate persistence layer beyond JSON-per-session files
- shared storage for multiple sessions/users/processes
- heavier indexing / analytics / operational tooling

**Current recommendation:**

- keep JSON state until scale or product shape clearly demands more

---

### 16. Full Mastra buffering/activation subsystem parity

**Mastra idea:** port the full internal buffering pipeline.

**Why this is Tier 3:** the underlying insight is useful, but a literal port is not the right target for pi.

**Backlog items:**

- only borrow the pieces that help the staged-observation design
- do not treat “match Mastra internals exactly” as a goal

---

## Recommended implementation order

If we want a practical parity roadmap rather than a theoretical one, I would sequence it like this:

### Phase 1

- Temporal reasoning overhaul, including stale-relative-reference normalization to absolute/ranged anchors
- Prompt/output specificity upgrades
- Completion markers + completed-observation lifecycle

### Phase 2

- Stable/cache-friendly observation block layout
- Lower/earlier thresholds
- Staged continuous/background observation without mid-turn publication

### Phase 3

- Reflection robustness + retry ladder
- Gap markers / session-phase organization
- Better current-task lifecycle handling

### Phase 4

- Opt-in project memory
- Retrieval/search
- Any later thread/resource/generalized-memory expansion

---

## Practical backlog summary

### Tier 1

- [ ] Temporal reasoning overhaul: preserve the original phrase, but normalize stale relative references to absolute/ranged anchors
- [ ] Continuous/background observation with next-turn-only publication
- [ ] Lower/earlier thresholds and smaller observation chunks
- [ ] Prompt/output upgrades for lists, exact numbers, constraints, and distinctions
- [ ] Completion markers and completed-observation tracking
- [ ] Stable, cache-friendly observation block layout

### Tier 2

- [ ] Better current-task / suggested-response lifecycle management
- [ ] Gap markers and session-phase organization
- [ ] Reflection robustness and retry ladder

### Tier 3

- [ ] Opt-in project-level / cross-session memory
- [ ] Retrieval/search over project memory
- [ ] Better in-session provenance for important observations

### Skip completely, not in scope

- [ ] Stronger observer/reflector validation and post-processing
- [ ] Thread/resource scope and attribution
- [ ] DB-backed storage / heavier infra
- [ ] Full buffering/activation subsystem parity as a literal port

---

## Bottom line

For this pi extension, the right parity target is **not** “be Mastra in miniature.”

The right target is:

1. make single-session memory much better at **time** (especially anchored temporal reasoning, not stale relative phrases), **specificity**, **completion state**, and **prompt stability**
2. add **continuous observation quality improvements** without reintroducing mid-turn context loss
3. treat project-level/shared memory as a **separate opt-in layer later**

If we follow that shape, we get the Mastra ideas that matter most in practice while staying true to the pi extension model you actually want.
