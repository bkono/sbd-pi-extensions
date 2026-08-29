import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import {
  COMM_SEND_STATUS,
  createSendMinionMessageTool,
  formatMinionMail,
  injectOrchestratedCommTools,
  LIST_MINION_PEERS_TOOL,
  ListMinionPeersParams,
  MAX_MAILBOX_QUEUE_DEPTH,
  MAX_MINION_MESSAGE_BYTES,
  MinionCommMailbox,
  ORCHESTRATED_COMM_TOOL_NAMES,
  OrchestrationGroupState,
  PARENT_ONLY_MINION_TOOLS,
  PARENT_RECIPIENT_ID,
  SEND_MINION_MESSAGE_TOOL,
  SEND_MINION_PEER_TOOL,
  SendMinionMessageParams,
  SendMinionPeerParams,
} from "../orchestration/index.js";
import {
  applyChildToolAllowlist,
  BEADWORK_CHILD_INSPECTION_TOOLS,
  computeChildActiveTools,
  SubsessionManager,
} from "../subsessions/manager.js";
import type { ChildSession, ChildSessionEvent } from "../subsessions/types.js";
import { orchestrate } from "../tools/orchestrate.js";
import { AgentTree } from "../tree.js";
import type { AgentConfig } from "../types.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

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

class FakeChildSession implements ChildSession {
  tools = new Map<string, { name: string }>([
    ["read", { name: "read" }],
    ["bash", { name: "bash" }],
    ["beadwork_show", { name: "beadwork_show" }],
    ["beadwork_list_issues", { name: "beadwork_list_issues" }],
    ["beadwork_issue_history", { name: "beadwork_issue_history" }],
    ["beadwork_ready", { name: "beadwork_ready" }],
    ["beadwork_blocked", { name: "beadwork_blocked" }],
    ["beadwork_status", { name: "beadwork_status" }],
    ["beadwork_prime", { name: "beadwork_prime" }],
    ["beadwork_close_issue", { name: "beadwork_close_issue" }],
  ]);
  active = new Set<string>();
  listeners = new Set<(event: ChildSessionEvent) => void>();
  promptDeferred = createDeferred<void>();
  idleDeferred = createDeferred<void>();
  state = { messages: [] as unknown[] };

  constructor(customTools: Array<{ name: string }> = []) {
    for (const tool of customTools) this.tools.set(tool.name, { name: tool.name });
    this.active = new Set(this.tools.keys());
  }

