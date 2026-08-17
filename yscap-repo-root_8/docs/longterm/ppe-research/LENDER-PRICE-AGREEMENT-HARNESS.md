# The ≥200-scenario Lender Price AGREEMENT harness — design

**Owner HARD RULE (2026-08-17):** before any rate sheet is *built into the system*, prove — to the
penny — that OUR rate-sheet grid and Lender Price agree on **every LLPA, every eligibility, every
ineligibility, max price and min price**, across ≥200 scenarios run "from every angle." Lender Price
stays authoritative; ours must MATCH it, not the reverse.

This is designed **on top of modules that already exist**. It adds exactly ONE thin new module
(`ratesheet-agreement.js`) that composes them. It invents no new engine.

The one-line data flow it wires together:

```
grid (human rate sheet)
  └─ deephaven-grid.gridToRateSheet(grid)        → { basePrices[], adjustments[], ineligibilities[], priceLimit }
       └─ ratesheet.rateSheetToProgram(sheet)    → program { baseGrid[], rules[], priceLimit }
            └─ quote.quoteProgram({scenario, program, settings})   ← OUR priced result

scenario-matrix.buildMatrix(AXES, {base})        → the deterministic scenario battery
  └─ for each scenario:
       ours   = quote.quoteProgram(...)                             (PURE)
       theirs = lp-normalize-full.normalizeLpFull(client.parseFull(client.price(s).raw))       (LIVE LP)
              + lp-normalize-full.normalizeLpDisqualified(client.parseDisqualified(...))
       diff   = parity-detectors.detectDifferences({ours, lp, lpDisqualified})   (PURE)
              + reconcileLlpas(ours, lp)          ← NEW itemized per-LLPA diff   (PURE)
              + boundsProbe(ours, lp)             ← NEW max/min probe            (PURE)
```

Real exports this builds on (verified in-tree):

- `scenario-matrix.js` → `buildMatrix(axes, opts)` → `{ scenarios, fullSize, truncated, stride }`;
  each scenario carries `_index` + `_label`. Also `fullSizeOf`, `describeScenario`.
- `coverage.js` → `oneFieldGoldens(baseline, axes)`, `boundaryScenarios(baseline, field, spec)`,
  `pairwise(axes)`.
- `deephaven-grid.js` → `gridToRateSheet(grid)` → `{ basePrices, adjustments, ineligibilities, priceLimit, problems }`; `rateSheetToGrid(sheet)`.
- `ratesheet.js` → `rateSheetToProgram(sheet, meta)`, `adjustmentToRule(a)`, `bandPredicate(fact,min,max)`.
- `quote.js` → `quoteProgram({scenario, program, settings})` → eligible `{eligible:true, ladder[<record>], pricingBasis}` or `{eligible:false, declines[], bounds, unknownFacts}`.
- `pricing.js` reconstruction record per rung carries: `basePriceMilli`, `basePointsMilli`,
  `adjustments[]`, `adjustmentCostMilli`, `adjustmentPointsMilli`, `adjustmentCapped`,
  `marginMilli`, `finalPriceMilli`, `finalPointsMilli`, `floorMilli`, `capMilli`, `clamped`.
- `lp-normalize-full.js` → `normalizeLpFull(full, opts)` → `{ eligible, programsMatched, programs[{rungs[<rung>]}], bestLadder }`; each rung: `rate, priceMilli, baseRateMilli, basePointsMilli, adjustmentPointsMilli, marginMilli, marginByTier, llpas[{reason,adjType,group,valueMilli}], rateLlpas[]`. And `normalizeLpDisqualified(disq, opts)` → `{ ready, declined[{lender,investor,program,reasons[{rule,adjType}]}] }`.
- `parity-detectors.js` → `detectDifferences({ours, lp, lpDisqualified}, {settings})` →
  `{ verdict:'agree'|'disagree', differences[{category,severity,rate?,ourValue,lpValue,deltaMilli?,detail,lpLlpas?,lpReasons?}], summary }`. Categories: `base_price`, `final_price`, `coupon_missing_ours/_lp`, `margin`, `llpa_total`, `disqualification_missing`, `disqualification_extra`. Tolerances default 0 (exact).
