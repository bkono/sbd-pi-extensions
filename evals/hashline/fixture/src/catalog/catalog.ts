// Catalog lookups over the generated catalog data.

import type { CatalogItem, Category, LineItem } from "../types.ts";
import { CATALOG } from "./catalog-data.ts";

const BY_SKU = new Map(CATALOG.map((item) => [item.sku, item]));

export function findItem(sku: string): CatalogItem | undefined {
  return BY_SKU.get(sku);
}

export function getItem(sku: string): CatalogItem {
  const item = BY_SKU.get(sku);
  if (!item) throw new RangeError(`unknown sku: ${sku}`);
  return item;
}

export function itemsInCategory(category: Category): CatalogItem[] {
  return CATALOG.filter((i) => i.category === category);
}

/** Builds an order line for `qty` units of `sku` at today's catalog price. */
export function lineFor(sku: string, qty: number): LineItem {
  const item = getItem(sku);
  return {
    sku: item.sku,
    qty,
    unitPriceCents: item.unitPriceCents,
    category: item.category,
    weightGrams: item.weightGrams,
    taxClass: item.taxClass,
  };
}

export function searchCatalog(query: string, limit = 10): CatalogItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return CATALOG.filter((i) => i.name.toLowerCase().includes(q) || i.sku.toLowerCase() === q).slice(
    0,
    limit,
  );
}

export function catalogSize(): number {
  return CATALOG.length;
}
