# The Pricing Engine

**Owner-directed 2026-08-23.** In the owner's own words:

> "We are building a general pricing engine. The section should be called **Pricing Engine**. Give
> our team the options to be able to price basic scenarios. You should know what you need to set for
> the defaults. You should give them back the results nicely, all the results, every single result
> that you are seeing in Lender Price, with nice screens that you can break down into details to see
> why you're seeing it like this: **Base price · Final price · LLPAs · Margin holdbacks**. Also,
> include an **ineligible screen** where they can go … They can see exactly the reason for
> ineligibility. This is what we're building right now."

And on the shape of the board:

> "our default is set so that we're going to see all rates and products. How's it going to be? This
> is how you see a rate, let's say **6.5**, and then you see **all the investors lying down how much
> they're pricing for 6.5**, with more details about them. Then you can **click into it and see the
> details about that price and program**, and then you see, okay, **6.625**, and another list of all
> investors. This is how the old products and pricing are populated usually."

---

## What it is

| | |
| --- | --- |
| Section | **Pricing Engine** — `/internal/lt/pricer`, inside `<StaffPrivate>` |
| Screen | `app-v2/src/longterm/LtPricer.jsx` |
| Doors | `POST /api/lt/dscr/price` (the priced side) · `GET /api/lt/dscr/disqualifications/:searchKey` (the ineligible side) |
| Reader | `src/longterm/lenderprice/client.js` → `parseFull` / `parseDisqualified` |
| Guards | `scripts/test-lt-pricer-screen.mjs` (structure) · `scripts/test-lt-pricer-screen-render.mjs` (it renders, against a real captured answer) |

**Nothing new was needed on the server.** Both doors have been shipping, staff-gated, since the DSCR
pricer was written, and `parseFull` has captured the vendor's entire per-option answer the whole
time — the price build, every itemized point LLPA with the vendor's own reason, the rate
adjustments, the three-way holdback, the comp, the fees, the terms, the monthly payment and the rate
sheet's own provenance and expiry. Nothing in the product could reach them: the LT client had
exactly one `/dscr` method, the field manifest. **This was never a missing integration. It was a
missing wire, and a screen.**

## The board is a RATE STACK

One row per note rate, ascending. Under each rate, every investor quoting it, best price first.
Click a line and the whole build behind that price opens underneath it.

```
5.750   2 quotes · 2 lenders                     best price  99.311
  Onslow Bay · Onslow — 30yr Fixed DSCR Plus       99.311   −0.689   7.012%   $2,187.44   [Details]
  AD Mortgage LLC — DSCR 30 Year Fixed             98.000   +2.000   7.284%   $2,187.44   [Details]

5.875   2 quotes · 2 lenders                     best price 100.061
  …
```

**Why this shape and not a list of programmes.** A programme list answers *"what does this lender
do?"*. A person pricing a loan is asking *"who is best at this rate?"*, and that is one row.

**The grouping key is the vendor's own rate at THREE decimals, and that is load-bearing.** Two
lenders quoting `5.99` and `5.990` are quoting the same rate and must land together; `5.875` and
`5.88` are *different* rates and must not. Rounding to two decimals merges the second pair and
attributes one lender's price to the other's rate. Both directions are pinned.

**Ordering is a FACT, never a judgement.** Rates ascend because that is how a ladder reads. Within a
rate the best price is first because a higher price is worth more to the borrower — arithmetic. A
"best execution" score would be a rule, and this engine holds none.

**Nothing is silently dropped.** A rung the vendor sent with no note rate cannot go on a rate row,
so it is counted and the screen says how many. A quote with no price sorts LAST, never as though it
were zero — which would put a figure we do not have at the top of a best-price list.

## The breakdown — the owner's four

Behind every line, in two tracks exactly as Lender Price builds a quote:

