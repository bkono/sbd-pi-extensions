import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  ChildSession,
  ChildSessionEvent,
} from "../../../../pi-minions/src/subsessions/types.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * In-process child session used by the 4.2/4.3/4.6 harness.
 * Production wraps Pi AgentSession; this stub is the no-paid-LLM stand-in.
 */
export class ScriptedChildSession implements ChildSession {
  tools = new Map<string, { name: string }>();
  customTools = new Map<string, ToolDefinition>();
  active = new Set<string>();
  listeners = new Set<(event: ChildSessionEvent) => void>();
  disposed = false;
  aborted = false;
  promptCalls = 0;
  lastPrompt: string | undefined;
  thinkingLevel: string | undefined;
  promptDeferred = createDeferred<void>();
  idleDeferred = createDeferred<void>();
  followUps: string[] = [];
  steers: string[] = [];
  state: { messages: unknown[] } = { messages: [] };

  constructor(toolNames: readonly string[], customTools: ToolDefinition[] = []) {
    for (const name of toolNames) {
      this.tools.set(name, { name });
    }
    for (const tool of customTools) {
      this.tools.set(tool.name, { name: tool.name });
      this.customTools.set(tool.name, tool);
    }
    this.active = new Set(this.tools.keys());
  }

  async bindExtensions(): Promise<void> {}

  setThinkingLevel(level: string): void {
    this.thinkingLevel = level;
  }

  setActiveToolsByName(toolNames: string[]): void {
    this.active = new Set(toolNames.filter((name) => this.tools.has(name)));
  }

  getAllTools(): Array<{ name: string }> {
    return [...this.tools.values()];
  }

  getActiveToolNames(): string[] {
    return [...this.active];
  }

  registerTool(name: string): void {
    this.tools.set(name, { name });
    this.active.add(name);
  }

  subscribe(listener: (event: ChildSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: ChildSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  prompt(text: string): Promise<void> {
    this.promptCalls += 1;
    this.lastPrompt = text;
    return this.promptDeferred.promise;
  }

  abort(): void {
    this.aborted = true;
    this.idleDeferred.resolve();
    this.promptDeferred.resolve();
  }

  abortBash(): void {}

  async steer(text: string): Promise<void> {
    this.steers.push(text);
  }

  async followUp(text: string): Promise<void> {
    if (this.disposed) {
      throw new Error("Child is terminal; further mail is rejected");
    }
    this.followUps.push(text);
  }

  async executeTool(name: string, params: unknown): Promise<unknown> {
    const tool = this.customTools.get(name);
    if (!tool || typeof tool.execute !== "function") {
      throw new Error(`Child tool not registered: ${name}`);
    }
    return tool.execute(
      `child-${name}`,
      params as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    );
  }

  waitForIdle(): Promise<void> {
    return this.idleDeferred.promise;
  }

  dispose(): void {
    this.disposed = true;
  }

  getSessionStats() {
    return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
  }

  /**
   * Settle with unstructured prose. Does not close tickets; that is the parent's job.
   */
  finishWithProse(prose: string): void {
    this.state.messages.push({ role: "assistant", content: prose });
    this.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: prose },
    });
    this.emit({ type: "agent_end", willRetry: false });
    this.emit({ type: "agent_settled" });
    this.idleDeferred.resolve();
    this.promptDeferred.resolve();
  }
}
