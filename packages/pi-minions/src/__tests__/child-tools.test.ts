import { describe, expect, it } from "vitest";
import {
  applyChildToolAllowlist,
  BEADWORK_CHILD_INSPECTION_TOOLS,
  computeChildActiveTools,
} from "../subsessions/manager.js";

const PARENT_CODING = ["read", "bash", "edit", "write", "grep", "spawn", "halt"];
const PARENT_WITH_MUTATIONS = [
  "read",
  "bash",
  "beadwork_show",
  "beadwork_comment_issue",
  "beadwork_create_issue",
  "beadwork_close_issue",
  "beadwork_update_issue",
  "beadwork_label_issue",
  "beadwork_defer_issue",
  "beadwork_undefer_issue",
  "beadwork_add_dependency",
  "beadwork_remove_dependency",
  "beadwork_sync",
];
const ROLE_ALLOWLIST = ["read", "bash", "beadwork_close_issue"];

describe("child tool allowlist formula", () => {
  it("treats parent coding tools as parent minus all beadwork_*, then unions inspection", () => {
    const names = computeChildActiveTools({ parentCodingTools: PARENT_WITH_MUTATIONS });

    expect(names).toEqual(
      expect.arrayContaining(["read", "bash", ...BEADWORK_CHILD_INSPECTION_TOOLS]),
    );
    expect(names).toContain("beadwork_show");
    expect(names).not.toContain("beadwork_comment_issue");
    expect(names).not.toContain("beadwork_create_issue");
    expect(names).not.toContain("beadwork_close_issue");
    expect(names).not.toContain("beadwork_update_issue");
    expect(names).not.toContain("beadwork_sync");
    expect(names.filter((name) => name.startsWith("beadwork_")).sort()).toEqual(
      [...BEADWORK_CHILD_INSPECTION_TOOLS].sort(),
    );
  });

  it("keeps inspection even when a role allowlist omits it, and still cannot add close", () => {
    const names = computeChildActiveTools({
      roleAllowlist: ROLE_ALLOWLIST,
      parentCodingTools: PARENT_CODING,
    });

    expect(names).toEqual(
      expect.arrayContaining(["read", "bash", ...BEADWORK_CHILD_INSPECTION_TOOLS]),
    );
    expect(names).not.toContain("beadwork_close_issue");
    expect(names).not.toContain("edit");
  });

  it("leaves an extraTools hook so orchestrate can union comm tools without rewriting", () => {
    const names = computeChildActiveTools({
      parentCodingTools: PARENT_WITH_MUTATIONS,
      extraTools: ["minion_mail", "beadwork_close_issue", "beadwork_comment_issue"],
    });

    expect(names).toContain("minion_mail");
    expect(names).toContain("beadwork_show");
    expect(names).not.toContain("beadwork_close_issue");
    expect(names).not.toContain("beadwork_comment_issue");
  });

  it("spawn formula omits extraTools so inspection stays and comm/close stay out", () => {
    for (const extraTools of [undefined, [] as string[]]) {
      const names = computeChildActiveTools({
        parentCodingTools: PARENT_WITH_MUTATIONS,
        extraTools,
      });

      expect(names).toEqual(
        expect.arrayContaining(["read", "bash", ...BEADWORK_CHILD_INSPECTION_TOOLS]),
      );
      expect(names).toContain("beadwork_show");
      expect(names).not.toContain("minion_mail");
      expect(names).not.toContain("beadwork_close_issue");
      expect(names).not.toContain("beadwork_comment_issue");
    }
  });

  it("strips late-registered beadwork mutations on re-apply", () => {
    const registered = new Set([
      "read",
      "bash",
      "beadwork_show",
      "beadwork_list_issues",
      "beadwork_issue_history",
      "beadwork_ready",
      "beadwork_blocked",
      "beadwork_status",
      "beadwork_prime",
    ]);
    const session = {
      active: [] as string[],
      setActiveToolsByName(names: string[]) {
        this.active = names.filter((name) => registered.has(name));
      },
      getActiveToolNames() {
        return [...this.active];
      },
    };

    applyChildToolAllowlist(session, { parentCodingTools: PARENT_WITH_MUTATIONS });
    expect(session.getActiveToolNames()).toContain("beadwork_show");
    expect(session.getActiveToolNames()).not.toContain("beadwork_close_issue");
    expect(session.getActiveToolNames()).not.toContain("beadwork_comment_issue");
    expect(session.getActiveToolNames()).not.toContain("beadwork_create_issue");

    registered.add("beadwork_close_issue");
    registered.add("beadwork_comment_issue");
    registered.add("beadwork_create_issue");
    session.active.push("beadwork_close_issue", "beadwork_comment_issue", "beadwork_create_issue");
    expect(session.getActiveToolNames()).toContain("beadwork_comment_issue");

    applyChildToolAllowlist(session, { parentCodingTools: PARENT_WITH_MUTATIONS });
    expect(session.getActiveToolNames()).toContain("beadwork_show");
    expect(session.getActiveToolNames()).not.toContain("beadwork_close_issue");
    expect(session.getActiveToolNames()).not.toContain("beadwork_comment_issue");
    expect(session.getActiveToolNames()).not.toContain("beadwork_create_issue");
  });
});
