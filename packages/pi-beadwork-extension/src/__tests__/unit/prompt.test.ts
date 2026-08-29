import { describe, expect, it } from "vitest";
import {
  buildBeadworkPromptAppendix,
  DEFAULT_REVIEW_POLICY,
  GOAL_TASK_TYPES,
  REVIEW_POLICIES,
  SCOPE_POLICY_TRADEOFF,
  selectReviewPolicy,
} from "../../prompt.js";
import { dropGoalMode } from "../../session-state.js";
import type {
  ActivationState,
  BeadworkIssue,
  BeadworkIssueDetail,
  Goal,
  ReviewPolicy,
  SessionState,
} from "../../types.js";

const ACTIVE: ActivationState = { kind: "active", repoRoot: "/repo" };

const TASK_TYPE_NEXT_QUESTIONS: Record<(typeof GOAL_TASK_TYPES)[number], RegExp[]> = {
  implementation: [
    /assess evidence/i,
    /apply the active review policy/i,
    /do not close solely because the child settled/i,
  ],
  fix: [/remediation of a required finding/i, /re-review before accept/i],
  reviewImplementation: [
    /independent ticket review/i,
    /fix\s*\|\s*file\s*\|\s*reject/i,
    /fix is blocking/i,
    /file is nonblocking unless the user waives a blocker/i,
    /reject records why/i,
    /no keyword classifier/i,
  ],
  reviewScope: [/aggregate review before epic complete/i],
  investigateBlocker: [
    /investigation of blocked work/i,
    /settlement is not implementation completion/i,
  ],
};

type RequiredPhrase = {
  name: string;
  needle: string | RegExp;
};

/** Fail CI if a review-policy instruction is deleted. */
const POLICY_REQUIRED_PHRASES: Record<ReviewPolicy, readonly RequiredPhrase[]> = {
  ticket: [
    {
      name: "independent reviewImplementation before close",
      needle: "Launch an independent `reviewImplementation` child before closing that ticket.",
    },
    {
      name: "do not close from implementer settlement",
      needle: "Do not close from implementer settlement alone.",
    },
  ],
  scope: [
    {
      name: "close from evidence without per-ticket review",
      needle:
        "You may close individual tickets from evidence without an independent per-ticket review child.",
    },
    {
      name: "reviewScope before epic complete",
      needle: "Launch a `reviewScope` child before declaring the epic complete.",
    },
    {
      name: "dependents may start before aggregate review",
      needle: SCOPE_POLICY_TRADEOFF,
    },
  ],
  none: [
    {
      name: "skip independent review children",
      needle: "Skip independent review children.",
    },
  ],
};

const REVIEWER_TASK_GUIDANCE_PHRASES: readonly RequiredPhrase[] = [
  { name: "named commits", needle: "named commits" },
  { name: "ticket id", needle: "the ticket id" },
  { name: "git show", needle: "`git show`" },
  {
    name: "do not start review of A while implementing",
    needle: "Do not start review of ticket A while A's implementer is still live.",
  },
];

const ANTI_CLASSIFIER_PHRASES: readonly RequiredPhrase[] = [
  { name: "no keyword classifier", needle: /no keyword classifier/i },
  {
    name: "no keyword matcher",
    needle: "Do not classify review findings with a keyword matcher.",
  },
];

const FORBIDDEN_REVIEW_LANGUAGE: readonly { name: string; needle: RegExp }[] = [
  { name: "regex classifier", needle: /regex\s+classifier/i },
  { name: "structured-result gate", needle: /structured[- ]results?(?:\s+gate)?/i },
];

function goal(reviewPolicy: ReviewPolicy): Goal {
  return {
    goalId: "goal-BW-100",
    scopeIds: ["BW-100"],
    reviewPolicy,
    startedAt: "2026-08-28T00:00:00.000Z",
  };
}

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    mode: "run",
    scope: { kind: "epic", id: "BW-100", title: "Epic title" },
    updatedAt: "2026-08-28T00:00:00.000Z",
    goal: goal("ticket"),
    ...overrides,
  };
}

function appendix(
  overrides: {
    activation?: ActivationState;
    sessionState?: Partial<SessionState>;
    scopeDetail?: BeadworkIssueDetail;
  } = {},
): string | undefined {
  return buildBeadworkPromptAppendix({
    activation: overrides.activation ?? ACTIVE,
    sessionState: session(overrides.sessionState),
    scopeDetail: overrides.scopeDetail,
  });
}

