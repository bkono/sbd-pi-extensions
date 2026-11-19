import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUILTIN_AGENTS } from "./builtin-agents.js";
import { contributedAgentDirs } from "./contributions.js";
import { logger } from "./logger.js";
import { AGENT_MODES } from "./model-policy.js";
import type { AgentConfig, AgentMode, AgentSource, ThinkingLevel } from "./types.js";

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

/** Tri-state so an explicit `false` can override an inherited `true`. */
function parseBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value !== "string") return undefined;
  if (/^(true|yes|1)$/iu.test(value)) return true;
  if (/^(false|no|0)$/iu.test(value)) return false;
  return undefined;
}

function parseMode(value: unknown): AgentMode | undefined {
  return typeof value === "string" && (AGENT_MODES as readonly string[]).includes(value)
    ? (value as AgentMode)
    : undefined;
}

/**
 * One agent file as written: only the fields it sets. `description` and `systemPrompt` may be
 * absent because a same-named lower-layer agent supplies them; `mergeAgentLayers` resolves the
 * rest. A complete file is already a valid AgentConfig.
 */
export type AgentLayerEntry = Omit<AgentConfig, "description" | "systemPrompt"> & {
  description?: string;
  systemPrompt?: string;
};

/** YAML types frontmatter values; a string field given a list or number counts as omitted. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function positiveInt(value: unknown): number | undefined {
  const n =
    typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** `read, bash`, `[read, bash]` (YAML flow list or quoted string), or a block list. */
