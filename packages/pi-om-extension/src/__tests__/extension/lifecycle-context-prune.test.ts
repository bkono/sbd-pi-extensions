import { mkdirSync, writeFileSync } from "node:fs";
import type { Message } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStatePath } from "../../config.js";
import piObservationalMemory from "../../index.js";
import { loadSessionState } from "../../state.js";
import {
  createExtensionTestHarness,
  createFakeExtensionContext,
} from "../helpers/extension-harness.js";
import { conversation, messageId, resetMessageCounter } from "../helpers/fixtures.js";
import { MockObservationAgents } from "../helpers/mock-agents.js";
import { __clearMockAgents, __installMockAgents } from "../helpers/mock-agents-module.js";
import { createTempStateDir, type TempStateDir } from "../helpers/temp-state-dir.js";

vi.mock("../../agents.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents.js")>("../../agents.js");
  const mod = await import("../helpers/mock-agents-module.js");
  return { ...actual, ObservationAgents: mod.ObservationAgents };
});

describe("extension: context lifecycle (message pruning)", () => {
  let temp: TempStateDir;
  let mock: MockObservationAgents;
  const sessionId = "test-context-prune";

  beforeEach(() => {
    temp = createTempStateDir();
    mock = new MockObservationAgents();
    __installMockAgents(mock);
    resetMessageCounter();
  });

  afterEach(() => {
    __clearMockAgents();
    temp.cleanup();
  });

  function preloadState(state: Record<string, unknown>) {
    const stateDir = `${temp.stateDir}/.pi/om-state`;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      sessionStatePath(stateDir, sessionId),
      JSON.stringify({
        sessionId,
        observations: "",
        observationTokens: 0,
        updatedAt: Date.now(),
        ...state,
      }),
    );
  }

  function asBranchEntries(messages: Message[]): Array<{
    type: "message";
    id: string;
    parentId: string | null;
    timestamp: string;
    message: Message;
  }> {
    return messages.map((message, i) => ({
      type: "message" as const,
      id: `entry-${i}`,
      parentId: i === 0 ? null : `entry-${i - 1}`,
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      message,
    }));
  }

  it("returns all messages when no cursor is set", async () => {
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });
    const msgs = conversation(3, { baseTs: 1_700_000_000_000 });

    const result = (await harness.dispatch(
      "context",
      { type: "context", messages: msgs },
      ctx,
    )) as { messages: Message[] };

    expect(result.messages).toHaveLength(3);
  });

  it("returns only messages after the cursor when id cursor is set", async () => {
    const msgs = conversation(5, { baseTs: 1_700_000_000_000 });
    const cursorId = messageId(msgs[1]!)!;
    preloadState({ lastObservedEntryId: cursorId, lastObservedTimestamp: 1_700_000_001_000 });

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = (await harness.dispatch(
      "context",
      { type: "context", messages: msgs },
      ctx,
    )) as { messages: Message[] };

    expect(result.messages).toHaveLength(3); // msgs 2, 3, 4
  });

  it("never returns an empty array — falls back to latest message", async () => {
    const msgs = conversation(3, { baseTs: 1_700_000_000_000 });
    const lastId = messageId(msgs[2]!)!;
    const lastTs = 1_700_000_000_000 + 2 * 1000;
    preloadState({ lastObservedEntryId: lastId, lastObservedTimestamp: lastTs });

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = (await harness.dispatch(
      "context",
      { type: "context", messages: msgs },
      ctx,
    )) as { messages: Message[] };

    expect(result.messages.length).toBeGreaterThanOrEqual(1);
  });

  it("saves pruning metrics to state", async () => {
    const msgs = conversation(5, { baseTs: 1_700_000_000_000 });
    const cursorId = messageId(msgs[1]!)!;
    preloadState({ lastObservedEntryId: cursorId, lastObservedTimestamp: 1_700_000_001_000 });

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    await harness.dispatch("context", { type: "context", messages: msgs }, ctx);

    const state = await loadSessionState(`${temp.stateDir}/.pi/om-state`, sessionId);
    expect(state.tailEntriesBeforePrune).toBe(5);
    expect(state.tailEntriesAfterPrune).toBe(3);
    expect(state.prunedEntriesCount).toBe(2);
    expect(state.lastCycleReason).toBe("context");
  });

  it("stages observations during context events without publishing them", async () => {
    const originalEnv = process.env.OM_OBSERVATION_STAGE_MESSAGE_TOKENS;
    process.env.OM_OBSERVATION_STAGE_MESSAGE_TOKENS = "50";

    try {
      mock = new MockObservationAgents({
        observeResponses: [{ observations: "* 🔴 staged in context", raw: "" }],
      });
      __installMockAgents(mock);

      const msgs = conversation(6, { baseTs: 1_700_000_000_000, contentSize: 200 });
      preloadState({
        observations: "* published",
        observationTokens: 10,
        lastObservedEntryId: messageId(msgs[1]!),
        lastObservedTimestamp: 1_700_000_000_000 + 1000,
      });
      const harness = await createExtensionTestHarness(piObservationalMemory);
      const ctx = createFakeExtensionContext({
        cwd: temp.stateDir,
        sessionId,
        entries: asBranchEntries(msgs),
      });

      const result = (await harness.dispatch(
        "context",
        { type: "context", messages: msgs },
        ctx,
      )) as { messages: Message[] };

      expect(mock.observeCalls).toHaveLength(1);
      expect(mock.observeCalls[0]!.serializedMessages).toContain("user-2:");
      expect(mock.observeCalls[0]!.serializedMessages).toContain("user-4:");
      expect(mock.observeCalls[0]!.serializedMessages).not.toContain("assistant-5:");

      const state = await loadSessionState(`${temp.stateDir}/.pi/om-state`, sessionId);
      expect(state.observations).toBe("* published");
      expect(state.lastObservedEntryId).toBe(messageId(msgs[1]!));
      expect(state.draftObservations).toContain("staged in context");
      expect(state.draftLastObservedEntryId).toBe(messageId(msgs[4]!));
      expect(result.messages).toHaveLength(4);
    } finally {
      if (originalEnv === undefined) delete process.env.OM_OBSERVATION_STAGE_MESSAGE_TOKENS;
      else process.env.OM_OBSERVATION_STAGE_MESSAGE_TOKENS = originalEnv;
    }
  });

  it("does NOT advance the cursor", async () => {
    const msgs = conversation(5, { baseTs: 1_700_000_000_000 });
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    await harness.dispatch("context", { type: "context", messages: msgs }, ctx);

    const state = await loadSessionState(`${temp.stateDir}/.pi/om-state`, sessionId);
    expect(state.lastObservedEntryId).toBeUndefined();
    expect(state.lastObservedTimestamp).toBeUndefined();
  });
});
