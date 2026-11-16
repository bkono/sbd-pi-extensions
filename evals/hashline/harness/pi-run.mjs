// One Pi RPC session over a list of prompts. Every event (minus streaming deltas) goes to
// <out>/events.jsonl. Usage: node pi-run.mjs <cwd> <out> <arm> <promptsJsonFile>
// arm: "pi-hashline" | "pi-stock". Both load the same sbd-pi-extensions set via -e; stock omits
// pi-hashline-readmap, so Pi's default built-ins (read, edit, write, bash) stay in place.
// EVAL_PI_EXT_ROOT picks the extensions checkout (default: the live main checkout); its git SHA
// and dirty state are recorded in the trace so a run is tied to the code it loaded.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [cwd, out, arm, promptsFile] = process.argv.slice(2);
const MODEL = process.env.EVAL_PI_MODEL ?? "openai-codex/gpt-6.1-sol";
const THINKING = process.env.EVAL_THINKING ?? "medium";
const EXT_ROOT =
  process.env.EVAL_PI_EXT_ROOT ??
  path.join(process.env.HOME, "src/github.com/bkono/sbd-pi-extensions");
const prompts = JSON.parse(readFileSync(promptsFile, "utf8"));
const exts = [
  "pi-om-extension",
  "pi-files-extension",
  "pi-answer-extension",
  "pi-exa-extension",
  "pi-minions",
  "pi-sbd-workflow",
  ...(arm === "pi-hashline" ? ["pi-hashline-readmap"] : []),
];
mkdirSync(out, { recursive: true });
const log = path.join(out, "events.jsonl");
writeFileSync(log, "");
const args = [
  "--mode",
  "rpc",
  "--session-dir",
  path.join(out, "sessions"),
  "--no-extensions",
  "--no-context-files",
  "--no-skills",
  "--no-mcp",
  ...exts.flatMap((e) => ["-e", path.join(EXT_ROOT, "packages", e, "index.ts")]),
  // Eval-only payload probe, loaded last so it sees the final payload.
  ...(process.env.EVAL_PROBE
    ? ["-e", path.join(path.dirname(new URL(import.meta.url).pathname), "probe-payload.ts")]
    : []),
];
const child = spawn("pi", args, {
  cwd,
  env: {
    ...process.env,
    PI_SKIP_VERSION_CHECK: "1",
    PI_OM_TRACE: path.join(out, "om-trace.jsonl"),
    EVAL_PAYLOAD_DIR: path.join(out, "payloads"),
  },
  stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map();
let buffer = "";
let seq = 0;
let settled = null;
const write = (e) =>
  writeFileSync(log, `${JSON.stringify({ t: Date.now(), ...e })}\n`, { flag: "a" });
child.stderr.on("data", (d) => write({ type: "stderr", text: String(d) }));
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "message_update" && event.type !== "tool_execution_update") write(event);
    if (event.type === "agent_settled" && settled) {
      settled();
      settled = null;
    }
    if (event.type === "response" && pending.has(event.id)) {
      pending.get(event.id)(event);
      pending.delete(event.id);
    }
  }
});
const send = (command) => {
  const id = `c${++seq}`;
  child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
};
const timeout = (ms, what) =>
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms));
const [provider, ...rest] = MODEL.split("/");
const m = await send({ type: "set_model", provider, modelId: rest.join("/") });
if (!m.success) throw new Error(`set_model: ${m.error}`);
await send({ type: "set_thinking_level", level: THINKING });
const state = await send({ type: "get_state" });
const git = (...a) => {
  try {
    return execFileSync("git", a, { cwd: EXT_ROOT, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
};
write({
  type: "harness_state",
  data: state.data,
  extensions: {
    root: EXT_ROOT,
    sha: git("rev-parse", "HEAD"),
    dirty: Boolean(git("status", "--porcelain")),
  },
});
for (const [i, message] of prompts.entries()) {
  write({ type: "harness_prompt", index: i, message });
  const done = new Promise((r) => {
    settled = r;
  });
  const res = await send({ type: "prompt", message });
  if (res.data?.disposition === "handled") continue;
  await Promise.race([
    done,
    timeout(Number(process.env.EVAL_PROMPT_TIMEOUT_MS ?? 25 * 60_000), `prompt ${i}`),
  ]);
  write({ type: "harness_prompt_done", index: i });
}
const stats = await send({ type: "get_session_stats" });
write({ type: "harness_stats", data: stats.data });
child.kill("SIGTERM");
process.exit(0);
