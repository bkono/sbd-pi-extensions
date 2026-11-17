// Hidden grader for t7-sustained: checks the end state after all 14 prompts (addendum applied,
// restocking fee renamed to handling fee). Cases use undiscounted US-NY lines so every valid
// implementation of the policy agrees on the cents.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { route } from "../src/api/handlers.ts";
import { lineFor } from "../src/catalog/catalog.ts";
import { InventoryStore } from "../src/inventory/store.ts";
import { FakeGateway, OrderService } from "../src/orders/service.ts";
import { priceOrder } from "../src/pricing/engine.ts";
import * as summary from "../src/reports/summary.ts";
import type { Order } from "../src/types.ts";

const load = async (rel: string) => import(new URL(rel, import.meta.url).href) as Promise<any>;

const order = (lines: Order["lines"], extra: Partial<Order> = {}): Order =>
  ({
    id: "ord_hidden",
    customerId: "cus_h",
    region: "US-NY",
    lines,
    loyaltyTier: "none",
    createdAt: "2026-03-01",
    status: "shipped",
    shippedAt: "2026-03-02",
    ...extra,
  }) as Order;

const req = (sku: string, qty: number, reason = "changed_mind", condition = "resellable") => ({
  sku,
  qty,
  reason,
  condition,
});

function shippedService(skus: [string, number][], loyaltyTier: Order["loyaltyTier"] = "none") {
  const clock = { today: "2026-03-01" };
  const inventory = InventoryStore.withDefaultStock();
  const gateway = new FakeGateway();
  const service = new OrderService({ inventory, gateway, clock: () => clock.today });
  const o = service.create({ customerId: "cus_h", region: "US-NY", loyaltyTier });
  for (const [sku, qty] of skus) service.addLine(o.id, sku, qty);
  service.submit(o.id);
  service.pay(o.id);
  service.fulfil(o.id);
  clock.today = "2026-03-02";
  service.ship(o.id);
  clock.today = "2026-03-10";
  return { service, inventory, gateway, clock, id: o.id };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return "no error";
};

test("hidden S1: ship records shippedAt", () => {
  const { service, id } = shippedService([["STA-1801", 3]]);
  assert.equal((service.get(id) as any).shippedAt, "2026-03-02");
});

test("hidden S2: eligibility rules and precedence (R1, R4, R7)", async () => {
  const { checkReturnEligibility: check } = await load("../src/returns/eligibility.ts");
  const verdict = (o: Order, r: unknown, today: string) => {
    const v = check(o, r, today);
    return v.ok ? "ok" : v.code;
  };
  const std = order([lineFor("STA-1801", 3)]);
  assert.equal(verdict(std, req("STA-9999", 1), "2026-03-05"), "NO_LINE");
  assert.equal(verdict(order([lineFor("STA-1801", 3)], { shippedAt: undefined }), req("STA-1801", 1), "2026-03-05"), "NOT_SHIPPED");
  assert.equal(verdict(std, req("STA-1801", 1), "2026-04-01"), "ok");
  assert.equal(verdict(std, req("STA-1801", 1), "2026-04-02"), "OUTSIDE_WINDOW");
  const per = order([lineFor("PER-1437", 2)]);
  assert.equal(verdict(per, req("PER-1437", 1, "defective"), "2026-03-05"), "ok");
  assert.equal(verdict(per, req("PER-1437", 1, "defective"), "2026-03-06"), "OUTSIDE_WINDOW");
  const dig = order([lineFor("DIG-1761", 1)]);
  assert.equal(verdict(dig, req("DIG-1761", 1, "changed_mind"), "2026-03-03"), "NOT_RETURNABLE");
  assert.equal(verdict(dig, req("DIG-1761", 1, "defective"), "2026-03-16"), "ok");
  assert.equal(verdict(dig, req("DIG-1761", 1, "defective"), "2026-03-17"), "OUTSIDE_WINDOW");
  const haz = order([lineFor("HAZ-1166", 1)]);
  assert.equal(verdict(haz, req("HAZ-1166", 1, "defective"), "2026-03-03"), "FINAL_SALE");
  assert.equal(verdict(haz, req("HAZ-1166", 1, "defective"), "2026-06-01"), "FINAL_SALE");
  assert.equal(verdict(order([lineFor("HAZ-1166", 1)], { shippedAt: undefined }), req("HAZ-1166", 1), "2026-03-03"), "NOT_SHIPPED");
});

