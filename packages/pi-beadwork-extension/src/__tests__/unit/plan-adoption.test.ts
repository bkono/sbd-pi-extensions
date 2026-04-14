import { describe, expect, it, vi } from "vitest";
import {
  applyAdoptionPlan,
  buildAdoptionPlan,
  formatAdoptionPreview,
  resolvePlanSource,
} from "../../plan-adoption.js";

describe("plan adoption", () => {
  it("builds a multi-step plan with sequential dependencies by default", () => {
    const plan = buildAdoptionPlan(
      `# Ship feature\n\n1. Add parser\n2. Wire commands\n3. Add tests`,
    );

    expect(plan.title).toBe("Ship feature");
    expect(plan.landMode).toBe("multi");
    expect(plan.steps).toHaveLength(3);
    expect(plan.dependencies).toEqual([
      { blockerIndex: 1, blockedIndex: 2 },
      { blockerIndex: 2, blockedIndex: 3 },
    ]);
    expect(plan.dependencyStrategy).toBe("sequential");
    expect(formatAdoptionPreview(plan)).toContain("Dependencies: 2 (sequential)");
  });

  it("prefers explicit mermaid dependencies when present", () => {
    const plan = buildAdoptionPlan(
      `# Ship feature\n\n1. Add parser\n2. Wire commands\n3. Add tests\n\n\`\`\`mermaid\ngraph LR\n1 --> 3\n2 --> 3\n\`\`\``,
    );

    expect(plan.dependencies).toEqual([
      { blockerIndex: 1, blockedIndex: 3 },
      { blockerIndex: 2, blockedIndex: 3 },
    ]);
    expect(plan.dependencyStrategy).toBe("explicit");
  });

  it("resolves plan text from editor or recent session messages", () => {
    const fromEditor = resolvePlanSource("", "1. Editor plan", []);
    expect(fromEditor).toBe("1. Editor plan");

    const fromSession = resolvePlanSource("", "", [
      {
        type: "message",
        message: {
          content: [{ type: "text", text: "Plan:\n1. Session plan" }],
        },
      },
    ]);
    expect(fromSession).toContain("Session plan");
  });

  it("applies a multi-step plan into an epic, children, and dependencies", async () => {
    const adapter = {
      createIssue: vi
        .fn()
        .mockResolvedValueOnce({
          issue: {
            id: "BW-200",
            title: "Ship feature",
            description: "",
            status: "open",
            type: "epic",
            priority: 2,
            labels: [],
            blockedBy: [],
            blocks: [],
            assignee: "",
            createdAt: "",
            updatedAt: "",
          },
        })
        .mockResolvedValueOnce({
          issue: {
            id: "BW-200.1",
            title: "Add parser",
            description: "",
            status: "open",
            type: "task",
            priority: 2,
            labels: [],
            blockedBy: [],
            blocks: [],
            assignee: "",
            createdAt: "",
            updatedAt: "",
            parentId: "BW-200",
          },
        })
        .mockResolvedValueOnce({
          issue: {
            id: "BW-200.2",
            title: "Wire commands",
            description: "",
            status: "open",
            type: "task",
            priority: 2,
            labels: [],
            blockedBy: [],
            blocks: [],
            assignee: "",
            createdAt: "",
            updatedAt: "",
            parentId: "BW-200",
          },
        }),
      addDependency: vi.fn().mockResolvedValue(undefined),
    };

    const plan = buildAdoptionPlan(`# Ship feature\n\n1. Add parser\n2. Wire commands`);
    const result = await applyAdoptionPlan(adapter as never, "/repo", plan);

    expect(result.root?.id).toBe("BW-200");
    expect(result.created).toHaveLength(3);
    expect(adapter.addDependency).toHaveBeenCalledWith("/repo", "BW-200.1", "BW-200.2");
  });
});
