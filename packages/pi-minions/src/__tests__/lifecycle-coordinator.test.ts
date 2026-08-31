import { describe, expect, it, vi } from "vitest";
import { PathOverlapLog } from "../coordination/index.js";
import {
  createLifecyclePacketDispatcher,
  MinionCommMailbox,
  OrchestrationGroupState,
  OrchestrationLifecycleCoordinator,
  PARENT_RECIPIENT_ID,
} from "../orchestration/index.js";
import { AgentTree } from "../tree.js";

function fixture(failSubmit = true) {
  const tree = new AgentTree();
  const groups = new OrchestrationGroupState();
  const overlaps = new PathOverlapLog();
  const scheduled: Array<() => void> = [];
  let coordinator!: OrchestrationLifecycleCoordinator;
  const sendMessage = vi.fn(() => {
    if (failSubmit) throw new Error("submit failed");
  });
  const mailbox = new MinionCommMailbox({
    getTree: () => tree,
    getGroups: () => groups,
    isLive: (id) => tree.get(id)?.status === "running",
    followUp: () => {},
  });
  const packets = createLifecyclePacketDispatcher({
    getTree: () => tree,
    getGroups: () => groups,
    sendMessage: sendMessage as never,
    schedule: (run) => scheduled.push(run),
    peekOverlaps: (groupIds) => overlaps.peek(groupIds),
    ackOverlaps: (ids) => overlaps.ack(ids),
    peekParentMail: (authority) => {
      const messages = mailbox
        .peekPending(PARENT_RECIPIENT_ID, authority.childId)
        .filter(
          (message) =>
            message.groupId === authority.groupId &&
            message.lifecycleId === authority.lifecycleId &&
            message.lifecycleEpoch === authority.epoch,
        );
      return messages.length
        ? {
            ids: messages.map((message) => message.id),
            text: messages.map((m) => m.body).join("\n"),
          }
        : undefined;
    },
    ackParentMail: (snapshot) => mailbox.ackPending(PARENT_RECIPIENT_ID, snapshot.ids),
    onAcceptedTerminal: (authority) => coordinator.cleanupAcceptedLifecycle(authority),
  });
  coordinator = new OrchestrationLifecycleCoordinator({
    tree,
    groups,
    mailbox,
    overlaps,
    packets,
  });
  return { tree, groups, mailbox, overlaps, packets, coordinator, scheduled, sendMessage };
}

describe("explicit cancellation cleanup", () => {
  it("discards 17 failed groups without leaking evidence and lets a new group submit", () => {
    const f = fixture(true);
    for (let index = 0; index < 17; index++) {
      const groupId = `grp-${index.toString(16).padStart(8, "0")}`;
      const childId = `child-${index}`;
      const lifecycleId = `life-${index}`;
      f.groups.commitGroup({ groupId, cwd: "/tmp" });
      const epoch = f.groups.acceptLiveWork(groupId, [{ childId, lifecycleId }])!;
      f.tree.add(childId, childId, "work", {
        kind: "orchestrated",
        groupId,
        lifecycleId,
        lifecycleEpoch: epoch,
      });
      f.tree.updateInspection(childId, {
        pathIntent: [{ path: `/tmp/${index}`, expiresAt: Date.now() + 1000 }],
      });
      expect(
        f.mailbox.send({
          from: childId,
          to: PARENT_RECIPIENT_ID,
          groupId,
          body: "pending",
          lifecycleId,
          lifecycleEpoch: epoch,
        }).status,
      ).toBe("queued");
      f.overlaps.record({
        groupId,
        childId,
        lifecycleId,
        epoch,
        path: `/tmp/${index}`,
        otherId: "peer",
        otherPath: "/tmp",
      });
      f.tree.updateStatus(childId, "failed", 1, "boom");
      f.packets.enqueue({
        class: "failed",
        groupId,
        childId,
        lifecycleId,
        epoch,
        error: "boom",
      });
      f.scheduled.shift()?.();
      expect(f.packets.inspectionCounts().queued).toBeGreaterThan(0);

      f.coordinator.discardGroup(groupId);
      f.coordinator.discardGroup(groupId);
      expect(f.packets.inspectionCounts()).toEqual({ queued: 0, deliveredHistory: 0 });
      expect(f.mailbox.inspectionCounts()).toEqual({ history: 0, pending: 0 });
      expect(f.overlaps.list()).toEqual([]);
      expect(f.tree.get(childId)?.pathIntent).toEqual([]);
      expect(f.groups.getOpenGroup()).toBeUndefined();
    }

    const groupId = "grp-ffffffff";
    const childId = "child-new";
    const lifecycleId = "life-new";
    f.groups.commitGroup({ groupId, cwd: "/tmp" });
    const epoch = f.groups.acceptLiveWork(groupId, [{ childId, lifecycleId }])!;
    f.tree.add(childId, childId, "new", {
      kind: "orchestrated",
      groupId,
      lifecycleId,
      lifecycleEpoch: epoch,
    });
    f.tree.updateStatus(childId, "completed", 0);
    f.packets.enqueue({ class: "settled", groupId, childId, lifecycleId, epoch });
    f.sendMessage.mockImplementation(() => undefined);
    f.scheduled.shift()?.();
    expect(f.sendMessage).toHaveBeenCalled();
  });

  it("keeps other-group evidence and treats accepted delivery separately from discard", () => {
    const f = fixture(false);
    const groupId = "grp-aaaaaaaa";
    const childId = "child-a";
    const lifecycleId = "life-a";
    f.groups.commitGroup({ groupId, cwd: "/tmp" });
    const epoch = f.groups.acceptLiveWork(groupId, [{ childId, lifecycleId }])!;
    f.tree.add(childId, childId, "a", {
      kind: "orchestrated",
      groupId,
      lifecycleId,
      lifecycleEpoch: epoch,
    });
    f.overlaps.record({
      groupId: "grp-bbbbbbbb",
      childId: "child-b",
      lifecycleId: "life-b",
      epoch: 1,
      path: "/b",
      otherId: "peer",
      otherPath: "/",
    });
    f.tree.updateStatus(childId, "completed", 0);
    f.packets.enqueue({ class: "settled", groupId, childId, lifecycleId, epoch });
    f.scheduled.shift()?.();
    expect(f.packets.inspectionCounts().deliveredHistory).toBe(1);
    expect(f.groups.getLifecycleRegistration(lifecycleId, groupId, epoch)).toBeUndefined();

    f.coordinator.discardGroup(groupId);
    expect(f.packets.inspectionCounts()).toEqual({ queued: 0, deliveredHistory: 0 });
    expect(f.overlaps.list().map((notice) => notice.groupId)).toEqual(["grp-bbbbbbbb"]);
  });
});
