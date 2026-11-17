// Generates the t7-sustained refund audit log from the fixture's own pricing engine, so its
// reconciliation mismatches are the ones the fixture's per-request refund rounding really
// produces. Deterministic; run once and commit the output.
// Usage: node evals/hashline/gen-t7-log.mjs
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixture");
const { itemsInCategory, lineFor } = await import(path.join(fixture, "src/catalog/catalog.ts"));
const { priceOrder, refundForUnits } = await import(path.join(fixture, "src/pricing/engine.ts"));

let seed = 0x7a11e7;
const rand = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 1_000_000) / 1_000_000;
};
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const regions = ["US-NY", "US-CA", "CA-ON", "DE-BE", "JP-13", "GB-LND"];
const tiers = ["none", "none", "none", "silver", "gold", "platinum"];
const skus = [...itemsInCategory("standard"), ...itemsInCategory("bulk")]
  .filter((i) => i.unitPriceCents <= 16000)
  .map((i) => i.sku);

const out = [];
let t = Date.parse("2026-03-01T08:00:00Z");
const stamp = () => {
  t += int(4, 900) * 1000;
  return new Date(t).toISOString().replace(".000", "");
};
const emit = (level, event, fields) =>
  out.push(
    `${stamp()} ${level.padEnd(5)} ${event} ${Object.entries(fields)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`,
  );
const noise = () => {
  const n = int(0, 3);
  for (let i = 0; i < n; i++) {
    const kind = pick(["label", "capture", "restock", "health", "webhook"]);
    if (kind === "label")
      emit("INFO", "shipping.label", {
        order: `ord_${int(1000, 9999)}`,
        carrier: pick(["ups", "dhl", "yamato"]),
        parcels: 1,
      });
    if (kind === "capture")
      emit("INFO", "payment.captured", {
        order: `ord_${int(1000, 9999)}`,
        amount_cents: int(500, 90000),
      });
    if (kind === "restock")
      emit("DEBUG", "inventory.restock", { sku: pick(skus), qty: int(1, 40) });
    if (kind === "health") emit("DEBUG", "gateway.health", { latency_ms: int(40, 900), ok: true });
    if (kind === "webhook") emit("WARN", "webhook.retry", { target: "erp", attempt: int(2, 4) });
  }
};

let mismatches = 0;
let reconciled = 0;
for (let n = 0; n < 420; n++) {
  const orderId = `ord_${String(2000 + n).padStart(6, "0")}`;
  const region = pick(regions);
  const sku = pick(skus);
  const qty = pick([2, 3, 3, 4, 5, 6, 7]);
  let breakdown;
  try {
    breakdown = priceOrder({
      id: orderId,
      customerId: `cus_${int(100, 999)}`,
      region,
      lines: [lineFor(sku, qty)],
      loyaltyTier: pick(tiers),
      createdAt: "2026-02-20",
      status: "shipped",
    });
  } catch {
    continue;
  }
  const line = breakdown.lines[0];
  const charged = line.netCents + line.taxCents;
  // Half the lines come back in one request, half one or two units at a time.
  const splits = [];
  if (rand() < 0.5) splits.push(qty);
  else {
    let left = qty;
    while (left > 0) {
      const take = Math.min(left, pick([1, 1, 2]));
      splits.push(take);
      left -= take;
    }
  }
  let refunded = 0;
  for (const units of splits) {
    noise();
    const amount = refundForUnits(breakdown, 0, units);
    refunded += amount;
    emit("INFO", "refund.issued", {
      order: orderId,
      region,
      sku,
      units,
      amount_cents: amount,
      line_qty: qty,
      line_charged_cents: charged,
      refunded_to_date_cents: refunded,
    });
  }
  const diff = refunded - charged;
  if (diff === 0) reconciled++;
  else mismatches++;
  emit(diff === 0 ? "INFO" : "ERROR", "reconcile.line", {
    order: orderId,
    sku,
    requests: splits.length,
    charged_cents: charged,
    refunded_cents: refunded,
    status: diff === 0 ? "ok" : "MISMATCH",
    ...(diff === 0 ? {} : { diff_cents: diff > 0 ? `+${diff}` : diff }),
  });
}
const file = path.join(here, "overlays/t7-sustained/logs/refund-audit-2026-03.log");
writeFileSync(file, `${out.join("\n")}\n`);
console.log(
  `${out.length} lines, ${reconciled} lines reconciled, ${mismatches} mismatches -> ${file}`,
);
