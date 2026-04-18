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

describe("runObservationCycle — threshold behavior", () => {
  let temp: TempStateDir;
  const sessionId = "sess-thresh";

  beforeEach(() => {
    temp = createTempStateDir();
    resetMessageCounter();
  });
  afterEach(() => temp.cleanup());

  it("does not observe when unobserved tokens are below threshold", async () => {
    const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 1_000_000 });
    const mock = new MockObservationAgents();
    const msgs = conversation(4, { baseTs: 1_700_000_000_000 });

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

    expect(mock.observeCalls).toHaveLength(0);

    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.observeTriggered).toBe(false);
    expect(state.lastCycleReason).toBe("turn_end");
  });

  it("observes when unobserved tokens are at or above threshold", async () => {
    const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 50 });
    const mock = new MockObservationAgents({
      observeResponses: [{ observations: "* 🔴 seen it", raw: "* 🔴 seen it" }],
    });
    const msgs = conversation(6, { baseTs: 1_700_000_000_000, contentSize: 200 });

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

    expect(mock.observeCalls).toHaveLength(1);
    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.observations).toContain("🔴 seen it");
    expect(state.observationTokens).toBeGreaterThan(0);
    expect(state.observeTriggered).toBe(true);
    expect(state.lastObservedTimestamp).toBeDefined();
  });

  it("can stage observations without publishing when the publish threshold is higher", async () => {
    const config = createTestConfig({
      stateDir: temp.stateDir,
      stagingTokens: 50,
      publishTokens: 1_000_000,
    });
    const mock = new MockObservationAgents({
      observeResponses: [{ observations: "* 🔴 staged only", raw: "* 🔴 staged only" }],
    });
    const msgs = conversation(6, { baseTs: 1_700_000_000_000, contentSize: 200 });

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

    expect(mock.observeCalls).toHaveLength(1);
    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.observations).toBe("");
    expect(state.draftObservations).toContain("staged only");
    expect(state.observeTriggered).toBe(true);
    expect(state.publishTriggered).toBe(false);
  });

  it("forceObserve: true triggers observation even below threshold", async () => {
    const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 1_000_000 });
    const mock = new MockObservationAgents({
      observeResponses: [{ observations: "* 🟡 forced", raw: "* 🟡 forced" }],
    });
    const msgs = conversation(2, { baseTs: 1_700_000_000_000 });

    const inflight = new Map<string, Promise<void>>();
    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      msgs,
      inflight,
      {
        forceObserve: true,
        reason: "compacting",
      },
    );

    expect(mock.observeCalls).toHaveLength(1);
    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.observations).toContain("🟡 forced");
    expect(state.lastCycleReason).toBe("compacting");
  });

  it("excludeLatestMessage prevents the final message from being observed", async () => {
    const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 50 });
    const mock = new MockObservationAgents({
      observeResponses: [{ observations: "* obs", raw: "* obs" }],
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
        excludeLatestMessage: true,
        reason: "turn_end",
      },
    );

    expect(mock.observeCalls).toHaveLength(1);
    const serialized = mock.observeCalls[0]!.serializedMessages;
    // Last message content should NOT be in the serialized observer input
    const lastMsgContent = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 200 })[3];
    expect(serialized).not.toContain((lastMsgContent as unknown as { content: string }).content);
  });

  it("empty message list saves cycle metadata but does not observe", async () => {
    const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 50 });
    const mock = new MockObservationAgents();

    const inflight = new Map<string, Promise<void>>();
    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      [],
      inflight,
      {
        reason: "turn_end",
      },
    );

    expect(mock.observeCalls).toHaveLength(0);
    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.lastCycleReason).toBe("turn_end");
    expect(state.observeTriggered).toBe(false);
  });

  it("skips state save for context reason when nothing to observe", async () => {
    // When reason is "context" and no observation happens, state is NOT written
    // (the context handler will write its own state with pruning metrics)
    const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 1_000_000 });
    const mock = new MockObservationAgents();
    const msgs = conversation(2, { baseTs: 1_700_000_000_000 });

    const inflight = new Map<string, Promise<void>>();
    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      msgs,
      inflight,
      {
        reason: "context",
      },
    );

    // State file should be default (not written by this cycle)
    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.lastCycleReason).toBeUndefined();
  });
});