- `parity-review.js` → `reviewScenario({ours, lpFull, lpDisq, filter, settings})` → per-scenario
  differences + suggested overlay rules (used for the human review queue, not the pass/fail).
- `shadow.js` → `runShadow(scenarios, {ours, theirs}, opts)` → `{results, summary}`; bounded
  concurrency; an engine throw becomes an `engine_error` finding for THAT scenario, never fails the batch.
- `lenderprice/client.js` → `price(scenario)`, `priceDisqualified(scenario, opts)`, `parseFull(raw)`,
  `parseDisqualified(raw)`, `configured()`. `search-model.buildSearch(sc, opts)` / `validateScenario`.

---

## 1. THE SCENARIO BATTERY ("every angle")

### 1.1 Units contract (must be honored by both adapters)

The axes are declared in **human units**. Each engine gets the units it reads (verified against
`deephaven-grid.gridToRateSheet` and `search-model.buildSearch`):

| axis (human)   | OUR scenario (quote.js facts)         | LP scenario (search-model)          |
|----------------|----------------------------------------|-------------------------------------|
| `fico` = 740   | `fico: 740` (raw)                      | `fico: 740`                         |
| `cltv` = 75    | `ltv: 75000` (milli-percent)           | `ltv: 0.75`  (buildSearch accepts 75 too) |
| `dscr` = 1.25  | `dscr: 1250` (milli)                   | `dscr: 1.25`                        |
| `loan` = 1_000_000 | `loan_amount: 1000000` (raw $)     | `loan: 1000000` + `value`/`ltv`     |
| `purpose`      | `purpose: 'purchase'`                  | `purpose: 'Purchase'` / `'Cash out'`/`'Refinance'` |
| `term` = 30    | `term: 30`                             | `termYears: 30`                     |
| `lock` = 30    | `lock_days: 30`                        | `lockDays: 30`                      |
| `state`,`propertyType`,`units` | passthrough facts      | `state`/`zip`, `propertyType`, `units` |

The adapters are `toOurScenario(s)` and `toLpScenario(s)` inside the new module. **This translation
layer is the ONE place unit skew can hide** — it is tested with a fixed golden (§5).

### 1.2 The AXES (concrete values, edges included on purpose)

```js
const AXES = {
  // FICO bands, each threshold PLUS a just-below-threshold probe (LLPA jumps at the boundary)
  fico:   [820, 780, 760, 740, 720, 700, 680, 679, 660, 640, 639, 620],   // 679/639 = just-below
  // CLTV bands incl. the max-LTV EDGE and one above it (must be INELIGIBLE)
  cltv:   [55, 60, 65, 70, 75, 80, 80.01, 85],                            // 80.01/85 = past the DSCR wall
  // every DSCR band incl. sub-1.0 and no-DSCR
  dscr:   [1.50, 1.35, 1.25, 1.20, 1.10, 1.00, 0.99, 0.75, 0.0],          // 0.99=sub-1, 0.0=no-DSCR
  purpose:[ 'purchase', 'refinance', 'cashout' ],
  // loan tiers incl. below-min and above-max (both should be INELIGIBLE)
  loan:   [ 74000, 75000, 150000, 500000, 1000000, 1500000, 2000000, 3500001 ], // 74000<min, 3500001>max
  term:   [ 30, 15 ],
  lock:   [ 30, 45 ],
};
// Secondary angles swept SEPARATELY (small) so they don't multiply the core grid:
const STATE_ANGLES = ['NY', 'CA', 'TX', 'FL', 'NJ'];      // incl. a high-cost + an ineligible-state probe
const PROP_ANGLES  = ['SingleFamily', 'Condominium', 'Multi2to4'];
```

