import type {
  EntryRenderer,
  ExtensionAPI,
  ExtensionContext,
  SessionBoundaryDraft,
  Theme,
  TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import piObservationalMemory from "../index.js";
import { type ActivationData, type ChunkData, OM_ACTIVATION, OM_CHUNK } from "../state.js";
import { registerRenderers } from "../ui.js";
import {
  append,
  assistantToolCall,
  commit,
  fakeModel,
  fakeRegistry,
  newSession,
  textOf,
  toolResult,
  user,
} from "./helpers.js";

const theme = { fg: (_color: string, text: string) => text } as Theme;
const observations = "Date: Nov 11, 2026\n* A remembered fact";

function chunk(id: string, observationTokens: number): ChunkData {
  return {
    v: 1,
    id,
    observations: `${observations} ${id}`,
    observationTokens,
    messageTokens: 9_000,
    entryIds: [],
    range: "a:b",
    createdAt: 0,
    model: "test",
  };
}

function line(
  renderer: EntryRenderer<ActivationData>,
  data: ActivationData,
  expanded = false,
): string {
  const entry = { type: "custom", customType: OM_ACTIVATION, data } as Parameters<
    EntryRenderer<ActivationData>
  >[0];
  return (
    renderer(entry, { expanded }, theme)
      ?.render(120)
      .map((row) => row.trimEnd())
      .join("\n") ?? ""
  );
}

function extension() {
  const session = newSession();
  const registry = fakeRegistry();
  const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let renderer: EntryRenderer<ActivationData> | undefined;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      hooks.set(name, handler);
    },
    registerEntryRenderer: (type: string, callback: EntryRenderer<ActivationData>) => {
      if (type === OM_ACTIVATION) renderer = callback;
    },
    events: { emit: () => {} },
    registerCommand: () => {},
    registerTool: () => {},
    getSessionName: () => undefined,
    setSessionName: () => {},
    appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
  } as unknown as ExtensionAPI;
  piObservationalMemory(pi);
  const ctx = {
    sessionManager: session,
    modelRegistry: registry,
    model: fakeModel("openai-codex", "gpt-6.1-sol"),
    isIdle: () => false,
    ui: { setStatus: () => {} },
  } as unknown as ExtensionContext;
  const fire = async (name: string, event: unknown): Promise<unknown> =>
    hooks.get(name)?.(event, ctx);
  return { session, registry, fire, renderer: () => renderer! };
}

