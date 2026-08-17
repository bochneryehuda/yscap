# R10 — Loan-size / Prepay / IO / Escrow re-measure + L1↔L2 reconciliation plan

**Owner directive D35 (2026-08-17).** Read-only research + a measurement/reconciliation plan. NO live
Lender Price calls were made producing this. It cites the exact constants, lines and values in the LT
DSCR code and the matrix/raw sources, and specifies (a) the two L1↔L2 divergences to correct, (b) a
targeted live re-measure battery for the four UNMEASURED LLPAs, (c) what the raw sheet already reveals vs
what must be measured, and (d) an ordered, incremental build plan.

> **Scope guard.** LT-only. Every change lands in `src/longterm/ppe/**`. Investor names (Deephaven /
> Lender Price) are staff-only internal engineering knowledge.

---

## 0. The two-layer model, in one line

- **Layer 1** = the rate sheet: base ladder + LLPA tables + an eligibility *envelope*, in
  `src/longterm/ppe/deephaven-dscr-sheet.js` (the SHEET-UNDER-TEST for the ≥200-scenario LP agreement gate).
- **Layer 2** = the independent eligibility matrix, in `src/longterm/ppe/deephaven-matrix.js` (sourced only
  from the published product matrix, so it can catch an LP mistake).

The two divergences below are places where **L1's envelope is a coarse simplification of what L2 (and the
real matrix) already encode correctly.** L2 is right; L1 must be corrected up to it, and the correction is
proven both against the matrix and against a live LP measurement.

---

## 1. L1↔L2 DIVERGENCES to reconcile

### 1a. Divergence A — the flat $75k minimum should be DSCR-dependent ($200k for DSCR < 1.00)

**CURRENT L1 encoding (wrong — flat $75k for every DSCR):**
`deephaven-dscr-sheet.js:140`

```js
{ code: 'dhvn_min_loan', declineReason: 'Minimum Loan Amount $75,000',
  predicate: { fact: 'loan_amount', op: 'lt', value: 75000 } },
```

There is a single flat rule; it never reads DSCR. A $150,000 loan at DSCR 0.90 **prices** in L1.

**REAL value (matrix + raw sheet):**
- `matrices/deephaven-dscr-matrix.json:32-33` → `"minLoanDscrGe1": 75000`, `"minLoanDscrLt1": 200000`.
- `matrices/deephaven-dscr-sheet-raw.txt` R11 = `75000` (Minimum Loan Amount DSCR ≥ 1.00x), R12 = `200000`
  (Minimum Loan Amount DSCR < 1.00x).
- Rule catalog §1.2 / §1.3.

**L2 already encodes it correctly** (this is the reference):
`deephaven-matrix.js:34-35` constants and `:104-107` predicates —

```js
const MIN_LOAN_DSCR_GE1 = 75000;   // DSCR >= 1.00x
const MIN_LOAN_DSCR_LT1 = 200000;  // DSCR < 1.00x
...
if (dscr >= 1000 && loan < MIN_LOAN_DSCR_GE1) add('dhvn_min_loan_ge1', ...'$75,000 (DSCR >= 1.00x)'...);
if (dscr < 1000 && loan < MIN_LOAN_DSCR_LT1) add('dhvn_min_loan_lt1', ...'$200,000 (DSCR < 1.00x)'...);
```

**PROPOSED corrected L1 encoding** — replace the one flat rule at `deephaven-dscr-sheet.js:140` with two
DSCR-gated rules that mirror L2 (dscr fact is MILLI: 1.00 → 1000):

```js
{ code: 'dhvn_min_loan_ge1', declineReason: 'Minimum Loan Amount $75,000 (DSCR >= 1.00x)',
  predicate: { all: [{ fact: 'dscr', op: 'gte', value: 1000 }, { fact: 'loan_amount', op: 'lt', value: 75000 }] } },
{ code: 'dhvn_min_loan_lt1', declineReason: 'Minimum Loan Amount $200,000 (DSCR < 1.00x)',
  predicate: { all: [{ fact: 'dscr', op: 'lt', value: 1000 }, { fact: 'loan_amount', op: 'lt', value: 200000 }] } },
```

