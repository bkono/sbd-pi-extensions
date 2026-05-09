import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { type AttributionEvidencePack, buildAttributionEvidencePack } from "./attribution.js";
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
  ReviewFinding,
  ReviewTriageDecision,
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

export type { AttributionCommitEvidence, AttributionEvidencePack } from "./attribution.js";
export { buildAttributionEvidencePack } from "./attribution.js";

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
const MAX_CURRENT_BRANCH_REMEDIATION_ATTEMPTS = 2;
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

function formatCurrentBranchReviewFinding(value: {
  file?: unknown;
  issue?: unknown;
  suggestion?: unknown;
  severity?: unknown;
}): string | undefined {
  const issue = typeof value.issue === "string" ? value.issue.trim() : "";
  const suggestion = typeof value.suggestion === "string" ? value.suggestion.trim() : "";
  if (!issue && !suggestion) {
    return undefined;
  }
  const file =
    typeof value.file === "string" && value.file.trim() ? value.file.trim() : "unspecified";
  const severity =
    typeof value.severity === "string" && value.severity.trim() ? value.severity.trim() : "fix";
  const parts = [`[${severity}] ${file}`];
  if (issue) {
    parts.push(`issue: ${issue}`);
  }
  if (suggestion) {
    parts.push(`suggestion: ${suggestion}`);
  }
  return parts.join(" — ");
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
    file?: unknown;
    issue?: unknown;
    suggestion?: unknown;
    intentAlignment?: unknown;
    requiresChanges?: unknown;
    severity?: unknown;
  };
  const comment =
    typeof objectValue.comment === "string" && objectValue.comment.trim().length > 0
      ? objectValue.comment.trim()
      : formatCurrentBranchReviewFinding(objectValue);
  if (!comment) {
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
    comment,
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

class ReviewOutputParseError extends Error {
  readonly rawOutput: string;

  constructor(message: string, rawOutput: string) {
    super(message);
    this.name = "ReviewOutputParseError";
    this.rawOutput = rawOutput;
  }
}

type CurrentBranchReviewResult = {
  checkedAt: string;
  summary: string;
  findings: ReviewFinding[];
  rawOutput: string;
  reviewLogFile: string;
};

type CurrentBranchReviewContextArtifacts = {
  ticket: BeadworkIssueDetail;
  epic?: BeadworkIssueDetail;
  history: unknown[];
  evidence: AttributionEvidencePack;
};

function normalizeReviewSeverity(value: unknown): "fix" | "nit" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "fix" || normalized === "nit" ? normalized : undefined;
}

function normalizeReviewFinding(value: unknown): ReviewFinding | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const file = typeof record.file === "string" ? record.file.trim() : "";
  const issue = typeof record.issue === "string" ? record.issue.trim() : "";
  const suggestion = typeof record.suggestion === "string" ? record.suggestion.trim() : "";
  const severity = normalizeReviewSeverity(record.severity);

  if (!file || !issue || !suggestion || !severity) {
    return undefined;
  }

  return { file, issue, suggestion, severity };
}

function parseCurrentBranchReviewOutput(rawOutput: string): {
  summary: string;
  findings: ReviewFinding[];
} {
  let payload: unknown;
  try {
    payload = extractJsonPayload(rawOutput);
  } catch (error) {
    throw new ReviewOutputParseError(humanizeError(error), rawOutput);
  }
  if (!payload || typeof payload !== "object") {
    throw new ReviewOutputParseError(
      "Reviewer output was not a structured report object.",
      rawOutput,
    );
  }

  const record = payload as { summary?: unknown; findings?: unknown };
  if (!Array.isArray(record.findings)) {
    throw new ReviewOutputParseError(
      "Current-branch reviewer output must contain a findings array.",
      rawOutput,
    );
  }

  const findings = record.findings.map(normalizeReviewFinding);
  if (findings.some((finding) => finding === undefined)) {
    throw new ReviewOutputParseError(
      "Current-branch reviewer findings must include file, issue, suggestion, and severity fix|nit.",
      rawOutput,
    );
  }

  return {
    summary:
      typeof record.summary === "string" && record.summary.trim().length > 0
        ? record.summary.trim()
        : "Reviewer did not provide a summary.",
    findings: findings as ReviewFinding[],
  };
}

function reviewFindingKey(finding: ReviewFinding): string {
  return [finding.severity, finding.file, finding.issue, finding.suggestion]
    .map((value) => value.trim().toLowerCase())
    .join("|");
}

function reviewFindingSetKey(findings: ReviewFinding[]): string {
  return findings.map(reviewFindingKey).sort().join("\n");
}

function classifyReviewFinding(finding: ReviewFinding): ReviewTriageDecision {
  const text = `${finding.file} ${finding.issue} ${finding.suggestion}`.toLowerCase();
  const findingKey = reviewFindingKey(finding);

  if (
    /\b(false positive|invalid|misunderstood|misunderstanding|already fixed|already handled|not applicable|cannot reproduce)\b/.test(
      text,
    )
  ) {
    return {
      finding,
      findingKey,
      classification: "reject",
      rationale: "Finding appears invalid or based on reviewer misunderstanding.",
      action: "discarded",
    };
  }

  if (
    /\b(out of scope|unrelated|follow[- ]?up|future work|nice to have|prefer(?:ence)?|style only)\b/.test(
      text,
    )
  ) {
    return {
      finding,
      findingKey,
      classification: "file",
      rationale:
        "Finding is valid follow-up material but not required for this ticket verification.",
      action: "follow-up pending",
    };
  }

  if (finding.severity === "nit") {
    if (
      /\b(security|data loss|crash|compile|typecheck|test failure|broken|regression)\b/.test(text)
    ) {
      return {
        finding,
        findingKey,
        classification: "fix",
        rationale: "Reviewer marked this as a nit, but the diagnostic names a blocker-class issue.",
        action: "send to current-branch remediation",
      };
    }

    return {
      finding,
      findingKey,
      classification: "file",
      rationale: "Nit findings default to non-blocking follow-up unless they describe a blocker.",
      action: "follow-up pending",
    };
  }

  return {
    finding,
    findingKey,
    classification: "fix",
    rationale: "Reviewer requested an in-scope fix and no reject/file heuristic matched.",
    action: "send to current-branch remediation",
  };
}

function summarizeTriageDecisions(decisions: ReviewTriageDecision[]): string {
  const fixCount = decisions.filter((decision) => decision.classification === "fix").length;
  const fileCount = decisions.filter((decision) => decision.classification === "file").length;
  const rejectCount = decisions.filter((decision) => decision.classification === "reject").length;
  return `Coordinator triage: fix=${fixCount}, file=${fileCount}, reject=${rejectCount}.`;
}

function formatTriageDecision(decision: ReviewTriageDecision): string {
  return `${decision.classification.toUpperCase()} ${decision.finding.severity} ${decision.finding.file}: ${decision.finding.issue} — ${decision.rationale} Action: ${decision.action}.`;
}

