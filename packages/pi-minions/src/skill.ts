export const SPAWN_GUIDELINE =
  "Use `spawn` for a foreground delegation whose result should return inside this turn. The tool blocks until the minion completes.";

export const ORCHESTRATE_GUIDELINE =
  "Use `orchestrate` when the supervisor must remain available to the user or manage an ongoing workflow. Dispatch, then yield; resume on child events or user messages.";

export const ORCHESTRATE_SIDECAR_GUIDELINES = [
  "Delegate independent slices with orchestrate. Do not edit a delegated scope while its child remains live; message or halt the child instead. Active domain restrictions such as a manager-only role still apply.",
  "After orchestrate registers background work, treat delegated work as live until terminal lifecycle evidence, explicit inspection, or halt proves otherwise.",
  "After dispatch, stop. Once orchestrate accepts work, end the assistant turn. Do not continue implementation, test-harness preparation, research, or validation—even if that work is independent or previously planned. Complete prerequisites before dispatch, delegate independent work, or defer it until results arrive.",
  "Child completion and failure follow-ups wait until your tool sequence ends. Any continued tool sequence can postpone them—not just polling. Yielding is part of supervision, not idle time or abandonment.",
  "Resume on a delivered child event or user message. Handle the actionable evidence, perform necessary coordination, dispatch follow-on work, then yield again. A user request remains actionable while workers run.",
  "Never claim orchestrate-delegated work or the orchestration goal complete while any child remains live.",
  "Treat orchestrate path intent and overlap notices as advisory, not locks.",
] as const;

const ORCHESTRATE_SIDECAR_SKILL = ORCHESTRATE_SIDECAR_GUIDELINES.map(
  (guideline) => `- ${guideline}`,
).join("\n");

export const MINIONS_SKILL = `# pi-minions

Use minions when independent work can run in isolated agent sessions.

## Blocking versus yielding

- ${SPAWN_GUIDELINE} Spawn is not in an orchestration group and does not emit parent lifecycle packets.
- ${ORCHESTRATE_GUIDELINE} It returns handles immediately; results arrive later as coalesced parent packets. Persistent hosts only (\`tui\` / \`rpc\`).

## Supervisor loop

Dispatch → yield → receive follow-up → evaluate and decide → dispatch or yield.

**Yield** means end the assistant turn without another tool call. A brief pending-status response is enough when useful. Children continue running in the same Pi process, and follow-ups resume supervision automatically. Do not ask the user to say “continue.” Do not sleep, poll, or invent work to keep the turn alive. Yielding saves tokens and preserves context for decisions instead of spending it on repeated status checks.

Follow-ups intentionally wait until the current tool sequence ends so child completions do not interrupt the active user conversation. Any continued tool sequence postpones delivery, including useful preparation. Ending the turn is neither task completion nor process shutdown.

| Situation | Supervisor action |
| --- | --- |
| Selected workers still need registration | Finish registering them, then end this turn. |
| Dispatch complete; parent preparation or implementation remains | Yield. Delegate that work or defer it until results arrive. |
| User asks a question | Answer it; inspect only if needed for that question. |
| Child result arrives | Evaluate the supplied evidence; retrieve missing details selectively. |
| Result handled; siblings still running | Dispatch eligible follow-on work, otherwise yield. |
| Recovering unclear state after compaction | Inspect to resolve the uncertainty, then return to event-driven supervision. |

### Evaluate and decide

The supervisor owns the final judgment: is the result correct, appropriate to the approved scope, aligned with project vision and goals, and up to the quality bar? Child output and reviewer findings are evidence, not instructions to accept mechanically. Apply the active domain's review and acceptance policy; settlement alone is not acceptance or ticket closure.

For each substantive finding, choose **fix / file / reject**:

- **Fix:** resolve an accepted blocking finding and verify it before acceptance, including re-review where required by the active policy.
- **File:** record a valid nonblocking follow-up in the active tracker, with rationale for deferral. Filing a blocker does not make it nonblocking or satisfy acceptance.
- **Reject:** record why the finding is unsupported, inappropriate to scope, or misaligned with project goals. Avoid expanding the system merely to satisfy a reviewer.

If a finding requires changing approved product intent or scope, ask the user rather than deciding that change unilaterally. Once required findings are resolved and acceptance evidence is sufficient, accept the work under the active policy. If evidence was already evaluated and decided, do not repeat the work or publish a separate “already handled” acknowledgment. New findings still require evaluation.

## Cooperative sidecar

${ORCHESTRATE_SIDECAR_SKILL}

## Tool reference

- \`spawn\`: provide \`task\`, optional \`agent\`, and optional \`model\`. Use a \`tasks\` array for parallel foreground minions.
- Each \`orchestrate\` task requires \`task\` (complete child prompt; not wrapped) and \`description\` (short fleet label; do not infer from \`task\`). Optional: \`agent\`, \`taskType\`, \`model\`, \`domain\`. Domain metadata is opaque; multiple live children may share a \`workItemId\`.
- \`agent\` is a discovered agent/template name (same loader as spawn). Built-in \`worker\` and \`investigate\` are always available and overridable. Call \`list_agents\` before selecting a named agent if unsure. Not a closed enum.
- \`taskType\` is closed: \`implementation\`, \`fix\`, \`reviewImplementation\`, \`reviewScope\`, \`investigateBlocker\`. Omit for untyped work. It selects parent nudge text when the child settles, fails, aborts, or sends a notification. Never collapse agent and taskType.
- One open group per parent session. Omit \`groupId\` to create it or join the open group. A second group is rejected. \`cwd\` is group-create only, must already exist, and cannot change later.
- Use \`halt\` with a minion id, name, group id, \`group\`, or \`all\` to abort running minions. Halt of a group forgets the open orchestration group so the next orchestrate creates a new id. Halt does not exit Beadwork goal mode.
- Use \`list_minions\` for a user's status question, context recovery, or a concrete coordination decision. It shows spawn vs orchestrated minions, agent, taskType, group, last said, and peer-message failures. Wait for the completion event instead of polling an active child's status.
- Use \`show_minion\` for specific evidence missing from a delivered packet or to investigate a concrete problem. Inspection is read-only and does not acknowledge pending follow-ups. Human users can also use \`/minions show <id|name>\`.
- Use \`send_minion_message\` to message a live orchestrated child without waiting. Not available to children. Parent-to-child mail does not start a parent turn. Child-to-parent \`send_minion_peer\` is also nonblocking: it may wake the parent, but never parks the child or requires a reply.

Children are process-local. They die with the parent Pi process.
Live detach is not available. Users can engage the supervisor normally; this package does not expose direct user steering of child sessions.
`;

export function getMinionsSkill(): string {
  return MINIONS_SKILL;
}
