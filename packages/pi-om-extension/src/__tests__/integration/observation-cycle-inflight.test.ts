import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("runObservationCycle — inflight deduplication", () => {
	let temp: TempStateDir;

	beforeEach(() => {
		temp = createTempStateDir();
		resetMessageCounter();
	});
	afterEach(() => temp.cleanup());

	it("concurrent calls for the same session deduplicate to one observer call", async () => {
		const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 50 });
		const mock = new MockObservationAgents({
			observeResponses: [
				{ observations: "* first", raw: "" },
				{ observations: "* second", raw: "" }, // should never be used
			],
		});
		const msgs = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 200 });
		const inflight = new Map<string, Promise<void>>();

		// Kick off two cycles for the same session concurrently
		await Promise.all([
			runObservationCycle(config, mock as unknown as ObservationAgents, "sess-A", msgs, inflight, {
				reason: "turn_end",
			}),
			runObservationCycle(config, mock as unknown as ObservationAgents, "sess-A", msgs, inflight, {
				reason: "turn_end",
			}),
		]);

		expect(mock.observeCalls).toHaveLength(1);
		const state = await loadSessionState(temp.stateDir, "sess-A");
		expect(state.observations).toContain("first");
		expect(state.observations).not.toContain("second");
	});

	it("concurrent calls for different sessions run independently", async () => {
		const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 50 });
		const mock = new MockObservationAgents({
			observeResponses: [
				{ observations: "* A", raw: "" },
				{ observations: "* B", raw: "" },
			],
		});
		const msgs = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 200 });
		const inflight = new Map<string, Promise<void>>();

		await Promise.all([
			runObservationCycle(config, mock as unknown as ObservationAgents, "sess-A", msgs, inflight, {
				reason: "turn_end",
			}),
			runObservationCycle(config, mock as unknown as ObservationAgents, "sess-B", msgs, inflight, {
				reason: "turn_end",
			}),
		]);

		expect(mock.observeCalls).toHaveLength(2);
		const stateA = await loadSessionState(temp.stateDir, "sess-A");
		const stateB = await loadSessionState(temp.stateDir, "sess-B");
		// Each session has one observation (order between them is non-deterministic)
		const combined = stateA.observations + stateB.observations;
		expect(combined).toContain("* A");
		expect(combined).toContain("* B");
	});

	it("inflight map is cleared after successful completion", async () => {
		const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 50 });
		const mock = new MockObservationAgents({
			observeResponses: [{ observations: "* done", raw: "" }],
		});
		const msgs = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 200 });
		const inflight = new Map<string, Promise<void>>();

		await runObservationCycle(
			config,
			mock as unknown as ObservationAgents,
			"sess-C",
			msgs,
			inflight,
			{
				reason: "turn_end",
			},
		);

		expect(inflight.has("sess-C")).toBe(false);
	});

	it("inflight map is cleared after observer throws", async () => {
		const config = createTestConfig({ stateDir: temp.stateDir, observationTokens: 50 });
		const mock = new MockObservationAgents({
			observeError: new Error("simulated observer failure"),
		});
		const msgs = conversation(4, { baseTs: 1_700_000_000_000, contentSize: 200 });
		const inflight = new Map<string, Promise<void>>();

		// Suppress console.error noise — the engine logs unconditionally on failure
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await runObservationCycle(
			config,
			mock as unknown as ObservationAgents,
			"sess-D",
			msgs,
			inflight,
			{
				reason: "turn_end",
			},
		);

		expect(inflight.has("sess-D")).toBe(false);
		expect(errSpy).toHaveBeenCalled();
		const firstCall = errSpy.mock.calls[0]!;
		expect(String(firstCall[0])).toContain("observation cycle failed");

		errSpy.mockRestore();
	});
});