**Net effect:** a `< $200k` loan at DSCR `< 1.00` (e.g. the $150k / DSCR-0.90 case) now declines in L1 as
it already does in L2. A `$75k`–`$199k` loan at DSCR `≥ 1.00` is unaffected (still eligible — the owner's
"$75k is allowed, not an LP bug" point).

### 1b. Divergence B — the flat 80/75/70 envelope should be the REAL 4-axis grid

**CURRENT L1 encoding (wrong — three flat bounds):**
`deephaven-dscr-sheet.js:136-138`

```js
{ code: 'dhvn_max_ltv',                 declineReason: 'Max LTV/CLTV 80%',
  predicate: { fact: 'ltv', op: 'gt', value: 80000 } },
{ code: 'dhvn_max_ltv_lt100',           declineReason: 'DSCR < 1.00: Max LTV 75%',
  predicate: { all: [{ fact: 'dscr', op: 'lt', value: 1000 }, { fact: 'ltv', op: 'gt', value: 75000 }] } },
{ code: 'dhvn_max_ltv_lt100_weakfico',  declineReason: 'DSCR < 1.00, FICO < 700: Max LTV 70%',
  predicate: { all: [{ fact: 'dscr', op: 'lt', value: 1000 }, { fact: 'fico', op: 'lt', value: 700 }, { fact: 'ltv', op: 'gt', value: 70000 }] } },
```

This is a single envelope that ignores **loan-amount tier** and **purpose** entirely, and reads FICO only
as one 700 cut. It over-admits: a $2.3M FICO-660 cash-out at 70% LTV passes this flat 80% but the real grid
caps that cell at **65%**.

**REAL value (matrix + raw sheet).** Max LTV is a 4-axis grid: **loan tier × FICO floor × purpose
(Purchase/R&T vs Cash-Out) × DSCR band (≥1.00 vs <1.00)**; `N/A` = ineligible at any LTV.

Sources: `matrices/deephaven-dscr-matrix.json:12-29` (tiers), `deephaven-dscr-sheet-raw.txt` R11–R20,
`LP-DSCR-ELIGIBILITY-MATRIX.md` "Max-LTV grid", rule catalog §2. The full corrected grid (percent):

**Tier 1 — loan ≤ $1,500,000 (min FICO 640)**

| FICO | P/R&T ≥1 | C/O ≥1 | P/R&T <1 | C/O <1 |
|------|:---:|:---:|:---:|:---:|
| 720  | 80 | 80 | 75 | 70 |
| 700  | 80 | 75 | 75 | 65 |
| 680  | 75 | 75 | 70 | 65 |
| 640  | 70 | 70 | N/A | N/A |
| Foreign National | 70 | 60 | N/A | N/A |

**Tier 2 — $1.5M < loan ≤ $2,000,000 (min FICO 660)**

| FICO | P/R&T ≥1 | C/O ≥1 | P/R&T <1 | C/O <1 |
|------|:---:|:---:|:---:|:---:|
| 700  | 80 | 75 | 70 | 65 |
| 680  | 75 | 75 | 65 | 65 |
| 660  | 65 | 65 | N/A | N/A |

**Tier 3 — $2.0M < loan ≤ $2,500,000 (min FICO 660)**

| FICO | P/R&T ≥1 | C/O ≥1 | P/R&T <1 | C/O <1 |
|------|:---:|:---:|:---:|:---:|
| 700  | 70 | 70 | 60 | 60 |
| 660  | 65 | 65 | N/A | N/A |

**L2 already encodes this grid** (the reference): `deephaven-matrix.js:47-63` (`GRID`), with tiers
half-open by dollar (`T1 loan<=1.5M, T2 1.5M<loan<=2.0M, T3 2.0M<loan<=2.5M`, `:46`), descending FICO
floors, `null` = N/A cell, and `gridCell()`/`evaluateEligibility()` (`:77-118`) turning a cell into a
`Max LTV X%` decline. **One gap in L2 to fix in the same pass:** the **Foreign National row is present in
the matrix JSON (`:18`) but MISSING from `deephaven-matrix.js` `GRID` tier 1** (rule catalog §9.9 —
"FN grid row entirely absent from L2 GRID"). It is fact-gated (needs a `foreign_national` fact) so it stays
inert until that fact is emitted, but the row belongs in both layers.

