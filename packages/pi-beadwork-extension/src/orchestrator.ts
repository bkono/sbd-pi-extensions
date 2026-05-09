import { createWriteStream } from "node:fs";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BeadworkAdapter } from "./bw.js";
import { buildCurrentBranchHandoffPrompt, buildWorkerHandoff } from "./handoff.js";
import { defaultProcessRunner, type ProcessRunner, shellQuote, sleep } from "./process.js";
import {
  loadWorkerRegistry,
  resolveWorkerRegistryPath,
  resolveWorkerRuntimeDir,
  saveWorkerRegistry,
  summarizeWorkers,
  upsertWorkerRuntime,
} from "./registry.js";
import { createTmuxBackend, type TmuxBackend, type TmuxPaneInspection } from "./tmux.js";
import type {
  BeadworkConfig,
  BeadworkIssue,
  BeadworkIssueDetail,
  CurrentBranchWorkerRuntime,
  RunOptions,
  RunSummary,
  RunUntil,
  WorkerReviewVerdict,
  WorkerRuntime,
  WorktreeWorkerRuntime,
} from "./types.js";
import { isSuccessfulTerminalWorker, isWorktreeWorker } from "./types.js";
import {
  cleanupTicketWorktree,
  type LandingVerificationResult,
  landWorktreeBranch,
  prepareWorkerCheckout,
  rebaseWorktreeOntoRepoHead,
  runWorktreeValidation,
  verifyWorktreeLanding,
} from "./worktree.js";

function buildWorkerId(ticketId: string): string {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${ticketId.toLowerCase()}-${stamp}-${random}`;
}

function describeLaunchLocation(worker: WorkerRuntime): string {
  if (worker.executionMode === "worktree") {
    return `executionMode=worktree worktreePath=${worker.worktreePath}`;
  }

  return (
    `executionMode=current-branch checkoutPath=${worker.checkoutPath} ` +
    `branchName=${worker.branchName} launchHead=${worker.launchHead}`
  );
}

function buildLaunchFailureMessage(worker: WorkerRuntime, error: unknown): string {
  return (
    `Failed to launch worker ${worker.workerId} for ${worker.ticketId} ` +
    `(${describeLaunchLocation(worker)}): ${humanizeError(error)}`
  );
}

function buildRunLaunchNotice(worker: WorkerRuntime): string {
  if (worker.executionMode === "worktree") {
    return `launched worktree worker for ${worker.ticketId} at worktreePath ${worker.worktreePath}`;
  }

  return `launched current-branch worker for ${worker.ticketId} at checkoutPath ${worker.checkoutPath}`;
}

function humanizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasPiPrintFlag(command: string): boolean {
  return /(^|\s)(?:--print|-p)(?=\s|$)/.test(command);
}

function stripPiPrintFlag(command: string): string {
  return command
    .replace(/(^|\s)(?:--print|-p)(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function hasPiModeFlag(command: string): boolean {
  return /(^|\s)--mode(?:=|\s+)[^\s]+/.test(command);
}

function shouldNormalizePiWorkerCommand(command: string): boolean {
  const [executable = ""] = command.trim().split(/\s+/, 1);
  return executable === "pi" || executable.endsWith("/pi");
}

function buildModelScopedAgentCommand(input: {
  command: string;
  provider?: string;
  model?: string;
}): string {
  const baseCommand = input.command.trim();
  let normalizedCommand = baseCommand;

  if (shouldNormalizePiWorkerCommand(baseCommand)) {
    if (hasPiPrintFlag(normalizedCommand)) {
      normalizedCommand = stripPiPrintFlag(normalizedCommand);
    }
    if (!hasPiModeFlag(normalizedCommand)) {
      normalizedCommand = `${normalizedCommand} --mode json`;
    }
  }

  const parts = [normalizedCommand];
  if (input.provider?.trim()) {
    parts.push(`--provider ${shellQuote(input.provider.trim())}`);
  }
  if (input.model?.trim()) {
    parts.push(`--model ${shellQuote(input.model.trim())}`);
  }

  return parts.filter((part) => part.length > 0).join(" ");
}

type WorkerAgentSettings = Partial<
  Pick<WorkerRuntime, "workerCommand" | "workerProvider" | "workerModel">
>;

function resolveWorkerAgentSettings(
  config: BeadworkConfig,
  override?: WorkerAgentSettings,
): Required<Pick<WorkerRuntime, "workerCommand">> &
  Pick<WorkerRuntime, "workerProvider" | "workerModel"> {
  return {
    workerCommand: override?.workerCommand?.trim() || config.tmux.workerCommand,
    workerProvider: override?.workerProvider?.trim() || config.tmux.workerProvider,
    workerModel: override?.workerModel?.trim() || config.tmux.workerModel,
  };
}

function resolveReviewerAgentSettings(
  config: BeadworkConfig,
  worker?: WorkerAgentSettings,
): Required<Pick<WorkerRuntime, "workerCommand">> &
  Pick<WorkerRuntime, "workerProvider" | "workerModel"> {
  const resolvedWorker = resolveWorkerAgentSettings(config, worker);
  return {
    workerCommand: resolvedWorker.workerCommand,
    workerProvider: config.landing.review.provider ?? resolvedWorker.workerProvider,
    workerModel: config.landing.review.model ?? resolvedWorker.workerModel,
  };
}

export function buildWorkerAgentCommand(
  config: BeadworkConfig,
  override?: WorkerAgentSettings,
): string {
  const worker = resolveWorkerAgentSettings(config, override);
  return buildModelScopedAgentCommand({
    command: worker.workerCommand,
    provider: worker.workerProvider,
    model: worker.workerModel,
  });
}

export function buildReviewerAgentCommand(
  config: BeadworkConfig,
  worker?: WorkerAgentSettings,
): string {
  const reviewer = resolveReviewerAgentSettings(config, worker);
  return buildModelScopedAgentCommand({
    command: reviewer.workerCommand,
    provider: reviewer.workerProvider,
    model: reviewer.workerModel,
  });
}

function buildWorkerScript(input: {
  workerAgentCommand: string;
  promptFile: string;
  logFile: string;
  stateFile: string;
  exitCodeFile: string;
  finishedAtFile: string;
}): string {
  return `#!/usr/bin/env bash
set -uo pipefail
exec > >(tee -a ${shellQuote(input.logFile)}) 2>&1
printf '[beadwork worker] started %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
printf '[beadwork worker] cwd: %s\n' "$PWD"
printf '[beadwork worker] handoff: %s\n' ${shellQuote(input.promptFile)}
printf '[beadwork worker] command: %s\n' ${shellQuote(input.workerAgentCommand)}
printf 'running\n' > ${shellQuote(input.stateFile)}
${input.workerAgentCommand} "$(cat ${shellQuote(input.promptFile)})"
status=$?
printf '%s\n' "$status" > ${shellQuote(input.exitCodeFile)}
date -u +"%Y-%m-%dT%H:%M:%SZ" > ${shellQuote(input.finishedAtFile)}
if [[ "$status" -eq 0 ]]; then
  printf 'exited\n' > ${shellQuote(input.stateFile)}
else
  printf 'failed\n' > ${shellQuote(input.stateFile)}
fi
printf '[beadwork worker] finished %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
printf '[beadwork worker exited with code %s]\n' "$status"
exit "$status"
`;
}

async function appendWorkerLog(logFile: string, message: string): Promise<void> {
  try {
    await appendFile(
      logFile,
      `[beadwork orchestrator] ${new Date().toISOString()} ${message}\n`,
      "utf8",
    );
  } catch {
    // best-effort runtime logging only
  }
}

function resolveReviewerLogFile(worker: WorkerRuntime): string {
  return path.join(worker.runtimeDir, "review.log");
}

type WorkerOrchestrationLock = {
  snapshot: WorkerRuntime;
  promise: Promise<WorkerRuntime>;
};

export type CurrentBranchVerificationContext = {
  cwd: string;
  repoRoot: string;
  config: BeadworkConfig;
  adapter: BeadworkAdapter;
  runner: ProcessRunner;
  tmuxBackend: TmuxBackend;
  worker: CurrentBranchWorkerRuntime;
  onLifecycleEvent?: (message: string) => void;
  onWorkerUpdate?: (worker: WorkerRuntime) => void;
};

export type CurrentBranchVerificationOperation = (
  context: CurrentBranchVerificationContext,
) => Promise<CurrentBranchWorkerRuntime>;

export type CurrentBranchVerificationPipeline = {
  buildAttributionEvidence?: CurrentBranchVerificationOperation;
  runWorkerReview?: CurrentBranchVerificationOperation;
  applyCoordinatorTriage?: CurrentBranchVerificationOperation;
  handleRemediation?: CurrentBranchVerificationOperation;
  markVerified?: CurrentBranchVerificationOperation;
};

type VerifyCurrentBranchWorkerInput = CurrentBranchVerificationContext & {
  awaitOrchestration?: boolean;
  pipeline?: CurrentBranchVerificationPipeline;
};

type RunLaunchLockResult = {
  workers: WorkerRuntime[];
  launchable: BeadworkIssue[];
  launchedThisCycle: string[];
  launchNotices: string[];
};

const workerOrchestrationLocks = new Map<string, WorkerOrchestrationLock>();
const epicRunLaunchLocks = new Map<string, Promise<void>>();

const MAX_VALIDATION_REMEDIATION_ATTEMPTS = 1;
const MAX_LANDING_REMEDIATION_ATTEMPTS = 1;
const REVIEWER_ALLOWED_VERDICTS: WorkerReviewVerdict[] = [
  "approve",
  "approve-with-nits",
  "request-changes",
];

function normalizeReviewVerdict(value: unknown): WorkerReviewVerdict | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  return REVIEWER_ALLOWED_VERDICTS.includes(normalized as WorkerReviewVerdict)
    ? (normalized as WorkerReviewVerdict)
    : undefined;
}

type ReviewFeedbackItem = {
  comment: string;
  intentAlignment: "aligned" | "unclear" | "misaligned";
  requiresChanges: boolean;
};

type ReviewerDecision = {
  verdict: WorkerReviewVerdict;
  summary: string;
  feedback: ReviewFeedbackItem[];
};

type ReviewerAssessment = {
  validFeedback: ReviewFeedbackItem[];
  invalidFeedback: ReviewFeedbackItem[];
  requiresChanges: boolean;
};

function truncateForPrompt(value: string | undefined, maxChars: number): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars).trimEnd()}\n\n[truncated]`;
}

function extractAssistantTextParts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .flatMap((entry) => {
      if (typeof entry === "string") {
        return entry.trim().length > 0 ? [entry.trim()] : [];
      }

      if (!entry || typeof entry !== "object") {
        return [];
      }

      const item = entry as { type?: unknown; text?: unknown; content?: unknown };
      if (typeof item.text === "string" && item.text.trim().length > 0) {
        return [item.text.trim()];
      }

      if (item.type === "output_text" && typeof item.content === "string") {
        const text = item.content.trim();
        return text.length > 0 ? [text] : [];
      }

      return [];
    })
    .filter((entry) => entry.length > 0);
}

function extractPiJsonAssistantTexts(raw: string): string[] {
  const assistantTexts: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("{")) {
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(trimmedLine) as unknown;
    } catch {
      continue;
    }

    if (!event || typeof event !== "object") {
      continue;
    }

    const record = event as {
      message?: { role?: unknown; content?: unknown };
      assistantMessageEvent?: {
        partial?: { role?: unknown; content?: unknown };
        message?: { role?: unknown; content?: unknown };
      };
    };

    const assistantMessages = [
      record.message,
      record.assistantMessageEvent?.message,
      record.assistantMessageEvent?.partial,
    ].filter(
      (message): message is { role?: unknown; content?: unknown } =>
        Boolean(message) && typeof message === "object" && message.role === "assistant",
    );

    for (const message of assistantMessages) {
      const content = Array.isArray(message.content) ? message.content : [];
      const text = extractAssistantTextParts(content).join("\n").trim();
      if (text.length > 0) {
        assistantTexts.push(text);
      }
    }
  }

  return assistantTexts;
}

function extractJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Reviewer output was empty.");
  }

  const taggedReport = trimmed.match(/<review_report>\s*([\s\S]*?)\s*<\/review_report>/i);
  if (taggedReport?.[1]) {
    try {
      return extractJsonPayload(taggedReport[1]);
    } catch {
      // fall through so event-stream extraction can inspect decoded assistant text
    }
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Try markdown JSON fences.
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]) as unknown;
    } catch {
      // fall through to additional extraction strategies
    }
  }

  const assistantTexts = extractPiJsonAssistantTexts(trimmed);
  for (let index = assistantTexts.length - 1; index >= 0; index -= 1) {
    try {
      return extractJsonPayload(assistantTexts[index] ?? "");
    } catch {
      // try older assistant messages before failing
    }
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) {
    try {
      return JSON.parse(objectMatch[0]) as unknown;
    } catch {
      // fall through to the final error
    }
  }

  throw new Error("Reviewer output did not contain a structured review report.");
}

