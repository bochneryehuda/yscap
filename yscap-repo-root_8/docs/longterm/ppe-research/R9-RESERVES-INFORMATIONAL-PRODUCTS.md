# R9 — Reserve requirements, informational product attributes, and the delegate exception product

**Research-engine output (owner directives D26 + D34, 2026-08-17). Build blueprint — read-only research + design; no code was changed.**

LT-only. Everything here lives under `src/longterm/**`. It reads the Deephaven DSCR matrix
(`docs/longterm/ppe-research/matrices/deephaven-dscr-matrix.json` + `LP-DSCR-ELIGIBILITY-MATRIX.md`)
and the already-built Layer-2 engine (`src/longterm/ppe/deephaven-matrix.js`,
`program-deephaven-dscr.js`). It touches NO RTL code.

---

## 0. The problem, in one paragraph

Today the program answers exactly one question: **is this loan eligible?** (`evaluateProgram(facts) →
{eligible, reasons, maxLtvMilli, ppp, unverifiable}`, in `program-deephaven-dscr.js`). It says nothing
about what a chosen-and-eligible product *carries*: how many months of reserves the borrower must show,
whether a second appraisal is triggered, that a small loan is delegate-channel-only, or the cash-out
reserve rule. Those are **INFORMATIONAL** — notes/conditions attached to the product, not disqualifiers
(D26). And one class of them (delegate-only availability, D34) is a special kind of informational
attribute: the product is *always* offered but flagged loudly as needing a super-admin exception.

The existing engine already has the exact hooks for this. `deephaven-matrix.js` collects declines into
`reasons[]` **and** already surfaces two seeds of informational data: `maxLtvMilli` (a computed value,
not a decline) and `unverifiable[]` (overlays we cannot yet enforce, flagged not guessed — including the
delegate-only note at line 170). This blueprint adds a third, first-class output array —
`informational[]` — built the same pure, fact-driven, fail-safe way.

---

## PART A — the catalog of informational attributes (mined from the matrix, with exact numbers)

Every row below is a note the product CARRIES; none disqualifies. Provenance: `[JSON]` = a literal in
`deephaven-dscr-matrix.json`; `[MD]` = `LP-DSCR-ELIGIBILITY-MATRIX.md`; `[RC]` = `RULE-CATALOG-AND-BUILDER.md`
(the line-by-line sheet read). Where the JSON does not carry a number and only `[RC]` does, that is
flagged so a human confirms it against the source sheet before it drives a condition.

### A1. Reserves (`kind:'reserve'`, `severity:'info'`) — the headline attribute

`[JSON]` `"reserves": "3 Months PITIA (loan <= $1mm); 6 Months PITIA (loan > $1mm)"` (line 44).
`[MD]` "3 mo PITIA (loan ≤ $1mm); 6 mo PITIA (loan > $1mm)" (line 81). `[RC §10.1]` adds two overlay
bumps to **6 months**: DSCR < 1.00, and Foreign National.

| Rule that triggers it | Reserve required | Fact(s) | Status |
|---|---|---|---|
| Loan ≤ **$1,000,000** | **3 months** PITIA | `loan_amount` | encodable now |
| Loan > **$1,000,000** | **6 months** PITIA | `loan_amount` | encodable now |
| DSCR < **1.00×** (any loan size) | **6 months** PITIA (bump) | `dscr` | encodable now `[RC §10.1]` |
| Foreign National | **6 months** PITIA (bump) | `foreign_national` | deferred (needs fact) |

The *reserve requirement must be computable for a scenario*, not a static note. The months come from the
table above; the **monthly PITIA** comes from the priced LP option (`parseFull` → `option.monthlyPayment`
in `client.js`, or `parse` → `rung.monthly`). So:

```
reserveAmountDollars = reserveMonths × monthlyPitia
```

`reserveMonths` is deterministic from `{loan_amount, dscr}` (+ FN later). `monthlyPitia` rides on the
priced product, so a **reserve dollar figure is available per (scenario × chosen product)** and recomputes
when the borrower changes the loan.

### A2. Cash-out reserve rule (`kind:'reserve'`, `severity:'info'`)

`[JSON]` `"maxCashOutAmount": "$1,000,000 (overlays apply); cash-out may be used towards reserves"`
(line 45). A cash-out loan carries a note: **the cash-out proceeds may be applied toward the reserve
requirement.** Trigger: `purpose === 'cashout'`. No number of its own — it modifies how A1 is *satisfied*,
not how much is required. Worth surfacing because it changes the borrower's cash-to-close story.

