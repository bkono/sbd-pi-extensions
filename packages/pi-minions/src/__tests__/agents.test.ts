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

  it("includes the unresolved agent identity in diagnostics", () => {
    const message = unknownAgentMessage("not-a-real-agent");
    expect(message).toContain("not-a-real-agent");
  });
});

describe("agent field inheritance across layers", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-minions-inherit-"));
    dirs.push(dir);
    return dir;
  }

  function writeRaw(dir: string, fileName: string, content: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), content, "utf-8");
  }

  /** A lower-layer agent that sets every field, so inheritance of each one is observable. */
  const packageReviewer: AgentConfig = {
    name: "reviewer",
    displayName: "Reviewer",
    description: "Independently review completed work",
    tools: ["read", "grep"],
    model: "anthropic/claude-sonnet-5-5",
    mode: "plan",
    packModel: true,
    independent: true,
    thinking: "high",
    steps: 40,
    timeout: 600,
    systemPrompt: "You are the package reviewer.",
    source: "package",
    filePath: "/pkg/agents/reviewer.md",
    completionNudge: "Assess the feedback; do not accept it mechanically.",
  };

  function overlay(content: string, base: AgentConfig = packageReviewer): AgentConfig | undefined {
    const dir = tempDir();
    writeRaw(dir, "reviewer.md", content);
    return mergeAgentLayers([base], loadAgentsFromDir(dir, "project")).find(
      (a) => a.name === "reviewer",
    );
  }

  it("inherits every omitted field and changes only the model", () => {
    const merged = overlay(
      "---\ndescription: Independently review completed work\nmodel: openai/gpt-6.1-sol\n---\n",
    );

    expect(merged).toEqual({
      ...packageReviewer,
      model: "openai/gpt-6.1-sol",
      source: "project",
      filePath: expect.stringMatching(/reviewer\.md$/),
    });
  });

  it("inherits the description when the override omits it", () => {
    const merged = overlay("---\nmodel: openai/gpt-6.1-sol\n---\n");
    expect(merged?.description).toBe(packageReviewer.description);
    expect(merged?.systemPrompt).toBe(packageReviewer.systemPrompt);
    expect(merged?.source).toBe("project");
  });

  it("drops a description-less file that has no lower-layer agent to inherit from", () => {
    const dir = tempDir();
    writeRaw(dir, "orphan.md", "---\nmodel: openai/gpt-6.1-sol\n---\nBody.\n");
    const merged = mergeAgentLayers([...BUILTIN_AGENTS], loadAgentsFromDir(dir, "project"));
    expect(merged.find((a) => a.name === "orphan")).toBeUndefined();
  });

  it("does not treat a frontmatter-less file as an override", () => {
    const merged = overlay("Just a body, no frontmatter.\n");
    expect(merged).toEqual(packageReviewer);
  });

  it.each([
    ["packModel", "packModel: false"],
    ["packModel", "pack_model: false"],
    ["packModel", 'packModel: "false"'],
    ["independent", "independent: false"],
    ["independent", "independent: no"],
  ] as const)("an explicit false %s (%s) overrides an inherited true", (field, line) => {
    const merged = overlay(`---\nmodel: openai/gpt-6.1-sol\n${line}\n---\n`);
    expect(merged).toBeDefined();
    expect(merged?.[field]).toBeFalsy();
    expect(merged).not.toHaveProperty(field);
    const other = field === "packModel" ? "independent" : "packModel";
    expect(merged?.[other]).toBe(true);
  });

  it("an explicit true overrides an inherited absence", () => {
    const { packModel: _p, independent: _i, ...plain } = packageReviewer;
    const merged = overlay("---\npackModel: true\nindependent: true\n---\n", plain);
    expect(merged?.packModel).toBe(true);
    expect(merged?.independent).toBe(true);
  });

  it("a file with its own body replaces the inherited body", () => {
    const merged = overlay("---\nmodel: openai/gpt-6.1-sol\n---\n\nProject reviewer prompt.\n");
    expect(merged?.systemPrompt).toBe("Project reviewer prompt.");
    expect(merged?.mode).toBe("plan");
  });

  it("a complete redefinition matches loading the file on its own", () => {
    const dir = tempDir();
    writeRaw(
      dir,
      "reviewer.md",
      [
        "---",
        "name: reviewer",
        "displayName: Project Reviewer",
        "description: Project reviewer",
        "tools: read, bash",
        "model: openai/gpt-6.1-sol",
        "mode: build",
        "packModel: true",
        "independent: true",
        "thinking: low",
        "steps: 7",
        "timeout: 90",
        "completion_nudge: Project nudge.",
        "---",
        "",
        "Project reviewer prompt.",
      ].join("\n"),
    );
    const [standalone] = loadAgentsFromDir(dir, "project");
    const merged = mergeAgentLayers([packageReviewer], loadAgentsFromDir(dir, "project")).find(
      (a) => a.name === "reviewer",
    );

    expect(merged).toEqual(standalone);
    expect(merged).toEqual({
      name: "reviewer",
      displayName: "Project Reviewer",
      description: "Project reviewer",
      tools: ["read", "bash"],
      model: "openai/gpt-6.1-sol",
      mode: "build",
      packModel: true,
      independent: true,
      thinking: "low",
      steps: 7,
      timeout: 90,
      systemPrompt: "Project reviewer prompt.",
      source: "project",
      filePath: join(dir, "reviewer.md"),
      completionNudge: "Project nudge.",
    });
  });

  it("discovery inherits builtin fields for a project .agents/minions model-only override", () => {
    const home = tempDir();
    const agentDir = tempDir();
    const cwd = tempDir();
    mkdirSync(join(cwd, ".git"));
    writeRaw(
      join(cwd, ".agents", "minions"),
      "investigate.md",
      "---\ndescription: Investigate on Sol\nmodel: openai/gpt-6.1-sol\n---\n",
    );
    const builtin = BUILTIN_AGENTS.find((a) => a.name === "investigate");
    const found = findAgent("investigate", cwd, { agentDir, homeDir: home });

    expect(found).toMatchObject({
      description: "Investigate on Sol",
      model: "openai/gpt-6.1-sol",
      mode: builtin?.mode,
      thinking: builtin?.thinking,
      systemPrompt: builtin?.systemPrompt,
      source: "project",
    });
  });

  it("a partial <name>.md layers over its sibling <name>/MINION.md in the same directory", () => {
    const dir = tempDir();
    writeRaw(dir, "rev.md", "---\nmodel: openai/gpt-6.1-sol\n---\n");
    writeRaw(
      join(dir, "rev"),
      "MINION.md",
      "---\ndescription: Full rev\nmode: plan\n---\nRev body.\n",
    );
    const merged = mergeAgentLayers(loadAgentsFromDir(dir, "project"));

    expect(merged).toEqual([
      expect.objectContaining({
        name: "rev",
        description: "Full rev",
        mode: "plan",
        model: "openai/gpt-6.1-sol",
        systemPrompt: "Rev body.",
        filePath: join(dir, "rev.md"),
      }),
    ]);
  });

  it("two same-named .md files in one directory layer in sorted order", () => {
    const dir = tempDir();
    writeRaw(dir, "b.md", "---\nname: custom\nmodel: openai/gpt-6.1-sol\n---\n");
    writeRaw(dir, "a.md", "---\nname: custom\ndescription: Custom\n---\nCustom body.\n");
    const merged = mergeAgentLayers(loadAgentsFromDir(dir, "project"));

    expect(merged).toEqual([
      expect.objectContaining({
        name: "custom",
        description: "Custom",
        model: "openai/gpt-6.1-sol",
        systemPrompt: "Custom body.",
        filePath: join(dir, "b.md"),
      }),
    ]);
  });

  it("rejects frontmatter that is not a mapping", () => {
    const merged = overlay("---\njust text\n---\nScalar body.\n");
    expect(merged).toEqual(packageReviewer);
  });

  it("an empty frontmatter fence is a body-only override", () => {
    const merged = overlay("---\n---\nFenced body.\n");
    expect(merged).toEqual({
      ...packageReviewer,
      systemPrompt: "Fenced body.",
      source: "project",
      filePath: expect.stringMatching(/reviewer\.md$/),
    });
  });

  it("parses numeric 0/1 booleans", () => {
    const merged = overlay("---\npackModel: 0\nindependent: 1\n---\n");
    expect(merged).not.toHaveProperty("packModel");
    expect(merged?.independent).toBe(true);
  });

  it("chains two directories within the user layer in discovery order", () => {
    const home = tempDir();
    const agentDir = tempDir();
    const cwd = tempDir();
    mkdirSync(join(cwd, ".git"));
    writeRaw(join(agentDir, "agents"), "worker.md", "---\nsteps: 9\n---\n\nPi worker prompt.\n");
    writeRaw(join(home, ".agents", "minions"), "worker.md", "---\nthinking: low\n---\n");
    const found = findAgent("worker", cwd, { agentDir, homeDir: home });

    expect(found).toMatchObject({
      steps: 9,
      thinking: "low",
      mode: "build",
      systemPrompt: "Pi worker prompt.",
      filePath: join(home, ".agents", "minions", "worker.md"),
    });
  });

  it("chains inheritance through user then project layers", () => {
    const home = tempDir();
    const agentDir = tempDir();
    const cwd = tempDir();
    mkdirSync(join(cwd, ".git"));
    writeRaw(
      join(home, ".agents", "minions"),
      "worker.md",
      "---\nthinking: xhigh\nsteps: 12\n---\n\nUser worker prompt.\n",
    );
    writeRaw(join(cwd, ".pi", "minions"), "worker.md", "---\nmodel: openai/gpt-6.1-sol\n---\n");
    const found = findAgent("worker", cwd, { agentDir, homeDir: home });

    expect(found).toMatchObject({
      description: BUILTIN_AGENTS.find((a) => a.name === "worker")?.description,
      mode: "build",
      thinking: "xhigh",
      steps: 12,
      model: "openai/gpt-6.1-sol",
      systemPrompt: "User worker prompt.",
      source: "project",
    });
  });
});