function availableToolsLine(text: string): string {
  const line = text.split("\n").find((entry) => entry.startsWith("Available beadwork tools:"));
  expect(line).toBeDefined();
  return line ?? "";
}

function expectPhrase(text: string, label: string, needle: string | RegExp): void {
  if (typeof needle === "string") {
    expect(text, label).toContain(needle);
    return;
  }
  expect(text, label).toMatch(needle);
}

function assertReviewPolicyPhrases(policy: ReviewPolicy, text: string): void {
  const required: RequiredPhrase[] = [
    ...POLICY_REQUIRED_PHRASES[policy],
    ...REVIEWER_TASK_GUIDANCE_PHRASES,
    ...ANTI_CLASSIFIER_PHRASES,
  ];
  const matched: string[] = [];
  for (const phrase of required) {
    expectPhrase(text, `${policy}: missing ${phrase.name}`, phrase.needle);
    matched.push(phrase.name);
  }
  for (const phrase of FORBIDDEN_REVIEW_LANGUAGE) {
    expect(text, `${policy}: must not contain ${phrase.name}`).not.toMatch(phrase.needle);
  }
  console.log(`review policy: ${policy}; matched required phrases: ${matched.join(", ")}`);
}

describe("buildBeadworkPromptAppendix modes", () => {
  it("returns undefined in neutral mode", () => {
    expect(appendix({ sessionState: { mode: "neutral", goal: undefined } })).toBeUndefined();
  });

  it("returns undefined when activation is not active", () => {
    expect(
      appendix({
        activation: { kind: "inactive", reason: "no-bw" },
        sessionState: { mode: "run" },
      }),
    ).toBeUndefined();
    expect(
      appendix({
        activation: { kind: "available", repoRoot: "/repo" },
        sessionState: { mode: "interactive" },
      }),
    ).toBeUndefined();
  });

  it("builds a human-led interactive appendix that does not start a turn", () => {
    const text = appendix({
      sessionState: { mode: "interactive", goal: undefined },
    });

    expect(text).toBeDefined();
    expect(text).toContain("[BEADWORK SESSION ACTIVE]");
    expect(text).toContain("You are in beadwork interactive mode.");
    expect(text).toContain("Stay human-led.");
    expect(text).toContain("This standing appendix is policy only. It does not start a turn.");
    expect(text).toContain("Wait for the user.");
    expect(text).toContain("Do not autonomously launch children");
    expect(text).toContain("`orchestrate`");
    expect(text).not.toContain("Goal mode: run the scoped epic to completion.");
  });

  it("builds a run-mode appendix with orchestrate policy and settlement≠close", () => {
    const text = appendix();

    expect(text).toBeDefined();
    expect(text).toContain("You are in beadwork run mode.");
    expect(text).toContain("Goal mode: run the scoped epic to completion.");
    expect(text).toContain("Use `orchestrate` plus beadwork tools. Do not poll.");
    expect(text).toContain("Child settlement is evidence, not acceptance.");
    expect(text).toContain("Do not close a ticket solely because a child settled.");
    expect(text).toContain("Start-before-work:");
    expect(text).toContain("This standing appendix is policy only. It does not start a turn.");
    expect(text).not.toContain("Stay human-led.");
    expect(text).not.toContain("Wait for the user.");
  });

  it("does not inject run-loop guidance for an interrupted run", () => {
    const text = appendix({
      sessionState: { runInterrupted: true },
      scopeDetail: {
        id: "BW-100",
        title: "Ship goal adapter",
        description: "desc",
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
      },
    });

    expect(text).toBeDefined();
    expect(text).toContain("[BEADWORK SESSION ACTIVE]");
    expect(text).toContain("Current scope: epic:BW-100");
    expect(text).toContain("## Scoped issue");
    expect(text).toContain("Do not orchestrate");
    expect(text).toContain("Wait for the user.");
    expect(text).toContain("Resume only after explicit `/bw run <epic-id>`");
    expect(text).not.toContain("Goal mode: run the scoped epic to completion.");
    expect(text).not.toContain(
      "When a turn runs: refresh `bw` (ready/show), start ready work, compose each child's `task`, then `orchestrate`.",
    );
    expect(text).not.toContain("You are in beadwork run mode.");
  });

  it("drops the run standing appendix after dropGoalMode", () => {
    const text = appendix({ sessionState: dropGoalMode(session()) });
    expect(text).toBeDefined();
    expect(text).toContain("You are in beadwork interactive mode.");
    expect(text).not.toContain("You are in beadwork run mode.");
    expect(text).not.toContain("Goal mode: run the scoped epic to completion.");
  });
});

