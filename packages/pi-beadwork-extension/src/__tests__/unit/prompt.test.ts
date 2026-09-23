import { describe, expect, it } from "vitest";
import {
  buildBeadworkPromptAppendix,
  DEFAULT_REVIEW_POLICY,
  REVIEW_POLICIES,
  selectReviewPolicy,
} from "../../prompt.js";
import { dropGoalMode } from "../../session-state.js";
import type { BeadworkIssueDetail, ReviewPolicy, SessionState } from "../../types.js";

function session(reviewPolicy: ReviewPolicy = "ticket"): SessionState {
  return {
    mode: "run",
    scope: { kind: "epic", id: "BW-100", title: "Scope sentinel" },
    updatedAt: "2026-08-28T00:00:00.000Z",
    goal: {
      goalId: "goal-BW-100",
      scopeIds: ["BW-100"],
      reviewPolicy,
      startedAt: "2026-08-28T00:00:00.000Z",
    },
  };
}

function appendix(sessionState: SessionState, scopeDetail?: BeadworkIssueDetail) {
  return buildBeadworkPromptAppendix({
    activation: { kind: "active", repoRoot: "/repo" },
    sessionState,
    scopeDetail,
  });
}

function issue(id: string): BeadworkIssueDetail {
  return {
    id,
    title: `title-sentinel-${id}`,
    description: "",
    status: "open",
    type: "epic",
    priority: 1,
    labels: [],
    blockedBy: [],
    blocks: [],
    assignee: "",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    children: [],
  };
}

describe("buildBeadworkPromptAppendix", () => {
  it("omits context for neutral or inactive sessions", () => {
    expect(appendix({ ...session(), mode: "neutral", goal: undefined })).toBeUndefined();
    for (const activation of [
      { kind: "inactive", reason: "no-bw" },
      { kind: "available", repoRoot: "/repo" },
    ] as const) {
      expect(buildBeadworkPromptAppendix({ activation, sessionState: session() })).toBeUndefined();
    }
  });

  it.each(REVIEW_POLICIES)("selects the %s review policy from goal state", (policy) => {
    expect(selectReviewPolicy(session(policy))).toBe(policy);
  });

  it("defaults sessions without a goal to the default review policy", () => {
    expect(selectReviewPolicy(dropGoalMode(session()))).toBe(DEFAULT_REVIEW_POLICY);
  });

  it("includes supplied scope, dependency, and child data", () => {
    const detail = {
      ...issue("BW-scope"),
      parentId: "BW-parent",
      blockedBy: ["BW-blocker"],
      blocks: ["BW-dependent"],
      children: [issue("BW-child")],
    };
    const text = appendix(session(), detail);
    for (const value of [
      detail.id,
      detail.title,
      detail.parentId,
      ...detail.blockedBy,
      ...detail.blocks,
      detail.children[0].id,
      detail.children[0].title,
    ]) {
      expect(text).toContain(value);
    }
  });

  it("bounds child summaries to twelve children", () => {
    const children = Array.from({ length: 13 }, (_, i) => issue(`child-${i}-sentinel`));
    const text = appendix(session(), { ...issue("BW-scope"), children });
    for (const child of children.slice(0, 12)) {
      expect(text).toContain(child.title);
    }
    expect(text).not.toContain(children[12].title);
  });

  it("preserves cached prime through the limit and excludes overflow", () => {
    const prefix = "x".repeat(8_000);
    const state = session();
    for (const content of ["prime-sentinel", prefix, `${prefix}overflow-sentinel`]) {
      const text = appendix({ ...state, prime: { content, loadedAt: state.updatedAt } });
      expect(text).toContain(content.slice(0, 8_000));
      expect(text).not.toContain("overflow-sentinel");
    }
  });

  it("retains scope data but omits cached prime for interrupted runs", () => {
    const state = session();
    const detail = issue("BW-interrupted");
    const text = appendix(
      {
        ...state,
        runInterrupted: true,
        prime: { content: "prime-sentinel", loadedAt: state.updatedAt },
      },
      detail,
    );
    expect(text).toContain(detail.id);
    expect(text).toContain(detail.title);
    expect(text).not.toContain("prime-sentinel");
  });
});
