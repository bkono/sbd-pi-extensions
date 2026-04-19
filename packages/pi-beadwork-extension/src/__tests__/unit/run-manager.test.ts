import { describe, expect, it } from "vitest";
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
              failed: [],
              attention: [],
              exited: [],
            },
          ],
        },
      } as DashboardStatusSnapshot["state"]),
    counts: overrides.counts ?? { ready: 2, blocked: 1, inProgress: 1, scopedReady: 1 },
    scopeDetail: overrides.scopeDetail,
    workerSummary: overrides.workerSummary ?? {
      total: 1,
      active: 1,
      launching: 0,
      running: 1,
      exited: 0,
      held: 0,
      landed: 0,
      failed: 0,
      attention: 0,
      cleaned: 0,
    },
  };
}

describe("run manager", () => {
  it("renders single-epic run state, options, and recent cycles", () => {
    const rendered = formatRunManagerLines(createSnapshot()).join("\n");

    expect(rendered).toContain("Single-epic run panel.");
    expect(rendered).toContain("Run scope: BW-100 · Scoped epic");
    expect(rendered).toContain("Run state: idle · last stop=blocked");
    expect(rendered).toContain(
      "Options: workers=3 until=blocked maxCycles=5 dryRun=no noSpawn=yes",
    );
    expect(rendered).toContain(
      "Recent result: cycles=2 launched=BW-101 activeWorkers=bw-101-worker",
    );
    expect(rendered).toContain(
      "- cycle 1 · ready=BW-101 · launched=BW-101 · running=bw-101-worker",
    );
  });
});
