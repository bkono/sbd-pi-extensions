import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { OMEvent, SessionOM } from "./runtime.js";
import {
  type ActivationData,
  type ChunkData,
  OM_ACTIVATION,
  OM_REFLECTION,
  type ReflectionData,
} from "./state.js";

function k(tokens: number): string {
  return tokens < 1_000 ? `${tokens}` : `${(tokens / 1_000).toFixed(1)}k`;
}

const COLLAPSED_LINES = 10;

/**
 * Transcript rendering for memory changes, after Mastra Code's om-output block: one line
 * collapsed, the observations when expanded. Chunks only render through the activation
 * that swaps them in, so background buffering never adds transcript noise.
 */
export function registerRenderers(
  pi: ExtensionAPI,
  lookupChunk: (id: string) => ChunkData | undefined,
): void {
  pi.registerEntryRenderer<ActivationData>(OM_ACTIVATION, (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    const chunks = data.chunkIds
      .map(lookupChunk)
      .filter((chunk): chunk is ChunkData => Boolean(chunk));
    const observed = chunks.reduce((total, chunk) => total + chunk.observationTokens, 0);
    const header = `${theme.fg("warning", "◆ memory")} ${theme.fg("dim", `${data.trigger} · ${chunks.length} chunk${chunks.length === 1 ? "" : "s"} · ${k(data.messageTokens)} msgs → ${k(observed)} obs`)}`;
    if (!expanded) return new Text(header, 0, 0);
    const body = chunks.map((chunk) => chunk.observations).join("\n\n");
    return new Text(`${header}\n${theme.fg("dim", body)}`, 0, 0);
  });

  pi.registerEntryRenderer<ReflectionData>(OM_REFLECTION, (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    const header = `${theme.fg("error", "◆ reflection")} ${theme.fg("dim", `generation ${data.generation} · ${k(data.observationTokens)} obs`)}`;
    if (!expanded) return new Text(header, 0, 0);
    const lines = data.observations.split("\n");
    const shown =
      lines.length > COLLAPSED_LINES * 4 ? [...lines.slice(0, COLLAPSED_LINES * 4), "…"] : lines;
    return new Text(`${header}\n${theme.fg("dim", shown.join("\n"))}`, 0, 0);
  });
}

function eventLine(event: OMEvent): string {
  const time = new Date(event.at).toLocaleTimeString("en-US", { hour12: false });
  const ms = event.ms !== undefined ? ` ${event.ms}ms` : "";
  return `${time} ${event.kind}${ms}${event.detail ? ` · ${event.detail}` : ""}`;
}

export function formatStatusReport(
  snapshot: ReturnType<SessionOM["snapshot"]>,
  events: readonly OMEvent[],
  ttlMs: number | undefined,
): string {
  const { state, status } = snapshot;
  const lines = [
    "Observational memory",
    snapshot.disabledReason
      ? `  off: ${snapshot.disabledReason}`
      : `  models: ${snapshot.models.join(" → ")}`,
    `  messages: ${k(status.pendingTokens)} pending / ${k(status.threshold)} threshold / ${k(status.blockAfter)} block`,
    `  unbuffered: ${k(status.unbufferedTokens)} · buffered chunks: ${state.buffered.length}${snapshot.bufferInFlight ? " · observing…" : ""}`,
    `  memory: ${k(state.observationTokens)} obs · generation ${state.generation} · ${state.activeChunks.length} active chunks${snapshot.reflectionInFlight ? " · reflecting…" : ""}${snapshot.bufferedReflectionTokens !== undefined ? ` · reflection ready (${k(snapshot.bufferedReflectionTokens)})` : ""}`,
    `  cache TTL for activation: ${ttlMs === undefined ? "unknown" : `${Math.round(ttlMs / 60_000)}m`}`,
  ];
  if (snapshot.lastError) lines.push(`  last error: ${snapshot.lastError}`);
  const recent = events.slice(-12);
  if (recent.length > 0)
    lines.push("  recent:", ...recent.map((event) => `    ${eventLine(event)}`));
  return lines.join("\n");
}
