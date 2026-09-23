import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../constants.js";
import { renderStatusText } from "../../statusline.js";
import { createFakeExtensionContext, createFakeUi } from "../helpers/extension-harness.js";

describe("statusline", () => {
  it("renders the supplied scope id", () => {
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui });
    const statusText = renderStatusText(
      ctx,
      { kind: "active", repoRoot: "/repo" },
      {
        mode: "run",
        scope: { kind: "epic", id: "BW-100", title: "Scoped epic" },
        updatedAt: "now",
      },
      DEFAULT_CONFIG,
    );

    expect(statusText).toContain("BW-100");
  });
});
