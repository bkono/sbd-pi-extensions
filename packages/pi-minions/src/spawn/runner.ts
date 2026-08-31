import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bindTreeActivity, lastNarrativeLine } from "../activity.js";
import { requireAgent } from "../agents.js";
import { logger } from "../logger.js";
import { defaultMinionTemplate } from "../minions.js";
import { runMinionSession } from "../spawn.js";
import type { SubsessionManager } from "../subsessions/manager.js";
import type { BatchMinionItem } from "../tools/spawn.js";
import type { AgentTree } from "../tree.js";
import type { AgentConfig } from "../types.js";
import type { BatchCoordinator } from "./batch.js";

function resolveAgentConfig(agentName: string, cwd: string): AgentConfig {
  return requireAgent(agentName, cwd);
}

function formatModelReference(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function resolveModelReference(
  modelReference: string | undefined,
  ctx: ExtensionContext,
): Model<Api> | undefined {
  if (!modelReference?.trim()) return ctx.model;

  const requested = modelReference.trim();
  const availableModels = ctx.modelRegistry.getAll();

  if (requested.includes("/")) {
    const [provider, ...idParts] = requested.split("/");
    const modelId = idParts.join("/");
    const found = provider ? ctx.modelRegistry.find(provider, modelId) : undefined;
    if (found) return found;
  }

  const exactMatches = availableModels.filter(
    (model) =>
      model.id === requested ||
      model.name === requested ||
      formatModelReference(model) === requested,
  );

  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) {
    throw new Error(
      `Model reference "${requested}" is ambiguous. Use provider/model, e.g. ${exactMatches
        .slice(0, 5)
        .map(formatModelReference)
        .join(", ")}.`,
    );
  }

  const available = availableModels.slice(0, 20).map(formatModelReference).join(", ");
  throw new Error(
    `Model "${requested}" not found. Use a known provider/model reference. Available examples: ${
      available || "none"
    }`,
  );
}

export async function runSingleMinion(opts: {
  spec: { task: string; agent?: string; model?: string };
  m: BatchMinionItem;
  isSingleMinion: boolean;
  toolCallId: string;
  controller: AbortController;
  tree: AgentTree;
  ctx: ExtensionContext;
  piConfig: {
    toolSync: { enabled: boolean; maxWait: number };
  };
  parentToolNames: string[];
  subsessionManager: SubsessionManager;
  coordinator: BatchCoordinator;
}): Promise<{
  success: boolean;
  result?: import("../types.js").SpawnResult;
  error?: string;
}> {
  const {
    spec,
    m,
    isSingleMinion,
    toolCallId,
    controller,
    tree,
    ctx,
    piConfig,
    parentToolNames,
    subsessionManager,
    coordinator,
  } = opts;

  try {
    const config = spec.agent
      ? resolveAgentConfig(spec.agent, ctx.cwd)
      : defaultMinionTemplate(m.name, { model: spec.model });

    const requestedModel = spec.model ?? config.model;
    const selectedModel = resolveModelReference(requestedModel, ctx);
    if (requestedModel && selectedModel) {
      m.model = formatModelReference(selectedModel);
    }

    coordinator.emit(true);

    const bound = bindTreeActivity(tree, m.id);
    const result = await runMinionSession(config, spec.task, {
      id: m.id,
      name: m.name,
      signal: controller.signal,
      modelRegistry: ctx.modelRegistry,
      parentModel: selectedModel,
      cwd: ctx.cwd,
      subsessionManager,
      spawnedBy: toolCallId,
      parentSessionPath: ctx.sessionManager?.getSessionFile() ?? undefined,
      parentToolNames,
      toolSyncEnabled: piConfig.toolSync.enabled,
      toolSyncMaxWait: piConfig.toolSync.maxWait * 1000,
      tree,
      onToolActivity: (activity) => {
        bound.onToolActivity(activity);
        if (activity.type === "start") {
          m.activity = tree.get(m.id)?.lastActivity;
          coordinator.emit(true);
        }
      },
      onToolOutput: bound.onToolOutput,
      onTextDelta: (delta, fullText) => {
        bound.onTextDelta(delta, fullText);
        m.finalOutput = lastNarrativeLine(fullText);
        coordinator.emit(true);
      },
      onTurnEnd: bound.onTurnEnd,
      onAgentEnd: bound.onAgentEnd,
      onUsageUpdate: (usage) => {
        tree.updateUsage(m.id, usage);
        m.usage = {
          ...m.usage,
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          cost: usage.cost,
        };
        coordinator.emit(true);
      },
    });

    const resultStatus = result.status ?? (result.exitCode === 0 ? "completed" : "failed");
    m.status = resultStatus;
    m.finalOutput = result.finalOutput;
    m.usage = result.usage;
    tree.updateStatus(m.id, resultStatus, result.exitCode, result.error);
    tree.updateUsage(m.id, result.usage);
    coordinator.emit(true);

    if (!isSingleMinion) {
      logger.debug("spawn:tool", "batch-minion-finished", {
        id: m.id,
        name: m.name,
        status: m.status,
        exitCode: result.exitCode,
      });
    }

    return { success: result.exitCode === 0, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    m.status = "failed";
    m.finalOutput = msg;
    tree.updateStatus(m.id, "failed", 1, msg);
    logger.error("spawn:tool", isSingleMinion ? "failed" : "batch-minion-failed", {
      id: m.id,
      name: m.name,
      error: msg,
    });
    return { success: false, error: msg };
  }
}
