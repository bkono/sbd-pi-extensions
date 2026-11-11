import { hasActiveMemory, type OMState, renderActiveObservations } from "./state.js";
import { addRelativeTimeToObservations } from "./upstream/date-utils";
import { renderObservationGroupsForReflection } from "./upstream/observation-groups";
import { optimizeObservationsForContext } from "./upstream/parse";
import {
  OBSERVATION_CONTEXT_INSTRUCTIONS,
  OBSERVATION_CONTEXT_PROMPT_THREAD,
  OBSERVATION_CONTINUATION_HINT,
} from "./upstream/prompts";

/** Name of the system prompt section OM owns. */
export const OM_SECTION = "observational-memory";

/**
 * Pi replacement for Mastra's retrieval instructions: the recall tool here pages this
 * session's raw history by observation group range.
 */
export const RECALL_INSTRUCTIONS = `## Recalling raw history

Each observation group above shows a \`_range: \`first:last\`_\` of session entry ids. The raw messages behind any group are still available. When you need exact wording, a tool result, or file contents you already saw, call \`om_recall\` with that range (or a search \`query\`) instead of re-running the tool. Re-run a tool only when its result may have changed since.`;

/**
 * The OM system section, rebuilt per request. It changes only when an activation or
 * reflection changes active memory, or when the calendar day changes (relative dates).
 */
export function buildOMSection(state: OMState, now: Date, timeZone?: string): string | undefined {
  if (!hasActiveMemory(state)) return undefined;
  const observations = renderActiveObservations(state);
  let rendered =
    renderObservationGroupsForReflection(observations, { includeReflectionKind: true }) ??
    optimizeObservationsForContext(observations);
  rendered = addRelativeTimeToObservations(rendered, now, timeZone);

  const parts = [
    `${OBSERVATION_CONTEXT_PROMPT_THREAD}\n\n${OBSERVATION_CONTEXT_INSTRUCTIONS}\n\n${RECALL_INSTRUCTIONS}`,
    `<observations>\n${rendered.trim()}\n</observations>`,
  ];
  if (state.currentTask) parts.push(`<current-task>\n${state.currentTask}\n</current-task>`);
  if (state.suggestedResponse) {
    parts.push(`<suggested-response>\n${state.suggestedResponse}\n</suggested-response>`);
  }
  return `<observational-memory>\n${parts.join("\n\n")}\n</observational-memory>`;
}

/** Synthetic first message once earlier context lives in memory (Mastra processor.ts). */
export const CONTINUATION_REMINDER = `<system-reminder>${OBSERVATION_CONTINUATION_HINT}</system-reminder>`;
