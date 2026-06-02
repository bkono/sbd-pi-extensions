import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export interface PiMinionsConfig {
  minionNames?: string[];
  allowEphemeral?: boolean;
  delegation?: DelegationConfig;
  display?: DisplayConfig;
  toolSync?: ToolSyncConfig;
}

export interface ToolSyncConfig {
  enabled?: boolean;
  maxWait?: number;
}

export interface DelegationConfig {
  enabled?: boolean;
  toolCallThreshold?: number;
  promptLengthThreshold?: number;
  hintIntervalMinutes?: number;
  acknowledgementRequired?: boolean;
  complexTaskKeywords?: string[];
  message?: string;
}

export interface ResolvedDelegationConfig {
  enabled: boolean;
  toolCallThreshold: number;
  promptLengthThreshold: number;
  hintIntervalMinutes: number;
  acknowledgementRequired: boolean;
  complexTaskKeywords: string[];
  message?: string;
}

export interface DisplayConfig {
  outputPreviewLines?: number;
  observabilityLines?: number;
  showStatusHints?: boolean;
  spinnerFrames?: string[];
}

export interface ResolvedConfig {
  minionNames: string[];
  allowEphemeral: boolean;
  display: Required<DisplayConfig>;
  toolSync: Required<ToolSyncConfig>;
  delegation: ResolvedDelegationConfig;
}

interface PiSettings {
  "pi-minions"?: PiMinionsConfig;
}

function loadSettings(cwd: string): PiSettings {
  const settings: PiSettings = {};

  const globalSettingsPath = join(getAgentDir(), "settings.json");
  if (existsSync(globalSettingsPath)) {
    try {
      const globalContent = readFileSync(globalSettingsPath, "utf-8");
      const globalSettings = JSON.parse(globalContent) as PiSettings;
      Object.assign(settings, globalSettings);
    } catch {
      // Ignore parse errors, use defaults
    }
  }

  const projectSettingsPath = join(cwd, ".pi", "settings.json");
  if (existsSync(projectSettingsPath)) {
    try {
      const projectContent = readFileSync(projectSettingsPath, "utf-8");
      const projectSettings = JSON.parse(projectContent) as PiSettings;
      if (projectSettings["pi-minions"]) {
        settings["pi-minions"] = {
          ...settings["pi-minions"],
          ...projectSettings["pi-minions"],
          delegation: {
            ...settings["pi-minions"]?.delegation,
            ...projectSettings["pi-minions"]?.delegation,
          },
          display: {
            ...settings["pi-minions"]?.display,
            ...projectSettings["pi-minions"]?.display,
          },
          toolSync: {
            ...settings["pi-minions"]?.toolSync,
            ...projectSettings["pi-minions"]?.toolSync,
          },
        };
      }
    } catch {
      // Ignore parse errors, use defaults
    }
  }

  return settings;
}

export const DEFAULT_MINION_NAMES = [
  "kevin",
  "stuart",
  "bob",
  "otto",
  "mel",
  "arnie",
  "barry",
  "beena",
  "billy",
  "bina",
  "bobby",
  "brett",
  "brian",
  "cameron",
  "carl",
  "claude",
  "dan",
  "dave",
  "devin",
  "donny",
  "erik",
  "frank",
  "fred",
  "gaetano",
  "gary",
  "george",
  "gerald",
  "gigi",
  "jeff",
  "jim",
  "jon",
  "jorge",
  "juan",
  "ken",
  "keela",
  "koko",
  "lance",
  "larry",
  "lionel",
  "lola",
  "lulu",
  "mack",
  "mimi",
  "momo",
  "nana",
  "norbert",
  "pedro",
  "peter",
  "pip",
  "pippa",
  "ralph",
  "robert",
  "ron",
  "samson",
  "steve",
  "ted",
  "tim",
  "tom",
  "tony",
  "zack",
  "ziggy",
];

export const DEFAULT_SPINNER_FRAMES = [
  "[oo]",
  "[oo]",
  "[oo]",
  "[oo]",
  "[o-]",
  "[--]",
  "[--]",
  "[-o]",
  "[oo]",
  "[oo]",
];

export const DEFAULT_COMPLEX_TASK_KEYWORDS = [
  "investigate",
  "audit",
  "review",
  "refactor",
  "analyze",
  "implement",
];

export function getConfig(ctx: ExtensionContext): ResolvedConfig {
  const settings = loadSettings(ctx.cwd);
  const user = settings["pi-minions"] ?? {};
  return {
    minionNames: [...(user.minionNames ?? DEFAULT_MINION_NAMES)],
    allowEphemeral: user.allowEphemeral ?? true,
    delegation: {
      enabled: user.delegation?.enabled ?? true,
      toolCallThreshold: user.delegation?.toolCallThreshold ?? 16,
      promptLengthThreshold: user.delegation?.promptLengthThreshold ?? 200,
      hintIntervalMinutes: user.delegation?.hintIntervalMinutes ?? 8,
      acknowledgementRequired: user.delegation?.acknowledgementRequired ?? false,
      complexTaskKeywords: [
        ...(user.delegation?.complexTaskKeywords ?? DEFAULT_COMPLEX_TASK_KEYWORDS),
      ],
      message: user.delegation?.message,
    },
    display: {
      outputPreviewLines: user.display?.outputPreviewLines ?? 20,
      observabilityLines: user.display?.observabilityLines ?? 6,
      showStatusHints: user.display?.showStatusHints ?? true,
      spinnerFrames: [...(user.display?.spinnerFrames ?? DEFAULT_SPINNER_FRAMES)],
    },
    toolSync: {
      enabled: user.toolSync?.enabled ?? true,
      maxWait: user.toolSync?.maxWait ?? 5,
    },
  };
}
