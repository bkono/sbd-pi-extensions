// One Mastra Code session (host SDK, in-process) over a list of prompts. Scratch DB per run;
// Bryan's auth and settings are read, never written. Events go to <out>/events.jsonl.
// Usage: node mc-run.mjs <cwd> <out> <promptsJsonFile>
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [cwd, out, promptsFile] = process.argv.slice(2);
const HOST =
  process.env.MC_HOST_NODE_MODULES ??
  path.join(
    process.env.HOME,
    ".local/share/mise/installs/node/25/lib/node_modules/mastracode/node_modules",
  );
const MODEL = process.env.EVAL_MC_MODEL ?? "openai/gpt-6.1-sol";
const THINKING = process.env.EVAL_THINKING ?? "medium";
const prompts = JSON.parse(readFileSync(promptsFile, "utf8"));
mkdirSync(out, { recursive: true });
const log = path.join(out, "events.jsonl");
writeFileSync(log, "");
const write = (e) => appendFileSync(log, `${JSON.stringify({ t: Date.now(), ...e })}\n`);
process.env.MASTRA_DB_PATH = path.join(out, "mc.db");

const sdk = await import(pathToFileURL(path.join(HOST, "@mastra/code-sdk/dist/index.js")).href);
const mc = await sdk.createMastraCode({
  cwd,
  initialState: { skipGlobalInstructions: true, thinkingLevel: THINKING, yolo: true },
  // Plain harness: no plugins (the sbd workflow), no user hooks, no MCP servers. Pi runs with
  // --no-skills --no-mcp so the two differ only in their native tools (and their OM).
  disablePlugins: true,
  disableHooks: true,
  disableMcp: true,
});
const { session } = mc;
await session.model.switch(MODEL);
write({ type: "harness_state", model: session.model.get?.(), thinking: THINKING });

let ends = 0;
let lastActivity = Date.now();
let text = "";
const SKIP = new Set([
  "display_state_changed",
  "tool_input_delta",
  "tool_input_start",
  "tool_input_end",
]);
session.subscribe((ev) => {
  lastActivity = Date.now();
  if (ev.type === "message_update") {
    if (ev.event?.type === "text-delta") text += ev.event.delta ?? "";
    return;
  }
  if (SKIP.has(ev.type)) return;
  if (ev.type === "agent_end") {
    ends += 1;
    write({ type: "assistant_text", text });
    text = "";
  }
  if (ev.type === "usage_update") {
    const { raw: _raw, ...usage } = ev.usage ?? {};
    write({ type: "usage_update", usage });
    return;
  }
  if (ev.type === "tool_start")
    write({ type: ev.type, toolCallId: ev.toolCallId, toolName: ev.toolName, args: ev.args });
  else if (ev.type === "tool_end")
    write({ type: ev.type, toolCallId: ev.toolCallId, result: ev.result, isError: ev.isError });
  else if (ev.type === "message_end" || ev.type === "message_start")
    write({ type: ev.type, role: ev.message?.role });
  else {
    let copy;
    try {
      copy = JSON.parse(JSON.stringify(ev));
    } catch {
      copy = { type: ev.type };
    }
    write(copy);
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMIT = Number(process.env.EVAL_PROMPT_TIMEOUT_MS ?? 25 * 60_000);
for (const [i, content] of prompts.entries()) {
  write({ type: "harness_prompt", index: i, message: content });
  const before = ends;
  const started = Date.now();
  await session.sendMessage({ content });
  while (Date.now() - started < LIMIT) {
    if (ends > before && Date.now() - lastActivity > 5000) break;
    await sleep(1000);
  }
  write({ type: "harness_prompt_done", index: i, timedOut: Date.now() - started >= LIMIT });
}
write({ type: "harness_stats", tokenUsage: session.getTokenUsage?.() ?? null });
process.exit(0);
