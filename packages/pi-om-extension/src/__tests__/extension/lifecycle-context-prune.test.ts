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
import {
  assistantMsg,
  conversation,
  messageId,
  resetMessageCounter,
  userMsg,
} from "../helpers/fixtures.js";
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

  function assistantToolCallMessage(
    toolCallId: string,
    opts?: { id?: string; timestamp?: number },
  ): Message {
    return {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: toolCallId,
          toolCallId,
          name: "read",
          toolName: "read",
          arguments: { path: "README.md" },
          input: '{"path":"README.md"}',
        },
      ],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.3-codex",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "tool_use",
      timestamp: opts?.timestamp ?? 1_700_000_001_000,
      id: opts?.id ?? "assistant-tool-call",
    } as unknown as Message;
  }

  function toolResultMessage(
    toolCallId: string,
    opts?: { id?: string; timestamp?: number; text?: string },
  ): Message {
    return {
      role: "toolResult",
      toolName: "read",
      toolCallId,
      content: [{ type: "text", text: opts?.text ?? "README contents" }],
      timestamp: opts?.timestamp ?? 1_700_000_002_000,
      id: opts?.id ?? "tool-result",
    } as unknown as Message;
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

  it("returns messages after the cursor plus the previous assistant bridge", async () => {
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

    expect(result.messages).toHaveLength(4); // previous assistant bridge + msgs 2, 3, 4
  });

  it("preserves the previous assistant response when a published cursor would prune it before a user follow-up", async () => {
    resetMessageCounter();
    const msgs = [
      userMsg("draft the proposal", 1_700_000_000_000),
      assistantMsg("Long proposal text that the user can refer to as that", 1_700_000_001_000),
      userMsg("save that to a doc", 1_700_000_002_000),
    ];
    preloadState({
      lastObservedEntryId: messageId(msgs[1]!),
      lastObservedTimestamp: 1_700_000_001_000,
    });

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = (await harness.dispatch(
      "context",
      { type: "context", messages: msgs },
      ctx,
    )) as { messages: Message[] };

    expect(result.messages).toHaveLength(2);
    expect((result.messages[0] as { id?: string }).id).toBe(messageId(msgs[1]!));
    expect((result.messages[1] as { id?: string }).id).toBe(messageId(msgs[2]!));

    const state = await loadSessionState(`${temp.stateDir}/.pi/om-state`, sessionId);
    expect(state.tailEntriesAfterPrune).toBe(2);
    expect(state.prunedEntriesCount).toBe(1);
  });

  it("preserves the previous assistant response when pruning falls back from a timestamp cursor", async () => {
    resetMessageCounter();
    const msgs = [
      userMsg("draft the proposal", 1_700_000_000_000),
      assistantMsg("Long proposal text that the user can refer to as that", 1_700_000_001_000),
      userMsg("save that to a doc", 1_700_000_002_000),
    ];
    preloadState({
      lastObservedEntryId: "missing-assistant-id",
      lastObservedTimestamp: 1_700_000_001_000,
    });

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = (await harness.dispatch(
      "context",
      { type: "context", messages: msgs },
      ctx,
    )) as { messages: Message[] };

    expect(result.messages).toHaveLength(2);
    expect((result.messages[0] as { id?: string }).id).toBe(messageId(msgs[1]!));
    expect((result.messages[1] as { id?: string }).id).toBe(messageId(msgs[2]!));
  });

  it("does not duplicate the assistant response when the selected window already includes it", async () => {
    resetMessageCounter();
    const msgs = [
      userMsg("draft the proposal", 1_700_000_000_000),
      assistantMsg("Long proposal text that the user can refer to as that", 1_700_000_001_000),
      userMsg("save that to a doc", 1_700_000_002_000),
    ];
    preloadState({
      lastObservedEntryId: messageId(msgs[0]!),
      lastObservedTimestamp: 1_700_000_000_000,
    });

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = (await harness.dispatch(
      "context",
      { type: "context", messages: msgs },
      ctx,
    )) as { messages: Message[] };

    expect(result.messages).toHaveLength(2);
    expect((result.messages[0] as { id?: string }).id).toBe(messageId(msgs[1]!));
    expect((result.messages[1] as { id?: string }).id).toBe(messageId(msgs[2]!));
  });

  it("prepends the matching assistant tool call when pruning would start at a tool result", async () => {
    resetMessageCounter();
    const toolCallId = "call-context-pair";
    const msgs = [
      userMsg("read README", 1_700_000_000_000),
      assistantToolCallMessage(toolCallId, {
        id: "assistant-tool-call-1",
        timestamp: 1_700_000_001_000,
      }),
      toolResultMessage(toolCallId, {
        id: "tool-result-1",
        timestamp: 1_700_000_002_000,
      }),
      {
        role: "assistant",
        content: [{ type: "text", text: "README summarized" }],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.3-codex",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1_700_000_003_000,
        id: "assistant-final-1",
      } as unknown as Message,
    ];
    preloadState({
      lastObservedEntryId: "assistant-tool-call-1",
      lastObservedTimestamp: 1_700_000_001_000,
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

    expect(result.messages).toHaveLength(3);
    expect((result.messages[0] as { role?: string }).role).toBe("assistant");
    expect((result.messages[1] as { role?: string }).role).toBe("toolResult");
    expect((result.messages[0] as { id?: string }).id).toBe("assistant-tool-call-1");
  });

  it("keeps the latest tool result paired during latest-message fallback", async () => {
    resetMessageCounter();
    const toolCallId = "call-context-fallback";
    const msgs = [
      userMsg("read README", 1_700_000_000_000),
      assistantToolCallMessage(toolCallId, {
        id: "assistant-tool-call-2",
        timestamp: 1_700_000_001_000,
      }),
      toolResultMessage(toolCallId, {
        id: "tool-result-2",
        timestamp: 1_700_000_002_000,
      }),
    ];
    preloadState({
      lastObservedEntryId: "tool-result-2",
      lastObservedTimestamp: 1_700_000_002_000,
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

    expect(result.messages).toHaveLength(2);
    expect((result.messages[0] as { id?: string }).id).toBe("assistant-tool-call-2");
    expect((result.messages[1] as { id?: string }).id).toBe("tool-result-2");
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
    expect(state.tailEntriesAfterPrune).toBe(4);
    expect(state.prunedEntriesCount).toBe(1);
    expect(state.lastCycleReason).toBe("context");
  });

  it("does not crash when messages contain literal tiktoken sentinel text", async () => {
    resetMessageCounter();
    const msgs = [userMsg("please keep literal <|endoftext|> in the transcript")];

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = (await harness.dispatch(
      "context",
      { type: "context", messages: msgs },
      ctx,
    )) as { messages: Message[] };

    expect(result.messages).toHaveLength(1);

    const state = await loadSessionState(`${temp.stateDir}/.pi/om-state`, sessionId);
    expect(state.tailEntriesBeforePrune).toBe(1);
    expect(state.tailTokensBeforePrune).toBeGreaterThan(0);
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
      expect(result.messages).toHaveLength(5);
    } finally {
      if (originalEnv === undefined) delete process.env.OM_OBSERVATION_STAGE_MESSAGE_TOKENS;
      else process.env.OM_OBSERVATION_STAGE_MESSAGE_TOKENS = originalEnv;
    }
  });

  it("keeps staged observations out of the prompt until agent_end publishes them", async () => {
    const originalStageEnv = process.env.OM_OBSERVATION_STAGE_MESSAGE_TOKENS;
    const originalPublishEnv = process.env.OM_OBSERVATION_PUBLISH_MESSAGE_TOKENS;
    process.env.OM_OBSERVATION_STAGE_MESSAGE_TOKENS = "50";
    process.env.OM_OBSERVATION_PUBLISH_MESSAGE_TOKENS = "50";

    try {
      mock = new MockObservationAgents({
        observeResponses: [
          { observations: "* 🟡 staged mid-turn", raw: "" },
          { observations: "* 🟡 staged mid-turn\n\n* 🔴 published at turn boundary", raw: "" },
        ],
      });
      __installMockAgents(mock);

      const msgs = conversation(5, { baseTs: 1_700_000_000_000, contentSize: 200 });
      preloadState({
        observations: "* published from previous turn",
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

      const initialPrompt = (await harness.dispatch(
        "before_agent_start",
        { type: "before_agent_start", prompt: "continue", systemPrompt: "Base prompt" },
        ctx,
      )) as { systemPrompt: string };
      expect(initialPrompt.systemPrompt).toContain("published from previous turn");
      expect(initialPrompt.systemPrompt).not.toContain("staged mid-turn");

      const contextResult = (await harness.dispatch(
        "context",
        { type: "context", messages: msgs },
        ctx,
      )) as { messages: Message[] };
      expect(contextResult.messages).toHaveLength(4);

      const midTurnPrompt = (await harness.dispatch(
        "before_agent_start",
        { type: "before_agent_start", prompt: "continue", systemPrompt: "Base prompt" },
        ctx,
      )) as { systemPrompt: string };
      expect(midTurnPrompt.systemPrompt).toContain("published from previous turn");
      expect(midTurnPrompt.systemPrompt).not.toContain("staged mid-turn");

      await harness.dispatch("agent_end", { type: "agent_end", messages: msgs.slice(-2) }, ctx);

      const state = await loadSessionState(`${temp.stateDir}/.pi/om-state`, sessionId);
      expect(state.observations).toContain("staged mid-turn");
      expect(state.observations).toContain("published at turn boundary");
      expect(state.lastObservedEntryId).toBe(messageId(msgs[4]!));

      const nextTurnPrompt = (await harness.dispatch(
        "before_agent_start",
        { type: "before_agent_start", prompt: "continue", systemPrompt: "Base prompt" },
        ctx,
      )) as { systemPrompt: string };
      expect(nextTurnPrompt.systemPrompt).toContain("staged mid-turn");
      expect(nextTurnPrompt.systemPrompt).toContain("published at turn boundary");
    } finally {
      if (originalStageEnv === undefined) delete process.env.OM_OBSERVATION_STAGE_MESSAGE_TOKENS;
      else process.env.OM_OBSERVATION_STAGE_MESSAGE_TOKENS = originalStageEnv;

      if (originalPublishEnv === undefined)
        delete process.env.OM_OBSERVATION_PUBLISH_MESSAGE_TOKENS;
      else process.env.OM_OBSERVATION_PUBLISH_MESSAGE_TOKENS = originalPublishEnv;
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

  it("skips observation and pruning when paused", async () => {
    const msgs = conversation(5, { baseTs: 1_700_000_000_000 });
    const cursorId = messageId(msgs[1]!)!;
    preloadState({
      paused: true,
      lastObservedEntryId: cursorId,
      lastObservedTimestamp: 1_700_000_001_000,
    });

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = await harness.dispatch("context", { type: "context", messages: msgs }, ctx);

    // When paused, context handler returns undefined (no message modification)
    expect(result).toBeUndefined();
    // Observation agent should not have been called
    expect(mock.observeCalls).toHaveLength(0);
  });
});
