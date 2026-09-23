/* biome-ignore-all lint/complexity/noBannedTypes: test harnesses store opaque Pi event callbacks. */
import { describe, expect, it } from "vitest";
import init from "../index.js";
import { formatDoomLoopMessage, makeToolFingerprint } from "../src/doom-loop.js";

function createHarness() {
  const handlers: Record<string, Function> = {};

  init({
    registerTool() {},
    on(event: string, handler: Function) {
      handlers[event] = handler;
    },
    events: { emit() {}, on() {} },
  } as any);

  return handlers;
}

function makeToolCall(toolName: string, toolCallId: string, input: Record<string, unknown>) {
  return {
    type: "tool_call" as const,
    toolName,
    toolCallId,
    input,
  };
}

function makeToolResult(
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
  text: string,
) {
  return {
    type: "tool_result" as const,
    toolName,
    toolCallId,
    input,
    content: [{ type: "text" as const, text }],
    isError: false,
    details: undefined,
  };
}

describe("doom loop detection — identical consecutive calls", () => {
  it("appends a warning after the third identical call without blocking the original tool result", async () => {
    const handlers = createHarness();

    expect(handlers.tool_call).toBeDefined();
    expect(handlers.tool_result).toBeDefined();

    for (const id of ["read-1", "read-2"]) {
      await handlers.tool_call(makeToolCall("read", id, { path: "src/read.ts" }), {});
      const result = await handlers.tool_result(
        makeToolResult("read", id, { path: "src/read.ts" }, "plain output"),
        {},
      );
      expect(result).toBeUndefined();
    }

    await handlers.tool_call(makeToolCall("read", "read-3", { path: "src/read.ts" }), {});
    const third = await handlers.tool_result(
      makeToolResult("read", "read-3", { path: "src/read.ts" }, "plain output"),
      {},
    );

    expect(third).toBeDefined();
    const text = third.content[0].text as string;
    const warning = formatDoomLoopMessage({
      kind: "identical-tail",
      toolName: "read",
      fingerprint: makeToolFingerprint("read", { path: "src/read.ts" }),
    });
    expect(text.startsWith(warning)).toBe(true);
    expect(text.endsWith("plain output")).toBe(true);
  });
});
