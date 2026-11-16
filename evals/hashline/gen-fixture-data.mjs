// Generates the fixture's data tables deterministically (catalog, regions, coupons, and the
// shipping-rate table spliced into engine.ts). Run once; the output is committed.
// Usage: node evals/hashline/gen-fixture-data.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture");
let seed = 0x5eed1234;
const rand = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 1_000_000) / 1_000_000;
};
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// ---------- catalog ----------
const nouns = {
  standard: [
    "Desk Lamp",
    "Notebook",
    "Water Bottle",
    "Backpack",
    "Headphones",
    "Mouse Pad",
    "Mug",
    "Umbrella",
    "Phone Stand",
    "Cable Kit",
  ],
  bulk: [
    "Copy Paper Case",
    "Pallet Wrap",
    "Shipping Boxes",
    "Packing Peanuts",
    "Paper Towels",
    "Trash Bags",
    "Zip Ties",
    "Batteries AA",
    "Pens Box",
    "Tape Rolls",
  ],
  digital: [
    "Ebook",
    "Font License",
    "Stock Photo Pack",
    "Plugin Seat",
    "Course Access",
    "Template Kit",
    "Audio Loop Pack",
    "Icon Set",
    "Game Key",
    "Software Seat",
  ],
  perishable: [
    "Coffee Beans",
    "Green Tea",
    "Dark Chocolate",
    "Granola",
    "Olive Oil",
    "Honey",
    "Dried Mango",
    "Almonds",
    "Oat Milk",
    "Sourdough Starter",
  ],
  hazmat: [
    "Lithium Pack",
    "Spray Paint",
    "Lighter Fluid",
    "Pool Chlorine",
    "Aerosol Cleaner",
    "Propane Canister",
    "Bleach Concentrate",
    "Fireworks Kit",
    "Epoxy Resin",
    "Paint Thinner",
  ],
};
const adjectives = [
  "Classic",
  "Pro",
  "Eco",
  "Mini",
  "Max",
  "Studio",
  "Travel",
  "Basic",
  "Prime",
  "Ultra",
  "Field",
  "Core",
];
const taxClassFor = (c) =>
  c === "digital"
    ? "digital"
    : c === "perishable"
      ? "reduced"
      : rand() < 0.08
        ? "exempt"
        : "general";
const catalog = [];
for (const category of Object.keys(nouns)) {
  for (let i = 0; i < 24; i++) {
    const noun = nouns[category][i % 10];
    const adj = adjectives[(i * 7 + category.length) % adjectives.length];
    const sku = `${category.slice(0, 3).toUpperCase()}-${String(1000 + i * 37 + category.length * 3)}`;
    catalog.push({
      sku,
      name: `${adj} ${noun}`,
      category,
      unitPriceCents:
        category === "bulk"
          ? int(899, 6999)
          : category === "digital"
            ? int(199, 4999)
            : int(299, 19999),
      weightGrams: category === "digital" ? 0 : int(50, category === "bulk" ? 12000 : 3000),
      taxClass: taxClassFor(category),
    });
  }
}
const catalogRows = catalog
  .map(
    (c) =>
      `  { sku: "${c.sku}", name: "${c.name}", category: "${c.category}", unitPriceCents: ${c.unitPriceCents}, weightGrams: ${c.weightGrams}, taxClass: "${c.taxClass}" },`,
  )
  .join("\n");
writeFileSync(
  path.join(root, "src/catalog/catalog-data.ts"),
  `// Generated catalog. Do not edit by hand; regenerate with gen-fixture-data.mjs.

import type { CatalogItem } from "../types.ts";

export const CATALOG: readonly CatalogItem[] = [
${catalogRows}
];
`,
);

// ---------- regions ----------
const countries = [
  ["US", "USD", ["NY", "CA", "TX", "WA", "OR", "FL", "IL", "MA", "CO", "NJ", "PA", "GA"]],
  ["CA", "CAD", ["ON", "QC", "BC", "AB", "NS", "MB"]],
  ["DE", "EUR", ["BE", "BY", "HH", "NW", "BW", "SN"]],
  ["FR", "EUR", ["IDF", "ARA", "NAQ", "OCC", "PAC"]],
  ["GB", "GBP", ["ENG", "SCT", "WLS", "NIR"]],
  ["JP", "JPY", ["13", "27", "01", "14", "23"]],
  ["AU", "AUD", ["NSW", "VIC", "QLD", "WA", "SA"]],
  ["BR", "BRL", ["SP", "RJ", "MG"]],
  ["IN", "INR", ["MH", "KA", "DL"]],
];
const zoneFor = (cc) =>
  cc === "US"
    ? "domestic"
    : cc === "CA"
      ? "near"
      : ["BR", "IN", "AU"].includes(cc)
        ? "remote"
        : "far";
const regions = [];
for (const [cc, currency, subs] of countries) {
  const base = {
    US: 600,
    CA: 1300,
    DE: 1900,
    FR: 2000,
    GB: 2000,
    JP: 1000,
    AU: 1000,
    BR: 1700,
    IN: 1800,
  }[cc];
  for (const s of subs) {
    const code = `${cc}-${s}`;
    const taxBps = cc === "US" ? int(0, 1025) : base;
    regions.push({
      code,
      name: `${s} (${cc})`,
      currency,
      taxBps,
      reducedTaxBps: cc === "US" ? Math.round(taxBps / 2) : Math.round(base * 0.37),
      digitalTaxBps: cc === "US" ? (rand() < 0.4 ? 0 : taxBps) : base,
      perishableExempt: cc === "US" ? rand() < 0.6 : cc === "GB" || cc === "CA",
      hazmatBlocked: cc === "JP" || cc === "AU" ? true : rand() < 0.1,
      shippingZone: zoneFor(cc),
      freeShippingThresholdCents:
        cc === "US" ? pick([4900, 5900, 7500]) : pick([7500, 9900, 12500, 15000]),
    });
  }
}
// Pin the values the eval questions depend on.
const pin = (code, patch) =>
  Object.assign(
    regions.find((r) => r.code === code),
    patch,
  );
