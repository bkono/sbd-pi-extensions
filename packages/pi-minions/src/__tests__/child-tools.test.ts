import { describe, expect, it } from "vitest";
import {
  applyChildToolAllowlist,
  BEADWORK_CHILD_DENIED_TOOLS,
  BEADWORK_CHILD_INSPECTION_TOOLS,
  computeChildActiveTools,
} from "../subsessions/manager.js";

const PARENT_CODING = ["read", "bash", "edit", "write", "grep", "spawn", "halt"];
const ROLE_ALLOWLIST = ["read", "bash", "beadwork_close_issue"];

describe("child tool allowlist formula", () => {
  it("unions inspection tools onto parent coding tools and strips close/start/reopen", () => {
    const names = computeChildActiveTools({ parentCodingTools: PARENT_CODING });

    expect(names).toEqual(expect.arrayContaining([...BEADWORK_CHILD_INSPECTION_TOOLS]));
    expect(names).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "grep"]));
    expect(names).not.toEqual(expect.arrayContaining([...BEADWORK_CHILD_DENIED_TOOLS]));
    expect(names).not.toContain("beadwork_close_issue");
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
      parentCodingTools: PARENT_CODING,
      extraTools: ["minion_mail", "beadwork_close_issue"],
    });

    expect(names).toContain("minion_mail");
    expect(names).not.toContain("beadwork_close_issue");
  });

  it("strips a late-registered beadwork_close_issue on re-apply", () => {
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

    applyChildToolAllowlist(session, { parentCodingTools: ["read", "bash"] });
    expect(session.getActiveToolNames()).toContain("beadwork_show");
    expect(session.getActiveToolNames()).not.toContain("beadwork_close_issue");

    registered.add("beadwork_close_issue");
    session.active.push("beadwork_close_issue");
    expect(session.getActiveToolNames()).toContain("beadwork_close_issue");

    applyChildToolAllowlist(session, { parentCodingTools: ["read", "bash"] });
    expect(session.getActiveToolNames()).toContain("beadwork_show");
    expect(session.getActiveToolNames()).not.toContain("beadwork_close_issue");
  });
});
