import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { AgentTree, PARENT_SESSION_RESTARTED, rehydratePersistedMinion } from "../tree.js";
import type { OrchestrationDomain } from "../types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function logNode(
  label: string,
  node: { id: string; kind?: string; groupId?: string; taskType?: string; description?: string },
) {
  console.log(label, {
    id: node.id,
    kind: node.kind,
    groupId: node.groupId,
    taskType: node.taskType,
    description: node.description,
  });
}

describe("AgentTree spawn default", () => {
  it("defaults positional add() to kind spawn and does not infer description from task", () => {
    const tree = new AgentTree();
    const node = tree.add(
      "mn-spawn",
      "alpha",
      "Implement the registry refactor",
      undefined,
      "ephemeral",
      "gpt-test",
    );

    logNode("spawn-default", node);

    expect(node.kind).toBe("spawn");
    expect(node.task).toBe("Implement the registry refactor");
    expect(node.description).toBeUndefined();
    expect(node.groupId).toBeUndefined();
    expect(node.role).toBeUndefined();
    expect(node.taskType).toBeUndefined();
    expect(node.domain).toBeUndefined();
    expect(node.agentName).toBe("ephemeral");
    expect(node.model).toBe("gpt-test");
  });
});

describe("AgentTree orchestrated group snapshot", () => {
  it("returns only live orchestrated members of one group and excludes spawn", () => {
    const tree = new AgentTree();
    tree.add("mn-spawn", "alpha", "foreground task");
    tree.add("mn-orch-a", "bravo", "child a prompt", {
      kind: "orchestrated",
      groupId: "grp-1",
      description: "Child A",
    });
    tree.add("mn-orch-b", "charlie", "child b prompt", {
      kind: "orchestrated",
      groupId: "grp-1",
      description: "Child B",
    });
    tree.add("mn-orch-other", "delta", "other group prompt", {
      kind: "orchestrated",
      groupId: "grp-2",
      description: "Other group",
    });
    tree.add("mn-spawn-grouped", "echo", "spawn with a groupId", {
      kind: "spawn",
      groupId: "grp-1",
      description: "Should never snapshot",
    });

    const snapshot = tree.getOrchestratedGroup("grp-1");
    for (const node of snapshot) logNode("snapshot-live", node);

    expect(snapshot.map((n) => n.id)).toEqual(["mn-orch-a", "mn-orch-b"]);
    expect(snapshot.every((n) => n.kind === "orchestrated")).toBe(true);
    expect(snapshot.some((n) => n.kind === "spawn")).toBe(false);
    expect(tree.get("mn-spawn")?.status).toBe("running");
  });

  it("excludes terminal orchestrated nodes from still-running snapshots", () => {
    const tree = new AgentTree();
    tree.add("mn-running", "alpha", "running prompt", {
      kind: "orchestrated",
      groupId: "grp-1",
      description: "Running",
    });
    tree.add("mn-pending", "bravo", "pending prompt", {
      kind: "orchestrated",
      groupId: "grp-1",
      description: "Pending",
    });
    tree.updateStatus("mn-pending", "pending");
    tree.add("mn-completed", "charlie", "completed prompt", {
      kind: "orchestrated",
      groupId: "grp-1",
      description: "Completed",
    });
    tree.add("mn-failed", "delta", "failed prompt", {
      kind: "orchestrated",
      groupId: "grp-1",
      description: "Failed",
    });
    tree.add("mn-aborted", "echo", "aborted prompt", {
      kind: "orchestrated",
      groupId: "grp-1",
      description: "Aborted",
    });
    tree.updateStatus("mn-completed", "completed", 0);
    tree.updateStatus("mn-failed", "failed", 1, "boom");
    tree.updateStatus("mn-aborted", "aborted");

    const snapshot = tree.getOrchestratedGroup("grp-1");
    for (const node of snapshot) logNode("snapshot-non-terminal", node);

    expect(snapshot.map((n) => n.id).sort()).toEqual(["mn-pending", "mn-running"]);
    expect(snapshot.map((n) => n.status).sort()).toEqual(["pending", "running"]);
    expect(
      tree
        .listOrchestratedGroup("grp-1")
        .map((n) => n.id)
        .sort(),
    ).toEqual(["mn-aborted", "mn-completed", "mn-failed", "mn-pending", "mn-running"]);
  });
});