  async bindExtensions(): Promise<void> {}
  setActiveToolsByName(toolNames: string[]): void {
    this.active = new Set(toolNames.filter((name) => this.tools.has(name)));
  }
  getAllTools(): Array<{ name: string }> {
    return [...this.tools.values()];
  }
  getActiveToolNames(): string[] {
    return [...this.active];
  }
  subscribe(listener: (event: ChildSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  prompt(_text: string): Promise<void> {
    return this.promptDeferred.promise;
  }
  abort(): void {
    this.promptDeferred.resolve();
    this.idleDeferred.resolve();
  }
  abortBash(): void {}
  followUps: string[] = [];
  steers: string[] = [];
  async steer(text: string): Promise<void> {
    this.steers.push(text);
  }
  async followUp(text: string): Promise<void> {
    this.followUps.push(text);
  }
  waitForIdle(): Promise<void> {
    return this.idleDeferred.promise;
  }
  dispose(): void {}
  getSessionStats() {
    return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
  }
}

const agentConfig: AgentConfig = {
  name: "ephemeral",
  description: "test minion",
  systemPrompt: "You are a test minion.",
  source: "ephemeral",
  filePath: "",
};

function groupTree(): { tree: AgentTree; childId: string; peerId: string; groupId: string } {
  const tree = new AgentTree();
  const groupId = "grp-1";
  const childId = "mn-self";
  const peerId = "mn-peer";
  tree.add(childId, "alpha", "self prompt", {
    kind: "orchestrated",
    groupId,
    role: "implementer",
    taskType: "implementation",
    description: "Self task",
  });
  tree.add(peerId, "bravo", "peer prompt", {
    kind: "orchestrated",
    groupId,
    role: "reviewer",
    taskType: "reviewImplementation",
    description: "Peer task",
  });
  tree.add("mn-done", "charlie", "done prompt", {
    kind: "orchestrated",
    groupId,
    role: "fixer",
    taskType: "fix",
    description: "Already settled",
  });
  tree.updateStatus("mn-done", "completed", 0);
  tree.add("mn-spawn", "delta", "foreground", { kind: "spawn" });
  tree.add("mn-other", "echo", "other group", {
    kind: "orchestrated",
    groupId: "grp-2",
    description: "Other group",
  });
  return { tree, childId, peerId, groupId };
}

function liveMailbox(
  tree: AgentTree,
  groupId: string,
  liveIds: string[],
  open = true,
): {
  mailbox: MinionCommMailbox;
  followUps: Array<{ id: string; text: string }>;
  groups: { getOpenGroup: () => { groupId: string; cwd: string } | undefined };
} {
  const followUps: Array<{ id: string; text: string }> = [];
  const groups = {
    getOpenGroup: () => (open ? { groupId, cwd: "/tmp" } : undefined),
  };
  const mailbox = new MinionCommMailbox({
    getTree: () => tree,
    getGroups: () => groups,
    isLive: (id) => liveIds.includes(id),
    followUp: async (id, text) => {
      followUps.push({ id, text });
    },
  });
  return { mailbox, followUps, groups };
}

async function execTool(
  tool: ToolDefinition,
  params: unknown,
): Promise<{ content: Array<{ text?: string }>; details: unknown }> {
  const result = await tool.execute(
    "call-1",
    params as never,
    undefined,
    undefined,
    {} as ExtensionContext,
  );
  return result as { content: Array<{ text?: string }>; details: unknown };
}

describe("injectOrchestratedCommTools", () => {
  it("binds list and send with childId closed over, not a from parameter", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const { tree, childId, peerId, groupId } = groupTree();
    const { mailbox, followUps } = liveMailbox(tree, groupId, [childId, peerId]);
    const injected = injectOrchestratedCommTools({
      childId,
      groupId,
      tree,
      mailbox,
      kind: "orchestrated",
    });

    expect(injected.names).toEqual([...ORCHESTRATED_COMM_TOOL_NAMES]);
    expect(injected.tools.map((tool) => tool.name)).toEqual([...ORCHESTRATED_COMM_TOOL_NAMES]);
    expect(injected.names).toContain(LIST_MINION_PEERS_TOOL);
    expect(injected.names).toContain(SEND_MINION_PEER_TOOL);
    for (const banned of PARENT_ONLY_MINION_TOOLS) {
      expect(injected.names).not.toContain(banned);
    }
    expect(Object.keys(SendMinionPeerParams.properties).sort()).toEqual(["body", "to"]);
    expect(Object.keys(SendMinionPeerParams.properties)).not.toContain("from");
    expect(Object.keys(SendMinionMessageParams.properties).sort()).toEqual(["body", "to"]);
    expect(Object.keys(SendMinionMessageParams.properties)).not.toContain("from");
    expect(Object.keys(ListMinionPeersParams.properties)).toEqual([]);

    expect(info).toHaveBeenCalledWith(
      "comm",
      "inject",
      expect.objectContaining({
        childId,
        tools: [...ORCHESTRATED_COMM_TOOL_NAMES],
        kind: "orchestrated",
      }),
    );

    const send = injected.tools.find((tool) => tool.name === SEND_MINION_PEER_TOOL);
    expect(send).toBeDefined();
    const sent = await execTool(send!, {
      to: peerId,
      body: "hello peer",
      from: "forged-id",
    });
    expect(sent.details).toMatchObject({
      status: COMM_SEND_STATUS.queued,
      from: childId,
      to: peerId,
      groupId,
      parentTurnTriggered: false,
    });
    expect(sent.details).not.toMatchObject({ from: "forged-id" });
    expect(mailbox.list()).toEqual([
      expect.objectContaining({ from: childId, to: peerId, body: "hello peer", groupId }),
    ]);
    expect(mailbox.list()[0]?.from).toBe(childId);
    expect(mailbox.list()[0]?.from).not.toBe("forged-id");
    expect(followUps).toEqual([{ id: peerId, text: formatMinionMail(childId, "hello peer") }]);
    expect(info).toHaveBeenCalledWith(
      "comm",
      "send",
      expect.objectContaining({
        messageId: mailbox.list()[0]?.id,
        from: childId,
        to: peerId,
        status: COMM_SEND_STATUS.queued,
        bytes: Buffer.byteLength("hello peer", "utf8"),
        parentTurnTriggered: false,
      }),
    );
  });

  it("lists group peers including parent and terminal members, excluding spawn", async () => {
    const { tree, childId, peerId, groupId } = groupTree();
    const injected = injectOrchestratedCommTools({
      childId,
      groupId,
      tree,
      mailbox: new MinionCommMailbox(),
    });
    const list = injected.tools.find((tool) => tool.name === LIST_MINION_PEERS_TOOL);
    const result = await execTool(list!, {});
    const details = result.details as {
      selfId: string;
      groupId: string;
      peers: Array<{
        id: string;
        role?: string;
        taskType?: string;
        description?: string;
        state: string;
      }>;
    };

    expect(details.selfId).toBe(childId);
    expect(details.groupId).toBe(groupId);
    expect(details.peers.map((peer) => peer.id)).toEqual([
      PARENT_RECIPIENT_ID,
      childId,
      peerId,
      "mn-done",
    ]);
    expect(details.peers.find((peer) => peer.id === PARENT_RECIPIENT_ID)).toMatchObject({
      role: "parent",
      state: "parent",
    });
    expect(details.peers.find((peer) => peer.id === peerId)).toMatchObject({
      role: "reviewer",
      taskType: "reviewImplementation",
      description: "Peer task",
      state: "running",
    });
    expect(details.peers.find((peer) => peer.id === "mn-done")?.state).toBe("completed");
    expect(details.peers.some((peer) => peer.id === "mn-spawn")).toBe(false);
    expect(details.peers.some((peer) => peer.id === "mn-other")).toBe(false);
  });

  it("queues parent send and rejects terminal, spawn, and cross-group recipients", async () => {
    const { tree, childId, peerId, groupId } = groupTree();
    const { mailbox, followUps } = liveMailbox(tree, groupId, [childId, peerId]);
    const injected = injectOrchestratedCommTools({ childId, groupId, tree, mailbox });
    const send = injected.tools.find((tool) => tool.name === SEND_MINION_PEER_TOOL)!;

    const toParent = await execTool(send, { to: PARENT_RECIPIENT_ID, body: "need a ruling" });
    expect(toParent.details).toMatchObject({
      status: COMM_SEND_STATUS.queued,
      from: childId,
      to: PARENT_RECIPIENT_ID,
      parentTurnTriggered: false,
    });
    expect(followUps).toEqual([]);

    const toTerminal = await execTool(send, { to: "mn-done", body: "too late" });
    expect(toTerminal.details).toMatchObject({
      status: COMM_SEND_STATUS.recipientTerminal,
      from: childId,
    });

    const toSpawn = await execTool(send, { to: "mn-spawn", body: "nope" });
    expect(toSpawn.details).toMatchObject({ status: COMM_SEND_STATUS.invalidRecipient });

    const toOther = await execTool(send, { to: "mn-other", body: "nope" });
    expect(toOther.details).toMatchObject({ status: COMM_SEND_STATUS.invalidRecipient });

    const toSelf = await execTool(send, { to: childId, body: "nope" });
    expect(toSelf.details).toMatchObject({ status: COMM_SEND_STATUS.invalidRecipient });

    const missing = await execTool(send, { to: "mn-nobody", body: "nope" });
    expect(missing.details).toMatchObject({ status: COMM_SEND_STATUS.invalidRecipient });

    expect(mailbox.list().map((message) => message.to)).toEqual([PARENT_RECIPIENT_ID]);
    expect(followUps).toEqual([]);
  });

  it("does not inject when kind is spawn", () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const { tree, childId, groupId } = groupTree();
    const injected = injectOrchestratedCommTools({
      childId,
      groupId,
      tree,
      mailbox: new MinionCommMailbox(),
      kind: "spawn",
    });
    expect(injected.tools).toEqual([]);
    expect(injected.names).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      "comm",
      "inject",
      expect.objectContaining({ childId, tools: [], kind: "spawn" }),
    );
  });
});

