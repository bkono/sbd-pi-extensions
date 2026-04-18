import type { Message } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * Wrap a message list as session branch entries. The agent_end handler
 * reads the full session history via `ctx.sessionManager.getBranch()`
 * rather than `event.messages` (which is turn-scoped in pi-agent-core),
 * so tests must populate the fake context's branch.
 */
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

describe("extension: agent_end lifecycle (observation cycle)", () => {
  let temp: TempStateDir;
  let mock: MockObservationAgents;
  const sessionId = "test-agent-end";

  beforeEach(() => {
    temp = createTempStateDir();
    resetMessageCounter();
  });

  afterEach(() => {
    __clearMockAgents();
    temp.cleanup();
  });

  it("observes when tokens exceed the extension's default threshold", async () => {
    // Default threshold is 70k; we override via env to a tiny value
    const originalEnv = process.env.OM_OBSERVATION_MESSAGE_TOKENS;
    process.env.OM_OBSERVATION_MESSAGE_TOKENS = "50";
    try {
      mock = new MockObservationAgents({
        observeResponses: [{ observations: "* 🔴 seen", raw: "" }],
      });
      __installMockAgents(mock);

      const harness = await createExtensionTestHarness(piObservationalMemory);
      const msgs = conversation(6, { baseTs: 1_700_000_000_000, contentSize: 300 });
      const ctx = createFakeExtensionContext({
        cwd: temp.stateDir,
        sessionId,
        entries: asBranchEntries(msgs),
      });

      // event.messages is intentionally turn-scoped (pi-agent-core semantics).
      // The handler should ignore it and read the full list from ctx.
      await harness.dispatch("agent_end", { type: "agent_end", messages: msgs }, ctx);

      expect(mock.observeCalls).toHaveLength(1);
      const state = await loadSessionState(`${temp.stateDir}/.pi/om-state`, sessionId);
      expect(state.observations).toContain("seen");
      expect(state.observeTriggered).toBe(true);
    } finally {
      if (originalEnv === undefined) delete process.env.OM_OBSERVATION_MESSAGE_TOKENS;
      else process.env.OM_OBSERVATION_MESSAGE_TOKENS = originalEnv;
    }
  });

  it("does not observe when tokens stay below threshold", async () => {
    const originalEnv = process.env.OM_OBSERVATION_MESSAGE_TOKENS;
    process.env.OM_OBSERVATION_MESSAGE_TOKENS = "1000000";
    try {
      mock = new MockObservationAgents();
      __installMockAgents(mock);

      const harness = await createExtensionTestHarness(piObservationalMemory);
      const msgs = conversation(2, { baseTs: 1_700_000_000_000 });
      const ctx = createFakeExtensionContext({
        cwd: temp.stateDir,
        sessionId,
        entries: asBranchEntries(msgs),
      });

      await harness.dispatch("agent_end", { type: "agent_end", messages: msgs }, ctx);

      expect(mock.observeCalls).toHaveLength(0);
      const state = await loadSessionState(`${temp.stateDir}/.pi/om-state`, sessionId);
      expect(state.observeTriggered).toBe(false);
      expect(state.lastCycleReason).toBe("turn_end");
    } finally {
      if (originalEnv === undefined) delete process.env.OM_OBSERVATION_MESSAGE_TOKENS;
      else process.env.OM_OBSERVATION_MESSAGE_TOKENS = originalEnv;
    }
  });

  it("observes from the full session branch even when event.messages is turn-scoped", async () => {
    // Regression test for the bug that slipped into manual smoke:
    //   pi-agent-core's agent_end event has `messages` set to only the
    //   messages produced DURING this run (turn-scoped delta). For a
    //   resumed long-lived session, the delta is always tiny while the
    //   cumulative history is large. The handler must read from
    //   ctx.sessionManager.getBranch(), not from event.messages, or it
    //   will never observe on resumed sessions regardless of threshold.
    //
    // Setup: threshold is 50 tokens. The full session has 20 messages at
    // 300 chars each (plenty over threshold). But event.messages contains
    // only the last 2 messages of that list (small delta). Prior to the
    // fix, the handler would compute unobserved from the 2-msg delta and
    // decide `shouldObserve: false`. After the fix, it reads the full 20
    // from the branch and correctly observes.
    const originalEnv = process.env.OM_OBSERVATION_MESSAGE_TOKENS;
    process.env.OM_OBSERVATION_MESSAGE_TOKENS = "50";
    try {
      mock = new MockObservationAgents({
        observeResponses: [{ observations: "* 🔴 resumed-session observation", raw: "" }],
      });
      __installMockAgents(mock);

      const harness = await createExtensionTestHarness(piObservationalMemory);
      const fullHistory = conversation(20, { baseTs: 1_700_000_000_000, contentSize: 300 });
      const turnDelta = fullHistory.slice(-2); // only the last 2, as pi-agent-core does
      const ctx = createFakeExtensionContext({
        cwd: temp.stateDir,
        sessionId,
        entries: asBranchEntries(fullHistory),
      });

      await harness.dispatch("agent_end", { type: "agent_end", messages: turnDelta }, ctx);

      expect(mock.observeCalls.length).toBeGreaterThan(0);
      // Observation work may now be chunked across multiple observer passes, but
      // the first chunk still proves the handler used the FULL branch history.
      // If the handler read event.messages instead, these early messages would be
      // absent from every observer call.
      const serialized = mock.observeCalls[0]?.serializedMessages ?? "";
      expect(serialized).toContain("user-0:");
      expect(serialized).toContain("assistant-1:");
      const state = await loadSessionState(`${temp.stateDir}/.pi/om-state`, sessionId);
      expect(state.observeTriggered).toBe(true);
      expect(state.observations).toContain("resumed-session observation");
    } finally {
      if (originalEnv === undefined) delete process.env.OM_OBSERVATION_MESSAGE_TOKENS;
      else process.env.OM_OBSERVATION_MESSAGE_TOKENS = originalEnv;
    }
  });
});
