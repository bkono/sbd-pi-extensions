import { createWriteStream } from "node:fs";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BeadworkAdapter } from "./bw.js";
import { buildWorkerHandoff } from "./handoff.js";
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
  BeadworkIssueDetail,
  RunOptions,
  RunSummary,
  RunUntil,
  WorkerReviewVerdict,
  WorkerRuntime,
} from "./types.js";
import {
  cleanupTicketWorktree,
  type LandingVerificationResult,
  landWorktreeBranch,
  prepareTicketWorktree,
  rebaseWorktreeOntoRepoHead,
  runWorktreeValidation,
  verifyWorktreeLanding,
} from "./worktree.js";

function buildWorkerId(ticketId: string): string {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${ticketId.toLowerCase()}-${stamp}-${random}`;
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

export function buildWorkerAgentCommand(config: BeadworkConfig): string {
  return buildModelScopedAgentCommand({
    command: config.tmux.workerCommand,
    provider: config.tmux.workerProvider,
    model: config.tmux.workerModel,
  });
}

export function buildReviewerAgentCommand(config: BeadworkConfig): string {
  return buildModelScopedAgentCommand({
    command: config.tmux.workerCommand,
    provider: config.landing.review.provider ?? config.tmux.workerProvider,
    model: config.landing.review.model ?? config.tmux.workerModel,
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

const workerOrchestrationLocks = new Map<string, WorkerOrchestrationLock>();

const MAX_VALIDATION_REMEDIATION_ATTEMPTS = 1;
const REVIEWER_ALLOWED_VERDICTS: WorkerReviewVerdict[] = [
  "approve",
  "approve-with-nits",
  "request-changes",
];

function isReviewVerdict(value: unknown): value is WorkerReviewVerdict {
  return (
    typeof value === "string" && REVIEWER_ALLOWED_VERDICTS.includes(value as WorkerReviewVerdict)
  );
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

function extractJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Reviewer output was empty.");
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
      // fall through to broad object extraction
    }
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) {
    return JSON.parse(objectMatch[0]) as unknown;
  }

  throw new Error("Reviewer output did not contain a JSON object.");
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
    throw new Error("Reviewer output was not a JSON object.");
  }

  const value = payload as {
    verdict?: unknown;
    summary?: unknown;
    feedback?: unknown;
  };

  if (!isReviewVerdict(value.verdict)) {
    throw new Error(
      `Reviewer verdict must be one of: ${REVIEWER_ALLOWED_VERDICTS.join(", ")}. Received: ${String(value.verdict)}.`,
    );
  }

  const feedback = Array.isArray(value.feedback)
    ? value.feedback
        .map((entry) => normalizeReviewFeedbackItem(entry))
        .filter((entry): entry is ReviewFeedbackItem => entry !== undefined)
    : [];

  return {
    verdict: value.verdict,
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
  worker: WorkerRuntime;
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

function buildReviewRemediationPrompt(input: {
  worker: WorkerRuntime;
  reviewSummary: string;
  validFeedback: ReviewFeedbackItem[];
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

  lines.push(
    "",
    "Rules:",
    "- Stay scoped to the ticket intent and the listed valid review feedback.",
    "- Ignore reviewer comments that are not in the valid-feedback list.",
    "- Keep commits focused; commit follow-up fixes on the current branch.",
    "- Re-run any needed quality checks before exiting.",
    "- Do not reopen the ticket unless absolutely necessary.",
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
  worker: WorkerRuntime;
  ticket: BeadworkIssueDetail;
  epic?: BeadworkIssueDetail;
  artifacts: { commitSummary: string; diffStat: string; diff: string };
}): string {
  const lines = [
    "You are a reviewer agent performing a merge-back gate for delegated beadwork work.",
    "Assess the change against the ticket intent and task goals. Do not invent unrelated scope.",
    "",
    "Return STRICT JSON only with this schema:",
    "{",
    '  "verdict": "approve" | "approve-with-nits" | "request-changes",',
    '  "summary": "short summary",',
    '  "feedback": [',
    '    { "comment": "text", "intentAlignment": "aligned" | "unclear" | "misaligned", "requiresChanges": true | false }',
    "  ]",
    "}",
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
    "- Only request changes when the issue is truly relevant to this ticket's intent/constraints.",
    "- Use intentAlignment=misaligned for comments that are not truly in scope.",
    "- For minor polish that should not block landing, use verdict=approve-with-nits and requiresChanges=false.",
  );

  return lines.join("\n");
}

async function runReviewerPass(input: {
  cwd: string;
  worker: WorkerRuntime;
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

  const reviewerCommand = buildReviewerAgentCommand(input.config);
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
  worker: WorkerRuntime;
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
  const workerAgentCommand = buildWorkerAgentCommand(input.config);

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
    workerCommand: input.config.tmux.workerCommand,
    workerProvider: input.config.tmux.workerProvider,
    workerModel: input.config.tmux.workerModel,
    status: "running",
    validationStatus: "pending",
    validationAt: now,
    validationSummary: `Automatic remediation attempt ${remediationAttempt} started after validation failed: ${input.validationDetail}`,
    remediationStatus: "running",
    remediationAttempts: remediationAttempt,
    remediationAt: now,
    remediationSummary: `Automatic remediation attempt ${remediationAttempt}/${MAX_VALIDATION_REMEDIATION_ATTEMPTS} is running in the existing worktree.`,
    landingVerifiedAt: undefined,
    landingVerification: `Validation failed; remediation attempt ${remediationAttempt}/${MAX_VALIDATION_REMEDIATION_ATTEMPTS} is running.`,
    lastError: undefined,
    finishedAt: undefined,
    updatedAt: now,
  };
}

async function relaunchWorkerForReviewFeedback(input: {
  worker: WorkerRuntime;
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
  });
  const workerAgentCommand = buildWorkerAgentCommand(input.config);

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
    workerCommand: input.config.tmux.workerCommand,
    workerProvider: input.config.tmux.workerProvider,
    workerModel: input.config.tmux.workerModel,
    reviewerProvider: input.config.landing.review.provider ?? input.config.tmux.workerProvider,
    reviewerModel: input.config.landing.review.model ?? input.config.tmux.workerModel,
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
  worker: WorkerRuntime;
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

function buildAttentionState(
  worker: WorkerRuntime,
  detail: string,
  overrides: Partial<WorkerRuntime> = {},
): WorkerRuntime {
  return {
    ...worker,
    ...overrides,
    status: "attention",
    landingVerification: overrides.landingVerification ?? detail,
    lastError: detail,
    updatedAt: new Date().toISOString(),
  };
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

  const queuedDetail = ticketClosed
    ? reviewEnabled
      ? `Explicit landing request queued. Background supervision will rerun validation, reviewer gating, and merge-back. Reviewer output will stream to ${reviewLogFile} once it starts.`
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
    reviewStatus: reviewEnabled ? "pending" : undefined,
    reviewVerdict: undefined,
    reviewAt: reviewEnabled ? now : undefined,
    reviewSummary: reviewEnabled ? queuedDetail : undefined,
    reviewFeedback: undefined,
    reviewValidFeedbackCount: undefined,
    reviewInvalidFeedbackCount: undefined,
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
  worker: WorkerRuntime;
  verifiedAt: string;
  tmuxBackend: TmuxBackend;
  runner: ProcessRunner;
}): Promise<WorkerRuntime> {
  const landedWorker: WorkerRuntime = {
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
  worker: WorkerRuntime;
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

  let worker: WorkerRuntime = {
    ...input.worker,
    landingVerification: landing.detail,
    landingAheadCount: landing.aheadCount,
    landingBehindCount: landing.behindCount,
    updatedAt: new Date().toISOString(),
  };

  if (landing.worktreeClean === false) {
    return buildAttentionState(worker, `Deferred landing needs attention: ${landing.detail}`);
  }

  if (landing.verified) {
    await appendWorkerLog(worker.logFile, "held worker is already integrated into repo HEAD");
    return finalizeLandedWorker({
      repoRoot: input.repoRoot,
      worker,
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
  worker: WorkerRuntime;
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
      tmuxBackend: input.tmuxBackend,
      runner: input.runner,
    });
  }

  let worker: WorkerRuntime = {
    ...input.worker,
    landingPolicy,
    reviewerProvider: input.config.landing.review.provider ?? input.config.tmux.workerProvider,
    reviewerModel: input.config.landing.review.model ?? input.config.tmux.workerModel,
    landingRequestedAt: input.requestLanding
      ? new Date().toISOString()
      : input.worker.landingRequestedAt,
    validationStatus: validationRequired ? (input.worker.validationStatus ?? "pending") : undefined,
    reviewStatus: input.config.landing.review.enabled
      ? (input.worker.reviewStatus ?? "pending")
      : input.worker.reviewStatus,
  };
  const updateWorker = (nextWorker: WorkerRuntime): WorkerRuntime => {
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
        return buildAttentionState(worker, rebase.detail);
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
        verifiedAt: postValidationLanding.checkedAt,
        tmuxBackend: input.tmuxBackend,
        runner: input.runner,
      });
    }

    if (input.config.landing.review.enabled && (postValidationLanding.aheadCount ?? 0) > 0) {
      const reviewLogFile = resolveReviewerLogFile(worker);
      worker = updateWorker({
        ...worker,
        reviewStatus: "pending",
        reviewAt: new Date().toISOString(),
        reviewSummary: `Reviewer gate is running before merge-back. See ${reviewLogFile} for live output.`,
        landingVerification: `Running reviewer-agent gate before landing. See ${reviewLogFile} for live output.`,
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
        const reviewLogFile = resolveReviewerLogFile(worker);
        return buildAttentionState(
          worker,
          `Reviewer gate failed: ${humanizeError(error)}. See ${reviewLogFile}.`,
          {
            reviewStatus: "review-blocked",
            reviewSummary: `Reviewer gate failed: ${humanizeError(error)}. See ${reviewLogFile}.`,
            landingVerification: `Landing blocked: reviewer gate failed (${humanizeError(error)}). See ${reviewLogFile}.`,
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
        };
      } else if (reviewPass.decision.verdict === "approve-with-nits") {
        worker = {
          ...worker,
          reviewStatus: "nits-only",
          reviewSummary: `Reviewer approved with nits. ${normalizedSummary}`,
        };
      } else if (!reviewPass.assessment.requiresChanges) {
        worker = {
          ...worker,
          reviewStatus: "nits-only",
          reviewSummary:
            "Reviewer requested changes, but no valid in-scope blockers were found. " +
            normalizedSummary,
        };
      } else {
        worker = {
          ...worker,
          reviewStatus: "changes-requested",
          reviewSummary: `Reviewer requested valid in-scope changes. ${normalizedSummary}`,
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
      const heldWorker: WorkerRuntime = {
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

    if (verifiedAfterLanding.verified) {
      return finalizeLandedWorker({
        repoRoot: input.repoRoot,
        worker,
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
  tmuxBackend?: TmuxBackend;
}): Promise<WorkerRuntime> {
  const tmuxBackend = input.tmuxBackend ?? createTmuxBackend();
  const ticket = await input.adapter.show(input.cwd, input.ticketId);
  if (ticket.type === "epic") {
    throw new Error(`Cannot launch a worker directly for epic ${ticket.id}. Use /bw run instead.`);
  }

  const epic = ticket.parentId ? await input.adapter.show(input.cwd, ticket.parentId) : undefined;
  const prepared = await prepareTicketWorktree({
    repoRoot: input.repoRoot,
    ticketId: ticket.id,
    title: ticket.title,
    baseDir: input.config.worktrees.baseDir,
    copyFiles: input.config.worktrees.copyFiles,
    setupCommands: input.config.worktrees.setupCommands,
    rerunSetupOnReuse: input.config.worktrees.rerunSetupOnReuse,
  });

  const registryPath = resolveWorkerRegistryPath(
    input.repoRoot,
    input.config.storage.workerRegistryFile,
  );
  const runtimeRoot = resolveWorkerRuntimeDir(input.repoRoot, input.config.storage.runtimeDir);
  const workerId = buildWorkerId(ticket.id);
  const runtimeDir = path.join(runtimeRoot, workerId);
  await mkdir(runtimeDir, { recursive: true });

  const prompt = buildWorkerHandoff({
    ticket,
    epic,
    branchName: prepared.branchName,
    worktreePath: prepared.worktreePath,
    prime: input.prime,
  });

  const promptFile = path.join(runtimeDir, "handoff.txt");
  const logFile = path.join(runtimeDir, "worker.log");
  const stateFile = path.join(runtimeDir, "state.txt");
  const exitCodeFile = path.join(runtimeDir, "exit-code.txt");
  const finishedAtFile = path.join(runtimeDir, "finished-at.txt");
  const scriptFile = path.join(runtimeDir, "launch.sh");
  const workerAgentCommand = buildWorkerAgentCommand(input.config);

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
  const pendingWorker: WorkerRuntime = {
    workerId,
    ticketId: ticket.id,
    epicId: input.epicId ?? ticket.parentId,
    ticketTitle: ticket.title,
    ticketStatus: ticket.status,
    branchName: prepared.branchName,
    worktreePath: prepared.worktreePath,
    backend: "tmux",
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
    workerCommand: input.config.tmux.workerCommand,
    workerProvider: input.config.tmux.workerProvider,
    workerModel: input.config.tmux.workerModel,
    reviewerProvider: input.config.landing.review.provider ?? input.config.tmux.workerProvider,
    reviewerModel: input.config.landing.review.model ?? input.config.tmux.workerModel,
    cleanupPolicy: input.config.worktrees.cleanup,
    landingPolicy: input.config.landing.policy,
    reviewStatus: input.config.landing.review.enabled ? "pending" : undefined,
    cleanupStatus:
      input.config.worktrees.cleanup === "cleanup-after-landing" ? "pending" : undefined,
    status: "launching",
    startedAt: now,
    updatedAt: now,
  };

  await upsertWorkerRuntime(registryPath, pendingWorker);
  await tmuxBackend.ensureSession({ sessionName: input.config.tmux.sessionName });
  const launched = await tmuxBackend.launchWorker({
    sessionName: input.config.tmux.sessionName,
    workerId,
    title: ticket.title,
    worktreePath: prepared.worktreePath,
    launchCommand,
  });

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
  const shouldRequestLanding =
    input.requestLanding === true || Boolean(input.worker.landingRequestedAt);

  if (
    input.worker.status === "landed" &&
    input.worker.landingVerifiedAt &&
    (!validationRequired || input.worker.validationStatus === "passed")
  ) {
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
    input.worker.status === "landed";

  if (ticketStatus === "closed" && workerFinished && config) {
    const orchestratedWorker = {
      ...input.worker,
      ticketStatus,
      tmuxSession: resolvedTmuxSession,
      tmuxWindow: resolvedTmuxWindow,
      tmuxPane: resolvedTmuxPane,
      finishedAt: finishedAtText ?? input.worker.finishedAt,
    };
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
    const attemptedTicketIds = new Set(workers.map((worker) => worker.ticketId));
    const activeWorkers = workers.filter(
      (worker) => worker.status === "launching" || worker.status === "running",
    );
    const launchable = ready.filter(
      (issue) => !attemptedTicketIds.has(issue.id) && issue.type !== "epic",
    );
    const launchedThisCycle: string[] = [];

    if (!input.options.dryRun && !input.options.noSpawn) {
      const availableSlots = Math.max(0, input.options.workers - activeWorkers.length);
      for (const issue of launchable.slice(0, availableSlots)) {
        const worker = await launchTicketWorker({
          cwd: input.cwd,
          repoRoot: input.repoRoot,
          config: input.config,
          adapter: input.adapter,
          ticketId: issue.id,
          epicId: input.epicId,
          prime: input.prime,
          tmuxBackend,
        });
        launched.add(worker.ticketId);
        launchedThisCycle.push(worker.ticketId);
        workers.push(worker);
      }
    } else if (launchable.length > 0) {
      notes.push(
        `Cycle ${cycle}: ${launchable
          .slice(0, input.options.workers)
          .map((issue) => issue.id)
          .join(", ")} would be launched.`,
      );
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
