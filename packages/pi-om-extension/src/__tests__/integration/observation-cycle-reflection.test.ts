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

describe("runObservationCycle — reflection cascade", () => {
  let temp: TempStateDir;
  const sessionId = "sess-reflect";

  beforeEach(() => {
    temp = createTempStateDir();
    resetMessageCounter();
  });
  afterEach(() => temp.cleanup());

  it("does not reflect when observation tokens stay below threshold", async () => {
    const config = createTestConfig({
      stateDir: temp.stateDir,
      observationTokens: 50,
      reflectionTokens: 1_000_000,
    });
    const mock = new MockObservationAgents({
      observeResponses: [{ observations: "* short obs", raw: "" }],
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
        reason: "turn_end",
      },
    );

    expect(mock.reflectCalls).toHaveLength(0);
    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.reflectTriggered).toBe(false);
  });

  it("triggers reflection when observation tokens exceed threshold", async () => {
    const config = createTestConfig({
      stateDir: temp.stateDir,
      observationTokens: 50,
      reflectionTokens: 5, // tiny threshold — any observation triggers reflection
    });
    const bigObs = `* 🔴 ${"x".repeat(500)}`;
    const mock = new MockObservationAgents({
      observeResponses: [{ observations: bigObs, raw: bigObs }],
      reflectResponses: [{ observations: "* 🔴 consolidated", raw: "* 🔴 consolidated" }],
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
        reason: "turn_end",
      },
    );

    expect(mock.reflectCalls).toHaveLength(1);
    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.reflectTriggered).toBe(true);
    expect(state.observations).toContain("🔴 consolidated");
    expect(state.observations).not.toContain("x".repeat(100));
  });

  it("reflector returning empty observations retains pre-reflection value", async () => {
    const config = createTestConfig({
      stateDir: temp.stateDir,
      observationTokens: 50,
      reflectionTokens: 5,
    });
    const bigObs = "* 🔴 pre-reflect content";
    const mock = new MockObservationAgents({
      observeResponses: [{ observations: bigObs, raw: bigObs }],
      reflectResponses: [{ observations: "", raw: "" }],
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
        reason: "turn_end",
      },
    );

    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.observations).toContain("pre-reflect content");
    expect(state.reflectTriggered).toBe(true);
  });

  it("reflector sets currentTask — propagates to state", async () => {
    const config = createTestConfig({
      stateDir: temp.stateDir,
      observationTokens: 50,
      reflectionTokens: 5,
    });
    const mock = new MockObservationAgents({
      observeResponses: [
        { observations: "* 🔴 obs from observer", raw: "", currentTask: "observer task" },
      ],
      reflectResponses: [
        {
          observations: "* 🔴 reflected",
          raw: "",
          currentTask: "reflector task",
          suggestedResponse: "reflector suggestion",
        },
      ],
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
        reason: "turn_end",
      },
    );

    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.currentTask).toBe("reflector task");
    expect(state.suggestedResponse).toBe("reflector suggestion");
  });

  it("reflector not returning currentTask keeps observer's value", async () => {
    const config = createTestConfig({
      stateDir: temp.stateDir,
      observationTokens: 50,
      reflectionTokens: 5,
    });
    const mock = new MockObservationAgents({
      observeResponses: [{ observations: "* 🔴 big", raw: "", currentTask: "observer task" }],
      reflectResponses: [{ observations: "* 🔴 consolidated", raw: "" }],
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
        reason: "turn_end",
      },
    );

    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.currentTask).toBe("observer task");
  });

  it("preserves reflected structure, exact values, and outcome state in stored memory", async () => {
    const config = createTestConfig({
      stateDir: temp.stateDir,
      observationTokens: 50,
      reflectionTokens: 5,
    });
    const bigObs = `* 🔴 ${"x".repeat(500)}`;
    const reflectedObservations = `Date: Apr 18, 2026
* 🔴 (09:10) Compared 3 reflector prompt variants; kept Option B because it preserved 2 list items and exact counts.
* 🔴 (09:12) ✅ Updated packages/pi-om-extension/src/prompts.ts and kept \`bw close sbdpi-f51.5.2\` pending until tests + commit complete.
* 🟡 (09:13) Waiting on review before running the deploy command \`npm publish\`.`;
    const reflectedTask = `Primary:
- Active: Strengthen reflector consolidation for exact numbers, dates, and list structure.
- Blocked: close sbdpi-f51.5.2 only after tests and commit.
Secondary:
- ✅ Observer-stage specificity upgrade already landed.`;
    const reflectedResponse = `- Summarize that 3 exact preservation rules are now enforced.
- Confirm tests passed before closing the ticket.`;
    const mock = new MockObservationAgents({
      observeResponses: [{ observations: bigObs, raw: bigObs }],
      reflectResponses: [
        {
          observations: reflectedObservations,
          raw: reflectedObservations,
          currentTask: reflectedTask,
          suggestedResponse: reflectedResponse,
        },
      ],
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
        reason: "turn_end",
      },
    );

    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.reflectTriggered).toBe(true);
    expect(state.observations).toContain("Compared 3 reflector prompt variants");
    expect(state.observations).toContain("preserved 2 list items and exact counts");
    expect(state.observations).toContain("✅ Updated packages/pi-om-extension/src/prompts.ts");
    expect(state.observations).toContain("`bw close sbdpi-f51.5.2`");
    expect(state.observations).toContain("`npm publish`");
    expect(state.currentTask).toContain(
      "- Active: Strengthen reflector consolidation for exact numbers, dates, and list structure.",
    );
    expect(state.currentTask).toContain(
      "- Blocked: close sbdpi-f51.5.2 only after tests and commit.",
    );
    expect(state.currentTask).toContain("- ✅ Observer-stage specificity upgrade already landed.");
    expect(state.suggestedResponse).toContain(
      "- Summarize that 3 exact preservation rules are now enforced.",
    );
    expect(state.suggestedResponse).toContain("- Confirm tests passed before closing the ticket.");
  });
});
