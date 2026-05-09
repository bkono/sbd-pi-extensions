import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import {
  countBadge,
  joinColumns,
  kv,
  normalizeSurfaceLines,
  padAnsi,
  priorityBadge,
  renderSurface,
  renderTabLine,
  sectionTitle,
  selectionMarker,
  statusStyle,
  styledAccent,
  styledDim,
  styledError,
  styledLabel,
  styledSuccess,
  styledValue,
  styledWarning,
  typeBadge,
  workerStatusStyle,
  wrapAnsiToWidth,
} from "../../tui/common.js";

// Passthrough theme for testing (matches createFakeUi behavior)
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as import("@mariozechner/pi-coding-agent").Theme;

describe("theme-aware content helpers", () => {
  it("styledLabel returns text", () => {
    expect(styledLabel(theme, "Status")).toBe("Status");
  });

  it("styledValue returns text", () => {
    expect(styledValue(theme, "open")).toBe("open");
  });

  it("styledAccent returns text", () => {
    expect(styledAccent(theme, "active")).toBe("active");
  });

  it("styledSuccess returns text", () => {
    expect(styledSuccess(theme, "passed")).toBe("passed");
  });

  it("styledWarning returns text", () => {
    expect(styledWarning(theme, "held")).toBe("held");
  });

  it("styledError returns text", () => {
    expect(styledError(theme, "failed")).toBe("failed");
  });

  it("styledDim returns text", () => {
    expect(styledDim(theme, "n/a")).toBe("n/a");
  });

  it("sectionTitle returns bolded text", () => {
    expect(sectionTitle(theme, "Workers")).toBe("Workers");
  });

  it("kv formats key: value", () => {
    expect(kv(theme, "status", "open")).toBe("status: open");
  });

  it("selectionMarker shows ▸ when selected", () => {
    expect(selectionMarker(theme, true)).toBe("▸");
    expect(selectionMarker(theme, false)).toBe(" ");
  });

  it("countBadge formats n label", () => {
    expect(countBadge(theme, 3, "ready")).toBe("3 ready");
    expect(countBadge(theme, 0, "blocked", "error")).toBe("0 blocked");
  });

  it("statusStyle maps issue statuses", () => {
    expect(statusStyle(theme, "open")).toBe("open");
    expect(statusStyle(theme, "in-progress")).toBe("in-progress");
    expect(statusStyle(theme, "closed")).toBe("closed");
    expect(statusStyle(theme, "done")).toBe("done");
    expect(statusStyle(theme, "landed")).toBe("landed");
    expect(statusStyle(theme, "verified")).toBe("verified");
    expect(statusStyle(theme, "blocked")).toBe("blocked");
    expect(statusStyle(theme, "deferred")).toBe("deferred");
    expect(statusStyle(theme, "unknown")).toBe("unknown");
  });

  it("workerStatusStyle maps worker statuses", () => {
    expect(workerStatusStyle(theme, "running")).toBe("running");
    expect(workerStatusStyle(theme, "launching")).toBe("launching");
    expect(workerStatusStyle(theme, "held")).toBe("held");
    expect(workerStatusStyle(theme, "attention")).toBe("attention");
    expect(workerStatusStyle(theme, "failed")).toBe("failed");
    expect(workerStatusStyle(theme, "landed")).toBe("landed");
    expect(workerStatusStyle(theme, "verified")).toBe("verified");
    expect(workerStatusStyle(theme, "exited")).toBe("exited");
    expect(workerStatusStyle(theme, "other")).toBe("other");
  });

  it("priorityBadge returns P-label", () => {
    expect(priorityBadge(theme, 0)).toBe("P0");
    expect(priorityBadge(theme, 1)).toBe("P1");
    expect(priorityBadge(theme, 2)).toBe("P2");
    expect(priorityBadge(theme, 3)).toBe("P3");
    expect(priorityBadge(theme, 4)).toBe("P4");
  });

  it("typeBadge returns type label", () => {
    expect(typeBadge(theme, "epic")).toBe("epic");
    expect(typeBadge(theme, "task")).toBe("task");
    expect(typeBadge(theme, "bug")).toBe("bug");
  });
});

