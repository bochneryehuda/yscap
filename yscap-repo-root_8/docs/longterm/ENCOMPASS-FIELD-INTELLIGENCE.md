# Encompass Field Intelligence — what the fields actually contain

**Long-Term (LT). Read-only research. Census taken 2026-08-14 against the live
YS Capital Group tenant (instance `BE11397907`).**

This document is the write-up behind `src/longterm/encompass/field-intelligence.js`
and `src/longterm/encompass/dictionary/field-dictionary.json`. Where the older
`completion-rules.js` says which fields a milestone *requires*, this says what those
fields — and about 3,700 more — actually *hold* on real loans.

---

## 1. How the census was taken

Nothing here is inferred from documentation. The method was:

1. **Read the tenant's own field definitions.** `GET /encompass/v3/schemas/loan/standardFields`
   returned **23,704** standard fields and `GET /encompass/v3/settings/loan/customFields`
   returned **856** custom fields — **24,560** definitions in total. Each carries a
   `description`, a `dataType`, a `format`, a `maxLength`, the enum `options` where the
   field is a dropdown, and — critically — a `jsonPath` and `contractPath`.

   > A trap worth recording: that schema endpoint keeps paginating past whatever limit
   > you set. A loop bounded at 20,000 stops early and silently, and you never learn
   > there were 3,704 more fields.

2. **Pull every loan whole.** `GET /encompass/v3/loans/{id}` for all **772** loans in the
   pipeline — not a sample. 490 DSCR (long-term), 251 Fix & Flip (short-term), 31 other.
   Zero failures.

3. **Resolve definitions against data.** Each definition's `jsonPath` was compiled into a
   resolver (including the filter forms, e.g.
   `$.customFields[?(@.fieldName == 'CX.PITIA')].value`) and evaluated against each loan.
   That connects a field *id* — which is what business rules and the fieldReader API
   speak — to a *value* in the loan JSON. **3,783 field ids carry data** somewhere.

4. **Verify against Encompass's own reader.** Spot-checked against `POST /fieldReader`
   so the path resolution is known to agree with what Encompass itself returns.

### Privacy

Identifying and high-cardinality fields are stored as `valuesWithheld` — no borrower
name, SSN, date of birth, email, phone or property address value is in the repo.
Enums, booleans, numeric ranges, date ranges and fill rates are kept for everything.
Verified: the committed dictionary contains no borrower name or address string from
the tenant.

---

## 2. What one dictionary entry tells you

| Key | Meaning |
|---|---|
| `id`, `kind`, `label` | what the field **is** |
| `declaredType` / `declaredFormat` | the type Encompass **declares** |
| `observedTypes` | the types actually **seen** in data |
| `allowedValues` | the enum, with display text |
| `contractPath` / `jsonPath` | where it lives in the loan JSON |
| `fill.dscrPct` / `fill.fixflipPct` | how often it is filled, **per product** |
| `populatedFrom` / `fillByStage` | the milestone it fills up at |
| `range` / `dateRange` / `observedValues` | the actual data |
| `calculated` / `calculation` | the tenant's own formula |
| `inLegacyCatalog` | whether our earlier 174-field catalog already knew it |

Declared type and observed type are not always the same, and the gap matters. The
three credit-score fields (`67`, `1450`, `1414`) are declared **String** and hold
integers. Anything that sorts or compares them as text will rank `95` above `700`.

---

## 3. The shape of a long-term file

Of 3,783 fields carrying data:

- **589** are filled on **95%+ of DSCR files** — the long-term backbone.
- **~1,100** are filled on 40%+ of DSCR files but under 5% of Fix & Flip files —
  genuinely long-term-specific.
- The rest are sparse, product-neutral, or belong to forms this tenant does not use.

**The 100%-filled core**, present on every single long-term loan:
`364` loan number · `1401` loan program · `1172` loan type · `4` term in months ·
`745` application date · `1811` occupancy · `1041` property type · `1487` occupancy
rate · `MS.STATUS` current milestone.

**Where the two products separate.** Sorting by the gap between DSCR fill and Fix &
Flip fill, the top differentiators are all the same story — a long-term loan is a
priced, locked, prepayment-protected 30-year instrument and a bridge loan is not:

| Field | Label | DSCR | Fix & Flip |
|---|---|---:|---:|
| `675` | Prepayment Penalty | 95.1% | 0% |
| `2963` | Lock Request Prepay Penalty | 94.9% | 0% |
| `432` | Rate Lock # Days | 92.4% | 0% |
| `1005` | Subject Property Gross Rent | 65.9% | 3.2% |
| `1041` | Property Type (Fannie Mae) | 100% | 17.5% |

And in the other direction, the fields that mean "this is a bridge loan, not ours":
`1177` interest-only months (100% Fix & Flip, 8.8% DSCR), `136` purchase price
(82.9% vs 22.7%), and the whole `CX.RTL*` rehab/reserve family.

**The shared core** — filled the same way on both — is the loan's skeleton: loan
number, program, type, term, purpose, application date, occupancy, borrower identity,
the proposed housing expense block, and the milestone tracking fields.

---

## 4. Stage of fill — when each field arrives

Because the 490 long-term loans are spread across 17 milestone stages, fill rate can
be measured *per stage*, which shows when a field comes alive. The distribution:

```
Purchasing Conditions 152   Started 96   Completion 84   Submittal 33   Loan Setup 30
Cond. Approval 21   Investor Delivery 16   Final Docs 14   LO Prep 14   Waiting for Docs 8
Docs Out 8   Funding 4   Resubmittal 3   Schedule Closing 2   Closed 2   Wire Order 2
Ready for Docs 1
```

