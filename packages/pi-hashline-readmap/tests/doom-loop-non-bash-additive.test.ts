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

describe("doom loop warning content preservation", () => {
  it("appends warning without dropping non-text content blocks", async () => {
    const handlers = createHarness();

    for (const id of ["read-1", "read-2"]) {
      await handlers.tool_call(makeToolCall("read", id, { path: "src/read.ts" }), {});
      const result = await handlers.tool_result(
        {
          type: "tool_result" as const,
          toolName: "read",
          toolCallId: id,
          input: { path: "src/read.ts" },
          content: [
            { type: "text" as const, text: "plain output" },
            { type: "image" as const, source: "fixture.png" },
          ],
          isError: false,
          details: { marker: "ok" },
        },
        {},
      );
      expect(result).toBeUndefined();
    }

    await handlers.tool_call(makeToolCall("read", "read-3", { path: "src/read.ts" }), {});
    const third = await handlers.tool_result(
      {
        type: "tool_result" as const,
        toolName: "read",
        toolCallId: "read-3",
        input: { path: "src/read.ts" },
        content: [
          { type: "text" as const, text: "plain output" },
          { type: "image" as const, source: "fixture.png" },
        ],
        isError: false,
        details: { marker: "ok" },
      },
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
    expect(third.content[1]).toEqual({ type: "image", source: "fixture.png" });
  });
});
