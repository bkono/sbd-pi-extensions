---
name: proposal-existing
description: >-
  Compile messy feature brain dumps into strong, repo-grounded initial plans for
  existing codebases. Use when the user says proposal:existing, wants to turn a
  rough feature idea into the first serious markdown plan for a repo, or wants
  repo inspection before planning/review begins. Resolve load-bearing human
  decisions before handing the candidate to repeated architectural review.
category: workflow
tags:
  - planning
  - proposals
  - existing-repo
  - brain-dump
license: MIT
distribution: public
---

# proposal-existing

Turn a messy feature brain dump into a comprehensive, repo-grounded initial plan for an existing codebase.

This skill is the **Stage 0 → Stage 1 compiler**:

- **Stage 0:** normalize rough human intent into a clear feature brief.
- **Stage 1:** inspect the existing repo, draft a grounded candidate, and resolve its load-bearing assumptions with the user before handing it to architectural review.

A candidate is not an approved plan. Make it comprehensive enough to expose consequential choices, without polishing an architecture around intent the user has not approved.

## Boundary

This skill owns the repo-grounded candidate and its intent-confirmation checkpoint. Repeated architectural review remains downstream.

Use this sequence:

```text
proposal-existing
  rough intent → targeted clarification / repo reconnaissance (order depends on the unknowns)
  → grounded candidate → load-bearing decision grilling → confirmed intent

planning-workflow
  intent-confirmed candidate → reviewed, challenged, revised, stabilized plan

beadwork-workflow
  stabilized plan → dependency-aware task graph

implementation agents
  beads/tasks → code
```

This skill does **not**:

- brainstorm or rank unrelated feature ideas
- perform broad external software research
- run multi-model plan review or repeated revision loops
- convert the plan into beads/tasks/issues
- implement the feature

It may inspect repo docs, code, tests, existing proposals, and user-provided references. If broader external research is needed, hand off to the appropriate research workflow instead of absorbing that work here.

## When to use

Use this skill when the user wants to plan a significant feature in an existing repository and provides rough intent, a product brain dump, unclear requirements, or a repo-specific feature direction.

Trigger phrases include:

- `proposal:existing`
- “create a proposal for this feature”
- “turn this brain dump into a plan for this repo”
- “inspect the repo and write the initial plan”
- “plan this before implementation”

Do **not** use this for greenfield project planning.

## Core rule

Plan before patching.

- Do not implement production code.
- Do not modify tests, schemas, migrations, config, or application docs unless explicitly authorized.
- Do not create beads/tasks/issues.
- If writing a file, only create/update the initial plan/proposal document, normally under `docs/proposals/`.
- Optional skills do not expand that write scope: capture decisions and proposed glossary/ADR changes in the proposal unless the user separately authorizes editing those artifacts.

## Workflow

### 1. Normalize the brain dump

Rewrite the user’s rough input into a clear feature intent brief before designing anything.

Capture:

- what the user wants to add or change
- the problem/opportunity behind it
- target users, operators, or developer workflows
- why this matters now
- what a successful v1 enables that is impossible or painful today
- explicit constraints, preferences, and non-goals
- source ideas, metaphors, examples, or prior art the user is implicitly pointing at
- how those source ideas should be generalized into repo-native behavior rather than copied literally
- assumptions you are making from incomplete input
- unknowns that may materially affect the design

Choose the order by the missing input, not by a fixed interview ritual:

- **Repository knowledge is missing:** inspect first, then draft a grounded candidate with explicit assumptions. Do not ask the user facts you can discover from code, tests, or docs.
- **Human intent is missing:** if competing interpretations would change the user/problem/outcome, v1 scope, or behavior to preserve, ask a short round of blocking questions before detailed design. Use targeted repo reads first when needed to make those questions concrete.
- **Both are missing:** alternate targeted inspection and decision questions. Do not conduct exhaustive archaeology for an undefined feature or demand product decisions without useful evidence.

Previously approved decisions are inputs, not questions to repeat. Surface contradictions explicitly rather than silently reopening them. Non-blocking unknowns may remain labeled in the candidate; load-bearing assumptions must pass the checkpoint in step 5 before repeated architectural review.

