import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../constants.js";
import { loadSessionState, resolveSessionStateDir } from "../../session-state.js";
import type { BeadworkIssue } from "../../types.js";
import {
  type InProcessHarness,
  LIFECYCLE_PACKET_CUSTOM_TYPE,
  withInProcessHarness,
} from "../helpers/in-process-orchestration.js";

const PARENT_TITLE = "Scope parent ticket";
const DEPENDENT_TITLE = "Scope dependent ticket";
const IMPLEMENT_PROSE = "Implemented as unstructured prose. Named commit is the evidence.";
const BLOCKING_FINDING =
  "Blocking finding: parent ticket is missing the required error path. Disposition: fix.";
const CLEAN_REVIEW = "No remaining blocking findings. Goal meets acceptance.";

function issueIds(issues: Array<{ id: string }>): string[] {
  return issues.map((issue) => issue.id);
}

async function sessionState(harness: InProcessHarness) {
  return loadSessionState(
    resolveSessionStateDir(harness.fixture.cwd, DEFAULT_CONFIG.storage.sessionStateDir),
    harness.ctx.sessionManager.getSessionId(),
  );
}

async function commitEvidence(
  harness: InProcessHarness,
  relativePath: string,
  contents: string,
  message: string,
): Promise<string> {
  await writeFile(join(harness.fixture.cwd, relativePath), contents, "utf8");
  await harness.fixture.exec("git", ["add", relativePath]);
  await harness.fixture.exec("git", ["commit", "-q", "-m", message]);
  const { stdout } = await harness.fixture.exec("git", ["rev-parse", "HEAD"]);
  return stdout.trim();
}

async function settleAndWait(harness: InProcessHarness, childId: string, prose: string) {
  const before = harness.packets.length;
  await harness.settleChild(childId, prose);
  await harness.waitForPackets(before + 1);
  return harness.lastPacket();
}

async function startAndImplement(input: {
  harness: InProcessHarness;
  epicId: string;
  ticket: BeadworkIssue;
  task: string;
  description: string;
  relativePath: string;
  contents: string;
  commitMessage: string;
}): Promise<{ childId: string; commit: string; groupId: string }> {
  const { harness, epicId, ticket } = input;
  await harness.invokeBeadworkTool("beadwork_start_issue", { id: ticket.id });
  const started = await harness.fixture.show(ticket.id);
  expect(started.status).toBe("in_progress");

  const result = await harness.orchestrate({
    tasks: [
      {
        task: input.task,
        description: input.description,
        agent: "worker",
        taskType: "implementation",
        domain: {
          source: "beadwork",
          scopeId: epicId,
          workItemId: ticket.id,
          title: ticket.title,
        },
      },
    ],
  });
  expect(result.accepted).toHaveLength(1);
  expect(result.rejected).toEqual([]);
  const childId = result.accepted[0]?.childId;
  const groupId = result.groupId;
  if (!childId) {
    throw new Error(`orchestrate did not accept implementation for ${ticket.id}`);
  }

  const commit = await commitEvidence(
    harness,
    input.relativePath,
    input.contents,
    input.commitMessage,
  );
  await settleAndWait(harness, childId, `${IMPLEMENT_PROSE} commit ${commit}`);

  const afterSettle = await harness.fixture.show(ticket.id);
  expect(afterSettle.status).toBe("in_progress");
  expect(afterSettle.status).not.toBe("closed");
  await harness.logStep("implementation-settled-without-close", {
    ticketId: ticket.id,
    childId,
    groupId,
    issueStatus: afterSettle.status,
  });
  return { childId, commit, groupId };
}

