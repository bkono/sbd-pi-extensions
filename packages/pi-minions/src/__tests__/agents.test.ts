import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgentsFromDir } from "../agents.js";
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
