# Tallyhub returns policy, version 2

Status: approved by Finance and Customer Operations, effective 2026-04-01.
Owner: Commerce Platform team. Questions: #returns-policy.

This document is the source of truth for how tallyhub accepts returns of shipped goods, how much
it refunds, and what happens to the returned stock. Engineering implements it; Support quotes it to
customers; Finance reconciles against it. When this document and the code disagree, the code is
wrong.

Version 1 of the policy lived in a support macro and in the `refundUnits` method of the order
service. It had no return window, no fees, and no notion of item condition. Version 2 replaces it
for every order shipped on or after the effective date.

---

## 1. Purpose

Customers can send back goods they no longer want, goods that arrived broken, and goods we sent by
mistake. Each of those cases costs us something different, and version 1 treated them all the
same. In 2025 we refunded 11,402 returns. Roughly 62% were "changed my mind", 27% were defective
or damaged in transit, and 11% were the wrong item. Changed-mind returns of heavy standard goods
were the single largest source of unrecovered logistics cost.

Version 2 has three goals:

1. Refund customers exactly what they paid for the units they return, never a cent more or less,
   no matter how many separate returns they make against one line.
2. Recover part of our cost on discretionary returns, without charging customers for our mistakes.
3. Keep stock counts honest: units we cannot resell must never show up as available.

## 2. Scope

In scope:

- Returns of units from orders in status `shipped`.
- Partial returns: any number of units from any line, across any number of separate requests.
- Refunds of goods, tax, and, in one case, original shipping.
- What happens to returned stock.

Out of scope:

- Cancellations before shipping. Those follow the order lifecycle (`cancel`), which refunds the
  charged total in full and releases stock. Nothing here changes that.
- Exchanges. An exchange is a return plus a new order; each half follows its own rules.
- Chargebacks and disputes, which Finance handles outside the platform.
- Marketplace sellers. Tallyhub sells only its own catalog.

## 3. Definitions

**Ship date.** The calendar date an order moved to `shipped`. The order records it as
`shippedAt`. An order that has never shipped has no ship date.

**Return request.** One customer request to return some units of one line. It names the SKU, the
quantity, the reason, and the condition the units arrived back in.

**Reason.** Exactly one of:

- `changed_mind`: the customer no longer wants the item. Nothing is wrong with it.
- `defective`: the item does not work, is broken, or arrived damaged.
- `wrong_item`: we shipped something other than what was ordered.

**Condition.** What our warehouse found when the units came back. Exactly one of:

- `resellable`: the units can go back on the shelf as new.
- `damaged`: the units cannot be sold again.

Condition is independent of reason. A defective item is usually damaged, but a customer who
changed their mind can also return a unit damaged, and a defective unit is sometimes repairable and
marked resellable after inspection.

**Charged amount of a line.** What the customer paid for that line: its net (gross minus every
discount that applied to it) plus the tax on it. Shipping and handling are order-level charges and
are not part of any line.

**Refund.** Money we send back to the customer through the payment gateway.

**Calendar days.** Every day counts, including weekends and holidays. Business-day calendars do not
apply anywhere in this policy.

## 4. Rules

Every rule has a number. Tickets, code comments, and tests should cite rules by number (for
example "R3").

### R1. Return window

A return request is accepted only within the return window, counted in calendar days after the
order's ship date:

| Category | Window |
| --- | --- |
| standard, bulk, hazmat | 30 days |
| perishable | 3 days |
| digital (defective only, see R4) | 14 days |

The window is inclusive. For a 30-day window and a ship date of 2026-04-01, the last day a request
is accepted is 2026-05-01. A request on 2026-05-02 is outside the window.

The ship date itself is day 0. A request on the ship date is always inside the window.

Rationale: 30 days matches the industry norm and our carriers' claim deadlines. Perishables spoil;
three days is the longest our cold-chain partner will accept them back. Digital goods have no
physical return, so the window only bounds how long a customer can report a defect.

### R2. Refund amount

The refund for returned units is their share of the line's charged amount: the units' share of the
line net, plus the units' share of the line tax. Discounts are refunded at the rate the line was
actually charged, not at whatever rate the returned quantity would earn today. For example, units
bought at a bulk tier are refunded at that tier's price even if the customer returns fewer units
than the tier requires.

