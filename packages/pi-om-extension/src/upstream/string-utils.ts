/**
 * Vendored from @mastra/memory@1.41.0 (Apache-2.0), src/processors/observational-memory.
 * Copyright Mastra AI, Inc. Licensed under the Apache License, Version 2.0.
 * Local changes are limited to import paths and Mastra-only types.
 */
// biome-ignore-all lint: verbatim upstream code

/**
 * Slice a string up to `end` UTF-16 code units without splitting a surrogate
 * pair. If `end` would land immediately after a lone high surrogate
 * (U+D800..U+DBFF), the slice backs off by one code unit so the pair is
 * dropped as a whole.
 *
 * Lone UTF-16 surrogates are rejected by strict JSON parsers (e.g. Anthropic's
 * with `no low surrogate in string`), so any truncation of observer-facing
 * text that could cut an emoji/astral codepoint in half must go through this
 * helper.
 */
export function safeSlice(str: string, end: number): string {
  if (end <= 0) return "";
  if (end >= str.length) return str;
  const code = str.charCodeAt(end - 1);
  const safeEnd = code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
  return str.slice(0, safeEnd);
}
