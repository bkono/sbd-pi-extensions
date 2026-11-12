import type { AgentConfig, AgentMode } from "./types.js";

export const AGENT_MODES = ["plan", "build", "fast"] as const satisfies readonly AgentMode[];

/** Model reference per mode, from `pi-minions.modes` in settings.json. The pack for minions. */
export type ModesConfig = Partial<Record<AgentMode, string>>;

export type ModelSelection = { ref: string | undefined; ignored?: string } | { reject: string };

/** The model id without its provider, so `openai-codex/x` and `x` name the same model. */
function modelId(ref: string): string {
  const at = ref.indexOf("/");
  return at === -1 ? ref : ref.slice(at + 1);
}

/**
 * Picks the model reference a child runs on. `undefined` means the parent session model.
 *
 * Ordinary agents: task model > agent-file model > the model of the agent's mode > session.
 * Pack agents (`packModel`) run only on their mode's model and ignore task and file models.
 * Independent agents, pack or not, must not share the build model, which writers run on by default.
 */
export function selectModel(
  taskModel: string | undefined,
  config: AgentConfig,
  modes: ModesConfig,
): ModelSelection {
  const selection = selectRef(taskModel, config, modes);
  if ("reject" in selection || !config.independent) return selection;
  const writers = modes.build;
  if (!writers) {
    return {
      reject: `${config.name} must differ from the writers' model; set pi-minions.modes.build in settings.json`,
    };
  }
  if (!selection.ref) {
    return {
      reject: `${config.name} must run on a model other than the build model; give it a mode or model`,
    };
  }
  if (modelId(writers) === modelId(selection.ref)) {
    const where = config.packModel && config.mode ? `pi-minions.modes.${config.mode}` : "its model";
    return {
      reject: `${config.name} would run on ${selection.ref}, the build model writers use; set ${where} to another model`,
    };
  }
  return selection;
}

function selectRef(
  taskModel: string | undefined,
  config: AgentConfig,
  modes: ModesConfig,
): ModelSelection {
  if (!config.packModel) {
    return { ref: taskModel ?? config.model ?? (config.mode ? modes[config.mode] : undefined) };
  }
  const mode = config.mode;
  if (!mode) return { reject: `${config.name} runs on the model pack but sets no mode` };
  const ref = modes[mode];
  if (!ref) {
    return {
      reject: `${config.name} runs on the ${mode} model; set pi-minions.modes.${mode} in settings.json`,
    };
  }
  const override = taskModel ?? config.model;
  return override && override !== ref
    ? { ref, ignored: `model ${override} ignored: ${config.name} runs on the ${mode} model` }
    : { ref };
}
