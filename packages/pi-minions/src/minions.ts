import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MINION_NAMES, getConfig } from "./config.js";
import type { AgentTree } from "./tree.js";
import type { AgentConfig } from "./types.js";

export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

export const MAX_PUBLIC_ID_ATTEMPTS = 32;

/** Allocate an 8-hex public id without ever overwriting an existing tree node. */
export function generateAvailableId(
  tree: Pick<AgentTree, "has">,
  reserved: ReadonlySet<string> = new Set(),
  candidate: () => string = generateId,
): string {
  for (let attempt = 0; attempt < MAX_PUBLIC_ID_ATTEMPTS; attempt++) {
    const id = candidate();
    if (!tree.has(id) && !reserved.has(id)) return id;
  }
  throw new Error(`unable to allocate unique minion id after ${MAX_PUBLIC_ID_ATTEMPTS} attempts`);
}

export function pickMinionName(
  tree: AgentTree,
  fallbackId: string,
  ctx?: ExtensionContext,
  preferredName?: string,
  reservedNames?: Set<string>,
): string {
  const inUse = new Set([
    ...tree.getLive().map((n) => n.name),
    ...(reservedNames ? Array.from(reservedNames) : []),
  ]);

  if (preferredName) {
    if (!inUse.has(preferredName)) return preferredName;
    let candidate: string;
    do {
      const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 4);
      candidate = `${preferredName}-${suffix}`;
    } while (inUse.has(candidate));
    return candidate;
  }

  const configuredNames = ctx ? getConfig(ctx).minionNames : DEFAULT_MINION_NAMES;
  const names = configuredNames.length > 0 ? configuredNames : DEFAULT_MINION_NAMES;
  const available = names.filter((n) => !inUse.has(n));

  if (available.length === 0) {
    const fallbackBase = names[0] ?? "minion";
    return `${fallbackBase}-${fallbackId}`;
  }

  const name = available[Math.floor(Math.random() * available.length)] ?? `minion-${fallbackId}`;

  return name;
}

export const DEFAULT_MINION_PROMPT = `You are a minion — an autonomous subagent in an isolated context with no conversation history. Be concise; your output goes to a parent agent, not a human.

Use tools to investigate and complete the task. Prefer grep/find/ls before reading files. Use absolute paths.

File boundaries: research output goes to /tmp/ only.
Project files can be modified only when explicitly requested.
When in doubt, report findings first.

Fix what the work turns up and keep going. These are part of the task, not failures:
- A path or glob that matches nothing: search for the real one. If several fit, name the one you chose.
- A setup step whose effect already holds for this task (its claim or start already done): note it and go on. If that state belongs to someone else or another task, you are blocked.
- A test your change turns red (when you were asked to change files): fix the code, or update a test whose old expectation the brief changes. Never weaken, skip or delete a test to get green.
- A formatter or lint diff, a typo in a command: fix it and rerun.
Report each one in Notes.
Stop and report only when blocked: the brief and the code disagree in a way only the parent can settle, the next step needs a decision outside your task (product intent, shared state, credentials, a contract other code depends on), or the same failure survives two different fixes. Never fabricate a result.

Respond with:

## Result
What was accomplished or found.

## Files
File paths modified or referenced.

## Notes
Issues, assumptions, or follow-up needed.`;

export function defaultMinionTemplate(
  name: string,
  overrides?: Partial<Pick<AgentConfig, "model" | "thinking" | "tools" | "steps" | "timeout">>,
): AgentConfig {
  return {
    name,
    description: "Ephemeral minion",
    systemPrompt: DEFAULT_MINION_PROMPT,
    source: "ephemeral",
    filePath: "",
    ...overrides,
  };
}