describe("orchestrated vs spawn session tool names", () => {
  it("unions bound comm names through extraTools without rewriting allowlist math", () => {
    const parent = [
      "read",
      "bash",
      "spawn",
      "halt",
      "orchestrate",
      "beadwork_show",
      "beadwork_close_issue",
    ];
    const orchestrated = computeChildActiveTools({
      parentCodingTools: parent,
      extraTools: [...ORCHESTRATED_COMM_TOOL_NAMES],
    });
    expect(orchestrated).toEqual(
      expect.arrayContaining([...ORCHESTRATED_COMM_TOOL_NAMES, ...BEADWORK_CHILD_INSPECTION_TOOLS]),
    );
    expect(orchestrated).toContain("beadwork_show");
    expect(orchestrated).not.toContain("beadwork_close_issue");

    const spawnNames = computeChildActiveTools({
      parentCodingTools: parent,
      extraTools: [],
    });
    for (const name of ORCHESTRATED_COMM_TOOL_NAMES) {
      expect(spawnNames).not.toContain(name);
    }
  });

  it("applies injected comm tools onto an orchestrated session and keeps halt/orchestrate off it", async () => {
    const cwd = tempDir("pi-minions-comm-session-");
    const { tree, groupId } = groupTree();
    const mailbox = new MinionCommMailbox();
    let session!: FakeChildSession;
    const manager = new SubsessionManager(cwd, join(cwd, "parent.jsonl"), undefined, {
      createChildRuntime: async (input) => {
        session = new FakeChildSession(input.customTools ?? []);
        return {
          runtime: {
            session,
            dispose: () => {
              session.dispose();
            },
          },
          sessionPath: join(cwd, "child.jsonl"),
        };
      },
    });

    const injected = injectOrchestratedCommTools({
      childId: "mn-orch-session",
      groupId,
      tree,
      mailbox,
    });
    await manager.startChild({
      id: "mn-orch-session",
      name: "alpha",
      task: "do the work",
      config: agentConfig,
      spawnedBy: "test",
      cwd,
      modelRegistry: {} as never,
      parentToolNames: ["read", "bash", "spawn", "halt", "orchestrate", "send_minion_message"],
      customTools: injected.tools,
      extraTools: injected.names,
      toolSyncEnabled: false,
    });

    const names = session.getActiveToolNames();
    expect(names).toEqual(
      expect.arrayContaining([...ORCHESTRATED_COMM_TOOL_NAMES, "read", "bash"]),
    );
    expect(names).toContain("beadwork_show");
    expect(names).not.toContain("halt");
    expect(names).not.toContain("orchestrate");
    expect(names).not.toContain("spawn");
    expect(names).not.toContain("send_minion_message");
    expect(names).not.toContain("beadwork_close_issue");

    applyChildToolAllowlist(session, {
      parentCodingTools: ["read", "bash", "spawn", "halt", "orchestrate"],
      extraTools: [],
    });
    expect(session.getActiveToolNames()).not.toContain(LIST_MINION_PEERS_TOOL);
    expect(session.getActiveToolNames()).not.toContain(SEND_MINION_PEER_TOOL);

    await manager.disposeAll();
  });

  it("orchestrate startChild receives bound comm tools; names exclude parent-only tools", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const cwd = tempDir("pi-minions-comm-orch-");
    const started: Array<{ extraTools?: string[]; customTools?: Array<{ name: string }> }> = [];
    const execute = orchestrate({
      tree: new AgentTree(),
      pi: { getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "halt" }] } as Pick<
        ExtensionAPI,
        "getAllTools"
      >,
      subsessionManager: {
        startChild: async (opts: {
          id: string;
          extraTools?: string[];
          customTools?: Array<{ name: string }>;
        }) => {
          started.push(opts);
          return {
            id: opts.id,
            path: join(cwd, `${opts.id}.jsonl`),
            steer: async () => {},
            followUp: async () => {},
            abort: () => {},
            wait: () => new Promise(() => {}),
          };
        },
      } as never,
      groups: new OrchestrationGroupState(),
    });
    const ctx = {
      cwd,
      mode: "tui",
      model: undefined,
      modelRegistry: { getAll: () => [], find: () => undefined },
      getSystemPrompt: () => "",
    } as unknown as ExtensionContext;

    const result = await execute(
      "tool-1",
      { tasks: [{ task: "Implement the registry refactor", description: "Registry refactor" }] },
      undefined,
      undefined,
      ctx,
    );
    const childId = (result.details as { accepted: Array<{ childId: string }> }).accepted[0]
      ?.childId;
    await vi.waitFor(() => {
      expect(started.length).toBe(1);
    });

    const names = started[0]?.customTools?.map((tool) => tool.name) ?? [];
    expect(started[0]?.extraTools).toEqual(
      expect.arrayContaining([...ORCHESTRATED_COMM_TOOL_NAMES]),
    );
    expect(names).toEqual([...ORCHESTRATED_COMM_TOOL_NAMES]);
    for (const banned of PARENT_ONLY_MINION_TOOLS) {
      expect(names).not.toContain(banned);
      expect(started[0]?.extraTools).not.toContain(banned);
    }
    expect(info).toHaveBeenCalledWith(
      "comm",
      "inject",
      expect.objectContaining({
        childId,
        tools: [...ORCHESTRATED_COMM_TOOL_NAMES],
        kind: "orchestrated",
      }),
    );
  });
});

