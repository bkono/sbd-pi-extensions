import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUILTIN_AGENTS } from "./builtin-agents.js";
import { logger } from "./logger.js";
import type { AgentConfig, AgentSource, ThinkingLevel } from "./types.js";

export { BUILTIN_AGENTS } from "./builtin-agents.js";

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const COMPLETION_NUDGE_MAX_LENGTH = 500;

function parseCompletionNudge(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.length > COMPLETION_NUDGE_MAX_LENGTH
    ? trimmed.slice(0, COMPLETION_NUDGE_MAX_LENGTH)
    : trimmed;
}

function loadAgentFromFile(
  filePath: string,
  source: AgentSource,
  defaultName: string,
): AgentConfig | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

  if (!frontmatter.description) return null;

  const name = frontmatter.name ?? defaultName;

  const tools = frontmatter.tools
    ?.split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const thinking =
    frontmatter.thinking && THINKING_LEVELS.has(frontmatter.thinking as ThinkingLevel)
      ? (frontmatter.thinking as ThinkingLevel)
      : undefined;

  const steps =
    frontmatter.steps || frontmatter.max_turns
      ? parseInt(frontmatter.steps, 10) || parseInt(frontmatter.max_turns, 10) || undefined
      : undefined;
  const timeout = frontmatter.timeout ? parseInt(frontmatter.timeout, 10) || undefined : undefined;
  const completionNudge = parseCompletionNudge(frontmatter.completion_nudge);

  logger.debug("agents", "loaded", {
    name,
    completionNudgePresent: completionNudge !== undefined,
    completionNudgeLength: completionNudge?.length ?? 0,
  });

  return {
    name,
    displayName: frontmatter.displayName,
    description: frontmatter.description,
    tools: tools && tools.length > 0 ? tools : undefined,
    model: frontmatter.model,
    thinking,
    steps,
    timeout,
    systemPrompt: body.trim(),
    source,
    filePath,
    ...(completionNudge !== undefined ? { completionNudge } : {}),
  };
}

export function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  if (!existsSync(dir)) return [];

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf-8" });
  } catch {
    return [];
  }

  const agentMap = new Map<string, AgentConfig>();

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const agent = loadAgentFromFile(join(dir, entry.name), source, entry.name.replace(/\.md$/, ""));
    if (agent) agentMap.set(agent.name, agent);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const filePath = join(dir, entry.name, "MINION.md");
    let isFile = false;
    try {
      isFile = existsSync(filePath) && statSync(filePath).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;

    const agent = loadAgentFromFile(filePath, source, entry.name);
    if (agent && !agentMap.has(agent.name)) agentMap.set(agent.name, agent);
  }

  return Array.from(agentMap.values());
}

function findProjectDir(cwd: string, ...subpath: string[]): string | null {
  let current = cwd;
  while (true) {
    const candidate = join(current, ...subpath);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;

    // Stop at git root
    if (existsSync(join(current, ".git"))) return null;

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Later layers win. Discovery order is builtin < user < project. */
export function mergeAgentLayers(...layers: AgentConfig[][]): AgentConfig[] {
  const agentMap = new Map<string, AgentConfig>();
  for (const layer of layers) {
    for (const agent of layer) agentMap.set(agent.name, agent);
  }
  return Array.from(agentMap.values());
}

export interface DiscoverAgentsOptions {
  agentDir?: string;
  homeDir?: string;
}

export function unknownAgentMessage(name: string): string {
  return `Unknown agent "${name}". Call list_agents to see discovered agent names.`;
}

export function findAgent(
  name: string,
  cwd: string,
  options?: DiscoverAgentsOptions,
): AgentConfig | undefined {
  return discoverAgents(cwd, "both", options).agents.find((agent) => agent.name === name);
}

export function requireAgent(
  name: string,
  cwd: string,
  options?: DiscoverAgentsOptions,
): AgentConfig {
  const found = findAgent(name, cwd, options);
  if (!found) {
    logger.warn("agents", "agent not found", { requested: name });
    throw new Error(unknownAgentMessage(name));
  }
  return found;
}

export function discoverAgents(
  cwd: string,
  scope: "user" | "project" | "both",
  options: DiscoverAgentsOptions = {},
): { agents: AgentConfig[]; projectAgentsDir: string | null } {
  const agentDir = options.agentDir ?? getAgentDir();
  const home = options.homeDir ?? homedir();

  // Global dirs: ~/.pi/agent/agents/, ~/.pi/agent/minions/, ~/.agents/agents/, ~/.agents/minions/
  const userDir = join(agentDir, "agents");
  const minionsDir = join(agentDir, "minions");
  const dotAgentsUserDir = join(home, ".agents", "agents");
  const dotMinionsUserDir = join(home, ".agents", "minions");

  // Project dirs: .pi/agents/, .agents/agents/ (walk up to git root)
  const piProjectDir = findProjectDir(cwd, ".pi", "agents");
  const piMinionsProjectDir = findProjectDir(cwd, ".pi", "minions");
  const dotAgentsProjectDir = findProjectDir(cwd, ".agents", "agents");
  const dotMinionsProjectDir = findProjectDir(cwd, ".agents", "minions");

  const userAgents =
    scope !== "project"
      ? [
          ...loadAgentsFromDir(userDir, "user"),
          ...loadAgentsFromDir(minionsDir, "user"),
          ...loadAgentsFromDir(dotAgentsUserDir, "user"),
          ...loadAgentsFromDir(dotMinionsUserDir, "user"),
        ]
      : [];

  const projectAgents: AgentConfig[] = [];
  if (scope !== "user") {
    if (piProjectDir) projectAgents.push(...loadAgentsFromDir(piProjectDir, "project"));
    if (piMinionsProjectDir)
      projectAgents.push(...loadAgentsFromDir(piMinionsProjectDir, "project"));
    if (dotAgentsProjectDir)
      projectAgents.push(...loadAgentsFromDir(dotAgentsProjectDir, "project"));
    if (dotMinionsProjectDir)
      projectAgents.push(...loadAgentsFromDir(dotMinionsProjectDir, "project"));
  }

  const projectAgentsDir =
    piProjectDir ?? piMinionsProjectDir ?? dotAgentsProjectDir ?? dotMinionsProjectDir;
  return {
    agents: mergeAgentLayers([...BUILTIN_AGENTS], userAgents, projectAgents),
    projectAgentsDir,
  };
}