function normalizeReviewFeedbackItem(value: unknown): ReviewFeedbackItem | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return {
      comment: value.trim(),
      intentAlignment: "unclear",
      requiresChanges: true,
    };
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const objectValue = value as {
    comment?: unknown;
    intentAlignment?: unknown;
    requiresChanges?: unknown;
    severity?: unknown;
  };
  if (typeof objectValue.comment !== "string" || objectValue.comment.trim().length === 0) {
    return undefined;
  }

  const rawAlignment =
    typeof objectValue.intentAlignment === "string" ? objectValue.intentAlignment : undefined;
  const intentAlignment =
    rawAlignment === "aligned" || rawAlignment === "unclear" || rawAlignment === "misaligned"
      ? rawAlignment
      : "unclear";

  const requiresChanges =
    typeof objectValue.requiresChanges === "boolean"
      ? objectValue.requiresChanges
      : objectValue.severity !== "nit";

  return {
    comment: objectValue.comment.trim(),
    intentAlignment,
    requiresChanges,
  };
}

function normalizeReviewerDecision(raw: string): ReviewerDecision {
  const payload = extractJsonPayload(raw);
  if (!payload || typeof payload !== "object") {
    throw new Error("Reviewer output was not a structured report object.");
  }

  const value = payload as {
    verdict?: unknown;
    summary?: unknown;
    feedback?: unknown;
    findings?: unknown;
  };

  const verdict = normalizeReviewVerdict(value.verdict);
  if (!verdict) {
    throw new Error(
      `Reviewer verdict must be one of: APPROVE, APPROVE WITH NITS, REQUEST CHANGES. Received: ${String(value.verdict)}.`,
    );
  }

  const feedbackEntries = Array.isArray(value.findings)
    ? value.findings
    : Array.isArray(value.feedback)
      ? value.feedback
      : [];
  const feedback = feedbackEntries
    .map((entry) => normalizeReviewFeedbackItem(entry))
    .filter((entry): entry is ReviewFeedbackItem => entry !== undefined);

  return {
    verdict,
    summary:
      typeof value.summary === "string" && value.summary.trim().length > 0
        ? value.summary.trim()
        : "Reviewer did not provide a summary.",
    feedback,
  };
}

function tokenizeIntent(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4),
  );
}

function feedbackLooksRelevant(comment: string, intentTokens: Set<string>): boolean {
  const tokens = comment
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);

  for (const token of tokens) {
    if (intentTokens.has(token)) {
      return true;
    }
  }

  return /(lint|test|typecheck|build|compile|regression|bug|error|security|crash|perf)/i.test(
    comment,
  );
}

function assessReviewerFeedback(input: {
  decision: ReviewerDecision;
  ticket: BeadworkIssueDetail;
  epic?: BeadworkIssueDetail;
}): ReviewerAssessment {
  const intentTokens = tokenizeIntent(
    [
      input.ticket.id,
      input.ticket.title,
      input.ticket.description,
      input.epic?.id,
      input.epic?.title,
      input.epic?.description,
    ]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n"),
  );

  const validFeedback: ReviewFeedbackItem[] = [];
  const invalidFeedback: ReviewFeedbackItem[] = [];

  for (const feedback of input.decision.feedback) {
    const aligned = feedback.intentAlignment !== "misaligned";
    const relevant =
      feedback.intentAlignment === "aligned" ||
      feedbackLooksRelevant(feedback.comment, intentTokens);

    if (aligned && relevant) {
      validFeedback.push(feedback);
    } else {
      invalidFeedback.push(feedback);
    }
  }

  return {
    validFeedback,
    invalidFeedback,
    requiresChanges:
      input.decision.verdict === "request-changes" &&
      validFeedback.some((feedback) => feedback.requiresChanges),
  };
}

function hasReusableApprovedReview(worker: WorkerRuntime): boolean {
  return (
    (worker.reviewStatus === "approved" || worker.reviewStatus === "nits-only") &&
    typeof worker.reviewedWorkerHead === "string" &&
    worker.reviewedWorkerHead.trim().length > 0
  );
}

function canReuseApprovedReview(worker: WorkerRuntime, workerHead: string | undefined): boolean {
  return (
    Boolean(workerHead) &&
    hasReusableApprovedReview(worker) &&
    worker.reviewedWorkerHead === workerHead
  );
}

export type WorkerLifecycleEvent =
  | {
      type: "post-exit-started";
      ticketId: string;
      message: string;
    }
  | {
      type: "remediation-started";
      ticketId: string;
      message: string;
    };

function buildValidationRemediationPrompt(input: {
  worker: WorktreeWorkerRuntime;
  validationDetail: string;
  validationCommands: string[];
}): string {
  const lines = [
    "You are continuing delegated work in an existing beadwork ticket worktree.",
    "",
    `Ticket: ${input.worker.ticketId} ${input.worker.ticketTitle}`,
    `Worktree: ${input.worker.worktreePath}`,
    `Branch: ${input.worker.branchName}`,
    "",
    "The previous delegated pass finished and closed the ticket, but orchestrator validation failed.",
    `Validation failure: ${input.validationDetail}`,
  ];

  if (input.validationCommands.length > 0) {
    lines.push("", "Validation commands to satisfy:");
    for (const command of input.validationCommands) {
      lines.push(`- ${command}`);
    }
  }

  lines.push(
    "",
    "Rules:",
    "- Stay scoped to fixing the validation failure in this worktree.",
    "- Do not reopen the ticket unless absolutely necessary.",
    "- If you change code, commit the follow-up fix on the current branch.",
    "- Re-run the necessary validation commands until they pass.",
    "- If you make additional commits, run `bw sync` before exiting.",
    "- If you are blocked or cannot remediate cleanly, explain that clearly and exit.",
  );

  return lines.join("\n");
}

function buildLandingRemediationPrompt(input: {
  worker: WorktreeWorkerRuntime;
  rebaseDetail: string;
  validationCommands: string[];
}): string {
  const lines = [
    "You are continuing delegated work in an existing beadwork ticket worktree.",
    "",
    `Ticket: ${input.worker.ticketId} ${input.worker.ticketTitle}`,
    `Worktree: ${input.worker.worktreePath}`,
    `Branch: ${input.worker.branchName}`,
    "",
    "The orchestrator attempted to rebase this worker branch onto the latest repo HEAD before landing, but the rebase failed.",
    `Rebase failure: ${input.rebaseDetail}`,
  ];

  if (input.validationCommands.length > 0) {
    lines.push("", "Validation commands to satisfy after resolving the rebase:");
    for (const command of input.validationCommands) {
      lines.push(`- ${command}`);
    }
  }

  lines.push(
    "",
    "Rules:",
    "- Resolve the rebase/conflict mechanically in this existing worktree against the latest repo HEAD.",
    "- Keep the ticket scoped to the original intent; do not introduce unrelated changes.",
    "- If you change code while resolving conflicts, commit the updated result on the current branch.",
    "- Use runtime scratch space instead of leaving transient files like context.md in the worktree.",
    "- Re-run any required validation commands until they pass.",
    "- Run `bw sync` before exiting if you create any commits.",
    "- If you are blocked or cannot resolve the rebase cleanly, explain that clearly and exit.",
  );

  return lines.join("\n");
}

function buildReviewRemediationPrompt(input: {
  worker: WorktreeWorkerRuntime;
  reviewSummary: string;
  validFeedback: ReviewFeedbackItem[];
  validationCommands: string[];
}): string {
  const lines = [
    "You are continuing delegated work in an existing beadwork ticket worktree.",
    "",
    `Ticket: ${input.worker.ticketId} ${input.worker.ticketTitle}`,
    `Worktree: ${input.worker.worktreePath}`,
    `Branch: ${input.worker.branchName}`,
    "",
    "The reviewer requested changes that the orchestrator deemed valid for this ticket.",
    `Review summary: ${input.reviewSummary}`,
  ];

  if (input.validFeedback.length > 0) {
    lines.push("", "Valid feedback that must be addressed before landing:");
    for (const feedback of input.validFeedback) {
      lines.push(`- ${feedback.comment}`);
    }
  }

  if (input.validationCommands.length > 0) {
    lines.push("", "Mandatory validation commands to satisfy before handing back:");
    for (const command of input.validationCommands) {
      lines.push(`- ${command}`);
    }
  }

  lines.push(
    "",
    "Rules:",
    "- Stay scoped to the ticket intent and the listed valid review feedback.",
    "- Ignore reviewer comments that are not in the valid-feedback list.",
    "- Keep commits focused; commit follow-up fixes on the current branch.",
    "- Re-run the required validation commands until they pass.",
    "- Do not reopen the ticket unless absolutely necessary.",
    "- If you create any commits, run `bw sync` before exiting.",
    "- If blocked, explain the blocker clearly and exit.",
  );

  return lines.join("\n");
}

async function gatherReviewArtifacts(input: {
  workerHead: string;
  repoHead: string;
  worktreePath: string;
  maxArtifactChars: number;
  runner: ProcessRunner;
}): Promise<{ commitSummary: string; diffStat: string; diff: string }> {
  const safeRun = async (args: string[]): Promise<string> => {
    try {
      const result = await input.runner("git", args, {
        cwd: input.worktreePath,
        timeout: 60_000,
      });
      return result.stdout.trim();
    } catch (error) {
      return `[unavailable: ${humanizeError(error)}]`;
    }
  };

  const [commitSummaryRaw, diffStatRaw, diffRaw] = await Promise.all([
    safeRun(["log", "--no-color", "--oneline", `${input.repoHead}..${input.workerHead}`]),
    safeRun(["diff", "--no-color", "--stat", `${input.repoHead}...${input.workerHead}`]),
    safeRun(["diff", "--no-color", `${input.repoHead}...${input.workerHead}`]),
  ]);

  const maxChars = Math.max(2_000, input.maxArtifactChars);
  const maxDiffChars = Math.max(1_000, Math.floor(maxChars * 0.65));

  return {
    commitSummary: truncateForPrompt(commitSummaryRaw, Math.floor(maxChars * 0.2)),
    diffStat: truncateForPrompt(diffStatRaw, Math.floor(maxChars * 0.2)),
    diff: truncateForPrompt(diffRaw, maxDiffChars),
  };
}

function buildReviewerPrompt(input: {
  worker: WorktreeWorkerRuntime;
  ticket: BeadworkIssueDetail;
  epic?: BeadworkIssueDetail;
  artifacts: { commitSummary: string; diffStat: string; diff: string };
  validationCommands: string[];
}): string {
  const lines = [
    "You are a reviewer agent performing a merge-back gate for delegated beadwork work.",
    "Review like a normal exploratory coding agent: inspect code, compare the diff to ticket intent, check downstream usage, and run commands in the worktree as needed.",
    "Do not edit files, but normal tools/extensions/skills are available and expected when they help you verify the change.",
    "",
    "Finish with a machine-readable handoff enclosed in <review_report> tags:",
    "<review_report>",
    "{",
    '  "verdict": "APPROVE" | "APPROVE WITH NITS" | "REQUEST CHANGES",',
    '  "summary": "short summary",',
    '  "findings": [',
    '    { "comment": "text", "intentAlignment": "aligned" | "unclear" | "misaligned", "requiresChanges": true | false }',
    "  ]",
    "}",
    "</review_report>",
    "",
    `Ticket: ${input.ticket.id} ${input.ticket.title}`,
    `Branch: ${input.worker.branchName}`,
    `Worktree: ${input.worker.worktreePath}`,
  ];

  if (input.epic) {
    lines.push(`Epic: ${input.epic.id} ${input.epic.title}`);
  }

  if (input.ticket.description.trim()) {
    lines.push("", "Ticket context:", truncateForPrompt(input.ticket.description, 2_500));
  }

  if (input.epic?.description.trim()) {
    lines.push("", "Epic context:", truncateForPrompt(input.epic.description, 2_500));
  }

  if (input.validationCommands.length > 0) {
    lines.push("", "Mandatory validation commands for this review:");
    for (const command of input.validationCommands) {
      lines.push(`- ${command}`);
    }
  }

  lines.push(
    "",
    "Worker commits (repo HEAD..worker HEAD):",
    input.artifacts.commitSummary || "[none]",
    "",
    "Diff stat:",
    input.artifacts.diffStat || "[none]",
    "",
    "Unified diff excerpt:",
    input.artifacts.diff || "[none]",
    "",
    "Review rules:",
    "- Validation is mandatory: run or otherwise verify the listed commands before you finalize the report, and call out blockers clearly in the summary if validation cannot complete.",
    "- The coordinator will independently filter your findings against ticket intent, so mark out-of-scope comments with intentAlignment=misaligned instead of inflating the verdict.",
    "- Only use REQUEST CHANGES for real blockers that are relevant to this ticket's intent or required validation.",
    "- For minor polish that should not block landing, use verdict=APPROVE WITH NITS and requiresChanges=false.",
    "- Always end with exactly one <review_report> block so the coordinator can parse your handoff.",
  );

  return lines.join("\n");
}

