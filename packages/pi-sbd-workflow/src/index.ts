import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  Skill,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { decideSettle, type Goal, type GoalRepo, type RepoState } from "./gate.js";
import { classifyCommand, MERGE_BLOCK_REASON, readyBlockReason } from "./guard.js";
import {
  checkVerdict,
  hasTrackedEdits,
  postVerdict,
  repoRoot,
  resolveSha,
  VERDICTS,
  type Verdict,
} from "./verdict.js";

export const SOURCE = "@solvedbydev/pi-sbd-workflow";
export const GOAL_ENTRY = "sbd-goal";
export const GATE_MESSAGE = "sbd-gate";
export const SET_PREDICATE_TOOL = "sbd_set_predicate";
export const VERDICT_POST_TOOL = "sbd_verdict_post";
export const ROUTER_SECTION = "sbd_workflow";

/** pi-minions' contribution protocol (pi-minions README, Contributions). */
const MINIONS_HELLO = "pi-minions:hello";
const MINIONS_READY = "pi-minions:ready";
const MINIONS_CONTRIBUTE = "pi-minions:contribute";

interface MinionsApi {
  liveOrchestrated(): number;
}

export const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");

export function repoState(repo: GoalRepo): RepoState {
  if (hasTrackedEdits(repo.root)) return { root: repo.root, kind: "uncommitted" };
  const head = resolveSha(repo.root, "HEAD");
  if (!head || head === repo.base) return { root: repo.root, kind: "unchanged" };
  const result = checkVerdict(repo.root, head);
  return { root: repo.root, kind: "verdict", pass: result.pass, line: result.line, sha: head };
}

/** Where the hidden router and its principle leaves are, for any session that loaded them. */
export function routerSection(skills: readonly Skill[] | undefined): string | undefined {
  const router = skills?.find((skill) => skill.name === "sbd");
  if (!router) return undefined;
  const skillsDir = dirname(router.baseDir);
  return [
    `The sbd workflow router is ${router.filePath}. Read it only when the user's /skill:sbd message, your brief or a playbook sends you there.`,
    `Its principle leaves are ${join(skillsDir, "principle-<title>", "SKILL.md")} and ${join(skillsDir, "sbd-principle-<title>", "SKILL.md")}. Read them by path.`,
  ].join("\n");
}

const SetPredicateParams = Type.Object({
  predicate: Type.String({
    description:
      "The done-predicate: one falsifiable sentence plus the evidence that will prove it.",
  }),
  repos: Type.Optional(
    Type.Array(Type.String(), {
      description: "Repository paths the work changes. Default: the session's working directory.",
    }),
  ),
});

const VerdictPostParams = Type.Object({
  sha: Type.String({ description: "The commit the verdict covers." }),
  verdict: Type.Union(
    VERDICTS.map((v) => Type.Literal(v)),
    { description: "PASS, PASS+NOTES or FAIL." },
  ),
  worktree: Type.String({
    description: "Absolute path of the detached worktree checked out at the SHA.",
  }),
  summary: Type.String({ description: "Your Evidence and Repro sections, as markdown." }),
});

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: undefined };
}

function modelRef(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

/** Only the verifier's children receive this tool, through pi-minions. */
export const verdictPostTool: ToolDefinition<typeof VerdictPostParams> = {
  name: VERDICT_POST_TOOL,
  label: "Post verdict",
  description:
    "Record your independent verdict for a commit. Run it after you verified the change in a detached worktree at that SHA.",
  parameters: VerdictPostParams,
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const result = postVerdict({
      worktree: params.worktree,
      sha: params.sha,
      verdict: params.verdict as Verdict,
      summary: params.summary,
      verifier: { host: "pi", agent: "verifier", model: modelRef(ctx) },
    });
    if (!result.ok) throw new Error(`verdict refused: ${result.reason}`);
    return text(result.line);
  },
};

export default function sbdWorkflow(pi: ExtensionAPI): void {
  let goal: Goal | undefined;
  let continuations = 0;
  let minions: MinionsApi | undefined;

  const setGoal = (next: Goal | undefined) => {
    goal = next;
    continuations = 0;
    pi.appendEntry(GOAL_ENTRY, next ?? null);
  };

  pi.events.on(MINIONS_READY, (api: unknown) => {
    minions = api as MinionsApi;
    pi.events.emit(MINIONS_CONTRIBUTE, {
      source: SOURCE,
      agentDirs: [AGENTS_DIR],
      agentTools: { verifier: [verdictPostTool] },
      parentOnlyTools: [SET_PREDICATE_TOOL],
    });
  });
  pi.events.emit(MINIONS_HELLO, undefined);

  pi.on("session_start", (_event, ctx) => {
    goal = undefined;
    continuations = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === GOAL_ENTRY) {
        goal = (entry.data as Goal | null) ?? undefined;
      }
    }
  });

  pi.registerTool({
    name: SET_PREDICATE_TOOL,
    label: "Set done-predicate",
    description:
      "Set this session's done-predicate. Until it is met, Pi will not settle while a covered repository has new commits without a passing verifier verdict at HEAD, or has uncommitted tracked edits.",
    promptSnippet: "Set the sbd done-predicate that gates settling on an independent verdict",
    parameters: SetPredicateParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const predicate = params.predicate.trim();
      if (!predicate) throw new Error("the predicate is empty");
      const paths = params.repos?.length ? params.repos : [ctx.cwd];
      const repos: GoalRepo[] = [];
      for (const path of paths) {
        const root = repoRoot(path);
        const base = root && resolveSha(root, "HEAD");
        if (!root || !base) throw new Error(`not a git repository with a commit: ${path}`);
        if (!repos.some((repo) => repo.root === root)) repos.push({ root, base });
      }
      setGoal({ predicate, repos });
      return text(
        [
          `Goal set: ${predicate}`,
          `Covered: ${repos.map((repo) => `${repo.root} (base ${repo.base.slice(0, 12)})`).join(", ")}.`,
          "The session will not settle while a covered repository has new commits without a passing verifier verdict at HEAD, or uncommitted tracked edits.",
        ].join("\n"),
      );
    },
  });

  pi.on("input", (event) => {
    if (event.source !== "extension") continuations = 0;
    return { action: "continue" };
  });

  pi.on("agent_before_settle", (event) => {
    const decision = decideSettle({
      goal,
      liveChildren: minions?.liveOrchestrated() ?? 0,
      continuations,
      states: () => goal?.repos.map(repoState) ?? [],
    });
    if (decision.kind === "settle") return undefined;
    if (decision.kind === "met") {
      setGoal(undefined);
      return undefined;
    }
    const draft = {
      type: "custom_message" as const,
      customType: GATE_MESSAGE,
      content: decision.message,
      display: true,
    };
    if (decision.kind === "give-up") {
      setGoal(undefined);
      return { entries: [...event.entries, draft], continue: false };
    }
    continuations += 1;
    return { entries: [...event.entries, draft], continue: true };
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = String((event.input as { command?: unknown }).command ?? "");
    const kind = classifyCommand(command);
    if (kind === "merge") return { block: true, reason: MERGE_BLOCK_REASON };
    if (kind === "ready") {
      const check = checkVerdict(ctx.cwd, "HEAD");
      if (!check.pass) return { block: true, reason: readyBlockReason(check.line) };
    }
    return undefined;
  });

  pi.on("before_agent_start", (event) => {
    const section = routerSection(event.systemPromptOptions.skills);
    if (section) event.systemPromptOptions.sections[ROUTER_SECTION] = section;
    return undefined;
  });
}
