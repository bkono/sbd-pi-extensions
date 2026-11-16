#!/usr/bin/env python3
"""Applies a reference solution for each task to a copy of the fixture, so the hidden graders can
be checked: every grader must fail on the fixture and pass on its reference.
Usage: python3 reference-solutions.py <dir with t2-bugfix t3-feature t4-refactor t5-marathon copies>"""
import glob, re, sys, os

root = sys.argv[1]
os.chdir(root)

def sub(path, old, new):
    s = open(path).read()
    assert old in s, (path, old[:70])
    open(path, "w").write(s.replace(old, new, 1))

# T2: gross is list price; the bulk tier is a discount source only.
sub("t2-bugfix/src/pricing/engine.ts", """  const bulkBps = requests.find((r) => r.source === "bulk")?.bps ?? 0;
  // Gross at the tier price: the tier is part of the list price for bulk buyers.
  const grossCents = computeLineTotal(line.qty, line.unitPriceCents, bulkBps);""", """  const grossCents = line.qty * line.unitPriceCents;""")

# T4: options-object signature, every caller updated.
sub("t4-refactor/src/pricing/engine.ts",
    "export function computeLineTotal(qty: number, unitPriceCents: Cents, discountBps: Bps): Cents {",
    "export function priceLineItem({\n  qty,\n  unitPriceCents,\n  discountBps = 0,\n}: { qty: number; unitPriceCents: Cents; discountBps?: Bps }): Cents {")
for f in glob.glob("t4-refactor/src/**/*.ts", recursive=True) + glob.glob("t4-refactor/test/*.ts"):
    if "zz-hidden" in f:
        continue
    s = open(f).read()
    s = re.sub(r"computeLineTotal\(([^,()]+(?:\([^()]*\))?), ([^,()]+(?:\([^()]*\))?), ([^()]+?)\)",
               r"priceLineItem({ qty: \1, unitPriceCents: \2, discountBps: \3 })", s)
    open(f, "w").write(s.replace("computeLineTotal", "priceLineItem"))

# T5: P1 exemption on every class, P2 region caps, P3 exposed cap.
e = "t5-marathon/src/pricing/engine.ts"
sub(e, """    const taxable =
      taxClass === "reduced" ? group : group.filter((l) => !isTaxExempt(l, region));""",
    """    const taxable = group.filter((l) => !isTaxExempt(l, region));""")
sub("t5-marathon/src/types.ts", "  freeShippingThresholdCents: Cents;\n}", "  freeShippingThresholdCents: Cents;\n  maxDiscountBps?: Bps;\n}")
sub("t5-marathon/src/types.ts", "  freeShipping: boolean;\n  warnings: string[];", "  freeShipping: boolean;\n  discountCapBps: Bps;\n  warnings: string[];")
r = "t5-marathon/src/pricing/regions.ts"
for code, cap in [("US-NY", 2500), ("DE-BE", 3000), ("JP-13", 2000)]:
    s = open(r).read()
    i = s.index(f'code: "{code}"'); j = s.index("freeShippingThresholdCents", i); k = s.index("\n", j)
    open(r, "w").write(s[:k] + f"\n    maxDiscountBps: {cap}," + s[k:])
sub(e, "  const discounts = stackDiscounts(grossCents, requests);", "  const discounts = stackDiscounts(grossCents, requests, effectiveCapBps(ctx.region));")
sub(e, "export interface LineContext {", "export function effectiveCapBps(region: Region): Bps {\n  return Math.min(region.maxDiscountBps ?? GLOBAL_DISCOUNT_CAP_BPS, GLOBAL_DISCOUNT_CAP_BPS);\n}\n\nexport interface LineContext {")
sub(e, "    freeShipping: shipping.free,\n    warnings,", "    freeShipping: shipping.free,\n    discountCapBps: effectiveCapBps(region),\n    warnings,")
sub(e, "  out.push(`Total: ${formatCents(b.totalCents, b.currency)}`);", "  out.push(`Discount cap: ${b.discountCapBps / 100}%`);\n  out.push(`Total: ${formatCents(b.totalCents, b.currency)}`);")
s = "t5-marathon/src/api/serialize.ts"
sub(s, "  free_shipping: boolean;\n  warnings: string[];", "  free_shipping: boolean;\n  discount_cap_bps: number;\n  warnings: string[];")
sub(s, "    free_shipping: b.freeShipping,", "    free_shipping: b.freeShipping,\n    discount_cap_bps: b.discountCapBps,")