describe("mailbox bounds and closed reasons", () => {
  it("rejects a body over the UTF-8 byte cap at the boundary", async () => {
    const { tree, childId, peerId, groupId } = groupTree();
    const { mailbox } = liveMailbox(tree, groupId, [peerId]);
    const injected = injectOrchestratedCommTools({ childId, groupId, tree, mailbox });
    const send = injected.tools.find((tool) => tool.name === SEND_MINION_PEER_TOOL)!;

    const atCap = "a".repeat(MAX_MINION_MESSAGE_BYTES);
    const over = "a".repeat(MAX_MINION_MESSAGE_BYTES + 1);
    const ok = await execTool(send, { to: peerId, body: atCap });
    expect(ok.details).toMatchObject({
      status: COMM_SEND_STATUS.queued,
      bytes: MAX_MINION_MESSAGE_BYTES,
    });

    const rejected = await execTool(send, { to: peerId, body: over });
    expect(rejected.details).toMatchObject({
      status: COMM_SEND_STATUS.bodyTooLarge,
      bytes: MAX_MINION_MESSAGE_BYTES + 1,
      parentTurnTriggered: false,
    });
    expect(mailbox.list()).toHaveLength(1);
  });

  it("rejects mailbox-full at the per-recipient depth cap", async () => {
    const { tree, childId, peerId, groupId } = groupTree();
    const { mailbox } = liveMailbox(tree, groupId, [childId, peerId]);
    const injected = injectOrchestratedCommTools({ childId, groupId, tree, mailbox });
    const send = injected.tools.find((tool) => tool.name === SEND_MINION_PEER_TOOL)!;

    for (let i = 0; i < MAX_MAILBOX_QUEUE_DEPTH; i++) {
      const result = await execTool(send, { to: peerId, body: `msg-${i}` });
      expect(result.details).toMatchObject({ status: COMM_SEND_STATUS.queued });
    }
    const full = await execTool(send, { to: peerId, body: "overflow" });
    expect(full.details).toMatchObject({
      status: COMM_SEND_STATUS.mailboxFull,
      parentTurnTriggered: false,
    });
    expect(mailbox.depthFor(peerId)).toBe(MAX_MAILBOX_QUEUE_DEPTH);

    const toParent = await execTool(send, { to: PARENT_RECIPIENT_ID, body: "still ok" });
    expect(toParent.details).toMatchObject({ status: COMM_SEND_STATUS.queued });
  });

  it("rejects group-not-open when the bound group is not the open group", async () => {
    const { tree, childId, peerId, groupId } = groupTree();
    const { mailbox } = liveMailbox(tree, groupId, [peerId], false);
    const injected = injectOrchestratedCommTools({ childId, groupId, tree, mailbox });
    const send = injected.tools.find((tool) => tool.name === SEND_MINION_PEER_TOOL)!;
    const result = await execTool(send, { to: peerId, body: "hello" });
    expect(result.details).toMatchObject({
      status: COMM_SEND_STATUS.groupNotOpen,
      from: childId,
      parentTurnTriggered: false,
    });
    expect(mailbox.list()).toEqual([]);
  });
});

