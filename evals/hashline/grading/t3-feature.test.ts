import assert from "node:assert/strict";
import { test } from "node:test";
import { breakdownToJson, orderFromJson, orderToJson } from "../src/api/serialize.ts";
import { lineFor } from "../src/catalog/catalog.ts";
import * as engine from "../src/pricing/engine.ts";
import { validateOrder } from "../src/orders/validation.ts";
import type { Order } from "../src/types.ts";
import { taxOf } from "../src/util/money.ts";

const wrap = (sku: string, qty: number) => ({ ...lineFor(sku, qty), giftWrap: true });
const order = (lines: Order["lines"], extra: Partial<Order> = {}): Order => ({
  id: "ord_hidden",
  customerId: "cus_h",
  region: "DE-BE",
  lines,
  loyaltyTier: "none",
  createdAt: "2026-03-02",
  status: "draft",
  ...extra,
});

test("hidden: constant exported", () => {
  assert.equal((engine as Record<string, unknown>).GIFT_WRAP_CENTS_PER_UNIT, 499);
});

test("hidden: fee per unit, taxed, in total, audit passes", () => {
  const b = engine.priceOrder(order([wrap("STA-1024", 2)])) as any;
  assert.equal(b.giftWrapCents, 998);
  assert.equal(b.lines[0].giftWrapCents, 998);
  assert.equal(b.subtotalCents, 26486);
  assert.equal(b.taxCents, taxOf(26486 + 998, 1900));
  assert.equal(
    b.totalCents,
    b.subtotalCents - b.discountCents + b.taxCents + b.shippingCents + b.handlingCents + 998,
  );
  assert.deepEqual(engine.auditBreakdown(b), []);
});

test("hidden: fee is not discounted", () => {
  const plain = engine.priceOrder(order([lineFor("STA-1024", 1)], { couponCode: "TEST10" }));
  const wrapped = engine.priceOrder(order([wrap("STA-1024", 1)], { couponCode: "TEST10" })) as any;
  assert.equal(wrapped.discountCents, plain.discountCents);
  assert.equal(wrapped.giftWrapCents, 499);
});

test("hidden: unwrapped lines carry no fee", () => {
  const b = engine.priceOrder(order([lineFor("STA-1024", 1), wrap("STA-1061", 1)])) as any;
  assert.equal(b.lines[0].giftWrapCents ?? 0, 0);
  assert.equal(b.lines[1].giftWrapCents, 499);
  assert.equal(b.giftWrapCents, 499);
});

test("hidden: exempt line stays exempt", () => {
  const b = engine.priceOrder(order([wrap("STA-1098", 1)])) as any;
  assert.equal(b.taxCents, 0);
  assert.equal(b.giftWrapCents, 499);
});

test("hidden: fee does not count toward free shipping", () => {
  // 12242 is under DE-BE's 12500 threshold; 12242 + 499 would cross it.
  const b = engine.priceOrder(order([wrap("STA-1209", 1)]));
  assert.equal(b.freeShipping, false);
});

test("hidden: explain shows gift wrap", () => {
  const b = engine.priceOrder(order([wrap("STA-1024", 2)]));
  assert.match(engine.explainBreakdown(b), /Gift wrap: [^0-9]{0,4}9\.98/);
  const plain = engine.priceOrder(order([lineFor("STA-1024", 2)]));
  assert.doesNotMatch(engine.explainBreakdown(plain), /Gift wrap/);
});

test("hidden: digital cannot be wrapped", () => {
  const codes = validateOrder(order([wrap("DIG-1021", 1)])).map((e) => e.code);
  assert.ok(codes.includes("GIFT_WRAP_DIGITAL"), codes.join(","));
  assert.deepEqual(validateOrder(order([wrap("STA-1024", 1)])), []);
});

test("hidden: json carries gift wrap", () => {
  const o = order([wrap("STA-1024", 2), lineFor("STA-1061", 1)]);
  const json = orderToJson(o) as any;
  assert.equal(json.lines[0].gift_wrap, true);
  assert.equal(json.lines[1].gift_wrap ?? false, false);
  const back = orderFromJson(JSON.parse(JSON.stringify(json)));
  assert.equal(back.lines[0].giftWrap, true);
  assert.equal(back.lines[1].giftWrap ?? false, false);
  const bj = breakdownToJson(engine.priceOrder(o)) as any;
  assert.equal(bj.gift_wrap_cents, 998);
  assert.equal(bj.lines[0].gift_wrap_cents, 998);
});
