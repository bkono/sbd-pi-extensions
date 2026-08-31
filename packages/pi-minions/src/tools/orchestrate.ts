import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { bindTreeActivity } from "../activity.js";
import { findAgent, unknownAgentMessage } from "../agents.js";
import { getConfig, type ResolvedConfig } from "../config.js";
import type { PathOverlapLog } from "../coordination/index.js";
import { logger } from "../logger.js";
import { defaultMinionTemplate, generateId, pickMinionName } from "../minions.js";
import {
  type InjectedCommTools,
  injectOrchestratedCommTools,
  isResolveGroupReject,
  MinionCommMailbox,
  type OrchestrationGroupState,
  type OrchestrationLifecycleEvent,
} from "../orchestration/index.js";
import { formatOrchestrateText } from "../renderers/orchestrate.js";
import { installSessionTimeout, resolveEffectiveTimeout } from "../session-timeout.js";
import { applyStepLimit } from "../step-limit.js";
import type { SubsessionManager } from "../subsessions/manager.js";
import { TASK_TYPES } from "../task-types.js";
import { type AgentTree, isTerminalStatus } from "../tree.js";
import type {
  AgentConfig,
  OrchestratedTaskDescriptor,
  OrchestrateInput,
  OrchestrateResult,
  TaskType,
} from "../types.js";
import { OrchestrateInputSchema } from "../types.js";

export const OrchestrateToolParams = OrchestrateInputSchema;

/** print/json hosts die after the prompt; orchestrate needs a live tui/rpc process. */
export const ORCHESTRATE_REJECT_REASONS = {
  nonPersistentHost: "orchestrate requires a persistent host (tui or rpc)",
  missingDescription: "missing description",
  missingTask: "missing task",
  unknownTaskType: "unknown taskType",
  duplicateWorkItemId: "duplicate workItemId",
  unknownAgent: "unknown agent",
  unknownModel: "unknown model",
  ephemeralDisabled: "ephemeral minions are disabled",
  registrationAborted: "registration aborted",
} as const;

export type OrchestrateRejectReason =
  (typeof ORCHESTRATE_REJECT_REASONS)[keyof typeof ORCHESTRATE_REJECT_REASONS];

export function isPersistentHost(mode: string): boolean {
  return mode === "tui" || mode === "rpc";
}

export interface OrchestrateDeps {
  tree: AgentTree;
  pi: Pick<ExtensionAPI, "getAllTools">;
  subsessionManager: Pick<SubsessionManager, "startChild" | "getSessionHandle" | "abortSession">;
  groups: OrchestrationGroupState;
  /**
   * Additional extra-tool names unioned with bound comm names.
   * Do not use this to rewrite allowlist math.
   */
  extraTools?: readonly string[];
  /** Shared in-process mailbox. 3.2 owns live delivery. */
  mailbox?: MinionCommMailbox;
  /** Pending overlap notices for the next real parent packet. */
  overlaps?: PathOverlapLog;
  now?: () => number;
  /** Override bound-tool injection. Default binds list/send/announce/inspect with childId closed over. */
  injectCommTools?: (input: { childId: string; groupId: string }) => InjectedCommTools;
  /** Event path 1.8 consumes. Do not deliver parent packets here. */
  onLifecycle?: (event: OrchestrationLifecycleEvent) => void;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && (TASK_TYPES as readonly string[]).includes(value);
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
    throw new Error(ORCHESTRATE_REJECT_REASONS.unknownModel);
  }

  throw new Error(ORCHESTRATE_REJECT_REASONS.unknownModel);
}

function resolveAgentConfig(
  agent: string | undefined,
  name: string,
  model: string | undefined,
  cwd: string,
): AgentConfig | { reject: string } {
  if (!agent) return defaultMinionTemplate(name, { model });
  const found = findAgent(agent, cwd);
  if (!found) return { reject: unknownAgentMessage(agent) };
  return found;
}

function allRejectedError(rejected: OrchestrateResult["rejected"]): Error {
  return new Error(
    formatOrchestrateText({
      groupId: "",
      accepted: [],
      rejected,
    }),
  );
}

function logOrchestrate(
  msg: string,
  data: {
    groupId?: string;
    childId?: string;
    hostMode: string;
    accepted: number;
    rejected: number;
    reasons: string[];
  },
): void {
  logger.info("orchestrate", msg, data);
}

interface RegisteredChild {
  id: string;
  name: string;
  task: OrchestratedTaskDescriptor;
  config: AgentConfig;
  parentModel: Model<Api> | undefined;
}

function injectBoundCommTools(
  deps: OrchestrateDeps,
  mailbox: MinionCommMailbox,
  group: { groupId: string; cwd: string },
  childId: string,
): InjectedCommTools {
  if (deps.injectCommTools) return deps.injectCommTools({ childId, groupId: group.groupId });
  return injectOrchestratedCommTools({
    childId,
    groupId: group.groupId,
    cwd: group.cwd,
    tree: deps.tree,
    mailbox,
    overlaps: deps.overlaps,
    now: deps.now,
    kind: "orchestrated",
  });
}