### 1.3 How buildMatrix strides to ~200–400 deterministically, and why edges survive

`buildMatrix` is the **deterministic** cartesian generator: with `maxScenarios` it strides the full
grid (`stride = ceil(fullSize/max)`), reports `truncated`/`fullSize`, and never uses randomness. A
plain stride over the whole 9-axis product would *skip* the exact ineligible corners we care about.
So the battery is built in **three deterministic parts, concatenated then de-duped** (all pure):

1. **CORE** — `buildMatrix(coreAxes, {base, maxScenarios: 280, label:['fico','cltv','dscr','purpose','loan']})`
   where `coreAxes = {fico, cltv, dscr, purpose, loan}` (fullSize = 12·8·9·3·8 = **20 736**),
   strided to 280. This gives broad, reproducible coverage of the FICO×CLTV×DSCR×purpose×loan
   corners. `term`/`lock`/`state`/`propertyType` sit on `base` at defaults.
2. **EDGES (guaranteed present regardless of stride)** — an explicit list built from the same `base`,
   so the designed-ineligible and cap/floor corners cannot be strided away:
   - below-min loan (`loan:74000`) and above-max loan (`loan:3500001`) → **INELIGIBLE**;
   - max-LTV edge (`cltv:80` eligible / `cltv:80.01` + `cltv:85`) → the over-edge → **INELIGIBLE**;
   - sub-1.0 DSCR (`dscr:0.99`) and no-DSCR (`dscr:0.0`) at each purpose;
   - just-below-FICO-floor (`fico:619` if the sheet floors at 620) → **INELIGIBLE**;
   - term 15 and lock 45 each crossed with one mid-grid eligible cell;
   - one row per `STATE_ANGLES` and per `PROP_ANGLES`, each on a known-eligible mid cell.
   Built with `coverage.oneFieldGoldens(base, {term:[30,15], lock:[30,45]})` +
   `coverage.boundaryScenarios(base, 'loan', {min, max})` + a hand-listed ineligible set.
3. **PAIRWISE fill** (optional, to lift count/coverage) — `coverage.pairwise(coreAxes)` guarantees
   every value-pair of any two axes appears together; concatenated and de-duped it tops the battery
   toward the upper end (~300–400) without a full cartesian.

De-dupe key = a stable `JSON.stringify` of the sorted human-fact bag (drop `_index`/`_label`/`_layer`).
`buildMatrix` already stamps `_index`+`_label`; EDGES/PAIRWISE get their own `_label` via
`describeScenario`. **Result: 280 (core) + ~40 (edges) + fill, de-duped ⇒ ≥ 200, typically ~300.**
The count and `{truncated, fullSize, stride}` are reported in the run header (no silent caps — repo rule).

**Explicitly ineligible scenarios are a first-class part of the battery** — they are the whole point
of §2's ineligibility axis, and EDGES makes them survive truncation.

---

## 2. THE COMPARISON (per scenario) + the aggregate

### 2.1 Build ours ONCE (pure) — the program under test

The rate sheet being validated is compiled once, before the run:

```js
const sheet   = gridToRateSheet(grid);            // { basePrices, adjustments, ineligibilities, priceLimit, problems }
// HARD PRE-CHECK: sheet.problems MUST be empty. A malformed band / unreadable cell is a build blocker.
const program = rateSheetToProgram(sheet, meta);  // { baseGrid, rules[], priceLimit }
```
`ours(scenario) = quoteProgram({ scenario: toOurScenario(scenario), program, settings })`. Pure, no IO.

**Ineligibility on our side has TWO sources that must agree with LP:** the `N/A` grid cells become
`sheet.ineligibilities[]` (decline predicates) and out-of-band loan/LTV/FICO become `bounds`. Both
surface as `quoteProgram(...).eligible === false` with `declines[]`. The harness reads `ours.eligible`.

### 2.2 Build theirs (live LP) and normalize

