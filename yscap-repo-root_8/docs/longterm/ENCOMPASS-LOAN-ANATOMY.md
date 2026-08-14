# Anatomy of an Encompass loan file

**Long-Term (LT). Measured against all 772 loans in the live tenant, 2026-08-14.
Read-only.** Companion to `src/longterm/encompass/loan-anatomy.js`.

Everything below is an observation with a count behind it. Where a statement is an
inference rather than a measurement, it says so.

---

## 1. Three addressing systems, and why you need all three

The same piece of data has three different names, and mixing them up is the most
common way to get lost:

| System | Example | Who speaks it |
|---|---|---|
| **Field ID** | `1005`, `CX.PITIA`, `URLA.X73` | Encompass Desktop, business rules, calculations, `POST /fieldReader` |
| **JSON path** | `$.subjectPropertyGrossRentalIncomeAmount` | `GET /encompass/v3/loans/{id}` |
| **Contract path** | `loan.subjectPropertyGrossRentalIncomeAmount` | the SDK |

`GET /encompass/v3/schemas/loan/standardFields` returns all three per field. That
mapping is what lets a rule written in field ids be evaluated against a loan JSON —
and it is how the field dictionary was built.

**Multi-instance notation.** In a rule or formula, `[67#2]` means *field 67 on
borrower pair 2*. **1,070** of the tenant's standard fields are multi-instance. A
field id on its own is therefore not a complete address on any file with more than one
borrower pair.

---

## 2. The loan root

Every loan returns **173 top-level keys**. The ones that carry the file:

- `id` — the loan GUID. The only durable handle; every API path takes it.
- `loanNumber` — field `364`, e.g. `YSCAP258134846`. The human key.
- `applications[]` — **the borrower pairs**. See below.
- `borrowerPairCount`, `currentApplicationIndex` — how many pairs, and which one the
  `currentApplication` shortcuts resolve to.
- `customFields[]` — the tenant's own fields, as `{ fieldName, value, format }`.
- `milestones[]` plus `milestoneCurrentName` / `milestoneNextName` / `milestoneStage`.
- `property`, `contacts`, `loanProductData`, `regulationZ`, `closingCost`, `hmda`,
  `correspondent`.

---

## 3. Borrower pairs — the part most systems get wrong

`loan.applications[]` is an **array of borrower PAIRS**. Each entry holds **one
borrower and one optional co-borrower**.

Observed across the tenant:

| Pairs on the file | Loans |
|---|---:|
| 1 | 737 |
| 2 | 31 |
| 3 | 4 |

But the tenant is *configured* for **six**: it defines `CX.PAIR1…CX.PAIR6` borrower
and co-borrower FICO fields, and `CX.PAIRS16` takes the minimum across all six.

> **Design consequence.** Carry borrowers as an ordered **list of pairs**, not as
> fixed `borrower` / `coborrower` columns. A two-column model cannot represent pair 2,
> and four of the tenant's live files already have three pairs. The
> `borrowerPairs.maxPairs` setting defaults to 6.

Each pair carries: `id`, `borrowerPairId` (which the eFolder also uses, as
`_borrower1`, `_borrower2`…), `borrower`, `coborrower`, `propertyUsageType`,
`reoProperties`, and pair-level asset/payment totals.

### Credit scores

| | Experian | TransUnion | Equifax |
|---|---|---|---|
| Borrower | `67` | `1450` | `1414` |
| Co-borrower | `60` | `1452` | `1415` |

Filled on ~55% of long-term files; co-borrower scores on only ~3%, because most
long-term files are single-borrower entities. **All six are declared `String` in the
schema despite holding integers** — compare them numerically or `95` sorts above
`700`.

### Primary residence — own or rent, and for how long

`borrower.residences[]`. Each entry has a `residencyType` (`Current` | `Prior`) and a
`residencyBasisType` (`Rent` | `Own` | `NoPrimaryHousingExpense`). Observed:

```
Current/Rent 386   Current/Own 186   Current/NoPrimaryHousingExpense 70
Prior/NoPrimaryHousingExpense 32   Prior/Rent 29   Prior/Own 15
```

`Prior/*` rows appear when the current address is under two years old. Duration lives
in the residence entry (years + months), and the tenant rolls it up into
`CX.YEARS.AT.RESIDENCE`.

### Employment — mostly absent, by design

`URLA.X199` ("Borrower Current Employment Does Not Apply") is **true on 98% of
long-term files**. DSCR qualifies on the property's cash flow, not the borrower's
income, so the employment and income blocks are deliberately empty. A long-term
underwriting screen should not ask for them.

---

## 4. Subject property