async function runReviewerPass(input: {
  cwd: string;
  worker: WorktreeWorkerRuntime;
  config: BeadworkConfig;
  adapter: BeadworkAdapter;
  repoHead: string;
  workerHead: string;
  runner: ProcessRunner;
}): Promise<{
  checkedAt: string;
  decision: ReviewerDecision;
  assessment: ReviewerAssessment;
  reviewLogFile: string;
}> {
  const ticket = await input.adapter.show(input.cwd, input.worker.ticketId);
  const epic = ticket.parentId ? await input.adapter.show(input.cwd, ticket.parentId) : undefined;
  const artifacts = await gatherReviewArtifacts({
    repoHead: input.repoHead,
    workerHead: input.workerHead,
    worktreePath: input.worker.worktreePath,
    maxArtifactChars: input.config.landing.review.maxArtifactChars,
    runner: input.runner,
  });

  const prompt = buildReviewerPrompt({
    worker: input.worker,
    ticket,
    epic,
    artifacts,
    validationCommands: input.config.landing.validateCommands,
  });
  const promptFile = path.join(input.worker.runtimeDir, "review-handoff.txt");
  const reviewLogFile = resolveReviewerLogFile(input.worker);
  await writeFile(promptFile, `${prompt}\n`, "utf8");

  await writeFile(reviewLogFile, "", { flag: "a" });
  const reviewLog = createWriteStream(reviewLogFile, { flags: "a", encoding: "utf8" });
  let sawStdout = false;
  let sawStderr = false;
  reviewLog.write(
    `[beadwork reviewer] started ${new Date().toISOString()}\n` +
      `[beadwork reviewer] cwd: ${input.worker.worktreePath}\n` +
      `[beadwork reviewer] handoff: ${promptFile}\n`,
  );

  const reviewerCommand = buildReviewerAgentCommand(input.config, input.worker);
  const reviewerInvocation = `${reviewerCommand} "$(cat ${shellQuote(promptFile)})"`;
  reviewLog.write(`[beadwork reviewer] command: ${reviewerInvocation}\n`);

  let reviewResult: Awaited<ReturnType<ProcessRunner>>;
  try {
    reviewResult = await input.runner("bash", ["-lc", reviewerInvocation], {
      cwd: input.worker.worktreePath,
      timeout: input.config.landing.review.commandTimeoutMs,
      onStdoutChunk: (chunk) => {
        if (!sawStdout) {
          sawStdout = true;
          reviewLog.write("[beadwork reviewer stdout]\n");
        }
        reviewLog.write(chunk);
      },
      onStderrChunk: (chunk) => {
        if (!sawStderr) {
          sawStderr = true;
          reviewLog.write("[beadwork reviewer stderr]\n");
        }
        reviewLog.write(chunk);
      },
    });
  } catch (error) {
    reviewLog.write(`\n[beadwork reviewer] failed ${new Date().toISOString()}\n`);
    await new Promise<void>((resolve) => {
      reviewLog.end(resolve);
    });
    throw error;
  }

  reviewLog.write(`\n[beadwork reviewer] finished ${new Date().toISOString()}\n`);
  await new Promise<void>((resolve) => {
    reviewLog.end(resolve);
  });

  const rawOutput = `${reviewResult.stdout}\n${reviewResult.stderr}`;
  const decision = normalizeReviewerDecision(rawOutput);
  const assessment = assessReviewerFeedback({ decision, ticket, epic });

  return {
    checkedAt: new Date().toISOString(),
    decision,
    assessment,
    reviewLogFile,
  };
}

async function relaunchWorkerForValidationFailure(input: {
  worker: WorktreeWorkerRuntime;
  config: BeadworkConfig;
  tmuxBackend: TmuxBackend;
  validationDetail: string;
}): Promise<WorkerRuntime> {
  const remediationAttempt = (input.worker.remediationAttempts ?? 0) + 1;
  const remediationPrompt = buildValidationRemediationPrompt({
    worker: input.worker,
    validationDetail: input.validationDetail,
    validationCommands: input.config.landing.validateCommands,
  });
  const workerAgentCommand = buildWorkerAgentCommand(input.config, input.worker);

  await writeFile(input.worker.promptFile, `${remediationPrompt}\n`, "utf8");
  await writeFile(
    input.worker.scriptFile,
    buildWorkerScript({
      workerAgentCommand,
      promptFile: input.worker.promptFile,
      logFile: input.worker.logFile,
      stateFile: input.worker.stateFile,
      exitCodeFile: input.worker.exitCodeFile,
      finishedAtFile: input.worker.finishedAtFile,
    }),
    "utf8",
  );
  await chmod(input.worker.scriptFile, 0o755);
  await writeFile(input.worker.stateFile, "launching\n", "utf8");
  await writeFile(input.worker.exitCodeFile, "", "utf8");
  await writeFile(input.worker.finishedAtFile, "", "utf8");

  try {
    await input.tmuxBackend.cleanupWorker({
      paneId: input.worker.tmuxPane !== "pending" ? input.worker.tmuxPane : undefined,
      sessionName: input.worker.tmuxSession,
      windowName: input.worker.tmuxWindow,
    });
  } catch {
    // best-effort cleanup in case the previous tmux window is still hanging around
  }

  await input.tmuxBackend.ensureSession({ sessionName: input.worker.tmuxSession });
  const launched = await input.tmuxBackend.launchWorker({
    sessionName: input.worker.tmuxSession,
    workerId: input.worker.workerId,
    title: input.worker.ticketTitle,
    worktreePath: input.worker.worktreePath,
    launchCommand: input.worker.launchCommand,
  });

  const now = new Date().toISOString();
  return {
    ...input.worker,
    tmuxSession: launched.sessionName,
    tmuxWindow: launched.windowName,
    tmuxPane: launched.paneId,
    launchCommand: launched.launchCommand,
    workerCommand: input.worker.workerCommand,
    workerProvider: input.worker.workerProvider,
    workerModel: input.worker.workerModel,
    status: "running",
    validationStatus: "pending",
    validationAt: now,
    validationSummary: `Automatic remediation attempt ${remediationAttempt} started after validation failed: ${input.validationDetail}`,
    remediationStatus: "running",
    remediationAttempts: remediationAttempt,
    remediationAt: now,
    remediationSummary: `Automatic remediation attempt ${remediationAttempt}/${MAX_VALIDATION_REMEDIATION_ATTEMPTS} is running in the existing worktree.`,
    reviewedWorkerHead: undefined,
    landingVerifiedAt: undefined,
    landingVerification: `Validation failed; remediation attempt ${remediationAttempt}/${MAX_VALIDATION_REMEDIATION_ATTEMPTS} is running.`,
    lastError: undefined,
    finishedAt: undefined,
    updatedAt: now,
  };
}

async function relaunchWorkerForLandingFailure(input: {
  worker: WorktreeWorkerRuntime;
  config: BeadworkConfig;
  tmuxBackend: TmuxBackend;
  rebaseDetail: string;
}): Promise<WorkerRuntime> {
  const remediationAttempt = (input.worker.landingRemediationAttempts ?? 0) + 1;
  const remediationPrompt = buildLandingRemediationPrompt({
    worker: input.worker,
    rebaseDetail: input.rebaseDetail,
    validationCommands: input.config.landing.validateCommands,
  });
  const workerAgentCommand = buildWorkerAgentCommand(input.config, input.worker);

  await writeFile(input.worker.promptFile, `${remediationPrompt}\n`, "utf8");
  await writeFile(
    input.worker.scriptFile,
    buildWorkerScript({
      workerAgentCommand,
      promptFile: input.worker.promptFile,
      logFile: input.worker.logFile,
      stateFile: input.worker.stateFile,
      exitCodeFile: input.worker.exitCodeFile,
      finishedAtFile: input.worker.finishedAtFile,
    }),
    "utf8",
  );
  await chmod(input.worker.scriptFile, 0o755);
  await writeFile(input.worker.stateFile, "launching\n", "utf8");
  await writeFile(input.worker.exitCodeFile, "", "utf8");
  await writeFile(input.worker.finishedAtFile, "", "utf8");

  try {
    await input.tmuxBackend.cleanupWorker({
      paneId: input.worker.tmuxPane !== "pending" ? input.worker.tmuxPane : undefined,
      sessionName: input.worker.tmuxSession,
      windowName: input.worker.tmuxWindow,
    });
  } catch {
    // best-effort cleanup in case the previous tmux window is still hanging around
  }

  await input.tmuxBackend.ensureSession({ sessionName: input.worker.tmuxSession });
  const launched = await input.tmuxBackend.launchWorker({
    sessionName: input.worker.tmuxSession,
    workerId: input.worker.workerId,
    title: input.worker.ticketTitle,
    worktreePath: input.worker.worktreePath,
    launchCommand: input.worker.launchCommand,
  });

  const now = new Date().toISOString();
  return {
    ...input.worker,
    tmuxSession: launched.sessionName,
    tmuxWindow: launched.windowName,
    tmuxPane: launched.paneId,
    launchCommand: launched.launchCommand,
    workerCommand: input.worker.workerCommand,
    workerProvider: input.worker.workerProvider,
    workerModel: input.worker.workerModel,
    status: "running",
    validationStatus: input.config.landing.validateCommands.length > 0 ? "pending" : undefined,
    validationAt: input.config.landing.validateCommands.length > 0 ? now : undefined,
    validationSummary:
      input.config.landing.validateCommands.length > 0
        ? `Landing remediation attempt ${remediationAttempt} started after a rebase failure.`
        : undefined,
    reviewStatus: input.config.landing.review.enabled ? "pending" : undefined,
    reviewVerdict: undefined,
    reviewAt: undefined,
    reviewSummary: input.config.landing.review.enabled
      ? "Review will rerun after the landing remediation worker exits."
      : undefined,
    reviewFeedback: undefined,
    reviewValidFeedbackCount: undefined,
    reviewInvalidFeedbackCount: undefined,
    reviewedWorkerHead: undefined,
    landingRemediationAttempts: remediationAttempt,
    landingRemediationAt: now,
    landingRemediationSummary:
      `Automatic landing remediation attempt ${remediationAttempt}/` +
      `${MAX_LANDING_REMEDIATION_ATTEMPTS} is running after a rebase failure.`,
    landingVerifiedAt: undefined,
    landingVerification:
      `Rebase failed before landing; remediation attempt ${remediationAttempt}/` +
      `${MAX_LANDING_REMEDIATION_ATTEMPTS} is running in the existing worktree.`,
    lastError: undefined,
    finishedAt: undefined,
    updatedAt: now,
  };
}

