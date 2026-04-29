---
name: proposal-existing
description: >-
  Compile messy feature brain dumps into strong, repo-grounded initial plans for
  existing codebases. Use when the user says proposal:existing, wants to turn a
  rough feature idea into the first serious markdown plan for a repo, or wants
  repo inspection before planning/review begins.
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
- **Stage 1:** inspect the existing repo and turn that brief into the strongest possible initial markdown plan.

The plan is “initial” only because it has not yet gone through review and revision. It should not be shallow. The stronger this first pass is, the better every downstream review, competing-plan pass, and implementation handoff will be.

## Boundary

This skill owns only the repo-grounded initial plan step.

Use this sequence:

```text
proposal-existing
  messy brain dump + existing repo → comprehensive repo-grounded initial plan

planning-workflow
  initial plan → reviewed, challenged, revised, stabilized plan

beads-workflow
  stabilized plan → bead/task graph

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

If no coherent user/problem/outcome can be inferred, ask 1–3 blocking clarification questions before repo work. Otherwise proceed with labeled assumptions.

### 2. Perform repo reconnaissance

Inspect the repo before drafting. Prefer fast, targeted reads.

Look for:

1. Project instructions: `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `README.md`, docs.
2. Existing proposal/planning conventions: `docs/proposals/`, `docs/`, `planning/`.
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

### 3. Ask only high-leverage questions

After reconnaissance, ask at most 5 questions **only if** answers would materially change the initial plan.

Good questions clarify:

- the primary user or workflow
- the v1 success boundary
- scope boundaries and non-goals
- existing behavior that must be preserved
- durable vs ephemeral data
- security/trust boundaries
- rollout/backout needs

Avoid permission-seeking or generic intake questions. If questions are non-blocking, proceed with labeled assumptions.

### 4. Draft the initial plan artifact

Default path:

```text
docs/proposals/<short-feature-name>.md
```

If the user asked only for a prompt/template, return the repo-native prompt instead of creating a file.

The plan must be self-contained enough for GPT Pro or other models to review without rediscovering the basics. A fresh model with only this plan plus the repo should be able to perform a high-quality review or competing-plan pass.

Use this structure unless the repo has a stronger convention:

```markdown
# Initial Plan: <Feature Name>

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
- Assumptions that downstream review should challenge

## 18. Handoff to planning-workflow
- What reviewers should scrutinize first
- Areas where competing approaches may be valuable
- Why this plan is ready for review/revision

## Appendix A: Files inspected, evidence pointers, and search anchors

## Appendix B: Likely implementation files
```

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
- Leaves the plan ready for `planning-workflow`, not for immediate implementation.

## Exact prompt for repo-native initial plan creation

Use or adapt this when delegating to Codex/pi inside an existing repo:

```text
We are in an existing repository. I want to turn a rough feature brain dump into the strongest possible repo-grounded initial plan before any implementation begins.

Your job is to inspect the repo, understand the current architecture, normalize the feature intent, and produce a comprehensive markdown initial plan. Do not implement the feature. Do not edit production code, tests, schemas, migrations, config, or application docs. Do not create beads/tasks/issues. If you create or modify anything, only create/update a plan/proposal document under docs/proposals/ unless I explicitly authorize otherwise.

Feature brain dump:

<PASTE FEATURE BRAIN DUMP HERE>

Planning objective:

Create a self-contained initial plan that can later be handed to GPT Pro / other models for review, competing-plan feedback, and revision via planning-workflow. This is not a lightweight sketch: downstream reviewers should be improving and challenging the plan, not rediscovering the feature intent or basic repo architecture.

First normalize the brain dump:

1. Restate the feature intent clearly.
2. Identify the problem/opportunity and target user/workflow.
3. Define likely v1 success criteria.
4. Identify source ideas, examples, metaphors, or prior art embedded in the brain dump.
5. Identify non-goals, constraints, assumptions, and unknowns.

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

Then produce an initial plan with these sections:

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
18. Handoff notes for planning-workflow review
19. Appendices: files inspected, evidence pointers, search anchors, and likely implementation files

Important constraints:

- Do not propose a rewrite unless repo evidence strongly justifies it.
- Prefer changes that fit existing project conventions.
- Ground claims in files you inspected.
- Clearly distinguish confirmed repo facts from assumptions.
- Ask at most 5 high-leverage questions, and only if answers would materially change the plan.
- If questions are non-blocking, proceed with labeled assumptions.
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
- Absorbing planning-workflow, research-software, idea-wizard, or beads-workflow responsibilities into this skill.
- Converting the feature directly into tasks before the plan stabilizes.
- Starting implementation while the user is still shaping product intent.
- Recommending rewrites without strong evidence.
- Producing a vague plan with no file/module grounding.
