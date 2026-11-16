// Order validation. Returns every problem, not just the first, so the API can show
// them all at once.

import { findItem } from "../catalog/catalog.ts";
import { categoryRule } from "../pricing/engine.ts";
import { couponRejection, describeRejection, findCoupon } from "../pricing/coupons.ts";
import { findRegion } from "../pricing/regions.ts";
import type { LineItem, LoyaltyTier, Order, ValidationError } from "../types.ts";
import { parseIsoDate } from "../util/dates.ts";
import { sumCents } from "../util/money.ts";

export const MAX_LINES = 50;
export const MAX_NOTES_LENGTH = 500;
export const LOYALTY_TIERS: readonly LoyaltyTier[] = ["none", "silver", "gold", "platinum"];

function error(code: string, message: string, path?: string): ValidationError {
  return path === undefined ? { code, message } : { code, message, path };
}

export function validateLine(line: LineItem, index: number): ValidationError[] {
  const errors: ValidationError[] = [];
  const at = `lines[${index}]`;
  const item = findItem(line.sku);
  if (!item) {
    errors.push(error("UNKNOWN_SKU", `unknown sku ${line.sku}`, `${at}.sku`));
    return errors;
  }
  if (!Number.isInteger(line.qty) || line.qty < 1) {
    errors.push(error("BAD_QTY", "quantity must be a positive integer", `${at}.qty`));
  } else {
    const max = categoryRule(item.category).maxQty;
    if (line.qty > max) {
      errors.push(error("QTY_TOO_HIGH", `at most ${max} of ${item.category} items per line`, `${at}.qty`));
    }
  }
  if (line.category !== item.category) {
    errors.push(error("CATEGORY_MISMATCH", `line category ${line.category} != catalog ${item.category}`, `${at}.category`));
  }
  if (!Number.isInteger(line.unitPriceCents) || line.unitPriceCents < 0) {
    errors.push(error("BAD_PRICE", "unit price must be a non-negative integer", `${at}.unitPriceCents`));
  }
  return errors;
}

export function validateLines(lines: readonly LineItem[]): ValidationError[] {
  const errors: ValidationError[] = [];
  if (lines.length === 0) errors.push(error("NO_LINES", "an order needs at least one line", "lines"));
  if (lines.length > MAX_LINES) errors.push(error("TOO_MANY_LINES", `at most ${MAX_LINES} lines`, "lines"));
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    if (seen.has(line.sku)) {
      errors.push(error("DUPLICATE_SKU", `sku ${line.sku} appears twice; merge the lines`, `lines[${i}].sku`));
    }
    seen.add(line.sku);
    errors.push(...validateLine(line, i));
  });
  return errors;
}

export function validateRegion(order: Order): ValidationError[] {
  const region = findRegion(order.region);
  if (!region) return [error("UNKNOWN_REGION", `unknown region ${order.region}`, "region")];
  const errors: ValidationError[] = [];
  if (region.hazmatBlocked && order.lines.some((l) => l.category === "hazmat")) {
    errors.push(error("HAZMAT_BLOCKED", `hazmat items cannot ship to ${region.code}`, "lines"));
  }
  return errors;
}

export function validateCoupon(order: Order, usesSoFar = 0): ValidationError[] {
  if (!order.couponCode) return [];
  const coupon = findCoupon(order.couponCode);
  const subtotalCents = sumCents(order.lines.map((l) => l.qty * l.unitPriceCents));
  const rejection = couponRejection(coupon, { subtotalCents, today: order.createdAt }, usesSoFar);
  if (!rejection) return [];
  return [error(`COUPON_${rejection.toUpperCase().replaceAll("-", "_")}`, describeRejection(rejection), "couponCode")];
}

export function validateOrder(order: Order, usesSoFar = 0): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!order.customerId) errors.push(error("NO_CUSTOMER", "customerId is required", "customerId"));
  if (!LOYALTY_TIERS.includes(order.loyaltyTier)) {
    errors.push(error("BAD_LOYALTY", `unknown loyalty tier ${order.loyaltyTier}`, "loyaltyTier"));
  }
  try {
    parseIsoDate(order.createdAt);
  } catch {
    errors.push(error("BAD_DATE", "createdAt must be an ISO date", "createdAt"));
  }
  if (order.notes && order.notes.length > MAX_NOTES_LENGTH) {
    errors.push(error("NOTES_TOO_LONG", `notes are limited to ${MAX_NOTES_LENGTH} characters`, "notes"));
  }
  errors.push(...validateLines(order.lines));
  errors.push(...validateRegion(order));
  errors.push(...validateCoupon(order, usesSoFar));
  return errors;
}

export function isValidOrder(order: Order): boolean {
  return validateOrder(order).length === 0;
}
