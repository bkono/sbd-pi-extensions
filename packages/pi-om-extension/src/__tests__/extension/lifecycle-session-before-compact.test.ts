import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piObservationalMemory from "../../index.js";
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
  let mock: MockObservationAgents;
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
    const msgs = conversation(messageCount, { baseTs: 1_700_000_000_000 });
    return msgs.map((m, i) => ({
      type: "message" as const,
      id: `entry-${i}`,
      parentId: i === 0 ? null : `entry-${i - 1}`,
      timestamp: new Date((m as unknown as { timestamp: number }).timestamp).toISOString(),
      message: m,
    }));
  }

  it("returns custom compaction result with observation context baked in", async () => {
    mock = new MockObservationAgents({
      observeResponses: [{ observations: "* 🔴 compaction test", raw: "" }],
    });
    __installMockAgents(mock);

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });
    const branchEntries = buildBranchEntries(4);

    const event = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "entry-3",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 10_000,
        previousSummary: undefined,
        fileOps: {},
        settings: {},
      },
      branchEntries,
      signal: new AbortController().signal,
    };

    const result = (await harness.dispatch("session_before_compact", event, ctx)) as
      | { compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number } }
      | undefined;

    expect(result).toBeDefined();
    expect(result?.compaction).toBeDefined();
    expect(result!.compaction!.summary).toContain("<observational-memory>");
    expect(result!.compaction!.summary).toContain("<om-durable>");
    expect(result!.compaction!.summary).toContain("<observations>");
    expect(result!.compaction!.summary).toContain("compaction test");
    expect(result!.compaction!.summary).toContain("<om-guidance>");
    expect(result!.compaction!.summary).toContain("<system-reminder>");
    expect(result!.compaction!.firstKeptEntryId).toBe("entry-3");
    expect(result!.compaction!.tokensBefore).toBe(10_000);
  });

  it("includes previousSummary when present", async () => {
    mock = new MockObservationAgents({
      observeResponses: [{ observations: "* new obs", raw: "" }],
    });
    __installMockAgents(mock);

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const event = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "entry-3",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 10_000,
        previousSummary: "PREVIOUS_SUMMARY_MARKER",
        fileOps: {},
        settings: {},
      },
      branchEntries: buildBranchEntries(2),
      signal: new AbortController().signal,
    };

    const result = (await harness.dispatch("session_before_compact", event, ctx)) as {
      compaction: { summary: string };
    };

    expect(result.compaction.summary).toContain("PREVIOUS_SUMMARY_MARKER");
    expect(result.compaction.summary).toContain("new obs");
  });

  it("returns undefined when observer produces no observations", async () => {
    mock = new MockObservationAgents({
      observeResponses: [{ observations: "", raw: "" }],
    });
    __installMockAgents(mock);

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const event = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "entry-1",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 5_000,
        fileOps: {},
        settings: {},
      },
      branchEntries: buildBranchEntries(2),
      signal: new AbortController().signal,
    };

    const result = await harness.dispatch("session_before_compact", event, ctx);
    expect(result).toBeUndefined();
  });

  it("extracts only message entries from branchEntries (skips non-message types)", async () => {
    mock = new MockObservationAgents({
      observeResponses: [{ observations: "* obs", raw: "" }],
    });
    __installMockAgents(mock);

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const mixedEntries = [
      ...buildBranchEntries(2),
      {
        type: "model_change",
        id: "mc-1",
        parentId: "entry-1",
        timestamp: new Date().toISOString(),
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
      },
    ];

    const event = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "entry-1",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 5_000,
        fileOps: {},
        settings: {},
      },
      branchEntries: mixedEntries,
      signal: new AbortController().signal,
    };

    await harness.dispatch("session_before_compact", event, ctx);

    // Only 2 message entries should have been serialized (not 3)
    expect(mock.observeCalls).toHaveLength(1);
    expect(mock.observeCalls[0]!.serializedMessages.split("\n\n").length).toBe(2);
  });
});
