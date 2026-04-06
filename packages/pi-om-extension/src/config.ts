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

function defaults(cwd: string): OMConfig {
  return {
    observation: {
      messageTokens: 70_000,
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

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

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

function applyEnvOverrides(config: OMConfig): OMConfig {
  const env = process.env;

  if (env.OM_OBSERVATION_MESSAGE_TOKENS) {
    const v = Number.parseInt(env.OM_OBSERVATION_MESSAGE_TOKENS, 10);
    if (!Number.isNaN(v)) config.observation.messageTokens = v;
  }

  if (env.OM_REFLECTION_OBSERVATION_TOKENS) {
    const v = Number.parseInt(env.OM_REFLECTION_OBSERVATION_TOKENS, 10);
    if (!Number.isNaN(v)) config.reflection.observationTokens = v;
  }

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

  if (env.OM_OBSERVATION_TIMEOUT !== undefined) {
    const v = Number.parseInt(env.OM_OBSERVATION_TIMEOUT, 10);
    if (!Number.isNaN(v) && v > 0) config.observation.timeout = v;
  }

  if (env.OM_REFLECTION_TIMEOUT !== undefined) {
    const v = Number.parseInt(env.OM_REFLECTION_TIMEOUT, 10);
    if (!Number.isNaN(v) && v > 0) config.reflection.timeout = v;
  }

  if (env.OM_DEBUG !== undefined) {
    config.debug = env.OM_DEBUG === "1";
  }

  return config;
}

export function loadConfig(cwd: string = process.cwd()): OMConfig {
  let config = defaults(cwd);

  const global = readJsonFile(globalConfigPath());
  if (global) {
    config = mergeConfig(config, global as DeepPartial<OMConfig>);
  }

  const project = readJsonFile(projectConfigPath(cwd));
  if (project) {
    config = mergeConfig(config, project as DeepPartial<OMConfig>);
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
