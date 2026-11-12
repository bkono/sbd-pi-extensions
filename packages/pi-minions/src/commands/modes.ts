import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { modelPolicyFor } from "../model-context.js";
import { AGENT_MODES, type ModesConfig } from "../model-policy.js";
import type { AgentTree } from "../tree.js";
import type { AgentMode } from "../types.js";

export type SettingsScope = "global" | "project";

export function settingsPath(scope: SettingsScope, cwd: string, agentDir = getAgentDir()): string {
  return scope === "global" ? join(agentDir, "settings.json") : join(cwd, ".pi", "settings.json");
}

const LOCK_ATTEMPTS = 10;
const LOCK_DELAY_MS = 20;
const LOCK_STALE_MS = 10_000;

function sleepSync(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Synchronous wait, as Pi's own settings lock does.
  }
}

/**
 * Read-modify-write a settings file under the same lock Pi's SettingsManager takes
 * (proper-lockfile's convention: an atomic mkdir of `<file>.lock`). Pi re-reads the file under
 * that lock and merges only the fields it changed, so its later saves keep this edit.
 */
export function updateSettingsFile(
  path: string,
  update: (settings: Record<string, unknown>) => void,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  let held = false;
  for (let attempt = 1; attempt <= LOCK_ATTEMPTS && !held; attempt++) {
    try {
      mkdirSync(lock);
      held = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock);
      } catch {
        // Released between the failed mkdir and the stat.
      }
      if (attempt < LOCK_ATTEMPTS) sleepSync(LOCK_DELAY_MS);
    }
  }
  if (!held) throw new Error(`settings are locked: ${lock}`);
  try {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    const settings = current.trim() ? (JSON.parse(current) as Record<string, unknown>) : {};
    update(settings);
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  } finally {
    rmdirSync(lock);
  }
}

/** Sets or, with `undefined`, clears one mode in `pi-minions.modes`, pruning empty objects. */
export function writeMode(path: string, mode: AgentMode, ref: string | undefined): void {
  updateSettingsFile(path, (settings) => {
    const minions = (settings["pi-minions"] ?? {}) as Record<string, unknown>;
    const modes = (minions.modes ?? {}) as Record<string, string>;
    if (ref) modes[mode] = ref;
    else delete modes[mode];
    if (Object.keys(modes).length > 0) minions.modes = modes;
    else delete minions.modes;
    if (Object.keys(minions).length > 0) settings["pi-minions"] = minions;
    else delete settings["pi-minions"];
  });
}

export function readModes(path: string): ModesConfig {
  try {
    const settings = JSON.parse(readFileSync(path, "utf8")) as {
      "pi-minions"?: { modes?: Record<string, unknown> };
    };
    const raw = settings["pi-minions"]?.modes ?? {};
    const modes: ModesConfig = {};
    for (const mode of AGENT_MODES) {
      const value = raw[mode];
      if (typeof value === "string" && value.trim()) modes[mode] = value.trim();
    }
    return modes;
  } catch {
    return {};
  }
}

export interface ModeLine {
  mode: AgentMode;
  /** What the mode resolves to now, and why. */
  label: string;
}

const ROLE: Record<AgentMode, string> = {
  plan: "reviewer; investigate only when set",
  build: "worker, sbd-worker",
  fast: "verifier",
};

/** The effective pack: project over global; unset plan/fast show their default, build the session. */
export function describePack(
  ctx: Pick<ExtensionCommandContext, "cwd" | "model" | "modelRegistry">,
  tree: Pick<AgentTree, "getAll">,
  agentDir = getAgentDir(),
): ModeLine[] {
  const global = readModes(settingsPath("global", ctx.cwd, agentDir));
  const project = readModes(settingsPath("project", ctx.cwd, agentDir));
  const modes = { ...global, ...project };
  const defaults = modelPolicyFor(ctx, tree, modes, ctx.cwd).defaults?.() ?? {};
  const session = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the session model";
  return AGENT_MODES.map((mode) => {
    const explicit = project[mode]
      ? `${project[mode]} (project)`
      : global[mode]
        ? `${global[mode]} (global)`
        : undefined;
    const fallback =
      mode !== "build" && defaults[mode] ? `${defaults[mode]} (default)` : `${session} (session)`;
    return { mode, label: `${mode}: ${explicit ?? fallback} · ${ROLE[mode]}` };
  });
}

const DONE = "Done";
const GLOBAL = "All projects (~/.pi/agent/settings.json)";
const PROJECT = "This project (.pi/settings.json)";
const USE_DEFAULT = "Unset (use the default)";
const ALL_MODELS = "All available models…";

/** `/minions modes`: pick the plan, build and fast models, as Mastra Code's model packs do. */
export function createModesHandler(tree: Pick<AgentTree, "getAll">, agentDir?: () => string) {
  return async (ctx: ExtensionCommandContext): Promise<void> => {
    const dir = agentDir?.() ?? getAgentDir();
    const summary = () =>
      describePack(ctx, tree, dir)
        .map((line) => line.label)
        .join("\n");
    if (!ctx.hasUI) {
      ctx.ui.notify(`Minion model pack:\n${summary()}\nSet it in pi-minions.modes.`, "info");
      return;
    }
    const where = await ctx.ui.select("Save the model pack for", [GLOBAL, PROJECT]);
    if (!where) return;
    const scope: SettingsScope = where === PROJECT ? "project" : "global";
    const path = settingsPath(scope, ctx.cwd, dir);
    const available = ctx.modelRegistry
      .getAvailable()
      .map((m) => `${m.provider}/${m.id}`)
      .sort();
    // Mirror Pi's own picker: the scoped models (enabledModels / --models) first.
    const scoped = [...new Set(ctx.scopedModels.map((s) => `${s.model.provider}/${s.model.id}`))];
    const label = (ref: string, current?: string) => (ref === current ? `${ref} (current)` : ref);
    for (;;) {
      const lines = describePack(ctx, tree, dir);
      const pick = await ctx.ui.select("Minion model pack", [
        ...lines.map((line) => line.label),
        DONE,
      ]);
      const line = lines.find((l) => l.label === pick);
      if (!line) break;
      const current = readModes(path)[line.mode];
      const title = `${line.mode} model (${scope})`;
      let model = await ctx.ui.select(
        title,
        scoped.length > 0
          ? [USE_DEFAULT, ...scoped.map((ref) => label(ref, current)), ALL_MODELS]
          : [USE_DEFAULT, ...available.map((ref) => label(ref, current))],
      );
      if (model === ALL_MODELS) {
        model = await ctx.ui.select(title, [
          USE_DEFAULT,
          ...available.map((ref) => label(ref, current)),
        ]);
      }
      if (!model) continue;
      const ref = model === USE_DEFAULT ? undefined : model.replace(/ \(current\)$/, "");
      writeMode(path, line.mode, ref);
    }
    ctx.ui.notify(`Minion model pack:\n${summary()}`, "info");
  };
}
