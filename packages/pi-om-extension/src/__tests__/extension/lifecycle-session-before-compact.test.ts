import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStatePath } from "../../config.js";
import piObservationalMemory from "../../index.js";
import { loadSessionState } from "../../state.js";
import {
  createExtensionTestHarness,
  createFakeExtensionContext,
} from "../helpers/extension-harness.js";
import { conversation, resetMessageCounter } from "../helpers/fixtures.js";
import { MockObservationAgents } from "../helpers/mock-agents.js";
import { __clearMockAgents, __installMockAgents } from "../helpers/mock-agents-module.js";
import { createTempStateDir, type TempStateDir } from "../helpers/temp-state-dir.js";

vi.mock("../../agents.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents.js")>("../../agents.js");
  const mod = await import("../helpers/mock-agents-module.js");
  return { ...actual, ObservationAgents: mod.ObservationAgents };
});

describe("extension: session_before_compact lifecycle", () => {
  let temp: TempStateDir;
  const sessionId = "test-before-compact";

  beforeEach(() => {
    temp = createTempStateDir();
    resetMessageCounter();
  });

  afterEach(() => {
    __clearMockAgents();
    temp.cleanup();
  });

  function buildBranchEntries(messageCount: number) {
    const messages = conversation(messageCount, { baseTs: 1_700_000_000_000 });
    return messages.map((message, index) => ({
      type: "message" as const,
      id: `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      timestamp: new Date((message as unknown as { timestamp: number }).timestamp).toISOString(),
      message,
    }));
  }

  function buildEvent(branchEntries: unknown[]) {
    return {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "entry-1",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 190_000,
        previousSummary: "A prior Pi summary that must be updated by Pi.",
        fileOps: {},
        settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      },
      branchEntries,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    };
  }

  function preloadState(state: Record<string, unknown>): void {
    const stateDir = `${temp.stateDir}/.pi/om-state`;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      sessionStatePath(stateDir, sessionId),
      JSON.stringify({
        sessionId,
        observations: "",
        observationTokens: 0,
        draftObservations: "",
        draftObservationTokens: 0,
        updatedAt: Date.now(),
        ...state,
      }),
    );
  }

  it("force-observes and publishes before letting Pi perform compaction", async () => {
    const mock = new MockObservationAgents({
      observeResponses: [{ observations: "* latest compacting observation", raw: "" }],
    });
    __installMockAgents(mock);

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const result = await harness.dispatch(
      "session_before_compact",
      buildEvent(buildBranchEntries(4)),
      createFakeExtensionContext({ cwd: temp.stateDir, sessionId }),
    );

    expect(result).toBeUndefined();
    expect(mock.observeCalls).toHaveLength(1);

    const state = await loadSessionState(`${temp.stateDir}/.pi/om-state`, sessionId);
    expect(state.observations).toContain("latest compacting observation");
    expect(state.lastCycleReason).toBe("compacting");
    expect(state.publishTriggered).toBe(true);
  });

  it("returns undefined when stale published observations already exist and observation fails", async () => {
    preloadState({
      observations: "* stale published observation",
      observationTokens: 4,
      draftObservations: "* stale published observation",
      draftObservationTokens: 4,
    });
    const mock = new MockObservationAgents({ observeError: new Error("observer auth failed") });
    __installMockAgents(mock);

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const result = await harness.dispatch(
      "session_before_compact",
      buildEvent(buildBranchEntries(2)),
      createFakeExtensionContext({ cwd: temp.stateDir, sessionId }),
    );

    expect(result).toBeUndefined();
    expect(mock.observeCalls).toHaveLength(1);
  });

  it("skips observation while paused and still lets Pi perform compaction", async () => {
    preloadState({
      observations: "* existing observation",
      observationTokens: 3,
      draftObservations: "* existing observation",
      draftObservationTokens: 3,
      paused: true,
    });
    const mock = new MockObservationAgents();
    __installMockAgents(mock);

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const result = await harness.dispatch(
      "session_before_compact",
      buildEvent(buildBranchEntries(2)),
      createFakeExtensionContext({ cwd: temp.stateDir, sessionId }),
    );

    expect(result).toBeUndefined();
    expect(mock.observeCalls).toHaveLength(0);
  });

  it("extracts only message entries from branchEntries", async () => {
    const mock = new MockObservationAgents({
      observeResponses: [{ observations: "* observation", raw: "" }],
    });
    __installMockAgents(mock);

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const branchEntries = [
      ...buildBranchEntries(2),
      {
        type: "model_change",
        id: "model-change-1",
        parentId: "entry-1",
        timestamp: new Date().toISOString(),
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
      },
    ];

    const result = await harness.dispatch(
      "session_before_compact",
      buildEvent(branchEntries),
      createFakeExtensionContext({ cwd: temp.stateDir, sessionId }),
    );

    expect(result).toBeUndefined();
    expect(mock.observeCalls).toHaveLength(1);
    expect(mock.observeCalls[0]!.serializedMessages.split("\n\n")).toHaveLength(2);
  });
});
