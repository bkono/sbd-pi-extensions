import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { EXTENSION_ID } from "./constants.js";
import type { ActivationState, BeadworkConfig, SessionState } from "./types.js";

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
): string | undefined {
  const theme = ctx.ui.theme;
  const scope = renderScope(sessionState.scope);

  if (activation.kind === "active") {
    const parts = [theme.fg("accent", "bw"), theme.fg("muted", sessionState.mode)];
    if (scope) {
      parts.push(theme.fg("muted", `· ${scope}`));
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
): void {
  ctx.ui.setStatus(EXTENSION_ID, renderStatusText(ctx, activation, sessionState, config));
}
