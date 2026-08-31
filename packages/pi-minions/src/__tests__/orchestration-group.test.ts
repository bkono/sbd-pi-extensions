import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import {
  GROUP_REJECT_REASONS,
  isResolveGroupReject,
  OrchestrationGroupState,
  type ResolveGroupResult,
} from "../orchestration/index.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function logResult(label: string, result: ResolveGroupResult): void {
  if (isResolveGroupReject(result)) {
    console.log(label, { groupId: undefined, cwd: undefined, reject: result.reject });
    return;
  }
  console.log(label, { groupId: result.groupId, cwd: result.cwd, reject: undefined });
}

describe("OrchestrationGroupState create and join", () => {
  it("creates a group from parent cwd when groupId is omitted and none is open", () => {
    const parentCwd = tempDir("pi-minions-group-parent-");
    const groups = new OrchestrationGroupState();

    const created = groups.resolveGroup({ parentCwd });
    logResult("create-omit-groupId", created);

    expect(isResolveGroupReject(created)).toBe(false);
    if (isResolveGroupReject(created)) return;
    expect(created.groupId).toMatch(/^grp-[a-f0-9]{8}$/);
    expect(created.cwd).toBe(realpathSync(parentCwd));
    expect(groups.getOpenGroup()).toEqual(created);
  });

  it("joins the one open group when groupId is omitted", () => {
    const parentCwd = tempDir("pi-minions-group-join-");
    const groups = new OrchestrationGroupState();
    const created = groups.resolveGroup({ parentCwd });
    expect(isResolveGroupReject(created)).toBe(false);
    if (isResolveGroupReject(created)) return;

    const joined = groups.resolveGroup({ parentCwd });
    logResult("join-omit-groupId", joined);

    expect(joined).toEqual(created);
    expect(groups.getOpenGroup()).toEqual(created);
  });

  it("joins when the provided groupId matches the open group", () => {
    const parentCwd = tempDir("pi-minions-group-match-");
    const groups = new OrchestrationGroupState();
    const created = groups.resolveGroup({ parentCwd });
    expect(isResolveGroupReject(created)).toBe(false);
    if (isResolveGroupReject(created)) return;

    const joined = groups.resolveGroup({ groupId: created.groupId, parentCwd });
    logResult("join-matching-groupId", joined);

    expect(joined).toEqual(created);
  });

  it("uses provided existing cwd on create, not parent cwd", () => {
    const parentCwd = tempDir("pi-minions-group-parentcwd-");
    const cwd = tempDir("pi-minions-group-explicit-cwd-");
    const groups = new OrchestrationGroupState();

    const created = groups.resolveGroup({ cwd, parentCwd });
    logResult("create-explicit-cwd", created);

    expect(isResolveGroupReject(created)).toBe(false);
    if (isResolveGroupReject(created)) return;
    expect(created.cwd).toBe(realpathSync(cwd));
    expect(created.cwd).not.toBe(realpathSync(parentCwd));
  });
});

