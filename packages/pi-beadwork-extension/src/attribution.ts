import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BeadworkAdapter } from "./bw.js";
import type { ProcessRunner } from "./process.js";
import type {
  BeadworkHistoryEntry,
  BeadworkIssue,
  BeadworkIssueDetail,
  CurrentBranchCheckout,
  WorkerRuntime,
} from "./types.js";

const MAX_POST_LAUNCH_COMMITS = 20;
const MAX_FILE_SNIPPET_CHARS = 4_000;
const SHA_PATTERN = /\b[0-9a-f]{7,40}\b/gi;

export type AttributionAncestryStatus = "ancestor" | "not-ancestor" | "unknown";

export type AttributionCommitEvidence = {
  sha: string;
  subject: string;
  sources: string[];
  ancestry: AttributionAncestryStatus;
  touchedPaths: string[];
  notes?: string[];
};

export type AttributionEvidencePack = {
  workerId: string;
  ticketId: string;
  renderedText: string;
  rendered: string;
  text: string;
  attention: string[];
  branch: {
    recordedBranch: string;
    currentBranch?: string;
    currentHead?: string;
    drift: boolean;
    detachedHeadLaunch: boolean;
  };
  launchHead: {
    sha: string;
    ancestry: AttributionAncestryStatus;
  };
  candidateCommits: AttributionCommitEvidence[];
  contextCommits: AttributionCommitEvidence[];
  mentionedShas: string[];
};

type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: number;
};

function errorField(
  error: unknown,
  field: "stdout" | "stderr" | "code",
): string | number | undefined {
  if (!error || typeof error !== "object" || !(field in error)) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[field];
  if (field === "code") {
    return typeof value === "number" ? value : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

async function runGit(
  runner: ProcessRunner,
  cwd: string,
  args: string[],
  timeout = 10_000,
): Promise<GitResult> {
  try {
    const result = await runner("git", args, { cwd, timeout });
    return {
      ok: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: (errorField(error, "stdout") as string | undefined) ?? "",
      stderr:
        (errorField(error, "stderr") as string | undefined) ??
        (error instanceof Error ? error.message : String(error)),
      code: errorField(error, "code") as number | undefined,
    };
  }
}

async function readOptionalSnippet(filePath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.length <= MAX_FILE_SNIPPET_CHARS) {
      return trimmed;
    }
    return `${trimmed.slice(0, MAX_FILE_SNIPPET_CHARS).trimEnd()}\n[truncated]`;
  } catch {
    return undefined;
  }
}

function parseCommitLines(stdout: string, source: string): AttributionCommitEvidence[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const tabIndex = line.indexOf("\t");
      if (tabIndex > 0) {
        return {
          sha: line.slice(0, tabIndex).trim(),
          subject: line.slice(tabIndex + 1).trim(),
          sources: [source],
          ancestry: "unknown" as const,
          touchedPaths: [],
        };
      }
      const [sha = "", ...subjectParts] = line.split(/\s+/);
      return {
        sha,
        subject: subjectParts.join(" ").trim(),
        sources: [source],
        ancestry: "unknown" as const,
        touchedPaths: [],
      };
    })
    .filter((commit) => commit.sha.length > 0);
}

function uniq(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))];
}

function extractShas(value: string): string[] {
  return uniq(value.match(SHA_PATTERN) ?? []).map((sha) => sha.toLowerCase());
}

function extractHistoryMentionedShas(history: BeadworkHistoryEntry[]): string[] {
  const mentionText = history
    .map((entry) => {
      const searchable = Object.entries(entry).filter(([key]) => key !== "hash");
      return JSON.stringify(Object.fromEntries(searchable));
    })
    .join("\n");
  return extractShas(mentionText);
}

function shasReferToSameCommit(left: string, right: string): boolean {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}

function hasCommitForSha(commits: Map<string, AttributionCommitEvidence>, sha: string): boolean {
  return [...commits.keys()].some((existingSha) => shasReferToSameCommit(existingSha, sha));
}