- **Rate track** — par rate → rate adjustments (each with the vendor's reason) → **note rate**, then APR and APOR.
- **Price track** — **base price** (100 − base points) → the **itemized LLPA stack**, grouped the way the vendor grouped it, each line carrying the vendor's own reason and value → adjusted points → **final price**.
- **Margin & holdback** — every holdback line, per party. **Stated even when there is none**, because "this quote carries no holdback" and "nobody looked" are different facts and a blank space reads as the second.
- Terms, fees, comp, and the rate sheet's name, effective date and expiry.

**The one piece of arithmetic the page does** is the running total down the LLPA stack, printed
*beside* the vendor's own `adjustmentPoints`, never instead of it. If the two ever disagree, the
screen says so on its face rather than quietly showing one of them.

**Absent renders as an em dash**, decided by `Number.isFinite`, never as `0.000`. A quoted fee of
zero and a fee the vendor never mentioned are different facts, and printing the second as the first
is how a page talks somebody into believing a fee was waived.

## The Ineligible view

Its own view, reached from the board — not a panel folded under the priced list. It names every
product Lender Price ruled out, grouped by lender, with **the vendor's refusal printed word for
word**:

> DSCR >=1.00, Loan Amount <= $1.5 MM, Purch RT, FICO < 680:  Maximum LTV/CLTV 70%

Re-wording one, grouping them under a heading of ours, or picking out which "really" caused the
decline would each be a rule. This engine holds none, and a guard fails the build if a table of ours
ever starts turning a refusal into a meaning of ours.

**One press, one request — a decision, not a missing retry loop.** The vendor computes this side
AFTER the price, so the answer may not be ready on the first ask, and every ask is an upstream call.
A self-retrying loop would keep spending on a screen somebody has walked away from. So a press asks
once, and the screen says plainly what to do next. **Three states, three different next steps**,
because collapsing any two sends somebody after the wrong thing: still computing (ask again), an
expired search key (price it again — the kickoff behind that key is gone), and a genuine failure
(the reason as given, with the priced side left standing). A page the server said it truncated
**says so and names the numbers** — a silent cap reads as "that was the whole list".

## The defaults

The scenario opens filled in — purpose, property value, loan amount, FICO, DSCR, ZIP, property type,
units and lock — so a staffer can press **Price it** and see the whole market without filling in
plumbing first.

**Every one of them is visibly a starting point.** The screen says so above the fields, and there is
a one-press reset. A prefilled scenario nobody can tell is a prefill is how somebody quotes a
borrower off a number nobody chose.

**Nothing narrows the answer.** There is no rate window, no price target, no lender filter and no
"hide expired" — the ask is to see **all rates and all products**, the vendor returns every rung of
every ladder it will quote, and the board shows all of them. A guard fails the build if a filter
appears.

**A blank field is OMITTED from the request**, never sent as `""`. An empty string is a value, and
the pricer would have to guess what it meant. **LTV is the page's own arithmetic, is labelled as
such, and is never sent** — the pricer derives its own from value and loan, and shipping a rounded
copy would let two LTVs disagree about one loan.

## Staff only

Every line names a lender and an investor, and the standing rule (CLAUDE.md, "TWO PRODUCTS, TWO
SYSTEMS", rule 10) is that an investor name never reaches a borrower or a TPO. `/api/lt` is mounted
behind `requireAuth` + `requireStaff`, and the route is declared inside `StaffPrivate` — asserted on
the route line itself.

## What is parked

Everything that lays out our OWN programmes, our OWN rules and our OWN investor guidelines — the
rate-sheet layer, the eligibility matrix, the prepayment matrix, the parity and canary apparatus —
is **left in the repo, unchanged, and reached by nothing this engine touches**. It is still at
`/internal/lt/ppe`, renamed in the nav to **"Parity & rules (parked)"** so nobody mistakes it for
the Pricing Engine. **Parked is not deleted**; if the owner wants it back it is all still there.

The boundary is enforced, not just described: a guard fails the build if this screen ever imports
from the rules side or calls one of its doors.

## Proven

The engine was run end to end against the real Lender Price system on 2026-08-23 before the screen
was written, so it was built against a measured answer rather than an assumed one:

| what | measured |
| --- | --- |
| login | OK, 1,011 ms |
| price call | OK, 12,136 ms |
| lenders / programmes / priced rungs | 17 / 32 / 1,055 |
| sample programme | Onslow, "30yr Fixed - DSCR Plus", 48 rungs, lowest rate 5.625 |
| sample price build | par 5.875, base points 1.939, adjustments −2, adjusted −0.061, **price 100.061** |
| sample LLPAs | 4 itemized, each with the vendor's group, reason and value |
| sample rate sheet | Onslow Bay ND, valid as of 2026-08-21, not expired |

A reduced copy of that exact answer is committed as
`scripts/fixtures/lt-pricer-live-capture.json` and is what the render suite drives the screen with.
It says on its own face that it is reduced, and records the full run's counts, so nobody reads it as
the whole thing.

**48 render assertions and 40+ structural ones.** Seven mutations were each proven to fail them:
rounding the rate key to two decimals, dropping a rung with no rate, sorting a missing price as
zero, dropping `full: true` from the price call, summarising a refusal instead of printing it,
leaving a blank where "no holdback" belongs, and folding the ineligible side away.

**And three of the structural guards INVENTED a defect on their first run** — flagging `bucket` (a
local grouping the vendor's own adjustment groups), `o.rateSheet` (the vendor's own rate sheet,
which is exactly what a mirror shows), and a price call built through a helper. Each was the guard
being wrong about correct code, which is the most expensive kind: the tempting fix is to bend the
code to suit the test. All three now test the thing they were about.