### A3. Second (full) appraisal trigger (`kind:'appraisal'`, `severity:'info'`)

`[RC §10.2 / R53]`: **Full 2nd appraisal required when loan > $2,000,000, OR when Cash-Out and loan >
$1,500,000.** This is the "this project needs a second appraisal" example from D26.

| Rule that triggers it | Threshold | Fact(s) |
|---|---|---|
| Large loan | loan > **$2,000,000** | `loan_amount` |
| Large cash-out | `purpose === 'cashout'` AND loan > **$1,500,000** | `loan_amount`, `purpose` |

> **Provenance flag:** the second-appraisal thresholds are NOT literals in `deephaven-dscr-matrix.json`;
> they come from the rule-mining read (`[RC §10.2]`). Confirm against the DSCR sheet source
> (`matrices/corr-flow-all-sheets-raw.txt`) before this note drives a hard condition. Until confirmed,
> ship it as `severity:'info'` (a heads-up), never as a blocker.

### A4. Small-loan LTV note + the delegate-only note (`kind:'condition'` / `kind:'exception'`)

`[JSON]` `"smallLoan": "Loan < $125,000: Max LTV reduced to 75%; Loan < $100k delegated delivery only"`
(line 50). Two distinct attributes from one sheet line:

- **A4a — small-loan LTV cut.** Loan < **$125,000** → max LTV **75%**. This is already ENFORCED as a
  bound/cut in `deephaven-matrix.js` (`dhvn_small_loan_ltv`, `SMALL_LOAN_CAP_MILLI = 75000`). As an
  informational attribute it is the *note* that explains the cut ("this loan is under $125k, so its LTV
  is capped at 75%") — `severity:'info'`, `kind:'condition'`.
- **A4b — the delegate exception (D34's concrete example).** Loan < **$100,000** → **delegated delivery
  only**. This is the D34 product: eligible/available always, but flagged loudly as delegate-channel-only
  needing a super-admin exception. `kind:'exception'`, `severity:'exception'`. Today it sits inert in
  `deephaven-matrix.js` `unverifiable[]` (line 170) as "advisory, not a decline" — this blueprint promotes
  it to a first-class exception attribute. See Part D.

### A5. Minimum-DSCR notes (`kind:'condition'`, `severity:'info'`)

- `[JSON]` `"dscrLt1Floor": "Minimum DSCR 0.75x"` (line 49). Below 0.75 is a DECLINE (already
  `dhvn_min_dscr`); *at* 0.75–0.99 the product carries the note "DSCR below 1.00 — 6-month reserves and
  the lower-band LTV grid apply" (ties A1 + the `_lt1` grid columns together for the officer).
- `[JSON]` `"interestOnly": "Max LTV 80%; Min DSCR 1.00x"` (line 46). An interest-only product carries the
  note "Interest-Only: min DSCR 1.00×, max LTV 80%." (Enforcement already exists — `dhvn_io_min_dscr`,
  `dhvn_io_max_ltv`; this is the explanatory note.)
- `[JSON]` `"firstTimeInvestor": "Min DSCR 1.00, Min FICO 700, Long-Term Rental Only"` (line 51) —
  informational until the `first_time_investor` fact exists.

### A6. Large-loan / high-leverage conditions (`kind:'condition'`, `severity:'info'`)

- **Cash-out amount caps** `[JSON]` (lines 45, 68–69): max cash-out **$1,000,000** at LTV ≤ 65%;
  **$500,000** at LTV > 65%. Over these = a DECLINE (already `dhvn_cashout_le65` / `dhvn_cashout_gt65`);
  *approaching* them is a note worth showing ("cash-out is capped at $500k above 65% LTV").
- **Foreign National max loan** `[JSON]` (line 37): **$1,500,000**. Informational until the FN fact exists.
- **Seller concessions** `[JSON]` (line 55): up to **6%** toward closing. A carry-note.
- **Prepayment penalty** `[JSON]` (line 56): "5yr (5/4/3/2/1) or 4yr (5/4/3/2) stepdown." A carry-note;
  the *state eligibility* of a PPP is already Layer 3 (`deephaven-ppp-matrix.js`).

### A7. Property/geo carry-notes (`kind:'condition'`, mostly deferred)

STR ("Property Guard report required; Min DSCR 1.15×; 5% LTV reduction; Min FICO 720") `[JSON]` line 43;
Philadelphia −10% LTV `[JSON]` line 57; declining markets −5% `[JSON]` line 54; ineligible geos (HI lava
zones 1&2, Baltimore City MD) `[JSON]` line 58. All already listed in `deephaven-matrix.js`
`unverifiable[]` — they become informational notes the moment their fact is wired, with **zero new code**
(see Part B: the informational engine reads the same `unverifiable[]` seed).

**Catalog summary:** the two that are *computable and shippable today* off facts we already carry are
**reserves (A1/A2)** and **second appraisal (A3)**, plus the **delegate exception (A4b)** and the
small-loan / min-DSCR / cash-out explanatory notes (A4a, A5, A6). Everything else is a note that lights up
as its fact arrives.

---

## PART B — the data model for an informational attribute

One shape, mirroring the rule shape `rules.js` already evaluates and `rule-store.js` persists — so an
informational attribute composes with the existing predicate vocabulary and needs no new evaluator.

```jsonc
// src/longterm/ppe/informational.js  (NEW, pure — no DB, no network, no clock, no RTL imports)
{
  code: 'dhvn_reserves',                         // stable id
  kind: 'reserve' | 'appraisal' | 'exception' | 'condition',
  severity: 'info' | 'exception',                // 'exception' renders LOUDLY (D34)
  when: <predicate>,                             // SAME tree rules.evalPredicate() evaluates, or null (always)
  message: (facts, ctx) => string,               // plain-language note; ctx carries the priced product
  citation: 'Deephaven Corr Flow DSCR matrix, eff 08/04/26 — …',
  compute?: (facts, ctx) => object,              // reserve → { months, monthlyPitia, amountDollars }
  meta?: object                                  // exception → { channel, requiresException, superAdminOnly }
}
```

### B1. How `when` composes with the existing predicate vocabulary

The `when` field is **byte-identical in shape** to a `rules.js` rule's `when` — the tree the existing pure
evaluator already understands:

```js
const { evalPredicate } = require('./rules');   // already exported; pure
// tree: { all|any|none|not: [...] }, leaf: { fact, op, value }, ops: eq neq in nin lt lte gt gte between exists
```

This buys three guarantees for free, all already true of `rules.js`:

1. **Half-open `[min,max)` bands** — the reserve tier boundary at exactly $1,000,000 lands in exactly one
   band, never two (the boundary-bug defense the whole engine is built on).
2. **Fail-safe on a missing fact** — `evalPredicate` returns `false` and records the fact in `unknown`.
   So a deferred attribute (FN reserves, STR) sits **inert** until its fact arrives — an informational note
   is never invented from data we do not have, exactly like a decline is never invented.
3. **The same fact vocabulary** — `lp-agreement-legs.lpScenarioToFacts` emits `{fico, ltv, dscr,
   loan_amount, cashout_amount, purpose, property_type, units, state, interest_only}` (all milli/raw units
   documented at the top of `deephaven-matrix.js`). An informational attribute reads those and nothing new.

### B2. The attribute definitions (real numbers wired to real facts)

```jsonc
// reserves — computable per scenario × product
{ code:'dhvn_reserves', kind:'reserve', severity:'info',
  when: null,                                    // always applies (every loan has a reserve requirement)
  compute: (f, ctx) => {
    const months = (f.dscr < 1000 ? 6 : (f.loan_amount > 1000000 ? 6 : 3));   // A1
    const monthlyPitia = ctx.monthlyPitia ?? null;                            // from the priced LP option
    return { months, monthlyPitia, amountDollars: monthlyPitia == null ? null : months * monthlyPitia };
  },
  message: (f, ctx) => `${f.dscr<1000?6:(f.loan_amount>1000000?6:3)} months PITIA reserves required` }

// cash-out reserve rule
{ code:'dhvn_reserves_cashout', kind:'reserve', severity:'info',
  when: { all:[{ fact:'purpose', op:'eq', value:'cashout' }] },
  message:()=>'Cash-out proceeds may be applied toward the reserve requirement.' }

// second appraisal (A3) — provenance-flagged
{ code:'dhvn_second_appraisal', kind:'appraisal', severity:'info',
  when: { any:[
    { fact:'loan_amount', op:'gt', value:2000000 },
    { all:[{ fact:'purpose', op:'eq', value:'cashout' }, { fact:'loan_amount', op:'gt', value:1500000 }] },
  ]},
  message:(f)=> f.loan_amount>2000000
      ? 'Full second appraisal required (loan over $2,000,000).'
      : 'Full second appraisal required (cash-out over $1,500,000).' }

// small-loan LTV note (A4a) — explains the already-enforced cut
{ code:'dhvn_small_loan_note', kind:'condition', severity:'info',
  when: { all:[{ fact:'loan_amount', op:'lt', value:125000 }] },
  message:()=>'Loan under $125,000 — max LTV reduced to 75%.' }

// DELEGATE EXCEPTION (A4b / D34) — see Part D
{ code:'dhvn_delegate_only', kind:'exception', severity:'exception',
  when: { all:[{ fact:'loan_amount', op:'lt', value:100000 }] },
  meta: { channel:'delegate', requiresException:true, superAdminOnly:true },
  message:()=>'Loan under $100,000 — DELEGATE CHANNEL ONLY. Available, but requires a super-admin exception.' }
```

### B3. Where it attaches (program descriptor → price response)

The informational engine slots in exactly where declines already flow — no new plumbing.

- **`deephaven-matrix.js`** gains one export, `evaluateInformational(facts, ctx)` (or a sibling module
  `informational.js` it re-exports), returning `informational[]`. It reuses the existing `unverifiable[]`
  seed for the deferred notes so the two never drift.
- **`program-deephaven-dscr.js`** `evaluateProgram(facts)` adds one line to its return object:
  `informational: evaluateInformational(facts, ctx)`. It already composes the eligibility + PPP layers;
  this is a third, non-blocking layer. `eligible` is UNCHANGED — informational attributes never touch it.
- **`program-deephaven-dscr.js`** `PROGRAM.layers` gains `informational: evaluateInformational` (dot 2b),
  so the descriptor names all its layers in one place.
- **`dscr-pricer.js`** carries it in the price response per chosen product (Part C).

```
scenario facts ──► evaluateProgram(facts)
                     ├─ eligibility_matrix  → reasons[]        (declines — unchanged)
                     ├─ ppp_matrix          → reasons[]        (declines — unchanged)
                     └─ informational       → informational[]  (NEW — notes, never declines)
                                               each attribute run through rules.evalPredicate(when, facts)
```

---

## PART C — the price response shape (per chosen product)

The `full` path in `dscr-pricer.js` (`price()` → `req.body.full` → `lp.parseFull`) is where per-product
data already lives. Each priced option carries `monthlyPayment` (→ `monthlyPitia`), `terms`, `fees`.
Attach the informational block per program so the reserve dollar figure is computed against THAT product's
PITIA:

```jsonc
// POST /api/lt/dscr/price  { full:true }  → programs[i] gains:
{
  lender, program, product, minRate, /* … existing … */
  informational: {
    reserves:   { months: 6, monthlyPitia: 3120.44, amountDollars: 18722.64, cashoutMayApply: false,
                  citation: '…reserves 6 mo (loan > $1mm)' },
    appraisal:  { secondAppraisalRequired: true, reason: 'loan over $2,000,000', provenance: 'rule-catalog §10.2 — confirm vs sheet' },
    conditions: [ { code:'dhvn_small_loan_note', message:'…', severity:'info' } ],
    exceptions: [ /* Part D — the LOUD one */ ],
  }
}
```

Design rules for the response, matching the transparency discipline already in `dscr-pricer.js`:

1. **Reserve is a computed object, not a string.** `{months, monthlyPitia, amountDollars}`. `monthlyPitia`
   is per-product (from `option.monthlyPayment`), so `amountDollars` is per (scenario × product) and
   recomputes on any change — the "computable for a scenario, not a static note" requirement.
2. **`amountDollars` is `null` when `monthlyPitia` is unknown**, never 0 — same fail-loud discipline as the
   rest of the connector (a 0 reserve would read as "no reserves required," which is wrong).
3. **The exception block is always present when it fires** and is structurally distinct from `conditions`
   so a UI can render it LOUDLY without string-matching (Part D).
4. **A scenario-level copy** (not per-product) rides at the top of the response for the attributes that do
   not depend on the priced product (reserves months, second-appraisal, delegate exception) — so a caller
   that used the light (`parse`) path still sees them. Per-product only adds the PITIA dollar figure.

---

## PART D — the delegate exception product model (D34)

D34: a delegate-only product is **eligible + available ALWAYS** (even on non-delegate channels), but
flagged as an EXCEPTION product — visible enough that it is obviously "not simple, needs a super-admin
exception." Concrete matrix example: **loan < $100,000 → delegated delivery only** (`[JSON]` line 50).

### D1. Representation

An informational attribute with `severity:'exception'`, `kind:'exception'`, carrying a structured `meta`:

```jsonc
{ code:'dhvn_delegate_only', kind:'exception', severity:'exception',
  when: { all:[{ fact:'loan_amount', op:'lt', value:100000 }] },
  meta: { channel:'delegate', requiresException:true, superAdminOnly:true },
  message:'Loan under $100,000 — DELEGATE CHANNEL ONLY. Available, but requires a super-admin exception.',
  citation:'Deephaven Corr Flow DSCR matrix — smallLoan: Loan < $100k delegated delivery only' }
```

### D2. "Available always but needs an exception" — how it is represented

- The product stays **ELIGIBLE**: the delegate attribute is `kind:'exception'`, NOT a `reasons[]` decline.
  It never touches `eligible`, so the product still prices and still appears in the board on every channel.
- It rides in the response's `informational.exceptions[]` — a separate array from `conditions[]` — so the
  distinction between "a note" and "a blocking-until-approved exception" is structural, never a severity
  string a screen has to parse.
- `meta.requiresException:true` + `meta.superAdminOnly:true` is the machine-readable "this is not simple."
  A UI renders a loud gold/amber banner + an "Available — needs super-admin exception" chip; a workflow can
  gate registration behind a super-admin approval keyed on `code` (mirroring the RTL
  `loan_exceptions`/super-admin-override pattern, but built fresh under `src/longterm/**` — nothing is
  copied from RTL).

### D3. Surfacing (loud enough)

- Response: `informational.exceptions[]` present ⇒ the product card shows the exception treatment.
- The top-level scenario copy also lists it, so a delegate exception is visible even before a product is
  chosen ("this loan is delegate-only whichever product you pick").
- Message copy leads with the loud clause (`DELEGATE CHANNEL ONLY`) so a plain-text surface (email, log)
  still reads as an exception.
- `severity:'exception'` is the one value that means "render LOUDLY" — every `kind:'exception'` attribute
  carries it, and the informational engine refuses to emit `severity:'exception'` on a non-exception kind
  (a test guards this) so the two can never disagree.

### D4. The "advanced section" (D34, second half)

All Job-1 deferred / new-fact gaps (`RULE-CATALOG` "Job-1 gap priority": rural, vacant/unleased, FN grid
row, subordinate-financing fact, STR/FTI/FTHB/declining/Philly/geo, `<$100k delegated-only` as a channel
fact, the L1↔L2 divergences, unmeasured LLPAs) are already enumerated in `deephaven-matrix.js`
`unverifiable[]`. The informational engine reads that same array and emits each as a
`kind:'condition', severity:'info', deferred:true` note, tagged `section:'advanced'`. So the advanced
section is **generated from the one source of truth**, never a hand-kept list — add a fact, the note
promotes itself from advanced/deferred to live with no new code.

---

## PART E — the ordered, incremental build plan

Each step is independently shippable and independently testable. Files are all under `src/longterm/**`.

**Step 1 — the pure informational engine.** New `src/longterm/ppe/informational.js`:
`evaluateInformational(facts, ctx)` → `{ reserves, appraisal, conditions[], exceptions[], deferred[] }`.
Reuses `require('./rules').evalPredicate` for every `when`. Pure; no DB/network/clock; no RTL imports.
Encodes A1–A6 + D1 with the exact numbers above. Reads `deephaven-matrix.js` `unverifiable[]` for the
deferred/advanced notes.
- **Test** `scripts/test-lt-informational-pure.js`: reserves 3-vs-6 at the $1M boundary (both sides,
  half-open); DSCR<1.00 forces 6; second-appraisal at $2M and cash-out>$1.5M (and the negatives just under
  each); delegate exception fires <$100k and is `severity:'exception'`; a missing fact yields no note
  (fail-safe); `severity:'exception'` never appears on a non-exception kind.

**Step 2 — reserve dollar computation from the priced product.** In `informational.js`, `compute` reads
`ctx.monthlyPitia`; `dscr-pricer.js` passes `monthlyPitia` from each `parseFull` option
(`option.monthlyPayment.monthlyPI ?? .total`) / each `parse` rung (`rung.monthly`).
- **Test** extends step 1: `amountDollars = months × monthlyPitia`; `null` (not 0) when PITIA unknown.

**Step 3 — wire into the program descriptor.** `program-deephaven-dscr.js` `evaluateProgram` returns
`informational`; `PROGRAM.layers.informational = evaluateInformational`. `eligible` unchanged.
- **Test** `scripts/test-lt-program-informational.js`: an eligible scenario still `eligible:true` and now
  carries `informational`; a declined scenario carries BOTH `reasons[]` and `informational[]` (a note is
  not suppressed by a decline).

**Step 4 — surface in the price response.** `dscr-pricer.js`: attach `informational` per program on the
`full` path and a scenario-level copy on both paths. Keep the "nothing silently dropped / computed-not-
static" discipline already in that file (`effectiveOf`, `derivedOf`).
- **Test** `scripts/test-lt-dscr-informational-route.js` (stubbed LP client): `POST /price {full:true}`
  returns `programs[i].informational.reserves.amountDollars` computed against that program's PITIA;
  scenario copy present on the light path.

**Step 5 — the delegate exception product (D34).** Promote `dhvn_delegate_only` to
`informational.exceptions[]` with `meta:{channel:'delegate',requiresException:true,superAdminOnly:true}`.
Response places it in its own array; product stays eligible on every channel.
- **Test**: `<$100k` ⇒ product still prices AND carries the exception; `≥$100k` ⇒ no exception;
  `eligible` never flips because of it.

**Step 6 — the advanced/deferred section (D34 second half).** Emit each `unverifiable[]` overlay as a
`deferred:true, section:'advanced'` note, generated from the array.
- **Test**: every entry in `deephaven-matrix.js` `unverifiable[]` appears exactly once in `deferred[]`
  (generated, not hand-listed — the test reads the source array).

**Step 7 (optional, later) — surface LP's OWN per-product conditions.** `client.js` `optionOf` currently
extracts `conditionActions` only in the DISQUALIFY parser (`disqualifyRulesOf`, line 1430); a QUALIFIED LP
option can also carry `conditionActions` (product-level advisories LP itself attaches). Add
`option.conditions = conditionActions.map(…)` in `optionOf`, and merge them into
`informational.conditions[]` as `source:'lender_price'`. This cross-checks our matrix-derived notes against
LP's own — the same two-layer discipline the eligibility engine uses.
- **Test**: an LP fixture carrying `conditionActions` surfaces them; ours and LP's notes coexist, tagged by
  source.

**Provenance to confirm before any of these drives a hard block:** A3's second-appraisal thresholds are
`[RC]`-only — confirm against `matrices/corr-flow-all-sheets-raw.txt`. Until then every informational
attribute ships `severity:'info'` (or `'exception'` for D34), never as an eligibility decline.

---

## Appendix — exact numbers, one place

| Attribute | Number | Source |
|---|---|---|
| Reserves, loan ≤ $1M | 3 months PITIA | `[JSON]` reserves / `[MD]` L81 |
| Reserves, loan > $1M | 6 months PITIA | `[JSON]` reserves / `[MD]` L81 |
| Reserves, DSCR < 1.00 | 6 months PITIA | `[RC §10.1]` |
| Reserves, Foreign National | 6 months PITIA | `[RC §10.1]` (deferred) |
| Cash-out toward reserves | allowed | `[JSON]` maxCashOutAmount L45 |
| Second appraisal (large loan) | loan > $2,000,000 | `[RC §10.2 / R53]` (confirm) |
| Second appraisal (large cash-out) | cash-out & loan > $1,500,000 | `[RC §10.2 / R53]` (confirm) |
| Small-loan LTV cut | loan < $125,000 → 75% LTV | `[JSON]` smallLoan L50 |
| Delegate-only (D34) | loan < $100,000 → delegate only | `[JSON]` smallLoan L50 |
| Min DSCR floor | 0.75× | `[JSON]` dscrLt1Floor L49 |
| Interest-Only | max LTV 80%, min DSCR 1.00× | `[JSON]` interestOnly L46 |
| Max cash-out, LTV ≤ 65% | $1,000,000 | `[JSON]` L68 |
| Max cash-out, LTV > 65% | $500,000 | `[JSON]` L69 |
| Foreign National max loan | $1,500,000 | `[JSON]` L37 |
| Seller concessions | up to 6% | `[JSON]` sellerConcessions L55 |
| Prepayment penalty | 5yr (5/4/3/2/1) or 4yr (5/4/3/2) | `[JSON]` prepaymentPenalty L56 |
</content>
</invoke>
