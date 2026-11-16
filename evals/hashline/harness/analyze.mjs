// Turns run traces into comparable metrics. Usage: node analyze.mjs <outDir> [--json]
// Per run: tokens, requests, cache, tool calls by kind, lines and chars returned by reads,
// re-reads classified before/after edits, edit failures by cause, OM activations, grades.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const outDir = path.resolve(process.argv[2]);

const KIND = {
  read: "read",
  view: "read",
  edit: "edit",
  string_replace_lsp: "edit",
  ast_smart_edit: "edit",
  apply_patch: "edit",
  write: "write",
  write_file: "write",
  grep: "search",
  ast_search: "search",
  search_content: "search",
  find: "search",
  find_files: "search",
  ls: "search",
  list_files: "search",
  bash: "bash",
  execute_command: "bash",
  skill: "skill",
  skill_read: "skill",
  skill_search: "skill",
};

const readJsonl = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        })
    : [];

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((c) => (typeof c === "string" ? c : (c?.text ?? ""))).join("\n");
  if (content && typeof content === "object") {
    if (typeof content.content === "string" || Array.isArray(content.content))
      return textOf(content.content);
    if (typeof content.text === "string") return content.text;
    return JSON.stringify(content);
  }
  return String(content ?? "");
};

/** Normalized timeline: tool calls (with what the model saw), requests (usage), prompts, text. */
function timeline(arm, events) {
  const calls = new Map();
  const items = [];
  let prompt = -1;
  for (const e of events) {
    if (e.type === "harness_prompt") {
      prompt = e.index;
      items.push({ type: "prompt", prompt });
    } else if (arm === "mc") {
      if (e.type === "tool_start") {
        const call = {
          type: "tool",
          prompt,
          id: e.toolCallId,
          name: e.toolName,
          args: e.args ?? {},
          text: "",
          isError: false,
        };
        calls.set(e.toolCallId, call);
        items.push(call);
      } else if (e.type === "tool_end") {
        const call = calls.get(e.toolCallId);
        if (call) {
          call.text = textOf(e.result);
          call.isError = e.isError === true;
        }
      } else if (e.type === "usage_update") {
        const u = e.usage;
        items.push({
          type: "request",
          prompt,
          input: u.promptTokens ?? 0,
          cached: u.cachedInputTokens ?? 0,
          cacheWrite: u.cacheCreationInputTokens ?? 0,
          output: u.completionTokens ?? 0,
          reasoning: u.reasoningTokens ?? 0,
        });
      } else if (e.type === "assistant_text") items.push({ type: "text", prompt, text: e.text });
      else if (e.type === "om_activation") items.push({ type: "om", prompt, op: e.operationType });
    } else {
      if (e.type === "tool_execution_start") {
        const call = {
          type: "tool",
          prompt,
          id: e.toolCallId,
          name: e.toolName,
          args: e.args ?? {},
          text: "",
          isError: false,
        };
        calls.set(e.toolCallId, call);
        items.push(call);
      } else if (e.type === "message_end" && e.message?.role === "toolResult") {
        const call = calls.get(e.message.toolCallId);
        if (call) {
          call.text = textOf(e.message.content);
          call.isError = e.message.isError === true;
        }
      } else if (e.type === "message_end" && e.message?.role === "assistant") {
        const u = e.message.usage ?? {};
        items.push({
          type: "request",
          prompt,
          // Pi's `input` excludes both cache reads and cache writes (Anthropic reports writes).
          input: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
          cached: u.cacheRead ?? 0,
          cacheWrite: u.cacheWrite ?? 0,
          output: u.output ?? 0,
          reasoning: u.reasoning ?? 0,
        });
        const text = (e.message.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        if (text) items.push({ type: "text", prompt, text });
      }
    }
  }
  return items;
}

function relPath(p, work) {
  if (typeof p !== "string" || !p) return undefined;
  const clean = p.replace(/^@/, "");
  const abs = path.isAbsolute(clean) ? clean : path.join(work, clean);
  const real = abs.replace(/^\/private/, "");
  const workReal = work.replace(/^\/private/, "");
  if (!real.startsWith(`${workReal}/`) && real !== workReal) return `external:${clean}`;
  return path.relative(workReal, real);
}

/** Line numbers a read result returned, from its anchors / gutters or from offset. */
function linesOfRead(call) {
  const lines = call.text.split("\n");
  const nums = [];
  let mapLines = 0;
  for (const l of lines) {
    const m = /^(\d+):[0-9a-f]{2,4}\|/.exec(l) ?? /^\s*(\d+)→/.exec(l);
    if (m) nums.push(Number(m[1]));
    else if (/^\s*(L?\d+(-\d+)?\s*[:|]|[│├└─]|\[)/.test(l)) mapLines += 1;
  }
  if (nums.length === 0 && !call.isError) {
    // Stock Pi read: plain content from `offset` (1-based), with a trailing notice.
    const start = Number(call.args.offset ?? 1) || 1;
    const content = lines.filter((l) => !/^\[.*(offset|lines|truncated|more).*\]$/i.test(l.trim()));
    for (let i = 0; i < content.length; i++) nums.push(start + i);
  }
  return { nums, mapLines };
}

// Bash output is classified per command of a chain (split on && || ; and newlines), by the
// first stage of its pipeline: later stages only filter. Precedence for the output's chars when
// a chain mixes classes: read > search > diff > test > other. Writes are counted on their own.
const FILE_RE = /([\w./-]+\.(?:ts|tsx|js|mjs|cjs|json|md|csv|py|txt))\b/g;
const SCRIPT_READ = /readFileSync|readFile\(|open\([^)]*\)\.read|read_text|readlines|\.read\(\)/;
const SCRIPT_WRITE =
  /writeFileSync|writeFile\(|write_text|\.write\(|open\([^)]*['"][wa]\+?['"]|appendFileSync/;

function stripPrefix(seg) {
  let s = seg.trim();
  for (;;) {
    const next = s
      .replace(/^(?:do|then|else|\(|\{)\s+/, "")
      .replace(/^[A-Z_][A-Z0-9_]*=\S*\s+/, "")
      .replace(/^(?:command|time|timeout\s+\d+)\s+/, "");
    if (next === s) return s;
    s = next;
  }
}

function classifyStage(stage) {
  const s = stripPrefix(stage);
  const word = s.split(/\s+/)[0] ?? "";
  if (/^git$/.test(word)) return /^git\s+(diff|show|log\s+-p)\b/.test(s) ? "diff" : "other";
  if (/^(python3?|node|deno|bun|perl|ruby)$/.test(word)) {
    if (/^node\s+--test\b/.test(s)) return "test";
    if (SCRIPT_READ.test(s)) return "read";
    return "other";
  }
  if (/^(npm|npx|pnpm|yarn|tsc|vitest|jest|biome|eslint|prettier|make)$/.test(word)) return "test";
  if (/^(cat|head|tail|nl|awk|less|more|bat|wc|diff|cut|xxd|od)$/.test(word)) return "read";
  if (word === "sed") return /^sed\s+(-[a-zA-Z]*i|--in-place)/.test(s) ? "other" : "read";
  if (/^(rg|grep|egrep|fgrep|ag|ack|find|fd|ls|tree|stat|file)$/.test(word)) return "search";
  return "other";
}

/** Files a command writes (sed -i, perl -i, > / >> / tee into the tree, scripted writes). */
function bashWriteTargets(cmd) {
  const targets = [];
  for (const m of cmd.matchAll(/(?<![0-9&])>>?\s*(['"]?)([^\s'"&|;]+)\1/g)) {
    if (!/^\/(dev|tmp|private\/tmp)\b/.test(m[2])) targets.push(m[2]);
  }
  for (const m of cmd.matchAll(/\btee\s+(?:-a\s+)?([^\s|;&]+)/g)) targets.push(m[1]);
  let scripted = false;
  for (const seg of cmd.split(/&&|\|\||;|\n/)) {
    const s = stripPrefix(seg);
    if (/^sed\s+(-[a-zA-Z]*i|--in-place)/.test(s) || /^perl\s+-\S*i/.test(s)) {
      targets.push(...[...s.matchAll(FILE_RE)].map((m) => m[1]));
    }
  }
  // A script's write call can sit on a later line than the interpreter (heredocs).
  if (/(^|[\s;&|(])(python3?|node|deno|bun|ruby)\b/.test(cmd) && SCRIPT_WRITE.test(cmd)) {
    scripted = true;
  }
  if (scripted || /\bapply_patch\b/.test(cmd)) {
    targets.push(...[...cmd.matchAll(FILE_RE)].map((m) => m[1]));
  }
  return { targets: [...new Set(targets)], scripted };
}

const PRECEDENCE = ["read", "search", "diff", "test", "other"];

function classifyBash(cmd) {
  const classes = new Set();
  for (const command of cmd.split(/&&|\|\||;|\n/)) {
    const first = command.split(/(?<!\|)\|(?!\|)/)[0];
    if (!first.trim() || /^\s*(done|fi|esac)\s*$/.test(first)) continue;
    if (/^\s*for\s+\w+\s+in\b/.test(first) || /^\s*(cd|echo|printf|set|export)\b/.test(first)) {
      classes.add("other");
      continue;
    }
    classes.add(classifyStage(first));
  }
  const primary = PRECEDENCE.find((c) => classes.has(c)) ?? "other";
  return { primary, mixed: classes.size > 1 };
}

function bashRead(call, work) {
  const cmd = String(call.args.command ?? call.args.cmd ?? "");
  const { primary, mixed } = classifyBash(cmd);
  if (primary !== "read") return undefined;
  const files = [...cmd.matchAll(FILE_RE)].map((m) => relPath(m[1], work));
  const unique = [...new Set(files)];
  const outLines = call.text.split("\n").filter((l) => l.length).length;
  if (unique.length !== 1 || mixed) return { file: undefined, nums: [], outLines };
  const range = /sed\s+-n\s+['"]?(\d+),(\d+)p/.exec(cmd);
  const start = range ? Number(range[1]) : 1;
  return { file: unique[0], nums: Array.from({ length: outLines }, (_, i) => start + i) };
}

function editPath(call, work) {
  return relPath(call.args.path ?? call.args.file_path ?? call.args.filePath, work);
}

function classifyEditError(text) {
  if (/fresh anchors|before editing it/i.test(text)) return "read-guard";
  if (/hash|anchor|mismatch|stale/i.test(text)) return "anchor-mismatch";
  if (/not found|no match|could not find|did not find|0 occurrences|does not contain/i.test(text))
    return "text-not-found";
  if (/multiple|more than one|ambiguous|occurrences/i.test(text)) return "ambiguous";
  if (/must (first )?(read|view)|has not been read|read it first/i.test(text)) return "read-guard";
  return "other";
}

function analyzeRun(dir, task, arm) {
  const work = path.join(dir, "work");
  const events = readJsonl(path.join(dir, "trace", "events.jsonl"));
  const items = timeline(arm, events);
  const grade = existsSync(path.join(dir, "grade.json"))
    ? JSON.parse(readFileSync(path.join(dir, "grade.json"), "utf8"))
    : {};
  const m = {
    task,
    arm,
    rep: grade.rep,
    ms: grade.ms,
    requests: 0,
    inputTokens: 0,
    cachedTokens: 0,
    uncachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    peakContext: 0,
    cacheDrops: 0,
    toolCalls: 0,
    byKind: {},
    byTool: {},
    reads: 0,
    readLines: 0,
    readChars: 0,
    mapLines: 0,
    bashReads: 0,
    bashReadLines: 0,
    searchCalls: 0,
    searchChars: 0,
    diffCalls: 0,
    diffChars: 0,
    testChars: 0,
    otherBashChars: 0,
    mixedBash: 0,
    bashWrites: 0,
    scriptedWrites: 0,
    editResultChars: 0,
    cacheWriteTokens: 0,
    externalReads: 0,
    filesRead: 0,
    reReads: { redundant: 0, newWindow: 0, postEdit: 0, postEditError: 0 },
    reReadLines: { redundant: 0, postEdit: 0 },
    readsBeforeFirstEdit: 0,
    readsAfterFirstEdit: 0,
    readLinesBeforeFirstEdit: 0,
    readLinesAfterFirstEdit: 0,
    edits: 0,
    editErrors: 0,
    editErrorKinds: {},
    editErrorSamples: [],
    writes: 0,
    guardRefusals: 0,
    guardUnneeded: 0,
    omActivations: 0,
    prompts: [],
    grade,
  };
  const fileState = new Map();
  const state = (f) => {
    if (!fileState.has(f))
      fileState.set(f, {
        everRead: false,
        seen: new Set(),
        editedSinceRead: false,
        lastEditError: false,
      });
    return fileState.get(f);
  };
  let firstEditSeen = false;
  // Read-guard refusals waiting for the next edit of the same file: was the retry identical?
  const pendingGuard = new Map();
  let prevInput = 0;
  let curPrompt = null;
  const promptStat = () => {
    curPrompt = {
      requests: 0,
      inputTokens: 0,
      uncachedTokens: 0,
      outputTokens: 0,
      reads: 0,
      readLines: 0,
      reReadsPostEdit: 0,
      reReadsRedundant: 0,
      edits: 0,
      editErrors: 0,
      toolCalls: 0,
      om: 0,
      finalText: "",
    };
    m.prompts.push(curPrompt);
  };
  const noteRead = (file, nums, viaBash) => {
    const s = state(file);
    const set = new Set(nums);
    let kind = "first";
    const overlap = s.editedSinceRead ? 0 : [...set].filter((n) => s.seen.has(n)).length;
    if (s.everRead) {
      if (s.lastEditError) kind = "postEditError";
      else if (s.editedSinceRead) kind = "postEdit";
      else kind = overlap > 0 ? "redundant" : "newWindow";
    }
    if (kind === "newWindow") m.reReads.newWindow += 1;
    if (kind === "redundant") {
      m.reReads.redundant += 1;
      m.reReadLines.redundant += overlap;
      curPrompt.reReadsRedundant += 1;
    } else if (kind === "postEdit" || kind === "postEditError") {
      m.reReads[kind] += 1;
      m.reReadLines.postEdit += set.size;
      curPrompt.reReadsPostEdit += 1;
    }
    if (s.editedSinceRead) s.seen = new Set();
    for (const n of set) s.seen.add(n);
    s.everRead = true;
    s.editedSinceRead = false;
    s.lastEditError = false;
    if (firstEditSeen) {
      m.readsAfterFirstEdit += 1;
      m.readLinesAfterFirstEdit += set.size;
    } else {
      m.readsBeforeFirstEdit += 1;
      m.readLinesBeforeFirstEdit += set.size;
    }
    if (viaBash) {
      m.bashReads += 1;
      m.bashReadLines += set.size;
    }
  };
  for (const it of items) {
    if (it.type === "prompt") {
      promptStat();
      continue;
    }
    if (!curPrompt) promptStat();
    if (it.type === "request") {
      m.requests += 1;
      m.inputTokens += it.input;
      m.cachedTokens += it.cached;
      m.cacheWriteTokens += it.cacheWrite ?? 0;
      m.uncachedTokens += it.input - it.cached;
      m.outputTokens += it.output;
      m.reasoningTokens += it.reasoning;
      m.peakContext = Math.max(m.peakContext, it.input);
      const shrank = it.input < prevInput * 0.7;
      if (prevInput > 10_000 && !shrank && it.cached < prevInput * 0.5) m.cacheDrops += 1;
      prevInput = it.input;
      curPrompt.requests += 1;
      curPrompt.inputTokens += it.input;
      curPrompt.uncachedTokens += it.input - it.cached;
      curPrompt.outputTokens += it.output;
      continue;
    }
    if (it.type === "om") {
      m.omActivations += 1;
      curPrompt.om += 1;
      continue;
    }
    if (it.type === "text") {
      curPrompt.finalText = it.text;
      continue;
    }
    const kind = KIND[it.name] ?? "other";
    m.toolCalls += 1;
    curPrompt.toolCalls += 1;
    m.byKind[kind] = (m.byKind[kind] ?? 0) + 1;
    m.byTool[it.name] = (m.byTool[it.name] ?? 0) + 1;
    if (kind === "read") {
      const file = relPath(it.args.path ?? it.args.file_path, work);
      if (!file || file.startsWith("external:")) {
        m.externalReads += 1;
        continue;
      }
      const { nums, mapLines } = linesOfRead(it);
      m.reads += 1;
      m.readLines += nums.length;
      m.readChars += it.text.length;
      m.mapLines += mapLines;
      curPrompt.reads += 1;
      curPrompt.readLines += nums.length;
      if (!it.isError) noteRead(file, nums, false);
    } else if (kind === "bash") {
      const cmd = String(it.args.command ?? it.args.cmd ?? "");
      const { primary, mixed } = classifyBash(cmd);
      if (mixed) m.mixedBash += 1;
      const br = bashRead(it, work);
      if (br && !br.file) {
        // Multi-file or mixed read: content in context, but no per-file attribution.
        m.bashReads += 1;
        m.bashReadLines += br.outLines;
        m.readLines += br.outLines;
        m.readChars += it.text.length;
        curPrompt.readLines += br.outLines;
      }
      if (br?.file && !br.file.startsWith("external:")) {
        m.readChars += it.text.length;
        m.readLines += br.nums.length;
        curPrompt.readLines += br.nums.length;
        noteRead(br.file, br.nums, true);
      }
      if (primary === "search") {
        m.searchCalls += 1;
        m.searchChars += it.text.length;
      } else if (primary === "diff") {
        m.diffCalls += 1;
        m.diffChars += it.text.length;
      } else if (primary === "test") m.testChars += it.text.length;
      else if (primary === "other") m.otherBashChars += it.text.length;
      const writes = bashWriteTargets(cmd);
      if (!it.isError && (writes.targets.length || writes.scripted)) {
        m.bashWrites += 1;
        if (writes.scripted) m.scriptedWrites += 1;
        for (const target of writes.targets) {
          const file = relPath(target, work);
          if (!file || file.startsWith("external:")) continue;
          firstEditSeen = true;
          state(file).editedSinceRead = true;
        }
      }
    } else if (kind === "search") {
      m.searchCalls += 1;
      m.searchChars += it.text.length;
    } else if (kind === "edit" || kind === "write") {
      const file = editPath(it, work);
      if (kind === "edit") m.editResultChars += it.text.length;
      if (kind === "write") m.writes += 1;
      else m.edits += 1;
      curPrompt.edits += 1;
      if (it.isError) {
        m.editErrors += 1;
        curPrompt.editErrors += 1;
        const cause = classifyEditError(it.text);
        m.editErrorKinds[cause] = (m.editErrorKinds[cause] ?? 0) + 1;
        if (m.editErrorSamples.length < 6)
          m.editErrorSamples.push(`${it.name} ${file}: ${it.text.slice(0, 220)}`);
        if (file) state(file).lastEditError = true;
        if (cause === "read-guard" && file) {
          m.guardRefusals += 1;
          pendingGuard.set(file, JSON.stringify(it.args.edits ?? it.args));
        }
      } else if (file) {
        if (pendingGuard.has(file)) {
          if (pendingGuard.get(file) === JSON.stringify(it.args.edits ?? it.args))
            m.guardUnneeded += 1;
          pendingGuard.delete(file);
        }
        firstEditSeen = true;
        const s = state(file);
        s.editedSinceRead = true;
        s.lastEditError = false;
        if (kind === "write") {
          // A write returns the file's content (hashline) or nothing (stock); either way the
          // agent knows the content it wrote.
          s.everRead = true;
        }
      }
    }
  }
  m.filesRead = [...fileState.entries()].filter(([, s]) => s.everRead).length;
  m.cacheHitRatio = m.inputTokens ? m.cachedTokens / m.inputTokens : 0;
  if (arm !== "mc") {
    const trace = readJsonl(path.join(dir, "trace", "om-trace.jsonl"));
    m.omActivations = trace.filter((e) =>
      /activat/i.test(String(e.event ?? e.type ?? e.kind ?? "")),
    ).length;
    m.omTraceEvents = [...new Set(trace.map((e) => String(e.event ?? e.type ?? e.kind)))];
  }
  m.finalText = m.prompts.at(-1)?.finalText ?? "";
  if (task === "t1-explore") m.answerScore = gradeAnswer(m.finalText);
  if (task === "t5-marathon" || task === "t6-long-session")
    m.lineRefs = gradeLineRefs(m.finalText, work);
  if (task === "t6-long-session") {
    const answer = m.prompts[4]?.finalText ?? "";
    const named = [...new Set(answer.match(/\b[A-Z]{2}-[A-Z0-9]{2,3}\b/g) ?? [])];
    m.regionsAnswer = { correct: named.includes("JP-13"), named };
  }
  return m;
}

function gradeAnswer(text) {
  const t = text.toLowerCase();
  const order = ["bulk", "promo", "coupon", "loyalty"].map((w) => t.indexOf(w));
  const checks = {
    q1Order: order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]),
    q1Cap: /40\s?%|4,?000\s?(bps|basis)/.test(t),
    q2NoLoyalty:
      /solo15/.test(t) &&
      /(not stackable|non-stackable|stackable:\s*false|isn't stackable|is not stackable)/.test(t),
    q3Threshold: /\$?99(\.00)?\b|9,?900/.test(t),
    q3Hazmat: /hazmat/.test(t),
    q3Weight: /30\s?kg|30,?000\s?g/.test(t),
    q4PerClass: /per (tax )?class|by tax class|each tax class/.test(t),
    q4HalfEven: /half[- ]even|banker/.test(t),
    q4Allocation: /proportion|largest[- ]remainder/.test(t),
    q5Release: /releas|back to available|returned to available/.test(t),
    q5Refund: /refund/.test(t) && /(full|charged total|chargedtotal)/.test(t),
  };
  return {
    score: Object.values(checks).filter(Boolean).length,
    of: Object.keys(checks).length,
    checks,
  };
}

function gradeLineRefs(text, work) {
  let diff = "";
  try {
    diff = execFileSync("git", ["diff", "-U0", "HEAD"], {
      cwd: work,
      encoding: "utf8",
      maxBuffer: 1 << 26,
    });
  } catch {
    return { refs: 0, accurate: 0 };
  }
  const changed = new Map();
  let file;
  for (const line of diff.split("\n")) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) {
      file = f[1];
      changed.set(file, new Set());
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      for (let i = Math.max(1, start - 1); i <= start + Math.max(count, 1); i++)
        changed.get(file).add(i);
    }
  }
  const refs = [...text.matchAll(/((?:src|test)\/[\w./-]+\.ts):(\d+)/g)].map((m) => ({
    file: m[1],
    line: Number(m[2]),
  }));
  const near = (r) => {
    const set = changed.get(r.file);
    if (!set) return false;
    for (let d = -3; d <= 3; d++) if (set.has(r.line + d)) return true;
    return false;
  };
  const accurate = refs.filter(near).length;
  return { refs: refs.length, accurate, wrong: refs.filter((r) => !near(r)).slice(0, 8) };
}

const runs = [];
for (const task of readdirSync(outDir).filter(
  (d) => existsSync(path.join(outDir, d)) && !d.includes("."),
)) {
  const taskDir = path.join(outDir, task);
  for (const run of readdirSync(taskDir)) {
    const dir = path.join(taskDir, run);
    if (!existsSync(path.join(dir, "trace", "events.jsonl"))) continue;
    const arm = run.replace(/-r\d+$/, "");
    runs.push(analyzeRun(dir, task, arm));
  }
}
const scrub = (value) =>
  JSON.parse(
    JSON.stringify(value)
      .replaceAll(outDir, "<out>")
      .replaceAll(outDir.replace(/^\/private/, ""), "<out>")
      .replaceAll(process.env.HOME ?? "\u0000", "~"),
  );
writeFileSync(path.join(outDir, "metrics.json"), `${JSON.stringify(scrub(runs), null, 2)}\n`);

// Aggregate: mean per task x arm.
const groups = new Map();
for (const r of runs) {
  const key = `${r.task}|${r.arm}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (n) =>
  Math.abs(n) >= 1000
    ? `${(n / 1000).toFixed(1)}k`
    : Number.isInteger(n)
      ? String(n)
      : n.toFixed(1);
const rows = [];
for (const [key, rs] of [...groups.entries()].sort()) {
  const [task, arm] = key.split("|");
  const g = (f) => mean(rs.map(f));
  const refs = rs
    .filter((r) => r.lineRefs)
    .map((r) => `${r.lineRefs.accurate}/${r.lineRefs.refs}`)
    .join(" ");
  const hidden = rs
    .map((r) =>
      r.grade.hidden
        ? `${r.grade.hidden.pass}/${r.grade.hidden.pass + r.grade.hidden.fail}`
        : r.answerScore
          ? `${r.answerScore.score}/${r.answerScore.of}`
          : "-",
    )
    .join(" ");
  const visible = rs
    .map((r) =>
      r.grade.visible ? (r.grade.visible.fail === 0 ? "ok" : `${r.grade.visible.fail}F`) : "-",
    )
    .join(" ");
  rows.push({
    task,
    arm,
    n: rs.length,
    grade: hidden,
    suite: visible,
    "in tok": fmt(g((r) => r.inputTokens)),
    uncached: fmt(g((r) => r.uncachedTokens)),
    "cache write": fmt(g((r) => r.cacheWriteTokens)),
    "out tok": fmt(g((r) => r.outputTokens)),
    reqs: fmt(g((r) => r.requests)),
    "peak ctx": fmt(g((r) => r.peakContext)),
    tools: fmt(g((r) => r.toolCalls)),
    reads: fmt(g((r) => r.reads + r.bashReads)),
    "read lines": fmt(g((r) => r.readLines)),
    "read chars": fmt(g((r) => r.readChars)),
    "search chars": fmt(g((r) => r.searchChars)),
    "git diff chars": fmt(g((r) => r.diffChars)),
    "edit result chars": fmt(g((r) => r.editResultChars)),
    "bash writes": fmt(g((r) => r.bashWrites)),
    "rr redundant": fmt(g((r) => r.reReads.redundant)),
    "rr redundant lines": fmt(g((r) => r.reReadLines.redundant)),
    "rr new window": fmt(g((r) => r.reReads.newWindow)),
    "rr post-edit": fmt(g((r) => r.reReads.postEdit + r.reReads.postEditError)),
    "reads pre/post 1st edit": `${fmt(g((r) => r.readsBeforeFirstEdit))}/${fmt(g((r) => r.readsAfterFirstEdit))}`,
    edits: fmt(g((r) => r.edits)),
    "edit errs": fmt(g((r) => r.editErrors)),
    "guard (same retry)": `${fmt(g((r) => r.guardRefusals))} (${fmt(g((r) => r.guardUnneeded))})`,
    "cache drops": fmt(g((r) => r.cacheDrops)),
    om: fmt(g((r) => r.omActivations)),
    min: fmt(g((r) => (r.ms ?? 0) / 60000)),
    "path:line ok": refs || "-",
  });
}
const cols = Object.keys(rows[0] ?? {});
const md = [
  `| ${cols.join(" | ")} |`,
  `| ${cols.map(() => "---").join(" | ")} |`,
  ...rows.map((r) => `| ${cols.map((c) => r[c]).join(" | ")} |`),
].join("\n");
writeFileSync(path.join(outDir, "summary.md"), `${md}\n`);
console.log(md);
if (process.argv.includes("--json"))
  console.log(
    JSON.stringify(
      runs.map(({ prompts, finalText, ...r }) => r),
      null,
      2,
    ),
  );
