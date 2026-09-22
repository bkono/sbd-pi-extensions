import { describe, expect, it } from "vitest";
import { getMinionsSkill, MINIONS_SKILL, ORCHESTRATE_SIDECAR_GUIDELINES } from "../skill.js";

describe("minions skill", () => {
  it("documents spawn vs orchestrate instead of denying background minions", () => {
    const skill = getMinionsSkill();

    expect(skill).toBe(MINIONS_SKILL);
    expect(skill).toContain("Use `spawn` for a foreground delegation");
    expect(skill).toContain(
      "Use `orchestrate` when the supervisor must remain available to the user",
    );
    expect(skill).toContain("Persistent hosts only");
    expect(skill).toContain("`description`");
    expect(skill).toContain("`agent`");
    expect(skill).toContain("`taskType`");
    expect(skill).toContain("`worker`");
    expect(skill).toContain("`investigate`");
    expect(skill).not.toContain("`role`");
    expect(skill).toContain("send_minion_message");
    expect(skill).toContain("Halt does not exit Beadwork goal mode");
    expect(skill).toContain("Live detach is not available");
    expect(skill).toContain("Users can engage the supervisor normally");
    expect(skill).toContain("does not expose direct user steering of child sessions");

    expect(skill.toLowerCase()).not.toContain("background minions are not available");
    expect(skill).not.toContain("Use `spawn` when you intend to wait");
  });

  it("locks cooperative sidecar guidance for generic orchestrate", () => {
    const skill = getMinionsSkill();

    expect(skill).toContain("## Cooperative sidecar");
    for (const guideline of ORCHESTRATE_SIDECAR_GUIDELINES) {
      expect(skill).toContain(guideline);
      expect(guideline).toMatch(/\borchestrate\b/i);
    }
    expect(skill).toContain(
      "After orchestrate registers background work, treat delegated work as live until terminal lifecycle evidence, explicit inspection, or halt proves otherwise.",
    );
    expect(skill).toContain(
      "finish any already-identified, independent parent work, then end the turn",
    );
    expect(skill).toContain(
      "Do not edit the delegated scope or invent work to keep the turn alive. Active domain restrictions such as a manager-only role still apply.",
    );
    expect(skill).toContain(
      "Never claim orchestrate-delegated work or the orchestration goal complete while any child remains live.",
    );

    expect(skill).toContain("Yielding is token-efficient: it preserves context");
    expect(skill).toContain("polling postpones the events you are waiting for");

    expect(skill).not.toMatch(/\boperatingMode\b/);
    expect(skill).not.toContain("beadwork_start_goal");
    expect(skill).not.toContain("beadwork_run_epic");
    expect(skill).not.toContain("beadwork_implement_epic");
    expect(skill).not.toContain("`role`");
  });

  it("teaches yielding and supervisor-owned fix/file/reject before tool reference", () => {
    const skill = getMinionsSkill();
    expect(skill).toContain(
      "Dispatch → yield → receive follow-up → evaluate and decide → dispatch or yield",
    );
    expect(skill).toContain("end the assistant turn without another tool call");
    expect(skill).toContain("Do not ask the user to say “continue.”");
    expect(skill).toContain("User asks a question");
    expect(skill).toContain("Recovering unclear state after compaction");
    expect(skill).toContain("fix / file / reject");
    expect(skill).toContain("aligned with project vision and goals");
    expect(skill).toContain("quality bar");
    expect(skill).toContain("Filing a blocker does not make it nonblocking");
    expect(skill).toContain("ask the user rather than deciding that change unilaterally");
    expect(skill).toContain("New findings still require evaluation");
    expect(skill.indexOf("## Supervisor loop")).toBeLessThan(skill.indexOf("## Tool reference"));
  });
});
