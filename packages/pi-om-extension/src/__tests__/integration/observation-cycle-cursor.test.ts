import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ObservationAgents } from "../../agents.js";
import { runObservationCycle } from "../../engine.js";
import { loadSessionState } from "../../state.js";
import { conversation, messageId, resetMessageCounter } from "../helpers/fixtures.js";
import { MockObservationAgents } from "../helpers/mock-agents.js";
import {
	createTempStateDir,
	createTestConfig,
	type TempStateDir,
} from "../helpers/temp-state-dir.js";

describe("runObservationCycle — cursor advancement", () => {
	let temp: TempStateDir;
	const sessionId = "sess-cursor";

	beforeEach(() => {
		temp = createTempStateDir();
		resetMessageCounter();
	});
	afterEach(() => temp.cleanup());

	it("first cycle advances cursor to last observed message id + timestamp", async () => {
		const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 50 });
		const mock = new MockObservationAgents({
			observeResponses: [{ observations: "* obs", raw: "" }],
		});
		const msgs = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 200 });
		const lastId = messageId(msgs[3]!)!;

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
		expect(state.lastObservedEntryId).toBe(lastId);
		expect(state.lastObservedTimestamp).toBe(1_700_000_000_000 + 3 * 1000);
	});

	it("second cycle only observes new messages after the cursor", async () => {
		const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 50 });
		const mock = new MockObservationAgents({
			observeResponses: [
				{ observations: "* first obs", raw: "" },
				{ observations: "* second obs", raw: "" },
			],
		});

		// Turn 1: 4 messages
		const turn1Msgs = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 200 });
		const inflight = new Map<string, Promise<void>>();
		await runObservationCycle(
			config,
			mock as unknown as ObservationAgents,
			sessionId,
			turn1Msgs,
			inflight,
			{
				reason: "turn_end",
			},
		);

		// Turn 2: 4 original + 2 new messages
		resetMessageCounter();
		const allMsgs = conversation(6, { baseTs: 1_700_000_000_000, contentSize: 200 });
		await runObservationCycle(
			config,
			mock as unknown as ObservationAgents,
			sessionId,
			allMsgs,
			inflight,
			{
				reason: "turn_end",
			},
		);

		expect(mock.observeCalls).toHaveLength(2);
		// Second observe should only contain the NEW messages (indices 4 and 5)
		const secondSerialized = mock.observeCalls[1]!.serializedMessages;
		expect(secondSerialized).toContain(`user-4:`);
		expect(secondSerialized).toContain(`assistant-5:`);
		expect(secondSerialized).not.toContain(`user-0:`);
	});

	it("observations accumulate across cycles via appendObservations", async () => {
		const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 50 });
		const mock = new MockObservationAgents({
			observeResponses: [
				{ observations: "* first observation", raw: "" },
				{ observations: "* second observation", raw: "" },
			],
		});

		const turn1Msgs = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 200 });
		const inflight = new Map<string, Promise<void>>();
		await runObservationCycle(
			config,
			mock as unknown as ObservationAgents,
			sessionId,
			turn1Msgs,
			inflight,
			{
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
				reason: "turn_end",
			},
		);

		const state = await loadSessionState(temp.stateDir, sessionId);
		expect(state.observations).toContain("first observation");
		expect(state.observations).toContain("second observation");
	});

	it("passes existing observations to the next observer call", async () => {
		const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 50 });
		const mock = new MockObservationAgents({
			observeResponses: [
				{ observations: "* first", raw: "" },
				{ observations: "* second", raw: "" },
			],
		});

		const turn1Msgs = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 200 });
		const inflight = new Map<string, Promise<void>>();
		await runObservationCycle(
			config,
			mock as unknown as ObservationAgents,
			sessionId,
			turn1Msgs,
			inflight,
			{
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
				reason: "turn_end",
			},
		);

		expect(mock.observeCalls[1]!.existingObservations).toContain("first");
	});
});