**PROPOSED corrected L1 encoding.** Replace the three flat rules (`deephaven-dscr-sheet.js:136-138`) with a
grid-driven max-LTV eligibility that evaluates the same 4-axis cell. Because L1 and L2 are deliberately
independent modules (`deephaven-matrix.js:7-12` — L2 must not import L1's eligibility so it can still catch
an LP mistake), the grid is **mirrored, not imported**, and a test fails the moment the two copies disagree
cell-for-cell (repo rule: "where a mirror is unavoidable, a test must fail the moment they disagree"). The
L1 eligibility gains, for a scenario's (loan-tier, FICO-floor, purpose-class, DSCR-band) cell:

- a **`dhvn_grid_na`** decline when the cell is `null` (ineligible at any LTV), and
- a **`dhvn_grid_ltv`** decline `Max LTV X% (tier ..., FICO ..., Purchase|Cash-Out, DSCR ...)` when
  `ltv > cap` — the cap being the exact percent from the grid above (× 1000 for the milli `ltv` fact),

replacing the coarse `dhvn_max_ltv` / `dhvn_max_ltv_lt100` / `dhvn_max_ltv_lt100_weakfico`. The existing
`dhvn_min_fico` (640) stays; the per-tier FICO floors (Tier-1 640, Tier-2/3 660) are enforced by the grid
having no row below the floor.

**Net effect:** every cell the flat envelope over-admitted now declines exactly where the matrix says —
notably the tier-2/3 cash-out and DSCR<1 cells that drop to 65/60. This is precisely the LP-vs-matrix signal
the two-layer design exists to surface; the live re-measure (below) confirms whether LP itself implements
the grid.

---

## 2. TARGETED RE-MEASURE BATTERY

Four LLPAs are UNMEASURED and are honestly declared so in the code: `deephaven-dscr-sheet.js:159-164`
(`UNMEASURED`) and rule catalog §13.7 — **loan-amount** (only sparsely sampled), **prepay-term**,
**interest-only**, **escrow-waiver**. Everything to price these is on the LP sheet + response; what is
missing is the measurement.

### 2.0 The isolation principle + the ONE field-name gotcha

Each LLPA is measured by sweeping **one axis at a time** and holding everything else constant, so the delta
between a scenario and its twin is that one adjustment. The scenario builder already sweeps one axis per
group (`agreement-scenarios.js:11-12`).

**Critical gotcha (already documented at `agreement-scenarios.js:36-38`):** the LP scenario contract fields
are **`prepayMonths`** (number; omitted/60 → the 5-yr default), **`io`** (boolean), **`escrowWaive`**
(boolean). Using `prepayTerm` / `interestOnly` / `escrowWaiver` is **silently ignored** by the builder and
by `lpScenarioToFacts` (`lp-agreement-legs.js:76-81`), so a scenario built with the wrong names prices a
5-yr prepay, no IO, no escrow waiver every time — which is exactly how these axes went unmeasured. Use the
contract names.

### 2.1 Loan-amount LLPA — a 2D (amount × CLTV) table, not a 1D tier list

**Why the current battery cannot capture it.** Group D (`agreement-scenarios.js:76-79`) probes 7 loan sizes
`[150k, 200k, 800k, 1.2M, 1.6M, 2.0M, 2.4M]` **all at a fixed 70% CLTV** (each value/loan pair is 70%). The
loan-amount LLPA on this sheet is a **2D table (amount × CLTV)** (`deephaven-dscr-sheet.js:161`,
`UNMEASURED` — "few CLTV points; needs a 2D sweep"), so a single-CLTV sweep only reads one column of it.

**Breakpoints to probe** (from the partial already captured — `deephaven-dscr-sheet.js:161` and rule catalog
§13.7: `<125k +2.25`, `<150k +1.5`, `>1.5M +0.25` — plus the eligibility tier edges the sheet already names):

