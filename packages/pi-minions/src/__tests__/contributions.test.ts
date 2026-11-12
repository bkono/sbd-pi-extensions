import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverAgents, installDiscoverAgentsOptions } from "../agents.js";
import {
  clearContributions,
  connectContributions,
  MINIONS_CONTRIBUTE_EVENT,
  MINIONS_HELLO_EVENT,
  MINIONS_READY_EVENT,
  type MinionsReadyApi,
} from "../contributions.js";
import { OrchestrationGroupState } from "../orchestration/index.js";
import { computeChildActiveTools, type SubsessionManager } from "../subsessions/manager.js";
import type { MinionSessionHandle } from "../subsessions/types.js";
import { orchestrate } from "../tools/orchestrate.js";
import { AgentTree } from "../tree.js";
import type { OrchestrateResult } from "../types.js";

const dirs: string[] = [];
let restoreDiscovery: (() => void) | undefined;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  const home = tempDir("pi-minions-home-");
  restoreDiscovery = installDiscoverAgentsOptions({ agentDir: join(home, "agent"), homeDir: home });
});

afterEach(() => {
  restoreDiscovery?.();
  clearContributions();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agentFile(dir: string, name: string, frontmatter: string, body = "prompt"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} agent\n${frontmatter}---\n${body}\n`,
  );
}

function tool(name: string): ToolDefinition {
  return { name } as unknown as ToolDefinition;
}

function connect(api: MinionsReadyApi = { liveOrchestrated: () => 0 }) {
  const events = createEventBus();
  connectContributions({ events } as Pick<ExtensionAPI, "events">, api);
  return events;
}

describe("contribution handshake", () => {
  it("delivers the API to a contributor loaded before or after minions", () => {
    const events = createEventBus();
    const early: MinionsReadyApi[] = [];
    events.on(MINIONS_READY_EVENT, (api) => early.push(api as MinionsReadyApi));
    connectContributions({ events } as Pick<ExtensionAPI, "events">, {
      liveOrchestrated: () => 3,
    });
    expect(early.map((api) => api.liveOrchestrated())).toEqual([3]);

    const late: MinionsReadyApi[] = [];
    events.on(MINIONS_READY_EVENT, (api) => late.push(api as MinionsReadyApi));
    events.emit(MINIONS_HELLO_EVENT, undefined);
    expect(late.map((api) => api.liveOrchestrated())).toEqual([3]);
  });

  it("discovers contributed agents above built-ins and below user agents", () => {
    const events = connect();
    const pkg = tempDir("pi-minions-pkg-");
    agentFile(pkg, "reviewer", "mode: plan\npackModel: true\n");
    agentFile(pkg, "worker", "mode: fast\n", "package worker");
    events.emit(MINIONS_CONTRIBUTE_EVENT, { source: "sbd", agentDirs: [pkg] });

    const cwd = tempDir("pi-minions-cwd-");
    const agents = discoverAgents(cwd, "both").agents;
    const reviewer = agents.find((a) => a.name === "reviewer");
    expect(reviewer).toMatchObject({ source: "package", mode: "plan", packModel: true });
    expect(agents.find((a) => a.name === "worker")?.systemPrompt).toBe("package worker");

    agentFile(join(cwd, ".pi", "agents"), "reviewer", "", "project reviewer");
    mkdirSync(join(cwd, ".git"));
    const overridden = discoverAgents(cwd, "both").agents.find((a) => a.name === "reviewer");
    expect(overridden?.source).toBe("project");

    events.emit(MINIONS_CONTRIBUTE_EVENT, { source: "sbd", agentDirs: [] });
    expect(discoverAgents(cwd, "user").agents.some((a) => a.name === "reviewer")).toBe(false);
  });

  it("keeps contributed parent-only tools out of every child's base tools", () => {
    const events = connect();
    events.emit(MINIONS_CONTRIBUTE_EVENT, {
      source: "sbd",
      parentOnlyTools: ["sbd_set_predicate"],
    });
    expect(
      computeChildActiveTools({ parentCodingTools: ["read", "bash", "sbd_set_predicate"] }),
    ).not.toContain("sbd_set_predicate");
    expect(computeChildActiveTools({ roleAllowlist: ["read", "sbd_set_predicate"] })).not.toContain(
      "sbd_set_predicate",
    );
  });
});

function model(provider: string, id: string): Model<Api> {
  return { provider, id, name: id } as Model<Api>;
}

function setupOrchestrate(modes?: Record<string, string>) {
  const cwd = tempDir("pi-minions-cwd-");
  mkdirSync(join(cwd, ".git"));
  if (modes) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-minions": { modes } }));
  }
  const models = [
    model("anthropic", "claude-opus-5-5"),
    model("openai-codex", "gpt-6.1-sol"),
    model("anthropic", "claude-fable-5-2"),
  ];
  const startChild = vi.fn(
    async (opts: { id: string }): Promise<MinionSessionHandle> => ({
      id: opts.id,
      path: join(cwd, `${opts.id}.jsonl`),
      steer: async () => {},
      followUp: async () => {},
      abort: () => {},
      wait: () => new Promise(() => {}),
    }),
  );
  const execute = orchestrate({
    tree: new AgentTree(),
    pi: { getAllTools: () => [{ name: "read" }] } as Pick<ExtensionAPI, "getAllTools">,
    subsessionManager: { startChild } as unknown as Pick<
      SubsessionManager,
      "startChild" | "getSessionHandle" | "abortSession"
    >,
    groups: new OrchestrationGroupState(),
    extraTools: [],
  });
  const ctx = {
    cwd,
    mode: "rpc",
    model: models[0],
    modelRegistry: {
      getAll: () => models,
      find: (provider: string, id: string) =>
        models.find((m) => m.provider === provider && m.id === id),
    },
    sessionManager: { getSessionFile: () => undefined },
    getSystemPrompt: () => "",
  } as unknown as ExtensionContext;
  const run = async (tasks: Array<{ agent?: string; model?: string }>) => {
    const result = await execute(
      "call-1",
      { tasks: tasks.map((t) => ({ task: "do it", description: "d", ...t })) },
      undefined,
      undefined,
      ctx,
    );
    return result.details as OrchestrateResult;
  };
  const started = () =>
    startChild.mock.calls.map(
      (call) =>
        call[0] as unknown as {
          config: { name: string };
          parentModel?: Model<Api>;
          customTools?: ToolDefinition[];
          extraTools?: string[];
        },
    );
  return { cwd, run, started };
}

describe("orchestrate with the model pack and contributed tools", () => {
  const modes = {
    plan: "anthropic/claude-opus-5-5",
    build: "openai-codex/gpt-6.1-sol",
    fast: "anthropic/claude-fable-5-2",
  };

  it("runs agents on their mode's model and pack agents only on theirs", async () => {
    const events = connect();
    const pkg = tempDir("pi-minions-pkg-");
    agentFile(pkg, "verifier", "mode: fast\npackModel: true\nindependent: true\n");
    events.emit(MINIONS_CONTRIBUTE_EVENT, { source: "sbd", agentDirs: [pkg] });
    const { run, started } = setupOrchestrate(modes);

    const result = await run([
      { agent: "worker" },
      { agent: "verifier", model: "anthropic/claude-opus-5-5" },
    ]);
    expect(result.rejected).toEqual([]);
    expect(
      started().map((c) => [c.config.name, `${c.parentModel?.provider}/${c.parentModel?.id}`]),
    ).toEqual([
      ["worker", modes.build],
      ["verifier", modes.fast],
    ]);
  });

  it("rejects a verifier when the pack has no fast model", async () => {
    const events = connect();
    const pkg = tempDir("pi-minions-pkg-");
    agentFile(pkg, "verifier", "mode: fast\npackModel: true\nindependent: true\n");
    events.emit(MINIONS_CONTRIBUTE_EVENT, { source: "sbd", agentDirs: [pkg] });
    const { run, started } = setupOrchestrate({ build: modes.build });

    await expect(run([{ agent: "verifier" }])).rejects.toThrow(
      "verifier runs on the fast model; set pi-minions.modes.fast in settings.json",
    );
    expect(started()).toEqual([]);
  });

  it("injects a contributed tool only into children of its agent", async () => {
    const events = connect();
    const pkg = tempDir("pi-minions-pkg-");
    agentFile(pkg, "verifier", "mode: fast\npackModel: true\ntools: read, bash\n");
    events.emit(MINIONS_CONTRIBUTE_EVENT, {
      source: "sbd",
      agentDirs: [pkg],
      agentTools: { verifier: [tool("sbd_verdict_post")] },
    });
    const { run, started } = setupOrchestrate(modes);

    await run([{ agent: "verifier" }, { agent: "worker" }]);
    const [verifier, worker] = started();
    expect(verifier?.customTools?.map((t) => t.name)).toContain("sbd_verdict_post");
    expect(verifier?.extraTools).toContain("sbd_verdict_post");
    expect(worker?.customTools?.map((t) => t.name)).not.toContain("sbd_verdict_post");
    expect(worker?.extraTools).not.toContain("sbd_verdict_post");
  });
});
