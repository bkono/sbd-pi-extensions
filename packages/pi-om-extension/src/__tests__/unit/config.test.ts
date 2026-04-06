import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stubbable homedir. We set this before each test and vi.mock node:os to read it.
let currentFakeHome = "";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => currentFakeHome,
  };
});

// Import AFTER the mock is set up.
const { loadConfig, sessionStatePath } = await import("../../config.js");

describe("loadConfig", () => {
  let fakeCwd: string;
  const savedEnv: Record<string, string | undefined> = {};

  const envKeys = [
    "OM_OBSERVATION_MESSAGE_TOKENS",
    "OM_REFLECTION_OBSERVATION_TOKENS",
    "OM_OBSERVATION_PROVIDER",
    "OM_OBSERVATION_MODEL",
    "OM_REFLECTION_PROVIDER",
    "OM_REFLECTION_MODEL",
    "OM_OBSERVATION_TEMPERATURE",
    "OM_REFLECTION_TEMPERATURE",
    "OM_OBSERVATION_TIMEOUT",
    "OM_REFLECTION_TIMEOUT",
    "OM_DEBUG",
  ];

  beforeEach(() => {
    currentFakeHome = mkdtempSync(join(tmpdir(), "om-home-"));
    fakeCwd = mkdtempSync(join(tmpdir(), "om-cwd-"));
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    rmSync(currentFakeHome, { recursive: true, force: true });
    rmSync(fakeCwd, { recursive: true, force: true });
  });

  function writeConfig(dir: string, config: unknown) {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "om-config.json"), JSON.stringify(config));
  }

  it("returns defaults when no config files or env vars exist", () => {
    const config = loadConfig(fakeCwd);
    expect(config.observation.messageTokens).toBe(70_000);
    expect(config.reflection.observationTokens).toBe(50_000);
    expect(config.observation.provider).toBe("google");
    expect(config.observation.modelId).toBe("gemini-2.5-flash");
    expect(config.reflection.provider).toBe("google");
    expect(config.reflection.modelId).toBe("gemini-2.5-flash");
    expect(config.observation.temperature).toBeUndefined();
    expect(config.reflection.temperature).toBeUndefined();
    expect(config.debug).toBe(false);
    expect(config.storage.stateDir).toBe(join(fakeCwd, ".pi", "om-state"));
  });

  it("env OM_OBSERVATION_TEMPERATURE and OM_REFLECTION_TEMPERATURE set per-section values", () => {
    process.env.OM_OBSERVATION_TEMPERATURE = "0.3";
    process.env.OM_REFLECTION_TEMPERATURE = "0.1";
    const config = loadConfig(fakeCwd);
    expect(config.observation.temperature).toBe(0.3);
    expect(config.reflection.temperature).toBe(0.1);
  });

  it("invalid temperature env var is silently ignored", () => {
    process.env.OM_OBSERVATION_TEMPERATURE = "not-a-number";
    const config = loadConfig(fakeCwd);
    expect(config.observation.temperature).toBeUndefined();
  });

  it("global config overrides defaults", () => {
    writeConfig(currentFakeHome, {
      observation: { messageTokens: 12345 },
    });
    const config = loadConfig(fakeCwd);
    expect(config.observation.messageTokens).toBe(12345);
    expect(config.reflection.observationTokens).toBe(50_000);
  });

  it("project config overrides global", () => {
    writeConfig(currentFakeHome, {
      observation: { messageTokens: 12345 },
    });
    writeConfig(fakeCwd, {
      observation: { messageTokens: 99999 },
    });
    const config = loadConfig(fakeCwd);
    expect(config.observation.messageTokens).toBe(99999);
  });

  it("env OM_OBSERVATION_MESSAGE_TOKENS overrides config file", () => {
    writeConfig(fakeCwd, {
      observation: { messageTokens: 99999 },
    });
    process.env.OM_OBSERVATION_MESSAGE_TOKENS = "500";
    const config = loadConfig(fakeCwd);
    expect(config.observation.messageTokens).toBe(500);
  });

  it("env OM_DEBUG=1 enables debug", () => {
    process.env.OM_DEBUG = "1";
    const config = loadConfig(fakeCwd);
    expect(config.debug).toBe(true);
  });

  it("env OM_DEBUG=0 disables debug explicitly", () => {
    process.env.OM_DEBUG = "0";
    const config = loadConfig(fakeCwd);
    expect(config.debug).toBe(false);
  });

  it("invalid numeric env var is silently ignored", () => {
    process.env.OM_OBSERVATION_MESSAGE_TOKENS = "not-a-number";
    const config = loadConfig(fakeCwd);
    expect(config.observation.messageTokens).toBe(70_000);
  });

  it("env provider and model overrides propagate", () => {
    process.env.OM_OBSERVATION_PROVIDER = "google";
    process.env.OM_OBSERVATION_MODEL = "gemini-2.5-flash";
    const config = loadConfig(fakeCwd);
    expect(config.observation.provider).toBe("google");
    expect(config.observation.modelId).toBe("gemini-2.5-flash");
  });

  it("includes default timeout values", () => {
    const config = loadConfig(fakeCwd);
    expect(config.observation.timeout).toBe(120_000);
    expect(config.reflection.timeout).toBe(120_000);
  });

  it("env OM_OBSERVATION_TIMEOUT and OM_REFLECTION_TIMEOUT override defaults", () => {
    process.env.OM_OBSERVATION_TIMEOUT = "30000";
    process.env.OM_REFLECTION_TIMEOUT = "60000";
    const config = loadConfig(fakeCwd);
    expect(config.observation.timeout).toBe(30_000);
    expect(config.reflection.timeout).toBe(60_000);
  });

  it("invalid timeout env var is ignored", () => {
    process.env.OM_OBSERVATION_TIMEOUT = "not-a-number";
    const config = loadConfig(fakeCwd);
    expect(config.observation.timeout).toBe(120_000);
  });

  it("warns to stderr when config file has invalid JSON", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const configDir = join(currentFakeHome, ".pi");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "om-config.json"), "{ invalid json ,,,");

    const config = loadConfig(fakeCwd);

    // Falls back to defaults
    expect(config.observation.messageTokens).toBe(70_000);
    // Logged a warning
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[om:config] Failed to parse config file"),
    );
    spy.mockRestore();
  });
});

describe("sessionStatePath", () => {
  it("sanitizes non-alphanumeric characters", () => {
    const path = sessionStatePath("/tmp/state", "session/with:special*chars");
    expect(path).toContain("session_with_special_chars.json");
    expect(path).not.toContain(":");
    expect(path).not.toContain("*");
    expect(path).not.toContain("/session/");
  });

  it("preserves safe characters", () => {
    const path = sessionStatePath("/tmp/state", "abc-123_XYZ");
    expect(path).toContain("abc-123_XYZ.json");
  });
});