### 2. Perform repo reconnaissance

Inspect the repo before drafting. Prefer fast, targeted reads.

Look for:

1. Project instructions: `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `README.md`, docs.
2. Existing proposal/planning conventions: `docs/proposals/`, `docs/`, `planning/`.
   Read relevant `CONTEXT.md` vocabulary (via `CONTEXT-MAP.md` if present) and ADRs. Their absence is not a blocker; do not scaffold them as part of reconnaissance.
3. Existing work signals: open/closed beads, issues, TODOs, roadmap notes, related proposals.
4. File tree and major boundaries: CLI, API, frontend, packages, internal modules, tests.
5. Relevant implementation areas for the feature.
6. Existing related functionality to extend rather than bypass.
7. Current testing style and commands.
8. Error-handling, logging, naming, architecture, and persistence conventions.
9. Source-of-truth ownership: which files, services, schemas, or systems own the domain today.
10. Stale or deprecated patterns: old docs, renamed modules, superseded APIs, migrations, archived proposals.
11. Evidence pointers: file paths, commands, symbols, or search anchors reviewers can use to verify the plan.

Ground claims in files inspected. Clearly separate confirmed repo facts from assumptions.

Bias guards during reconnaissance:

- Do not infer the project architecture from a single file, example, or old issue unless you label that as weak evidence.
- Corroborate important patterns with docs, tests, analogous modules, recent commits, or multiple code paths when practical.
- Treat older proposals, docs, and TODOs as possible evidence, not truth; check whether the repo has moved on.
- Summarize source evidence instead of copying large code/doc blocks into the plan.

### 3. Identify load-bearing assumptions

Separate discoverable facts from decisions only the user can make. An assumption is **load-bearing** when a different answer would materially change scope, user-visible behavior, preservation/replacement boundaries, ownership, trust, persistence, or rollout.

If one prevents a meaningful candidate, ask it now. Otherwise make the recommendation concrete in the candidate and resolve it in step 5. Ask only questions whose prerequisites are known; defer questions dependent on unanswered choices. Give a recommendation and explain the consequential trade-off without presenting it as approved.

Keep rounds manageable (normally no more than five questions). This is a pacing guideline, not permission to leave a sixth consequential decision silently assumed. Avoid generic intake and permission-seeking for already authorized work.

### 4. Draft the grounded candidate artifact

Default path:

```text
docs/proposals/<short-feature-name>.md
```

If the user asked only for a prompt/template, return the repo-native prompt instead of creating a file.

The candidate must be self-contained enough for the user to judge its assumptions and for later reviewers to challenge its design without rediscovering the basics. Mark recommendations conditional where they depend on unresolved decisions. Detail should expose choices, not make an unapproved architecture look settled.

Keep two kinds of content distinct:

- **Behavioral requirements and invariants:** identify whether user-confirmed or proposed. Confirmed constraints govern downstream design and review.
- **File paths, symbols, and implementation sketches:** retain them as grounded evidence and navigation hints, with confidence labels. They are not immutable implementation requirements unless the user explicitly makes them so; later agents must revalidate them against the repo.

Use this structure unless the repo has a stronger convention:

```markdown
# Initial Plan: <Feature Name>

**Intent status:** awaiting decisions / confirmed for architectural review
**Open load-bearing decisions:** <list or none>
**Confirmation:** <user confirmation reference/summary, or pending>

## Decision ledger
For each consequential choice, record: question, recommendation, status (proposed / user-confirmed / deferred), rationale, rejected alternatives, and affected sections. Preserve existing approvals; deferred load-bearing choices still block review of the dependent design.

## 1. Normalized feature intent
- Clear rewrite of the user’s brain dump
- Problem/opportunity
- Target users/workflows
- Desired outcome
- Key assumptions
- Source ideas/examples/metaphors to adapt, if any

## 2. Problem and success criteria
- Why this matters
- What v1 must make possible
- What would count as success/failure

