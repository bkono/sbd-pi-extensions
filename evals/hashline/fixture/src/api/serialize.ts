// Wire format for the public API: snake_case JSON. Parsing validates shape only;
// business rules live in orders/validation.ts.

import type {
  AppliedDiscount,
  Category,
  LineItem,
  LinePrice,
  LoyaltyTier,
  Order,
  OrderStatus,
  PriceBreakdown,
  TaxClass,
} from "../types.ts";
import { CATEGORIES } from "../types.ts";

export interface LineJson {
  sku: string;
  qty: number;
  unit_price_cents: number;
  category: Category;
  weight_grams: number;
  tax_class: TaxClass;
}

export interface OrderJson {
  id: string;
  customer_id: string;
  region: string;
  lines: LineJson[];
  coupon_code: string | null;
  loyalty_tier: LoyaltyTier;
  created_at: string;
  status: OrderStatus;
  charged_total_cents: number | null;
  notes: string | null;
}

export interface DiscountJson {
  source: AppliedDiscount["source"];
  requested_bps: number;
  amount_cents: number;
}

export interface LinePriceJson {
  sku: string;
  qty: number;
  unit_price_cents: number;
  gross_cents: number;
  discounts: DiscountJson[];
  discount_cents: number;
  net_cents: number;
  tax_cents: number;
}

export interface BreakdownJson {
  order_id: string;
  region: string;
  currency: string;
  lines: LinePriceJson[];
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  shipping_cents: number;
  handling_cents: number;
  total_cents: number;
  free_shipping: boolean;
  warnings: string[];
}

export class ParseError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ParseError";
    this.path = path;
  }
}

export function lineToJson(line: LineItem): LineJson {
  return {
    sku: line.sku,
    qty: line.qty,
    unit_price_cents: line.unitPriceCents,
    category: line.category,
    weight_grams: line.weightGrams,
    tax_class: line.taxClass,
  };
}

export function orderToJson(order: Order): OrderJson {
  return {
    id: order.id,
    customer_id: order.customerId,
    region: order.region,
    lines: order.lines.map(lineToJson),
    coupon_code: order.couponCode ?? null,
    loyalty_tier: order.loyaltyTier,
    created_at: order.createdAt,
    status: order.status,
    charged_total_cents: order.chargedTotalCents ?? null,
    notes: order.notes ?? null,
  };
}

function discountToJson(d: AppliedDiscount): DiscountJson {
  return { source: d.source, requested_bps: d.requestedBps, amount_cents: d.amountCents };
}

export function linePriceToJson(line: LinePrice): LinePriceJson {
  return {
    sku: line.sku,
    qty: line.qty,
    unit_price_cents: line.unitPriceCents,
    gross_cents: line.grossCents,
    discounts: line.discounts.map(discountToJson),
    discount_cents: line.discountCents,
    net_cents: line.netCents,
    tax_cents: line.taxCents,
  };
}

export function breakdownToJson(b: PriceBreakdown): BreakdownJson {
  return {
    order_id: b.orderId,
    region: b.region,
    currency: b.currency,
    lines: b.lines.map(linePriceToJson),
    subtotal_cents: b.subtotalCents,
    discount_cents: b.discountCents,
    tax_cents: b.taxCents,
    shipping_cents: b.shippingCents,
    handling_cents: b.handlingCents,
    total_cents: b.totalCents,
    free_shipping: b.freeShipping,
    warnings: [...b.warnings],
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== "string") throw new ParseError(`${path}.${key}`, "expected a string");
  return v;
}

function int(obj: Record<string, unknown>, key: string, path: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v)) throw new ParseError(`${path}.${key}`, "expected an integer");
  return v;
}

function optStr(obj: Record<string, unknown>, key: string, path: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ParseError(`${path}.${key}`, "expected a string or null");
  return v;
}

const TAX_CLASSES: readonly TaxClass[] = ["general", "reduced", "exempt", "digital"];

export function lineFromJson(value: unknown, path = "line"): LineItem {
  if (!isObject(value)) throw new ParseError(path, "expected an object");
  const category = str(value, "category", path);
  if (!CATEGORIES.includes(category as Category)) throw new ParseError(`${path}.category`, `unknown category ${category}`);
  const taxClass = str(value, "tax_class", path);
  if (!TAX_CLASSES.includes(taxClass as TaxClass)) throw new ParseError(`${path}.tax_class`, `unknown tax class ${taxClass}`);
  return {
    sku: str(value, "sku", path),
    qty: int(value, "qty", path),
    unitPriceCents: int(value, "unit_price_cents", path),
    category: category as Category,
    weightGrams: int(value, "weight_grams", path),
    taxClass: taxClass as TaxClass,
  };
}

export function orderFromJson(value: unknown): Order {
  const path = "order";
  if (!isObject(value)) throw new ParseError(path, "expected an object");
  const lines = value.lines;
  if (!Array.isArray(lines)) throw new ParseError(`${path}.lines`, "expected an array");
  const order: Order = {
    id: str(value, "id", path),
    customerId: str(value, "customer_id", path),
    region: str(value, "region", path),
    lines: lines.map((l, i) => lineFromJson(l, `${path}.lines[${i}]`)),
    loyaltyTier: str(value, "loyalty_tier", path) as LoyaltyTier,
    createdAt: str(value, "created_at", path),
    status: str(value, "status", path) as OrderStatus,
  };
  const coupon = optStr(value, "coupon_code", path);
  if (coupon !== undefined) order.couponCode = coupon;
  const notes = optStr(value, "notes", path);
  if (notes !== undefined) order.notes = notes;
  const charged = value.charged_total_cents;
  if (typeof charged === "number") order.chargedTotalCents = charged;
  return order;
}
