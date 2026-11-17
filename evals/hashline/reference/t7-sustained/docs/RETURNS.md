# Returns

- `checkReturnEligibility` in src/returns/eligibility.ts (R1, R4, R7).
- `quoteReturn` in src/returns/quote.ts (R2, R3 as amended, R5, R6).
- `OrderService.requestReturn` and `OrderService.returnsFor` in src/orders/service.ts; `InventoryStore.writeOff` (R8).
- `summarizeReturns` in src/reports/summary.ts; `returnQuoteToCsvRow` in src/returns/csv.ts.

Endpoint: `POST /orders/:id/returns` with `{ sku, qty, reason, condition }`; responds with
`sku, qty, refund_cents, handling_fee_cents, shipping_refund_cents, net_refund_cents`.

Rejection codes (R7): NO_LINE, NOT_SHIPPED, FINAL_SALE (R4), NOT_RETURNABLE (R4),
OUTSIDE_WINDOW (R1), OVER_RETURN.

Incident: each partial refund rounded its tax share on its own, so split refunds drifted from the
line's charged amount by a cent or two.
