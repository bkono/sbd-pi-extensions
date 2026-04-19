import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CommandRegistration = {
  description?: string;
  getArgumentCompletions?: (prefix: string) => unknown | Promise<unknown>;
  handler: (args: string, ctx: ExtensionCommandContext) => unknown | Promise<unknown>;
};

export interface ExtensionTestHarness {
  handlers: Map<string, AnyHandler[]>;
  commands: Map<string, CommandRegistration>;
  sentMessages: Array<{ message: unknown; options?: unknown }>;
  sentUserMessages: Array<{ content: unknown; options?: unknown }>;
  dispatch<T = unknown>(
    eventType: string,
    event: unknown,
    ctx: ExtensionContext,
  ): Promise<T | undefined>;
  invokeCommand(name: string, args: string, ctx: ExtensionCommandContext): Promise<unknown>;
  getCommandCompletions(name: string, prefix: string): Promise<unknown>;
}

export async function createExtensionTestHarness(
  factory: (pi: ExtensionAPI) => void | Promise<void>,
): Promise<ExtensionTestHarness> {
  const handlers = new Map<string, AnyHandler[]>();
  const commands = new Map<string, CommandRegistration>();
  const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
  const sentUserMessages: Array<{ content: unknown; options?: unknown }> = [];

  const fakeApi: Partial<ExtensionAPI> = {
    on: ((event: string, handler: AnyHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }) as ExtensionAPI["on"],
    registerCommand: ((name: string, options: CommandRegistration) => {
      commands.set(name, options);
    }) as unknown as ExtensionAPI["registerCommand"],
    registerTool: (() => {}) as unknown as ExtensionAPI["registerTool"],
    registerShortcut: (() => {}) as ExtensionAPI["registerShortcut"],
    registerFlag: (() => {}) as ExtensionAPI["registerFlag"],
    getFlag: (() => undefined) as ExtensionAPI["getFlag"],
    registerProvider: (() => {}) as unknown as ExtensionAPI["registerProvider"],
    unregisterProvider: (() => {}) as unknown as ExtensionAPI["unregisterProvider"],
    registerMessageRenderer: (() => {}) as unknown as ExtensionAPI["registerMessageRenderer"],
    sendMessage: ((message: unknown, options?: unknown) => {
      sentMessages.push({ message, options });
    }) as ExtensionAPI["sendMessage"],
    sendUserMessage: ((content: unknown, options?: unknown) => {
      sentUserMessages.push({ content, options });
    }) as ExtensionAPI["sendUserMessage"],
  };

  await factory(fakeApi as ExtensionAPI);

  return {
    handlers,
    commands,
    sentMessages,
    sentUserMessages,
    async dispatch(eventType, event, ctx) {
      const list = handlers.get(eventType) ?? [];
      let last: unknown;
      for (const handler of list) {
        last = await handler(event, ctx);
      }
      return last as T | undefined;
    },
    async invokeCommand(name, args, ctx) {
      const command = commands.get(name);
      if (!command) {
        throw new Error(`Command not registered: ${name}`);
      }
      return command.handler(args, ctx);
    },
    async getCommandCompletions(name, prefix) {
      const command = commands.get(name);
      if (!command) {
        throw new Error(`Command not registered: ${name}`);
      }
      return command.getArgumentCompletions?.(prefix) ?? null;
    },
  };
}

export type FakeUi = {
  notifications: Array<{ message: string; level?: string }>;
  statuses: Map<string, string | undefined>;
  theme: {
    fg: (_color: string, text: string) => string;
    bold: (text: string) => string;
  };
  notify: (message: string, level?: string) => void;
  setStatus: (id: string, text: string | undefined) => void;
  customCalls: Array<{
    options?: unknown;
    factory?: unknown;
    component?: unknown;
    tui?: { requestRenderCalls: number };
  }>;
  custom: <T>(factory: unknown, options?: unknown) => Promise<T>;
};

export function createFakeUi(): FakeUi {
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses = new Map<string, string | undefined>();
  const customCalls: Array<{
    options?: unknown;
    factory?: unknown;
    component?: unknown;
    tui?: { requestRenderCalls: number };
  }> = [];

  return {
    notifications,
    statuses,
    theme: {
      fg: (_color, text) => text,
      bold: (text) => text,
    },
    notify: (message, level) => {
      notifications.push({ message, level });
    },
    setStatus: (id, text) => {
      statuses.set(id, text);
    },
    customCalls,
    custom: async <T>(factory: unknown, options?: unknown) => {
      const tui = {
        requestRenderCalls: 0,
        requestRender() {
          this.requestRenderCalls += 1;
        },
      };
      const component =
        typeof factory === "function"
          ? factory(
              tui as unknown,
              {
                fg: (_color: string, text: string) => text,
                bold: (text: string) => text,
              },
              {},
              () => undefined,
            )
          : undefined;
      customCalls.push({
        options,
        factory,
        component,
        tui: { requestRenderCalls: tui.requestRenderCalls },
      });
      return undefined as T;
    },
  };
}

export function createFakeExtensionContext(
  overrides: { cwd?: string; sessionId?: string; ui?: FakeUi } = {},
): ExtensionCommandContext {
  const sessionId = overrides.sessionId ?? "test-session-123";
  const ui = overrides.ui ?? createFakeUi();

  const ctx = {
    cwd: overrides.cwd ?? process.cwd(),
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
      getEntries: () => [],
      getCwd: () => overrides.cwd ?? process.cwd(),
      getSessionDir: () => overrides.cwd ?? process.cwd(),
      getSessionFile: () => undefined,
      getLeafId: () => null,
      getLeafEntry: () => undefined,
      getEntry: () => undefined,
      getLabel: () => undefined,
      getHeader: () => undefined,
      getTree: () => [],
      getSessionName: () => undefined,
    },
    ui,
    hasUI: true,
    modelRegistry: {},
    model: undefined,
    signal: undefined,
    isIdle: () => true,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: true }),
    fork: async () => undefined,
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => {},
  };

  return ctx as unknown as ExtensionCommandContext;
}
