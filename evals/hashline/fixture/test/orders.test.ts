import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { lineFor } from "../src/catalog/catalog.ts";
import { createTestService, OrderError } from "../src/orders/service.ts";
import { validateOrder } from "../src/orders/validation.ts";
import type { Order } from "../src/types.ts";

describe("validation", () => {
  const base: Order = {
    id: "ord_v",
    customerId: "cus_1",
    region: "DE-BE",
    lines: [lineFor("STA-1024", 1)],
    loyaltyTier: "none",
    createdAt: "2026-03-02",
    status: "draft",
  };
  test("a good order has no errors", () => {
    assert.deepEqual(validateOrder(base), []);
  });
  test("collects every problem", () => {
    const codes = validateOrder({ ...base, customerId: "", region: "XX-YY", lines: [] }).map((e) => e.code);
    assert.deepEqual(codes.sort(), ["NO_CUSTOMER", "NO_LINES", "UNKNOWN_REGION"]);
  });
  test("hazmat blocked regions", () => {
    const codes = validateOrder({ ...base, region: "JP-13", lines: [lineFor("HAZ-1018", 1)] }).map((e) => e.code);
    assert.ok(codes.includes("HAZMAT_BLOCKED"));
  });
  test("qty ceiling per category", () => {
    const codes = validateOrder({ ...base, lines: [lineFor("DIG-1021", 26)] }).map((e) => e.code);
    assert.ok(codes.includes("QTY_TOO_HIGH"));
  });
});

describe("lifecycle", () => {
  test("submit, pay, fulfil, ship", () => {
    const { service, inventory, gateway } = createTestService();
    const o = service.create({ customerId: "cus_1", region: "DE-BE" });
    service.addLine(o.id, "STA-1024", 2);
    const b = service.submit(o.id);
    assert.equal(inventory.level("STA-1024").reserved, 2);
    service.pay(o.id);
    assert.equal(gateway.charges[0].amountCents, b.totalCents);
    assert.equal(inventory.level("STA-1024").committed, 2);
    service.fulfil(o.id);
    service.ship(o.id);
    assert.equal(service.get(o.id).status, "shipped");
    assert.equal(inventory.level("STA-1024").committed, 0);
  });
  test("cancel after payment refunds in full and releases stock", () => {
    const { service, inventory, gateway } = createTestService();
    const o = service.create({ customerId: "cus_1", region: "DE-BE" });
    service.addLine(o.id, "STA-1024", 1);
    service.submit(o.id);
    const b = service.pay(o.id);
    service.cancel(o.id);
    assert.equal(gateway.refunds[0].amountCents, b.totalCents);
    assert.equal(inventory.level("STA-1024").available, 100);
  });
  test("cannot ship a draft", () => {
    const { service } = createTestService();
    const o = service.create({ customerId: "cus_1", region: "DE-BE" });
    assert.throws(() => service.ship(o.id), OrderError);
  });
  test("partial refund of a shipped line", () => {
    const { service } = createTestService();
    const o = service.create({ customerId: "cus_1", region: "DE-BE" });
    service.addLine(o.id, "STA-1024", 2);
    service.submit(o.id);
    service.pay(o.id);
    service.fulfil(o.id);
    service.ship(o.id);
    const amount = service.refundUnits(o.id, "STA-1024", 1);
    const b = service.breakdownFor(o.id)!;
    assert.equal(amount, Math.round(b.lines[0].netCents / 2) + Math.round(b.lines[0].taxCents / 2));
    assert.equal(service.get(o.id).status, "shipped");
  });
  test("marginal unit cost is the list price", () => {
    const { service } = createTestService();
    const o = service.create({ customerId: "cus_1", region: "DE-BE" });
    assert.equal(service.marginalUnitCost(o.id, "STA-1024"), 13243);
  });
});
