import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  announcePathIntent,
  inspectPathIntent,
  normalizeIntentPath,
  PathOverlapLog,
  pathsOverlap,
} from "../coordination/index.js";
import { logger } from "../logger.js";
import {
  ANNOUNCE_MINION_PATHS_TOOL,
  createLifecyclePacketDispatcher,
  INSPECT_MINION_PATHS_TOOL,
  injectOrchestratedCommTools,
  type LifecyclePacketDetails,
  MinionCommMailbox,
  ORCHESTRATED_COMM_TOOL_NAMES,
  OrchestrationGroupState,
} from "../orchestration/index.js";
import { AgentTree } from "../tree.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const CWD = "/repo";

function groupTree() {
  const tree = new AgentTree();
  const groupId = "grp-1";
  const childId = "mn-self";
  const peerId = "mn-peer";
  tree.add(childId, "alpha", "self prompt", {
    kind: "orchestrated",
    groupId,
    description: "Self task",
  });
  tree.add(peerId, "bravo", "peer prompt", {
    kind: "orchestrated",
    groupId,
    description: "Peer task",
  });
  tree.add("mn-done", "charlie", "done prompt", {
    kind: "orchestrated",
    groupId,
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

async function execTool(tool: ToolDefinition, params: unknown) {
  const result = await tool.execute(
    "call-1",
    params as never,
    undefined,
    undefined,
    {} as ExtensionContext,
  );
  return result as { content: Array<{ text?: string }>; details: unknown };
}

describe("path matcher", () => {
  it("treats a/b.ts as overlapping a/ (ancestor/descendant)", () => {
    const file = normalizeIntentPath("a/b.ts", CWD);
    const dir = normalizeIntentPath("a/", CWD);
    console.log("overlap-descendant", { file, dir, overlap: pathsOverlap(file, dir) });
    expect(file).toBe("a/b.ts");
    expect(dir).toBe("a");
    expect(pathsOverlap(file, dir)).toBe(true);
    expect(pathsOverlap(dir, file)).toBe(true);
  });

  it("does not treat a/b.ts as overlapping c/", () => {
    const file = normalizeIntentPath("a/b.ts", CWD);
    const other = normalizeIntentPath("c/", CWD);
    console.log("no-overlap-sibling", { file, other, overlap: pathsOverlap(file, other) });
    expect(pathsOverlap(file, other)).toBe(false);
  });

  it("treats * and braces as literal segments (no glob engine)", () => {
    const star = normalizeIntentPath("a/*.ts", CWD);
    const brace = normalizeIntentPath("a/{b,c}.ts", CWD);
    const file = normalizeIntentPath("a/b.ts", CWD);
    console.log("literal-glob", { star, brace, file });
    expect(star).toBe("a/*.ts");
    expect(brace).toBe("a/{b,c}.ts");
    expect(pathsOverlap(star, file)).toBe(false);
    expect(pathsOverlap(brace, file)).toBe(false);
    expect(pathsOverlap(star, star)).toBe(true);
  });

  it("lexically normalizes . / .. and POSIX-ish separators against group cwd", () => {
    expect(normalizeIntentPath("a/./b/../c.ts", CWD)).toBe("a/c.ts");
    expect(normalizeIntentPath("a\\b.ts", CWD)).toBe("a/b.ts");
    expect(normalizeIntentPath("/repo/a/b.ts", CWD)).toBe("a/b.ts");
    expect(normalizeIntentPath("./a/b.ts", CWD)).toBe("a/b.ts");
    expect(
      pathsOverlap(normalizeIntentPath("a/./b.ts", CWD), normalizeIntentPath("a/b.ts", CWD)),
    ).toBe(true);
  });
});

describe("announce and inspect tools", () => {
  it("announces TTL intent, overlaps a/b.ts with a/, and never rejects the edit", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const { tree, childId, peerId, groupId } = groupTree();
    const mailbox = new MinionCommMailbox();
    const overlaps = new PathOverlapLog();
    const now = 1_000;

    const peerInjected = injectOrchestratedCommTools({
      childId: peerId,
      groupId,
      cwd: CWD,
      tree,
      mailbox,
      overlaps,
      now: () => now,
    });
    const peerAnnounce = peerInjected.tools.find(
      (tool) => tool.name === ANNOUNCE_MINION_PATHS_TOOL,
    );
    const peerAnnounced = await execTool(peerAnnounce!, { paths: ["a/"], ttlMs: 30_000 });
    expect(peerAnnounced.details).toMatchObject({
      overlap: false,
      editAllowed: true,
      paths: ["a"],
    });

    const injected = injectOrchestratedCommTools({
      childId,
      groupId,
      cwd: CWD,
      tree,
      mailbox,
      overlaps,
      now: () => now,
    });
    expect(injected.names).toEqual([...ORCHESTRATED_COMM_TOOL_NAMES]);
    expect(injected.names).toContain(ANNOUNCE_MINION_PATHS_TOOL);
    expect(injected.names).toContain(INSPECT_MINION_PATHS_TOOL);

    const announce = injected.tools.find((tool) => tool.name === ANNOUNCE_MINION_PATHS_TOOL)!;
    const announced = await execTool(announce, { paths: ["a/b.ts"], ttlMs: 30_000 });
    const details = announced.details as {
      paths: string[];
      overlap: boolean;
      editAllowed: boolean;
      overlaps: Array<{ otherId: string; otherDescription?: string; path: string }>;
    };

    console.log("announce-overlap", {
      paths: details.paths,
      childId,
      peerId,
      overlap: details.overlap,
      editAllowed: details.editAllowed,
    });

    expect(details.paths).toEqual(["a/b.ts"]);
    expect(details.overlap).toBe(true);
    expect(details.editAllowed).toBe(true);
    expect(details.overlaps).toEqual([
      expect.objectContaining({
        otherId: peerId,
        otherDescription: "Peer task",
        path: "a/b.ts",
        otherPath: "a",
      }),
    ]);
    expect(announced.content[0]?.text).toContain("Peer task");
    expect(announced.content[0]?.text).toContain("send_minion_peer");
    expect(announced.content[0]?.text).toMatch(/not blocked/i);

    expect(mailbox.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: childId,
          to: peerId,
          groupId,
        }),
      ]),
    );
    expect(mailbox.list()).toHaveLength(1);
    expect(mailbox.list()[0]?.body).toContain("Self task");
    expect(mailbox.list()[0]?.body).toMatch(/not blocked/i);

    expect(overlaps.list()).toEqual([
      expect.objectContaining({
        childId,
        otherId: peerId,
        path: "a/b.ts",
        otherPath: "a",
        editAllowed: true,
      }),
    ]);

    expect(info).toHaveBeenCalledWith(
      "path-intent",
      "announce",
      expect.objectContaining({
        paths: ["a/b.ts"],
        childId,
        overlap: true,
        editAllowed: true,
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "path-intent",
      "overlap",
      expect.objectContaining({
        paths: ["a/b.ts", "a"],
        childId,
        otherId: peerId,
        overlap: true,
        editAllowed: true,
      }),
    );

    const inspect = injected.tools.find((tool) => tool.name === INSPECT_MINION_PATHS_TOOL)!;
    const inspected = await execTool(inspect, {});
    expect(inspected.details).toMatchObject({
      groupId,
      intents: expect.arrayContaining([
        expect.objectContaining({ childId, path: "a/b.ts", overlapping: true }),
        expect.objectContaining({ childId: peerId, path: "a", overlapping: true }),
      ]),
    });
  });

  it("does not overlap a/b.ts with c/ and still allows the edit", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const { tree, childId, peerId, groupId } = groupTree();
    const mailbox = new MinionCommMailbox();
    const now = 1_000;
    injectOrchestratedCommTools({
      childId: peerId,
      groupId,
      cwd: CWD,
      tree,
      mailbox,
      now: () => now,
    });
    announcePathIntent({
      tree,
      childId: peerId,
      groupId,
      cwd: CWD,
      paths: ["c/"],
      ttlMs: 30_000,
      now,
    });

    const injected = injectOrchestratedCommTools({
      childId,
      groupId,
      cwd: CWD,
      tree,
      mailbox,
      now: () => now,
    });
    const announce = injected.tools.find((tool) => tool.name === ANNOUNCE_MINION_PATHS_TOOL)!;
    const announced = await execTool(announce, { paths: ["a/b.ts"], ttlMs: 10_000 });
    const details = announced.details as {
      overlap: boolean;
      editAllowed: boolean;
      paths: string[];
    };
    console.log("announce-no-overlap", {
      paths: details.paths,
      childId,
      peerId,
      overlap: details.overlap,
      editAllowed: details.editAllowed,
    });
    expect(details.overlap).toBe(false);
    expect(details.editAllowed).toBe(true);
    expect(mailbox.list()).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      "path-intent",
      "announce",
      expect.objectContaining({
        paths: ["a/b.ts"],
        childId,
        overlap: false,
        editAllowed: true,
      }),
    );
  });

  it("expires intent by TTL without implying the agent stopped", async () => {
    const { tree, childId, groupId } = groupTree();
    const mailbox = new MinionCommMailbox();
    let now = 1_000;
    const injected = injectOrchestratedCommTools({
      childId,
      groupId,
      cwd: CWD,
      tree,
      mailbox,
      now: () => now,
    });
    const announce = injected.tools.find((tool) => tool.name === ANNOUNCE_MINION_PATHS_TOOL)!;
    const inspect = injected.tools.find((tool) => tool.name === INSPECT_MINION_PATHS_TOOL)!;

    await execTool(announce, { paths: ["a/b.ts"], ttlMs: 50 });
    now = 1_049;
    const before = await execTool(inspect, {});
    expect((before.details as { intents: unknown[] }).intents).toEqual([
      expect.objectContaining({ childId, path: "a/b.ts" }),
    ]);

    now = 1_050;
    const after = await execTool(inspect, {});
    console.log("ttl-expiry", {
      childId,
      status: tree.get(childId)?.status,
      intents: (after.details as { intents: unknown[] }).intents,
    });
    expect((after.details as { intents: unknown[] }).intents).toEqual([]);
    expect(tree.get(childId)?.status).toBe("running");
    expect(tree.get(childId)?.pathIntent).toEqual([]);
    expect(after.content[0]?.text).toMatch(/does not mean an agent stopped/i);
  });

  it("does not announce for spawn children", () => {
    const { tree, groupId } = groupTree();
    const injected = injectOrchestratedCommTools({
      childId: "mn-spawn",
      groupId,
      cwd: CWD,
      tree,
      mailbox: new MinionCommMailbox(),
      kind: "spawn",
    });
    expect(injected.names).toEqual([]);
    expect(injected.names).not.toContain(ANNOUNCE_MINION_PATHS_TOOL);

    const result = announcePathIntent({
      tree,
      childId: "mn-spawn",
      groupId,
      cwd: CWD,
      paths: ["a/b.ts"],
      ttlMs: 30_000,
      now: 1_000,
    });
    expect(tree.get("mn-spawn")?.pathIntent).toBeUndefined();
    expect(result.overlap).toBe(false);
    expect(result.editAllowed).toBe(true);
  });

  it("ignores terminal and cross-group intent when detecting overlap", () => {
    const { tree, childId, groupId } = groupTree();
    announcePathIntent({
      tree,
      childId: "mn-done",
      groupId,
      cwd: CWD,
      paths: ["a/"],
      ttlMs: 30_000,
      now: 1_000,
    });
    announcePathIntent({
      tree,
      childId: "mn-other",
      groupId: "grp-2",
      cwd: CWD,
      paths: ["a/b.ts"],
      ttlMs: 30_000,
      now: 1_000,
    });
    const result = announcePathIntent({
      tree,
      childId,
      groupId,
      cwd: CWD,
      paths: ["a/b.ts"],
      ttlMs: 30_000,
      now: 1_000,
    });
    expect(result.overlap).toBe(false);
    expect(result.editAllowed).toBe(true);
  });
});

