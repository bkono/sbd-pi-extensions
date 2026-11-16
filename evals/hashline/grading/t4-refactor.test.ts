import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as engine from "../src/pricing/engine.ts";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

test("hidden: priceLineItem takes an options object", () => {
  const priceLineItem = (engine as any).priceLineItem;
  assert.equal(typeof priceLineItem, "function");
  assert.equal(priceLineItem.length, 1);
  assert.equal(priceLineItem({ qty: 3, unitPriceCents: 999 }), 2997);
  assert.equal(priceLineItem({ qty: 3, unitPriceCents: 999, discountBps: 1000 }), 2697);
  assert.throws(() => priceLineItem({ qty: -1, unitPriceCents: 1 }), RangeError);
});

test("hidden: computeLineTotal is gone", () => {
  assert.equal((engine as any).computeLineTotal, undefined);
  const hits = [...files("src"), ...files("test")].filter(
    (f) => !f.includes("zz-hidden") && readFileSync(f, "utf8").includes("computeLineTotal"),
  );
  assert.deepEqual(hits, []);
});
