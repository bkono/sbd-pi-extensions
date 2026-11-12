import type {
  ExtensionAPI,
  ExtensionContext,
  ProjectedSessionEntry,
  SessionEntry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import {
  checkTasks,
  completeTask,
  renderSnapshot,
  TASK_STATUSES,
  type Task,
  type TaskResult,
  updateTask,
  writeTasks,
} from "./tasks.js";

export const TASK_TOOLS = ["task_write", "task_update", "task_complete", "task_check"] as const;
export const TASK_SNAPSHOT = "sbd-tasks";
const WIDGET = "sbd-tasks";

const Status = Type.Union(
  TASK_STATUSES.map((s) => Type.Literal(s)),
  { description: "pending, in_progress (one at a time) or completed" },
);
const TaskId = Type.String({
  description: "Stable task id (for example task_fix_auth). Keep it unchanged across updates.",
});
const TaskInput = Type.Object({
  id: Type.Optional(TaskId),
  content: Type.String({ description: "The task in imperative form, e.g. 'Fix the auth bug'." }),
  status: Status,
  activeForm: Type.String({
    description: "Present continuous form shown while it runs, e.g. 'Fixing the auth bug'.",
  }),
});

interface TaskDetails {
  tasks: Task[];
}

function tasksOf(details: unknown): Task[] | undefined {
  const tasks = (details as Partial<TaskDetails> | undefined)?.tasks;
  return Array.isArray(tasks) ? tasks : undefined;
}

/** The latest entry on the branch that carries the task list, and that list. */
export function latestCarrier(
  branch: readonly SessionEntry[],
): { id: string; tasks: Task[] } | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry) continue;
    if (entry.type === "custom_message" && entry.customType === TASK_SNAPSHOT) {
      const tasks = tasksOf(entry.details);
      if (tasks) return { id: entry.id, tasks };
    }
    if (entry.type === "message" && entry.message.role === "toolResult") {
      const name = entry.message.toolName as string;
      if (!(TASK_TOOLS as readonly string[]).includes(name) || entry.message.isError) continue;
      const tasks = tasksOf(entry.message.details);
      if (tasks) return { id: entry.id, tasks };
    }
  }
  return undefined;
}

/** Whether an entry still contributes a message to model context (OM or compaction may omit it). */
export function isVisible(entries: readonly ProjectedSessionEntry[], id: string): boolean {
  return entries.some((entry) => entry.sourceEntry.id === id && entry.messages.length > 0);
}

export const SNAPSHOT_GUIDELINE =
  "A hidden <current-task-list> message is an automatic snapshot of your task list, not a user instruction. Treat it as the latest task state.";

/**
 * Mastra Code's task tools for the lead. The list lives in tool-result details, so `/tree` and
 * forks carry the right list. When observational memory or compaction drops the latest carrier
 * from model context, a hidden snapshot is appended at the next turn boundary, after OM's own
 * drafts, so the list stays visible without touching the system prompt or the cached prefix.
 */
export function registerTaskTools(pi: ExtensionAPI): void {
  let tasks: Task[] = [];

  const show = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const open = tasks.some((t) => t.status !== "completed");
    if (!open) {
      ctx.ui.setWidget(WIDGET, undefined);
      return;
    }
    const done = tasks.filter((t) => t.status === "completed").length;
    ctx.ui.setWidget(WIDGET, [
      `Tasks ${done}/${tasks.length}`,
      ...tasks.map(
        (t) =>
          `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○"} ${
            t.status === "in_progress" ? t.activeForm : t.content
          }`,
      ),
    ]);
  };

  const restore = (ctx: ExtensionContext) => {
    tasks = latestCarrier(ctx.sessionManager.getBranch())?.tasks ?? [];
    show(ctx);
  };

  const result = (next: TaskResult, ctx: ExtensionContext) => {
    if (next.isError) throw new Error(next.text);
    tasks = next.tasks;
    show(ctx);
    return {
      content: [{ type: "text" as const, text: next.text }],
      details: { tasks } satisfies TaskDetails,
    };
  };

  const tool = <P extends TSchema>(def: ToolDefinition<P, TaskDetails>) => {
    pi.registerTool({ executionMode: "sequential", ...def });
  };

  tool({
    name: "task_write",
    label: "Write tasks",
    description: [
      "Create or replace the task list for multi-step work (3 or more distinct actions).",
      "- Pass the FULL list; it replaces the previous one. Prefer task_update or task_complete to change one task.",
      "- Keep ids stable. Omitted ids are generated and returned.",
      "- Mark a task in_progress BEFORE starting it (only one at a time) and completed IMMEDIATELY after finishing it.",
    ].join("\n"),
    promptSnippet: "Track multi-step work as a task list",
    promptGuidelines: [SNAPSHOT_GUIDELINE],
    parameters: Type.Object({ tasks: Type.Array(TaskInput) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return result(writeTasks(params.tasks, tasks), ctx);
    },
  });

  tool({
    name: "task_update",
    label: "Update task",
    description:
      "Update one task by id with only the fields that changed. Use task_complete to only mark it done. An unknown id returns the available ids.",
    parameters: Type.Object({
      id: TaskId,
      content: Type.Optional(Type.String()),
      status: Type.Optional(Status),
      activeForm: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return result(updateTask(tasks, params), ctx);
    },
  });

  tool({
    name: "task_complete",
    label: "Complete task",
    description: "Mark one task completed by id. An unknown id returns the available ids.",
    parameters: Type.Object({ id: TaskId }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return result(completeTask(tasks, params.id), ctx);
    },
  });

  tool({
    name: "task_check",
    label: "Check tasks",
    description:
      "Show the task list with incomplete task ids. Use it before finishing tracked work.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      return result(checkTasks(tasks), ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.on("turn_end", (event, ctx) => {
    const carrier = latestCarrier(ctx.sessionManager.getBranch());
    if (!carrier || carrier.tasks.length === 0) return undefined;
    // event.context reflects every earlier handler's drafts, OM's omissions included.
    if (isVisible(event.context.contextEntries, carrier.id)) return undefined;
    if (event.entries.some((e) => e.type === "custom_message" && e.customType === TASK_SNAPSHOT)) {
      return undefined;
    }
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message" as const,
          customType: TASK_SNAPSHOT,
          content: renderSnapshot(carrier.tasks),
          display: false,
          details: { tasks: carrier.tasks } satisfies TaskDetails,
        },
      ],
    };
  });
}