async function relaunchWorkerForReviewFeedback(input: {
  worker: WorktreeWorkerRuntime;
  config: BeadworkConfig;
  tmuxBackend: TmuxBackend;
  reviewSummary: string;
  validFeedback: ReviewFeedbackItem[];
}): Promise<WorkerRuntime> {
  const remediationAttempt = (input.worker.reviewRemediationAttempts ?? 0) + 1;
  const remediationPrompt = buildReviewRemediationPrompt({
    worker: input.worker,
    reviewSummary: input.reviewSummary,
    validFeedback: input.validFeedback,
    validationCommands: input.config.landing.validateCommands,
  });
  const workerAgentCommand = buildWorkerAgentCommand(input.config, input.worker);
  const reviewerAgent = resolveReviewerAgentSettings(input.config, input.worker);

  await writeFile(input.worker.promptFile, `${remediationPrompt}\n`, "utf8");
  await writeFile(
    input.worker.scriptFile,
    buildWorkerScript({
      workerAgentCommand,
      promptFile: input.worker.promptFile,
      logFile: input.worker.logFile,
      stateFile: input.worker.stateFile,
      exitCodeFile: input.worker.exitCodeFile,
      finishedAtFile: input.worker.finishedAtFile,
    }),
    "utf8",
  );
  await chmod(input.worker.scriptFile, 0o755);
  await writeFile(input.worker.stateFile, "launching\n", "utf8");
  await writeFile(input.worker.exitCodeFile, "", "utf8");
  await writeFile(input.worker.finishedAtFile, "", "utf8");

  try {
    await input.tmuxBackend.cleanupWorker({
      paneId: input.worker.tmuxPane !== "pending" ? input.worker.tmuxPane : undefined,
      sessionName: input.worker.tmuxSession,
      windowName: input.worker.tmuxWindow,
    });
  } catch {
    // best-effort cleanup in case the previous tmux window is still hanging around
  }

  await input.tmuxBackend.ensureSession({ sessionName: input.worker.tmuxSession });
  const launched = await input.tmuxBackend.launchWorker({
    sessionName: input.worker.tmuxSession,
    workerId: input.worker.workerId,
    title: input.worker.ticketTitle,
    worktreePath: input.worker.worktreePath,
    launchCommand: input.worker.launchCommand,
  });

  const now = new Date().toISOString();
  return {
    ...input.worker,
    tmuxSession: launched.sessionName,
    tmuxWindow: launched.windowName,
    tmuxPane: launched.paneId,
    launchCommand: launched.launchCommand,
    workerCommand: input.worker.workerCommand,
    workerProvider: input.worker.workerProvider,
    workerModel: input.worker.workerModel,
    reviewerProvider: reviewerAgent.workerProvider,
    reviewerModel: reviewerAgent.workerModel,
    status: "running",
    validationStatus: "pending",
    validationAt: now,
    validationSummary: `Review remediation attempt ${remediationAttempt} started after reviewer requested changes.`,
    reviewStatus: "remediation-in-progress",
    reviewVerdict: "request-changes",
    reviewAt: now,
    reviewSummary: input.reviewSummary,
    reviewFeedback: input.validFeedback.map((feedback) => feedback.comment),
    reviewValidFeedbackCount: input.validFeedback.length,
    reviewInvalidFeedbackCount: input.worker.reviewInvalidFeedbackCount,
    reviewedWorkerHead: undefined,
    reviewRemediationAttempts: remediationAttempt,
    reviewRemediationAt: now,
    landingVerifiedAt: undefined,
    landingVerification:
      `Review requested changes; remediation attempt ${remediationAttempt}/` +
      `${Math.max(1, input.config.landing.review.maxRemediationAttempts)} is running.`,
    lastError: undefined,
    finishedAt: undefined,
    updatedAt: now,
  };
}

async function cleanupLandedWorker(input: {
  repoRoot: string;
  worker: WorktreeWorkerRuntime;
  runtimeRoot: string;
  tmuxBackend: TmuxBackend;
  runner: ProcessRunner;
}): Promise<Pick<WorkerRuntime, "cleanupStatus" | "cleanupAt" | "lastError">> {
  try {
    await input.tmuxBackend.cleanupWorker({
      paneId: input.worker.tmuxPane !== "pending" ? input.worker.tmuxPane : undefined,
      sessionName: input.worker.tmuxSession,
      windowName: input.worker.tmuxWindow,
    });
    await cleanupTicketWorktree({
      repoRoot: input.repoRoot,
      worktreePath: input.worker.worktreePath,
      runtimeDir: input.worker.runtimeDir,
      runtimeRoot: input.runtimeRoot,
      runner: input.runner,
    });
    return {
      cleanupStatus: "cleaned",
      cleanupAt: new Date().toISOString(),
      lastError: undefined,
    };
  } catch (error) {
    return {
      cleanupStatus: "failed",
      cleanupAt: undefined,
      lastError: `Landing verified, but cleanup failed: ${humanizeError(error)}`,
    };
  }
}

function buildAttentionState<T extends WorkerRuntime>(
  worker: T,
  detail: string,
  overrides: Partial<T> = {},
): T {
  return {
    ...worker,
    ...overrides,
    status: "attention",
    landingRequestedAt: overrides.landingRequestedAt,
    landingVerification: overrides.landingVerification ?? detail,
    lastError: detail,
    updatedAt: new Date().toISOString(),
  } as T;
}

async function withEpicRunLaunchLock<T>(lockKey: string, task: () => Promise<T>): Promise<T> {
  const previous = (epicRunLaunchLocks.get(lockKey) ?? Promise.resolve()).catch(() => undefined);
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  epicRunLaunchLocks.set(lockKey, queued);

  await previous;

  try {
    return await task();
  } finally {
    release?.();
    if (epicRunLaunchLocks.get(lockKey) === queued) {
      epicRunLaunchLocks.delete(lockKey);
    }
  }
}

async function launchReadyWorkersWithinConcurrencyLimit(input: {
  cwd: string;
  repoRoot: string;
  registryPath: string;
  config: BeadworkConfig;
  adapter: BeadworkAdapter;
  epicId: string;
  ready: BeadworkIssue[];
  maxWorkers: number;
  prime?: string;
  tmuxBackend: TmuxBackend;
  processRunner?: ProcessRunner;
}): Promise<RunLaunchLockResult> {
  const lockKey = `${input.registryPath}::${input.epicId}`;

  return withEpicRunLaunchLock(lockKey, async () => {
    const launchedThisCycle: string[] = [];
    const launchNotices: string[] = [];
    let workers = (await loadWorkerRegistry(input.registryPath)).filter(
      (worker) => worker.epicId === input.epicId,
    );
    const attemptedTicketIds = new Set(workers.map((worker) => worker.ticketId));
    const activeWorkers = workers.filter(
      (worker) => worker.status === "launching" || worker.status === "running",
    );
    const launchable = input.ready.filter(
      (issue) => !attemptedTicketIds.has(issue.id) && issue.type !== "epic",
    );
    const availableSlots = Math.max(0, input.maxWorkers - activeWorkers.length);

    for (const issue of launchable.slice(0, availableSlots)) {
      const worker = await launchTicketWorker({
        cwd: input.cwd,
        repoRoot: input.repoRoot,
        config: input.config,
        adapter: input.adapter,
        ticketId: issue.id,
        epicId: input.epicId,
        prime: input.prime,
        tmuxBackend: input.tmuxBackend,
        processRunner: input.processRunner,
      });
      launchedThisCycle.push(worker.ticketId);
      launchNotices.push(buildRunLaunchNotice(worker));
    }

    workers = (await loadWorkerRegistry(input.registryPath)).filter(
      (worker) => worker.epicId === input.epicId,
    );

    return {
      workers,
      launchable,
      launchedThisCycle,
      launchNotices,
    };
  });
}

function resolveLandingPolicy(config: BeadworkConfig, worker: WorkerRuntime): "auto" | "deferred" {
  return worker.landingPolicy ?? config.landing.policy;
}

function buildDeferredHoldDetail(worker: WorkerRuntime): string {
  const aheadCount = worker.landingAheadCount ?? 0;
  const behindCount = worker.landingBehindCount ?? 0;

  const reviewDetail =
    worker.reviewStatus === "approved"
      ? " Reviewer approved."
      : worker.reviewStatus === "nits-only"
        ? " Reviewer approved with non-blocking nits."
        : "";

  if (aheadCount > 0 && behindCount > 0) {
    return (
      `Validated and held. Landing needs refresh before merge-back (ahead=${aheadCount}, behind=${behindCount}).` +
      reviewDetail
    );
  }

  if (aheadCount > 0) {
    return (
      `Validated and held. Ready to land on explicit request (ahead=${aheadCount}, behind=${behindCount}).` +
      reviewDetail
    );
  }

  return `Validated and held. Waiting for an explicit landing request.${reviewDetail}`;
}

function buildQueuedLandingRequestState(
  worker: WorkerRuntime,
  config: BeadworkConfig,
): WorkerRuntime {
  const now = new Date().toISOString();
  const ticketClosed = worker.ticketStatus === "closed";
  const reviewLogFile = resolveReviewerLogFile(worker);
  const validationRequired = config.landing.validateCommands.length > 0;
  const reviewEnabled = config.landing.review.enabled;
  const preserveApprovedReview = reviewEnabled && hasReusableApprovedReview(worker);

  const queuedDetail = ticketClosed
    ? reviewEnabled
      ? preserveApprovedReview
        ? "Explicit landing request queued. Background supervision will rerun validation and merge-back while reusing the previously approved reviewer result."
        : `Explicit landing request queued. Background supervision will rerun validation, reviewer gating, and merge-back. Reviewer output will stream to ${reviewLogFile} once it starts.`
      : "Explicit landing request queued. Background supervision will rerun validation and merge-back in the background."
    : "Explicit landing request queued. Landing will continue after the worker exits and the ticket closes.";

  return {
    ...worker,
    status:
      worker.status === "launching" || worker.status === "running"
        ? worker.status
        : worker.status === "held"
          ? "held"
          : "exited",
    landingRequestedAt: now,
    landingVerifiedAt: undefined,
    landingVerification: queuedDetail,
    validationStatus: validationRequired ? "pending" : worker.validationStatus,
    validationAt: validationRequired ? now : worker.validationAt,
    validationSummary: validationRequired ? queuedDetail : worker.validationSummary,
    remediationStatus: undefined,
    remediationAttempts: worker.remediationAttempts,
    remediationAt: undefined,
    remediationSummary: undefined,
    reviewStatus: reviewEnabled
      ? preserveApprovedReview
        ? worker.reviewStatus
        : "pending"
      : undefined,
    reviewVerdict: reviewEnabled
      ? preserveApprovedReview
        ? worker.reviewVerdict
        : undefined
      : undefined,
    reviewAt: reviewEnabled ? (preserveApprovedReview ? worker.reviewAt : now) : undefined,
    reviewSummary: reviewEnabled
      ? preserveApprovedReview
        ? worker.reviewSummary
        : queuedDetail
      : undefined,
    reviewFeedback: reviewEnabled
      ? preserveApprovedReview
        ? worker.reviewFeedback
        : undefined
      : undefined,
    reviewValidFeedbackCount: reviewEnabled
      ? preserveApprovedReview
        ? worker.reviewValidFeedbackCount
        : undefined
      : undefined,
    reviewInvalidFeedbackCount: reviewEnabled
      ? preserveApprovedReview
        ? worker.reviewInvalidFeedbackCount
        : undefined
      : undefined,
    reviewedWorkerHead: preserveApprovedReview ? worker.reviewedWorkerHead : undefined,
    reviewRemediationAt: undefined,
    cleanupStatus:
      worker.cleanupPolicy === "cleanup-after-landing" ? "pending" : worker.cleanupStatus,
    cleanupAt: undefined,
    lastError: undefined,
    updatedAt: now,
  };
}

async function finalizeLandedWorker(input: {
  repoRoot: string;
  worker: WorktreeWorkerRuntime;
  runtimeRoot: string;
  verifiedAt: string;
  tmuxBackend: TmuxBackend;
  runner: ProcessRunner;
}): Promise<WorkerRuntime> {
  const landedWorker: WorktreeWorkerRuntime = {
    ...input.worker,
    status: "landed",
    landingVerifiedAt: input.verifiedAt,
    landingHeldAt: undefined,
    landingRequestedAt: undefined,
    lastError: undefined,
    updatedAt: new Date().toISOString(),
  };

  if (
    landedWorker.cleanupPolicy === "cleanup-after-landing" &&
    landedWorker.cleanupStatus !== "cleaned"
  ) {
    await appendWorkerLog(
      landedWorker.logFile,
      "cleanup-after-landing is enabled; cleaning up tmux session and worktree",
    );
    const cleanup = await cleanupLandedWorker({
      repoRoot: input.repoRoot,
      worker: landedWorker,
      runtimeRoot: input.runtimeRoot,
      tmuxBackend: input.tmuxBackend,
      runner: input.runner,
    });
    return {
      ...landedWorker,
      cleanupStatus: cleanup.cleanupStatus,
      cleanupAt: cleanup.cleanupAt,
      lastError: cleanup.lastError,
      updatedAt: new Date().toISOString(),
    };
  }

  return landedWorker;
}

async function refreshDeferredHoldState(input: {
  repoRoot: string;
  worker: WorktreeWorkerRuntime;
  runtimeRoot: string;
  tmuxBackend: TmuxBackend;
  runner: ProcessRunner;
}): Promise<WorkerRuntime> {
  let landing: LandingVerificationResult;
  try {
    landing = await verifyWorktreeLanding({
      repoRoot: input.repoRoot,
      worktreePath: input.worker.worktreePath,
      ticketClosed: true,
      runner: input.runner,
    });
  } catch (error) {
    return buildAttentionState(
      input.worker,
      `Deferred landing verification failed: ${humanizeError(error)}`,
    );
  }

  let worker: WorktreeWorkerRuntime = {
    ...input.worker,
    landingVerification: landing.detail,
    landingAheadCount: landing.aheadCount,
    landingBehindCount: landing.behindCount,
    updatedAt: new Date().toISOString(),
  };

  if ((landing.cleanedTransientFiles?.length ?? 0) > 0) {
    await appendWorkerLog(
      worker.logFile,
      `cleaned transient worktree files before deferred landing verification: ${landing.cleanedTransientFiles?.join(", ")}`,
    );
  }

  if (landing.worktreeClean === false) {
    return buildAttentionState(worker, `Deferred landing needs attention: ${landing.detail}`);
  }

  if (landing.verified) {
    await appendWorkerLog(worker.logFile, "held worker is already integrated into repo HEAD");
    return finalizeLandedWorker({
      repoRoot: input.repoRoot,
      worker,
      runtimeRoot: input.runtimeRoot,
      verifiedAt: landing.checkedAt,
      tmuxBackend: input.tmuxBackend,
      runner: input.runner,
    });
  }

  worker = {
    ...worker,
    status: "held",
    landingHeldAt: worker.landingHeldAt ?? new Date().toISOString(),
    landingVerification: buildDeferredHoldDetail(worker),
    lastError: undefined,
    updatedAt: new Date().toISOString(),
  };

  return worker;
}

