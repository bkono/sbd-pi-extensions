import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFleetWidgetController,
  FLEET_WIDGET_KEY,
  FLEET_WIDGET_ROW_CAP,
  FleetWidgetComponent,
} from "../fleet-widget.js";
import registerMinions from "../index.js";
import { OrchestrationGroupState } from "../orchestration/group-state.js";
import { AgentTree } from "../tree.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-minions-fleet-widget-"));
  tempDirs.push(dir);
  return dir;
}

function mutableTheme(label = "a"): { theme: Theme; setLabel: (next: string) => void } {
  let current = label;
  return {
    setLabel: (next) => {
      current = next;
    },
    theme: {
      fg: (_color: string, text: string) =>
        `\u001b[${current === "a" ? "31" : "32"}m${text}\u001b[0m`,
      bold: (text: string) => text,
    } as unknown as Theme,
  };
}

function openGroup(groups: OrchestrationGroupState, groupId: string): void {
  groups.commitGroup({ groupId, cwd: process.cwd() });
}

function renderWidget(
  tree: AgentTree,
  groups: OrchestrationGroupState,
  width: number,
  theme = mutableTheme().theme,
): string[] {
  return new FleetWidgetComponent(tree, groups, theme).render(width);
}

function plain(lines: string[]): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: test helper removes ANSI SGR only
  return lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
}

