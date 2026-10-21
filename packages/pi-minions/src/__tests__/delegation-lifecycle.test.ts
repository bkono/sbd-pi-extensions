import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import registerMinions from "../index.js";

vi.mock("../config.js", () => ({
  getConfig: () => ({
    delegation: {
      enabled: true,
      toolCallThreshold: 2,
      promptLengthThreshold: 100,
      complexTaskKeywords: [],
      hintIntervalMinutes: 8,
      message: "fixture-count={toolCallCount}",
    },
  }),
}));

describe("delegation lifecycle", () => {
  it("skips custom starts without consuming the tool count or user hint interval", async () => {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    registerMinions({
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        handlers.set(name, handler);
      },
    } as unknown as ExtensionAPI);
    const ctx = {} as ExtensionContext;
    const start = (event: BeforeAgentStartEvent) => handlers.get("before_agent_start")!(event, ctx);
    const systemPromptOptions = {
      cwd: "/fixture",
      selectedTools: [],
      hiddenTools: [],
      toolSnippets: {},
      toolGuidelines: {},
      promptGuidelines: [],
      appendSystemPrompt: "",
      sections: {},
      contextFiles: [],
      skills: [],
    };
    const custom: BeforeAgentStartEvent = {
      type: "before_agent_start",
      messageType: "custom",
      systemPrompt: "fixture-base",
      systemPromptOptions,
      message: {
        role: "custom",
        customType: "minion-lifecycle",
        content: "fixture-result",
        display: true,
        timestamp: 1,
      },
    };
    const user: BeforeAgentStartEvent = {
      type: "before_agent_start",
      messageType: "user",
      systemPrompt: "fixture-base",
      systemPromptOptions,
      prompt: "continue",
      images: undefined,
    };

    expect(start(custom)).toBeUndefined();
    expect(start(user)).toBeUndefined();
    await handlers.get("tool_call")!({}, ctx);
    await handlers.get("tool_call")!({}, ctx);
    expect(start(custom)).toBeUndefined();
    expect(start(user)).toEqual({ systemPrompt: "fixture-base\n\nfixture-count=2" });
    expect(start(user)).toBeUndefined();
  });
});
