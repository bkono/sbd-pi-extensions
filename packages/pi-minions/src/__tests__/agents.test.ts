import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_AGENTS,
  discoverAgents,
  findAgent,
  loadAgentsFromDir,
  mergeAgentLayers,
  unknownAgentMessage,
} from "../agents.js";
import { logger } from "../logger.js";
import type { AgentConfig } from "../types.js";

const COMPLETION_NUDGE_MAX_LENGTH = 500;

function writeAgentMarkdown(
  dir: string,
  fileName: string,
  frontmatter: string,
  body = "You are an agent.",
): void {
  writeFileSync(join(dir, fileName), `---\n${frontmatter}\n---\n\n${body}\n`, "utf-8");
}

function logNudge(agent: AgentConfig | undefined): void {
  console.log("agent", {
    name: agent?.name,
    completionNudgePresent: agent?.completionNudge !== undefined,
    completionNudgeLength: agent?.completionNudge?.length ?? 0,
  });
}

describe("agent frontmatter completion_nudge", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempAgentsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-minions-agents-"));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("exposes completion_nudge from YAML on AgentConfig", () => {
    const dir = tempAgentsDir();
    const nudge =
      "Assess the feedback against the task and project intent; do not accept findings mechanically.";
    writeAgentMarkdown(
      dir,
      "reviewer.md",
      [
        "name: reviewer",
        "description: Independently review completed work",
        `completion_nudge: ${nudge}`,
      ].join("\n"),
    );

    const debug = vi.spyOn(logger, "debug");
    const [agent] = loadAgentsFromDir(dir, "project");
    logNudge(agent);

    expect(agent).toMatchObject({
      name: "reviewer",
      description: "Independently review completed work",
      completionNudge: nudge,
      source: "project",
    });
    expect(debug).toHaveBeenCalledWith("agents", "loaded", {
      name: "reviewer",
      completionNudgePresent: true,
      completionNudgeLength: nudge.length,
    });
  });

  it("loads an agent without completion_nudge", () => {
    const dir = tempAgentsDir();
    writeAgentMarkdown(
      dir,
      "coder.md",
      ["name: project-specific-role", "description: Project-specific coder"].join("\n"),
    );

    const debug = vi.spyOn(logger, "debug");
    const [agent] = loadAgentsFromDir(dir, "project");
    logNudge(agent);

    expect(agent?.name).toBe("project-specific-role");
    expect(agent).not.toHaveProperty("completionNudge");
    expect(debug).toHaveBeenCalledWith("agents", "loaded", {
      name: "project-specific-role",
      completionNudgePresent: false,
      completionNudgeLength: 0,
    });
  });

  it("treats empty and whitespace completion_nudge as absent", () => {
    const dir = tempAgentsDir();
    writeAgentMarkdown(
      dir,
      "empty.md",
      ["name: empty-nudge", "description: Empty nudge", 'completion_nudge: ""'].join("\n"),
    );
    writeAgentMarkdown(
      dir,
      "whitespace.md",
      ["name: whitespace-nudge", "description: Whitespace nudge", 'completion_nudge: "   "'].join(
        "\n",
      ),
    );

    const agents = loadAgentsFromDir(dir, "project");
    const empty = agents.find((a) => a.name === "empty-nudge");
    const whitespace = agents.find((a) => a.name === "whitespace-nudge");
    logNudge(empty);
    logNudge(whitespace);

    expect(empty).toBeDefined();
    expect(whitespace).toBeDefined();
    expect(empty).not.toHaveProperty("completionNudge");
    expect(whitespace).not.toHaveProperty("completionNudge");
  });

  it("truncates an oversized completion_nudge and still loads", () => {
    const dir = tempAgentsDir();
    const oversized = "x".repeat(COMPLETION_NUDGE_MAX_LENGTH + 80);
    writeAgentMarkdown(
      dir,
      "verbose.md",
      [
        "name: verbose-reviewer",
        "description: Reviewer with a long nudge",
        `completion_nudge: "${oversized}"`,
      ].join("\n"),
    );

    const debug = vi.spyOn(logger, "debug");
    const [agent] = loadAgentsFromDir(dir, "project");
    logNudge(agent);

    expect(agent?.name).toBe("verbose-reviewer");
    expect(agent?.completionNudge).toBe("x".repeat(COMPLETION_NUDGE_MAX_LENGTH));
    expect(agent?.completionNudge).toHaveLength(COMPLETION_NUDGE_MAX_LENGTH);
    expect(debug).toHaveBeenCalledWith("agents", "loaded", {
      name: "verbose-reviewer",
      completionNudgePresent: true,
      completionNudgeLength: COMPLETION_NUDGE_MAX_LENGTH,
    });
  });
});

