---
name: planning-workflow
description: >-
  Refine a proposal into a grounded, reviewable implementation plan. Use when
  reviewing or revising plans, comparing architectural alternatives, planning a
  new project, or preparing an approved plan for Beadwork decomposition. Resolve
  consequential intent before architectural polishing; keep execution separate.
category: workflow
license: MIT
distribution: public
---

# Planning Workflow

Turn confirmed intent into a coherent implementation plan that fresh agents can execute without inventing product decisions. Preserve the useful parts of deep planning: evidence, rationale, focused iteration, independent criticism, and dependency-aware handoff. Quality is not measured by document length, model brand, time spent, or review count.

## Ownership and boundaries

```text
proposal-existing (existing repositories)
  grounded candidate + confirmed intent
                  ↓
planning-workflow
  evidence-backed design → focused reviews → integrated, stable plan
                  ↓ explicit plan approval and decomposition authorization
beadwork-workflow
  self-contained issues + parallel-safe dependencies
                  ↓ explicit execution authorization
implementation / supervised orchestration
```

This skill owns plan refinement, not task creation or implementation. Write only the designated plan and requested review artifacts. Reading code, tests, domain docs, and existing issues is in scope. Production changes, prototypes, glossary/ADR edits, tracker mutations, and launching implementation require separate authorization. An optional skill cannot expand this scope.

A user can authorize multiple stages in advance. Preserve that authorization and proceed when its prerequisites are met; do not ask for the same permission again. Otherwise stop at the appropriate handoff. A stable plan is not automatically approved, and approval to create issues is not approval to execute them.

For small, well-understood changes, use a brief plan proportional to the risk. For incidents, prioritize the incident workflow rather than imposing this process. A port or fixed specification can still need sequencing and validation planning: preserve its locked behavior instead of redesigning it.

## 1. Establish the input and intent boundary

Read the actual plan, relevant conversation decisions, project instructions, and relevant current repository evidence. Name the canonical plan path and revision being reviewed. Update that artifact rather than creating competing authoritative plans. If the source is ambiguous, ask which one to use.

When consuming `proposal-existing`, carry forward its decision ledger, user confirmation, invariants, rejected alternatives, non-goals, and unresolved questions. Do not repeat reconnaissance or interviews whose evidence is still applicable; verify stale or contested claims.

Classify unknowns before designing:

- **Repository or external fact:** investigate it. Do not ask the user what inspected code or current documentation can establish.
- **Load-bearing human decision:** a different answer changes outcome, scope, observable behavior, preservation/replacement boundaries, ownership, trust, persistence, or rollout. Resolve it with the user before polishing the dependent architecture.
- **Technical design choice within confirmed constraints:** recommend and compare grounded alternatives as part of planning. Do not turn every implementation choice into an approval gate.
- **Non-blocking uncertainty:** label it with impact, how it will be verified, and who must resolve it before the affected work begins.

If intent is not confirmed, present the currently answerable decision questions with recommendations and consequences. Wait for answers, record them immediately, reconcile affected sections, and ask dependent questions only after their prerequisites are settled. Keep rounds manageable. Explicit confirmation already covering the current intent is sufficient; silence, model agreement, and praise for document thoroughness are not substitutes.

For an existing repo with no meaningful candidate, use `proposal-existing` if available. For greenfield work, establish users, outcomes, constraints, scope, and success criteria, then draft a candidate and confirm its load-bearing intent here. Missing optional skills never block this process. When ambiguity spans sessions, keep a bounded open-decisions section or propose separate discovery work; do not manufacture an implementation graph for unresolved product questions.

**Checkpoint:** confirmed intent is recorded, or the plan is explicitly awaiting decisions. Fact-finding may continue while answers are pending; repeated architectural reviews must not optimize unapproved premises.

## 2. Ground the design and preserve decision ownership

Ground load-bearing claims before accepting them:

