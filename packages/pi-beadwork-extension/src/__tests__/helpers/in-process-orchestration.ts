/**
 * Reusable in-process orchestration harness for sbdpi-vur.4.2 / 4.3 / 4.6.
 *
 * 4.3 (ticket-policy epic e2e) and 4.6 (scope-policy epic e2e) MUST import this
 * module rather than forking a second git/bw/scripted-parent fixture:
 *
 *   import {
 *     createGitBwFixture,
 *     createInProcessHarness,
 *     withInProcessHarness,
 *   } from "../helpers/in-process-orchestration.js";
 *
 * Scripted parent turns + stub child sessions. Real `/bw run`, orchestrate,
 * SubsessionManager (session factory), and packet dispatcher. No paid LLM.
 * PATH has no tmux. Child output is unstructured prose.
 */
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { PathOverlapLog } from "../../../../pi-minions/src/coordination/index.js";
import {
  ANNOUNCE_MINION_PATHS_TOOL,
  COMM_SEND_STATUS,
  type CommSendDetails,
  createLifecyclePacketDispatcher,
  formatMinionMail,
  LIFECYCLE_PACKET_CUSTOM_TYPE,
  type LifecyclePacketDetails,
  MinionCommMailbox,
  ORCHESTRATED_COMM_TOOL_NAMES,
  OrchestrationGroupState,
  PARENT_ONLY_MINION_TOOLS,
  PARENT_RECIPIENT_ID,
  SEND_MINION_MESSAGE_TOOL,
  SEND_MINION_PEER_TOOL,
  sendMinionMessage,
} from "../../../../pi-minions/src/orchestration/index.js";
import {
  BEADWORK_CHILD_INSPECTION_TOOLS,
  SubsessionManager,
} from "../../../../pi-minions/src/subsessions/manager.js";
import type { CreateChildRuntimeInput } from "../../../../pi-minions/src/subsessions/types.js";
import { halt } from "../../../../pi-minions/src/tools/halt.js";
import type { MinionInfo } from "../../../../pi-minions/src/tools/minions.js";
import { listMinions, showMinion } from "../../../../pi-minions/src/tools/minions.js";
import { orchestrate } from "../../../../pi-minions/src/tools/orchestrate.js";
import { AgentTree } from "../../../../pi-minions/src/tree.js";
import type { OrchestrateInput, OrchestrateResult } from "../../../../pi-minions/src/types.js";
import beadworkExtension from "../../index.js";
import {
  createExtensionTestHarness,
  createFakeExtensionContext,
  createFakeUi,
  type ExtensionTestHarness,
  type FakeUi,
} from "./extension-harness.js";
import {
  createGitBwFixture,
  type GitBwFixture,
  type GitBwFixtureOptions,
  snapshotTmuxPids,
} from "./git-bw-fixture.js";
import { probeRemovedSymbols } from "./removed-symbol-probes.js";
import { ScriptedChildSession } from "./scripted-child.js";

export type {
  FixtureTicketSpec,
  GitBwFixture,
  GitBwFixtureOptions,
} from "./git-bw-fixture.js";
export { createGitBwFixture, snapshotTmuxPids } from "./git-bw-fixture.js";
export { ScriptedChildSession } from "./scripted-child.js";
export {
  ANNOUNCE_MINION_PATHS_TOOL,
  BEADWORK_CHILD_INSPECTION_TOOLS,
  COMM_SEND_STATUS,
  formatMinionMail,
  LIFECYCLE_PACKET_CUSTOM_TYPE,
  ORCHESTRATED_COMM_TOOL_NAMES,
  PARENT_ONLY_MINION_TOOLS,
  PARENT_RECIPIENT_ID,
  SEND_MINION_MESSAGE_TOOL,
  SEND_MINION_PEER_TOOL,
};

export const PARENT_CODING_TOOLS = ["read", "bash", "edit", "write", "grep"] as const;

export const BEADWORK_MUTATION_TOOLS = [
  "beadwork_create_issue",
  "beadwork_update_issue",
  "beadwork_add_dependency",
  "beadwork_remove_dependency",
  "beadwork_start_issue",
  "beadwork_close_issue",
  "beadwork_reopen_issue",
  "beadwork_comment_issue",
  "beadwork_label_issue",
  "beadwork_defer_issue",
  "beadwork_undefer_issue",
  "beadwork_sync",
  "beadwork_start_goal",
] as const;