describe("AgentTree orchestration metadata", () => {
  it("round-trips role, taskType, description, and opaque domain without ticket parsing", () => {
    const tree = new AgentTree();
    const domain: OrchestrationDomain = {
      source: "adapter-x",
      scopeId: "scope-9",
      workItemId: "ABC-123",
      title: "not a parsed ticket",
    };
    const node = tree.add("mn-orch", "alpha", "Implement the registry refactor in full", {
      kind: "orchestrated",
      groupId: "grp-1",
      role: "hard_problem_coder",
      taskType: "implementation",
      description: "Registry refactor",
      domain,
    });

    logNode("metadata-round-trip", node);
    console.log("domain", node.domain);

    expect(node.kind).toBe("orchestrated");
    expect(node.groupId).toBe("grp-1");
    expect(node.role).toBe("hard_problem_coder");
    expect(node.taskType).toBe("implementation");
    expect(node.description).toBe("Registry refactor");
    expect(node.description).not.toBe(node.task);
    expect(node.domain).toEqual(domain);
    expect(node.domain).toBe(domain);
    expect(tree.get("mn-orch")?.domain?.workItemId).toBe("ABC-123");
    expect(tree.getLiveByWorkItemId("ABC-123").map((n) => n.id)).toEqual(["mn-orch"]);
    expect(tree.getLiveByWorkItemId("abc-123")).toEqual([]);
    expect(tree.getLiveByWorkItemId("ABC")).toEqual([]);

    tree.updateStatus("mn-orch", "completed", 0);
    expect(tree.getLiveByWorkItemId("ABC-123")).toEqual([]);
    expect(tree.getOrchestratedGroup("grp-1")).toEqual([]);
  });
});

describe("AgentTree first terminal wins", () => {
  it("ignores later status writes after completed, failed, or aborted", () => {
    const tree = new AgentTree();
    tree.add("mn-aborted", "alpha", "halted task");
    tree.updateStatus("mn-aborted", "aborted", 1, "halted");
    tree.updateStatus("mn-aborted", "completed", 0);
    tree.updateStatus("mn-aborted", "failed", 1, "later failure");
    tree.updateStatus("mn-aborted", "running");

    expect(tree.get("mn-aborted")?.status).toBe("aborted");
    expect(tree.get("mn-aborted")?.error).toBe("halted");
    expect(tree.get("mn-aborted")?.exitCode).toBe(1);

    tree.add("mn-done", "bravo", "finished");
    tree.updateStatus("mn-done", "completed", 0);
    tree.updateStatus("mn-done", "aborted");
    expect(tree.get("mn-done")?.status).toBe("completed");
    expect(tree.get("mn-done")?.exitCode).toBe(0);
  });
});

