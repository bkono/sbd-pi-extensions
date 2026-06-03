import { describe, expect, it } from "vitest";
import {
  buildContextHygieneMetadata,
  buildFileResource,
  buildReadRehydrateDescriptor,
  createContextHygieneTracker,
} from "../src/context-hygiene.js";

describe("context hygiene rehydrate metadata", () => {
  it("carries optional rehydrate descriptors beside required metadata fields", () => {
    const resource = buildFileResource("src/read.ts");
    const descriptor = buildReadRehydrateDescriptor({ path: "src/read.ts", offset: 1 });

    const metadata = buildContextHygieneMetadata({
      tool: "read",
      classification: "read-context",
      resources: [resource],
      rehydrate: descriptor,
    });

    expect(metadata).toEqual({
      schemaVersion: 1,
      tool: "read",
      classification: "read-context",
      resources: [resource],
      rehydrate: { tool: "read", input: { path: "src/read.ts", offset: 1 } },
    });
    expect((metadata as any).ptcValue).toBeUndefined();

    descriptor.input.path = "src/other.ts";
    expect(metadata.rehydrate).toEqual({ tool: "read", input: { path: "src/read.ts", offset: 1 } });

    const tracker = createContextHygieneTracker();
    const event = tracker.record(metadata, { resultId: "read-result-1" });
    expect(event.rehydrate).toEqual({ tool: "read", input: { path: "src/read.ts", offset: 1 } });
  });
});