export const DENIED_CHILD_BEADWORK_TOOLS = [
  "beadwork_close_issue",
  "beadwork_start_issue",
  "beadwork_reopen_issue",
  "beadwork_start_goal",
] as const;

const ALL_BEADWORK_TOOLS = [
  ...BEADWORK_CHILD_INSPECTION_TOOLS,
  ...BEADWORK_MUTATION_TOOLS,
] as const;

export type StepLogEntry = {
  timestamp: string;
  step: string;
  epicId?: string;
  ticketId?: string;
  childId?: string;
  groupId?: string;
  issueStatus?: string;
  packetCount: number;
  /** Active review policy. Filled from the fixture unless a step overrides it. */
  policy?: string;
  eventClass?: string;
  packetSeq?: number;
  issueIds?: string[];
  childIds?: string[];
};

export type LaunchedChild = {
  id: string;
  taskType?: string;
  description?: string;
  status: string;
};

export function listLaunchedChildren(tree: Pick<AgentTree, "getRoots">): LaunchedChild[] {
  return tree.getRoots().map((node) => ({
    id: node.id,
    taskType: node.taskType,
    description: node.description,
    status: node.status,
  }));
}

export function listLaunchedTaskTypes(
  tree: Pick<AgentTree, "getRoots">,
): Array<string | undefined> {
  return listLaunchedChildren(tree).map((child) => child.taskType);
}

export class StepLog {
  readonly entries: StepLogEntry[] = [];

  record(entry: Omit<StepLogEntry, "timestamp">): StepLogEntry {
    const full: StepLogEntry = { timestamp: new Date().toISOString(), ...entry };
    this.entries.push(full);
    console.info("[in-process]", full);
    return full;
  }
}

export type SentPacket = {
  message: {
    customType: string;
    content: string;
    display: boolean;
    details: LifecyclePacketDetails;
  };
  options?: { triggerTurn?: boolean; deliverAs?: string };
};

export type InProcessHarnessOptions = {
  fixture?: GitBwFixture;
  fixtureOptions?: GitBwFixtureOptions;
  log?: StepLog;
  sessionId?: string;
};

export type InProcessHarness = {
  fixture: GitBwFixture;
  log: StepLog;
  ui: FakeUi;
  ctx: ExtensionCommandContext;
  beadwork: ExtensionTestHarness;
  tree: AgentTree;
  groups: OrchestrationGroupState;
  mailbox: MinionCommMailbox;
  overlaps: PathOverlapLog;
  manager: SubsessionManager;
  children: Map<string, ScriptedChildSession>;
  packets: SentPacket[];
  tmuxPidsAtStart: string[];
  parentToolNames: string[];
  logStep: (step: string, extra?: Partial<StepLogEntry>) => Promise<StepLogEntry>;
  bwRun: (
    epicId: string,
    mode?: ExtensionContext["mode"],
  ) => Promise<{ ui: FakeUi; ctx: ExtensionCommandContext }>;
  injectedPrompt: () => string | undefined;
  orchestrate: (input: OrchestrateInput) => Promise<OrchestrateResult>;
  listMinions: () => Promise<{ minions: MinionInfo[]; text: string }>;
  showMinion: (target: string) => Promise<unknown>;
  halt: (id: string) => Promise<unknown>;
  sendMinionMessage: (to: string, body: string) => Promise<CommSendDetails>;
  invokeBeadworkTool: (name: string, params: unknown) => Promise<unknown>;
  invokeChildTool: (childId: string, name: string, params: unknown) => Promise<unknown>;
  waitForChild: (childId: string) => Promise<ScriptedChildSession>;
  waitUntilRunning: (childId: string) => Promise<void>;
  childActiveTools: (childId: string) => string[];
  settleChild: (childId: string, prose: string) => Promise<void>;
  settleChildren: (entries: Array<{ childId: string; prose: string }>) => Promise<void>;
  waitForPackets: (count: number) => Promise<SentPacket[]>;
  lastPacket: () => SentPacket | undefined;
  launchedChildren: () => LaunchedChild[];
  launchedTaskTypes: () => Array<string | undefined>;
  assertNoTmuxOrWorktree: () => Promise<void>;
  dumpFailure: (error?: unknown) => Promise<void>;
  dispose: () => Promise<void>;
};

function parentToolNamesFrom(beadwork: ExtensionTestHarness): string[] {
  const beadworkNames = [...beadwork.tools.keys()];
  return [
    ...PARENT_CODING_TOOLS,
    ...PARENT_ONLY_MINION_TOOLS,
    "list_minions",
    "show_minion",
    ...beadworkNames,
  ];
}

