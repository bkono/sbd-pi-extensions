# Planning prompts

Use these with [planning-workflow](../SKILL.md). Fill the source, revision, constraints, and scope before delegation. These are task briefs, not permission to expand the workflow. No prompt requires a particular model or harness.

## Focused review

```text
Review <plan path or supplied text>, revision <commit/content revision>, read-only.
Lens: <intent/domain | repository/interfaces | lifecycle/operations | validation/experience | delivery/concurrency>.
Approved intent, invariants, rejected paths, and non-goals: <summary and precise references>.
Relevant evidence: <repo paths, docs, prior decisions>. Mark anything you cannot inspect as unverified.

First identify any unresolved human decision that makes this review premature.
Within confirmed scope, identify concrete omissions, contradictions, unnecessary complexity,
unsupported assumptions, and failures of acceptance or operability. Do not invent new features.

For each substantive finding, return:
- Plan section and the specific claim at issue.
- Evidence or concrete failure scenario; distinguish observation from hypothesis.
- Impact: blocks readiness or non-blocking, with justification.
- Smallest recommended revision, with rationale and trade-offs.
- Whether it requires a new user decision.

Name the areas checked that need no change. No-change is a valid result.
Do not edit files, switch branches, commit, create issues, or delegate further.
Return findings to the integrator; do not declare the overall plan approved.
```

## Compare interfaces or competing designs

Use only when a concrete choice merits alternatives. Give each reviewer the same problem and constraints but a different design objective; do not imply that each objective warrants a new abstraction.

```text
Compare alternatives for <specific decision> within <confirmed behavior and constraints>.
Source plan/revision: <reference>. Relevant evidence: <references>.
Your design objective: <common-caller simplicity | minimal interface | demonstrated extension need>.

Provide the interface and its invariants, ordering/error behavior, a usage example,
ownership/lifecycle implications, what implementation detail it hides, and how to test it.
Explain costs, migration consequences, limitations, and the strongest competing option.
Distinguish evidence from assumptions. Do not add scope or modify files.
```

The integrator chooses a coherent design against actual requirements. Mixing alternatives is justified only when their contracts remain compatible; model voting is not approval.

## Integrate findings

```text
Integrate review findings for <canonical plan>, reviewed revision <revision>.
Current approved intent and constraints: <references>.
Findings: <reports>.

Reconcile stale findings against the current revision before proposing edits.
Disposition every substantive finding: accept, ask, defer, or reject, with rationale.
Accept supported improvements within scope; ask before changing human-owned decisions.
Do not defer an acceptance/feasibility blocker merely to call the plan complete.
Do not automatically accept every suggestion or aim for a longer document.

Update only <authorized plan/review artifacts>. Preserve concrete evidence pointers.
When a premise changes, reconcile behavior, examples, interfaces, rollout, validation,
and dependencies. Retain concise rejected-path rationale and existing approvals that still apply.

Recheck the integrated plan against approved acceptance criteria and relevant review lenses.
Report consequential changes, remaining blockers, coverage/evidence, and the next review question
if one is warranted. Separate intent confirmation, review stability, and next-stage authorization.
This integration task makes no tracker or implementation changes. Return the plan and its
status to the coordinating agent, which may then transition to an already authorized next stage.
```

## Greenfield candidate

```text
Create a candidate plan for <new project> without implementing it.
Known users, outcomes, constraints, and non-goals: <brief>.
Designated artifact: <path or response-only>.

Separate discoverable facts from human choices. Ask the currently answerable load-bearing
questions with recommendations; do not assume answers to questions whose prerequisites remain open.
Keep the candidate concrete enough to expose decisions. Mark conditional recommendations explicitly.
Record decisions and rationale as they are resolved. Confirm intent before repeated architectural
review, reusing applicable prior approval. Do not choose a stack solely because it appears in a template.
```

## Beadwork handoff

This brief is for the explicitly authorized transition to `beadwork-workflow`, not an automatic final step of plan review.

```text
The user approved <canonical plan/revision> and authorized Beadwork decomposition only.
Carry forward <approved scope, invariants, rejected paths, deletion/replacement requirements>.
Acceptance mapping and relevant evidence: <references>.

Draft coherent, independently verifiable slices with necessary shared-contract/migration
prerequisites. Include worker-critical context and expected validation evidence in each issue;
link canonical decisions without making the worker reconstruct forgotten conversation.

Design true dependencies so any set returned by bw ready can be assigned concurrently.
Review API/schema/file/fixture/migration/acceptance-flow conflicts, not merely graph acyclicity.
Use native Beadwork tools or the verified bw CLI; dependency direction is
bw dep add <blocker> blocks <blocked>. Parent hierarchy alone is not a dependency.

Inspect existing issues to avoid duplicate work before publishing the approved graph.
Unresolved human decisions are not executable implementation tasks.
Do not start tickets, start goal mode, dispatch implementers, or synchronize remote state
merely because the graph now exists. Report readiness and the remaining execution authorization.
```

If execution was also explicitly authorized, state that separately and pass it to the execution workflow after graph validation; do not use this decomposition-only brief to silently discard or invent authorization.