- Inspect actual code, tests, analogous flows, and relevant history. Separate current behavior from desired behavior; contradictory docs are evidence to investigate, not authority to obey blindly.
- Verify library/API claims against the installed or proposed version. A newer release is not an instruction to upgrade dependencies.
- Cite performance and cost evidence, or mark estimates as hypotheses with a measurement plan. Unverified feasibility or safety that could invalidate the design remains a blocker, not a reassuring footnote.
- Verify tool contracts before prescribing commands or orchestration. Prefer available inspection tools or current CLI help to remembered flags.
- Keep concrete paths, symbols, and sketches as confidence-labeled evidence and navigation hints. Approved behavior is authoritative; incidental file layout is not, unless explicitly constrained by the user.

Consume relevant `CONTEXT.md` vocabulary, following `CONTEXT-MAP.md` if present, and ADRs touching the design. Missing files are not a defect. Challenge overloaded terms with concrete scenarios; surface code/glossary/ADR contradictions rather than silently changing their meaning. Package directories do not by themselves establish domain boundaries.

Give each kind of knowledge a clear home:

| Artifact | Responsibility |
| --- | --- |
| Plan decision ledger | Feature-local choices, status, rationale, rejected paths, invariants, and approval evidence |
| `CONTEXT.md` | Canonical domain terms and discouraged synonyms; not implementation notes or a specification |
| ADR | A consequential choice that is hard to reverse, surprising without context, and based on a real trade-off |
| Beadwork issue | Worker-critical behavior, constraints, dependencies, and acceptance evidence, with links to relevant canonical decisions |
| Session memory / handoff | Continuity and pointers; not a replacement for project contracts |

Propose glossary changes or selective ADR promotion when useful. Until their edits are authorized, retain the resolution in the plan. If promoted, link to the canonical record and retain only the feature-specific consequences; avoid two independently maintained versions of the same decision. The integrating agent owns shared-artifact changes; reviewers propose, not concurrently rewrite them.

## 3. Make the candidate implementable and verifiable

Keep existing plan structure if it works. Fill material gaps rather than expanding every heading mechanically. A fresh agent with the plan and referenced repository material should understand:

- **Intent and scope:** user outcomes, success/failure criteria, approved constraints, non-goals, deferred scope, and keep/change/drop decisions for existing behavior.
- **Behavior:** concrete workflows, terminology, state transitions, edge cases, and observable results. Include loading and in-surface transitions for UI work, not just final data correctness.
- **Design:** ownership, interfaces, invariants, ordering, error modes, and relevant alternatives with rationale. Prefer the smallest coherent design; deep interfaces are useful when they hide real complexity, not when they justify hypothetical layers.
- **Operations where applicable:** dependency ordering, startup/shutdown, interruption, cancellation, retry/idempotency, recovery, observability, migration, rollout, and rollback or explicit irreversibility.
- **Validation:** observable test surfaces, independently stated expected outcomes, the exact reported regression to reproduce, relevant unit/integration/end-to-end coverage, and real project commands. Compilation alone cannot establish behavioral acceptance. Test reusable contracts rather than freezing incidental code structure.
- **Delivery shape:** coherent, verifiable slices, prerequisites, integration checkpoints, conflict risks, and a mapping from acceptance criteria to planned work and evidence.
- **Decision state:** proposed versus approved choices, rejected approaches, remaining blockers, non-blocking uncertainties, and what evidence would invalidate the design.

Agree consequential acceptance boundaries with the user when they are unclear; reuse existing agreement. Do not require a new approval for each test helper or file. An unrun test or planned benchmark is a future check, never evidence already obtained.

Self-contained means no dependence on forgotten conversation, not copying every external document. Include the constraints a worker must not miss and precise pointers for deeper evidence. Keep useful implementation sketches provisional. Remove dead alternatives from the active design, preserving only concise rejection rationale and explicit deletion/replacement instructions.

## 4. Review a fixed revision through focused lenses

Choose lenses according to the plan's risks. For a substantive plan, cover both **spec/intent fidelity** and **design/operational correctness**, plus relevant concerns below. One reviewer can cover several lenses for a small plan; independent reviewers or different models are useful for contested or high-impact choices, not mandatory ceremony.