function formatFixFindingsForRemediation(decisions: ReviewTriageDecision[]): string {
  return decisions
    .filter((decision) => decision.classification === "fix")
    .map((decision, index) =>
      [
        `${index + 1}. ${decision.finding.file}`,
        `   original severity: ${decision.finding.severity}`,
        `   issue: ${decision.finding.issue}`,
        `   suggestion: ${decision.finding.suggestion}`,
        `   coordinator rationale: ${decision.rationale}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function hasNoCodeExplanation(history: unknown[]): boolean {
  const text = history.map((entry) => JSON.stringify(entry)).join("\n");
  return /\b(no code changes?|no commits?|nothing to commit|no-op|already (?:implemented|complete)|not required)\b/i.test(
    text,
  );
}

function renderHistoryForPrompt(history: unknown[]): string {
  if (history.length === 0) {
    return "No beadwork history or handoff comments were available.";
  }

  return history
    .map((entry, index) => `${index + 1}. ${JSON.stringify(entry, null, 2)}`)
    .join("\n\n");
}

function renderCommitListForPrompt(evidence: AttributionEvidencePack): string {
  if (evidence.candidateCommits.length === 0) {
    return "No candidate commits were attributed; reviewer should inspect handoff/context before concluding.";
  }

  return evidence.candidateCommits
    .map((commit) => {
      const paths =
        commit.touchedPaths.length > 0 ? commit.touchedPaths.join(", ") : "none derived";
      return `- ${commit.sha} ${commit.subject}\n  sources: ${commit.sources.join(", ")}\n  touched paths: ${paths}`;
    })
    .join("\n");
}

function buildCurrentBranchReviewerPrompt(input: {
  worker: CurrentBranchWorkerRuntime;
  artifacts: CurrentBranchReviewContextArtifacts;
  validationCommands: string[];
}): string {
  const { evidence, epic, history, ticket } = input.artifacts;
  const lines = [
    "You are a reviewer agent inspecting ticket-attributed commits on the current branch.",
    "This is a per-worker quality review, not a merge-back gate and not a precomputed diff review.",
    "Use your own tools to inspect the repository: read files, grep call sites, run git show <sha>, and run relevant commands when useful.",
    "Do not edit files. Produce concrete findings that the coordinator can triage later.",
    "",
    "Finish with exactly one machine-readable handoff enclosed in <review_report> tags:",
    "<review_report>",
    "{",
    '  "summary": "short summary",',
    '  "findings": [',
    '    { "file": "path", "issue": "what is wrong", "suggestion": "what should change", "severity": "fix" | "nit" }',
    "  ]",
    "}",
    "</review_report>",
    "",
    `Ticket: ${ticket.id} ${ticket.title}`,
    `Ticket status/type: ${ticket.status}/${ticket.type}`,
    `Checkout: ${input.worker.checkoutPath}`,
    `Recorded branch: ${input.worker.branchName}`,
    `Recorded launch head: ${input.worker.launchHead}`,
  ];

  if (epic) {
    lines.push(`Epic/scope: ${epic.id} ${epic.title}`);
  }

  if (ticket.description.trim()) {
    lines.push("", "Ticket description:", truncateForPrompt(ticket.description, 2_500));
  }

  if (epic?.description.trim()) {
    lines.push("", "Epic/scope goal:", truncateForPrompt(epic.description, 2_500));
  }

  if (input.validationCommands.length > 0) {
    lines.push("", "Validation commands claimed/expected by this workflow:");
    for (const command of input.validationCommands) {
      lines.push(`- ${command}`);
    }
  }

  lines.push(
    "",
    "Attributed commit list to inspect with tools:",
    renderCommitListForPrompt(evidence),
    "",
    "Worker handoff/comments and coordination context:",
    truncateForPrompt(renderHistoryForPrompt(history), 4_000),
    "",
    "Attribution diagnostics:",
    evidence.attention.length > 0
      ? evidence.attention.map((item) => `- ${item}`).join("\n")
      : "No attribution attention flags were detected.",
    "",
    "Review rules:",
    "- Inspect commit SHAs directly; for example run git show on the listed SHAs instead of relying on this prompt.",
    "- Report only concrete, in-scope findings with file paths and actionable suggestions.",
    "- Use severity=fix for likely in-scope corrections; use severity=nit for minor follow-up material.",
    "- Return findings=[] when you find no concrete issues.",
  );

  return lines.join("\n");
}

async function safeLoadCurrentBranchReviewArtifacts(input: {
  cwd: string;
  adapter: BeadworkAdapter;
  runner: ProcessRunner;
  worker: CurrentBranchWorkerRuntime;
}): Promise<CurrentBranchReviewContextArtifacts> {
  const ticket = await input.adapter.show(input.cwd, input.worker.ticketId);
  const epic = ticket.parentId ? await input.adapter.show(input.cwd, ticket.parentId) : undefined;
  const history =
    typeof input.adapter.history === "function"
      ? await input.adapter.history(input.cwd, input.worker.ticketId)
      : [];
  const evidence = await buildAttributionEvidencePack({
    worker: input.worker,
    adapter: input.adapter,
    processRunner: input.runner,
  });

  return { ticket, epic, history, evidence };
}

function attributionCommitShas(evidence: AttributionEvidencePack): string[] {
  return evidence.candidateCommits.map((commit) => commit.sha);
}

function attributionTouchedPaths(evidence: AttributionEvidencePack): string[] {
  return [...new Set(evidence.candidateCommits.flatMap((commit) => commit.touchedPaths))];
}

function resolveCurrentBranchAttributionEvidenceFile(worker: CurrentBranchWorkerRuntime): string {
  return path.join(worker.runtimeDir, "current-branch-attribution.md");
}

async function persistCurrentBranchAttributionEvidence(input: {
  cwd: string;
  worker: CurrentBranchWorkerRuntime;
  adapter: BeadworkAdapter;
  runner: ProcessRunner;
}): Promise<{
  artifacts: CurrentBranchReviewContextArtifacts;
  worker: CurrentBranchWorkerRuntime;
}> {
  const artifacts = await safeLoadCurrentBranchReviewArtifacts({
    cwd: input.cwd,
    adapter: input.adapter,
    runner: input.runner,
    worker: input.worker,
  });
  const evidenceFile = resolveCurrentBranchAttributionEvidenceFile(input.worker);
  await mkdir(input.worker.runtimeDir, { recursive: true });
  await writeFile(evidenceFile, `${artifacts.evidence.renderedText}\n`, "utf8");

  return {
    artifacts,
    worker: {
      ...input.worker,
      commitShas: attributionCommitShas(artifacts.evidence),
      touchedPaths: attributionTouchedPaths(artifacts.evidence),
      validationStatus: "passed",
      validationAt: new Date().toISOString(),
      validationSummary:
        artifacts.evidence.attention.length > 0
          ? `Attribution evidence gathered with ${artifacts.evidence.attention.length} attention flag(s).`
          : `Attribution evidence gathered for ${artifacts.evidence.candidateCommits.length} candidate commit(s).`,
      updatedAt: new Date().toISOString(),
    },
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

async function resolveCurrentBranchHead(input: {
  runner: ProcessRunner;
  checkoutPath: string;
}): Promise<string | undefined> {
  try {
    const result = await input.runner("git", ["rev-parse", "HEAD"], {
      cwd: input.checkoutPath,
      timeout: 10_000,
    });
    const head = result.code === 0 ? result.stdout.trim() : "";
    return head.length > 0 ? head : undefined;
  } catch {
    return undefined;
  }
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

type CurrentBranchReviewPassResult = CurrentBranchReviewResult & {
  evidence: AttributionEvidencePack;
  reviewedHead?: string;
};

async function runCurrentBranchReviewerPass(input: {
  cwd: string;
  worker: CurrentBranchWorkerRuntime;
  config: BeadworkConfig;
  adapter: BeadworkAdapter;
  runner: ProcessRunner;
}): Promise<CurrentBranchReviewPassResult> {
  const { artifacts, worker } = await persistCurrentBranchAttributionEvidence({
    cwd: input.cwd,
    worker: input.worker,
    adapter: input.adapter,
    runner: input.runner,
  });
  const prompt = buildCurrentBranchReviewerPrompt({
    worker,
    artifacts,
    validationCommands: input.config.landing.validateCommands,
  });
  const promptFile = path.join(worker.runtimeDir, "current-branch-review-handoff.txt");
  const reviewLogFile = resolveReviewerLogFile(worker);
  await writeFile(promptFile, `${prompt}\n`, "utf8");

  await writeFile(reviewLogFile, "", { flag: "a" });
  const reviewLog = createWriteStream(reviewLogFile, { flags: "a", encoding: "utf8" });
  let sawStdout = false;
  let sawStderr = false;
  reviewLog.write(
    `[beadwork current-branch reviewer] started ${new Date().toISOString()}\n` +
      `[beadwork current-branch reviewer] cwd: ${worker.checkoutPath}\n` +
      `[beadwork current-branch reviewer] handoff: ${promptFile}\n`,
  );

  const reviewerCommand = buildReviewerAgentCommand(input.config, worker);
  const reviewerInvocation = `${reviewerCommand} "$(cat ${shellQuote(promptFile)})"`;
  reviewLog.write(`[beadwork current-branch reviewer] command: ${reviewerInvocation}\n`);

  let reviewResult: Awaited<ReturnType<ProcessRunner>>;
  try {
    reviewResult = await input.runner("bash", ["-lc", reviewerInvocation], {
      cwd: worker.checkoutPath,
      timeout: input.config.landing.review.commandTimeoutMs,
      onStdoutChunk: (chunk) => {
        if (!sawStdout) {
          sawStdout = true;
          reviewLog.write("[beadwork current-branch reviewer stdout]\n");
        }
        reviewLog.write(chunk);
      },
      onStderrChunk: (chunk) => {
        if (!sawStderr) {
          sawStderr = true;
          reviewLog.write("[beadwork current-branch reviewer stderr]\n");
        }
        reviewLog.write(chunk);
      },
    });
  } catch (error) {
    reviewLog.write(`\n[beadwork current-branch reviewer] failed ${new Date().toISOString()}\n`);
    await new Promise<void>((resolve) => {
      reviewLog.end(resolve);
    });
    throw error;
  }

  reviewLog.write(`\n[beadwork current-branch reviewer] finished ${new Date().toISOString()}\n`);
  await new Promise<void>((resolve) => {
    reviewLog.end(resolve);
  });

  const rawOutput = `${reviewResult.stdout}\n${reviewResult.stderr}`;
  const parsed = parseCurrentBranchReviewOutput(rawOutput);
  const headResult = await input.runner("git", ["rev-parse", "HEAD"], {
    cwd: worker.checkoutPath,
    timeout: 10_000,
  });

  return {
    checkedAt: new Date().toISOString(),
    summary: parsed.summary,
    findings: parsed.findings,
    rawOutput,
    reviewLogFile,
    evidence: artifacts.evidence,
    reviewedHead: headResult.code === 0 ? headResult.stdout.trim() : undefined,
  };
}

function isActiveWorkerProcess(worker: WorkerRuntime): boolean {
  return worker.status === "running" || worker.status === "launching";
}

async function runCurrentBranchReviewOperation(
  input: CurrentBranchVerificationContext,
): Promise<CurrentBranchWorkerRuntime> {
  if (isActiveWorkerProcess(input.worker)) {
    return {
      ...input.worker,
      status: "running",
      updatedAt: new Date().toISOString(),
    };
  }

  if (
    input.config.workerExecution.review.enabled === false &&
    input.worker.reviewStatus === "remediation-in-progress" &&
    input.worker.reviewTriageFindingSetKey &&
    input.worker.currentBranchRemediationFindingSetKey === input.worker.reviewTriageFindingSetKey
  ) {
    return {
      ...input.worker,
      status: "running",
      updatedAt: new Date().toISOString(),
    };
  }

  if (input.config.workerExecution.review.enabled === false) {
    return {
      ...input.worker,
      reviewStatus: undefined,
      reviewSummary:
        "Current-branch worker review disabled by workerExecution.review.enabled=false.",
      updatedAt: new Date().toISOString(),
    };
  }

  if (hasReusableApprovedReview(input.worker)) {
    const workerHead = await resolveCurrentBranchHead({
      runner: input.runner,
      checkoutPath: input.worker.checkoutPath,
    });
    if (canReuseApprovedReview(input.worker, workerHead)) {
      return input.worker;
    }
  }

  const pendingWorker: CurrentBranchWorkerRuntime = {
    ...input.worker,
    reviewStatus: "pending",
    reviewAt: new Date().toISOString(),
    reviewSummary: "Current-branch reviewer gate is running.",
    reviewedWorkerHead: undefined,
    updatedAt: new Date().toISOString(),
  };

  let review: CurrentBranchReviewPassResult;
  try {
    review = await runCurrentBranchReviewerPass({
      cwd: input.cwd,
      worker: pendingWorker,
      config: input.config,
      adapter: input.adapter,
      runner: input.runner,
    });
  } catch (error) {
    const rawOutput = error instanceof ReviewOutputParseError ? error.rawOutput : undefined;
    return buildAttentionState(
      pendingWorker,
      `Current-branch reviewer gate failed: ${humanizeError(error)}`,
      {
        reviewStatus: "review-blocked",
        reviewRawOutput: rawOutput,
        reviewSummary: `Reviewer gate failed: ${humanizeError(error)}. Raw output/artifacts are preserved in ${resolveReviewerLogFile(pendingWorker)}.`,
      },
    );
  }

  const now = new Date().toISOString();
  const fixFindings = review.findings.filter((finding) => finding.severity === "fix");
  const nits = review.findings.filter((finding) => finding.severity === "nit");
  const verdict: WorkerReviewVerdict =
    fixFindings.length > 0 ? "request-changes" : nits.length > 0 ? "approve-with-nits" : "approve";

  return {
    ...pendingWorker,
    commitShas: attributionCommitShas(review.evidence),
    touchedPaths: attributionTouchedPaths(review.evidence),
    reviewStatus:
      verdict === "request-changes"
        ? "changes-requested"
        : verdict === "approve-with-nits"
          ? "nits-only"
          : "approved",
    reviewVerdict: verdict,
    reviewAt: review.checkedAt,
    reviewSummary: `${review.summary} Artifacts: ${review.reviewLogFile}.`,
    reviewFindings: review.findings,
    reviewRawOutput: review.rawOutput,
    reviewFeedback: review.findings
      .map(formatCurrentBranchReviewFinding)
      .filter((value): value is string => Boolean(value)),
    reviewValidFeedbackCount: review.findings.length,
    reviewInvalidFeedbackCount: 0,
    reviewedWorkerHead: review.reviewedHead,
    validationStatus: "passed",
    validationAt: now,
    validationSummary:
      review.evidence.attention.length > 0
        ? `Attribution evidence gathered with ${review.evidence.attention.length} attention flag(s).`
        : `Attribution evidence gathered for ${review.evidence.candidateCommits.length} candidate commit(s).`,
    updatedAt: now,
  };
}

async function buildAttributionEvidenceOperation(
  input: CurrentBranchVerificationContext,
): Promise<CurrentBranchWorkerRuntime> {
  const result = await persistCurrentBranchAttributionEvidence({
    cwd: input.cwd,
    worker: input.worker,
    adapter: input.adapter,
    runner: input.runner,
  });
  return result.worker;
}

async function applyCoordinatorTriageOperation(
  input: CurrentBranchVerificationContext,
): Promise<CurrentBranchWorkerRuntime> {
  const findings = input.worker.reviewFindings ?? [];
  const findingSetKey = reviewFindingSetKey(findings);

  if (
    input.worker.reviewTriageFindingSetKey === findingSetKey &&
    input.worker.reviewTriageDecisions
  ) {
    return input.worker;
  }

  if (input.worker.reviewStatus === "review-blocked" || input.worker.reviewStatus === "pending") {
    return input.worker;
  }

  const decisions = findings.map(classifyReviewFinding);
  const fileDecisions = decisions.filter((decision) => decision.classification === "file");
  const fixDecisions = decisions.filter((decision) => decision.classification === "fix");

  for (const decision of fileDecisions) {
    await input.adapter.comment(
      input.worker.checkoutPath,
      input.worker.ticketId,
      [
        "coordinator follow-up from reviewer triage:",
        formatTriageDecision(decision),
        "This is filed as non-blocking follow-up and does not block verification of the current ticket.",
      ].join("\n"),
    );
    decision.action = "filed non-blocking follow-up comment on ticket";
  }

  for (const decision of decisions.filter((item) => item.classification === "reject")) {
    decision.action = "discarded by coordinator triage";
  }

  for (const decision of fixDecisions) {
    decision.action = "approved for current-branch remediation";
  }

  const summary = `${summarizeTriageDecisions(decisions)} ${decisions
    .map(formatTriageDecision)
    .join(" ")}`;

  return {
    ...input.worker,
    reviewStatus:
      fixDecisions.length > 0
        ? "changes-requested"
        : input.worker.reviewStatus === "changes-requested"
          ? "nits-only"
          : input.worker.reviewStatus,
    reviewTriageAt: new Date().toISOString(),
    reviewTriageSummary: summary,
    reviewTriageDecisions: decisions,
    reviewTriageFindingSetKey: findingSetKey,
    reviewSummary: input.worker.reviewSummary
      ? `${input.worker.reviewSummary} ${summarizeTriageDecisions(decisions)}`
      : summarizeTriageDecisions(decisions),
    updatedAt: new Date().toISOString(),
  };
}

async function buildCurrentBranchRemediationPrompt(input: {
  worker: CurrentBranchWorkerRuntime;
  ticket: BeadworkIssueDetail;
  epic?: BeadworkIssueDetail;
  config: BeadworkConfig;
  fixDecisions: ReviewTriageDecision[];
  attempt: number;
}): Promise<string> {
  const basePrompt = buildCurrentBranchHandoffPrompt({
    ticket: input.ticket,
    epic: input.epic,
    checkoutPath: input.worker.checkoutPath,
    branchName: input.worker.branchName,
    runtimeScratchDir: path.join(input.worker.runtimeDir, "scratch"),
  });

  return [
    basePrompt,
    "",
    "Coordinator review remediation:",
    `- Continue ticket \`${input.worker.ticketId}\` after coordinator review.`,
    `- This is current-branch remediation attempt ${input.attempt}/${MAX_CURRENT_BRANCH_REMEDIATION_ATTEMPTS}.`,
    "- Address only the coordinator-approved `fix` findings below or validation failures explicitly listed by the coordinator.",
    "- Ignore findings classified as `file` or `reject`; they are intentionally not included here.",
    "- Inspect existing ticket commits, beadwork comments, and current checkout state before changing files.",
    `- Make additional atomic commits referencing ${input.worker.ticketId}; commit only the specific changed files with \`git commit <specific-files> -m "... ${input.worker.ticketId} ..."\`.`,
    "- Update the handoff comment with new commit SHAs and validation results.",
    `- Close ticket ${input.worker.ticketId} and run \`bw sync\` when done, or explain the blocker in a comment and leave the ticket open.`,
    "",
    "Coordinator-approved fix findings:",
    formatFixFindingsForRemediation(input.fixDecisions),
    "",
    "Validation commands to run before handoff:",
    input.config.landing.validateCommands.map((command) => `- ${command}`).join("\n") ||
      "- No validation commands configured.",
  ].join("\n");
}

async function relaunchCurrentBranchWorkerForCoordinatorFixes(input: {
  context: CurrentBranchVerificationContext;
  fixDecisions: ReviewTriageDecision[];
}): Promise<CurrentBranchWorkerRuntime> {
  const { context, fixDecisions } = input;
  const worker = context.worker;
  const attempt = (worker.reviewRemediationAttempts ?? 0) + 1;
  const issue = await context.adapter.show(worker.checkoutPath, worker.ticketId);
  let ticket = issue;

  if (issue.status === "closed") {
    await context.adapter.reopen(worker.checkoutPath, worker.ticketId);
    await context.adapter.comment(
      worker.checkoutPath,
      worker.ticketId,
      `Coordinator-approved remediation is reopening this closed ticket for current-branch attempt ${attempt}/${MAX_CURRENT_BRANCH_REMEDIATION_ATTEMPTS}.`,
    );
    ticket = { ...issue, status: "open" };
  } else {
    await context.adapter.comment(
      worker.checkoutPath,
      worker.ticketId,
      `Coordinator-approved current-branch remediation attempt ${attempt}/${MAX_CURRENT_BRANCH_REMEDIATION_ATTEMPTS} is starting.`,
    );
  }

  const epic = worker.epicId
    ? await context.adapter.show(worker.checkoutPath, worker.epicId)
    : undefined;
  const remediationPrompt = await buildCurrentBranchRemediationPrompt({
    worker,
    ticket,
    epic,
    config: context.config,
    fixDecisions,
    attempt,
  });
  const workerAgentCommand = buildWorkerAgentCommand(context.config, worker);

  await writeFile(worker.promptFile, `${remediationPrompt}\n`, "utf8");
  await writeFile(
    worker.scriptFile,
    buildWorkerScript({
      workerAgentCommand,
      promptFile: worker.promptFile,
      logFile: worker.logFile,
      stateFile: worker.stateFile,
      exitCodeFile: worker.exitCodeFile,
      finishedAtFile: worker.finishedAtFile,
    }),
    "utf8",
  );
  await chmod(worker.scriptFile, 0o755);
  await writeFile(worker.stateFile, "launching\n", "utf8");
  await writeFile(worker.exitCodeFile, "", "utf8");
  await writeFile(worker.finishedAtFile, "", "utf8");

  try {
    await context.tmuxBackend.cleanupWorker({
      paneId: worker.tmuxPane !== "pending" ? worker.tmuxPane : undefined,
      sessionName: worker.tmuxSession,
      windowName: worker.tmuxWindow,
    });
  } catch {
    // best-effort tmux cleanup only; no git/worktree cleanup is performed for current-branch remediation
  }

  await context.tmuxBackend.ensureSession({ sessionName: worker.tmuxSession });
  const launched = await context.tmuxBackend.launchWorker({
    sessionName: worker.tmuxSession,
    workerId: worker.workerId,
    title: worker.ticketTitle,
    worktreePath: worker.checkoutPath,
    launchCommand: worker.launchCommand,
  });

  const now = new Date().toISOString();
  return {
    ...worker,
    tmuxSession: launched.sessionName,
    tmuxWindow: launched.windowName,
    tmuxPane: launched.paneId,
    launchCommand: launched.launchCommand,
    status: "running",
    ticketStatus: "open",
    validationStatus: "pending",
    validationAt: now,
    validationSummary: `Current-branch coordinator remediation attempt ${attempt}/${MAX_CURRENT_BRANCH_REMEDIATION_ATTEMPTS} started.`,
    reviewStatus: "remediation-in-progress",
    reviewVerdict: "request-changes",
    reviewAt: now,
    reviewSummary: `${fixDecisions.length} coordinator-approved fix finding(s) sent to current-branch remediation.`,
    reviewFeedback: fixDecisions.map(formatTriageDecision),
    reviewValidFeedbackCount: fixDecisions.length,
    reviewedWorkerHead: undefined,
    reviewRemediationAttempts: attempt,
    reviewRemediationAt: now,
    currentBranchRemediationFindingSetKey: worker.reviewTriageFindingSetKey,
    currentBranchRemediationSummary: `Attempt ${attempt}/${MAX_CURRENT_BRANCH_REMEDIATION_ATTEMPTS} launched for ${fixDecisions.length} fix finding(s).`,
    landingVerifiedAt: undefined,
    landingVerification: `Current-branch remediation attempt ${attempt}/${MAX_CURRENT_BRANCH_REMEDIATION_ATTEMPTS} is running in the same checkout; no rebase, merge-back, containment, or worktree cleanup was run.`,
    lastError: undefined,
    finishedAt: undefined,
    updatedAt: now,
  };
}

async function handleCurrentBranchRemediationOperation(
  input: CurrentBranchVerificationContext,
): Promise<CurrentBranchWorkerRuntime> {
  const fixDecisions = (input.worker.reviewTriageDecisions ?? []).filter(
    (decision) => decision.classification === "fix",
  );

  if (fixDecisions.length === 0) {
    return input.worker;
  }

  if (isActiveWorkerProcess(input.worker)) {
    return {
      ...input.worker,
      status: "running",
      updatedAt: new Date().toISOString(),
    };
  }

  if (
    input.worker.reviewStatus === "remediation-in-progress" &&
    input.worker.reviewTriageFindingSetKey &&
    input.worker.currentBranchRemediationFindingSetKey === input.worker.reviewTriageFindingSetKey
  ) {
    return {
      ...input.worker,
      status: "running",
      updatedAt: new Date().toISOString(),
    };
  }

  const attempts = input.worker.reviewRemediationAttempts ?? 0;
  if (attempts >= MAX_CURRENT_BRANCH_REMEDIATION_ATTEMPTS) {
    return buildAttentionState(
      input.worker,
      `Current-branch remediation attempts exhausted (${attempts}/${MAX_CURRENT_BRANCH_REMEDIATION_ATTEMPTS}).`,
      {
        reviewStatus: "review-blocked",
        currentBranchRemediationSummary: `Exhausted after ${attempts}/${MAX_CURRENT_BRANCH_REMEDIATION_ATTEMPTS} current-branch remediation attempts.`,
        landingVerification:
          "Current-branch verification blocked by unresolved coordinator-approved fixes.",
      },
    ) as CurrentBranchWorkerRuntime;
  }

  await appendWorkerLog(
    input.worker.logFile,
    `launching current-branch remediation attempt ${attempts + 1}/${MAX_CURRENT_BRANCH_REMEDIATION_ATTEMPTS}`,
  );
  await input.onLifecycleEvent?.(
    `Coordinator approved ${fixDecisions.length} review finding(s) for ${input.worker.ticketId}. ` +
      `Launching current-branch remediation attempt ${attempts + 1}/${MAX_CURRENT_BRANCH_REMEDIATION_ATTEMPTS}.`,
  );

  return relaunchCurrentBranchWorkerForCoordinatorFixes({ context: input, fixDecisions });
}

async function markCurrentBranchVerifiedOperation(
  input: CurrentBranchVerificationContext,
): Promise<CurrentBranchWorkerRuntime> {
  if (input.worker.status === "running") {
    return input.worker;
  }

  const fixDecisions = (input.worker.reviewTriageDecisions ?? []).filter(
    (decision) => decision.classification === "fix",
  );
  if (fixDecisions.length > 0) {
    return buildAttentionState(
      input.worker,
      "Current-branch verification still has unresolved fix findings.",
    ) as CurrentBranchWorkerRuntime;
  }

  const [attribution, ticket, history] = await Promise.all([
    persistCurrentBranchAttributionEvidence({
      cwd: input.cwd,
      worker: input.worker,
      adapter: input.adapter,
      runner: input.runner,
    }),
    input.adapter.show(input.worker.checkoutPath, input.worker.ticketId),
    input.adapter.history(input.worker.checkoutPath, input.worker.ticketId),
  ]);
  const evidence = attribution.artifacts.evidence;

  if (evidence.attention.length > 0) {
    return buildAttentionState(input.worker, evidence.attention.join(" "), {
      validationSummary: `Attribution evidence has ${evidence.attention.length} attention flag(s).`,
    }) as CurrentBranchWorkerRuntime;
  }

  const commitShas = attributionCommitShas(evidence);
  const touchedPaths = attributionTouchedPaths(evidence);
  if (commitShas.length === 0 && !hasNoCodeExplanation(history)) {
    return buildAttentionState(
      input.worker,
      "Current-branch verification found no attributed commits and no explicit no-code explanation.",
      {
        validationSummary: "Missing current-branch commit attribution.",
      },
    ) as CurrentBranchWorkerRuntime;
  }

  if (ticket.status !== "closed") {
    return buildAttentionState(
      input.worker,
      `Current-branch ticket ${input.worker.ticketId} is ${ticket.status}; worker must close or explain blocker before verification.`,
    ) as CurrentBranchWorkerRuntime;
  }

  const now = new Date().toISOString();
  return {
    ...input.worker,
    status: "verified",
    ticketStatus: "closed",
    validationStatus: "passed",
    validationAt: now,
    validationSummary:
      commitShas.length > 0
        ? `Verified ${commitShas.length} attributed commit(s) for current-branch worker.`
        : "Verified closed no-code ticket with explicit explanation in beadwork history.",
    commitShas,
    touchedPaths,
    landingVerifiedAt: now,
    landingVerification:
      "Current-branch worker verified: attribution, review triage, and ticket closure passed. No worktree rebase, merge-back, containment, or cleanup was run.",
    lastError: undefined,
    updatedAt: now,
  };
}

const DEFAULT_CURRENT_BRANCH_VERIFICATION_PIPELINE: CurrentBranchVerificationPipeline = {
  buildAttributionEvidence: buildAttributionEvidenceOperation,
  runWorkerReview: runCurrentBranchReviewOperation,
  applyCoordinatorTriage: applyCoordinatorTriageOperation,
  handleRemediation: handleCurrentBranchRemediationOperation,
  markVerified: markCurrentBranchVerifiedOperation,
};

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

  const pipeline = input.pipeline ?? DEFAULT_CURRENT_BRANCH_VERIFICATION_PIPELINE;

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
      const operation = pipeline[name];
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
      if (worker.status === "running") {
        return worker;
      }
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

  if (worker.status === "verified" || worker.status === "attention") {
    return worker;
  }

  return buildAttentionState(
    worker,
    "Current-branch verification is awaiting coordinator triage/remediation and final verified-state handling.",
    {
      landingVerification:
        "Current-branch review completed through the current implemented gate. No worktree rebase, merge-back, containment check, or cleanup was run.",
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

function hasInlineChildren(
  issue: BeadworkIssue | BeadworkIssueDetail,
): issue is BeadworkIssueDetail {
  return Array.isArray((issue as BeadworkIssueDetail).children);
}

async function loadScopeChildDetail(input: {
  cwd: string;
  adapter: BeadworkAdapter;
  child: BeadworkIssue;
}): Promise<BeadworkIssueDetail> {
  if (hasInlineChildren(input.child)) {
    return input.child;
  }

  const detail = await input.adapter.show(input.cwd, input.child.id);
  if (detail.id === input.child.id) {
    return detail;
  }

  return { ...input.child, children: [] };
}

async function isScopeTicketTerminal(input: {
  cwd: string;
  adapter: BeadworkAdapter;
  issue: BeadworkIssueDetail;
  seen?: Set<string>;
}): Promise<boolean> {
  const seen = input.seen ?? new Set<string>();
  if (seen.has(input.issue.id)) {
    return true;
  }
  seen.add(input.issue.id);

  if (input.issue.status !== "closed") {
    return false;
  }

  if (input.issue.children.length === 0) {
    return true;
  }

  for (const child of input.issue.children) {
    const childDetail = await loadScopeChildDetail({
      cwd: input.cwd,
      adapter: input.adapter,
      child,
    });
    if (!(await isScopeTicketTerminal({ ...input, issue: childDetail, seen }))) {
      return false;
    }
  }

  return true;
}

function hasUnresolvedFixFindings(worker: WorkerRuntime): boolean {
  return (worker.reviewTriageDecisions ?? []).some((decision) => decision.classification === "fix");
}

function requiresPendingScopeReviewGate(input: {
  config: BeadworkConfig;
  workers: WorkerRuntime[];
}): boolean {
  return (
    input.config.workerExecution.mode === "current-branch" ||
    input.workers.some((worker) => worker.executionMode === "current-branch")
  );
}

function pendingScopeReviewGateNote(): string {
  return (
    "Scope validation passed, but scope-completion review/fix-forward gating is pending. " +
    "The orchestrator cannot mark the current-branch scope completed until Phase 4 scope " +
    "review runs and has no unresolved fix findings."
  );
}

type DirtyStatusEntry = {
  code: string;
  path: string;
};

type DirtyStateRemediationAction = {
  type: "delete" | "restore" | "commit" | "create-follow-up" | "none";
  paths: string[];
  message?: string;
  title?: string;
  description?: string;
};

type DirtyStateRemediationDecision = {
  path: string;
  classification: string;
  rationale: string;
  action: DirtyStateRemediationAction;
};

type DirtyStateRemediationResult = {
  passed: boolean;
  detail: string;
  evidenceFile?: string;
  logFile?: string;
};

const DIRTY_STATE_SUMMARY_BYTES = 4_000;
const DIRTY_STATE_DIFF_BYTES = 12_000;
const DIRTY_STATE_LOG_BYTES = 8_000;
const DIRTY_STATE_APPROVED_ACTION_CLASSIFICATIONS: Record<
  DirtyStateRemediationAction["type"],
  ReadonlySet<string>
> = {
  delete: new Set(["generated-artifact"]),
  restore: new Set(["generated-artifact"]),
  commit: new Set(["valid-partial-work"]),
  "create-follow-up": new Set(["follow-up-task"]),
  none: new Set(["generated-artifact", "valid-partial-work", "follow-up-task"]),
};

function isDirtyStateActionClassificationApproved(
  classification: string,
  actionType: DirtyStateRemediationAction["type"],
): boolean {
  return DIRTY_STATE_APPROVED_ACTION_CLASSIFICATIONS[actionType].has(classification);
}

function parseDirtyStatus(raw: string): DirtyStatusEntry[] {
  return raw
    .split(/\r?\n/g)
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 3)
    .map((line) => {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const renameTarget = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() : rawPath;
      return { code, path: renameTarget ?? rawPath };
    })
    .filter((entry) => entry.path.length > 0);
}

function truncateDirtyStateValue(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function isSafeGeneratedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.includes("..") || normalized.startsWith("/")) {
    return false;
  }

  return (
    normalized.startsWith("dist/") ||
    normalized.startsWith("build/") ||
    normalized.startsWith("coverage/") ||
    normalized.startsWith(".turbo/") ||
    normalized.startsWith(".tsdown/") ||
    normalized.startsWith(".pi/beadwork/workers/runtime/") ||
    normalized.endsWith(".tsbuildinfo") ||
    normalized.endsWith(".log") ||
    normalized.endsWith(".tmp")
  );
}

function resolveRepoRelativePath(repoRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error(`Refusing unsafe path: ${relativePath}`);
  }

  const resolved = path.resolve(repoRoot, relativePath);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing path outside repository: ${relativePath}`);
  }
  return resolved;
}

function completedTicketIds(issue: BeadworkIssueDetail): string[] {
  const result: string[] = [];
  const visit = (current: BeadworkIssueDetail): void => {
    if (current.status === "closed") {
      result.push(current.id);
    }
    for (const child of current.children ?? []) {
      visit({ ...child, children: [] });
    }
  };
  visit(issue);
  return result;
}

async function summarizeUntrackedPath(repoRoot: string, relativePath: string): Promise<string> {
  try {
    const absolutePath = resolveRepoRelativePath(repoRoot, relativePath);
    const pathStat = await stat(absolutePath);
    if (pathStat.isDirectory()) {
      const entries = (await readdir(absolutePath)).slice(0, 25);
      return [
        `### ${relativePath}`,
        `directory, entries shown=${entries.length}`,
        ...entries.map((entry) => `- ${entry}`),
      ].join("\n");
    }

    if (!pathStat.isFile()) {
      return `### ${relativePath}\nnon-file path, size=${pathStat.size}`;
    }

    const fileHandle = await open(absolutePath, "r");
    const buffer = Buffer.alloc(Math.min(pathStat.size, DIRTY_STATE_SUMMARY_BYTES));
    try {
      await fileHandle.read(buffer, 0, buffer.length, 0);
    } finally {
      await fileHandle.close();
    }
    const text = buffer.toString("utf8");
    const binaryMarker = text.includes("\0") ? "\n[binary-looking content omitted]" : "";
    const truncationMarker =
      pathStat.size > DIRTY_STATE_SUMMARY_BYTES
        ? `\n[truncated ${pathStat.size - DIRTY_STATE_SUMMARY_BYTES} bytes]`
        : "";
    return [
      `### ${relativePath}`,
      `file, size=${pathStat.size} bytes`,
      "```",
      binaryMarker || `${text}${truncationMarker}`,
      "```",
    ].join("\n");
  } catch (error) {
    return `### ${relativePath}\nUnable to summarize: ${humanizeError(error)}`;
  }
}

