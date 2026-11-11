/* biome-ignore-all lint/complexity/noBannedTypes: test harnesses store opaque Pi event callbacks. */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import init from "../index.js";
import { buildContextHygieneMetadata, buildFileResource } from "../src/context-hygiene.js";
import { PREFIX_SIGNAL_CHANNEL } from "../src/stale-mask-gate.js";

/**
 * Stale masks rewrite an earlier tool result, which moves the provider's cached prompt
 * prefix from that item on. When a prefix owner (pi-om) signals per request, a mask on an
 * already-sent result waits for a request whose prefix moves anyway, then stays frozen.
 */
function createHarness() {
  const handlers: Record<string, Function> = {};
  const bus = new EventEmitter();
  init({
    registerTool() {},
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
  return { handlers, bus };
}

const SYSTEM = { role: "system", content: "sys", timestamp: 0 };
const FILE = buildFileResource("src/ledger.ts");

function toolResultMessage(toolCallId: string, toolName: string, text: string) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName,
    content: [{ type: "text" as const, text }],
    details: {},
    isError: false,
    timestamp: 1,
  };
}

async function recordTool(
  handlers: Record<string, Function>,
  toolCallId: string,
  tool: "read" | "edit",
) {
  const metadata = buildContextHygieneMetadata({
    tool,
    classification: tool === "read" ? "read-context" : "mutation",
    resources: [FILE],
  });
  await handlers.tool_result(
    {
      type: "tool_result",
      toolName: tool,
      toolCallId,
      input: { path: "src/ledger.ts" },
      content: [{ type: "text", text: `${tool} output` }],
      isError: false,
      details: { contextHygiene: metadata },
    },
    {},
  );
}

/** One provider request: the context phase (where pi-om signals), then context_with_system. */
function providerRequest(
  harness: ReturnType<typeof createHarness>,
  messages: ReturnType<typeof toolResultMessage>[],
  signal?: { moved: boolean },
) {
  harness.handlers.context({ type: "context", messages });
  if (signal) harness.bus.emit(PREFIX_SIGNAL_CHANNEL, { source: "pi-om", ...signal });
  const full = [SYSTEM, ...messages];
  const result = harness.handlers.context_with_system({
    type: "context_with_system",
    messages: full,
  });
  return ((result?.messages ?? full) as any[]).slice(1);
}

function textAt(messages: any[], toolCallId: string): string {
  return messages.find((m) => m.toolCallId === toolCallId)?.content?.[0]?.text;
}

afterEach(() => {
  delete (globalThis as any).__hashlineToolExecutors;
});

describe("stale masks and the cached prompt prefix", () => {
  const read = toolResultMessage("read-1", "read", "old read output");
  const edit = toolResultMessage("edit-1", "edit", "edit succeeded");

  it("masks immediately when no prefix owner signals (standalone hashline)", async () => {
    const harness = createHarness();
    await recordTool(harness.handlers, "read-1", "read");
    providerRequest(harness, [read]);
    await recordTool(harness.handlers, "edit-1", "edit");
    const out = providerRequest(harness, [read, edit]);
    expect(textAt(out, "read-1")).toMatch(/^\[Stale read result/);
  });

  it("holds a mask on a sent result until the prefix moves, then keeps it frozen", async () => {
    const harness = createHarness();
    await recordTool(harness.handlers, "read-1", "read");
    providerRequest(harness, [read], { moved: false });
    await recordTool(harness.handlers, "edit-1", "edit");

    // The read was in the previous request: masking it now would break the cache.
    const held = providerRequest(harness, [read, edit], { moved: false });
    expect(textAt(held, "read-1")).toBe("old read output");
    const stillHeld = providerRequest(harness, [read, edit], { moved: false });
    expect(textAt(stillHeld, "read-1")).toBe("old read output");

    // OM activation: the prefix moves anyway, so the mask lands on this request.
    const landed = providerRequest(harness, [read, edit], { moved: true });
    expect(textAt(landed, "read-1")).toMatch(/^\[Stale read result/);

    // Committed masks are sticky and byte-stable afterwards.
    const after = providerRequest(harness, [read, edit], { moved: false });
    expect(JSON.stringify(after)).toBe(JSON.stringify(landed));
  });

  it("masks a result the provider has not seen yet without waiting", async () => {
    const harness = createHarness();
    providerRequest(harness, [], { moved: false });
    // read and edit in the same tool batch: the read never reached the provider unmasked
    await recordTool(harness.handlers, "read-1", "read");
    await recordTool(harness.handlers, "edit-1", "edit");
    const out = providerRequest(harness, [read, edit], { moved: false });
    expect(textAt(out, "read-1")).toMatch(/^\[Stale read result/);
  });

  it("consumes a moved signal on one request only", async () => {
    const harness = createHarness();
    await recordTool(harness.handlers, "read-1", "read");
    providerRequest(harness, [read], { moved: true });
    await recordTool(harness.handlers, "edit-1", "edit");
    // no signal this request would mean standalone, so signal moved: false explicitly
    const out = providerRequest(harness, [read, edit], { moved: false });
    expect(textAt(out, "read-1")).toBe("old read output");
  });

  it("freezes the committed record when the file changes again", async () => {
    const harness = createHarness();
    await recordTool(harness.handlers, "read-1", "read");
    providerRequest(harness, [read], { moved: false });
    await recordTool(harness.handlers, "edit-1", "edit");
    const first = providerRequest(harness, [read, edit], { moved: true });
    const edit2 = toolResultMessage("edit-2", "edit", "edit succeeded again");
    await recordTool(harness.handlers, "edit-2", "edit");
    const second = providerRequest(harness, [read, edit, edit2], { moved: true });
    const recordOf = (out: any[]) => out.find((m) => m.toolCallId === "read-1").details;
    expect(recordOf(second)).toEqual(recordOf(first));
  });

  it("ignores malformed signals", async () => {
    const harness = createHarness();
    await recordTool(harness.handlers, "read-1", "read");
    providerRequest(harness, [read], { moved: false });
    await recordTool(harness.handlers, "edit-1", "edit");
    harness.handlers.context({ type: "context", messages: [read, edit] });
    harness.bus.emit(PREFIX_SIGNAL_CHANNEL, { moved: "yes" });
    harness.bus.emit(PREFIX_SIGNAL_CHANNEL, { source: "pi-om", moved: false });
    const out = harness.handlers.context_with_system({
      type: "context_with_system",
      messages: [SYSTEM, read, edit],
    });
    expect(textAt((out?.messages ?? [SYSTEM, read, edit]).slice(1), "read-1")).toBe(
      "old read output",
    );
  });
});

describe("supportsContextWithSystem", () => {
  it("gates on Pi 0.87.0, where context_with_system arrived", async () => {
    const { supportsContextWithSystem } = await import("../src/index.js");
    expect(supportsContextWithSystem(undefined)).toBe(false);
    expect(supportsContextWithSystem("0.86.9")).toBe(false);
    expect(supportsContextWithSystem("0.87.0")).toBe(true);
    expect(supportsContextWithSystem("1.5.2")).toBe(true);
  });
});

describe("PREFIX_SIGNAL_CHANNEL", () => {
  it("is the literal pi-om emits", () => {
    expect(PREFIX_SIGNAL_CHANNEL).toBe("context:prefix");
  });
});
