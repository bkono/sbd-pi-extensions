// Money helpers. All amounts are integer cents; rates are basis points (1 bps = 0.01%).

export type Cents = number;
export type Bps = number;

export const BPS_DENOMINATOR = 10_000;

export function toCents(amount: number): Cents {
  if (!Number.isFinite(amount)) throw new RangeError(`not a finite amount: ${amount}`);
  return Math.round(amount * 100);
}

export function fromCents(cents: Cents): number {
  return cents / 100;
}

export function formatCents(cents: Cents, currency = "USD"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : `${currency} `;
  return `${sign}${symbol}${whole.toLocaleString("en-US")}.${frac}`;
}

/**
 * Banker's rounding: halves go to the nearest even integer. Used for tax so that
 * aggregate rounding error stays near zero across many orders.
 */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  const epsilon = 1e-9;
  if (diff > 0.5 + epsilon) return floor + 1;
  if (diff < 0.5 - epsilon) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Conventional rounding: halves go away from zero. Used for discounts and fees. */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** `bps` of `cents`, rounded half-up. */
export function percentOf(cents: Cents, bps: Bps): Cents {
  return roundHalfUp((cents * bps) / BPS_DENOMINATOR);
}

/** `bps` of `cents`, rounded half-even (tax). */
export function taxOf(cents: Cents, bps: Bps): Cents {
  return roundHalfEven((cents * bps) / BPS_DENOMINATOR);
}

export function clamp(value: number, min: number, max: number): number {
  if (min > max) throw new RangeError(`clamp: min ${min} > max ${max}`);
  return Math.min(max, Math.max(min, value));
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * Splits `total` across `weights` so the parts sum exactly to `total`, using the
 * largest-remainder method. Ties go to the earlier index.
 */
export function allocateProportionally(total: Cents, weights: readonly number[]): Cents[] {
  if (weights.length === 0) return [];
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / weightSum);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  return floors;
}

export function minCents(a: Cents, b: Cents): Cents {
  return a < b ? a : b;
}

export function maxCents(a: Cents, b: Cents): Cents {
  return a > b ? a : b;
}