## 3. V1 scope, non-goals, and deferred scope
- In scope for the first useful version
- Explicit non-goals
- Deferred ideas that should not distract this plan

## 4. Current repo context
- Confirmed facts from inspected files
- Relevant architecture and module boundaries
- Existing conventions to preserve
- Existing related work, proposals, issues, TODOs, or beads
- Deprecated/stale patterns to avoid, if found

## 5. Repo-native adaptation map and mental model
- Source idea / user intent → repo evidence → repo-native adaptation → rejected literal interpretation
- Mental model: who/what does what in the proposed design
- Current source of truth and what should remain the source of truth
- Missing pieces: what the repo already has vs what this feature must add

## 6. Existing behavior and patterns to extend
- Current flows this feature touches
- Similar commands/APIs/components/services/tests
- Patterns that should be reused

## 7. Proposed v1 behavior
- User/developer/operator-facing behavior
- API / CLI / UI / background behavior as applicable
- Example workflows or canonical usage patterns, if applicable
- Distinct modes or operational paths, if applicable
- Happy paths
- Important edge cases
- Behavior that must remain unchanged

## 8. Recommended implementation approach
- Repo-specific design
- Why this approach fits the existing architecture
- Minimal but fully coherent v1 slice
- Source-of-truth and ownership boundaries
- Judgment-based vs deterministic/repeatable parts, if applicable
- Important design decisions and tradeoffs
- Alternatives considered and why they are not the recommendation

## 9. Likely files/modules affected
For each likely file/module:
- expected change
- rationale
- confidence: confirmed / inferred / speculative

## 10. Data model, state, or persistence impact
If applicable, describe schema/state changes, migrations, compatibility, data lifetime, ownership, and source-of-truth rules.

## 11. API / CLI / UI / config surface changes
If applicable, describe exact surfaces, names, flags, routes, commands, options, config shape, output shape, and error behavior.

## 12. Integration points and sequencing
- How the feature threads through existing code
- Dependencies between pieces
- Suggested implementation order at a high level

## 13. Compatibility, migration, and rollout concerns
- Backward compatibility
- Existing users/workflows to protect
- Rollout/backout considerations if relevant

## 14. Security, privacy, auth, and trust boundaries
If applicable, describe access rules, sensitive data, trust boundaries, and abuse cases.

## 15. Error handling and failure modes
- Expected failure cases
- User-facing errors
- Degraded/fallback behavior
- Recovery behavior
- Debuggability

## 16. Testing strategy
- Existing tests to extend
- New unit/integration/e2e/golden tests likely needed
- Regression cases for existing behavior
- Acceptance criteria for v1

## 17. Risks and open questions
- Material risks
- Open questions that affect design
- Assumptions to confirm with the user versus technical uncertainties reviewers should investigate

## 18. Next checkpoint / handoff
- Awaiting intent confirmation: next answerable questions and design sections they affect
- After confirmation: what planning-workflow reviewers should scrutinize, where competing approaches are useful, and the approved constraints they must preserve
- A later review finding that invalidates an approved premise must return to the user, not silently change the premise

## Appendix A: Files inspected, evidence pointers, and search anchors

