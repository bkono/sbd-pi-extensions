import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHaltHandler } from "./commands/halt.js";
import { createMinionsHandler } from "./commands/minions.js";
import { createSpawnHandler, parseSpawnArgs } from "./commands/spawn.js";
import { getConfig } from "./config.js";
import { PathOverlapLog } from "./coordination/index.js";
import {
  createDelegationHint,
  isComplexDelegationTask,
  shouldInjectDelegationHint,
} from "./delegation.js";
import { createFleetWidgetController, type FleetWidgetController } from "./fleet-widget.js";
import { buildFooterFactory } from "./footer.js";
import { LOG_FILE, logger } from "./logger.js";
import {
  createLifecyclePacketDispatcher,
  MinionCommMailbox,
  ORCHESTRATION_LIFECYCLE_CHANNEL,
  OrchestrationGroupState,
  OrchestrationLifecycleCoordinator,
  type OrchestrationLifecycleEvent,
  PARENT_RECIPIENT_ID,
  SEND_MINION_MESSAGE_TOOL,
  SendMinionMessageParams,
  sendMinionMessage,
} from "./orchestration/index.js";
import { renderCall, renderResult } from "./render.js";
import { minionSpawnMessageRenderer } from "./renderers/minion-spawn.js";
import { renderOrchestrateCall, renderOrchestrateResult } from "./renderers/orchestrate.js";
import {
  getMinionsSkill,
  ORCHESTRATE_GUIDELINE,
  ORCHESTRATE_SIDECAR_GUIDELINES,
  SPAWN_GUIDELINE,
} from "./skill.js";
import { createStatusTracker } from "./status.js";
import { EventBus } from "./subsessions/event-bus.js";
import { SubsessionManager } from "./subsessions/manager.js";
import { getTempSessionPath } from "./subsessions/paths.js";
import { HaltToolParams, halt } from "./tools/halt.js";
import { ListAgentsParams, listAgents } from "./tools/list-agents.js";
import { ListMinionsParams, listMinions, ShowMinionParams, showMinion } from "./tools/minions.js";
import { OrchestrateToolParams, orchestrate } from "./tools/orchestrate.js";
import { SpawnToolParams, spawn } from "./tools/spawn.js";
import { AgentTree, rehydratePersistedMinion } from "./tree.js";

const LearnMinionsParams = Type.Object(
  {},
  { description: "Return the built-in pi-minions spawn and orchestrate skill." },
);