async function autoLandCompletedWorker(input: {
  cwd: string;
  repoRoot: string;
  worker: WorktreeWorkerRuntime;
  config: BeadworkConfig;
  adapter: BeadworkAdapter;
  tmuxBackend: TmuxBackend;
  runner: ProcessRunner;
  requestLanding?: boolean;
  onLifecycleEvent?: (event: WorkerLifecycleEvent) => Promise<void> | void;
  onWorkerUpdate?: (worker: WorkerRuntime) => void;
}): Promise<WorkerRuntime> {
  if (
    !input.requestLanding &&
    input.worker.status === "attention" &&
    ((input.worker.validationStatus === "failed" &&
      input.worker.remediationStatus === "exhausted") ||
      input.worker.reviewStatus === "review-blocked")
  ) {
    return {
      ...input.worker,
      updatedAt: new Date().toISOString(),
    };
  }

  const attempts = Math.max(1, input.config.landing.maxRebaseAttempts);
  const validationRequired = input.config.landing.validateCommands.length > 0;
  const landingPolicy = resolveLandingPolicy(input.config, input.worker);
  const deferLanding = landingPolicy === "deferred" && input.requestLanding !== true;

  if (deferLanding && input.worker.status === "held") {
    return refreshDeferredHoldState({
      repoRoot: input.repoRoot,
      worker: {
        ...input.worker,
        landingPolicy,
      },
      runtimeRoot: resolveWorkerRuntimeDir(input.repoRoot, input.config.storage.runtimeDir),
      tmuxBackend: input.tmuxBackend,
      runner: input.runner,
    });
  }

  const reviewerAgent = resolveReviewerAgentSettings(input.config, input.worker);
  let worker: WorktreeWorkerRuntime = {
    ...input.worker,
    landingPolicy,
    reviewerProvider: reviewerAgent.workerProvider,
    reviewerModel: reviewerAgent.workerModel,
    landingRequestedAt: input.requestLanding
      ? new Date().toISOString()
      : input.worker.landingRequestedAt,
    validationStatus: validationRequired ? (input.worker.validationStatus ?? "pending") : undefined,
    reviewStatus: input.config.landing.review.enabled
      ? (input.worker.reviewStatus ?? "pending")
      : input.worker.reviewStatus,
  };
  const updateWorker = (nextWorker: WorktreeWorkerRuntime): WorktreeWorkerRuntime => {
    worker = nextWorker;
    input.onWorkerUpdate?.(worker);
    return worker;
  };

  updateWorker(worker);

  if (input.requestLanding) {
    await appendWorkerLog(worker.logFile, `explicit landing requested for ${worker.ticketId}`);
  } else if (
    input.worker.status !== "attention" &&
    input.worker.status !== "landed" &&
    input.worker.status !== "held"
  ) {
    await appendWorkerLog(
      worker.logFile,
      `starting post-worker validation and landing checks for ${worker.ticketId}`,
    );
    await input.onLifecycleEvent?.({
      type: "post-exit-started",
      ticketId: worker.ticketId,
      message: `Delegated ticket ${worker.ticketId} exited. Starting validation and merge-back checks.`,
    });
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let landing: LandingVerificationResult;
    try {
      await appendWorkerLog(
        worker.logFile,
        `checking landing state (attempt ${attempt}/${attempts})`,
      );
      landing = await verifyWorktreeLanding({
        repoRoot: input.repoRoot,
        worktreePath: input.worker.worktreePath,
        ticketClosed: true,
        runner: input.runner,
      });
    } catch (error) {
      return buildAttentionState(worker, `Landing verification failed: ${humanizeError(error)}`, {
        validationStatus: worker.validationStatus,
        validationAt: worker.validationAt,
        validationSummary: worker.validationSummary,
      });
    }

    worker = {
      ...worker,
      landingVerification: landing.detail,
      landingAheadCount: landing.aheadCount,
      landingBehindCount: landing.behindCount,
      updatedAt: new Date().toISOString(),
    };

    if ((landing.cleanedTransientFiles?.length ?? 0) > 0) {
      await appendWorkerLog(
        worker.logFile,
        `cleaned transient worktree files before landing verification: ${landing.cleanedTransientFiles?.join(", ")}`,
      );
    }

    if (landing.worktreeClean === false) {
      return buildAttentionState(worker, landing.detail);
    }

    if ((landing.aheadCount ?? 0) > 0 && (landing.behindCount ?? 0) > 0) {
      await appendWorkerLog(
        worker.logFile,
        "repo head moved; attempting to rebase worker worktree",
      );
      const rebase = await rebaseWorktreeOntoRepoHead({
        repoRoot: input.repoRoot,
        worktreePath: input.worker.worktreePath,
        runner: input.runner,
      });

      worker = {
        ...worker,
        landingVerification: rebase.detail,
        landingAheadCount: rebase.aheadCount,
        landingBehindCount: rebase.behindCount,
        updatedAt: new Date().toISOString(),
      };

      if (!rebase.rebased) {
        const remediationAttempt = worker.landingRemediationAttempts ?? 0;
        if (remediationAttempt < MAX_LANDING_REMEDIATION_ATTEMPTS) {
          await appendWorkerLog(
            worker.logFile,
            "rebase failed; launching automatic landing remediation in the existing worktree",
          );
          await input.onLifecycleEvent?.({
            type: "remediation-started",
            ticketId: worker.ticketId,
            message:
              `Landing rebase failed for delegated ticket ${worker.ticketId}. ` +
              `Launching remediation attempt ${remediationAttempt + 1}/${MAX_LANDING_REMEDIATION_ATTEMPTS} in the existing worktree.`,
          });

          try {
            return await relaunchWorkerForLandingFailure({
              worker,
              config: input.config,
              tmuxBackend: input.tmuxBackend,
              rebaseDetail: rebase.detail,
            });
          } catch (error) {
            return buildAttentionState(
              {
                ...worker,
                landingRemediationAttempts: remediationAttempt + 1,
                landingRemediationAt: new Date().toISOString(),
                landingRemediationSummary:
                  `Failed to launch landing remediation attempt ${remediationAttempt + 1}: ` +
                  humanizeError(error),
                reviewedWorkerHead: undefined,
              },
              `Landing rebase failed and remediation could not be started: ${humanizeError(error)}`,
            );
          }
        }

        return buildAttentionState(worker, rebase.detail, {
          landingRemediationAttempts: remediationAttempt,
          landingRemediationAt: new Date().toISOString(),
          landingRemediationSummary:
            remediationAttempt > 0
              ? `Automatic landing remediation was attempted ${remediationAttempt} time(s) and did not produce a merge-ready branch.`
              : "Automatic landing remediation was not attempted.",
        });
      }
    }

    if (validationRequired) {
      await appendWorkerLog(
        worker.logFile,
        "running configured validation commands before landing",
      );
      const validation = await runWorktreeValidation({
        worktreePath: input.worker.worktreePath,
        commands: input.config.landing.validateCommands,
        timeoutMs: input.config.landing.commandTimeoutMs,
        runner: input.runner,
      });

      worker = {
        ...worker,
        validationStatus: validation.passed ? "passed" : "failed",
        validationAt: validation.checkedAt,
        validationSummary: validation.detail,
        remediationStatus: validation.passed ? undefined : worker.remediationStatus,
        remediationSummary: validation.passed ? undefined : worker.remediationSummary,
        updatedAt: new Date().toISOString(),
      };

      await appendWorkerLog(
        worker.logFile,
        validation.passed ? "validation passed" : `validation failed: ${validation.detail}`,
      );

      if (!validation.passed) {
        const remediationAttempt = worker.remediationAttempts ?? 0;
        if (remediationAttempt < MAX_VALIDATION_REMEDIATION_ATTEMPTS) {
          await appendWorkerLog(
            worker.logFile,
            `validation failed; launching automatic remediation attempt ${remediationAttempt + 1}/${MAX_VALIDATION_REMEDIATION_ATTEMPTS}`,
          );
          await input.onLifecycleEvent?.({
            type: "remediation-started",
            ticketId: worker.ticketId,
            message:
              `Validation failed for delegated ticket ${worker.ticketId}. ` +
              `Launching remediation attempt ${remediationAttempt + 1}/${MAX_VALIDATION_REMEDIATION_ATTEMPTS} in the existing worktree.`,
          });

          try {
            return await relaunchWorkerForValidationFailure({
              worker: {
                ...worker,
                validationStatus: "failed",
                validationAt: validation.checkedAt,
                validationSummary: validation.detail,
              },
              config: input.config,
              tmuxBackend: input.tmuxBackend,
              validationDetail: validation.detail,
            });
          } catch (error) {
            return buildAttentionState(
              {
                ...worker,
                remediationAttempts: remediationAttempt + 1,
                remediationStatus: "failed",
                remediationAt: new Date().toISOString(),
                remediationSummary: `Failed to launch remediation attempt ${remediationAttempt + 1}: ${humanizeError(error)}`,
              },
              `Validation failed and remediation could not be started: ${humanizeError(error)}`,
              {
                validationStatus: "failed",
                validationAt: validation.checkedAt,
                validationSummary: validation.detail,
                landingVerification: `Landing blocked after validation failure. ${validation.detail}`,
              },
            );
          }
        }

        return buildAttentionState(worker, validation.detail, {
          validationStatus: "failed",
          validationAt: validation.checkedAt,
          validationSummary: validation.detail,
          remediationAttempts: remediationAttempt,
          remediationStatus: "exhausted",
          remediationAt: new Date().toISOString(),
          remediationSummary:
            remediationAttempt > 0
              ? `Automatic remediation was attempted ${remediationAttempt} time(s) and did not produce a passing validation result.`
              : "Automatic remediation was not attempted.",
          landingVerification: `Landing blocked after validation failure. ${validation.detail}`,
        });
      }
    }

    await appendWorkerLog(worker.logFile, "rechecking landing state after validation");
    const postValidationLanding = await verifyWorktreeLanding({
      repoRoot: input.repoRoot,
      worktreePath: input.worker.worktreePath,
      ticketClosed: true,
      runner: input.runner,
    });

    worker = {
      ...worker,
      landingVerification: postValidationLanding.detail,
      landingAheadCount: postValidationLanding.aheadCount,
      landingBehindCount: postValidationLanding.behindCount,
      updatedAt: new Date().toISOString(),
    };

    if ((postValidationLanding.cleanedTransientFiles?.length ?? 0) > 0) {
      await appendWorkerLog(
        worker.logFile,
        `cleaned transient worktree files after validation: ${postValidationLanding.cleanedTransientFiles?.join(", ")}`,
      );
    }

    if (postValidationLanding.worktreeClean === false) {
      return buildAttentionState(worker, postValidationLanding.detail);
    }

    if (postValidationLanding.verified) {
      await appendWorkerLog(
        worker.logFile,
        "worker changes are already integrated into the repo branch",
      );
      return finalizeLandedWorker({
        repoRoot: input.repoRoot,
        worker,
        runtimeRoot: resolveWorkerRuntimeDir(input.repoRoot, input.config.storage.runtimeDir),
        verifiedAt: postValidationLanding.checkedAt,
        tmuxBackend: input.tmuxBackend,
        runner: input.runner,
      });
    }

    const reuseApprovedReview = canReuseApprovedReview(worker, postValidationLanding.workerHead);
    if (input.config.landing.review.enabled && (postValidationLanding.aheadCount ?? 0) > 0) {
      if (reuseApprovedReview) {
        await appendWorkerLog(
          worker.logFile,
          `reusing approved reviewer result for worker HEAD ${postValidationLanding.workerHead}`,
        );
      } else {
        const reviewLogFile = resolveReviewerLogFile(worker);
        worker = updateWorker({
          ...worker,
          reviewStatus: "pending",
          reviewAt: new Date().toISOString(),
          reviewSummary: `Reviewer gate is running before merge-back. See ${reviewLogFile} for live output.`,
          landingVerification: `Running reviewer-agent gate before landing. See ${reviewLogFile} for live output.`,
          reviewedWorkerHead: undefined,
          updatedAt: new Date().toISOString(),
        });
        await appendWorkerLog(
          worker.logFile,
          `running reviewer-agent gating pass before landing (log: ${reviewLogFile})`,
        );

        let reviewPass: Awaited<ReturnType<typeof runReviewerPass>>;
        try {
          reviewPass = await runReviewerPass({
            cwd: input.cwd,
            worker,
            config: input.config,
            adapter: input.adapter,
            repoHead: postValidationLanding.repoHead ?? "HEAD",
            workerHead: postValidationLanding.workerHead ?? "HEAD",
            runner: input.runner,
          });
        } catch (error) {
          return buildAttentionState(
            worker,
            `Reviewer gate failed: ${humanizeError(error)}. See ${reviewLogFile}.`,
            {
              reviewStatus: "review-blocked",
              reviewSummary: `Reviewer gate failed: ${humanizeError(error)}. See ${reviewLogFile}.`,
              landingVerification: `Landing blocked: reviewer gate failed (${humanizeError(error)}). See ${reviewLogFile}.`,
              reviewedWorkerHead: undefined,
            },
          );
        }

        const validFeedback = reviewPass.assessment.validFeedback;
        const invalidFeedback = reviewPass.assessment.invalidFeedback;
        const normalizedSummary =
          invalidFeedback.length > 0
            ? `${reviewPass.decision.summary} (${invalidFeedback.length} feedback item(s) rejected as out-of-scope by orchestrator intent checks.)`
            : reviewPass.decision.summary;

        await appendWorkerLog(
          worker.logFile,
          `reviewer gate completed with verdict ${reviewPass.decision.verdict} (log: ${reviewPass.reviewLogFile})`,
        );

        worker = {
          ...worker,
          reviewAt: reviewPass.checkedAt,
          reviewVerdict: reviewPass.decision.verdict,
          reviewSummary: normalizedSummary,
          reviewFeedback: validFeedback.map((feedback) => feedback.comment),
          reviewValidFeedbackCount: validFeedback.length,
          reviewInvalidFeedbackCount: invalidFeedback.length,
          updatedAt: new Date().toISOString(),
        };

        if (reviewPass.decision.verdict === "approve") {
          worker = {
            ...worker,
            reviewStatus: "approved",
            reviewSummary: `Reviewer approved merge-back. ${normalizedSummary}`,
            reviewedWorkerHead: postValidationLanding.workerHead,
          };
        } else if (reviewPass.decision.verdict === "approve-with-nits") {
          worker = {
            ...worker,
            reviewStatus: "nits-only",
            reviewSummary: `Reviewer approved with nits. ${normalizedSummary}`,
            reviewedWorkerHead: postValidationLanding.workerHead,
          };
        } else if (!reviewPass.assessment.requiresChanges) {
          worker = {
            ...worker,
            reviewStatus: "nits-only",
            reviewSummary:
              "Reviewer requested changes, but no valid in-scope blockers were found. " +
              normalizedSummary,
            reviewedWorkerHead: postValidationLanding.workerHead,
          };
        } else {
          worker = {
            ...worker,
            reviewStatus: "changes-requested",
            reviewSummary: `Reviewer requested valid in-scope changes. ${normalizedSummary}`,
            reviewedWorkerHead: undefined,
          };

          const remediationAttempt = worker.reviewRemediationAttempts ?? 0;
          const maxReviewRemediationAttempts = Math.max(
            0,
            input.config.landing.review.maxRemediationAttempts,
          );

          if (remediationAttempt < maxReviewRemediationAttempts) {
            await appendWorkerLog(
              worker.logFile,
              "review requested changes; launching automatic review remediation pass",
            );
            await input.onLifecycleEvent?.({
              type: "remediation-started",
              ticketId: worker.ticketId,
              message:
                `Reviewer requested changes for delegated ticket ${worker.ticketId}. ` +
                `Launching remediation attempt ${remediationAttempt + 1}/${maxReviewRemediationAttempts}.`,
            });

            try {
              return await relaunchWorkerForReviewFeedback({
                worker,
                config: input.config,
                tmuxBackend: input.tmuxBackend,
                reviewSummary: worker.reviewSummary ?? normalizedSummary,
                validFeedback,
              });
            } catch (error) {
              return buildAttentionState(
                {
                  ...worker,
                  reviewStatus: "review-blocked",
                  reviewRemediationAttempts: remediationAttempt + 1,
                  reviewRemediationAt: new Date().toISOString(),
                  reviewSummary: `Review requested changes, but remediation launch failed: ${humanizeError(error)}`,
                },
                `Review requested changes and remediation failed to launch: ${humanizeError(error)}`,
                {
                  landingVerification:
                    "Landing blocked after valid reviewer change requests could not be remediated.",
                },
              );
            }
          }

          return buildAttentionState(
            {
              ...worker,
              reviewStatus: "review-blocked",
              reviewRemediationAttempts: remediationAttempt,
              reviewRemediationAt: new Date().toISOString(),
              reviewSummary: `Reviewer requested valid in-scope changes, but remediation attempts are exhausted (${remediationAttempt}/${maxReviewRemediationAttempts}).`,
            },
            "Landing blocked by reviewer-requested changes that still need remediation.",
            {
              landingVerification: "Landing blocked by reviewer-requested changes.",
            },
          );
        }
      }
    }

    if (deferLanding) {
      if ((postValidationLanding.aheadCount ?? 0) <= 0) {
        return buildAttentionState(
          worker,
          "Deferred landing could not confirm worker commits ahead of repo HEAD after validation.",
        );
      }

      await appendWorkerLog(
        worker.logFile,
        "validation passed; holding worker in deferred-landing mode",
      );
      const heldWorker: WorktreeWorkerRuntime = {
        ...worker,
        status: "held",
        landingHeldAt: worker.landingHeldAt ?? new Date().toISOString(),
        landingRequestedAt: undefined,
        landingVerifiedAt: undefined,
        landingVerification: buildDeferredHoldDetail(worker),
        lastError: undefined,
        updatedAt: new Date().toISOString(),
      };
      return heldWorker;
    }

    if (
      (postValidationLanding.aheadCount ?? 0) > 0 &&
      (postValidationLanding.behindCount ?? 0) > 0
    ) {
      if (attempt < attempts) {
        continue;
      }
      return buildAttentionState(
        worker,
        `Landing needs refresh before merge-back (ahead=${postValidationLanding.aheadCount ?? 0}, behind=${postValidationLanding.behindCount ?? 0}).`,
      );
    }

    if ((postValidationLanding.aheadCount ?? 0) === 0) {
      return buildAttentionState(worker, postValidationLanding.detail);
    }

    await appendWorkerLog(worker.logFile, "landing worker branch back into the repo branch");
    const landed = await landWorktreeBranch({
      repoRoot: input.repoRoot,
      worktreePath: input.worker.worktreePath,
      runner: input.runner,
    });

    worker = {
      ...worker,
      landingVerification: landed.detail,
      updatedAt: new Date().toISOString(),
    };

    if (!landed.landed) {
      if (attempt < attempts) {
        continue;
      }
      return buildAttentionState(worker, landed.detail);
    }

    await appendWorkerLog(worker.logFile, "verifying merge-back containment after landing");
    const verifiedAfterLanding = await verifyWorktreeLanding({
      repoRoot: input.repoRoot,
      worktreePath: input.worker.worktreePath,
      ticketClosed: true,
      runner: input.runner,
    });

    worker = {
      ...worker,
      landingVerification: verifiedAfterLanding.detail,
      landingAheadCount: verifiedAfterLanding.aheadCount,
      landingBehindCount: verifiedAfterLanding.behindCount,
      updatedAt: new Date().toISOString(),
    };

    if ((verifiedAfterLanding.cleanedTransientFiles?.length ?? 0) > 0) {
      await appendWorkerLog(
        worker.logFile,
        `cleaned transient worktree files after merge-back: ${verifiedAfterLanding.cleanedTransientFiles?.join(", ")}`,
      );
    }

    if (verifiedAfterLanding.verified) {
      return finalizeLandedWorker({
        repoRoot: input.repoRoot,
        worker,
        runtimeRoot: resolveWorkerRuntimeDir(input.repoRoot, input.config.storage.runtimeDir),
        verifiedAt: verifiedAfterLanding.checkedAt,
        tmuxBackend: input.tmuxBackend,
        runner: input.runner,
      });
    }

    if (attempt < attempts) {
      continue;
    }

    return buildAttentionState(worker, verifiedAfterLanding.detail);
  }

  return buildAttentionState(
    worker,
    `Landing could not be completed after ${attempts} attempt(s).`,
  );
}

