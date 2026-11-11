/**
 * Vendored from @mastra/memory@1.41.0 (Apache-2.0), ObservationalMemory.truncateObservationsToTokenBudget.
 * Copyright Mastra AI, Inc. Licensed under the Apache License, Version 2.0.
 * Local change: the token counter is a parameter instead of an instance field.
 */
// biome-ignore-all lint: verbatim upstream code
export function truncateObservationsToTokenBudget(
  observations: string,
  budget: number,
  countTokens: (text: string) => number,
): string {
  if (budget === 0) {
    return "";
  }

  const totalTokens = countTokens(observations);
  if (totalTokens <= budget) {
    return observations;
  }

  const lines = observations.split("\n");
  const totalCount = lines.length;

  // tokenx is lightweight (regex-based), so measure each line directly.
  const lineTokens: number[] = new Array(totalCount);
  const isImportant: boolean[] = new Array(totalCount);
  for (let i = 0; i < totalCount; i++) {
    lineTokens[i] = countTokens(lines[i]!);
    isImportant[i] = lines[i]!.includes("🔴") || lines[i]!.includes("✅");
  }

  // Precompute suffix sums so tail cost is O(1).
  const suffixTokens: number[] = new Array(totalCount + 1);
  suffixTokens[totalCount] = 0;
  for (let i = totalCount - 1; i >= 0; i--) {
    suffixTokens[i] = suffixTokens[i + 1]! + lineTokens[i]!;
  }

  // Collect important-line indexes from the head region.
  // Built incrementally as tailStart advances.
  const headImportantIndexes: number[] = [];

  const buildCandidateString = (tailStart: number, selectedImportantIndexes: number[]) => {
    const keptIndexes = [
      ...selectedImportantIndexes,
      ...Array.from({ length: totalCount - tailStart }, (_, i) => tailStart + i),
    ].sort((a, b) => a - b);

    if (keptIndexes.length === 0) {
      return `[${totalCount} observations truncated here]`;
    }

    const outputLines: string[] = [];
    let previousKeptIndex = -1;

    for (const keptIndex of keptIndexes) {
      const hiddenCount = keptIndex - previousKeptIndex - 1;
      if (hiddenCount === 1) {
        // Keep the original line — the marker would cost more tokens than the line itself
        outputLines.push(lines[previousKeptIndex + 1]!);
      } else if (hiddenCount > 1) {
        outputLines.push(`[${hiddenCount} observations truncated here]`);
      }
      outputLines.push(lines[keptIndex]!);
      previousKeptIndex = keptIndex;
    }

    const trailingHiddenCount = totalCount - previousKeptIndex - 1;
    if (trailingHiddenCount === 1) {
      outputLines.push(lines[totalCount - 1]!);
    } else if (trailingHiddenCount > 1) {
      outputLines.push(`[${trailingHiddenCount} observations truncated here]`);
    }

    return outputLines.join("\n");
  };

  // Lower-bound cost of kept content (excludes marker lines).
  // Used for fast rejection — the final countObservations call is the real gatekeeper.
  const estimateKeptContentCost = (
    tailStart: number,
    selectedImportantIndexes: number[],
  ): number => {
    let cost = suffixTokens[tailStart]!;
    for (const idx of selectedImportantIndexes) {
      cost += lineTokens[idx]!;
    }
    return cost;
  };

  let bestCandidate: string | undefined;
  let bestImportantCount = -1;
  let bestRawTailLength = -1;

  for (let tailStart = 1; tailStart < totalCount; tailStart++) {
    // Incrementally track important lines in the head region.
    if (isImportant[tailStart - 1]) {
      headImportantIndexes.push(tailStart - 1);
    }

    const rawTailLength = totalCount - tailStart;
    const maxImportantByRatio = rawTailLength;
    let importantToKeep = Math.min(headImportantIndexes.length, maxImportantByRatio);

    const getSelectedImportant = (count: number) =>
      count > 0 ? headImportantIndexes.slice(Math.max(0, headImportantIndexes.length - count)) : [];

    // Fast rejection: drop important lines if even the kept content exceeds budget.
    while (
      importantToKeep > 0 &&
      estimateKeptContentCost(tailStart, getSelectedImportant(importantToKeep)) > budget
    ) {
      importantToKeep -= 1;
    }

    if (estimateKeptContentCost(tailStart, getSelectedImportant(importantToKeep)) > budget) {
      continue;
    }

    // Only build + verify when this candidate could beat the current best.
    if (
      importantToKeep > bestImportantCount ||
      (importantToKeep === bestImportantCount && rawTailLength > bestRawTailLength)
    ) {
      const candidate = buildCandidateString(tailStart, getSelectedImportant(importantToKeep));
      if (countTokens(candidate) <= budget) {
        bestCandidate = candidate;
        bestImportantCount = importantToKeep;
        bestRawTailLength = rawTailLength;
      }
    }
  }

  if (!bestCandidate) {
    return `[${totalCount} observations truncated here]`;
  }

  return bestCandidate;
}
