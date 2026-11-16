// Pricing engine: line pricing, discount stacking, tax, shipping and the order breakdown.
//
// Pricing pipeline for one order (priceOrder):
//   1. price each line (gross, then stacked discounts)
//   2. compute tax per tax class across the whole order, then allocate it to lines
//   3. compute shipping from total weight and the region's zone
//   4. assemble the breakdown and run the invariant audit
//
// All amounts are integer cents. Rates are basis points.

import { findCoupon, isCouponApplicable } from "./coupons.ts";
import { getRegion } from "./regions.ts";
import type {
  AppliedDiscount,
  Category,
  Coupon,
  DiscountSource,
  LineItem,
  LinePrice,
  LoyaltyTier,
  Order,
  PriceBreakdown,
  Region,
  ShippingZone,
  TaxClass,
} from "../types.ts";
import {
  allocateProportionally,
  type Bps,
  BPS_DENOMINATOR,
  type Cents,
  clamp,
  formatCents,
  percentOf,
  sumCents,
  taxOf,
} from "../util/money.ts";
import { addBusinessDays, type IsoDate, isWithin } from "../util/dates.ts";
import { log } from "../util/log.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** No line may be discounted by more than this, whatever the sources request. */
export const GLOBAL_DISCOUNT_CAP_BPS: Bps = 4000;

/** Quantity tiers for bulk-category lines. The highest tier reached applies. */
export const BULK_TIERS: readonly { minQty: number; bps: Bps }[] = [
  { minQty: 10, bps: 800 },
  { minQty: 50, bps: 1200 },
  { minQty: 200, bps: 1500 },
];

export const LOYALTY_BPS: Record<LoyaltyTier, Bps> = {
  none: 0,
  silver: 300,
  gold: 500,
  platinum: 800,
};

/** Discount sources in the order they are applied against the cap. */
export const DISCOUNT_ORDER: readonly DiscountSource[] = ["bulk", "promo", "coupon", "loyalty"];

/** Flat surcharge per hazmat line, on top of zone handling. */
export const HAZMAT_HANDLING_CENTS: Cents = 1250;

/** Orders heavier than this never ship free, whatever the threshold. */
export const FREE_SHIPPING_MAX_GRAMS = 30_000;

export const DEFAULT_CURRENCY = "USD";

// ---------------------------------------------------------------------------
// Category rules
// ---------------------------------------------------------------------------

export interface CategoryRule {
  /** Whether discounts may apply to lines in this category at all. */
  discountable: boolean;
  /** Whether the line contributes weight to shipping. */
  shippable: boolean;
  /** Per-line handling surcharge. */
  handlingCents: Cents;
  /** Hard per-line quantity ceiling. */
  maxQty: number;
  /** Which discount sources are allowed for this category. */
  allowedSources: readonly DiscountSource[];
}

export const CATEGORY_RULES: Record<Category, CategoryRule> = {
  standard: {
    discountable: true,
    shippable: true,
    handlingCents: 0,
    maxQty: 99,
    allowedSources: ["promo", "coupon", "loyalty"],
  },
  bulk: {
    discountable: true,
    shippable: true,
    handlingCents: 0,
    maxQty: 999,
    allowedSources: ["bulk", "promo", "coupon", "loyalty"],
  },
  digital: {
    discountable: true,
    shippable: false,
    handlingCents: 0,
    maxQty: 25,
    allowedSources: ["promo", "coupon"],
  },
  perishable: {
    discountable: true,
    shippable: true,
    handlingCents: 150,
    maxQty: 48,
    allowedSources: ["promo", "coupon", "loyalty"],
  },
  hazmat: {
    discountable: false,
    shippable: true,
    handlingCents: HAZMAT_HANDLING_CENTS,
    maxQty: 12,
    allowedSources: [],
  },
};

export function categoryRule(category: Category): CategoryRule {
  return CATEGORY_RULES[category];
}