```js
const priced = await client.price(toLpScenario(scenario));         // LIVE
const lpFull = normalizeLpFull(client.parseFull(priced.raw), filter);
const dq     = await client.priceDisqualified(toLpScenario(scenario)); // LIVE (async poll)
const lpDisq = normalizeLpDisqualified(client.parseDisqualified(dq.raw), filter);
const lpProgram = lpFull.programs[0] || { eligible: lpFull.eligible, rungs: lpFull.bestLadder };
```
`filter = { investor, program, product }` selects the LP program that corresponds to the sheet under
test (the sheet's `meta.investorCode`/program). LP eligibility = `lpFull.eligible` (bestLadder
non-empty); LP ineligibility = `lpDisq.declined[]` for this program.

### 2.3 The per-scenario PASS/FAIL

Run the canonical detector plus the two new pure diffs:

```js
const det  = detectDifferences({ ours, lp: lpProgram, lpDisqualified: lpDisq }, { settings });
const llpa = reconcileLlpas(ours, lpProgram);   // NEW, §4
const bnd  = boundsProbe(ours, lpProgram, sheet.priceLimit);  // NEW, §3
const pass = det.verdict === 'agree'
          && llpa.itemized.every(x => x.deltaMilli === 0)
          && bnd.agree;
```

The two axes of PASS, spelled out:

- **ELIGIBLE scenario** — assert, EXACT (milli, tolerances default 0):
  - base price: `ours.ladder[r].basePriceMilli` == `100000 − lp.rungs[r].basePointsMilli`
    → detector `base_price` empty.
  - each LLPA by dimension one-for-one → `reconcileLlpas` all `deltaMilli === 0` (§4).
  - final price: `ours.ladder[r].finalPriceMilli` == `lp.rungs[r].priceMilli`
    → detector `final_price` empty.
  - cap/floor applied identically → `boundsProbe.agree` (§3).
  - margin: `ours.ladder[r].marginMilli` == `lp.rungs[r].marginMilli`
    → detector `margin` empty.
  - no coupon offered by one side and not the other → `coupon_missing_ours/_lp` empty.
- **INELIGIBLE scenario** — assert both directions are empty:
  - `disqualification_missing` empty (we did NOT price a loan LP declines — the dangerous direction),
  - `disqualification_extra` empty (we did not decline a loan LP priced),
  - AND the SAME dimension + threshold: extend the check so an ineligible pass also requires that our
    decline reason (`ours.declines[].dimension` / band) **maps to** an LP disqualifier
    (`lpDisq.declined[].reasons[].rule` via `disqualify-crosswalk`, already used by `parity-review`).
    A both-decline-but-different-dimension case is reported as a `dimension_mismatch` finding (new,
    low-severity) so "we agree it's ineligible but for a different reason" is never silently a pass.

`reviewScenario` is run alongside to attach **suggested overlay rules** for any disagreement — that
output feeds the human review queue, it is NOT part of pass/fail (Lender Price stays authoritative).

### 2.4 The aggregate

The report is "agree on N/200; here is every disagreement, itemized by dimension":

```
{ total, agreed, disagreed, ineligibleAgreed, engineErrors,
  byCategory: { base_price, final_price, llpa_total, margin, coupon_missing_ours,
                coupon_missing_lp, disqualification_missing, disqualification_extra,
                dimension_mismatch, cap_floor },
  byDimension: { fico_cltv_dscr: {count, worstDeltaMilli}, loan_amount:{...}, state:{...}, ... },
  disagreements: [ { scenario:_label, category, dimension, rate?, ourValue, lpValue, deltaMilli, detail } ],
  truncation: { fullSize, truncated, stride, batteryCount } }
```

`shadow.summarize` (= `parity.summarize` + `errors`) is the base; `byDimension` and the ineligibility
counts are added by the new module. **A single `disagreement` with a non-zero milli delta, in either
direction, fails the whole harness** — that is the owner's "to the penny" gate. `engineErrors > 0`
also fails (an LP timeout or our throw is not agreement).

