// Order lifecycle.
//
//   draft --submit--> submitted --pay--> paid --fulfil--> fulfilled --ship--> shipped
//     |                  |                 |
//     +--cancel----------+--cancel---------+--cancel (refund)--> cancelled
//   shipped --refund--> refunded (partial refunds keep the order shipped)
//
// Submitting reserves stock; paying commits it; cancelling releases it. Cancelling a
// paid order refunds the charged total in full.

import { lineFor } from "../catalog/catalog.ts";
import { InventoryStore } from "../inventory/store.ts";
import { computeLineTotal, priceOrder, refundForUnits } from "../pricing/engine.ts";
import type { Order, OrderEvent, OrderStatus, PriceBreakdown, ValidationError } from "../types.ts";
import type { IsoDate } from "../util/dates.ts";
import { nextId } from "../util/ids.ts";
import { log } from "../util/log.ts";
import type { Cents } from "../util/money.ts";
import { validateOrder } from "./validation.ts";

export class OrderError extends Error {
  readonly code: string;
  readonly errors: ValidationError[];

  constructor(code: string, message: string, errors: ValidationError[] = []) {
    super(message);
    this.name = "OrderError";
    this.code = code;
    this.errors = errors;
  }
}

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["paid", "cancelled"],
  paid: ["fulfilled", "cancelled"],
  fulfilled: ["shipped"],
  shipped: ["refunded"],
  cancelled: [],
  refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface PaymentGateway {
  charge(orderId: string, amountCents: Cents): { ok: true; reference: string } | { ok: false; reason: string };
  refund(orderId: string, amountCents: Cents): { ok: true } | { ok: false; reason: string };
}

/** A gateway that approves everything; records calls for tests. */
export class FakeGateway implements PaymentGateway {
  readonly charges: { orderId: string; amountCents: Cents }[] = [];
  readonly refunds: { orderId: string; amountCents: Cents }[] = [];
  declineNext = false;

  charge(orderId: string, amountCents: Cents) {
    if (this.declineNext) {
      this.declineNext = false;
      return { ok: false as const, reason: "card declined" };
    }
    this.charges.push({ orderId, amountCents });
    return { ok: true as const, reference: `ch_${this.charges.length}` };
  }

  refund(orderId: string, amountCents: Cents) {
    this.refunds.push({ orderId, amountCents });
    return { ok: true as const };
  }
}

export interface OrderServiceDeps {
  inventory: InventoryStore;
  gateway: PaymentGateway;
  clock: () => IsoDate;
}

export class OrderService {
  private readonly orders = new Map<string, Order>();
  private readonly breakdowns = new Map<string, PriceBreakdown>();
  private readonly events: OrderEvent[] = [];
  private readonly refundedUnits = new Map<string, number[]>();
  private readonly couponUses = new Map<string, number>();

  private readonly deps: OrderServiceDeps;

  constructor(deps: OrderServiceDeps) {
    this.deps = deps;
  }

  private record(orderId: string, kind: OrderEvent["kind"], detail?: string, amountCents?: Cents): void {
    const event: OrderEvent = { orderId, at: this.deps.clock(), kind };
    if (detail !== undefined) event.detail = detail;
    if (amountCents !== undefined) event.amountCents = amountCents;
    this.events.push(event);
  }

  private require(orderId: string): Order {
    const order = this.orders.get(orderId);
    if (!order) throw new OrderError("NOT_FOUND", `no order ${orderId}`);
    return order;
  }

  private move(order: Order, to: OrderStatus): void {
    if (!canTransition(order.status, to)) {
      throw new OrderError("BAD_TRANSITION", `cannot go from ${order.status} to ${to}`);
    }
    order.status = to;
  }

  get(orderId: string): Order {
    return structuredClone(this.require(orderId));
  }

  eventsFor(orderId: string): OrderEvent[] {
    return this.events.filter((e) => e.orderId === orderId);
  }

  create(input: { customerId: string; region: string; loyaltyTier?: Order["loyaltyTier"] }): Order {
    const order: Order = {
      id: nextId("ord"),
      customerId: input.customerId,
      region: input.region,
      lines: [],
      loyaltyTier: input.loyaltyTier ?? "none",
      createdAt: this.deps.clock(),
      status: "draft",
    };
    this.orders.set(order.id, order);
    this.record(order.id, "created");
    return structuredClone(order);
  }

  addLine(orderId: string, sku: string, qty: number): Order {
    const order = this.require(orderId);
    if (order.status !== "draft") throw new OrderError("NOT_DRAFT", "lines can only change on drafts");
    const existing = order.lines.find((l) => l.sku === sku);
    if (existing) existing.qty += qty;
    else order.lines.push(lineFor(sku, qty));
    this.record(orderId, "line_added", `${qty} x ${sku}`);
    return structuredClone(order);
  }

  removeLine(orderId: string, sku: string): Order {
    const order = this.require(orderId);
    if (order.status !== "draft") throw new OrderError("NOT_DRAFT", "lines can only change on drafts");
    const before = order.lines.length;
    order.lines = order.lines.filter((l) => l.sku !== sku);
    if (order.lines.length === before) throw new OrderError("NO_LINE", `no line for ${sku}`);
    this.record(orderId, "line_removed", sku);
    return structuredClone(order);
  }

  applyCoupon(orderId: string, code: string): Order {
    const order = this.require(orderId);
    if (order.status !== "draft") throw new OrderError("NOT_DRAFT", "coupons can only change on drafts");
    order.couponCode = code;
    return structuredClone(order);
  }

