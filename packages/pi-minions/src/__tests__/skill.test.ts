import { describe, expect, it } from "vitest";
import { getMinionsSkill, MINIONS_SKILL, ORCHESTRATE_SIDECAR_GUIDELINES } from "../skill.js";

describe("minions skill composition", () => {
  it("returns the exported skill with each shared guideline included", () => {
    const skill = getMinionsSkill();
    expect(skill).toBe(MINIONS_SKILL);
    for (const guideline of ORCHESTRATE_SIDECAR_GUIDELINES) {
      expect(skill).toContain(guideline);
    }
  });
});
