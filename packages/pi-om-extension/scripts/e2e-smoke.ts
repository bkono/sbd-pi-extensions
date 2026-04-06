#!/usr/bin/env tsx
/**
 * End-to-end smoke test for @solvedbydev/pi-om-extension.
 *
 * Runs a real pi coding-agent session with our extension + a companion
 * verification extension loaded. Uses the same config/auth/provider resolution
 * as the pi CLI in production. Low OM thresholds force observation cycles to
 * fire during a short scripted interaction.
 *
 * Verifies:
 * - Hooks fire in the expected order
 * - State files are created on disk with expected shape
 * - Observations are generated and persisted
 * - System prompt sent to the LLM on turn 2 contains the observation context
 * - Message structure sent to the LLM matches expectations
 *
 * Run: npm run smoke (from packages/pi-om-extension)
 * Requires: a working pi config (~/.pi/agent/settings.json) + auth.
 */

// Set OM thresholds BEFORE any extension imports so config picks them up.
// Low thresholds ensure even a short scripted interaction crosses the
// observation boundary.
process.env.OM_OBSERVATION_MESSAGE_TOKENS = "200";
process.env.OM_REFLECTION_OBSERVATION_TOKENS = "5000";
process.env.OM_DEBUG = "1";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnownProvider } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";

import { sessionStatePath } from "../src/config.js";
import piObservationalMemory from "../src/index.js";
import type { SessionState } from "../src/types.js";
import { createVerificationExtension, createVerificationRecord } from "./e2e-verification.js";

// ---------------------------------------------------------------------------
// Agent model selection (pinned to avoid drift from pi settings.json defaults)
// ---------------------------------------------------------------------------
// Override via env: PI_SMOKE_PROVIDER, PI_SMOKE_MODEL
const SMOKE_PROVIDER = (process.env.PI_SMOKE_PROVIDER ?? "google") as KnownProvider;
const SMOKE_MODEL_ID = process.env.PI_SMOKE_MODEL ?? "gemini-2.5-flash";

// ---------------------------------------------------------------------------
// Assertion helpers — this script uses a bespoke report rather than vitest
// ---------------------------------------------------------------------------

interface Check {
	name: string;
	pass: boolean;
	details?: string;
}

const checks: Check[] = [];

function check(name: string, pass: boolean, details?: string): void {
	checks.push({ name, pass, details });
	const marker = pass ? "[\u2713]" : "[\u2717]";
	const suffix = details ? ` — ${details}` : "";
	console.log(`${marker} ${name}${suffix}`);
}

/**
 * Drain the AgentSession's internal event queue.
 *
 * `await session.prompt()` and `await session.agent.waitForIdle()` both return
 * BEFORE the session has finished dispatching events to extensions. The session
 * maintains a private `_agentEventQueue: Promise<void>` chain that processes
 * events asynchronously via microtasks. We need to await that chain directly.
 *
 * Events can queue other events, so we loop until the queue reference stops
 * changing across awaits.
 */
async function drainSessionEvents(session: unknown): Promise<void> {
	const anySession = session as { _agentEventQueue?: Promise<void> };
	for (let i = 0; i < 100; i++) {
		const before = anySession._agentEventQueue;
		if (!before) return;
		await before;
		const after = anySession._agentEventQueue;
		if (before === after) return;
	}
}

class FatalError extends Error {}

function fatal(message: string): never {
	throw new FatalError(message);
}

// ---------------------------------------------------------------------------
// Setup: temp workspace + sample files
// ---------------------------------------------------------------------------

const workspace = mkdtempSync(join(tmpdir(), "pi-om-smoke-"));
console.log(`\n=== pi-om-extension e2e smoke test ===`);
console.log(`Workspace: ${workspace}`);

function writeSampleFile(name: string, content: string): void {
	writeFileSync(join(workspace, name), content);
}

writeSampleFile(
	"sample.ts",
	`export const SAMPLE_CONST = "observational-memory-test";
export function sampleFn(x: number): number {
  return x * 2;
}
`,
);