describe("OrchestrationGroupState rejects", () => {
  it("rejects a second concurrent open group", () => {
    const parentCwd = tempDir("pi-minions-group-second-");
    const groups = new OrchestrationGroupState();
    const created = groups.resolveGroup({ parentCwd });
    expect(isResolveGroupReject(created)).toBe(false);
    if (isResolveGroupReject(created)) return;

    const rejected = groups.resolveGroup({ groupId: "grp-other", parentCwd });
    logResult("reject-second-group", rejected);

    expect(rejected).toEqual({ reject: GROUP_REJECT_REASONS.secondConcurrentGroup });
    expect(groups.getOpenGroup()).toEqual(created);
  });

  it("rejects an unknown groupId when none is open", () => {
    const parentCwd = tempDir("pi-minions-group-unknown-");
    const groups = new OrchestrationGroupState();

    const rejected = groups.resolveGroup({ groupId: "grp-missing", parentCwd });
    logResult("reject-unknown-groupId", rejected);

    expect(rejected).toEqual({ reject: GROUP_REJECT_REASONS.unknownGroupId });
    expect(groups.getOpenGroup()).toBeUndefined();
  });

  it("rejects when cwd does not exist on create", () => {
    const parentCwd = tempDir("pi-minions-group-parent-ok-");
    const missing = join(parentCwd, "no-such-workspace");
    const groups = new OrchestrationGroupState();

    const rejected = groups.resolveGroup({ cwd: missing, parentCwd });
    logResult("reject-cwd-missing", rejected);

    expect(rejected).toEqual({ reject: GROUP_REJECT_REASONS.cwdMissing });
    expect(groups.getOpenGroup()).toBeUndefined();
  });

  it("rejects when parent cwd does not exist and cwd is omitted", () => {
    const parentCwd = join(tmpdir(), `pi-minions-group-missing-parent-${Date.now()}`);
    const groups = new OrchestrationGroupState();

    const rejected = groups.resolveGroup({ parentCwd });
    logResult("reject-parent-cwd-missing", rejected);

    expect(rejected).toEqual({ reject: GROUP_REJECT_REASONS.cwdMissing });
    expect(groups.getOpenGroup()).toBeUndefined();
  });

  it("rejects later cwd mismatch against the immutable group cwd", () => {
    const parentCwd = tempDir("pi-minions-group-cwd-a-");
    const otherCwd = tempDir("pi-minions-group-cwd-b-");
    const groups = new OrchestrationGroupState();
    const created = groups.resolveGroup({ parentCwd });
    expect(isResolveGroupReject(created)).toBe(false);
    if (isResolveGroupReject(created)) return;

    const rejected = groups.resolveGroup({ cwd: otherCwd, parentCwd });
    logResult("reject-cwd-mismatch", rejected);

    expect(rejected).toEqual({ reject: GROUP_REJECT_REASONS.cwdMismatch });
    expect(groups.getOpenGroup()).toEqual(created);
  });

  it("rejects later cwd that no longer exists", () => {
    const parentCwd = tempDir("pi-minions-group-cwd-later-missing-");
    const groups = new OrchestrationGroupState();
    const created = groups.resolveGroup({ parentCwd });
    expect(isResolveGroupReject(created)).toBe(false);
    if (isResolveGroupReject(created)) return;

    const rejected = groups.resolveGroup({
      cwd: join(parentCwd, "gone"),
      parentCwd,
    });
    logResult("reject-later-cwd-missing", rejected);

    expect(rejected).toEqual({ reject: GROUP_REJECT_REASONS.cwdMissing });
    expect(groups.getOpenGroup()).toEqual(created);
  });
});

describe("OrchestrationGroupState cwd identity", () => {
  it("joins when a later cwd realpath matches the stored cwd", () => {
    const parentCwd = tempDir("pi-minions-group-realpath-");
    const nested = join(parentCwd, "nested");
    mkdirSync(nested);
    const groups = new OrchestrationGroupState();
    const created = groups.resolveGroup({ parentCwd });
    expect(isResolveGroupReject(created)).toBe(false);
    if (isResolveGroupReject(created)) return;

    const viaRelative = groups.resolveGroup({
      cwd: relative(parentCwd, parentCwd) || ".",
      parentCwd,
    });
    logResult("join-relative-cwd", viaRelative);
    expect(viaRelative).toEqual(created);

    const link = join(nested, "parent-link");
    symlinkSync(parentCwd, link);
    const viaSymlink = groups.resolveGroup({ cwd: link, parentCwd });
    logResult("join-symlink-cwd", viaSymlink);
    expect(viaSymlink).toEqual(created);
  });

  it("rejects a file path as cwd missing", () => {
    const parentCwd = tempDir("pi-minions-group-file-cwd-");
    const filePath = join(parentCwd, "not-a-dir");
    writeFileSync(filePath, "nope");
    const groups = new OrchestrationGroupState();

    const rejected = groups.resolveGroup({ cwd: filePath, parentCwd });
    logResult("reject-file-cwd", rejected);

    expect(rejected).toEqual({ reject: GROUP_REJECT_REASONS.cwdMissing });
  });
});

