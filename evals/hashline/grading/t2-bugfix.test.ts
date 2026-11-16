import assert from "node:assert/strict";
import { test } from "node:test";
import { lineFor } from "../src/catalog/catalog.ts";
import { auditBreakdown, priceLine, priceOrder } from "../src/pricing/engine.ts";
import { getRegion } from "../src/pricing/regions.ts";
import type { Order } from "../src/types.ts";

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

test("hidden: bulk tier applies once at 10 units", () => {
  const b = priceOrder(order([lineFor("BUL-1012", 10)]));
  assert.equal(b.lines[0].grossCents, 49870);
  assert.equal(b.lines[0].discountCents, 3990);
  assert.equal(b.lines[0].netCents, 45880);
  assert.deepEqual(auditBreakdown(b), []);
});

test("hidden: bulk 50+ tier is 12% of list gross", () => {
  const ctx = { region: getRegion("DE-BE"), coupon: undefined, loyaltyTier: "none" as const, today: "2026-03-02" };
  const line = priceLine(lineFor("BUL-1049", 60), ctx);
  assert.equal(line.grossCents, 60 * 2833);
  assert.equal(line.discountCents, Math.round((60 * 2833 * 1200) / 10000));
});

test("hidden: bulk tier stacks with a coupon on list gross", () => {
  const b = priceOrder(order([lineFor("BUL-1012", 10)], { couponCode: "TEST10" }));
  assert.equal(b.lines[0].grossCents, 49870);
  assert.equal(b.lines[0].discountCents, 3990 + 4987);
});

test("hidden: non-bulk pricing unchanged", () => {
  const b = priceOrder(order([lineFor("STA-1024", 2)], { couponCode: "TEST10", loyaltyTier: "gold" }));
  assert.equal(b.subtotalCents, 26486);
  assert.equal(b.discountCents, 3973);
});
