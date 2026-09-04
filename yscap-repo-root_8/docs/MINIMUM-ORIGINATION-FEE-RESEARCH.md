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
owner's to make, and the wording.

> **STATUS 2026-09-04 — BUILT AND SHIPPED.** Sections 1–8 are the research as it was written before
> anything was changed, and they are kept unedited so the reasoning can be read against what
> actually shipped. **§9 is the shipped record** — what was built, what was measured rather than
> assumed, what was corrected along the way, and what is deliberately still open. Where §9 and an
> earlier section disagree, **§9 is what the code does.**

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

**Status 2026-09-04:** put to the owner as recommendations. The reply that settled Q1 and Q2 did not
correct any of them, so they proceed as **stated defaults**, clearly labelled as such — silence is
never recorded here as approval. Any one of them is a one-commit reversal.

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

## 4. The two questions that were blocking — ANSWERED by the owner 2026-09-04

Both are settled, and both answers were verified against primary sources before being written down
here rather than taken on trust.

### Q1 — Blue Lake's data tape: send the REAL percentage. ✔ ANSWERED

> *"Send them a higher percentage, according to how much this is the real percentage for $2,500."*

`src/lib/tapes/bluelake.js` column **BC** ("Total Points") is `e.origPct`, fed from `q.origPct`.
Measured: `quote.origPct` is the **fraction** (`0.0125`), rendered by `FMT.RATE` (`'0.00#%'`), so
Excel shows `1.25%`; the percent-scaled copy (`1.25`) lives on `quote.adminPricing.origPct`, which
is the staff-only block and is not what the tape reads. So the change is one expression:

```js
origPct: n(q.origPct)                       // today
origPct: effectiveOrigPct(q)                // = origination / totalLoan when the minimum bound
```

On the owner's $100,000 example that sends **0.025 → "2.5%"**, which is what the borrower actually
paid. **When the minimum does not bind it is byte-identical** — `origination / totalLoan` IS
`origPct` by construction — so no tape already sent changes meaning, and the effective figure is
DERIVED from the two numbers on the row rather than stored, so it can never disagree with the
dollars beside it.

**Fidelis and EMCAP are unaffected — checked, not assumed:** neither tape carries an origination
column at all (`emcap.js` column K is the *rehab* amount; the word "origination" appears in those
files only in comments about seasoning). Blue Lake is the only one.

### Q2 — Encompass: when the minimum binds, compare field **454**, not 388. ✔ ANSWERED

> *"Encompass has a different field, 454, which is the flat amount of the origination, so any time
> that you are hitting your minimum, instead of mapping to field ID 388 Map it to 454."*

**VERIFIED AGAINST THE TENANT'S OWN FIELD EXPORT, and the owner is exactly right — better than
right, because the two fields turn out to be two attributes of the SAME fee object:**

| field | label | contract path | format | fill (fix & flip) |
|-------|-------|---------------|--------|-------------------|
| **388** | Fees Loan Origination Fee % | `loan.fees[feeType=='LoanOriginationFee'].percentage` | `DECIMAL_3` | 91.6% |
| **454** | Fees Loan Origination Fee Borr | `loan.fees[feeType=='LoanOriginationFee'].borPaidAmount` | `DECIMAL_2` | 80.9% |

They are the **percentage** and the **borrower-paid dollars** of one and the same
`LoanOriginationFee`. That is what makes this the right answer rather than merely a workable one:
we are not comparing a different fee, we are comparing the same fee by the attribute that is
unambiguous. Observed values on 454 are real dollars (min $1,725, median $6,000, max $15,400) and
its fill by stage is **100% from Loan Setup onwards**, so on any file far enough along to be issuing
a term sheet the number is there.

**The rule, therefore:**

- minimum **did not** bind → compare `origPct × 100` against **388**, exactly as today, byte-identical.
- minimum **did** bind → compare the origination **dollars** against **454**.

Two things this deliberately does NOT do. It does not stop pulling 388 (it stays on the panel as a
reference row, because a reader still wants to see what percentage was typed). And it does not
write anything: **Encompass stays READ-ONLY** — 454 joins the registry as one more `pull()`, which
is exactly what `check-encompass-readonly.js` permits and what the write pad does not need to
record.

**Where the field number is verified, and the one thing that must NOT be done with it.** The table
above was read from the tenant's own Encompass field export. That export happens to be stored at
`src/longterm/encompass/dictionary/field-dictionary.json` — **LONG-TERM product code**. Citing a
fact about the vendor's own field numbering in an RTL research note is fine; **an RTL module may
never `require` that file.** RTL spells the id and the path out in its own
`encompass-field-map.js` registry entry and verifies it live against `encompass_field_catalog`
(db/245), which is the RTL-native copy of the same catalogue. This is written down because the
tempting shortcut — importing the dictionary — is precisely the crossing the product-separation
rule forbids.