export async function createInProcessHarness(
  options: InProcessHarnessOptions = {},
): Promise<InProcessHarness> {
  const ownsFixture = options.fixture === undefined;
  const fixture = options.fixture ?? (await createGitBwFixture(options.fixtureOptions));
  const log = options.log ?? new StepLog();
  const tmuxPidsAtStart = await snapshotTmuxPids();
  const ui = createFakeUi();
  const ctx = createFakeExtensionContext({
    cwd: fixture.cwd,
    ui,
    mode: "tui",
    sessionId: options.sessionId ?? "in-process-parent",
    isIdle: () => true,
  });
  const beadwork = await createExtensionTestHarness(beadworkExtension);
  await beadwork.dispatch("session_start", {}, ctx);

  const tree = new AgentTree();
  const groups = new OrchestrationGroupState();
  const packets: SentPacket[] = [];
  const overlaps = new PathOverlapLog();
  let mailbox!: MinionCommMailbox;
  const dispatcher = createLifecyclePacketDispatcher({
    getTree: () => tree,
    getGroups: () => groups,
    sendMessage: (message, sendOptions) => {
      packets.push({
        message: message as SentPacket["message"],
        options: sendOptions as SentPacket["options"],
      });
    },
    peekOverlaps: (groupIds) => overlaps.peek(groupIds),
    ackOverlaps: (ids) => {
      overlaps.ack(ids);
    },
    peekParentMail: (childId, lifecycleId) => {
      const messages = mailbox
        .peekPending(PARENT_RECIPIENT_ID, childId)
        .filter((message) => message.lifecycleId === lifecycleId);
      if (messages.length === 0) return undefined;
      return {
        ids: messages.map((message) => message.id),
        text: messages.map((message) => message.body).join("\n\n"),
      };
    },
    ackParentMail: (snapshot) => {
      mailbox.ackPending(PARENT_RECIPIENT_ID, snapshot.ids);
    },
  });
  dispatcher.open();

  const children = new Map<string, ScriptedChildSession>();
  const parentTools = parentToolNamesFrom(beadwork);
  const manager = new SubsessionManager(fixture.cwd, join(fixture.cwd, "parent.jsonl"), undefined, {
    createChildRuntime: async (input: CreateChildRuntimeInput) => {
      const session = new ScriptedChildSession(
        [...PARENT_CODING_TOOLS, ...ALL_BEADWORK_TOOLS],
        input.customTools ?? [],
      );
      children.set(input.id, session);
      return {
        runtime: {
          session,
          dispose: () => {
            session.dispose();
          },
        },
        sessionPath: join(input.cwd, `${input.id}.jsonl`),
      };
    },
  });

  mailbox = new MinionCommMailbox({
    getTree: () => tree,
    getGroups: () => groups,
    isLive: (id) => manager.isLive(id),
    followUp: async (id, text) => {
      const handle = manager.getSessionHandle(id);
      if (!handle) {
        throw new Error(`Child ${id} is terminal; further mail is rejected`);
      }
      await handle.followUp(text);
    },
    onParentDirected: (message) => {
      dispatcher.enqueue({
        class: "parentMessage",
        groupId: message.groupId,
        childId: message.from,
        output: message.body,
        lifecycleId: message.lifecycleId ?? "",
        epoch:
          message.lifecycleId === undefined
            ? -1
            : (groups.getLifecycleRegistration(message.lifecycleId)?.epoch ?? -1),
      });
    },
  });

  const executeOrchestrate = orchestrate({
    tree,
    pi: {
      getAllTools: () => parentTools.map((name) => ({ name })),
    } as Pick<ExtensionAPI, "getAllTools">,
    subsessionManager: manager,
    groups,
    mailbox,
    overlaps,
    onLifecycle: (event) => dispatcher.enqueue(event),
  });
  const executeList = listMinions(tree);
  const executeShow = showMinion(tree, manager);
  const executeHalt = halt(tree, manager, groups);
  const executeSend = sendMinionMessage({ mailbox, groups });

  const ids = () => ({
    epicId: fixture.epic.id,
    ticketId: fixture.tickets[0]?.id,
  });

  const logStep = async (
    step: string,
    extra: Partial<StepLogEntry> = {},
  ): Promise<StepLogEntry> => {
    const ticketId = extra.ticketId ?? ids().ticketId;
    let issueStatus = extra.issueStatus;
    if (issueStatus === undefined && ticketId) {
      try {
        issueStatus = (await fixture.show(ticketId)).status;
      } catch {
        issueStatus = "unknown";
      }
    }
    const last = packets.at(-1);
    return log.record({
      step,
      epicId: extra.epicId ?? ids().epicId,
      ticketId,
      childId: extra.childId,
      groupId: extra.groupId ?? groups.getOpenGroup()?.groupId,
      issueStatus,
      packetCount: extra.packetCount ?? packets.length,
      policy: extra.policy ?? fixture.reviewPolicy,
      eventClass:
        extra.eventClass ??
        last?.message.details.changed.map((child) => child.eventClass).join(",") ??
        undefined,
      packetSeq: extra.packetSeq ?? last?.message.details.seq,
      issueIds: extra.issueIds,
      childIds: extra.childIds,
    });
  };

  const waitForChild = async (childId: string): Promise<ScriptedChildSession> => {
    const started = Date.now();
    while (Date.now() - started < 5_000) {
      const session =
        children.get(childId) ?? (manager.getSession(childId) as ScriptedChildSession);
      if (session) {
        return session;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Child ${childId} did not start`);
  };

  const waitUntilRunning = async (childId: string): Promise<void> => {
    const started = Date.now();
    while (Date.now() - started < 5_000) {
      const status = tree.get(childId)?.status;
      if (status === "running") {
        return;
      }
      if (status && status !== "pending") {
        throw new Error(`Child ${childId} became ${status} without running`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Child ${childId} did not become running (status=${tree.get(childId)?.status ?? "missing"})`,
    );
  };

  const harness: InProcessHarness = {
    fixture,
    log,
    ui,
    ctx,
    beadwork,
    tree,
    groups,
    mailbox,
    overlaps,
    manager,
    children,
    packets,
    tmuxPidsAtStart,
    parentToolNames: parentTools,
    logStep,
    async bwRun(epicId, mode = "tui") {
      if (mode === ctx.mode) {
        await beadwork.invokeCommand("bw", `run ${epicId}`, ctx);
        return { ui, ctx };
      }
      const hostUi = createFakeUi();
      const runCtx = createFakeExtensionContext({
        cwd: fixture.cwd,
        ui: hostUi,
        mode,
        sessionId: `${ctx.sessionManager.getSessionId()}-${mode}`,
      });
      await beadwork.invokeCommand("bw", `run ${epicId}`, runCtx);
      return { ui: hostUi, ctx: runCtx };
    },
    injectedPrompt() {
      const sent = beadwork.sentMessages.find((entry) => {
        const message = entry.message as { customType?: string; content?: string };
        return message?.customType === "beadwork-goal-run";
      });
      const message = sent?.message as { content?: string } | undefined;
      return message?.content;
    },
    async orchestrate(input) {
      const result = await executeOrchestrate(
        "parent-orchestrate",
        input,
        undefined,
        undefined,
        ctx,
      );
      return result.details as OrchestrateResult;
    },
    async listMinions() {
      const result = await executeList("parent-list", {}, undefined, undefined, ctx);
      return {
        minions: result.details?.minions ?? [],
        text: result.content.map((block) => ("text" in block ? String(block.text) : "")).join("\n"),
      };
    },
    async showMinion(target) {
      return executeShow("parent-show", { target }, undefined, undefined, ctx);
    },
    async halt(id) {
      return executeHalt("parent-halt", { id }, undefined, undefined, ctx);
    },
    async sendMinionMessage(to, body) {
      const result = await executeSend("parent-send", { to, body }, undefined, undefined, ctx);
      return result.details as CommSendDetails;
    },
    async invokeBeadworkTool(name, params) {
      const tool = beadwork.tools.get(name) as
        | { execute?: (...args: unknown[]) => unknown }
        | undefined;
      if (!tool || typeof tool.execute !== "function") {
        throw new Error(`Beadwork tool not registered: ${name}`);
      }
      return tool.execute("parent-bw-tool", params, undefined, undefined, ctx);
    },
    async invokeChildTool(childId, name, params) {
      const session = await waitForChild(childId);
      return session.executeTool(name, params);
    },
    waitForChild,
    waitUntilRunning,
    childActiveTools(childId) {
      const session = children.get(childId);
      if (!session) {
        throw new Error(`Unknown child ${childId}`);
      }
      return session.getActiveToolNames();
    },
    async settleChild(childId, prose) {
      const session = await waitForChild(childId);
      session.finishWithProse(prose);
      const started = Date.now();
      while (Date.now() - started < 5_000) {
        if (manager.getTerminal(childId)) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Child ${childId} did not settle`);
    },
    async settleChildren(entries) {
      const sessions = await Promise.all(entries.map((entry) => waitForChild(entry.childId)));
      for (const [index, entry] of entries.entries()) {
        sessions[index]?.finishWithProse(entry.prose);
      }
      const started = Date.now();
      while (Date.now() - started < 5_000) {
        if (entries.every((entry) => manager.getTerminal(entry.childId))) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const pending = entries
        .filter((entry) => !manager.getTerminal(entry.childId))
        .map((entry) => entry.childId);
      throw new Error(`Children did not settle: ${pending.join(", ")}`);
    },
    async waitForPackets(count) {
      const started = Date.now();
      while (Date.now() - started < 5_000) {
        if (packets.length >= count) {
          return packets;
        }
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${count} packets; have ${packets.length}`);
    },
    lastPacket() {
      return packets.at(-1);
    },
    launchedChildren() {
      return listLaunchedChildren(tree);
    },
    launchedTaskTypes() {
      return listLaunchedTaskTypes(tree);
    },
    async assertNoTmuxOrWorktree() {
      if (fixture.tmuxOnPath()) {
        throw new Error(`tmux is on PATH: ${fixture.tmuxOnPath()}`);
      }
      const pids = await snapshotTmuxPids();
      const spawned = pids.filter((pid) => !tmuxPidsAtStart.includes(pid));
      if (spawned.length > 0) {
        throw new Error(`tmux process spawned: ${spawned.join(", ")}`);
      }
      const worktrees = await fixture.worktreePaths();
      if (worktrees.length !== 1) {
        throw new Error(`expected one worktree, got ${JSON.stringify(worktrees)}`);
      }
      if (worktrees[0] !== fixture.cwd) {
        throw new Error(`unexpected worktree ${worktrees[0]} (cwd ${fixture.cwd})`);
      }
    },
    async dumpFailure(error) {
      const ticketId = fixture.tickets[0]?.id;
      let ticketShow: unknown;
      try {
        ticketShow = ticketId ? await fixture.show(ticketId) : undefined;
      } catch (showError) {
        ticketShow = {
          error: showError instanceof Error ? showError.message : String(showError),
        };
      }
      const childId = [...children.keys()].at(-1);
      let epicShow: unknown;
      try {
        epicShow = await fixture.show(fixture.epic.id);
      } catch (showError) {
        epicShow = {
          error: showError instanceof Error ? showError.message : String(showError),
        };
      }
      let ready: unknown;
      try {
        ready = await fixture.ready();
      } catch (readyError) {
        ready = { error: readyError instanceof Error ? readyError.message : String(readyError) };
      }
      let removedSymbolProbes: unknown;
      try {
        removedSymbolProbes = await probeRemovedSymbols();
      } catch (probeError) {
        removedSymbolProbes = {
          error: probeError instanceof Error ? probeError.message : String(probeError),
        };
      }
      const dump = {
        error: error instanceof Error ? error.message : error ? String(error) : undefined,
        injectedPrompt: harness.injectedPrompt(),
        lastPacket: harness.lastPacket(),
        lastPackets: packets.slice(-5),
        fleet: tree.getRoots().map((node) => ({
          id: node.id,
          kind: node.kind,
          status: node.status,
          description: node.description,
          taskType: node.taskType,
          domain: node.domain,
          groupId: node.groupId,
        })),
        launchedTaskTypes: listLaunchedTaskTypes(tree),
        ticketShow,
        epicShow,
        ready,
        activeTools: childId ? harness.childActiveTools(childId) : [],
        removedSymbolProbes,
        tmuxProbe: {
          onPath: fixture.tmuxOnPath() ?? null,
          path: process.env.PATH,
        },
        steps: log.entries,
      };
      console.error("[in-process] failure dump", JSON.stringify(dump, null, 2));
    },
    async dispose() {
      dispatcher.close();
      await manager.disposeAll();
      if (ownsFixture) {
        await fixture.dispose();
      }
    },
  };

  await logStep("harness-ready");
  return harness;
}

export async function withInProcessHarness(
  options: InProcessHarnessOptions,
  run: (harness: InProcessHarness) => Promise<void>,
): Promise<void> {
  const harness = await createInProcessHarness(options);
  try {
    await run(harness);
  } catch (error) {
    await harness.dumpFailure(error);
    throw error;
  } finally {
    await harness.dispose();
  }
}
