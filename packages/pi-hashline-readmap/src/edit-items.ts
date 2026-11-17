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

const OP_FIELDS: Record<string, { required: string[]; optional: string[] }> = {
  set_line: { required: ["anchor", "new_text"], optional: [] },
  replace_lines: { required: ["start_anchor", "end_anchor", "new_text"], optional: [] },
  insert_after: { required: ["anchor", "new_text"], optional: ["text"] },
  replace: { required: ["old_text", "new_text"], optional: ["all", "fuzzy"] },
};
/** Field names that mean something to some op; any other key a model adds is ignored. */
const EDIT_FIELDS = new Set([
  ...Object.keys(OP_FIELDS),
  ...Object.values(OP_FIELDS).flatMap((f) => [...f.required, ...f.optional]),
  "replace_symbol",
  "symbol",
  "new_body",
]);

/**
 * A field that belongs to another op (end_anchor on set_line, a nested set_line beside op) would
 * be silently dropped, and a missing required field would crash later: refuse both with a message
 * the model can act on. Unknown keys stay ignored.
 */
export function editItemProblem(item: unknown, index: number): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const raw = item as Record<string, unknown>;
  const flat = typeof raw.op === "string";
  const op = flat
    ? (raw.op as string)
    : Object.keys(OP_FIELDS).find((k) => raw[k] && typeof raw[k] === "object");
  if (!op || !OP_FIELDS[op]) return undefined;
  const body = (flat ? raw : raw[op]) as Record<string, unknown>;
  const fields = OP_FIELDS[op];
  const own = new Set(["op", ...fields.required, ...fields.optional]);
  const stray = Object.keys(body).filter((k) => EDIT_FIELDS.has(k) && !own.has(k));
  if (stray.length) {
    return `edits[${index}] (op "${op}") has ${stray.join(", ")}, which belong${stray.length === 1 ? "s" : ""} to another op; nothing was written. One edit per object: use op "replace_lines" with start_anchor/end_anchor for a range, op "replace" for old_text.`;
  }
  const missing = fields.required.filter(
    (k) => typeof body[k] !== "string" && !(k === "new_text" && typeof body.text === "string"),
  );
  if (missing.length) {
    return `edits[${index}] (op "${op}") is missing ${missing.join(", ")}; nothing was written.`;
  }
  return undefined;
}
