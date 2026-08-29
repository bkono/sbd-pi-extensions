import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { BEADWORK_ALIAS_COMMANDS } from "../../command-aliases.js";
import { createBeadworkCommandCompletionFactory } from "../../command-completions.js";
import type { BeadworkIssue } from "../../types.js";

function issue(overrides: Partial<BeadworkIssue>): BeadworkIssue {
  return {
    id: "BW-100",
    title: "Epic",
    description: "",
    status: "open",
    type: "epic",
    priority: 1,
    labels: [],
    blockedBy: [],
    blocks: [],
    assignee: "",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

const REJECTED_RUN_FLAGS = [
  "--workers",
  "--until",
  "--max-cycles",
  "--maxCycles",
  "--no-spawn",
  "--noSpawn",
  "--dry-run",
  "--dryRun",
];

const REMOVED_WORKER_COMMANDS = ["workers", "delegate", "land", "cancel", "cleanup"] as const;

describe("beadwork command completions", () => {
  it("suggests subcommands for the main /bw command", async () => {
    const completions = createBeadworkCommandCompletionFactory({
      adapter: {
        ready: vi.fn(),
        list: vi.fn(),
      },
      detectActivation: vi.fn(),
      getCwd: () => "/repo",
    });

    const items = await completions.getMainCommandCompletions("de");
    expect(items?.map((item) => item.value)).toEqual(expect.arrayContaining(["dep", "defer"]));
    expect(items?.map((item) => item.value)).not.toContain("delegate");
    expect(items?.map((item) => item.value)).not.toContain("run");
  });

  it("does not complete leftover worker subcommands", async () => {
    const completions = createBeadworkCommandCompletionFactory({
      adapter: {
        ready: vi.fn(),
        list: vi.fn(),
      },
      detectActivation: vi.fn(),
      getCwd: () => "/repo",
    });

    const items = await completions.getMainCommandCompletions("");
    const values = items?.map((item) => item.value) ?? [];
    for (const command of REMOVED_WORKER_COMMANDS) {
      expect(values).not.toContain(command);
      expect(await completions.getMainCommandCompletions(command)).toBeNull();
    }
  });

  it("offers only epic ids for /bw run completions", async () => {
    const adapter = {
      ready: vi.fn(),
      list: vi
        .fn()
        .mockResolvedValue([
          issue({ id: "BW-100", title: "Epic", type: "epic" }),
          issue({ id: "BW-101", title: "Task", type: "task" }),
        ]),
    };
    const completions = createBeadworkCommandCompletionFactory({
      adapter,
      detectActivation: vi.fn().mockResolvedValue({ kind: "active", repoRoot: "/repo" }),
      getCwd: () => "/repo",
    });

    const aliasItems = await completions.getAliasCommandCompletions("run", "BW-");
    const mainItems = await completions.getMainCommandCompletions("run BW-");

    expect(aliasItems).toEqual([
      {
        value: "BW-100",
        label: "BW-100 · epic",
        description: "Epic",
      },
    ]);
    expect(mainItems).toEqual(aliasItems);
    expect(aliasItems?.map((item) => item.value)).not.toContain("BW-101");
  });

  it("does not offer supervisor flags for /bw run", async () => {
    const completions = createBeadworkCommandCompletionFactory({
      adapter: {
        ready: vi.fn(),
        list: vi.fn(),
      },
      detectActivation: vi.fn().mockResolvedValue({ kind: "active", repoRoot: "/repo" }),
      getCwd: () => "/repo",
    });

    expect(await completions.getAliasCommandCompletions("run", "--")).toBeNull();
    expect(await completions.getMainCommandCompletions("run --")).toBeNull();

    for (const flag of REJECTED_RUN_FLAGS) {
      expect(await completions.getAliasCommandCompletions("run", flag)).toBeNull();
      expect(await completions.getMainCommandCompletions(`run ${flag}`)).toBeNull();
    }
  });

  it("offers /bw abandon with no arguments", async () => {
    const abandonAlias = BEADWORK_ALIAS_COMMANDS.find((alias) => alias.subcommand === "abandon");
    expect(abandonAlias?.name).toBe("bw:abandon");
    expect(abandonAlias?.description).toBe("Exit goal mode and halt the minion group");

    const completions = createBeadworkCommandCompletionFactory({
      adapter: {
        ready: vi.fn(),
        list: vi.fn(),
      },
      detectActivation: vi.fn(),
      getCwd: () => "/repo",
    });
    const items = await completions.getMainCommandCompletions("ab");
    const abandon = items?.find((item) => item.value === "abandon");
    expect(abandon?.description).toBe("Exit goal mode and halt the minion group");
    expect(await completions.getAliasCommandCompletions("abandon", "")).toBeNull();
    expect(await completions.getAliasCommandCompletions("abandon", "--")).toBeNull();
  });

  it("describes /bw run as goal mode, not a bounded epic loop", async () => {
    const runAlias = BEADWORK_ALIAS_COMMANDS.find((alias) => alias.subcommand === "run");
    expect(runAlias?.description).toBe("Start goal mode for an epic");
    expect(runAlias?.description).not.toMatch(/bounded epic loop|tmux|workers/i);

    const completions = createBeadworkCommandCompletionFactory({
      adapter: {
        ready: vi.fn(),
        list: vi.fn(),
      },
      detectActivation: vi.fn(),
      getCwd: () => "/repo",
    });
    const items = await completions.getMainCommandCompletions("run");
    const run = items?.find((item) => item.value === "run");
    expect(run?.description).toBe("Start goal mode for an epic");
    expect(run?.description).not.toMatch(/bounded epic loop|tmux|workers/i);
  });

  it("drops leftover worker aliases and supervisor flags from CLI copy", async () => {
    const aliases = await readFile(new URL("../../command-aliases.ts", import.meta.url), "utf8");
    const completions = await readFile(
      new URL("../../command-completions.ts", import.meta.url),
      "utf8",
    );
    const index = await readFile(new URL("../../index.ts", import.meta.url), "utf8");

    for (const source of [aliases, completions, index]) {
      expect(source).not.toContain("bounded epic loop");
    }

    for (const command of REMOVED_WORKER_COMMANDS) {
      expect(aliases).not.toContain(`name: "bw:${command}"`);
      expect(aliases).not.toContain(`subcommand: "${command}"`);
      expect(completions).not.toContain(`value: "${command}"`);
    }

    expect(completions).not.toContain('value: "--workers"');
    expect(completions).not.toContain('value: "--until"');
    expect(completions).not.toContain('value: "--max-cycles"');
    expect(completions).not.toContain('value: "--dry-run"');
    expect(completions).not.toContain('value: "--no-spawn"');
    expect(completions).not.toContain('value: "--stop-workers"');
    expect(completions).not.toContain('value: "--all-workers"');
    expect(completions).not.toContain('value: "--leave-workers"');

    expect(index).toContain("run <epic-id>");
    expect(index).toContain("|abandon|");
    expect(index).not.toMatch(/run <epic-id> \[--workers/);
    expect(index).not.toMatch(/run <epic-id> \[--until/);
    expect(index).not.toMatch(/run <epic-id> \[--max-cycles/);
    expect(index).not.toMatch(/run <epic-id> \[--dry-run/);
    expect(index).not.toMatch(/run <epic-id> \[--no-spawn/);
    expect(index).not.toContain("workers [epic-id]");
    expect(index).not.toContain("delegate <ticket-id>");
    expect(index).not.toContain("land <ticket-id");
    expect(index).not.toContain("cancel <ticket-id");
    expect(index).not.toContain("cleanup <ticket-id");
    expect(index).not.toContain("--stop-workers");
    expect(index).not.toContain("--all-workers");
    expect(index).not.toContain("--leave-workers");
    expect(index).not.toContain("session/worker commands");
  });
});
