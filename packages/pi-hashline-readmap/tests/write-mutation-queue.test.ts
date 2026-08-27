import { afterEach, describe, expect, it, vi } from "vitest";

describe("write Pi file mutation queue integration", () => {
  afterEach(() => {
    vi.doUnmock("@earendil-works/pi-coding-agent");
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("wraps write's full mutation window in Pi's file mutation queue", async () => {
    vi.resetModules();
    const events: string[] = [];
    const filePath = "/virtual/write-queue.txt";

    vi.doMock("@earendil-works/pi-coding-agent", async () => {
      const actual = await vi.importActual<any>("@earendil-works/pi-coding-agent");
      return {
        ...actual,
        withFileMutationQueue: vi.fn(async (queuedPath: string, fn: () => Promise<unknown>) => {
          events.push(`queue-enter:${queuedPath}`);
          const result = await fn();
          events.push(`queue-exit:${queuedPath}`);
          return result;
        }),
      };
    });

    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<any>("node:fs");
      return {
        ...actual,
        mkdirSync: vi.fn((dirPath: string) => {
          events.push(`mkdir:${dirPath}`);
        }),
        writeFileSync: vi.fn((targetPath: string, content: string) => {
          events.push(`write:${targetPath}:${content}`);
        }),
      };
    });

    const { registerWriteTool } = await import("../src/write.js");
    let tool: any;
    registerWriteTool({
      registerTool(def: any) {
        tool = def;
      },
    } as any);

    const result = await tool.execute(
      "write-queue",
      { path: filePath, content: "queued content" },
      new AbortController().signal,
      () => {},
      { cwd: "/" },
    );

    expect(result.isError).not.toBe(true);
    expect(events[0]).toBe(`queue-enter:${filePath}`);
    expect(events).toEqual([
      `queue-enter:${filePath}`,
      "mkdir:/virtual",
      `write:${filePath}:queued content`,
      `queue-exit:${filePath}`,
    ]);
  });
});