## Appendix B: Likely implementation files
```

### 5. Grill load-bearing assumptions before architectural polishing

Present the candidate and its unresolved consequential choices. Work in dependency-aware rounds:

1. Ask the currently answerable decision questions, each with a recommendation and concrete consequences or edge-case examples. Do not ask dependent questions as though earlier choices were already settled.
2. Wait for the user's answers. Repository research can inform decisions; neither a research agent nor model consensus can supply human approval.
3. Record each answer and rationale in the proposal immediately. Update affected behavior, alternatives, examples, and implementation recommendations; remove contradictions rather than appending a competing answer.
4. Recompute the remaining questions. If the user pauses or requests only a draft, stop without launching review. Leave unconfirmed intent explicitly awaiting decisions and state the next questions; preserve any existing confirmation that still covers the candidate.
5. When no load-bearing decisions remain open, summarize the agreed intent, behavioral invariants, rejected paths, and remaining non-blocking uncertainties. Obtain explicit confirmation of that understanding, reusing an existing explicit confirmation if it already covers the current candidate.

Confirmation makes the candidate ready for `planning-workflow`; it does not stabilize the architecture, authorize ticket creation, or authorize implementation. Hand off rather than launching downstream workflows automatically. Facts can be investigated before confirmation, but repeated architectural polishing and competing implementation plans must not treat unresolved intent as settled.

**Optional skill composition:** this checkpoint works without additional installation. If `grilling` is available, load it using the host's skill-loading mechanism for interview technique, bounded by the feature's load-bearing decisions. If terminology is ambiguous, `domain-modeling` can help challenge terms and concrete scenarios. Keep its results in the proposal under this skill's write scope; separate authorization is required for glossary/ADR edits. `grill-with-docs` is an optional user-invoked entry point, not a mandatory dependency or an automatic expansion of permissions.

### Acceptance checks for this skill

Before handoff, check the exact failure modes:

- Repo-unknown but intent-clear: investigated facts instead of asking the user to supply them; produced a grounded candidate.
- Intent-ambiguous: clarified consequential alternatives before committing to detailed architecture.
- Unanswered load-bearing choice: candidate remains awaiting decisions; no premature architectural-review handoff.
- Answer changed a premise: affected sections agree with the decision ledger; dependent questions were reconsidered.
- Already confirmed intent: approvals were reused, not subjected to a redundant interview.
- Optional skills absent: the same checkpoint still works without installation or extra document writes.
- File guidance: concrete evidence remains available, but approved behavior is distinguished from provisional implementation hints.

## Output standards

A good initial plan:

- Is comprehensive, not a lightweight sketch.
- Is specific to the actual repo, not generic architecture advice.
- Explains both the product intent and the repo-specific path to achieve it.
- Translates source ideas into repo-native behavior instead of copying them literally.
- Gives downstream reviewers enough context to challenge judgment and tradeoffs, not redo basic archaeology.
- Clearly separates confirmed repo facts, inferred conclusions, and assumptions.
- Uses corroborated repo patterns where possible and labels weak evidence when not.
- Extends existing primitives instead of inventing parallel systems.
- Names concrete files/modules likely to change and explains why.
- Defines v1 scope and non-goals sharply.
- Includes example workflows, canonical usage, or surface shapes when those clarify the feature.
- Includes a testing strategy that protects existing behavior.
- Marks an unconfirmed candidate as awaiting decisions; hands off to `planning-workflow` only after intent confirmation, never directly to implementation.

## Exact prompt for repo-native initial plan creation

Use or adapt this when delegating to Codex/pi inside an existing repo:

```text
We are in an existing repository. I want to turn a rough feature brain dump into the strongest possible repo-grounded initial plan before any implementation begins.

Your job is to inspect the repo, understand the current architecture, normalize the feature intent, and produce a comprehensive markdown initial plan. Do not implement the feature. Do not edit production code, tests, schemas, migrations, config, or application docs. Do not create beads/tasks/issues. If you create or modify anything, only create/update a plan/proposal document under docs/proposals/ unless I explicitly authorize otherwise.

Feature brain dump:

<PASTE FEATURE BRAIN DUMP HERE>

Planning objective:

Create a self-contained grounded candidate, then resolve load-bearing assumptions with me before handing it to GPT Pro / other models for repeated architectural review via planning-workflow. A candidate is not approval. Reviewers should challenge the design within confirmed intent, not optimize an assumption I never accepted. If I request only a draft, stop without launching review; mark unconfirmed intent awaiting decisions and preserve any still-applicable existing confirmation.

First normalize the brain dump:

1. Restate the feature intent clearly.
2. Identify the problem/opportunity and target user/workflow.
3. Define likely v1 success criteria.
4. Identify source ideas, examples, metaphors, or prior art embedded in the brain dump.
5. Identify non-goals, constraints, assumptions, and unknowns.

Choose order by the unknowns: investigate discoverable repository facts first; ask a short round first when unresolved human intent would change the feature's outcome, scope, or preserved behavior. Alternate when needed. Reuse prior explicit approvals rather than reopening them.

