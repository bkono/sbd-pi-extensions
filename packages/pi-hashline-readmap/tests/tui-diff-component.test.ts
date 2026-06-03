import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import type { DiffData } from "../src/diff-data.js";
import { DiffPreviewComponent } from "../src/tui-diff-component.js";

const identityTheme = { fg: (_kind: string, text: string) => text } as any;

const longText =
  "the quick brown fox jumps over the lazy dog and then keeps going far past the right edge of the viewport without stopping";

const longDiffData: DiffData = {
  version: 1,
  entries: [
    { kind: "remove", oldLine: 1, text: longText },
    { kind: "add", newLine: 1, text: longText.toUpperCase() },
    { kind: "context", oldLine: 2, newLine: 2, text: "tail" },
  ],
  stats: { added: 1, removed: 1, context: 1 },
  blockRanges: [{ kind: "add", startLine: 1, endLine: 2 }],
};

describe("DiffPreviewComponent", () => {
  it("renders at the width passed to render() rather than a baked-in fallback", () => {
    const comp = new DiffPreviewComponent({
      prefixLines: ["edit /tmp/file.txt (1 edit)", "↳ pending edit"],
      diffData: longDiffData,
      theme: identityTheme,
      expanded: true,
    });
    const at60 = comp.render(60);
    const at160 = comp.render(160);
    for (const line of at60) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    for (const line of at160) expect(visibleWidth(line)).toBeLessThanOrEqual(160);
    // At 60 columns we must be in unified mode (>= 50 and < 100) and content wraps.
    expect(at60.join("\n")).toContain("↳ diff +1 -1 • 1 hunk • 1 file • unified");
    expect(at60.length).toBeGreaterThan(at160.length);
    // No row should be truncated with an ellipsis when wrap is feasible.
    expect(at60.some((line) => line.endsWith("..."))).toBe(false);
  });

  it("respects expanded=false by omitting the body and showing a hidden hint", () => {
    const comp = new DiffPreviewComponent({
      prefixLines: ["write sample.txt", "↳ pending overwrite"],
      diffData: longDiffData,
      theme: identityTheme,
      expanded: false,
    });
    const lines = comp.render(120);
    const text = lines.join("\n");
    expect(text).toContain("write sample.txt");
    expect(text).toContain("↳ pending overwrite");
    // In collapsed mode the diff renderer emits the hidden-content hint
    // rather than the body rows.
    expect(text).not.toContain("▌- 1 │ ");
    expect(text).not.toContain("▌+ 1 │ ");
    expect(text).toMatch(/^…|^… \(/m);
  });

  it("invalidates cached output when update() changes inputs", () => {
    const comp = new DiffPreviewComponent({
      prefixLines: ["first"],
      diffData: longDiffData,
      theme: identityTheme,
      expanded: true,
    });
    const first = comp.render(80).join("\n");
    comp.update({
      prefixLines: ["second"],
      diffData: longDiffData,
      theme: identityTheme,
      expanded: true,
    });
    const second = comp.render(80).join("\n");
    expect(first).toContain("first");
    expect(second).toContain("second");
    expect(second).not.toContain("first");
  });
});