function startRegisteredChild(
  deps: OrchestrateDeps,
  mailbox: MinionCommMailbox,
  ctx: ExtensionContext,
  group: { groupId: string; cwd: string },
  toolCallId: string,
  parentToolNames: string[],
  child: RegisteredChild,
  piConfig: ResolvedConfig,
): Promise<void> {
  const { tree, subsessionManager } = deps;
  const { id, name, task, config, parentModel } = child;
  const stepLimit = { reached: false };
  const node = tree.get(id);
  if (node && isTerminalStatus(node.status)) {
    return Promise.resolve();
  }
  const injected = injectBoundCommTools(deps, mailbox, group, id);
  const bound = bindTreeActivity(tree, id);

  return subsessionManager
    .startChild({
      id,
      name,
      task: task.task,
      config,
      spawnedBy: toolCallId,
      cwd: group.cwd,
      kind: "orchestrated",
      groupId: group.groupId,
      taskType: task.taskType,
      description: task.description,
      domain: task.domain,
      modelRegistry: ctx.modelRegistry,
      parentModel,
      parentToolNames,
      customTools: injected.tools,
      extraTools: [...injected.names, ...(deps.extraTools ?? [])],
      toolSyncEnabled: piConfig.toolSync.enabled,
      toolSyncMaxWait: piConfig.toolSync.maxWait * 1000,
      onToolActivity: bound.onToolActivity,
      onToolOutput: bound.onToolOutput,
      onTextDelta: bound.onTextDelta,
      onAgentEnd: bound.onAgentEnd,
      onWaitingResume: bound.onWaitingResume,
      onTurnEnd: (turnCount) => {
        bound.onTurnEnd(turnCount);
        applyStepLimit({
          count: turnCount,
          steps: config.steps,
          state: stepLimit,
          steer: (text) => subsessionManager.getSessionHandle(id)?.steer(text),
          abort: () => {
            subsessionManager.abortSession(id);
          },
        });
      },
      onUsageUpdate: (usage) => {
        tree.updateUsage(id, usage);
      },
      onComplete: (result) => {
        const status = result.status ?? (result.exitCode === 0 ? "completed" : "failed");
        tree.updateStatus(id, status, result.exitCode, result.error);
      },
    })
    .then(async (handle) => {
      const sessionTimeout = installSessionTimeout({
        timeoutMs: resolveEffectiveTimeout(config.timeout),
        steer: (text) => handle.steer(text),
        abort: () => {
          handle.abort();
        },
      });
      try {
        const current = tree.get(id);
        if (current && isTerminalStatus(current.status)) {
          const terminal = await handle.wait();
          deps.onLifecycle?.({
            class: terminal.class,
            groupId: group.groupId,
            childId: id,
            error: terminal.error,
            output: terminal.output || undefined,
          });
          return;
        }
        tree.markLiveHandle(id);
        deps.onLifecycle?.({ class: "started", groupId: group.groupId, childId: id });
        const terminal = await handle.wait();
        deps.onLifecycle?.({
          class: terminal.class,
          groupId: group.groupId,
          childId: id,
          error: terminal.error,
          output: terminal.output || undefined,
        });
      } finally {
        sessionTimeout.clear();
      }
    })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      tree.updateStatus(id, "failed", 1, error);
      deps.onLifecycle?.({
        class: "failed",
        groupId: group.groupId,
        childId: id,
        error,
      });
      logger.info("orchestrate", "start-failed", {
        groupId: group.groupId,
        childId: id,
        hostMode: ctx.mode,
        error,
      });
    });
}