| Lens | Question |
| --- | --- |
| Intent and domain | Does the design deliver the approved outcome using consistent concepts, without silently expanding or dropping scope? |
| Repository and interfaces | Are the claimed seams, dependencies, APIs, and preservation assumptions real? Is there a simpler coherent design? |
| Lifecycle and operations | What happens during partial failure, cancellation, interruption, migration, rollback, and concurrent activity? |
| Validation and experience | Which concrete outcomes would falsify success? Are the exact regression and relevant transitions observable at appropriate test surfaces? |
| Delivery and concurrency | Can slices be verified, and can supposedly independent work actually proceed together without unstable contracts or shared-artifact collisions? |

Give every reviewer the same named plan revision or immutable copy, approved constraints, relevant evidence pointers, a specific lens, and read-only instructions. Ask for supported findings, their impact, and a minimal proposed revision, including areas checked that need no change. Do not ask for speculative features or a longer plan.

Independent criticism may run in parallel. Changes to the canonical plan are serialized through one integrator. Use the host's actual delegation tools; in SBD, use `spawn` for foreground results within the current turn and `orchestrate` for event-driven supervision that yields between actionable events. Plan review is not automatically an implementation-review task type. Do not assume leaf workers can delegate again. No branch switching, commits, or shared-document edits by parallel reviewers.

Without delegation, review serially and state that independence was limited. External-model review may use supplied document text, but claims about uninspected code remain unverified. If work returns against an older revision, reconcile each finding against the current plan rather than applying its patch blindly. Do not declare convergence while reviews for the current round are still live.

When a specific interface choice is genuinely contested, explore two or three materially different designs under distinct constraints (for example, common-caller simplicity versus a demonstrated extension need). Compare invariants, failure modes, locality, migration cost, and testability. Select a coherent option; do not blend incompatible alternatives to keep every model's suggestion.

Use [PROMPTS.md](references/PROMPTS.md) for reviewer, comparison, integration, and handoff prompts.

## 5. Adjudicate findings, then integrate

The integrating agent evaluates evidence; reviewer output is not an instruction stream. Disposition each substantive finding:

- **Accept:** supported, in scope, and consistent with confirmed intent. Revise the canonical plan and record why.
- **Ask:** changes a user-owned decision or exposes a consequential ambiguity. Present the trade-off, mark affected design blocked, and wait before integrating that change.
- **Defer:** genuinely non-blocking follow-up. Record why current acceptance remains achievable; do not turn an unresolved correctness or feasibility blocker into future work by relabeling it.
- **Reject:** unsupported, redundant, incompatible with constraints, or disproportionate. Record concise rationale so later reviews do not resurrect it without new evidence.

Keep a compact review log in the plan or an explicitly requested linked review artifact: revision/lens, consequential findings, dispositions, evidence, and unresolved blockers. No separate progress system is required. Reconcile behavior, examples, interfaces, rollout, validation, and sequencing whenever a premise changes. Scope changes require user agreement; a technical improvement inside approved boundaries does not reopen the entire interview.

After integration, recheck:

1. Every in-scope acceptance criterion has planned behavior and a way to verify it; nothing was silently lost or added.
2. New load-bearing claims are supported, or explicitly blocking; relevant approvals still apply.
3. Critical interfaces, lifecycle cases, and test surfaces are coherent across sections.
4. Planned dependencies represent actual prerequisites or conflict avoidance. Independent roots and terminal deliverables are legitimate; lack of a downstream consumer is not automatically an error.
5. A fresh reader can explain a difficult slice without inventing behavior. Missing repository facts get investigated; missing human decisions return to the user.
6. The diff resolves findings rather than just adding words. Record no-change results as valid evidence, not reviewer failure.

Commit meaningful plan checkpoints where repository policy calls for it, staging only owned files. Do not require empty commits or changes merely to prove a review happened.

## 6. Converge on evidence, not quotas