| Amount to probe | Why |
|---|---|
| just below / above **$100,000** | small-loan floor; `<$100k` = delegated-only (raw R45) |
| just below / above **$125,000** | known `<125k +2.25`; also the small-loan **75% LTV** cut (raw R45 / `deephaven-matrix.js:40`) |
| just below / above **$150,000** | known `<150k +1.5` |
| around **$1,000,000** | reserves tier edge (raw R32) — probe for an LLPA step |
| just below / above **$1,500,000** | known `>1.5M +0.25`; also FN max + 2nd-appraisal C/O edge |
| just below / above **$2,000,000** | tier-2/3 boundary; 2nd-appraisal edge (raw R53) |
| near **$2,500,000** | max-loan ceiling |

**Cross each amount with CLTV bands 50 / 60 / 70 / 75 / 80** so the full 2D table is read. **Keep CLTV ≤ 75
for any amount `< $125,000`** — the small-loan overlay caps LTV at 75% there (`deephaven-matrix.js:40,127`),
so an 80%-CLTV small-loan scenario is ineligible and reads no price. Hold FICO 760, DSCR 1.25, Purchase, NY,
prepay 60mo, no IO/escrow across the whole sweep so the only moving axis is (amount, CLTV).

### 2.2 Prepay-term LLPA — sweep the 5 terms, twin against the 5-yr baseline

**Terms to probe:** `prepayMonths` ∈ `[60, 48, 36, 24, 12, 0]` (5/4/3/2/1-year and No-PPP — the structures
the raw sheet lists at R65–R66). Group F (`agreement-scenarios.js:85`) already probes `[36, 24, 12, 0]` at
one anchor; add `48` and make 5-yr (`60`) the explicit baseline twin. Sweep at **two anchors** (e.g. FICO
760 / CLTV 70 / DSCR 1.25, and a second at CLTV 80) since the prepay LLPA may be CLTV-segmented like the
other add-ons. Everything else constant; the delta from the 60mo twin per term is the prepay LLPA.

### 2.3 Interest-only LLPA — IO on/off twins across CLTV

**Probe:** `io: true` vs `io: false` at the same anchor. Group G (`agreement-scenarios.js:87`) has a single
`io:true` scenario with no matched non-IO twin at the same anchor, so nothing isolates the delta. Add
paired twins across CLTV 60 / 70 / 75 / 80 at FICO 760 / DSCR 1.25 / Purchase. IO is eligibility-bounded to
LTV ≤ 80% and DSCR ≥ 1.00 (raw R39; `deephaven-matrix.js:133-136`), so keep DSCR ≥ 1.00 and CLTV ≤ 80. The
`io` fact already flows through `lpScenarioToFacts` as `interest_only` (`lp-agreement-legs.js:80`).

### 2.4 Escrow-waiver LLPA — waiver on/off twins

**Probe:** `escrowWaive: true` vs `escrowWaive: false` at the same anchor(s). Group G
(`agreement-scenarios.js:88`) has a single `escrowWaive:true` with no twin. Add paired twins at one or two
CLTV points (escrow waiver is not obviously leverage-segmented — probe two CLTVs to confirm). The
`escrowWaive` fact flows through as `escrow_waiver` (`lp-agreement-legs.js:81`).

### 2.5 How to run it through the existing agreement harness

The whole harness is already built and offline-tested; the live run is one command
(`scripts/test-lt-lp-agreement-run.js`), gated only on the three LP credentials
(`LP_USERNAME` / `LP_PASSWORD` / `LP_CLIENT_SECRET` — `lp-agreement-legs.js:29,141-150`).

1. **Scenarios.** Extend `buildAgreementScenarios` (`agreement-scenarios.js`) so the `loansize`, `prepay`,
   `flags` groups carry the amount×CLTV / term / on-off twins above, **or** hand a captured JSON array via
   `--scenarios`. One scenario object drives BOTH legs (`factsFromLp:true`,
   `lp-agreement-legs.js:98-99`).
2. **The two legs.** `legs.buildOursLeg(program, settings, { factsFromLp:true })` prices our
   sheet-under-test via `quote.quoteProgram`; `legs.buildLpLeg(client, { withDisqualify })` returns
   `{ full, disqualified }` from the live LP search (`lp-agreement-legs.js:95-135`).