function isSkippedCurrentBranchVerificationStatus(worker: WorkerRuntime): boolean {
  return (
    worker.status === "verified" || worker.status === "attention" || worker.status === "failed"
  );
}

async function runCurrentBranchVerification(
  input: VerifyCurrentBranchWorkerInput,
): Promise<CurrentBranchWorkerRuntime> {
  let worker: CurrentBranchWorkerRuntime = {
    ...input.worker,
    landingVerification:
      input.worker.landingVerification ??
      "Current-branch verification started; worktree landing is intentionally skipped.",
    updatedAt: new Date().toISOString(),
  };

  const updateWorker = (nextWorker: CurrentBranchWorkerRuntime): CurrentBranchWorkerRuntime => {
    worker = nextWorker;
    input.onWorkerUpdate?.(worker);
    return worker;
  };

  updateWorker(worker);
  await appendWorkerLog(
    worker.logFile,
    `starting current-branch verification for ${worker.ticketId}; skipping worktree landing`,
  );
  await input.onLifecycleEvent?.(
    `Delegated ticket ${worker.ticketId} exited closed. Starting current-branch verification.`,
  );

  const steps: Array<[keyof CurrentBranchVerificationPipeline, string]> = [
    ["buildAttributionEvidence", "build attribution evidence"],
    ["runWorkerReview", "run per-worker review"],
    ["applyCoordinatorTriage", "apply coordinator triage"],
    ["handleRemediation", "handle remediation"],
    ["markVerified", "mark verified"],
  ];

  try {
    for (const [name, label] of steps) {
      if (isSkippedCurrentBranchVerificationStatus(worker)) {
        return worker;
      }
      const operation = input.pipeline?.[name];
      if (!operation) {
        continue;
      }
      await appendWorkerLog(worker.logFile, `current-branch verification: ${label}`);
      worker = updateWorker(
        await operation({
          cwd: input.cwd,
          repoRoot: input.repoRoot,
          config: input.config,
          adapter: input.adapter,
          runner: input.runner,
          tmuxBackend: input.tmuxBackend,
          worker,
          onLifecycleEvent: input.onLifecycleEvent,
          onWorkerUpdate: input.onWorkerUpdate,
        }),
      );
    }
  } catch (error) {
    return buildAttentionState(
      worker,
      `Current-branch verification failed: ${humanizeError(error)}`,
      {
        landingVerification: `Current-branch verification failed: ${humanizeError(error)}`,
      },
    ) as CurrentBranchWorkerRuntime;
  }

  if (worker.status === "verified") {
    return worker;
  }

  return buildAttentionState(
    worker,
    "Current-branch verification pipeline is not fully implemented yet; awaiting attribution, review, triage, and remediation steps.",
    {
      landingVerification:
        "Current-branch verification placeholder reached. No worktree rebase, merge-back, containment check, or cleanup was run.",
    },
  ) as CurrentBranchWorkerRuntime;
}

export async function verifyCurrentBranchWorker(
  input: VerifyCurrentBranchWorkerInput,
): Promise<WorkerRuntime> {
  if (isSkippedCurrentBranchVerificationStatus(input.worker)) {
    return {
      ...input.worker,
      updatedAt: new Date().toISOString(),
    };
  }

  const existingLock = workerOrchestrationLocks.get(input.worker.workerId);
  if (existingLock) {
    return input.awaitOrchestration === false ? existingLock.snapshot : await existingLock.promise;
  }

  let snapshot: WorkerRuntime = {
    ...input.worker,
    updatedAt: new Date().toISOString(),
  };
  const publishSnapshot = (nextWorker: WorkerRuntime): void => {
    snapshot = nextWorker;
    input.onWorkerUpdate?.(nextWorker);
  };
  const promise = runCurrentBranchVerification({
    ...input,
    onWorkerUpdate: publishSnapshot,
  })
    .then((nextWorker) => {
      snapshot = nextWorker;
      return nextWorker;
    })
    .finally(() => {
      workerOrchestrationLocks.delete(input.worker.workerId);
    });

  workerOrchestrationLocks.set(input.worker.workerId, { promise, snapshot });

  return input.awaitOrchestration === false ? snapshot : await promise;
}