// ---------------------------------------------------------------------------
// Shipping rate table
// ---------------------------------------------------------------------------

export interface ShippingRate {
  zone: ShippingZone;
  /** Upper bound (inclusive) of the weight band in grams. */
  maxGrams: number;
  baseCents: Cents;
  perKgCents: Cents;
  handlingCents: Cents;
}

export const SHIPPING_RATES: readonly ShippingRate[] = [
  /*@@SHIPPING@@*/
  { zone: "domestic", maxGrams: 250, baseCents: 399, perKgCents: 40, handlingCents: 0 },
  { zone: "domestic", maxGrams: 500, baseCents: 579, perKgCents: 49, handlingCents: 0 },
  { zone: "domestic", maxGrams: 1000, baseCents: 759, perKgCents: 58, handlingCents: 0 },
  { zone: "domestic", maxGrams: 2000, baseCents: 939, perKgCents: 67, handlingCents: 0 },
  { zone: "domestic", maxGrams: 3000, baseCents: 1119, perKgCents: 76, handlingCents: 0 },
  { zone: "domestic", maxGrams: 5000, baseCents: 1299, perKgCents: 85, handlingCents: 0 },
  { zone: "domestic", maxGrams: 7500, baseCents: 1479, perKgCents: 94, handlingCents: 0 },
  { zone: "domestic", maxGrams: 10000, baseCents: 1659, perKgCents: 103, handlingCents: 0 },
  { zone: "domestic", maxGrams: 15000, baseCents: 1839, perKgCents: 112, handlingCents: 250 },
  { zone: "domestic", maxGrams: 20000, baseCents: 2019, perKgCents: 121, handlingCents: 250 },
  { zone: "domestic", maxGrams: 30000, baseCents: 2199, perKgCents: 130, handlingCents: 250 },
  { zone: "domestic", maxGrams: 50000, baseCents: 2379, perKgCents: 139, handlingCents: 250 },
  { zone: "near", maxGrams: 250, baseCents: 638, perKgCents: 64, handlingCents: 0 },
  { zone: "near", maxGrams: 500, baseCents: 926, perKgCents: 78, handlingCents: 0 },
  { zone: "near", maxGrams: 1000, baseCents: 1214, perKgCents: 93, handlingCents: 0 },
  { zone: "near", maxGrams: 2000, baseCents: 1502, perKgCents: 107, handlingCents: 0 },
  { zone: "near", maxGrams: 3000, baseCents: 1790, perKgCents: 122, handlingCents: 0 },
  { zone: "near", maxGrams: 5000, baseCents: 2078, perKgCents: 136, handlingCents: 0 },
  { zone: "near", maxGrams: 7500, baseCents: 2366, perKgCents: 150, handlingCents: 0 },
  { zone: "near", maxGrams: 10000, baseCents: 2654, perKgCents: 165, handlingCents: 0 },
  { zone: "near", maxGrams: 15000, baseCents: 2942, perKgCents: 179, handlingCents: 400 },
  { zone: "near", maxGrams: 20000, baseCents: 3230, perKgCents: 194, handlingCents: 400 },
  { zone: "near", maxGrams: 30000, baseCents: 3518, perKgCents: 208, handlingCents: 400 },
  { zone: "near", maxGrams: 50000, baseCents: 3806, perKgCents: 222, handlingCents: 400 },
  { zone: "far", maxGrams: 250, baseCents: 958, perKgCents: 96, handlingCents: 0 },
  { zone: "far", maxGrams: 500, baseCents: 1390, perKgCents: 118, handlingCents: 0 },
  { zone: "far", maxGrams: 1000, baseCents: 1822, perKgCents: 139, handlingCents: 0 },
  { zone: "far", maxGrams: 2000, baseCents: 2254, perKgCents: 161, handlingCents: 0 },
  { zone: "far", maxGrams: 3000, baseCents: 2686, perKgCents: 182, handlingCents: 0 },
  { zone: "far", maxGrams: 5000, baseCents: 3118, perKgCents: 204, handlingCents: 0 },
  { zone: "far", maxGrams: 7500, baseCents: 3550, perKgCents: 226, handlingCents: 0 },
  { zone: "far", maxGrams: 10000, baseCents: 3982, perKgCents: 247, handlingCents: 0 },
  { zone: "far", maxGrams: 15000, baseCents: 4414, perKgCents: 269, handlingCents: 600 },
  { zone: "far", maxGrams: 20000, baseCents: 4846, perKgCents: 290, handlingCents: 600 },
  { zone: "far", maxGrams: 30000, baseCents: 5278, perKgCents: 312, handlingCents: 600 },
  { zone: "far", maxGrams: 50000, baseCents: 5710, perKgCents: 334, handlingCents: 600 },
  { zone: "remote", maxGrams: 250, baseCents: 1397, perKgCents: 140, handlingCents: 0 },
  { zone: "remote", maxGrams: 500, baseCents: 2027, perKgCents: 172, handlingCents: 0 },
  { zone: "remote", maxGrams: 1000, baseCents: 2657, perKgCents: 203, handlingCents: 0 },
  { zone: "remote", maxGrams: 2000, baseCents: 3287, perKgCents: 235, handlingCents: 0 },
  { zone: "remote", maxGrams: 3000, baseCents: 3917, perKgCents: 266, handlingCents: 0 },
  { zone: "remote", maxGrams: 5000, baseCents: 4547, perKgCents: 298, handlingCents: 0 },
  { zone: "remote", maxGrams: 7500, baseCents: 5177, perKgCents: 329, handlingCents: 0 },
  { zone: "remote", maxGrams: 10000, baseCents: 5807, perKgCents: 361, handlingCents: 0 },
  { zone: "remote", maxGrams: 15000, baseCents: 6437, perKgCents: 392, handlingCents: 875 },
  { zone: "remote", maxGrams: 20000, baseCents: 7067, perKgCents: 424, handlingCents: 875 },
  { zone: "remote", maxGrams: 30000, baseCents: 7697, perKgCents: 455, handlingCents: 875 },
  { zone: "remote", maxGrams: 50000, baseCents: 8327, perKgCents: 487, handlingCents: 875 },
  /*@@END@@*/
];