describe("activation transcript", () => {
  it("renders MastraCode activation copy and keeps expanded observation text", () => {
    const chunks = new Map([
      ["a", chunk("a", 700)],
      ["b", chunk("b", 500)],
      ["c", chunk("c", 200)],
    ]);
    let renderer: EntryRenderer<ActivationData> | undefined;
    registerRenderers(
      {
        registerEntryRenderer: (type: string, callback: EntryRenderer<ActivationData>) => {
          if (type === OM_ACTIVATION) renderer = callback;
        },
      } as unknown as ExtensionAPI,
      (id) => chunks.get(id),
    );
    expect(renderer).toBeDefined();
    const data: ActivationData = {
      v: 1,
      chunkIds: ["a", "b", "c"],
      trigger: "threshold",
      at: 0,
      messageTokens: 26_900,
    };
    expect(line(renderer!, data)).toBe(
      "✓ Activated 3 observations: -26.9k msg tokens, +1.4k obs tokens",
    );
    expect(line(renderer!, data, true)).toBe(
      `✓ Activated 3 observations: -26.9k msg tokens, +1.4k obs tokens\n${[...chunks.values()].map((value) => value.observations).join("\n\n")}`,
    );
    expect(line(renderer!, { ...data, chunkIds: ["a"], messageTokens: 1_000 })).toBe(
      "✓ Activated observations: -1k msg tokens, +0.7k obs tokens",
    );
    expect(line(renderer!, { ...data, chunkIds: ["b"], messageTokens: 0 })).toBe(
      "✓ Activated observations: -0 msg tokens, +0.5k obs tokens",
    );
  });

  it("indexes synchronous turn-end drafts before Pi commits them and adds no model message", async () => {
    const { session, fire, renderer } = extension();
    await fire("session_start", {});
    append(session, user("fix auth"));
    await fire("agent_start", {});
    await fire("context", {});
    const id = "big";
    append(session, assistantToolCall(id, "read", { path: "big.log" }));
    append(session, toolResult(id, "read", textOf(62_000)));
    await fire("context", {});
    const nextId = "next";
    append(session, assistantToolCall(nextId, "grep", { q: "x" }));
    append(session, toolResult(nextId, "grep", "no matches"));
    const result = (await fire("turn_end", {
      context: { contextEntries: session.buildSessionProjection().entries },
      entries: [],
    })) as TurnEndEventResult;
    const drafts = result.entries as SessionBoundaryDraft[];
    const chunks = drafts.filter(
      (draft) => draft.type === "custom" && draft.customType === OM_CHUNK,
    );
    const activation = drafts.find(
      (draft) => draft.type === "custom" && draft.customType === OM_ACTIVATION,
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(activation).toBeDefined();
    if (!activation || activation.type !== "custom") throw new Error("missing activation");
    const data = activation.data as ActivationData;
    const total = chunks.reduce(
      (sum, draft) =>
        sum + ((draft.type === "custom" && draft.data) as ChunkData).observationTokens,
      0,
    );
    expect(line(renderer(), data, true)).toContain("* 🔴 (10:00) User asked to fix auth bug");
    expect(total).toBeGreaterThan(0);
    const thousands = total / 1_000;
    expect(line(renderer(), data)).toContain(
      `+${total === 0 ? "0" : thousands % 1 === 0 ? `${thousands}k` : `${thousands.toFixed(1)}k`} obs tokens`,
    );
    const before = session.buildSessionProjection().messages;
    commit(session, [activation]);
    expect(session.buildSessionProjection().messages).toEqual(before);
    commit(
      session,
      drafts.filter((draft) => draft !== activation),
    );
    expect(
      session
        .buildSessionProjection()
        .entries.find(
          (entry) =>
            entry.sourceEntry.type === "custom" && entry.sourceEntry.customType === OM_ACTIVATION,
        )?.messages,
    ).toEqual([]);
  });

  it("indexes an outgoing settle chunk before the boundary commits", async () => {
    const { session, registry, fire, renderer } = extension();
    await fire("session_start", {});
    append(session, user("fix auth"));
    await fire("agent_start", {});
    await fire("context", {});
    append(session, assistantToolCall("first", "read", { path: "src/auth.ts" }));
    append(session, toolResult("first", "read", textOf(7_000)));
    await fire("context", {});
    append(session, assistantToolCall("next", "grep", { q: "auth" }));
    append(session, toolResult("next", "grep", "found"));
    const boundary = {
      context: { contextEntries: session.buildSessionProjection().entries },
      entries: [],
    };
    await fire("turn_end", boundary);
    await vi.waitFor(() => expect(registry.calls).toHaveLength(1));
    await new Promise((resolve) => setImmediate(resolve));
    const result = (await fire("agent_before_settle", boundary)) as TurnEndEventResult;
    const draft = result.entries.find(
      (entry) => entry.type === "custom" && entry.customType === OM_CHUNK,
    );
    expect(draft).toBeDefined();
    if (!draft || draft.type !== "custom") throw new Error("missing chunk");
    const chunk = draft.data as ChunkData;
    const activation: ActivationData = {
      v: 1,
      chunkIds: [chunk.id],
      trigger: "threshold",
      at: 0,
      messageTokens: chunk.messageTokens,
    };
    expect(
      session.getBranch().some((entry) => entry.type === "custom" && entry.customType === OM_CHUNK),
    ).toBe(false);
    expect(line(renderer(), activation, true)).toContain("* 🔴 (10:00) User asked to fix auth bug");
  });
});
