import { describe, expect, it } from "vitest";
import { getMinionsSkill, MINIONS_SKILL } from "../skill.js";

describe("minions skill", () => {
  it("documents spawn vs orchestrate instead of denying background minions", () => {
    const skill = getMinionsSkill();

    expect(skill).toBe(MINIONS_SKILL);
    expect(skill).toContain("Use `spawn` when you intend to wait");
    expect(skill).toContain("Use `orchestrate` for background work");
    expect(skill).toContain("Persistent hosts only");
    expect(skill).toContain("`description`");
    expect(skill).toContain("`taskType`");
    expect(skill).toContain("send_minion_message");
    expect(skill).toContain("Halt does not exit Beadwork goal mode");
    expect(skill).toContain("Live detach is not available");
    expect(skill).toContain("User steering is not available");

    expect(skill.toLowerCase()).not.toContain("background minions are not available");
    expect(skill).not.toContain(
      "foreground agent sessions and you need the result before continuing",
    );
  });
});