3. **The run.** `runRatesheetAgreement(scenarios, { ours, lp }, opts)`
   (`ratesheet-agreement.js:196`). For a MEASUREMENT pass, `opts` must **not** hide the axis being
   measured — see 2.6.

### 2.6 How to READ the itemized LLPA out of LP's response (`parseFull`) — this is the measurement

The measurement number falls straight out of the harness's own per-dimension reconcile; no manual
response-walking is needed:

- LP `parseFull(raw)` → each option carries `adjustments[]` flattened from
  `groupAdjustmentProperties[].adjustments[].{key, adjType, adj|llpa}`
  (`RATE-SHEET-BACKEND-MECHANICS.md` §3c; `flattenAdjustments`).
- `lp-normalize-full.js` turns each into a rung `llpas[]` of `{ reason, adjType, group, valueMilli }`
  (cost-positive milli-points).
- `ratesheet-agreement-diff.reconcileLlpas(...)` folds LP's items **per DIMENSION** using
  `deephavenLpDimension` (`ratesheet-agreement-diff.js:70-88`) and returns
  `itemized:[{ dimension, ourMilli, lpMilli, deltaMilli, lpReason }]` (`:134-139`), surfaced on each
  scenario as `rungReconciles[].itemized[]` (`ratesheet-agreement.js:151`).
- **For an axis we do not model yet, `ourMilli` is `null` and `lpMilli` is exactly the LLPA to encode.**
  So: run the isolated twin, read `itemized[<dimension>].lpMilli` (with its `lpReason`, e.g.
  `"Loan Amount < $150,000"` / `"5 Year Prepay"`) — that milli value **is** the measured LLPA for that
  (amount, CLTV) / term / IO / escrow cell.

**Two crosswalk facts about `deephavenLpDimension` (`ratesheet-agreement-diff.js:70-88`):**
- `loan_amount` (`LoanAmountRateAdjustment` → `:84`) and `prepay` (`SimpleRateAdjustment` + `/prepay/` →
  `:78-81`) **are already classified** — their `lpMilli` reads immediately.
- **IO and escrow are NOT yet classified.** An IO or escrow line is a `SimpleRateAdjustment` whose reason
  is neither `dscr ratio` nor `prepay`, so it currently falls to `other:<slug>` (`:80`). Add two branches
  before measuring so the value lands on a stable dimension:
  `if (/interest\s*only/i.test(r)) return 'interest_only';` and
  `if (/escrow/i.test(r)) return 'escrow_waiver';` inside the `simplerateadjustment` block.

**Measurement-mode opts (vs the current gate run).** The one-command runner today deliberately masks these
axes so the confirmed subset can pass green: `ignoreDimensions:['prepay']` and
`coarseIgnore:['final_price','llpa_total','margin']` (`test-lt-lp-agreement-run.js:97,101`). For a
**measurement** pass, run WITHOUT `ignoreDimensions` (so the prepay/loan_amount/IO/escrow `itemized` rows
are reported, not dropped) and read `lpMilli`; keep `--out <report.json>` to capture the full per-scenario
itemization. The ineligible probes still use the disqualify poll (`withDisqualify`, default on) so the
divergence-A/B corrections are proven on the eligibility side too.

---

## 3. What the raw text ALREADY reveals vs what MUST be measured live

**Key finding about the raw file.** `matrices/deephaven-dscr-sheet-raw.txt` is the **PRODUCT MATRIX**
(`CORR_Flow_Product_Matrices.xlsx`, DSCR sheet) — eligibility + overlays. The **LLPA point tables**
(Block B FICO×CLTV, Block C loan-amount / prepay / IO / escrow / units / condo) live on a **different**
workbook, the rate sheet `Corr_Flow_Rate_Sheet__T0__Excel.xlsx` DSCR tab
(`RATE-SHEET-BACKEND-MECHANICS.md` §2), which is **not** in this repo's raw dump. So the raw matrix text
contains **zero LLPA point values**. Everything the already-encoded LLPAs use (FICO×CLTV, DSCR band, state,
cash-out, condo, units) was measured **live from the captured battery**, not read from this file.

### 3a. Every relevant number the raw matrix DOES give (all ELIGIBILITY, not pricing)

