import { describe, expect, it } from "vitest";
import { getMinionsSkill, MINIONS_SKILL, ORCHESTRATE_SIDECAR_GUIDELINES } from "../skill.js";

describe("minions skill", () => {
  it("documents spawn vs orchestrate instead of denying background minions", () => {
    const skill = getMinionsSkill();

    expect(skill).toBe(MINIONS_SKILL);
    expect(skill).toContain("Use `spawn` when you intend to wait");
    expect(skill).toContain("Use `orchestrate` for background work");
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
    expect(skill).toContain("User steering is not available");

    expect(skill.toLowerCase()).not.toContain("background minions are not available");
    expect(skill).not.toContain(
      "foreground agent sessions and you need the result before continuing",
    );
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
      "While orchestrate work is live, the parent may end the current turn, inspect, message, halt, or continue safe non-overlapping work; do not edit the delegated scope.",
    );
    expect(skill).toContain(
      "Never claim orchestrate-delegated work or the orchestration goal complete while any child remains live.",
    );

    expect(ORCHESTRATE_SIDECAR_GUIDELINES).toHaveLength(5);

    expect(skill).not.toMatch(/\boperatingMode\b/);
    expect(skill).not.toContain("beadwork_start_goal");
    expect(skill).not.toContain("beadwork_run_epic");
    expect(skill).not.toContain("beadwork_implement_epic");
    expect(skill).not.toContain("`role`");
  });
});
