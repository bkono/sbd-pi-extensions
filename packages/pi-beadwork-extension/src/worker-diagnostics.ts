import type { WorkerRuntime } from "./types.js";

export type WorkerInspection = {
  runtime: WorkerRuntime;
  landing: {
    state: "waiting-ticket-close" | "verified" | "pending-review" | "verification-failed";
    summary: string;
    detail?: string;
    aheadCount?: number;
    behindCount?: number;
    verifiedAt?: string;
  };
  cleanup: {
    policy: WorkerRuntime["cleanupPolicy"];
    state: "keep" | "pending" | "cleaned" | "failed";
    summary: string;
    at?: string;
  };
  followUp: {
    needsAttention: boolean;
    action: string;
  };
};

function formatAheadBehind(worker: WorkerRuntime): string | undefined {
  if (
    typeof worker.landingAheadCount !== "number" &&
    typeof worker.landingBehindCount !== "number"
  ) {
    return undefined;
  }

  return `ahead=${worker.landingAheadCount ?? 0}, behind=${worker.landingBehindCount ?? 0}`;
}

function describeLanding(worker: WorkerRuntime): WorkerInspection["landing"] {
  if (worker.ticketStatus !== "closed") {
    return {
      state: "waiting-ticket-close",
      summary:
        worker.ticketStatus && worker.ticketStatus.length > 0
          ? `waiting for ticket close (ticket:${worker.ticketStatus})`
          : "waiting for ticket close",
      detail: "Landing verification begins after the ticket is closed.",
    };
  }

  if (worker.landingVerifiedAt) {
    const counts = formatAheadBehind(worker);
    return {
      state: "verified",
      summary: counts ? `verified (${counts})` : "verified",
      detail: worker.landingVerification,
      aheadCount: worker.landingAheadCount,
      behindCount: worker.landingBehindCount,
      verifiedAt: worker.landingVerifiedAt,
    };
  }

  if (worker.landingVerification) {
    const failed = /verification failed/i.test(worker.landingVerification);
    return {
      state: failed ? "verification-failed" : "pending-review",
      summary: failed ? "verification failed" : "pending review",
      detail: worker.landingVerification,
      aheadCount: worker.landingAheadCount,
      behindCount: worker.landingBehindCount,
    };
  }

  return {
    state: "pending-review",
    summary: "pending review",
    detail: "Ticket is closed, but landing verification details are not available yet.",
    aheadCount: worker.landingAheadCount,
    behindCount: worker.landingBehindCount,
  };
}

function describeCleanup(worker: WorkerRuntime): WorkerInspection["cleanup"] {
  if (worker.cleanupPolicy === "keep") {
    return {
      policy: worker.cleanupPolicy,
      state: "keep",
      summary: "keep (manual cleanup)",
      at: worker.cleanupAt,
    };
  }

  if (worker.cleanupStatus === "cleaned") {
    return {
      policy: worker.cleanupPolicy,
      state: "cleaned",
      summary: "cleaned",
      at: worker.cleanupAt,
    };
  }

  if (worker.cleanupStatus === "failed") {
    return {
      policy: worker.cleanupPolicy,
      state: "failed",
      summary: "failed",
      at: worker.cleanupAt,
    };
  }

  return {
    policy: worker.cleanupPolicy,
    state: "pending",
    summary: "pending",
    at: worker.cleanupAt,
  };
}

function describeFollowUp(
  worker: WorkerRuntime,
  landing: WorkerInspection["landing"],
  cleanup: WorkerInspection["cleanup"],
): WorkerInspection["followUp"] {
  if (worker.status === "launching") {
    return {
      needsAttention: false,
      action: "Worker is launching. Re-run /bw workers shortly.",
    };
  }

  if (worker.status === "running") {
    if (worker.ticketStatus === "closed") {
      return {
        needsAttention: false,
        action:
          "Ticket is closed. Waiting for the worker process to exit so landing can be verified.",
      };
    }

    return {
      needsAttention: false,
      action: "Worker is running. Wait for completion; inspect tmux/logs if stalled.",
    };
  }

  if (worker.status === "failed") {
    return {
      needsAttention: true,
      action: "Inspect worker logs and re-run after fixing the failure.",
    };
  }

  if (worker.status === "exited") {
    if (worker.ticketStatus !== "closed") {
      return {
        needsAttention: true,
        action: `Worker exited before ${worker.ticketId} was closed. Resume manually or relaunch.`,
      };
    }

    if (landing.state === "verified") {
      if (cleanup.state === "failed") {
        return {
          needsAttention: true,
          action: "Landing verified, but cleanup failed. Remove tmux/worktree manually.",
        };
      }

      if (cleanup.state === "pending") {
        return {
          needsAttention: true,
          action: "Landing verified. Cleanup is still pending.",
        };
      }

      return {
        needsAttention: false,
        action: "No action needed.",
      };
    }

    return {
      needsAttention: true,
      action: "Ticket is closed, but landing still needs human review.",
    };
  }

  if (cleanup.state === "failed") {
    return {
      needsAttention: true,
      action: "Landing verified, but cleanup failed. Remove tmux/worktree manually.",
    };
  }

  if (cleanup.state === "pending") {
    return {
      needsAttention: true,
      action: "Landing verified. Cleanup is still pending.",
    };
  }

  if (cleanup.state === "keep") {
    return {
      needsAttention: false,
      action: "Landing verified. Optional manual cleanup (policy: keep).",
    };
  }

  return {
    needsAttention: false,
    action: "No action needed.",
  };
}

export function inspectWorker(worker: WorkerRuntime): WorkerInspection {
  const landing = describeLanding(worker);
  const cleanup = describeCleanup(worker);
  const followUp = describeFollowUp(worker, landing, cleanup);
  return {
    runtime: worker,
    landing,
    cleanup,
    followUp,
  };
}

export function formatWorkerInspectionLines(inspection: WorkerInspection): string[] {
  const worker = inspection.runtime;
  const lines = [
    `- ${worker.ticketId} · ${worker.status} · ${worker.ticketTitle}`,
    `  Worker: ${worker.workerId} · pane:${worker.tmuxPane}`,
    `  Ticket: ${worker.ticketStatus ?? "unknown"} · landing:${inspection.landing.summary} · cleanup:${inspection.cleanup.summary}`,
    `  Next: ${inspection.followUp.action}`,
  ];

  if (inspection.landing.detail) {
    lines.push(`  Landing detail: ${inspection.landing.detail}`);
  }

  if (worker.lastError) {
    lines.push(`  Last error: ${worker.lastError}`);
  }

  return lines;
}
