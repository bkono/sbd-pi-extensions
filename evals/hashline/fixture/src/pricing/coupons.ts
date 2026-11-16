// Coupon definitions and applicability checks.

import type { Category, Coupon } from "../types.ts";
import type { Cents } from "../util/money.ts";
import { type IsoDate, isWithin } from "../util/dates.ts";

export const COUPONS: readonly Coupon[] = [
  /*@@COUPONS@@*/
  {
    code: "LOYAL15A",
    description: "21% off",
    bps: 2100,
    minSubtotalCents: 2500,
    categories: [],
    validFrom: "2026-01-01",
    validTo: "2026-09-28",
    perCustomerLimit: 0,
    stackable: true,
  },
  {
    code: "WELCOME21B",
    description: "16% off bulk items",
    bps: 1600,
    minSubtotalCents: 5000,
    categories: ["bulk"],
    validFrom: "2026-01-01",
    validTo: "2026-07-28",
    perCustomerLimit: 3,
    stackable: true,
  },
  {
    code: "FLASH39C",
    description: "28% off standard items",
    bps: 2800,
    minSubtotalCents: 2500,
    categories: ["standard"],
    validFrom: "2026-05-01",
    validTo: "2026-11-28",
    perCustomerLimit: 3,
    stackable: true,
  },
  {
    code: "FALL13D",
    description: "29% off bulk items",
    bps: 2900,
    minSubtotalCents: 2500,
    categories: ["bulk"],
    validFrom: "2026-02-01",
    validTo: "2026-12-28",
    perCustomerLimit: 1,
    stackable: true,
  },
  {
    code: "FLASH25E",
    description: "10% off",
    bps: 1000,
    minSubtotalCents: 10000,
    categories: [],
    validFrom: "2026-01-01",
    validTo: "2026-09-28",
    perCustomerLimit: 1,
    stackable: true,
  },
  {
    code: "BUNDLE26F",
    description: "12% off",
    bps: 1200,
    minSubtotalCents: 0,
    categories: [],
    validFrom: "2026-04-01",
    validTo: "2026-08-28",
    perCustomerLimit: 0,
    stackable: true,
  },
  {
    code: "SAVE11G",
    description: "22% off",
    bps: 2200,
    minSubtotalCents: 5000,
    categories: [],
    validFrom: "2026-06-01",
    validTo: "2026-09-28",
    perCustomerLimit: 1,
    stackable: true,
  },
  {
    code: "FLASH23H",
    description: "29% off",
    bps: 2900,
    minSubtotalCents: 2500,
    categories: [],
    validFrom: "2026-05-01",
    validTo: "2026-11-28",
    perCustomerLimit: 0,
    stackable: true,
  },
  {
    code: "WELCOME25I",
    description: "29% off digital items",
    bps: 2900,
    minSubtotalCents: 2500,
    categories: ["digital"],
    validFrom: "2026-04-01",
    validTo: "2026-11-28",
    perCustomerLimit: 3,
    stackable: false,
  },
  {
    code: "BUNDLE19J",
    description: "20% off standard items",
    bps: 2000,
    minSubtotalCents: 0,
    categories: ["standard"],
    validFrom: "2026-01-01",
    validTo: "2026-08-28",
    perCustomerLimit: 1,
    stackable: true,
  },
  {
    code: "LOYAL32K",
    description: "23% off standard items",
    bps: 2300,
    minSubtotalCents: 0,
    categories: ["standard"],
    validFrom: "2026-06-01",
    validTo: "2026-11-28",
    perCustomerLimit: 3,
    stackable: true,
  },
  {
    code: "FALL22L",
    description: "5% off digital items",
    bps: 500,
    minSubtotalCents: 0,
    categories: ["digital"],
    validFrom: "2026-06-01",
    validTo: "2026-08-28",
    perCustomerLimit: 0,
    stackable: true,
  },
  {
    code: "WELCOME10M",
    description: "17% off",
    bps: 1700,
    minSubtotalCents: 5000,
    categories: [],
    validFrom: "2026-02-01",
    validTo: "2026-09-28",
    perCustomerLimit: 1,
    stackable: false,
  },
  {
    code: "FLASH8N",
    description: "9% off digital items",
    bps: 900,
    minSubtotalCents: 2500,
    categories: ["digital"],
    validFrom: "2026-05-01",
    validTo: "2026-08-28",
    perCustomerLimit: 0,
    stackable: true,
  },
  {
    code: "LOYAL17O",
    description: "18% off",
    bps: 1800,
    minSubtotalCents: 5000,
    categories: [],
    validFrom: "2026-03-01",
    validTo: "2026-09-28",
    perCustomerLimit: 1,
    stackable: true,
  },
  {
    code: "FALL20P",
    description: "23% off perishable items",
    bps: 2300,
    minSubtotalCents: 10000,
    categories: ["perishable"],
    validFrom: "2026-03-01",
    validTo: "2026-08-28",
    perCustomerLimit: 1,
    stackable: true,
  },
  {
    code: "FLASH8Q",
    description: "29% off digital items",
    bps: 2900,
    minSubtotalCents: 2500,
    categories: ["digital"],
    validFrom: "2026-05-01",
    validTo: "2026-07-28",
    perCustomerLimit: 1,
    stackable: true,
  },
  {
    code: "FLASH21R",
    description: "6% off",
    bps: 600,
    minSubtotalCents: 0,
    categories: [],
    validFrom: "2026-02-01",
    validTo: "2026-09-28",
    perCustomerLimit: 1,
    stackable: true,
  },
  {
    code: "BUNDLE25S",
    description: "10% off perishable items",
    bps: 1000,
    minSubtotalCents: 2500,
    categories: ["perishable"],
    validFrom: "2026-01-01",
    validTo: "2026-10-28",
    perCustomerLimit: 0,
    stackable: true,
  },
  {
    code: "SAVE22T",
    description: "11% off perishable items",
    bps: 1100,
    minSubtotalCents: 10000,
    categories: ["perishable"],
    validFrom: "2026-01-01",
    validTo: "2026-08-28",
    perCustomerLimit: 3,
    stackable: true,
  },
  {
    code: "BUNDLE16U",
    description: "28% off",
    bps: 2800,
    minSubtotalCents: 0,
    categories: [],
    validFrom: "2026-04-01",
    validTo: "2026-08-28",
    perCustomerLimit: 0,
    stackable: true,
  },
  {
    code: "WELCOME38V",
    description: "30% off",
    bps: 3000,
    minSubtotalCents: 2500,
    categories: [],
    validFrom: "2026-04-01",
    validTo: "2026-07-28",
    perCustomerLimit: 1,
    stackable: true,
  },
  {
    code: "VIP16W",
    description: "23% off",
    bps: 2300,
    minSubtotalCents: 5000,
    categories: [],
    validFrom: "2026-03-01",
    validTo: "2026-09-28",
    perCustomerLimit: 0,
    stackable: false,
  },
  {
    code: "SAVE19X",
    description: "28% off perishable items",
    bps: 2800,
    minSubtotalCents: 0,
    categories: ["perishable"],
    validFrom: "2026-05-01",
    validTo: "2026-12-28",
    perCustomerLimit: 3,
    stackable: false,
  },
  {
    code: "BUNDLE12Y",
    description: "13% off perishable items",
    bps: 1300,
    minSubtotalCents: 10000,
    categories: ["perishable"],
    validFrom: "2026-02-01",
    validTo: "2026-08-28",
    perCustomerLimit: 3,
    stackable: true,
  },
  {
    code: "VIP29Z",
    description: "10% off",
    bps: 1000,
    minSubtotalCents: 0,
    categories: [],
    validFrom: "2026-05-01",
    validTo: "2026-10-28",
    perCustomerLimit: 3,
    stackable: true,
  },
  {
    code: "LOYAL5A",
    description: "4% off perishable items",
    bps: 400,
    minSubtotalCents: 10000,
    categories: ["perishable"],
    validFrom: "2026-02-01",
    validTo: "2026-10-28",
    perCustomerLimit: 3,
    stackable: true,
  },
  {
    code: "SPRING29B",
    description: "6% off standard items",
    bps: 600,
    minSubtotalCents: 10000,
    categories: ["standard"],
    validFrom: "2026-01-01",
    validTo: "2026-10-28",
    perCustomerLimit: 0,
    stackable: true,
  },
  {
    code: "TEST10",
    description: "10% off everything (test coupon)",
    bps: 1000,
    minSubtotalCents: 0,
    categories: [],
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    perCustomerLimit: 0,
    stackable: true,
  },
  {
    code: "BIG30",
    description: "30% off everything over $100",
    bps: 3000,
    minSubtotalCents: 10000,
    categories: [],
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    perCustomerLimit: 0,
    stackable: true,
  },
  {
    code: "SOLO15",
    description: "15% off, cannot be combined with loyalty",
    bps: 1500,
    minSubtotalCents: 0,
    categories: [],
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    perCustomerLimit: 1,
    stackable: false,
  },
  /*@@END@@*/
];