describe("OrchestrationGroupState close/forget", () => {
  it("forgets the open group so the next resolve creates a new groupId", () => {
    const parentCwd = tempDir("pi-minions-group-close-");
    const groups = new OrchestrationGroupState();
    const first = groups.resolveGroup({ parentCwd });
    expect(isResolveGroupReject(first)).toBe(false);
    if (isResolveGroupReject(first)) return;

    groups.closeGroup();
    expect(groups.getOpenGroup()).toBeUndefined();

    const second = groups.resolveGroup({ parentCwd });
    logResult("recreate-after-close", second);

    expect(isResolveGroupReject(second)).toBe(false);
    if (isResolveGroupReject(second)) return;
    expect(second.groupId).not.toBe(first.groupId);
    expect(second.cwd).toBe(first.cwd);
    expect(groups.getOpenGroup()).toEqual(second);
  });

  it("rejects the closed groupId instead of reopening it", () => {
    const parentCwd = tempDir("pi-minions-group-closed-id-");
    const groups = new OrchestrationGroupState();
    const first = groups.resolveGroup({ parentCwd });
    expect(isResolveGroupReject(first)).toBe(false);
    if (isResolveGroupReject(first)) return;

    groups.closeGroup(first.groupId);
    const rejected = groups.resolveGroup({ groupId: first.groupId, parentCwd });
    logResult("reject-closed-groupId", rejected);

    expect(rejected).toEqual({ reject: GROUP_REJECT_REASONS.unknownGroupId });
    expect(groups.getOpenGroup()).toBeUndefined();
  });

  it("does not forget the open group when closeGroup receives a different id", () => {
    const parentCwd = tempDir("pi-minions-group-close-mismatch-");
    const groups = new OrchestrationGroupState();
    const created = groups.resolveGroup({ parentCwd });
    expect(isResolveGroupReject(created)).toBe(false);
    if (isResolveGroupReject(created)) return;

    groups.closeGroup("grp-other");
    expect(groups.getOpenGroup()).toEqual(created);
  });

  it("uses reload-safe full UUID lifecycle identities", async () => {
    const firstModule = await import("../orchestration/events.js");
    const first = firstModule.createLifecycleId();
    vi.resetModules();
    const reloadedModule = await import("../orchestration/events.js");
    const second = reloadedModule.createLifecycleId();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(first).toMatch(uuid);
    expect(second).toMatch(uuid);
    expect(second).not.toBe(first);
  });
});

describe("OrchestrationGroupState idle epochs", () => {
  it("arms only after accepted live work and consumes one active-to-idle transition", () => {
    const groups = new OrchestrationGroupState();
    groups.commitGroup({ groupId: "grp-idle", cwd: "/tmp" });

    expect(groups.peekIdleTransition("grp-idle", false, new Set())).toBeUndefined();
    expect(
      groups.acceptLiveWork("grp-other", [{ childId: "mn-other", lifecycleId: "old" }]),
    ).toBeUndefined();
    expect(
      groups.acceptLiveWork("grp-idle", [{ childId: "mn-idle", lifecycleId: "life-idle" }]),
    ).toBe(1);
    expect(groups.getLifecycleRegistration("life-idle")).toEqual({
      lifecycleId: "life-idle",
      childId: "mn-idle",
      groupId: "grp-idle",
      epoch: 1,
    });
    expect(groups.peekIdleTransition("grp-idle", true, new Set())).toBeUndefined();
    expect(groups.peekIdleTransition("grp-idle", false, new Set([1]))).toBe(1);
    expect(groups.acknowledgeIdleTransition("grp-idle", 1)).toBe(true);
    expect(groups.peekIdleTransition("grp-idle", false, new Set([1]))).toBeUndefined();
  });

  it("re-arms a later epoch in the same open group and clears state on close", () => {
    const groups = new OrchestrationGroupState();
    groups.commitGroup({ groupId: "grp-reuse", cwd: "/tmp" });
    groups.acceptLiveWork("grp-reuse", [{ childId: "mn-1", lifecycleId: "life-1" }]);
    expect(groups.peekIdleTransition("grp-reuse", false, new Set([1]))).toBe(1);
    expect(groups.acknowledgeIdleTransition("grp-reuse", 1)).toBe(true);

    groups.acceptLiveWork("grp-reuse", [{ childId: "mn-2", lifecycleId: "life-2" }]);
    expect(groups.getLifecycleRegistration("life-1")?.epoch).toBe(1);
    expect(groups.getLifecycleRegistration("life-2")?.epoch).toBe(2);
    expect(groups.peekIdleTransition("grp-reuse", false, new Set([1]))).toBeUndefined();
    expect(groups.peekIdleTransition("grp-reuse", false, new Set([2]))).toBe(2);
    expect(groups.acknowledgeIdleTransition("grp-reuse", 2)).toBe(true);

    groups.acceptLiveWork("grp-reuse", [{ childId: "mn-3", lifecycleId: "life-3" }]);
    groups.closeGroup("grp-reuse");
    expect(groups.peekIdleTransition("grp-reuse", false, new Set([3]))).toBeUndefined();
    expect(groups.getLifecycleRegistration("life-3")).toBeUndefined();
  });
});

