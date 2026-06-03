import { describe, expect, it } from "vitest";
import { buildBashCommandState } from "../src/bash-command-state.js";
import {
  buildCommandResource,
  buildContextHygieneMetadata,
  buildFileResource,
  createContextHygieneTracker,
} from "../src/context-hygiene.js";

function bashMetadata(command: string, text: string, isError = false) {
  return buildContextHygieneMetadata({
    tool: "bash",
    classification: "command-output",
    resources: [buildCommandResource(command)],
    commandState: buildBashCommandState({ command, text, isError }),
  });
}

describe("Bash context hygiene report candidates", () => {
  it("marks git status and git diff stale after mutations but leaves git log live", () => {
    const tracker = createContextHygieneTracker();
    const file = buildFileResource("src/example.ts");

    tracker.record(bashMetadata("git status --short", " M src/example.ts"), {
      resultId: "status-before",
    });
    tracker.record(
      bashMetadata("git diff -- src/example.ts", "diff --git a/src/example.ts b/src/example.ts"),
      { resultId: "diff-before" },
    );
    tracker.record(bashMetadata("git log --oneline -5", "abc123 feat"), { resultId: "log-before" });
    tracker.record(
      buildContextHygieneMetadata({ tool: "edit", classification: "mutation", resources: [file] }),
      { resultId: "edit-file" },
    );

    const report = tracker.generateReport();
    const staleIds = report.staleCandidates.flatMap((candidate) =>
      candidate.staleResults.map((record) => record.originalResultId),
    );

    expect(staleIds).toContain("status-before");
    expect(staleIds).toContain("diff-before");
    expect(staleIds).not.toContain("log-before");
    expect(report.staleCandidates.flatMap((candidate) => candidate.staleResults)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          originalTool: "bash",
          originalResultId: "status-before",
          reason: "bash-repo-state-after-mutation",
        }),
        expect.objectContaining({
          originalTool: "bash",
          originalResultId: "diff-before",
          reason: "bash-repo-state-after-mutation",
        }),
      ]),
    );
  });

  it("marks failed verification stale only after exact successful rerun", () => {
    const tracker = createContextHygieneTracker();

    tracker.record(bashMetadata("npm test", "FAIL tests/all.test.ts", true), {
      resultId: "test-all-fail",
    });
    tracker.record(bashMetadata("npm test -- tests/a.test.ts", "PASS tests/a.test.ts"), {
      resultId: "test-a-pass",
    });
    tracker.record(bashMetadata("npm test", "PASS tests/all.test.ts"), {
      resultId: "test-all-pass",
    });

    const report = tracker.generateReport();
    const staleIds = report.staleCandidates.flatMap((candidate) =>
      candidate.staleResults.map((record) => record.originalResultId),
    );

    expect(staleIds).toContain("test-all-fail");
    expect(staleIds).not.toContain("test-a-pass");
    expect(report.staleCandidates.flatMap((candidate) => candidate.staleResults)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          originalResultId: "test-all-fail",
          invalidatingMutationResultId: "test-all-pass",
          reason: "bash-verification-success-rerun",
        }),
      ]),
    );
  });

  it("retires older successful routine results with a same-command frontier", () => {
    const tracker = createContextHygieneTracker();

    tracker.record(bashMetadata("git log --oneline -5", "old history"), { resultId: "log-old" });
    tracker.record(bashMetadata("git log --oneline -5", "new history"), { resultId: "log-new" });
    tracker.record(
      bashMetadata("node debug-script.js", "TypeError: boom\n    at main (debug-script.js:1:1)"),
      { resultId: "debug-old" },
    );
    tracker.record(
      bashMetadata("node debug-script.js", "TypeError: boom\n    at main (debug-script.js:1:1)"),
      { resultId: "debug-new" },
    );

    const report = tracker.generateReport();
    const retiredIds = report.retirementCandidates.flatMap(
      (candidate) => candidate.retiredResults?.map((record) => record.originalResultId) ?? [],
    );

    expect(retiredIds).toContain("log-old");
    expect(retiredIds).not.toContain("log-new");
    expect(retiredIds).not.toContain("debug-old");
    expect(report.retirementCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "same-command-success-rerun",
          supersededByEventId: expect.any(Number),
        }),
      ]),
    );
  });
});
