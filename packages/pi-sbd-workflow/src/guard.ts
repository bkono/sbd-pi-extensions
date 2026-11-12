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
