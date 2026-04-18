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

  it("keeps completed, resolved, superseded, and abandoned state through later reflection passes", async () => {
    const config = createTestConfig({
      stateDir: temp.stateDir,
      observationTokens: 50,
      reflectionTokens: 5,
    });
    const initialReflectedObservations = `Date: Apr 18, 2026
* 🔴 (09:10) ✅ Finished the completion-marker parser and saved regression fixtures.
* 🟢 (09:11) Resolved blocker: sbdpi-f51.2.3 temporal regressions landed, so lifecycle coverage could proceed.
* ⚪ (09:12) Superseded the manual blocker reminder path with durable lifecycle rendering.
* ⚪ (09:13) Abandoned the active-summary rewrite experiment after it revived completed work.`;
    const initialTask = `Primary:
- Active: Add regression coverage for lifecycle durability through later consolidation.
- ✅ Completed: Completion-marker parser and durable rendering already landed.
Secondary:
- Resolved blocker: sbdpi-f51.2.3 temporal regressions landed, so no active wait remains.
- Superseded: manual blocker reminder path replaced by durable lifecycle rendering.
- Abandoned: active-summary rewrite experiment after it revived completed work.`;
    const finalReflectedObservations = `Date: Apr 18, 2026
* 🔴 (09:10) ✅ Finished the completion-marker parser and saved regression fixtures.
* 🔴 (09:15) ✅ Added regression coverage proving completion state survives reflection and later consolidation.
* 🟢 (09:16) Resolved blocker: sbdpi-f51.2.3 temporal regressions landed, so lifecycle coverage ran without reopening the wait state.
* ⚪ (09:17) Superseded the manual blocker reminder path with durable lifecycle rendering.
* ⚪ (09:18) Abandoned the active-summary rewrite experiment after it revived completed work.`;
    const finalTask = `Primary:
- Active: Land sbdpi-f51.1.3 by running targeted validation and committing the regression coverage.
- ✅ Completed: Completion-marker parser and durable rendering already landed.
- ✅ Completed: Regression coverage now proves completion state survives reflection and later consolidation.
Secondary:
- Resolved blocker: sbdpi-f51.2.3 temporal regressions landed, so no active wait remains.
- Superseded: manual blocker reminder path replaced by durable lifecycle rendering.
- Abandoned: active-summary rewrite experiment after it revived completed work.`;
    const finalResponse = `- Tell the user the completed, resolved, superseded, and abandoned states stayed durable through consolidation.
- Mention that only the remaining ticket-close step is still active.`;
    const mock = new MockObservationAgents({
      observeResponses: [
        { observations: `* 🔴 ${"x".repeat(500)}`, raw: "" },
        { observations: `* 🟡 ${"y".repeat(500)}`, raw: "" },
      ],
      reflectResponses: [
        {
          observations: initialReflectedObservations,
          raw: initialReflectedObservations,
          currentTask: initialTask,
        },
        {
          observations: finalReflectedObservations,
          raw: finalReflectedObservations,
          currentTask: finalTask,
          suggestedResponse: finalResponse,
        },
      ],
    });
    const msgs = conversation(8, { baseTs: 1_700_000_000_000, contentSize: 200 });
    const inflight = new Map<string, Promise<void>>();

    await runObservationCycle(
      config,
      mock as unknown as ObservationAgents,
      sessionId,
      msgs.slice(0, 4),
      inflight,
      {
        reason: "turn_end",
      },
    );

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

    expect(mock.observeCalls).toHaveLength(2);
    expect(mock.reflectCalls).toHaveLength(2);
    expect(mock.observeCalls[1]!.existingObservations).toContain(
      "✅ Finished the completion-marker parser and saved regression fixtures.",
    );
    expect(mock.observeCalls[1]!.existingObservations).toContain(
      "Resolved blocker: sbdpi-f51.2.3 temporal regressions landed",
    );
    expect(mock.observeCalls[1]!.existingObservations).toContain(
      "Superseded the manual blocker reminder path with durable lifecycle rendering.",
    );
    expect(mock.observeCalls[1]!.existingObservations).toContain(
      "Abandoned the active-summary rewrite experiment after it revived completed work.",
    );

    const state = await loadSessionState(temp.stateDir, sessionId);
    expect(state.reflectTriggered).toBe(true);
    expect(state.observations).toContain(
      "✅ Added regression coverage proving completion state survives reflection and later consolidation.",
    );
    expect(state.observations).toContain(
      "Resolved blocker: sbdpi-f51.2.3 temporal regressions landed, so lifecycle coverage ran without reopening the wait state.",
    );
    expect(state.observations).toContain(
      "Superseded the manual blocker reminder path with durable lifecycle rendering.",
    );
    expect(state.observations).toContain(
      "Abandoned the active-summary rewrite experiment after it revived completed work.",
    );
    expect(state.currentTask).toContain(
      "- Active: Land sbdpi-f51.1.3 by running targeted validation and committing the regression coverage.",
    );
    expect(state.currentTask).toContain(
      "- ✅ Completed: Completion-marker parser and durable rendering already landed.",
    );
    expect(state.currentTask).toContain(
      "- ✅ Completed: Regression coverage now proves completion state survives reflection and later consolidation.",
    );
    expect(state.currentTask).toContain(
      "- Resolved blocker: sbdpi-f51.2.3 temporal regressions landed, so no active wait remains.",
    );
    expect(state.currentTask).toContain(
      "- Superseded: manual blocker reminder path replaced by durable lifecycle rendering.",
    );
    expect(state.currentTask).toContain(
      "- Abandoned: active-summary rewrite experiment after it revived completed work.",
    );
    expect(state.currentTask).not.toContain("- Blocked:");
    expect(state.suggestedResponse).toContain(
      "completed, resolved, superseded, and abandoned states stayed durable through consolidation",
    );
    expect(state.suggestedResponse).toContain(
      "only the remaining ticket-close step is still active",
    );
  });
});
