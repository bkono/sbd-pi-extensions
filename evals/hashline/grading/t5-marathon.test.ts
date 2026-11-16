import assert from "node:assert/strict";
import { test } from "node:test";
import { breakdownToJson } from "../src/api/serialize.ts";
import { lineFor } from "../src/catalog/catalog.ts";
import { explainBreakdown, priceOrder } from "../src/pricing/engine.ts";
import { getRegion } from "../src/pricing/regions.ts";
import type { Order } from "../src/types.ts";
import { taxOf } from "../src/util/money.ts";

const order = (region: string, lines: Order["lines"], extra: Partial<Order> = {}): Order => ({
  id: "ord_hidden",
  customerId: "cus_h",
  region,
  lines,
  loyaltyTier: "none",
  createdAt: "2026-03-02",
  status: "draft",
  ...extra,
});

test("hidden P1: perishables exempt in US-NY and CA-ON", () => {
  assert.equal(priceOrder(order("US-NY", [lineFor("PER-1030", 2)])).taxCents, 0);
  assert.equal(priceOrder(order("CA-ON", [lineFor("PER-1030", 2)])).taxCents, 0);
});

test("hidden P1: perishables still taxed where not exempt; other reduced lines unaffected", () => {
  const de = priceOrder(order("DE-BE", [lineFor("PER-1030", 2)]));
  assert.equal(de.taxCents, taxOf(2 * 10713, getRegion("DE-BE").reducedTaxBps));
  const mixed = priceOrder(order("US-NY", [lineFor("PER-1030", 1), lineFor("STA-1024", 1)]));
  assert.equal(mixed.lines[0].taxCents, 0);
  assert.equal(mixed.lines[1].taxCents, taxOf(13243, 887));
});

test("hidden P2: region caps", () => {
  assert.equal((getRegion("US-NY") as any).maxDiscountBps, 2500);
  assert.equal((getRegion("DE-BE") as any).maxDiscountBps, 3000);
  assert.equal((getRegion("JP-13") as any).maxDiscountBps, 2000);
  const heavy = { couponCode: "BIG30", loyaltyTier: "platinum" as const };
  const ny = priceOrder(order("US-NY", [lineFor("STA-1024", 1)], heavy));
  assert.equal(ny.discountCents, Math.round((13243 * 2500) / 10000));
  const de = priceOrder(order("DE-BE", [lineFor("STA-1024", 1)], heavy));
  assert.equal(de.discountCents, Math.round((13243 * 3000) / 10000));
  const ca = priceOrder(order("US-CA", [lineFor("STA-1024", 1)], heavy));
  assert.equal(ca.discountCents, Math.round((13243 * 3000) / 10000) + Math.round((13243 * 800) / 10000));
});

test("hidden P3: cap exposed", () => {
  const ny = priceOrder(order("US-NY", [lineFor("STA-1024", 1)])) as any;
  assert.equal(ny.discountCapBps, 2500);
  const ca = priceOrder(order("US-CA", [lineFor("STA-1024", 1)])) as any;
  assert.equal(ca.discountCapBps, 4000);
  assert.match(explainBreakdown(ny), /Discount cap: 25%/);
  assert.equal((breakdownToJson(ny) as any).discount_cap_bps, 2500);
});
