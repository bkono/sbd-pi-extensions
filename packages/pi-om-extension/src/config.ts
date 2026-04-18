import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { KnownProvider } from "@mariozechner/pi-ai";

import type { OMConfig } from "./types.js";

function globalConfigPath(): string {
  return join(homedir(), ".pi", "om-config.json");
}

function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "om-config.json");
}

/** Default timeout for observer/reflector LLM calls (ms). */
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STAGE_MESSAGE_TOKENS = 32_000;
const DEFAULT_PUBLISH_MESSAGE_TOKENS = 32_000;

const DEFAULT_STAGE_MESSAGE_COUNT = 12;
const DEFAULT_PUBLISH_MESSAGE_COUNT = 12;
const DEFAULT_STAGE_TOOL_RESULT_TOKENS = 6_000;
const DEFAULT_PUBLISH_TOOL_RESULT_TOKENS = 6_000;
const DEFAULT_MAX_CHUNK_MESSAGE_TOKENS = 8_000;
const DEFAULT_MAX_CHUNK_MESSAGES = 8;

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

type LegacyConfigInput = DeepPartial<OMConfig> & {
  observation?: DeepPartial<OMConfig["observation"]> & {
    messageTokens?: number;
  };
};

function defaults(cwd: string): OMConfig {
  return {
    observation: {
      stageMessageTokens: DEFAULT_STAGE_MESSAGE_TOKENS,
      publishMessageTokens: DEFAULT_PUBLISH_MESSAGE_TOKENS,
      stageMessageCount: DEFAULT_STAGE_MESSAGE_COUNT,
      publishMessageCount: DEFAULT_PUBLISH_MESSAGE_COUNT,
      stageToolResultTokens: DEFAULT_STAGE_TOOL_RESULT_TOKENS,
      publishToolResultTokens: DEFAULT_PUBLISH_TOOL_RESULT_TOKENS,
      maxChunkMessageTokens: DEFAULT_MAX_CHUNK_MESSAGE_TOKENS,
      maxChunkMessages: DEFAULT_MAX_CHUNK_MESSAGES,
      provider: "google",
      modelId: "gemini-2.5-flash",
      timeout: DEFAULT_TIMEOUT_MS,
    },
    reflection: {
      observationTokens: 50_000,
      provider: "google",
      modelId: "gemini-2.5-flash",
      timeout: DEFAULT_TIMEOUT_MS,
    },
    storage: {
      stateDir: join(cwd, ".pi", "om-state"),
    },
    debug: false,
  };
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    // Distinguish "file not found" (expected) from parse errors (actionable)
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(
        `[om:config] Failed to parse config file: ${path}\n` +
          `  ${err instanceof Error ? err.message : String(err)}\n` +
          "  This config file will be ignored — defaults will be used instead.",
      );
    }
    return undefined;
  }
}

function normalizeConfigInput(partial: LegacyConfigInput): DeepPartial<OMConfig> {
  const observation = partial.observation ? { ...partial.observation } : undefined;

  if (
    observation &&
    typeof observation.messageTokens === "number" &&
    Number.isFinite(observation.messageTokens)
  ) {
    observation.stageMessageTokens ??= observation.messageTokens;
    observation.publishMessageTokens ??= observation.messageTokens;
  }

  if (observation && "messageTokens" in observation) {
    delete observation.messageTokens;
  }

  return {
    ...partial,
    observation,
  };
}

function mergeConfig(base: OMConfig, partial: DeepPartial<OMConfig>): OMConfig {
  return {
    observation: {
      ...base.observation,
      ...partial.observation,
    },
    reflection: {
      ...base.reflection,
      ...partial.reflection,
    },
    storage: {
      ...base.storage,
      ...partial.storage,
    },
    debug: partial.debug ?? base.debug,
  };
}

function applyNumberOverride(value: string | undefined, apply: (parsed: number) => void): void {
  if (value === undefined) {
    return;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isNaN(parsed)) {
    apply(parsed);
  }
}

function applyPositiveNumberOverride(
  value: string | undefined,
  apply: (parsed: number) => void,
): void {
  if (value === undefined) {
    return;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isNaN(parsed) && parsed > 0) {
    apply(parsed);
  }
}

