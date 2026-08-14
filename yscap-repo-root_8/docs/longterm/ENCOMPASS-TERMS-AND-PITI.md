# Terms, PITI and the DSCR — measured, not remembered

**Long-Term (LT). Every number below was recomputed from all 772 loans in the live
tenant (490 long-term) on 2026-08-14. Read-only.**
Behind `src/longterm/encompass/terms.js`; browsable as
`research-exports/05-term-structures.csv` and `06-piti-components.csv`.

This is the chain that decides everything else on a long-term file:

> **the term structure decides the payment → the payment is the biggest part of the
> PITI → the PITI is the denominator of the DSCR → the DSCR is the whole product.**

Get the structure wrong and every number downstream is wrong.

---

## 1. The term structures that actually exist

The owner named the shapes he expects: *"10 years interest only and 40 year … 30
year term 10 year interest only … 20 year term … regular 30 year fix."* Here is the
book.

| Structure | Program | Term | Interest-only | Then amortizes over | Loans |
|---|---|---:|---:|---:|---:|
| **30-year fixed** | Investor DSCR 30 YEAR FRM | 360 | — | 360 | **444** |
| 30-year term, 10 years I/O | DSCR I/O 30 Year FRM | 360 | 120 | 240 | 26 |
| 40-year term, 10 years I/O | DSCR I/O 40 Year FRM | 480 | 120 | 360 | 3 |
| 40-year fixed | Investor DSCR 40 YEAR FRM | 480 | — | 480 | 2 |
| DSCR ARM | DSCR ARM | 360 | one file has 120, one none | — | 2 |
| 30-year fixed with a 12- or 24-month I/O | Investor DSCR 30 YEAR FRM | 360 | 12 or 24 | — | 10 |

**The ordinary 30-year fixed is nine out of every ten long-term files.** Everything
else is a rounding error by volume — which does not make it unimportant, but it does
mean the plain case must be effortless and the rest must be possible.

### Two shapes you named that the book does not contain

- **A 20-year term.** There is not one long-term loan at 240 months in the tenant —
  every single one is 360 or 480. Two readings, and it is worth one answer rather
  than a guess: either it is a product we have not written yet, or you mean the
  **240 amortizing months that follow the ten interest-only years** on the 30-year
  I/O program, which is exactly 20 years and is in the table above.
- **A 10-year term.** Nothing at 120 months either. **In this book 120 is always the
  interest-only PERIOD (field 1177), never the loan term (field 4).** Reading one as
  the other would size the payment on a ten-year loan instead of a thirty-year one.

### The ten files that need your eye

Ten files on the plain 30-year program carry a **12- or 24-month interest-only
period**. That is the short-term (bridge) pattern — on the Fix & Flip side field 1177
carries the whole term, because a bridge loan is interest-only end to end. So these
are either real short-I/O long-term deals, or values left behind on a file that
started life as a bridge. Until you say which, the code does not treat them as a
product.

---

## 2. Which fields carry it

| What | Field | Path | Filled on long-term |
|---|---|---|---:|
| Term, in **months** | `4` | `loan.loanAmortizationTermMonths` | 100% |
| Interest-only period, in **months** | `1177` | `loan.regulationZ.interestOnlyMonths` | 8.8% |
| Is it interest-only | `2982` | `loan.regulationZ.interestOnlyIndicator` | 8.8% |
| Amortization type | `608` | `loan.loanAmortizationType` | 100% |
| Note rate | `3` | `loan.requestedInterestRatePercent` | 86.9% |
| Loan amount | `1109` (and `2`) | `loan.borrowerRequestedLoanAmount` | 91.8% |
| Lien position | `420` | `loan.loanProductData.lienPriorityType` | 100% |
| Loan purpose | `19` | `loan.property.loanPurposeType` | 93.9% |

**Both `1177` and `2982` are blank on 91% of files, and a blank means "not
interest-only" — not "unknown".** Measured across all 490: the two are filled on
exactly the same 43 files, so they never disagree.

Note rate across the book: min 5.49%, 25th 6.75%, **median 7.00%**, 75th 7.50%, max
12.375%.

### Long-term is a refinance book

| Purpose | Loans |
|---|---:|
| Cash-Out Refinance | 284 |
| Purchase | 110 |
| No Cash-Out Refinance | 66 |
| (blank) | 30 |

