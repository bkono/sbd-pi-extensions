import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../../../pi-minions/src/logger.js";
import { DEFAULT_CONFIG } from "../../constants.js";
import { loadSessionState, resolveSessionStateDir } from "../../session-state.js";
import type { BeadworkIssue } from "../../types.js";
import {
  ANNOUNCE_MINION_PATHS_TOOL,
  BEADWORK_CHILD_INSPECTION_TOOLS,
  COMM_SEND_STATUS,
  DENIED_CHILD_BEADWORK_TOOLS,
  formatMinionMail,
  type InProcessHarness,
  LIFECYCLE_PACKET_CUSTOM_TYPE,
  ORCHESTRATED_COMM_TOOL_NAMES,
  PARENT_ONLY_MINION_TOOLS,
  PARENT_RECIPIENT_ID,
  type ScriptedChildSession,
  SEND_MINION_PEER_TOOL,
  withInProcessHarness,
} from "../helpers/in-process-orchestration.js";

const ALPHA_TITLE = "Parallel alpha ticket";
const BETA_TITLE = "Parallel beta ticket";
const GAMMA_TITLE = "Dependent gamma ticket";
const QUALITY =
  "Run project quality commands (`npm run lint`, `npm run test`, `npm run typecheck`) yourself. " +
  "Beadwork does not own a validation gate.";
const IMPLEMENT_PROSE =
  "Implemented as unstructured prose. Ran npm run lint, npm run test, and npm run typecheck. " +
  "All passed. Do not close tickets.";
const CLEAN_REVIEW =
  "No remaining findings. Acceptance met. Ran lint/test/typecheck as reviewer actions.";
const FINDINGS_REVIEW = [
  "Reviewed named commits. Findings:",
  "1. [required] Missing error path — fix (blocking, re-review required).",
  "2. [nonblocking] Extra debug logging — file as a durable follow-up issue.",
  "3. [nit] README wording is out of scope — reject with rationale.",
  "Ran lint/test/typecheck as reviewer actions. No keyword classifier.",
].join(" ");
const DELETED_WORKER_TOOLS = [
  "beadwork_delegate",
  "beadwork_worker_done",
  "beadwork_land_worker",
  "beadwork_worker_check",
] as const;

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
  const abs = join(harness.fixture.cwd, relativePath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, contents, "utf8");
  await harness.fixture.exec("git", ["add", relativePath]);
  await harness.fixture.exec("git", ["commit", "-q", "-m", message]);
  const { stdout } = await harness.fixture.exec("git", ["rev-parse", "HEAD"]);
  return stdout.trim();
}

async function waitForFollowUps(
  session: ScriptedChildSession,
  count: number,
  label: string,
): Promise<string[]> {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    if (session.followUps.length >= count) return session.followUps;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `${label}: expected ${count} followUps, have ${session.followUps.length}: ${JSON.stringify(session.followUps)}`,
  );
}

async function commentEvidence(harness: InProcessHarness, id: string): Promise<string> {
  const chunks: string[] = [];
  for (const args of [
    ["comments", id],
    ["history", id],
  ]) {
    try {
      const { stdout } = await harness.fixture.exec("bw", args);
      chunks.push(stdout);
    } catch {
      // Optional CLI surface; history via the adapter is the durable fallback.
    }
  }
  const history = await harness.fixture.adapter.history(harness.fixture.cwd, id);
  chunks.push(JSON.stringify(history));
  return chunks.join("\n");
}

function domainFor(epicId: string, ticket: BeadworkIssue) {
  return {
    source: "beadwork" as const,
    scopeId: epicId,
    workItemId: ticket.id,
    title: ticket.title,
  };
}

