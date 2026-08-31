import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../constants.js";
import type { DashboardStatusSnapshot } from "../../tui/dashboard.js";
import { formatGoalModeLines } from "../../tui/run-manager.js";

function createSnapshot(overrides: Partial<DashboardStatusSnapshot> = {}): DashboardStatusSnapshot {
  return {
    activation: overrides.activation ?? { kind: "active", repoRoot: "/repo" },
    state:
      overrides.state ??
      ({
        mode: "interactive",
        scope: { kind: "epic", id: "BW-100", title: "Scoped epic" },
        updatedAt: "2026-04-19T00:00:00.000Z",
      } as DashboardStatusSnapshot["state"]),
    counts: overrides.counts ?? { ready: 2, blocked: 1, inProgress: 1, scopedReady: 1 },
    scopeDetail: overrides.scopeDetail,
    config: overrides.config ?? DEFAULT_CONFIG,
  };
}

describe("goal mode panel", () => {
  it("renders only current explicit goal entry and review policy", () => {
    const rendered = formatGoalModeLines(
      createSnapshot({
        state: {
          mode: "run",
          scope: { kind: "epic", id: "BW-100", title: "Scoped epic" },
          updatedAt: "2026-04-19T00:00:00.000Z",
          goal: {
            goalId: "goal-BW-100",
            scopeIds: ["BW-100"],
            reviewPolicy: "scope",
            startedAt: "2026-04-19T00:00:00.000Z",
          },
        },
      }),
    ).join("\n");

    expect(rendered).toContain("Current explicit goal-mode entry and review policy.");
    expect(rendered).toContain("Epic: BW-100 · Scoped epic");
    expect(rendered).toContain("Review policy: scope");
    expect(rendered).toContain("Goal mode: active");
    expect(rendered).not.toMatch(/workers|cycles|stop reason|summary/i);
  });

  it("marks a rehydrated run as interrupted and gives explicit choices", () => {
    const rendered = formatGoalModeLines(
      createSnapshot({
        state: {
          mode: "run",
          runInterrupted: true,
          scope: { kind: "epic", id: "BW-100", title: "Scoped epic" },
          updatedAt: "2026-04-19T00:00:00.000Z",
          goal: {
            goalId: "goal-BW-100",
            scopeIds: ["BW-100"],
            reviewPolicy: "ticket",
            startedAt: "2026-04-19T00:00:00.000Z",
          },
        },
      }),
    ).join("\n");

    expect(rendered).toContain("Goal mode: interrupted");
    expect(rendered).toContain("Resume only with an explicit /bw run <epic-id>");
    expect(rendered).not.toContain("Goal mode: active");
  });

  it("shows inactive entry instructions without historical fallback", () => {
    const rendered = formatGoalModeLines(createSnapshot()).join("\n");

    expect(rendered).toContain("Goal mode: inactive");
    expect(rendered).toContain("Select an open epic in Issues and press r");
    expect(rendered).not.toMatch(/last run|last stop|max-cycles/i);
  });
});