describe("overlap on next real parent packet", () => {
  it("does not wake the parent on overlap; surfaces metadata on the next real packet", () => {
    const { tree, childId, peerId, groupId } = groupTree();
    const overlaps = new PathOverlapLog();
    const pending: Array<() => void> = [];
    const sendMessage = vi.fn();
    const groups = new OrchestrationGroupState();
    groups.commitGroup({ groupId, cwd: CWD });
    const lifecycleId = "test-overlap-lifecycle";
    const node = tree.get(childId);
    if (node) node.lifecycleId = lifecycleId;
    const epoch = groups.acceptLiveWork(groupId, [{ childId, lifecycleId }]);
    if (epoch !== undefined) tree.setLifecycleEpoch(childId, lifecycleId, epoch);
    const dispatcher = createLifecyclePacketDispatcher({
      getTree: () => tree,
      getGroups: () => groups,
      sendMessage: sendMessage as ExtensionAPI["sendMessage"],
      now: () => 10_000,
      schedule: (run) => pending.push(run),
      peekOverlaps: (groupIds) => overlaps.peek(groupIds),
      ackOverlaps: (ids) => {
        overlaps.ack(ids);
      },
    });

    announcePathIntent({
      tree,
      childId: peerId,
      groupId,
      cwd: CWD,
      paths: ["a/"],
      ttlMs: 30_000,
      now: 1_000,
      overlaps,
    });
    announcePathIntent({
      tree,
      childId,
      groupId,
      cwd: CWD,
      paths: ["a/b.ts"],
      ttlMs: 30_000,
      now: 1_000,
      overlaps,
    });

    while (pending.length > 0) pending.shift()?.();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(overlaps.list()).toHaveLength(1);

    tree.updateStatus(childId, "completed", 0);
    dispatcher.enqueue({
      class: "settled",
      groupId,
      childId,
      lifecycleId,
      epoch: epoch ?? -1,
      output: "done",
    });
    while (pending.length > 0) pending.shift()?.();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const details = sendMessage.mock.calls[0]?.[0]?.details as LifecyclePacketDetails;
    const content = sendMessage.mock.calls[0]?.[0]?.content as string;
    console.log("packet-overlaps", {
      seq: details.seq,
      childIds: details.changed.map((child) => child.childId),
      overlap: details.overlaps.map((notice) => ({
        childId: notice.childId,
        otherId: notice.otherId,
        path: notice.path,
        editAllowed: notice.editAllowed,
      })),
    });
    expect(details.overlaps).toEqual([
      expect.objectContaining({
        childId,
        childDescription: "Self task",
        otherId: peerId,
        otherDescription: "Peer task",
        path: "a/b.ts",
        otherPath: "a",
        editAllowed: true,
      }),
    ]);
    expect(content).toContain("Overlaps (advisory; edits are not blocked)");
    expect(content).toContain("Peer task");
    expect(content).toContain("send_minion_peer");
    expect(overlaps.list()).toEqual([]);
  });
});

describe("inspectPathIntent helper", () => {
  it("marks overlapping live intents and skips expired ones", () => {
    const { tree, childId, peerId, groupId } = groupTree();
    announcePathIntent({
      tree,
      childId: peerId,
      groupId,
      cwd: CWD,
      paths: ["a/"],
      ttlMs: 50,
      now: 1_000,
    });
    announcePathIntent({
      tree,
      childId,
      groupId,
      cwd: CWD,
      paths: ["a/b.ts", "z.ts"],
      ttlMs: 50,
      now: 1_000,
    });
    const live = inspectPathIntent({ tree, groupId, now: 1_000 });
    expect(live.intents.find((intent) => intent.path === "a/b.ts")?.overlapping).toBe(true);
    expect(live.intents.find((intent) => intent.path === "a")?.overlapping).toBe(true);
    expect(live.intents.find((intent) => intent.path === "z.ts")?.overlapping).toBe(false);

    const expired = inspectPathIntent({ tree, groupId, now: 1_050 });
    expect(expired.intents).toEqual([]);
    expect(tree.get(childId)?.status).toBe("running");
    expect(tree.get(peerId)?.status).toBe("running");
  });
});
