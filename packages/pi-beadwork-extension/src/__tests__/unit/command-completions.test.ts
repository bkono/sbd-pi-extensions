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
    expect(abandon?.value).toBe("abandon");
    expect(await completions.getAliasCommandCompletions("abandon", "")).toBeNull();
    expect(await completions.getAliasCommandCompletions("abandon", "--")).toBeNull();
  });
});
