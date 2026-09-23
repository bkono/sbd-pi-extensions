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
  it("renders supplied goal identity", () => {
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

    expect(rendered).toContain("BW-100");
    expect(rendered).toContain("Scoped epic");
  });
});
