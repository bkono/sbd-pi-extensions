import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ObservationAgents } from "../../agents.js";
import { runObservationCycle } from "../../engine.js";
import { loadSessionState, saveSessionState } from "../../state.js";
import { conversation, messageId, resetMessageCounter } from "../helpers/fixtures.js";
import { MockObservationAgents } from "../helpers/mock-agents.js";
import {
  createTempStateDir,
  createTestConfig,
  type TempStateDir,
} from "../helpers/temp-state-dir.js";

describe("runObservationCycle — staged draft state", () => {
  let temp: TempStateDir;
  const sessionId = "sess-draft";

  beforeEach(() => {
    temp = createTempStateDir();
    resetMessageCounter();
  });

  afterEach(() => {
    temp.cleanup();
  });

  it("stages observations without mutating published state when publishDraft=false", async () => {
    const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 50 });
    const mock = new MockObservationAgents({
      observeResponses: [
        {
          observations: "* 🔴 staged observation",
          raw: "",
          currentTask: "draft task",
          suggestedResponse: "draft response",
        },
      ],
    });
    const msgs = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 200 });

    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      msgs,
      new Map<string, Promise<void>>(),
      {
        publishDraft: false,
        reason: "turn_end",
      },
    );

    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.observations).toBe("");
    expect(state.observationTokens).toBe(0);
    expect(state.currentTask).toBeUndefined();
    expect(state.suggestedResponse).toBeUndefined();
    expect(state.lastObservedEntryId).toBeUndefined();

    expect(state.draftObservations).toContain("staged observation");
    expect(state.draftObservationTokens).toBeGreaterThan(0);
    expect(state.draftCurrentTask).toBe("draft task");
    expect(state.draftSuggestedResponse).toBe("draft response");
    expect(state.draftLastObservedEntryId).toBe(messageId(msgs[3]!));
    expect(state.draftLastObservedTimestamp).toBe(1_700_000_000_000 + 3 * 1000);
  });

  it("continues staging from the staged cursor and existing staged observations", async () => {
    const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 50 });
    const mock = new MockObservationAgents({
      observeResponses: [
        { observations: "* first staged observation", raw: "" },
        { observations: "* second staged observation", raw: "" },
      ],
    });

    const inflight = new Map<string, Promise<void>>();
    const turn1Msgs = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 200 });
    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      turn1Msgs,
      inflight,
      {
        publishDraft: false,
        reason: "turn_end",
      },
    );

    resetMessageCounter();
    const allMsgs = conversation(6, { baseTs: 1_700_000_000_000, contentSize: 200 });
    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      allMsgs,
      inflight,
      {
        publishDraft: false,
        reason: "turn_end",
      },
    );

    expect(mock.observeCalls).toHaveLength(2);
    expect(mock.observeCalls[1]!.existingObservations).toContain("first staged observation");
    expect(mock.observeCalls[1]!.serializedMessages).toContain("user-4:");
    expect(mock.observeCalls[1]!.serializedMessages).not.toContain("user-0:");

    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.observations).toBe("");
    expect(state.draftObservations).toContain("first staged observation");
    expect(state.draftObservations).toContain("second staged observation");
    expect(state.lastObservedEntryId).toBeUndefined();
    expect(state.draftLastObservedEntryId).toBe(messageId(allMsgs[5]!));
  });

  it("publishes an already-staged draft even when there are no new messages to observe", async () => {
    const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 50 });
    const msgs = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 200 });
    const lastId = messageId(msgs[3]!);
    const lastTimestamp = 1_700_000_000_000 + 3 * 1000;

    await saveSessionState(temp.stateDir, {
      sessionId,
      observations: "",
      observationTokens: 0,
      draftObservations: "* staged only",
      draftObservationTokens: 9,
      draftLastObservedEntryId: lastId,
      draftLastObservedTimestamp: lastTimestamp,
      draftCurrentTask: "publish me",
      draftSuggestedResponse: "next turn",
      updatedAt: 0,
    });

    const mock = new MockObservationAgents();
    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      msgs,
      new Map<string, Promise<void>>(),
      {
        publishDraft: true,
        reason: "turn_end",
      },
    );

    expect(mock.observeCalls).toHaveLength(0);

    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.observations).toBe("* staged only");
    expect(state.observationTokens).toBe(9);
    expect(state.lastObservedEntryId).toBe(lastId);
    expect(state.lastObservedTimestamp).toBe(lastTimestamp);
    expect(state.currentTask).toBe("publish me");
    expect(state.suggestedResponse).toBe("next turn");
  });
});
