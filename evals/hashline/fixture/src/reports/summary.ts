// Daily sales summaries by region and category. Runs over priced breakdowns plus the
// orders they came from.

import { computeLineTotal, priceOrder } from "../pricing/engine.ts";
import type { Category, Order, PriceBreakdown } from "../types.ts";
import { formatCents, sumCents, type Cents } from "../util/money.ts";

export interface RegionSummary {
  region: string;
  orders: number;
  grossCents: Cents;
  discountCents: Cents;
  taxCents: Cents;
  shippingCents: Cents;
  totalCents: Cents;
}

export interface CategorySummary {
  category: Category;
  units: number;
  listCents: Cents;
  netCents: Cents;
}

export interface DailySummary {
  date: string;
  regions: RegionSummary[];
  categories: CategorySummary[];
  totalCents: Cents;
  averageOrderCents: Cents;
}

export function summarizeRegions(breakdowns: readonly PriceBreakdown[]): RegionSummary[] {
  const byRegion = new Map<string, RegionSummary>();
  for (const b of breakdowns) {
    const row = byRegion.get(b.region) ?? {
      region: b.region,
      orders: 0,
      grossCents: 0,
      discountCents: 0,
      taxCents: 0,
      shippingCents: 0,
      totalCents: 0,
    };
    row.orders += 1;
    row.grossCents += b.subtotalCents;
    row.discountCents += b.discountCents;
    row.taxCents += b.taxCents;
    row.shippingCents += b.shippingCents;
    row.totalCents += b.totalCents;
    byRegion.set(b.region, row);
  }
  return [...byRegion.values()].sort((a, b) => b.totalCents - a.totalCents || a.region.localeCompare(b.region));
}

export function summarizeCategories(orders: readonly Order[], breakdowns: readonly PriceBreakdown[]): CategorySummary[] {
  const byCategory = new Map<Category, CategorySummary>();
  orders.forEach((order, i) => {
    const b = breakdowns[i];
    order.lines.forEach((line, j) => {
      const row = byCategory.get(line.category) ?? { category: line.category, units: 0, listCents: 0, netCents: 0 };
      row.units += line.qty;
      row.listCents += computeLineTotal(line.qty, line.unitPriceCents, 0);
      row.netCents += b?.lines[j]?.netCents ?? 0;
      byCategory.set(line.category, row);
    });
  });
  return [...byCategory.values()].sort((a, b) => a.category.localeCompare(b.category));
}

export function dailySummary(date: string, orders: readonly Order[]): DailySummary {
  const todays = orders.filter((o) => o.createdAt === date && o.status !== "draft" && o.status !== "cancelled");
  const breakdowns = todays.map((o) => priceOrder(o, { skipAudit: true }));
  const totalCents = sumCents(breakdowns.map((b) => b.totalCents));
  return {
    date,
    regions: summarizeRegions(breakdowns),
    categories: summarizeCategories(todays, breakdowns),
    totalCents,
    averageOrderCents: todays.length ? Math.round(totalCents / todays.length) : 0,
  };
}

/** List-price value of the units in `orders`, ignoring discounts. */
export function listValue(orders: readonly Order[]): Cents {
  let total = 0;
  for (const order of orders) {
    for (const line of order.lines) total += computeLineTotal(line.qty, line.unitPriceCents, 0);
  }
  return total;
}

export function renderSummary(s: DailySummary): string {
  const lines = [`Sales for ${s.date}: ${formatCents(s.totalCents)} (avg ${formatCents(s.averageOrderCents)})`];
  for (const r of s.regions) {
    lines.push(`  ${r.region}: ${r.orders} orders, ${formatCents(r.totalCents)} (tax ${formatCents(r.taxCents)})`);
  }
  for (const c of s.categories) {
    lines.push(`  [${c.category}] ${c.units} units, net ${formatCents(c.netCents)} of ${formatCents(c.listCents)} list`);
  }
  return lines.join("\n");
}