---

## 3. MAX / MIN PRICE (the cap and the floor)

Our engine applies the sheet's `priceLimit`: `pricing.priceRung` clamps `roundedPriceMilli` to
`[floorMilli, capMilli]` and records `finalPriceMilli`, `floorMilli`, `capMilli`, and `clamped`
(true when the clamp bit). `quote.capForLoanAmount` selects the cap tier by loan amount.

**Probe scenarios (added to EDGES so they always run):**

- **CAP probe** — a coupon/leverage cell whose *raw* price would exceed the cap: a very high note
  rate on a strong FICO×low-CLTV cell (biggest positive rebate). Expect `ours.ladder[r].clamped ===
  true` and `finalPriceMilli === capMilli`.
- **FLOOR probe** — a cell whose *raw* price would fall below the floor: a very low coupon on a weak
  FICO×high-CLTV cell (deep discount). Expect `clamped === true` and `finalPriceMilli === floorMilli`.
- **Loan-tier cap** — the same cell at each `loan` tier that changes `capForLoanAmount`, to prove the
  tier boundary is read the same as LP's loan-amount price cap.

`boundsProbe(ours, lp, priceLimit)` asserts, per rung, EXACT (milli):

1. our clamped `finalPriceMilli` == LP's `rungs[r].priceMilli` — i.e. LP bounded it to the **same
   number** (this is the primary, always-checkable assertion; `normalizeLpFull` exposes LP's final
   `priceMilli`, which is already post-bound).
2. when `ours.clamped` is true, the clamped value equals our `capMilli`/`floorMilli` — proving OUR
   bound fired at the sheet's stated limit, not by coincidence.
3. **direction check**: if LP's price and our raw (pre-clamp `roundedPriceMilli`) disagree on which
   way the bound moved, that is a `cap_floor` finding — LP bounded but we did not (or vice-versa).

Note: `lp-normalize-full` today exposes LP's post-bound `priceMilli` but not a separate LP
cap/floor field, so assertion (1) — same final number — is the load-bearing one, and (2)/(3) prove
our own clamp is faithful to the sheet. If a live LP capture is later found to carry an explicit
max/min field, add it to `rungOf` and assertion (1) gets a second, direct leg.

---

## 4. PER-LLPA RECONCILIATION (itemized, one-for-one)

