import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { SubsessionManager } from "../../../../pi-minions/src/subsessions/manager.js";
import type { CreateMinionSessionOptions } from "../../../../pi-minions/src/subsessions/types.js";
import type { AgentConfig } from "../../../../pi-minions/src/types.js";
import { ScriptedChildSession } from "./scripted-child.js";

const roots: string[] = [];

const config: AgentConfig = {
  name: "ephemeral",
  description: "scripted child",
  systemPrompt: "Test child.",
  source: "ephemeral",
  filePath: "",
};

function options(id: string, cwd: string): CreateMinionSessionOptions {
  return {
    id,
    name: "scripted",
    task: "keep the initial prompt live",
    config,
    spawnedBy: "test",
    cwd,
    modelRegistry: {} as ModelRegistry,
    parentToolNames: ["read"],
    toolSyncEnabled: false,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ScriptedChildSession production run-state truth", () => {
  it("routes active-session delivery through followUp while the initial prompt is live", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "scripted-child-"));
    roots.push(cwd);
    const session = new ScriptedChildSession(["read"]);
    const manager = new SubsessionManager(cwd, join(cwd, "parent.jsonl"), undefined, {
      createChildRuntime: async () => ({
        runtime: { session, dispose: () => session.dispose() },
        sessionPath: join(cwd, "child.jsonl"),
      }),
    });

    const handle = await manager.startChild(options("mn-scripted", cwd));
    expect(session.isStreaming).toBe(true);

    const delivery = handle.followUp("active overlap notice");
    await expect.poll(() => session.followUps.length).toBe(1);

    expect(session.followUps).toEqual(["active overlap notice"]);
    expect(session.promptCalls).toBe(1);

    handle.abort();
    await delivery;
    await expect(handle.wait()).resolves.toMatchObject({ class: "aborted" });
    expect(session.isStreaming).toBe(false);
  });

  it("reports non-streaming after normal settlement", async () => {
    const session = new ScriptedChildSession(["read"]);
    const prompt = session.prompt("initial");
    expect(session.isStreaming).toBe(true);

    session.finishWithProse("opaque terminal prose");

    await prompt;
    expect(session.isStreaming).toBe(false);
  });
});
