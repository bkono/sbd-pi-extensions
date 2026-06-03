// NOTE: This mapper scans user-provided file paths. Keep the implementation
// in-process; do not use `exec` with template interpolation for grep/wc because
// shell metacharacters in paths would be parsed by `/bin/sh`. See GH #116.
import { readFile, stat } from "node:fs/promises";
import { DetailLevel, SymbolKind } from "../enums.js";
import { detectLanguage } from "../language-detect.js";
import type { FileMap, FileSymbol } from "../types.js";
export const MAPPER_VERSION = 1;

/**
 * Patterns to grep for common structural elements.
 * Each pattern maps to a symbol kind.
 */
const PATTERNS: { pattern: string; kind: SymbolKind }[] = [
  { pattern: "^class ", kind: SymbolKind.Class },
  { pattern: "^def ", kind: SymbolKind.Function },
  { pattern: "^async def ", kind: SymbolKind.Function },
  { pattern: "^func ", kind: SymbolKind.Function },
  { pattern: "^function ", kind: SymbolKind.Function },
  { pattern: "^export ", kind: SymbolKind.Function },
  { pattern: "^struct ", kind: SymbolKind.Struct },
  { pattern: "^enum ", kind: SymbolKind.Enum },
  { pattern: "^interface ", kind: SymbolKind.Interface },
  { pattern: "^type ", kind: SymbolKind.Type },
  { pattern: "^#define ", kind: SymbolKind.Constant },
  { pattern: "^CREATE TABLE", kind: SymbolKind.Table },
  { pattern: "^CREATE VIEW", kind: SymbolKind.View },
  { pattern: "^CREATE FUNCTION", kind: SymbolKind.Function },
  { pattern: "^CREATE PROCEDURE", kind: SymbolKind.Procedure },
  { pattern: "^ALTER TABLE", kind: SymbolKind.Table },
];

interface GrepMatch {
  lineNumber: number;
  content: string;
  kind: SymbolKind;
}

function extractName(line: string): string {
  // Remove common prefixes
  const cleaned = line
    .replace(/^(async\s+)?def\s+/, "")
    .replace(/^class\s+/, "")
    .replace(/^func\s+/, "")
    .replace(/^function\s+/, "")
    .replace(/^export\s+(async\s+)?function\s+/, "")
    .replace(/^export\s+(const|let|var)\s+/, "")
    .replace(/^struct\s+/, "")
    .replace(/^enum\s+/, "")
    .replace(/^interface\s+/, "")
    .replace(/^type\s+/, "")
    .replace(/^#define\s+/, "")
    .replace(/^CREATE\s+(TABLE|VIEW|FUNCTION|PROCEDURE|INDEX|TRIGGER)\s+/i, "")
    .replace(/^ALTER\s+TABLE\s+/i, "");

  // Extract identifier (stop at common delimiters)
  const match = cleaned.match(/^[\w$]+/);
  if (match) {
    return match[0];
  }

  // Fallback: return first word-like thing
  return cleaned.split(/\s|[({<:]/)[0] || "unknown";
}

/**
 * Fallback mapper using grep for basic structure extraction.
 * Works for any file type but produces minimal output.
 */
export async function fallbackMapper(
  filePath: string,
  signal?: AbortSignal,
): Promise<FileMap | null> {
  try {
    // Get file stats
    const stats = await stat(filePath);
    const totalBytes = stats.size;

    // Count lines in JS (matches `wc -l` semantics).
    const fileText = await readFile(filePath, "utf8");
    const lines = fileText.split("\n");
    const totalLines = lines.length - 1;

    const matches: GrepMatch[] = [];
    for (const [index, rawLine] of lines.entries()) {
      if (signal?.aborted) return null;
      const content = rawLine.trim();
      if (!content) continue;

      let matchedKind: SymbolKind | null = null;
      for (const p of PATTERNS) {
        if (new RegExp(p.pattern, "i").test(content)) {
          matchedKind = p.kind;
          break;
        }
      }

      if (matchedKind !== null) {
        matches.push({ lineNumber: index + 1, content, kind: matchedKind });
        if (matches.length >= 500) break;
      }
    }

    // Convert to symbols
    const symbols: FileSymbol[] = matches.map((m, i) => {
      // Estimate end line from next match
      const nextMatch = matches[i + 1];
      const endLine = nextMatch
        ? Math.max(m.lineNumber, nextMatch.lineNumber - 1)
        : Math.min(m.lineNumber + 50, totalLines);

      return {
        name: extractName(m.content),
        kind: m.kind,
        startLine: m.lineNumber,
        endLine,
      };
    });

    // No symbols found — nothing useful to map
    if (symbols.length === 0) {
      return null;
    }

    // Get language info
    const langInfo = detectLanguage(filePath);

    return {
      path: filePath,
      totalLines,
      totalBytes,
      language: langInfo?.name || "Unknown",
      symbols,
      imports: [],
      detailLevel: DetailLevel.Minimal,
    };
  } catch (error) {
    if (signal?.aborted) {
      return null;
    }
    console.error(`Fallback mapper failed: ${error}`);
    return null;
  }
}
