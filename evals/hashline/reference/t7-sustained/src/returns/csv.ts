import type { ReturnQuote, ReturnRequest } from "./types.ts";

export const RETURNS_CSV_HEADER =
  "order_id,sku,qty,reason,refund_cents,handling_fee_cents,shipping_refund_cents,net_refund_cents";

export function returnQuoteToCsvRow(
  orderId: string,
  request: ReturnRequest,
  quote: ReturnQuote,
): string {
  return [
    orderId,
    quote.sku,
    quote.qty,
    request.reason,
    quote.refundCents,
    quote.handlingFeeCents,
    quote.shippingRefundCents,
    quote.netRefundCents,
  ].join(",");
}
