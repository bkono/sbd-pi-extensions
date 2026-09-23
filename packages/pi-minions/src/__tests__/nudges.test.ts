import { describe, expect, it } from "vitest";
import { nudgeFor } from "../nudges.js";
import { NUDGE_EVENTS, TASK_TYPES } from "../task-types.js";

const AGENT_NUDGE = "agent-nudge-sentinel";

describe("nudgeFor selection", () => {
  it("provides guidance for every task type and event, including untyped children", () => {
    for (const taskType of [...TASK_TYPES, undefined]) {
      for (const event of NUDGE_EVENTS) {
        expect(nudgeFor({ taskType }, event).length).toBeGreaterThan(0);
      }
    }
  });

  it("uses task-type policy instead of agent completion_nudge", () => {
    for (const taskType of TASK_TYPES) {
      for (const event of NUDGE_EVENTS) {
        expect(nudgeFor({ taskType, completionNudge: AGENT_NUDGE }, event)).toBe(
          nudgeFor({ taskType }, event),
        );
      }
    }
  });

  it("uses only agent completion_nudge for untyped settled and failed events", () => {
    for (const event of ["settled", "failed"] as const) {
      expect(nudgeFor({ completionNudge: AGENT_NUDGE }, event)).toBe(AGENT_NUDGE);
    }
  });

  it("ignores agent completion_nudge on parentMessage and aborted", () => {
    for (const event of ["parentMessage", "aborted"] as const) {
      expect(nudgeFor({ completionNudge: AGENT_NUDGE }, event)).toBe(nudgeFor({}, event));
    }
  });

  it("treats blank agent completion_nudge as absent", () => {
    expect(nudgeFor({ completionNudge: "" }, "settled")).toBe(nudgeFor({}, "settled"));
    expect(nudgeFor({ completionNudge: "   " }, "failed")).toBe(nudgeFor({}, "failed"));
  });

  it("falls back safely for hostile task and event runtime values", () => {
    const hostileTaskType = "x".repeat(10_000);
    expect(nudgeFor({ taskType: hostileTaskType }, "settled")).toBe(nudgeFor({}, "settled"));
    const unknownEvent = nudgeFor({}, "unknown-event");
    expect(unknownEvent.length).toBeGreaterThan(0);
    expect(nudgeFor({ taskType: hostileTaskType }, "unknown-event")).toBe(unknownEvent);
    expect(nudgeFor({ taskType: { malformed: true } }, null)).toBe(unknownEvent);
  });
});
