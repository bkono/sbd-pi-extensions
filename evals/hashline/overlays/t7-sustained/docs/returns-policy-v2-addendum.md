# Returns policy v2, addendum 1

Status: approved by Finance, effective 2026-05-01. Amends `returns-policy-v2.md`. Everything not
mentioned here is unchanged.

## Amended R3. Restocking fee rate

The R3 fee rate now depends on the size of the order the line belongs to:

| Order subtotal (`subtotalCents` of the order's price breakdown) | Fee rate |
| --- | --- |
| 20,000 cents ($200.00) or more | 10% |
| under 20,000 cents | 15% |

Everything else in R3 stays as it was: the fee applies only to `changed_mind` returns of `standard`
or `bulk` lines, it is a percentage of the refunded net (the R2 refund minus its tax share), it is
rounded half up to whole cents, and it is capped at 2,500 cents per return request. R6 (platinum
pays no fee) still applies.

The subtotal is the order's subtotal as charged, before discounts, tax, and shipping. It does not
change as units are returned: a line from a $250.00 order keeps the 10% rate for every return
against it.

## Rationale

Large orders churn less and carry lower per-unit handling cost. Finance measured a 9.6% median
handling cost on orders of $200 and more in Q1 2026, against 15.1% below that.

## Worked example

A line of 2 units at $150.00 on an order with a $300.00 subtotal. One unit is returned
`changed_mind`. The refunded net is $150.00. The fee is 10% of that, $15.00, under the cap. Under
the original R3 it would have been $22.50.

## Change history

- Addendum 1 (2026-04-20): tiered R3 rate.