describe("buildBeadworkPromptAppendix task types", () => {
  it("names each taskType with the right next-question", () => {
    const text = appendix();
    expect(text).toBeDefined();
    if (!text) {
      return;
    }

    expect(text).toContain("Role (open string): how the child works (prompt/template).");
    expect(text).toContain("Same loader as spawn `agent`.");
    expect(text).toContain(
      "Task type (closed): what question the parent asks when that child settles, fails, aborts, or asks.",
    );
    expect(text).toContain("Never collapse role and task type into one field.");
    expect(text).toContain("Omit `taskType` for untyped research or exploration.");

    for (const taskType of GOAL_TASK_TYPES) {
      expect(text, `missing taskType ${taskType}`).toContain(`\`${taskType}\``);
      for (const pattern of TASK_TYPE_NEXT_QUESTIONS[taskType]) {
        expect(text, `${taskType} next-question ${pattern}`).toMatch(pattern);
      }
    }
  });
});

describe("buildBeadworkPromptAppendix review policies", () => {
  it.each(REVIEW_POLICIES)("selects the %s policy branch and logs it", async (policy) => {
    const state = session({
      mode: "run",
      goal: goal(policy),
    });
    const selected = selectReviewPolicy(state);

    const text = buildBeadworkPromptAppendix({
      activation: ACTIVE,
      sessionState: state,
    });

    expect(selected).toBe(policy);
    expect(text).toBeDefined();
    if (!text) {
      return;
    }

    expect(text).toContain("Review policies: `ticket` (default), `scope`, and `none`.");
    expect(text).toContain(`Review policy branch: ${policy}`);
    assertReviewPolicyPhrases(policy, text);
    await expect(text).toMatchFileSnapshot(`../goldens/prompt-appendix-run-${policy}.md`);
  });

  it("defaults interactive sessions without a goal to ticket policy", async () => {
    const state = session({ mode: "interactive", goal: undefined });
    const selected = selectReviewPolicy(state);

    const text = buildBeadworkPromptAppendix({
      activation: ACTIVE,
      sessionState: state,
    });
    expect(selected).toBe(DEFAULT_REVIEW_POLICY);
    expect(text).toBeDefined();
    if (!text) {
      return;
    }
    expect(text).toContain("Review policy branch: ticket");
    expect(text).toContain("Launch an independent `reviewImplementation` child before closing");
    assertReviewPolicyPhrases("ticket", text);
    await expect(text).toMatchFileSnapshot("../goldens/prompt-appendix-interactive-ticket.md");
  });

  it("requires a reviewImplementation child before close under ticket policy", () => {
    const text = appendix({ sessionState: { goal: goal("ticket") } });
    expect(text).toContain("Active review policy: ticket (default).");
    expect(text).toContain(
      "Launch an independent `reviewImplementation` child before closing that ticket.",
    );
    expect(text).toContain("Do not close from implementer settlement alone.");
    expect(text).not.toContain(SCOPE_POLICY_TRADEOFF);
    expect(text).not.toContain("Skip independent review children.");
  });

  it("states the scope-policy dependents-before-aggregate-review tradeoff", () => {
    const text = appendix({ sessionState: { goal: goal("scope") } });
    expect(text).toContain("Active review policy: scope.");
    expect(text).toContain("You may close individual tickets from evidence");
    expect(text).toContain("Launch a `reviewScope` child before declaring the epic complete.");
    expect(text).toContain(SCOPE_POLICY_TRADEOFF);
    expect(text).toContain("Dependents may start before aggregate review finds a problem.");
  });

  it("skips independent review children under none policy and still judges from Git/bw", () => {
    const text = appendix({ sessionState: { goal: goal("none") } });
    expect(text).toContain("Active review policy: none.");
    expect(text).toContain("Skip independent review children.");
    expect(text).toContain("Still judge from Git and `bw` before close.");
    expect(text).not.toContain("Launch an independent `reviewImplementation` child before closing");
    expect(text).not.toContain(SCOPE_POLICY_TRADEOFF);
  });

  it("states reviewer child-task composition for every policy", () => {
    for (const policy of REVIEW_POLICIES) {
      const text = appendix({ sessionState: { goal: goal(policy) } });
      expect(text, policy).toBeDefined();
      if (!text) {
        continue;
      }
      for (const phrase of REVIEWER_TASK_GUIDANCE_PHRASES) {
        expectPhrase(text, `${policy}: missing ${phrase.name}`, phrase.needle);
      }
    }
  });

  it("rejects regex classifier and structured-result gate language", () => {
    for (const policy of REVIEW_POLICIES) {
      const text = appendix({ sessionState: { goal: goal(policy) } });
      expect(text, policy).toBeDefined();
      if (!text) {
        continue;
      }
      for (const phrase of FORBIDDEN_REVIEW_LANGUAGE) {
        expect(text, `${policy}: must not contain ${phrase.name}`).not.toMatch(phrase.needle);
      }
      for (const phrase of ANTI_CLASSIFIER_PHRASES) {
        expectPhrase(text, `${policy}: missing ${phrase.name}`, phrase.needle);
      }
    }
  });
});