function parseTools(value: unknown): string[] | undefined {
  const items = Array.isArray(value)
    ? value.filter((t): t is string => typeof t === "string")
    : typeof value === "string"
      ? value.replace(/^\s*\[|\]\s*$/gu, "").split(",")
      : [];
  const tools = items.map((t) => t.trim().replace(/^["']|["']$/gu, "")).filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

/** Mirrors pi's extractFrontmatter, which returns `{}` for both an empty fence and no fence. */
function hasFrontmatterFence(content: string): boolean {
  const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  return normalized.startsWith("---") && normalized.indexOf("\n---", 3) !== -1;
}

function loadAgentFromFile(
  filePath: string,
  source: AgentSource,
  defaultName: string,
): AgentLayerEntry | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch (error) {
    // One malformed file must not take down discovery for every agent.
    logger.warn("agents", "invalid frontmatter", {
      filePath,
      error: error instanceof Error ? error.message.split("\n")[0] : String(error),
    });
    return null;
  }
  const { frontmatter, body } = parsed;

  // A file without a frontmatter fence is not an agent file, even when its name matches one. An
  // empty fence (`---\n---`) is: it overrides only the body. YAML that is not a mapping is malformed.
  if (!hasFrontmatterFence(content)) return null;
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    return null;
  }

  const name = str(frontmatter.name) ?? defaultName;
  const displayName = str(frontmatter.displayName);
  const description = str(frontmatter.description);
  const model = str(frontmatter.model);
  const tools = parseTools(frontmatter.tools);

  const thinking = THINKING_LEVELS.has(frontmatter.thinking as ThinkingLevel)
    ? (frontmatter.thinking as ThinkingLevel)
    : undefined;

  const steps = positiveInt(frontmatter.steps) ?? positiveInt(frontmatter.max_turns);
  const timeout = positiveInt(frontmatter.timeout);
  const completionNudge = parseCompletionNudge(frontmatter.completion_nudge);
  const mode = parseMode(frontmatter.mode);
  const packModel = parseBool(frontmatter.packModel ?? frontmatter.pack_model);
  const independent = parseBool(frontmatter.independent);
  const systemPrompt = body.trim();

  logger.debug("agents", "loaded", {
    name,
    completionNudgePresent: completionNudge !== undefined,
    completionNudgeLength: completionNudge?.length ?? 0,
  });

  return {
    name,
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(tools ? { tools } : {}),
    ...(model ? { model } : {}),
    ...(mode ? { mode } : {}),
    ...(packModel !== undefined ? { packModel } : {}),
    ...(independent !== undefined ? { independent } : {}),
    ...(thinking ? { thinking } : {}),
    ...(steps ? { steps } : {}),
    ...(timeout ? { timeout } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    source,
    filePath,
    ...(completionNudge !== undefined ? { completionNudge } : {}),
  };
}

/**
 * Resolve a file against the same-named lower-precedence agent. Every field the file omits falls
 * back to `base`, and an empty body keeps the base prompt. Returns undefined when no description
 * results: a new agent must set one.
 */
function resolveAgentEntry(entry: AgentLayerEntry, base?: AgentConfig): AgentConfig | undefined {
  const description = entry.description ?? base?.description;
  if (!description) return undefined;
  const displayName = entry.displayName ?? base?.displayName;
  const tools = entry.tools ?? base?.tools;
  const model = entry.model ?? base?.model;
  const mode = entry.mode ?? base?.mode;
  const packModel = entry.packModel ?? base?.packModel;
  const independent = entry.independent ?? base?.independent;
  const thinking = entry.thinking ?? base?.thinking;
  const steps = entry.steps ?? base?.steps;
  const timeout = entry.timeout ?? base?.timeout;
  const completionNudge = entry.completionNudge ?? base?.completionNudge;
  return {
    name: entry.name,
    ...(displayName ? { displayName } : {}),
    description,
    ...(tools ? { tools } : {}),
    ...(model ? { model } : {}),
    ...(mode ? { mode } : {}),
    ...(packModel ? { packModel } : {}),
    ...(independent ? { independent } : {}),
    ...(thinking ? { thinking } : {}),
    ...(steps ? { steps } : {}),
    ...(timeout ? { timeout } : {}),
    systemPrompt: entry.systemPrompt || base?.systemPrompt || "",
    source: entry.source,
    filePath: entry.filePath,
    ...(completionNudge !== undefined ? { completionNudge } : {}),
  };
}

export function loadAgentsFromDir(dir: string, source: AgentSource): AgentLayerEntry[] {
  if (!existsSync(dir)) return [];

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf-8" });
  } catch {
    return [];
  }

  // Every entry is kept, `<name>/MINION.md` first and then `*.md`, each sorted, so same-named
  // entries layer field by field in mergeAgentLayers instead of one silently replacing another.
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const minionAgents: AgentLayerEntry[] = [];
  const fileAgents: AgentLayerEntry[] = [];

  for (const entry of sorted) {
    if (entry.isDirectory()) {
      const filePath = join(dir, entry.name, "MINION.md");
      let isFile = false;
      try {
        isFile = existsSync(filePath) && statSync(filePath).isFile();
      } catch {
        continue;
      }
      const agent = isFile ? loadAgentFromFile(filePath, source, entry.name) : null;
      if (agent) minionAgents.push(agent);
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const agent = loadAgentFromFile(join(dir, entry.name), source, entry.name.replace(/\.md$/, ""));
    if (agent) fileAgents.push(agent);
  }

  return [...minionAgents, ...fileAgents];
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

/**
 * Later layers win field by field. Discovery order is builtin < package < user < project, and
 * entries within a layer apply in order. A same-named entry inherits every field it omits from
 * the agent merged so far, so a project file that sets only `model` keeps the rest.
 */
export function mergeAgentLayers(...layers: AgentLayerEntry[][]): AgentConfig[] {
  const agentMap = new Map<string, AgentConfig>();
  for (const layer of layers) {
    for (const entry of layer) {
      const base = agentMap.get(entry.name);
      const agent = resolveAgentEntry(entry, base);
      if (!agent) {
        logger.debug("agents", "skipped: no description and nothing to inherit", {
          name: entry.name,
          filePath: entry.filePath,
        });
        continue;
      }
      if (base) {
        logger.debug("agents", "inherited", {
          name: agent.name,
          from: base.source,
          source: agent.source,
        });
      }
      agentMap.set(agent.name, agent);
    }
  }
  return Array.from(agentMap.values());
}

export interface DiscoverAgentsOptions {
  agentDir?: string;
  homeDir?: string;
}

/** Test seam. Production leaves this unset so discovery uses getAgentDir()/homedir(). */
let injectedDiscovery: DiscoverAgentsOptions | undefined;

/** Pin discovery roots; returns a restorer. Nested installs restore the previous value. */
export function installDiscoverAgentsOptions(options: DiscoverAgentsOptions): () => void {
  const previous = injectedDiscovery;
  injectedDiscovery = options;
  return () => {
    injectedDiscovery = previous;
  };
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
  const agentDir = options.agentDir ?? injectedDiscovery?.agentDir ?? getAgentDir();
  const home = options.homeDir ?? injectedDiscovery?.homeDir ?? homedir();

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

  const packageAgents =
    scope !== "project"
      ? contributedAgentDirs().flatMap((dir) => loadAgentsFromDir(dir, "package"))
      : [];

  const projectAgents: AgentLayerEntry[] = [];
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
    agents: mergeAgentLayers([...BUILTIN_AGENTS], packageAgents, userAgents, projectAgents),
    projectAgentsDir,
  };
}