export function buildRunOptions(
  config: BeadworkConfig,
  options: {
    workers?: number;
    until?: string;
    dryRun?: boolean;
    maxCycles?: number;
    noSpawn?: boolean;
  },
): RunOptions {
  const until: RunUntil =
    options.until === "empty" || options.until === "blocked"
      ? options.until
      : config.run.defaultUntil;
  return {
    workers:
      typeof options.workers === "number" && options.workers > 0
        ? options.workers
        : config.run.defaultWorkers,
    until,
    dryRun: options.dryRun === true,
    maxCycles:
      typeof options.maxCycles === "number" && options.maxCycles > 0
        ? options.maxCycles
        : config.run.defaultMaxCycles,
    pollIntervalMs: config.run.pollIntervalMs,
    noSpawn: options.noSpawn === true,
  };
}

export async function launchTicketWorker(input: {
  cwd: string;
  repoRoot: string;
  config: BeadworkConfig;
  adapter: BeadworkAdapter;
  ticketId: string;
  epicId?: string;
  prime?: string;
  workerProviderOverride?: string;
  workerModelOverride?: string;
  tmuxBackend?: TmuxBackend;
  processRunner?: ProcessRunner;
}): Promise<WorkerRuntime> {
  const tmuxBackend = input.tmuxBackend ?? createTmuxBackend();
  const ticket = await input.adapter.show(input.cwd, input.ticketId);
  if (ticket.type === "epic") {
    throw new Error(`Cannot launch a worker directly for epic ${ticket.id}. Use /bw run instead.`);
  }

  const epic = ticket.parentId ? await input.adapter.show(input.cwd, ticket.parentId) : undefined;
  const checkout = await prepareWorkerCheckout({
    config: input.config,
    repoRoot: input.repoRoot,
    ticketId: ticket.id,
    epicId: input.epicId ?? ticket.parentId,
    title: ticket.title,
    processRunner: input.processRunner,
  });

  const registryPath = resolveWorkerRegistryPath(
    input.repoRoot,
    input.config.storage.workerRegistryFile,
  );
  const runtimeRoot = resolveWorkerRuntimeDir(input.repoRoot, input.config.storage.runtimeDir);
  const workerId = buildWorkerId(ticket.id);
  const runtimeDir = path.join(runtimeRoot, workerId);
  const runtimeScratchDir = path.join(runtimeDir, "scratch");
  await mkdir(runtimeScratchDir, { recursive: true });

  const prompt =
    checkout.executionMode === "current-branch"
      ? buildCurrentBranchHandoffPrompt({
          ticket,
          epic,
          branchName: checkout.branchName,
          checkoutPath: checkout.checkoutPath,
          runtimeScratchDir,
          prime: input.prime,
        })
      : buildWorkerHandoff({
          ticket,
          epic,
          branchName: checkout.branchName,
          worktreePath: checkout.worktreePath,
          runtimeScratchDir,
          prime: input.prime,
        });

  const promptFile = path.join(runtimeDir, "handoff.txt");
  const logFile = path.join(runtimeDir, "worker.log");
  const stateFile = path.join(runtimeDir, "state.txt");
  const exitCodeFile = path.join(runtimeDir, "exit-code.txt");
  const finishedAtFile = path.join(runtimeDir, "finished-at.txt");
  const scriptFile = path.join(runtimeDir, "launch.sh");
  const workerAgent = resolveWorkerAgentSettings(input.config, {
    workerProvider: input.workerProviderOverride,
    workerModel: input.workerModelOverride,
  });
  const reviewerAgent = resolveReviewerAgentSettings(input.config, workerAgent);
  const workerAgentCommand = buildWorkerAgentCommand(input.config, workerAgent);

  await writeFile(promptFile, `${prompt}\n`, "utf8");
  await writeFile(
    scriptFile,
    buildWorkerScript({
      workerAgentCommand,
      promptFile,
      logFile,
      stateFile,
      exitCodeFile,
      finishedAtFile,
    }),
    "utf8",
  );
  await chmod(scriptFile, 0o755);

  const now = new Date().toISOString();
  const launchCommand = `bash ${shellQuote(scriptFile)}`;
  const launchReviewEnabled =
    checkout.executionMode === "current-branch"
      ? input.config.workerExecution.review.enabled
      : input.config.landing.review.enabled;
  const commonWorker = {
    workerId,
    ticketId: ticket.id,
    epicId: input.epicId ?? ticket.parentId,
    ticketTitle: ticket.title,
    ticketStatus: ticket.status,
    backend: "tmux" as const,
    tmuxSession: input.config.tmux.sessionName,
    tmuxWindow: workerId,
    tmuxPane: "pending",
    runtimeDir,
    promptFile,
    scriptFile,
    logFile,
    stateFile,
    exitCodeFile,
    finishedAtFile,
    launchCommand,
    workerCommand: workerAgent.workerCommand,
    workerProvider: workerAgent.workerProvider,
    workerModel: workerAgent.workerModel,
    reviewerProvider: reviewerAgent.workerProvider,
    reviewerModel: reviewerAgent.workerModel,
    landingPolicy: input.config.landing.policy,
    reviewStatus: launchReviewEnabled ? ("pending" as const) : undefined,
    status: "launching" as const,
    startedAt: now,
    updatedAt: now,
  };

  const pendingWorker: WorkerRuntime =
    checkout.executionMode === "current-branch"
      ? {
          ...commonWorker,
          executionMode: checkout.executionMode,
          checkoutPath: checkout.checkoutPath,
          branchName: checkout.branchName,
          launchHead: checkout.launchHead,
        }
      : {
          ...commonWorker,
          executionMode: checkout.executionMode,
          checkoutPath: checkout.checkoutPath,
          branchName: checkout.branchName,
          worktreePath: checkout.worktreePath,
          cleanupPolicy: input.config.worktrees.cleanup,
          cleanupStatus:
            input.config.worktrees.cleanup === "cleanup-after-landing" ? "pending" : undefined,
        };

  await upsertWorkerRuntime(registryPath, pendingWorker);

  let launched: Awaited<ReturnType<TmuxBackend["launchWorker"]>>;
  try {
    await tmuxBackend.ensureSession({ sessionName: input.config.tmux.sessionName });
    launched = await tmuxBackend.launchWorker({
      sessionName: input.config.tmux.sessionName,
      workerId,
      title: ticket.title,
      worktreePath: checkout.checkoutPath,
      launchCommand,
    });
  } catch (error) {
    const launchFailedWorker: WorkerRuntime = {
      ...pendingWorker,
      status: "failed",
      lastError: buildLaunchFailureMessage(pendingWorker, error),
      updatedAt: new Date().toISOString(),
    };
    await upsertWorkerRuntime(registryPath, launchFailedWorker);
    throw new Error(launchFailedWorker.lastError);
  }

  const runningWorker: WorkerRuntime = {
    ...pendingWorker,
    tmuxSession: launched.sessionName,
    tmuxWindow: launched.windowName,
    tmuxPane: launched.paneId,
    launchCommand: launched.launchCommand,
    status: "running",
    updatedAt: new Date().toISOString(),
  };

  await upsertWorkerRuntime(registryPath, runningWorker);
  return runningWorker;
}

export async function inspectWorkerRuntime(input: {
  cwd: string;
  repoRoot: string;
  worker: WorkerRuntime;
  adapter: BeadworkAdapter;
  config?: BeadworkConfig;
  tmuxBackend?: TmuxBackend;
  runner?: ProcessRunner;
  onLifecycleEvent?: (event: WorkerLifecycleEvent) => Promise<void> | void;
  onWorkerUpdate?: (worker: WorkerRuntime) => Promise<void> | void;
  requestLanding?: boolean;
  awaitOrchestration?: boolean;
}): Promise<WorkerRuntime> {
  const tmuxBackend = input.tmuxBackend ?? createTmuxBackend();
  const runner = input.runner ?? defaultProcessRunner;
  const config = input.config;
  const validationRequired = (config?.landing.validateCommands.length ?? 0) > 0;
  const landedNeedsValidation =
    input.worker.status === "landed" &&
    validationRequired &&
    input.worker.validationStatus !== "passed";
  const shouldRequestLanding =
    input.requestLanding === true || Boolean(input.worker.landingRequestedAt);

  if (isSuccessfulTerminalWorker(input.worker) && !landedNeedsValidation) {
    return {
      ...input.worker,
      updatedAt: new Date().toISOString(),
    };
  }

  const [stateText, exitCodeText, finishedAtText, pane] = await Promise.all([
    readOptionalFile(input.worker.stateFile),
    readOptionalFile(input.worker.exitCodeFile),
    readOptionalFile(input.worker.finishedAtFile),
    input.worker.tmuxPane === "pending"
      ? Promise.resolve<TmuxPaneInspection>({ exists: false })
      : tmuxBackend.inspectWorker({
          paneId: input.worker.tmuxPane,
          sessionName: input.worker.tmuxSession,
          windowName: input.worker.tmuxWindow,
        }),
  ]);

  const resolvedTmuxSession =
    pane.exists && pane.sessionName ? pane.sessionName : input.worker.tmuxSession;
  const resolvedTmuxWindow =
    pane.exists && pane.windowName ? pane.windowName : input.worker.tmuxWindow;
  const resolvedTmuxPane = pane.exists && pane.paneId ? pane.paneId : input.worker.tmuxPane;
  const exitCode = parseInteger(exitCodeText);
  let nextStatus = input.worker.status;
  let ticketStatus = input.worker.ticketStatus;

  try {
    ticketStatus = (await input.adapter.show(input.cwd, input.worker.ticketId)).status;
  } catch {
    ticketStatus = input.worker.ticketStatus;
  }

  const workerFinished =
    stateText === "exited" ||
    stateText === "failed" ||
    (!pane.exists && input.worker.status !== "launching") ||
    input.worker.status === "exited" ||
    input.worker.status === "failed" ||
    input.worker.status === "held" ||
    input.worker.status === "attention" ||
    input.worker.status === "landed" ||
    input.worker.status === "verified";

  if (ticketStatus === "closed" && workerFinished && config) {
    const orchestratedWorker = {
      ...input.worker,
      ticketStatus,
      tmuxSession: resolvedTmuxSession,
      tmuxWindow: resolvedTmuxWindow,
      tmuxPane: resolvedTmuxPane,
      finishedAt: finishedAtText ?? input.worker.finishedAt,
    };
    if (!isWorktreeWorker(orchestratedWorker)) {
      return await verifyCurrentBranchWorker({
        cwd: input.cwd,
        repoRoot: input.repoRoot,
        worker: orchestratedWorker,
        config,
        adapter: input.adapter,
        tmuxBackend,
        runner,
        awaitOrchestration: input.awaitOrchestration,
        onLifecycleEvent: (message) =>
          input.onLifecycleEvent?.({
            type: "post-exit-started",
            ticketId: orchestratedWorker.ticketId,
            message,
          }),
        onWorkerUpdate: (nextWorker) => {
          void input.onWorkerUpdate?.(nextWorker);
        },
      });
    }
    const existingLock = workerOrchestrationLocks.get(orchestratedWorker.workerId);
    if (existingLock) {
      if (input.awaitOrchestration === false) {
        return {
          ...existingLock.snapshot,
          ticketStatus,
          tmuxSession: resolvedTmuxSession,
          tmuxWindow: resolvedTmuxWindow,
          tmuxPane: resolvedTmuxPane,
          finishedAt: existingLock.snapshot.finishedAt ?? finishedAtText,
          updatedAt: new Date().toISOString(),
        };
      }

      const awaited = await existingLock.promise;
      return {
        ...awaited,
        ticketStatus,
        tmuxSession: awaited.tmuxSession,
        tmuxWindow: awaited.tmuxWindow,
        tmuxPane: awaited.tmuxPane,
        finishedAt: awaited.finishedAt ?? finishedAtText,
        updatedAt: new Date().toISOString(),
      };
    }

    let snapshot: WorkerRuntime = {
      ...orchestratedWorker,
      updatedAt: new Date().toISOString(),
    };
    const publishSnapshot = (nextWorker: WorkerRuntime): WorkerRuntime => {
      const mergedWorker: WorkerRuntime = {
        ...nextWorker,
        ticketStatus,
        tmuxSession: nextWorker.tmuxSession,
        tmuxWindow: nextWorker.tmuxWindow,
        tmuxPane: nextWorker.tmuxPane,
        finishedAt: nextWorker.finishedAt ?? finishedAtText,
        updatedAt: new Date().toISOString(),
      };
      snapshot = mergedWorker;
      const current = workerOrchestrationLocks.get(orchestratedWorker.workerId);
      if (current) {
        current.snapshot = mergedWorker;
      }
      void input.onWorkerUpdate?.(mergedWorker);
      return mergedWorker;
    };

    const orchestrationPromise = autoLandCompletedWorker({
      cwd: input.cwd,
      repoRoot: input.repoRoot,
      worker: orchestratedWorker,
      config,
      adapter: input.adapter,
      tmuxBackend,
      runner,
      requestLanding: shouldRequestLanding,
      onLifecycleEvent: input.onLifecycleEvent,
      onWorkerUpdate: (nextWorker) => {
        publishSnapshot(nextWorker);
      },
    })
      .then((nextWorker) => publishSnapshot(nextWorker))
      .catch((error) =>
        publishSnapshot(
          buildAttentionState(snapshot, `Landing orchestration failed: ${humanizeError(error)}`, {
            ticketStatus,
          }),
        ),
      )
      .finally(() => {
        workerOrchestrationLocks.delete(orchestratedWorker.workerId);
      });

    workerOrchestrationLocks.set(orchestratedWorker.workerId, {
      snapshot,
      promise: orchestrationPromise,
    });

    if (input.awaitOrchestration === false) {
      return snapshot;
    }

    return await orchestrationPromise;
  }

  if (stateText === "failed" || (exitCode !== undefined && exitCode !== 0)) {
    nextStatus = "failed";
  } else if (stateText === "exited" || (!pane.exists && input.worker.status !== "launching")) {
    nextStatus = "exited";
  } else if (stateText === "running" || (pane.exists && pane.dead !== true)) {
    nextStatus = "running";
  }

  const lastError =
    ticketStatus === "closed" && nextStatus === "exited"
      ? (input.worker.landingVerification ?? input.worker.lastError)
      : nextStatus === "failed" && ticketStatus !== "closed"
        ? (input.worker.lastError ??
          (exitCode !== undefined && exitCode !== 0
            ? `Worker exited with code ${exitCode}.`
            : "Worker exited before landing orchestration could begin."))
        : undefined;

  return {
    ...input.worker,
    ticketStatus,
    tmuxSession: resolvedTmuxSession,
    tmuxWindow: resolvedTmuxWindow,
    tmuxPane: resolvedTmuxPane,
    status: nextStatus,
    finishedAt: finishedAtText ?? input.worker.finishedAt,
    lastError,
    updatedAt: new Date().toISOString(),
  };
}

