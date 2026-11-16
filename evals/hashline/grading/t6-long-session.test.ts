import assert from "node:assert/strict";
import { test } from "node:test";
import { breakdownToJson } from "../src/api/serialize.ts";
import { lineFor } from "../src/catalog/catalog.ts";
import { breakdownToCsvRow, CSV_HEADER, explainBreakdown, priceOrder } from "../src/pricing/engine.ts";
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

test("hidden P1: perishables exempt where exempt, taxed elsewhere", () => {
  assert.equal(priceOrder(order("US-NY", [lineFor("PER-1030", 2)])).taxCents, 0);
  assert.equal(priceOrder(order("CA-ON", [lineFor("PER-1030", 2)])).taxCents, 0);
  const de = priceOrder(order("DE-BE", [lineFor("PER-1030", 2)]));
  assert.equal(de.taxCents, taxOf(2 * 10713, getRegion("DE-BE").reducedTaxBps));
});

test("hidden P2: region caps", () => {
  assert.equal((getRegion("US-NY") as any).maxDiscountBps, 2500);
  assert.equal((getRegion("DE-BE") as any).maxDiscountBps, 3000);
  assert.equal((getRegion("JP-13") as any).maxDiscountBps, 2000);
  const heavy = { couponCode: "BIG30", loyaltyTier: "platinum" as const };
  const ny = priceOrder(order("US-NY", [lineFor("STA-1024", 1)], heavy));
  assert.equal(ny.discountCents, Math.round((13243 * 2500) / 10000));
  const ca = priceOrder(order("US-CA", [lineFor("STA-1024", 1)], heavy));
  assert.equal(ca.discountCents, Math.round((13243 * 3000) / 10000) + Math.round((13243 * 800) / 10000));
});

test("hidden P3: cap in breakdown and json", () => {
  const ny = priceOrder(order("US-NY", [lineFor("STA-1024", 1)])) as any;
  assert.equal(ny.discountCapBps, 2500);
  assert.equal((priceOrder(order("US-CA", [lineFor("STA-1024", 1)])) as any).discountCapBps, 4000);
  assert.equal((breakdownToJson(ny) as any).discount_cap_bps, 2500);
});

test("hidden P5: csv column", () => {
  assert.ok(CSV_HEADER.endsWith(",discount_cap_bps"), CSV_HEADER);
  const ny = priceOrder(order("US-NY", [lineFor("STA-1024", 1)]));
  assert.ok(breakdownToCsvRow(ny).endsWith(",2500"), breakdownToCsvRow(ny));
  assert.equal(breakdownToCsvRow(ny).split(",").length, CSV_HEADER.split(",").length);
});

test("hidden P7: cap line placement and condition", () => {
  const withDiscount = explainBreakdown(priceOrder(order("US-NY", [lineFor("STA-1024", 1)], { couponCode: "TEST10" }))).split("\n");
  const d = withDiscount.findIndex((l) => l.startsWith("Discounts:"));
  assert.ok(d >= 0);
  assert.match(withDiscount[d + 1] ?? "", /^Discount cap: 25%/);
  const noDiscount = explainBreakdown(priceOrder(order("US-NY", [lineFor("STA-1024", 1)]))).split("\n");
  const s = noDiscount.findIndex((l) => l.startsWith("Subtotal:"));
  assert.match(noDiscount[s + 1] ?? "", /^Discount cap: 25%/);
  const ca = explainBreakdown(priceOrder(order("US-CA", [lineFor("STA-1024", 1)], { couponCode: "TEST10" })));
  assert.doesNotMatch(ca, /Discount cap/);
});