describe("FleetWidgetComponent", () => {
  it("renders active count, open group, and useful wide identity fields", () => {
    const tree = new AgentTree();
    const groups = new OrchestrationGroupState();
    tree.add("mn-orch", "otto", "full internal prompt", {
      agentName: "worker",
      kind: "orchestrated",
      groupId: "grp-1234",
      taskType: "implementation",
      description: "Add auth guard",
      status: "pending",
    });
    tree.add("mn-spawn", "mel", "Review the auth commit", {
      agentName: "reviewer",
    });
    tree.applyActivityEvent("mn-spawn", {
      type: "tool_start",
      toolName: "read",
      args: { path: "src/auth.ts" },
    });
    openGroup(groups, "grp-1234");

    const lines = plain(renderWidget(tree, groups, 120));
    expect(lines[0]).toContain("2 active · group grp-1234");
    expect(lines[1]).toMatch(/otto\s+worker\/implementation\s+Add auth guard\s+pending · starting/);
    expect(lines[2]).toMatch(/mel\s+reviewer\s+Review the auth commit\s+→ read src\/auth\.ts/);
    expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
  });

  it("renders every trusted phase and distinguishes pending from running", () => {
    const tree = new AgentTree();
    const groups = new OrchestrationGroupState();
    const phases = ["starting", "thinking", "tool", "waiting", "settling"] as const;

    phases.forEach((phase, index) => {
      const id = `mn-${index}`;
      tree.add(id, `m${index}`, `task ${index}`, { status: index === 0 ? "pending" : "running" });
      if (phase === "thinking") tree.applyActivityEvent(id, { type: "thinking" });
      if (phase === "tool") {
        tree.applyActivityEvent(id, {
          type: "tool_start",
          toolName: "grep",
          args: { pattern: "x" },
        });
      }
      if (phase === "waiting") tree.applyActivityEvent(id, { type: "waiting" });
      if (phase === "settling") tree.applyActivityEvent(id, { type: "settling" });
    });

    const text = plain(renderWidget(tree, groups, 100)).join("\n");
    expect(text).toContain("pending · starting");
    expect(text).toContain("thinking");
    expect(text).toContain('→ grep {"pattern":"x"}');
    expect(text).toContain("waiting on parent");
    expect(text).toContain("settling");
  });

  it("obeys every supplied width with ANSI-aware truncation", () => {
    const tree = new AgentTree();
    const groups = new OrchestrationGroupState();
    tree.add("mn-wide", "a-very-long-minion-name", "A long task summary that must be bounded", {
      agentName: "investigate",
    });
    tree.applyActivityEvent("mn-wide", {
      type: "tool_start",
      toolName: "bash",
      args: { command: "npm run test -- --very-long-argument" },
    });

    for (const width of [0, 1, 4, 9, 18, 31, 48, 80]) {
      const lines = renderWidget(tree, groups, width);
      expect(lines.length).toBe(2);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("uses a deterministic modest cap and a bounded +N more row", () => {
    const tree = new AgentTree();
    const groups = new OrchestrationGroupState();
    for (let i = FLEET_WIDGET_ROW_CAP + 2; i >= 1; i--) {
      const id = `mn-${String(i).padStart(2, "0")}`;
      const node = tree.add(id, `name-${i}`, `task-${i}`);
      node.startTime = 100;
    }

    const lines = plain(renderWidget(tree, groups, 36));
    expect(lines).toHaveLength(FLEET_WIDGET_ROW_CAP + 2);
    expect(lines.slice(1, 1 + FLEET_WIDGET_ROW_CAP).join("\n")).toContain("name-1");
    expect(lines.slice(1, 1 + FLEET_WIDGET_ROW_CAP).join("\n")).not.toContain(
      `name-${FLEET_WIDGET_ROW_CAP + 1}`,
    );
    expect(lines.at(-1)).toContain("+2 more");
    expect(lines.every((line) => visibleWidth(line) <= 36)).toBe(true);
  });

  it("sanitizes identity text and never renders narrative previews", () => {
    const tree = new AgentTree();
    const groups = new OrchestrationGroupState();
    tree.add("mn-hostile", "bad\u001b[31m name", "task\nwith controls", {
      description: "\u001b]8;;https://evil.example\u0007desc\u001b]8;;\u0007 hidden",
    });
    tree.applyActivityEvent("mn-hostile", {
      type: "narrative",
      text: "untrusted streamed child prose",
    });

    const text = plain(renderWidget(tree, groups, 100)).join("\n");
    expect(text).toContain("bad name");
    expect(text).toContain("desc hidden");
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("untrusted streamed child prose");
  });

  it("rebuilds themed output after invalidation instead of retaining pre-themed ANSI", () => {
    const tree = new AgentTree();
    const groups = new OrchestrationGroupState();
    tree.add("mn-1", "otto", "work");
    const { theme, setLabel } = mutableTheme("a");
    const widget = new FleetWidgetComponent(tree, groups, theme);

    const first = widget.render(60);
    setLabel("b");
    expect(widget.render(60)).toBe(first);
    widget.invalidate();
    const second = widget.render(60);
    expect(second).not.toBe(first);
    expect(second.join("\n")).toContain("\u001b[32m");
    expect(second.join("\n")).not.toContain("\u001b[31m");
  });
});

interface FakeUiHarness {
  ui: ExtensionContext["ui"];
  tui: Pick<TUI, "requestRender">;
  requestRender: ReturnType<typeof vi.fn>;
  setWidget: ReturnType<typeof vi.fn>;
  component: () => (Component & { dispose?(): void }) | undefined;
}

function fakeUi(): FakeUiHarness {
  const requestRender = vi.fn();
  const tui = { requestRender } as Pick<TUI, "requestRender">;
  const { theme } = mutableTheme();
  let component: (Component & { dispose?(): void }) | undefined;
  const setWidget = vi.fn(
    (
      _key: string,
      content:
        | string[]
        | ((tui: TUI, theme: Theme) => Component & { dispose?(): void })
        | undefined,
    ) => {
      component?.dispose?.();
      component = typeof content === "function" ? content(tui as TUI, theme) : undefined;
      requestRender();
    },
  );
  const ui = {
    theme,
    setWidget,
    setStatus: vi.fn(),
    setFooter: vi.fn(),
  } as unknown as ExtensionContext["ui"];
  return { ui, tui, requestRender, setWidget, component: () => component };
}

describe("fleet widget reactivity and lifecycle", () => {
  it("appears on tree updates, rerenders activity, and clears on the last terminal child", () => {
    const tree = new AgentTree();
    const groups = new OrchestrationGroupState();
    const harness = fakeUi();
    const controller = createFleetWidgetController(tree, groups, harness.ui);

    expect(tree.listenerCount()).toBe(1);
    tree.add("mn-1", "otto", "work", { status: "pending" });
    expect(harness.setWidget).toHaveBeenCalledWith(FLEET_WIDGET_KEY, expect.any(Function), {
      placement: "aboveEditor",
    });
    const component = harness.component();
    expect(component?.render(80)).toHaveLength(2);

    const rendersBefore = harness.requestRender.mock.calls.length;
    tree.markLiveHandle("mn-1");
    tree.applyActivityEvent("mn-1", { type: "waiting" });
    expect(harness.requestRender.mock.calls.length).toBeGreaterThan(rendersBefore);
    expect(plain(component?.render(80) ?? []).join("\n")).toContain("waiting on parent");

    tree.updateStatus("mn-1", "completed", 0);
    expect(harness.setWidget).toHaveBeenLastCalledWith(FLEET_WIDGET_KEY, undefined);
    expect(component?.render(80)).toEqual([]);

    controller.destroy();
    expect(tree.listenerCount()).toBe(0);
  });

  it.each([
    "new",
    "resume",
    "fork",
    "reload",
    "quit",
  ])("%s replacement cleanup unsubscribes, clears, and makes stale tree/component inert", () => {
    const oldTree = new AgentTree();
    const oldGroups = new OrchestrationGroupState();
    const oldUi = fakeUi();
    const oldController = createFleetWidgetController(oldTree, oldGroups, oldUi.ui);
    oldTree.add("old", "old-minion", "old task");
    const staleComponent = oldUi.component();

    oldController.destroy();
    const callsAfterDestroy = oldUi.requestRender.mock.calls.length;
    expect(oldTree.listenerCount()).toBe(0);
    expect(oldUi.setWidget).toHaveBeenLastCalledWith(FLEET_WIDGET_KEY, undefined);
    expect(staleComponent?.render(80)).toEqual([]);

    oldTree.applyActivityEvent("old", { type: "waiting" });
    expect(oldUi.requestRender).toHaveBeenCalledTimes(callsAfterDestroy);

    const nextTree = new AgentTree();
    const nextUi = fakeUi();
    const nextController = createFleetWidgetController(
      nextTree,
      new OrchestrationGroupState(),
      nextUi.ui,
    );
    nextTree.add("new", "new-minion", "new task");
    expect(nextUi.component()?.render(80)).toHaveLength(2);
    nextController.destroy();
  });
});

function extensionHarness() {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    getThinkingLevel: () => "off",
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as ExtensionAPI;
  registerMinions(pi);
  return {
    async emit(event: string, ctx: ExtensionContext, payload: unknown = {}) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
}

function fakeContext(cwd: string, uiHarness: FakeUiHarness): ExtensionContext {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    model: undefined,
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: {
      getSessionFile: () => join(cwd, "parent.jsonl"),
      getEntries: () => [],
      getCwd: () => cwd,
      getSessionName: () => undefined,
    },
    getContextUsage: () => undefined,
    ui: uiHarness.ui,
  } as unknown as ExtensionContext;
}

describe("extension session ownership", () => {
  it("defensively clears the prior session widget on replacement and shutdown", async () => {
    const extension = extensionHarness();
    const firstUi = fakeUi();
    const secondUi = fakeUi();
    const first = fakeContext(tempDir(), firstUi);
    const second = fakeContext(tempDir(), secondUi);

    await extension.emit("session_start", first, { reason: "startup" });
    await extension.emit("session_start", second, { reason: "resume" });
    expect(firstUi.setWidget).toHaveBeenCalledWith(FLEET_WIDGET_KEY, undefined);

    await extension.emit("session_shutdown", second, { reason: "reload" });
    expect(secondUi.setWidget).toHaveBeenCalledWith(FLEET_WIDGET_KEY, undefined);
  });
});
