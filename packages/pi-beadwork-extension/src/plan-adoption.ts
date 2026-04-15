import type { BeadworkAdapter } from "./bw.js";
import type {
  AdoptionApplyResult,
  AdoptionDependency,
  AdoptionLandMode,
  AdoptionOptions,
  AdoptionPlan,
  AdoptionPlanSource,
  BeadworkIssue,
} from "./types.js";

const HEADING_REGEX = /^\s*#{1,6}\s+(.+?)\s*$/;
const SOURCE_EXCERPT_LINE_LIMIT = 20;
const SOURCE_EXCERPT_CHAR_LIMIT = 2_500;

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

function normalizeAdoptionSource(source: string | AdoptionPlanSource): AdoptionPlanSource {
  if (typeof source === "string") {
    return {
      kind: "inline",
      markdown: source,
      label: "inline markdown argument",
    };
  }

  return source;
}

function formatSourceExcerpt(source: string): string[] {
  const rawLines = source.split(/\r?\n/);
  const excerptLines: string[] = [];
  let usedChars = 0;

  for (const line of rawLines.slice(0, SOURCE_EXCERPT_LINE_LIMIT)) {
    const nextLength = usedChars + line.length;
    if (nextLength > SOURCE_EXCERPT_CHAR_LIMIT) {
      const remaining = Math.max(0, SOURCE_EXCERPT_CHAR_LIMIT - usedChars);
      excerptLines.push(`${line.slice(0, remaining).trimEnd()}…`);
      usedChars = SOURCE_EXCERPT_CHAR_LIMIT;
      break;
    }

    excerptLines.push(line);
    usedChars = nextLength;
  }

  const truncated =
    rawLines.length > SOURCE_EXCERPT_LINE_LIMIT || source.length > SOURCE_EXCERPT_CHAR_LIMIT;

  return [
    "Source excerpt:",
    "```md",
    ...(excerptLines.length > 0 ? excerptLines : ["(empty)"]),
    ...(truncated ? ["…"] : []),
    "```",
  ];
}

function buildPreviewPrefix(plan: AdoptionPlan): string[] {
  const lines = [
    `Plan title: ${plan.title}`,
    `Plan source: ${plan.sourceLabel} (${plan.sourceKind})`,
  ];

  if (plan.sourcePath) {
    lines.push(`Plan source path: ${plan.sourcePath}`);
  }

  return [...lines, "", ...formatSourceExcerpt(plan.source), ""];
}

export function resolvePlanSource(input: {
  inlineText: string;
  editorText: string | undefined;
  file?: {
    path: string;
    markdown: string | undefined;
  };
}): AdoptionPlanSource | undefined {
  if (input.file) {
    const fromFile = trimBlock(input.file.markdown ?? "");
    if (fromFile.length === 0) {
      return undefined;
    }

    return {
      kind: "file",
      markdown: fromFile,
      label: `file:${input.file.path}`,
      path: input.file.path,
    };
  }

  const direct = trimBlock(input.inlineText);
  if (direct.length > 0) {
    return {
      kind: "inline",
      markdown: direct,
      label: "inline markdown argument",
    };
  }

  const editor = trimBlock(input.editorText ?? "");
  if (editor.length > 0) {
    return {
      kind: "editor",
      markdown: editor,
      label: "active editor markdown",
    };
  }

  return undefined;
}

export function buildAdoptionPlan(
  source: string | AdoptionPlanSource,
  options: AdoptionOptions = {},
): AdoptionPlan {
  const normalizedSource = normalizeAdoptionSource(source);
  const trimmed = trimBlock(normalizedSource.markdown);
  const steps = normalizeSteps(options);
  const dependencies = normalizeDependencies(options.dependencies, steps.length);
  const landMode = options.landMode ?? (steps.length > 1 ? "multi" : "branch");

  return {
    source: trimmed,
    sourceKind: normalizedSource.kind,
    sourceLabel: normalizedSource.label,
    sourcePath: normalizedSource.path,
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
      "Land mode: multi",
      "",
      "No explicit step graph was provided.",
      "Use beadwork_create_issue and beadwork_add_dependency to materialize decomposition explicitly.",
    ];
  }

  const lines = [
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
  const prefix = buildPreviewPrefix(plan);

  if (plan.landMode === "quick") {
    return [
      ...prefix,
      "Land mode: quick",
      "",
      "No beadwork graph will be created for a quick-fix delivery.",
    ].join("\n");
  }

  if (plan.landMode === "branch") {
    return [
      ...prefix,
      "Land mode: branch",
      "",
      "A single task will be created from this explicit plan source.",
      "No automatic graph parsing is performed; use tools for multi-ticket decomposition.",
    ].join("\n");
  }

  return [...prefix, ...buildMultiStepSummary(plan)].join("\n");
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