export function orchestrate(deps: OrchestrateDeps) {
  const mailbox = deps.mailbox ?? new MinionCommMailbox();
  return async function execute(
    toolCallId: string,
    params: OrchestrateInput,
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<OrchestrateResult>> {
    const hostMode = ctx.mode;
    if (!isPersistentHost(hostMode)) {
      logOrchestrate("host-rejected", {
        hostMode,
        accepted: 0,
        rejected: 0,
        reasons: [ORCHESTRATE_REJECT_REASONS.nonPersistentHost],
      });
      throw new Error(ORCHESTRATE_REJECT_REASONS.nonPersistentHost);
    }

    const tasks = Array.isArray(params.tasks) ? params.tasks : [];
    if (tasks.length === 0) {
      throw new Error("Must specify at least one task.");
    }

    const previewed = deps.groups.previewGroup({
      groupId: optionalString(params.groupId),
      cwd: optionalString(params.cwd),
      parentCwd: ctx.cwd,
    });
    if (isResolveGroupReject(previewed)) {
      logOrchestrate("group-rejected", {
        groupId: optionalString(params.groupId),
        hostMode,
        accepted: 0,
        rejected: 0,
        reasons: [previewed.reject],
      });
      throw new Error(previewed.reject);
    }

    const { tree } = deps;
    const piConfig = getConfig({ ...ctx, cwd: previewed.cwd });
    const accepted: OrchestrateResult["accepted"] = [];
    const rejected: OrchestrateResult["rejected"] = [];
    const registered: RegisteredChild[] = [];
    const claimedWorkItemIds = new Set<string>();
    const assignedNames = new Set<string>();

    for (let index = 0; index < tasks.length; index++) {
      if (signal?.aborted) {
        rejected.push({ index, reason: ORCHESTRATE_REJECT_REASONS.registrationAborted });
        continue;
      }

      const spec = tasks[index] as OrchestratedTaskDescriptor;
      const task = optionalString(spec?.task);
      const description = optionalString(spec?.description);
      if (!description) {
        rejected.push({ index, reason: ORCHESTRATE_REJECT_REASONS.missingDescription });
        continue;
      }
      if (!task) {
        rejected.push({ index, reason: ORCHESTRATE_REJECT_REASONS.missingTask });
        continue;
      }
      if (spec.taskType !== undefined && !isTaskType(spec.taskType)) {
        rejected.push({
          index,
          reason: ORCHESTRATE_REJECT_REASONS.unknownTaskType,
          value: String(spec.taskType),
        });
        continue;
      }

      const workItemId = optionalString(spec.domain?.workItemId);
      if (workItemId) {
        const live = tree.getLiveByWorkItemId(workItemId);
        if (live.length > 0 || claimedWorkItemIds.has(workItemId)) {
          rejected.push({
            index,
            reason: ORCHESTRATE_REJECT_REASONS.duplicateWorkItemId,
            value: workItemId,
          });
          continue;
        }
      }

      const agent = optionalString(spec.agent);
      if (!agent && !piConfig.allowEphemeral) {
        rejected.push({ index, reason: ORCHESTRATE_REJECT_REASONS.ephemeralDisabled });
        continue;
      }

      const id = generateId();
      const name = pickMinionName(tree, id, ctx, agent, assignedNames);
      const config = resolveAgentConfig(agent, name, optionalString(spec.model), previewed.cwd);
      if ("reject" in config) {
        rejected.push({ index, reason: config.reject, value: agent });
        continue;
      }

      let parentModel: Model<Api> | undefined;
      try {
        parentModel = resolveModelReference(optionalString(spec.model) ?? config.model, ctx);
      } catch {
        rejected.push({
          index,
          reason: ORCHESTRATE_REJECT_REASONS.unknownModel,
          value: optionalString(spec.model) ?? config.model,
        });
        continue;
      }

      assignedNames.add(name);
      if (workItemId) claimedWorkItemIds.add(workItemId);

      const descriptor: OrchestratedTaskDescriptor = {
        task,
        description,
        agent,
        taskType: spec.taskType,
        model: optionalString(spec.model),
        domain: spec.domain,
      };

      tree.add(id, name, task, {
        kind: "orchestrated",
        groupId: previewed.groupId,
        taskType: descriptor.taskType,
        description,
        domain: spec.domain,
        agentName: agent ?? "ephemeral",
        model: descriptor.model ?? (parentModel ? formatModelReference(parentModel) : undefined),
        completionNudge: config.completionNudge,
        status: "pending",
      });

      accepted.push({ childId: id, description, state: "starting" });
      registered.push({ id, name, task: descriptor, config, parentModel });
    }

    if (accepted.length === 0) {
      logOrchestrate("result", {
        groupId: previewed.created ? undefined : previewed.groupId,
        hostMode,
        accepted: 0,
        rejected: rejected.length,
        reasons: rejected.map((item) => item.reason),
      });
      throw allRejectedError(rejected);
    }

    if (previewed.created) {
      deps.groups.commitGroup(previewed);
    }

    const parentToolNames = deps.pi.getAllTools().map((tool) => tool.name);
    for (const child of registered) {
      // Registration is done. Start is detached; tool AbortSignal does not abort children.
      void startRegisteredChild(
        deps,
        mailbox,
        ctx,
        previewed,
        toolCallId,
        parentToolNames,
        child,
        piConfig,
      ).catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        logger.error("orchestrate", "detached-start", {
          groupId: previewed.groupId,
          childId: child.id,
          hostMode,
          error,
        });
      });
    }

    const result: OrchestrateResult = {
      groupId: previewed.groupId,
      accepted,
      rejected,
    };

    logOrchestrate("result", {
      groupId: result.groupId,
      childId: accepted.map((item) => item.childId).join(",") || undefined,
      hostMode,
      accepted: accepted.length,
      rejected: rejected.length,
      reasons: rejected.map((item) => item.reason),
    });

    return {
      content: [{ type: "text", text: formatOrchestrateText(result) }],
      details: result,
    };
  };
}
