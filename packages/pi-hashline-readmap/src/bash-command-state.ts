import path from "node:path";
import {
  type ContextHygieneCommandKind,
  classifyCommandForContextHygiene,
  normalizeCommandForContextHygiene,
} from "./context-hygiene.js";

export type BashCommandStateKind =
  | "repo-status"
  | "repo-diff"
  | "git-history"
  | "git-worktree-mutation"
  | "shell-file-mutation"
  | "verification"
  | "routine"
  | "debug";

export type BashCommandOutcome = "success" | "failure";

export interface BuildBashCommandStateInput {
  command: string;
  isError?: boolean;
  text?: string;
  cwd?: string;
}

export interface BashCommandState {
  command: string;
  normalizedCommand: string;
  commandKind: ContextHygieneCommandKind;
  stateKind: BashCommandStateKind;
  outcome: BashCommandOutcome;
  containsDiagnostics: boolean;
  semanticInvalidationSensitive: boolean;
  routineRetirementEligible: boolean;
  protectedFromRoutineRetirement: boolean;
  fileTargets?: string[];
}

const GIT_WORKTREE_MUTATION_RE =
  /^git\s+(add|apply|am|checkout|clean|commit|merge|mv|pull|rebase|reset|restore|rm|stash|switch)\b/;

const REDIRECTION_RE = /(?:^|[\s;|&])(?:\d?>>?|&>|>>|>)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
const TEE_RE = /(?:^|[|;&]\s*)tee((?:\s+(?:"[^"]+"|'[^']+'|[^\s;&|]+))*)/g;

function containsDiagnostics(text: string): boolean {
  return /\b(error TS\d+|TypeError:|ReferenceError:|SyntaxError:|AssertionError:|\bat\s+\S+\s+\([^)]*:\d+:\d+\)|FAIL\b)/.test(
    text,
  );
}

function isSafeLiteralShellTarget(target: string): boolean {
  if (/[$`*?{}()[\]]/.test(target)) return false;
  if (target.includes("~")) return false;
  if (target.startsWith("-")) return false;
  return true;
}
function normalizeShellTarget(rawTarget: string, cwd: string): string | undefined {
  const trimmed = rawTarget.trim();
  if (!trimmed || trimmed === "/dev/null" || /^&\d+$/.test(trimmed)) return undefined;
  if (!isSafeLiteralShellTarget(trimmed)) return undefined;
  return path.resolve(cwd, trimmed);
}

function pushUniqueTarget(targets: string[], target: string | undefined): void {
  if (!target || targets.includes(target)) return;
  targets.push(target);
}

function splitShellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) words.push(current);
  return words;
}

function extractTeeTargets(command: string, cwd: string, targets: string[]): void {
  for (const match of command.matchAll(TEE_RE)) {
    const words = splitShellWords(match[1] ?? "");
    for (const word of words) {
      if (word === "-a" || word.startsWith("--")) continue;
      pushUniqueTarget(targets, normalizeShellTarget(word, cwd));
    }
  }
}

function extractSedInPlaceTargets(command: string, cwd: string, targets: string[]): void {
  const words = splitShellWords(command);
  if (words[0] !== "sed") return;

  const inPlaceIndex = words.findIndex((word) => word === "-i" || word.startsWith("-i"));
  if (inPlaceIndex < 0) return;

  let index = inPlaceIndex + 1;
  if (words[inPlaceIndex] === "-i" && words[index] === "") index += 1;

  while (index < words.length && words[index].startsWith("-") && words[index] !== "-") {
    index += 1;
  }

  if (index < words.length) index += 1;

  for (; index < words.length; index += 1) {
    const word = words[index];
    if (!word || word.startsWith("-")) continue;
    pushUniqueTarget(targets, normalizeShellTarget(word, cwd));
  }
}

function nonOptionOperands(words: readonly string[]): string[] {
  const operands: string[] = [];
  for (const word of words) {
    if (!word || word === "--") continue;
    if (word.startsWith("-")) continue;
    operands.push(word);
  }
  return operands;
}

function extractPathCommandTargets(command: string, cwd: string, targets: string[]): void {
  const words = splitShellWords(command);
  const commandName = words[0];
  if (!commandName) return;

  if (commandName === "mv") {
    const operands = nonOptionOperands(words.slice(1));
    if (operands.length === 2) {
      pushUniqueTarget(targets, normalizeShellTarget(operands[0], cwd));
      pushUniqueTarget(targets, normalizeShellTarget(operands[1], cwd));
    }
  }

  if (commandName === "cp") {
    const operands = nonOptionOperands(words.slice(1));
    if (operands.length === 2) {
      pushUniqueTarget(targets, normalizeShellTarget(operands[1], cwd));
    }
  }

  if (commandName === "rm") {
    for (const operand of nonOptionOperands(words.slice(1))) {
      pushUniqueTarget(targets, normalizeShellTarget(operand, cwd));
    }
  }

  if (commandName === "install") {
    const operands = nonOptionOperands(words.slice(1));
    if (operands.length >= 2) {
      pushUniqueTarget(targets, normalizeShellTarget(operands[operands.length - 1], cwd));
    }
  }
}

export function extractShellFileMutationTargets(command: string, cwd = process.cwd()): string[] {
  const normalized = normalizeCommandForContextHygiene(command);
  if (/^(eval|source|\.)\b/.test(normalized)) return [];

  const targets: string[] = [];
  for (const match of command.matchAll(REDIRECTION_RE)) {
    pushUniqueTarget(targets, normalizeShellTarget(match[1] ?? match[2] ?? match[3] ?? "", cwd));
  }
  extractTeeTargets(command, cwd, targets);
  extractSedInPlaceTargets(command, cwd, targets);
  extractPathCommandTargets(command, cwd, targets);
  return targets;
}

function classifyStateKind(
  normalizedCommand: string,
  commandKind: ContextHygieneCommandKind,
  fileTargets: readonly string[],
): BashCommandStateKind {
  if (fileTargets.length > 0) return "shell-file-mutation";
  if (/^git\s+status\b/.test(normalizedCommand)) return "repo-status";
  if (/^git\s+diff\b/.test(normalizedCommand)) return "repo-diff";
  if (/^git\s+log\b/.test(normalizedCommand)) return "git-history";
  if (GIT_WORKTREE_MUTATION_RE.test(normalizedCommand)) return "git-worktree-mutation";
  if (
    commandKind === "test" ||
    commandKind === "typecheck" ||
    commandKind === "build" ||
    commandKind === "lint"
  ) {
    return "verification";
  }
  if (commandKind === "install") return "routine";
  return "debug";
}

export function buildBashCommandState(input: BuildBashCommandStateInput): BashCommandState {
  const normalizedCommand = normalizeCommandForContextHygiene(input.command);
  const commandKind = classifyCommandForContextHygiene(normalizedCommand);
  const fileTargets = extractShellFileMutationTargets(input.command, input.cwd ?? process.cwd());
  const stateKind = classifyStateKind(normalizedCommand, commandKind, fileTargets);
  const outcome: BashCommandOutcome = input.isError === true ? "failure" : "success";
  const diagnostic = containsDiagnostics(input.text ?? "");
  const semanticInvalidationSensitive = stateKind === "repo-status" || stateKind === "repo-diff";
  const protectedFromRoutineRetirement =
    outcome === "failure" ||
    diagnostic ||
    stateKind === "debug" ||
    stateKind === "git-worktree-mutation" ||
    stateKind === "shell-file-mutation";

  return {
    command: input.command,
    normalizedCommand,
    commandKind,
    stateKind,
    outcome,
    containsDiagnostics: diagnostic,
    semanticInvalidationSensitive,
    routineRetirementEligible:
      outcome === "success" && !protectedFromRoutineRetirement && !semanticInvalidationSensitive,
    protectedFromRoutineRetirement,
    ...(fileTargets.length > 0 ? { fileTargets } : {}),
  };
}