describe("parent send_minion_message", () => {
  it("delivers parent→child via followUp, ignores forged from, and does not start a parent turn", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const { tree, childId, peerId, groupId } = groupTree();
    const { mailbox, followUps, groups } = liveMailbox(tree, groupId, [childId, peerId]);
    const tool = createSendMinionMessageTool({ mailbox, groups });
    expect(tool.name).toBe(SEND_MINION_MESSAGE_TOOL);

    const sent = await execTool(tool, { to: peerId, body: "from parent", from: "forged-id" });
    expect(sent.details).toMatchObject({
      status: COMM_SEND_STATUS.queued,
      from: PARENT_RECIPIENT_ID,
      to: peerId,
      groupId,
      parentTurnTriggered: false,
    });
    expect(sent.details).not.toMatchObject({ from: "forged-id" });
    expect(followUps).toEqual([
      { id: peerId, text: formatMinionMail(PARENT_RECIPIENT_ID, "from parent") },
    ]);
    expect(info).toHaveBeenCalledWith(
      "comm",
      "send",
      expect.objectContaining({
        from: PARENT_RECIPIENT_ID,
        to: peerId,
        status: COMM_SEND_STATUS.queued,
        parentTurnTriggered: false,
      }),
    );
  });

  it("rejects parent send when no group is open or the child is not live", async () => {
    const { tree, peerId, groupId } = groupTree();
    const closed = liveMailbox(tree, groupId, [peerId], false);
    const closedTool = createSendMinionMessageTool({
      mailbox: closed.mailbox,
      groups: closed.groups,
    });
    const noGroup = await execTool(closedTool, { to: peerId, body: "hi" });
    expect(noGroup.details).toMatchObject({ status: COMM_SEND_STATUS.groupNotOpen });

    const { mailbox, groups, followUps } = liveMailbox(tree, groupId, []);
    const tool = createSendMinionMessageTool({ mailbox, groups });
    const terminal = await execTool(tool, { to: peerId, body: "hi" });
    expect(terminal.details).toMatchObject({ status: COMM_SEND_STATUS.recipientTerminal });
    expect(followUps).toEqual([]);

    const spawn = await execTool(tool, { to: "mn-spawn", body: "hi" });
    expect(spawn.details).toMatchObject({ status: COMM_SEND_STATUS.invalidRecipient });
  });
});

