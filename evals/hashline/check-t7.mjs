// Checks the t7-sustained grader: every hidden test must fail on the fixture plus overlay, and
// pass on a reference solution (reference/t7-sustained files plus the edits below), with the
// visible suite still green. Usage: node evals/hashline/check-t7.mjs
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "t7-check-"));

function prepare(name) {
  const dir = path.join(tmp, name);
  cpSync(path.join(here, "fixture"), dir, { recursive: true });
  cpSync(path.join(here, "overlays/t7-sustained"), dir, { recursive: true });
  return dir;
}

function sub(dir, file, old, next) {
  const p = path.join(dir, file);
  const s = readFileSync(p, "utf8");
  if (!s.includes(old)) throw new Error(`${file}: anchor not found: ${old.slice(0, 80)}`);
  writeFileSync(p, s.replace(old, next));
}

function applyReference(dir) {
  cpSync(path.join(here, "reference/t7-sustained"), dir, { recursive: true });
  sub(dir, "src/types.ts", "  notes?: string;\n}", "  notes?: string;\n  shippedAt?: IsoDate;\n}");
  sub(
    dir,
    "src/types.ts",
    '    | "refunded"\n    | "note";',
    '    | "refunded"\n    | "returned"\n    | "note";',
  );

  const engine = "src/pricing/engine.ts";
  const e = readFileSync(path.join(dir, engine), "utf8");
  const start = e.indexOf("export function refundForUnits(");
  const end = e.indexOf("export function fullRefund(");
  writeFileSync(
    path.join(dir, engine),
    `${e.slice(0, start)}/**
 * R2: the refund for \`qty\` units of a line after \`alreadyRefunded\` units have been refunded.
 * Shares are taken cumulatively, so any split of the line's units refunds exactly its net plus tax.
 */
export function refundPartsForUnits(
  b: PriceBreakdown,
  lineIndex: number,
  qty: number,
  alreadyRefunded = 0,
): { netCents: Cents; taxCents: Cents } {
  const line = b.lines[lineIndex];
  if (!line) throw new RangeError(\`no line \${lineIndex}\`);
  if (qty < 0 || alreadyRefunded < 0 || alreadyRefunded + qty > line.qty) {
    throw new RangeError(\`bad refund qty \${qty}\`);
  }
  const share = (total: Cents, units: number) => Math.round((total * units) / line.qty);
  const upTo = alreadyRefunded + qty;
  return {
    netCents: share(line.netCents, upTo) - share(line.netCents, alreadyRefunded),
    taxCents: share(line.taxCents, upTo) - share(line.taxCents, alreadyRefunded),
  };
}

export function refundForUnits(b: PriceBreakdown, lineIndex: number, qty: number, alreadyRefunded = 0): Cents {
  const parts = refundPartsForUnits(b, lineIndex, qty, alreadyRefunded);
  return parts.netCents + parts.taxCents;
}

${e.slice(end)}`,
  );

  const svc = "src/orders/service.ts";
  sub(
    dir,
    svc,
    'import { validateOrder } from "./validation.ts";',
    'import { validateOrder } from "./validation.ts";\nimport { checkReturnEligibility } from "../returns/eligibility.ts";\nimport { quoteReturn } from "../returns/quote.ts";\nimport type { ReturnQuote, ReturnRequest } from "../returns/types.ts";',
  );
  sub(
    dir,
    svc,
    "  private readonly couponUses = new Map<string, number>();",
    "  private readonly couponUses = new Map<string, number>();\n  private readonly shippingRefunded = new Set<string>();\n  private readonly returnQuotes = new Map<string, ReturnQuote[]>();",
  );
  sub(
    dir,
    svc,
    '    this.move(order, "shipped");\n',
    '    this.move(order, "shipped");\n    order.shippedAt = this.deps.clock();\n',
  );
  sub(
    dir,
    svc,
    "const amount = refundForUnits(breakdown, index, qty);",
    "const amount = refundForUnits(breakdown, index, qty, refunded[index]);",
  );
  sub(
    dir,
    svc,
    "  /** What one more unit of `sku` would add to a draft, before tax and shipping. */",
    `  /** Returns policy v2: R1-R8. */
  requestReturn(orderId: string, request: ReturnRequest): ReturnQuote {
    const order = this.require(orderId);
    const verdict = checkReturnEligibility(order, request, this.deps.clock());
    if (!verdict.ok) throw new OrderError(verdict.code, \`return rejected: \${verdict.code}\`);
    const breakdown = this.breakdowns.get(orderId);
    if (!breakdown) throw new OrderError("NO_BREAKDOWN", "order was never priced");
    const index = order.lines.findIndex((l) => l.sku === request.sku);
    const returned = this.refundedUnits.get(orderId) ?? order.lines.map(() => 0);
    if (returned[index] + request.qty > order.lines[index].qty) {
      throw new OrderError("OVER_RETURN", "cannot return more units than were bought");
    }
    const quote = quoteReturn(order, breakdown, request, {
      shippingAlreadyRefunded: this.shippingRefunded.has(orderId),
      alreadyReturned: returned[index],
    });
    const result = this.deps.gateway.refund(orderId, quote.netRefundCents);
    if (!result.ok) throw new OrderError("REFUND_FAILED", result.reason);
    returned[index] += request.qty;
    this.refundedUnits.set(orderId, returned);
    if (quote.shippingRefundCents > 0) this.shippingRefunded.add(orderId);
    if (request.condition === "damaged") this.deps.inventory.writeOff(request.sku, request.qty);
    else this.deps.inventory.acceptReturn(request.sku, request.qty);
    this.record(orderId, "returned", \`\${request.qty} x \${request.sku} (\${request.reason})\`, quote.netRefundCents);
    if (returned.every((n, i) => n === order.lines[i].qty)) this.move(order, "refunded");
    this.returnQuotes.set(orderId, [...(this.returnQuotes.get(orderId) ?? []), quote]);
    return quote;
  }

  returnsFor(orderId: string): ReturnQuote[] {
    this.require(orderId);
    return structuredClone(this.returnQuotes.get(orderId) ?? []);
  }

  /** What one more unit of \`sku\` would add to a draft, before tax and shipping. */`,
  );

  const store = "src/inventory/store.ts";
  sub(
    dir,
    store,
    "  committed: number;\n}",
    "  committed: number;\n  /** R8: damaged returns, never available. */\n  writtenOff: number;\n}",
  );
  sub(
    dir,
    store,
    "{ sku, available: qty, reserved: 0, committed: 0 }",
    "{ sku, available: qty, reserved: 0, committed: 0, writtenOff: 0 }",
  );
  sub(
    dir,
    store,
    "if (!level) return { sku, available: 0, reserved: 0, committed: 0 };",
    "if (!level) return { sku, available: 0, reserved: 0, committed: 0, writtenOff: 0 };",
  );
  sub(
    dir,
    store,
    "level = { sku, available: 0, reserved: 0, committed: 0 };",
    "level = { sku, available: 0, reserved: 0, committed: 0, writtenOff: 0 };",
  );
  sub(
    dir,
    store,
    "  totals(): {",
    `  /** R8: damaged returned units are counted, never made available. */
  writeOff(sku: string, qty: number): void {
    if (!Number.isInteger(qty) || qty <= 0) throw new RangeError(\`bad write-off qty \${qty}\`);
    this.mutable(sku).writtenOff += qty;
  }

  totals(): {`,
  );

  const api = "src/api/handlers.ts";
  sub(
    dir,
    api,
    'import { breakdownToJson, orderFromJson, orderToJson, ParseError } from "./serialize.ts";',
    'import { breakdownToJson, orderFromJson, orderToJson, ParseError } from "./serialize.ts";\nimport { RETURN_REJECTIONS, type ReturnQuote, type ReturnRequest } from "../returns/types.ts";',
  );
  sub(
    dir,
    api,
    "export function toErrorResponse(",
    `function returnQuoteToJson(q: ReturnQuote) {
  return {
    sku: q.sku,
    qty: q.qty,
    refund_cents: q.refundCents,
    handling_fee_cents: q.handlingFeeCents,
    shipping_refund_cents: q.shippingRefundCents,
    net_refund_cents: q.netRefundCents,
  };
}

export function handleReturn(service: OrderService, orderId: string, body: unknown): Response {
  const sku = bodyField(body, "sku");
  const qty = bodyField(body, "qty");
  const reason = bodyField(body, "reason");
  const condition = bodyField(body, "condition");
  if (
    typeof sku !== "string" ||
    typeof qty !== "number" ||
    !Number.isInteger(qty) ||
    qty <= 0 ||
    !["changed_mind", "defective", "wrong_item"].includes(reason as string) ||
    !["resellable", "damaged"].includes(condition as string)
  ) {
    return fail(400, "BAD_BODY", "expected { sku, qty, reason, condition }");
  }
  try {
    return ok(returnQuoteToJson(service.requestReturn(orderId, { sku, qty, reason, condition } as ReturnRequest)));
  } catch (error) {
    if (error instanceof OrderError && (RETURN_REJECTIONS as readonly string[]).includes(error.code)) {
      return fail(422, error.code, error.message);
    }
    throw error;
  }
}

export function toErrorResponse(`,
  );
  sub(
    dir,
    api,
    '      if (req.method === "POST" && parts[2] === "cancel")',
    '      if (req.method === "POST" && parts[2] === "returns") return handleReturn(service, id, req.body);\n      if (req.method === "GET" && parts[2] === "returns") return ok(service.returnsFor(id).map(returnQuoteToJson));\n      if (req.method === "POST" && parts[2] === "cancel")',
  );

  const rep = "src/reports/summary.ts";
  sub(
    dir,
    rep,
    "export interface RegionSummary {",
    `import type { ReturnQuote } from "../returns/types.ts";

export function summarizeReturns(quotes: readonly ReturnQuote[]) {
  const sum = (f: (q: ReturnQuote) => number) => quotes.reduce((a, q) => a + f(q), 0);
  return {
    count: quotes.length,
    refundCents: sum((q) => q.refundCents),
    handlingFeeCents: sum((q) => q.handlingFeeCents),
    shippingRefundCents: sum((q) => q.shippingRefundCents),
    netRefundCents: sum((q) => q.netRefundCents),
  };
}

export interface RegionSummary {`,
  );
}

