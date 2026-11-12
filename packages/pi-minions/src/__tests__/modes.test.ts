import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDiscoverAgentsOptions } from "../agents.js";
import {
  createModesHandler,
  describePack,
  updateSettingsFile,
  writeMode,
} from "../commands/modes.js";
import { getConfig } from "../config.js";
import { AgentTree } from "../tree.js";

const dirs: string[] = [];
let restore: (() => void) | undefined;
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

beforeEach(() => {
  const home = temp("modes-home-");
  restore = installDiscoverAgentsOptions({ agentDir: join(home, "agent"), homeDir: home });
});
afterEach(() => {
  restore?.();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const models = [
  { provider: "anthropic", id: "claude-opus-5-5" },
  { provider: "anthropic", id: "claude-sonnet-5-5" },
  { provider: "openai-codex", id: "gpt-6.1-sol" },
  { provider: "openai-codex", id: "gpt-6.1-terra" },
];

function ctx(
  cwd: string,
  picks: Array<string | undefined>,
  hasUI = true,
  scoped: typeof models = [],
) {
  const select = vi.fn(async (_title: string, options: string[]) => {
    const pick = picks.shift();
    return typeof pick === "string" ? options.find((o) => o.startsWith(pick)) : undefined;
  });
  const notify = vi.fn();
  return {
    c: {
      cwd,
      hasUI,
      model: models[2],
      modelRegistry: { getAvailable: () => models },
      scopedModels: scoped.map((model) => ({ model })),
      ui: { select, notify },
    } as unknown as ExtensionCommandContext,
    select,
    notify,
  };
}

describe("settings writes", () => {
  it("sets and clears one mode, keeping every other setting", () => {
    const path = join(temp("modes-"), "settings.json");
    writeFileSync(path, JSON.stringify({ theme: "dark", "pi-minions": { allowEphemeral: false } }));
    writeMode(path, "fast", "openai-codex/gpt-6.1-terra");
    expect(json(path)).toEqual({
      theme: "dark",
      "pi-minions": { allowEphemeral: false, modes: { fast: "openai-codex/gpt-6.1-terra" } },
    });
    writeMode(path, "fast", undefined);
    expect(json(path)).toEqual({ theme: "dark", "pi-minions": { allowEphemeral: false } });
  });

  it("creates the file, and prunes empty objects", () => {
    const path = join(temp("modes-"), ".pi", "settings.json");
    writeMode(path, "plan", "anthropic/claude-opus-5-5");
    expect(json(path)).toEqual({ "pi-minions": { modes: { plan: "anthropic/claude-opus-5-5" } } });
    writeMode(path, "plan", undefined);
    expect(json(path)).toEqual({});
  });

  it("waits on Pi's settings lock and breaks only a stale one", () => {
    const path = join(temp("modes-"), "settings.json");
    writeFileSync(path, "{}");
    mkdirSync(`${path}.lock`);
    expect(() => writeMode(path, "build", "x/y")).toThrow("settings are locked");
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(`${path}.lock`, old, old);
    writeMode(path, "build", "x/y");
    expect(json(path)).toEqual({ "pi-minions": { modes: { build: "x/y" } } });
  });
});

describe("/minions modes", () => {
  it("describes the effective pack: project over global, defaults, then the session", () => {
    const agentDir = temp("modes-agent-");
    const cwd = temp("modes-cwd-");
    writeMode(join(agentDir, "settings.json"), "build", "anthropic/claude-sonnet-5-5");
    writeMode(join(cwd, ".pi", "settings.json"), "build", "openai-codex/gpt-6.1-sol");
    const labels = describePack(ctx(cwd, []).c, new AgentTree(), agentDir).map((l) => l.label);
    expect(labels).toEqual([
      "plan: anthropic/claude-opus-5-5 (default) · reviewer; investigate only when set",
      "build: openai-codex/gpt-6.1-sol (project) · worker, sbd-worker",
      "fast: openai-codex/gpt-6.1-terra (default) · verifier",
    ]);
  });

  it("picks a scope, then a model per mode, and writes what pi-minions reads", async () => {
    const agentDir = temp("modes-agent-");
    const cwd = temp("modes-cwd-");
    const { c, notify } = ctx(cwd, [
      "This project",
      "plan:",
      "anthropic/claude-opus-5-5",
      "fast:",
      "Unset",
      "Done",
    ]);
    await createModesHandler(new AgentTree(), () => agentDir)(c);
    expect(json(join(cwd, ".pi", "settings.json"))).toEqual({
      "pi-minions": { modes: { plan: "anthropic/claude-opus-5-5" } },
    });
    expect(getConfig({ cwd } as never).modes.plan).toBe("anthropic/claude-opus-5-5");
    expect(notify.mock.calls.at(-1)?.[0]).toContain("plan: anthropic/claude-opus-5-5 (project)");
  });

  it("labels unset plan and fast as refusing when no default is available", () => {
    const { c } = ctx(temp("modes-cwd-"), []);
    const noDefaults = {
      ...c,
      model: { provider: "google", id: "gemini-3-pro" },
      modelRegistry: { getAvailable: () => [{ provider: "google", id: "gemini-3-pro" }] },
    } as unknown as ExtensionCommandContext;
    expect(
      describePack(noDefaults, new AgentTree(), temp("modes-agent-")).map((l) => l.label),
    ).toEqual([
      "plan: unset, no default · reviewer refuses until set; investigate uses the session model",
      "build: google/gemini-3-pro (session) · worker, sbd-worker",
      "fast: unset, no default · verifier refuses until set",
    ]);
  });

  it("does not open the picker without a UI", async () => {
    const cwd = temp("modes-cwd-");
    const { c, select } = ctx(cwd, [], false);
    await createModesHandler(new AgentTree(), () => temp("modes-agent-"))(c);
    expect(select).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, ".pi", "settings.json"))).toBe(false);
  });
});

describe("updateSettingsFile", () => {
  it("refuses to clobber a file that is not JSON", () => {
    const path = join(temp("modes-"), "settings.json");
    writeFileSync(path, "{ not json");
    expect(() => updateSettingsFile(path, () => {})).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});

describe("/minions modes model list", () => {
  it("offers the scoped models first and the full list on request", async () => {
    const cwd = temp("modes-cwd-");
    const { c, select } = ctx(
      cwd,
      ["This project", "build:", "All available", "anthropic/claude-sonnet-5-5", "Done"],
      true,
      [models[2] as (typeof models)[number], models[3] as (typeof models)[number]],
    );
    await createModesHandler(new AgentTree(), () => temp("modes-agent-"))(c);
    expect(select.mock.calls[2]?.[1]).toEqual([
      "Unset (use the default)",
      "openai-codex/gpt-6.1-sol",
      "openai-codex/gpt-6.1-terra",
      "All available models…",
    ]);
    expect(select.mock.calls[3]?.[1]).toHaveLength(models.length + 1);
    expect(json(join(cwd, ".pi", "settings.json"))["pi-minions"].modes.build).toBe(
      "anthropic/claude-sonnet-5-5",
    );
  });
});