/** Days in transit per zone, in business days of the destination region. */
export const TRANSIT_DAYS: Record<ShippingZone, number> = {
  domestic: 3,
  near: 5,
  far: 8,
  remote: 12,
};

export function findShippingRate(zone: ShippingZone, grams: number): ShippingRate | undefined {
  for (const rate of SHIPPING_RATES) {
    if (rate.zone === zone && grams <= rate.maxGrams) return rate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Promotions calendar
// ---------------------------------------------------------------------------

export interface PromoWindow {
  id: string;
  category: Category | "all";
  from: IsoDate;
  to: IsoDate;
  bps: Bps;
}

export const PROMO_WINDOWS: readonly PromoWindow[] = [
  { id: "new-year", category: "all", from: "2026-01-01", to: "2026-01-07", bps: 500 },
  { id: "winter-bulk", category: "bulk", from: "2026-01-15", to: "2026-02-15", bps: 300 },
  { id: "valentines", category: "perishable", from: "2026-02-07", to: "2026-02-14", bps: 1000 },
  { id: "spring-digital", category: "digital", from: "2026-03-20", to: "2026-04-10", bps: 1500 },
  { id: "earth-day", category: "standard", from: "2026-04-20", to: "2026-04-22", bps: 700 },
  { id: "may-bulk", category: "bulk", from: "2026-05-01", to: "2026-05-31", bps: 400 },
  { id: "summer-standard", category: "standard", from: "2026-06-21", to: "2026-07-05", bps: 600 },
  { id: "back-to-school", category: "standard", from: "2026-08-10", to: "2026-08-31", bps: 800 },
  { id: "harvest", category: "perishable", from: "2026-09-15", to: "2026-10-15", bps: 600 },
  { id: "cyber-week", category: "digital", from: "2026-11-27", to: "2026-12-04", bps: 2500 },
  { id: "holiday", category: "all", from: "2026-12-10", to: "2026-12-24", bps: 400 },
];

export function activePromos(category: Category, today: IsoDate): PromoWindow[] {
  return PROMO_WINDOWS.filter(
    (p) => (p.category === "all" || p.category === category) && isWithin(today, p.from, p.to),
  );
}

/** Promotions do not stack with each other: the best active window wins. */
export function promoBps(category: Category, today: IsoDate): Bps {
  let best = 0;
  for (const p of activePromos(category, today)) best = Math.max(best, p.bps);
  return best;
}

// ---------------------------------------------------------------------------
// Line arithmetic
// ---------------------------------------------------------------------------

/**
 * Net cents for `qty` units at `unitPriceCents` with `discountBps` taken off the
 * gross. The discount is rounded half-up on the whole line, not per unit.
 */
export function computeLineTotal(qty: number, unitPriceCents: Cents, discountBps: Bps): Cents {
  if (!Number.isInteger(qty) || qty < 0) throw new RangeError(`bad qty: ${qty}`);
  const gross = qty * unitPriceCents;
  return gross - percentOf(gross, discountBps);
}

export function bulkTierBps(qty: number, category: Category): Bps {
  if (category !== "bulk") return 0;
  let bps = 0;
  for (const tier of BULK_TIERS) if (qty >= tier.minQty) bps = tier.bps;
  return bps;
}

export function loyaltyBps(tier: LoyaltyTier, coupon: Coupon | undefined): Bps {
  // A non-stackable coupon replaces loyalty entirely.
  if (coupon && !coupon.stackable) return 0;
  return LOYALTY_BPS[tier];
}

export function couponBpsFor(line: LineItem, coupon: Coupon | undefined): Bps {
  if (!coupon) return 0;
  if (coupon.categories.length > 0 && !coupon.categories.includes(line.category)) return 0;
  return coupon.bps;
}

export interface DiscountRequest {
  source: DiscountSource;
  bps: Bps;
}

/**
 * Applies discount requests in DISCOUNT_ORDER against `capBps`. Each source gets
 * what it asks for until the cap is reached; later sources get the remainder.
 * Amounts are computed on the line's gross so the order of sources only decides
 * who is cut when the cap binds.
 */
export function stackDiscounts(
  grossCents: Cents,
  requests: readonly DiscountRequest[],
  capBps: Bps = GLOBAL_DISCOUNT_CAP_BPS,
): AppliedDiscount[] {
  const sorted = [...requests]
    .filter((r) => r.bps > 0)
    .sort((a, b) => DISCOUNT_ORDER.indexOf(a.source) - DISCOUNT_ORDER.indexOf(b.source));
  const applied: AppliedDiscount[] = [];
  let remaining = capBps;
  for (const request of sorted) {
    const granted = clamp(request.bps, 0, remaining);
    remaining -= granted;
    applied.push({
      source: request.source,
      requestedBps: request.bps,
      amountCents: percentOf(grossCents, granted),
    });
  }
  return applied;
}

export interface LineContext {
  region: Region;
  coupon: Coupon | undefined;
  loyaltyTier: LoyaltyTier;
  today: IsoDate;
}

export function discountRequestsFor(line: LineItem, ctx: LineContext): DiscountRequest[] {
  const rule = categoryRule(line.category);
  if (!rule.discountable) return [];
  const all: DiscountRequest[] = [
    { source: "bulk", bps: bulkTierBps(line.qty, line.category) },
    { source: "promo", bps: promoBps(line.category, ctx.today) },
    { source: "coupon", bps: couponBpsFor(line, ctx.coupon) },
    { source: "loyalty", bps: loyaltyBps(ctx.loyaltyTier, ctx.coupon) },
  ];
  return all.filter((r) => rule.allowedSources.includes(r.source));
}

/** Prices one line: gross, stacked discounts, net. Tax is filled in later by computeTax. */
export function priceLine(line: LineItem, ctx: LineContext): LinePrice {
  const rule = categoryRule(line.category);
  if (line.qty > rule.maxQty) {
    throw new RangeError(`qty ${line.qty} exceeds max ${rule.maxQty} for ${line.category}`);
  }
  const requests = discountRequestsFor(line, ctx);
  const bulkBps = requests.find((r) => r.source === "bulk")?.bps ?? 0;
  // Gross at the tier price: the tier is part of the list price for bulk buyers.
  const grossCents = computeLineTotal(line.qty, line.unitPriceCents, bulkBps);
  const discounts = stackDiscounts(grossCents, requests);
  const discountCents = sumCents(discounts.map((d) => d.amountCents));
  return {
    sku: line.sku,
    qty: line.qty,
    unitPriceCents: line.unitPriceCents,
    grossCents,
    discounts,
    discountCents,
    netCents: grossCents - discountCents,
    taxCents: 0,
  };
}

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

export function taxRateFor(taxClass: TaxClass, region: Region): Bps {
  switch (taxClass) {
    case "general":
      return region.taxBps;
    case "reduced":
      return region.reducedTaxBps;
    case "digital":
      return region.digitalTaxBps;
    case "exempt":
      return 0;
  }
}

export interface TaxableLine {
  index: number;
  category: Category;
  taxClass: TaxClass;
  netCents: Cents;
}

/** Whether a line is fully exempt from tax in `region`. */
export function isTaxExempt(line: TaxableLine, region: Region): boolean {
  if (line.taxClass === "exempt") return true;
  if (region.perishableExempt && line.category === "perishable") return true;
  return false;
}

/**
 * Tax is computed per tax class over the whole order (sum of nets in the class,
 * times the class rate, rounded half-even once), then allocated back to the lines
 * in proportion to their nets. Rounding once per class keeps order tax within a
 * cent of the exact amount however many lines there are.
 *
 * Returns tax per line, indexed like `lines`.
 */
export function computeTax(lines: readonly TaxableLine[], region: Region): Cents[] {
  const result = lines.map(() => 0);
  const byClass = new Map<TaxClass, TaxableLine[]>();
  for (const line of lines) {
    if (line.taxClass === "exempt") continue;
    const group = byClass.get(line.taxClass) ?? [];
    group.push(line);
    byClass.set(line.taxClass, group);
  }
  for (const [taxClass, group] of byClass) {
    const rate = taxRateFor(taxClass, region);
    if (rate === 0) continue;
    // General and digital classes honour the exemption list; reduced is
    // already the concessionary rate.
    const taxable =
      taxClass === "reduced" ? group : group.filter((l) => !isTaxExempt(l, region));
    const base = sumCents(taxable.map((l) => l.netCents));
    const classTax = taxOf(base, rate);
    const parts = allocateProportionally(
      classTax,
      taxable.map((l) => l.netCents),
    );
    taxable.forEach((l, i) => {
      result[l.index] += parts[i];
    });
  }
  return result;
}

export function effectiveTaxBps(lines: readonly TaxableLine[], region: Region): Bps {
  const net = sumCents(lines.map((l) => l.netCents));
  if (net === 0) return 0;
  const tax = sumCents(computeTax(lines, region));
  return Math.round((tax * BPS_DENOMINATOR) / net);
}

// ---------------------------------------------------------------------------
// Shipping
// ---------------------------------------------------------------------------

export interface ShippingQuote {
  shippingCents: Cents;
  handlingCents: Cents;
  free: boolean;
  totalGrams: number;
  rate: ShippingRate | undefined;
  reason: string;
}

export function shippableGrams(lines: readonly LineItem[]): number {
  let grams = 0;
  for (const line of lines) {
    if (categoryRule(line.category).shippable) grams += line.weightGrams * line.qty;
  }
  return grams;
}

export function lineHandlingCents(lines: readonly LineItem[]): Cents {
  return sumCents(lines.map((l) => categoryRule(l.category).handlingCents));
}

/**
 * Shipping for an order. Free shipping applies when the discounted subtotal reaches
 * the region's threshold, the order has no hazmat lines, and it weighs at most
 * FREE_SHIPPING_MAX_GRAMS. Handling is never free.
 */
export function computeShipping(
  lines: readonly LineItem[],
  region: Region,
  discountedSubtotalCents: Cents,
): ShippingQuote {
  const totalGrams = shippableGrams(lines);
  const handlingFromLines = lineHandlingCents(lines);
  if (totalGrams === 0) {
    return {
      shippingCents: 0,
      handlingCents: handlingFromLines,
      free: true,
      totalGrams,
      rate: undefined,
      reason: "nothing to ship",
    };
  }
  const rate = findShippingRate(region.shippingZone, totalGrams);
  if (!rate) {
    throw new RangeError(`no shipping rate for ${totalGrams}g to zone ${region.shippingZone}`);
  }
  const hasHazmat = lines.some((l) => l.category === "hazmat");
  const qualifies =
    discountedSubtotalCents >= region.freeShippingThresholdCents &&
    !hasHazmat &&
    totalGrams <= FREE_SHIPPING_MAX_GRAMS;
  const kg = Math.ceil(totalGrams / 1000);
  const shippingCents = qualifies ? 0 : rate.baseCents + kg * rate.perKgCents;
  return {
    shippingCents,
    handlingCents: rate.handlingCents + handlingFromLines,
    free: qualifies,
    totalGrams,
    rate,
    reason: qualifies
      ? `free over ${formatCents(region.freeShippingThresholdCents)}`
      : hasHazmat
        ? "hazmat ships at full rate"
        : totalGrams > FREE_SHIPPING_MAX_GRAMS
          ? "too heavy for free shipping"
          : `below ${formatCents(region.freeShippingThresholdCents)}`,
  };
}

export function estimateDeliveryDate(region: Region, shipDate: IsoDate): IsoDate {
  return addBusinessDays(region.code, shipDate, TRANSIT_DAYS[region.shippingZone]);
}

// ---------------------------------------------------------------------------
// Order pricing
// ---------------------------------------------------------------------------

export interface PriceOptions {
  /** Pricing date; defaults to the order's createdAt. */
  today?: IsoDate;
  /** Skip the invariant audit (used by bulk reports). */
  skipAudit?: boolean;
}

export function resolveCoupon(order: Order, subtotalCents: Cents, today: IsoDate): Coupon | undefined {
  if (!order.couponCode) return undefined;
  const coupon = findCoupon(order.couponCode);
  if (!coupon) return undefined;
  return isCouponApplicable(coupon, { subtotalCents, today }) ? coupon : undefined;
}

export function priceOrder(order: Order, options: PriceOptions = {}): PriceBreakdown {
  const region = getRegion(order.region);
  const today = options.today ?? order.createdAt;
  const warnings: string[] = [];
  const listSubtotal = sumCents(order.lines.map((l) => l.qty * l.unitPriceCents));
  const coupon = resolveCoupon(order, listSubtotal, today);
  if (order.couponCode && !coupon) warnings.push(`coupon ${order.couponCode} not applied`);
  const ctx: LineContext = { region, coupon, loyaltyTier: order.loyaltyTier, today };

  const lines = order.lines.map((line) => priceLine(line, ctx));
  const taxes = computeTax(
    order.lines.map((line, index) => ({
      index,
      category: line.category,
      taxClass: line.taxClass,
      netCents: lines[index].netCents,
    })),
    region,
  );
  lines.forEach((line, i) => {
    line.taxCents = taxes[i];
  });

  const subtotalCents = sumCents(lines.map((l) => l.grossCents));
  const discountCents = sumCents(lines.map((l) => l.discountCents));
  const taxCents = sumCents(lines.map((l) => l.taxCents));
  const shipping = computeShipping(order.lines, region, subtotalCents - discountCents);
  if (order.lines.some((l) => l.category === "hazmat") && region.hazmatBlocked) {
    warnings.push(`hazmat cannot ship to ${region.code}`);
  }

  const breakdown: PriceBreakdown = {
    orderId: order.id,
    region: region.code,
    currency: region.currency,
    lines,
    subtotalCents,
    discountCents,
    taxCents,
    shippingCents: shipping.shippingCents,
    handlingCents: shipping.handlingCents,
    totalCents:
      subtotalCents - discountCents + taxCents + shipping.shippingCents + shipping.handlingCents,
    freeShipping: shipping.free,
    warnings,
  };
  if (!options.skipAudit) {
    const problems = auditBreakdown(breakdown);
    if (problems.length > 0) {
      log("error", "breakdown failed audit", { orderId: order.id, problems });
      throw new Error(`breakdown audit failed: ${problems.join("; ")}`);
    }
  }
  return breakdown;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Invariants every breakdown must satisfy. Returns human-readable problems. */
export function auditBreakdown(b: PriceBreakdown): string[] {
  const problems: string[] = [];
  const lineGross = sumCents(b.lines.map((l) => l.grossCents));
  if (lineGross !== b.subtotalCents) problems.push(`subtotal ${b.subtotalCents} != lines ${lineGross}`);
  const lineDiscount = sumCents(b.lines.map((l) => l.discountCents));
  if (lineDiscount !== b.discountCents) problems.push("discount does not match lines");
  const lineTax = sumCents(b.lines.map((l) => l.taxCents));
  if (lineTax !== b.taxCents) problems.push("tax does not match lines");
  for (const line of b.lines) {
    if (line.netCents !== line.grossCents - line.discountCents) {
      problems.push(`line ${line.sku}: net != gross - discount`);
    }
    if (line.netCents < 0) problems.push(`line ${line.sku}: negative net`);
    const cap = percentOf(line.grossCents, GLOBAL_DISCOUNT_CAP_BPS);
    if (line.discountCents > cap + line.discounts.length) {
      problems.push(`line ${line.sku}: discount ${line.discountCents} over cap ${cap}`);
    }
  }
  const expected =
    b.subtotalCents - b.discountCents + b.taxCents + b.shippingCents + b.handlingCents;
  if (expected !== b.totalCents) problems.push(`total ${b.totalCents} != ${expected}`);
  if (b.freeShipping && b.shippingCents !== 0) problems.push("free shipping with a shipping charge");
  return problems;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export function explainLine(line: LinePrice, currency: string): string {
  const parts = [
    `${line.qty} x ${line.sku} @ ${formatCents(line.unitPriceCents, currency)} = ${formatCents(line.grossCents, currency)}`,
  ];
  for (const d of line.discounts) {
    parts.push(`  - ${d.source} (${d.requestedBps / 100}%): -${formatCents(d.amountCents, currency)}`);
  }
  if (line.taxCents > 0) parts.push(`  + tax: ${formatCents(line.taxCents, currency)}`);
  return parts.join("\n");
}

/** Multi-line human summary used by the CLI and in support tickets. */
export function explainBreakdown(b: PriceBreakdown): string {
  const out: string[] = [`Order ${b.orderId} (${b.region})`];
  for (const line of b.lines) out.push(explainLine(line, b.currency));
  out.push(`Subtotal: ${formatCents(b.subtotalCents, b.currency)}`);
  if (b.discountCents > 0) out.push(`Discounts: -${formatCents(b.discountCents, b.currency)}`);
  out.push(`Tax: ${formatCents(b.taxCents, b.currency)}`);
  out.push(
    b.freeShipping
      ? "Shipping: free"
      : `Shipping: ${formatCents(b.shippingCents, b.currency)}`,
  );
  if (b.handlingCents > 0) out.push(`Handling: ${formatCents(b.handlingCents, b.currency)}`);
  out.push(`Total: ${formatCents(b.totalCents, b.currency)}`);
  for (const w of b.warnings) out.push(`! ${w}`);
  return out.join("\n");
}

export interface BreakdownDelta {
  subtotalCents: Cents;
  discountCents: Cents;
  taxCents: Cents;
  shippingCents: Cents;
  totalCents: Cents;
}

export function diffBreakdowns(before: PriceBreakdown, after: PriceBreakdown): BreakdownDelta {
  return {
    subtotalCents: after.subtotalCents - before.subtotalCents,
    discountCents: after.discountCents - before.discountCents,
    taxCents: after.taxCents - before.taxCents,
    shippingCents: after.shippingCents - before.shippingCents,
    totalCents: after.totalCents - before.totalCents,
  };
}

export const CSV_HEADER =
  "order_id,region,subtotal_cents,discount_cents,tax_cents,shipping_cents,handling_cents,total_cents";

export function breakdownToCsvRow(b: PriceBreakdown): string {
  return [
    b.orderId,
    b.region,
    b.subtotalCents,
    b.discountCents,
    b.taxCents,
    b.shippingCents,
    b.handlingCents,
    b.totalCents,
  ].join(",");
}

// ---------------------------------------------------------------------------
// Refunds and re-pricing helpers
// ---------------------------------------------------------------------------

/**
 * The refundable amount for `qty` units of line `lineIndex`: the line's net per unit
 * (after its discounts) times qty, plus the proportional share of the line's tax.
 * Shipping is refunded only when every unit of every line is returned.
 */
export function refundForUnits(b: PriceBreakdown, lineIndex: number, qty: number): Cents {
  const line = b.lines[lineIndex];
  if (!line) throw new RangeError(`no line ${lineIndex}`);
  if (qty < 0 || qty > line.qty) throw new RangeError(`bad refund qty ${qty}`);
  if (qty === 0) return 0;
  const effectiveBps =
    line.grossCents === 0
      ? 0
      : Math.round((line.discountCents * BPS_DENOMINATOR) / line.grossCents);
  const net = computeLineTotal(qty, line.unitPriceCents, effectiveBps);
  const tax = Math.round((line.taxCents * qty) / line.qty);
  return net + tax;
}

export function fullRefund(b: PriceBreakdown): Cents {
  return b.totalCents;
}

/** Re-prices `order` with one line's quantity changed, without mutating it. */
export function quoteWithQty(order: Order, lineIndex: number, qty: number, options: PriceOptions = {}) {
  const lines = order.lines.map((l, i) => (i === lineIndex ? { ...l, qty } : l));
  return priceOrder({ ...order, lines }, options);
}

/** Cheapest unit price a customer could reach for `line` at the best bulk tier. */
export function bestCaseUnitPrice(line: LineItem): Cents {
  const top = BULK_TIERS[BULK_TIERS.length - 1];
  if (line.category !== "bulk" || !top) return line.unitPriceCents;
  const total = computeLineTotal(top.minQty, line.unitPriceCents, top.bps);
  return Math.round(total / top.minQty);
}

/** Lists the shipping options for an order, cheapest first (used by the quote API). */
export function shippingOptions(lines: readonly LineItem[], region: Region): ShippingRate[] {
  const grams = shippableGrams(lines);
  return SHIPPING_RATES.filter((r) => r.zone === region.shippingZone && grams <= r.maxGrams)
    .slice(0, 3)
    .sort((a, b) => a.baseCents - b.baseCents);
}

export function describeZone(zone: ShippingZone): string {
  switch (zone) {
    case "domestic":
      return "Domestic (3 business days)";
    case "near":
      return "Neighbouring country (5 business days)";
    case "far":
      return "International (8 business days)";
    case "remote":
      return "Remote international (12 business days)";
  }
}
