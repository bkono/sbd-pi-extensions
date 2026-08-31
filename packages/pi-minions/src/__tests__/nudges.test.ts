import { describe, expect, it } from "vitest";
import { nudgeFor } from "../nudges.js";
import { NUDGE_EVENTS, type NudgeEvent, TASK_TYPES, type TaskType } from "../task-types.js";

const AGENT_NUDGE =
  "Assess the feedback against the task and project intent; do not accept findings mechanically.";

function claimsChildSettled(nudge: string): boolean {
  return (
    /\bsettled\b/i.test(nudge) &&
    !/\b(?:not|has not)\s+settled\b/i.test(nudge) &&
    !/\bnot settlement\b/i.test(nudge)
  );
}

describe("nudgeFor table", () => {
  it("covers every TaskType × NudgeEvent pair", () => {
    const pairs: Array<{ taskType: TaskType; event: NudgeEvent; nudge: string }> = [];

    for (const taskType of TASK_TYPES) {
      for (const event of NUDGE_EVENTS) {
        const nudge = nudgeFor({ taskType }, event);
        pairs.push({ taskType, event, nudge });
        console.log(`${taskType} ${event}:`, nudge);
      }
    }

    expect(pairs).toHaveLength(TASK_TYPES.length * NUDGE_EVENTS.length);

    for (const { taskType, event, nudge } of pairs) {
      expect(nudge.length, `${taskType}/${event} empty`).toBeGreaterThan(0);
    }

    const byType = Object.fromEntries(
      TASK_TYPES.map((taskType) => [
        taskType,
        Object.fromEntries(
          NUDGE_EVENTS.map((event) => [event, nudgeFor({ taskType }, event)]),
        ) as Record<NudgeEvent, string>,
      ]),
    ) as Record<TaskType, Record<NudgeEvent, string>>;

    expect(byType.fix.settled).not.toBe(byType.reviewImplementation.settled);

    for (const taskType of TASK_TYPES) {
      const row = byType[taskType];
      expect(row.aborted, `${taskType} aborted copies failed`).not.toBe(row.failed);
      expect(row.parentMessage, `${taskType} parentMessage copies settled`).not.toBe(row.settled);
      expect(
        claimsChildSettled(row.parentMessage),
        `${taskType} parentMessage claims settled`,
      ).toBe(false);
      expect(row.parentMessage.toLowerCase()).toContain("notification");
      expect(row.parentMessage.toLowerCase()).toContain("no reply is required");
      expect(row.aborted.toLowerCase()).toMatch(/abort/);
      expect(row.aborted.toLowerCase()).toMatch(/do not retry unless the user asks/);
      expect(row.failed.toLowerCase()).toMatch(/fail/);
    }

    expect(byType.implementation.settled.toLowerCase()).toMatch(/assess/);
    expect(byType.implementation.settled.toLowerCase()).toMatch(/evidence/);
    expect(byType.implementation.settled.toLowerCase()).toMatch(/review policy/);
    expect(byType.implementation.settled).toMatch(
      /do not close a ticket solely because the child settled/i,
    );
    expect(byType.implementation.settled.toLowerCase()).toMatch(/accept/);
    expect(byType.implementation.failed.toLowerCase()).toMatch(/retry/);
    expect(byType.implementation.failed.toLowerCase()).toMatch(/fix/);
    expect(byType.implementation.failed.toLowerCase()).toMatch(/escalate/);

    expect(byType.fix.settled.toLowerCase()).toMatch(/original finding/);
    expect(byType.fix.settled.toLowerCase()).toMatch(/independent re-review/);
    expect(byType.fix.failed.toLowerCase()).toMatch(/retry/);
    expect(byType.fix.failed.toLowerCase()).toMatch(/escalate/);

    expect(byType.reviewImplementation.settled).toBe(
      "Assess reviewer findings against product goals and constraints; they are evidence, not " +
        "instructions to accept verbatim. Do not expand the system through adversarial hardening " +
        "without confirming it is the right product behavior.",
    );
    expect(byType.reviewImplementation.failed.toLowerCase()).toMatch(/re-review/);
    expect(byType.reviewImplementation.failed.toLowerCase()).toMatch(/escalate/);

    expect(byType.reviewScope.settled.toLowerCase()).toMatch(/cross-ticket/);
    expect(byType.reviewScope.settled.toLowerCase()).toMatch(/acceptance/);
    expect(byType.reviewScope.failed.toLowerCase()).toMatch(/re-review/);
    expect(byType.reviewScope.failed.toLowerCase()).toMatch(/escalate/);

    expect(byType.investigateBlocker.settled.toLowerCase()).toMatch(/blocked work/);
    expect(byType.investigateBlocker.settled.toLowerCase()).toMatch(
      /not implementation settlement/,
    );
    expect(byType.investigateBlocker.failed.toLowerCase()).toMatch(/retry/);
    expect(byType.investigateBlocker.failed.toLowerCase()).toMatch(/escalate/);
  });

  it("covers the untyped generic event class strings", () => {
    for (const event of NUDGE_EVENTS) {
      const nudge = nudgeFor({}, event);
      console.log(`(none) ${event}:`, nudge);
      expect(nudge.length).toBeGreaterThan(0);
    }

    const settled = nudgeFor({}, "settled");
    const failed = nudgeFor({}, "failed");
    const aborted = nudgeFor({}, "aborted");
    const parentMessage = nudgeFor({}, "parentMessage");

    expect(settled).toMatch(/background task settled/i);
    expect(settled.toLowerCase()).toMatch(/inspect/);
    expect(failed).toMatch(/background task failed/i);
    expect(aborted).toMatch(/background task was aborted/i);
    expect(aborted.toLowerCase()).toMatch(/do not retry unless the user asks/);
    expect(aborted).not.toBe(failed);
    expect(parentMessage.toLowerCase()).toMatch(/live child/);
    expect(parentMessage.toLowerCase()).toMatch(/notification/);
    expect(parentMessage.toLowerCase()).toMatch(/no reply is required/);
    expect(parentMessage.toLowerCase()).toMatch(/has not settled/);
    expect(claimsChildSettled(parentMessage)).toBe(false);
  });
});