export async function requestWorkerLanding(input: {
  cwd: string;
  repoRoot: string;
  config: BeadworkConfig;
  adapter: BeadworkAdapter;
  ticketId?: string;
  workerId?: string;
  tmuxBackend?: TmuxBackend;
  runner?: ProcessRunner;
  onLifecycleEvent?: (event: WorkerLifecycleEvent) => Promise<void> | void;
}): Promise<WorkerRuntime> {
  if (!input.ticketId && !input.workerId) {
    throw new Error("Provide either workerId or ticketId to request landing.");
  }

  const registryPath = resolveWorkerRegistryPath(
    input.repoRoot,
    input.config.storage.workerRegistryFile,
  );
  const workers = await loadWorkerRegistry(registryPath);
  const normalizedTicketId = input.ticketId?.toLowerCase();

  const candidates = workers
    .filter((worker) => {
      if (input.workerId) {
        return worker.workerId === input.workerId;
      }
      if (normalizedTicketId) {
        return worker.ticketId.toLowerCase() === normalizedTicketId;
      }
      return false;
    })
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

  const worker = candidates[0];
  if (!worker) {
    throw new Error(
      input.workerId
        ? `No delegated worker found for worker id ${input.workerId}.`
        : `No delegated worker found for ticket ${input.ticketId}.`,
    );
  }

  if (isSuccessfulTerminalWorker(worker)) {
    throw new Error(
      worker.status === "verified"
        ? `Worker ${worker.workerId} is already verified.`
        : `Worker ${worker.workerId} is already landed.`,
    );
  }

  const queued = buildQueuedLandingRequestState(worker, input.config);
  await upsertWorkerRuntime(registryPath, queued);

  const inspected = await inspectWorkerRuntime({
    cwd: input.cwd,
    repoRoot: input.repoRoot,
    worker: queued,
    adapter: input.adapter,
    config: input.config,
    tmuxBackend: input.tmuxBackend,
    runner: input.runner,
    requestLanding: true,
    awaitOrchestration: false,
    onLifecycleEvent: input.onLifecycleEvent,
    onWorkerUpdate: async (nextWorker) => {
      await upsertWorkerRuntime(registryPath, nextWorker);
    },
  });

  await upsertWorkerRuntime(registryPath, inspected);
  return inspected;
}

export async function listWorkers(input: {
  repoRoot: string;
  config: BeadworkConfig;
  epicId?: string;
}): Promise<WorkerRuntime[]> {
  const registryPath = resolveWorkerRegistryPath(
    input.repoRoot,
    input.config.storage.workerRegistryFile,
  );
  const workers = await loadWorkerRegistry(registryPath);
  return input.epicId ? workers.filter((worker) => worker.epicId === input.epicId) : workers;
}

export async function stopWorkers(input: {
  repoRoot: string;
  config: BeadworkConfig;
  workerIds?: string[];
  epicId?: string;
  tmuxBackend?: TmuxBackend;
  reason?: string;
}): Promise<WorkerRuntime[]> {
  const tmuxBackend = input.tmuxBackend ?? createTmuxBackend();
  const registryPath = resolveWorkerRegistryPath(
    input.repoRoot,
    input.config.storage.workerRegistryFile,
  );
  const workers = await loadWorkerRegistry(registryPath);
  const selectedIds = input.workerIds ? new Set(input.workerIds) : undefined;
  const now = new Date().toISOString();
  const stopped: WorkerRuntime[] = [];

  const nextWorkers = await Promise.all(
    workers.map(async (worker) => {
      const inScope = input.epicId ? worker.epicId === input.epicId : true;
      const selected = selectedIds ? selectedIds.has(worker.workerId) : true;
      const active = worker.status === "launching" || worker.status === "running";
      if (!inScope || !selected || !active) {
        return worker;
      }

      let nextWorker: WorkerRuntime = {
        ...worker,
        status: "exited",
        finishedAt: worker.finishedAt ?? now,
        updatedAt: now,
        lastError: input.reason ?? "Stopped by user.",
      };

      try {
        await tmuxBackend.cleanupWorker({
          paneId: worker.tmuxPane !== "pending" ? worker.tmuxPane : undefined,
          sessionName: worker.tmuxSession,
          windowName: worker.tmuxWindow,
        });
      } catch (error) {
        nextWorker = {
          ...nextWorker,
          status: "failed",
          lastError: `Failed to stop worker: ${humanizeError(error)}`,
        };
      }

      stopped.push(nextWorker);
      return nextWorker;
    }),
  );

  await saveWorkerRegistry(registryPath, nextWorkers);
  return stopped;
}

export async function runBoundedEpicLoop(input: {
  cwd: string;
  repoRoot: string;
  config: BeadworkConfig;
  adapter: BeadworkAdapter;
  epicId: string;
  options: RunOptions;
  prime?: string;
  tmuxBackend?: TmuxBackend;
  sleepFn?: (ms: number) => Promise<void>;
  runner?: ProcessRunner;
}): Promise<RunSummary> {
  const tmuxBackend = input.tmuxBackend ?? createTmuxBackend();
  const sleepFn = input.sleepFn ?? sleep;
  const runner = input.runner ?? defaultProcessRunner;
  const registryPath = resolveWorkerRegistryPath(
    input.repoRoot,
    input.config.storage.workerRegistryFile,
  );
  const launched = new Set<string>();
  const notes: string[] = [];
  const cycleSummaries: RunSummary["cycleSummaries"] = [];
  let stopReason: RunSummary["stopReason"] = "max-cycles";

  for (let cycle = 1; cycle <= input.options.maxCycles; cycle += 1) {
    const epic = await input.adapter.show(input.cwd, input.epicId);
    let workers = (await loadWorkerRegistry(registryPath)).filter(
      (worker) => worker.epicId === input.epicId,
    );

    const inspectedWorkers = await Promise.all(
      workers.map((worker) =>
        inspectWorkerRuntime({
          cwd: input.cwd,
          repoRoot: input.repoRoot,
          worker,
          adapter: input.adapter,
          config: input.config,
          tmuxBackend,
          runner,
        }),
      ),
    );

    workers = await saveWorkerRegistry(registryPath, [
      ...(await loadWorkerRegistry(registryPath)).filter(
        (worker) => worker.epicId !== input.epicId,
      ),
      ...inspectedWorkers,
    ]);
    workers = workers.filter((worker) => worker.epicId === input.epicId);

    const ready = await input.adapter.ready(input.cwd, input.epicId);
    let launchable = ready.filter((issue) => issue.type !== "epic");
    let launchedThisCycle: string[] = [];

    if (!input.options.dryRun && !input.options.noSpawn) {
      const launchResult = await launchReadyWorkersWithinConcurrencyLimit({
        cwd: input.cwd,
        repoRoot: input.repoRoot,
        registryPath,
        config: input.config,
        adapter: input.adapter,
        epicId: input.epicId,
        ready,
        maxWorkers: input.options.workers,
        prime: input.prime,
        tmuxBackend,
        processRunner: runner,
      });
      workers = launchResult.workers;
      launchable = launchResult.launchable;
      launchedThisCycle = launchResult.launchedThisCycle;
      for (const ticketId of launchedThisCycle) {
        launched.add(ticketId);
      }
      for (const notice of launchResult.launchNotices) {
        notes.push(`Cycle ${cycle}: ${notice}.`);
      }
    } else {
      const attemptedTicketIds = new Set(workers.map((worker) => worker.ticketId));
      launchable = ready.filter(
        (issue) => !attemptedTicketIds.has(issue.id) && issue.type !== "epic",
      );
      if (launchable.length > 0) {
        notes.push(
          `Cycle ${cycle}: ${launchable
            .slice(0, input.options.workers)
            .map((issue) => issue.id)
            .join(", ")} would be launched.`,
        );
      }
    }

    const summary = summarizeWorkers(workers);
    cycleSummaries.push({
      cycle,
      ready: ready.map((issue) => issue.id),
      launched: launchedThisCycle,
      running: workers
        .filter((worker) => worker.status === "launching" || worker.status === "running")
        .map((worker) => worker.ticketId),
      held: workers.filter((worker) => worker.status === "held").map((worker) => worker.ticketId),
      landed: workers
        .filter((worker) => worker.status === "landed")
        .map((worker) => worker.ticketId),
      verified: workers
        .filter((worker) => worker.status === "verified")
        .map((worker) => worker.ticketId),
      failed: workers
        .filter((worker) => worker.status === "failed")
        .map((worker) => worker.ticketId),
      attention: workers
        .filter((worker) => worker.status === "attention")
        .map((worker) => worker.ticketId),
      exited: workers
        .filter((worker) => worker.status === "exited")
        .map((worker) => worker.ticketId),
    });

    if (epic.status === "closed" || epic.children.every((child) => child.status === "closed")) {
      stopReason = "completed";
      break;
    }

    if (
      summary.failed > 0 ||
      summary.attention > 0 ||
      summary.held > 0 ||
      workers.some((worker) => worker.status === "exited")
    ) {
      notes.push(
        "At least one worker needs operator attention before the orchestrator can continue.",
      );
      stopReason = "attention";
      break;
    }

    if (ready.length === 0 && summary.active === 0) {
      stopReason = input.options.until === "empty" ? "empty" : "blocked";
      break;
    }

    if (
      launchable.length === 0 &&
      summary.active === 0 &&
      ready.length > 0 &&
      ready.every((issue) =>
        workers.some(
          (worker) => worker.ticketId === issue.id && isSuccessfulTerminalWorker(worker),
        ),
      )
    ) {
      stopReason = "blocked";
      break;
    }
    if (launchable.length === 0 && summary.active === 0 && ready.length > 0) {
      notes.push("Ready tickets remain, but all have already been attempted in this run.");
      stopReason = "attention";
      break;
    }

    if (cycle < input.options.maxCycles && input.options.pollIntervalMs > 0) {
      await sleepFn(input.options.pollIntervalMs);
    }
  }

  const finalWorkers = (await loadWorkerRegistry(registryPath)).filter(
    (worker) => worker.epicId === input.epicId,
  );

  return {
    epicId: input.epicId,
    stopReason,
    cycles: cycleSummaries.length,
    launched: [...launched],
    activeWorkerIds: finalWorkers
      .filter((worker) => worker.status === "launching" || worker.status === "running")
      .map((worker) => worker.workerId),
    workerSummary: summarizeWorkers(finalWorkers),
    notes,
    cycleSummaries,
  };
}
