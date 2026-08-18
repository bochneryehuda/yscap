# Deephaven DSCR — complete rule catalog (Job 1) + unified rule/condition builder (Job 2)

**Research-engine output, saved verbatim-in-substance so nothing is lost (owner HARD RULE 2026-08-17).**
Source: the rule-mining engine's exhaustive read of the DSCR sheet line by line against all three engines.

Status legend: **✅ encoded** (live now) · **🟢 encodable-now** (facts exist, not yet a rule) ·
**🟡 needs-fact** (deferred; requires a fact we don't carry — flagged, never guessed) · **💲 LLPA** (pricing).
Effect: **DECLINE** (eligibility no-go) · **CUT** (reduce max LTV below the 80% program max) · **LLPA** (points) · **REQUIREMENT**.

## JOB 1 — every rule, with exact numbers

### 1. Program envelope (Layer 2, also Layer 1)
- 1.1 Max loan > **$2,500,000** → DECLINE. ✅ (L1 `dhvn_max_loan` + L2)
- 1.2 Min loan DSCR≥1.00 < **$75,000** → DECLINE. ✅ L2 `dhvn_min_loan_ge1`
- 1.3 Min loan DSCR<1.00 < **$200,000** → DECLINE. ✅ L2 `dhvn_min_loan_lt1`. **⚠ L1 GAP:** L1 sheet uses flat $75k → a $150k DSCR-0.90 loan prices in L1 but declines in L2 (a real two-layer divergence to reconcile).
- 1.4 DSCR < **0.75×** → DECLINE. ✅ (L1+L2 `dhvn_min_dscr`)
- 1.5 FICO < **640** → DECLINE. ✅ L1; L2 per-tier
- 1.6 DSCR<1.00 & FICO < **680** → DECLINE. ✅ L1 `dhvn_min_fico_lt100`

### 2. Max-LTV grid (Layer 2 GRID — loan tier × FICO floor × purpose × DSCR band; null=N/A=DECLINE)
- **Tier 1 ≤$1.5M (min FICO 640):** 720→80/80/75/70 · 700→80/75/75/65 · 680→75/75/70/65 · 640→70/70/N/A/N/A
- **Tier 2 ≤$2.0M (min FICO 660):** 700→80/75/70/65 · 680→75/75/65/65 · 660→65/65/N/A/N/A
- **Tier 3 ≤$2.5M (min FICO 660):** 700→70/70/60/60 · 660→65/65/N/A/N/A
- ✅ encoded (`dhvn_grid_ltv`, `dhvn_grid_na`, `dhvn_min_fico_tier`). Columns order: P/R&T≥1, C/O≥1, P/R&T<1, C/O<1.
- **⚠ L1 vs L2 divergence:** L1's flat envelope (80 / <1.00→75 / <1.00&FICO<700→70) is coarser; e.g. a $2.3M FICO-660 cash-out at 70% passes L1's flat 80% but the grid caps it at 65%. This is exactly the LP-vs-matrix signal.

### 3. Cash-out amount caps (Layer 2) ✅
- 3.1 cashout > **$1,000,000** at LTV≤65% → DECLINE. `dhvn_cashout_le65`
- 3.2 cashout > **$500,000** at LTV>65% → DECLINE. `dhvn_cashout_gt65`

### 4. Small-loan overlay
- 4.1 loan < **$125,000** → max LTV **75%** (CUT). ✅ `dhvn_small_loan_ltv`
- 4.2 loan < **$100,000** → delegated delivery only. 🟡 needs `delivery_channel` — genuine gap.

### 5. Interest-only (R39) ✅
- 5.1 IO & LTV > 80% → DECLINE. `dhvn_io_max_ltv`
- 5.2 IO & DSCR < 1.00 → DECLINE. `dhvn_io_min_dscr`

### 6. Subordinate financing (R40)
- 6.1 subordinate amount > 0 → DECLINE. ⚠ **rule encoded L2 `dhvn_subordinate` BUT `subordinate_amount` is not emitted by `lpScenarioToFacts`** → effectively needs the fact wired to fire.

### 7. Property type & units (R26) ✅
- 7.1 units ≥ **5** → DECLINE (program is 1–4 + condos). `dhvn_units_5plus`
- 7.2 Row homes → DECLINE. `dhvn_row_home`
- 7.3 "2-4 Units & Non-Warrantable Condos Max 80% LTV" is **NOT a cut** (80% is the DSCR program max). Correctly not encoded as a cut; property-type differences are LLPAs (§13).

### 8. Occupancy (R25)
- 8.1 non-investment occupancy → DECLINE. 🟡 needs `occupancy` (DSCR implicitly investment-only).

### 9. Finer overlays (mostly deferred / new-fact)
- 9.1 **Rural (R27):** Max **65% LTV**; DSCR **>1.0×** required; long-term rent only; **≤10 acres** no ag/farm. CUT+DECLINE. 🟡 needs-fact **and NOT flagged in L2 unverifiable — HIGHEST-VALUE GAP.**
- 9.2 **STR (R28):** Min DSCR **1.15**, Min FICO **720**, **−5% LTV (75% max)**, no FTI/2+unit/rural/unique; Property Guard; purchase AirDNA min 60% occ. CUT+DECLINE. 🟡 flagged.
- 9.3 **First-Time Investor (R55):** Min DSCR 1.00, Min FICO 700, LTR only. DECLINE. 🟡 flagged.
- 9.4 **First-Time Homebuyer (R56):** ineligible unless 2+ borrowers & ≥1 non-FTHB. DECLINE. 🟡 needs-fact **and NOT flagged — gap.**
- 9.5 **Declining market (R64):** Max LTV **−5%**. CUT. 🟡 flagged.
- 9.6 **Philadelphia PA (R69):** Max LTV **−10%**. CUT. 🟡 needs `city`. flagged.
- 9.7 **Ineligible geos (R70):** HI lava zones 1&2; Baltimore City MD → DECLINE. 🟡 flagged. **Note: DSCR sheet does NOT list NY as ineligible** (unlike other Deephaven programs).
- 9.8 **Vacant/unleased (R43/R47/R48):** (a) ineligible for R/T or C/O refi; (b) unleased −5% LTV on refi (none on purchase); (c) 2+unit max 1 vacant on refi. DECLINE+CUT. 🟡 needs-fact **and NOT flagged — gap.**
- 9.9 **Foreign National (R49, grid R15/R16):** own grid row P/R&T **70%** · C/O **60%** · DSCR<1.00 N/A; Min DSCR 1.00; Max loan **$1.5M**; 6-mo reserves. CUT+DECLINE. 🟡 **FN grid row entirely absent from L2 GRID — deferred.**
- 9.10 **Citizenship (R49):** US/PR/Non-PR(w/US credit)/FN per guidelines. DECLINE (unlisted). 🟡 needs `citizenship`.

### 10. Requirements (not decline/cut/LLPA)
- 10.1 **Reserves (R32/R33):** 3mo (≤$1M) / 6mo (>$1M); DSCR<1.00→6mo; FN→6mo. 🟢 encodable (loan/dscr branches); FN branch needs fact.
- 10.2 **Full 2nd appraisal (R53):** loan >$2M, OR C/O & loan >$1.5M. 🟢 encodable as a condition flag.
- 10.3 Mortgage history 0x30x12; BK/FC/SS/DIL seasoning 36mo; tradelines 0x60/12mo. 🟡 credit facts.
- 10.4 **Qualifying FICO (R61):** higher-middle of 3, or lower of 2, across ALL borrowers/guarantors (DSCR-specific — differs from other sheets' primary-wage-earner). Feeds the `fico` fact.
- 10.5 Refi seasoning/valuation basis (R35–R38): 0–6mo → lesser of (purchase+improvements) or appraisal; >6mo → appraised; RTL/reno C/O appraised <6mo w/ SSR≤2.5 & max 75% LTV. 🟡 seasoning fact; feeds value/ltv.
- 10.6 DSCR definition (R41): Gross Rents / PITIA (amort) or / ITIA (IO). Upstream of `dscr`.
- 10.7 Income basis (R46): lesser of 1007 market rent or lease (higher w/ 3mo receipt). Upstream of `dscr`.
- 10.8 Seller concessions (R68): up to **6%**. 🟢 encodable as a cap.
- 10.10 LLC entity (R58): Domestic LLC required; guarantors US/PR/Non-PR/FN. 🟡 fact.
- 10.11 Appraisal review product (R51): CU/LCA ≤2.5, or AVM within 10% + CF≥87% + FSD≤.13, or CDA/field. 🟡 fact.

### 11. PPP state matrix (Layer 3 — all ✅). A PPP requested where prohibited → DECLINE; No-PPP never declines. 2026 thresholds.
AK 1-4 prohibited · IL natural-person APR>8 prohibited · LA rural prohibited · MD restricted · MI 1u/first restricted · MN 1-4 ≤$832,750 prohibited · **NJ natural-person 1-4 prohibited + 5+ prohibited** · NM 1-4 prohibited · OH 1-2 first <$116,356 prohibited · PA 1-2 ≤$329,411 prohibited · RI 1-4 restricted · VT <$1M prohibited · VA 1-4 first <$75k prohibited / junior prohibited. **⚠ `borrower_type`/`apr`/`rural_property` consumed but not emitted by `lpScenarioToFacts`.**

### 12. Base ladder (💲 ✅): 28 coupons 6.125%(+0.150) … 9.500%(−9.927); product = 30 Yr Fixed only. Full set: 5/6 ARM, 5/6 ARM-IO, 15Y/30Y Fixed, 30Y Fixed-IO.

### 13. LLPAs (💲) — LP cost-positive, stored negated; 0 = no line; n/e = eligibility cap.
- 13.1 **FICO×CLTV grid** (DSCR-independent) — the full 8×7 matrix (780+ … 640-660 × ≤50 … 75-80). ✅ (see deephaven-dscr-sheet.js).
- 13.2 **DSCR band:** ≥1.25 → +0.25; 1.00–1.24 → 0; <1.00 CLTV-segmented [0.750,0.875,1.000,1.250,1.500,2.000, n/e@75-80]. ✅
- 13.3 **State:** DC/MA/NJ/NY → +0.375. ✅
- 13.4 **Cash-out** (split at FICO 720): ≥720 [0,0.125,0.25,0.25,0.5,0.875,2.625]; <720 [0.25,0.375,0.375,0.5,0.75,1.0,n/e@80]. ✅
- 13.5 **Condo:** [0,0,0,0.125,0.125,0.25,0.5]. ✅
- 13.6 **2-4 units:** [0.25,0.25,0.5,0.5,0.75,1.0,1.5]. ✅
- 13.7 **UNMEASURED (never guessed):** loan-amount LLPA (partial: <125k +2.25, <150k +1.5, >1.5M +0.25 — needs 2D sweep); prepay-term; interest-only; escrow-waiver; cash-out FICO<720@80.

### Job-1 gap priority (deferred / new-fact)
1. **Rural** (65% cut + declines) — not encoded, not flagged. HIGHEST.
2. **Vacant/unleased** — not encoded, not flagged.
3. **Foreign National grid row** — absent from L2 grid.
4. **Subordinate financing** — rule exists, fact not emitted.
5. STR/FTI/**FTHB**/declining/Philly/geo — new facts (FTHB/rural/vacant not flagged).
6. **<$100k delegated-only** — needs `delivery_channel`.
7. **L1↔L2 divergences** — flat $75k vs $200k; flat envelope vs 4-axis grid.
8. Loan-amount + prepay/IO/escrow LLPAs — unmeasured, need a re-measure battery.

## JOB 2 — the unified rule / condition builder

**ONE rule shape for all kinds** (this is literally what `rules.js` evaluates + `rule-store.js` persists in `lt_ppe_rule`):

```jsonc
{ code, kind: "eligibility"|"bound"|"pricing"|"margin", source:"base"|"overlay",
  origin:"derived"|"suggested"|"user", priority, description, citation,
  when: { all|any|none|not: [ { fact, op: eq|neq|in|nin|lt|lte|gt|gte|between|exists, value } ] },
  // payload — exactly one by kind:
  declineReason,                                  // eligibility (DISQUALIFIER)
  target, boundOp:"max"|"min"|"delta", value,     // bound (a leverage CUT / min-max)
  adjustment: { category, dimension, adjMilli, unit, reason, cumulative },  // pricing (LLPA)
  marginMilli, holdbackMilli }                    // margin/holdback
```

- **Eligibility** → collected into `declines[]`; eligible iff none fired. **Bound (CUT)** → most-restrictive-per-target wins; an overlay can only tighten; a requested LTV over the bound auto-declines. **LLPA** → accumulates, never declines; signed milli-points. **Margin/holdback** → first matching rule that names a field wins that field, layered on the per-investor default (250).
- Half-open `[min,max)` bands everywhere; **fail-safe on a missing fact** (leaf over absent fact = false, recorded in `unknownFacts`) — which is why deferred overlays sit inert until their fact arrives.
- **`boundOp:'delta'`** is the ONE new op needed (relative −5%/−10% cuts that compose with the grid) — or expand a delta into per-band absolutes at save time (a UX choice for the owner).

**Builder ops (owner D11):** CREATE (POST a rule) · DUPLICATE (`POST /rule/:id/duplicate` → pre-filled draft) · EDIT (versioned write: close old `effective_to`, insert new — never rename in place) · ADD LLPA (`kind:'pricing'`, grid band editor → `adjustmentToRule`/`bandPredicate`) · ADD MARGIN HOLDBACK (conditions=`when`, limitations=clamp bounds, advancements=lower-priority tighter rows).

**Seeding (already built):** `buildDeephavenGrid` → `rateSheetToProgram` (via `adjustmentToRule`/`ineligibilityToRule`/`bandPredicate`) emits the exact rule shape → the builder renders these as editable `origin:'derived'` rows. The LP-suggestion loop (`rule-store` + `disqualify-analysis` → `lt_ppe_rule_suggestion`) is the third seed. A user rule sits beside as `source:'overlay'`, `origin:'user'` — can only tighten/add, never loosen. `rulesForProgram` already loads house+investor+program rules layered by priority + effective window.

**Mega-system patterns to adopt:** (1) **adjustment stacks** (signed cumulative itemized LLPAs + visible breakdown), (2) **eligibility matrices** (4-axis band editors round-tripped via `bandPredicate`, most-restrictive-wins), (3) **scenario conditions** (arbitrary all/any/none/not predicates scoping any kind), (4) **tiered/effective-dated pricing** (priority-ordered, effective windows, scope layering product→company→investor→scenario). Maps 1:1 onto LoanPass field-rules+stacks, Polly eligibility+adjustment passes (collect ALL blockers), Lender Price matrices+disqualify tree, LoanSifter scenario-conditions+tiered pricing.
