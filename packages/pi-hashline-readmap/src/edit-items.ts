/* biome-ignore-all lint/suspicious/noExplicitAny: edit items arrive as dynamic tool arguments. */
/**
 * The model sends flat edit items, `{op, ...fields}`; programmatic callers may send the nested
 * `{set_line: {...}}` shape. Everything that inspects edits works on the nested shape.
 */
export function unflattenEditItem(item: unknown): unknown {
  if (!item || typeof item !== "object" || typeof (item as any).op !== "string") return item;
  const { op, ...body } = item as Record<string, unknown>;
  return { [op as string]: body };
}

export function unflattenEditItems(items: unknown): unknown[] | undefined {
  return Array.isArray(items) ? items.map(unflattenEditItem) : undefined;
}