test("hidden S3: quotes follow R2, R3 (addendum rate and cap), R5, R6", async () => {
  const { quoteReturn } = await load("../src/returns/quote.ts");
  const small = order([lineFor("STA-1801", 3)]);
  const smallB = priceOrder(small);
  assert.equal(smallB.shippingCents, 2137);
  const changed = quoteReturn(small, smallB, req("STA-1801", 1));
  assert.equal(changed.refundCents, 370);
  assert.equal(changed.handlingFeeCents, 51, "15% of 340 below a 20,000 subtotal");
  assert.equal(changed.shippingRefundCents, 0);
  assert.equal(changed.netRefundCents, 319);
  const wrong = quoteReturn(small, smallB, req("STA-1801", 1, "wrong_item"));
  assert.deepEqual([wrong.handlingFeeCents, wrong.shippingRefundCents, wrong.netRefundCents], [0, 2137, 2507]);
  const again = quoteReturn(small, smallB, req("STA-1801", 1, "wrong_item"), { shippingAlreadyRefunded: true });
  assert.equal(again.shippingRefundCents, 0);
  const plat = order([lineFor("STA-1801", 3)], { loyaltyTier: "platinum" });
  const platQ = quoteReturn(plat, priceOrder(plat), req("STA-1801", 1));
  assert.equal(platQ.handlingFeeCents, 0);
  assert.equal(platQ.netRefundCents, platQ.refundCents);

  const two = order([lineFor("STA-1024", 2)]);
  const tier = quoteReturn(two, priceOrder(two), req("STA-1024", 1));
  assert.equal(tier.handlingFeeCents, 1324, "addendum: 10% of 13,243 on a 26,486 subtotal");
  const three = order([lineFor("STA-1024", 3)]);
  const capped = quoteReturn(three, priceOrder(three), req("STA-1024", 3));
  assert.equal(capped.refundCents, 43253);
  assert.equal(capped.handlingFeeCents, 2500, "capped at 2,500 per request");
  assert.equal(capped.netRefundCents, 40753);

  const per = order([lineFor("PER-1437", 2)]);
  assert.equal(quoteReturn(per, priceOrder(per), req("PER-1437", 1)).handlingFeeCents, 0);
  const bulk = order([lineFor("BUL-1715", 4)]);
  assert.equal(quoteReturn(bulk, priceOrder(bulk), req("BUL-1715", 1, "defective")).handlingFeeCents, 0);
  assert.ok(!("restockingFeeCents" in capped), "renamed to handlingFeeCents");
});

test("hidden S4: service returns: stock, write-offs, over-returns, shipping once, refunded status", () => {
  const { service, inventory, gateway, clock, id } = shippedService([["STA-1801", 3]]);
  const before = inventory.level("STA-1801");
  const q1 = service.requestReturn(id, req("STA-1801", 1, "wrong_item"));
  assert.equal(q1.shippingRefundCents, 2137);
  assert.equal(inventory.level("STA-1801").available, before.available + 1);
  assert.equal(gateway.refunds.at(-1)?.amountCents, q1.netRefundCents);
  const q2 = service.requestReturn(id, req("STA-1801", 1, "wrong_item", "damaged"));
  assert.equal(q2.shippingRefundCents, 0, "shipping refunded once per order");
  assert.equal(inventory.level("STA-1801").available, before.available + 1, "damaged units never become available");
  assert.equal((inventory.level("STA-1801") as any).writtenOff, 1);
  assert.equal(code(() => service.requestReturn(id, req("STA-1801", 2, "defective"))), "OVER_RETURN");
  const returned = service.eventsFor(id).filter((e) => (e.kind as string) === "returned");
  assert.equal(returned.length, 2);
  assert.equal(returned[1]?.amountCents, q2.netRefundCents);
  assert.equal(service.get(id).status, "shipped");
  service.requestReturn(id, req("STA-1801", 1, "defective"));
  assert.equal(service.get(id).status, "refunded");
  const late = shippedService([["STA-1801", 1]]);
  late.clock.today = "2026-04-02";
  assert.equal(code(() => late.service.requestReturn(late.id, req("STA-1801", 1))), "OUTSIDE_WINDOW");
  const haz = shippedService([["HAZ-1166", 1]]);
  assert.equal(code(() => haz.service.requestReturn(haz.id, req("HAZ-1166", 1, "defective"))), "FINAL_SALE");
});

test("hidden S5: split refunds add up to exactly what the line charged (R2 incident)", () => {
  for (const [sku, charged] of [
    ["STA-1024", 43253],
    ["STA-1135", 32236],
  ] as const) {
    const viaReturns = shippedService([[sku, 3]]);
    let sum = 0;
    for (let i = 0; i < 3; i++) sum += viaReturns.service.requestReturn(viaReturns.id, req(sku, 1, "defective")).refundCents;
    assert.equal(sum, charged, `${sku} via requestReturn`);
    const viaRefundUnits = shippedService([[sku, 3]]);
    let sum2 = 0;
    for (let i = 0; i < 3; i++) sum2 += viaRefundUnits.service.refundUnits(viaRefundUnits.id, sku, 1);
    assert.equal(sum2, charged, `${sku} via refundUnits`);
  }
});

