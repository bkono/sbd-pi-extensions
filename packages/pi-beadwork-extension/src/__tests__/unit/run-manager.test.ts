import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../constants.js";
import type { DashboardStatusSnapshot } from "../../tui/dashboard.js";
import { formatRunManagerLines } from "../../tui/run-manager.js";

function createSnapshot(overrides: Partial<DashboardStatusSnapshot> = {}): DashboardStatusSnapshot {
  return {
    activation: overrides.activation ?? { kind: "active", repoRoot: "/repo" },
    state:
      overrides.state ??
      ({
        mode: "interactive",
        scope: { kind: "epic", id: "BW-100", title: "Scoped epic" },
        updatedAt: "2026-04-19T00:00:00.000Z",
        lastRunOptions: {
          workers: 3,
          until: "blocked",
          noSpawn: true,
          dryRun: false,
          maxCycles: 5,
        },
        recentRunSummary: {
          epicId: "BW-100",
          stopReason: "blocked",
          cycles: 2,
          launched: ["BW-101"],
          activeWorkerIds: ["bw-101-worker"],
          workerSummary: {
            total: 1,
            active: 1,
            launching: 0,
            running: 1,
            exited: 0,
            held: 0,
            landed: 0,
            verified: 0,
            successfulTerminal: 0,
            failed: 0,
            attention: 0,
            cleaned: 0,
          },
          notes: ["waiting for blockers"],
          cycleSummaries: [
            {
              cycle: 1,
              ready: ["BW-101"],
              launched: ["BW-101"],
              running: ["bw-101-worker"],
              held: [],
              landed: [],
              verified: [],
              failed: [],
              attention: [],
              exited: [],
            },
          ],
        },
      } as DashboardStatusSnapshot["state"]),
    counts: overrides.counts ?? { ready: 2, blocked: 1, inProgress: 1, scopedReady: 1 },
    scopeDetail: overrides.scopeDetail,
    config: overrides.config ?? DEFAULT_CONFIG,
  };
}

describe("run manager", () => {
  it("renders a goal summary with epic, review policy, and interrupted vs active", () => {
    const rendered = formatRunManagerLines(createSnapshot()).join("\n");

    expect(rendered).toContain("Goal summary · epic, review policy, and run state.");
    expect(rendered).toContain("Epic: BW-100 · Scoped epic");
    expect(rendered).toContain("Review policy: ticket");
    expect(rendered).toContain("Goal state: interrupted · last stop=blocked");
    expect(rendered).toContain(
      "Next: The last run paused because no additional scoped ready work was available.",
    );
    expect(rendered).not.toContain("Tracked workers:");
    expect(rendered).not.toContain("activeWorkers=");
    expect(rendered).not.toContain("bw-101-worker");
    expect(rendered).not.toContain("Workers tab");
  });

  it("marks an armed run as active without minion rows", () => {
    const rendered = formatRunManagerLines(
      createSnapshot({
        state: {
          mode: "run",
          scope: { kind: "epic", id: "BW-100", title: "Scoped epic" },
          updatedAt: "2026-04-19T00:00:00.000Z",
        },
      }),
    ).join("\n");

    expect(rendered).toContain("Goal state: active");
    expect(rendered).not.toContain("interrupted");
    expect(rendered).not.toContain("Options:");
    expect(rendered).not.toContain("Recent cycles");
  });
});