A plan is stable when relevant review lenses have been covered, accepted findings are integrated, blockers are resolved, consequential claims are grounded, and the integrated revision has been rechecked without unresolved structural contradictions. The next pass should have a specific question or risk to test, not merely fill a quota.

There is no minimum line count, mandatory model, planning-time percentage, or fixed number of rounds. A large structural revision calls for reviewing its consequences; a small diff alone does not prove readiness. If reviewers keep reversing a decision, stop and resolve the disputed criterion rather than oscillating indefinitely.

Honor user-requested review budgets. If time or a pass cap is exhausted with blockers remaining, report the plan as incomplete and name them. If the requested coverage is complete with no justified changes, stop; do not manufacture revisions. A user can explicitly reduce scope or accept a risk, but record the precise decision and residual risk instead of claiming the blocker vanished.

Record three separate states in the handoff:

- **Intent:** confirmed / awaiting specified decisions.
- **Review:** stable / incomplete, with evidence and remaining blockers.
- **Next-stage authorization:** plan approval and decomposition authorized / pending; execution is separately authorized or not.

Never claim code was validated because the plan's validation strategy was reviewed. Planning reduces uncertainty; it does not guarantee that implementation will encounter no surprises.

## 7. Hand off to Beadwork, not a second tracker

Present the stable plan and consequential decisions for approval, reusing applicable prior approval. When the user has approved the plan and authorized decomposition, transition to `beadwork-workflow` if available. Supply the exact plan path/revision, approved scope and invariants, acceptance mapping, likely slices, true blockers, integration checks, and deletion/replacement requirements. If the skill is unavailable, present that handoff and ask how to proceed rather than inventing another tracker.

Planning can outline slices without creating issues. Prefer narrow, independently verifiable behavior over disconnected layer-only tasks. Shared-contract or migration prerequisites are valid when necessary. Size work for a fresh agent, not a fixed token count. Expand–migrate–contract is an option only when compatibility is required; do not preserve a deprecated path in a scope explicitly approved as complete replacement.

The downstream graph has a stronger requirement than demoable slices: every issue returned by `bw ready` must be safe to assign alongside the others. Order or reshape work that shares unstable APIs, schemas, migrations, fixtures, files, generated output, or acceptance flows. Avoid edges added only for narrative order. Parent/child hierarchy is not a blocking edge.

Beadwork uses `bw dep add <blocker> blocks <blocked>` and inspection via `bw ready`, `bw blocked`, `bw show <id>`, and `bw list`. Use native Beadwork tools when available or verify current CLI help. It rejects dependency cycles, but cannot prove semantic concurrency safety; that still needs review. Its data is not a working-tree `.beads/` directory. `bw sync` performs remote synchronization, not a local validation check; do not run it incidentally.

Keep decision discovery separate from execution: an unblocked question is ready to investigate, not ready to implement. Human decisions cannot be closed by model consensus. An open-decisions section usually suffices; a separate discovery graph or `wayfinder` is optional and requires authorization, not a prerequisite.

This handoff does not start a Beadwork goal or dispatch implementers. In SBD execution, the parent manages the ready frontier, ticket mutations, acceptance, and review adjudication. Runtime settlement is evidence, not success; path warnings and review policy are not hard acceptance gates. Do not import autonomous worker self-selection or closure rules into this planning skill.

## Do not

- Restore `br`/`bv` task routing, a parallel local-markdown issue store, or automatic graph execution.
- Reintroduce pass quotas, line-count targets, brand-specific model mandates, or promises that a sufficiently reviewed plan will “just work.”
- Treat feedback as approval, accept every suggested feature, or silently override confirmed scope and ADRs.
- Require optional skills, nested delegation, or extra artifacts beyond the designated plan to complete the core workflow.

## Further guidance

- [PROMPTS.md](references/PROMPTS.md): prompts for scoped reviews, design alternatives, integration, and Beadwork handoff.
- [FAQ.md](references/FAQ.md): artifact ownership, discovery versus delivery, authorization, and stop conditions.
- [EXAMPLES.md](references/EXAMPLES.md): worked review/dependency examples and behavioral regression scenarios for this skill.
