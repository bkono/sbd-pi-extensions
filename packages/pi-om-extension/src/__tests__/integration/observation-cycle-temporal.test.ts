import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ObservationAgents } from "../../agents.js";
import { runObservationCycle } from "../../engine.js";
import { loadSessionState } from "../../state.js";
import { assistantMsg, resetMessageCounter, userMsg } from "../helpers/fixtures.js";
import { MockObservationAgents } from "../helpers/mock-agents.js";
import {
  createTempStateDir,
  createTestConfig,
  type TempStateDir,
} from "../helpers/temp-state-dir.js";

function ts(value: string): number {
  return Date.parse(value);
}

describe("runObservationCycle — temporal regressions", () => {
  let temp: TempStateDir;
  const sessionId = "sess-temporal";

  beforeEach(() => {
    temp = createTempStateDir();
    resetMessageCounter();
  });

  afterEach(() => temp.cleanup());

  it("keeps stale references, elapsed gaps, and future state changes anchored across days", async () => {
    const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 1_000_000 });
    const dayOneObservations = `
Date: Apr 18, 2026
* 🔴 (09:00) User plans to resume tomorrow.
`.trim();
    const resumedObservations = `
Date: Apr 21, 2026
* 🟡 (10:15) User resumed work yesterday after a multi-day gap.
* 🟡 (10:16) Rollout now shifts next Friday.
* 🟡 (10:17) They may revisit Friday.
`.trim();
    const completedObservations = `
Date: Apr 25, 2026
* 🟢 (08:30) Rollout landed yesterday as planned.
`.trim();
    const mock = new MockObservationAgents({
      observeResponses: [
        { observations: dayOneObservations, raw: dayOneObservations },
        { observations: resumedObservations, raw: resumedObservations },
        { observations: completedObservations, raw: completedObservations },
      ],
    });
    const inflight = new Map<string, Promise<void>>();

    const dayOneMessages = [
      userMsg(
        "Started investigating the stale reference temporal regressions.",
        ts("2026-04-18T09:00:00.000Z"),
      ),
      assistantMsg(
        "Let us resume tomorrow once the first baseline is captured.",
        ts("2026-04-18T09:01:00.000Z"),
      ),
    ];

    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      dayOneMessages,
      inflight,
      {
        forceObserve: true,
        reason: "turn_end",
      },
    );

    expect(mock.observeCalls).toHaveLength(1);
    expect(mock.observeCalls[0]!.existingObservations).toBe("");

    let state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.observationEntries).toHaveLength(1);
    expect(state.observations).toContain("tomorrow (target: 2026-04-19)");

    const resumedMessages = [
      ...dayOneMessages,
      userMsg(
        "Back after a few days away; let us resume the regressions.",
        ts("2026-04-21T10:15:00.000Z"),
      ),
      assistantMsg("Okay, and the rollout now shifts next Friday.", ts("2026-04-21T10:16:00.000Z")),
    ];

    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      resumedMessages,
      inflight,
      {
        forceObserve: true,
        reason: "turn_end",
      },
    );

    expect(mock.observeCalls).toHaveLength(2);
    expect(mock.observeCalls[1]!.existingObservations).toContain("tomorrow (target: 2026-04-19)");
    expect(mock.observeCalls[1]!.serializedMessages).toContain(
      "Back after a few days away; let us resume the regressions.",
    );
    expect(mock.observeCalls[1]!.serializedMessages).not.toContain(
      "Started investigating the stale reference temporal regressions.",
    );

    state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.observationEntries).toHaveLength(4);
    expect(state.observations).toContain("Date: Apr 21, 2026");
    expect(state.observations).toContain("yesterday (date: 2026-04-20)");
    expect(state.observations).toContain("next Friday (target: 2026-04-24)");
    expect(state.observations).toContain("They may revisit Friday.");

    const completedMessages = [
      ...resumedMessages,
      userMsg(
        "The rollout landed yesterday, matching the earlier plan.",
        ts("2026-04-25T08:30:00.000Z"),
      ),
      assistantMsg("Great, that future change is now complete.", ts("2026-04-25T08:31:00.000Z")),
    ];

    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      completedMessages,
      inflight,
      {
        forceObserve: true,
        reason: "turn_end",
      },
    );

    expect(mock.observeCalls).toHaveLength(3);
    expect(mock.observeCalls[2]!.existingObservations).toContain(
      "next Friday (target: 2026-04-24)",
    );
    expect(mock.observeCalls[2]!.serializedMessages).toContain(
      "The rollout landed yesterday, matching the earlier plan.",
    );
    expect(mock.observeCalls[2]!.serializedMessages).not.toContain(
      "Back after a few days away; let us resume the regressions.",
    );

    state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.observationEntries).toHaveLength(5);
    expect(state.observations).toContain("Date: Apr 25, 2026");
    expect(state.observations).toContain("yesterday (date: 2026-04-24)");

    const plannedChange = state.observations.indexOf("next Friday (target: 2026-04-24)");
    const completedChange = state.observations.indexOf("yesterday (date: 2026-04-24)");
    expect(plannedChange).toBeGreaterThanOrEqual(0);
    expect(completedChange).toBeGreaterThan(plannedChange);
  });
});
