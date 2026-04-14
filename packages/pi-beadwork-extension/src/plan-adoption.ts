import type { BeadworkAdapter } from "./bw.js";
import type {
  AdoptionApplyResult,
  AdoptionDependency,
  AdoptionLandMode,
  AdoptionOptions,
  AdoptionPlan,
  BeadworkIssue,
  ExtensionBranchEntryLike,
} from "./types.js";

const BULLET_REGEX = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s+)?(.+?)\s*$/;
const HEADING_REGEX = /^\s*#{1,6}\s+(.+?)\s*$/;
const MERMAID_BLOCK_REGEX = /```mermaid\s*([\s\S]*?)```/gim;
const MERMAID_EDGE_REGEX = /(^|\s)(\d+)\s*--+>\s*(\d+)(?=\s|$)/gm;

function trimBlock(value: string): string {
  return value.replace(/^\s+|\s+$/g, "");
}

function sanitizeStepTitle(value: string): string {
  return value.replace(/`+/g, "").trim();
}

function normalizePlanTitle(source: string, overrideTitle?: string): string {
  if (overrideTitle?.trim()) {
    return overrideTitle.trim();
  }

  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const heading = line.match(HEADING_REGEX);
    if (heading) {
      return heading[1].trim();
    }
  }

  const firstSentence = lines[0] ?? "Adopted beadwork plan";
  return firstSentence.slice(0, 120);
}

function extractPlanSteps(source: string): AdoptionPlan["steps"] {
  const steps: AdoptionPlan["steps"] = [];
  const lines = source.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(BULLET_REGEX);
    if (!match) {
      continue;
    }

    const title = sanitizeStepTitle(match[1]);
    if (!title) {
      continue;
    }

    steps.push({
      index: steps.length + 1,
      title,
      description: title,
    });
  }

  return steps;
}

function extractMermaidDependencies(source: string, stepCount: number): AdoptionDependency[] {
  const dependencies: AdoptionDependency[] = [];
  const seen = new Set<string>();

  for (const block of source.matchAll(MERMAID_BLOCK_REGEX)) {
    const body = block[1] ?? "";
    for (const edge of body.matchAll(MERMAID_EDGE_REGEX)) {
      const blockerIndex = Number.parseInt(edge[2] ?? "", 10);
      const blockedIndex = Number.parseInt(edge[3] ?? "", 10);
      if (
        Number.isNaN(blockerIndex) ||
        Number.isNaN(blockedIndex) ||
        blockerIndex < 1 ||
        blockedIndex < 1 ||
        blockerIndex > stepCount ||
        blockedIndex > stepCount ||
        blockerIndex === blockedIndex
      ) {
        continue;
      }

      const key = `${blockerIndex}->${blockedIndex}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      dependencies.push({ blockerIndex, blockedIndex });
    }
  }

  return dependencies;
}

function buildSequentialDependencies(stepCount: number): AdoptionDependency[] {
  const dependencies: AdoptionDependency[] = [];
  for (let index = 1; index < stepCount; index += 1) {
    dependencies.push({ blockerIndex: index, blockedIndex: index + 1 });
  }
  return dependencies;
}