### Q3 — a loan with no amount yet carries no minimum

Today `origination` is `0` when `totalLoan` is 0. It stays `0`: a fee on a deal that does not exist
is nonsense, and the minimum only ever applies to a **sized** loan. Stated for the record rather
than assumed.

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
- **`src/lib/tapes/bluelake.js`** — column BC sends the EFFECTIVE fraction when the minimum bound
  (Q1). Derived from the row's own two numbers, never stored, and byte-identical when it did not.
- **`src/lib/integrations/encompass-field-map.js`** — field **454** joins the registry as a `pull()`
  (a READ; Encompass stays read-only), and the origination comparison switches to it when the
  minimum bound (Q2). 388 stays, as a reference row.
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
6. **Encompass field 388 is a blocking row, and comparing it on a minimum-bound file is what would
   stop small files issuing.** Settled by Q2: on those files the comparison moves to field 454 (the
   same fee's borrower-paid dollars). The trap that remains is *forgetting the switch* — comparing
   388 against a stated 1.25% while the loan is booked at an effective 2.5% holds the term sheet AND
   the tape export, on every small file, with the only way through being a per-file super-admin
   exception. The test for this must assert the comparison PASSES on a minimum-bound file, not
   merely that 454 is read.
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
7. **Blue Lake's tape** (the effective fraction on column BC) + **Encompass field 454** (the
   comparison switch), each with a test that bites: for the tape, that a minimum-bound loan sends
   0.025 and an ordinary one is byte-identical; for Encompass, that the reconcile row **PASSES** on a
   minimum-bound file rather than merely that the field is pulled.

