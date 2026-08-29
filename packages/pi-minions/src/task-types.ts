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

/** Provider-visible closed list. Role remains an open string elsewhere. */
export const TaskTypeSchema = Type.Enum(TASK_TYPES, {
  type: "string",
  description:
    "Closed workflow type that selects parent nudge policy. Omit for untyped delegation.",
});

/** Parent-packet event classes. There is no `completed` value; settlement is `settled`. */
export const NUDGE_EVENTS = ["settled", "aborted", "failed", "parentMessage"] as const;

export type NudgeEvent = (typeof NUDGE_EVENTS)[number];

export const NudgeEventSchema = Type.Enum(NUDGE_EVENTS, {
  type: "string",
  description:
    "Parent-packet event class. Abort is not failure. Settlement is fully idle, not success.",
});
