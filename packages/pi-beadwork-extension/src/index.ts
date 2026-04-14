import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { detectActivation } from "./activation.js";
import { showStatus } from "./commands.js";
import { loadConfig } from "./config.js";
import { COMMAND_NAME, DEFAULT_SESSION_STATE } from "./constants.js";
import {
  loadSessionState,
  resetSessionState,
  resolveSessionStateDir,
  saveSessionState,
} from "./session-state.js";
import { updateStatusline } from "./statusline.js";
import type { ActivationState, BeadworkConfig, SessionState } from "./types.js";

export { loadConfig } from "./config.js";
export type {
  ActivationState,
  BeadworkConfig,
  SessionMode,
  SessionScope,
  SessionState,
} from "./types.js";

function buildDefaultSessionState(): SessionState {
  return {
    ...DEFAULT_SESSION_STATE,
    updatedAt: new Date().toISOString(),
  };
}

export default function piBeadworkExtension(pi: ExtensionAPI): void {
  const stateCache = new Map<string, SessionState>();

  function getStateDir(
    ctx: ExtensionContext,
    activation: ActivationState,
    config: BeadworkConfig,
  ): string {
    return resolveSessionStateDir(activation.repoRoot ?? ctx.cwd, config.storage.sessionStateDir);
  }

  async function readSessionState(
    ctx: ExtensionContext,
    activation: ActivationState,
    config: BeadworkConfig,
  ): Promise<SessionState> {
    const sessionId = ctx.sessionManager.getSessionId();
    const cached = stateCache.get(sessionId);
    if (cached) {
      return cached;
    }

    try {
      const state = await loadSessionState(getStateDir(ctx, activation, config), sessionId);
      stateCache.set(sessionId, state);
      return state;
    } catch {
      const fallback = buildDefaultSessionState();
      stateCache.set(sessionId, fallback);
      return fallback;
    }
  }

  async function writeSessionState(
    ctx: ExtensionContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
  ): Promise<SessionState> {
    const sessionId = ctx.sessionManager.getSessionId();
    const normalized = {
      ...state,
      updatedAt: new Date().toISOString(),
    };

    stateCache.set(sessionId, normalized);

    try {
      return await saveSessionState(getStateDir(ctx, activation, config), sessionId, normalized);
    } catch {
      return normalized;
    }
  }

  async function refreshStatus(
    ctx: ExtensionContext,
  ): Promise<{ activation: ActivationState; state: SessionState }> {
    const config = loadConfig(ctx.cwd);
    const activation = await detectActivation(ctx.cwd);
    const state = await readSessionState(ctx, activation, config);

    updateStatusline(ctx, activation, state, config);

    return { activation, state };
  }

  async function resetState(ctx: ExtensionCommandContext): Promise<SessionState> {
    const config = loadConfig(ctx.cwd);
    const activation = await detectActivation(ctx.cwd);
    const sessionId = ctx.sessionManager.getSessionId();
    const nextState = buildDefaultSessionState();

    stateCache.set(sessionId, nextState);

    try {
      const persisted = await resetSessionState(getStateDir(ctx, activation, config), sessionId);
      stateCache.set(sessionId, persisted);
      updateStatusline(ctx, activation, persisted, config);
      return persisted;
    } catch {
      updateStatusline(ctx, activation, nextState, config);
      return nextState;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    const activation = await detectActivation(ctx.cwd);
    const state = await readSessionState(ctx, activation, config);
    await writeSessionState(ctx, activation, config, state);
    updateStatusline(ctx, activation, state, config);
  });

  pi.on("turn_end", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Beadwork session status and mode controls",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [subcommand] = trimmed.length > 0 ? trimmed.split(/\s+/) : ["status"];

      if (subcommand === "status") {
        const { activation, state } = await refreshStatus(ctx);
        await showStatus(ctx, activation, state);
        return;
      }

      if (subcommand === "off") {
        const activation = await detectActivation(ctx.cwd);
        const state = await resetState(ctx);
        ctx.ui.notify("Beadwork session mode reset to neutral.", "info");
        await showStatus(ctx, activation, state);
        return;
      }

      ctx.ui.notify("Usage: /bw [status|off]", "info");
    },
  });
}