test("hidden S6: bulk partial returns refund at the tier the line was charged", () => {
  const { service, id } = shippedService([["BUL-1715", 10]]);
  const line = service.breakdownFor(id)!.lines[0]!;
  assert.ok(line.discountCents > 0, "the line earned the bulk tier");
  const q = service.requestReturn(id, req("BUL-1715", 1, "defective"));
  assert.ok(Math.abs(q.refundCents - (line.netCents + line.taxCents) / 10) <= 1, `${q.refundCents}`);
});

test("hidden S7: API POST /orders/:id/returns", () => {
  const { service, id } = shippedService([["STA-1801", 3]]);
  const ok = route(service, { method: "POST", path: `/orders/${id}/returns`, body: req("STA-1801", 1) });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, {
    sku: "STA-1801",
    qty: 1,
    refund_cents: 370,
    handling_fee_cents: 51,
    shipping_refund_cents: 0,
    net_refund_cents: 319,
  });
  const over = route(service, { method: "POST", path: `/orders/${id}/returns`, body: req("STA-1801", 3, "defective") });
  assert.equal(over.status, 422);
  assert.equal((over.body as any).error.code, "OVER_RETURN");
  const bad = route(service, { method: "POST", path: `/orders/${id}/returns`, body: { sku: "STA-1801", qty: 0, reason: "defective", condition: "resellable" } });
  assert.equal(bad.status, 400);
  assert.equal((bad.body as any).error.code, "BAD_BODY");
  const unknown = route(service, { method: "POST", path: `/orders/${id}/returns`, body: { sku: "STA-1801", qty: 1, reason: "bored", condition: "resellable" } });
  assert.equal(unknown.status, 400);
  const haz = shippedService([["HAZ-1166", 1]]);
  const final = route(haz.service, { method: "POST", path: `/orders/${haz.id}/returns`, body: req("HAZ-1166", 1, "defective") });
  assert.equal(final.status, 422);
  assert.equal((final.body as any).error.code, "FINAL_SALE");
});

test("hidden S8: summarizeReturns and CSV use the handling fee", async () => {
  const quotes = [
    { sku: "A", qty: 1, refundCents: 370, handlingFeeCents: 51, shippingRefundCents: 0, netRefundCents: 319 },
    { sku: "B", qty: 2, refundCents: 1000, handlingFeeCents: 0, shippingRefundCents: 2137, netRefundCents: 3137 },
  ];
  assert.deepEqual((summary as any).summarizeReturns(quotes), {
    count: 2,
    refundCents: 1370,
    handlingFeeCents: 51,
    shippingRefundCents: 2137,
    netRefundCents: 3456,
  });
  const csv = await load("../src/returns/csv.ts");
  assert.equal(csv.RETURNS_CSV_HEADER, "order_id,sku,qty,reason,refund_cents,handling_fee_cents,shipping_refund_cents,net_refund_cents");
  assert.equal(csv.returnQuoteToCsvRow("ord_1", req("A", 1), quotes[0]), "ord_1,A,1,changed_mind,370,51,0,319");
});

test("hidden S9: no restocking left in src or test", () => {
  const files = [
    "src/returns/types.ts",
    "src/returns/quote.ts",
    "src/returns/csv.ts",
    "src/api/handlers.ts",
    "src/reports/summary.ts",
    "src/orders/service.ts",
  ];
  for (const f of ["src/returns/quote.ts", "src/returns/csv.ts"]) {
    assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), `${f} exists`);
  }
  for (const f of files) {
    const p = new URL(`../${f}`, import.meta.url);
    if (existsSync(p)) assert.ok(!/restocking/i.test(readFileSync(p, "utf8")), `${f} still says restocking`);
  }
});

test("hidden S10: docs/RETURNS.md documents the endpoint and every rejection code", () => {
  const p = new URL("../docs/RETURNS.md", import.meta.url);
  assert.ok(existsSync(p), "docs/RETURNS.md exists");
  const doc = readFileSync(p, "utf8");
  assert.match(doc, /\/orders\/[^\s`]*\/returns/);
  for (const c of ["NO_LINE", "NOT_SHIPPED", "FINAL_SALE", "NOT_RETURNABLE", "OUTSIDE_WINDOW", "OVER_RETURN"]) {
    assert.ok(doc.includes(c), `RETURNS.md mentions ${c}`);
  }
  assert.match(doc, /round/i, "the incident root cause (rounding) is described");
});
