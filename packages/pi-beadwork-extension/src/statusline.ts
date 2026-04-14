import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { EXTENSION_ID } from "./constants.js";
import type { ActivationState, BeadworkConfig, SessionState, WorkerSummary } from "./types.js";

function renderScope(scope: SessionState["scope"]): string | undefined {
  if (scope.kind === "none") {
    return undefined;
  }

  return `${scope.kind} ${scope.id}`;
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

  if (activation.kind === "active") {
    const parts = [theme.fg("accent", "bw"), theme.fg("muted", sessionState.mode)];
    if (scope) {
      parts.push(theme.fg("muted", `· ${scope}`));
    }
    if (workerSummary && workerSummary.active > 0) {
      parts.push(theme.fg("muted", `· workers ${workerSummary.active}`));
    }
    if (workerSummary && workerSummary.failed > 0) {
      parts.push(theme.fg("warning", `· fail ${workerSummary.failed}`));
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
