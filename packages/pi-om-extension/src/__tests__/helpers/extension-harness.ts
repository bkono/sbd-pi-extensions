import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type AnyTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<{ content: unknown[]; details?: unknown }>;
};

export interface ExtensionTestHarness {
  handlers: Map<string, AnyHandler[]>;
  tools: Map<string, AnyTool>;
  /**
   * Invoke all handlers registered for `eventType` in order, returning the
   * result of the last handler. Mimics a simple "one extension" dispatch;
   * does NOT chain results between handlers (the real ExtensionRunner does,
   * but this extension never has multiple handlers on the same event).
   */
  dispatch<T = unknown>(
    eventType: string,
    event: unknown,
    ctx: ExtensionContext,
  ): Promise<T | undefined>;
  /**
   * Invoke a registered tool's execute function.
   */
  invokeTool(
    name: string,
    params: unknown,
    ctx: ExtensionContext,
  ): Promise<{ content: unknown[]; details?: unknown }>;
}

/**
 * Create a fake ExtensionAPI dispatcher. Records all `pi.on(...)` and
 * `pi.registerTool(...)` calls, then lets tests dispatch events and invoke
 * tools directly.
 *
 * This deliberately does NOT use the real ExtensionRunner. The OM extension
 * has no cross-extension chaining concerns, so a simple dispatcher is enough
 * and much faster than spinning up the real runner.
 */
export async function createExtensionTestHarness(
  factory: (pi: ExtensionAPI) => void | Promise<void>,
): Promise<ExtensionTestHarness> {
  const handlers = new Map<string, AnyHandler[]>();
  const tools = new Map<string, AnyTool>();

  const fakeApi: Partial<ExtensionAPI> = {
    on: ((event: string, handler: AnyHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }) as ExtensionAPI["on"],
    registerTool: ((tool: AnyTool) => {
      tools.set(tool.name, tool);
    }) as unknown as ExtensionAPI["registerTool"],
    registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
    registerShortcut: (() => {}) as ExtensionAPI["registerShortcut"],
    registerFlag: (() => {}) as ExtensionAPI["registerFlag"],
    getFlag: (() => undefined) as ExtensionAPI["getFlag"],
    registerProvider: (() => {}) as unknown as ExtensionAPI["registerProvider"],
    unregisterProvider: (() => {}) as unknown as ExtensionAPI["unregisterProvider"],
    registerMessageRenderer: (() => {}) as unknown as ExtensionAPI["registerMessageRenderer"],
  };

  await factory(fakeApi as ExtensionAPI);

  return {
    handlers,
    tools,
    async dispatch(eventType, event, ctx) {
      const list = handlers.get(eventType) ?? [];
      let last: unknown;
      for (const h of list) {
        last = await h(event, ctx);
      }
      return last as never;
    },
    async invokeTool(name, params, ctx) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool.execute(`test-call-${name}`, params, new AbortController().signal, () => {}, ctx);
    },
  };
}

/**
 * Minimal ExtensionContext stub. Override fields via the argument.
 * Most tests only need `cwd` and `sessionManager.getSessionId()`.
 */
export function createFakeExtensionContext(
  overrides: { cwd?: string; sessionId?: string; entries?: unknown[]; systemPrompt?: string } = {},
): ExtensionContext {
  const sessionId = overrides.sessionId ?? "test-session-123";
  const entries = overrides.entries ?? [];
  const ctx = {
    cwd: overrides.cwd ?? "/tmp/test-cwd",
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries,
      getEntries: () => entries,
      getCwd: () => overrides.cwd ?? "/tmp/test-cwd",
      getSessionDir: () => overrides.cwd ?? "/tmp/test-cwd",
      getSessionFile: () => undefined,
      getLeafId: () => null,
      getLeafEntry: () => undefined,
      getEntry: () => undefined,
      getLabel: () => undefined,
      getHeader: () => undefined,
      getTree: () => [],
      getSessionName: () => undefined,
    },
    ui: {},
    hasUI: false,
    modelRegistry: {},
    model: undefined,
    isIdle: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => overrides.systemPrompt ?? "",
  };
  return ctx as unknown as ExtensionContext;
}
