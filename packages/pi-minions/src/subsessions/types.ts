import type {
  AgentConfig,
  AgentKind,
  OrchestrationDomain,
  TaskType,
  ThinkingLevel,
} from "../types.js";

export interface MinionSessionMetadata {
  sessionId: string;
  parentSession: string;
  spawnedBy: string;
  name: string;
  task: string;
  agent?: string;
  createdAt: number;
  status: "running" | "completed" | "failed" | "aborted";
  exitCode?: number;
  error?: string;
  kind?: AgentKind;
  groupId?: string;
  taskType?: TaskType;
  description?: string;
  domain?: OrchestrationDomain;
}

/** Parent-packet event classes for child terminal. Abort is not failure. */
export type ChildTerminalClass = "settled" | "aborted" | "failed";

export interface ChildTerminalEvent {
  class: ChildTerminalClass;
  exitCode: number;
  output: string;
  error?: string;
}

/**
 * Structural child session used by SubsessionManager.
 * Production wraps Pi AgentSession; tests inject a fake.
 */
export interface ChildSession {
  bindExtensions(bindings: { shutdownHandler?: () => void }): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  setActiveToolsByName(toolNames: string[]): void;
  getAllTools(): Array<{ name: string }>;
  getActiveToolNames(): string[];
  subscribe(listener: (event: ChildSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): void | Promise<void>;
  abortBash?: () => void;
  steer(text: string): Promise<void>;
  /** Child-safe queued continuation. Pi delivers after the current tool/steer drain. */
  followUp(text: string): Promise<void>;
  waitForIdle(): Promise<void>;
  /** Proven Pi AgentSession run-state. True while an agent run or post-run continuation is active. */
  readonly isStreaming: boolean;
  dispose(): void;
  getSessionStats(): {
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    cost: number;
  };
  readonly state: { messages: unknown[] };
}

export interface ChildSessionEvent {
  type: string;
  toolName?: string;
  args?: Record<string, unknown>;
  willRetry?: boolean;
  success?: boolean;
  finalError?: string;
  assistantMessageEvent?: { type: string; delta?: string };
  partialResult?: { content?: Array<{ text?: string }> };
  message?: { role?: string; content?: unknown };
  [key: string]: unknown;
}

export interface ChildRuntime {
  session: ChildSession;
  dispose(): void | Promise<void>;
}

export interface CreateChildRuntimeInput {
  cwd: string;
  id: string;
  name: string;
  config: AgentConfig;
  // biome-ignore lint/suspicious/noExplicitAny: external API type
  parentModel?: import("@earendil-works/pi-ai").Model<any>;
  parentSystemPrompt?: string;
  customTools?: import("@earendil-works/pi-coding-agent").ToolDefinition[];
}

export type CreateChildRuntime = (
  input: CreateChildRuntimeInput,
) => Promise<{ runtime: ChildRuntime; sessionPath: string }>;

export interface MinionSessionHandle {
  id: string;
  path: string;
  steer(text: string): Promise<void>;
  followUp(text: string, opts?: { parentReply?: boolean; deliveryId?: string }): Promise<void>;
  abort(): void;
  wait(): Promise<ChildTerminalEvent>;
}

export interface CreateMinionSessionOptions {
  id: string;
  name: string;
  task: string;
  config: AgentConfig;
  spawnedBy: string;
  cwd: string;
  kind?: AgentKind;
  groupId?: string;
  taskType?: TaskType;
  description?: string;
  domain?: OrchestrationDomain;
  modelRegistry: import("@earendil-works/pi-coding-agent").ModelRegistry;
  // biome-ignore lint/suspicious/noExplicitAny: external API type
  parentModel?: import("@earendil-works/pi-ai").Model<any>;
  parentSystemPrompt?: string;
  signal?: AbortSignal;
  customTools?: import("@earendil-works/pi-coding-agent").ToolDefinition[];
  parentToolNames?: string[];
  /** Orchestrated-only comm tools. Spawn leaves this empty. */
  extraTools?: string[];
  toolSyncEnabled?: boolean;
  toolSyncMaxWait?: number;
  onToolActivity?: (activity: {
    type: "start" | "end";
    toolName: string;
    args?: Record<string, unknown>;
  }) => void;
  onToolOutput?: (toolName: string, delta: string) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAgentEnd?: (info: { willRetry?: boolean }) => void;
  onWaitingResume?: () => void;
  onUsageUpdate?: (usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  }) => void;
  onComplete?: (result: {
    exitCode: number;
    output: string;
    status?: MinionSessionMetadata["status"];
    error?: string;
  }) => void | Promise<void>;
}