`detectDifferences` already compares the LLPA **stack total** (`llpa_total`: our
`adjustmentCostMilli` vs LP's `adjustmentPointsMilli`) and attaches LP's itemized `lpLlpas`. The owner
wants **each individual LLPA to line up**, so the new module adds an itemized diff on top.

**Our side (per rung):** `ours.ladder[r].adjustments[]` — each carries `{ code, category, dimension,
adjMilli, unit, reason }` (from `ratesheet.adjustmentToRule`'s adjustment object; the FICO×CLTV×DSCR
grid cell is dimension `fico_cltv_dscr`, loan-amount/prepay/state/property/purpose each their own
`dimension`).

**LP side (per rung):** `lp.rungs[r].llpas[] = [{ reason, adjType, group, valueMilli }]` (point LLPAs,
verbatim from `groupAdjustmentProperties` via `lp-normalize-full.llpasOf`) and `rateLlpas[]`.

**The itemized diff — `reconcileLlpas(ours, lp)` (pure, new):**

1. Build a canonical **dimension key** for each side. Ours: `dimension` directly. LP: map
   `adjType`/`group`/`reason` → our dimension via a small crosswalk table (`fico`/`cltv`/`ltv`→
   `fico_cltv_dscr`, `loanamount`→`loan_amount`, `state`, `prepay`, `propertytype`, `purpose`, …).
   Unknown LP `adjType` → key `other:<reason>` so it is never silently merged.
2. Sum each side per key (LLPAs are cumulative points, cost-positive on both sides — same convention
   noted in `parity-detectors`).
3. Emit `itemized[] = [{ dimension, ourMilli, lpMilli, deltaMilli, ourReason, lpReason }]` for the
   UNION of keys. A dimension present on one side only appears with the other side `null` and a
   non-zero delta (`llpa_missing_ours` / `llpa_extra_ours`).
4. `deltaMilli === 0` on every row ⇒ the LLPA stack matches one-for-one, not just in total. A
   `llpa_total` agreement with a per-dimension disagreement (two offsetting cell errors) is the exact
   case this catches that the total check cannot.

The aggregate's `byDimension` rolls these up so a failing sheet reads: "fico_cltv_dscr agrees on
298/300; loan_amount off by +125 milli on 4 scenarios" — dimension-itemized, per the owner's ask.

---

## 5. THE THIN NEW MODULE — `src/longterm/ppe/ratesheet-agreement.js`

**Purpose:** compile a grid, run the battery through both engines, and produce the per-scenario +
aggregate agreement report. It is glue over the modules above — no pricing math of its own.

### 5.1 Inputs / output

```js
/**
 * runRatesheetAgreement({ grid, axes?, meta, settings, filter, lpPrice, lpDisqualify, opts }) → report
 *
 *   grid        — the human rate sheet (deephaven-grid.gridToRateSheet input).
 *   axes        — override AXES (defaults to §1.2). base/maxScenarios via opts.
 *   meta        — { code, name, investorCode } identity for rateSheetToProgram + the LP filter.
 *   settings    — resolved settings map (tolerances; default 0 = exact) for quoteProgram + detectDifferences.
 *   filter      — { investor, program, product } to pick the matching LP program.
 *   lpPrice(s)     — async: a LIVE Lender Price price   → { raw }  (wraps client.price + parseFull).
 *   lpDisqualify(s)— async: a LIVE LP disqualify        → { raw }  (wraps client.priceDisqualified + parseDisqualified).
 *   opts        — { maxScenarios=280, concurrency=2, base }.
 *
 * Returns:
 *   { header:{ batteryCount, fullSize, truncated, stride, sheetProblems },
 *     results:[ { scenario:_label, pass, eligibleOurs, eligibleLp,
 *                 differences[], itemized[], bounds, review } ],
 *     aggregate:{ total, agreed, disagreed, ineligibleAgreed, engineErrors,
 *                 byCategory, byDimension, disagreements[] },
 *     pass:boolean }              // pass = disagreed===0 && engineErrors===0
 */
```

### 5.2 How it composes the existing modules

1. **Compile** — `gridToRateSheet(grid)`; **refuse to proceed if `sheet.problems.length`** (a
   malformed sheet cannot be validated). `rateSheetToProgram(sheet, meta)` → `program`.
2. **Battery** — build CORE via `buildMatrix(coreAxes, {base, maxScenarios, label})`, EDGES via
   `coverage.oneFieldGoldens`/`boundaryScenarios` + the explicit ineligible/cap/floor list,
   optional PAIRWISE via `coverage.pairwise`; concat + de-dupe (§1.3).
3. **Adapters** — `toOurScenario(s)` / `toLpScenario(s)` (the §1.1 unit contract, ONE place).
4. **Engines for `shadow.runShadow`**:
   - `ours = s => quoteProgram({ scenario: toOurScenario(s), program, settings })` — **PURE**.
   - `theirs = async s => { const p = await lpPrice(toLpScenario(s)); const d = await lpDisqualify(toLpScenario(s));
       return { lpFull: normalizeLpFull(client.parseFull(p.raw), filter),
                lpDisq: normalizeLpDisqualified(client.parseDisqualified(d.raw), filter) }; }` — **LIVE LP**.
   Reuse `shadow.runShadow` for the bounded-concurrency, fail-safe batch loop (an engine throw becomes
   an `engine_error` finding for that scenario, never fails the batch).
5. **Per-scenario compare** — inside the runner's comparator: `detectDifferences({ours, lp:lpFull.programs[0], lpDisqualified:lpDisq}, {settings})`
   + `reconcileLlpas(ours, lpFull.programs[0])` (new, in this module) + `boundsProbe(...)` (new) +
   `reviewScenario(...)` for the suggestion queue.
6. **Aggregate** — start from `shadow.summarize`, add `byDimension` + ineligibility tallies + the flat
   `disagreements[]`.

`reconcileLlpas` and `boundsProbe` are small pure functions that live in this module (or a sibling
`ratesheet-agreement-diff.js`); everything else is an existing export.

### 5.3 What is PURE (offline, fixture-testable) vs what needs LIVE LP

| piece | pure? | how it is tested offline |
|-------|-------|---------------------------|
| `gridToRateSheet`, `rateSheetToProgram`, `quoteProgram` | **pure** | a golden grid → priced ladder |
| `buildMatrix` / `coverage.*` battery build + de-dupe | **pure** | assert count ≥200, edges present, deterministic |
| `toOurScenario` / `toLpScenario` unit adapters | **pure** | golden scenario → both shapes, unit skew pinned |
| `normalizeLpFull` / `normalizeLpDisqualified` | **pure** | fed a **captured LP `raw` fixture** (`parseFull`/`parseDisqualified` output) |
| `detectDifferences`, `reconcileLlpas`, `boundsProbe`, `reviewScenario` | **pure** | ours (real quote) vs a captured LP fixture |
| `client.price` / `client.priceDisqualified` | **LIVE** | the ONLY live legs; needs LP creds |

So the entire harness runs **offline against a captured Lender Price fixture** (a recorded `searchRaw`
`raw` per scenario) — that is the CI test: `ours` real, `theirs` = replay the fixture through
`parseFull`/`normalizeLpFull`. The only thing that needs the live vendor is refreshing the fixtures /
running the real agreement gate. `lpPrice`/`lpDisqualify` are injected exactly so the pure path and
the live path share one code path (the `shadow.js` IO-injection pattern).

### 5.4 Test-proven-to-fail discipline (repo HARD RULE)

The offline suite must be shown to go RED when the sheet is wrong: mutate ONE grid cell by 125 milli
and confirm exactly one `final_price` + one `fico_cltv_dscr` `reconcileLlpas` row turn non-zero and
the aggregate `pass` flips to false, with an unmutated control green on either side.

---

## 6. BLOCKERS (state plainly — until these land, the harness runs FIXTURES, not live agreement)

1. **Live Lender Price credentials are COMPROMISED and must be ROTATED.** `client.configured()`
   requires `LP_USERNAME` / `LP_PASSWORD` / `LP_CLIENT_SECRET` (Render env only, never committed). Any
   credential shared in chat/transcript is considered compromised per the repo secrets rule and must
   be rotated by the owner in the Render dashboard before the live legs (`client.price` /
   `client.priceDisqualified`) can be trusted. Until then the live agreement gate cannot run — only
   the fixture replay can.
2. **The real Deephaven Excel rate sheet is not yet in hand.** `gridToRateSheet` needs the actual
   `grid` (base-price ladder, the FICO×CLTV×DSCR LLPA box with its real bands and `N/A` cells, the
   loan-amount/prepay/state/property tables, and the real `priceLimit` cap/floor). The AXES thresholds
   in §1.2 (FICO floor, max-LTV wall, min/max loan) must be re-pinned to the sheet's actual band edges
   once the Excel lands, or the "just-below-threshold" and "over-the-edge-INELIGIBLE" probes test the
   wrong numbers.

**Until BOTH land, the harness is exercised only against fixtures — a captured LP `raw` per scenario —
which proves the plumbing and the pure comparators, but is NOT proof of live agreement.** The owner's
gate ("pass BEFORE any rate sheet is built into the system") is satisfied only by a live run: real
Deephaven grid in, rotated LP creds, `pass === true` on ≥200 scenarios, to the penny.
