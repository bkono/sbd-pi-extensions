import { isNudgeEvent, isTaskType, type NudgeEvent, type TaskType } from "./task-types.js";

export interface NudgeChild {
  /** API inputs are enum-validated; runtime projections still treat this as hostile. */
  taskType?: TaskType | unknown;
  completionNudge?: string;
}

type EventNudges = Record<NudgeEvent, string>;

const ABORTED =
  "The child was aborted. Do not retry unless the user asks. Abort is a halt, not a failure.";

const PARENT_MESSAGE = "A child sent a notification. No reply is required.";

const GENERIC: EventNudges = {
  settled:
    "A background task settled. Evaluate the evidence included below and decide the next action; retrieve additional evidence only if needed.",
  failed:
    "A background task failed. Evaluate the error included below and decide the next action; retrieve additional evidence only if needed.",
  aborted: "A background task was aborted. Do not retry unless the user asks.",
  parentMessage: PARENT_MESSAGE,
};

const REVIEW_FAILED =
  "Evaluate the supplied failure evidence; retrieve missing details only if needed. Decide whether to re-review or escalate.";

const BY_TASK_TYPE: Record<TaskType, EventNudges> = {
  implementation: {
    settled:
      "Assess the child's supplied evidence. Apply the active domain review policy if any. " +
      "Accept, dispatch a fix, or ask the user. Do not close a ticket solely because the child settled.",
    failed:
      "Evaluate the supplied failure evidence; retrieve missing details only if needed. Decide whether to retry, dispatch a fix, or escalate.",
    aborted: ABORTED,
    parentMessage: PARENT_MESSAGE,
  },
  fix: {
    settled:
      "Verify the change against the original finding. Require independent re-review before acceptance.",
    failed:
      "Evaluate the supplied failure evidence; retrieve missing details only if needed. Decide whether to retry or escalate.",
    aborted: ABORTED,
    parentMessage: PARENT_MESSAGE,
  },
  reviewImplementation: {
    settled:
      "Assess reviewer findings against product goals and constraints; they are evidence, not " +
      "instructions to accept verbatim. Do not expand the system through adversarial hardening " +
      "without confirming it is the right product behavior.",
    failed: REVIEW_FAILED,
    aborted: ABORTED,
    parentMessage: PARENT_MESSAGE,
  },
  reviewScope: {
    settled: "Evaluate cross-ticket findings and decide whether the goal meets acceptance.",
    failed: REVIEW_FAILED,
    aborted: ABORTED,
    parentMessage: PARENT_MESSAGE,
  },
  investigateBlocker: {
    settled:
      "Apply the answer to blocked work, or record why escalation remains. " +
      "Investigation settlement is not implementation settlement.",
    failed:
      "Evaluate the supplied failure evidence; retrieve missing details only if needed. Decide whether to retry or escalate.",
    aborted: ABORTED,
    parentMessage: PARENT_MESSAGE,
  },
};

function agentNudge(child: NudgeChild): string | undefined {
  const text = child.completionNudge?.trim();
  return text ? child.completionNudge : undefined;
}

/**
 * Select parent instruction text for a child state change.
 * Task-type policy wins. Agent completion_nudge applies only to settled/failed
 * when taskType is absent. Never concatenates sources.
 */
export function nudgeFor(child: NudgeChild, event: NudgeEvent | unknown): string {
  const normalizedEvent = isNudgeEvent(event) ? event : undefined;
  if (!normalizedEvent) {
    return "A background child changed state. Evaluate the supplied evidence and decide the next action; retrieve missing details only if needed.";
  }

  if (isTaskType(child.taskType)) return BY_TASK_TYPE[child.taskType][normalizedEvent];

  if (normalizedEvent === "settled" || normalizedEvent === "failed") {
    const fromAgent = agentNudge(child);
    if (fromAgent !== undefined) return fromAgent;
  }

  return GENERIC[normalizedEvent];
}
