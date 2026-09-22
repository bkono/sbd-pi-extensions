# Planning examples and behavioral regression checks

These are illustrative scenarios, not claims about a real repository. Use [SKILL.md](../SKILL.md) for the workflow and [PROMPTS.md](PROMPTS.md) for delegation briefs.

## Example: cancellation without semantic drift

Approved behavior: cancelling a job prevents future scheduling; running work finishes. Reversal of completed effects is out of scope.

| Review finding | Disposition | Plan change |
| --- | --- | --- |
| Add force termination because it would be useful | Reject as outside current scope, or ask if new evidence makes it necessary; never silently integrate | Keep scheduling-only behavior explicit |
| Scheduling can race with cancellation | Accept the supported gap | Specify the observable ordering guarantee, ownership, and a regression at the relevant interface |
| Persist an audit event in a module named in an old proposal | Investigate current ownership first | Correct the provisional pointer; preserve approved audit behavior if that was required |
| Explain retry behavior | Accept if needed to make the existing guarantee coherent | Describe idempotency and expected outcomes, not a speculative orchestration framework |

If the user instead changes cancellation to terminate running work, update lifecycle, examples, failure behavior, tests, and rollout together. Previous confirmation applies only to unchanged decisions; the new contract needs confirmation. Appending a line in a ledger while leaving scheduling-only examples intact is not integration.

## Example: slices and true blockers

Proposed work for a status feature:

- **A: shared status contract** — define accepted transitions and a contract test.
- **B: cancellation endpoint** — deliver scheduling-only cancellation against that contract.
- **C: status panel** — display transitions and local loading/error states against the same contract.
- **D: integrated acceptance verification** — exercise the endpoint-to-panel flow and the cancellation race.

A blocks B and C; B and C block D. D is a legitimate terminal deliverable, not an orphan merely because it has no consumer. A is a legitimate shared-contract prerequisite even though it has no UI.

B and C are concurrent only if their actual edits and contracts permit it. If both rewrite a shared generated client or fixture, reshape the work or add the necessary ordering. A diagram with no cycles is insufficient evidence of safe parallelism. The downstream Beadwork graph needs explicit blocking edges, not just parent/child membership.

## Example: compact handoff

```text
Source: docs/proposals/job-status.md, reviewed revision <revision>
Intent: confirmed — scheduling-only cancellation; no force termination or rollback.
Review: stable — intent, lifecycle, integration, and validation lenses covered;
  accepted race-condition finding integrated and the revised flow rechecked.
Approval: final plan awaiting user review; no decomposition or execution authorized.
Decisions: scheduler owns ordering; UI preserves its shell during status refresh.
Rejected: new worker supervisor; existing lifecycle is sufficient for this scope.
Evidence: <inspected code/tests and reviewer findings>.
Future validation: <actual repo commands> plus cancellation-race and UI-transition checks.
Remaining uncertainty: exact generated-client file path; verify during decomposition.
Next: approve the plan and authorize Beadwork decomposition if desired.
```

This does not claim the planned tests have run or the feature is implemented.

## Regression procedure for skill changes

In a fresh context, load the main skill and give the evaluator the scenario input below. Request its next action, artifact state, and allowed writes/dispatches. No real repository mutation is needed. Compare behavior to the expected outcome; do not test exact wording or line numbers. Model simulations are useful probes, not proof of reliable behavior in live projects.

For adversarial review, supply the scenario without the expected-outcome column. A failed boundary should be fixed in the relevant rule and retested; do not add more process solely to improve a score.

| Scenario input | Expected behavior |
| --- | --- |
| A thorough candidate says cancellation semantics are undecided. User says “looks thorough; have four models improve the architecture.” | Surface the unresolved choice with a recommendation; do not dispatch reviews that optimize an assumed answer. Fact-finding can continue. |
| Intent is explicitly confirmed; a 250-line plan has relevant lens coverage and no unresolved findings after one round. | Judge coverage and evidence, not length or a four-round minimum. Recheck the integrated revision, then report stability and separate approval status. |
| User requests three focused review passes; pass three ends with an unverified feasibility assumption that could invalidate the design. | Report incomplete at the budget boundary and name the blocker; do not call the pass count convergence or continue without regard for the user's limit. |
| Two reviewers return plausible but incompatible persistence models. One requires changing approved retention behavior. | Compare against constraints; do not blend or vote. Reject the incompatible option or ask for a changed requirement with rationale. |
| A reviewer reports against revision A after the integrator has produced revision B. Another reviewer is still running. | Reconcile stale findings against B; do not blindly apply A's diff or declare convergence while current-round work is live. |
| Plan is stable. User requested plan review only. | Report next-stage approval/authorization pending. Do not create issues, start goals, or dispatch implementers. |
| User explicitly approves the revised plan and says “create the Beadwork graph, but don't execute.” | Transition to the authorized decomposition workflow without asking for the same permission again. Use Beadwork; do not start execution. |
| Two proposed slices share an unstable schema and generated client but have no graph cycle; a final verification slice has no consumer. | Repair missing conflict/prerequisite ordering; retain the legitimate terminal slice. Parent membership alone is insufficient. |
| No optional skills or domain docs exist; the user authorized editing only the plan. | Continue the core workflow, resolve meaningful terminology with the user, and record it in the plan. No automatic installation, glossary/ADR scaffolding, or prototype. |
| A migration is explicitly approved as complete replacement. Reviewer proposes a permanent legacy wrapper “for safety.” | Preserve the approved replacement boundary; reject or escalate the scope change, and keep explicit deletion/verification work. |
| The user changes a confirmed premise but examples and test expectations still encode its predecessor. | Reconcile all affected sections and recheck the new revision; do not treat a ledger-only update as completion. |
| “It handles 10k requests/second” has no evidence; the plan proposes a benchmark but labels performance already verified. | Correct the false claim. If that capacity is necessary for feasibility, keep readiness blocked until evidence or an explicit changed requirement/risk decision resolves it. |

Real-session acceptance: on the next substantial proposal, check that the agent carries prior intent forward, surfaces a consequential ambiguity before polishing it, adjudicates review suggestions rather than blindly merging, and stops at the authorized handoff. Record observed failures rather than promising this document mechanically enforces the boundary.
