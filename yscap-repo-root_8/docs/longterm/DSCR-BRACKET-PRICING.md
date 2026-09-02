# Pricing every rate in the DSCR band it actually reaches

Owner-directed 2026-09-01. This is the research and the design behind
`src/longterm/pricing/{dscr-tiers,bracket-board,bracket-run}.js`.

## The report

> *"Option 11.125% — Harbor has moved band. These figures come to 0.93, which is a
> lower DSCR band than the 1.25 it was priced in — so the rate on it is one this
> loan no longer qualifies for. Re-price at 0.93 and issue from the new price."*

That sentence is `termsheet/snapshot.js` `repriceProblem`, and **it is correct**.
It is not the bug. The bug is that the board offered the rate at all.

## Why a single-ratio board is wrong, in one line

A search is priced at ONE assumed DSCR. But the rate sets the payment, and the
payment is the DSCR's denominator:

```
DSCR(rate) = rent / ( P&I(rate) + tax + insurance + HOA )
```

So the ratio a loan actually achieves **depends on the rate it takes**. A board
asked at 1.25 prices its 6.5% rung and its 11.125% rung as though both achieve
1.25. Measured on a $300,000 30-year deal with $3,000 rent, $400 tax, $150
insurance:

| rate | true DSCR | band |
|---|---|---|
| 6.500% | 1.23 | 1.15 – 1.25 |
| 8.500% | 1.05 | 1.00 – 1.10 |
| 11.125% | 0.87 | 0.85 – 1.00 |

Every one of those rates was on one board, priced as one ratio. Three different
bands, one price assumption. The term sheet catches it at issue; the officer
finds out at the end.

## The fix

Ask the vendor once **per DSCR band**, and show every rate under the band its own
ratio reaches.

Nothing here is a new business rule. All three rules it stands on existed:

| what | where | note |
|---|---|---|
| what a band IS | `pricing/dscr-tiers.js` | the owner's own eleven-tier ladder, **moved** out of `snapshot.js`, not copied |
| what a ratio IS | `encompass/formulas.computeDscr` | the tenant's own `Round(rent / PITIA, 2)` |
| what a payment IS | `termsheet/overlay.monthlyPI` | only used when the vendor did not quote its own |

### Sharing the bracket, which was the explicit instruction

> *"You know internally the brackets that we require reprice. Don't rebuild that
> bracket. I want to stay that bracket, just share that bracket, because if the
> bracket is changing you should automatically change yourself as well."*

The ladder that decides a re-price now lives in one module. `snapshot.js`
requires it and re-exports it; the board requires it. `test-lt-dscr-brackets-pure`
asserts the two hold the **same object**, not two tables that happen to agree, and
that the second copy is gone from `snapshot.js`. Move an edge and the board
re-groups itself.

**`dscrBand` in `lenderprice/search-model.js` is a different thing and is NOT the
bracket to share.** It maps a ratio to Lender Price's own `DSCRRATIO` token and
band SMO, and both of those are gated OFF (`LP_SEND_DSCRRATIO`,
`LP_SEND_DSCR_BAND_SMO`) — §37.9 records that sending the token cost us a whole
lender program. What actually carries the ratio to the vendor today is the plain
`criteria.dscr` number.

### The ratio each band is searched at

**The lowest ratio any rate in that band reaches.** Every other rate in the band
beats it, so nothing is ever priced at a ratio the loan has not earned — a board
that over-stated the ratio would hand back exactly the too-good rate that was
reported. With no rates yet in a band it falls back to the band's own floor,
which is the same figure by construction.

That choice is also what makes the invariant hold:

> **For every quote on the finished board, the band it was priced in is the band
> its own rate reaches.**

Which is precisely `ratioProblem`'s test — so a sheet built from this board
cannot produce the owner's refusal. Section F of the test proves it by running
the **real** `snapshot.exportGate` over every quote, with a control that shows the
same rates priced the old way *do* refuse (5 of 5).

### Finding the bands — two failures the naive version had

The obvious approach is "price the bands the first board's rates land in". It was
built, and measured to fail two ways:

1. **A hole in the middle.** The first board's rates fell in bands 7 and 5;
   nothing landed in 6, so band 6 was never asked about — although the ratio moves
   smoothly with the rate, so rates in band 6 plainly exist.
2. **An investor no search could reach.** A lender pricing only at a weak ratio
   cannot appear on a board asked at a strong one, so its band is never observed,
   so it is never asked about, so it is never observed.

That second one is the owner's *"don't go only by the rates that are coming up"*.