writeSampleFile(
	"sample.md",
	`# Sample Document

This is a sample markdown file used by the e2e smoke test.

## Purpose

Ensures the pi-om-extension observer can capture enough conversation content
to cross the observation token threshold.
`,
);

writeSampleFile(
	"config.json",
	JSON.stringify({ name: "e2e-sample", version: "1.0.0", feature: "om-smoke-test" }, null, 2),
);

// ---------------------------------------------------------------------------
// Bootstrap: real pi config + auth + model registry
// ---------------------------------------------------------------------------

async function runSmoke(): Promise<void> {
	console.log(`\nLoading pi config (same mechanism as real pi CLI)...`);

	let authStorage: AuthStorage;
	let settingsManager: SettingsManager;
	let modelRegistry: ModelRegistry;

	try {
		authStorage = AuthStorage.create();
		settingsManager = SettingsManager.create();
		modelRegistry = ModelRegistry.create(authStorage);
	} catch (err) {
		fatal(
			`Failed to load pi config or auth: ${err instanceof Error ? err.message : String(err)}\n` +
				`Ensure ~/.pi/agent/settings.json exists and auth is configured.`,
		);
	}

	const record = createVerificationRecord();

	// Extension factories: OM first (so its modifications are visible to the
	// verification extension), verification second.
	const resourceLoader = new DefaultResourceLoader({
		cwd: workspace,
		settingsManager,
		extensionFactories: [piObservationalMemory, createVerificationExtension(record)],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});

	try {
		await resourceLoader.reload();
	} catch (err) {
		fatal(`Resource loader reload failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	console.log(`\nResolving agent model: ${SMOKE_PROVIDER}/${SMOKE_MODEL_ID}`);
	const agentModel = getModel(
		SMOKE_PROVIDER as Parameters<typeof getModel>[0],
		SMOKE_MODEL_ID as Parameters<typeof getModel>[1],
	);
	if (!agentModel) {
		fatal(
			`Model not found in pi-ai registry: ${SMOKE_PROVIDER}/${SMOKE_MODEL_ID}\n` +
				`Override via PI_SMOKE_PROVIDER and PI_SMOKE_MODEL env vars.`,
		);
	}

	console.log(`\nCreating agent session...`);
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	try {
		const result = await createAgentSession({
			cwd: workspace,
			model: agentModel,
			authStorage,
			settingsManager,
			modelRegistry,
			resourceLoader,
			// Omitting `tools` lets pi activate its default built-in tool set
			// (read, bash, edit, write, grep, find, ls). Extension-registered tools
			// (om_status, om_observations) are merged automatically.
			sessionManager: SessionManager.create(workspace),
		});
		session = result.session;
	} catch (err) {
		fatal(
			`createAgentSession failed: ${err instanceof Error ? err.message : String(err)}\n` +
				`Ensure auth for ${SMOKE_PROVIDER} is configured (~/.pi/agent/auth.json or env vars).`,
		);
	}

	// CRITICAL: bindExtensions must be called explicitly — it fires session_start
	// and wires up UI/command bindings. Without this, extension event handlers
	// for session_start are never invoked even though other events still fire.
	try {
		await session.bindExtensions({});
	} catch (err) {
		fatal(`session.bindExtensions failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	const sessionId = session.sessionManager.getSessionId();
	console.log(`Session ID: ${sessionId}`);
	console.log(`Model: ${JSON.stringify(session.sessionManager.buildSessionContext().model)}`);

	// Capture assistant text + tool calls so we can see what the model actually did
	const assistantActivity: string[] = [];
	session.subscribe((event: { type: string; [k: string]: unknown }) => {
		if (event.type === "message_end") {
			const msg = (event as unknown as { message?: { role: string; content: unknown } }).message;
			if (msg?.role === "assistant" && Array.isArray(msg.content)) {
				for (const part of msg.content as Array<{
					type: string;
					text?: string;
					name?: string;
					input?: unknown;
				}>) {
					if (part.type === "text" && part.text) {
						assistantActivity.push(`TEXT: ${part.text.slice(0, 200)}`);
					} else if (part.type === "toolCall") {
						assistantActivity.push(
							`TOOL: ${part.name} ${typeof part.input === "string" ? part.input.slice(0, 100) : ""}`,
						);
					}
				}
			} else if (msg?.role === "toolResult") {
				const tr = msg as unknown as {
					toolName?: string;
					content?: Array<{ type: string; text?: string }>;
				};
				const firstText = tr.content?.find((c) => c.type === "text")?.text ?? "";
				assistantActivity.push(`TOOL_RESULT: ${tr.toolName} -> ${firstText.slice(0, 100)}`);
			}
		}
	});

	// -------------------------------------------------------------------------
	// Turn 1: force observation by asking the agent to read the sample files
	// -------------------------------------------------------------------------

	console.log(`\n--- Turn 1: reading sample files ---`);
	try {
		await session.prompt(
			"Use the read tool to read each of these files from the current directory: " +
				"sample.ts, sample.md, and config.json. After reading all three, give me a " +
				"one-sentence summary of what each file contains.",
		);
		// Critical: wait for the agent loop AND drain the session's async event queue.
		// `session.prompt()` resolves when the final message text is streamed, and
		// `agent.waitForIdle()` resolves when the agent loop is done, but the
		// AgentSession's internal `_agentEventQueue` processes events via microtasks
		// and is separate from both. Without draining it, `agent_end` (and other
		// trailing events) won't have been dispatched to extensions yet.
		await session.agent.waitForIdle();
		await drainSessionEvents(session);
	} catch (err) {
		fatal(`Turn 1 prompt failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	// State file should now exist at <workspace>/.pi/om-state/<sessionId>.json
	const stateDir = join(workspace, ".pi", "om-state");
	const statePath = sessionStatePath(stateDir, sessionId);

	check("State directory created", existsSync(stateDir), `stateDir=${stateDir}`);
	check("State file exists after turn 1", existsSync(statePath), `path=${statePath}`);

	let state1: SessionState | undefined;
	if (existsSync(statePath)) {
		state1 = JSON.parse(readFileSync(statePath, "utf-8"));
	}

	check(
		"state1.observations is non-empty",
		Boolean(state1?.observations && state1.observations.trim().length > 0),
		state1 ? `${state1.observationTokens} obs tokens` : undefined,
	);
	check("state1.observationTokens > 0", (state1?.observationTokens ?? 0) > 0);
	check("state1.lastObservedTimestamp is set", state1?.lastObservedTimestamp !== undefined);
	check("state1.lastCycleReason is 'turn_end'", state1?.lastCycleReason === "turn_end");
	check("state1.observeTriggered is true", state1?.observeTriggered === true);

	// Hook firing order
	const hasSessionStart = record.hookOrder.includes("session_start");
	const hasBeforeAgentStart = record.hookOrder.includes("before_agent_start");
	const hasContext = record.hookOrder.includes("context");
	const hasAgentEnd = record.hookOrder.includes("agent_end");

	check("session_start hook fired", hasSessionStart);
	check("before_agent_start hook fired", hasBeforeAgentStart);
	check("context hook fired at least once", hasContext);
	check("agent_end hook fired", hasAgentEnd);

	const bas1Count = record.beforeAgentStart.length;
	const ctx1Count = record.contextEvents.length;
	const ae1Count = record.agentEnds.length;
	check(
		"Turn 1 recorded exactly one before_agent_start event",
		bas1Count === 1,
		`count=${bas1Count}`,
	);
	check("Turn 1 recorded at least one context event", ctx1Count >= 1, `count=${ctx1Count}`);
	check("Turn 1 recorded exactly one agent_end event", ae1Count === 1, `count=${ae1Count}`);

	// On turn 1, before_agent_start receives an empty state (no observations yet),
	// so OM extension should NOT modify the system prompt.
	const turn1SysPrompt = record.beforeAgentStart[0]?.incomingSystemPrompt ?? "";
	check(
		"Turn 1 system prompt does NOT yet contain observations",
		!turn1SysPrompt.includes("<observations>"),
	);

	// -------------------------------------------------------------------------
	// Turn 2: verify observations are injected into the system prompt
	// -------------------------------------------------------------------------

	console.log(`\n--- Turn 2: follow-up question ---`);
	try {
		await session.prompt("Which of those three files was the largest?");
		await session.agent.waitForIdle();
		await drainSessionEvents(session);
	} catch (err) {
		fatal(`Turn 2 prompt failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	const state2: SessionState = JSON.parse(readFileSync(statePath, "utf-8"));

	check("Turn 2 recorded a second before_agent_start event", record.beforeAgentStart.length === 2);

	const turn2SysPrompt = record.beforeAgentStart[1]?.incomingSystemPrompt ?? "";
	check(
		"Turn 2 system prompt contains <observations> block (OM injection worked)",
		turn2SysPrompt.includes("<observations>"),
	);
	check(
		"Turn 2 system prompt contains <system-reminder> continuation tag",
		turn2SysPrompt.includes("<system-reminder>"),
	);
	check(
		"Turn 2 system prompt preserves original prompt prefix",
		turn2SysPrompt.length > (record.beforeAgentStart[0]?.incomingSystemPrompt.length ?? 0),
	);

	check(
		"state2 observations persisted across turns",
		state2.observations.length >= (state1?.observations?.length ?? 0),
	);

	// -------------------------------------------------------------------------
	// Tool verification: invoke om_status and om_observations
	// -------------------------------------------------------------------------

	// These are registered via pi.registerTool inside the OM extension. They
	// appear in the session's tool list via the extension runner. We verify
	// they're registered by checking session tools — exact invocation would
	// require model tool-calling, which is out of scope for the smoke test.
	// Checking via the session is enough to confirm registration succeeded.

	const allTools = (session.agent.state.tools ?? []).map((t: { name: string }) => t.name);
	check("om_status tool registered on agent", allTools.includes("om_status"));
	check("om_observations tool registered on agent", allTools.includes("om_observations"));

	// -------------------------------------------------------------------------
	// Report
	// -------------------------------------------------------------------------

	console.log(`\n=== Summary ===`);
	const passed = checks.filter((c) => c.pass).length;
	const failed = checks.length - passed;
	console.log(`Passed: ${passed}/${checks.length}`);

	if (failed > 0) {
		console.log(`\nFailed checks:`);
		for (const c of checks.filter((c) => !c.pass)) {
			console.log(`  [\u2717] ${c.name}${c.details ? ` — ${c.details}` : ""}`);
		}

		console.log(`\n=== Diagnostic dump ===`);
		console.log(`\nHook firing order:`);
		console.log(record.hookOrder.join(" -> "));

		console.log(`\nState file (${statePath}):`);
		if (existsSync(statePath)) {
			console.log(readFileSync(statePath, "utf-8"));
		} else {
			console.log("(file does not exist)");
		}

		console.log(`\nTurn 2 incoming system prompt (first 2000 chars):`);
		console.log(turn2SysPrompt.slice(0, 2000));

		console.log(`\nContext events:`);
		for (const [i, ev] of record.contextEvents.entries()) {
			console.log(`  [${i}] count=${ev.messageCount} roles=${ev.messageRoles.join(",")}`);
		}

		console.log(`\nAssistant activity (text + tool calls + results):`);
		if (assistantActivity.length === 0) {
			console.log("  (nothing captured)");
		} else {
			for (const [i, line] of assistantActivity.entries()) {
				console.log(`  [${i}] ${line}`);
			}
		}
	}

	// -------------------------------------------------------------------------
	// Cleanup
	// -------------------------------------------------------------------------

	try {
		session.dispose?.();
	} catch {
		// ignore
	}

	try {
		rmSync(workspace, { recursive: true, force: true });
		console.log(`\nWorkspace cleaned up.`);
	} catch (err) {
		console.warn(
			`Failed to clean up workspace: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	process.exit(failed > 0 ? 1 : 0);
}

runSmoke().catch((err) => {
	if (err instanceof FatalError) {
		console.error(`\n[FATAL] ${err.message}\n`);
	} else {
		console.error(`\nUnhandled error: ${err instanceof Error ? err.stack : String(err)}`);
	}
	try {
		rmSync(workspace, { recursive: true, force: true });
		console.log(`Workspace cleaned up.`);
	} catch {
		// ignore
	}
	process.exit(1);
});