describe("buildBeadworkPromptAppendix standing constraints", () => {
  it("includes start-before-work, domain metadata, reviewer evidence, and quality commands", () => {
    const text = appendix();
    expect(text).toContain("Start-before-work:");
    expect(text).toContain("Compose `task` yourself:");
    expect(text).toContain("Attach domain metadata:");
    expect(text).toContain('source "beadwork"');
    expect(text).toContain("workItemId (ticket id)");
    expect(text).toContain("named commits");
    expect(text).toContain("the ticket id");
    expect(text).toContain("`git show`");
    expect(text).toContain("Do not tell them to read the whole dirty workspace.");
    expect(text).toContain("Do not start review of ticket A while A's implementer is still live.");
    expect(text).toContain("That is an instruction, not a lock.");
    expect(text).toContain("`lint` / `test` / `typecheck`");
    expect(text).toContain("Beadwork does not own a validation gate.");
    expect(text).toContain("Do not classify review findings with a keyword matcher.");
    expect(text).toContain("Do not use tmux, landing, `--workers`, or polling.");
  });

  it("does not advertise deleted worker tools on the available-tools line", () => {
    const text = appendix();
    expect(text).toBeDefined();
    if (!text) {
      return;
    }

    const tools = availableToolsLine(text);
    expect(tools).not.toContain("beadwork_delegate");
    expect(tools).not.toContain("beadwork_worker_done");
    expect(tools).not.toContain("beadwork_land_worker");
    expect(tools).not.toContain("beadwork_worker_check");
    expect(tools).toContain("beadwork_start_issue");
    expect(tools).toContain("beadwork_close_issue");
    expect(tools).toContain("beadwork_sync");
  });

  it("keeps scoped issue summary and truncated prime", () => {
    const text = appendix({
      scopeDetail: {
        id: "BW-100",
        title: "Ship goal adapter",
        description: "desc",
        status: "open",
        type: "epic",
        priority: 1,
        labels: [],
        blockedBy: [],
        blocks: ["BW-101"],
        assignee: "",
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
        children: [
          {
            id: "BW-101",
            title: "Child",
            description: "",
            status: "open",
            type: "task",
            priority: 1,
            labels: [],
            blockedBy: [],
            blocks: [],
            assignee: "",
            createdAt: "2026-08-28T00:00:00.000Z",
            updatedAt: "2026-08-28T00:00:00.000Z",
          } satisfies BeadworkIssue,
        ],
      },
      sessionState: {
        prime: { content: `${"x".repeat(8_050)} leftover`, loadedAt: "2026-08-28T00:00:00.000Z" },
      },
    });

    expect(text).toContain("## Scoped issue");
    expect(text).toContain("BW-100 · epic · open · P1");
    expect(text).toContain("Ship goal adapter");
    expect(text).toContain("Blocks: BW-101");
    expect(text).toContain("- BW-101 · open · Child");
    expect(text).toContain("## Cached bw prime");
    expect(text).toContain("[prime truncated]");
    expect(text).not.toContain(" leftover");
  });
});