So the frontier is: the observed bands, **plus every band between the weakest and
the strongest**, **plus one band beyond each end** — and the loop walks outward
again only while the edges keep returning rates this loan can use. It converges
because a band leaves the frontier the moment it is priced and there are eleven of
them. On the measured fixture it costs 7 searches and finds the low-ratio investor
a single search could never have shown.

### What the board shows

Strongest band first — which is the owner's own economics (*"lower rates mean
better ratios… the cheapest rate should be set up with the highest ratio"*) and is
not imposed anywhere: it falls out of the arithmetic, because the ratio falls as
the rate rises.

Only bands with rates are drawn. A band that was asked about and came back with
nothing is **reported with its reason** rather than hidden — *"no lender priced
this deal at that ratio"* and *"the rates that came back belong to other bands"*
are different facts, and neither is *"we did not look"*. A band whose search
**failed** is reported separately again: that is a fact about the vendor, not about
the loan.

### The sheet judges the band the option was priced in — not the form's ratio

Reported 2026-09-02, the day after the banded board shipped:

> *"Option 5.75% — Harbor has moved band. These figures come to 1.25, a higher DSCR
> band than the 1.14 it was priced in… I searched a scenario, which was a full
> scenario. It comes up all the bands, and the 5.75 was actually priced on the 1.25
> band… He's still claiming that it's a different band just because he's not
> looking at the correct ratio, but in real life, it was priced on the correct
> ratio… You should not look at the original scenario. You should look at what was
> the actual pricing on."*

The board was right and the sheet was wrong. `ratioProblem` asks *"which band was
this priced in?"* of the member's `scenario.dscr`, and the browser sent the
**form's** DSCR as the scenario of every option it collected — on a banded board
that figure is only where the search *started*. The 5.75% option was bought in
band 8 at band 8's own ratio, and stamped 1.25 to say so; the sheet judged it
against the 1.14 the officer typed, found a different band, and refused.

**The fix is a fact carried, not a rule changed.** A collected option now carries
the ratio it was priced at (`pricedDscr` — the board's own stamp on the option)
and `snapshot.buildMember` makes it the member's `scenario.dscr`: *the scenario as
it was priced* for that option, which is what the cart stores per member, what the
document prints, and what the re-price rule judges. An option that carries none
(an unbracketed board, the combined board, an older cart) keeps the form's ratio,
which on those boards is what was actually sent. The browser's own pre-check
(`ratioCheck`) prefers the same stamp, and the comparison-ux suite fails the
moment the two preferences differ.

Section G of `test-lt-dscr-brackets-pure.js` reproduces the report exactly —
the form at 1.14, every option on the real board, selections built the way the
browser now builds them — through the real `exportGate`: none refuses. The
control sends the same selections without the stamp and the owner's sentence
comes straight back.

### Collecting a row is one press, on the row

Owner-directed 2026-09-02: *"You don't need to click Details and go down and
click Add. You should be able to do that right away… It can just be a button, but
it needs to be very clean, modern, user-friendly, and simple. Next to each and
every quote."*

Every quote row carries **Add to comparison**, which becomes **In comparison**
once pressed and takes the option back out on the next press. It is there
whether or not a workflow has been chosen at the bottom of the board — the
chooser still says which *document* is being built, but it no longer gates
whether a row can be collected, which is what made the earlier tick-box look as
though it had disappeared.

## On logging in several times

> *"Maybe you can duplicate your agents to log in several times separately,
> because it's not a real API, so you can't do a few requests."*

**Not needed, and it would be the riskier option.** `lenderprice/client.js` holds
one shared service login behind a single-flight lock, and its own header records
that *"the pricing call is stateless (each search independent), so concurrent
searches don't collide."* Several sessions on one service account is the shape a
vendor rate-limits or bumps. The runner instead keeps a small number of searches
in flight at once (`LP_BRACKET_CONCURRENCY`, default 3).

## What it costs, and why it is a button

One vendor search per band. On a real deal that is 4–7 searches instead of 1, so
it is a deliberate press on the pricing engine — never an effect, never a
keystroke — and the button states the cost before it is pressed.

## Open, and the owner's to decide

- **Should this replace the ordinary board rather than sit beside it?** It is
  built as a second, pressed view so the existing board is untouched and the extra
  vendor cost is opted into. Making it the default is a one-line change and a real
  decision about spend.
- ~~**Should the term sheet be issued straight from a bracket row?**~~ Settled
  2026-09-02: every row carries *Add to comparison*, so collecting from a band is
  one press, and a single option's term sheet issues from its Details panel as it
  always did. The sheet knows which band it is "from" because the option carries
  the ratio it was priced at (see above).
