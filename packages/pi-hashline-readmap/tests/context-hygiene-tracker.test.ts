import { describe, expect, it } from "vitest";
import {
  buildCommandResource,
  buildContextHygieneMetadata,
  buildFileResource,
  buildReadRehydrateDescriptor,
  createContextHygieneTracker,
  getContextHygieneTracker,
  resetContextHygieneTracker,
} from "../src/context-hygiene.js";

describe("context hygiene telemetry tracker", () => {
  it("reports reuse, reruns, mutation staleness, retirement candidates, and churn deterministically", () => {
    const fileResource = buildFileResource("src/read.ts");
    const commandResource = buildCommandResource("npm test");
    const readRehydrate = buildReadRehydrateDescriptor({
      path: "src/read.ts",
      symbol: "buildReadOutput",
    });
    const tracker = createContextHygieneTracker();

    tracker.record(
      buildContextHygieneMetadata({
        tool: "read",
        classification: "read-context",
        resources: [fileResource],
        rehydrate: readRehydrate,
      }),
      { resultId: "read-1" },
    );
    tracker.record(
      buildContextHygieneMetadata({
        tool: "read",
        classification: "read-context",
        resources: [fileResource],
      }),
      { resultId: "read-2" },
    );
    tracker.record(
      buildContextHygieneMetadata({
        tool: "edit",
        classification: "mutation",
        resources: [fileResource],
      }),
      { resultId: "edit-1" },
    );
    tracker.record(
      buildContextHygieneMetadata({
        tool: "bash",
        classification: "command-output",
        resources: [commandResource],
      }),
      { resultId: "bash-1" },
    );
    tracker.record(
      buildContextHygieneMetadata({
        tool: "bash",
        classification: "command-output",
        resources: [commandResource],
      }),
      { resultId: "bash-2" },
    );

    expect(tracker.generateReport()).toEqual({
      eventCount: 5,
      resourceCount: 2,
      readReuse: [
        {
          resourceKey: "file:src/read.ts",
          count: 2,
          eventIds: [1, 2],
          resultIds: ["read-1", "read-2"],
        },
      ],
      commandReruns: [
        {
          resourceKey: "command:test:npm test",
          count: 2,
          eventIds: [4, 5],
          resultIds: ["bash-1", "bash-2"],
        },
      ],
      mutationAfterRead: [
        {
          resourceKey: "file:src/read.ts",
          readEventIds: [1, 2],
          mutationEventId: 3,
        },
      ],
      staleCandidates: [
        {
          resourceKey: "file:src/read.ts",
          staleEventIds: [1, 2],
          mutationEventId: 3,
          reason: "mutation-after-read",
          staleResults: [
            {
              status: "stale",
              originalTool: "read",
              originalEventId: 1,
              originalResultId: "read-1",
              staleResourceKeys: ["file:src/read.ts"],
              invalidatingMutationEventId: 3,
              invalidatingMutationResultId: "edit-1",
              reason: "mutation-after-read",
              rehydrate: readRehydrate,
            },
            {
              status: "stale",
              originalTool: "read",
              originalEventId: 2,
              originalResultId: "read-2",
              staleResourceKeys: ["file:src/read.ts"],
              invalidatingMutationEventId: 3,
              invalidatingMutationResultId: "edit-1",
              reason: "mutation-after-read",
            },
          ],
        },
      ],
      retirementCandidates: [
        {
          resourceKey: "command:test:npm test",
          eventIds: [4],
          supersededByEventId: 5,
          reason: "command-rerun",
        },
      ],
      churn: {
        byClassification: {
          "command-output": 2,
          mutation: 1,
          "read-context": 2,
          "search-context": 0,
        },
        byTool: {
          bash: 2,
          edit: 1,
          read: 2,
        },
        uniqueResourcesSeen: 2,
      },
    });
  });

  it("returns a shared global tracker", () => {
    expect(getContextHygieneTracker()).toBe(getContextHygieneTracker());
  });

  it("bounds retained event history and can reset the shared tracker", () => {
    const tracker = createContextHygieneTracker({ maxEvents: 2 });
    const resource = buildFileResource("src/read.ts");
    const metadata = buildContextHygieneMetadata({
      tool: "read",
      classification: "read-context",
      resources: [resource],
    });

    tracker.record(metadata, { resultId: "read-1" });
    tracker.record(metadata, { resultId: "read-2" });
    tracker.record(metadata, { resultId: "read-3" });

    expect(tracker.generateReport().readReuse).toEqual([
      {
        resourceKey: resource.key,
        count: 2,
        eventIds: [2, 3],
        resultIds: ["read-2", "read-3"],
      },
    ]);

    const reset = resetContextHygieneTracker({ maxEvents: 2 });
    expect(getContextHygieneTracker()).toBe(reset);
    expect(reset.generateReport().eventCount).toBe(0);
  });
});
