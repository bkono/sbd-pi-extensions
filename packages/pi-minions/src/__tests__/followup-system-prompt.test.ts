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
import {
  createLiveGroupPromptHandler,
  formatLiveGroupInvariant,
  LiveGroupSystemPromptController,
} from "../live-group-invariant.js";
import { OrchestrationGroupState } from "../orchestration/group-state.js";
import { AgentTree } from "../tree.js";

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

describe("Pi 0.84.3 followUp system-prompt boundary", () => {
  it("carries the live invariant through direct lifecycle followUp despite bypassing before_agent_start", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-followup-"));
    const agentDir = join(cwd, ".pi-agent");
    dirs.push(cwd);
    const tree = new AgentTree();
    const groups = new OrchestrationGroupState();
    const contexts: Context[] = [];
    let beforeAgentStartCalls = 0;
    let controller: LiveGroupSystemPromptController | undefined;

    const livePromptExtension = (pi: ExtensionAPI): void => {
      const baseGuidelines = ["Preserve this independent extension-style base contribution."];
      const tool = {
        name: "runtime_prompt_host",
        label: "Runtime prompt host",
        description: "Hosts a dynamic system-prompt guideline for this runtime regression.",
        promptGuidelines: [...baseGuidelines],
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text" as const, text: "ok" }], details: undefined };
        },
      };
      controller = new LiveGroupSystemPromptController(
        () => tree,
        () => groups,
        (invariant) => {
          tool.promptGuidelines = invariant ? [...baseGuidelines, invariant] : [...baseGuidelines];
          pi.registerTool(tool);
        },
      );
      pi.registerTool(tool);
      const before = createLiveGroupPromptHandler(
        () => tree,
        () => groups,
      );
      pi.on("before_agent_start", (event) => {
        beforeAgentStartCalls++;
        return before(event);
      });
    };

    const otherPromptExtension = (pi: ExtensionAPI): void => {
      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\nOther extension per-turn contribution.`,
      }));
    };

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [livePromptExtension, otherPromptExtension],
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
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const session = new AgentSession({
      agent,
      cwd,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      modelRuntime: {
        getAuth: async () => ({ auth: { apiKey: "test" }, env: {} }),
        isUsingOAuth: () => false,
        hasConfiguredAuth: () => true,
      } as unknown as ModelRuntime,
      initialActiveToolNames: [],
    });
    await session.bindExtensions({});

    groups.commitGroup({ groupId: "grp-runtime", cwd });
    tree.add("mn-runtime", "runtime", "task", {
      kind: "orchestrated",
      groupId: "grp-runtime",
      description: "runtime child",
      status: "running",
    });
    groups.acceptLiveWork("grp-runtime", ["mn-runtime"]);
    controller?.sync();

    await session.sendCustomMessage(
      { customType: "minion-lifecycle", content: "lifecycle", display: true },
      { triggerTurn: true, deliverAs: "followUp" },
    );

    expect(beforeAgentStartCalls).toBe(0);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.systemPrompt).toContain(formatLiveGroupInvariant("grp-runtime"));
    expect(contexts[0]?.systemPrompt).toContain("independent extension-style base contribution");

    await session.prompt("normal parent prompt");
    expect(beforeAgentStartCalls).toBe(1);
    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.systemPrompt).toContain(formatLiveGroupInvariant("grp-runtime"));
    expect(contexts[1]?.systemPrompt).toContain("Other extension per-turn contribution");
    expect(contexts[1]?.systemPrompt?.match(/Background orchestration work is live/g)).toHaveLength(
      1,
    );

    tree.updateStatus("mn-runtime", "completed", 0);
    controller?.sync();
    await session.sendCustomMessage(
      { customType: "minion-lifecycle", content: "idle", display: true },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    expect(contexts).toHaveLength(3);
    expect(contexts[2]?.systemPrompt).not.toContain("Background orchestration work is live");
    expect(contexts[2]?.systemPrompt).toContain("independent extension-style base contribution");

    session.dispose();
  });
});
