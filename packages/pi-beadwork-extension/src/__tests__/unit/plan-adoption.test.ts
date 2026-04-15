import { describe, expect, it, vi } from "vitest";
import {
  applyAdoptionPlan,
  buildAdoptionPlan,
  formatAdoptionPreview,
  resolvePlanSource,
} from "../../plan-adoption.js";

describe("plan adoption", () => {
  it("does not infer step graphs from markdown bullets by default", () => {
    const plan = buildAdoptionPlan(
      `# Ship feature\n\n1. Add parser\n2. Wire commands\n3. Add tests`,
    );

    expect(plan.title).toBe("Ship feature");
    expect(plan.sourceKind).toBe("inline");
    expect(plan.sourceLabel).toBe("inline markdown argument");
    expect(plan.landMode).toBe("branch");
    expect(plan.steps).toHaveLength(0);
    expect(plan.dependencies).toEqual([]);
    expect(plan.dependencyStrategy).toBe("none");
    expect(formatAdoptionPreview(plan)).toContain("Source excerpt:");
    expect(formatAdoptionPreview(plan)).toContain("No automatic graph parsing is performed");
  });

  it("builds an explicit multi-step graph when steps/dependencies are provided", () => {
    const plan = buildAdoptionPlan(`# Ship feature`, {
      landMode: "multi",
      steps: [{ title: "Add parser" }, { title: "Wire commands" }, { title: "Add tests" }],
      dependencies: [
        { blockerIndex: 1, blockedIndex: 3 },
        { blockerIndex: 2, blockedIndex: 3 },
      ],
    });

    expect(plan.steps.map((step) => step.title)).toEqual([
      "Add parser",
      "Wire commands",
      "Add tests",
    ]);
    expect(plan.dependencies).toEqual([
      { blockerIndex: 1, blockedIndex: 3 },
      { blockerIndex: 2, blockedIndex: 3 },
    ]);
    expect(plan.dependencyStrategy).toBe("explicit");
  });

  it("resolves plan text from explicit file input, inline markdown, or editor markdown", () => {
    expect(
      resolvePlanSource({
        inlineText: "inline plan",
        editorText: "editor plan",
        file: { path: "/tmp/plan.md", markdown: "file plan" },
      }),
    ).toEqual({
      kind: "file",
      markdown: "file plan",
      label: "file:/tmp/plan.md",
      path: "/tmp/plan.md",
    });

    expect(
      resolvePlanSource({
        inlineText: "inline plan",
        editorText: "editor plan",
      }),
    ).toEqual({
      kind: "inline",
      markdown: "inline plan",
      label: "inline markdown argument",
    });

    expect(
      resolvePlanSource({
        inlineText: "",
        editorText: "editor plan",
      }),
    ).toEqual({
      kind: "editor",
      markdown: "editor plan",
      label: "active editor markdown",
    });

    expect(
      resolvePlanSource({
        inlineText: "inline plan",
        editorText: "editor plan",
        file: { path: "/tmp/empty.md", markdown: "   " },
      }),
    ).toBeUndefined();
  });

  it("applies an explicit multi-step plan into an epic, children, and dependencies", async () => {
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

    const plan = buildAdoptionPlan(`# Ship feature`, {
      landMode: "multi",
      steps: [{ title: "Add parser" }, { title: "Wire commands" }],
      dependencies: [{ blockerIndex: 1, blockedIndex: 2 }],
    });
    const result = await applyAdoptionPlan(adapter as never, "/repo", plan);

    expect(result.root?.id).toBe("BW-200");
    expect(result.created).toHaveLength(3);
    expect(adapter.addDependency).toHaveBeenCalledWith("/repo", "BW-200.1", "BW-200.2");
  });
});
