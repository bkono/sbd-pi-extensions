import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  filterMinions,
  type ListMinionsParams,
  listMinions,
  showMinion,
  toInfo,
} from "../tools/minions.js";
import { AgentTree } from "../tree.js";

const ctx = {} as ExtensionContext;

afterEach(() => {
  vi.restoreAllMocks();
});

function logNode(
  label: string,
  node: { id: string; kind?: string; groupId?: string; status: string },
) {
  console.log(label, {
    id: node.id,
    kind: node.kind ?? "spawn",
    groupId: node.groupId,
    status: node.status,
  });
}

function seedTree(): AgentTree {
  const tree = new AgentTree();
  tree.add("mn-spawn", "alpha", "foreground task");
  tree.add("mn-orch-a", "bravo", "implement the registry", {
    kind: "orchestrated",
    groupId: "grp-1",
    role: "hard_problem_coder",
    taskType: "implementation",
    description: "Registry refactor",
    domain: { source: "adapter-x", workItemId: "ABC-123" },
  });
  tree.add("mn-orch-b", "charlie", "review the registry", {
    kind: "orchestrated",
    groupId: "grp-1",
    role: "reviewer",
    taskType: "reviewImplementation",
    description: "Review registry",
  });
  tree.add("mn-orch-other", "delta", "other group prompt", {
    kind: "orchestrated",
    groupId: "grp-2",
    description: "Other group",
  });
  tree.updateStatus("mn-orch-other", "completed", 0);
  tree.updateActivity("mn-orch-a", "checking auth middleware");
  tree.updateInspection("mn-orch-a", {
    output: "full child transcript lives here, not in packets",
    messages: [
      { from: "mn-orch-b", to: "mn-orch-a", text: "need the types first" },
      { from: "mn-orch-a", to: "parent", text: "peer send failed", failed: true },
    ],
    pathIntent: [{ path: "src/registry.ts", ttlMs: 30_000 }],
    peerMessageFailed: true,
    lastPeerError: "recipient-terminal",
  });
  tree.logActivity("mn-orch-a", "→ grep auth");
  return tree;
}

async function list(tree: AgentTree, params: ListMinionsParams = {}) {
  return listMinions(tree)("tool-1", params, undefined, undefined, ctx);
}

async function show(tree: AgentTree, target: string) {
  return showMinion(tree)("tool-1", { target }, undefined, undefined, ctx);
}

describe("list_minions filters", () => {
  it("lists spawn and orchestrated together and filters by kind, group, and status", async () => {
    const tree = seedTree();

    const all = await list(tree);
    const allIds = all.details.minions.map((m) => m.id);
    for (const m of all.details.minions) logNode("list-all", m);

    expect(allIds).toEqual(["mn-spawn", "mn-orch-a", "mn-orch-b", "mn-orch-other"]);
    expect(all.content[0]?.text).toContain("alpha (mn-spawn) spawn [running]");
    expect(all.content[0]?.text).toContain(
      "bravo (mn-orch-a) orchestrated [running] implementation group=grp-1",
    );
    expect(all.content[0]?.text).toContain("[peer-failed]");

    const spawnOnly = await list(tree, { kind: "spawn" });
    for (const m of spawnOnly.details.minions) logNode("list-spawn", m);
    expect(spawnOnly.details.minions.map((m) => m.id)).toEqual(["mn-spawn"]);
    expect(spawnOnly.details.minions[0]?.kind).toBe("spawn");
    expect(spawnOnly.details.minions[0]?.groupId).toBeUndefined();

    const orch = await list(tree, { kind: "orchestrated" });
    for (const m of orch.details.minions) logNode("list-orchestrated", m);
    expect(orch.details.minions.map((m) => m.id)).toEqual([
      "mn-orch-a",
      "mn-orch-b",
      "mn-orch-other",
    ]);
    expect(orch.details.minions.every((m) => m.kind === "orchestrated")).toBe(true);

    const group1 = await list(tree, { groupId: "grp-1" });
    for (const m of group1.details.minions) logNode("list-group", m);
    expect(group1.details.minions.map((m) => m.id)).toEqual(["mn-orch-a", "mn-orch-b"]);

    const running = await list(tree, { status: "running" });
    for (const m of running.details.minions) logNode("list-running", m);
    expect(running.details.minions.map((m) => m.id)).toEqual([
      "mn-spawn",
      "mn-orch-a",
      "mn-orch-b",
    ]);

    const spawnInGroup = filterMinions([tree.get("mn-spawn")!, tree.get("mn-orch-a")!], {
      kind: "spawn",
      groupId: "grp-1",
    });
    expect(spawnInGroup).toEqual([]);
  });

  it("exposes last said and peer-message failure so the parent can inspect without packets", async () => {
    const tree = seedTree();
    const listed = await list(tree, { kind: "orchestrated", groupId: "grp-1" });
    const bravo = listed.details.minions.find((m) => m.id === "mn-orch-a");
    logNode("list-comm", bravo!);

    expect(bravo?.taskType).toBe("implementation");
    expect(bravo?.lastSaid).toBe("→ grep auth");
    expect(bravo?.peerMessageFailed).toBe(true);
    expect(bravo?.lastPeerError).toBe("recipient-terminal");
    expect(listed.content[0]?.text).toContain("-- → grep auth");
  });
});

