import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ObservationAgents } from "../../agents.js";
import { runObservationCycle } from "../../engine.js";
import { loadSessionState } from "../../state.js";
import { conversation, resetMessageCounter } from "../helpers/fixtures.js";
import { MockObservationAgents } from "../helpers/mock-agents.js";
import {
  createTempStateDir,
  createTestConfig,
  type TempStateDir,
} from "../helpers/temp-state-dir.js";

describe("runObservationCycle — reflection cascade", () => {
  let temp: TempStateDir;
  const sessionId = "sess-reflect";

  beforeEach(() => {
    temp = createTempStateDir();
    resetMessageCounter();
  });
  afterEach(() => temp.cleanup());

  it("does not reflect when observation tokens stay below threshold", async () => {
    const config = createTestConfig({
      stateDir: temp.stateDir,
      observationTokens: 50,
      reflectionTokens: 1_000_000,
    });
    const mock = new MockObservationAgents({
      observeResponses: [{ observations: "* short obs", raw: "" }],
    });
    const msgs = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 200 });

    const inflight = new Map<string, Promise<void>>();
    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      msgs,
      inflight,
      {
        reason: "turn_end",
      },
    );

    expect(mock.reflectCalls).toHaveLength(0);
    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.reflectTriggered).toBe(false);
  });

  it("triggers reflection when observation tokens exceed threshold", async () => {
    const config = createTestConfig({
      stateDir: temp.stateDir,
      observationTokens: 50,
      reflectionTokens: 5, // tiny threshold — any observation triggers reflection
    });
    const bigObs = `* 🔴 ${"x".repeat(500)}`;
    const mock = new MockObservationAgents({
      observeResponses: [{ observations: bigObs, raw: bigObs }],
      reflectResponses: [{ observations: "* 🔴 consolidated", raw: "* 🔴 consolidated" }],
    });
    const msgs = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 200 });

    const inflight = new Map<string, Promise<void>>();
    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      msgs,
      inflight,
      {
        reason: "turn_end",
      },
    );

    expect(mock.reflectCalls).toHaveLength(1);
    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.reflectTriggered).toBe(true);
    expect(state.observations).toContain("🔴 consolidated");
    expect(state.observations).not.toContain("x".repeat(100));
  });

  it("reflector returning empty observations retains pre-reflection value", async () => {
    const config = createTestConfig({
      stateDir: temp.stateDir,
      observationTokens: 50,
      reflectionTokens: 5,
    });
    const bigObs = "* 🔴 pre-reflect content";
    const mock = new MockObservationAgents({
      observeResponses: [{ observations: bigObs, raw: bigObs }],
      reflectResponses: [{ observations: "", raw: "" }],
    });
    const msgs = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 200 });

    const inflight = new Map<string, Promise<void>>();
    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      msgs,
      inflight,
      {
        reason: "turn_end",
      },
    );

    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.observations).toContain("pre-reflect content");
    expect(state.reflectTriggered).toBe(true);
  });

  it("reflector sets currentTask — propagates to state", async () => {
    const config = createTestConfig({
      stateDir: temp.stateDir,
      observationTokens: 50,
      reflectionTokens: 5,
    });
    const mock = new MockObservationAgents({
      observeResponses: [
        { observations: "* 🔴 obs from observer", raw: "", currentTask: "observer task" },
      ],
      reflectResponses: [
        {
          observations: "* 🔴 reflected",
          raw: "",
          currentTask: "reflector task",
          suggestedResponse: "reflector suggestion",
        },
      ],
    });
    const msgs = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 200 });

    const inflight = new Map<string, Promise<void>>();
    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      msgs,
      inflight,
      {
        reason: "turn_end",
      },
    );

    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.currentTask).toBe("reflector task");
    expect(state.suggestedResponse).toBe("reflector suggestion");
  });

  it("reflector not returning currentTask keeps observer's value", async () => {
    const config = createTestConfig({
      stateDir: temp.stateDir,
      observationTokens: 50,
      reflectionTokens: 5,
    });
    const mock = new MockObservationAgents({
      observeResponses: [{ observations: "* 🔴 big", raw: "", currentTask: "observer task" }],
      reflectResponses: [{ observations: "* 🔴 consolidated", raw: "" }],
    });
    const msgs = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 200 });

    const inflight = new Map<string, Promise<void>>();
    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      msgs,
      inflight,
      {
        reason: "turn_end",
      },
    );

    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.currentTask).toBe("observer task");
  });
});
