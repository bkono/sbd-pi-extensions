import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentConfig, discoverAgents } from "../../../../pi-minions/src/agents.js";
import {
  PARENT_RECIPIENT_ID,
  SEND_MINION_PEER_TOOL,
} from "../../../../pi-minions/src/orchestration/index.js";
import {
  PACKET_CONTENT_BYTE_BUDGET,
  PACKET_DETAILS_BYTE_BUDGET,
} from "../../../../pi-minions/src/orchestration/packets.js";
import { DEFAULT_CONFIG } from "../../constants.js";
import { loadSessionState, resolveSessionStateDir } from "../../session-state.js";
import type { BeadworkIssue, SessionState } from "../../types.js";
import {
  createInProcessHarness,
  type InProcessHarness,
  withInProcessHarness,
} from "../helpers/in-process-orchestration.js";

const IMPLEMENTER_OUTPUT = "Implemented the ticket, ran quality gates, and committed atomically.";
const REVIEW_OUTPUT = "Independent review passed after inspecting the named commit.";

function domainFor(epicId: string, ticket: BeadworkIssue) {
  return {
    source: "beadwork" as const,
    scopeId: epicId,
    workItemId: ticket.id,
    title: ticket.title,
  };
}

function goalSemantics(state: SessionState) {
  return {
    mode: state.mode,
    scope: state.scope,
    scopeIds: state.goal?.scopeIds,
    reviewPolicy: state.goal?.reviewPolicy,
  };
}

async function persistedState(harness: InProcessHarness): Promise<SessionState> {
  return loadSessionState(
    resolveSessionStateDir(harness.fixture.cwd, DEFAULT_CONFIG.storage.sessionStateDir),
    harness.ctx.sessionManager.getSessionId(),
  );
}