describe("show_minion fields", () => {
  it("shows orchestrated metadata, full output, messages, path intent, and activity", async () => {
    const tree = seedTree();
    const result = await show(tree, "mn-orch-a");
    const info = result.details;
    logNode("show-orchestrated", info);

    expect(info.kind).toBe("orchestrated");
    expect(info.groupId).toBe("grp-1");
    expect(info.status).toBe("running");
    expect(info.role).toBe("hard_problem_coder");
    expect(info.taskType).toBe("implementation");
    expect(info.description).toBe("Registry refactor");
    expect(info.domain).toEqual({ source: "adapter-x", workItemId: "ABC-123" });
    expect(info.lastSaid).toBe("→ grep auth");
    expect(info.peerMessageFailed).toBe(true);
    expect(info.lastPeerError).toBe("recipient-terminal");
    expect(info.output).toBe("full child transcript lives here, not in packets");
    expect(info.messages).toEqual([
      { from: "mn-orch-b", to: "mn-orch-a", text: "need the types first" },
      { from: "mn-orch-a", to: "parent", text: "peer send failed", failed: true },
    ]);
    expect(info.pathIntent).toEqual([{ path: "src/registry.ts", ttlMs: 30_000 }]);
    expect(info.activityHistory).toContain("→ grep auth");

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Kind: orchestrated");
    expect(text).toContain("Group: grp-1");
    expect(text).toContain("Task type: implementation");
    expect(text).toContain("Last said: → grep auth");
    expect(text).toContain("Peer message: failed (recipient-terminal)");
    expect(text).toContain("full child transcript lives here, not in packets");
    expect(text).toContain("mn-orch-b -> mn-orch-a: need the types first");
    expect(text).toContain("src/registry.ts ttl=30000ms");
  });

  it("distinguishes spawn from orchestrated and omits group fields for spawn", async () => {
    const tree = seedTree();
    const result = await show(tree, "mn-spawn");
    logNode("show-spawn", result.details);

    expect(result.details.kind).toBe("spawn");
    expect(result.details.groupId).toBeUndefined();
    expect(result.details.taskType).toBeUndefined();
    expect(result.details.peerMessageFailed).toBe(false);
    expect(result.content[0]?.text).toContain("Kind: spawn");
    expect(result.content[0]?.text).not.toContain("Task type:");
    expect(result.content[0]?.text).toContain("Peer message: none");
    expect(toInfo(tree.get("mn-spawn")!).kind).toBe("spawn");
  });

  it("throws for a missing id", async () => {
    const tree = seedTree();
    await expect(show(tree, "missing")).rejects.toThrow("Minion not found: missing");
  });

  it("falls back to persisted session output when tree and terminal are empty", async () => {
    const tree = new AgentTree();
    tree.add("mn-done", "alpha", "finished");
    tree.updateStatus("mn-done", "completed", 0);

    const result = await showMinion(tree, {
      getTerminal: () => undefined,
      parseSessionOutput: () => "persisted transcript",
    })("tool-1", { target: "mn-done" }, undefined, undefined, ctx);

    expect(result.details.output).toBe("persisted transcript");
    expect(result.content[0]?.text).toContain("Output:\n    persisted transcript");
  });
});