describe("OrchestrationGroupState preview and commit", () => {
  it("does not open a group until commitGroup", () => {
    const parentCwd = tempDir("pi-minions-group-preview-");
    const groups = new OrchestrationGroupState();

    const previewed = groups.previewGroup({ parentCwd });
    expect(isResolveGroupReject(previewed)).toBe(false);
    if (isResolveGroupReject(previewed)) return;
    expect(previewed.created).toBe(true);
    expect(groups.getOpenGroup()).toBeUndefined();

    groups.commitGroup(previewed);
    expect(groups.getOpenGroup()).toEqual({
      groupId: previewed.groupId,
      cwd: previewed.cwd,
    });
  });

  it("joining an existing group does not require commit", () => {
    const parentCwd = tempDir("pi-minions-group-preview-join-");
    const groups = new OrchestrationGroupState();
    const created = groups.resolveGroup({ parentCwd });
    expect(isResolveGroupReject(created)).toBe(false);
    if (isResolveGroupReject(created)) return;

    const previewed = groups.previewGroup({ parentCwd });
    expect(previewed).toEqual({
      groupId: created.groupId,
      cwd: created.cwd,
      created: false,
    });
    expect(groups.getOpenGroup()).toEqual(created);
  });
});

describe("OrchestrationGroupState logging", () => {
  it("logs groupId, cwd, and reject reason on resolve and close", () => {
    const parentCwd = tempDir("pi-minions-group-log-");
    const otherCwd = tempDir("pi-minions-group-log-other-");
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const groups = new OrchestrationGroupState();

    const created = groups.resolveGroup({ parentCwd });
    expect(isResolveGroupReject(created)).toBe(false);
    if (isResolveGroupReject(created)) return;

    groups.resolveGroup({ groupId: "grp-other", parentCwd });
    groups.resolveGroup({ cwd: otherCwd, parentCwd });
    groups.resolveGroup({ cwd: join(parentCwd, "missing"), parentCwd });
    groups.closeGroup();
    groups.resolveGroup({ groupId: created.groupId, parentCwd });

    expect(info).toHaveBeenCalledWith("orchestration-group", "resolve", {
      groupId: created.groupId,
      cwd: created.cwd,
      reject: undefined,
    });
    expect(info).toHaveBeenCalledWith("orchestration-group", "resolve", {
      groupId: "grp-other",
      cwd: undefined,
      reject: GROUP_REJECT_REASONS.secondConcurrentGroup,
    });
    expect(info).toHaveBeenCalledWith("orchestration-group", "resolve", {
      groupId: undefined,
      cwd: otherCwd,
      reject: GROUP_REJECT_REASONS.cwdMismatch,
    });
    expect(info).toHaveBeenCalledWith("orchestration-group", "resolve", {
      groupId: undefined,
      cwd: join(parentCwd, "missing"),
      reject: GROUP_REJECT_REASONS.cwdMissing,
    });
    expect(info).toHaveBeenCalledWith("orchestration-group", "close", {
      groupId: created.groupId,
      cwd: created.cwd,
      reject: undefined,
    });
    expect(info).toHaveBeenCalledWith("orchestration-group", "resolve", {
      groupId: created.groupId,
      cwd: undefined,
      reject: GROUP_REJECT_REASONS.unknownGroupId,
    });
  });
});