Then perform repo reconnaissance / context hydration:

1. Read AGENTS.md / CLAUDE.md / README.md / package docs / architecture docs if present.
2. Inspect the file tree and identify the major app boundaries.
3. Identify relevant modules, routes, commands, services, schemas, workers, tests, and integration points for this feature.
4. Infer the project’s coding, testing, architecture, naming, and error-handling conventions.
5. Look for existing related functionality that this feature should extend rather than bypass.
6. Identify source-of-truth ownership for the domain this feature touches.
7. Identify stale or deprecated patterns: old docs, renamed modules, superseded APIs, archived proposals, or migrations.
8. Identify relevant existing issues, TODOs, beads, docs, or proposal files if present.
9. Corroborate important patterns when practical; do not overfit to one file or one old issue.

Then produce a grounded candidate with intent status, open load-bearing decisions, and a decision ledger (proposed/user-confirmed/deferred choices, rationale, rejected alternatives, affected sections), followed by these sections:

1. Normalized feature intent
2. Problem and success criteria
3. V1 scope, non-goals, and deferred scope
4. Current repo context
5. Repo-native adaptation map and mental model
6. Existing behavior and patterns to extend
7. Proposed v1 behavior
8. Recommended implementation approach
9. Likely files/modules affected
10. Data model, state, or persistence impact, if any
11. API / CLI / UI / config surface changes, if any
12. Integration points and sequencing
13. Compatibility, migration, and rollout concerns
14. Security, privacy, auth, and trust boundaries, if applicable
15. Error handling and failure modes
16. Testing strategy
17. Risks and open questions
18. Next checkpoint: answerable decision questions if unconfirmed, or planning-workflow handoff constrained by confirmed intent
19. Appendices: files inspected, evidence pointers, search anchors, and likely implementation files

After presenting the candidate, resolve load-bearing decisions in dependency-aware rounds: ask currently answerable questions with recommendations, wait for my answers, record them immediately, reconcile affected sections, and recompute remaining questions. Keep rounds manageable, normally up to five questions; that is not a total limit or a reason to silently assume an answer. Summarize the settled intent and obtain explicit confirmation before architectural polishing. Confirmation is not implementation approval. Optional skills are not required; this workflow writes only the proposal unless separately authorized.

Important constraints:

- Do not propose a rewrite unless repo evidence strongly justifies it.
- Prefer changes that fit existing project conventions.
- Ground claims in files you inspected.
- Clearly distinguish confirmed repo facts from assumptions.
- Distinguish user-confirmed behavioral requirements from provisional file paths and implementation sketches; retain evidence pointers and confidence labels for revalidation.
- Carry non-blocking technical uncertainties into review, but leave unanswered load-bearing human decisions visibly blocking that handoff.
- Do not start implementation.
- Do not create beads/tasks/issues.
```

## Anti-patterns

Avoid:

- Treating “initial” as permission to produce a shallow sketch.
- Designing against an imaginary codebase from a pasted summary only.
- Copying the user’s source example too literally instead of adapting the underlying principle to the repo.
- Letting the plan become too source/tool-centric, e.g. Claude-specific, CASS-specific, or framework-specific without repo evidence.
- Making architecture claims from a single file, stale proposal, or old issue without labeling uncertainty.
- Copying large source excerpts into the plan instead of using concise evidence pointers.
- Fabricating technical details, latencies, APIs, flags, storage shapes, or error codes without repo evidence or explicit assumptions.
- Asking broad generic questions before inspecting the repo.
- Absorbing planning-workflow, research-software, idea-wizard, or beadwork-workflow responsibilities into this skill.
- Converting the feature directly into tasks before the plan stabilizes.
- Starting implementation while the user is still shaping product intent.
- Sending an unconfirmed candidate into repeated architectural review or treating model consensus as user approval.
- Removing concrete repo pointers to avoid staleness, or treating those pointers as an immutable file-by-file build contract.
- Recommending rewrites without strong evidence.
- Producing a vague plan with no file/module grounding.