**350 of the 460 that state a purpose are refinances** — the exact opposite of the
short-term side, which is 96% purchase. Anything built for this product should
assume a refinance and treat a purchase as the special case, not the reverse.

---

## 3. Two defects worth knowing about

**`DEFECT-AMORT-ARM` — both ARM files say "Fixed".** Field 608 records
`amortizationType = Fixed` on all 490 long-term loans, including the two on the
`DSCR ARM` program. Anything that reads field 608 to decide whether a rate can move
will conclude it cannot. On today's book that is two files, so the damage is small —
and it is structural, so it will not stay small. **Our rule: decide fixed-vs-adjustable
from the PROGRAM NAME, never from field 608.**

**`DEFECT-NO-ARM-FIELDS` — there is nowhere to put an ARM's terms.** No field in the
3,783-field census carries an ARM index, a margin, a first-adjustment cap, a periodic
cap or a lifetime cap with data on it. Encompass, as this tenant is configured, has no
home for the values that make an ARM an ARM. Our own model (`lt_loans`) carries all
eight, so an ARM can be described properly on our side regardless.

---

## 4. The PITI — and the one rule about it

**Field `912` (`loan.proposedHousingExpenseTotal`) is the whole monthly cost of
owning the property AFTER this loan closes.** "Proposed" means post-close, not what
the borrower pays today. Filled on 92.2% of long-term files.

It is made of seven components:

| Field | What | Filled on |
|---|---|---:|
| `228` | First mortgage P&I — the payment on this loan | 449 / 490 |
| `230` | Hazard insurance | 401 / 490 |
| `1405` | Real-estate taxes | 371 / 490 |
| `234` | Other housing expense | 18 / 490 |
| `233` | Association (HOA) dues | 17 / 490 |
| `URLA.X144` | Supplemental property insurance (flood, wind) | 12 / 490 |
| `229` | Other financing P&I — subordinate financing | 1 / 490 |

### READ THE TOTAL. NEVER REBUILD IT.

The seven components were summed independently on every long-term file and compared
with field 912: **they match to the cent on 414 of the 453 files that carry a total
(91.4%).**

On **38 of the 39 that do not match, the TAX LINE is blank** while the total plainly
contains taxes. The shortfall runs **$1,000 to $5,410 a month, median $1,328, and it
is positive every single time.** That shortfall is a monthly property-tax figure in
every case — so **field 912 is right and the tax line is simply empty.** Whoever built
the payment knew the taxes and never wrote them on their own line.

**The consequence, and it is the reason this rule exists:** rebuilding the housing
expense by adding the components up understates it on 8% of files by about $1,300 a
month — which **inflates the DSCR and makes a deal look better than it is.** Read the
total.

---

## 5. The DSCR

```
CUST01FV  =  Round( [1005] / [912] , 2 )
             gross monthly rent ÷ total proposed housing expense
```

**Verified: recomputed on every long-term file carrying rent, housing expense and a
stored ratio — 323 matched, 0 did not.** The formula is exact.

Field 1005 is **gross monthly market rent** — not annual, and not net of vacancy.

### What the book looks like

| DSCR | Loans |
|---|---:|
| under 1.00 | 8 |
| 1.00 – 1.09 | 70 |
| 1.10 – 1.24 | 49 |
| **1.25 – 1.49** | **103** |
| 1.50 – 1.99 | 73 |
| 2.00 and above | 21 |

Minimum 0.51, 25th percentile 1.10, **median 1.29**, 75th 1.53. The eight files under
1.00 — where the rent does not cover the payment — are real underwriting decisions,
not errors.

### The one file that stores a DSCR of 300,000

Rent 6,000 ÷ PITI **0.02**. The formula is right; the input is not — the housing
expense block was never built, so field 912 holds two cents. This is why
`computeDscr()` refuses a near-zero denominator rather than returning a number nobody
can use.

---

## 6. `CX.PITIA` — the evidence, and the one-line fix

> This section was rewritten on 2026-08-14 after the owner challenged the finding
> directly: *"I do believe it's correct… I cannot understand why you're claiming that
> it's wrong."* That was fair — the original write-up rested on field LABELS, which is
> not proof. It was re-tested four ways. Everything below is reproducible from the
> harvested loans.

The tenant has a custom field **Total PITIA (P&I + Taxes + Insurance + MI + HOA)**,
filled on **99.6% of long-term files**, calculated as:

```
Sum([#228], [#140], [#136], [#142], [#144])
```

### Proof 1 — the formula really is that sum

