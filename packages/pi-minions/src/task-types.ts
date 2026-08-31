import { Type } from "typebox";

/** Closed workflow types. There is no `validation` value. */
export const TASK_TYPES = [
  "implementation",
  "fix",
  "reviewImplementation",
  "reviewScope",
  "investigateBlocker",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && (TASK_TYPES as readonly string[]).includes(value);
}

export function normalizeTaskType(value: unknown): TaskType | undefined {
  return isTaskType(value) ? value : undefined;
}

/** Provider-visible closed list. Agent selection is a separate discovered-name field. */
export const TaskTypeSchema = Type.Enum(TASK_TYPES, {
  type: "string",
  description:
    "Closed workflow type that selects parent nudge policy. Omit for untyped delegation.",
});

/** Parent-packet event classes. There is no `completed` value; settlement is `settled`. */
export const NUDGE_EVENTS = ["settled", "aborted", "failed", "parentMessage"] as const;

export type NudgeEvent = (typeof NUDGE_EVENTS)[number];

export function isNudgeEvent(value: unknown): value is NudgeEvent {
  return typeof value === "string" && (NUDGE_EVENTS as readonly string[]).includes(value);
}

export const NudgeEventSchema = Type.Enum(NUDGE_EVENTS, {
  type: "string",
  description:
    "Parent-packet event class. Abort is not failure. Settlement is fully idle, not success.",
});
