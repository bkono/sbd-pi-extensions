/**
 * Universal ctags mapper for languages without dedicated mappers.
 *
 * Uses universal-ctags when installed to extract symbols.
 * Falls back gracefully when ctags is not available.
 */
// NOTE: This mapper invokes ctags as a subprocess. Use `execFile` (no shell)
// with argv arrays — never `exec` with template interpolation or shell
// redirection — so user file paths are not parsed by `/bin/sh`. See GH #116.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { DetailLevel, SymbolKind } from "../enums.js";
import { detectLanguage } from "../language-detect.js";
import type { FileMap, FileSymbol } from "../types.js";
export const MAPPER_VERSION = 1;

const execFileAsync = promisify(execFile);

// Cache ctags availability check
let ctagsAvailable: boolean | null = null;

/**
 * Map ctags kind identifiers to SymbolKind.
 * Handles both single-letter kinds (legacy format) and full-word kinds (JSON format).
 * See: https://docs.ctags.io/en/latest/man/ctags.1.html
 */
const CTAGS_KIND_MAP: Record<string, SymbolKind> = {
  // Single-letter kinds (legacy/traditional format)
  c: SymbolKind.Class,
  d: SymbolKind.Constant, // macro definition
  e: SymbolKind.Enum,
  f: SymbolKind.Function,
  g: SymbolKind.Enum, // enumeration name
  i: SymbolKind.Interface,
  m: SymbolKind.Method,
  n: SymbolKind.Namespace,
  p: SymbolKind.Property,
  s: SymbolKind.Struct,
  t: SymbolKind.Type,
  v: SymbolKind.Variable,
  x: SymbolKind.Variable, // external variable
  A: SymbolKind.Variable, // alias (Go)
  C: SymbolKind.Class, // class (Python, Ruby)
  F: SymbolKind.Function, // function (many languages)
  I: SymbolKind.Interface, // interface (Go)
  M: SymbolKind.Method, // method
  P: SymbolKind.Property, // property
  S: SymbolKind.Struct, // struct
  T: SymbolKind.Type, // type
  // Language-specific single-letter mappings
  a: SymbolKind.Type, // alias
  b: SymbolKind.Variable, // block (Ruby)
  h: SymbolKind.Module, // header (C)
  l: SymbolKind.Variable, // local
  r: SymbolKind.Function, // receiver (Go method)
  u: SymbolKind.Type, // union
  w: SymbolKind.Property, // field
  z: SymbolKind.Property, // parameter

  // Full-word kinds (JSON output format)
  class: SymbolKind.Class,
  enum: SymbolKind.Enum,
  enumerator: SymbolKind.Enum,
  function: SymbolKind.Function,
  interface: SymbolKind.Interface,
  macro: SymbolKind.Constant,
  member: SymbolKind.Property,
  method: SymbolKind.Method,
  module: SymbolKind.Module,
  namespace: SymbolKind.Namespace,
  package: SymbolKind.Module,
  property: SymbolKind.Property,
  struct: SymbolKind.Struct,
  type: SymbolKind.Type,
  typedef: SymbolKind.Type,
  union: SymbolKind.Type,
  variable: SymbolKind.Variable,
  field: SymbolKind.Property,
  constant: SymbolKind.Constant,
  prototype: SymbolKind.Function,
  alias: SymbolKind.Type,
  trait: SymbolKind.Interface,
};

interface CtagsEntry {
  name: string;
  line: number;
  kind: string;
  pattern?: string;
}

/**
 * Check if universal-ctags is available.
 */
export async function isCtagsAvailable(): Promise<boolean> {
  if (ctagsAvailable !== null) {
    return ctagsAvailable;
  }

  try {
    const { stdout, stderr } = await execFileAsync("ctags", ["--version"], {
      timeout: 2000,
    });
    const banner = `${stdout}\n${stderr}`;
    // Universal Ctags includes "Universal Ctags" in version output
    // Exuberant Ctags also works but is less feature-rich
    ctagsAvailable = banner.includes("Universal Ctags") || banner.includes("Exuberant Ctags");
    return ctagsAvailable;
  } catch {
    ctagsAvailable = false;
    return false;
  }
}

/**
 * Reset ctags availability cache (for testing).
 */
export function resetCtagsCache(): void {
  ctagsAvailable = null;
}

/**
 * Parse ctags JSON output.
 */
