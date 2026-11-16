// HTTP-ish handlers over OrderService. Transport-free: a request is { method, path,
// body } and a response is { status, body }, so tests can call route() directly.

import { getItem, searchCatalog } from "../catalog/catalog.ts";
import { OrderError, type OrderService } from "../orders/service.ts";
import { computeLineTotal, explainBreakdown, priceOrder } from "../pricing/engine.ts";
import { findRegion } from "../pricing/regions.ts";
import { InsufficientStockError } from "../inventory/store.ts";
import { breakdownToJson, orderFromJson, orderToJson, ParseError } from "./serialize.ts";

export interface Request {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
}

export interface Response {
  status: number;
  body: unknown;
}

const ok = (body: unknown): Response => ({ status: 200, body });
const created = (body: unknown): Response => ({ status: 201, body });
const fail = (status: number, code: string, message: string, details?: unknown): Response => ({
  status,
  body: details === undefined ? { error: { code, message } } : { error: { code, message, details } },
});

function bodyField(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

export function handleCreateOrder(service: OrderService, body: unknown): Response {
  const customerId = bodyField(body, "customer_id");
  const region = bodyField(body, "region");
  if (typeof customerId !== "string" || typeof region !== "string") {
    return fail(400, "BAD_REQUEST", "customer_id and region are required");
  }
  if (!findRegion(region)) return fail(422, "UNKNOWN_REGION", `unknown region ${region}`);
  const tier = bodyField(body, "loyalty_tier");
  const order = service.create({
    customerId,
    region,
    loyaltyTier: typeof tier === "string" ? (tier as never) : "none",
  });
  return created(orderToJson(order));
}

export function handleAddLine(service: OrderService, orderId: string, body: unknown): Response {
  const sku = bodyField(body, "sku");
  const qty = bodyField(body, "qty");
  if (typeof sku !== "string" || typeof qty !== "number") return fail(400, "BAD_REQUEST", "sku and qty are required");
  return ok(orderToJson(service.addLine(orderId, sku, qty)));
}

export function handleQuote(service: OrderService, orderId: string, format?: string): Response {
  const breakdown = service.quote(orderId);
  if (format === "text") return ok({ text: explainBreakdown(breakdown) });
  return ok(breakdownToJson(breakdown));
}

/** Prices an order sent inline, without storing it. */
export function handleAnonymousQuote(body: unknown): Response {
  const order = orderFromJson(body);
  return ok(breakdownToJson(priceOrder(order)));
}

/** Price of `qty` units before any discounts, for the product page. */
export function handleListPrice(sku: string, qty: number): Response {
  const item = getItem(sku);
  return ok({ sku, qty, list_cents: computeLineTotal(qty, item.unitPriceCents, 0) });
}

export function handleSubmit(service: OrderService, orderId: string): Response {
  return ok(breakdownToJson(service.submit(orderId)));
}

export function handlePay(service: OrderService, orderId: string): Response {
  return ok(breakdownToJson(service.pay(orderId)));
}

export function handleCancel(service: OrderService, orderId: string, body: unknown): Response {
  const reason = bodyField(body, "reason");
  service.cancel(orderId, typeof reason === "string" ? reason : undefined);
  return ok(orderToJson(service.get(orderId)));
}

export function handleSearch(query: string): Response {
  return ok({ results: searchCatalog(query).map((i) => ({ sku: i.sku, name: i.name, price_cents: i.unitPriceCents })) });
}

/** Maps domain errors to HTTP responses; anything else is a 500. */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof ParseError) return fail(400, "BAD_BODY", error.message);
  if (error instanceof InsufficientStockError) {
    return fail(409, "OUT_OF_STOCK", error.message, { sku: error.sku, available: error.available });
  }
  if (error instanceof OrderError) {
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "INVALID" ? 422 : 409;
    return fail(status, error.code, error.message, error.errors.length ? error.errors : undefined);
  }
  if (error instanceof RangeError) return fail(422, "OUT_OF_RANGE", error.message);
  return fail(500, "INTERNAL", "unexpected error");
}

export function route(service: OrderService, req: Request): Response {
  try {
    const parts = req.path.split("?")[0]!.split("/").filter(Boolean);
    const query = new URLSearchParams(req.path.split("?")[1] ?? "");
    if (req.method === "POST" && parts.length === 1 && parts[0] === "orders") {
      return handleCreateOrder(service, req.body);
    }
    if (parts[0] === "orders" && parts[1]) {
      const id = parts[1];
      if (req.method === "GET" && parts.length === 2) return ok(orderToJson(service.get(id)));
      if (req.method === "POST" && parts[2] === "lines") return handleAddLine(service, id, req.body);
      if (req.method === "GET" && parts[2] === "quote") return handleQuote(service, id, query.get("format") ?? undefined);
      if (req.method === "POST" && parts[2] === "submit") return handleSubmit(service, id);
      if (req.method === "POST" && parts[2] === "pay") return handlePay(service, id);
      if (req.method === "POST" && parts[2] === "cancel") return handleCancel(service, id, req.body);
    }
    if (req.method === "POST" && parts[0] === "quote") return handleAnonymousQuote(req.body);
    if (req.method === "GET" && parts[0] === "catalog" && parts[1] === "search") {
      return handleSearch(query.get("q") ?? "");
    }
    if (req.method === "GET" && parts[0] === "catalog" && parts[1] && parts[2] === "price") {
      return handleListPrice(parts[1], Number(query.get("qty") ?? "1"));
    }
    return fail(404, "NO_ROUTE", `no route for ${req.method} ${req.path}`);
  } catch (error) {
    return toErrorResponse(error);
  }
}
