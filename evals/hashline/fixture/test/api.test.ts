import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { route } from "../src/api/handlers.ts";
import { lineToJson, orderFromJson, orderToJson } from "../src/api/serialize.ts";
import { lineFor } from "../src/catalog/catalog.ts";
import { createTestService } from "../src/orders/service.ts";

describe("serialize", () => {
  test("order round-trips", () => {
    const { service } = createTestService();
    const o = service.create({ customerId: "cus_1", region: "US-NY" });
    service.addLine(o.id, "STA-1024", 1);
    const json = orderToJson(service.get(o.id));
    assert.deepEqual(orderFromJson(JSON.parse(JSON.stringify(json))), service.get(o.id));
  });
  test("line json is snake_case", () => {
    assert.deepEqual(Object.keys(lineToJson(lineFor("STA-1024", 1))).sort(), [
      "category",
      "qty",
      "sku",
      "tax_class",
      "unit_price_cents",
      "weight_grams",
    ]);
  });
});

describe("routes", () => {
  test("create, add line, quote", () => {
    const { service } = createTestService();
    const created = route(service, { method: "POST", path: "/orders", body: { customer_id: "c", region: "US-NY" } });
    assert.equal(created.status, 201);
    const id = (created.body as { id: string }).id;
    route(service, { method: "POST", path: `/orders/${id}/lines`, body: { sku: "STA-1024", qty: 1 } });
    const quote = route(service, { method: "GET", path: `/orders/${id}/quote` });
    assert.equal(quote.status, 200);
    assert.equal((quote.body as { subtotal_cents: number }).subtotal_cents, 13243);
  });
  test("list price", () => {
    const { service } = createTestService();
    const res = route(service, { method: "GET", path: "/catalog/STA-1024/price?qty=3" });
    assert.deepEqual(res.body, { sku: "STA-1024", qty: 3, list_cents: 39729 });
  });
  test("unknown route", () => {
    const { service } = createTestService();
    assert.equal(route(service, { method: "GET", path: "/nope" }).status, 404);
  });
  test("validation errors are 422", () => {
    const { service } = createTestService();
    const created = route(service, { method: "POST", path: "/orders", body: { customer_id: "c", region: "US-NY" } });
    const id = (created.body as { id: string }).id;
    const res = route(service, { method: "POST", path: `/orders/${id}/submit` });
    assert.equal(res.status, 422);
  });
});
