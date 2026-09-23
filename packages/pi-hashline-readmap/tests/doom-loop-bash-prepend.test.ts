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

describe("doom loop prepend — bash path", () => {
  it("prepends ⚠ REPEATED-CALL WARNING to bash tool_result after 3 identical bash calls", async () => {
    const handlers = createHarness();
    const command = "echo hi";
    const warning = formatDoomLoopMessage({
      kind: "identical-tail",
      toolName: "bash",
      fingerprint: makeToolFingerprint("bash", { command }),
    });

    for (const id of ["bash-1", "bash-2"]) {
      await handlers.tool_call(
        { type: "tool_call", toolName: "bash", toolCallId: id, input: { command } },
        {},
      );
      const r = await handlers.tool_result(
        {
          type: "tool_result",
          toolName: "bash",
          toolCallId: id,
          input: { command },
          content: [{ type: "text", text: "hi\n" }],
          isError: false,
        },
        {},
      );
      expect(r).toBeDefined();
      expect(r.content[0].text).not.toContain(warning);
    }

    await handlers.tool_call(
      { type: "tool_call", toolName: "bash", toolCallId: "bash-3", input: { command } },
      {},
    );
    const third = await handlers.tool_result(
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "bash-3",
        input: { command },
        content: [{ type: "text", text: "hi\n" }],
        isError: false,
      },
      {},
    );

    expect(third).toBeDefined();
    const text = third.content[0].text as string;
    expect(text.startsWith(warning)).toBe(true);
    expect(text.trimEnd().endsWith("hi")).toBe(true);
  });
});
