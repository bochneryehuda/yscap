# The minimum origination fee — research before anything is built

**Owner-directed 2026-09-04. RTL only** (Standard, Gold, Silver, Speed, Manual). Nothing here
touches the long-term product.

> *"Massive massive massive enhancement on all of our programs. All of our RTL programs. The manual
> program. The Speed program the standard program the silver program the gold program everything.
> We're going to enforce right now a minimum origination fee of 2,500 dollars pre-filled which
> means should not be pre-set it should be pre-filled … we're going to add this to the manual
> section as part of the pricing exceptions pre-filled a minimum of 2,500 … if the loan amount is
> 100,000 it's going to be more than the origination set by percentage because no matter the
> percentage it's not going to get to 2500 and 2500 is the minimum … also in the admin section
> where we pre-set everything for the entire program where we can increase and decrease the minimum
> accordingly. The term sheet generator products and pricing and it should come up that the
> origination fees because we have a 2,500 minimum if the origination fee is more than the standard
> percentage and populate on the initial term sheet on all the term sheets on the final term sheet
> it needs to calculate in the cash to close and the liquidity requirement needs to be a new line of
> the term sheet like not a new line but wording next to the origination fee that's because of the
> minimum … You need to add to the general exception pad an exception for the minimum and all the
> exception routes should have an added option to make exceptions for the minimum fee and stuff like
> that. Do first the research engine how to wire this in correctly in all the products everywhere.
> In all the sections that manual section where we overwrite and make exceptions. The exception
> route: Term sheet / Product pricing / Liquidity calculation / Structure screen / Everywhere else.
> Which wording then is for the program minimum origination fees?"*

This document is the research pass the owner asked for **first**. It states what the system does
today (measured, not remembered), what one honest change looks like, the decisions that are the
owner's to make, and the wording. **No code has been changed.**

---

## 1. What the origination fee is today — measured

`src/lib/pricing.js normalize()`, one line:

```js
const origination = totalLoan > 0 ? round2(totalLoan * origPct) : 0;
```

`origPct` resolves through a chain that is already per-program and already admin-adjustable
(`resolvedOrigPct` / the `origKey` block):

| program  | per-file override | company default            | engine fallback |
|----------|-------------------|----------------------------|-----------------|
| Standard | `origStdPct`      | `orig_std_pct` (1.25%)     | `YSP.constants.ORIG_PCT` |
| Gold     | `origGoldPct`     | `orig_gold_pct` (1.25%)    | `GSP.constants.ORIG_PCT` |
| Silver   | `origSilverPct`   | `orig_silver_pct` (1.25%)  | `SVP.constants.ORIG_PCT` |
| Speed    | `origSpeedPct`    | `orig_speed_pct` (1.25%)   | `SPP.constants.ORIG_PCT` |
| Manual   | `origManualPct`   | *falls back to Standard's* | — |

**THE SINGLE MOST IMPORTANT FINDING: the origination fee is not a frozen-engine number.**
`ORIG_PCT` is exported by each engine as a *constant* and is never read by `sizeLoan` — checked in
`web/tools/standard-program.js` (it appears at the declaration and in the exported `constants`
block, nowhere in the waterfall). So the loan amount, the note rate, every cap, the initial advance,
the holdback and the financed reserve are all computed **above** this line and never read it. A
minimum is therefore a pure closing-cost change of exactly the same class as the construction
feasibility fee (2026-08-21) and the legal-fee ladder (2026-08-26) — **no owner authorization of a
frozen guideline number is required, and no engine file is touched.**

**Where it already cascades, by construction, with nothing new to wire:**

```
origination ──► closingDueAtClose ──► cashToClose ──► liquidityRequired
                (pricing.js:957)      (pricing.js)    (= cashToClose + reserve + oopRehab + 1% buffer)
```

So the owner's *"it needs to calculate in the cash to close and the liquidity requirement"* is
satisfied **the moment the minimum is applied at that one line** — a fee can never be missing from a
total that is built by adding. That is the same reasoning `scripts/lib/fee-roster.js` records for
why `cashToClose` and `liquidityRequired` are *totals proven by arithmetic*, never surfaces proven
by a source token.