| Item | Raw source | Value | Where it lives |
|---|---|---|---|
| Min loan DSCR ≥ 1.00 | R11 | **$75,000** | L2 `MIN_LOAN_DSCR_GE1`; L1 fix 1a |
| Min loan DSCR < 1.00 | R12 | **$200,000** | L2 `MIN_LOAN_DSCR_LT1`; L1 fix 1a |
| Max loan | R13 | **$2,500,000** | L1 `dhvn_max_loan`, L2 `MAX_LOAN` |
| Max cash-out, LTV ≤ 65% | R14 | **$1,000,000** | L2 `MAX_CASHOUT_LTV_LE65` |
| Max cash-out, LTV > 65% | R15 | **$500,000** | L2 `MAX_CASHOUT_LTV_GT65` |
| Foreign National max loan | R16 | **$1,500,000** | matrix JSON; not yet in L2 GRID |
| Small loan `< $125,000` | R45 | **Max LTV 75%** | L2 `SMALL_LOAN_THRESHOLD`/`SMALL_LOAN_CAP_MILLI` |
| Small loan `< $100,000` | R45 | delegated delivery only | deferred (needs `delivery_channel`) |
| Full 2nd appraisal | R53 | loan `> $2M`, or C/O & loan `> $1.5M` | condition flag (deferred) |
| Reserves | R32–R33 | 3mo (≤$1M) / 6mo (>$1M); DSCR<1 → 6mo; FN → 6mo | requirement (deferred) |
| 4-axis Max-LTV grid | R11–R20 | see §1b table | L2 `GRID`; L1 fix 1b |
| **Prepay STRUCTURES** | R65–R66 | 5yr **5/4/3/2/1**; 4yr **5/4/3/2**; 3yr **5/4/3**; 2yr **3/3**; 1yr **3** | borrower penalty stepdown — **NOT the price LLPA** |
| Prepay state restrictions | R67 | "see Operational Prepayment Penalty Matrices" | Layer 3 PPP matrix (`deephaven-ppp-matrix.js`) |
| Interest Only | R39 | **Max LTV 80%; Min DSCR 1.00x** | eligibility — L2 `:133-136` — **NOT the price LLPA** |
| IO products | R18/R21/R22 | 5/6 ARM-IO, 30Y Fixed-IO | product list — **NOT the price LLPA** |
| Escrow waiver | — | **not mentioned anywhere in the raw matrix** | purely a rate-sheet LLPA |

### 3b. The only LLPA numbers we hold today for the four axes (PARTIAL, from the live battery — NOT the raw sheet)

`deephaven-dscr-sheet.js:161` + rule catalog §13.7:

- **Loan-amount:** `< $125k → +2.25`, `< $150k → +1.5`, `> $1.5M → +0.25` — LP cost-positive points, at a
  **few CLTV points only**. The full 2D (amount × CLTV) table is unknown.
- **Prepay-term / IO / escrow-waiver:** **nothing** — the live run always priced a 5-yr prepay, no IO, no
  escrow waiver (`deephaven-dscr-sheet.js:162-163`). (`RATE-SHEET-BACKEND-MECHANICS.md` §3c shows a live
  capture with an `"Adjustments - DSCR Interest Only"` group at `+0.75` — that is the response *shape*, not
  a confirmed sheet value; it still must be measured.)

