import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { parseSpawnArgs } from "../commands/spawn.js";
import { DEFAULT_MINION_NAMES } from "../config.js";
import { pickMinionName } from "../minions.js";
import { formatToolCall } from "../render.js";
import { shouldLoadExtensionInMinion } from "../subsessions/manager.js";
import { AgentTree } from "../tree.js";

function createSettingsCwd(settings: unknown): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-minions-test-"));
  const piDir = join(cwd, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(join(piDir, "settings.json"), JSON.stringify(settings), "utf-8");
  return cwd;
}

describe("spawn helper regressions", () => {
  it("renders a single task descriptor without [object Object]", () => {
    const rendered = formatToolCall("spawn", { tasks: [{ task: "review the auth flow" }] });

    expect(rendered).toContain("review the auth flow");
    expect(rendered).not.toContain("[object Object]");
  });

  it("treats unknown flag-like words in /spawn as task text", () => {
    const parsed = parseSpawnArgs("test the --help output");

    expect(parsed).toEqual({ task: "test the --help output" });
  });

  it("rejects /spawn --bg and points at orchestrate", () => {
    const parsed = parseSpawnArgs("--bg review the auth flow");

    expect(parsed).toEqual({
      error:
        "Background /spawn --bg is not available. Use the orchestrate tool for background work. Usage: /spawn <task> [--model <model>]",
    });
  });

  it("does not produce undefined minion names when config minionNames is empty", () => {
    const cwd = createSettingsCwd({ "pi-minions": { minionNames: [] } });
    const name = pickMinionName(new AgentTree(), "abc123", { cwd } as ExtensionContext);

    expect(name).not.toContain("undefined");
    expect(DEFAULT_MINION_NAMES).toContain(name);
  });

  it("filters memory and recursive minion extensions out of minion sessions", () => {
    expect(shouldLoadExtensionInMinion("/repo/packages/pi-minions/src/index.ts")).toBe(false);
    expect(shouldLoadExtensionInMinion("/repo/packages/pi-om-extension/src/index.ts")).toBe(false);
    expect(shouldLoadExtensionInMinion("/repo/packages/pi-exa-extension/src/index.ts")).toBe(true);
    expect(shouldLoadExtensionInMinion("/repo/packages/pi-beadwork-extension/src/index.ts")).toBe(
      true,
    );
    expect(shouldLoadExtensionInMinion("/repo/packages/pi-hashline-readmap/src/index.ts")).toBe(
      true,
    );
  });
});