export default function (pi: ExtensionAPI): void {
  logger.debug("extension", "loaded", { logFile: LOG_FILE });

  let tree = new AgentTree();
  let groups = new OrchestrationGroupState();
  let mailbox = new MinionCommMailbox();
  let overlaps = new PathOverlapLog();
  let lifecycleCoordinator: OrchestrationLifecycleCoordinator;
  let subsessionManager: SubsessionManager | undefined;
  let statusTracker: ReturnType<typeof createStatusTracker> | undefined;
  let cachedUi: ExtensionContext["ui"] | null = null;
  let cachedCtx: ExtensionContext | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: external API type
  let cachedModel: Model<any> | undefined;
  let fleetWidget: FleetWidgetController | undefined;
  let sessionGeneration = 0;

  const clearSessionUi = (): void => {
    fleetWidget?.destroy();
    fleetWidget = undefined;
    statusTracker?.destroy();
    statusTracker?.setUi(null);
    statusTracker = undefined;
    cachedUi = null;
    cachedCtx = null;
    cachedModel = undefined;
  };

  const eventBus = new EventBus();
  const packets = createLifecyclePacketDispatcher({
    getTree: () => tree,
    sendMessage: (message, options) => pi.sendMessage(message, options),
    getGroups: () => groups,
    peekOverlaps: (groupIds) => overlaps.peek(groupIds),
    ackOverlaps: (ids) => {
      overlaps.ack(ids);
    },
    peekParentMail: (authority) => {
      const messages = mailbox
        .peekPending(PARENT_RECIPIENT_ID, authority.childId)
        .filter(
          (message) =>
            message.groupId === authority.groupId &&
            message.lifecycleId === authority.lifecycleId &&
            message.lifecycleEpoch === authority.epoch,
        );
      if (messages.length === 0) return undefined;
      return {
        ids: messages.map((message) => message.id),
        text: messages.map((message) => message.body).join("\n\n"),
      };
    },
    ackParentMail: (snapshot) => {
      mailbox.ackPending(PARENT_RECIPIENT_ID, snapshot.ids);
    },
    onAcceptedTerminal: (authority) => lifecycleCoordinator.cleanupAcceptedLifecycle(authority),
  });
  lifecycleCoordinator = new OrchestrationLifecycleCoordinator({
    tree,
    groups,
    mailbox,
    overlaps,
    packets,
  });
  eventBus.on(ORCHESTRATION_LIFECYCLE_CHANNEL, (event: OrchestrationLifecycleEvent) => {
    packets.enqueue(event);
  });

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
      "The agent runs as a file-based foreground session with parent tracking. Blocks this turn until the child completes; use orchestrate for an event-driven supervisor that yields between results.",
    promptSnippet: "Spawn a foreground minion for isolated task delegation",
    promptGuidelines: [
      SPAWN_GUIDELINE,
      ORCHESTRATE_GUIDELINE,
      "To spawn multiple minions in parallel, use the `tasks` array parameter with multiple task descriptors. Each task can specify `task`, optional `agent`, and optional `model`.",
      "For single task delegation, use the `task` parameter directly.",
      "Use list_agents to discover available named agents before spawning by name.",
      "Omit the agent parameter to spawn an ephemeral minion with default capabilities.",
      "When a spawn result says [HALTED], the user intentionally stopped the minion. Do NOT retry, re-spawn, or ask about it. Acknowledge and move on.",
      "Use list_minions and show_minion to answer a specific status or evidence question. For orchestrated work, wait for completion events instead of polling an active child's status.",
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

  const orchestratePromptGuidelines = [
    ORCHESTRATE_GUIDELINE,
    SPAWN_GUIDELINE,
    "For orchestrate, description is required on every task; do not omit it or infer it from task.",
    "For orchestrate, agent is a discovered agent/template name from the same loader as spawn; built-in worker and investigate are always available, and list_agents resolves uncertainty.",
    "For orchestrate, taskType is a closed workflow-policy enum; never collapse agent and taskType.",
    "For orchestrate, omit groupId to create the open group if none exists or to join it; a second groupId is rejected.",
    "For orchestrate, cwd is group-create only, must already exist, and cannot change later.",
    ...ORCHESTRATE_SIDECAR_GUIDELINES,
  ];
  const orchestrateTool = {
    name: "orchestrate",
    label: "Orchestrate Minions",
    description:
      "Register background minion work and return handles immediately. " +
      "Children start in the session's one open group and report later; this tool does not wait. " +
      "Finish registering the selected workers, then end this turn. Do not transition into parent-side preparation or implementation. Results arrive as follow-ups after you yield. " +
      "Each task requires a short description. Persistent hosts only (tui/rpc).",
    promptSnippet: "Dispatch background minions; yield between actionable events",
    promptGuidelines: [...orchestratePromptGuidelines],
    parameters: OrchestrateToolParams,
    execute: async (...args: Parameters<ReturnType<typeof orchestrate>>) => {
      if (!subsessionManager) throw new Error("SubsessionManager not initialized");
      usedMinionsThisSession = true;
      const result = await orchestrate({
        tree,
        pi,
        subsessionManager,
        groups,
        mailbox,
        overlaps,
        onLifecycle: (event) => eventBus.emit(ORCHESTRATION_LIFECYCLE_CHANNEL, event),
      })(...args);
      return result;
    },
    renderCall: renderOrchestrateCall,
    renderResult: renderOrchestrateResult,
  };
  pi.registerTool(orchestrateTool);

  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description: "List available agents for spawn and orchestrate.",
    promptSnippet: "List available agents for spawn and orchestrate",
    parameters: ListAgentsParams,
    execute: listAgents(),
  });

  pi.registerTool({
    name: SEND_MINION_MESSAGE_TOOL,
    label: "Send Minion Message",
    description:
      "Send a non-blocking message to a live orchestrated child in the open group. " +
      "Does not wait for a reply. Not available to children.",
    promptSnippet: "Message a live orchestrated minion without waiting",
    promptGuidelines: [
      "Messages succeed only while the recipient is live. Do not wait for a reply.",
      "Parent-to-child mail does not start a parent turn.",
    ],
    parameters: SendMinionMessageParams,
    execute: (...args) => {
      if (!subsessionManager) throw new Error("SubsessionManager not initialized");
      return sendMinionMessage({ mailbox, groups })(...args);
    },
  });

  pi.registerTool({
    name: "halt",
    label: "Halt Minion",
    description:
      "Abort a running minion by ID or name, an orchestration group, or all running minions. " +
      "Use id='all' to halt everyone. Use id='group' or a groupId to halt orchestrated members and forget the open group. " +
      "Halt does not exit Beadwork goal mode.",
    parameters: HaltToolParams,
    execute: async (...args) => {
      if (!subsessionManager) throw new Error("SubsessionManager not initialized");
      const result = await halt(tree, subsessionManager, groups, lifecycleCoordinator)(...args);
      return result;
    },
  });

  pi.registerTool({
    name: "list_minion_types",
    label: "List Minion Types",
    description: "List available agent types for spawn and orchestrate.",
    promptSnippet: "List available minion types",
    parameters: ListAgentsParams,
    execute: listAgents(),
  });

  pi.registerTool({
    name: "list_minions",
    label: "List Minions",
    description:
      "Inspect spawn and orchestrated minions for a user's status question, context recovery, or a concrete coordination decision. " +
      "Includes agent, taskType, group, and last activity. For completion monitoring, wait for the event instead of polling an active child's status.",
    promptSnippet: "Inspect minions for a specific question; wait for events to monitor completion",
    promptGuidelines: [
      "Use list_minions for a user's status question, context recovery, or a concrete coordination decision. Once the question is answered, yield; wait for the completion event instead of polling an active child's status.",
    ],
    parameters: ListMinionsParams,
    execute: (...args) => listMinions(tree)(...args),
  });

  pi.registerTool({
    name: "show_minion",
    label: "Show Minion",
    description:
      "Retrieve specific evidence missing from a delivered packet or investigate a concrete problem by minion ID or name. " +
      "Returns status, output, messages, path intent, and activity. Wait for the completion event instead of repeatedly inspecting an active child's status.",
    promptGuidelines: [
      "Use show_minion only when a specific evidence question needs it; evaluate the supplied lifecycle packet first. Inspection is read-only and does not acknowledge pending follow-ups. For completion monitoring, yield and wait for the event.",
    ],
    parameters: ShowMinionParams,
    execute: (...args) => showMinion(tree, subsessionManager)(...args),
  });

  pi.registerTool({
    name: "learn_minions",
    label: "Learn Minions",
    description:
      "Learn blocking versus yielding, the event-driven supervisor loop, and how to evaluate results. Read before first delegation or when recovering unclear orchestration state after compaction.",
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
    description: "Halt minion(s): /halt <id | name | group | all>",
    handler: async (args, ctx) => {
      if (!subsessionManager) throw new Error("SubsessionManager not initialized");
      await createHaltHandler(tree, subsessionManager, groups, lifecycleCoordinator)(args, ctx);
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
    sessionGeneration++;
    clearSessionUi();
    lifecycleCoordinator.discardOpenGroup();
    packets.close();
    const manager = subsessionManager;
    subsessionManager = undefined;
    await manager?.disposeAll();
  });

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++sessionGeneration;
    clearSessionUi();
    lifecycleCoordinator.discardOpenGroup();
    packets.close();
    const priorManager = subsessionManager;
    subsessionManager = undefined;
    await priorManager?.disposeAll();
    if (generation !== sessionGeneration) return;

    cachedCtx = ctx;
    cachedModel = ctx.model;
    cachedUi = ctx.ui;
    usedMinionsThisSession = false;
    toolCallCount = 0;
    lastHintTime = 0;

    const parentSessionPath = ctx.sessionManager?.getSessionFile() ?? getTempSessionPath(ctx.cwd);
    const manager = new SubsessionManager(ctx.cwd, parentSessionPath, eventBus);
    subsessionManager = manager;

    tree = new AgentTree();
    groups = new OrchestrationGroupState();
    mailbox = new MinionCommMailbox({
      getTree: () => tree,
      getGroups: () => groups,
      isLive: (id) => subsessionManager?.isLive(id) === true,
      followUp: async (id, text) => {
        const handle = subsessionManager?.getSessionHandle(id);
        if (!handle) {
          throw new Error(`Child ${id} is terminal; further mail is rejected`);
        }
        await handle.followUp(text);
      },
      onParentDirected: (message) => {
        if (message.lifecycleId === undefined || message.lifecycleEpoch === undefined) return;
        eventBus.emit(ORCHESTRATION_LIFECYCLE_CHANNEL, {
          class: "parentMessage",
          groupId: message.groupId,
          childId: message.from,
          output: message.body,
          lifecycleId: message.lifecycleId,
          epoch: message.lifecycleEpoch,
        });
      },
    });
    overlaps = new PathOverlapLog();
    lifecycleCoordinator = new OrchestrationLifecycleCoordinator({
      tree,
      groups,
      mailbox,
      overlaps,
      packets,
    });
    packets.open();

    for (const metadata of manager.list()) {
      if (metadata.parentSession === parentSessionPath) {
        rehydratePersistedMinion(tree, metadata, (id, status, exitCode, error) => {
          manager.updateStatus(id, status, exitCode, error);
        });
        const history = manager.parseSessionHistory(metadata.sessionId);
        if (history.length > 0) tree.setActivityHistory(metadata.sessionId, history);
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
    if (ctx.mode === "tui") {
      fleetWidget = createFleetWidgetController(tree, groups, cachedUi);
    }

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