async function runOptionalGitCommand(input: {
  repoRoot: string;
  runner: ProcessRunner;
  args: string[];
  maxChars: number;
}): Promise<string> {
  try {
    const result = await input.runner("git", input.args, { cwd: input.repoRoot, timeout: 30_000 });
    return truncateDirtyStateValue(result.stdout.trimEnd(), input.maxChars);
  } catch (error) {
    return `command failed: git ${input.args.join(" ")}\n${humanizeError(error)}`;
  }
}

function normalizeDirtyStateActions(value: unknown): DirtyStateRemediationDecision[] {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawDecisions = Array.isArray(record.decisions) ? record.decisions : [];
  return rawDecisions.map((rawDecision, index) => {
    if (!rawDecision || typeof rawDecision !== "object") {
      throw new Error(`Decision ${index + 1} is not an object.`);
    }
    const decision = rawDecision as Record<string, unknown>;
    const action = decision.action;
    if (!action || typeof action !== "object") {
      throw new Error(`Decision ${index + 1} is missing action.`);
    }
    const actionRecord = action as Record<string, unknown>;
    const type = actionRecord.type;
    if (
      type !== "delete" &&
      type !== "restore" &&
      type !== "commit" &&
      type !== "create-follow-up" &&
      type !== "none"
    ) {
      throw new Error(`Decision ${index + 1} has unsupported action type.`);
    }

    const paths = Array.isArray(actionRecord.paths)
      ? actionRecord.paths.filter((item): item is string => typeof item === "string")
      : [];

    return {
      path: typeof decision.path === "string" ? decision.path : (paths[0] ?? "<unknown>"),
      classification:
        typeof decision.classification === "string" ? decision.classification : "unsafe-unknown",
      rationale:
        typeof decision.rationale === "string" ? decision.rationale : "No rationale provided.",
      action: {
        type,
        paths,
        message: typeof actionRecord.message === "string" ? actionRecord.message : undefined,
        title: typeof actionRecord.title === "string" ? actionRecord.title : undefined,
        description:
          typeof actionRecord.description === "string" ? actionRecord.description : undefined,
      },
    };
  });
}