describe("in-process scope-policy epic without per-ticket review children", () => {
  it("closes from evidence, reviews the aggregate, remediates, then closes the epic", async () => {
    await withInProcessHarness(
      {
        fixtureOptions: {
          prefix: "scp",
          reviewPolicy: "scope",
          epicTitle: "Scope-policy epic",
          tickets: [
            {
              title: PARENT_TITLE,
              description: "Parent work that dependents wait on until close, not settle.",
            },
            {
              title: DEPENDENT_TITLE,
              description: "May start after parent close, before aggregate review.",
              blockedBy: 0,
            },
          ],
        },
      },
      async (harness) => {
        const { fixture } = harness;
        expect(fixture.reviewPolicy).toBe("scope");
        const epicId = fixture.epic.id;
        const [parentTicket, dependentTicket] = fixture.tickets;
        if (!parentTicket || !dependentTicket) {
          throw new Error("fixture tickets missing");
        }

        await harness.logStep("fixture-ready", { ticketId: parentTicket.id });
        await harness.assertNoTmuxOrWorktree();

        const initialReady = await fixture.ready();
        expect(issueIds(initialReady)).toContain(parentTicket.id);
        expect(issueIds(initialReady)).not.toContain(dependentTicket.id);
        const initialBlocked = await fixture.adapter.blocked(fixture.cwd);
        expect(issueIds(initialBlocked)).toContain(dependentTicket.id);

        await harness.bwRun(epicId);
        const prompt = harness.injectedPrompt();
        expect(prompt).toBeTruthy();
        expect(prompt).toContain(epicId);
        expect(prompt).toContain("Scope-policy epic");
        expect(prompt).toContain("Review policy: scope");
        expect(prompt).toMatch(/Refresh `bw` \(ready\/show\)/);
        expect(prompt).not.toContain(PARENT_TITLE);
        expect(prompt).not.toContain(DEPENDENT_TITLE);
        expect(prompt).not.toContain(parentTicket.id);
        expect(prompt).not.toContain(dependentTicket.id);

        const appendix = await harness.beadwork.dispatch<{ systemPrompt?: string }>(
          "before_agent_start",
          { systemPrompt: "Base prompt" },
          harness.ctx,
        );
        const standing = appendix?.systemPrompt ?? "";
        expect(standing).toContain("Review policy branch: scope");
        expect(standing).toContain(
          "You may close individual tickets from evidence without an independent per-ticket review child.",
        );
        expect(standing).toContain(
          "Launch a `reviewScope` child before declaring the epic complete.",
        );
        expect(standing).toContain("Dependents may start before aggregate review finds a problem.");
        await harness.logStep("bw-run-injected", { ticketId: parentTicket.id });

        const runState = await sessionState(harness);
        expect(runState.mode).toBe("run");
        expect(runState.goal?.reviewPolicy).toBe("scope");
        expect(runState.goal?.scopeIds).toEqual([epicId]);

        const parentWork = await startAndImplement({
          harness,
          epicId,
          ticket: parentTicket,
          task: `Implement ${parentTicket.id}. Output unstructured prose. Do not close tickets.`,
          description: "Implement scope parent",
          relativePath: "parent-feature.txt",
          contents: "parent feature without error path\n",
          commitMessage: `feat: ${parentTicket.id} parent feature`,
        });
        const afterParentSettleReady = await fixture.ready();
        expect(issueIds(afterParentSettleReady)).not.toContain(dependentTicket.id);
        expect((await fixture.show(parentTicket.id)).status).not.toBe("closed");
        await harness.assertNoTmuxOrWorktree();
        await harness.logStep("dependent-still-blocked-after-parent-settle", {
          ticketId: dependentTicket.id,
          childId: parentWork.childId,
          groupId: parentWork.groupId,
        });

        await harness.invokeBeadworkTool("beadwork_close_issue", {
          id: parentTicket.id,
          reason: "Accepted from implementation evidence under scope policy.",
        });
        expect((await fixture.show(parentTicket.id)).status).toBe("closed");
        expect((await sessionState(harness)).mode).toBe("run");
        expect((await sessionState(harness)).goal?.reviewPolicy).toBe("scope");

        const afterParentCloseReady = await fixture.ready();
        expect(issueIds(afterParentCloseReady)).toContain(dependentTicket.id);
        await harness.logStep("dependent-ready-after-parent-close", {
          ticketId: dependentTicket.id,
          groupId: parentWork.groupId,
          issueStatus: (await fixture.show(dependentTicket.id)).status,
        });

        const dependentWork = await startAndImplement({
          harness,
          epicId,
          ticket: dependentTicket,
          task: `Implement ${dependentTicket.id}. Output unstructured prose. Do not close tickets.`,
          description: "Implement scope dependent",
          relativePath: "dependent-feature.txt",
          contents: "dependent feature built on closed parent\n",
          commitMessage: `feat: ${dependentTicket.id} dependent feature`,
        });
        expect(dependentWork.groupId).toBe(parentWork.groupId);

        await harness.invokeBeadworkTool("beadwork_close_issue", {
          id: dependentTicket.id,
          reason: "Accepted from implementation evidence under scope policy.",
        });
        expect((await fixture.show(dependentTicket.id)).status).toBe("closed");
        expect((await fixture.show(epicId)).status).not.toBe("closed");
        expect((await sessionState(harness)).mode).toBe("run");
        expect(harness.launchedTaskTypes()).toEqual(["implementation", "implementation"]);
        await harness.logStep("tickets-closed-without-ticket-review", {
          ticketId: dependentTicket.id,
          groupId: dependentWork.groupId,
        });

        const scopeReviewTask = [
          `Review the aggregate of ${epicId} tickets ${parentTicket.id} and ${dependentTicket.id}.`,
          `Inspect named commits ${parentWork.commit} and ${dependentWork.commit} with`,
          `\`git show ${parentWork.commit}\` and \`git show ${dependentWork.commit}\`.`,
          "Do not read the whole dirty workspace.",
          "Judge whether the goal meets acceptance.",
        ].join(" ");
        expect(scopeReviewTask).toContain(parentTicket.id);
        expect(scopeReviewTask).toContain(dependentTicket.id);
        expect(scopeReviewTask).toContain(parentWork.commit);
        expect(scopeReviewTask).toContain(dependentWork.commit);
        expect(scopeReviewTask).toContain("git show");
        expect(scopeReviewTask).toMatch(/do not read the whole dirty workspace/i);

        const firstReview = await harness.orchestrate({
          tasks: [
            {
              task: scopeReviewTask,
              description: "Aggregate scope review",
              agent: "worker",
              taskType: "reviewScope",
              domain: {
                source: "beadwork",
                scopeId: epicId,
                workItemId: epicId,
                title: fixture.epic.title,
              },
            },
          ],
        });
        const scopeReviewId = firstReview.accepted[0]?.childId;
        if (!scopeReviewId) {
          throw new Error("orchestrate did not accept reviewScope");
        }
        expect(firstReview.groupId).toBe(parentWork.groupId);
        expect(harness.tree.get(scopeReviewId)?.task).toContain("git show");
        expect(harness.tree.get(scopeReviewId)?.task).toContain(parentWork.commit);
        expect(harness.tree.get(scopeReviewId)?.task).toMatch(
          /do not read the whole dirty workspace/i,
        );

        const firstReviewPacket = await settleAndWait(
          harness,
          scopeReviewId,
          `${BLOCKING_FINDING} tickets ${parentTicket.id}, ${dependentTicket.id}.`,
        );
        expect(firstReviewPacket?.message.customType).toBe(LIFECYCLE_PACKET_CUSTOM_TYPE);
        expect(firstReviewPacket?.message.details.changed[0]?.childId).toBe(scopeReviewId);
        expect(firstReviewPacket?.message.details.changed[0]?.nudge).toMatch(/cross-ticket/i);
        expect(firstReviewPacket?.message.details.changed[0]?.nudge).toMatch(/acceptance/i);
        expect((await fixture.show(epicId)).status).not.toBe("closed");
        await harness.logStep("scope-review-blocking-finding", {
          ticketId: parentTicket.id,
          childId: scopeReviewId,
          groupId: firstReview.groupId,
        });

        const fixDisposition = [
          `Disposition: fix (blocking) on ${parentTicket.id} at ${parentWork.commit}.`,
          `Scope-review child ${scopeReviewId}. Re-review required before epic close.`,
        ].join(" ");
        await harness.invokeBeadworkTool("beadwork_comment_issue", {
          id: epicId,
          text: fixDisposition,
        });
        await harness.logStep("disposition-fix-blocking", {
          ticketId: parentTicket.id,
          childId: scopeReviewId,
          groupId: firstReview.groupId,
        });

        const fixResult = await harness.orchestrate({
          tasks: [
            {
              task: `Remediate the blocking finding on ${parentTicket.id} commit ${parentWork.commit}. Do not close tickets.`,
              description: "Fix scope-review finding",
              agent: "worker",
              taskType: "fix",
              domain: {
                source: "beadwork",
                scopeId: epicId,
                workItemId: parentTicket.id,
                title: parentTicket.title,
              },
            },
          ],
        });
        const fixId = fixResult.accepted[0]?.childId;
        if (!fixId) {
          throw new Error("orchestrate did not accept fix child");
        }
        const fixCommit = await commitEvidence(
          harness,
          "parent-feature.txt",
          "parent feature with required error path\n",
          `fix: ${parentTicket.id} add error path`,
        );
        const fixPacket = await settleAndWait(
          harness,
          fixId,
          `Remediated ${parentTicket.id} in commit ${fixCommit}.`,
        );
        expect(fixPacket?.message.details.changed[0]?.nudge).toMatch(/re-review/i);
        expect((await fixture.show(epicId)).status).not.toBe("closed");
        await harness.logStep("in-scope-remediation-settled", {
          ticketId: parentTicket.id,
          childId: fixId,
          groupId: fixResult.groupId,
        });

        const reReviewTask = [
          `Re-review the aggregate of ${epicId} tickets ${parentTicket.id} and ${dependentTicket.id}.`,
          `Inspect named commits ${parentWork.commit}, ${dependentWork.commit}, and ${fixCommit}`,
          `with \`git show ${fixCommit}\`.`,
          "Do not read the whole dirty workspace.",
        ].join(" ");
        const reReview = await harness.orchestrate({
          tasks: [
            {
              task: reReviewTask,
              description: "Aggregate scope re-review",
              agent: "worker",
              taskType: "reviewScope",
              domain: {
                source: "beadwork",
                scopeId: epicId,
                workItemId: epicId,
                title: fixture.epic.title,
              },
            },
          ],
        });
        const reReviewId = reReview.accepted[0]?.childId;
        if (!reReviewId) {
          throw new Error("orchestrate did not accept scope re-review");
        }
        await settleAndWait(
          harness,
          reReviewId,
          `${CLEAN_REVIEW} tickets ${parentTicket.id}, ${dependentTicket.id}.`,
        );
        expect((await fixture.show(epicId)).status).not.toBe("closed");

        const acceptDisposition = [
          `Disposition: accept after re-review ${reReviewId}.`,
          `Blocking finding on ${parentTicket.id} fixed in ${fixCommit}.`,
          "Scope-review dispositions complete.",
        ].join(" ");
        await harness.invokeBeadworkTool("beadwork_comment_issue", {
          id: epicId,
          text: acceptDisposition,
        });
        await harness.logStep("disposition-accept-after-rereview", {
          ticketId: parentTicket.id,
          childId: reReviewId,
          groupId: reReview.groupId,
        });

        const launched = harness.launchedChildren();
        const taskTypes = launched.map((child) => child.taskType);
        expect(taskTypes.filter((taskType) => taskType === "reviewImplementation")).toEqual([]);
        expect(taskTypes.filter((taskType) => taskType === "implementation")).toHaveLength(2);
        expect(taskTypes.filter((taskType) => taskType === "reviewScope")).toHaveLength(2);
        expect(taskTypes.filter((taskType) => taskType === "fix")).toHaveLength(1);
        await harness.logStep("zero-ticket-review-children", {
          ticketId: parentTicket.id,
          childId: scopeReviewId,
          groupId: parentWork.groupId,
        });
        console.info("[in-process] scope-policy launched taskTypes", {
          policy: "scope",
          epicId,
          ticketIds: [parentTicket.id, dependentTicket.id],
          launchedTaskTypes: taskTypes,
          scopeReviewChildId: scopeReviewId,
          reReviewChildId: reReviewId,
          dispositions: [fixDisposition, acceptDisposition],
        });

        harness.beadwork.sentUserMessages.length = 0;
        harness.beadwork.sentMessages.length = 0;
        await harness.invokeBeadworkTool("beadwork_close_issue", {
          id: epicId,
          reason: "Scope-review dispositions complete.",
        });
        expect((await fixture.show(epicId)).status).toBe("closed");
        const afterEpicClose = await sessionState(harness);
        expect(afterEpicClose.mode).not.toBe("run");
        expect(afterEpicClose.mode).toBe("interactive");
        expect(afterEpicClose.goal).toBeUndefined();
        expect(harness.beadwork.sentUserMessages).toHaveLength(1);
        expect(String(harness.beadwork.sentUserMessages[0]?.content ?? "")).toContain(
          "/halt group",
        );
        expect(harness.beadwork.sentUserMessages[0]?.options).toEqual({ deliverAs: "followUp" });
        expect(harness.groups.getOpenGroup()?.groupId).toBe(parentWork.groupId);

        await harness.halt("group");
        expect(harness.groups.getOpenGroup()).toBeUndefined();
        expect(harness.launchedTaskTypes()).not.toContain("reviewImplementation");
        await harness.assertNoTmuxOrWorktree();
        await harness.logStep("epic-closed-after-scope-dispositions", {
          ticketId: parentTicket.id,
          childId: reReviewId,
          issueStatus: "closed",
        });
      },
    );
  }, 30_000);
});