function applyEnvOverrides(config: OMConfig): OMConfig {
  const env = process.env;
  applyNumberOverride(env.OM_OBSERVATION_MESSAGE_TOKENS, (value) => {
    config.observation.stageMessageTokens = value;
    config.observation.publishMessageTokens = value;
  });

  applyNumberOverride(env.OM_OBSERVATION_STAGE_MESSAGE_TOKENS, (value) => {
    config.observation.stageMessageTokens = value;
  });

  applyNumberOverride(env.OM_OBSERVATION_PUBLISH_MESSAGE_TOKENS, (value) => {
    config.observation.publishMessageTokens = value;
  });

  applyNumberOverride(env.OM_OBSERVATION_STAGE_MESSAGE_COUNT, (value) => {
    config.observation.stageMessageCount = value;
  });

  applyNumberOverride(env.OM_OBSERVATION_PUBLISH_MESSAGE_COUNT, (value) => {
    config.observation.publishMessageCount = value;
  });

  applyNumberOverride(env.OM_OBSERVATION_STAGE_TOOL_RESULT_TOKENS, (value) => {
    config.observation.stageToolResultTokens = value;
  });

  applyNumberOverride(env.OM_OBSERVATION_PUBLISH_TOOL_RESULT_TOKENS, (value) => {
    config.observation.publishToolResultTokens = value;
  });

  applyNumberOverride(env.OM_OBSERVATION_MAX_CHUNK_MESSAGE_TOKENS, (value) => {
    config.observation.maxChunkMessageTokens = value;
  });

  applyNumberOverride(env.OM_OBSERVATION_MAX_CHUNK_MESSAGES, (value) => {
    config.observation.maxChunkMessages = value;
  });

  applyNumberOverride(env.OM_REFLECTION_OBSERVATION_TOKENS, (value) => {
    config.reflection.observationTokens = value;
  });
  if (env.OM_OBSERVATION_PROVIDER) {
    config.observation.provider = env.OM_OBSERVATION_PROVIDER as KnownProvider;
  }
  if (env.OM_OBSERVATION_MODEL) {
    config.observation.modelId = env.OM_OBSERVATION_MODEL;
  }
  if (env.OM_REFLECTION_PROVIDER) {
    config.reflection.provider = env.OM_REFLECTION_PROVIDER as KnownProvider;
  }
  if (env.OM_REFLECTION_MODEL) {
    config.reflection.modelId = env.OM_REFLECTION_MODEL;
  }
  if (env.OM_OBSERVATION_TEMPERATURE !== undefined) {
    const v = Number.parseFloat(env.OM_OBSERVATION_TEMPERATURE);
    if (Number.isFinite(v)) config.observation.temperature = v;
  }
  if (env.OM_REFLECTION_TEMPERATURE !== undefined) {
    const v = Number.parseFloat(env.OM_REFLECTION_TEMPERATURE);
    if (Number.isFinite(v)) config.reflection.temperature = v;
  }

  applyPositiveNumberOverride(env.OM_OBSERVATION_TIMEOUT, (value) => {
    config.observation.timeout = value;
  });

  applyPositiveNumberOverride(env.OM_REFLECTION_TIMEOUT, (value) => {
    config.reflection.timeout = value;
  });
  if (env.OM_DEBUG !== undefined) {
    config.debug = env.OM_DEBUG === "1";
  }
  return config;
}

export function loadConfig(cwd: string = process.cwd()): OMConfig {
  let config = defaults(cwd);

  const global = readJsonFile(globalConfigPath());
  if (global) {
    config = mergeConfig(config, normalizeConfigInput(global as LegacyConfigInput));
  }

  const project = readJsonFile(projectConfigPath(cwd));
  if (project) {
    config = mergeConfig(config, normalizeConfigInput(project as LegacyConfigInput));
  }

  config = applyEnvOverrides(config);

  return config;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function sessionStatePath(stateDir: string, sessionId: string): string {
  return join(stateDir, `${sanitize(sessionId)}.json`);
}

export async function ensureParentDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}
