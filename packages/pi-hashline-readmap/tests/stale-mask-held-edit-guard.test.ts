/* biome-ignore-all lint/complexity/noBannedTypes: test harnesses store opaque Pi event callbacks. */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import init from "../index.js";
import { computeLineHash, ensureHashInit } from "../src/hashline.js";
import { PREFIX_SIGNAL_CHANNEL } from "../src/stale-mask-gate.js";

function createHarness() {
  const tools: Record<string, any> = {};
  const handlers: Record<string, Function> = {};
  const bus = new EventEmitter();
  init({
    registerTool(def: any) {
      tools[def.name] = def;
    },
    on(event: string, handler: Function) {
      handlers[event] = handler;
    },
    events: {
      emit: (channel: string, data: unknown) => bus.emit(channel, data),
      on: (channel: string, handler: (data: unknown) => void) => {
        bus.on(channel, handler);
        return () => bus.off(channel, handler);
      },
    },
  } as any);
  return { tools, handlers, bus };
}

async function run(
  tools: Record<string, any>,
  handlers: Record<string, Function>,
  name: string,
  id: string,
  params: any,
) {
  const result = await tools[name].execute(id, params, new AbortController().signal, () => {}, {
    cwd: process.cwd(),
  });
  await handlers.tool_result(
    {
      toolName: name,
      toolCallId: id,
      input: params,
      content: result.content,
      isError: result.isError === true,
      details: result.details,
    },
    {},
  );
  return result;
}

describe("a stale read held unmasked for the cached prefix", () => {
  it("still fails the edit guard: the guard follows the tracker, not the mask", async () => {
    await ensureHashInit();
    const dir = mkdtempSync(resolve(tmpdir(), "pi-held-stale-"));
    try {
      const filePath = resolve(dir, "small.ts");
      writeFileSync(filePath, `${["a", "b", "uniqueLine", "d", "e"].join("\n")}\n`, "utf-8");
      const { tools, handlers, bus } = createHarness();
      const request = (messages: any[]) => {
        handlers.context({ type: "context", messages });
        bus.emit(PREFIX_SIGNAL_CHANNEL, { source: "pi-om", moved: false });
        const full = [{ role: "system", content: "sys", timestamp: 0 }, ...messages];
        return (
          handlers.context_with_system({ type: "context_with_system", messages: full })?.messages ??
          full
        ).slice(1);
      };

      const read = await run(tools, handlers, "read", "read-1", { path: filePath });
      const readMessage = {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: read.content,
        details: {},
        isError: false,
        timestamp: 1,
      };
      request([readMessage]);

      const anchor = `3:${computeLineHash(3, "uniqueLine")}`;
      const edit1 = await run(tools, handlers, "edit", "edit-1", {
        path: filePath,
        edits: [{ set_line: { anchor, new_text: "uniqueLineV2" } }],
      });
      expect(edit1.isError).not.toBe(true);
      const editMessage = {
        role: "toolResult",
        toolCallId: "edit-1",
        toolName: "edit",
        content: edit1.content,
        details: {},
        isError: false,
        timestamp: 2,
      };

      // The read was sent last request and the prefix does not move: it stays unmasked.
      const out = request([readMessage, editMessage]);
      expect(out[0].content).toEqual(read.content);

      // A second edit reusing the old read's anchors is still refused.
      const fakeAnchor = `1:${computeLineHash(2, "b")}`;
      const edit2 = await tools.edit.execute(
        "edit-2",
        { path: filePath, edits: [{ set_line: { anchor: fakeAnchor, new_text: "INJECTED" } }] },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );
      expect(edit2.isError).toBe(true);
      expect(edit2.content.find((c: any) => c.type === "text")?.text).toContain(
        `You must get fresh anchors for ${filePath} before editing it.`,
      );
      expect(readFileSync(filePath, "utf-8")).toBe(
        `${["a", "b", "uniqueLineV2", "d", "e"].join("\n")}\n`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
