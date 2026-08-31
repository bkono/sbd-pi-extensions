import { describe, expect, it } from "vitest";
import {
  BEADWORK_CHILD_INSPECTION_TOOLS,
  DENIED_CHILD_BEADWORK_TOOLS,
  LIFECYCLE_PACKET_CUSTOM_TYPE,
  PARENT_ONLY_MINION_TOOLS,
  withInProcessHarness,
} from "../helpers/in-process-orchestration.js";

const TICKET_TITLE = "Implement one in-process ticket";
const CHILD_PROSE = "Implemented the ticket as unstructured prose. Changed README.md. No schema.";

describe("in-process ticket from /bw run through child settlement", () => {
  it("proves one ticket without tmux, worktree, or automatic close", async () => {
    await withInProcessHarness(
      {
        fixtureOptions: {
          prefix: "e2e",
          reviewPolicy: "ticket",
          epicTitle: "In-process epic",
          tickets: [
            {
              title: TICKET_TITLE,
              description: "Ready work that must not be frozen into the inject prompt.",
            },
          ],
        },
      },
      async (harness) => {
        const { fixture } = harness;
        const epicId = fixture.epic.id;
        const ticket = fixture.tickets[0];
        if (!ticket) {
          throw new Error("fixture ticket missing");
        }

        await harness.logStep("fixture-ready", { ticketId: ticket.id });
        await harness.assertNoTmuxOrWorktree();

        for (const hostMode of ["print", "json"] as const) {
          const { ui } = await harness.bwRun(epicId, hostMode);
          expect(ui.notifications.at(-1)?.level).toBe("error");
          expect(ui.notifications.at(-1)?.message).toMatch(/print and json/);
        }
        expect(harness.injectedPrompt()).toBeUndefined();
        await harness.logStep("print-json-rejected", { ticketId: ticket.id });

        await harness.bwRun(epicId);
        const prompt = harness.injectedPrompt();
        expect(prompt).toBeTruthy();
        expect(prompt).toContain(epicId);
        expect(prompt).toContain("In-process epic");
        expect(prompt).toContain("Review policy: ticket");
        expect(prompt).toMatch(/Refresh `bw` \(ready\/show\)/);
        expect(prompt).toMatch(/orchestrate/);
        expect(prompt).toContain('source "beadwork"');
        expect(prompt).toContain("Do not treat this prompt as a frozen ready list.");
        expect(prompt).not.toContain(TICKET_TITLE);
        expect(prompt).not.toContain(ticket.id);
        await harness.logStep("bw-run-injected", { ticketId: ticket.id });

        const orchestrateStarted = Date.now();
        const result = await harness.orchestrate({
          tasks: [
            {
              task: `Implement ${ticket.id} (${TICKET_TITLE}). Output unstructured prose only.`,
              description: "Implement in-process ticket",
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
        const orchestrateMs = Date.now() - orchestrateStarted;

        expect(result.accepted).toHaveLength(1);
        expect(result.rejected).toEqual([]);
        expect(result.accepted[0]?.state).toBe("starting");
        expect(result.groupId).toMatch(/^grp-/);
        const childId = result.accepted[0]?.childId;
        if (!childId) {
          throw new Error("orchestrate did not accept a child");
        }
        expect(harness.manager.getTerminal(childId)).toBeUndefined();
        expect(orchestrateMs).toBeLessThan(1_000);
        await harness.logStep("orchestrate-returned-starting", {
          ticketId: ticket.id,
          childId,
          groupId: result.groupId,
        });

        const session = await harness.waitForChild(childId);
        expect(session.promptCalls).toBe(1);

        const parentContinued = await harness.listMinions();
        expect(parentContinued.minions).toHaveLength(1);
        const listed = parentContinued.minions[0];
        expect(listed?.kind).toBe("orchestrated");
        expect(listed?.description).toBe("Implement in-process ticket");
        expect(listed?.taskType).toBe("implementation");
        expect(listed?.groupId).toBe(result.groupId);
        expect(listed?.domain).toEqual({
          source: "beadwork",
          scopeId: epicId,
          workItemId: ticket.id,
          title: ticket.title,
        });
        expect(listed?.status).toBe("running");
        expect(parentContinued.text).toContain("orchestrated");
        expect(parentContinued.text).toContain("implementation");

        const show = await fixture.show(ticket.id);
        expect(show.status).toBe("open");
        await harness.assertNoTmuxOrWorktree();
        await harness.logStep("parent-unblocked-while-child-runs", {
          ticketId: ticket.id,
          childId,
          groupId: result.groupId,
          issueStatus: show.status,
        });

        const node = harness.tree.get(childId);
        expect(node?.domain).toEqual({
          source: "beadwork",
          scopeId: epicId,
          workItemId: ticket.id,
          title: ticket.title,
        });
        expect(node?.description).toBe("Implement in-process ticket");
        expect(node?.taskType).toBe("implementation");

        const active = harness.childActiveTools(childId);
        for (const name of BEADWORK_CHILD_INSPECTION_TOOLS) {
          expect(active).toContain(name);
        }
        for (const name of DENIED_CHILD_BEADWORK_TOOLS) {
          expect(active).not.toContain(name);
        }
        for (const name of PARENT_ONLY_MINION_TOOLS) {
          expect(active).not.toContain(name);
        }
        await harness.logStep("child-tools-allowlist", {
          ticketId: ticket.id,
          childId,
          groupId: result.groupId,
        });

        await harness.settleChild(childId, CHILD_PROSE);
        await harness.waitForPackets(1);
        const packet = harness.lastPacket();
        expect(packet).toBeTruthy();
        expect(packet?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
        expect(packet?.message.customType).toBe(LIFECYCLE_PACKET_CUSTOM_TYPE);
        expect(packet?.message.details.changed).toHaveLength(1);
        expect(packet?.message.details.changed[0]?.childId).toBe(childId);
        expect(packet?.message.details.changed[0]?.eventClass).toBe("settled");
        expect(packet?.message.details.changed[0]?.output).toContain("unstructured prose");
        expect(packet?.message.details.changed[0]?.nudge).toMatch(
          /do not close a ticket solely because the child settled/i,
        );
        expect(packet?.message.details.stillRunning).toEqual([]);
        expect(packet?.message.content).toContain("Changed:");
        expect(packet?.message.content).toContain("Still running:");
        expect(packet?.message.content).toMatch(/--- runtime instruction ---/);
        expect(packet?.message.content).toMatch(/--- untrusted child output ---/);
        expect(packet?.message.content).toContain(CHILD_PROSE);

        const after = await fixture.show(ticket.id);
        expect(after.status).toBe("open");
        expect(after.status).not.toBe("closed");
        await harness.assertNoTmuxOrWorktree();
        await harness.logStep("settled-without-close", {
          ticketId: ticket.id,
          childId,
          groupId: result.groupId,
          issueStatus: after.status,
          packetCount: harness.packets.length,
        });
      },
    );
  }, 20_000);
});