describe("rehydratePersistedMinion", () => {
  it("rehydrates running metadata as aborted and persists the restart error", () => {
    const tree = new AgentTree();
    const persist = vi.fn();
    rehydratePersistedMinion(
      tree,
      {
        sessionId: "mn-live",
        name: "alpha",
        task: "old work",
        agent: "ephemeral",
        status: "running",
      },
      persist,
    );

    expect(tree.get("mn-live")?.status).toBe("aborted");
    expect(tree.get("mn-live")?.error).toBe(PARENT_SESSION_RESTARTED);
    expect(persist).toHaveBeenCalledWith("mn-live", "aborted", undefined, PARENT_SESSION_RESTARTED);
  });

  it("keeps real terminal statuses without persisting a restart abort", () => {
    const tree = new AgentTree();
    const persist = vi.fn();
    rehydratePersistedMinion(
      tree,
      {
        sessionId: "mn-done",
        name: "bravo",
        task: "finished work",
        status: "completed",
        exitCode: 0,
      },
      persist,
    );
    rehydratePersistedMinion(
      tree,
      {
        sessionId: "mn-failed",
        name: "charlie",
        task: "broke",
        status: "failed",
        exitCode: 1,
        error: "boom",
      },
      persist,
    );

    expect(tree.get("mn-done")?.status).toBe("completed");
    expect(tree.get("mn-done")?.exitCode).toBe(0);
    expect(tree.get("mn-done")?.kind).toBe("spawn");
    expect(tree.get("mn-failed")?.status).toBe("failed");
    expect(tree.get("mn-failed")?.error).toBe("boom");
    expect(persist).not.toHaveBeenCalled();
  });

  it("rehydrates completed orchestrated metadata with kind and fleet fields", () => {
    const tree = new AgentTree();
    const persist = vi.fn();
    rehydratePersistedMinion(
      tree,
      {
        sessionId: "mn-orch",
        name: "bravo",
        task: "implement the registry",
        agent: "reviewer",
        status: "completed",
        exitCode: 0,
        kind: "orchestrated",
        groupId: "grp-1",
        role: "reviewer",
        taskType: "reviewImplementation",
        description: "Review registry",
        domain: { source: "adapter-x", workItemId: "ABC-123" },
      },
      persist,
    );

    const node = tree.get("mn-orch");
    expect(node?.kind).toBe("orchestrated");
    expect(node?.groupId).toBe("grp-1");
    expect(node?.role).toBe("reviewer");
    expect(node?.taskType).toBe("reviewImplementation");
    expect(node?.description).toBe("Review registry");
    expect(node?.domain).toEqual({ source: "adapter-x", workItemId: "ABC-123" });
    expect(node?.agentName).toBe("reviewer");
    expect(node?.status).toBe("completed");
    expect(persist).not.toHaveBeenCalled();
  });

  it("aborts running orchestrated metadata without dropping kind", () => {
    const tree = new AgentTree();
    const persist = vi.fn();
    rehydratePersistedMinion(
      tree,
      {
        sessionId: "mn-live-orch",
        name: "alpha",
        task: "old work",
        agent: "ephemeral",
        status: "running",
        kind: "orchestrated",
        groupId: "grp-1",
        role: "reviewer",
        taskType: "reviewImplementation",
        description: "Review registry",
        domain: { source: "adapter-x", workItemId: "ABC-123" },
      },
      persist,
    );

    const node = tree.get("mn-live-orch");
    expect(node?.status).toBe("aborted");
    expect(node?.error).toBe(PARENT_SESSION_RESTARTED);
    expect(node?.kind).toBe("orchestrated");
    expect(node?.groupId).toBe("grp-1");
    expect(node?.role).toBe("reviewer");
    expect(node?.taskType).toBe("reviewImplementation");
    expect(node?.description).toBe("Review registry");
    expect(node?.domain).toEqual({ source: "adapter-x", workItemId: "ABC-123" });
    expect(persist).toHaveBeenCalledWith(
      "mn-live-orch",
      "aborted",
      undefined,
      PARENT_SESSION_RESTARTED,
    );
  });
});

describe("AgentTree add logging", () => {
  it("logs id, kind, groupId, taskType, and description on add", () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const tree = new AgentTree();

    tree.add("mn-spawn", "alpha", "foreground task");
    tree.add("mn-orch", "bravo", "child prompt", {
      kind: "orchestrated",
      groupId: "grp-1",
      role: "reviewer",
      taskType: "reviewImplementation",
      description: "Review registry",
    });

    expect(info).toHaveBeenCalledWith("tree", "add", {
      id: "mn-spawn",
      kind: "spawn",
      groupId: undefined,
      taskType: undefined,
      description: undefined,
    });
    expect(info).toHaveBeenCalledWith("tree", "add", {
      id: "mn-orch",
      kind: "orchestrated",
      groupId: "grp-1",
      taskType: "reviewImplementation",
      description: "Review registry",
    });
  });
});
