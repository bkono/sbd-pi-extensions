import { describe, expect, it, vi } from "vitest";
import { DelegateClarifyComponent } from "../../tui/delegate-clarify.js";
import type { BeadworkIssueDetail } from "../../types.js";

function createIssue(overrides: Partial<BeadworkIssueDetail> = {}): BeadworkIssueDetail {
  return {
    id: overrides.id ?? "BW-101",
    title: overrides.title ?? "Delegate this ticket",
    description: overrides.description ?? "",
    status: overrides.status ?? "open",
    type: overrides.type ?? "task",
    priority: overrides.priority ?? 2,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    blocks: overrides.blocks ?? [],
    assignee: overrides.assignee ?? "",
    createdAt: overrides.createdAt ?? "2026-04-19T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-19T00:00:00.000Z",
    parentId: overrides.parentId ?? "BW-100",
    children: overrides.children ?? [],
  };
}

function createTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

describe("delegate clarify modal", () => {
  it("renders the selected ticket and submits the typed model override", () => {
    const done = vi.fn();
    const component = new DelegateClarifyComponent(
      { requestRender: vi.fn() } as never,
      createTheme() as never,
      createIssue(),
      done,
    );

    component.setModelOverride("cursor/composer-2");
    component.submit();

    expect(done).toHaveBeenCalledWith({
      ticketId: "BW-101",
      epicId: "BW-100",
      modelOverride: {
        provider: "cursor",
        model: "composer-2",
      },
    });

    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("Delegate ticket");
    expect(rendered).toContain("BW-101 · Delegate this ticket");
    expect(rendered).toContain(
      "type to edit • enter delegates • backspace deletes • esc/q cancels",
    );
  });

  it("shows validation feedback for invalid model overrides", () => {
    const requestRender = vi.fn();
    const done = vi.fn();
    const component = new DelegateClarifyComponent(
      { requestRender } as never,
      createTheme() as never,
      createIssue(),
      done,
    );

    component.setModelOverride("cursor/");
    component.submit();

    expect(done).not.toHaveBeenCalled();
    expect(requestRender).toHaveBeenCalled();
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("Validation");
    expect(rendered).toContain("Invalid model override");
  });
});
