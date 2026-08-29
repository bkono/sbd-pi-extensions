import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../constants.js";
import { renderStatusText } from "../../statusline.js";
import { createFakeExtensionContext, createFakeUi } from "../helpers/extension-harness.js";

describe("statusline", () => {
  it("renders mode and scope without worker counts", () => {
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui });
    const statusText = renderStatusText(
      ctx,
      { kind: "active", repoRoot: "/repo" },
      {
        mode: "run",
        scope: { kind: "epic", id: "BW-100", title: "Scoped epic" },
        updatedAt: "now",
        trackedWorkerIds: ["bw-101-worker"],
      },
      DEFAULT_CONFIG,
    );

    expect(statusText).toContain("bw");
    expect(statusText).toContain("run");
    expect(statusText).toContain("epic BW-100");
    expect(statusText).not.toContain("tracked");
    expect(statusText).not.toContain("workers");
    expect(statusText).not.toContain("held");
    expect(statusText).not.toContain("attention");
  });

  it("does not surface worker summaries even when leftover tracking ids exist", () => {
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui });
    const statusText = renderStatusText(
      ctx,
      { kind: "active", repoRoot: "/repo" },
      { mode: "interactive", scope: { kind: "none" }, updatedAt: "now" },
      DEFAULT_CONFIG,
    );

    expect(statusText).toContain("bw");
    expect(statusText).toContain("interactive");
    expect(statusText).not.toContain("workers");
  });
});