function runTests(dir, files) {
  try {
    return execFileSync("node", ["--test", ...files], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
}
const count = (out, k) => Number(new RegExp(`ℹ ${k} (\\d+)`).exec(out)?.[1] ?? -1);

const base = prepare("base");
const ref = prepare("ref");
applyReference(ref);
for (const dir of [base, ref])
  cpSync(path.join(here, "grading/t7-sustained.test.ts"), path.join(dir, "test/zz-hidden.test.ts"));

const baseOut = runTests(base, ["test/zz-hidden.test.ts"]);
const refOut = runTests(ref, ["test/zz-hidden.test.ts"]);
const refVisible = runTests(ref, [
  "test/api.test.ts",
  "test/inventory.test.ts",
  "test/orders.test.ts",
  "test/pricing.test.ts",
]);
console.log(`fixture: hidden pass=${count(baseOut, "pass")} fail=${count(baseOut, "fail")}`);
console.log(
  `reference: hidden pass=${count(refOut, "pass")} fail=${count(refOut, "fail")}; visible pass=${count(refVisible, "pass")} fail=${count(refVisible, "fail")}`,
);
if (count(refOut, "fail") !== 0)
  console.log(
    refOut
      .split("\n")
      .filter((l) => /✖|Error|expected|actual/.test(l))
      .slice(0, 30)
      .join("\n"),
  );
if (count(refVisible, "fail") !== 0)
  console.log(
    refVisible
      .split("\n")
      .filter((l) => /✖/.test(l))
      .slice(0, 10)
      .join("\n"),
  );
const ok =
  count(baseOut, "pass") === 0 && count(refOut, "fail") === 0 && count(refVisible, "fail") === 0;
console.log(ok ? "CHECK PASS" : "CHECK FAIL");
process.exitCode = ok ? 0 : 1;
