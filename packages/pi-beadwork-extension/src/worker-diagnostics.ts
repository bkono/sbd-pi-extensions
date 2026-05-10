import { isSuccessfulTerminalWorker, type WorkerRuntime } from "./types.js";

export type WorkerInspection = {
  runtime: WorkerRuntime;
  validation: {
    state: "not-run" | "pending" | "passed" | "failed";
    summary: string;
    detail?: string;
    at?: string;
  };
  review: {
    state:
      | "not-run"
      | "pending"
      | "approved"
      | "nits-only"
      | "changes-requested"
      | "remediation-in-progress"
      | "review-blocked";
    summary: string;
    detail?: string;
    at?: string;
    verdict?: WorkerRuntime["reviewVerdict"];
    validFeedbackCount?: number;
    invalidFeedbackCount?: number;
  };
  landing: {
    state:
      | "waiting-ticket-close"
      | "verified"
      | "validated-and-held"
      | "ready-to-land"
      | "needs-refresh"
      | "pending-review"
      | "verification-failed"
      | "needs-attention";
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

function verificationSubject(worker: WorkerRuntime): string {
  return worker.executionMode === "worktree" ? "Landing" : "Current-branch verification";
}

function verificationSubjectLower(worker: WorkerRuntime): string {
  return worker.executionMode === "worktree" ? "landing" : "current-branch verification";
}

function mergeBackOrVerification(worker: WorkerRuntime): string {
  return worker.executionMode === "worktree" ? "merge-back" : "current-branch verification";
}

function backgroundCheckLabel(worker: WorkerRuntime): string {
  return worker.executionMode === "worktree" ? "merge-back checks" : "current-branch verification";
}

function remediationCheckoutLabel(worker: WorkerRuntime): string {
  return worker.executionMode === "worktree" ? "the existing worktree" : "the current checkout";
}

function manualCleanupTarget(worker: WorkerRuntime): string {
  return worker.executionMode === "worktree" ? "tmux/worktree" : "tmux/runtime";
}

function describeValidation(worker: WorkerRuntime): WorkerInspection["validation"] {
  if (worker.validationStatus === "passed") {
    return {
      state: "passed",
      summary: "passed",
      detail: worker.validationSummary,
      at: worker.validationAt,
    };
  }

  if (worker.validationStatus === "failed") {
    return {
      state: "failed",
      summary: "failed",
      detail: worker.validationSummary,
      at: worker.validationAt,
    };
  }

  if (worker.validationStatus === "pending") {
    return {
      state: "pending",
      summary: "pending",
      detail: worker.validationSummary,
      at: worker.validationAt,
    };
  }

  return {
    state: "not-run",
    summary: "not-run",
    detail: worker.validationSummary,
    at: worker.validationAt,
  };
}

function describeReview(worker: WorkerRuntime): WorkerInspection["review"] {
  const feedbackCounts = {
    validFeedbackCount: worker.reviewValidFeedbackCount,
    invalidFeedbackCount: worker.reviewInvalidFeedbackCount,
  };

  if (worker.reviewStatus === "approved") {
    return {
      state: "approved",
      summary: "approved",
      detail: worker.reviewSummary,
      at: worker.reviewAt,
      verdict: worker.reviewVerdict,
      ...feedbackCounts,
    };
  }

  if (worker.reviewStatus === "nits-only") {
    return {
      state: "nits-only",
      summary: "approved-with-nits",
      detail: worker.reviewSummary,
      at: worker.reviewAt,
      verdict: worker.reviewVerdict,
      ...feedbackCounts,
    };
  }

  if (worker.reviewStatus === "changes-requested") {
    return {
      state: "changes-requested",
      summary: "changes-requested",
      detail: worker.reviewSummary,
      at: worker.reviewAt,
      verdict: worker.reviewVerdict,
      ...feedbackCounts,
    };
  }

  if (worker.reviewStatus === "remediation-in-progress") {
    return {
      state: "remediation-in-progress",
      summary: "remediation-in-progress",
      detail: worker.reviewSummary,
      at: worker.reviewAt,
      verdict: worker.reviewVerdict,
      ...feedbackCounts,
    };
  }

  if (worker.reviewStatus === "review-blocked") {
    return {
      state: "review-blocked",
      summary: "review-blocked",
      detail: worker.reviewSummary ?? worker.lastError,
      at: worker.reviewAt,
      verdict: worker.reviewVerdict,
      ...feedbackCounts,
    };
  }

  if (worker.reviewStatus === "pending") {
    return {
      state: "pending",
      summary: "pending",
      detail: worker.reviewSummary,
      at: worker.reviewAt,
      verdict: worker.reviewVerdict,
      ...feedbackCounts,
    };
  }

  if (worker.reviewVerdict) {
    return {
      state: "pending",
      summary: `pending (${worker.reviewVerdict})`,
      detail: worker.reviewSummary,
      at: worker.reviewAt,
      verdict: worker.reviewVerdict,
      ...feedbackCounts,
    };
  }

  return {
    state: "not-run",
    summary: "not-run",
    detail: worker.reviewSummary,
    at: worker.reviewAt,
    verdict: worker.reviewVerdict,
    ...feedbackCounts,
  };
}

function describeLanding(worker: WorkerRuntime): WorkerInspection["landing"] {
  if (worker.status === "attention" && worker.lastError) {
    return {
      state: "needs-attention",
      summary: "needs attention",
      detail: worker.lastError,
      aheadCount: worker.landingAheadCount,
      behindCount: worker.landingBehindCount,
    };
  }

  if (isSuccessfulTerminalWorker(worker) && worker.status === "verified") {
    const counts = formatAheadBehind(worker);
    return {
      state: "verified",
      summary: counts ? `verified (${counts})` : "verified",
      detail: worker.landingVerification ?? "Current-branch worker has been verified.",
      aheadCount: worker.landingAheadCount,
      behindCount: worker.landingBehindCount,
      verifiedAt: worker.landingVerifiedAt,
    };
  }

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

  if (worker.status === "held") {
    const aheadCount = worker.landingAheadCount ?? 0;
    const behindCount = worker.landingBehindCount ?? 0;

    if (worker.validationStatus !== "passed") {
      return {
        state: "needs-attention",
        summary: "needs attention",
        detail:
          worker.validationSummary ??
          "Deferred landing is held, but validation is no longer in a passing state.",
        aheadCount: worker.landingAheadCount,
        behindCount: worker.landingBehindCount,
      };
    }

    if (aheadCount > 0 && behindCount > 0) {
      return {
        state: "needs-refresh",
        summary: `validated and held · needs refresh (ahead=${aheadCount}, behind=${behindCount})`,
        detail:
          worker.landingVerification ??
          "Validated and held, but repo HEAD moved. Run /bw land to refresh and merge.",
        aheadCount: worker.landingAheadCount,
        behindCount: worker.landingBehindCount,
      };
    }

    if (aheadCount > 0) {
      return {
        state: "ready-to-land",
        summary: `validated and held · ready to land (ahead=${aheadCount}, behind=${behindCount})`,
        detail:
          worker.landingVerification ??
          "Validated and held. Ready to land when explicitly requested.",
        aheadCount: worker.landingAheadCount,
        behindCount: worker.landingBehindCount,
      };
    }

    return {
      state: "validated-and-held",
      summary: "validated and held",
      detail:
        worker.landingVerification ??
        "Validated and held for deferred landing. Run /bw land when ready.",
      aheadCount: worker.landingAheadCount,
      behindCount: worker.landingBehindCount,
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
  if (worker.cleanupPolicy === undefined) {
    return {
      policy: worker.cleanupPolicy,
      state: "keep",
      summary: "keep (no worktree cleanup)",
      at: worker.cleanupAt,
    };
  }
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
  validation: WorkerInspection["validation"],
  review: WorkerInspection["review"],
  landing: WorkerInspection["landing"],
  cleanup: WorkerInspection["cleanup"],
): WorkerInspection["followUp"] {
  if (worker.landingRequestedAt && !worker.landingVerifiedAt) {
    if (worker.ticketStatus !== "closed") {
      return {
        needsAttention: false,
        action: `${verificationSubject(worker)} was requested. Waiting for the worker to finish and close the ticket before ${backgroundCheckLabel(worker)} can continue.`,
      };
    }

    if (review.state === "pending") {
      return {
        needsAttention: false,
        action:
          review.detail ??
          `${verificationSubject(worker)} was requested. Reviewer gating is running before ${mergeBackOrVerification(worker)}.`,
      };
    }

    if (validation.state === "pending") {
      return {
        needsAttention: false,
        action:
          validation.detail ??
          `${verificationSubject(worker)} was requested. ${worker.executionMode === "worktree" ? "Validation and merge-back checks are" : "Validation is"} running in the background.`,
      };
    }

    return {
      needsAttention: false,
      action:
        worker.landingVerification ??
        `${verificationSubject(worker)} was requested. Background ${worker.executionMode === "worktree" ? "merge-back orchestration" : "verification"} is in progress.`,
    };
  }

  if (worker.status === "launching") {
    return {
      needsAttention: false,
      action: "Worker is launching. Re-run /bw workers shortly.",
    };
  }

  if (worker.status === "running") {
    if (worker.remediationStatus === "running") {
      return {
        needsAttention: false,
        action:
          worker.remediationSummary ??
          `Validation previously failed. Automatic remediation is running in ${remediationCheckoutLabel(worker)}.`,
      };
    }

    if (review.state === "remediation-in-progress") {
      return {
        needsAttention: false,
        action:
          review.detail ??
          "Reviewer requested in-scope fixes. Remediation is running before re-review.",
      };
    }

    if (worker.ticketStatus === "closed") {
      return {
        needsAttention: false,
        action: `Ticket is closed. Waiting for the worker process to exit so ${worker.executionMode === "worktree" ? "landing can be verified" : "current-branch verification can run"}.`,
      };
    }

    return {
      needsAttention: false,
      action: "Worker is running. Wait for completion; inspect tmux/logs if stalled.",
    };
  }

  if (isSuccessfulTerminalWorker(worker) && worker.status === "verified") {
    return {
      needsAttention: false,
      action: "Current-branch worker verified successfully. No action needed.",
    };
  }

  if (worker.status === "failed") {
    return {
      needsAttention: true,
      action: "Inspect worker logs and re-run after fixing the failure.",
    };
  }

  if (worker.status === "attention") {
    if (validation.state === "failed") {
      return {
        needsAttention: true,
        action:
          worker.remediationStatus === "exhausted"
            ? (worker.remediationSummary ??
              worker.validationSummary ??
              `Validation failed after automatic remediation. Fix ${remediationCheckoutLabel(worker)} manually.`)
            : (worker.validationSummary ??
              `Validation failed; fix ${remediationCheckoutLabel(worker)} and re-run /bw workers.`),
      };
    }

    if (review.state === "review-blocked" || review.state === "changes-requested") {
      return {
        needsAttention: true,
        action:
          review.detail ??
          `${verificationSubject(worker)} is blocked by reviewer-requested changes that still need remediation.`,
      };
    }

    return {
      needsAttention: true,
      action:
        worker.lastError ??
        `Worker needs operator attention before ${verificationSubjectLower(worker)} can finish.`,
    };
  }

  if (worker.status === "held") {
    if (review.state === "review-blocked" || review.state === "changes-requested") {
      return {
        needsAttention: true,
        action:
          review.detail ??
          `Deferred landing for ${worker.ticketId} is blocked by reviewer-requested changes.`,
      };
    }

    if (landing.state === "ready-to-land") {
      return {
        needsAttention: false,
        action: `Validated and held. Run /bw land ${worker.ticketId} when you're ready to merge-back.`,
      };
    }

    if (landing.state === "needs-refresh") {
      return {
        needsAttention: true,
        action: `Deferred landing needs refresh before merge-back. Run /bw land ${worker.ticketId} to rebase/revalidate.`,
      };
    }

    return {
      needsAttention: true,
      action:
        worker.landingVerification ??
        `Deferred landing for ${worker.ticketId} needs attention before it can be merged back.`,
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
          action: `${verificationSubject(worker)} verified, but cleanup failed. Remove ${manualCleanupTarget(worker)} manually.`,
        };
      }

      if (cleanup.state === "pending") {
        return {
          needsAttention: true,
          action: `${verificationSubject(worker)} verified. Cleanup is still pending.`,
        };
      }

      return {
        needsAttention: false,
        action: "No action needed.",
      };
    }

    return {
      needsAttention: true,
      action: `Ticket is closed, but ${worker.executionMode === "worktree" ? "worktree landing" : "current-branch verification"} still needs human review.`,
    };
  }

  if (validation.state === "pending") {
    return {
      needsAttention: true,
      action: "Worker changes appear integrated, but validation is still pending.",
    };
  }

  if (validation.state === "failed") {
    return {
      needsAttention: true,
      action: worker.validationSummary ?? "Worker validation failed after integration.",
    };
  }

  if (review.state === "pending") {
    return {
      needsAttention: true,
      action: `${verificationSubject(worker)} is integrated, but reviewer gating is still pending.`,
    };
  }

  if (review.state === "changes-requested" || review.state === "review-blocked") {
    return {
      needsAttention: true,
      action:
        review.detail ??
        `${verificationSubject(worker)} is integrated, but reviewer-requested changes are still unresolved.`,
    };
  }

  if (cleanup.state === "failed") {
    return {
      needsAttention: true,
      action: `${verificationSubject(worker)} verified, but cleanup failed. Remove ${manualCleanupTarget(worker)} manually.`,
    };
  }

  if (cleanup.state === "pending") {
    return {
      needsAttention: true,
      action: `${verificationSubject(worker)} verified. Cleanup is still pending.`,
    };
  }

  if (cleanup.state === "keep") {
    return {
      needsAttention: false,
      action: `${verificationSubject(worker)} verified. Optional manual cleanup (policy: keep).`,
    };
  }

  return {
    needsAttention: false,
    action: "No action needed.",
  };
}

export function inspectWorker(worker: WorkerRuntime): WorkerInspection {
  const validation = describeValidation(worker);
  const review = describeReview(worker);
  const landing = describeLanding(worker);
  const cleanup = describeCleanup(worker);
  const followUp = describeFollowUp(worker, validation, review, landing, cleanup);
  return {
    runtime: worker,
    validation,
    review,
    landing,
    cleanup,
    followUp,
  };
}

export function formatWorkerInspectionLines(inspection: WorkerInspection): string[] {
  const worker = inspection.runtime;
  const lines = [
    `- ${worker.ticketId} [${worker.executionMode}] · ${worker.status} · ${worker.ticketTitle}`,
    `  Worker: ${worker.workerId} · pane:${worker.tmuxPane}`,
    `  Ticket: ${worker.ticketStatus ?? "unknown"} · validation:${inspection.validation.summary} · review:${inspection.review.summary} · landing:${inspection.landing.summary} · cleanup:${inspection.cleanup.summary}`,
    `  Next: ${inspection.followUp.action}`,
  ];

  if (worker.executionMode === "worktree") {
    lines.push(
      `  Launch: executionMode=worktree · checkoutPath=${worker.checkoutPath} · worktreePath=${worker.worktreePath} · branchName=${worker.branchName}`,
    );
  } else {
    lines.push(
      `  Launch: executionMode=current-branch · checkoutPath=${worker.checkoutPath} · branchName=${worker.branchName} · launchHead=${worker.launchHead}`,
    );
  }

  if (inspection.validation.detail) {
    lines.push(`  Validation detail: ${inspection.validation.detail}`);
  }

  if (inspection.review.detail) {
    lines.push(`  Review detail: ${inspection.review.detail}`);
  }

  if (inspection.landing.detail) {
    lines.push(`  Landing detail: ${inspection.landing.detail}`);
  }

  if (worker.lastError) {
    lines.push(`  Last error: ${worker.lastError}`);
  }

  return lines;
}