Partial returns must add up. However the customer splits the returns of a line (one unit at a
time, all at once, or any mix), the refunds for the line must sum to exactly the line's charged
amount once every unit has been returned. No rounding drift is acceptable in either direction:
over-refunds are lost money and under-refunds are a compliance problem in several regions.

Rationale: version 1 rounded each refund on its own, and Finance has found lines whose refunds
drifted from the charged amount by a cent or two. Customers notice under-refunds; auditors notice
both.

### R3. Restocking fee

A restocking fee applies only when all of these hold:

- the reason is `changed_mind`, and
- the line's category is `standard` or `bulk`.

The fee is 15% of the refunded net, which is the R2 refund minus its tax share. Round it half up to
whole cents. It is capped at 2,500 cents ($25.00) per return request.

No restocking fee applies to `defective` or `wrong_item` returns, or to any other category. R6 can
also remove the fee.

The fee is withheld from the refund. It is never charged separately.

Rationale: changed-mind returns of standard and bulk goods carry real handling and repackaging
cost. Other categories are either low-value, non-returnable, or already priced to absorb returns.

### R4. Non-returnable goods

- `hazmat` items are final sale. Every return request for them is rejected as `FINAL_SALE`,
  whatever the reason, condition, or date.
- `digital` items cannot be returned unless the reason is `defective`. Any other reason is rejected
  as `NOT_RETURNABLE`. A defective digital item follows R1's 14-day window.

Rationale: carriers will not take hazardous materials back. Digital goods cannot be "returned" in
any meaningful sense, but a broken download is our problem.

### R5. Shipping refund

When the reason is `wrong_item`, we also refund the order's original shipping charge in full. This
happens at most once per order: the first `wrong_item` return on an order refunds shipping, and
later returns on the same order do not, whatever their reason.

No other reason refunds shipping. Handling charges are never refunded.

Rationale: if we shipped the wrong thing, the customer should not pay to ship it. Refunding
shipping more than once would refund money we never charged.

### R6. Loyalty

Customers at the `platinum` loyalty tier never pay a restocking fee. All other tiers follow R3.

### R7. Rejection codes

A rejected return request carries exactly one code. When more than one applies, use the first one
in this list:

1. `NO_LINE`: the order has no line for the requested SKU.
2. `NOT_SHIPPED`: the order has no ship date.
3. `FINAL_SALE`: R4, hazmat.
4. `NOT_RETURNABLE`: R4, digital and not defective.
5. `OUTSIDE_WINDOW`: R1.
6. `OVER_RETURN`: the units already returned from the line, plus this request, exceed the
   quantity bought.

`OVER_RETURN` needs the order's return history, so only the order service can decide it. The
others need only the order, the request, and today's date.

A request with a non-positive or non-integer quantity is malformed, not rejected. It never reaches
these checks.

### R8. Returned stock

- Units returned `resellable` go back to available stock immediately.
- Units returned `damaged` are written off. They never become available. The warehouse counts
  them separately as written off so that shrinkage reports stay accurate.

Condition never changes the refund. A damaged changed-mind return still follows R3, and a
resellable defective return still pays no fee.

## 5. Worked examples

These use round numbers, not real catalog prices, and a 10% tax rate where tax applies. Amounts are
in dollars for readability; the system works in cents.

**Example A: changed mind, standard item.** A line of 2 units at $40.00, no discounts, tax $8.00.
The customer returns 1 unit, `changed_mind`, `resellable`, 10 days after shipping.

- R1: day 10 of 30, accepted.
- R2: refund = $40.00 net share + $4.00 tax share = $44.00.
- R3: fee = 15% of $40.00 = $6.00 (under the $25.00 cap).
- Net to the customer: $38.00. The unit goes back to available (R8).

**Example B: the cap.** A line of 5 units at $60.00, tax $30.00. All 5 returned, `changed_mind`.

- R2: refund = $300.00 + $30.00 = $330.00.
- R3: 15% of $300.00 is $45.00, capped at $25.00.
- Net: $305.00.

**Example C: wrong item.** We shipped the wrong color. Order shipping was $12.50. The line is 1
unit at $25.00, tax $2.50. Returned `wrong_item`, `resellable`.

- R2: refund $27.50. R3: no fee. R5: shipping refund $12.50.
- Net: $40.00. A second wrong-item return on the same order would refund no shipping.

**Example D: platinum.** As example A, but the customer is platinum. R6 removes the fee; net
$44.00.

