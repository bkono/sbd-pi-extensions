import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHaltHandler } from "./commands/halt.js";
import { createMinionsHandler } from "./commands/minions.js";
import { createSpawnHandler, parseSpawnArgs } from "./commands/spawn.js";
import { getConfig } from "./config.js";
import {
  createDelegationHint,
  isComplexDelegationTask,
  shouldInjectDelegationHint,
} from "./delegation.js";
import { buildFooterFactory } from "./footer.js";
import { LOG_FILE, logger } from "./logger.js";
import { ORCHESTRATION_LIFECYCLE_CHANNEL, OrchestrationGroupState } from "./orchestration/index.js";
import { renderCall, renderResult } from "./render.js";
import { minionSpawnMessageRenderer } from "./renderers/minion-spawn.js";
import { getMinionsSkill } from "./skill.js";
import { createStatusTracker } from "./status.js";
import { EventBus } from "./subsessions/event-bus.js";
import { SubsessionManager } from "./subsessions/manager.js";
import { getTempSessionPath } from "./subsessions/paths.js";
import { HaltToolParams, halt } from "./tools/halt.js";
import { ListAgentsParams, listAgents } from "./tools/list-agents.js";
import { ListMinionsParams, listMinions, ShowMinionParams, showMinion } from "./tools/minions.js";
import { OrchestrateToolParams, orchestrate } from "./tools/orchestrate.js";
import { SpawnToolParams, spawn } from "./tools/spawn.js";
import { AgentTree } from "./tree.js";

const LearnMinionsParams = Type.Object(
  {},
  { description: "Return the built-in pi-minions foreground delegation skill." },
);