**Q1 and Q2 are answered, so the build is unblocked.** D1–D6 were put to the owner as
recommendations to be corrected and none was corrected in the reply that settled Q1/Q2 — they are
therefore proceeding **as stated defaults, not as approvals**, and each is small enough to reverse
in one commit. The two that would cost most to get wrong, and so are worth a second look before
they ship, are **D2** (the minimum applies to our fee only, never the TPO broker's own) and **D6**
(going forward only — no sweep of the open book).

---

## 9. THE SHIPPED RECORD — what was actually built, 2026-09-04

Five commits on `claude/speed-program-rtl-research-s70uam`. Sections 1–8 above are the research as
written **before** anything changed; this section is what the code does.

### 9.1 The one rule, and why it touched no frozen engine

`src/lib/min-origination.js` is the whole rule and it is **PURE** — no database, no config, no
`require`s — so the server, the studio's browser mirror and the admin screen read ONE definition.

**No frozen engine file moved, and that was verified rather than assumed.** Each engine exports
`ORIG_PCT` as a constant and never reads it in `sizeLoan` — in `standard-program.js` it appears
only at its declaration and in the exported `constants` block. The loan amount, the note rate,
every cap, the initial advance, the holdback and the financed reserve are all computed **above**
the origination line and never read it. So a floor on that fee is a pure closing-cost change of
exactly the same class as the construction feasibility fee and the legal-fee ladder, and it needed
no authorization of a frozen guideline number.

**It reaches cash to close and the liquidity requirement with nothing extra wired**, because the
cascade is built by adding:

```
origination ──► closingDueAtClose ──► cashToClose ──► liquidityRequired
```

A fee can never be missing from a total that is built by adding — the same reasoning
`scripts/lib/fee-roster.js` records for treating those two as totals proven by ARITHMETIC rather
than surfaces proven by a source token. The owner's *"it needs to calculate in the cash to close
and the liquidity requirement"* is therefore satisfied at the ONE line where the floor is applied,
in `pricing.js`:

```js
const originationDetail = minOrig.originationFor({
  totalLoan, origPct,
  minFee: minOrig.resolveMinFee(hasInput(input, 'minOrigFee') ? input.minOrigFee : null, cd.minOrigFee),
});
const origination = originationDetail.amount;
```

`amount` keeps the exact meaning `quote.closingCosts.origination` already had, so DocLab, the
tapes, the emails, the tie-outs and the reporting needed no change.

### 9.2 "Pre-filled, not pre-set" — the property, and where it is enforced

The owner's distinction is the whole design, and it is enforced in **four** places, not one:

| Layer | What makes it a pre-fill |
| --- | --- |
| `db/695` | Both columns are **nullable with NO DEFAULT**. A `DEFAULT 2500` would stamp the number onto every row at insert, and a stamped value is an explicit per-file override that outlives every later change to the company number — the 2026-08-20 defect reproduced in the database. |
| The studio | The company number is a **placeholder**, never a painted `value` (`seedAdminDefaults` sets the attribute, not `.value`). |
| `pricing-overrides` | `minOrigFee` is a **DEFAULTED** key, so `normalizeCompanyDefaultKnobs` maps an exact restatement of the company number back to `''`. |
| `buildInputs` | An explicit `''` **deletes** the key rather than skipping it (§9.5). |

`resolveMinFee(perFile, companyDefault)` is the three-step chain every other fee in this system
uses — per-file → company → $2,500 — and it is a function rather than a `||` chain for one reason:
**an explicit 0 is honoured**, because it is a real decision (an approved exception waiving the
minimum outright) and `0 || next` would silently un-waive an approved waiver. A value that is
blank, unreadable, negative or above the $25,000 ceiling is NOT a minimum and falls through.

### 9.3 What it actually changes — measured

At the 1.25% default the minimum is reached at a **$200,000** loan, so it binds below that and on
**nothing** above it. The owner's own example: a $100,000 loan pays $1,250 today and $2,500 with
the minimum — an effective 2.500%.

### 9.4 The investor-facing half (§4's two answers, as built)

**Blue Lake's tape.** Column BC is an origination FRACTION, so the tape now sends
`closingCosts.originationMinimum.effectivePct` when the floor bound and `q.origPct` otherwise —
the owner's *"send them a higher percentage, according to how much this is the real percentage for
$2,500."*

The byte-identical property on an unbound loan is a property of the EXPRESSION, not a test result:
`originationFor` returns `pct` **itself** when `applied` is false, never a re-derivation. Dividing
the ROUNDED dollars by the loan does not give the stated rate back — 1.25% of $200,001 rounds to
$2,500.01, and $2,500.01 / $200,001 is 0.0124999875 — so a tape reading a re-derived figure would
send 1.2499987…% where it has always sent exactly 1.25%, on every loan the minimum never touches.
That is a change to what an investor receives, dressed as a no-op. Found by section A3 of the pure
test before it shipped.

**Encompass field 454.** 454 and 388 are two attributes of the SAME `LoanOriginationFee` object
(`.borPaidAmount` DECIMAL_2 and `.percentage` DECIMAL_3), so 454 joined the **READ-ONLY** registry
as one more `pull()` — no write path, no new POST endpoint, the read-only gate untouched. The
switch is `reconcile.markNotApplicable`: a minimum-bound file marks the PERCENTAGE row not
applicable (with a reason naming 454) and compares the AMOUNT row; an ordinary loan does the
reverse. *"Not applicable is a status, not a silence"* — both rows still render with the server's
own sentence saying which governs.

Two things there look like tidiness and are not:

* `markNotApplicable` is **idempotent BY SKIPPING** a row already marked, so a fact that arrives on
  a second pass can never take effect. The reconcile therefore builds its facts ONCE and passes the
  same object to BOTH `compareAll` and `markNotApplicable`. The first cut ran the first pass with
  no facts, marked the amount row not-applicable, and blocked the second.
* The switch is guarded on `typeof facts.minOrigApplied === 'boolean'`, **not** on truthiness. An
  unreadable quote must leave the comparison exactly as it is today rather than silently switching
  which field an investor's file is judged against.

### 9.5 The owner's re-registration rule was NOT working, in two places

*"Any file, even if it's already in the system, by the next registration, it should follow the
rules of the new registration if it gets re-registered again. Shouldn't be locked in where the fee
was already locked in."*

**MEASURED before it was fixed:** a file registered with an approved waiver (a typed 0) and then
re-registered with the box cleared went on being priced at the waived fee. Two independent causes,
both required:

1. **`compact()` drops `''`,** so a blank box on the studio panel sent **nothing at all** — the
   payload key is therefore built OUTSIDE `compact()`:
   `...(f.tsMinOrigFee === '' ? { minOrigFee: '' } : f.tsMinOrigFee != null ? { minOrigFee: f.tsMinOrigFee } : {})`.
2. **`buildInputs` SKIPS a blank rather than deleting the key** — and `fileInputs` has already
   handed the base object the sticky value, so skipping leaves the stale amount standing. Hence
   `if (overrides.minOrigFee === '') delete out.minOrigFee;` beside its four siblings.

**AN OPEN FINDING, recorded rather than swept up, and its membership was MEASURED rather than
remembered** (the first version of this note got it wrong in both directions). Five keys sit inside
`compact()` while carrying (a) an explicit-blank `delete` in `buildInputs` and (b) a STICKY
per-file column for that blank to clear: **`feasibilityFee`, `underwritingFee`, `legalFee`,
`settlementFee`, `cemaFee`.** They have the same latent defect. `titleFee`, `lenderFee`,
`creditFee` and `appraisalFee` are **NOT** in that set and must not be added to it — they have no
per-file column at all, so a blank box already resolves to the company default and there is nothing
stale for it to clear. Widening the contract to the five would change how live files re-register
(blanks would start clearing stickies that currently survive), so it is **its own audited pass and
its own owner call**, not a drive-by.

### 9.6 The corrections made along the way, each of which would have shipped a defect

* **DEFAULTED, not ENGAGED.** The override key was planned as ENGAGED and is DEFAULTED, decided by
  reading the actual approval and normalization code: DEFAULTED keys have a company default, get
  the `normalizeCompanyDefaultKnobs` blanking, and `revenueUp: true` means charging MORE needs no
  approval — only a discount does. The reason is written into the registry entry.
* **The derivation row was TRUNCATED in the real PDF** — the value column allows two lines and then
  clips, so it printed `…charged $2,500.00 (3.472% eff`. Found by the new render harness, not by
  reading; fixed with three short `sub` rows. A source test cannot see this.
* **A pre-existing live bug found in passing:** `StaffCompanyPricing.jsx` printed
  `${fmtMoney(lf.underwriting)} + …` as literal text — `fmtMoney` was never defined in that file.
* **A tenth surface** was found by grep after the nine were done: `src/lib/file-overview.js` printed
  `1.25% · $2,500.00`, two figures that disagree. It now reads `originationMinimum`.
* **Two stale guards were RE-POINTED, never loosened** — the fee-roster's five origination tokens
  and `test-encompass-refinance-fields-pure` F1 (whose registry-shape assertion named the old field
  count), with F1b added for the new row.

### 9.7 What is deliberately NOT built

* **No sweep of the open book.** The owner's own call: *"no mass registration right now."* Both
  columns stay NULL on every existing row, so no loan already on the book has its cash to close or
  its liquidity requirement moved by this deploy — which would reopen Products & Pricing and
  un-sign live term sheets across the whole open book at once. A live file picks the minimum up on
  its **next registration**, which is exactly what was asked for.
* **No TPO-specific minimum.** The minimum applies to OUR fee only, never the broker's own fee on
  wholesale files (owner-confirmed: *"This is correct"*). There is no `tpo_pricing_settings` column
  and no per-firm knob.
* **No CEMA-style tax interaction, no engine number, no V1 change.** `/v1` is parked and registers
  no files.

### 9.8 The proof

| Suite | Checks | What it holds |
| --- | --- | --- |
| `test-min-origination-pure` | 58 | the rule, every boundary, the wording, the no-loan case, the `effectivePct` identity |
| `test-min-origination-db` | 41 | the migration against a REAL Postgres, the three-step chain, the cascade into cash to close and liquidity, the re-registration rule, the exception reason on every route, and (section G) the Encompass switch end to end |
| `render-min-origination` | 33 | the REAL browser export — the row label, the sub-line, and the derivation page not clipping |
| `test-tape-bluelake-pure` | 88 | the bound case plus a byte-identical control |
| `test-encompass-refinance-fields-pure` | 94 | the registry shape, re-pointed |

**22 mutations (M1–M22) were each proven to fail, with a green unmutated control either side.**
A 42-suite sweep across pricing, tapes, Encompass, exceptions and registration: **0 failing.**

One method note worth keeping: **a `require.cache` swap cannot neutralize a module captured by a
top-level `require`** — measured (cache swap: the fee stayed $2,500; property replacement on the
exports object: $900). The mutation harness replaces `M.originationFor` on the exports object, and
the test records why.

### 9.9 The wording that shipped (§6's answer, as built)

The row label becomes **"Origination fee (minimum applied)"** on an itemising surface and
**"— minimum applied"** where the row already says "Origination fee". The sub-line is:

> *This loan's origination fee is our $2,500.00 program minimum, which is more than 1.25% of the
> loan amount ($1,250.00).*

Three things this wording never does, and they are enforced by the one definition: it never calls
the floor a **penalty** (it is a minimum on a fee, exactly as the 3-month minimum earned interest
is never a "prepayment penalty"); it never names a note buyer or capital partner; and the
**borrower-facing row never states an effective percentage** — two percentages on one line invites
*"so which rate am I being charged?"*, so the effective figure lives on the derivation page and the
staff panel, where the reader is an underwriter. **Nothing prints at all when the minimum does not
bind** — a note that appears on every file teaches people to stop reading notes, so every surface
is byte-identical to today on a loan at or above the crossover.