function parseCtagsOutput(stdout: string): CtagsEntry[] {
  const entries: CtagsEntry[] = [];

  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line) as {
        name?: string;
        line?: number;
        kind?: string;
        pattern?: string;
      };
      if (entry.name && entry.line && entry.kind) {
        entries.push({
          name: entry.name,
          line: entry.line,
          kind: entry.kind,
          pattern: entry.pattern,
        });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

/**
 * Generate a file map using universal-ctags.
 *
 * Returns null if ctags is not installed or fails.
 */
export async function ctagsMapper(filePath: string, signal?: AbortSignal): Promise<FileMap | null> {
  try {
    // Check if ctags is available
    const available = await isCtagsAvailable();
    if (!available) {
      return null;
    }

    const stats = await stat(filePath);
    const totalBytes = stats.size;
    const fileText = await readFile(filePath, "utf8");
    const totalLines = fileText.split("\n").length - 1;

    if (signal?.aborted) {
      return null;
    }

    // Run ctags with JSON output and line numbers
    // --output-format=json requires Universal Ctags 5.9+
    // --fields=+n ensures line numbers are included in JSON output
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        "ctags",
        ["--output-format=json", "--fields=+n", "-f", "-", filePath],
        {
          signal,
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        },
      ));
    } catch {
      // ctags might not support JSON output, try standard format
      return await ctagsMapperLegacy(filePath, signal);
    }

    if (signal?.aborted) {
      return null;
    }

    // Parse output
    const entries = parseCtagsOutput(stdout);

    if (entries.length === 0) {
      return null;
    }

    // Sort by line number
    entries.sort((a, b) => a.line - b.line);

    // Convert to symbols
    const symbols: FileSymbol[] = entries.map((entry, i) => {
      const nextEntry = entries[i + 1];
      const endLine = nextEntry
        ? Math.max(entry.line, nextEntry.line - 1)
        : Math.min(entry.line + 50, totalLines);

      return {
        name: entry.name,
        kind: CTAGS_KIND_MAP[entry.kind] || SymbolKind.Unknown,
        startLine: entry.line,
        endLine,
      };
    });

    const langInfo = detectLanguage(filePath);

    return {
      path: filePath,
      totalLines,
      totalBytes,
      language: langInfo?.name || "Unknown",
      symbols,
      imports: [],
      detailLevel: DetailLevel.Compact,
    };
  } catch (error) {
    if (signal?.aborted) {
      return null;
    }
    console.error(`ctags mapper failed: ${error}`);
    return null;
  }
}

/**
 * Fallback parser for ctags without JSON output.
 * Parses traditional ctags format: name<tab>file<tab>pattern<tab>kind
 */
async function ctagsMapperLegacy(filePath: string, signal?: AbortSignal): Promise<FileMap | null> {
  try {
    const stats = await stat(filePath);
    const totalBytes = stats.size;
    const fileText = await readFile(filePath, "utf8");
    const totalLines = fileText.split("\n").length - 1;

    // Run ctags with line numbers
    const { stdout } = await execFileAsync("ctags", ["--excmd=number", "-f", "-", filePath], {
      signal,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });

    if (signal?.aborted) {
      return null;
    }

    // Parse traditional format
    const entries: CtagsEntry[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim() || line.startsWith("!")) {
        continue;
      }

      const parts = line.split("\t");
      if (parts.length < 4) {
        continue;
      }

      const [name] = parts;
      const lineStr = parts[2]?.replace(/[";].*$/, "") || "";
      const lineNum = Number.parseInt(lineStr, 10);
      const kind = parts[3]?.trim() || "";

      if (name && !Number.isNaN(lineNum)) {
        entries.push({
          name,
          line: lineNum,
          kind: kind.charAt(0), // First letter is the kind
        });
      }
    }

    if (entries.length === 0) {
      return null;
    }

    // Sort by line number
    entries.sort((a, b) => a.line - b.line);

    // Convert to symbols
    const symbols: FileSymbol[] = entries.map((entry, i) => {
      const nextEntry = entries[i + 1];
      const endLine = nextEntry
        ? Math.max(entry.line, nextEntry.line - 1)
        : Math.min(entry.line + 50, totalLines);

      return {
        name: entry.name,
        kind: CTAGS_KIND_MAP[entry.kind] || SymbolKind.Unknown,
        startLine: entry.line,
        endLine,
      };
    });

    const langInfo = detectLanguage(filePath);

    return {
      path: filePath,
      totalLines,
      totalBytes,
      language: langInfo?.name || "Unknown",
      symbols,
      imports: [],
      detailLevel: DetailLevel.Compact,
    };
  } catch {
    if (signal?.aborted) {
      return null;
    }
    // Silently fail - ctags is optional
    return null;
  }
}
