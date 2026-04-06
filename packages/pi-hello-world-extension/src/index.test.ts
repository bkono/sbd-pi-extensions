import { describe, expect, it, vi } from "vitest";
import initExtension from "./index.js";

type AnyFn = (...args: never[]) => unknown;

function createMockPI() {
	const handlers = new Map<string, AnyFn>();
	const tools: Array<{ name: string; execute: AnyFn }> = [];
	const commands = new Map<string, { handler: AnyFn }>();

	return {
		on: vi.fn((event: string, handler: AnyFn) => {
			handlers.set(event, handler);
		}),
		registerTool: vi.fn((tool: { name: string; execute: AnyFn }) => {
			tools.push(tool);
		}),
		registerCommand: vi.fn((name: string, opts: { handler: AnyFn }) => {
			commands.set(name, opts);
		}),
		// expose internals for assertions
		_handlers: handlers,
		_tools: tools,
		_commands: commands,
	};
}

describe("pi-hello-world-extension", () => {
	it("registers session_start handler, hello_world tool, and /hello command", () => {
		const pi = createMockPI();
		// biome-ignore lint/suspicious/noExplicitAny: mock satisfies the extension's structural contract
		initExtension(pi as any);

		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "hello_world" }));
		expect(pi.registerCommand).toHaveBeenCalledWith("hello", expect.any(Object));
	});

	it("hello_world tool returns a greeting", async () => {
		const pi = createMockPI();
		// biome-ignore lint/suspicious/noExplicitAny: mock satisfies the extension's structural contract
		initExtension(pi as any);

		const tool = pi._tools.find((t) => t.name === "hello_world");
		expect(tool).toBeDefined();

		const result = (await (tool as NonNullable<typeof tool>).execute(
			"call-1" as never,
			{ name: "Alice" } as never,
		)) as { content: Array<{ text: string }>; details: { greeted: string } };

		expect(result.content[0].text).toContain("Hello, Alice!");
		expect(result.details.greeted).toBe("Alice");
	});

	it("/hello command notifies with name", async () => {
		const pi = createMockPI();
		// biome-ignore lint/suspicious/noExplicitAny: mock satisfies the extension's structural contract
		initExtension(pi as any);

		const cmd = pi._commands.get("hello");
		expect(cmd).toBeDefined();

		const ctx = { ui: { notify: vi.fn() } };
		await (cmd as NonNullable<typeof cmd>).handler("Bob" as never, ctx as never);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Hello, Bob! 👋", "info");
	});

	it("/hello command defaults to World", async () => {
		const pi = createMockPI();
		// biome-ignore lint/suspicious/noExplicitAny: mock satisfies the extension's structural contract
		initExtension(pi as any);

		const cmd = pi._commands.get("hello");
		expect(cmd).toBeDefined();

		const ctx = { ui: { notify: vi.fn() } };
		await (cmd as NonNullable<typeof cmd>).handler("" as never, ctx as never);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Hello, World! 👋", "info");
	});
});
