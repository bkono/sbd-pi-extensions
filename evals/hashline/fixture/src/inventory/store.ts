// In-memory inventory with reservations.
//
// Stock moves through three buckets per SKU:
//   available -> reserved (reserve) -> committed (commit, at payment)
// release() returns reserved units to available. restock() adds to available.
// Committed units leave the store when the order ships (ship()).

import { CATALOG } from "../catalog/catalog-data.ts";
import { log } from "../util/log.ts";

export interface StockLevel {
  sku: string;
  available: number;
  reserved: number;
  committed: number;
}

export interface Reservation {
  orderId: string;
  sku: string;
  qty: number;
  state: "reserved" | "committed" | "released" | "shipped";
}

export class InsufficientStockError extends Error {
  readonly sku: string;
  readonly requested: number;
  readonly available: number;

  constructor(sku: string, requested: number, available: number) {
    super(`insufficient stock for ${sku}: requested ${requested}, available ${available}`);
    this.name = "InsufficientStockError";
    this.sku = sku;
    this.requested = requested;
    this.available = available;
  }
}

export const LOW_STOCK_THRESHOLD = 5;

export class InventoryStore {
  private readonly levels = new Map<string, StockLevel>();
  private readonly reservations: Reservation[] = [];
  private readonly lowStockListeners: ((sku: string, available: number) => void)[] = [];

  constructor(initial: Record<string, number> = {}) {
    for (const [sku, qty] of Object.entries(initial)) {
      this.levels.set(sku, { sku, available: qty, reserved: 0, committed: 0 });
    }
  }

  static withDefaultStock(qtyPerSku = 100): InventoryStore {
    const initial: Record<string, number> = {};
    for (const item of CATALOG) initial[item.sku] = item.category === "digital" ? 1_000_000 : qtyPerSku;
    return new InventoryStore(initial);
  }

  onLowStock(listener: (sku: string, available: number) => void): void {
    this.lowStockListeners.push(listener);
  }

  level(sku: string): StockLevel {
    const level = this.levels.get(sku);
    if (!level) return { sku, available: 0, reserved: 0, committed: 0 };
    return { ...level };
  }

  private mutable(sku: string): StockLevel {
    let level = this.levels.get(sku);
    if (!level) {
      level = { sku, available: 0, reserved: 0, committed: 0 };
      this.levels.set(sku, level);
    }
    return level;
  }

  restock(sku: string, qty: number): void {
    if (!Number.isInteger(qty) || qty <= 0) throw new RangeError(`bad restock qty ${qty}`);
    this.mutable(sku).available += qty;
  }

  /** Reserves every line or none: a failure leaves stock untouched. */
  reserve(orderId: string, lines: readonly { sku: string; qty: number }[]): Reservation[] {
    for (const line of lines) {
      const level = this.mutable(line.sku);
      if (level.available < line.qty) {
        throw new InsufficientStockError(line.sku, line.qty, level.available);
      }
    }
    const made: Reservation[] = [];
    for (const line of lines) {
      const level = this.mutable(line.sku);
      level.available -= line.qty;
      level.reserved += line.qty;
      const reservation: Reservation = { orderId, sku: line.sku, qty: line.qty, state: "reserved" };
      this.reservations.push(reservation);
      made.push(reservation);
      if (level.available <= LOW_STOCK_THRESHOLD) {
        for (const listener of this.lowStockListeners) listener(line.sku, level.available);
      }
    }
    log("debug", "reserved", { orderId, lines: lines.length });
    return made;
  }

  reservationsFor(orderId: string): Reservation[] {
    return this.reservations.filter((r) => r.orderId === orderId);
  }

  /** Moves an order's reserved units to committed (payment captured). */
  commit(orderId: string): void {
    for (const r of this.reservationsFor(orderId)) {
      if (r.state !== "reserved") continue;
      const level = this.mutable(r.sku);
      level.reserved -= r.qty;
      level.committed += r.qty;
      r.state = "committed";
    }
  }

  /**
   * Returns an order's units to available. Reserved and committed units both come
   * back; shipped units do not (they are handled as returns).
   */
  release(orderId: string): number {
    let released = 0;
    for (const r of this.reservationsFor(orderId)) {
      const level = this.mutable(r.sku);
      if (r.state === "reserved") level.reserved -= r.qty;
      else if (r.state === "committed") level.committed -= r.qty;
      else continue;
      level.available += r.qty;
      r.state = "released";
      released += r.qty;
    }
    return released;
  }

  /** Committed units leave the warehouse. */
  ship(orderId: string): void {
    for (const r of this.reservationsFor(orderId)) {
      if (r.state !== "committed") continue;
      this.mutable(r.sku).committed -= r.qty;
      r.state = "shipped";
    }
  }

  /** Puts returned, shipped units back on the shelf. */
  acceptReturn(sku: string, qty: number): void {
    this.restock(sku, qty);
  }

  totals(): { available: number; reserved: number; committed: number } {
    let available = 0;
    let reserved = 0;
    let committed = 0;
    for (const level of this.levels.values()) {
      available += level.available;
      reserved += level.reserved;
      committed += level.committed;
    }
    return { available, reserved, committed };
  }

  lowStock(threshold = LOW_STOCK_THRESHOLD): StockLevel[] {
    return [...this.levels.values()].filter((l) => l.available <= threshold).map((l) => ({ ...l }));
  }
}
