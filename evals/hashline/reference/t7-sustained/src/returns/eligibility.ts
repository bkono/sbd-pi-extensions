// R1 (windows), R4 (non-returnable goods) and R7 (codes and precedence).

import type { Category, Order } from "../types.ts";
import { type IsoDate, parseIsoDate } from "../util/dates.ts";
import type { ReturnRejection, ReturnRequest } from "./types.ts";

const WINDOW_DAYS: Record<Category, number> = {
  standard: 30,
  bulk: 30,
  hazmat: 30,
  perishable: 3,
  digital: 14,
};

export function calendarDaysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((parseIsoDate(to).getTime() - parseIsoDate(from).getTime()) / 86_400_000);
}

export function checkReturnEligibility(
  order: Order,
  request: ReturnRequest,
  today: IsoDate,
): { ok: true } | { ok: false; code: ReturnRejection } {
  const line = order.lines.find((l) => l.sku === request.sku);
  if (!line) return { ok: false, code: "NO_LINE" };
  if (!order.shippedAt) return { ok: false, code: "NOT_SHIPPED" };
  if (line.category === "hazmat") return { ok: false, code: "FINAL_SALE" };
  if (line.category === "digital" && request.reason !== "defective") {
    return { ok: false, code: "NOT_RETURNABLE" };
  }
  if (calendarDaysBetween(order.shippedAt, today) > WINDOW_DAYS[line.category]) {
    return { ok: false, code: "OUTSIDE_WINDOW" };
  }
  return { ok: true };
}