  quote(orderId: string): PriceBreakdown {
    return priceOrder(this.require(orderId));
  }

  submit(orderId: string): PriceBreakdown {
    const order = this.require(orderId);
    const uses = order.couponCode ? (this.couponUses.get(`${order.customerId}:${order.couponCode}`) ?? 0) : 0;
    const errors = validateOrder(order, uses);
    if (errors.length > 0) throw new OrderError("INVALID", "order failed validation", errors);
    this.deps.inventory.reserve(order.id, order.lines);
    this.move(order, "submitted");
    const breakdown = priceOrder(order);
    this.breakdowns.set(order.id, breakdown);
    this.record(orderId, "submitted", undefined, breakdown.totalCents);
    return breakdown;
  }

  pay(orderId: string): PriceBreakdown {
    const order = this.require(orderId);
    const breakdown = this.breakdowns.get(orderId);
    if (!breakdown || order.status !== "submitted") {
      throw new OrderError("BAD_TRANSITION", `cannot pay an order in ${order.status}`);
    }
    const result = this.deps.gateway.charge(orderId, breakdown.totalCents);
    if (!result.ok) throw new OrderError("PAYMENT_FAILED", result.reason);
    this.deps.inventory.commit(orderId);
    this.move(order, "paid");
    order.chargedTotalCents = breakdown.totalCents;
    if (order.couponCode) {
      const key = `${order.customerId}:${order.couponCode}`;
      this.couponUses.set(key, (this.couponUses.get(key) ?? 0) + 1);
    }
    this.record(orderId, "paid", result.reference, breakdown.totalCents);
    return breakdown;
  }

  fulfil(orderId: string): void {
    const order = this.require(orderId);
    this.move(order, "fulfilled");
    this.record(orderId, "fulfilled");
  }

  ship(orderId: string): void {
    const order = this.require(orderId);
    this.move(order, "shipped");
    this.deps.inventory.ship(orderId);
    this.record(orderId, "shipped");
  }

  /**
   * Cancels an order. Reserved or committed stock goes back to available. A paid
   * order is refunded its charged total in full.
   */
  cancel(orderId: string, reason = "customer request"): void {
    const order = this.require(orderId);
    const wasPaid = order.status === "paid";
    this.move(order, "cancelled");
    const released = this.deps.inventory.release(orderId);
    if (wasPaid && order.chargedTotalCents !== undefined) {
      const result = this.deps.gateway.refund(orderId, order.chargedTotalCents);
      if (!result.ok) log("error", "refund failed on cancel", { orderId, reason: result.reason });
      this.record(orderId, "refunded", "cancelled after payment", order.chargedTotalCents);
    }
    this.record(orderId, "cancelled", `${reason}; released ${released} units`);
  }

  /** Refunds `qty` units of one line of a shipped order. */
  refundUnits(orderId: string, sku: string, qty: number): Cents {
    const order = this.require(orderId);
    if (order.status !== "shipped") throw new OrderError("NOT_SHIPPED", "only shipped orders take returns");
    const breakdown = this.breakdowns.get(orderId);
    if (!breakdown) throw new OrderError("NO_BREAKDOWN", "order was never priced");
    const index = order.lines.findIndex((l) => l.sku === sku);
    if (index < 0) throw new OrderError("NO_LINE", `no line for ${sku}`);
    const refunded = this.refundedUnits.get(orderId) ?? order.lines.map(() => 0);
    if (refunded[index] + qty > order.lines[index].qty) {
      throw new OrderError("OVER_REFUND", "cannot refund more units than were bought");
    }
    const amount = refundForUnits(breakdown, index, qty);
    const result = this.deps.gateway.refund(orderId, amount);
    if (!result.ok) throw new OrderError("REFUND_FAILED", result.reason);
    refunded[index] += qty;
    this.refundedUnits.set(orderId, refunded);
    this.deps.inventory.acceptReturn(sku, qty);
    this.record(orderId, "refunded", `${qty} x ${sku}`, amount);
    if (refunded.every((n, i) => n === order.lines[i].qty)) this.move(order, "refunded");
    return amount;
  }

  /** What one more unit of `sku` would add to a draft, before tax and shipping. */
  marginalUnitCost(orderId: string, sku: string): Cents {
    const order = this.require(orderId);
    const line = order.lines.find((l) => l.sku === sku) ?? lineFor(sku, 0);
    const before = computeLineTotal(line.qty, line.unitPriceCents, 0);
    const after = computeLineTotal(line.qty + 1, line.unitPriceCents, 0);
    return after - before;
  }

  list(status?: OrderStatus): Order[] {
    return [...this.orders.values()]
      .filter((o) => status === undefined || o.status === status)
      .map((o) => structuredClone(o));
  }

  addNote(orderId: string, note: string): void {
    const order = this.require(orderId);
    order.notes = order.notes ? `${order.notes}\n${note}` : note;
    this.record(orderId, "note", note);
  }

  breakdownFor(orderId: string): PriceBreakdown | undefined {
    const b = this.breakdowns.get(orderId);
    return b ? structuredClone(b) : undefined;
  }
}

export function createTestService(today: IsoDate = "2026-03-02") {
  const inventory = InventoryStore.withDefaultStock();
  const gateway = new FakeGateway();
  const service = new OrderService({ inventory, gateway, clock: () => today });
  return { service, inventory, gateway };
}
