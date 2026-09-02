const ASSIGNMENT_PREFIX = /^[a-z_][a-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+)\s+/i;
const COMMAND_WRAPPER_PREFIX = /^(?:command|sudo)\s+/i;

function normalizeCommandStart(command: string): string {
  let normalized = command.trimStart();
  let previous = "";

  while (normalized !== previous) {
    previous = normalized;
    normalized = normalized.replace(ASSIGNMENT_PREFIX, "");
    normalized = normalized.replace(COMMAND_WRAPPER_PREFIX, "");
    if (/^env\s+/i.test(normalized)) normalized = normalized.replace(/^env\s+/i, "");
  }

  return normalized.toLowerCase().replace(/\s+/g, " ");
}

export function startsWithCommand(
  command: string | undefined | null,
  prefixes: readonly string[],
): boolean {
  if (typeof command !== "string" || command.length === 0) return false;

  const normalized = normalizeCommandStart(command);
  return prefixes.some((prefix) => {
    const normalizedPrefix = prefix.toLowerCase();
    return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix} `);
  });
}