pin("US-NY", {
  taxBps: 887,
  reducedTaxBps: 444,
  digitalTaxBps: 887,
  perishableExempt: true,
  hazmatBlocked: false,
  freeShippingThresholdCents: 5900,
});
pin("CA-ON", {
  taxBps: 1300,
  perishableExempt: true,
  freeShippingThresholdCents: 9900,
  hazmatBlocked: false,
});
pin("DE-BE", { perishableExempt: false, hazmatBlocked: false, freeShippingThresholdCents: 12500 });
pin("JP-13", { hazmatBlocked: true, freeShippingThresholdCents: 15000 });
pin("US-OR", { taxBps: 0, reducedTaxBps: 0, digitalTaxBps: 0, perishableExempt: true });
const regionRows = regions
  .map(
    (r) =>
      `  {\n    code: "${r.code}",\n    name: "${r.name}",\n    currency: "${r.currency}",\n    taxBps: ${r.taxBps},\n    reducedTaxBps: ${r.reducedTaxBps},\n    digitalTaxBps: ${r.digitalTaxBps},\n    perishableExempt: ${r.perishableExempt},\n    hazmatBlocked: ${r.hazmatBlocked},\n    shippingZone: "${r.shippingZone}",\n    freeShippingThresholdCents: ${r.freeShippingThresholdCents},\n  },`,
  )
  .join("\n");
writeFileSync(
  path.join(root, "src/pricing/regions.ts"),
  `// Region table: tax, shipping zone and free-shipping thresholds per region.
// Edit rows by hand when finance publishes new rates.

import type { Region } from "../types.ts";

export const REGIONS: readonly Region[] = [
${regionRows}
];

const BY_CODE = new Map(REGIONS.map((r) => [r.code, r]));

export function findRegion(code: string): Region | undefined {
  return BY_CODE.get(code);
}

export function getRegion(code: string): Region {
  const region = BY_CODE.get(code);
  if (!region) throw new RangeError(\`unknown region: \${code}\`);
  return region;
}

export function regionsInZone(zone: Region["shippingZone"]): Region[] {
  return REGIONS.filter((r) => r.shippingZone === zone);
}

export function countryOf(code: string): string {
  return code.split("-")[0] ?? code;
}
`,
);

// ---------- coupons ----------
const couponRows = [];
const cats = ["standard", "bulk", "digital", "perishable"];
for (let i = 0; i < 28; i++) {
  const code = `${pick(["SAVE", "WELCOME", "SPRING", "FALL", "VIP", "FLASH", "BUNDLE", "LOYAL"])}${int(5, 40)}${String.fromCharCode(65 + (i % 26))}`;
  const bps = int(3, 30) * 100;
  const catList = rand() < 0.5 ? [] : [pick(cats)];
  couponRows.push(
    `  {\n    code: "${code}",\n    description: "${bps / 100}% off${catList.length ? ` ${catList[0]} items` : ""}",\n    bps: ${bps},\n    minSubtotalCents: ${pick([0, 2500, 5000, 10000])},\n    categories: [${catList.map((c) => `"${c}"`).join(", ")}],\n    validFrom: "2026-${String(int(1, 6)).padStart(2, "0")}-01",\n    validTo: "2026-${String(int(7, 12)).padStart(2, "0")}-28",\n    perCustomerLimit: ${pick([0, 1, 3])},\n    stackable: ${rand() < 0.7},\n  },`,
  );
}
couponRows.push(`  {
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
  },`);
const couponsFile = path.join(root, "src/pricing/coupons.ts");
const couponsSrc = readFileSync(couponsFile, "utf8");
writeFileSync(
  couponsFile,
  couponsSrc.replace(
    /\/\*@@COUPONS@@\*\/[\s\S]*?\/\*@@END@@\*\//,
    `/*@@COUPONS@@*/\n${couponRows.join("\n")}\n  /*@@END@@*/`,
  ),
);

// ---------- shipping table spliced into engine.ts ----------
const zones = ["domestic", "near", "far", "remote"];
const bands = [250, 500, 1000, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000, 50000];
const shipRows = [];
for (const zone of zones) {
  const mult = { domestic: 1, near: 1.6, far: 2.4, remote: 3.5 }[zone];
  for (const [i, maxGrams] of bands.entries()) {
    shipRows.push(
      `  { zone: "${zone}", maxGrams: ${maxGrams}, baseCents: ${Math.round((399 + i * 180) * mult)}, perKgCents: ${Math.round((40 + i * 9) * mult)}, handlingCents: ${i > 7 ? Math.round(250 * mult) : 0} },`,
    );
  }
}
const engineFile = path.join(root, "src/pricing/engine.ts");
const engineSrc = readFileSync(engineFile, "utf8");
writeFileSync(
  engineFile,
  engineSrc.replace(
    /\/\*@@SHIPPING@@\*\/[\s\S]*?\/\*@@END@@\*\//,
    `/*@@SHIPPING@@*/\n${shipRows.join("\n")}\n  /*@@END@@*/`,
  ),
);
console.log({ catalog: catalog.length, regions: regions.length, coupons: couponRows.length });