# T3: gift wrap.
e = "t3-feature/src/pricing/engine.ts"
sub("t3-feature/src/types.ts", "  taxClass: TaxClass;\n}\n\nexport type LoyaltyTier", "  taxClass: TaxClass;\n  giftWrap?: boolean;\n}\n\nexport type LoyaltyTier")
sub("t3-feature/src/types.ts", "  netCents: Cents;\n  taxCents: Cents;\n}", "  netCents: Cents;\n  giftWrapCents: Cents;\n  taxCents: Cents;\n}")
sub("t3-feature/src/types.ts", "  handlingCents: Cents;\n  totalCents: Cents;", "  handlingCents: Cents;\n  giftWrapCents: Cents;\n  totalCents: Cents;")
sub(e, 'export const DEFAULT_CURRENCY = "USD";', 'export const DEFAULT_CURRENCY = "USD";\n\nexport const GIFT_WRAP_CENTS_PER_UNIT: Cents = 499;')
sub(e, "    netCents: grossCents - discountCents,\n    taxCents: 0,", "    netCents: grossCents - discountCents,\n    giftWrapCents: line.giftWrap ? line.qty * GIFT_WRAP_CENTS_PER_UNIT : 0,\n    taxCents: 0,")
sub(e, "      netCents: lines[index].netCents,\n    })),", "      netCents: lines[index].netCents + lines[index].giftWrapCents,\n    })),")
sub(e, "  const taxCents = sumCents(lines.map((l) => l.taxCents));\n  const shipping", "  const taxCents = sumCents(lines.map((l) => l.taxCents));\n  const giftWrapCents = sumCents(lines.map((l) => l.giftWrapCents));\n  const shipping")
sub(e, "    handlingCents: shipping.handlingCents,\n    totalCents:\n      subtotalCents - discountCents + taxCents + shipping.shippingCents + shipping.handlingCents,",
    "    handlingCents: shipping.handlingCents,\n    giftWrapCents,\n    totalCents:\n      subtotalCents - discountCents + taxCents + shipping.shippingCents + shipping.handlingCents + giftWrapCents,")
sub(e, "    b.subtotalCents - b.discountCents + b.taxCents + b.shippingCents + b.handlingCents;", "    b.subtotalCents - b.discountCents + b.taxCents + b.shippingCents + b.handlingCents + b.giftWrapCents;")
sub(e, "  if (b.handlingCents > 0) out.push(`Handling:", "  if (b.giftWrapCents > 0) out.push(`Gift wrap: ${formatCents(b.giftWrapCents, b.currency)}`);\n  if (b.handlingCents > 0) out.push(`Handling:")
sub("t3-feature/src/orders/validation.ts", "  if (!Number.isInteger(line.unitPriceCents)", '  if (line.giftWrap && item.category === "digital") {\n    errors.push(error("GIFT_WRAP_DIGITAL", "digital items cannot be gift wrapped", `${at}.giftWrap`));\n  }\n  if (!Number.isInteger(line.unitPriceCents)')
s = "t3-feature/src/api/serialize.ts"
sub(s, "  tax_class: TaxClass;\n}", "  tax_class: TaxClass;\n  gift_wrap: boolean;\n}")
sub(s, "    tax_class: line.taxClass,\n  };", "    tax_class: line.taxClass,\n    gift_wrap: line.giftWrap === true,\n  };")
sub(s, "    net_cents: line.netCents,\n    tax_cents: line.taxCents,", "    net_cents: line.netCents,\n    gift_wrap_cents: line.giftWrapCents,\n    tax_cents: line.taxCents,")
sub(s, "    handling_cents: b.handlingCents,\n    total_cents", "    handling_cents: b.handlingCents,\n    gift_wrap_cents: b.giftWrapCents,\n    total_cents")
sub(s, "    taxClass: taxClass as TaxClass,\n  };", "    taxClass: taxClass as TaxClass,\n    ...(value.gift_wrap === true ? { giftWrap: true } : {}),\n  };")
print("applied")
