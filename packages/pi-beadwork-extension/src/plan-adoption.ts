import type { BeadworkAdapter } from "./bw.js";
import type {
  AdoptionApplyResult,
  AdoptionDependency,
  AdoptionLandMode,
  AdoptionOptions,
  AdoptionPlan,
  BeadworkIssue,
} from "./types.js";

const HEADING_REGEX = /^\s*#{1,6}\s+(.+?)\s*$/;

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

function normalizeSteps(options: AdoptionOptions): AdoptionPlan["steps"] {
  const rawSteps = options.steps ?? [];
  const steps: AdoptionPlan["steps"] = [];

  for (const rawStep of rawSteps) {
    const title = sanitizeStepTitle(rawStep.title ?? "");
    if (!title) {
      continue;
    }

    steps.push({
      index: steps.length + 1,
      title,
      description: trimBlock(rawStep.description ?? title) || title,
    });
  }

  return steps;
}

function normalizeDependencies(
  dependencies: AdoptionDependency[] | undefined,
  stepCount: number,
): AdoptionDependency[] {
  const normalized: AdoptionDependency[] = [];
  const seen = new Set<string>();

  for (const dependency of dependencies ?? []) {
    const blockerIndex = Math.floor(dependency.blockerIndex);
    const blockedIndex = Math.floor(dependency.blockedIndex);

    if (
      !Number.isFinite(blockerIndex) ||
      !Number.isFinite(blockedIndex) ||
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
    normalized.push({ blockerIndex, blockedIndex });
  }

  return normalized;
}

export function resolvePlanSource(
  inputText: string,
  editorText: string | undefined,
  fileText?: string,
): string | undefined {
  const direct = trimBlock(inputText);
  if (direct.length > 0) {
    return direct;
  }

  const fromFile = trimBlock(fileText ?? "");
  if (fromFile.length > 0) {
    return fromFile;
  }

  const editor = trimBlock(editorText ?? "");
  if (editor.length > 0) {
    return editor;
  }

  return undefined;
}

export function buildAdoptionPlan(source: string, options: AdoptionOptions = {}): AdoptionPlan {
  const trimmed = trimBlock(source);
  const steps = normalizeSteps(options);
  const dependencies = normalizeDependencies(options.dependencies, steps.length);
  const landMode = options.landMode ?? (steps.length > 1 ? "multi" : "branch");

  return {
    source: trimmed,
    title: normalizePlanTitle(trimmed, options.title),
    landMode,
    steps,
    dependencies,
    dependencyStrategy: dependencies.length > 0 ? "explicit" : "none",
  };
}

function buildMultiStepSummary(plan: AdoptionPlan): string[] {
  if (plan.steps.length === 0) {
    return [
      `Plan title: ${plan.title}`,
      `Land mode: ${plan.landMode}`,
      "",
      "No explicit step graph was provided.",
      "Use beadwork_create_issue and beadwork_add_dependency to materialize decomposition explicitly.",
    ];
  }

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
      "A single task will be created from this explicit plan source.",
      "No automatic graph parsing is performed; use tools for multi-ticket decomposition.",
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
