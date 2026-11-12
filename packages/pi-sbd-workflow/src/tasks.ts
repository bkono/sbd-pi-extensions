/**
 * The task list: a port of Mastra Code's task tools (`task_write`, `task_update`,
 * `task_complete`, `task_check`) as pure state transitions. Pi wiring lives in task-tools.ts.
 */

export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: string;
  content: string;
  status: TaskStatus;
  activeForm: string;
}

export type TaskInput = Omit<Task, "id"> & { id?: string };

export interface TaskResult {
  tasks: Task[];
  text: string;
  isError: boolean;
}

const SLUG_MAX = 48;

function slug(content: string): string {
  let out = "";
  let gap = false;
  for (const char of content.toLowerCase()) {
    if (/[a-z0-9]/.test(char)) {
      if (gap && out.length > 0 && out.length < SLUG_MAX) out += "_";
      if (out.length >= SLUG_MAX) break;
      out += char;
      gap = false;
    } else {
      gap = out.length > 0;
    }
  }
  return out;
}

function unique(id: string, used: Set<string>, reserved: Set<string>): string {
  if (!used.has(id) && !reserved.has(id)) return id;
  let n = 2;
  while (used.has(`${id}_${n}`) || reserved.has(`${id}_${n}`)) n += 1;
  return `${id}_${n}`;
}

/**
 * Gives every task a stable id: its own when unique, else the id of the one previous task with
 * the same content, else one derived from its content.
 */
export function assignTaskIds(tasks: readonly TaskInput[], previous: readonly Task[] = []): Task[] {
  const explicit = new Set(tasks.map((t) => t.id).filter((id): id is string => Boolean(id)));
  const omittedCounts = new Map<string, number>();
  for (const t of tasks) {
    if (!t.id) omittedCounts.set(t.content, (omittedCounts.get(t.content) ?? 0) + 1);
  }
  const reuse = new Map<number, string>();
  tasks.forEach((t, index) => {
    if (t.id || omittedCounts.get(t.content) !== 1) return;
    const matches = previous.filter((p) => p.content === t.content && !explicit.has(p.id));
    if (matches.length === 1 && matches[0]) reuse.set(index, matches[0].id);
  });
  const reserved = new Set([...explicit, ...reuse.values()]);
  const used = new Set<string>();
  const occurrences = new Map<string, number>();
  return tasks.map((t, index) => {
    const occurrence = (occurrences.get(t.content) ?? 0) + 1;
    occurrences.set(t.content, occurrence);
    const fallback = `task_${slug(t.content) || "item"}${occurrence > 1 ? `_${occurrence}` : ""}`;
    const reused = reuse.get(index);
    const id =
      (t.id && !used.has(t.id) ? t.id : undefined) ??
      (reused && !used.has(reused) ? reused : unique(fallback, used, reserved));
    used.add(id);
    return { id, content: t.content, status: t.status, activeForm: t.activeForm };
  });
}

/** Keeps one task in progress: the one at `keep` (the task just updated), else the first. */
function demoteExtraInProgress(tasks: Task[], keep?: number): { tasks: Task[]; demoted: boolean } {
  const active = tasks.flatMap((t, i) => (t.status === "in_progress" ? [i] : []));
  if (active.length <= 1) return { tasks, demoted: false };
  const kept = keep !== undefined && active.includes(keep) ? keep : active[0];
  return {
    tasks: tasks.map((t, i) =>
      t.status === "in_progress" && i !== kept ? { ...t, status: "pending" } : t,
    ),
    demoted: true,
  };
}

const ONE_IN_PROGRESS =
  "Only one task can be in_progress at a time; the others went back to pending.";
const ONE_IN_PROGRESS_REFUSED =
  "Only one task can be in_progress at a time. Mark one in_progress and the rest pending; the list was not changed.";

function icon(status: TaskStatus): string {
  return status === "completed" ? "✓" : status === "in_progress" ? "▸" : "○";
}

export function formatTaskList(tasks: readonly Task[]): string {
  const done = tasks.filter((t) => t.status === "completed").length;
  const active = tasks.find((t) => t.status === "in_progress");
  const lines = [`Tasks: [${done}/${tasks.length} completed]`];
  if (active) lines.push(`Currently: ${active.activeForm} (${active.id})`);
  for (const t of tasks) lines.push(`${icon(t.status)} [${t.status}] {id: ${t.id}} ${t.content}`);
  return lines.join("\n");
}

function ids(tasks: readonly Task[]): string {
  return `Available task IDs:\n${tasks.map((t) => `- ${t.id}: ${t.content} (${t.status})`).join("\n")}`;
}

function blank(value: string | undefined): boolean {
  return value !== undefined && value.trim() === "";
}

/** Like Mastra, a list with more than one task in progress is refused and nothing changes. */
export function writeTasks(input: readonly TaskInput[], previous: readonly Task[]): TaskResult {
  if (input.some((t) => blank(t.content) || blank(t.activeForm))) {
    return {
      tasks: [...previous],
      text: "Task content and activeForm must not be empty.",
      isError: true,
    };
  }
  if (input.filter((t) => t.status === "in_progress").length > 1) {
    return { tasks: [...previous], text: ONE_IN_PROGRESS_REFUSED, isError: true };
  }
  const tasks = assignTaskIds(input, previous);
  return { tasks, text: formatTaskList(tasks), isError: false };
}

export function updateTask(
  current: readonly Task[],
  patch: { id: string; content?: string; status?: TaskStatus; activeForm?: string },
): TaskResult {
  if (!patch.content && !patch.status && !patch.activeForm) {
    return {
      tasks: [...current],
      text: "Pass at least one of content, status or activeForm.",
      isError: true,
    };
  }
  if (blank(patch.content) || blank(patch.activeForm)) {
    return {
      tasks: [...current],
      text: "Task content and activeForm must not be empty.",
      isError: true,
    };
  }
  const index = current.findIndex((t) => t.id === patch.id);
  if (index === -1) {
    return {
      tasks: [...current],
      text: `Unknown task ID: ${patch.id}\n${ids(current)}`,
      isError: true,
    };
  }
  const next = current.map((t, i) =>
    i === index
      ? {
          ...t,
          ...(patch.content ? { content: patch.content } : {}),
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.activeForm ? { activeForm: patch.activeForm } : {}),
        }
      : t,
  );
  const { tasks, demoted } = demoteExtraInProgress(next, index);
  const text = formatTaskList(tasks);
  return { tasks, text: demoted ? `${text}\n${ONE_IN_PROGRESS}` : text, isError: false };
}

export function completeTask(current: readonly Task[], id: string): TaskResult {
  return updateTask(current, { id, status: "completed" });
}

export function checkTasks(current: readonly Task[]): TaskResult {
  if (current.length === 0) {
    return {
      tasks: [],
      text: "No tasks found. Use task_write to create a task list for multi-step work.",
      isError: false,
    };
  }
  const incomplete = current.filter((t) => t.status !== "completed");
  const head =
    incomplete.length === 0
      ? `All ${current.length} tasks completed.`
      : `${incomplete.length} of ${current.length} tasks incomplete: ${incomplete.map((t) => t.id).join(", ")}.`;
  return { tasks: [...current], text: `${head}\n${formatTaskList(current)}`, isError: false };
}

/** The hidden message that re-surfaces the list once earlier carriers left model context. */
export function renderSnapshot(tasks: readonly Task[]): string {
  return [
    `<current-task-list count="${tasks.length}">`,
    ...tasks.map((t) => `  ${icon(t.status)} [${t.status}] {id: ${t.id}} ${t.content}`),
    "</current-task-list>",
  ].join("\n");
}