const BY_CODE = new Map(COUPONS.map((c) => [c.code.toUpperCase(), c]));

export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

export function findCoupon(code: string): Coupon | undefined {
  return BY_CODE.get(normalizeCouponCode(code));
}

export interface CouponCheck {
  subtotalCents: Cents;
  today: IsoDate;
}

export type CouponRejection = "unknown" | "expired" | "not-yet-valid" | "below-minimum" | "limit-reached";

/** Why `coupon` cannot be used, or undefined when it can. */
export function couponRejection(
  coupon: Coupon | undefined,
  check: CouponCheck,
  usesSoFar = 0,
): CouponRejection | undefined {
  if (!coupon) return "unknown";
  if (check.today < coupon.validFrom) return "not-yet-valid";
  if (!isWithin(check.today, coupon.validFrom, coupon.validTo)) return "expired";
  if (check.subtotalCents < coupon.minSubtotalCents) return "below-minimum";
  if (coupon.perCustomerLimit > 0 && usesSoFar >= coupon.perCustomerLimit) return "limit-reached";
  return undefined;
}

export function isCouponApplicable(coupon: Coupon, check: CouponCheck, usesSoFar = 0): boolean {
  return couponRejection(coupon, check, usesSoFar) === undefined;
}

export function couponsForCategory(category: Category): Coupon[] {
  return COUPONS.filter((c) => c.categories.length === 0 || c.categories.includes(category));
}

export function describeRejection(reason: CouponRejection): string {
  switch (reason) {
    case "unknown":
      return "That coupon code does not exist.";
    case "expired":
      return "That coupon has expired.";
    case "not-yet-valid":
      return "That coupon is not valid yet.";
    case "below-minimum":
      return "Your order does not reach the coupon's minimum.";
    case "limit-reached":
      return "You have already used that coupon the maximum number of times.";
  }
}
