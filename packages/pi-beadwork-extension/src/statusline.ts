import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { EXTENSION_ID } from "./constants.js";
import type { ActivationState, BeadworkConfig, SessionState, WorkerSummary } from "./types.js";

function renderScope(scope: SessionState["scope"]): string | undefined {
  if (scope.kind === "none") {
    return undefined;
  }

  return `${scope.kind} ${scope.id}`;
}

function renderWorkerModeIndicator(workerSummary?: WorkerSummary): string | undefined {
  if (!workerSummary || workerSummary.active <= 0) {
    return undefined;
  }

  const currentBranch = workerSummary.activeCurrentBranch ?? 0;
  const worktree = workerSummary.activeWorktree ?? 0;
  if (currentBranch > 0 && worktree > 0) {
    return `current-branch ${currentBranch} worktree ${worktree}`;
  }
  if (currentBranch > 0) {
    return `current-branch ${currentBranch}`;
  }
  if (worktree > 0) {
    return `worktree ${worktree}`;
  }
  return undefined;
}

export function renderStatusText(
  ctx: ExtensionContext,
  activation: ActivationState,
  sessionState: SessionState,
  config: BeadworkConfig,
  workerSummary?: WorkerSummary,
): string | undefined {
  const theme = ctx.ui.theme;
  const scope = renderScope(sessionState.scope);
  const trackedWorkers = sessionState.trackedWorkerIds?.length ?? 0;

  if (activation.kind === "active") {
    const parts = [theme.fg("accent", "bw"), theme.fg("muted", sessionState.mode)];
    if (scope) {
      parts.push(theme.fg("muted", `· ${scope}`));
    }
    if (trackedWorkers > 0) {
      parts.push(theme.fg("muted", `· tracked ${trackedWorkers}`));
    }
    if (workerSummary && workerSummary.active > 0) {
      parts.push(theme.fg("muted", `· workers ${workerSummary.active}`));
    }
    const modeIndicator = renderWorkerModeIndicator(workerSummary);
    if (modeIndicator) {
      parts.push(theme.fg("muted", `· ${modeIndicator}`));
    }
    if (workerSummary && workerSummary.successfulTerminal > 0) {
      parts.push(theme.fg("success", `· done ${workerSummary.successfulTerminal}`));
    }
    if (workerSummary && workerSummary.failed > 0) {
      parts.push(theme.fg("warning", `· fail ${workerSummary.failed}`));
    }
    if (workerSummary && workerSummary.held > 0) {
      parts.push(theme.fg("warning", `· held ${workerSummary.held}`));
    }
    if (workerSummary && workerSummary.attention > 0) {
      parts.push(theme.fg("warning", `· attention ${workerSummary.attention}`));
    }
    return parts.join(" ");
  }

  if (!config.ui.showInactiveStatus) {
    return undefined;
  }

  if (activation.kind === "available") {
    return [theme.fg("warning", "bw"), theme.fg("muted", "available")].join(" ");
  }

  return [theme.fg("dim", "bw"), theme.fg("muted", "off")].join(" ");
}

export function updateStatusline(
  ctx: ExtensionContext,
  activation: ActivationState,
  sessionState: SessionState,
  config: BeadworkConfig,
  workerSummary?: WorkerSummary,
): void {
  ctx.ui.setStatus(
    EXTENSION_ID,
    renderStatusText(ctx, activation, sessionState, config, workerSummary),
  );
}
