import { describe, expect, it } from "vitest";
import type { WorkerRuntime } from "../../types.js";
import { formatWorkerInspectionLines, inspectWorker } from "../../worker-diagnostics.js";

function createWorker(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
  return {
    workerId: "bw-101-worker",
    ticketId: "BW-101",
    epicId: "BW-100",
    ticketTitle: "Task",
    ticketStatus: "open",
    branchName: "BW-101/task",
    worktreePath: "/tmp/worktree",
    backend: "tmux",
    tmuxSession: "pi-bw",
    tmuxWindow: "bw-101",
    tmuxPane: "%42",
    runtimeDir: "/tmp/runtime",
    promptFile: "/tmp/runtime/handoff.txt",
    scriptFile: "/tmp/runtime/launch.sh",
    logFile: "/tmp/runtime/worker.log",
    stateFile: "/tmp/runtime/state.txt",
    exitCodeFile: "/tmp/runtime/exit-code.txt",
    finishedAtFile: "/tmp/runtime/finished-at.txt",
    launchCommand: "bash /tmp/runtime/launch.sh",
    workerCommand: "pi",
    cleanupPolicy: "keep",
    status: "running",
    startedAt: "2026-04-14T00:00:00.000Z",
    updatedAt: "2026-04-14T00:00:01.000Z",
    ...overrides,
  };
}

describe("worker diagnostics", () => {
  it("reports no follow-up when landing is verified and cleanup succeeded", () => {
    const worker = createWorker({
      status: "landed",
      ticketStatus: "closed",
      cleanupPolicy: "cleanup-after-landing",
      cleanupStatus: "cleaned",
      validationStatus: "passed",
      validationAt: "2026-04-14T00:55:00.000Z",
      validationSummary: "Validation passed: npm run lint, npm run test, npm run typecheck.",
      landingVerifiedAt: "2026-04-14T01:00:00.000Z",
      landingAheadCount: 0,
      landingBehindCount: 2,
      landingVerification:
        "Landing verified: worktree is clean and worker HEAD is fully contained in repo HEAD.",
    });

    const inspection = inspectWorker(worker);

    expect(inspection.validation.state).toBe("passed");
    expect(inspection.landing.state).toBe("verified");
    expect(inspection.cleanup.state).toBe("cleaned");
    expect(inspection.followUp.needsAttention).toBe(false);
    expect(inspection.followUp.action).toBe("No action needed.");
  });

  it("requires attention when a landed worker still has pending validation", () => {
    const inspection = inspectWorker(
      createWorker({
        status: "landed",
        ticketStatus: "closed",
        validationStatus: "pending",
        landingVerifiedAt: "2026-04-14T01:00:00.000Z",
        landingAheadCount: 0,
        landingBehindCount: 1,
        landingVerification:
          "Landing verified: worktree is clean and worker HEAD is fully contained in repo HEAD.",
      }),
    );

    expect(inspection.validation.state).toBe("pending");
    expect(inspection.followUp.needsAttention).toBe(true);
    expect(inspection.followUp.action).toContain("validation is still pending");
  });

  it("flags exited workers with closed tickets that still need landing review", () => {
    const worker = createWorker({
      status: "exited",
      ticketStatus: "closed",
      landingVerification:
        "Ticket is closed and the worktree is clean, but 2 worker commit(s) are not in the repo HEAD yet.",
      landingAheadCount: 2,
      landingBehindCount: 0,
      cleanupPolicy: "cleanup-after-landing",
      cleanupStatus: "pending",
    });

    const inspection = inspectWorker(worker);

    expect(inspection.landing.state).toBe("pending-review");
    expect(inspection.followUp.needsAttention).toBe(true);
    expect(inspection.followUp.action).toContain("human review");

    const lines = formatWorkerInspectionLines(inspection);
    expect(lines.join("\n")).toContain("Landing detail");
    expect(lines.join("\n")).toContain("Next:");
  });

  it("surfaces validation failures as explicit attention states", () => {
    const inspection = inspectWorker(
      createWorker({
        status: "attention",
        ticketStatus: "closed",
        validationStatus: "failed",
        validationSummary: "Validation failed on `npm run test`: tests failed",
        lastError: "Validation failed on `npm run test`: tests failed",
      }),
    );

    expect(inspection.validation.state).toBe("failed");
    expect(inspection.landing.state).toBe("needs-attention");
    expect(inspection.followUp.needsAttention).toBe(true);
    expect(inspection.followUp.action).toContain("npm run test");
  });

  it("marks deferred workers as ready to land when validation passed and branch is still mergeable", () => {
    const inspection = inspectWorker(
      createWorker({
        status: "held",
        ticketStatus: "closed",
        validationStatus: "passed",
        landingAheadCount: 2,
        landingBehindCount: 0,
        landingVerification:
          "Validated and held. Ready to land on explicit request (ahead=2, behind=0).",
      }),
    );

    expect(inspection.landing.state).toBe("ready-to-land");
    expect(inspection.followUp.needsAttention).toBe(false);
    expect(inspection.followUp.action).toContain("/bw land BW-101");
  });

  it("marks deferred workers as needing refresh when repo drift appears", () => {
    const inspection = inspectWorker(
      createWorker({
        status: "held",
        ticketStatus: "closed",
        validationStatus: "passed",
        landingAheadCount: 2,
        landingBehindCount: 1,
        landingVerification:
          "Validated and held. Landing needs refresh before merge-back (ahead=2, behind=1).",
      }),
    );

    expect(inspection.landing.state).toBe("needs-refresh");
    expect(inspection.followUp.needsAttention).toBe(true);
    expect(inspection.followUp.action).toContain("needs refresh");
  });

  it("keeps follow-up informational while a worker is still running", () => {
    const inspection = inspectWorker(
      createWorker({ status: "running", ticketStatus: "in_progress" }),
    );

    expect(inspection.followUp.needsAttention).toBe(false);
    expect(inspection.followUp.action).toContain("Wait for completion");
    expect(inspection.landing.state).toBe("waiting-ticket-close");
  });

  it("tells the operator when a closed ticket is waiting on worker exit", () => {
    const inspection = inspectWorker(createWorker({ status: "running", ticketStatus: "closed" }));

    expect(inspection.followUp.needsAttention).toBe(false);
    expect(inspection.followUp.action).toContain("Waiting for the worker process to exit");
    expect(inspection.landing.state).toBe("pending-review");
  });
});
