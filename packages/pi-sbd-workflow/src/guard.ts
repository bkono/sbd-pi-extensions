import { resolve } from "node:path";

/** Shell commands the workflow gates. Matching is on command text, so it is a guard, not a wall. */
export type GuardedCommand = "merge" | "ready";

export function classifyCommand(command: string): GuardedCommand | undefined {
  if (/\bgh\s+pr\s+merge\b/.test(command)) return "merge";
  if (/\bgh\s+pr\s+ready\b/.test(command)) return "ready";
  return undefined;
}

export const MERGE_BLOCK_REASON =
  "humans merge: hand the verified PR to the user or the required reviewers";

export function readyBlockReason(line: string): string {
  return `no passing independent verdict for HEAD (${line}); run the verifier before marking the PR ready`;
}

/** The directory a command runs in: a leading `cd <dir> &&` or `cd <dir>;`, else the session cwd. */
export function commandCwd(command: string, cwd: string): string {
  const match = command.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&]+))\s*(?:&&|;)/);
  const dir = match?.[1] ?? match?.[2] ?? match?.[3];
  return dir ? resolve(cwd, dir) : cwd;
}
