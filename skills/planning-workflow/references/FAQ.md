# Planning FAQ

The workflow contract lives in [SKILL.md](../SKILL.md). These answers clarify edge cases; they do not add approval gates or automatic stages.

## Is a candidate proposal already a plan we should polish?

Only within confirmed intent. A detailed document can encode an unapproved premise very convincingly. Carry `proposal-existing` confirmation forward, but resolve any flagged load-bearing decisions before optimizing the dependent architecture. Previously approved behavior should not trigger a fresh interview unless new evidence contradicts it or the requested scope changes.

## What if there is no proposal, glossary, ADR directory, or optional skill?

Work from the approved brief and current evidence. Existing-repository proposals can use `proposal-existing`; greenfield candidates can be drafted here. Core intent clarification and review do not depend on external skill installation. Read domain records when present; create none merely because a template mentions them. Keep resolved terms and decisions in the authorized plan until separate artifact edits are authorized.

## Does self-contained mean no references?

No. It means no missing behavioral decisions hidden in prior chat. Preserve critical constraints in the plan and later work items; use precise references for code evidence and canonical project decisions. A fresh worker may inspect the repository. Copying every dependency's documentation increases drift rather than reducing it.

## Are file paths and code sketches forbidden?

No. They are useful evidence with a known revision and confidence level. Distinguish them from behavioral requirements. A later file move should trigger revalidation of the pointer, not a claim that approved behavior changed. A public interface can itself be a requirement when explicitly locked; do not demote that contract to a disposable sketch.

## Must every decision become an ADR?

No. Ordinary feature decisions remain in the plan ledger. Promote decisions selectively using the ADR criteria in the main skill, with authorization. The glossary owns domain meaning, not implementation rationale. A handoff or memory summary points at those records; it does not supersede them.

## How many reviews and how long a plan?

Enough to cover material risks and resolve supported findings. A 300-line plan may be complete; a 3,000-line plan may still hide the central question. Different models and fresh contexts can expose blind spots, but no model is a universal final arbiter. Honor explicit review budgets, record coverage, and distinguish exhaustion of the budget from actual readiness.

## Is a no-change review useful?

Yes, when it names what was checked and why the plan holds. Do not require edits or empty commits as proof. Conversely, several small diffs do not establish stability if relevant lenses were skipped or feasibility remains unverified. After significant integration, recheck the resulting revision rather than relying only on reviews of its predecessor.

## What about surprises during implementation?

Planning cannot eliminate them. A worker investigates newly discovered facts; a fact that invalidates the plan is escalated with evidence. The parent distinguishes an implementation adjustment within approved constraints from a changed user-facing contract. Only the latter reopens the corresponding human decision. Do not bulldoze a contradiction because the plan was once marked stable.

## Should we prototype or use Wayfinder first?

Sometimes. A bounded prototype can answer an uncertain technical or interaction question, but code and environment changes need explicit authorization outside this skill's default write scope. Multi-session decision discovery may justify a separate map. It must not be mistaken for the executable task graph, and a question awaiting human input cannot be resolved by an agent impersonating the human. Use a plan section when that is enough. Never switch branches underneath live shared-checkout workers.

## Must every slice span schema, API, UI, and tests?

No. Prefer a complete, verifiable behavioral increment through the layers it actually needs. Shared contracts, migration prerequisites, and integration verification can be legitimate standalone tasks. Each needs a concrete contribution and acceptance evidence. Independent roots and terminal deliverables are valid; unnecessary dependencies just hide parallelism.

## Does a cycle-free graph mean parallel work is safe?

No. Dependencies must also account for unstable contracts and shared-artifact conflicts. A prerequisite parent is not automatically a blocker, and parent hierarchy alone never establishes execution ordering. Beadwork's graph validation cannot infer all semantic conflicts; inspect the ready set as a proposed concurrent assignment.

## Can workers choose and close their own tickets?

Not under SBD's supervised execution policy. The parent owns dispatch, ticket mutations, acceptance, and review adjudication; children return evidence. This planning skill is not an alternate execution loop. Lifecycle settlement and a review recommendation do not mechanically guarantee acceptance.

## Is task creation required to finish planning?

No. Planning delivers a stable artifact with honest approval and authorization status. Beadwork decomposition is a separate, explicitly authorized transition. If the user already approved the relevant stages, honor that approval without asking again; still satisfy each stage's prerequisites. A newly created or ready epic does not authorize execution by itself.

## What was intentionally replaced?

The old skill coupled planning completion to issue creation and prescribed a minimum review count, plan-length targets, particular model brands, automatic feature expansion, and legacy task-routing tools. Those are replaced by scoped review, evidence-based convergence, explicit authorization boundaries, and a Beadwork-only task handoff. The old prompts and FAQ are replaced too, not retained as alternate instructions.
