// Domain types shared across pricing, orders, inventory and the API layer.

import type { Bps, Cents } from "./util/money.ts";
import type { IsoDate } from "./util/dates.ts";

export type Category = "standard" | "bulk" | "digital" | "perishable" | "hazmat";

export const CATEGORIES: readonly Category[] = [
  "standard",
  "bulk",
  "digital",
  "perishable",
  "hazmat",
];

export type TaxClass = "general" | "reduced" | "exempt" | "digital";

export interface CatalogItem {
  sku: string;
  name: string;
  category: Category;
  unitPriceCents: Cents;
  weightGrams: number;
  taxClass: TaxClass;
}

export interface LineItem {
  sku: string;
  qty: number;
  /** Price per unit at the time the line was added. */
  unitPriceCents: Cents;
  category: Category;
  weightGrams: number;
  taxClass: TaxClass;
}

export type LoyaltyTier = "none" | "silver" | "gold" | "platinum";

export type OrderStatus =
  | "draft"
  | "submitted"
  | "paid"
  | "fulfilled"
  | "shipped"
  | "cancelled"
  | "refunded";

export interface Order {
  id: string;
  customerId: string;
  region: string;
  lines: LineItem[];
  couponCode?: string;
  loyaltyTier: LoyaltyTier;
  createdAt: IsoDate;
  status: OrderStatus;
  /** Set when the order is paid; the breakdown the customer was charged. */
  chargedTotalCents?: Cents;
  notes?: string;
}

export type DiscountSource = "bulk" | "coupon" | "loyalty" | "promo";

export interface AppliedDiscount {
  source: DiscountSource;
  /** Basis points requested by the source before the cap. */
  requestedBps: Bps;
  /** Cents actually taken off after the stacking cap. */
  amountCents: Cents;
}

export interface LinePrice {
  sku: string;
  qty: number;
  unitPriceCents: Cents;
  /** qty * unit price, before discounts. */
  grossCents: Cents;
  discounts: AppliedDiscount[];
  discountCents: Cents;
  /** gross - discount. */
  netCents: Cents;
  taxCents: Cents;
}

export interface PriceBreakdown {
  orderId: string;
  region: string;
  currency: string;
  lines: LinePrice[];
  subtotalCents: Cents;
  discountCents: Cents;
  taxCents: Cents;
  shippingCents: Cents;
  handlingCents: Cents;
  totalCents: Cents;
  freeShipping: boolean;
  warnings: string[];
}

export interface Region {
  code: string;
  name: string;
  currency: string;
  /** General sales tax / VAT. */
  taxBps: Bps;
  /** Reduced rate for the "reduced" tax class. */
  reducedTaxBps: Bps;
  /** Rate for digital goods; some regions tax digital differently. */
  digitalTaxBps: Bps;
  /** Perishable food is tax exempt in these regions. */
  perishableExempt: boolean;
  /** Hazmat cannot ship to this region. */
  hazmatBlocked: boolean;
  shippingZone: ShippingZone;
  freeShippingThresholdCents: Cents;
}

export type ShippingZone = "domestic" | "near" | "far" | "remote";

export interface Coupon {
  code: string;
  description: string;
  bps: Bps;
  /** Order subtotal (before discounts) must reach this. */
  minSubtotalCents: Cents;
  /** Only lines in these categories get the coupon; empty means all. */
  categories: readonly Category[];
  validFrom: IsoDate;
  validTo: IsoDate;
  /** At most this many uses per customer; 0 means unlimited. */
  perCustomerLimit: number;
  stackable: boolean;
}

export interface ValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface OrderEvent {
  orderId: string;
  at: IsoDate;
  kind:
    | "created"
    | "line_added"
    | "line_removed"
    | "submitted"
    | "paid"
    | "fulfilled"
    | "shipped"
    | "cancelled"
    | "refunded"
    | "note";
  detail?: string;
  amountCents?: Cents;
}