**Example E: split returns.** A line of 3 units at $33.33 with a total tax of $10.00. The customer
returns one unit at a time over three weeks. Whatever each individual refund comes to, the three
refunds together must equal $109.99 ($99.99 net plus $10.00 tax) exactly. Rounding each refund
independently ($33.33 + $3.33 three times) would refund $109.98, a cent short. That violates R2.

**Example F: perishables.** Groceries shipped Monday. A request on Thursday (day 3) is accepted. A
request on Friday (day 4) is `OUTSIDE_WINDOW`. Perishables carry no restocking fee (R3 covers only
standard and bulk).

**Example G: digital.** A software license returned `changed_mind` is `NOT_RETURNABLE`. Returned
`defective` on day 12, it is accepted with no fee. On day 15 it is `OUTSIDE_WINDOW`.

**Example H: hazmat.** A lithium battery pack returned `defective` on day 2 is `FINAL_SALE`. Support
offers a replacement through the carrier's hazmat program instead.

**Example I: precedence.** A hazmat item on an order that never shipped is `NOT_SHIPPED`, not
`FINAL_SALE`, because `NOT_SHIPPED` comes first in R7.

**Example J: damaged changed-mind return.** As example A, but the unit arrives `damaged`. The
refund and fee are unchanged ($38.00 net). The unit is written off and never becomes available.

## 6. Operational notes

### Support

- Quote the rule number when declining a return. Customers accept "final sale under our hazardous
  goods policy (R4)" far better than "the system won't let me".
- A customer can split a return across several requests. Never ask them to send everything at once
  to get a correct refund. R2 guarantees the total.
- Support cannot override `FINAL_SALE`. Escalate to Customer Operations if a customer insists.
- For `wrong_item`, confirm the SKU we shipped before tagging the reason. Mis-tagged wrong-item
  returns refund shipping we did not owe.

### Warehouse

- Inspect every returned unit and record its condition before the return is processed. Condition
  drives stock (R8), not money.
- Written-off units go to the disposal cage. Do not restock them, even if they look fine on a
  second look; open a re-inspection ticket instead.

### Finance

- Reconcile refunds per line, not per request. A line is reconciled when the sum of its refunds
  equals its charged amount (once fully returned) or is less than it (while partially returned).
- The monthly refund audit log lists every refund with the line's charged amount and the running
  total refunded. Any fully returned line whose running total differs from the charged amount is a
  defect, not a rounding tolerance.
- Restocking fees are revenue, booked under 4120-Restocking.

## 7. Frequently asked questions

**Does the window restart if we ship a replacement?** No. The window belongs to the original
order's ship date. A replacement is a new order with its own ship date.

**What if the order was shipped in two parcels?** Tallyhub ships an order as one unit; there is one
ship date per order.

**Can a customer return more units than they bought if they bought the item twice?** Each order is
separate. `OVER_RETURN` is per line of one order.

**Is the restocking fee taxed?** No. It is withheld from the refund of the net. The tax share of
the refund is always refunded in full.

**Does the fee cap apply per unit, per line, or per request?** Per return request.

**What about coupons?** Coupons are discounts like any other. R2 refunds at the discount the line
was actually charged, coupons included. Coupon usage counts are not restored by a return.

**Do bulk returns lose the bulk discount?** No. See R2: the refund uses the discount the line was
charged at, even if the returned quantity alone would not qualify for the tier.

**Can a perishable be returned `wrong_item` after 3 days?** No. The window applies to every reason.

**Are damaged-in-transit returns `defective`?** Yes, from the customer's side. The warehouse will
usually mark the condition `damaged`.

**What is the restocking fee on a platinum customer's changed-mind return?** Zero (R6).

**Do handling charges ever get refunded?** No (R5).

**What happens when every unit of every line has been returned?** The order moves to `refunded`.

**Why 15%?** It matches the median handling and repackaging cost Finance measured across 2025's
changed-mind returns of standard and bulk goods, rounded down.

**Does the 14-day digital window apply to changed-mind digital returns?** No. Those are
`NOT_RETURNABLE` regardless of timing (R4 before R1 in R7's order).

## 8. Change history

- v2.0 (2026-03-20): this document. Adds windows, restocking fees, conditions, rejection codes, and
  the R2 reconciliation requirement.
- v1 (2024): support macro "returns-basic" and `OrderService.refundUnits`. Full refunds, no fees,
  no windows, every returned unit restocked.