### What the minimum actually changes — measured

At today's 1.25% default, **$2,500 is reached at a $200,000 loan**, so the minimum binds on every
loan below that and on nothing above it:

| loan     | 1.25%       | charged    | effect                              |
|----------|-------------|------------|-------------------------------------|
| $50,000  | $625.00     | $2,500.00  | +$1,875.00 — effective **5.000%**   |
| $100,000 | $1,250.00   | $2,500.00  | +$1,250.00 — effective **2.500%**   |
| $150,000 | $1,875.00   | $2,500.00  | +$625.00 — effective **1.667%**     |
| $180,000 | $2,250.00   | $2,500.00  | +$250.00 — effective **1.389%**     |
| $200,000 | $2,500.00   | $2,500.00  | binds exactly, no change            |
| $400,000 | $5,000.00   | $5,000.00  | **byte-identical to today**         |

The owner's own example is line 2 of that table.

---

## 2. The shape of the change — one definition, one line

`src/lib/min-origination.js` — **PURE** (no database, no config, no requires), the same shape as
`feasibility-fee.js` and `lender-fees.js`, so every rule is unit-testable and the server, the
studio and the admin screen read ONE definition:

```js
originationFor({ totalLoan, origPct, minFee })
  → { amount, pct, minimum, applied, shortfall, effectivePct, label, note }
```

and `pricing.js` becomes:

```js
const orig = minOrig.originationFor({ totalLoan, origPct, minFee: resolvedMinOrigFee });
const origination = orig.amount;                     // ← everything downstream is untouched
```

`quote.closingCosts.origination` keeps its exact meaning (**the dollars actually charged**), so all
of DocLab, the tapes, the emails, the tie-outs and the reporting keep working with no change. The
*explanation* rides beside it as a new `closingCosts.originationMinimum` block, present only when
the minimum actually bound — which is what lets a surface print the wording without re-deriving the
rule.

### The resolution chain (mirrors every other fee in this system exactly)

```
per-file override  minOrigFee            (typed in the studio's admin zone, approval-routed)
      ↓ blank
company default    min_orig_fee          (db/695 on company_pricing_settings, Pricing Admin Center)
      ↓ unset
system default     MIN_ORIGINATION_FEE = 2500
```

**"Pre-filled, not pre-set" is a settled contract in this repo and it must be honoured literally.**
The owner used the identical words for the New York legal ladder on 2026-08-26 (*"everything of this
should not be hardwired. It should just be pre-filled in the manual section. Everything can be
changeable"*), and that shipped as: a **placeholder** in the studio admin zone + a **company
default** in the Pricing Admin Center. It must not ship as a painted `value`, because of the
2026-08-20 rule — a value in an admin box IS an explicit per-file override, it gets frozen onto
`applications.file_*`, and every subsequent registration then prices off a stale copy of the
company default and routes to an admin for approval. `seedAdminDefaults()` already enforces this;
the new box joins it (`s("tsMinOrigFee", …)` — placeholder only, never `value`).

---

## 3. Decisions that are the owner's, not mine

**D1 — Does the minimum apply per PROGRAM or once company-wide?**
Recommend **one company-wide minimum with a per-program override available but unset**. The owner
said *"all of our RTL programs … everything"* and named one number. Per-program columns can be added
later without moving anything; four columns nobody uses is four ways for the number to drift.
→ *Awaiting sign-off.*

**D2 — Is it a floor on OUR origination only, or on the TPO broker's fee too?**
Recommend **ours only**. `brokerFee` is the broker's own revenue on their own file (owner-directed
2026-08-06), set by the firm; applying our floor to it would silently raise a third party's fee.
→ *Awaiting sign-off.*

**D3 — What does the minimum do to a Manual product?**
Manual has no company origination default of its own — a blank Manual box means "use Standard".
Recommend the **same minimum applies**, because the owner listed the manual program first.
→ *Awaiting sign-off.*