| What | Field | Long-term fill |
|---|---|---:|
| Street / City / County / State / Zip | `11` / `12` / `13` / `14` / `15` | high |
| Units | `16` (`property.financedNumberOfUnits`) | 91.8% |
| **Property type (authoritative)** | `1041` (`loanProductData.gsePropertyType`) | **100%** |
| Property type (secondary) | `1553` (`tsum.propertyType`) | 54.3% |
| Occupancy | `1811` | 100% — `Investor` on 456 of 457 |
| Occupancy rate | `1487` | 100% |
| Appraised value | `356` | 74.5% |
| Estimated value | `1821` | 69.6% |
| Purchase price | `136` | 22.7% (82.9% on Fix & Flip) |
| Gross monthly rent | `1005` | 65.9% |
| LTV | `353` (`loan.ltv`) | 90.2% |

Use `1041` for property type. `1553` exists, disagrees, and is filled about half as
often. Value priority is `356` → `1821` → `136`, which is the
`property.valueFieldPriority` setting.

---

## 5. Terms, and how interest-only really works

| What | Field | Note |
|---|---|---|
| Loan amount | `1109` (and `2`, same value) | 91.8% |
| Interest rate | `3` | `DECIMAL_3` |
| Term in months | `4` | **100% on every program** |
| Amortization type | `608` | `Fixed` across the whole tenant today |
| Loan type | `1172` | `Conventional` across the board |
| Loan purpose | `19` | DSCR skews cash-out refi; Fix & Flip is 96% purchase |
| Interest-only indicator | `2982` (also `Terms.IntrOnly`, `HMDA.X109`) | Boolean |
| **Interest-only months** | `1177` (`regulationZ.interestOnlyMonths`) | the number that matters |

**The interest-only story, measured per program:**

| Program | Loans | Term | IO? | IO months |
|---|---:|---:|---|---:|
| Investor DSCR 30 YEAR FRM | 457 | 360 | no (444 of 457) | — |
| DSCR I/O 30 Year FRM | 26 | 360 | yes | **120** |
| DSCR I/O 40 Year FRM | 3 | 480 | yes | **120** |
| Investor DSCR 40 YEAR FRM | 2 | 480 | no | — |
| DSCR ARM | 2 | 360 | mixed | 120 |
| Fix & Flip Purchase + reno | 251 | **12** (some 18/24) | **always** | 12 or 24 |

So: a DSCR I/O loan is **10 years interest-only**, then amortising over the remaining
240 or 360 months. A Fix & Flip loan is interest-only for its **entire** 12-month
term — which is simply what a bridge loan is. That difference in `1177` is the
cleanest machine-readable separator between the two products after the program name.

**Anomaly worth a look:** 13 plain `Investor DSCR 30 YEAR FRM` files carry an IO flag —
7 with 12 months, 3 with 24, 3 with 120. The 12/24 values look like Fix & Flip numbers
entered on a long-term file.

---

## 6. Housing expense — the PITIA block

| What | Field | Fill |
|---|---|---:|
| **Proposed total housing expense (the real PITIA)** | **`912`** | 92.2% |
| First mortgage P&I | `228` | 91.6% |
| HOA dues | `233` | 3.7% |
| Mortgage insurance | `232` | 0% — DSCR carries no MI |

`912` is both the true PITIA and the denominator of the DSCR ratio.

**Do not use `CX.PITIA`.** Despite its name it is misconfigured and returns values
like −310,736. Full detail in `ENCOMPASS-FIELD-INTELLIGENCE.md` §5.

---

## 7. Milestones

19 active milestones, in order:

```
Started → LO Prep → Loan Setup → Submittal → Cond. Approval → Processing →
Waiting for Docs → Resubmittal → Clear To Close → Schedule Closing → Ready for Docs →
Docs Out → Wire Order → Funding → Investor Delivery → Purchasing Conditions →
Final Docs → Closed → Completion
```

On the loan: `milestoneCurrentName`, `milestoneNextName`, `milestoneStage`, and
`milestones[]` — each with `name`, `doneIndicator`, `startDate`, `duration` and
`loanAssociate` (who owns that step).

As field ids: `MS.STATUS` (current milestone name, **100% filled**), `MS.STATUSDATE`,
`MS.START`, `MS.SUB`, `MS.PROC`, `MS.FUN`, `MS.CLO`, plus the `.DUE` variants.

> **Gotcha.** The pipeline column `Loan.CurrentMilestone` is **blank for every loan**
> in this tenant. Read the milestone from the loan body or from `MS.STATUS`.
> `milestoneLogs` — who moved it and when — is currently 403 for our client.
