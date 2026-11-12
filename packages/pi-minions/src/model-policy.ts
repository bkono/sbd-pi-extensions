import type { AgentConfig, AgentMode } from "./types.js";

export const AGENT_MODES = ["plan", "build", "fast"] as const satisfies readonly AgentMode[];

/** Model reference per mode, from `pi-minions.modes` in settings.json. The pack for minions. */
export type ModesConfig = Partial<Record<AgentMode, string>>;

export interface ModelPolicy {
  /** Explicit pack. Always wins. */
  modes: ModesConfig;
  /** Pack-agent models for modes the pack leaves unset (see `packDefaults`). Read only when needed. */
  defaults?: () => ModesConfig;
  /** The session model. Writers run on it when the pack sets no build model. */
  session?: string;
}

export type ModelSelection = { ref: string | undefined; ignored?: string } | { reject: string };

/** The model id without its provider, so `openai-codex/x` and `x` name the same model. */
function modelId(ref: string): string {
  const at = ref.indexOf("/");
  return at === -1 ? ref : ref.slice(at + 1);
}

type Family = "anthropic" | "openai";

function familyOf(ref: string): Family | undefined {
  const id = modelId(ref);
  if (id.startsWith("claude")) return "anthropic";
  if (id.startsWith("gpt") || /^o\d/.test(id)) return "openai";
  return undefined;
}

/** First-party providers per family, in preference order. */
const PROVIDERS: Record<Family, readonly string[]> = {
  anthropic: ["anthropic"],
  openai: ["openai-codex", "openai"],
};

export const DEFAULT_MODEL_IDS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  sol: "gpt-6.1-sol",
  terra: "gpt-6.1-terra",
} as const;

/**
 * Default pack-agent models when `pi-minions.modes` leaves `plan` (reviewer) or `fast` (verifier)
 * unset (Bryan, 2026-11-11):
 * - Anthropic and OpenAI available: verifier on terra; reviewer on the family opposite the
 *   writers' (Opus if any writer ran on OpenAI, else Sol if any ran on Anthropic).
 * - Only Anthropic: reviewer on Opus, verifier on Sonnet.
 * - Only OpenAI: reviewer on Sol, verifier on Terra.
 */
export function packDefaults(input: {
  available: ReadonlyArray<{ provider: string; id: string }>;
  writers: readonly string[];
}): ModesConfig {
  const find = (family: Family, id: string): string | undefined => {
    for (const provider of PROVIDERS[family]) {
      if (input.available.some((m) => m.provider === provider && m.id === id)) {
        return `${provider}/${id}`;
      }
    }
    return undefined;
  };
  const opus = find("anthropic", DEFAULT_MODEL_IDS.opus);
  const sonnet = find("anthropic", DEFAULT_MODEL_IDS.sonnet);
  const sol = find("openai", DEFAULT_MODEL_IDS.sol);
  const terra = find("openai", DEFAULT_MODEL_IDS.terra);
  const anthropic = Boolean(opus || sonnet);
  const openai = Boolean(sol || terra);

  let plan: string | undefined;
  let fast: string | undefined;
  if (anthropic && openai) {
    const families = new Set(input.writers.map(familyOf));
    fast = terra ?? sonnet;
    plan = families.has("openai")
      ? (opus ?? sol)
      : families.has("anthropic")
        ? (sol ?? opus)
        : (opus ?? sol);
  } else if (anthropic) {
    plan = opus ?? sonnet;
    fast = sonnet ?? opus;
  } else if (openai) {
    plan = sol ?? terra;
    fast = terra ?? sol;
  }
  return { ...(plan ? { plan } : {}), ...(fast ? { fast } : {}) };
}

/**
 * Picks the model reference a child runs on. `undefined` means the parent session model.
 *
 * Ordinary agents: task model > agent-file model > the model of the agent's mode > session.
 * Pack agents (`packModel`) run only on their mode's model, explicit or default, and ignore task
 * and file models. Independent agents, pack or not, must not share the writers' model: the
 * build model, else the session model.
 */
export function selectModel(
  taskModel: string | undefined,
  config: AgentConfig,
  policy: ModelPolicy,
): ModelSelection {
  const selection = selectRef(taskModel, config, policy);
  if ("reject" in selection || !config.independent) return selection;
  const writers = policy.modes.build ?? policy.session;
  if (!writers) {
    return {
      reject: `${config.name} must differ from the writers' model; set pi-minions.modes.build in settings.json`,
    };
  }
  if (!selection.ref) {
    return {
      reject: `${config.name} must run on a model other than the writers'; give it a mode or model`,
    };
  }
  if (modelId(writers) === modelId(selection.ref)) {
    const where = config.packModel && config.mode ? `pi-minions.modes.${config.mode}` : "its model";
    return {
      reject: `${config.name} would run on ${selection.ref}, the model writers use; set ${where} to another model`,
    };
  }
  return selection;
}

function selectRef(
  taskModel: string | undefined,
  config: AgentConfig,
  policy: ModelPolicy,
): ModelSelection {
  const { modes } = policy;
  if (!config.packModel) {
    return { ref: taskModel ?? config.model ?? (config.mode ? modes[config.mode] : undefined) };
  }
  const mode = config.mode;
  if (!mode) return { reject: `${config.name} runs on the model pack but sets no mode` };
  const ref = modes[mode] ?? policy.defaults?.()[mode];
  if (!ref) {
    return {
      reject: `${config.name} runs on the ${mode} model and no default is available; set pi-minions.modes.${mode} in settings.json`,
    };
  }
  const override = taskModel ?? config.model;
  return override && override !== ref
    ? { ref, ignored: `model ${override} ignored: ${config.name} runs on the ${mode} model` }
    : { ref };
}
