import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import registerMinions from "../index.js";

// A system-prompt rewrite that comes and goes between runs moves the provider's cached prefix
// and forfeits the prompt cache from that point on. pi-minions must never rewrite it.
describe("system prompt stability", () => {
  it("never rewrites the system prompt, however many tool calls or how complex the prompt", async () => {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    registerMinions({
      events: createEventBus(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        handlers.set(name, handler);
      },
    } as unknown as ExtensionAPI);
    const ctx = { cwd: mkdtempSync(join(tmpdir(), "pi-minions-prompt-")) } as ExtensionContext;
    const user: BeforeAgentStartEvent = {
      type: "before_agent_start",
      messageType: "user",
      systemPrompt: "fixture-base",
      systemPromptOptions: {
        cwd: ctx.cwd,
        selectedTools: [],
        hiddenTools: [],
        toolSnippets: {},
        toolGuidelines: {},
        promptGuidelines: [],
        appendSystemPrompt: "",
        sections: {},
        contextFiles: [],
        skills: [],
      },
      prompt: `refactor and audit the whole service. ${"x".repeat(5_000)}`,
      images: undefined,
    };
    const start = handlers.get("before_agent_start");
    for (let run = 0; run < 3; run++) {
      for (let i = 0; i < 20; i++) await handlers.get("tool_call")?.({}, ctx);
      const result = (await start?.(user, ctx)) as { systemPrompt?: string } | undefined;
      expect(result?.systemPrompt ?? user.systemPrompt).toBe("fixture-base");
    }
  });
});