describe("builtin agents", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function isolatedCwd(): string {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-builtin-"));
    dirs.push(cwd);
    return cwd;
  }

  it("exposes worker and investigate without filesystem setup", () => {
    expect(BUILTIN_AGENTS.map((a) => a.name).sort()).toEqual(["investigate", "worker"]);
    expect(BUILTIN_AGENTS.every((a) => a.source === "builtin")).toBe(true);
    expect(BUILTIN_AGENTS.every((a) => a.filePath === "")).toBe(true);
    expect(BUILTIN_AGENTS.every((a) => a.model === undefined)).toBe(true);

    const emptyHome = isolatedCwd();
    const emptyAgentDir = isolatedCwd();
    const cwd = isolatedCwd();
    const { agents } = discoverAgents(cwd, "both", {
      agentDir: emptyAgentDir,
      homeDir: emptyHome,
    });
    const worker = agents.find((a) => a.name === "worker");
    const investigate = agents.find((a) => a.name === "investigate");
    expect(worker?.source).toBe("builtin");
    expect(worker?.thinking).toBe("medium");
    expect(investigate?.source).toBe("builtin");
    expect(investigate?.thinking).toBe("high");
  });

  it("uses project then user then builtin precedence", () => {
    const builtinWorker = BUILTIN_AGENTS.find((a) => a.name === "worker");
    if (!builtinWorker) throw new Error("missing builtin worker");
    const userWorker: AgentConfig = {
      ...builtinWorker,
      description: "user worker",
      source: "user",
      filePath: "/user/worker.md",
    };
    const projectWorker: AgentConfig = {
      ...builtinWorker,
      description: "project worker",
      source: "project",
      filePath: "/project/worker.md",
    };

    expect(
      mergeAgentLayers([...BUILTIN_AGENTS], [userWorker]).find((a) => a.name === "worker")?.source,
    ).toBe("user");
    expect(
      mergeAgentLayers([...BUILTIN_AGENTS], [userWorker], [projectWorker]).find(
        (a) => a.name === "worker",
      )?.source,
    ).toBe("project");

    const emptyHome = isolatedCwd();
    const emptyAgentDir = isolatedCwd();
    const cwd = isolatedCwd();
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "worker.md"),
      [
        "---",
        "name: worker",
        "description: project override",
        "---",
        "Project worker prompt.",
      ].join("\n"),
    );
    const found = findAgent("worker", cwd, { agentDir: emptyAgentDir, homeDir: emptyHome });
    expect(found?.source).toBe("project");
    expect(found?.description).toBe("project override");
    expect(found?.systemPrompt).toContain("Project worker prompt.");
  });

  it("keeps worker implementation-oriented and investigate mutation-gated", () => {
    const worker = BUILTIN_AGENTS.find((a) => a.name === "worker");
    const investigate = BUILTIN_AGENTS.find((a) => a.name === "investigate");
    if (!worker || !investigate) throw new Error("missing builtins");

    expect(worker.systemPrompt).toMatch(/implement the assigned task end to end/i);
    expect(worker.systemPrompt).toMatch(/follow existing repository patterns/i);
    expect(worker.systemPrompt).toMatch(/unrelated cleanup/i);
    expect(worker.systemPrompt).toMatch(/## Validation/);
    expect(worker.systemPrompt).toMatch(/## Risks/);
    expect(worker.systemPrompt).not.toMatch(/do not modify project files/i);

    expect(investigate.systemPrompt).toMatch(
      /do not modify project files unless the complete task explicitly requests implementation/i,
    );
    expect(investigate.systemPrompt).toMatch(
      /do not silently turn investigation into implementation/i,
    );
    expect(investigate.systemPrompt).toMatch(/## Evidence/);
    expect(investigate.systemPrompt).toMatch(/## Uncertainty/);
    expect(investigate.systemPrompt).not.toMatch(/implement the assigned task end to end/i);
  });

  it("names the unknown agent and points at list_agents, not taskType", () => {
    const message = unknownAgentMessage("not-a-real-agent");
    expect(message).toContain('"not-a-real-agent"');
    expect(message).toContain("list_agents");
    expect(message.toLowerCase()).not.toContain("tasktype");
    expect(message).not.toContain("implementation");
    expect(message).not.toContain("investigateBlocker");
  });
});
