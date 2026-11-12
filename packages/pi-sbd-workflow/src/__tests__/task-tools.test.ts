import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ProjectedSessionEntry,
  type SessionEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerTaskTools, TASK_SNAPSHOT } from "../task-tools.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** A session whose branch is the tool results the tools returned, like Pi persists them. */
function harness() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const branch: SessionEntry[] = [];
  const setWidget = vi.fn();
  const pi = {
    events: createEventBus(),
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI;
  registerTaskTools(pi);
  const ctx = {
    hasUI: true,
    ui: { setWidget },
    sessionManager: { getBranch: () => branch },
  } as unknown as ExtensionContext;
  let n = 0;
  const call = async (name: string, params: unknown) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    const result = await tool.execute("call", params as never, undefined, undefined, ctx);
    const id = `e${++n}`;
    branch.push({
      type: "message",
      id,
      message: { role: "toolResult", toolName: name, details: result.details, isError: false },
    } as unknown as SessionEntry);
    return { id, result };
  };
  const fire = async (name: string, event: unknown) => {
    let out: unknown;
    for (const h of handlers.get(name) ?? []) out = await h(event, ctx);
    return out;
  };
  const turnEnd = (visibleIds: string[], entries: unknown[] = []) =>
    fire("turn_end", {
      type: "turn_end",
      entries,
      context: {
        contextEntries: branch.map(
          (e) =>
            ({
              sourceEntry: e,
              messages: visibleIds.includes(e.id) ? [{ role: "toolResult" }] : [],
            }) as unknown as ProjectedSessionEntry,
        ),
      },
    }) as Promise<
      { entries: Array<{ customType?: string; content?: string; details?: unknown }> } | undefined
    >;
  return { tools, branch, call, fire, turnEnd, setWidget, ctx };
}

const plan = {
  tasks: [
    { content: "Reproduce", status: "in_progress", activeForm: "Reproducing" },
    { content: "Fix", status: "pending", activeForm: "Fixing" },
  ],
};

describe("task tools", () => {
  it("keep state across calls and show it in the widget", async () => {
    const h = harness();
    await h.call("task_write", plan);
    const { result } = await h.call("task_complete", { id: "task_reproduce" });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("[1/2 completed]") });
    expect(h.setWidget).toHaveBeenLastCalledWith("sbd-tasks", [
      "Tasks 1/2",
      "✓ Reproduce",
      "○ Fix",
    ]);
    await h.call("task_complete", { id: "task_fix" });
    expect(h.setWidget).toHaveBeenLastCalledWith("sbd-tasks", undefined);
    await expect(h.call("task_update", { id: "nope", status: "completed" })).rejects.toThrow(
      "Unknown task ID: nope",
    );
  });

  it("appends a hidden snapshot only once the latest carrier left model context", async () => {
    const h = harness();
    const { id } = await h.call("task_write", plan);
    expect(await h.turnEnd([id])).toBeUndefined();

    const omitted = await h.turnEnd([]);
    const snapshot = omitted?.entries.at(-1);
    expect(snapshot).toMatchObject({ customType: TASK_SNAPSHOT, display: false });
    expect(snapshot?.content).toContain("▸ [in_progress] {id: task_reproduce} Reproduce");

    // An earlier handler's draft already re-surfaced it in this boundary.
    expect(await h.turnEnd([], [snapshot])).toBeUndefined();

    // Once persisted, the snapshot is the carrier; while visible nothing more is added.
    h.branch.push({ type: "custom_message", id: "snap", ...snapshot } as unknown as SessionEntry);
    expect(await h.turnEnd(["snap"])).toBeUndefined();
  });

  it("restores the latest list from the branch, snapshots included", async () => {
    const h = harness();
    await h.call("task_write", plan);
    h.branch.push({
      type: "custom_message",
      id: "snap",
      customType: TASK_SNAPSHOT,
      details: {
        tasks: [{ id: "only", content: "Only", status: "pending", activeForm: "Onlying" }],
      },
    } as unknown as SessionEntry);
    await h.fire("session_tree", { type: "session_tree" });
    const { result } = await h.call("task_check", {});
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("{id: only} Only") });
  });

  it("adds nothing for an empty list", async () => {
    const h = harness();
    await h.call("task_write", { tasks: [] });
    expect(await h.turnEnd([])).toBeUndefined();
  });
});