describe("live vs disposed delivery", () => {
  it("delivers child→child and parent→child via followUp; disposed is recipient-terminal", async () => {
    const cwd = tempDir("pi-minions-comm-deliver-");
    const tree = new AgentTree();
    const groupId = "grp-live";
    tree.add("mn-a", "alpha", "task a", { kind: "orchestrated", groupId, description: "A" });
    tree.add("mn-b", "bravo", "task b", { kind: "orchestrated", groupId, description: "B" });

    const sessions = new Map<string, FakeChildSession>();
    const manager = new SubsessionManager(cwd, join(cwd, "parent.jsonl"), undefined, {
      createChildRuntime: async (input) => {
        const session = new FakeChildSession(input.customTools ?? []);
        sessions.set(input.id, session);
        return {
          runtime: {
            session,
            dispose: () => {
              session.dispose();
            },
          },
          sessionPath: join(cwd, `${input.id}.jsonl`),
        };
      },
    });

    const mailbox = new MinionCommMailbox({
      getTree: () => tree,
      getGroups: () => ({ getOpenGroup: () => ({ groupId, cwd }) }),
      isLive: (id) => manager.isLive(id),
      followUp: async (id, text) => {
        const handle = manager.getSessionHandle(id);
        if (!handle) throw new Error(`Child ${id} is terminal; further mail is rejected`);
        await handle.followUp(text);
      },
    });

    const injectA = injectOrchestratedCommTools({
      childId: "mn-a",
      groupId,
      tree,
      mailbox,
    });
    const injectB = injectOrchestratedCommTools({
      childId: "mn-b",
      groupId,
      tree,
      mailbox,
    });

    const start = (id: string, injected: ReturnType<typeof injectOrchestratedCommTools>) =>
      manager.startChild({
        id,
        name: id,
        task: "do the work",
        config: agentConfig,
        spawnedBy: "test",
        cwd,
        modelRegistry: {} as never,
        parentToolNames: ["read", "bash", SEND_MINION_MESSAGE_TOOL],
        customTools: injected.tools,
        extraTools: injected.names,
        toolSyncEnabled: false,
      });

    await start("mn-a", injectA);
    await start("mn-b", injectB);

    const sendA = injectA.tools.find((tool) => tool.name === SEND_MINION_PEER_TOOL)!;
    const peer = await execTool(sendA, { to: "mn-b", body: "hello from a" });
    expect(peer.details).toMatchObject({
      status: COMM_SEND_STATUS.queued,
      from: "mn-a",
      to: "mn-b",
      parentTurnTriggered: false,
    });
    expect(sessions.get("mn-b")?.followUps).toEqual([formatMinionMail("mn-a", "hello from a")]);
    expect(sessions.get("mn-b")?.steers).toEqual([]);
    expect(sessions.get("mn-a")?.followUps).toEqual([]);

    const parentTool = createSendMinionMessageTool({
      mailbox,
      groups: { getOpenGroup: () => ({ groupId, cwd }) },
    });
    const fromParent = await execTool(parentTool, { to: "mn-a", body: "steer this" });
    expect(fromParent.details).toMatchObject({
      status: COMM_SEND_STATUS.queued,
      from: PARENT_RECIPIENT_ID,
      parentTurnTriggered: false,
    });
    expect(sessions.get("mn-a")?.followUps).toEqual([
      formatMinionMail(PARENT_RECIPIENT_ID, "steer this"),
    ]);
    expect(sessions.get("mn-a")?.steers).toEqual([]);

    await manager.disposeAll();
    const afterDispose = await execTool(sendA, { to: "mn-b", body: "too late" });
    expect(afterDispose.details).toMatchObject({
      status: COMM_SEND_STATUS.recipientTerminal,
      parentTurnTriggered: false,
    });
    expect(sessions.get("mn-b")?.followUps).toHaveLength(1);
  });
});
