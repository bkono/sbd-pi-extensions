import type { Message } from "@mariozechner/pi-ai";

/**
 * Message factories for tests.
 *
 * Real pi-ai Message types don't carry an `id` field — but our engine's
 * cursor tracking reads `(m as { id?: unknown }).id` for ID-based cursors.
 * Injecting an id here lets us write deterministic cursor tests.
 */

let msgCounter = 0;

export function resetMessageCounter(): void {
	msgCounter = 0;
}

export function userMsg(text: string, ts?: number): Message {
	msgCounter++;
	return {
		role: "user",
		content: text,
		timestamp: ts ?? 1_700_000_000_000 + msgCounter * 1000,
		id: `u-${msgCounter}`,
	} as unknown as Message;
}

export function assistantMsg(text: string, ts?: number): Message {
	msgCounter++;
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: ts ?? 1_700_000_000_000 + msgCounter * 1000,
		id: `a-${msgCounter}`,
	} as unknown as Message;
}

export function toolResultMsg(name: string, text: string, ts?: number): Message {
	msgCounter++;
	return {
		role: "toolResult",
		toolName: name,
		toolCallId: `tc-${msgCounter}`,
		content: [{ type: "text", text }],
		timestamp: ts ?? 1_700_000_000_000 + msgCounter * 1000,
		id: `t-${msgCounter}`,
	} as unknown as Message;
}

/**
 * Build a back-and-forth user/assistant conversation.
 * Each message has content of `contentSize` characters (default 100).
 */
export function conversation(
	n: number,
	opts?: { baseTs?: number; contentSize?: number },
): Message[] {
	const contentSize = opts?.contentSize ?? 100;
	const filler = "x".repeat(contentSize);
	const messages: Message[] = [];
	for (let i = 0; i < n; i++) {
		if (i % 2 === 0) {
			messages.push(
				userMsg(`user-${i}: ${filler}`, opts?.baseTs ? opts.baseTs + i * 1000 : undefined),
			);
		} else {
			messages.push(
				assistantMsg(
					`assistant-${i}: ${filler}`,
					opts?.baseTs ? opts.baseTs + i * 1000 : undefined,
				),
			);
		}
	}
	return messages;
}

/**
 * Get the id injected by the factories (cast required because Message type doesn't include it).
 */
export function messageId(m: Message): string | undefined {
	return (m as unknown as { id?: string }).id;
}
