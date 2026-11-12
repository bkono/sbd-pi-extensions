import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_CONTINUATIONS } from "../gate.js";
import sbdWorkflow, {
  AGENTS_DIR,
  GATE_MESSAGE,
  GOAL_ENTRY,
  ROUTER_SECTION,
  SET_PREDICATE_TOOL,
  SOURCE,
  VERDICT_POST_TOOL,
} from "../index.js";
import { cleanupTempDirs, commit, git, makeRepo, tempDir, worktreeAt } from "./git-fixture.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.SBD_VERDICT_HOME;
  process.env.SBD_VERDICT_HOME = tempDir("sbd-verdicts-");
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.SBD_VERDICT_HOME;
  else process.env.SBD_VERDICT_HOME = previousHome;
  cleanupTempDirs();
});

function harness(options: { live?: () => number; branch?: unknown[] } = {}) {
  const events = createEventBus();
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const contributions: unknown[] = [];
  events.on("pi-minions:contribute", (data) => contributions.push(data));
  events.on("pi-minions:hello", () =>
    events.emit("pi-minions:ready", { liveOrchestrated: options.live ?? (() => 0) }),
  );
  const pi = {
    events,
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
  } as unknown as ExtensionAPI;
  sbdWorkflow(pi);

  const ctxFor = (cwd: string) =>
    ({
      cwd,
      model: { provider: "anthropic", id: "claude-fable-5-2" },
      sessionManager: { getBranch: () => options.branch ?? [] },
    }) as unknown as ExtensionContext;
  const fire = async (name: string, event: unknown, cwd: string) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctxFor(cwd));
    return result;
  };
  const callTool = (tool: ToolDefinition, params: unknown, cwd: string) =>
    tool.execute("call", params as never, undefined, undefined, ctxFor(cwd));
  const settle = (cwd: string) =>
    fire("agent_before_settle", { type: "agent_before_settle", entries: [] }, cwd) as Promise<
      { continue?: boolean; entries?: Array<{ customType: string; content: string }> } | undefined
    >;
  return { tools, entries, contributions, fire, callTool, settle, ctxFor };
}

function verifierTool(contributions: unknown[]): ToolDefinition {
  const last = contributions.at(-1) as { agentTools: Record<string, ToolDefinition[]> };
  const tool = last.agentTools.verifier?.[0];
  if (!tool) throw new Error("no verifier tool contributed");
  return tool;
}

