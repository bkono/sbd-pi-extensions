// R2 refund, R3 handling fee (addendum 1 rate), R5 shipping refund, R6 loyalty.

import { refundPartsForUnits } from "../pricing/engine.ts";
import type { Order, PriceBreakdown } from "../types.ts";
import { roundHalfUp } from "../util/money.ts";
import type { ReturnQuote, ReturnRequest } from "./types.ts";

const FEE_CAP_CENTS = 2_500;
const LARGE_ORDER_SUBTOTAL_CENTS = 20_000;

export function quoteReturn(
  order: Order,
  breakdown: PriceBreakdown,
  request: ReturnRequest,
  options: { shippingAlreadyRefunded?: boolean; alreadyReturned?: number } = {},
): ReturnQuote {
  const index = order.lines.findIndex((l) => l.sku === request.sku);
  if (index < 0) throw new RangeError(`no line for ${request.sku}`);
  const line = order.lines[index]!;
  const parts = refundPartsForUnits(breakdown, index, request.qty, options.alreadyReturned ?? 0);
  const refundCents = parts.netCents + parts.taxCents;
  const feeApplies =
    request.reason === "changed_mind" &&
    (line.category === "standard" || line.category === "bulk") &&
    order.loyaltyTier !== "platinum";
  const rate = breakdown.subtotalCents >= LARGE_ORDER_SUBTOTAL_CENTS ? 0.1 : 0.15;
  const handlingFeeCents = feeApplies
    ? Math.min(FEE_CAP_CENTS, roundHalfUp(parts.netCents * rate))
    : 0;
  const shippingRefundCents =
    request.reason === "wrong_item" && !options.shippingAlreadyRefunded
      ? breakdown.shippingCents
      : 0;
  return {
    sku: request.sku,
    qty: request.qty,
    refundCents,
    handlingFeeCents,
    shippingRefundCents,
    netRefundCents: refundCents - handlingFeeCents + shippingRefundCents,
  };
}
