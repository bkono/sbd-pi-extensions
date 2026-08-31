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
  MAX_MAILBOX_HISTORY,
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
  isStreaming = false;
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
    this.isStreaming = true;
    return this.promptDeferred.promise.finally(() => {
      this.isStreaming = false;
    });
  }
  abort(): void {
    this.promptDeferred.resolve();
    this.idleDeferred.resolve();
  }
  abortBash(): void {}
  followUps: string[] = [];
  steers: string[] = [];
  disposed = false;
  emit(event: ChildSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  async steer(text: string): Promise<void> {
    this.steers.push(text);
  }
  async followUp(text: string): Promise<void> {
    if (this.disposed) {
      throw new Error("Child is terminal; further mail is rejected");
    }
    this.followUps.push(text);
  }
  waitForIdle(): Promise<void> {
    return this.idleDeferred.promise;
  }
  dispose(): void {
    this.disposed = true;
    this.idleDeferred.resolve();
    this.promptDeferred.resolve();
  }
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

const mailboxGroups = new WeakMap<MinionCommMailbox, ReturnType<typeof testGroups>>();

function testGroups(tree: AgentTree, groupId: string, open = true) {
  return {
    getOpenGroup: () => (open ? { groupId, cwd: "/tmp" } : undefined),
    ownsLifecycle: (authority: {
      childId: string;
      groupId: string;
      lifecycleId: string;
      epoch: number;
    }) => {
      const node = tree.get(authority.childId);
      return (
        open &&
        authority.groupId === groupId &&
        node?.groupId === authority.groupId &&
        node.lifecycleId === authority.lifecycleId &&
        node.lifecycleEpoch === authority.epoch
      );
    },
  };
}

function injectForTest(
  input: Omit<
    Parameters<typeof injectOrchestratedCommTools>[0],
    "groups" | "lifecycleId" | "epoch"
  >,
) {
  const node = input.tree.get(input.childId)!;
  return injectOrchestratedCommTools({
    ...input,
    lifecycleId: node.lifecycleId!,
    epoch: node.lifecycleEpoch!,
    groups: mailboxGroups.get(input.mailbox) ?? testGroups(input.tree, input.groupId),
  });
}

function groupTree(): { tree: AgentTree; childId: string; peerId: string; groupId: string } {
  const tree = new AgentTree();
  const groupId = "grp-1";
  const childId = "mn-self";
  const peerId = "mn-peer";
  tree.add(childId, "alpha", "self prompt", {
    kind: "orchestrated",
    groupId,
    lifecycleId: "life-self",
    lifecycleEpoch: 1,
    agentName: "implementer",
    taskType: "implementation",
    description: "Self task",
  });
  tree.add(peerId, "bravo", "peer prompt", {
    kind: "orchestrated",
    groupId,
    lifecycleId: "life-peer",
    lifecycleEpoch: 1,
    agentName: "reviewer",
    taskType: "reviewImplementation",
    description: "Peer task",
  });
  tree.add("mn-done", "charlie", "done prompt", {
    kind: "orchestrated",
    groupId,
    lifecycleId: "life-done",
    lifecycleEpoch: 1,
    agentName: "fixer",
    taskType: "fix",
    description: "Already settled",
  });
  tree.updateStatus("mn-done", "completed", 0);
  tree.add("mn-spawn", "delta", "foreground", { kind: "spawn" });
  tree.add("mn-other", "echo", "other group", {
    kind: "orchestrated",
    groupId: "grp-2",
    lifecycleId: "life-other",
    lifecycleEpoch: 1,
    description: "Other group",
  });
  return { tree, childId, peerId, groupId };
}

function liveMailbox(
  tree: AgentTree,
  groupId: string,
  liveIds: string[],
  open = true,
  onParentDirected?: (message: { from: string; to: string; body: string }) => void,
): {
  mailbox: MinionCommMailbox;
  followUps: Array<{ id: string; text: string }>;
  parentDirected: Array<{ from: string; to: string; body: string }>;
  groups: { getOpenGroup: () => { groupId: string; cwd: string } | undefined };
} {
  const followUps: Array<{ id: string; text: string }> = [];
  const parentDirected: Array<{ from: string; to: string; body: string }> = [];
  const groups = testGroups(tree, groupId, open);
  const mailbox = new MinionCommMailbox({
    getTree: () => tree,
    getGroups: () => groups,
    isLive: (id) => liveIds.includes(id),
    followUp: async (id, text) => {
      followUps.push({ id, text });
    },
    onParentDirected: (message) => {
      parentDirected.push({ from: message.from, to: message.to, body: message.body });
      onParentDirected?.(message);
    },
  });
  mailboxGroups.set(mailbox, groups);
  return { mailbox, followUps, parentDirected, groups };
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
    const injected = injectForTest({
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
    expect(followUps).toEqual([
      {
        id: peerId,
        text: formatMinionMail(childId, "hello peer", mailbox.list()[0]?.id),
      },
    ]);
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
    const injected = injectForTest({
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
        agent?: string;
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
      state: "parent",
    });
    expect(details.peers.find((peer) => peer.id === PARENT_RECIPIENT_ID)?.agent).toBeUndefined();
    expect(details.peers.find((peer) => peer.id === peerId)).toMatchObject({
      agent: "reviewer",
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
    const injected = injectForTest({
      childId,
      lifecycleId: tree.get(childId)!.lifecycleId!,
      epoch: tree.get(childId)!.lifecycleEpoch!,
      groupId,
      tree,
      groups: liveMailbox(tree, groupId, [childId]).groups,
      mailbox,
    });
    const send = injected.tools.find((tool) => tool.name === SEND_MINION_PEER_TOOL)!;

    const toParent = await execTool(send, { to: PARENT_RECIPIENT_ID, body: "need a ruling" });
    expect(toParent.details).toMatchObject({
      status: COMM_SEND_STATUS.queued,
      from: childId,
      to: PARENT_RECIPIENT_ID,
      parentTurnTriggered: false,
    });
    expect(followUps).toEqual([]);
    expect(mailbox.depthFor(PARENT_RECIPIENT_ID)).toBe(1);

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
    const injected = injectForTest({
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
    tree.add("mn-orch-session", "alpha", "do work", {
      kind: "orchestrated",
      groupId,
      lifecycleId: "life-session",
      lifecycleEpoch: 1,
    });
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

    const injected = injectForTest({
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
    const { mailbox } = liveMailbox(tree, groupId, [childId, peerId]);
    const injected = injectForTest({
      childId,
      lifecycleId: tree.get(childId)!.lifecycleId!,
      epoch: tree.get(childId)!.lifecycleEpoch!,
      groupId,
      tree,
      groups: liveMailbox(tree, groupId, [childId]).groups,
      mailbox,
    });
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

  it("does not treat delivered live mail as a lifetime quota", async () => {
    const { tree, childId, peerId, groupId } = groupTree();
    const { mailbox, followUps } = liveMailbox(tree, groupId, [childId, peerId]);
    const injected = injectForTest({
      childId,
      lifecycleId: tree.get(childId)!.lifecycleId!,
      epoch: tree.get(childId)!.lifecycleEpoch!,
      groupId,
      tree,
      groups: liveMailbox(tree, groupId, [childId]).groups,
      mailbox,
    });
    const send = injected.tools.find((tool) => tool.name === SEND_MINION_PEER_TOOL)!;

    for (let i = 0; i < MAX_MAILBOX_QUEUE_DEPTH + 1; i++) {
      const result = await execTool(send, { to: peerId, body: `msg-${i}` });
      expect(result.details).toMatchObject({ status: COMM_SEND_STATUS.queued });
    }
    expect(mailbox.list()).toHaveLength(MAX_MAILBOX_QUEUE_DEPTH + 1);
    expect(mailbox.depthFor(peerId)).toBe(0);
    expect(followUps).toHaveLength(MAX_MAILBOX_QUEUE_DEPTH + 1);
  });

  it("rejects mailbox-full only when pending undelivered depth is at cap", async () => {
    const { tree, childId, peerId, groupId } = groupTree();
    const { mailbox, followUps } = liveMailbox(tree, groupId, [childId, peerId]);
    const injected = injectForTest({
      childId,
      lifecycleId: tree.get(childId)!.lifecycleId!,
      epoch: tree.get(childId)!.lifecycleEpoch!,
      groupId,
      tree,
      groups: liveMailbox(tree, groupId, [childId]).groups,
      mailbox,
    });
    const send = injected.tools.find((tool) => tool.name === SEND_MINION_PEER_TOOL)!;

    for (let i = 0; i < MAX_MAILBOX_QUEUE_DEPTH; i++) {
      const result = await execTool(send, { to: PARENT_RECIPIENT_ID, body: `pending-${i}` });
      expect(result.details).toMatchObject({ status: COMM_SEND_STATUS.queued });
    }
    expect(mailbox.depthFor(PARENT_RECIPIENT_ID)).toBe(MAX_MAILBOX_QUEUE_DEPTH);
    expect(followUps).toEqual([]);

    const full = await execTool(send, { to: PARENT_RECIPIENT_ID, body: "overflow" });
    expect(full.details).toMatchObject({
      status: COMM_SEND_STATUS.mailboxFull,
      parentTurnTriggered: false,
    });
    expect(mailbox.depthFor(PARENT_RECIPIENT_ID)).toBe(MAX_MAILBOX_QUEUE_DEPTH);
    expect(mailbox.list()).toHaveLength(MAX_MAILBOX_QUEUE_DEPTH);

    const toPeer = await execTool(send, { to: peerId, body: "live still ok" });
    expect(toPeer.details).toMatchObject({ status: COMM_SEND_STATUS.queued });
    expect(mailbox.depthFor(peerId)).toBe(0);
    expect(followUps).toEqual([
      {
        id: peerId,
        text: formatMinionMail(childId, "live still ok", mailbox.list().at(-1)?.id),
      },
    ]);
  });

  it("takePending drains parent-directed pending without scanning list()", async () => {
    const { tree, childId, peerId, groupId } = groupTree();
    const { mailbox } = liveMailbox(tree, groupId, [childId, peerId]);

    mailbox.send({
      from: childId,
      lifecycleId: tree.get(childId)?.lifecycleId,
      lifecycleEpoch: tree.get(childId)?.lifecycleEpoch,
      to: PARENT_RECIPIENT_ID,
      groupId,
      body: "q1",
    });
    mailbox.send({
      from: peerId,
      lifecycleId: tree.get(peerId)?.lifecycleId,
      lifecycleEpoch: tree.get(peerId)?.lifecycleEpoch,
      to: PARENT_RECIPIENT_ID,
      groupId,
      body: "q2",
    });
    mailbox.send({
      from: childId,
      lifecycleId: tree.get(childId)?.lifecycleId,
      lifecycleEpoch: tree.get(childId)?.lifecycleEpoch,
      to: PARENT_RECIPIENT_ID,
      groupId,
      body: "q3",
    });
    const inspectionIds = mailbox.list().map((message) => message.id);
    expect(mailbox.depthFor(PARENT_RECIPIENT_ID)).toBe(3);

    const fromChild = mailbox.takePending(PARENT_RECIPIENT_ID, childId);
    expect(fromChild.map((message) => message.body)).toEqual(["q1", "q3"]);
    expect(mailbox.depthFor(PARENT_RECIPIENT_ID)).toBe(1);
    expect(mailbox.list().map((message) => message.id)).toEqual(inspectionIds);

    const rest = mailbox.takePending(PARENT_RECIPIENT_ID);
    expect(rest.map((message) => message.body)).toEqual(["q2"]);
    expect(mailbox.depthFor(PARENT_RECIPIENT_ID)).toBe(0);
    expect(mailbox.takePending(PARENT_RECIPIENT_ID)).toEqual([]);
    expect(mailbox.list()).toHaveLength(3);
  });

  it("clears mailbox-full after takePending drains parent-directed pending", async () => {
    const { tree, childId, groupId } = groupTree();
    const { mailbox } = liveMailbox(tree, groupId, [childId]);
    for (let i = 0; i < MAX_MAILBOX_QUEUE_DEPTH; i++) {
      expect(
        mailbox.send({
          from: childId,
          lifecycleId: tree.get(childId)?.lifecycleId,
          lifecycleEpoch: tree.get(childId)?.lifecycleEpoch,
          to: PARENT_RECIPIENT_ID,
          groupId,
          body: `pending-${i}`,
        }).status,
      ).toBe(COMM_SEND_STATUS.queued);
    }
    expect(
      mailbox.send({
        from: childId,
        lifecycleId: tree.get(childId)?.lifecycleId,
        lifecycleEpoch: tree.get(childId)?.lifecycleEpoch,
        to: PARENT_RECIPIENT_ID,
        groupId,
        body: "overflow",
      }).status,
    ).toBe(COMM_SEND_STATUS.mailboxFull);

    const taken = mailbox.takePending(PARENT_RECIPIENT_ID, childId);
    expect(taken).toHaveLength(MAX_MAILBOX_QUEUE_DEPTH);
    expect(mailbox.depthFor(PARENT_RECIPIENT_ID)).toBe(0);
    expect(
      mailbox.send({
        from: childId,
        lifecycleId: tree.get(childId)?.lifecycleId,
        lifecycleEpoch: tree.get(childId)?.lifecycleEpoch,
        to: PARENT_RECIPIENT_ID,
        groupId,
        body: "after-drain",
      }).status,
    ).toBe(COMM_SEND_STATUS.queued);
    expect(mailbox.list().map((message) => message.body)).toContain("after-drain");
  });

  it("rejects group-not-open when the bound group is not the open group", async () => {
    const { tree, childId, peerId, groupId } = groupTree();
    const { mailbox } = liveMailbox(tree, groupId, [peerId], false);
    const injected = injectForTest({
      childId,
      lifecycleId: tree.get(childId)!.lifecycleId!,
      epoch: tree.get(childId)!.lifecycleEpoch!,
      groupId,
      tree,
      groups: liveMailbox(tree, groupId, [childId]).groups,
      mailbox,
    });
    const send = injected.tools.find((tool) => tool.name === SEND_MINION_PEER_TOOL)!;
    const result = await execTool(send, { to: peerId, body: "hello" });
    expect(result.details).toMatchObject({
      status: COMM_SEND_STATUS.senderNotLive,
    });
    expect(mailbox.list()).toEqual([]);
  });
});

describe("mailbox enqueue live-notify", () => {
  it("records and followUp-delivers without impersonating user mail", () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const { tree, childId, peerId, groupId } = groupTree();
    const { mailbox, followUps } = liveMailbox(tree, groupId, [childId, peerId]);
    const body = "overlap: a/b.ts with mn-self (Self task). Message them directly.";

    const notice = mailbox.enqueue({ from: childId, to: peerId, groupId, body });

    expect(notice).toMatchObject({ from: childId, to: peerId, groupId, body });
    expect(mailbox.list()).toEqual([expect.objectContaining({ id: notice.id, body })]);
    expect(mailbox.depthFor(peerId)).toBe(0);
    expect(followUps).toEqual([{ id: peerId, text: body }]);
    expect(followUps[0]?.text).not.toBe(formatMinionMail(childId, body));
    expect(tree.get(childId)?.messages ?? []).toEqual([]);
    expect(tree.get(peerId)?.messages ?? []).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      "comm",
      "enqueue",
      expect.objectContaining({
        messageId: notice.id,
        from: childId,
        to: peerId,
        bytes: Buffer.byteLength(body, "utf8"),
      }),
    );
    expect(info).not.toHaveBeenCalledWith("comm", "send", expect.anything());
  });

  it("does not apply the pending-depth cap and still delivers while user mail is full", () => {
    const { tree, childId, peerId, groupId } = groupTree();
    const { mailbox, followUps } = liveMailbox(tree, groupId, [childId, peerId]);

    for (let i = 0; i < MAX_MAILBOX_QUEUE_DEPTH; i++) {
      mailbox.send({
        from: childId,
        lifecycleId: tree.get(childId)?.lifecycleId,
        lifecycleEpoch: tree.get(childId)?.lifecycleEpoch,
        to: PARENT_RECIPIENT_ID,
        groupId,
        body: `pending-${i}`,
      });
    }
    expect(mailbox.depthFor(PARENT_RECIPIENT_ID)).toBe(MAX_MAILBOX_QUEUE_DEPTH);
    expect(
      mailbox.send({
        from: childId,
        lifecycleId: tree.get(childId)?.lifecycleId,
        lifecycleEpoch: tree.get(childId)?.lifecycleEpoch,
        to: PARENT_RECIPIENT_ID,
        groupId,
        body: "overflow",
      }).status,
    ).toBe(COMM_SEND_STATUS.mailboxFull);

    for (let i = 0; i < MAX_MAILBOX_QUEUE_DEPTH + 1; i++) {
      const notice = mailbox.enqueue({
        from: "overlap",
        to: peerId,
        groupId,
        body: `notice-${i}`,
      });
      expect(notice.body).toBe(`notice-${i}`);
    }
    expect(mailbox.depthFor(peerId)).toBe(0);
    expect(followUps).toEqual(
      Array.from({ length: MAX_MAILBOX_QUEUE_DEPTH + 1 }, (_, i) => ({
        id: peerId,
        text: `notice-${i}`,
      })),
    );
  });

  it("does not throw when the recipient is not live or followUp rejects", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { tree, childId, peerId, groupId } = groupTree();
    const { mailbox, followUps } = liveMailbox(tree, groupId, []);
    expect(() =>
      mailbox.enqueue({ from: childId, to: peerId, groupId, body: "offline" }),
    ).not.toThrow();
    expect(followUps).toEqual([]);
    expect(mailbox.list()).toHaveLength(1);

    const rejecting = new MinionCommMailbox({
      getTree: () => tree,
      getGroups: () => ({ getOpenGroup: () => ({ groupId, cwd: "/tmp" }) }),
      isLive: (id) => id === peerId,
      followUp: async () => {
        throw new Error("Child mn-peer is terminal; further mail is rejected");
      },
    });
    expect(() =>
      rejecting.enqueue({ from: childId, to: peerId, groupId, body: "race" }),
    ).not.toThrow();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        "comm",
        "enqueue-deliver-failed",
        expect.objectContaining({ to: peerId }),
      );
    });

    const syncThrow = new MinionCommMailbox({
      getTree: () => tree,
      getGroups: () => ({ getOpenGroup: () => ({ groupId, cwd: "/tmp" }) }),
      isLive: () => true,
      followUp: () => {
        throw new Error("sync followUp failure");
      },
    });
    expect(() =>
      syncThrow.enqueue({ from: childId, to: peerId, groupId, body: "sync" }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "comm",
      "enqueue-deliver-failed",
      expect.objectContaining({ error: "sync followUp failure" }),
    );
  });
});

describe("parent-directed wake hook", () => {
  it("calls onParentDirected for child→parent and not for peer or parent→child", async () => {
    const { tree, childId, peerId, groupId } = groupTree();
    const { mailbox, followUps, parentDirected, groups } = liveMailbox(tree, groupId, [
      childId,
      peerId,
    ]);
    const injected = injectForTest({
      childId,
      lifecycleId: tree.get(childId)!.lifecycleId!,
      epoch: tree.get(childId)!.lifecycleEpoch!,
      groupId,
      tree,
      groups: liveMailbox(tree, groupId, [childId]).groups,
      mailbox,
    });
    const send = injected.tools.find((tool) => tool.name === SEND_MINION_PEER_TOOL)!;

    const toParent = await execTool(send, { to: PARENT_RECIPIENT_ID, body: "need a ruling" });
    expect(toParent.details).toMatchObject({
      status: COMM_SEND_STATUS.queued,
      parentTurnTriggered: false,
    });
    expect(parentDirected).toEqual([
      { from: childId, to: PARENT_RECIPIENT_ID, body: "need a ruling" },
    ]);
    expect(followUps).toEqual([]);
    expect(tree.get(childId)?.status).toBe("running");

    const toPeer = await execTool(send, { to: peerId, body: "hello peer" });
    expect(toPeer.details).toMatchObject({ status: COMM_SEND_STATUS.queued });
    expect(parentDirected).toHaveLength(1);
    expect(followUps).toEqual([
      {
        id: peerId,
        text: formatMinionMail(childId, "hello peer", mailbox.list().at(-1)?.id),
      },
    ]);

    const parentTool = createSendMinionMessageTool({ mailbox, groups });
    const fromParent = await execTool(parentTool, { to: peerId, body: "steer this" });
    expect(fromParent.details).toMatchObject({
      status: COMM_SEND_STATUS.queued,
      from: PARENT_RECIPIENT_ID,
      parentTurnTriggered: false,
    });
    expect(parentDirected).toHaveLength(1);
  });

  it("still queues when onParentDirected throws", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { tree, childId, groupId } = groupTree();
    const { mailbox } = liveMailbox(tree, groupId, [childId], true, () => {
      throw new Error("wake exploded");
    });
    const result = mailbox.send({
      from: childId,
      lifecycleId: tree.get(childId)?.lifecycleId,
      lifecycleEpoch: tree.get(childId)?.lifecycleEpoch,
      to: PARENT_RECIPIENT_ID,
      groupId,
      body: "still record me",
    });
    expect(result.status).toBe(COMM_SEND_STATUS.queued);
    expect(mailbox.depthFor(PARENT_RECIPIENT_ID)).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      "comm",
      "parent-directed-wake-failed",
      expect.objectContaining({ error: "wake exploded", from: childId }),
    );
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
      {
        id: peerId,
        text: formatMinionMail(
          PARENT_RECIPIENT_ID,
          "from parent",
          (sent.details as { messageId?: string }).messageId,
        ),
      },
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
    tree.add("mn-a", "alpha", "task a", {
      kind: "orchestrated",
      groupId,
      description: "A",
      lifecycleId: "life-a",
      lifecycleEpoch: 1,
    });
    tree.add("mn-b", "bravo", "task b", {
      kind: "orchestrated",
      groupId,
      description: "B",
      lifecycleId: "life-b",
      lifecycleEpoch: 1,
    });

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
    const groups = new OrchestrationGroupState();
    groups.commitGroup({ groupId, cwd });
    groups.acceptLiveWork(groupId, [
      { childId: "mn-a", lifecycleId: "life-a" },
      { childId: "mn-b", lifecycleId: "life-b" },
    ]);

    const mailbox = new MinionCommMailbox({
      getTree: () => tree,
      getGroups: () => groups,
      isLive: (id) => manager.isLive(id),
      followUp: async (id, text) => {
        const handle = manager.getSessionHandle(id);
        if (!handle) throw new Error(`Child ${id} is terminal; further mail is rejected`);
        await handle.followUp(text);
      },
    });
    mailboxGroups.set(mailbox, groups);

    const injectA = injectForTest({
      childId: "mn-a",
      groupId,
      tree,
      mailbox,
    });
    const injectB = injectForTest({
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
    expect(sessions.get("mn-b")?.followUps).toEqual([
      formatMinionMail("mn-a", "hello from a", (peer.details as { messageId?: string }).messageId),
    ]);
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
      formatMinionMail(
        PARENT_RECIPIENT_ID,
        "steer this",
        (fromParent.details as { messageId?: string }).messageId,
      ),
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

describe("mailbox vs child terminal single winner", () => {
  it("mail then settle delivers and emits one settled", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const cwd = tempDir("pi-minions-mail-settle-mb-");
    const tree = new AgentTree();
    const groupId = "grp-race";
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

    await manager.startChild({
      id: "mn-b",
      name: "mn-b",
      task: "do the work",
      config: agentConfig,
      spawnedBy: "test",
      cwd,
      modelRegistry: {} as never,
      parentToolNames: ["read", "bash"],
      toolSyncEnabled: false,
    });
    const handle = manager.getSessionHandle("mn-b");
    expect(handle).toBeDefined();

    const sent = mailbox.send({
      from: PARENT_RECIPIENT_ID,
      to: "mn-b",
      groupId,
      body: "keep going",
    });
    expect(sent.status).toBe(COMM_SEND_STATUS.queued);
    await vi.waitFor(() => {
      expect(sessions.get("mn-b")?.followUps).toEqual([
        formatMinionMail(PARENT_RECIPIENT_ID, "keep going", sent.messageId),
      ]);
    });
    expect(manager.getTerminal("mn-b")).toBeUndefined();
    expect(sessions.get("mn-b")?.disposed).toBe(false);

    sessions.get("mn-b")?.emit({ type: "agent_settled" });
    await Promise.resolve();
    expect(manager.getTerminal("mn-b")).toBeUndefined();

    sessions.get("mn-b")?.idleDeferred.resolve();
    sessions.get("mn-b")?.emit({ type: "agent_settled" });
    const terminal = await handle!.wait();
    expect(terminal.class).toBe("settled");
    expect(sessions.get("mn-b")?.disposed).toBe(true);

    const committed = info.mock.calls.filter(
      (call) =>
        call[0] === "subsession" &&
        call[1] === "lifecycle" &&
        (call[2] as { terminalLatchFired?: boolean }).terminalLatchFired === true,
    );
    expect(committed).toHaveLength(1);
    expect(committed[0]?.[2]).toMatchObject({
      eventClass: "settled",
      winner: "mail-then-settle",
      terminalEventCount: 1,
    });

    const late = mailbox.send({
      from: PARENT_RECIPIENT_ID,
      to: "mn-b",
      groupId,
      body: "too late",
    });
    expect(late.status).toBe(COMM_SEND_STATUS.recipientTerminal);
  });

  it("settle then mail is recipient-terminal with one settle winner", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const cwd = tempDir("pi-minions-settle-mail-mb-");
    const tree = new AgentTree();
    const groupId = "grp-race";
    tree.add("mn-b", "bravo", "task b", { kind: "orchestrated", groupId, description: "B" });

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

    const handle = await manager.startChild({
      id: "mn-b",
      name: "mn-b",
      task: "do the work",
      config: agentConfig,
      spawnedBy: "test",
      cwd,
      modelRegistry: {} as never,
      parentToolNames: ["read", "bash"],
      toolSyncEnabled: false,
    });

    session.emit({ type: "agent_settled" });
    await expect(handle.wait()).resolves.toMatchObject({ class: "settled" });
    expect(session.disposed).toBe(true);

    const late = mailbox.send({
      from: PARENT_RECIPIENT_ID,
      to: "mn-b",
      groupId,
      body: "too late",
    });
    expect(late.status).toBe(COMM_SEND_STATUS.recipientTerminal);
    expect(session.followUps).toEqual([]);

    const committed = info.mock.calls.filter(
      (call) =>
        call[0] === "subsession" &&
        call[1] === "lifecycle" &&
        (call[2] as { terminalLatchFired?: boolean }).terminalLatchFired === true,
    );
    expect(committed).toHaveLength(1);
    expect(committed[0]?.[2]).toMatchObject({
      eventClass: "settled",
      winner: "settle",
      terminalEventCount: 1,
    });
  });

  it("caps accepted inspection history deterministically without evicting pending evidence", () => {
    const { tree, peerId, groupId } = groupTree();
    const { mailbox } = liveMailbox(tree, groupId, [peerId]);
    for (let index = 0; index < MAX_MAILBOX_HISTORY + 44; index++) {
      mailbox.send({
        from: PARENT_RECIPIENT_ID,
        to: peerId,
        groupId,
        body: `accepted-${index}`,
      });
      mailbox.ackPending(peerId, [mailbox.list().at(-1)!.id]);
    }
    expect(mailbox.list()).toHaveLength(MAX_MAILBOX_HISTORY);
    expect(mailbox.list()[0]?.body).toBe("accepted-44");
    expect(mailbox.inspectionCounts().pending).toBe(0);
  });
});