export default function (pi: ExtensionAPI): void {
  logger.debug("extension", "loaded", { logFile: LOG_FILE });

  let tree = new AgentTree();
  let groups = new OrchestrationGroupState();
  let subsessionManager: SubsessionManager | undefined;
  let statusTracker: ReturnType<typeof createStatusTracker> | undefined;
  let cachedUi: ExtensionContext["ui"] | null = null;
  let cachedCtx: ExtensionContext | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: external API type
  let cachedModel: Model<any> | undefined;

  const eventBus = new EventBus();

  let toolCallCount = 0;
  let lastHintTime = 0;
  let usedMinionsThisSession = false;

  pi.registerTool({
    name: "spawn",
    label: "Spawn Minion",
    description:
      "Delegate a task to a named agent or an ephemeral minion with isolated foreground context. " +
      "If no agent name is provided, spawns an ephemeral minion with default capabilities. " +
      "Agents are discovered from global and project agent/minion directories, including ~/.pi/agent/{agents,minions}/, ~/.agents/{agents,minions}/, .pi/{agents,minions}/, and .agents/{agents,minions}/. " +
      "The agent runs as a file-based foreground session with parent tracking.",
    promptSnippet: "Spawn a foreground minion for isolated task delegation",
    promptGuidelines: [
      "Use spawn for foreground task delegation. The tool blocks until the minion completes and returns its result.",
      "Use spawn when you intend to wait. Use orchestrate for background work that should not block this turn.",
      "To spawn multiple minions in parallel, use the `tasks` array parameter with multiple task descriptors. Each task can specify `task`, optional `agent`, and optional `model`.",
      "For single task delegation, use the `task` parameter directly.",
      "Use list_agents to discover available named agents before spawning by name.",
      "Omit the agent parameter to spawn an ephemeral minion with default capabilities.",
      "When a spawn result says [HALTED], the user intentionally stopped the minion. Do NOT retry, re-spawn, or ask about it. Acknowledge and move on.",
      "Use list_minions and show_minion to inspect foreground minion activity.",
    ],
    parameters: SpawnToolParams,
    execute: (...args) => {
      if (!subsessionManager) throw new Error("SubsessionManager not initialized");
      const params = args[1] as { task?: unknown; tasks?: unknown } | undefined;
      const hasTask = typeof params?.task === "string" && params.task.trim().length > 0;
      const hasTasks = Array.isArray(params?.tasks) && params.tasks.length > 0;
      if ((hasTask || hasTasks) && !(hasTask && hasTasks)) {
        usedMinionsThisSession = true;
      }
      return spawn(tree, pi, subsessionManager)(...args);
    },
    renderCall,
    renderResult,
  });

  pi.registerTool({
    name: "orchestrate",
    label: "Orchestrate Minions",
    description:
      "Register background minion work and return handles immediately. " +
      "Children start in the session's one open group and report later; this tool does not wait. " +
      "Each task requires a short description. Persistent hosts only (tui/rpc).",
    promptSnippet: "Orchestrate background minions without waiting",
    promptGuidelines: [
      "Use orchestrate for background work that should not block this turn. It returns handles immediately; results arrive later.",
      "Use spawn when you intend to wait for the minion to finish before continuing.",
      "description is required on every task. Do not omit it or infer it from task.",
      "Omit groupId to create the open group if none exists, otherwise join it. A second groupId is rejected.",
      "cwd is group-create only, must already exist, and cannot change later.",
    ],
    parameters: OrchestrateToolParams,
    execute: (...args) => {
      if (!subsessionManager) throw new Error("SubsessionManager not initialized");
      usedMinionsThisSession = true;
      return orchestrate({
        tree,
        pi,
        subsessionManager,
        groups,
        extraTools: [],
        onLifecycle: (event) => eventBus.emit(ORCHESTRATION_LIFECYCLE_CHANNEL, event),
      })(...args);
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description: "List available agents that can be spawned as minions.",
    promptSnippet: "List available agents for spawning",
    parameters: ListAgentsParams,
    execute: listAgents(),
  });

  pi.registerTool({
    name: "halt",
    label: "Halt Minion",
    description: "Abort a running minion by ID. Use id='all' to halt all running minions.",
    parameters: HaltToolParams,
    execute: (...args) => {
      if (!subsessionManager) throw new Error("SubsessionManager not initialized");
      return halt(tree, subsessionManager)(...args);
    },
  });

  pi.registerTool({
    name: "list_minion_types",
    label: "List Minion Types",
    description: "List available agent types that can be spawned as minions.",
    promptSnippet: "List available minion types",
    parameters: ListAgentsParams,
    execute: listAgents(),
  });

  pi.registerTool({
    name: "list_minions",
    label: "List Minions",
    description: "List all foreground minions in the current session.",
    promptSnippet: "List all current foreground minions",
    promptGuidelines: [
      "Use list_minions to check what foreground minions are currently running or recently completed before spawning new ones.",
    ],
    parameters: ListMinionsParams,
    execute: (...args) => listMinions(tree)(...args),
  });

  pi.registerTool({
    name: "show_minion",
    label: "Show Minion",
    description: "Show detailed status, activity, and output of a minion by ID or name.",
    parameters: ShowMinionParams,
    execute: (...args) => showMinion(tree)(...args),
  });

  pi.registerTool({
    name: "learn_minions",
    label: "Learn Minions",
    description: "Return concise guidance for using pi-minions foreground delegation.",
    promptSnippet: "Learn how to use pi-minions",
    parameters: LearnMinionsParams,
    execute: async () => ({
      content: [{ type: "text", text: getMinionsSkill() }],
      details: undefined,
    }),
  });

  logger.debug("extension", "registering-renderers");
  pi.registerMessageRenderer("minion-spawn", minionSpawnMessageRenderer);
  logger.debug("extension", "renderers-registered");

  pi.registerCommand("spawn", {
    description: "Spawn a foreground minion: /spawn <task> [--model <model>]",
    handler: async (args, ctx) => {
      const parsed = parseSpawnArgs(args);
      if (!("error" in parsed)) usedMinionsThisSession = true;
      return createSpawnHandler(pi)(args, ctx);
    },
  });

  pi.registerCommand("minions", {
    description: "Manage minions: /minions [help] for more information",
    handler: (args, ctx) => createMinionsHandler(tree, eventBus)(args, ctx),
  });

  pi.registerCommand("halt", {
    description: "Halt minion(s): /halt <id | name | all>",
    handler: (args, ctx) => {
      if (!subsessionManager) throw new Error("SubsessionManager not initialized");
      return createHaltHandler(tree, subsessionManager)(args, ctx);
    },
  });

  pi.on("tool_execution_end", (event) => {
    logger.debug("status", "tool_execution_end", { tool: event.toolName });
    statusTracker?.refresh();
  });

  pi.on("tool_call", async () => {
    toolCallCount++;
  });

  pi.on("before_agent_start", (event, ctx) => {
    const config = getConfig(ctx);
    if (!config.delegation.enabled) return;

    const prompt = event.prompt;
    const now = Date.now();
    const isComplexTask = isComplexDelegationTask({
      toolCallCount,
      prompt,
      config: config.delegation,
    });

    if (
      !shouldInjectDelegationHint({
        usedMinionsThisSession,
        isComplexTask,
        now,
        lastHintTime,
        hintIntervalMinutes: config.delegation.hintIntervalMinutes,
      })
    ) {
      return;
    }

    logger.debug("delegation", "injecting_hint", {
      toolCallCount,
      promptLength: prompt.length,
      isComplexTask,
      timeSinceLastHint: now - lastHintTime,
      usedMinionsThisSession,
    });

    lastHintTime = now;
    const hint = createDelegationHint(toolCallCount, config.delegation);
    toolCallCount = 0;

    return { systemPrompt: `${event.systemPrompt}\n\n${hint}` };
  });

  pi.on("session_shutdown", async () => {
    await subsessionManager?.disposeAll();
    subsessionManager = undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    await subsessionManager?.disposeAll();
    cachedCtx = ctx;
    cachedModel = ctx.model;
    cachedUi = ctx.ui;
    usedMinionsThisSession = false;
    toolCallCount = 0;
    lastHintTime = 0;
    statusTracker?.destroy();

    const parentSessionPath = ctx.sessionManager?.getSessionFile() ?? getTempSessionPath(ctx.cwd);
    subsessionManager = new SubsessionManager(ctx.cwd, parentSessionPath, eventBus);

    tree = new AgentTree();
    groups = new OrchestrationGroupState();

    for (const metadata of subsessionManager.list()) {
      if (metadata.parentSession === parentSessionPath) {
        tree.add(metadata.sessionId, metadata.name, metadata.task, undefined, metadata.agent);
        const history = subsessionManager.parseSessionHistory(metadata.sessionId);
        if (history.length > 0) tree.setActivityHistory(metadata.sessionId, history);
        if (metadata.status !== "running") {
          tree.updateStatus(metadata.sessionId, metadata.status, metadata.exitCode, metadata.error);
        }
      }
    }

    logger.debug("session", "subsession-manager-created", {
      cwd: ctx.cwd,
      parentSession: parentSessionPath,
      isTemp: !ctx.sessionManager?.getSessionFile(),
    });

    statusTracker = createStatusTracker(tree, subsessionManager, ctx);
    tree.onChange(() => statusTracker?.refresh());
    statusTracker.setUi(cachedUi);

    cachedUi.setStatus("minions-bg", undefined);
    cachedUi.setStatus("minions-fg", undefined);

    cachedUi.setFooter(
      buildFooterFactory({
        getCtx: () => cachedCtx,
        getModel: () => cachedModel,
        getThinkingLevel: () => pi.getThinkingLevel(),
        tree,
      }),
    );
  });

  pi.on("model_select", async (event, ctx) => {
    cachedUi = ctx.ui;
    cachedModel = event.model;

    cachedUi.setFooter(
      buildFooterFactory({
        getCtx: () => cachedCtx,
        getModel: () => cachedModel,
        getThinkingLevel: () => pi.getThinkingLevel(),
        tree,
      }),
    );
  });
}