describe("agent frontmatter robustness", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-minions-yaml-"));
    dirs.push(dir);
    return dir;
  }

  it.each([
    ["a YAML list", "tools: [read, bash]"],
    ["a block list", "tools:\n  - read\n  - bash"],
    ["a quoted bracket string", 'tools: "[read, bash]"'],
    ["a comma string", "tools: read, bash"],
  ])("parses tools written as %s", (_label, line) => {
    const dir = tempDir();
    writeAgentMarkdown(dir, "lister.md", `description: Lister\n${line}`);
    const [agent] = loadAgentsFromDir(dir, "project");
    expect(agent?.tools).toEqual(["read", "bash"]);
  });

  it("skips a file with invalid YAML, warns, and keeps its siblings", () => {
    const dir = tempDir();
    writeAgentMarkdown(dir, "bad.md", "description: [unclosed");
    writeAgentMarkdown(dir, "good.md", "description: Good");
    const warn = vi.spyOn(logger, "warn");

    const agents = loadAgentsFromDir(dir, "project");

    expect(agents.map((a) => a.name)).toEqual(["good"]);
    expect(warn).toHaveBeenCalledWith(
      "agents",
      "invalid frontmatter",
      expect.objectContaining({ filePath: join(dir, "bad.md") }),
    );
  });

  it("an invalid higher-layer file leaves discovery working and the lower agent in place", () => {
    const home = tempDir();
    const agentDir = tempDir();
    const cwd = tempDir();
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeAgentMarkdown(join(cwd, ".pi", "agents"), "worker.md", "model: [oops");
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    const found = findAgent("worker", cwd, { agentDir, homeDir: home });

    expect(found?.source).toBe("builtin");
  });

  it("coerces scalar values in string fields to strings", () => {
    const dir = tempDir();
    writeAgentMarkdown(dir, "year.md", "name: 2024\ndescription: 2024\ndisplayName: true");
    const [agent] = loadAgentsFromDir(dir, "project");
    expect(agent).toMatchObject({ name: "2024", description: "2024", displayName: "true" });
  });

  it("truncates numeric steps and timeout like parseInt", () => {
    const dir = tempDir();
    writeAgentMarkdown(dir, "nums.md", "description: Nums\nsteps: 10.7\ntimeout: 2.5");
    const [agent] = loadAgentsFromDir(dir, "project");
    expect(agent).toMatchObject({ steps: 10, timeout: 2 });
  });

  it("warns when two files in one directory define the same agent name", () => {
    const dir = tempDir();
    writeAgentMarkdown(dir, "a.md", "name: custom\ndescription: From a");
    writeAgentMarkdown(dir, "b.md", "name: custom\ndescription: From b");
    mkdirSync(join(dir, "custom"));
    writeAgentMarkdown(join(dir, "custom"), "MINION.md", "description: From minion");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const [agent] = mergeAgentLayers(loadAgentsFromDir(dir, "project"));

    expect(agent?.description).toBe("From b");
    expect(warn).toHaveBeenCalledWith("agents", "same agent name in one directory", {
      name: "custom",
      dir,
      files: [join(dir, "custom", "MINION.md"), join(dir, "a.md"), join(dir, "b.md")],
    });
  });

  it("ignores non-string values for string fields", () => {
    const dir = tempDir();
    writeAgentMarkdown(dir, "typed.md", "description: Typed\nmodel: [a, b]\ndisplayName: {x: 1}");
    const [agent] = loadAgentsFromDir(dir, "project");
    expect(agent).toMatchObject({ name: "typed", description: "Typed" });
    expect(agent).not.toHaveProperty("model");
    expect(agent).not.toHaveProperty("displayName");
  });
});