async function buildDirtyStateEvidencePack(input: {
  repoRoot: string;
  config: BeadworkConfig;
  epic: BeadworkIssueDetail;
  workers: WorkerRuntime[];
  statusRaw: string;
  statusEntries: DirtyStatusEntry[];
  runner: ProcessRunner;
}): Promise<string> {
  const trackedPaths = input.statusEntries
    .filter((entry) => entry.code !== "??")
    .map((entry) => entry.path);
  const untrackedPaths = input.statusEntries
    .filter((entry) => entry.code === "??")
    .map((entry) => entry.path);
  const diffArgs = trackedPaths.length > 0 ? ["diff", "--", ...trackedPaths] : ["diff", "--"];
  const cachedDiffArgs =
    trackedPaths.length > 0 ? ["diff", "--cached", "--", ...trackedPaths] : ["diff", "--cached"];
  const [diff, cachedDiff, recentLog, registryContext, ...untrackedSummaries] = await Promise.all([
    runOptionalGitCommand({
      repoRoot: input.repoRoot,
      runner: input.runner,
      args: diffArgs,
      maxChars: DIRTY_STATE_DIFF_BYTES,
    }),
    runOptionalGitCommand({
      repoRoot: input.repoRoot,
      runner: input.runner,
      args: cachedDiffArgs,
      maxChars: DIRTY_STATE_DIFF_BYTES,
    }),
    runOptionalGitCommand({
      repoRoot: input.repoRoot,
      runner: input.runner,
      args: ["log", "--oneline", "-10"],
      maxChars: DIRTY_STATE_LOG_BYTES,
    }),
    Promise.resolve(
      JSON.stringify(
        input.workers.map((worker) => ({
          workerId: worker.workerId,
          ticketId: worker.ticketId,
          ticketStatus: worker.ticketStatus,
          status: worker.status,
          executionMode: worker.executionMode,
          commitShas: worker.commitShas ?? [],
          touchedPaths: worker.touchedPaths ?? [],
          validationSummary: worker.validationSummary,
          landingVerification: worker.landingVerification,
          reviewSummary: worker.reviewSummary,
        })),
        null,
        2,
      ),
    ),
    ...untrackedPaths.map((entryPath) => summarizeUntrackedPath(input.repoRoot, entryPath)),
  ]);

  return [
    "# Quiescent dirty-state evidence pack",
    "",
    `Epic: ${input.epic.id} ${input.epic.title}`,
    `Validation commands: ${input.config.landing.validateCommands.join("; ") || "<none>"}`,
    `Completed tickets: ${completedTicketIds(input.epic).join(", ") || "<none>"}`,
    "",
    "## git status --porcelain",
    "```",
    input.statusRaw.trimEnd(),
    "```",
    "",
    "## Tracked diff",
    "```diff",
    diff,
    "```",
    "",
    "## Staged tracked diff",
    "```diff",
    cachedDiff,
    "```",
    "",
    "## Untracked summaries",
    untrackedSummaries.join("\n\n") || "<none>",
    "",
    "## Verified worker/ticket context",
    "```json",
    registryContext,
    "```",
    "",
    "## Recent git log",
    "```",
    recentLog,
    "```",
  ].join("\n");
}