describe("pi-sbd-workflow", () => {
  it("contributes its agents, the verifier-only post tool and a parent-only predicate tool", () => {
    const h = harness();
    expect(h.contributions).toEqual([
      {
        source: SOURCE,
        agentDirs: [AGENTS_DIR],
        agentTools: { verifier: [expect.objectContaining({ name: VERDICT_POST_TOOL })] },
        parentOnlyTools: [SET_PREDICATE_TOOL],
      },
    ]);
    for (const agent of ["sbd-worker", "verifier", "reviewer"]) {
      expect(existsSync(join(AGENTS_DIR, `${agent}.md`))).toBe(true);
    }
    expect(h.tools.has(VERDICT_POST_TOOL)).toBe(false);
    expect(h.tools.has(SET_PREDICATE_TOOL)).toBe(true);
  });

  it("holds settle until new commits carry a passing verdict, then clears the goal", async () => {
    const repo = makeRepo();
    const h = harness();
    const setPredicate = h.tools.get(SET_PREDICATE_TOOL);
    if (!setPredicate) throw new Error("missing tool");
    await h.callTool(setPredicate, { predicate: "a.txt says two" }, repo);
    expect(await h.settle(repo)).toBeUndefined();

    const sha = commit(repo, "a.txt", "two\n");
    const held = await h.settle(repo);
    expect(held?.continue).toBe(true);
    expect(held?.entries?.[0]?.customType).toBe(GATE_MESSAGE);
    expect(held?.entries?.[0]?.content).toContain(`no passing verdict for ${sha}`);

    const wt = worktreeAt(repo, sha);
    const post = verifierTool(h.contributions);
    await h.callTool(post, { sha, verdict: "PASS", worktree: wt, summary: "ran it" }, wt);
    expect(await h.settle(repo)).toBeUndefined();
    expect(h.entries.at(-1)).toEqual({ customType: GOAL_ENTRY, data: null });

    commit(repo, "a.txt", "three\n");
    expect(await h.settle(repo)).toBeUndefined();
  });

  it("refuses a verdict posted from the main checkout", async () => {
    const repo = makeRepo();
    const h = harness();
    const sha = commit(repo, "a.txt", "two\n");
    const post = verifierTool(h.contributions);
    await expect(
      h.callTool(post, { sha, verdict: "PASS", worktree: repo, summary: "ran it" }, repo),
    ).rejects.toThrow("linked worktree");
  });

  it("lets the lead yield while minions run, and gives up after the cap", async () => {
    const repo = makeRepo();
    let live = 1;
    const h = harness({ live: () => live });
    const setPredicate = h.tools.get(SET_PREDICATE_TOOL);
    if (!setPredicate) throw new Error("missing tool");
    await h.callTool(setPredicate, { predicate: "p" }, repo);
    commit(repo, "a.txt", "two\n");

    expect(await h.settle(repo)).toBeUndefined();
    live = 0;
    for (let i = 0; i < MAX_CONTINUATIONS; i++) expect((await h.settle(repo))?.continue).toBe(true);
    const last = await h.settle(repo);
    expect(last?.continue).toBe(false);
    expect(last?.entries?.[0]?.content).toContain("Done is not claimed");
    expect(await h.settle(repo)).toBeUndefined();
  });

  it("resets the continuation count when the user speaks", async () => {
    const repo = makeRepo();
    const h = harness();
    const setPredicate = h.tools.get(SET_PREDICATE_TOOL);
    if (!setPredicate) throw new Error("missing tool");
    await h.callTool(setPredicate, { predicate: "p" }, repo);
    commit(repo, "a.txt", "two\n");
    for (let i = 0; i < MAX_CONTINUATIONS; i++) await h.settle(repo);
    await h.fire("input", { type: "input", text: "keep going", source: "interactive" }, repo);
    expect((await h.settle(repo))?.continue).toBe(true);
  });

  it("restores the goal from the session branch", async () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const h = harness({
      branch: [
        {
          type: "custom",
          customType: GOAL_ENTRY,
          data: { predicate: "p", repos: [{ root: repo, base }] },
        },
      ],
    });
    await h.fire("session_start", { type: "session_start" }, repo);
    commit(repo, "a.txt", "two\n");
    expect((await h.settle(repo))?.continue).toBe(true);
  });

  it("blocks merges always and ready until HEAD has a passing verdict", async () => {
    const repo = makeRepo();
    const h = harness();
    const call = (command: string) =>
      h.fire(
        "tool_call",
        { type: "tool_call", toolName: "bash", input: { command } },
        repo,
      ) as Promise<{ block?: boolean; reason?: string } | undefined>;
    expect(await call("gh pr merge 12 --squash")).toMatchObject({ block: true });
    expect(await call("cd x && gh pr ready 12")).toMatchObject({
      block: true,
      reason: expect.stringContaining("no passing independent verdict"),
    });
    const sha = git(repo, "rev-parse", "HEAD");
    const wt = worktreeAt(repo, sha);
    await h.callTool(
      verifierTool(h.contributions),
      { sha, verdict: "PASS", worktree: wt, summary: "ran it" },
      wt,
    );
    expect(await call("gh pr ready 12")).toBeUndefined();
    expect(await call("git status")).toBeUndefined();
  });

  it("tells every session where the hidden router and its leaves are", async () => {
    const h = harness();
    const skillsDir = tempDir("sbd-skills-");
    const router = {
      name: "sbd",
      filePath: join(skillsDir, "sbd", "SKILL.md"),
      baseDir: join(skillsDir, "sbd"),
      disableModelInvocation: true,
    } as Skill;
    const event = {
      systemPromptOptions: { skills: [router], sections: {} as Record<string, string> },
    };
    await h.fire("before_agent_start", event, skillsDir);
    expect(event.systemPromptOptions.sections[ROUTER_SECTION]).toContain(router.filePath);
    expect(event.systemPromptOptions.sections[ROUTER_SECTION]).toContain(
      join(skillsDir, "principle-<title>", "SKILL.md"),
    );

    const none = { systemPromptOptions: { skills: [], sections: {} as Record<string, string> } };
    await h.fire("before_agent_start", none, skillsDir);
    expect(none.systemPromptOptions.sections).toEqual({});
  });
});