**Conclusion:** every loan-amount / prepay / IO / escrow **point** value must be measured live per §2. The
raw matrix supplies only the eligibility bounds and the prepay *penalty structures* (which are the
borrower's fee stepdown, a different thing from the price add-on per term).

---

## 4. Ordered, incremental build plan

Each step lands with a proof against **both** the matrix (offline) and the measured LP values (live), so no
step is trusted on assertion. Tests are `scripts/test-lt-ppe-*.js` (offline, in the aggregate glob) plus the
live `scripts/test-lt-lp-agreement-run.js`.

**Step 1 — L1 min-loan split (Divergence A).** Edit `deephaven-dscr-sheet.js:140` to the two DSCR-gated
rules (§1a). Proof: a new offline test asserts (i) L1 declines `$150k / DSCR 0.90` and admits `$150k /
DSCR 1.10`, and (ii) L1's two thresholds equal `matrices/deephaven-dscr-matrix.json`
`minLoanDscrGe1`/`minLoanDscrLt1`. Add an ineligible probe `$180k / DSCR 0.95` to `agreement-scenarios.js`
group I so the live run confirms LP declines it with a matching disqualifier.

**Step 2 — L1 grid + L2 FN row (Divergence B).** Encode the grid-driven max-LTV eligibility in
`deephaven-dscr-sheet.js` (mirror), and add the Foreign-National row to `deephaven-matrix.js` `GRID` tier 1.
Proof: an offline test asserts L1's mirrored grid equals `deephaven-matrix.js` `GRID` cell-for-cell (fails
the moment they drift), and both equal the matrix JSON tiers. Add grid-edge ineligible probes to the battery
(e.g. `$2.3M / FICO 660 / C/O / DSCR 1.25 / LTV 70` → decline at cap 65; `$2.0M / FICO 700 / P&T / DSCR
0.95 / LTV 65` → decline at cap 60) so the live disqualify poll confirms LP implements the grid.

**Step 3 — loan-amount LLPA 2D table.** Extend `agreement-scenarios.js` group `loansize` to the amount×CLTV
sweep (§2.1). Run a measurement pass (no `ignoreDimensions`) and read `itemized['loan_amount'].lpMilli` per
cell. Encode a `LOAN_AMOUNT_BY_CLTV`-style table in `deephaven-dscr-sheet.js` aligned index-for-index with
`CLTV_BANDS` (like `CONDO_BY_CLTV`/`UNITS_BY_CLTV`, `:84-85`), predicate on the `loan_amount` fact (raw
dollars). Remove the loan-amount line from `UNMEASURED`. Proof: an offline test reproduces the measured
values (LP cost-positive → negated per the `cost()` sign rule, `:31`); the live run's `loan_amount`
dimension reconciles to the penny.

**Step 4 — prepay-term LLPA.** Extend group `prepay` to the 6-term sweep at 2 anchors (§2.2). Measure
`itemized['prepay'].lpMilli` per term. `deephavenLpDimension` already classifies prepay
(`:78-81`). Encode a `PREPAY_BY_TERM` table keyed on the `prepay_months` fact
(`lp-agreement-legs.js:78`). Remove `ignoreDimensions:['prepay']` from
`test-lt-lp-agreement-run.js:97`. Proof: offline reproduction + live per-term reconcile to the penny.

**Step 5 — interest-only LLPA.** Add the `interest_only` branch to `deephavenLpDimension`
(`ratesheet-agreement-diff.js`, §2.6). Extend group `flags` to IO on/off twins across CLTV (§2.3). Measure
`itemized['interest_only'].lpMilli`. Encode an `IO_BY_CLTV` table keyed on the `interest_only` fact
(`lp-agreement-legs.js:80`). Remove the IO line from `UNMEASURED`. Proof: offline + live reconcile.

**Step 6 — escrow-waiver LLPA.** Add the `escrow_waiver` branch to `deephavenLpDimension` (§2.6). Add
escrow on/off twins to group `flags` (§2.4). Measure `itemized['escrow_waiver'].lpMilli`. Encode an
`ESCROW_WAIVER` adjustment keyed on the `escrow_waiver` fact (`lp-agreement-legs.js:81`). Remove the escrow
line from `UNMEASURED`. Proof: offline + live reconcile.

**Step 7 — full-battery green.** With all four axes modelled, drop the compensations that were masking them
in `test-lt-lp-agreement-run.js` (`ignoreDimensions`, and the `coarseIgnore` net-price masks if the margin
question is separately resolved), so the E3 gate now agrees with LP on loan-amount, prepay, IO and escrow to
the penny alongside everything already confirmed. `UNMEASURED` (`deephaven-dscr-sheet.js:159-164`) is empty
except the deliberately-deferred `cash-out FICO<720 @ CLTV 80%` (n/e) cell, which its own targeted probe
resolves.

**Sequencing note:** Steps 1–2 (eligibility) and Steps 3–6 (pricing) are independent and can land in any
order; each is a self-contained, separately-proven change. Do the two divergences first — they need no new
LLPA measurement and close the highest-risk gaps (a loan that should decline being priced).