async function commitAsChild(
  harness: InProcessHarness,
  childId: string,
  relativePath: string,
  source: string,
  issueId: string,
): Promise<string> {
  const path = join(harness.fixture.cwd, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, source, "utf8");
  await harness.fixture.exec("git", ["add", relativePath]);
  await harness.fixture.exec("git", ["commit", "-q", "-m", `feat: ${issueId} child ${childId}`]);
  const { stdout } = await harness.fixture.exec("git", ["rev-parse", "HEAD"]);
  return stdout.trim();
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function agentByName(agents: AgentConfig[], name: string): AgentConfig {
  const agent = agents.find((candidate) => candidate.name === name);
  if (!agent) throw new Error(`missing discovered agent ${name}`);
  return agent;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent-friendly orchestration vertical slice", () => {
  it("runs explicit goal entry through implementation, mail, review, idle adjudication, and parent acceptance", async () => {
    await withInProcessHarness(
      {
        parentBusy: true,
        deferChildStart: true,
        fixtureOptions: {
          prefix: "agent-friendly",
          reviewPolicy: "ticket",
          epicTitle: "Agent-friendly acceptance epic",
          tickets: [
            { title: "Implement alpha", description: "First independent implementation slice." },
            { title: "Implement beta", description: "Second independent implementation slice." },
          ],
        },
      },
      async (harness) => {
        const { fixture } = harness;
        const [alpha, beta] = fixture.tickets;
        if (!alpha || !beta) throw new Error("acceptance fixture tickets missing");
        const epicId = fixture.epic.id;

        const bundled = discoverAgents(fixture.cwd, "both").agents;
        expect(agentByName(bundled, "worker").source).toBe("builtin");
        expect(agentByName(bundled, "investigate").source).toBe("builtin");
        await mkdir(join(fixture.cwd, ".pi", "agents"), { recursive: true });
        await writeFile(
          join(fixture.cwd, ".pi", "agents", "worker.md"),
          [
            "---",
            "name: worker",
            "description: Project-owned worker override",
            "thinking: low",
            "---",
            "PROJECT WORKER OVERRIDE: implement only the delegated ticket scope.",
            "",
          ].join("\n"),
          "utf8",
        );
        const overridden = discoverAgents(fixture.cwd, "both").agents;
        expect(agentByName(overridden, "worker")).toMatchObject({
          source: "project",
          description: "Project-owned worker override",
        });
        expect(agentByName(overridden, "investigate").source).toBe("builtin");
        await harness.logStep("agent-discovery-builtin-and-project-override", {
          goalEntrySource: "none",
          issueIds: [alpha.id, beta.id],
        });

        const commandHarness = await createInProcessHarness({
          fixture,
          sessionId: "agent-friendly-command-parity",
          parentBusy: true,
        });
        let commandState: SessionState;
        let commandPrompt: string | undefined;
        try {
          await commandHarness.bwRun(epicId);
          commandState = await persistedState(commandHarness);
          commandPrompt = commandHarness.injectedPrompt();
          expect(commandHarness.beadwork.sentUserMessages).toHaveLength(1);
          expect(commandHarness.beadwork.sentUserMessages[0]?.options).toEqual({
            deliverAs: "followUp",
          });
        } finally {
          await commandHarness.dispose();
        }

        const started = (await harness.invokeBeadworkTool("beadwork_start_goal", {
          epic_id: epicId,
        })) as {
          details: {
            state: string;
            continuation: string;
            epic_id: string;
            review_policy: string;
          };
        };
        expect(started.details).toMatchObject({
          state: "started",
          continuation: "queued_follow_up",
          epic_id: epicId,
          review_policy: "ticket",
        });
        expect(harness.beadwork.sentUserMessages).toHaveLength(1);
        expect(harness.beadwork.sentUserMessages[0]?.options).toEqual({
          deliverAs: "followUp",
        });
        const toolState = await persistedState(harness);
        expect(goalSemantics(toolState)).toEqual(goalSemantics(commandState));
        expect(harness.injectedPrompt()).toBe(commandPrompt);
        expect(harness.groups.getOpenGroup()).toBeUndefined();
        expect(harness.tree.getRoots()).toEqual([]);
        expect((await fixture.show(alpha.id)).status).toBe("open");
        expect((await fixture.show(beta.id)).status).toBe("open");
        await harness.logStep("explicit-tool-goal-entry-parity", {
          goalEntrySource: "tool",
          issueIds: [alpha.id, beta.id],
        });

        const appendix = await harness.beadwork.dispatch<{ systemPrompt?: string }>(
          "before_agent_start",
          { systemPrompt: "base" },
          harness.ctx,
        );
        const standing = appendix?.systemPrompt ?? "";
        expect(standing).toContain("This is a manager-only loop.");
        expect(standing).toContain(
          "The parent does not implement a delegated ticket concurrently with its live child.",
        );
        expect(standing).toContain(
          "Do not start review of ticket A while A's implementer is still live.",
        );
        expect(standing).toContain("return the commit SHA");

        await harness.invokeBeadworkTool("beadwork_start_issue", { id: alpha.id });
        await harness.invokeBeadworkTool("beadwork_start_issue", { id: beta.id });
        const launched = await harness.orchestrate({
          tasks: [
            {
              task: `Implement ${alpha.id}. Commit only owned files and return the exact commit SHA.`,
              description: "Implement alpha acceptance slice",
              agent: "worker",
              taskType: "implementation",
              domain: domainFor(epicId, alpha),
            },
            {
              task: `Implement ${beta.id}. Commit only owned files and return the exact commit SHA.`,
              description: "Implement beta acceptance slice",
              agent: "worker",
              taskType: "implementation",
              domain: domainFor(epicId, beta),
            },
          ],
        });
        expect(launched.accepted).toHaveLength(2);
        expect(launched.accepted.every((accepted) => accepted.state === "starting")).toBe(true);
        const childA = launched.accepted[0]?.childId;
        const childB = launched.accepted[1]?.childId;
        if (!childA || !childB) throw new Error("implementer registration incomplete");
        expect(harness.tree.get(childA)).toMatchObject({
          status: "pending",
          agentName: "worker",
          taskType: "implementation",
          domain: domainFor(epicId, alpha),
        });
        expect(harness.tree.get(childB)).toMatchObject({
          status: "pending",
          agentName: "worker",
          taskType: "implementation",
          domain: domainFor(epicId, beta),
        });
        expect(harness.fleetSnapshot().join("\n")).toMatch(/pending · starting/);
        await harness.logStep("implementers-registered", {
          childId: childA,
          childIds: [childA, childB],
          groupId: launched.groupId,
          registrationState: "pending/starting",
          goalEntrySource: "tool",
          issueIds: [alpha.id, beta.id],
        });

        harness.releaseChildStarts();
        const sessionA = await harness.waitForChild(childA);
        const sessionB = await harness.waitForChild(childB);
        await Promise.all([harness.waitUntilRunning(childA), harness.waitUntilRunning(childB)]);
        expect(harness.tree.get(childA)?.status).toBe("running");
        expect(harness.tree.get(childB)?.status).toBe("running");
        expect(harness.parentToolInvocations).not.toContain("edit");
        expect(harness.parentToolInvocations).not.toContain("write");
        await harness.logStep("implementers-live-manager-only", {
          childId: childA,
          childIds: [childA, childB],
          groupId: launched.groupId,
          registrationState: "running",
          issueIds: [alpha.id, beta.id],
        });

        sessionA.emit({
          type: "tool_execution_start",
          toolName: "read",
          args: { path: "src/alpha.ts" },
        });
        sessionA.emit({ type: "turn_end" });
        sessionB.emit({
          type: "tool_execution_start",
          toolName: "bash",
          args: { command: "npm test -- beta" },
        });
        const toolFleet = harness.fleetSnapshot().join("\n");
        expect(toolFleet).toContain("read src/alpha.ts");
        expect(toolFleet).toContain("npm test -- beta");
        expect(toolFleet).not.toMatch(/turn \d+/i);
        expect(harness.tree.get(childA)?.activity?.phase).toBe("tool");
        await harness.logStep("fleet-tool-activity", {
          childId: childA,
          childIds: [childA, childB],
          groupId: launched.groupId,
          activityPhase: "tool",
          issueIds: [alpha.id, beta.id],
        });

        const alphaCommit = await commitAsChild(
          harness,
          childA,
          "src/alpha.ts",
          "export const alpha = 'accepted';\n",
          alpha.id,
        );
        const betaCommit = await commitAsChild(
          harness,
          childB,
          "src/beta.ts",
          "export const beta = 'accepted';\n",
          beta.id,
        );

        const asked = (await harness.invokeChildTool(childA, SEND_MINION_PEER_TOOL, {
          to: PARENT_RECIPIENT_ID,
          body: "Should alpha preserve the legacy error code?",
        })) as { details?: { status?: string } };
        expect(asked.details?.status).toBe("queued");
        expect(harness.tree.get(childA)?.status).toBe("running");
        expect(harness.tree.get(childA)?.activity?.phase).toBe("waiting");
        expect(harness.fleetSnapshot().join("\n")).toContain("waiting on parent");
        await harness.logStep("child-question-waiting", {
          childId: childA,
          groupId: launched.groupId,
          activityPhase: "waiting",
          issueIds: [alpha.id, beta.id],
        });

        sessionA.pauseFollowUps();
        const answer = await harness.sendMinionMessage(
          childA,
          "Preserve it and document the compatibility boundary.",
        );
        expect(answer.status).toBe("queued");
        await waitFor(
          () => sessionA.followUpCalls === 1,
          "parent answer was not accepted for delivery",
        );
        sessionA.beginSettling(`${IMPLEMENTER_OUTPUT} commit ${alphaCommit}`);
        sessionA.completeSettlement();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(harness.manager.getTerminal(childA)).toBeUndefined();
        expect(harness.tree.get(childA)?.activity?.phase).toBe("waiting");
        sessionA.resumeFollowUps();
        await waitFor(
          () => harness.manager.getTerminal(childA)?.class === "settled",
          "alpha did not settle after accepted parent mail drained",
        );
        expect(sessionA.followUps[0]).toMatch(
          /^\[minion-mail deliveryId=[^ ]+ from parent\]\nPreserve it and document the compatibility boundary\.$/,
        );
        await harness.logStep("parent-mail-drained-before-settlement", {
          childId: childA,
          groupId: launched.groupId,
          terminalState: "settled",
          issueIds: [alpha.id, beta.id],
        });

        sessionB.beginSettling(`${IMPLEMENTER_OUTPUT} commit ${betaCommit}`);
        expect(harness.tree.get(childB)?.activity?.phase).toBe("settling");
        expect(harness.fleetSnapshot().join("\n")).toContain("settling");
        await harness.logStep("fleet-settling-activity", {
          childId: childB,
          groupId: launched.groupId,
          activityPhase: "settling",
          issueIds: [alpha.id, beta.id],
        });
        sessionB.completeSettlement();
        await waitFor(
          () => harness.manager.getTerminal(childB)?.class === "settled",
          "beta implementer did not settle",
        );
        expect((await fixture.show(alpha.id)).status).toBe("in_progress");
        expect((await fixture.show(beta.id)).status).toBe("in_progress");

        const reviewTasks = [
          {
            ticket: alpha,
            commit: alphaCommit,
            description: "Review alpha named commit",
          },
          {
            ticket: beta,
            commit: betaCommit,
            description: "Review beta named commit",
          },
        ];
        const reviews = await harness.orchestrate({
          tasks: reviewTasks.map(({ ticket, commit, description }) => ({
            task: `Review ${ticket.id} only after implementer settlement. Inspect named commit with \`git show ${commit}\`.`,
            description,
            agent: "worker",
            taskType: "reviewImplementation" as const,
            domain: domainFor(epicId, ticket),
          })),
        });
        expect(reviews.accepted).toHaveLength(2);
        const reviewerA = reviews.accepted[0]?.childId;
        const reviewerB = reviews.accepted[1]?.childId;
        if (!reviewerA || !reviewerB) throw new Error("reviewer registration incomplete");
        expect(harness.manager.getTerminal(childA)?.class).toBe("settled");
        expect(harness.manager.getTerminal(childB)?.class).toBe("settled");
        expect(harness.tree.get(reviewerA)?.task).toContain(`git show ${alphaCommit}`);
        expect(harness.tree.get(reviewerB)?.task).toContain(`git show ${betaCommit}`);
        await Promise.all([
          harness.waitUntilRunning(reviewerA),
          harness.waitUntilRunning(reviewerB),
        ]);
        await harness.logStep("reviewers-started-after-named-sha-handoffs", {
          childId: reviewerA,
          childIds: [reviewerA, reviewerB],
          groupId: launched.groupId,
          issueIds: [alpha.id, beta.id],
        });

        const beforeFinalSettlements = harness.packets.length;
        await harness.settleChildren([
          { childId: reviewerA, prose: `${REVIEW_OUTPUT} ${alphaCommit}` },
          { childId: reviewerB, prose: `${REVIEW_OUTPUT} ${betaCommit}` },
        ]);
        await harness.waitForPackets(beforeFinalSettlements + 1);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const finalPackets = harness.packets.slice(beforeFinalSettlements);
        expect(finalPackets).toHaveLength(1);
        const finalPacket = finalPackets[0];
        expect(finalPacket?.message.details.changed).toHaveLength(2);
        expect(finalPacket?.message.details.groupIdleId).toBe(launched.groupId);
        expect(finalPacket?.message.details.stillRunning).toEqual([]);
        expect(finalPacket?.message.content).toMatch(/group idle:/i);
        expect(finalPacket?.message.content).toMatch(
          /inspect the evidence and decide the next action/i,
        );
        expect(finalPacket?.message.content).not.toMatch(/goal (completed|succeeded)/i);
        expect(finalPacket?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
        expect(Buffer.byteLength(finalPacket?.message.content ?? "", "utf8")).toBeLessThanOrEqual(
          PACKET_CONTENT_BYTE_BUDGET,
        );
        expect(
          Buffer.byteLength(JSON.stringify(finalPacket?.message.details ?? {}), "utf8"),
        ).toBeLessThanOrEqual(PACKET_DETAILS_BYTE_BUDGET);
        expect((await fixture.show(alpha.id)).status).toBe("in_progress");
        expect((await fixture.show(beta.id)).status).toBe("in_progress");
        expect((await fixture.show(epicId)).status).toBe("open");
        expect((await persistedState(harness)).mode).toBe("run");
        await harness.logStep("coalesced-group-idle-awaits-adjudication", {
          childId: reviewerA,
          childIds: [reviewerA, reviewerB],
          groupId: launched.groupId,
          terminalState: "settled,settled",
          packetSeq: finalPacket?.message.details.seq,
          issueIds: [alpha.id, beta.id],
        });

        for (const ticket of [alpha, beta]) {
          await harness.invokeBeadworkTool("beadwork_comment_issue", {
            id: ticket.id,
            text: `Parent adjudication: accepted after independent review of named commit for ${ticket.id}.`,
          });
          await harness.invokeBeadworkTool("beadwork_close_issue", {
            id: ticket.id,
            reason: "Accepted by parent after independent review.",
          });
        }
        await harness.invokeBeadworkTool("beadwork_close_issue", {
          id: epicId,
          reason: "All reviewed ticket outcomes accepted by parent.",
        });
        expect((await fixture.show(epicId)).status).toBe("closed");
        expect((await persistedState(harness)).mode).not.toBe("run");
        await harness.halt("group");
        await harness.logStep("parent-adjudicated-and-mutated-beadwork", {
          issueStatus: "closed",
          issueIds: [alpha.id, beta.id],
          groupId: launched.groupId,
        });
      },
    );
  }, 60_000);

  it("rejects an entire registration without committing an empty group", async () => {
    await withInProcessHarness({ fixtureOptions: { prefix: "af-reject" } }, async (harness) => {
      let rejection: Error | undefined;
      try {
        await harness.orchestrate({
          tasks: [
            {
              task: "This must not start.",
              description: "Unknown agent rejection",
              agent: "not-a-discovered-agent",
            },
          ],
        });
      } catch (error) {
        rejection = error instanceof Error ? error : new Error(String(error));
      }
      expect(rejection?.message).toContain("Orchestration rejected: 0 starting, 1 rejected.");
      expect(rejection?.message).toContain('Unknown agent "not-a-discovered-agent"');
      expect(rejection?.message).toContain("list_agents");
      expect(rejection?.message).not.toMatch(/\bcompleted\b/i);
      expect(harness.groups.getOpenGroup()).toBeUndefined();
      expect(harness.tree.getRoots()).toEqual([]);
      await harness.logStep("all-rejected-no-empty-group", {
        goalEntrySource: "none",
        registrationState: "rejected",
      });
    });
  });

  it("turns a detached boot failure into failed state and a lifecycle packet", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await withInProcessHarness(
        {
          fixtureOptions: { prefix: "af-boot-fail" },
          failChildStart: (input) =>
            input.name.length > 0 ? "scripted child runtime boot failed" : undefined,
        },
        async (harness) => {
          const result = await harness.orchestrate({
            tasks: [
              {
                task: "Register, then fail while starting.",
                description: "Boot failure after registration",
                agent: "worker",
                taskType: "implementation",
              },
            ],
          });
          const childId = result.accepted[0]?.childId;
          if (!childId) throw new Error("boot-failure child was not registered");
          expect(result.accepted[0]?.state).toBe("starting");
          await waitFor(
            () => harness.tree.get(childId)?.status === "failed",
            "boot failure did not become failed",
          );
          await harness.waitForPackets(1);
          expect(harness.lastPacket()?.message.details.changed[0]).toMatchObject({
            childId,
            eventClass: "failed",
            error: "scripted child runtime boot failed",
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(unhandled).toEqual([]);
          await harness.logStep("registered-start-failure-is-contained", {
            childId,
            groupId: result.groupId,
            registrationState: "starting",
            terminalState: "failed",
          });
        },
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps canonical foreground spawn blocking and outside orchestration packets", async () => {
    await withInProcessHarness({ fixtureOptions: { prefix: "af-spawn" } }, async (harness) => {
      const discovered = discoverAgents(harness.fixture.cwd, "both").agents;
      expect(agentByName(discovered, "worker")).toMatchObject({
        source: "builtin",
        thinking: "medium",
      });
      let resolved = false;
      const spawnPromise = harness
        .spawn({ task: "Perform one blocking foreground task.", agent: "worker" })
        .then((result) => {
          resolved = true;
          return result;
        });
      await waitFor(
        () => harness.tree.getRoots().some((node) => node.kind === "spawn"),
        "foreground spawn did not register",
      );
      const node = harness.tree.getRoots().find((candidate) => candidate.kind === "spawn");
      if (!node) throw new Error("foreground spawn node missing");
      const session = await harness.waitForChild(node.id);
      expect(resolved).toBe(false);
      expect(node).toMatchObject({ kind: "spawn", agentName: "worker", groupId: undefined });
      expect(session.getActiveToolNames()).not.toContain(SEND_MINION_PEER_TOOL);
      expect(harness.groups.getOpenGroup()).toBeUndefined();
      expect(harness.packets).toEqual([]);
      session.finishWithProse("Foreground work complete.");
      const result = await spawnPromise;
      expect(result.details).toMatchObject({ agentName: "worker", status: "completed" });
      expect(harness.packets).toEqual([]);
      await harness.logStep("foreground-spawn-blocking-and-excluded", {
        childId: node.id,
        registrationState: "running",
        terminalState: "settled",
        goalEntrySource: "none",
      });
    });
  });

  it("keeps planning and decomposition separate from explicit goal entry", async () => {
    await withInProcessHarness({ fixtureOptions: { prefix: "af-planning" } }, async (harness) => {
      const created = (await harness.invokeBeadworkTool("beadwork_create_issue", {
        title: "Newly decomposed planning child",
        description: "Planning output only; do not execute it automatically.",
        type: "task",
        parent_id: harness.fixture.epic.id,
      })) as { details?: { id?: string } };
      await harness.beadwork.invokeCommand("bw", `engage ${harness.fixture.epic.id}`, harness.ctx);
      expect(created.details?.id).toBeTruthy();
      const prompt = await harness.beadwork.dispatch<{ systemPrompt?: string }>(
        "before_agent_start",
        { systemPrompt: "planning" },
        harness.ctx,
      );
      expect(prompt?.systemPrompt).toContain(
        "Do not auto-start goal mode merely because an epic exists, becomes ready, or was just created.",
      );
      const state = await persistedState(harness);
      expect(state.mode).not.toBe("run");
      expect(state.goal).toBeUndefined();
      expect(harness.beadwork.sentMessages).toEqual([]);
      expect(harness.groups.getOpenGroup()).toBeUndefined();
      expect(harness.tree.getRoots()).toEqual([]);
      expect(harness.parentToolInvocations).not.toContain("beadwork_start_goal");
      await harness.logStep("planning-does-not-auto-enter-goal", {
        goalEntrySource: "none",
        issueIds: created.details?.id ? [created.details.id] : [],
      });
    });
  });
});
