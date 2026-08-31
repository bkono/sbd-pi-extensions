import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { logger } from "./logger.js";
import { generateId } from "./minions.js";
import { installSessionTimeout, resolveEffectiveTimeout } from "./session-timeout.js";
import { applyStepLimit } from "./step-limit.js";
import { SubsessionManager } from "./subsessions/manager.js";
import { getTempSessionPath } from "./subsessions/paths.js";
import type { AgentTree } from "./tree.js";
import type { AgentConfig, AgentStatus, SpawnResult } from "./types.js";
import { emptyUsage } from "./types.js";

// Transcript logging (transitional - should move to SubsessionManager)
const TRANSCRIPT_DIR = join("/tmp", "logs", "pi-minions", "minions");

function createTranscriptWriter(id: string, name: string, task: string) {
  try {
    mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  const path = join(TRANSCRIPT_DIR, `${id}-${name}.log`);

  const write = (line: string) => {
    try {
      appendFileSync(path, `${line}\n`);
    } catch {
      /* never throw from logging */
    }
  };

  write(`=== Minion: ${name} (${id}) ===`);
  write(`Task: ${task}`);
  write(`Started: ${new Date().toISOString()}`);
  write("---");

  return { write, path };
}

// Callbacks for streaming progress
export interface MinionCallbacks {
  onToolActivity?: (activity: {
    type: "start" | "end";
    toolName: string;
    args?: Record<string, unknown>;
  }) => void;
  onToolOutput?: (toolName: string, delta: string) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAgentEnd?: (info: { willRetry?: boolean }) => void;
  onUsageUpdate?: (usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  }) => void;
}

/**
 * Run a minion session.
 *
 * This function ORCHESTRATES between:
 * - AgentTree: UI state updates (status, activity, usage)
 * - SubsessionManager: Session lifecycle (create, steer, abort)
 *
 * All other modules should use ONE of these, not both.
 *
 * @param tree - UI state tracker (notifications, hierarchy)
 * @param subsessionManager - Session lifecycle manager
 */
