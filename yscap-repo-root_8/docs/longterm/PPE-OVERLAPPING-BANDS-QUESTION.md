# LT PPE — the open question: should two overlapping bands STACK?

**Status: OPEN — needs the owner's answer in the owner's own words. Nothing here has been guessed.**
**Nobody is affected today:** the real Deephaven DSCR sheet has ZERO overlapping pricing rules
(measured over all 133 of them), so the safe direction below has never changed a live number.

## What happened

A PILOT rate sheet is a set of PRICING rules, and pricing rules **accumulate** — `rules.js` §6.1:
*"pricing (LLPA) → these never decline, they ACCUMULATE"*. So when two of them cover the same loan,
the borrower is charged for both.

Two ordinary authoring mistakes produce exactly that:

* **Overlapping DSCR blocks.** A sheet segmented `DSCR 1.00–1.25` and `DSCR 1.20–1.50` (a typed edge,
  a pasted column, two people editing months apart) charges a loan at DSCR 1.22 **twice**.
* **A duplicated adjustment row.** The same loan-amount tier imported twice charges twice.

Measured on a two-block sheet: **2.000 points of adjustment where the sheet's own least-costly single
reading is 0.750** — a **1.250-point** overcharge, **$1,500 on a $120,000 loan** — and the compiler's
`problems[]` came back **empty**. Nothing anywhere said it happened.

## What PILOT does now (`src/longterm/ppe/adjustment-overlap.js`)

Detection is `rule-coverage.analyzeRuleSet` — the one definition of "these two pricing rules overlap",
which already existed. It is asked at **both** ends of the pricing path:

* **Compile time** (`deephaven-grid.gridToRateSheet`): every collision lands in `problems[]`, naming
  both rules and the exact band they collide across. **The sheet is never rewritten** — an investor's
  sheet is theirs; a compiler reports and a human decides.
* **Price time** (`quote.quoteProgram`): the colliding adjustments are collapsed to **one** and every
  collision comes back on the quote's `problems[]`, saying which rule was applied and which was
  suppressed. `rules.evaluateRules` is unchanged and still reports *every* rule that fired — the trace
  stays the faithful audit of the sheet as written.

**It prices once and reports rather than refusing to price.** Refusing turns a pricing defect into an
outage on a sheet that may be legitimately layered, hides the money question behind an *ineligibility*
(which reads as "this borrower does not qualify" — a different and wrong statement), and leaves the
person in front of it with nothing they can do about an investor's sheet. Pricing once keeps a quote
available, guarantees the borrower is never charged twice, and puts the question below in front of a
human. A collision the checker **cannot read** (an `any`/`not`/`none` tree or a `neq`/`nin`
complement) is **reported and NOT collapsed** — suppressing an unproven collision would be inventing a
discount.

## Which one is applied, and why that is not a guess at a pricing rule

The **least costly** of the colliding adjustments, in the engine's cost-positive convention
(`pricing.normalizeAdjustment` — never a second copy of the sign rule); a tie is broken by sheet
order, so the answer is deterministic.

This is not an answer to the question — it is a refusal to overcharge while the question is open.
Whatever the true reading turns out to be, the borrower was charged **no more than the sheet's own
smallest single answer** for that dimension.

## THE QUESTION FOR THE OWNER

1. When two bands on one dimension overlap, is a loan in the overlap meant to take **both**
   adjustments, or **one**?
2. If one — **which**? The tighter band? The one listed first? The one the investor's own pricer
   applies?
3. Should a sheet that overlaps be **publishable at all**, or should the publish step refuse it until
   an author fixes the bands?

Until (1)–(3) are answered in the owner's own words, the safe direction above stands and every
occurrence is reported at both ends. **Do not change the collapse rule, or make an overlap refuse to
price, on an inference from this document.**

## Proof

`scripts/test-lt-ppe-double-charge.js` — the reproduction with the numbers above, both reports, the
collapse, the three-way case, the unreadable case, and the **control**: over the canonical
~300-scenario agreement battery on the real Deephaven DSCR sheet, every priced ladder is
byte-for-byte what the unguarded composition produces, `problems[]` is empty, and nothing is
suppressed.
