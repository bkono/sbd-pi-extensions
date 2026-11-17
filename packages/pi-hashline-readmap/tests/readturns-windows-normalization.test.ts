/* biome-ignore-all lint/complexity/noBannedTypes: test harnesses store opaque Pi event callbacks. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import init from "../index.js";
import { computeLineHash, ensureHashInit } from "../src/hashline.js";

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

describe("Windows-style paths in the anchor ledger", () => {
  afterEach(() => {
    delete (globalThis as any).__hashlineToolExecutors;
  });

  it("a bash mutation on a slash-normalized target forgets anchors the read issued", async () => {
    await ensureHashInit();
    const dir = mkdtempSync(join(tmpdir(), "readturns-win-"));
    try {
      const filePath = join(dir, "has\\backslash.ts");
      writeFileSync(filePath, "const value = 1;\n", "utf8");

      const handlers = createHarness();
      const executors = (globalThis as any).__hashlineToolExecutors;
      const readResult = await executors.read.execute(
        "read-call",
        { path: filePath },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );
      expect(readResult.isError).not.toBe(true);

      // The command never runs, so only the ledger's forget() can make the anchor stale.
      await handlers.tool_result(
        {
          type: "tool_result",
          toolName: "bash",
          toolCallId: "bash-call",
          input: { command: `printf 'x' > '${filePath}'` },
          content: [{ type: "text", text: "" }],
          isError: false,
          details: {},
        },
        {},
      );

      const anchor = `1:${computeLineHash(1, "const value = 1;")}`;
      const editResult = await executors.edit.execute(
        "edit-call",
        { path: filePath, edits: [{ set_line: { anchor, new_text: "const value = 2;" } }] },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );

      expect(editResult.isError).toBe(true);
      expect(editResult.details?.ptcValue?.error?.code).toBe("stale-anchor");
      expect(readFileSync(filePath, "utf8")).toBe("const value = 1;\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
