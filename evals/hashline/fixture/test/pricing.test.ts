import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { lineFor } from "../src/catalog/catalog.ts";
import {
  auditBreakdown,
  bulkTierBps,
  computeLineTotal,
  computeShipping,
  computeTax,
  explainBreakdown,
  priceOrder,
  promoBps,
  stackDiscounts,
} from "../src/pricing/engine.ts";
import { getRegion } from "../src/pricing/regions.ts";
import type { Order } from "../src/types.ts";
import { allocateProportionally, roundHalfEven, taxOf } from "../src/util/money.ts";

function order(partial: Partial<Order> & Pick<Order, "lines">): Order {
  return {
    id: "ord_test",
    customerId: "cus_1",
    region: "DE-BE",
    loyaltyTier: "none",
    createdAt: "2026-03-02",
    status: "draft",
    ...partial,
  };
}

describe("money", () => {
  test("roundHalfEven sends halves to even", () => {
    assert.equal(roundHalfEven(2.5), 2);
    assert.equal(roundHalfEven(3.5), 4);
    assert.equal(roundHalfEven(2.51), 3);
  });
  test("allocateProportionally sums exactly", () => {
    const parts = allocateProportionally(100, [1, 1, 1]);
    assert.deepEqual(parts, [34, 33, 33]);
    assert.equal(taxOf(1000, 1900), 190);
  });
});

describe("line arithmetic", () => {
  test("computeLineTotal applies discount on the whole line", () => {
    assert.equal(computeLineTotal(3, 999, 0), 2997);
    assert.equal(computeLineTotal(3, 999, 1000), 2697);
  });
  test("bulk tiers", () => {
    assert.equal(bulkTierBps(9, "bulk"), 0);
    assert.equal(bulkTierBps(10, "bulk"), 800);
    assert.equal(bulkTierBps(60, "bulk"), 1200);
    assert.equal(bulkTierBps(60, "standard"), 0);
  });
  test("stackDiscounts respects order and cap", () => {
    const applied = stackDiscounts(10000, [
      { source: "loyalty", bps: 800 },
      { source: "coupon", bps: 3000 },
      { source: "promo", bps: 500 },
    ]);
    assert.deepEqual(
      applied.map((d) => [d.source, d.amountCents]),
      [
        ["promo", 500],
        ["coupon", 3000],
        ["loyalty", 500],
      ],
    );
  });
  test("no promo on a quiet day", () => {
    assert.equal(promoBps("standard", "2026-03-02"), 0);
    assert.equal(promoBps("digital", "2026-11-30"), 2500);
  });
});

describe("priceOrder", () => {
  test("standard line, coupon and loyalty", () => {
    const b = priceOrder(
      order({ lines: [lineFor("STA-1024", 2)], couponCode: "TEST10", loyaltyTier: "gold" }),
    );
    assert.equal(b.subtotalCents, 26486);
    assert.equal(b.discountCents, 2649 + 1324);
    assert.equal(b.taxCents, taxOf(26486 - 3973, 1900));
    assert.deepEqual(auditBreakdown(b), []);
  });
  test("small bulk line below the tier", () => {
    const b = priceOrder(order({ lines: [lineFor("BUL-1012", 4)] }));
    assert.equal(b.lines[0].grossCents, 4 * 4987);
    assert.equal(b.lines[0].discountCents, 0);
  });
  test("hazmat is never discounted", () => {
    const b = priceOrder(order({ lines: [lineFor("HAZ-1018", 1)], couponCode: "TEST10" }));
    assert.equal(b.discountCents, 0);
    assert.ok(b.handlingCents >= 1250);
  });
  test("non-stackable coupon drops loyalty", () => {
    const b = priceOrder(
      order({ lines: [lineFor("STA-1024", 1)], couponCode: "SOLO15", loyaltyTier: "platinum" }),
    );
    assert.deepEqual(
      b.lines[0].discounts.map((d) => d.source),
      ["coupon"],
    );
  });
  test("explainBreakdown mentions the total", () => {
    const b = priceOrder(order({ lines: [lineFor("STA-1024", 1)] }));
    assert.match(explainBreakdown(b), /Total: /);
  });
});

describe("tax", () => {
  test("reduced rate for perishables where they are taxed", () => {
    const region = getRegion("DE-BE");
    const tax = computeTax(
      [{ index: 0, category: "perishable", taxClass: "reduced", netCents: 10000 }],
      region,
    );
    assert.equal(tax[0], taxOf(10000, region.reducedTaxBps));
  });
  test("digital uses the digital rate", () => {
    const region = getRegion("US-NY");
    const tax = computeTax([{ index: 0, category: "digital", taxClass: "digital", netCents: 5000 }], region);
    assert.equal(tax[0], taxOf(5000, region.digitalTaxBps));
  });
});

describe("shipping", () => {
  test("free over the threshold", () => {
    const region = getRegion("US-NY");
    const q = computeShipping([lineFor("STA-1024", 1)], region, 13243);
    assert.equal(q.free, true);
    assert.equal(q.shippingCents, 0);
  });
  test("charged below the threshold", () => {
    const region = getRegion("US-NY");
    const q = computeShipping([lineFor("STA-1024", 1)], region, 1000);
    assert.equal(q.free, false);
    assert.ok(q.shippingCents > 0);
  });
});
