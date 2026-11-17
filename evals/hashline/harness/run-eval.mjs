// Runs the task matrix: every task x arm x rep in a fresh fixture copy, then grades each run with
// the hidden tests. Usage:
//   node run-eval.mjs <outDir> [--tasks t1-explore,t2-bugfix] [--arms mc,sbd-om-hashline,sbd-om]
//                     [--reps 2] [--concurrency 6] [--model sol|opus]
// --model picks the same model for every arm; run each model into its own outDir.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const evalRoot = path.dirname(here);
const argv = process.argv.slice(2);
const outDir = path.resolve(argv[0]);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const spec = JSON.parse(readFileSync(path.join(evalRoot, "tasks.json"), "utf8"));
const tasks = opt("tasks", Object.keys(spec.tasks).join(",")).split(",");
const arms = opt("arms", "mc,sbd-om-hashline,sbd-om").split(",");
const reps = Number(opt("reps", "2"));
const concurrency = Number(opt("concurrency", "6"));
const MODELS = {
  sol: { pi: "openai-codex/gpt-6.1-sol", mc: "openai/gpt-6.1-sol" },
  opus: { pi: "anthropic/claude-opus-5-5", mc: "anthropic/claude-opus-5-5" },
};
const model = opt("model", "sol");
if (!MODELS[model]) throw new Error(`--model must be one of ${Object.keys(MODELS).join(", ")}`);
const runEnv = {
  ...process.env,
  EVAL_PI_MODEL: MODELS[model].pi,
  EVAL_MC_MODEL: MODELS[model].mc,
};

const jobs = [];
for (let rep = 1; rep <= reps; rep++)
  for (const task of tasks) for (const arm of arms) jobs.push({ task, arm, rep });

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function prepare(job) {
  const dir = path.join(outDir, job.task, `${job.arm}-r${job.rep}`);
  const work = path.join(dir, "work");
  if (existsSync(path.join(dir, "grade.json"))) return null;
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(evalRoot, "fixture"), work, { recursive: true });
  git(work, "init", "-q");
  git(work, "add", "-A");
  git(work, "-c", "user.email=eval@local", "-c", "user.name=eval", "commit", "-qm", "baseline");
  const prompts = spec.tasks[job.task].prompts.map((p, i) => (i === 0 ? spec.preamble + p : p));
  writeFileSync(path.join(dir, "prompts.json"), JSON.stringify(prompts, null, 2));
  return { dir, work };
}

function nodeTest(cwd, files = []) {
  try {
    const out = execFileSync("node", ["--test", ...files], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    return parseTap(out);
  } catch (error) {
    return parseTap(`${error.stdout ?? ""}${error.stderr ?? ""}`);
  }
}

function parseTap(out) {
  const num = (k) => Number(new RegExp(`ℹ ${k} (\\d+)`).exec(out)?.[1] ?? 0);
  const failed = [...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]);
  return { pass: num("pass"), fail: num("fail"), failed: [...new Set(failed)].slice(0, 20) };
}

function grade(job, dir, work) {
  const g = { task: job.task, arm: job.arm, rep: job.rep, model };
  g.changedFiles = git(work, "status", "--porcelain").trim().split("\n").filter(Boolean);
  g.diffStat = git(work, "diff", "--shortstat").trim();
  if (spec.tasks[job.task].kind === "code") {
    g.visible = nodeTest(work);
    const gradeDir = path.join(dir, "graded");
    cpSync(work, gradeDir, { recursive: true });
    cpSync(
      path.join(evalRoot, "grading", `${job.task}.test.ts`),
      path.join(gradeDir, "test", "zz-hidden.test.ts"),
    );
    g.hidden = nodeTest(gradeDir, ["test/zz-hidden.test.ts"]);
  }
  writeFileSync(path.join(dir, "grade.json"), `${JSON.stringify(g, null, 2)}\n`);
  return g;
}

function runOne(job) {
  const prepared = prepare(job);
  if (!prepared) return Promise.resolve();
  const { dir, work } = prepared;
  const runner =
    job.arm === "mc"
      ? ["mc-run.mjs", work, path.join(dir, "trace"), path.join(dir, "prompts.json")]
      : ["pi-run.mjs", work, path.join(dir, "trace"), job.arm, path.join(dir, "prompts.json")];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      runner.map((a, i) => (i === 0 ? path.join(here, a) : a)),
      {
        cwd: work,
        stdio: ["ignore", "pipe", "pipe"],
        env: runEnv,
      },
    );
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    const killer = setTimeout(() => child.kill("SIGKILL"), 60 * 60_000);
    child.on("exit", (code) => {
      clearTimeout(killer);
      writeFileSync(path.join(dir, "runner.log"), log);
      const g = grade(job, dir, work);
      g.exitCode = code;
      g.ms = Date.now() - started;
      writeFileSync(path.join(dir, "grade.json"), `${JSON.stringify(g, null, 2)}\n`);
      console.log(
        `${new Date().toISOString()} done ${job.task} ${job.arm} r${job.rep} exit=${code} ${Math.round(g.ms / 1000)}s` +
          (g.hidden
            ? ` hidden=${g.hidden.pass}/${g.hidden.pass + g.hidden.fail} visible=${g.visible.pass}/${g.visible.pass + g.visible.fail}`
            : ""),
      );
      resolve();
    });
  });
}

mkdirSync(outDir, { recursive: true });
console.log(`${jobs.length} jobs, concurrency ${concurrency}, model ${model}`);
const queue = [...jobs];
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (queue.length) await runOne(queue.shift());
  }),
);
console.log("all done");