**D4 — What does an approved exception DO: waive the minimum entirely, or set a lower one?**
Recommend **set a lower one** (a number, which may be `0` = fully waived). "Reduce to $1,500" is a
real thing a person wants and a pure waiver cannot express; zero already means waived. This also
keeps it the same shape as every other fee override in `pricing-overrides.js`.
→ *Awaiting sign-off.*

**D5 — Does raising the minimum on a file need approval?** Under the existing `revenueUp` rule,
charging **above** the company default needs no approval and charging **below** does. A minimum
*raises* the fee, so **lowering or waiving the minimum is the exception** — which is exactly what
the owner asked for. Recommend `minOrigFee` be an `ENGAGED_OVERRIDE_KEY` with `zeroIsEngaged: true`
(waiving $2,500 is the decision an admin most wants to see) — the identical treatment `legalFee`
already carries.
→ *Recommended, no ambiguity, but stated so it is on the record.*

**D6 — GOING FORWARD ONLY, or does it reach files already registered?**
Recommend **going forward only, with no backfill.** A live file re-prices on its next registration
and picks it up then. A sweep would raise the cash-to-close and the liquidity requirement on the
whole open book at once, which reopens Products & Pricing (db/071/072) and can un-sign live term
sheets — the same hazard that made the appraisal As-Is sweep and the Speed knobs go-forward only.
A file whose term sheet is already **signed** is protected by the existing freeze either way.
→ *Awaiting sign-off.*

---

## 4. Open questions I cannot answer and will not guess

