import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ActivationState, SessionState } from "./types.js";

function describeActivation(activation: ActivationState): string {
  const repoRoot = activation.repoRoot ? ` (${activation.repoRoot})` : "";

  if (activation.kind === "active") {
    return `active${repoRoot}`;
  }

  const reason = activation.reason ? ` · ${activation.reason}` : "";
  return `${activation.kind}${reason}${repoRoot}`;
}

function describeScope(state: SessionState): string {
  if (state.scope.kind === "none") {
    return "none";
  }

  return `${state.scope.kind}:${state.scope.id}`;
}

export function formatStatusLines(activation: ActivationState, state: SessionState): string[] {
  const lines = [
    `Activation: ${describeActivation(activation)}`,
    `Mode: ${state.mode}`,
    `Scope: ${describeScope(state)}`,
    `Updated: ${state.updatedAt}`,
  ];

  if (activation.detail) {
    lines.push(`Detail: ${activation.detail}`);
  }

  return lines;
}

export async function showStatus(
  ctx: ExtensionCommandContext,
  activation: ActivationState,
  state: SessionState,
): Promise<void> {
  ctx.ui.notify(formatStatusLines(activation, state).join("\n"), "info");
}