describe("nudgeFor precedence", () => {
  it("uses task-type policy and ignores agent completion_nudge", () => {
    for (const taskType of TASK_TYPES) {
      for (const event of NUDGE_EVENTS) {
        const withoutAgent = nudgeFor({ taskType }, event);
        const withAgent = nudgeFor({ taskType, completionNudge: AGENT_NUDGE }, event);

        expect(withAgent, `${taskType}/${event} ignored agent`).toBe(withoutAgent);
        expect(withAgent).not.toContain(AGENT_NUDGE);
        expect(withAgent.includes(withoutAgent) && withAgent.includes(AGENT_NUDGE)).toBe(false);
      }
    }

    const fixSettled = nudgeFor({ taskType: "fix", completionNudge: AGENT_NUDGE }, "settled");
    const reviewSettled = nudgeFor(
      { taskType: "reviewImplementation", completionNudge: AGENT_NUDGE },
      "settled",
    );
    expect(fixSettled).not.toBe(reviewSettled);
  });

  it("uses agent completion_nudge for settled and failed when taskType is absent", () => {
    expect(nudgeFor({ completionNudge: AGENT_NUDGE }, "settled")).toBe(AGENT_NUDGE);
    expect(nudgeFor({ completionNudge: AGENT_NUDGE }, "failed")).toBe(AGENT_NUDGE);
  });

  it("ignores agent completion_nudge on parentMessage and aborted", () => {
    const parentMessage = nudgeFor({ completionNudge: AGENT_NUDGE }, "parentMessage");
    const aborted = nudgeFor({ completionNudge: AGENT_NUDGE }, "aborted");

    expect(parentMessage).toBe(nudgeFor({}, "parentMessage"));
    expect(aborted).toBe(nudgeFor({}, "aborted"));
    expect(parentMessage).not.toContain(AGENT_NUDGE);
    expect(aborted).not.toContain(AGENT_NUDGE);
    expect(claimsChildSettled(parentMessage)).toBe(false);
    expect(aborted).not.toBe(nudgeFor({}, "failed"));
  });

  it("does not concatenate agent guidance onto task-type or generic text", () => {
    const typed = nudgeFor({ taskType: "implementation", completionNudge: AGENT_NUDGE }, "settled");
    const genericSettled = nudgeFor({}, "settled");
    const agentSettled = nudgeFor({ completionNudge: AGENT_NUDGE }, "settled");

    expect(typed).toBe(nudgeFor({ taskType: "implementation" }, "settled"));
    expect(typed.endsWith(AGENT_NUDGE)).toBe(false);
    expect(agentSettled).toBe(AGENT_NUDGE);
    expect(agentSettled.startsWith(genericSettled)).toBe(false);
    expect(`${genericSettled} ${AGENT_NUDGE}`).not.toBe(agentSettled);
  });

  it("treats blank agent completion_nudge as absent", () => {
    expect(nudgeFor({ completionNudge: "" }, "settled")).toBe(nudgeFor({}, "settled"));
    expect(nudgeFor({ completionNudge: "   " }, "failed")).toBe(nudgeFor({}, "failed"));
  });
});

it("falls back safely for hostile task and event runtime values", () => {
  const hostileTaskType = "x".repeat(10_000);
  expect(() => nudgeFor({ taskType: hostileTaskType }, "settled")).not.toThrow();
  expect(nudgeFor({ taskType: hostileTaskType }, "settled")).toContain("Inspect");
  expect(nudgeFor({ taskType: hostileTaskType }, "unknown-event")).toBe(
    "A background child changed state. Inspect the evidence and decide the next action.",
  );
  expect(nudgeFor({ taskType: { malformed: true } }, null)).toContain("changed state");
});
