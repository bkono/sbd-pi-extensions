import { isNudgeEvent, isTaskType, type NudgeEvent, type TaskType } from "./task-types.js";

export interface NudgeChild {
  /** API inputs are enum-validated; runtime projections still treat this as hostile. */
  taskType?: TaskType | unknown;
  completionNudge?: string;
}

type EventNudges = Record<NudgeEvent, string>;

const ABORTED =
  "The child was aborted. Do not retry unless the user asks. Abort is a halt, not a failure.";

const PARENT_MESSAGE =
  "A live child sent a notification. Assess it alongside current work; no reply is required.";

const GENERIC: EventNudges = {
  settled: "A background task settled. Inspect its result and decide the next action.",
  failed: "A background task failed. Inspect the error and decide the next action.",
  aborted: "A background task was aborted. Do not retry unless the user asks.",
  parentMessage: "A live child sent a notification. No reply is required; it has not settled.",
};

const REVIEW_FAILED = "Inspect the failure. Decide whether to re-review or escalate.";

const BY_TASK_TYPE: Record<TaskType, EventNudges> = {
  implementation: {
    settled:
      "Assess the child's evidence. Apply the active domain review policy if any. " +
      "Accept, dispatch a fix, or ask the user. Do not close a ticket solely because the child settled.",
    failed: "Inspect the failure. Decide whether to retry, dispatch a fix, or escalate.",
    aborted: ABORTED,
    parentMessage: PARENT_MESSAGE,
  },
  fix: {
    settled:
      "Verify the change against the original finding. Require independent re-review before acceptance.",
    failed: "Inspect the failure. Decide whether to retry or escalate.",
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
    settled: "Adjudicate cross-ticket findings and judge whether the goal meets acceptance.",
    failed: REVIEW_FAILED,
    aborted: ABORTED,
    parentMessage: PARENT_MESSAGE,
  },
  investigateBlocker: {
    settled:
      "Apply the answer to blocked work, or record why escalation remains. " +
      "Investigation settlement is not implementation settlement.",
    failed: "Inspect the failure. Decide whether to retry or escalate.",
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
    return "A background child changed state. Inspect the evidence and decide the next action.";
  }

  if (isTaskType(child.taskType)) return BY_TASK_TYPE[child.taskType][normalizedEvent];

  if (normalizedEvent === "settled" || normalizedEvent === "failed") {
    const fromAgent = agentNudge(child);
    if (fromAgent !== undefined) return fromAgent;
  }

  return GENERIC[normalizedEvent];
}
