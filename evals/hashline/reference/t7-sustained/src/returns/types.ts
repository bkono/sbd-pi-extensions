// Returns policy v2 types.

import type { Cents } from "../util/money.ts";

export type ReturnReason = "changed_mind" | "defective" | "wrong_item";
export type ReturnCondition = "resellable" | "damaged";

export interface ReturnRequest {
  sku: string;
  qty: number;
  reason: ReturnReason;
  condition: ReturnCondition;
}

/** R7, in precedence order. */
export type ReturnRejection =
  | "NO_LINE"
  | "NOT_SHIPPED"
  | "FINAL_SALE"
  | "NOT_RETURNABLE"
  | "OUTSIDE_WINDOW"
  | "OVER_RETURN";

export const RETURN_REJECTIONS: readonly ReturnRejection[] = [
  "NO_LINE",
  "NOT_SHIPPED",
  "FINAL_SALE",
  "NOT_RETURNABLE",
  "OUTSIDE_WINDOW",
  "OVER_RETURN",
];

export interface ReturnQuote {
  sku: string;
  qty: number;
  /** R2 refund for the units, before any fee. */
  refundCents: Cents;
  /** R3 (amended), withheld from the refund. */
  handlingFeeCents: Cents;
  /** R5. */
  shippingRefundCents: Cents;
  netRefundCents: Cents;
}
