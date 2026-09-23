/* biome-ignore-all lint/complexity/noBannedTypes: test harnesses store opaque Pi event callbacks. */
import { describe, expect, it } from "vitest";
import init from "../index.js";
import { formatDoomLoopMessage, makeToolFingerprint } from "../src/doom-loop.js";
import { GENERIC_SUGGESTION, SUGGESTIONS } from "../src/doom-loop-suggestions.js";

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

const call = (toolName: string, toolCallId: string, input: Record<string, unknown>) => ({
  type: "tool_call" as const,
  toolName,
  toolCallId,
  input,
});
const result = (
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
  text: string,
) => ({
  type: "tool_result" as const,
  toolName,
  toolCallId,
  input,
  content: [{ type: "text" as const, text }],
  isError: false,
  details: undefined,
});

describe("doom loop suggestions — end-to-end", () => {
  it("3× identical grep → REPEATED-CALL warning at start, with fingerprint and grep suggestion", async () => {
    const handlers = createHarness();
    const input = { pattern: "addRoute", glob: "*.ts" };
    let final: any;
    for (let i = 0; i < 3; i++) {
      await handlers.tool_call(call("grep", `g${i}`, input), {});
      final = await handlers.tool_result(result("grep", `g${i}`, input, "match line"), {});
    }
    const text = final.content[0].text as string;
    expect(
      text.startsWith(
        formatDoomLoopMessage({
          kind: "identical-tail",
          toolName: "grep",
          fingerprint: makeToolFingerprint("grep", input),
        }),
      ),
    ).toBe(true);
    expect(text).toContain("grep");
    expect(text).toContain("addRoute");
    for (const suggestion of SUGGESTIONS.grep) expect(text).toContain(suggestion);
    expect(text).toContain("match line");
  });

  it("alternating grep/read → ALTERNATING-CALL warning with suggestions for both tools", async () => {
    const handlers = createHarness();
    const steps = [
      { toolName: "grep", input: { pattern: "foo" }, text: "grep out" },
      { toolName: "read", input: { path: "src/bar.ts" }, text: "read out" },
    ];
    let final: any;
    for (let repeat = 0; repeat < 3; repeat++) {
      for (const [i, s] of steps.entries()) {
        const id = `r${repeat}-${i}`;
        await handlers.tool_call(call(s.toolName, id, s.input), {});
        final = await handlers.tool_result(result(s.toolName, id, s.input, s.text), {});
      }
    }
    const text = final.content[0].text as string;
    expect(
      text.startsWith(
        formatDoomLoopMessage({
          kind: "repeated-subsequence",
          toolName: "read",
          fingerprint: makeToolFingerprint("read", steps[1].input),
          steps,
        }),
      ),
    ).toBe(true);
    for (const suggestion of [...SUGGESTIONS.grep, ...SUGGESTIONS.read]) {
      expect(text).toContain(suggestion);
    }
    expect(text).toContain("read out");
  });

  it("bash path renders the same REPEATED-CALL warning shape as non-bash path", async () => {
    const handlers = createHarness();
    const command = "echo hi";
    let final: any;
    for (let i = 0; i < 3; i++) {
      await handlers.tool_call(call("bash", `b${i}`, { command }), {});
      final = await handlers.tool_result(
        {
          type: "tool_result",
          toolName: "bash",
          toolCallId: `b${i}`,
          input: { command },
          content: [{ type: "text", text: "hi\n" }],
          isError: false,
        } as any,
        {},
      );
    }
    const text = final.content[0].text as string;
    expect(
      text.startsWith(
        formatDoomLoopMessage({
          kind: "identical-tail",
          toolName: "bash",
          fingerprint: makeToolFingerprint("bash", { command }),
        }),
      ),
    ).toBe(true);
    expect(text).toContain(GENERIC_SUGGESTION);
  });
});
