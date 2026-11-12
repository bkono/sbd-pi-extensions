import { describe, expect, it } from "vitest";
import {
  assignTaskIds,
  checkTasks,
  completeTask,
  renderSnapshot,
  type Task,
  updateTask,
  writeTasks,
} from "../tasks.js";

const t = (content: string, status: Task["status"] = "pending") => ({
  content,
  status,
  activeForm: `Doing ${content}`,
});

describe("task list", () => {
  it("assigns stable ids: explicit, reused by content, else derived and unique", () => {
    const first = assignTaskIds([t("Fix the auth bug"), t("Fix the auth bug"), t("!!!")]);
    expect(first.map((x) => x.id)).toEqual([
      "task_fix_the_auth_bug",
      "task_fix_the_auth_bug_2",
      "task_item",
    ]);
    const previous = assignTaskIds([t("Write tests"), { ...t("Ship"), id: "ship" }]);
    const again = assignTaskIds(
      [t("Write tests"), t("Ship"), { ...t("New"), id: "ship" }],
      previous,
    );
    expect(again.map((x) => x.id)).toEqual(["task_write_tests", "task_ship", "ship"]);
  });

  it("keeps one task in progress", () => {
    const written = writeTasks([t("a", "in_progress"), t("b", "in_progress")], []);
    expect(written.tasks.map((x) => x.status)).toEqual(["in_progress", "pending"]);
    expect(written.text).toContain("Only one task can be in_progress");

    const moved = updateTask(written.tasks, { id: "task_b", status: "in_progress" });
    expect(moved.tasks.map((x) => x.status)).toEqual(["pending", "in_progress"]);
  });

  it("updates and completes by id, and reports unknown ids with the available ones", () => {
    const { tasks } = writeTasks([t("a"), t("b")], []);
    expect(completeTask(tasks, "task_a").tasks[0]?.status).toBe("completed");
    expect(updateTask(tasks, { id: "task_b", content: "bee" }).tasks[1]?.content).toBe("bee");
    const missing = completeTask(tasks, "nope");
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("- task_a: a (pending)");
  });

  it("checks completion and renders a snapshot", () => {
    expect(checkTasks([]).text).toContain("No tasks found");
    const { tasks } = writeTasks([t("a", "completed"), t("b", "in_progress")], []);
    expect(checkTasks(tasks).text).toContain("1 of 2 tasks incomplete: task_b.");
    expect(checkTasks(completeTask(tasks, "task_b").tasks).text).toContain(
      "All 2 tasks completed.",
    );
    expect(renderSnapshot(tasks)).toBe(
      [
        '<current-task-list count="2">',
        "  ✓ [completed] {id: task_a} a",
        "  ▸ [in_progress] {id: task_b} b",
        "</current-task-list>",
      ].join("\n"),
    );
  });
});