describe("padAnsi", () => {
  it("pads short text to width", () => {
    const result = padAnsi("hi", 10);
    expect(result).toBe("hi        ");
    expect(result.length).toBe(10);
  });

  it("truncates text exceeding width to visible width", () => {
    const result = padAnsi("hello world", 5);
    expect(visibleWidth(result)).toBe(5);
  });

  it("handles zero width", () => {
    expect(padAnsi("test", 0)).toBe("");
  });
});

describe("wrapAnsiToWidth", () => {
  it("wraps long text into multiple padded lines", () => {
    const lines = wrapAnsiToWidth("hello world this is long text", 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBe(10);
    }
  });

  it("handles zero width", () => {
    expect(wrapAnsiToWidth("test", 0)).toEqual([""]);
  });
});

describe("normalizeSurfaceLines", () => {
  it("pads lines to width", () => {
    const result = normalizeSurfaceLines(["hi"], 10);
    expect(result).toHaveLength(1);
    expect(result[0].length).toBe(10);
  });

  it("fills remaining height with blank lines", () => {
    const result = normalizeSurfaceLines(["a", "b"], 5, 4);
    expect(result).toHaveLength(4);
    expect(result[2]).toBe("     ");
  });

  it("truncates with sentinel when exceeding height", () => {
    const result = normalizeSurfaceLines(["a", "b", "c", "d", "e"], 20, 3);
    expect(result).toHaveLength(3);
    expect(result[2]).toContain("… 3 more lines");
  });
});

describe("joinColumns", () => {
  it("joins left and right columns with gap", () => {
    const result = joinColumns({
      left: ["aaa", "bbb"],
      right: ["111", "222"],
      leftWidth: 5,
      rightWidth: 5,
      gap: 2,
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("aaa    111  ");
  });

  it("pads shorter column with empty lines", () => {
    const result = joinColumns({
      left: ["a"],
      right: ["1", "2", "3"],
      leftWidth: 3,
      rightWidth: 3,
    });
    expect(result).toHaveLength(3);
    // Left column's 2nd and 3rd rows should be empty (padded)
    expect(result[1].startsWith("   ")).toBe(true);
  });
});

describe("renderSurface", () => {
  it("renders rounded top border with embedded title", () => {
    const lines = renderSurface(theme, 40, { title: "Test" });
    expect(lines[0]).toContain("╭─");
    expect(lines[0]).toContain("Test");
    expect(lines[0]).toContain("╮");
  });

  it("renders rounded bottom border without footer", () => {
    const lines = renderSurface(theme, 40, { title: "Test" });
    const last = lines[lines.length - 1];
    expect(last).toContain("╰");
    expect(last).toContain("╯");
  });

  it("embeds footer in bottom border", () => {
    const lines = renderSurface(theme, 40, { title: "Test", footer: "help text" });
    const last = lines[lines.length - 1];
    expect(last).toContain("╰─");
    expect(last).toContain("help text");
    expect(last).toContain("╯");
  });

  it("renders subtitle content", () => {
    const lines = renderSurface(theme, 40, {
      title: "Test",
      subtitle: ["line one", "line two"],
    });
    const content = lines.join("\n");
    expect(content).toContain("line one");
    expect(content).toContain("line two");
  });

  it("renders sections with titles", () => {
    const lines = renderSurface(theme, 40, {
      title: "Test",
      sections: [{ title: "Section A", lines: ["content here"] }],
    });
    const content = lines.join("\n");
    expect(content).toContain("Section A");
    expect(content).toContain("content here");
  });

  it("applies bodyHeight truncation", () => {
    const lines = renderSurface(theme, 40, {
      title: "Test",
      subtitle: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
      bodyHeight: 5,
    });
    const content = lines.join("\n");
    expect(content).toContain("… ");
    expect(content).toContain("more lines");
  });
});

describe("renderTabLine", () => {
  it("renders selected tab with filled circle", () => {
    const result = renderTabLine(
      theme,
      [
        { label: "Issues", selected: true },
        { label: "Workers", selected: false },
      ],
      40,
    );
    expect(result).toContain("● Issues");
    expect(result).toContain("○ Workers");
  });
});