export async function runMinionSession(
  config: AgentConfig,
  task: string,
  opts: {
    id?: string;
    name?: string;
    signal?: AbortSignal;
    modelRegistry: ModelRegistry;
    customTools?: import("@earendil-works/pi-coding-agent").ToolDefinition[];
    parentToolNames?: string[];
    toolSyncEnabled?: boolean;
    toolSyncMaxWait?: number;
    parentModel?: Model<Api>;
    cwd: string;
    parentSystemPrompt?: string;
    subsessionManager?: SubsessionManager;
    spawnedBy?: string;
    parentSessionPath?: string;
    tree?: AgentTree;
  } & MinionCallbacks,
): Promise<SpawnResult> {
  const id = opts.id ?? generateId();
  const name = opts.name ?? config.name;
  const spawnedBy = opts.spawnedBy ?? "unknown";

  // Get or create SubsessionManager
  const subsessionManager =
    opts.subsessionManager ??
    new SubsessionManager(opts.cwd, opts.parentSessionPath ?? getTempSessionPath(opts.cwd));

  // Get AgentTree for UI updates (optional - can run without UI)
  const tree = opts.tree;

  logger.debug("spawn:session", "start", {
    id,
    name,
    agent: config.name,
    task,
  });
  logger.info("comm", "inject", { childId: id, tools: [], kind: "spawn" });

  // Transitional: logging should move to SubsessionManager
  const transcript = createTranscriptWriter(id, name, task);
  transcript.write(
    `System Prompt: ${opts.parentSystemPrompt ?? config.systemPrompt ?? "(default)"}`,
  );
  transcript.write("---");

  let turnCount = 0;
  let finalOutput = "";
  const stepLimit = { reached: false };
  let abortReason: string | undefined;
  const usage = emptyUsage();

  const effectiveTimeout = resolveEffectiveTimeout(config.timeout);
  let sessionTimeout: ReturnType<typeof installSessionTimeout> | undefined;

  try {
    const handle = await subsessionManager.startChild({
      id,
      name,
      task,
      config,
      spawnedBy,
      cwd: opts.cwd,
      modelRegistry: opts.modelRegistry,
      parentModel: opts.parentModel,
      parentSystemPrompt: opts.parentSystemPrompt,
      signal: opts.signal,
      customTools: opts.customTools,
      parentToolNames: opts.parentToolNames,
      // Spawn never unions orchestrated comm tools.
      extraTools: [],
      toolSyncEnabled: opts.toolSyncEnabled,
      toolSyncMaxWait: opts.toolSyncMaxWait,

      onToolActivity: (activity) => {
        transcript.write(`\n[tool:${activity.type}] ${activity.toolName}`);
        opts.onToolActivity?.(activity);
      },

      onToolOutput: (toolName, delta) => {
        transcript.write(`[tool:output] ${delta.trimEnd()}`);
        opts.onToolOutput?.(toolName, delta);
      },

      onTextDelta: (delta, fullText) => {
        finalOutput = fullText;
        opts.onTextDelta?.(delta, fullText);
      },

      onUsageUpdate: (partial) => {
        Object.assign(usage, partial);
        tree?.updateUsage(id, partial);
        opts.onUsageUpdate?.(partial);
      },

      onTurnEnd: (count) => {
        turnCount = count;
        transcript.write(`\n--- turn ${count} ---`);

        applyStepLimit({
          count,
          steps: config.steps,
          state: stepLimit,
          steer: (text) => subsessionManager.getSessionHandle(id)?.steer(text),
          abort: () => {
            subsessionManager.abortSession(id);
          },
          onWrapUp: () => {
            transcript.write(`\n=== Step limit reached (${config.steps}) ===`);
            logger.warn("spawn:session", "Step limit reached", {
              name: config.name,
              steps: config.steps,
              turnCount: count,
            });
          },
          onAbort: () => {
            abortReason = "Step limit exceeded — force abort after grace period";
            logger.warn("spawn:session", "Force abort after grace period", {
              name: config.name,
              steps: config.steps,
              turnCount: count,
            });
          },
        });

        opts.onTurnEnd?.(count);
      },

      onAgentEnd: (info) => {
        opts.onAgentEnd?.(info);
      },
    });

    tree?.applyActivityEvent(id, { type: "thinking" });

    sessionTimeout = installSessionTimeout({
      timeoutMs: effectiveTimeout,
      steer: (text) => handle.steer(text),
      abort: () => {
        handle.abort();
      },
      onWrapUp: () => {
        transcript.write(`\n=== Timeout reached (${effectiveTimeout}ms) ===`);
        logger.warn("spawn:session", "Timeout reached", {
          name: config.name,
          timeout: effectiveTimeout,
          turnCount,
        });
      },
      onAbort: () => {
        transcript.write(`\n=== Force abort after grace period ===`);
        logger.warn("spawn:session", "Force abort after timeout grace", {
          name: config.name,
          timeout: effectiveTimeout,
          turnCount,
        });
      },
    });

    const terminal = await handle.wait();
    const status: AgentStatus = terminal.class === "settled" ? "completed" : terminal.class;
    const result = {
      exitCode: terminal.exitCode,
      output: terminal.output,
      status,
      error: terminal.error,
    };
    tree?.updateStatus(id, status, result.exitCode, result.error);

    // Preserve explicit abort reasons from step-limit enforcement.
    if (abortReason) {
      return {
        exitCode: 1,
        status: "aborted",
        finalOutput: result.output || finalOutput,
        usage,
        error: abortReason,
      };
    }

    usage.turns = turnCount;
    if (result.output) {
      finalOutput = result.output;
    }

    transcript.write(
      `\n=== ${result.exitCode === 0 ? "Completed" : "Failed"} (${turnCount} turns) ===`,
    );
    transcript.write(`Output:\n${finalOutput}`);

    logger.debug("spawn:session", result.exitCode === 0 ? "completed" : "failed", {
      id,
      name,
      exitCode: result.exitCode,
      turns: turnCount,
      finalOutputLength: finalOutput?.length,
    });

    // Use the extracted last assistant message, not result.output which may contain full history
    const failureOutput = result.output || "Unknown error";
    return {
      exitCode: result.exitCode,
      status: result.status,
      finalOutput: finalOutput || result.output || "",
      usage,
      error: result.exitCode !== 0 ? (result.error ?? failureOutput) : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    transcript.write(`\n=== Error: ${msg} ===`);
    logger.debug("spawn:session", "error", { id, name, error: msg });

    return {
      exitCode: 1,
      status: opts.signal?.aborted ? "aborted" : "failed",
      finalOutput,
      usage,
      error: msg,
    };
  } finally {
    sessionTimeout?.clear();
  }
}
