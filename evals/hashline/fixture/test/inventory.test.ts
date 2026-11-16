import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InsufficientStockError, InventoryStore } from "../src/inventory/store.ts";
import { dailySummary, listValue } from "../src/reports/summary.ts";
import { lineFor } from "../src/catalog/catalog.ts";

describe("inventory", () => {
  test("reserve is all or nothing", () => {
    const store = new InventoryStore({ A: 5, B: 1 });
    assert.throws(
      () =>
        store.reserve("o1", [
          { sku: "A", qty: 2 },
          { sku: "B", qty: 2 },
        ]),
      InsufficientStockError,
    );
    assert.equal(store.level("A").available, 5);
  });
  test("release returns reserved and committed units", () => {
    const store = new InventoryStore({ A: 5 });
    store.reserve("o1", [{ sku: "A", qty: 2 }]);
    store.commit("o1");
    assert.equal(store.release("o1"), 2);
    assert.equal(store.level("A").available, 5);
  });
  test("low stock listener fires", () => {
    const store = new InventoryStore({ A: 6 });
    const seen: string[] = [];
    store.onLowStock((sku) => seen.push(sku));
    store.reserve("o1", [{ sku: "A", qty: 1 }]);
    assert.deepEqual(seen, ["A"]);
  });
});

describe("reports", () => {
  test("list value ignores discounts", () => {
    const o = {
      id: "o",
      customerId: "c",
      region: "DE-BE",
      lines: [lineFor("STA-1024", 2)],
      loyaltyTier: "gold" as const,
      createdAt: "2026-03-02",
      status: "paid" as const,
    };
    assert.equal(listValue([o]), 26486);
    const s = dailySummary("2026-03-02", [o]);
    assert.equal(s.regions[0].orders, 1);
    assert.equal(s.categories[0].listCents, 26486);
  });
});
