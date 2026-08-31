import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import {
  AgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { ORCHESTRATE_SIDECAR_GUIDELINES } from "../skill.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function assistant(model: Model<any>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function fakeModel(): Model<any> {
  return {
    id: "runtime-test",
    name: "Runtime test",
    api: "runtime-test",
    provider: "runtime-test",
    baseUrl: "https://invalid.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 1_000,
  };
}

describe("orchestrate system-prompt policy", () => {
  it("keeps one static invariant across lifecycle follow-ups and normal parent turns", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-static-prompt-"));
    const agentDir = join(cwd, ".pi-agent");
    dirs.push(cwd);
    const contexts: Context[] = [];
    let registrations = 0;

    const extension = (pi: ExtensionAPI): void => {
      registrations++;
      pi.registerTool({
        name: "orchestrate",
        label: "Orchestrate",
        description: "Register background work.",
        promptGuidelines: [...ORCHESTRATE_SIDECAR_GUIDELINES],
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text" as const, text: "ok" }], details: undefined };
        },
      });
    };

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [extension],
    });
    await loader.reload();

    const model = fakeModel();
    const agent = new Agent({
      initialState: { model, thinkingLevel: "off" },
      streamFn: (_model, context) => {
        contexts.push(context);
        const stream = createAssistantMessageEventStream();
        const message = assistant(model);
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      },
    });
    const session = new AgentSession({
      agent,
      cwd,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.create(cwd, agentDir),
      modelRuntime: {
        getAuth: async () => ({ auth: { apiKey: "test" }, env: {} }),
        isUsingOAuth: () => false,
        hasConfiguredAuth: () => true,
      } as unknown as ModelRuntime,
      initialActiveToolNames: ["orchestrate"],
    });
    await session.bindExtensions({});

    await session.sendCustomMessage(
      {
        customType: "minion-lifecycle",
        content: "Group grp-runtime has active children.",
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    await session.sendCustomMessage(
      {
        customType: "minion-lifecycle",
        content: "Group grp-runtime is idle and ready for adjudication.",
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    await session.prompt("Inspect lifecycle evidence and decide the next action.");

    expect(registrations).toBe(1);
    expect(contexts).toHaveLength(3);
    const prompts = contexts.map((context) => context.systemPrompt);
    expect(new Set(prompts).size).toBe(1);
    for (const guideline of ORCHESTRATE_SIDECAR_GUIDELINES) {
      expect(prompts[0]).toContain(guideline);
      expect(guideline).toMatch(/\borchestrate\b/i);
    }
    expect(prompts[0]).not.toContain("grp-runtime");
    expect(prompts[0]).not.toContain("Background orchestration work is live in group");

    session.dispose();
  });
});