function renderIssueSummary(issue: BeadworkIssue | BeadworkIssueDetail | undefined): string {
  if (!issue) {
    return "not available";
  }
  const parent = issue.parentId ? ` parent=${issue.parentId}` : "";
  return `${issue.id} [${issue.status}/${issue.type}] ${issue.title}${parent}`;
}

function renderHistoryEntry(entry: BeadworkHistoryEntry, index: number): string {
  const parts = [
    `${index + 1}.`,
    entry.timestamp ? `[${entry.timestamp}]` : undefined,
    entry.author ? `author=${entry.author}` : undefined,
    entry.intent ? `intent=${entry.intent}` : undefined,
  ].filter(Boolean);
  return `${parts.join(" ")}\n${JSON.stringify(entry, null, 2)}`;
}

function addOrMergeCommit(
  commits: Map<string, AttributionCommitEvidence>,
  commit: AttributionCommitEvidence,
): void {
  const existing = commits.get(commit.sha);
  if (!existing) {
    commits.set(commit.sha, { ...commit, sources: uniq(commit.sources) });
    return;
  }
  existing.sources = uniq([...existing.sources, ...commit.sources]);
  if (!existing.subject && commit.subject) {
    existing.subject = commit.subject;
  }
}

async function checkAncestry(
  runner: ProcessRunner,
  cwd: string,
  sha: string,
): Promise<AttributionAncestryStatus> {
  const result = await runGit(runner, cwd, ["merge-base", "--is-ancestor", sha, "HEAD"]);
  if (result.ok) {
    return "ancestor";
  }
  return "not-ancestor";
}

async function getCommitSubject(
  runner: ProcessRunner,
  cwd: string,
  sha: string,
): Promise<string | undefined> {
  const result = await runGit(runner, cwd, ["show", "-s", "--format=%s", sha]);
  return result.ok ? result.stdout.trim() || undefined : undefined;
}

async function getTouchedPaths(runner: ProcessRunner, cwd: string, sha: string): Promise<string[]> {
  const result = await runGit(runner, cwd, ["show", "--name-only", "--format=", sha]);
  if (!result.ok) {
    return [];
  }
  return uniq(result.stdout.split(/\r?\n/).map((line) => line.trim()));
}

function renderCommit(commit: AttributionCommitEvidence): string {
  const paths = commit.touchedPaths.length > 0 ? commit.touchedPaths.join(", ") : "none derived";
  const notes = commit.notes?.length ? `\n  notes: ${commit.notes.join("; ")}` : "";
  return `- ${commit.sha} ${commit.subject}\n  sources: ${commit.sources.join(", ")}\n  ancestry: ${commit.ancestry}\n  touched paths: ${paths}${notes}`;
}

function renderCommitContext(commit: AttributionCommitEvidence): string {
  const ticketReferenced = commit.sources.some((source) => source.includes("ticket-id grep"));
  const note = ticketReferenced ? "references ticket id" : "ticket id not present in strong grep";
  return `- ${commit.sha} ${commit.subject} (${note})`;
}

function renderRelatedIssues(title: string, issues: BeadworkIssue[]): string {
  if (issues.length === 0) {
    return `### ${title}\nNone returned.`;
  }
  return `### ${title}\n${issues.map((issue) => `- ${renderIssueSummary(issue)}`).join("\n")}`;
}

async function safeShow(
  adapter: BeadworkAdapter,
  cwd: string,
  id: string | undefined,
  attention: string[],
): Promise<BeadworkIssueDetail | undefined> {
  if (!id) {
    return undefined;
  }
  try {
    return await adapter.show(cwd, id);
  } catch (error) {
    attention.push(
      `Unable to load beadwork issue ${id}: ${error instanceof Error ? error.message : error}`,
    );
    return undefined;
  }
}

async function safeHistory(
  adapter: BeadworkAdapter,
  cwd: string,
  id: string,
  attention: string[],
): Promise<BeadworkHistoryEntry[]> {
  try {
    return await adapter.history(cwd, id);
  } catch (error) {
    attention.push(
      `Unable to load beadwork history for ${id}: ${error instanceof Error ? error.message : error}`,
    );
    return [];
  }
}

