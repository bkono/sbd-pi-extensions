import type { ObserverResult } from "../../types.js";

/**
 * Mock replacement for `ObservationAgents`. Records calls and returns queued
 * responses. Not a subclass — structural typing lets us cast at the call site.
 *
 * Usage:
 *   const mock = new MockObservationAgents({
 *     observeResponses: [{ observations: "obs1", raw: "obs1" }],
 *   });
 *   await runObservationCycle(cfg, mock as unknown as ObservationAgents, ...);
 */
export class MockObservationAgents {
	public observeCalls: Array<{
		existingObservations: string;
		serializedMessages: string;
		customInstruction?: string;
		includeContinuationHint?: boolean;
	}> = [];

	public reflectCalls: Array<{
		observations: string;
		customInstruction?: string;
	}> = [];

	private observeResponses: ObserverResult[];
	private reflectResponses: ObserverResult[];
	private observeError?: Error;
	private reflectError?: Error;

	constructor(opts?: {
		observeResponses?: ObserverResult[];
		reflectResponses?: ObserverResult[];
		observeError?: Error;
		reflectError?: Error;
	}) {
		this.observeResponses = opts?.observeResponses ? [...opts.observeResponses] : [];
		this.reflectResponses = opts?.reflectResponses ? [...opts.reflectResponses] : [];
		this.observeError = opts?.observeError;
		this.reflectError = opts?.reflectError;
	}

	async observe(input: {
		existingObservations: string;
		serializedMessages: string;
		customInstruction?: string;
		includeContinuationHint?: boolean;
	}): Promise<ObserverResult> {
		this.observeCalls.push(input);
		if (this.observeError) throw this.observeError;
		return (
			this.observeResponses.shift() ?? {
				observations: "",
				raw: "",
			}
		);
	}

	async reflect(input: {
		observations: string;
		customInstruction?: string;
	}): Promise<ObserverResult> {
		this.reflectCalls.push(input);
		if (this.reflectError) throw this.reflectError;
		return (
			this.reflectResponses.shift() ?? {
				observations: input.observations,
				raw: input.observations,
			}
		);
	}
}