Each dictionary entry carries `fillByStage`, and `populatedFrom` names the first stage
where the field crosses 50%. Broadly:

- **Started / LO Prep** — identity, property address, program, term, purpose.
- **Loan Setup / Submittal** — rent, the proposed housing expense block, the DSCR
  ratio, credit scores, LTV.
- **Cond. Approval → Docs Out** — appraised value, lock and prepayment terms, closing
  figures, the disclosure families.
- **Funding → Purchasing Conditions** — investor delivery, correspondent and purchase
  data.

This is the answer to *"at which step is it filled"*, and it is also the schedule a
Long-Term underwriting screen should follow — do not ask for a field before the stage
at which Encompass itself starts carrying it.

---

## 5. The DSCR ratio, decoded

The defining number of the product, and it is not stored the way you would guess.

```
CUST01FV  "DSCR"  DECIMAL_2  =  Round([1005] / [912], 2)
```

- **Numerator — field `1005`**, `loan.subjectPropertyGrossRentalIncomeAmount`:
  gross **monthly** market rent. Not annual, not net of vacancy. Filled on 65.9% of
  long-term files.
- **Denominator — field `912`**, `loan.proposedHousingExpenseTotal`: the **proposed**
  (post-close) total monthly housing expense — the true PITIA. Filled on 92.2%.

**Verified**: recomputing `1005 / 912` independently on every long-term loan carrying
both fields matched the stored `CUST01FV` on every one. Sample rows:

| Rent (1005) | PITIA (912) | Computed | Stored |
|---:|---:|---:|---:|
| 2,450.00 | 1,700.81 | 1.44 | 1.44 |
| 6,000.00 | 4,949.12 | 1.21 | 1.21 |
| 2,850.00 | 4,549.20 | 0.63 | 0.63 |
| 4,575.00 | 1,983.47 | 2.31 | 2.31 |

The stored field is blank on about a third of long-term files, which is why
`dscr.recomputeLocally` defaults to **true** in the settings registry: compute it
ourselves from 1005 and 912 and never let a stale custom field drive a decision.

### ⚠️ `CX.PITIA` is misconfigured — do not use it

The custom field *named* `Total PITIA (P&I + Taxes + Ins…)`, filled on **99.6%** of
long-term files, is defined as:

```
Sum([#228], [#140], [#136], [#142], [#144])
```

Only the first is a housing expense. Per Encompass's own field schema, `140` is
subordinate financing, `136` is the **purchase price**, `142` is **cash from
borrower** (usually negative) and `144` is a string income field.

**Proven four ways, not inferred from the labels** — the formula reproduces the stored
value on **760 of 761** loans, so those ids really are what is read; **0 of 451**
long-term files land within 2% of the real housing expense (median gap
**$166,197.97**); **297 are negative** and 120 exceed $50,000 a month; and the gap
points the wrong way for a field that were merely *missing* taxes. One real file:
P&I 3,048.46 + purchase price 689,000.00 + cash from borrower 219,940.44 =
**911,988.90**, against an actual monthly housing expense of **3,478.46**.

**The fix is one line** — the five fields the label already names, all from the
*Expenses Proposed* block: `Sum([#228], [#1405], [#230], [#232], [#233])`. Tested on
the same 451 loans: **88% land within 2% of field 912, median gap $0.00.**

Long-Term never reads `CX.PITIA`; it reads `912`. Full evidence in
`ENCOMPASS-TERMS-AND-PITI.md` §6. Changing it is an Encompass-side action — we are
read-only.

---

## 6. Other decoded formulas

52 of the 856 custom fields are calculated, and the formulas are the closest thing to
written-down underwriting policy in the system. Full decode in
`src/longterm/encompass/formulas.js`. The ones that matter for long-term:

- **Qualifying credit score.** `CX.PAIR{1..6}.BORROWER.FICO` implements
  *middle-of-three, lower-of-two*: median when all three bureaus report, minimum of
  the two that did when one is blank. `CX.PAIRS16` then takes the **minimum across
  all six pairs** — the file qualifies on its weakest borrower.
- **Max loan by LTV.** `CX.DSCRLOANAMOUNT` applies the LTV to the **purchase price**
  on a purchase and to the **appraised value** on a refinance. That purchase-vs-
  refinance value basis is now the `property.valueBasisByPurpose` setting.
- **Housing history.** `CX.YEARS.AT.RESIDENCE` sums years + months at the current
  address and falls back to prior addresses — the standard two-year test.
- **Change detection.** `CX.UC.CHANGES` and `CX.CDC.CHANGES` snapshot loan amount,
  rate, term, type and purpose and flag drift. A good model for our own
  re-underwrite trigger.

---

## 7. What is still missing

- **69 of the 91 Milestone Completion rules** remain uncaptured. They are not exposed
  through the API — `GET /encompass/v3/settings/businessRules/milestoneCompletion`
  returns **403** for our client. See `ENCOMPASS-ACCESS-AND-PERSONA.md`.
- **Loan program definitions.** `GET /encompass/v3/settings/loan/programs` is also
  403, so the program taxonomy in `dictionary/program-taxonomy.json` was derived from
  loan data rather than from the program setup itself.
- **Conditions are thin on the ground** — only 12 loans carry any, because most
  long-term files are underwritten by the investor rather than in Encompass. Those 12
  are the whole evidence base for the Condition Center.