**Q1 — Blue Lake's data tape carries POINTS, not dollars.** `src/lib/tapes/bluelake.js` column BC
is `origPct` (the registered quote's percentage). On a $100,000 loan the minimum makes the borrower
pay an effective **2.5%** while that column would still say **1.25%** — the tape would understate
what was charged. Fidelis and EMCAP were checked and carry no origination column at all. Options:
send the **effective** percentage (`amount / totalLoan`), send the stated percentage unchanged, or
ask Blue Lake. **This changes what an investor receives and needs the owner's own words.**

**Q2 — Encompass field 388 is the origination PERCENT, and it is a BLOCKING comparison row.**
`encompass-field-map.js` compares our `origPct × 100` against Encompass field 388 on the reconcile
panel, and that row is `GATE.BLOCK` — a mismatch holds the DocuSign term sheet and the data-tape
export. If our stated percentage stays 1.25 while the loan is actually booked in Encompass at the
effective 2.5%, **every small loan would fail that check and be unable to issue.** The recorded way
through is the existing super-admin field exception, but that is a dead end if it happens on every
small file. Needs a decision on which number goes into Encompass **before this ships.**

**Q3 — Does the minimum apply to a loan with no loan amount yet?** Today `origination` is `0` when
`totalLoan` is 0. Recommend it stays `0` (a fee on a deal that does not exist is nonsense), i.e.
the minimum only ever applies to a **sized** loan. Stated for the record rather than assumed.

---

## 5. The wiring map — every place it has to reach

The audit engine already exists: `scripts/lib/fee-roster.js` names **nine surfaces** every fee must
be printed on, and derives the closing-sum half so an unlisted fee fails the build. **The minimum is
NOT a new fee** — it is a floor on the existing `origination` addend — so the roster's derived half
needs no new entry. What it needs is a per-surface token proving each surface prints the **wording**
when the minimum bound.

| # | surface | file | what has to change |
|---|---------|------|--------------------|
| 1 | Term sheet PDF | `web/v2/tools/termsheet.js` (`rowIn(… "Origination fee (")`) | the qualifier beside the row |
| 2 | Spreadsheet — Standard (`d`) | same | ditto, keyed on its own data variable |
| 3 | Spreadsheet — Gold (`gd`) | same | ditto |
| 4 | Spreadsheet — Silver (`sd`) | same | ditto |
| 5 | Spreadsheet — Speed (`pd`) | same | ditto |
| 6 | Studio structure screen | same (`YS.put("rOrig"…)` / `rOrigLbl`) | ditto |
| 7 | Staff Products & Pricing panel | `app-v2/src/components/ProductStudioPanel.jsx` | ditto |
| 8 | Borrower "your terms are ready" email | `src/lib/product-registration.js` | ditto |
| 9 | Inputs & Loan Derivation page | `web/v2/tools/termsheet.js` | show the arithmetic (pct → minimum → charged) |

Plus, outside the roster's nine:

- **`src/lib/pricing.js`** — the one line, the resolution chain, the explain block.
- **`web/v2/tools/termsheet.js`** — the **browser mirror**: `origFee` is computed independently in
  **four** places (`calc`, `calcGold`, `calcSilver`, `calcSpeed`). All four must apply the same
  floor, and a mirror-agreement test must run BOTH copies — remembering the 2026-08-26 lesson that
  *a mirror-agreement test proves consistency, never correctness*, so the RULE must be asserted too.
- **`web/v2/tools/term-sheet.html`** — the `tsMinOrigFee` box in the admin zone + a cache-buster bump.
- **`src/lib/pricing-settings.js`** — `SYSTEM_DEFAULTS.minOrigFee = 2500`, `shape()` mapping,
  and both column SELECT lists.
- **`src/lib/pricing-overrides.js`** — the `minOrigFee` key (D5), its label, and the
  `sanitizeStaffOverrides` allowlist. **Never** the borrower's `borrowerPricingOverrides` allowlist,
  and never a TPO broker's.
- **`db/695`** — `company_pricing_settings.min_orig_fee` + `applications.file_min_orig_fee`
  (the sticky per-file value, written only by a registration, so — per db/609 and db/632 — the
  economics-reopen trigger is deliberately **not** widened; a source guard enforces the
  single-writer claim).
- **`src/lib/tpo-pricing.js`** — the resolved `cd` must carry the minimum so a broker's quote and a
  retail quote agree about our fee. Recommend the minimum is **retail's, not per-firm**.
- **`src/routes/admin-pricing.js` + `app-v2/src/screens/StaffCompanyPricing.jsx`** — the admin box
  the owner asked for (*"the admin section where we pre-set everything for the entire program where
  we can increase and decrease the minimum accordingly"*).
- **`src/lib/liquidity.js`** — nothing to change (it reads the stored quote's totals), but the
  liquidity condition must be re-synced on registration, which it already is.
- **`src/doclab/payload.js`** — nothing to change (`origination_fee` reads
  `quote.closingCosts.origination`, which is the charged dollars) — **verified, not assumed.**

### The exception half

- **`src/lib/loan-exceptions.js`** — the owner's *"add to the general exception pad an exception for
  the minimum"* is one new reason code on the **existing** `pricing_exception` type:
  `min_orig_fee: 'Reduce or waive the $2,500 minimum origination fee'`. The register's own rule is
  *"adding a type = one registry entry + a migration widening the CHECK + a TYPE_META entry — never
  a per-type ternary"*, and this needs **no new type at all** — a minimum-fee exception is a pricing
  exception, decided by the same people, on the same queue, with the same SLA.
- ***"all the exception routes should have an added option"*** — the reason list is **already
  shared**: `reasonCodesFor('pricing_exception')` is what every route and every screen renders, so
  adding the one code makes the option appear on the staff request route
  (`POST /applications/:id/pricing/request-exception`), the borrower's mirror of it, the Approvals
  hub, the exception card, the xlsx register export and the decision certificate — **for free, with
  no per-route edit.** That is the design this repo already paid for; it must not be re-litigated
  with a second list.
- **The GRANT** stays what every pricing exception's grant already is: an admin sets the per-file
  `minOrigFee` in the studio's admin zone and re-registers. Never automated.

---

## 6. The wording — answering the owner's closing question

> *"Which wording then is for the program minimum origination fees?"*

The owner was explicit that this is **not a new line**: *"needs to be a new line of the term sheet
like not a new line but wording next to the origination fee that's because of the minimum."* So the
origination row keeps its place and gains a qualifier. Recommended:

**The row label, when the minimum binds:**

> **Origination fee (minimum applied)** … $2,500.00

**The sub-line under it (the term sheet, the studio, the staff panel):**

> *This loan's origination fee is our $2,500 program minimum, which is more than 1.25% of the loan
> amount ($1,250.00).*

**On the Inputs & Loan Derivation page** (which records HOW a number was reached, so it shows the
arithmetic rather than the sentence):

> Origination — 1.25% of $100,000 = $1,250.00 · program minimum $2,500.00 · **charged $2,500.00
> (2.500% effective)**

**In the borrower's "your terms are ready" email** (plain, no jargon, no percentages competing with
each other):

> Origination fee — $2,500.00 (our minimum origination fee; on this loan amount it is more than the
> 1.25% rate)

**When the minimum does NOT bind, every one of these is byte-identical to today** — no qualifier, no
sub-line, no mention. A note that appears on every file teaches people to stop reading notes.

**Three things the wording deliberately never says:** it never calls it a penalty (it is a floor on
a fee, exactly like the 3-month minimum earned interest is never a "prepayment penalty" — the same
standing rule); it never names a note buyer or capital partner; and it never states an effective
percentage on the **borrower-facing** term sheet row, because two percentages on one line invites
the question "which rate am I being charged?" — the effective figure lives on the derivation page
and the staff panel, where the reader is an underwriter.

---

## 7. Traps found while researching, each of which would bite

1. **A painted value freezes the default onto the file.** (2026-08-20.) The box must be a
   **placeholder**. A `value` of 2500 becomes a per-file override, sticks to
   `applications.file_min_orig_fee`, and every later registration routes to an admin for approval
   while pricing off a stale copy.
2. **Four browser mirrors, not one.** `calcSpeed` was added 2026-09-03 and `STUDIO_MIRRORS = 4`.
   A floor applied in three of them means the printed sheet and the registered quote disagree on
   one program alone — invisible until somebody compares two documents.
3. **Each spreadsheet column must be keyed on its OWN data variable** (`d`/`gd`/`sd`/`pd`). The
   feasibility fee was "present in the spreadsheet" for five days while missing from Gold and
   Silver, because a search for the word found the Standard column and stopped.
4. **A mirror-agreement test proves consistency, never correctness.** Two copies of one mistake read
   as a pass — that is exactly how the bridge/feasibility bug survived. Assert the RULE as well.
5. **A test must be proven to FAIL.** The equivalence baseline for "the system without this
   minimum" must be built by **neutralising the module**, never by reading `git show HEAD:` — a git
   baseline proves inertness only until the change is committed, after which it degenerates into
   "the engine equals itself" and passes forever while proving nothing.
6. **Encompass field 388 (Q2 above) is a blocking row.** This is the one item that could stop small
   files issuing, and it must be settled before the first live file.
7. **`round2` before comparing.** `Math.max(round2(loan * pct), minFee)` and
   `round2(Math.max(loan * pct, minFee))` differ by a cent at the boundary; the fee must be computed
   once and reconciled to the printed total to the cent, or the fees a borrower can read will not
   add up to the total they are asked to bring — which is the whole reason the fee audit exists.

---

## 8. What I recommend building, in order

1. `src/lib/min-origination.js` + `scripts/test-min-origination-pure.js` (the rule, every boundary,
   the wording, and the "no minimum on an unsized loan" case).
2. `db/695` + `pricing-settings` + `pricing-overrides` + the `pricing.js` line, with an
   **equivalence proof**: with the minimum neutralised, a priced battery is byte-identical; with it
   on, only the fee, the closing total, the cash to close and the liquidity move, each by exactly
   the shortfall.
3. The four studio mirrors + the admin-zone box + the cache-buster, with a real **render** proof —
   a source test cannot see whether a box is wired to the right field id (the 2026-08-26 `purchase`
   vs `price` lesson).
4. The nine surfaces + the fee-roster tokens.
5. The Pricing Admin Center box + the TPO layer.
6. The one exception reason code (which reaches every exception route for free) + a test that it
   really does appear on each of them.

**Nothing starts until D1–D6 and Q1–Q2 are answered.** Q2 in particular can make small loans
unissuable, and that is not a thing to discover on a live file.
