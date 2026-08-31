import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getMinionsSkill, MINIONS_SKILL, ORCHESTRATE_SIDECAR_GUIDELINES } from "../skill.js";

const INDEX_SOURCE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../index.ts"),
  "utf8",
);

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
    expect(skill).toContain(
      "Use sidecar orchestration only for slices independent of the parent's continuing work.",
    );
    expect(skill).toContain(
      "Once scope is delegated, do not edit that delegated scope while the child is live. Message or halt the child instead.",
    );
    expect(skill).toContain(
      "The parent may continue user interaction, inspection, planning, or non-overlapping work.",
    );
    expect(skill).toContain("Path intent and overlap notices are advisory, not locks.");
    expect(skill).toContain(
      "A parent turn ending while children run is normal. Do not represent delegated work as complete while children are live.",
    );

    expect(ORCHESTRATE_SIDECAR_GUIDELINES).toEqual([
      "Use orchestrate only for slices independent of the parent's continuing work.",
      "Once scope is delegated, do not edit that delegated scope while the child is live. Message or halt the child instead.",
      "The parent may continue user interaction, inspection, planning, or non-overlapping work.",
      "Path intent and overlap notices are advisory, not locks.",
      "A parent turn ending while children run is normal. Do not represent delegated work as complete while children are live.",
    ]);
    expect(INDEX_SOURCE).toContain("ORCHESTRATE_SIDECAR_GUIDELINES");
    expect(INDEX_SOURCE).toContain("...ORCHESTRATE_SIDECAR_GUIDELINES");

    expect(skill).not.toMatch(/\boperatingMode\b/);
    expect(skill).not.toContain("beadwork_start_goal");
    expect(skill).not.toContain("beadwork_run_epic");
    expect(skill).not.toContain("beadwork_implement_epic");
    expect(skill).not.toContain("`role`");
  });
});
