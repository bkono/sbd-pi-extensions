import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ObservationAgents } from "../../agents.js";
import { runObservationCycle } from "../../engine.js";
import { loadSessionState } from "../../state.js";
import { conversation, resetMessageCounter, toolResultMsg, userMsg } from "../helpers/fixtures.js";
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

  it("observes when message-count heuristic trips before token threshold", async () => {
    const config = createTestConfig({
      stateDir: temp.stateDir,
      observationTokens: 1_000_000,
      stagingMessageCount: 4,
      publishMessageCount: 4,
    });
    const mock = new MockObservationAgents({
      observeResponses: [{ observations: "* 🟡 count heuristic", raw: "* 🟡 count heuristic" }],
    });
    const msgs = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 5 });

    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      msgs,
      new Map<string, Promise<void>>(),
      { reason: "turn_end" },
    );

    expect(mock.observeCalls).toHaveLength(1);
    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.observations).toContain("count heuristic");
  });

  it("observes when tool-result weight trips before total token threshold", async () => {
    const config = createTestConfig({
      stateDir: temp.stateDir,
      observationTokens: 1_000_000,
      stagingToolResultTokens: 50,
      publishToolResultTokens: 50,
    });
    const mock = new MockObservationAgents({
      observeResponses: [{ observations: "* 🔴 tool-heavy", raw: "* 🔴 tool-heavy" }],
    });
    const msgs = [
      userMsg("run a check", 1_700_000_000_000),
      toolResultMsg("read", "x".repeat(400), 1_700_000_001_000),
    ];

    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      msgs,
      new Map<string, Promise<void>>(),
      { reason: "turn_end" },
    );

    expect(mock.observeCalls).toHaveLength(1);
    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.observations).toContain("tool-heavy");
  });

  it("splits long observation work into smaller chunks", async () => {
    const config = createTestConfig({
      stateDir: temp.stateDir,
      observationTokens: 1_000_000,
      stagingMessageCount: 3,
      publishMessageCount: 3,
      maxChunkMessages: 2,
    });
    const mock = new MockObservationAgents({
      observeResponses: [
        { observations: "* first chunk", raw: "* first chunk" },
        { observations: "* second chunk", raw: "* second chunk" },
        { observations: "* third chunk", raw: "* third chunk" },
      ],
    });
    const msgs = conversation(5, { baseTs: 1_700_000_000_000, contentSize: 20 });

    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      msgs,
      new Map<string, Promise<void>>(),
      { reason: "turn_end" },
    );

    expect(mock.observeCalls).toHaveLength(3);
    expect(mock.observeCalls[0]!.serializedMessages).toContain("user-0:");
    expect(mock.observeCalls[0]!.serializedMessages).not.toContain("user-2:");
    expect(mock.observeCalls[1]!.serializedMessages).toContain("user-2:");
    expect(mock.observeCalls[2]!.serializedMessages).toContain("user-4:");

    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.observations).toContain("first chunk");
    expect(state.observations).toContain("second chunk");
    expect(state.observations).toContain("third chunk");
    expect(state.lastObservedTimestamp).toBe(1_700_000_000_000 + 4 * 1000);
  });

  it("renders structured observation entries into durable published observations", async () => {
    const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 50 });
    const mock = new MockObservationAgents({
      observeResponses: [
        {
          observations: "",
          raw: "",
          observationEntries: [
            {
              date: "2026-04-18",
              line: "* 🔴 (21:13) User plans to revisit reflection robustness tomorrow.",
              temporalAnchors: [
                {
                  recordedAt: "2026-04-18T21:13:00.000Z",
                  originalPhrase: "tomorrow",
                  referencedStart: "2026-04-19",
                  precision: "day",
                  relation: "future",
                },
              ],
            },
            {
              date: "2026-04-18",
              line: "* 🟡 (09:42) Error pattern appears to have started last week.",
              temporalAnchors: [
                {
                  recordedAt: "2026-04-18T09:42:00.000Z",
                  originalPhrase: "last week",
                  referencedStart: "2026-04-06",
                  precision: "week",
                  relation: "past",
                },
              ],
            },
          ],
        },
      ],
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

    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.observations).toContain("Date: Apr 18, 2026");
    expect(state.observations).toContain("tomorrow (target: 2026-04-19)");
    expect(state.observations).toContain("last week (week of 2026-04-06)");
    expect(state.observationEntries).toHaveLength(2);
  });

  it("derives temporal anchors from text-only observer output before publishing", async () => {
    const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 50 });
    const observations = `
Date: Apr 18, 2026
* 🔴 (21:13) User plans to revisit reflection robustness tomorrow.
* 🟡 (09:44) Rollout moves next week.
* 🟢 (09:45) They might revisit Friday.
`.trim();
    const mock = new MockObservationAgents({
      observeResponses: [{ observations, raw: observations }],
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

    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.observationEntries).toHaveLength(3);
    expect(state.observations).toContain("tomorrow (target: 2026-04-19)");
    expect(state.observations).toContain("next week (approx: 2026-04-20..2026-04-26)");
    expect(state.observations).toContain("They might revisit Friday.");
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
