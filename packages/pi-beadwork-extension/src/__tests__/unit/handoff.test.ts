import { describe, expect, it } from "vitest";
import { buildCurrentBranchHandoffPrompt } from "../../handoff.js";
import type { BeadworkIssueDetail } from "../../types.js";

function issue(overrides: Partial<BeadworkIssueDetail> = {}): BeadworkIssueDetail {
  return {
    id: "BW-123",
    title: "Implement current-branch launch",
    description: "Build the shared-checkout handoff prompt.",
    status: "open",
    type: "task",
    priority: 1,
    labels: [],
    blockedBy: [],
    blocks: [],
    assignee: "",
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    children: [],
    ...overrides,
  };
}

describe("buildCurrentBranchHandoffPrompt", () => {
  it("includes the required current-branch worker instructions and context", () => {
    const prompt = buildCurrentBranchHandoffPrompt({
      ticket: issue({ blockedBy: ["BW-100"] }),
      epic: issue({
        id: "BW-EPIC",
        title: "Current-branch swarm migration",
        description: "Move worker execution to the current branch.",
      }),
      checkoutPath: "/repo/project",
      branchName: "main",
      runtimeScratchDir: "/repo/project/.pi/beadwork/workers/runtime/BW-123/scratch",
    });

    expect(prompt).toContain(
      "You are working ticket `BW-123` in the current checkout/current branch.",
    );
    expect(prompt).toContain("Current checkout: /repo/project");
    expect(prompt).toContain("Current branch: main");
    expect(prompt).toContain(
      "Run `bw start BW-123` before beginning work unless the ticket is already started.",
    );
    expect(prompt).toContain("Do not create a branch, PR, or alternate checkout");
    expect(prompt).toContain("Keep the change scoped to this ticket");
    expect(prompt).toContain(
      "Coordinate via `bw comment`, child tickets, dependencies, and labels",
    );
    expect(prompt).toContain("Make atomic commits that clearly reference ticket BW-123");
    expect(prompt).toContain("git commit <specific-files> -m");
    expect(prompt).toContain("git commit <files> -m");
    expect(prompt).toContain("git add -A");
    expect(prompt).toContain("git add .");
    expect(prompt).toContain("git commit -a");
    expect(prompt).toContain("Do not stash, reset, clean, discard");
    expect(prompt).toContain("git diff -- <specific-files>");
    expect(prompt).toContain("git status --short");
    expect(prompt).toContain("status, commit SHAs when known, validation run/results, blockers");
    expect(prompt).toContain("bw close BW-123");
    expect(prompt).toContain("bw sync");
    expect(prompt).toContain("If blocked, explain the blocker in a `bw comment BW-123`");
    expect(prompt).toContain("Blocked by: BW-100");
    expect(prompt).toContain("Ticket context:\nBuild the shared-checkout handoff prompt.");
    expect(prompt).toContain("Epic context:\nMove worker execution to the current branch.");
    expect(prompt).toContain("/repo/project/.pi/beadwork/workers/runtime/BW-123/scratch");
  });

  it("does not include legacy isolated-checkout language", () => {
    const prompt = buildCurrentBranchHandoffPrompt({
      ticket: issue(),
      checkoutPath: "/repo/project",
      branchName: "main",
      runtimeScratchDir: "/tmp/pi-bw-scratch",
    });

    expect(prompt.toLowerCase()).not.toContain("worktree");
    expect(prompt).not.toContain("Worktree:");
  });
});
