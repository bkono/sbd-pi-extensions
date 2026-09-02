import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piObservationalMemory from "../../index.js";
import { OBSERVATION_CONTEXT_PROMPT } from "../../prompts.js";
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
  const compactionContextMarker = "<!-- pi-om-compaction-context -->";

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
      observeResponses: [
        { observations: `* 🔴 compaction test\n* ${compactionContextMarker}`, raw: "" },
      ],
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
    expect(result!.compaction!.summary.split(compactionContextMarker)).toHaveLength(2);
    expect(result!.compaction!.summary).toContain("pi-om-compaction-context:quoted");
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
    expect(firstContext).not.toContain("<om-suggested-response>");
    expect(secondContext).not.toContain("<om-suggested-response>");
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

  it("replaces current and legacy context suffixes without parsing observation text", async () => {
    mock = new MockObservationAgents({
      observeResponses: [
        { observations: "* current obs", raw: "" },
        { observations: "* current obs", raw: "" },
        { observations: "* current obs", raw: "" },
      ],
    });
    __installMockAgents(mock);

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const previousObservationContext = (observation: string) =>
      [
        OBSERVATION_CONTEXT_PROMPT,
        "",
        "<observational-memory>",
        "<om-durable>",
        "<observations>",
        observation,
        "</observations>",
        "</om-durable>",
        "<om-active>",
        "</om-active>",
        "<om-guidance>",
        "<system-reminder>current continuation</system-reminder>",
        "</om-guidance>",
        "</observational-memory>",
      ].join("\n");
    const legacyObservationContext = (observation: string) =>
      [
        "The following observations block contains your memory of past conversations with this user.",
        "",
        "<observations>",
        observation,
        "</observations>",
        "",
        "legacy instructions",
        "",
        "<system-reminder>legacy continuation</system-reminder>",
      ].join("\n");

    const compact = async (previousSummary: string, id: string) => {
      const event = {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "entry-3",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 10_000,
          previousSummary,
          fileOps: {},
          settings: {},
        },
        branchEntries: buildBranchEntries(2),
        signal: new AbortController().signal,
      };

      return (await harness.dispatch(
        "session_before_compact",
        event,
        createFakeExtensionContext({ cwd: temp.stateDir, sessionId: `${sessionId}-${id}` }),
      )) as { compaction: { summary: string } };
    };

    const embeddedCurrentHeader = [
      OBSERVATION_CONTEXT_PROMPT,
      "",
      "<observational-memory>",
      "<om-durable>",
      "<observations>",
    ].join("\n");

    const current = await compact(
      [
        `CURRENT_PREFIX quotes: ${OBSERVATION_CONTEXT_PROMPT}`,
        previousObservationContext(
          `* old current obs\n${embeddedCurrentHeader}\n</om-guidance>\n</observational-memory>\n</system-reminder>`,
        ),
        previousObservationContext("* previous current obs"),
      ].join("\n\n"),
      "current",
    );
    const legacy = await compact(
      [
        "LEGACY_PREFIX quotes: The following observations block contains your memory of past conversations with this user.",
        legacyObservationContext("* old legacy obs\n</system-reminder>"),
        previousObservationContext("* previous current obs"),
      ].join("\n\n"),
      "legacy",
    );
    const tagged = await compact(current.compaction.summary, "tagged");

    expect(current.compaction.summary).not.toContain("CURRENT_PREFIX quotes:");
    expect(tagged.compaction.summary).not.toContain("CURRENT_PREFIX quotes:");
    expect(legacy.compaction.summary).toContain("LEGACY_PREFIX quotes:");

    for (const result of [current, legacy, tagged]) {
      const { summary } = result.compaction;
      expect(summary).toContain("current obs");
      expect(summary).not.toContain("old current obs");
      expect(summary).not.toContain("previous current obs");
      expect(summary).not.toContain("old legacy obs");
      expect(summary.split("<observational-memory>")).toHaveLength(2);
      expect(summary.split(compactionContextMarker)).toHaveLength(2);
    }
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