export async function buildAttributionEvidencePack(opts: {
  worker: WorkerRuntime & CurrentBranchCheckout;
  adapter: BeadworkAdapter;
  processRunner: ProcessRunner;
}): Promise<AttributionEvidencePack> {
  const { adapter, processRunner, worker } = opts;
  const cwd = worker.checkoutPath;
  const attention: string[] = [];

  const [ticket, history, currentBranchResult, currentHeadResult, launchAncestry] =
    await Promise.all([
      safeShow(adapter, cwd, worker.ticketId, attention),
      safeHistory(adapter, cwd, worker.ticketId, attention),
      runGit(processRunner, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
      runGit(processRunner, cwd, ["rev-parse", "HEAD"]),
      checkAncestry(processRunner, cwd, worker.launchHead),
    ]);

  if (launchAncestry !== "ancestor") {
    attention.push(
      `Launch head ${worker.launchHead} is not an ancestor of HEAD; history may have been rewritten or reset.`,
    );
  }

  const currentBranch = currentBranchResult.ok ? currentBranchResult.stdout.trim() : undefined;
  const currentHead = currentHeadResult.ok ? currentHeadResult.stdout.trim() : undefined;
  const detachedHeadLaunch = worker.branchName === "HEAD";
  const branchDrift =
    !detachedHeadLaunch && Boolean(currentBranch) && currentBranch !== worker.branchName;

  if (!currentBranchResult.ok) {
    attention.push(`Unable to verify current branch identity: ${currentBranchResult.stderr}`);
  } else if (branchDrift) {
    attention.push(
      `Branch drift detected: worker launched on ${worker.branchName}, current branch is ${currentBranch}.`,
    );
  }

  const parentId = worker.epicId ?? ticket?.parentId;
  const parentEpic = await safeShow(adapter, cwd, parentId, attention);
  const relatedIds = uniq([...(ticket?.blockedBy ?? []), ...(ticket?.blocks ?? [])]);
  const relatedIssues = (
    await Promise.all(relatedIds.map((id) => safeShow(adapter, cwd, id, attention)))
  ).filter((issue): issue is BeadworkIssueDetail => Boolean(issue));

  const strongResult = await runGit(processRunner, cwd, [
    "log",
    "--format=%H%x09%s",
    `${worker.launchHead}..HEAD`,
    `--grep=${worker.ticketId}`,
  ]);
  if (!strongResult.ok) {
    attention.push(`Unable to gather ticket-id candidate commits: ${strongResult.stderr}`);
  }

  const contextResult = await runGit(processRunner, cwd, [
    "log",
    `--max-count=${MAX_POST_LAUNCH_COMMITS}`,
    "--format=%H%x09%s",
    `${worker.launchHead}..HEAD`,
  ]);
  if (!contextResult.ok) {
    attention.push(`Unable to gather bounded post-launch commit context: ${contextResult.stderr}`);
  }

  const historyMentionedShas = extractHistoryMentionedShas(history);
  const mentionedShas = uniq([...historyMentionedShas, ...(worker.commitShas ?? [])]);
  const commitMap = new Map<string, AttributionCommitEvidence>();
  const contextMap = new Map<string, AttributionCommitEvidence>();

  for (const commit of parseCommitLines(strongResult.stdout, "ticket-id grep")) {
    addOrMergeCommit(commitMap, commit);
  }

  for (const commit of parseCommitLines(contextResult.stdout, "bounded post-launch context")) {
    addOrMergeCommit(contextMap, commit);
    if (mentionedShas.some((sha) => shasReferToSameCommit(commit.sha, sha))) {
      addOrMergeCommit(commitMap, {
        ...commit,
        sources: [...commit.sources, "beadwork history/comment SHA mention"],
      });
    }
  }

  for (const sha of historyMentionedShas) {
    if (hasCommitForSha(commitMap, sha)) {
      continue;
    }
    addOrMergeCommit(commitMap, {
      sha,
      subject: (await getCommitSubject(processRunner, cwd, sha)) ?? "subject unavailable",
      sources: ["beadwork history/comment SHA mention"],
      ancestry: "unknown",
      touchedPaths: [],
    });
  }

  for (const commit of commitMap.values()) {
    commit.ancestry = await checkAncestry(processRunner, cwd, commit.sha);
    if (commit.ancestry !== "ancestor") {
      attention.push(
        `Commit ${commit.sha} is not an ancestor of HEAD; attribution needs attention.`,
      );
    }
    commit.touchedPaths = await getTouchedPaths(processRunner, cwd, commit.sha);
  }

  const candidateCommits = [...commitMap.values()];
  const contextCommits = [...contextMap.values()];
  const handoffEntries = history.filter((entry) =>
    /handoff|validation|validated|lint|test|typecheck|commit|sha/i.test(JSON.stringify(entry)),
  );

  const [promptSnippet, logSnippet, stateValue, exitCodeValue, finishedAtValue] = await Promise.all(
    [
      readOptionalSnippet(worker.promptFile),
      readOptionalSnippet(worker.logFile),
      readOptionalSnippet(worker.stateFile),
      readOptionalSnippet(worker.exitCodeFile),
      readOptionalSnippet(worker.finishedAtFile),
    ],
  );

  const childIssues = ticket?.children ?? [];
  const blockedByIssues = relatedIssues.filter((issue) => ticket?.blockedBy.includes(issue.id));
  const blocksIssues = relatedIssues.filter((issue) => ticket?.blocks.includes(issue.id));
  const validationClaims = [
    worker.validationStatus ? `validationStatus=${worker.validationStatus}` : undefined,
    worker.validationAt ? `validationAt=${worker.validationAt}` : undefined,
    worker.validationSummary ? `validationSummary=${worker.validationSummary}` : undefined,
    worker.reviewStatus ? `reviewStatus=${worker.reviewStatus}` : undefined,
    worker.reviewVerdict ? `reviewVerdict=${worker.reviewVerdict}` : undefined,
    worker.reviewSummary ? `reviewSummary=${worker.reviewSummary}` : undefined,
  ].filter(Boolean);

  const renderedText = `# Current-Branch Commit Attribution Evidence Pack

## Attention flags
${attention.length > 0 ? attention.map((item) => `- ${item}`).join("\n") : "No attention flags detected by evidence gathering. Attribution still requires coordinator judgment."}

## Worker runtime and artifact pointers
- workerId: ${worker.workerId}
- ticketId: ${worker.ticketId}
- worker title/status: ${worker.ticketTitle} / ${worker.status}
- runtime window: startedAt=${worker.startedAt} finishedAt=${worker.finishedAt ?? "unknown"} updatedAt=${worker.updatedAt}
- checkoutPath: ${worker.checkoutPath}
- recorded branchName: ${worker.branchName}
- launchHead: ${worker.launchHead}
- current HEAD: ${currentHead ?? "unknown"}
- tmux: session=${worker.tmuxSession} window=${worker.tmuxWindow} pane=${worker.tmuxPane}
- promptFile: ${worker.promptFile}
- logFile: ${worker.logFile}
- stateFile: ${worker.stateFile}${stateValue ? ` (value: ${stateValue})` : ""}
- exitCodeFile: ${worker.exitCodeFile}${exitCodeValue ? ` (value: ${exitCodeValue})` : ""}
- finishedAtFile: ${worker.finishedAtFile}${finishedAtValue ? ` (value: ${finishedAtValue})` : ""}
- scriptFile: ${worker.scriptFile}
- runtimeDir: ${worker.runtimeDir}
- registry snapshot pointer: caller-provided WorkerRuntime record; default registry path would be ${path.join(worker.checkoutPath, ".pi", "beadwork", "workers", "registry.json")}

## Branch identity and ancestry checks
- recorded launch branch: ${worker.branchName}
- observed current branch: ${currentBranch ?? "unknown"}
- branch drift: ${branchDrift ? "YES - route to attention" : "no"}
- detached HEAD launch: ${detachedHeadLaunch ? "YES - branchName=HEAD indicates explicit detached current-branch launch; normal branch-name drift assumptions are limited." : "no"}
- launchHead ancestry to HEAD: ${launchAncestry}

## Ticket context
- ticket: ${renderIssueSummary(ticket)}
- description:\n${ticket?.description?.trim() || "(no description)"}
- parent epic: ${renderIssueSummary(parentEpic)}
- parent epic goal/description:\n${parentEpic?.description?.trim() || "(not available)"}
- labels: ${(ticket?.labels ?? []).join(", ") || "none"}
- assignee: ${ticket?.assignee || "unassigned"}

${renderRelatedIssues("Child context", childIssues)}

${renderRelatedIssues("Blocked-by dependency context", blockedByIssues)}

${renderRelatedIssues("Blocks dependency context", blocksIssues)}

## Beadwork comments and history evidence
${history.length > 0 ? history.map((entry, index) => renderHistoryEntry(entry, index)).join("\n\n") : "No beadwork comments/history entries were returned."}

## Worker handoff and validation evidence
### Handoff-like/comment evidence surfaced without a rigid schema
${handoffEntries.length > 0 ? handoffEntries.map((entry, index) => renderHistoryEntry(entry, index)).join("\n\n") : "No handoff-like history entries were detected; this is not an automatic failure."}

### Worker-provided validation/runtime claims
${validationClaims.length > 0 ? validationClaims.map((claim) => `- ${claim}`).join("\n") : "No worker validation claims were recorded on the runtime object."}

### Prompt excerpt
${promptSnippet ?? "Prompt file not readable or empty; use promptFile pointer above."}

### Log excerpt
${logSnippet ?? "Log file not readable or empty; use logFile pointer above."}

## Strong candidate commits after launchHead that reference ${worker.ticketId}
${
  candidateCommits.filter((commit) => commit.sources.includes("ticket-id grep")).length > 0
    ? candidateCommits
        .filter((commit) => commit.sources.includes("ticket-id grep"))
        .map(renderCommit)
        .join("\n\n")
    : "No post-launch commits referencing the ticket id were found. Missing ticket ids are not an automatic failure; review handoff/comment/context evidence."
}

## Comment-mentioned or worker-claimed commits
${
  candidateCommits.filter((commit) => !commit.sources.includes("ticket-id grep")).length > 0
    ? candidateCommits
        .filter((commit) => !commit.sources.includes("ticket-id grep"))
        .map(renderCommit)
        .join("\n\n")
    : "No additional comment-mentioned or worker-claimed SHAs were found."
}

## Bounded post-launch commit context (max ${MAX_POST_LAUNCH_COMMITS})
${contextCommits.length > 0 ? contextCommits.map(renderCommitContext).join("\n") : "No bounded post-launch commit context was returned."}

## Derived touched paths for candidate/attributed commits
${candidateCommits.length > 0 ? candidateCommits.map((commit) => `- ${commit.sha}: ${commit.touchedPaths.length > 0 ? commit.touchedPaths.join(", ") : "none derived"}`).join("\n") : "No candidate/attributed commits available for touched-path derivation."}

## Coordinator guidance
Use this evidence as context, not as a deterministic attribution schema. Missing ticket ids in commit messages are not automatic failures. Branch drift, launch-head ancestry failure, or candidate commit ancestry failure should route to attention/remediation unless an explicit coordinator action explains them.
`;

  return {
    workerId: worker.workerId,
    ticketId: worker.ticketId,
    renderedText,
    rendered: renderedText,
    text: renderedText,
    attention,
    branch: {
      recordedBranch: worker.branchName,
      currentBranch,
      currentHead,
      drift: branchDrift,
      detachedHeadLaunch,
    },
    launchHead: {
      sha: worker.launchHead,
      ancestry: launchAncestry,
    },
    candidateCommits,
    contextCommits,
    mentionedShas,
  };
}
