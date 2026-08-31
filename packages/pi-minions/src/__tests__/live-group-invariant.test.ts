import { describe, expect, it } from "vitest";
import {
  createLiveGroupPromptHandler,
  formatLiveGroupInvariant,
  LiveGroupSystemPromptController,
} from "../live-group-invariant.js";
import { OrchestrationGroupState } from "../orchestration/group-state.js";
import { AgentTree } from "../tree.js";

function openArmedGroup(groups: OrchestrationGroupState, groupId: string): void {
  groups.commitGroup({ groupId, cwd: "/tmp" });
  groups.acceptLiveWork(groupId, [{ childId: "mn-live", lifecycleId: `${groupId}-lifecycle` }]);
}

function addOrchestrated(tree: AgentTree, id: string, groupId: string): void {
  tree.add(id, id, `task ${id}`, {
    kind: "orchestrated",
    groupId,
    description: `description ${id}`,
    status: "pending",
  });
}

describe("live group system-prompt invariant", () => {
  it("appends bounded per-turn system copy while pending or running orchestrated work is live", () => {
    const tree = new AgentTree();
    const groups = new OrchestrationGroupState();
    openArmedGroup(groups, "grp-live");
    addOrchestrated(tree, "mn-pending", "grp-live");
    addOrchestrated(tree, "mn-running", "grp-live");
    tree.markLiveHandle("mn-running");
    tree.applyActivityEvent("mn-running", { type: "waiting" });

    const handler = createLiveGroupPromptHandler(
      () => tree,
      () => groups,
    );
    const result = handler({ systemPrompt: "base prompt" });
    const invariant = formatLiveGroupInvariant("grp-live");

    expect(result).toEqual({ systemPrompt: `base prompt\n\n${invariant}` });
    expect(invariant).toContain("Background orchestration work is live");
    expect(invariant).toContain("end this turn");
    expect(invariant).toMatch(/inspect\/message\/halt/);
    expect(invariant).toContain("safe non-overlapping work");
    expect(invariant).toContain("Do not claim delegated work or the orchestration goal complete");
    expect(invariant.length).toBeLessThanOrEqual(300);
    const hostile = formatLiveGroupInvariant(`grp\n\u001b[31m${"x".repeat(500)}`);
    expect(hostile.length).toBeLessThanOrEqual(300);
    expect(hostile).not.toContain("\n");
    expect(hostile).not.toContain("\u001b");
  });

  it("returns nothing for no group, an idle group, terminal members, or spawn-only work", () => {
    const tree = new AgentTree();
    const groups = new OrchestrationGroupState();
    const handler = createLiveGroupPromptHandler(
      () => tree,
      () => groups,
    );

    tree.add("mn-spawn", "spawn", "foreground");
    expect(handler({ systemPrompt: "base" })).toBeUndefined();

    groups.commitGroup({ groupId: "grp-idle", cwd: "/tmp" });
    expect(handler({ systemPrompt: "base" })).toBeUndefined();

    groups.acceptLiveWork("grp-idle", [{ childId: "mn-done", lifecycleId: "idle-lifecycle" }]);
    addOrchestrated(tree, "mn-done", "grp-idle");
    tree.updateStatus("mn-done", "completed", 0);
    expect(handler({ systemPrompt: "base" })).toBeUndefined();
  });

  it("rebuilds from replacement session state and never retains the old tree or group", () => {
    let tree = new AgentTree();
    let groups = new OrchestrationGroupState();
    openArmedGroup(groups, "grp-old");
    addOrchestrated(tree, "mn-old", "grp-old");

    const handler = createLiveGroupPromptHandler(
      () => tree,
      () => groups,
    );
    expect(handler({ systemPrompt: "base" })?.systemPrompt).toContain("grp-old");

    tree = new AgentTree();
    groups = new OrchestrationGroupState();
    expect(handler({ systemPrompt: "replacement base" })).toBeUndefined();

    openArmedGroup(groups, "grp-new");
    addOrchestrated(tree, "mn-new", "grp-new");
    const replacement = handler({ systemPrompt: "replacement base" });
    expect(replacement?.systemPrompt).toContain("grp-new");
    expect(replacement?.systemPrompt).not.toContain("grp-old");
  });

  it("disposes dynamic prompt state across session replacement", () => {
    let tree = new AgentTree();
    let groups = new OrchestrationGroupState();
    const applied: Array<string | undefined> = [];
    openArmedGroup(groups, "grp-old");
    addOrchestrated(tree, "mn-old", "grp-old");
    const controller = new LiveGroupSystemPromptController(
      () => tree,
      () => groups,
      (invariant) => applied.push(invariant),
    );

    controller.sync();
    controller.reset();
    tree = new AgentTree();
    groups = new OrchestrationGroupState();
    controller.sync();
    openArmedGroup(groups, "grp-new");
    addOrchestrated(tree, "mn-new", "grp-new");
    controller.sync();

    expect(applied).toEqual([
      formatLiveGroupInvariant("grp-old"),
      undefined,
      formatLiveGroupInvariant("grp-new"),
    ]);
  });
});
