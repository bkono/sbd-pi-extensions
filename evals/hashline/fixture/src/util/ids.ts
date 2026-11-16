// Deterministic id generation for tests and local runs.

let counter = 0;

export function resetIds(): void {
  counter = 0;
}

export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36).padStart(6, "0")}`;
}

export function isId(value: unknown, prefix: string): value is string {
  return typeof value === "string" && value.startsWith(`${prefix}_`) && value.length === prefix.length + 7;
}
