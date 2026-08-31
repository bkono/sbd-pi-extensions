import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { NUDGE_EVENTS, NudgeEventSchema, TASK_TYPES, TaskTypeSchema } from "../task-types.js";
import {
  OrchestratedTaskDescriptorSchema,
  OrchestrateInputSchema,
  OrchestrateResultSchema,
} from "../types.js";

function pairResults<T>(label: string, values: T[], accept: (value: T) => boolean) {
  const accepted: T[] = [];
  const rejected: T[] = [];
  for (const value of values) {
    (accept(value) ? accepted : rejected).push(value);
  }
  console.log(`${label} accepted:`, accepted);
  console.log(`${label} rejected:`, rejected);
  return { accepted, rejected };
}

const baseTask = {
  task: "Implement the registry refactor",
  description: "Registry refactor",
};

describe("TaskType schema", () => {
  it("is a provider-visible string enum of the five closed task types", () => {
    expect(TaskTypeSchema.enum).toEqual([...TASK_TYPES]);
    expect(TaskTypeSchema.enum).toHaveLength(5);
    expect(TaskTypeSchema.type).toBe("string");
    expect(TaskTypeSchema.enum).not.toContain("validation");
    expect(TaskTypeSchema.enum).not.toContain("completed");
  });

  it("accepts the five task types and rejects validation and junk", () => {
    const { accepted, rejected } = pairResults(
      "taskType",
      [
        "implementation",
        "fix",
        "reviewImplementation",
        "reviewScope",
        "investigateBlocker",
        "validation",
        "completed",
        "research",
        "junk",
        "",
        1,
      ],
      (value) => Check(TaskTypeSchema, value),
    );

    expect(accepted).toEqual([...TASK_TYPES]);
    expect(rejected).toEqual(["validation", "completed", "research", "junk", "", 1]);
  });
});

describe("NudgeEvent schema", () => {
  it("accepts the four event classes and rejects completed", () => {
    const { accepted, rejected } = pairResults(
      "nudgeEvent",
      ["settled", "aborted", "failed", "parentMessage", "completed", "running"],
      (value) => Check(NudgeEventSchema, value),
    );

    expect(accepted).toEqual([...NUDGE_EVENTS]);
    expect(rejected).toEqual(["completed", "running"]);
  });
});

describe("OrchestratedTaskDescriptor schema", () => {
  it("requires description on orchestrate task descriptors", () => {
    const { accepted, rejected } = pairResults(
      "description",
      [
        baseTask,
        { task: "Implement the registry refactor" },
        { description: "Registry refactor" },
        {
          task: "Implement the registry refactor",
          description: "Registry refactor",
          agent: "worker",
        },
      ],
      (value) => Check(OrchestratedTaskDescriptorSchema, value),
    );

    expect(accepted).toEqual([
      baseTask,
      {
        task: "Implement the registry refactor",
        description: "Registry refactor",
        agent: "worker",
      },
    ]);
    expect(rejected).toEqual([
      { task: "Implement the registry refactor" },
      { description: "Registry refactor" },
    ]);
  });

  it("keeps agent as a discovered-name string, not a closed enum", () => {
    const agentSchema = OrchestratedTaskDescriptorSchema.properties.agent;
    expect(agentSchema).not.toHaveProperty("enum");

    const { accepted, rejected } = pairResults(
      "agent",
      [
        { ...baseTask, agent: "worker" },
        { ...baseTask, agent: "investigate" },
        { ...baseTask, agent: "project-specific-agent-unknown-at-build" },
        { ...baseTask, agent: 42 },
      ],
      (value) => Check(OrchestratedTaskDescriptorSchema, value),
    );

    expect(accepted).toEqual([
      { ...baseTask, agent: "worker" },
      { ...baseTask, agent: "investigate" },
      { ...baseTask, agent: "project-specific-agent-unknown-at-build" },
    ]);
    expect(rejected).toEqual([{ ...baseTask, agent: 42 }]);
  });

  it("exposes agent and does not expose role, assignmentPermit, or protocol fields", () => {
    const keys = Object.keys(OrchestratedTaskDescriptorSchema.properties);
    expect(keys).toEqual(["task", "description", "agent", "taskType", "model", "domain"]);
    expect(keys).not.toContain("role");
    expect(keys).not.toContain("assignmentPermit");
    expect(keys).not.toContain("operationId");
    expect(keys).not.toContain("protocolStatus");
  });

  it("accepts closed taskType values on descriptors and rejects validation", () => {
    const { accepted, rejected } = pairResults(
      "descriptor.taskType",
      [
        { ...baseTask, taskType: "implementation" },
        { ...baseTask, taskType: "fix" },
        { ...baseTask, taskType: "reviewImplementation" },
        { ...baseTask, taskType: "reviewScope" },
        { ...baseTask, taskType: "investigateBlocker" },
        { ...baseTask, taskType: "validation" },
        { ...baseTask, taskType: "junk" },
      ],
      (value) => Check(OrchestratedTaskDescriptorSchema, value),
    );

    expect(accepted.map((value) => value.taskType)).toEqual([...TASK_TYPES]);
    expect(rejected.map((value) => value.taskType)).toEqual(["validation", "junk"]);
  });
});

describe("OrchestrateInput schema", () => {
  it("accepts optional groupId/cwd and requires at least one described task", () => {
    const { accepted, rejected } = pairResults(
      "orchestrateInput",
      [
        { tasks: [baseTask] },
        { groupId: "grp-1", tasks: [baseTask] },
        {
          cwd: "/repo",
          tasks: [{ ...baseTask, agent: "worker", taskType: "implementation" as const }],
        },
        { tasks: [] },
        { groupId: "grp-1" },
        { tasks: [{ task: "missing description" }] },
      ],
      (value) => Check(OrchestrateInputSchema, value),
    );

    expect(accepted).toHaveLength(3);
    expect(rejected).toHaveLength(3);
  });
});

describe("OrchestrateResult schema", () => {
  it("locks accepted to starting and records rejected index/reason pairs", () => {
    const starting = {
      groupId: "grp-1",
      accepted: [{ childId: "mn-1", description: "Registry refactor", state: "starting" as const }],
      rejected: [{ index: 1, reason: "duplicate workItemId" }],
    };
    const completed = {
      groupId: "grp-1",
      accepted: [{ childId: "mn-1", description: "Registry refactor", state: "completed" }],
      rejected: [],
    };

    const { accepted, rejected } = pairResults(
      "orchestrateResult",
      [starting, completed],
      (value) => Check(OrchestrateResultSchema, value),
    );

    expect(accepted).toEqual([starting]);
    expect(rejected).toEqual([completed]);
  });
});
