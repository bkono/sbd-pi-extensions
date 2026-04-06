import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStatePath } from "../../config.js";
import piObservationalMemory from "../../index.js";
import { loadSessionState } from "../../state.js";
import {
	createExtensionTestHarness,
	createFakeExtensionContext,
} from "../helpers/extension-harness.js";
import { MockObservationAgents } from "../helpers/mock-agents.js";
import { __clearMockAgents, __installMockAgents } from "../helpers/mock-agents-module.js";
import { createTempStateDir, type TempStateDir } from "../helpers/temp-state-dir.js";

vi.mock("../../agents.js", async () => {
	const actual = await vi.importActual<typeof import("../../agents.js")>("../../agents.js");
	const mod = await import("../helpers/mock-agents-module.js");
	return { ...actual, ObservationAgents: mod.ObservationAgents };
});

describe("extension: session_start lifecycle", () => {
	let temp: TempStateDir;
	const sessionId = "test-session-start";

	beforeEach(() => {
		temp = createTempStateDir();
		__installMockAgents(new MockObservationAgents());
	});

	afterEach(() => {
		__clearMockAgents();
		temp.cleanup();
	});

	it("creates default state on disk when no state file exists", async () => {
		const harness = await createExtensionTestHarness(piObservationalMemory);

		const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

		// Normally we'd set up a project config; for this test we rely on the default
		// path: <cwd>/.pi/om-state. Since temp.stateDir already exists, the extension
		// will create .pi/om-state inside it.
		await harness.dispatch("session_start", { type: "session_start" }, ctx);

		const expectedStateDir = `${temp.stateDir}/.pi/om-state`;
		const state = await loadSessionState(expectedStateDir, sessionId);
		expect(state.sessionId).toBe(sessionId);
		expect(state.observations).toBe("");
		expect(state.updatedAt).toBeGreaterThan(0);
	});

	it("loads and re-saves existing valid state", async () => {
		const harness = await createExtensionTestHarness(piObservationalMemory);

		// Pre-populate a state file at the extension's default path
		const expectedStateDir = `${temp.stateDir}/.pi/om-state`;
		mkdirSync(expectedStateDir, { recursive: true });
		const path = sessionStatePath(expectedStateDir, sessionId);
		writeFileSync(
			path,
			JSON.stringify({
				sessionId,
				observations: "* 🔴 existing",
				observationTokens: 10,
				updatedAt: 1,
			}),
		);

		const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });
		await harness.dispatch("session_start", { type: "session_start" }, ctx);

		const state = await loadSessionState(expectedStateDir, sessionId);
		expect(state.observations).toContain("existing");
		expect(state.updatedAt).toBeGreaterThan(1); // refreshed on save
	});

	it("handles corrupt state file gracefully by writing a fresh default", async () => {
		const harness = await createExtensionTestHarness(piObservationalMemory);

		const expectedStateDir = `${temp.stateDir}/.pi/om-state`;
		mkdirSync(expectedStateDir, { recursive: true });
		const path = sessionStatePath(expectedStateDir, sessionId);
		writeFileSync(path, "{not valid");

		const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });
		await harness.dispatch("session_start", { type: "session_start" }, ctx);

		const state = await loadSessionState(expectedStateDir, sessionId);
		expect(state.observations).toBe("");
		expect(state.sessionId).toBe(sessionId);
	});
});