function assertNoDeletedRuntimeTools(names: string[]) {
  for (const tool of DELETED_WORKER_TOOLS) {
    expect(names).not.toContain(tool);
  }
  const qualityRunner = names.some(
    (name) => name.startsWith("beadwork_") && /lint|typecheck|quality/.test(name),
  );
  expect(qualityRunner).toBe(false);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("in-process ticket-policy epic with review and no tmux", () => {
  it("runs two parallel tickets, a dependent, review dispositions, then epic halt", async () => {
    const info = vi.spyOn(logger, "info");
    await withInProcessHarness(
      {
        fixtureOptions: {
          prefix: "tkp",
          reviewPolicy: "ticket",
          epicTitle: "Ticket-policy epic",
          tickets: [
            {
              title: ALPHA_TITLE,
              description:
                "Parallel work that review will find required and nonblocking issues on.",
            },
            {
              title: BETA_TITLE,
              description: "Parallel work that reviews clean.",
            },
            {
              title: GAMMA_TITLE,
              description: "Unlocks only after the parent closes the blocker, never after settle.",
              blockedBy: 0,
            },
          ],
        },
      },
      async (harness) => {
        const { fixture } = harness;
        expect(fixture.reviewPolicy).toBe("ticket");
        const epicId = fixture.epic.id;
        const [alpha, beta, gamma] = fixture.tickets;
        if (!alpha || !beta || !gamma) {
          throw new Error("fixture tickets missing");
        }
        const tickets = [alpha.id, beta.id, gamma.id];

        await harness.logStep("fixture-ready", {
          ticketId: alpha.id,
          issueIds: tickets,
        });
        await harness.assertNoTmuxOrWorktree();
        assertNoDeletedRuntimeTools(harness.parentToolNames);
        expect(harness.parentToolNames).toContain("send_minion_message");
        expect(harness.parentToolNames).toContain("beadwork_start_goal");

        const initialReady = await fixture.ready();
        expect(issueIds(initialReady)).toEqual(expect.arrayContaining([alpha.id, beta.id]));
        expect(issueIds(initialReady)).not.toContain(gamma.id);
        expect(issueIds(await fixture.adapter.blocked(fixture.cwd))).toContain(gamma.id);

        const started = (await harness.invokeBeadworkTool("beadwork_start_goal", {
          epic_id: epicId,
        })) as {
          details: {
            epic_id: string;
            epic_title: string;
            goal_id: string;
            review_policy: string;
            state: string;
            continuation: string;
          };
        };
        expect(started.details.state).toBe("started");
        expect(started.details.continuation).toBe("triggered_turn");
        expect(started.details.epic_id).toBe(epicId);
        expect(started.details.epic_title).toBe("Ticket-policy epic");
        expect(started.details.review_policy).toBe("ticket");
        expect(JSON.stringify(started.details).toLowerCase()).not.toMatch(
          /complet|succeed|finished|orchestrated/,
        );
        const prompt = harness.injectedPrompt();
        expect(prompt).toBeTruthy();
        expect(prompt).toContain(epicId);
        expect(prompt).toContain("Ticket-policy epic");
        expect(prompt).toContain("Review policy: ticket");
        expect(prompt).toMatch(/Refresh `bw` \(ready\/show\)/);
        expect(prompt).not.toContain(ALPHA_TITLE);
        expect(prompt).not.toContain(BETA_TITLE);
        expect(prompt).not.toContain(GAMMA_TITLE);
        expect(prompt).not.toContain(alpha.id);
        expect(prompt).not.toContain(beta.id);
        expect(prompt).not.toContain(gamma.id);

        const appendix = await harness.beadwork.dispatch<{ systemPrompt?: string }>(
          "before_agent_start",
          { systemPrompt: "Base prompt" },
          harness.ctx,
        );
        const standing = appendix?.systemPrompt ?? "";
        expect(standing).toContain("Base prompt");
        expect(standing).toContain("You are in beadwork run mode.");
        expect(standing).toContain(`Current scope: epic:${epicId}`);
        expect(standing).toContain("Review policy branch: ticket");
        expect(standing).toContain(
          "Launch an independent `reviewImplementation` child before closing that ticket.",
        );
        expect(standing).toContain("Do not close from implementer settlement alone.");
        expect(standing).toContain(
          "Do not start review of ticket A while A's implementer is still live.",
        );
        expect(standing).toContain("Beadwork does not own a validation gate.");
        expect(standing).toContain("This is a manager-only loop.");
        expect(standing).toContain(
          "The parent does not implement a delegated ticket concurrently with its live child.",
        );
        expect(standing).toContain(
          "Human `/bw run <epic-id>` and model `beadwork_start_goal({ epic_id })` are equivalent entry surfaces for the same lifecycle.",
        );
        expect(standing).toContain(
          "When a turn runs: refresh `bw` (ready/show), start ready work, compose each child's `task`, then `orchestrate`.",
        );
        expect(standing).not.toContain(
          "Do not imitate `/bw run` with `ready`, ticket mutations, and `orchestrate`.",
        );

        const runState = await sessionState(harness);
        expect(runState.mode).toBe("run");
        expect(runState.goal?.reviewPolicy).toBe("ticket");
        expect(runState.goal?.scopeIds).toEqual([epicId]);
        expect(harness.groups.getOpenGroup()).toBeUndefined();
        await harness.logStep("bw-start-goal-injected", {
          ticketId: alpha.id,
          issueIds: tickets,
        });

        await harness.invokeBeadworkTool("beadwork_start_issue", { id: alpha.id });
        await harness.invokeBeadworkTool("beadwork_start_issue", { id: beta.id });
        expect((await fixture.show(alpha.id)).status).toBe("in_progress");
        expect((await fixture.show(beta.id)).status).toBe("in_progress");

        const launched = await harness.orchestrate({
          tasks: [
            {
              task: [
                `Implement ${alpha.id} (${ALPHA_TITLE}) on the shared branch.`,
                "Output unstructured prose. Do not close tickets.",
                QUALITY,
              ].join(" "),
              description: "Implement parallel alpha",
              agent: "worker",
              taskType: "implementation",
              domain: domainFor(epicId, alpha),
            },
            {
              task: [
                `Implement ${beta.id} (${BETA_TITLE}) on the shared branch.`,
                "Output unstructured prose. Do not close tickets.",
                QUALITY,
              ].join(" "),
              description: "Implement parallel beta",
              agent: "worker",
              taskType: "implementation",
              domain: domainFor(epicId, beta),
            },
          ],
        });
        expect(launched.accepted).toHaveLength(2);
        expect(launched.rejected).toEqual([]);
        const childA = launched.accepted[0]?.childId;
        const childB = launched.accepted[1]?.childId;
        const groupId = launched.groupId;
        if (!childA || !childB) {
          throw new Error("orchestrate did not accept both implementers");
        }
        expect(groupId).toMatch(/^grp-/);
        expect(harness.groups.getOpenGroup()?.groupId).toBe(groupId);
        expect(harness.tree.get(childA)?.groupId).toBe(groupId);
        expect(harness.tree.get(childB)?.groupId).toBe(groupId);

        const sessionA = await harness.waitForChild(childA);
        const sessionB = await harness.waitForChild(childB);
        await Promise.all([harness.waitUntilRunning(childA), harness.waitUntilRunning(childB)]);
        for (const childId of [childA, childB]) {
          const active = harness.childActiveTools(childId);
          for (const name of BEADWORK_CHILD_INSPECTION_TOOLS) expect(active).toContain(name);
          for (const name of ORCHESTRATED_COMM_TOOL_NAMES) expect(active).toContain(name);
          for (const name of DENIED_CHILD_BEADWORK_TOOLS) expect(active).not.toContain(name);
          for (const name of PARENT_ONLY_MINION_TOOLS) expect(active).not.toContain(name);
          assertNoDeletedRuntimeTools(active);
        }
        await harness.assertNoTmuxOrWorktree();
        await harness.logStep("implementers-live-shared-branch", {
          ticketId: alpha.id,
          childId: childA,
          groupId,
          issueIds: tickets,
          childIds: [childA, childB],
        });

        const alphaCommit = await commitEvidence(
          harness,
          "src/alpha.ts",
          "export const alpha = () => 'ok'\n",
          `feat: ${alpha.id} alpha feature`,
        );
        const betaCommit = await commitEvidence(
          harness,
          "src/beta.ts",
          "export const beta = () => 'ok'\n",
          `feat: ${beta.id} beta feature`,
        );

        const peerAnnounce = (await harness.invokeChildTool(childB, ANNOUNCE_MINION_PATHS_TOOL, {
          paths: ["src/"],
          ttlMs: 60_000,
        })) as { details?: { overlap?: boolean; editAllowed?: boolean } };
        expect(peerAnnounce.details?.editAllowed).toBe(true);

        const overlapAnnounce = (await harness.invokeChildTool(childA, ANNOUNCE_MINION_PATHS_TOOL, {
          paths: ["src/alpha.ts"],
          ttlMs: 60_000,
        })) as {
          details?: {
            overlap?: boolean;
            editAllowed?: boolean;
            overlaps?: Array<{ otherId: string }>;
          };
        };
        expect(overlapAnnounce.details?.overlap).toBe(true);
        expect(overlapAnnounce.details?.editAllowed).toBe(true);
        expect(overlapAnnounce.details?.overlaps?.some((hit) => hit.otherId === childB)).toBe(true);
        expect(harness.overlaps.list().length).toBeGreaterThan(0);
        expect(harness.manager.getTerminal(childA)).toBeUndefined();
        expect(harness.manager.getTerminal(childB)).toBeUndefined();
        expect(harness.tree.get(childA)?.status).toBe("running");
        expect(harness.tree.get(childB)?.status).toBe("running");
        await waitForFollowUps(sessionB, 1, "overlap-notice");
        expect(sessionB.followUps.some((text) => /path overlap/i.test(text))).toBe(true);
        expect(sessionB.followUps.some((text) => /not blocked/i.test(text))).toBe(true);
        await harness.assertNoTmuxOrWorktree();
        await harness.logStep("overlap-notice-continue", {
          ticketId: alpha.id,
          childId: childA,
          groupId,
          issueIds: [alpha.id, beta.id],
          childIds: [childA, childB],
        });

        const peerSend = (await harness.invokeChildTool(childA, SEND_MINION_PEER_TOOL, {
          to: childB,
          body: "I am editing src/alpha.ts; leave src/beta.ts to you.",
        })) as { details?: { status?: string; from?: string; to?: string } };
        expect(peerSend.details).toMatchObject({
          status: COMM_SEND_STATUS.queued,
          from: childA,
          to: childB,
        });
        const peerMail = formatMinionMail(
          childA,
          "I am editing src/alpha.ts; leave src/beta.ts to you.",
        );
        // Production serializes accepted deliveries per child. The live overlap follow-up
        // must drain before this queued mail starts a fresh prompt after the run becomes idle.
        expect(sessionB.followUps).toHaveLength(1);
        expect(sessionB.followUps).not.toContain(peerMail);
        expect(harness.packets).toHaveLength(0);
        await harness.logStep("peer-send-no-parent-turn", {
          ticketId: beta.id,
          childId: childB,
          groupId,
          childIds: [childA, childB],
        });

        // Review ordering is parent policy from the standing appendix, not a runtime work-item lock.
        // The parent obeys it here and does not launch alpha's reviewer before settlement.
        expect(harness.launchedTaskTypes()).toEqual(["implementation", "implementation"]);
        expect(harness.groups.getOpenGroup()?.groupId).toBe(groupId);
        expect(harness.tree.get(childA)?.status).toBe("running");
        expect(harness.tree.get(childB)?.status).toBe("running");
        await harness.logStep("parent-kept-review-ordered-after-implementer", {
          ticketId: alpha.id,
          childId: childA,
          groupId,
        });

        const beforeQuestion = harness.packets.length;
        const asked = (await harness.invokeChildTool(childA, SEND_MINION_PEER_TOOL, {
          to: PARENT_RECIPIENT_ID,
          body: "Which error-path shape should alpha use?",
        })) as { details?: { status?: string; parentTurnTriggered?: boolean } };
        expect(asked.details?.status).toBe(COMM_SEND_STATUS.queued);
        expect(asked.details?.parentTurnTriggered).toBe(false);
        await harness.waitForPackets(beforeQuestion + 1);
        const questionPacket = harness.lastPacket();
        expect(questionPacket?.message.customType).toBe(LIFECYCLE_PACKET_CUSTOM_TYPE);
        expect(questionPacket?.message.details.changed).toHaveLength(1);
        expect(questionPacket?.message.details.changed[0]).toMatchObject({
          childId: childA,
          eventClass: "parentMessage",
          output: "Which error-path shape should alpha use?",
        });
        expect(questionPacket?.message.details.changed[0]?.nudge).toMatch(/no reply is required/i);
        expect(
          questionPacket?.message.details.stillRunning.map((child) => child.childId).sort(),
        ).toEqual([childA, childB].sort());
        expect(questionPacket?.message.details.overlaps.length).toBeGreaterThan(0);
        expect(questionPacket?.message.content).toMatch(/overlaps/i);
        expect(questionPacket?.message.content).toMatch(/edits are not blocked/i);
        expect(harness.manager.getTerminal(childA)).toBeUndefined();
        expect(harness.tree.get(childA)?.status).toBe("running");
        await harness.logStep("parent-message-live-child", {
          ticketId: alpha.id,
          childId: childA,
          groupId,
          eventClass: "parentMessage",
          packetSeq: questionPacket?.message.details.seq,
          childIds: [childA, childB],
        });

        const answered = await harness.sendMinionMessage(
          childA,
          "Use a Result type for the error path.",
        );
        expect(answered.status).toBe(COMM_SEND_STATUS.queued);
        await waitForFollowUps(sessionA, 1, "parent-answer");
        expect(sessionA.followUps[0]).toBe(
          "[minion-mail from parent]\nUse a Result type for the error path.",
        );
        expect(harness.manager.getTerminal(childA)).toBeUndefined();
        expect(harness.tree.get(childA)?.status).toBe("running");
        await harness.logStep("parent-answered-child-continues", {
          ticketId: alpha.id,
          childId: childA,
          groupId,
        });

        const beforeSettle = harness.packets.length;
        await harness.settleChildren([
          {
            childId: childA,
            prose: `${IMPLEMENT_PROSE} Used Result type per parent. commit ${alphaCommit}`,
          },
          {
            childId: childB,
            prose: `${IMPLEMENT_PROSE} commit ${betaCommit}`,
          },
        ]);
        await harness.waitForPackets(beforeSettle + 2);
        const settlePackets = harness.packets.slice(beforeSettle);
        expect(settlePackets.map((packet) => packet.message.details.seq)).toEqual([
          (questionPacket?.message.details.seq ?? 0) + 1,
          (questionPacket?.message.details.seq ?? 0) + 2,
        ]);
        const settled = settlePackets.flatMap((packet) =>
          packet.message.details.changed.filter((child) => child.eventClass === "settled"),
        );
        expect(settled).toHaveLength(2);
        expect(settled.map((child) => child.childId).sort()).toEqual([childA, childB].sort());
        expect(settlePackets[0]?.message.details.stillRunning).toEqual([
          expect.objectContaining({ childId: childB, state: "settling" }),
        ]);
        const settlePacket = settlePackets.at(-1);
        expect(settlePacket?.message.details.stillRunning).toEqual([]);
        expect(settlePacket?.message.details.groupIdleId).toBe(groupId);
        expect(sessionB.lastPrompt).toBe(
          `[minion-mail from ${childA}]\nI am editing src/alpha.ts; leave src/beta.ts to you.`,
        );
        expect(sessionB.promptCalls).toBe(2);
        expect(settlePacket?.message.content).toMatch(
          /do not close a ticket solely because the child settled/i,
        );
        expect((await fixture.show(alpha.id)).status).toBe("in_progress");
        expect((await fixture.show(beta.id)).status).toBe("in_progress");
        expect(issueIds(await fixture.ready())).not.toContain(gamma.id);

        const committed = info.mock.calls.filter(
          (call) =>
            call[0] === "subsession" &&
            call[1] === "lifecycle" &&
            (call[2] as { terminalLatchFired?: boolean; childId?: string }).terminalLatchFired ===
              true &&
            (call[2] as { childId?: string }).childId === childA,
        );
        expect(committed).toHaveLength(1);
        expect(committed[0]?.[2]).toMatchObject({
          eventClass: "settled",
          winner: "mail-then-settle",
          terminalEventCount: 1,
        });
        const late = await harness.sendMinionMessage(childA, "too late");
        expect(late.status).toBe(COMM_SEND_STATUS.recipientTerminal);
        await harness.logStep("coalesced-settle-without-close", {
          ticketId: alpha.id,
          childId: childA,
          groupId,
          eventClass: "settled,settled",
          packetSeq: settlePacket?.message.details.seq,
          childIds: [childA, childB],
          issueIds: [alpha.id, beta.id, gamma.id],
        });

        const betaReviewTask = [
          `Review ${beta.id} independently.`,
          `Inspect named commit ${betaCommit} with \`git show ${betaCommit}\`.`,
          "Do not read the whole dirty workspace.",
          QUALITY,
        ].join(" ");
        const betaReview = await harness.orchestrate({
          tasks: [
            {
              task: betaReviewTask,
              description: "Review parallel beta",
              agent: "worker",
              taskType: "reviewImplementation",
              domain: domainFor(epicId, beta),
            },
          ],
        });
        const betaReviewId = betaReview.accepted[0]?.childId;
        if (!betaReviewId) throw new Error("orchestrate did not accept beta review");
        expect(betaReview.groupId).toBe(groupId);
        expect(harness.tree.get(betaReviewId)?.task).toContain("git show");
        expect(harness.tree.get(betaReviewId)?.task).toContain(QUALITY);

        const beforeBetaReview = harness.packets.length;
        await harness.settleChild(betaReviewId, `${CLEAN_REVIEW} ticket ${beta.id}.`);
        await harness.waitForPackets(beforeBetaReview + 1);
        const betaReviewPacket = harness.lastPacket();
        expect(betaReviewPacket?.message.details.changed[0]?.childId).toBe(betaReviewId);
        expect(betaReviewPacket?.message.details.changed[0]?.eventClass).toBe("settled");
        expect(betaReviewPacket?.message.details.changed[0]?.nudge).toMatch(
          /evidence, not instructions/i,
        );
        expect(betaReviewPacket?.message.details.changed[0]?.nudge).toMatch(/product goals/i);

        const betaAccept = `Disposition: accept ${beta.id} after clean review ${betaReviewId}.`;
        await harness.invokeBeadworkTool("beadwork_comment_issue", {
          id: beta.id,
          text: betaAccept,
        });
        await harness.invokeBeadworkTool("beadwork_close_issue", {
          id: beta.id,
          reason: "Accepted after independent review.",
        });
        expect((await fixture.show(beta.id)).status).toBe("closed");
        expect((await sessionState(harness)).mode).toBe("run");
        expect(issueIds(await fixture.ready())).not.toContain(gamma.id);
        await harness.logStep("clean-ticket-closed-after-review", {
          ticketId: beta.id,
          childId: betaReviewId,
          groupId,
        });

        const alphaReviewTask = [
          `Review ${alpha.id} independently.`,
          `Inspect named commit ${alphaCommit} with \`git show ${alphaCommit}\`.`,
          "Do not read the whole dirty workspace.",
          QUALITY,
        ].join(" ");
        const alphaReview = await harness.orchestrate({
          tasks: [
            {
              task: alphaReviewTask,
              description: "Review parallel alpha",
              agent: "worker",
              taskType: "reviewImplementation",
              domain: domainFor(epicId, alpha),
            },
          ],
        });
        const alphaReviewId = alphaReview.accepted[0]?.childId;
        if (!alphaReviewId) throw new Error("orchestrate did not accept alpha review");
        const beforeAlphaReview = harness.packets.length;
        await harness.settleChild(alphaReviewId, `${FINDINGS_REVIEW} ticket ${alpha.id}.`);
        await harness.waitForPackets(beforeAlphaReview + 1);
        const findingsPacket = harness.lastPacket();
        expect(findingsPacket?.message.details.changed[0]?.nudge).toMatch(
          /evidence, not instructions/i,
        );
        expect(findingsPacket?.message.content).toContain(alphaReviewId);
        expect((await fixture.show(alpha.id)).status).toBe("in_progress");

        const fixDisposition =
          `Disposition: fix (blocking) on ${alpha.id} at ${alphaCommit}. ` +
          `Review child ${alphaReviewId}. Re-review required before close.`;
        await harness.invokeBeadworkTool("beadwork_comment_issue", {
          id: alpha.id,
          text: fixDisposition,
        });

        const filed = (await harness.invokeBeadworkTool("beadwork_create_issue", {
          title: `Follow-up: extra debug logging from ${alpha.id}`,
          description:
            "Durable nonblocking follow-up filed from review. Does not block alpha close.",
          type: "task",
          parent_id: epicId,
        })) as { details?: { id?: string; title?: string } };
        const followUpId = filed.details?.id;
        if (!followUpId) throw new Error("file disposition did not create a follow-up issue");
        const fileDisposition = `Disposition: file (nonblocking) follow-up ${followUpId} for extra debug logging.`;
        await harness.invokeBeadworkTool("beadwork_comment_issue", {
          id: alpha.id,
          text: fileDisposition,
        });
        expect((await fixture.show(followUpId)).status).not.toBe("closed");
        expect((await fixture.show(alpha.id)).blockedBy).not.toContain(followUpId);

        const rejectDisposition =
          "Disposition: reject — README wording is out of scope for this ticket. Rationale recorded.";
        await harness.invokeBeadworkTool("beadwork_comment_issue", {
          id: alpha.id,
          text: rejectDisposition,
        });
        const alphaComments = await commentEvidence(harness, alpha.id);
        expect(alphaComments).toContain("Disposition: fix");
        expect(alphaComments).toContain("Disposition: file");
        expect(alphaComments).toContain("Disposition: reject");
        expect(alphaComments).toContain("out of scope");
        expect(alphaComments).toContain(followUpId);
        await harness.logStep("dispositions-fix-file-reject", {
          ticketId: alpha.id,
          childId: alphaReviewId,
          groupId,
          issueIds: [alpha.id, followUpId],
        });

        const fixResult = await harness.orchestrate({
          tasks: [
            {
              task: [
                `Remediate the blocking finding on ${alpha.id} commit ${alphaCommit}.`,
                "Do not close tickets.",
                QUALITY,
              ].join(" "),
              description: "Fix alpha review finding",
              agent: "worker",
              taskType: "fix",
              domain: domainFor(epicId, alpha),
            },
          ],
        });
        const fixId = fixResult.accepted[0]?.childId;
        if (!fixId) throw new Error("orchestrate did not accept fix child");
        const fixCommit = await commitEvidence(
          harness,
          "src/alpha.ts",
          "export const alpha = (): Result<string, Error> => ({ ok: true, value: 'ok' })\n",
          `fix: ${alpha.id} add Result error path`,
        );
        const beforeFix = harness.packets.length;
        await harness.settleChild(
          fixId,
          `Remediated ${alpha.id} in commit ${fixCommit}. Ran quality commands.`,
        );
        await harness.waitForPackets(beforeFix + 1);
        expect(harness.lastPacket()?.message.details.changed[0]?.nudge).toMatch(/re-review/i);
        expect((await fixture.show(alpha.id)).status).not.toBe("closed");
        expect(issueIds(await fixture.ready())).not.toContain(gamma.id);

        const reReview = await harness.orchestrate({
          tasks: [
            {
              task: [
                `Re-review ${alpha.id} after fix.`,
                `Inspect named commit ${fixCommit} with \`git show ${fixCommit}\`.`,
                "Do not read the whole dirty workspace.",
                QUALITY,
              ].join(" "),
              description: "Re-review parallel alpha",
              agent: "worker",
              taskType: "reviewImplementation",
              domain: domainFor(epicId, alpha),
            },
          ],
        });
        const reReviewId = reReview.accepted[0]?.childId;
        if (!reReviewId) throw new Error("orchestrate did not accept alpha re-review");
        await harness.settleChild(
          reReviewId,
          `${CLEAN_REVIEW} ticket ${alpha.id} after ${fixCommit}.`,
        );
        const acceptAlpha =
          `Disposition: accept ${alpha.id} after re-review ${reReviewId}. ` +
          `Blocking finding fixed in ${fixCommit}. Filed ${followUpId}. Rejected README nit.`;
        await harness.invokeBeadworkTool("beadwork_comment_issue", {
          id: alpha.id,
          text: acceptAlpha,
        });
        await harness.invokeBeadworkTool("beadwork_close_issue", {
          id: alpha.id,
          reason: "Accepted after fix, file, reject dispositions and re-review.",
        });
        expect((await fixture.show(alpha.id)).status).toBe("closed");
        expect((await sessionState(harness)).mode).toBe("run");
        expect(issueIds(await fixture.ready())).toContain(gamma.id);
        await harness.logStep("dependent-ready-after-blocker-close", {
          ticketId: gamma.id,
          groupId,
          issueIds: [alpha.id, beta.id, gamma.id],
        });

        await harness.invokeBeadworkTool("beadwork_start_issue", { id: gamma.id });
        const gammaWork = await harness.orchestrate({
          tasks: [
            {
              task: [
                `Implement ${gamma.id} (${GAMMA_TITLE}).`,
                "Output unstructured prose. Do not close tickets.",
                QUALITY,
              ].join(" "),
              description: "Implement dependent gamma",
              agent: "worker",
              taskType: "implementation",
              domain: domainFor(epicId, gamma),
            },
          ],
        });
        const childG = gammaWork.accepted[0]?.childId;
        if (!childG) throw new Error("orchestrate did not accept dependent implementer");
        expect(gammaWork.groupId).toBe(groupId);
        const gammaCommit = await commitEvidence(
          harness,
          "src/gamma.ts",
          "export const gamma = () => 'depends on closed alpha'\n",
          `feat: ${gamma.id} dependent feature`,
        );
        await harness.settleChild(childG, `${IMPLEMENT_PROSE} commit ${gammaCommit}`);
        expect((await fixture.show(gamma.id)).status).toBe("in_progress");

        const gammaReview = await harness.orchestrate({
          tasks: [
            {
              task: [
                `Review ${gamma.id} independently.`,
                `Inspect named commit ${gammaCommit} with \`git show ${gammaCommit}\`.`,
                "Do not read the whole dirty workspace.",
                QUALITY,
              ].join(" "),
              description: "Review dependent gamma",
              agent: "worker",
              taskType: "reviewImplementation",
              domain: domainFor(epicId, gamma),
            },
          ],
        });
        const gammaReviewId = gammaReview.accepted[0]?.childId;
        if (!gammaReviewId) throw new Error("orchestrate did not accept gamma review");
        await harness.settleChild(gammaReviewId, `${CLEAN_REVIEW} ticket ${gamma.id}.`);
        await harness.invokeBeadworkTool("beadwork_comment_issue", {
          id: gamma.id,
          text: `Disposition: accept ${gamma.id} after clean review ${gammaReviewId}.`,
        });
        await harness.invokeBeadworkTool("beadwork_close_issue", {
          id: gamma.id,
          reason: "Accepted after independent review.",
        });
        expect((await fixture.show(gamma.id)).status).toBe("closed");
        expect((await fixture.show(epicId)).status).not.toBe("closed");
        expect((await sessionState(harness)).mode).toBe("run");

        const taskTypes = harness.launchedTaskTypes();
        expect(taskTypes.filter((taskType) => taskType === "implementation")).toHaveLength(3);
        expect(taskTypes.filter((taskType) => taskType === "reviewImplementation")).toHaveLength(4);
        expect(taskTypes.filter((taskType) => taskType === "fix")).toHaveLength(1);
        expect(taskTypes.filter((taskType) => taskType === "reviewScope")).toEqual([]);
        expect(harness.launchedTaskTypes()).not.toContain("reviewScope");

        harness.beadwork.sentUserMessages.length = 0;
        harness.beadwork.sentMessages.length = 0;
        await harness.invokeBeadworkTool("beadwork_close_issue", {
          id: epicId,
          reason: "Ticket-policy dispositions complete.",
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
        expect(harness.groups.getOpenGroup()?.groupId).toBe(groupId);

        await harness.halt("group");
        expect(harness.groups.getOpenGroup()).toBeUndefined();
        await harness.assertNoTmuxOrWorktree();
        await harness.logStep("epic-closed-halt-forgets-group", {
          ticketId: alpha.id,
          issueStatus: "closed",
          issueIds: tickets,
          childIds: [childA, childB, childG],
        });
      },
    );
  }, 60_000);
});