function extractTextBlocks(entry: ExtensionBranchEntryLike): string[] {
  if (entry.type !== "message") {
    return [];
  }

  const message = entry.message as { content?: unknown };
  const content = message.content;

  if (typeof content === "string") {
    return [content];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .filter((block): block is { type: string; text?: string } =>
      Boolean(block && typeof block === "object"),
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "");
}

function looksPlanLike(source: string): boolean {
  return BULLET_REGEX.test(source) || /\bplan\b/i.test(source) || /```mermaid/i.test(source);
}

export function resolvePlanSource(
  inputText: string,
  editorText: string | undefined,
  entries: ExtensionBranchEntryLike[],
): string | undefined {
  const direct = trimBlock(inputText);
  if (direct.length > 0) {
    return direct;
  }

  const editor = trimBlock(editorText ?? "");
  if (editor.length > 0) {
    return editor;
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const blocks = extractTextBlocks(entries[index]);
    const combined = trimBlock(blocks.join("\n\n"));
    if (combined.length > 0 && looksPlanLike(combined)) {
      return combined;
    }
  }

  return undefined;
}

export function buildAdoptionPlan(source: string, options: AdoptionOptions = {}): AdoptionPlan {
  const trimmed = trimBlock(source);
  const steps = extractPlanSteps(trimmed);
  const landMode = options.landMode ?? (steps.length <= 1 ? "branch" : "multi");

  let dependencies = extractMermaidDependencies(trimmed, steps.length);
  let dependencyStrategy: AdoptionPlan["dependencyStrategy"] = "explicit";

  if (dependencies.length === 0 && options.sequential !== false && steps.length > 1) {
    dependencies = buildSequentialDependencies(steps.length);
    dependencyStrategy = "sequential";
  }

  if (dependencies.length === 0) {
    dependencyStrategy = "none";
  }

  return {
    source: trimmed,
    title: normalizePlanTitle(trimmed, options.title),
    landMode,
    steps,
    dependencies,
    dependencyStrategy,
  };
}

function buildMultiStepSummary(plan: AdoptionPlan): string[] {
  const lines = [
    `Plan title: ${plan.title}`,
    `Land mode: ${plan.landMode}`,
    `Steps: ${plan.steps.length}`,
    `Dependencies: ${plan.dependencies.length} (${plan.dependencyStrategy})`,
    "",
    "Planned graph:",
  ];

  for (const step of plan.steps) {
    const blockedBy = plan.dependencies
      .filter((dependency) => dependency.blockedIndex === step.index)
      .map((dependency) => dependency.blockerIndex);
    const suffix = blockedBy.length > 0 ? ` [blocked by: ${blockedBy.join(", ")}]` : "";
    lines.push(`${step.index}. ${step.title}${suffix}`);
  }

  return lines;
}

export function formatAdoptionPreview(plan: AdoptionPlan): string {
  if (plan.landMode === "quick") {
    return [
      `Plan title: ${plan.title}`,
      "Land mode: quick",
      "",
      "No beadwork graph will be created for a quick-fix delivery.",
    ].join("\n");
  }

  if (plan.landMode === "branch") {
    return [
      `Plan title: ${plan.title}`,
      "Land mode: branch",
      "",
      "A single task will be created from this plan.",
      plan.steps.length > 0
        ? `Plan steps detected: ${plan.steps.length}`
        : "No explicit plan steps detected.",
    ].join("\n");
  }

  return buildMultiStepSummary(plan).join("\n");
}

export async function applyAdoptionPlan(
  adapter: BeadworkAdapter,
  cwd: string,
  plan: AdoptionPlan,
): Promise<AdoptionApplyResult> {
  if (plan.landMode === "quick") {
    return {
      mode: "quick",
      created: [],
    };
  }

  if (plan.landMode === "branch") {
    const created = await adapter.createIssue(cwd, {
      title: plan.title,
      type: "task",
      description: plan.source,
    });

    return {
      mode: "branch",
      root: created.issue,
      created: [created.issue],
    };
  }

  const epic = await adapter.createIssue(cwd, {
    title: plan.title,
    type: "epic",
    description: plan.source,
  });

  const created: BeadworkIssue[] = [epic.issue];
  const stepIssues = new Map<number, BeadworkIssue>();

  for (const step of plan.steps) {
    const child = await adapter.createIssue(cwd, {
      title: step.title,
      type: "task",
      description: step.description,
      parentId: epic.issue.id,
    });
    created.push(child.issue);
    stepIssues.set(step.index, child.issue);
  }

  for (const dependency of plan.dependencies) {
    const blocker = stepIssues.get(dependency.blockerIndex);
    const blocked = stepIssues.get(dependency.blockedIndex);
    if (!blocker || !blocked) {
      continue;
    }
    await adapter.addDependency(cwd, blocker.id, blocked.id);
  }

  return {
    mode: "multi",
    root: epic.issue,
    created,
  };
}

export function parseLandMode(value: string | undefined): AdoptionLandMode | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "quick" || value === "branch" || value === "multi") {
    return value;
  }
  return undefined;
}
