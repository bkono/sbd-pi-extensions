import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExaExtensionConfig, ExaSearchType } from "./types.js";

type ExaConfigInput = Partial<ExaExtensionConfig> & {
  exaApiKey?: string;
  searchType?: ExaSearchType;
  numResults?: number;
};

export const DEFAULT_NUM_RESULTS = 5;
export const DEFAULT_MAX_TEXT_PER_RESULT = 800;
export const MAX_NUM_RESULTS = 10;

function globalConfigPath(): string {
  return join(homedir(), ".pi", "exa-config.json");
}

function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "exa-config.json");
}

function defaults(): ExaExtensionConfig {
  return {
    apiKey: undefined,
    defaultSearchType: "auto",
    defaultNumResults: DEFAULT_NUM_RESULTS,
    maxTextPerResult: DEFAULT_MAX_TEXT_PER_RESULT,
  };
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    console.error(
      `[exa:config] Failed to parse config file: ${path}\n` +
        `  ${err instanceof Error ? err.message : String(err)}\n` +
        "  This config file will be ignored — defaults will be used instead.",
    );
    return undefined;
  }
}

function normalizeSearchType(value: unknown): ExaSearchType | undefined {
  return value === "auto" || value === "neural" || value === "keyword" ? value : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}

function clamp(value: number, minimum: number, maximum?: number): number {
  const lowerBounded = Math.max(minimum, value);
  return maximum === undefined ? lowerBounded : Math.min(maximum, lowerBounded);
}

function normalizeConfigInput(input: ExaConfigInput): Partial<ExaExtensionConfig> {
  const defaultSearchType = normalizeSearchType(input.defaultSearchType ?? input.searchType);
  const defaultNumResults = normalizePositiveInteger(input.defaultNumResults ?? input.numResults);
  const maxTextPerResult = normalizePositiveInteger(input.maxTextPerResult);

  return {
    apiKey:
      typeof input.apiKey === "string"
        ? input.apiKey
        : typeof input.exaApiKey === "string"
          ? input.exaApiKey
          : undefined,
    defaultSearchType,
    defaultNumResults:
      defaultNumResults === undefined ? undefined : clamp(defaultNumResults, 1, MAX_NUM_RESULTS),
    maxTextPerResult: maxTextPerResult === undefined ? undefined : clamp(maxTextPerResult, 1),
  };
}

function mergeConfig(
  base: ExaExtensionConfig,
  partial?: Partial<ExaExtensionConfig>,
): ExaExtensionConfig {
  if (!partial) {
    return base;
  }

  return {
    apiKey: partial.apiKey ?? base.apiKey,
    defaultSearchType: partial.defaultSearchType ?? base.defaultSearchType,
    defaultNumResults: partial.defaultNumResults ?? base.defaultNumResults,
    maxTextPerResult: partial.maxTextPerResult ?? base.maxTextPerResult,
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function applyEnvOverrides(config: ExaExtensionConfig): ExaExtensionConfig {
  const env = process.env;
  const apiKey = firstNonEmpty(env.PI_EXA_API_KEY, env.EXA_API_KEY);
  const defaultSearchType = normalizeSearchType(
    firstNonEmpty(env.PI_EXA_DEFAULT_SEARCH_TYPE, env.PI_EXA_SEARCH_TYPE),
  );
  const defaultNumResults = normalizePositiveInteger(
    firstNonEmpty(env.PI_EXA_DEFAULT_NUM_RESULTS, env.PI_EXA_NUM_RESULTS)
      ? Number.parseInt(firstNonEmpty(env.PI_EXA_DEFAULT_NUM_RESULTS, env.PI_EXA_NUM_RESULTS)!, 10)
      : undefined,
  );
  const maxTextPerResult = normalizePositiveInteger(
    env.PI_EXA_MAX_TEXT_PER_RESULT
      ? Number.parseInt(env.PI_EXA_MAX_TEXT_PER_RESULT, 10)
      : undefined,
  );

  return mergeConfig(config, {
    apiKey,
    defaultSearchType,
    defaultNumResults:
      defaultNumResults === undefined ? undefined : clamp(defaultNumResults, 1, MAX_NUM_RESULTS),
    maxTextPerResult: maxTextPerResult === undefined ? undefined : clamp(maxTextPerResult, 1),
  });
}

export function loadConfig(cwd: string = process.cwd()): ExaExtensionConfig {
  let config = defaults();

  const global = readJsonFile(globalConfigPath());
  if (global) {
    config = mergeConfig(config, normalizeConfigInput(global as ExaConfigInput));
  }

  const project = readJsonFile(projectConfigPath(cwd));
  if (project) {
    config = mergeConfig(config, normalizeConfigInput(project as ExaConfigInput));
  }

  config = applyEnvOverrides(config);

  return config;
}
