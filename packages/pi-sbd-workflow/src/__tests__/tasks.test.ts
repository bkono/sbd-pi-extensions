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

  it("keeps one task in progress: write refuses two, update moves it", () => {
    const refused = writeTasks([t("a", "in_progress"), t("b", "in_progress")], []);
    expect(refused).toMatchObject({ isError: true, tasks: [] });
    expect(refused.text).toContain("the list was not changed");

    const written = writeTasks([t("a", "in_progress"), t("b")], []);
    const moved = updateTask(written.tasks, { id: "task_b", status: "in_progress" });
    expect(moved.tasks.map((x) => x.status)).toEqual(["pending", "in_progress"]);
    expect(moved.text).toContain("the others went back to pending");
  });

  it("refuses empty text and updates that change nothing", () => {
    expect(writeTasks([{ ...t("a"), content: " " }], []).isError).toBe(true);
    const { tasks } = writeTasks([t("a")], []);
    expect(updateTask(tasks, { id: "task_a" }).isError).toBe(true);
    expect(updateTask(tasks, { id: "task_a", activeForm: "" }).isError).toBe(true);
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
