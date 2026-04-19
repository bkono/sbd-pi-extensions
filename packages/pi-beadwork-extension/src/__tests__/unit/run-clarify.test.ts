import { describe, expect, it, vi } from "vitest";
import { RunClarifyComponent } from "../../tui/run-clarify.js";
import type { BeadworkIssueDetail, SessionState } from "../../types.js";

function createEpic(overrides: Partial<BeadworkIssueDetail> = {}): BeadworkIssueDetail {
  return {
    id: overrides.id ?? "BW-100",
    title: overrides.title ?? "Run this epic",
    description: overrides.description ?? "",
    status: overrides.status ?? "open",
    type: overrides.type ?? "epic",
    priority: overrides.priority ?? 2,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    blocks: overrides.blocks ?? [],
    assignee: overrides.assignee ?? "",
    createdAt: overrides.createdAt ?? "2026-04-19T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-19T00:00:00.000Z",
    parentId: overrides.parentId,
    children: overrides.children ?? [],
  };
}

function createState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    mode: overrides.mode ?? "interactive",
    scope: overrides.scope ?? { kind: "epic", id: "BW-100", title: "Run this epic" },
    updatedAt: overrides.updatedAt ?? "2026-04-19T00:00:00.000Z",
    engagedAt: overrides.engagedAt,
    prime: overrides.prime,
    trackedWorkerIds: overrides.trackedWorkerIds,
    workerNotices: overrides.workerNotices,
    runOptions: overrides.runOptions,
    lastRunOptions: overrides.lastRunOptions,
    recentRunSummary: overrides.recentRunSummary,
  };
}

function createTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

describe("run clarify modal", () => {
  it("adjusts run options and submits the selected values", () => {
    const done = vi.fn();
    const component = new RunClarifyComponent(
      { requestRender: vi.fn() } as never,
      createTheme() as never,
      createEpic(),
      createState(),
      done,
      {
        workers: 2,
        until: "blocked",
        maxCycles: 3,
        dryRun: false,
        noSpawn: false,
      },
    );

    component.setField("workers", 4);
    component.setField("until", "empty");
    component.setField("maxCycles", 7);
    component.setField("dryRun", true);
    component.setField("noSpawn", true);
    component.submit();

    expect(done).toHaveBeenCalledWith({
      epicId: "BW-100",
      options: {
        workers: 4,
        until: "empty",
        maxCycles: 7,
        dryRun: true,
        noSpawn: true,
      },
    });
  });

  it("renders the current selection and session scope", () => {
    const component = new RunClarifyComponent(
      { requestRender: vi.fn() } as never,
      createTheme() as never,
      createEpic(),
      createState(),
      vi.fn(),
      {
        workers: 2,
        until: "blocked",
        maxCycles: 3,
        dryRun: false,
        noSpawn: false,
      },
    );

    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("Run epic");
    expect(rendered).toContain("Session: mode=interactive · scope=epic:BW-100");
    expect(rendered).toContain("> Workers: 2");
  });
});