function buildDirtyStateRemediationPrompt(evidencePack: string): string {
  return [
    "You are performing one bounded quiescent dirty-state remediation pass before validation.",
    "Classify every dirty path. Prefer unsafe-unknown over speculative cleanup.",
    "Never request blanket reset, stash, or clean. Only path-specific actions are allowed.",
    "Do not delete source-like untracked files just because they are untracked.",
    "Return strict JSON only with this shape:",
    '{"decisions":[{"path":"relative/path","classification":"generated-artifact|valid-partial-work|follow-up-task|unsafe-unknown","rationale":"why","action":{"type":"delete|restore|commit|create-follow-up|none","paths":["relative/path"],"message":"optional commit message","title":"optional issue title","description":"optional issue description"}}]}',
    "",
    evidencePack,
  ].join("\n");
}

async function writeDirtyStateArtifact(input: {
  repoRoot: string;
  config: BeadworkConfig;
  prefix: string;
  content: string;
}): Promise<string> {
  const artifactDir = path.join(
    resolveWorkerRuntimeDir(input.repoRoot, input.config.storage.runtimeDir),
    "dirty-state",
  );
  await mkdir(artifactDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(artifactDir, `${stamp}-${input.prefix}.md`);
  await writeFile(filePath, input.content, "utf8");
  return filePath;
}

type ScopeValidationDecision = {
  classification: "create-fix-forward" | "attention";
  rationale: string;
  safetyNotes: string;
  suspectedTickets: string[];
  suspectedCommits: string[];
  files: string[];
  tests: string[];
  title: string;
  successCriteria: string[];
};

type ScopeValidationRemediationResult = {
  proceed: boolean;
  detail: string;
  evidenceFile: string;
  logFile: string;
  signature: string;
  createdIssueIds: string[];
};

function validationFailureSignature(input: {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}): string {
  return createHash("sha256")
    .update(input.command)
    .update("\0")
    .update(String(input.exitCode))
    .update("\0")
    .update(input.stdout)
    .update("\0")
    .update(input.stderr)
    .digest("hex")
    .slice(0, 16);
}

function truncateScopeValidationValue(value: string, maxChars = 12_000): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function extractScopeValidationFailureHints(
  stdout: string,
  stderr: string,
): {
  files: string[];
  tests: string[];
} {
  const combined = `${stdout}\n${stderr}`;
  const files = new Set<string>();
  for (const match of combined.matchAll(
    /(?:^|[\s('"`])([A-Za-z0-9_./-]+\.(?:test\.|spec\.)?(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|sh))(?:[:)]|\s|$)/g,
  )) {
    files.add(match[1]);
  }
  const tests = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(FAIL|✗|×|not ok|Test Files|Tests)\b/i.test(line))
    .slice(0, 20);
  return { files: [...files].slice(0, 50), tests };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function normalizeScopeValidationDecisions(value: unknown): ScopeValidationDecision[] {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawDecisions = Array.isArray(record.followUpTasks)
    ? record.followUpTasks
    : Array.isArray(record.decisions)
      ? record.decisions
      : [record];

  return rawDecisions.map((rawDecision, index) => {
    if (!rawDecision || typeof rawDecision !== "object") {
      throw new Error(`Scope validation decision ${index + 1} is not an object.`);
    }
    const decision = rawDecision as Record<string, unknown>;
    const classification = decision.classification;
    if (classification !== "create-fix-forward" && classification !== "attention") {
      throw new Error(
        `Scope validation decision ${index + 1} must classify create-fix-forward or attention.`,
      );
    }
    return {
      classification,
      rationale:
        typeof decision.rationale === "string" && decision.rationale.trim()
          ? decision.rationale.trim()
          : "No rationale provided.",
      safetyNotes:
        typeof decision.safetyNotes === "string" && decision.safetyNotes.trim()
          ? decision.safetyNotes.trim()
          : "No safety notes provided.",
      suspectedTickets: stringArray(decision.suspectedTickets),
      suspectedCommits: stringArray(decision.suspectedCommits),
      files: stringArray(decision.files),
      tests: stringArray(decision.tests),
      title:
        typeof decision.title === "string" && decision.title.trim()
          ? decision.title.trim()
          : "Fix scope validation failure",
      successCriteria: stringArray(decision.successCriteria),
    };
  });
}

async function writeScopeValidationArtifact(input: {
  repoRoot: string;
  config: BeadworkConfig;
  prefix: string;
  content: string;
}): Promise<string> {
  const artifactDir = path.join(
    resolveWorkerRuntimeDir(input.repoRoot, input.config.storage.runtimeDir),
    "scope-validation",
  );
  await mkdir(artifactDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(artifactDir, `${stamp}-${input.prefix}.md`);
  await writeFile(filePath, input.content, "utf8");
  return filePath;
}

async function commitSubject(input: {
  repoRoot: string;
  runner: ProcessRunner;
  sha: string;
}): Promise<string> {
  try {
    const result = await input.runner("git", ["show", "-s", "--format=%s", input.sha], {
      cwd: input.repoRoot,
      timeout: 30_000,
    });
    return result.stdout.trim() || "<subject unavailable>";
  } catch (error) {
    return `subject unavailable: ${humanizeError(error)}`;
  }
}

async function buildScopeValidationEvidencePack(input: {
  repoRoot: string;
  adapter: BeadworkAdapter;
  epic: BeadworkIssueDetail;
  workers: WorkerRuntime[];
  validation: NonNullable<Awaited<ReturnType<typeof runWorktreeValidation>>["failedCommand"]>;
  signature: string;
  runner: ProcessRunner;
}): Promise<string> {
  const verifiedWorkers = input.workers.filter((worker) => isSuccessfulTerminalWorker(worker));
  const failureHints = extractScopeValidationFailureHints(
    input.validation.stdout,
    input.validation.stderr,
  );
  const [status, recentLog, epicHistory] = await Promise.all([
    runOptionalGitCommand({
      repoRoot: input.repoRoot,
      runner: input.runner,
      args: ["status", "--porcelain"],
      maxChars: 4_000,
    }),
    runOptionalGitCommand({
      repoRoot: input.repoRoot,
      runner: input.runner,
      args: ["log", "--oneline", "-20"],
      maxChars: 8_000,
    }),
    input.adapter
      .history(input.repoRoot, input.epic.id, 10)
      .catch((error: unknown) => [{ intent: "history-error", message: humanizeError(error) }]),
  ]);

  const workerContexts = await Promise.all(
    verifiedWorkers.map(async (worker) => {
      const commits = await Promise.all(
        (worker.commitShas ?? []).map(async (sha) => ({
          sha,
          subject: await commitSubject({ repoRoot: input.repoRoot, runner: input.runner, sha }),
        })),
      );
      const history = await input.adapter
        .history(input.repoRoot, worker.ticketId, 8)
        .catch((error: unknown) => [{ intent: "history-error", message: humanizeError(error) }]);
      return {
        workerId: worker.workerId,
        ticketId: worker.ticketId,
        ticketTitle: worker.ticketTitle,
        status: worker.status,
        executionMode: worker.executionMode,
        validationStatus: worker.validationStatus,
        landingVerification: worker.landingVerification,
        reviewSummary: worker.reviewSummary,
        commitShas: worker.commitShas ?? [],
        commits,
        touchedPaths: worker.touchedPaths ?? [],
        history,
      };
    }),
  );

  return [
    "# Scope validation failure evidence pack",
    "",
    `scope-validation-signature: ${input.signature}`,
    `Epic: ${input.epic.id} ${input.epic.title}`,
    "",
    "## Epic/scope goal",
    input.epic.description?.trim() || "<no epic description>",
    "",
    "## Validation command",
    `cwd: ${input.validation.cwd}`,
    `command: ${input.validation.command}`,
    `exitCode: ${input.validation.exitCode}`,
    `durationMs: ${input.validation.durationMs}`,
    "",
    "### stdout",
    "```",
    truncateScopeValidationValue(input.validation.stdout),
    "```",
    "",
    "### stderr",
    "```",
    truncateScopeValidationValue(input.validation.stderr),
    "```",
    "",
    "## Derived failing files/tests evidence",
    "Deterministic extraction only; coordinator judgment decides attribution.",
    "```json",
    JSON.stringify(failureHints, null, 2),
    "```",
    "",
    "## Verified workers/tickets, commits, touched paths, and handoff context",
    "```json",
    JSON.stringify(workerContexts, null, 2),
    "```",
    "",
    "## Epic coordination history",
    "```json",
    JSON.stringify(epicHistory, null, 2),
    "```",
    "",
    "## git status --porcelain",
    "```",
    status,
    "```",
    "",
    "## recent git log --oneline",
    "```",
    recentLog,
    "```",
  ].join("\n");
}

function buildScopeValidationPrompt(evidencePack: string): string {
  return [
    "You are the coordinator for a current-branch Beadwork epic.",
    "Integrated scope validation failed after all workers were terminal and the checkout was clean.",
    "Decide whether to create fix-forward child work under the active epic.",
    "Use the evidence to attribute likely in-scope failures to tickets/commits, but do not rely solely on brittle filename parsing.",
    "If attribution is ambiguous, unsafe, out-of-scope, or unclear, choose attention.",
    "Do not ask to reopen verified workers and do not suggest reset/rebase/amend/revert.",
    "Return strict JSON only. Shape:",
    '{"classification":"create-fix-forward|attention","rationale":"why","safetyNotes":"why safe/unsafe","suspectedTickets":["BW-123"],"suspectedCommits":["abc123"],"files":["src/file.ts"],"tests":["test name or file"],"title":"Fix validation failure in ...","successCriteria":["Validation command passes"]}',
    'Alternatively return {"followUpTasks":[...same decision objects...]} for multiple independent fix-forward tasks.',
    "",
    evidencePack,
  ].join("\n");
}

function buildScopeFixForwardDescription(input: {
  epic: BeadworkIssueDetail;
  validation: NonNullable<Awaited<ReturnType<typeof runWorktreeValidation>>["failedCommand"]>;
  signature: string;
  decision: ScopeValidationDecision;
  evidenceFile: string;
}): string {
  const outputExcerpt = truncateScopeValidationValue(
    [input.validation.stdout.trim(), input.validation.stderr.trim()].filter(Boolean).join("\n\n"),
    4_000,
  );
  return [
    "Fix-forward child task created from a current-branch scope validation failure.",
    "",
    `scope-validation-signature: ${input.signature}`,
    `Parent epic: ${input.epic.id} ${input.epic.title}`,
    `Evidence pack: ${input.evidenceFile}`,
    "",
    "## Failing validation command",
    `cwd: ${input.validation.cwd}`,
    `command: ${input.validation.command}`,
    `exitCode: ${input.validation.exitCode}`,
    `durationMs: ${input.validation.durationMs}`,
    "",
    "## Output excerpt",
    "```",
    outputExcerpt || "<no output>",
    "```",
    "",
    "## Suspected related tickets/commits",
    `Tickets: ${input.decision.suspectedTickets.join(", ") || "<unspecified>"}`,
    `Commits: ${input.decision.suspectedCommits.join(", ") || "<unspecified>"}`,
    "",
    "## Files/tests involved",
    `Files: ${input.decision.files.join(", ") || "<unspecified>"}`,
    `Tests: ${input.decision.tests.join(", ") || "<unspecified>"}`,
    "",
    "## Coordinator rationale and safety notes",
    input.decision.rationale,
    "",
    input.decision.safetyNotes,
    "",
    "## Success criteria",
    ...(input.decision.successCriteria.length > 0
      ? input.decision.successCriteria.map((criterion) => `- ${criterion}`)
      : [`- ${input.validation.command} passes in ${input.validation.cwd}.`]),
    "",
    "## Validation command to rerun",
    "```sh",
    input.validation.command,
    "```",
  ].join("\n");
}

async function hasExistingScopeValidationTask(input: {
  cwd: string;
  adapter: BeadworkAdapter;
  epicId: string;
  signature: string;
}): Promise<boolean> {
  const marker = `scope-validation-signature: ${input.signature}`;
  try {
    const issues = await input.adapter.list(input.cwd, { parent: input.epicId, all: true });
    return Array.isArray(issues)
      ? issues.some(
          (issue) => issue.description.includes(marker) || issue.title.includes(input.signature),
        )
      : false;
  } catch {
    return false;
  }
}

async function handleScopeValidationFailure(input: {
  cwd: string;
  repoRoot: string;
  config: BeadworkConfig;
  adapter: BeadworkAdapter;
  epic: BeadworkIssueDetail;
  workers: WorkerRuntime[];
  validation: NonNullable<Awaited<ReturnType<typeof runWorktreeValidation>>["failedCommand"]>;
  runner: ProcessRunner;
}): Promise<ScopeValidationRemediationResult> {
  const signature = validationFailureSignature({
    command: input.validation.command,
    exitCode: input.validation.exitCode,
    stdout: input.validation.stdout,
    stderr: input.validation.stderr,
  });
  const evidencePack = await buildScopeValidationEvidencePack({
    repoRoot: input.repoRoot,
    adapter: input.adapter,
    epic: input.epic,
    workers: input.workers,
    validation: input.validation,
    signature,
    runner: input.runner,
  });
  const evidenceFile = await writeScopeValidationArtifact({
    repoRoot: input.repoRoot,
    config: input.config,
    prefix: `${signature}-evidence`,
    content: evidencePack,
  });
  const prompt = buildScopeValidationPrompt(evidencePack);
  const promptFile = await writeScopeValidationArtifact({
    repoRoot: input.repoRoot,
    config: input.config,
    prefix: `${signature}-prompt`,
    content: prompt,
  });
  const command = buildReviewerAgentCommand(input.config);
  const reviewerInvocation = `${command} "$(cat ${shellQuote(promptFile)})"`;
  let decisions: ScopeValidationDecision[];
  let rawOutput = "";
  try {
    const result = await input.runner("bash", ["-lc", reviewerInvocation], {
      cwd: input.cwd,
      timeout: input.config.landing.review.commandTimeoutMs,
    });
    rawOutput = result.stdout.trim();
    decisions = normalizeScopeValidationDecisions(extractJsonPayload(rawOutput));
  } catch (error) {
    const logFile = await writeScopeValidationArtifact({
      repoRoot: input.repoRoot,
      config: input.config,
      prefix: `${signature}-attention-log`,
      content: [
        `scope-validation-signature: ${signature}`,
        "Scope validation coordinator/remediator failed.",
        `error: ${humanizeError(error)}`,
        "",
        `evidenceFile: ${evidenceFile}`,
        "",
        rawOutput,
      ].join("\n"),
    });
    return {
      proceed: false,
      detail: `Scope validation failed and coordinator classification failed; evidence preserved at ${evidenceFile}.`,
      evidenceFile,
      logFile,
      signature,
      createdIssueIds: [],
    };
  }

  if (
    decisions.length === 0 ||
    decisions.some((decision) => decision.classification === "attention")
  ) {
    const rationale = decisions.map((decision) => decision.rationale).join("\n") || "No rationale.";
    const logFile = await writeScopeValidationArtifact({
      repoRoot: input.repoRoot,
      config: input.config,
      prefix: `${signature}-attention-log`,
      content: [
        `scope-validation-signature: ${signature}`,
        "Scope validation coordinator requested operator attention.",
        "",
        rationale,
        "",
        `evidenceFile: ${evidenceFile}`,
        "",
        rawOutput,
      ].join("\n"),
    });
    return {
      proceed: false,
      detail: `Scope validation failed; attribution was ambiguous/unsafe. Evidence: ${evidenceFile}`,
      evidenceFile,
      logFile,
      signature,
      createdIssueIds: [],
    };
  }

  if (
    await hasExistingScopeValidationTask({
      cwd: input.cwd,
      adapter: input.adapter,
      epicId: input.epic.id,
      signature,
    })
  ) {
    const logFile = await writeScopeValidationArtifact({
      repoRoot: input.repoRoot,
      config: input.config,
      prefix: `${signature}-dedupe-log`,
      content: [
        `scope-validation-signature: ${signature}`,
        "Duplicate fix-forward task already exists; no new task created.",
        `evidenceFile: ${evidenceFile}`,
        rawOutput,
      ].join("\n"),
    });
    return {
      proceed: true,
      detail: `Scope validation failure ${signature} already has a fix-forward task; continuing bounded loop.`,
      evidenceFile,
      logFile,
      signature,
      createdIssueIds: [],
    };
  }

  const createdIssueIds: string[] = [];
  for (const decision of decisions) {
    const title = decision.title.startsWith("Fix scope validation")
      ? `${decision.title} (${signature})`
      : `Fix scope validation: ${decision.title} (${signature})`;
    const description = buildScopeFixForwardDescription({
      epic: input.epic,
      validation: input.validation,
      signature,
      decision,
      evidenceFile,
    });
    const created = await input.adapter.createIssue(input.cwd, {
      title,
      description,
      type: "task",
      priority: 1,
      parentId: input.epic.id,
    });
    createdIssueIds.push(created.issue.id);
  }

  const logFile = await writeScopeValidationArtifact({
    repoRoot: input.repoRoot,
    config: input.config,
    prefix: `${signature}-fix-forward-log`,
    content: [
      `scope-validation-signature: ${signature}`,
      `Created fix-forward issue(s): ${createdIssueIds.join(", ")}`,
      `command: ${input.validation.command}`,
      `exitCode: ${input.validation.exitCode}`,
      `durationMs: ${input.validation.durationMs}`,
      `relatedTickets: ${decisions.flatMap((decision) => decision.suspectedTickets).join(", ") || "<unspecified>"}`,
      `relatedCommits: ${decisions.flatMap((decision) => decision.suspectedCommits).join(", ") || "<unspecified>"}`,
      "",
      decisions.map((decision) => `rationale: ${decision.rationale}`).join("\n"),
      "",
      `evidenceFile: ${evidenceFile}`,
      "",
      rawOutput,
    ].join("\n"),
  });

  return {
    proceed: true,
    detail: `Scope validation failed; created fix-forward task(s) ${createdIssueIds.join(", ")} for signature ${signature}.`,
    evidenceFile,
    logFile,
    signature,
    createdIssueIds,
  };
}

async function executeDirtyStateDecision(input: {
  repoRoot: string;
  cwd: string;
  adapter: BeadworkAdapter;
  epicId: string;
  runner: ProcessRunner;
  statusByPath: Map<string, DirtyStatusEntry>;
  decision: DirtyStateRemediationDecision;
}): Promise<{ resolved: boolean; log: string }> {
  const { decision } = input;
  const logLines = [
    `path=${decision.path}`,
    `classification=${decision.classification}`,
    `rationale=${decision.rationale}`,
    `action=${decision.action.type}`,
  ];

  if (!isDirtyStateActionClassificationApproved(decision.classification, decision.action.type)) {
    return {
      resolved: false,
      log: `${logLines.join("\n")}\nrefused: classification ${decision.classification} is not approved for action ${decision.action.type}`,
    };
  }
  const paths = decision.action.paths.length > 0 ? decision.action.paths : [decision.path];

  for (const dirtyPath of paths) {
    if (!input.statusByPath.has(dirtyPath)) {
      return {
        resolved: false,
        log: `${logLines.join("\n")}\nrefused: ${dirtyPath} not in status`,
      };
    }
    resolveRepoRelativePath(input.repoRoot, dirtyPath);
  }

  if (decision.action.type === "delete") {
    for (const dirtyPath of paths) {
      const entry = input.statusByPath.get(dirtyPath);
      if (entry?.code !== "??" || !isSafeGeneratedPath(dirtyPath)) {
        return {
          resolved: false,
          log: `${logLines.join("\n")}\nrefused: delete is only allowed for untracked generated paths`,
        };
      }
      await rm(resolveRepoRelativePath(input.repoRoot, dirtyPath), {
        force: true,
        recursive: true,
      });
      logLines.push(`command=rm -rf -- ${dirtyPath}`);
      logLines.push("exitCode=0");
    }
    return { resolved: true, log: logLines.join("\n") };
  }

  if (decision.action.type === "restore") {
    for (const dirtyPath of paths) {
      const entry = input.statusByPath.get(dirtyPath);
      if (!entry || entry.code === "??" || !isSafeGeneratedPath(dirtyPath)) {
        return {
          resolved: false,
          log: `${logLines.join("\n")}\nrefused: restore is only allowed for tracked generated paths`,
        };
      }
    }
    await input.runner("git", ["restore", "--", ...paths], {
      cwd: input.repoRoot,
      timeout: 30_000,
    });
    logLines.push(`command=git restore -- ${paths.join(" ")}`);
    logLines.push("exitCode=0");
    return { resolved: true, log: logLines.join("\n") };
  }

  if (decision.action.type === "commit") {
    if (!decision.action.message?.trim()) {
      return { resolved: false, log: `${logLines.join("\n")}\nrefused: commit message missing` };
    }
    await input.runner("git", ["add", "--", ...paths], { cwd: input.repoRoot, timeout: 30_000 });
    await input.runner("git", ["commit", "-m", decision.action.message], {
      cwd: input.repoRoot,
      timeout: 120_000,
    });
    logLines.push(`command=git add -- ${paths.join(" ")}`);
    logLines.push(`command=git commit -m ${decision.action.message}`);
    logLines.push("exitCode=0");
    return { resolved: true, log: logLines.join("\n") };
  }

  if (decision.action.type === "create-follow-up") {
    await input.adapter.createIssue(input.cwd, {
      title: decision.action.title ?? `Follow up dirty state for ${input.epicId}`,
      description:
        decision.action.description ??
        `Quiescent dirty-state remediation found unresolved paths: ${paths.join(", ")}.\n\nRationale: ${decision.rationale}`,
      type: "task",
      priority: 1,
      parentId: input.epicId,
    });
    logLines.push("command=bw create (follow-up task)");
    logLines.push("exitCode=0");
    logLines.push("unresolved: follow-up created; preserving dirty files for operator review");
    return { resolved: false, log: logLines.join("\n") };
  }

  logLines.push("unresolved: no safe action approved");
  return { resolved: false, log: logLines.join("\n") };
}

async function runQuiescentDirtyStateRemediation(input: {
  cwd: string;
  repoRoot: string;
  config: BeadworkConfig;
  adapter: BeadworkAdapter;
  epic: BeadworkIssueDetail;
  workers: WorkerRuntime[];
  runner: ProcessRunner;
}): Promise<DirtyStateRemediationResult> {
  let statusRaw = "";
  try {
    const status = await input.runner("git", ["status", "--porcelain"], {
      cwd: input.repoRoot,
      timeout: 30_000,
    });
    statusRaw = status.stdout.trimEnd();
  } catch (error) {
    return { passed: false, detail: `Unable to inspect dirty state: ${humanizeError(error)}` };
  }

  if (statusRaw.trim().length === 0) {
    return { passed: true, detail: "Checkout clean; dirty-state remediation skipped." };
  }

  const statusEntries = parseDirtyStatus(statusRaw);
  const evidencePack = await buildDirtyStateEvidencePack({
    repoRoot: input.repoRoot,
    config: input.config,
    epic: input.epic,
    workers: input.workers,
    statusRaw,
    statusEntries,
    runner: input.runner,
  });
  const evidenceFile = await writeDirtyStateArtifact({
    repoRoot: input.repoRoot,
    config: input.config,
    prefix: "evidence",
    content: evidencePack,
  });
  const prompt = buildDirtyStateRemediationPrompt(evidencePack);
  const promptFile = await writeDirtyStateArtifact({
    repoRoot: input.repoRoot,
    config: input.config,
    prefix: "prompt",
    content: prompt,
  });
  const command = buildReviewerAgentCommand(input.config);
  const reviewerInvocation = `${command} "$(cat ${shellQuote(promptFile)})"`;
  let decisions: DirtyStateRemediationDecision[];
  let rawOutput = "";

  try {
    const result = await input.runner("bash", ["-lc", reviewerInvocation], {
      cwd: input.repoRoot,
      timeout: input.config.landing.review.commandTimeoutMs,
    });
    rawOutput = result.stdout.trim();
    decisions = normalizeDirtyStateActions(extractJsonPayload(rawOutput));
  } catch (error) {
    const logFile = await writeDirtyStateArtifact({
      repoRoot: input.repoRoot,
      config: input.config,
      prefix: "remediation-failed",
      content: [
        "# Dirty-state remediation failed",
        "",
        `Evidence: ${evidenceFile}`,
        `Prompt: ${promptFile}`,
        "",
        "## Error",
        humanizeError(error),
        "",
        "## Raw output",
        rawOutput || "<none>",
      ].join("\n"),
    });
    return {
      passed: false,
      detail: `Dirty-state remediation failed; evidence=${evidenceFile}; log=${logFile}`,
      evidenceFile,
      logFile,
    };
  }

  if (decisions.length === 0) {
    const logFile = await writeDirtyStateArtifact({
      repoRoot: input.repoRoot,
      config: input.config,
      prefix: "remediation-empty",
      content: `No dirty-state decisions returned.\n\nEvidence: ${evidenceFile}`,
    });
    return {
      passed: false,
      detail: `Dirty-state remediation returned no decisions; evidence=${evidenceFile}; log=${logFile}`,
      evidenceFile,
      logFile,
    };
  }

  const statusByPath = new Map(statusEntries.map((entry) => [entry.path, entry]));
  const decisionLogs: string[] = [];
  let allResolved = true;
  for (const decision of decisions) {
    try {
      const result = await executeDirtyStateDecision({
        cwd: input.cwd,
        repoRoot: input.repoRoot,
        adapter: input.adapter,
        epicId: input.epic.id,
        runner: input.runner,
        statusByPath,
        decision,
      });
      allResolved = allResolved && result.resolved;
      decisionLogs.push(result.log);
    } catch (error) {
      allResolved = false;
      decisionLogs.push(
        [
          `path=${decision.path}`,
          `action=${decision.action.type}`,
          `error=${humanizeError(error)}`,
        ].join("\n"),
      );
    }
  }

  let finalStatus = "<not checked>";
  try {
    const status = await input.runner("git", ["status", "--porcelain"], {
      cwd: input.repoRoot,
      timeout: 30_000,
    });
    finalStatus = status.stdout.trimEnd();
  } catch (error) {
    allResolved = false;
    finalStatus = `status check failed: ${humanizeError(error)}`;
  }

  const logFile = await writeDirtyStateArtifact({
    repoRoot: input.repoRoot,
    config: input.config,
    prefix: "remediation-log",
    content: [
      "# Dirty-state remediation log",
      "",
      `Evidence: ${evidenceFile}`,
      "",
      "## Decisions",
      decisionLogs.join("\n\n---\n\n"),
      "",
      "## Final git status --porcelain",
      "```",
      finalStatus || "<clean>",
      "```",
    ].join("\n"),
  });

  if (!allResolved || finalStatus.trim().length > 0) {
    return {
      passed: false,
      detail: `Dirty-state remediation unresolved; evidence=${evidenceFile}; log=${logFile}`,
      evidenceFile,
      logFile,
    };
  }

  return {
    passed: true,
    detail: `Dirty-state remediation cleaned checkout; evidence=${evidenceFile}; log=${logFile}`,
    evidenceFile,
    logFile,
  };
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

    if (await isScopeTicketTerminal({ cwd: input.cwd, adapter: input.adapter, issue: epic })) {
      if (summary.active === 0) {
        const nonTerminalWorkers = workers.filter((worker) => !isSuccessfulTerminalWorker(worker));
        const unresolvedFixWorkers = workers.filter(hasUnresolvedFixFindings);

        if (nonTerminalWorkers.length > 0 || unresolvedFixWorkers.length > 0) {
          notes.push(
            "At least one worker needs operator attention before the orchestrator can complete the scope.",
          );
          stopReason = "attention";
          break;
        }

        const dirtyState = await runQuiescentDirtyStateRemediation({
          cwd: input.cwd,
          repoRoot: input.repoRoot,
          config: input.config,
          adapter: input.adapter,
          epic,
          workers,
          runner,
        });
        notes.push(`Dirty-state remediation: ${dirtyState.detail}`);
        if (!dirtyState.passed) {
          stopReason = "attention";
          break;
        }

        const scopeValidation = await runWorktreeValidation({
          worktreePath: input.repoRoot,
          commands: input.config.landing.validateCommands,
          timeoutMs: input.config.landing.commandTimeoutMs,
          runner,
        });

        notes.push(`Scope validation: ${scopeValidation.detail}`);
        if (!scopeValidation.passed) {
          if (
            requiresPendingScopeReviewGate({ config: input.config, workers }) &&
            scopeValidation.failedCommand
          ) {
            const remediation = await handleScopeValidationFailure({
              cwd: input.cwd,
              repoRoot: input.repoRoot,
              config: input.config,
              adapter: input.adapter,
              epic,
              workers,
              validation: scopeValidation.failedCommand,
              runner,
            });
            notes.push(
              `Scope validation diagnostics: command=${scopeValidation.failedCommand.command}; exitCode=${scopeValidation.failedCommand.exitCode}; durationMs=${scopeValidation.failedCommand.durationMs}; signature=${remediation.signature}; evidence=${remediation.evidenceFile}; log=${remediation.logFile}; ${remediation.detail}`,
            );
            if (remediation.proceed) {
              continue;
            }
          }
          stopReason = "attention";
          break;
        }

        if (requiresPendingScopeReviewGate({ config: input.config, workers })) {
          notes.push(pendingScopeReviewGateNote());
          stopReason = "attention";
          break;
        }

        stopReason = "completed";
        break;
      }
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
