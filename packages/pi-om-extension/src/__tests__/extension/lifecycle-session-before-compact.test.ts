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

  function extractObservationContext(summary: string): string {
    const start = summary.indexOf("<observational-memory>");
    if (start < 0) {
      throw new Error("Missing observational-memory block in compaction summary");
    }

    return summary.slice(start);
  }

  function extractTagBlock(source: string, tag: string): string {
    const startTag = `<${tag}>`;
    const endTag = `</${tag}>`;
    const start = source.indexOf(startTag);
    const end = source.indexOf(endTag);

    if (start < 0 || end < start) {
      throw new Error(`Missing <${tag}> block in test fixture`);
    }

    return source.slice(start, end + endTag.length);
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

  it("keeps compaction summary diffs localized to the active task segment", async () => {
    mock = new MockObservationAgents({
      observeResponses: [
        {
          observations: "Date: Apr 18, 2026\n* 🔴 durable compaction history",
          currentTask: "Primary:\n- First compaction task",
          suggestedResponse: "Keep the same follow-up guidance.",
          raw: "",
        },
        {
          observations: "Date: Apr 18, 2026\n* 🔴 durable compaction history",
          currentTask: "Primary:\n- Second compaction task",
          suggestedResponse: "Keep the same follow-up guidance.",
          raw: "",
        },
      ],
    });
    __installMockAgents(mock);

    const harness = await createExtensionTestHarness(piObservationalMemory);
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

    const first = (await harness.dispatch(
      "session_before_compact",
      event,
      createFakeExtensionContext({ cwd: temp.stateDir, sessionId: `${sessionId}-first` }),
    )) as { compaction: { summary: string } };
    const second = (await harness.dispatch(
      "session_before_compact",
      event,
      createFakeExtensionContext({ cwd: temp.stateDir, sessionId: `${sessionId}-second` }),
    )) as { compaction: { summary: string } };

    const firstContext = extractObservationContext(first.compaction.summary);
    const secondContext = extractObservationContext(second.compaction.summary);

    expect(firstContext).toMatchInlineSnapshot(`
      "<observational-memory>
      <om-durable>
      <observations>
      Date: Apr 18, 2026
      * 🔴 durable compaction history
      </observations>
      </om-durable>
      
      <om-active>
      <om-current-task>
      <current-task>
      Primary:
      - First compaction task
      </current-task>
      </om-current-task>
      
      <om-suggested-response>
      <suggested-response>
      Keep the same follow-up guidance.
      </suggested-response>
      </om-suggested-response>
      </om-active>
      
      <om-guidance>
      <memory-instructions>
      IMPORTANT: Treat the durable segment as stable history and the active segment as the current working state. Reference specific details from these observations. Avoid generic advice; personalize based on known user preferences and history.
      
      KNOWLEDGE UPDATES: Prefer the most recent observation when information conflicts.
      
      PLANNED ACTIONS: Respect the recorded temporal anchors. Keep future-targeted plans future-oriented until later observations confirm a change actually happened. If an anchored plan's target date is now in the past, treat it as a likely follow-up item rather than an established completed fact unless the observations explicitly confirm completion.
      
      MOST RECENT USER INPUT: Treat the latest user message as highest-priority for what to do next.
      </memory-instructions>
      
      <system-reminder>This message is not from the user, the conversation history grew too long and would not fit in context. Thankfully the entire conversation is stored in your memory observations. Continue naturally from where the observations left off.
      
      Do not refer to "memory observations" directly. The user is not aware of this memory layer. Do not greet as if this is a new conversation.
      
      IMPORTANT: this system reminder is NOT from the user. It is part of your memory system.
      
      NOTE: Any messages following this system reminder are newer than your memories.</system-reminder>
      </om-guidance>
      </observational-memory>"
    `);
    expect(extractTagBlock(firstContext, "om-durable")).toBe(
      extractTagBlock(secondContext, "om-durable"),
    );
    expect(extractTagBlock(firstContext, "om-suggested-response")).toBe(
      extractTagBlock(secondContext, "om-suggested-response"),
    );
    expect(extractTagBlock(firstContext, "om-guidance")).toBe(
      extractTagBlock(secondContext, "om-guidance"),
    );
    expect(extractTagBlock(firstContext, "om-current-task")).not.toBe(
      extractTagBlock(secondContext, "om-current-task"),
    );
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