`Sum(228, 140, 136, 142, 144)` was computed from the live loan values and compared
with the **stored** `CX.PITIA`: **760 of 761 reproduce it to the cent.** So those
field ids are genuinely the ones being read, and Encompass is doing exactly what the
formula says. Nothing is being misread on our side.

### Proof 2 — the field meanings are ICE's, not our interpretation

Straight from the tenant's own `GET /encompass/v3/schemas/loan/standardFields`
(23,704 fields):

| | Encompass's own description | In the formula? |
|---|---|---|
| `228` | Expenses Proposed **Mtg Pymt** — P&I | ✅ correct ingredient |
| `140` | Trans Details **Subordinate Financing** | ❌ not a housing expense |
| `136` | Trans Details **Purchase Price** | ❌ not a housing expense |
| `142` | Trans Details **Cash From Borr** | ❌ not a housing expense |
| `144` | Income Borr/Co-Borr **Other Income 1** — a *String* field | ❌ not a housing expense |

**The same tenant confirms `136` independently:** its own `CX.RTLDOWNPAYMENT` formula
uses `VAL([136])` as the **purchase price** to work out a down payment.

### Proof 3 — what it produces is not a monthly payment

Of the 451 long-term loans carrying both `CX.PITIA` and field 912:

| | |
|---|---:|
| Within 2% of the real housing expense | **0** |
| Within 50% | 10 |
| **Negative** (a payment cannot be) | **297** |
| Over $50,000 a month | 120 |
| Plausible ($100 – $50,000) | 34 |
| **Median gap from field 912** | **$166,197.97** |

Which parts actually carry a value: `142` cash-from-borrower on **760** files, `136`
purchase price on **328**, `228` P&I on 662. `140` and `144` are empty on every file.
And it is never merely P&I — on all 662 files with a P&I, something else was added.

**A real file:** P&I `3,048.46` + purchase price `689,000.00` + cash from borrower
`219,940.44` = `CX.PITIA` **911,988.90**. That property's actual total monthly housing
expense is **3,478.46**.

### Proof 4 — the gap points the wrong way

If `CX.PITIA` were merely *missing* taxes and insurance, then `912 − CX.PITIA` would
be **positive** and look like a monthly tax bill (~$400). It is **negative, median
−$2,963** — the signature of one-time amounts being added into a monthly figure.

### The fix — the label's own five fields

The label names five things, and Encompass has all five in one block, **Expenses
Proposed**: `228` Mtg Pymt (P&I), `1405` Taxes, `230` Haz Ins, `232` Mtg Ins (MI),
`233` HOA. **Only the first id in the current formula comes from that block.**

```
Sum([#228], [#1405], [#230], [#232], [#233])
```

Computed on the same 451 loans and compared with field 912:

| Formula | Within 2% of the real expense | Median gap |
|---|---:|---:|
| As it is today `Sum(228,140,136,142,144)` | **0%** | $166,197.97 |
| The label's own fields `Sum(228,1405,230,232,233)` | **88%** | **$0.00** |

The remaining 12% are files where 912 legitimately carries something the label does
not name (`234` other housing, `229` other financing), or where the tax line is blank
— the same 38-file case in §4.

**Owner action:** one line, in Encompass → Settings → Loan Custom Fields → `CX.PITIA`.
Or retire the field and use `912`.

**Our rule either way: the long-term side never reads `CX.PITIA`. It reads field
912** — which is also what the DSCR ratio itself uses. Nothing we build depends on
`CX.PITIA` being fixed.

---

## 7. How to reach this from code

```js
const terms = require('src/longterm/encompass/terms');

terms.TERM_STRUCTURES              // the six that exist, with counts
terms.TERM_STRUCTURES_NOT_PRESENT  // the two you named that do not
terms.PITI                         // the seven components + the read-the-total rule
terms.DSCR_MEASURED                // the verification and the distribution
terms.KNOWN_TERM_DEFECTS           // the two above

terms.describeStructure(360, 120)
// → { termMonths: 360, interestOnlyMonths: 120, amortizingMonths: 240,
//     label: '30-year term, first 10-year interest-only', knownStructure: true }
```

`describeStructure` **describes rather than classifies**: a combination we have never
seen reads as itself and comes back `knownStructure: false`, never rounded into the
nearest known program.

Over HTTP, read-only: `GET /api/lt/encompass/terms` (add `?term=360&io=120` to
describe one).
