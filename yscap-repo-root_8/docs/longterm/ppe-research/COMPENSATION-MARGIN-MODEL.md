# LT DSCR — Loan-Officer MARGIN + COMPENSATION Model (DESIGN, not built)

**Scope:** Long-Term (LT) DSCR Product & Pricing Engine only (`src/longterm/**`). READ-ONLY research + design. Nothing here is built; this is the buildable spec to add to the plan.

**What this governs:** how our COMPANY and each LOAN OFFICER make money on TOP of the investor's raw pricing — the margin the company always keeps behind the price, the LO's own margin (front vs back), the per-loan minimum/maximum, and the split of the compensation between the company and the LO.

---

## 0. Vocabulary (mortgage-PPE terms, used correctly)

Real PPEs / LOS platforms (Optimal Blue, Lender Price, EPPS) model officer/broker compensation with a small, well-defined vocabulary. The owner's words map onto it 1:1:

| Owner's word | Industry term | Meaning |
|---|---|---|
| "priced at PAR / 100" | **Par pricing (100.000)** | The borrower neither pays points nor gets a rebate; price = 100. |
| "2-point origination charge (front)" | **Origination points / discount points (borrower-paid)** | The borrower pays points up front. 1 point = 1% of the loan amount. This is money collected AT closing, on top of the note. |
| "price at 102 (back / rebate)" | **Rebate / YSP (yield-spread premium), lender-paid** | The investor pays a premium above par (e.g. 102). That premium funds the compensation from the BACK — the borrower pays no points. |
| "search borrower-paid vs lender-paid" | **Compensation type: Borrower-Paid Comp (BPC) vs Lender-Paid Comp (LPC)** | BPC: the comp is NOT baked into the shown price; it is charged to the borrower as points (front). LPC: the comp IS baked into the shown price as a rebate deducted from a higher investor price (back). |
| "our 0.25 holdback, always kept in the back" | **Company margin / lender margin (retained spread)** | A fixed spread the company always subtracts from the investor price before anyone sees it. It is the company's cut and is never the officer's to give away. |
| "give zero origination and price at 102" | **Buy-up (trading price for a lower borrower cost)** | Choosing a higher investor price (a worse note rate) so the rebate covers the comp instead of the borrower paying points. |
| "his own rules for back vs front" | **Comp plan (per-originator)** | Each originator's configured split of how much margin is taken as rebate (back) vs origination (front). |
| "he won't work a file for less than $3000" | **Minimum comp floor** | A dollar (or %) floor the comp is bumped UP to. |
| "$50,000 max = only 1 point" | **Maximum comp cap** | A dollar (or %) ceiling the comp is capped DOWN to. |
| "not the entire origination goes to the LO" | **Comp split / commission split** | The originator receives a percentage of the compensation; the company keeps the remainder. |

**Unit convention (matches the existing engine — `src/longterm/ppe/pricing.js` §3):** every price/point value is an INTEGER in **milli-points** (thousandths of a point). Par 100.000 → `100000`; the 0.25 holdback → `250`; a 2.00 margin → `2000`. Dollars are held separately as integers of cents where money is computed. This spec never introduces a float.

---

## 1. The two things that are NOT the same

The single most important distinction, and the one the owner stated first:

- **COMPANY HOLDBACK = 0.250 (`250` milli).** Company-set, ON the loan, displayed BEHIND the pricing. A loan officer can **NEVER** override it, remove it, or reduce it. It is always subtracted from the investor price before the LO ever sees a number, and the company keeps **100%** of it. It is NEVER part of the min/max clamp and NEVER part of the comp split.
- **LO MARGIN = 2.000 (`2000` milli) by default.** This is the officer's OWN take. It is a company DEFAULT that each LO can override (up or down) and split between FRONT (origination) and BACK (rebate) with his own rules. It IS subject to the per-loan min/max and IS the thing the comp split divides between the LO and the company.

**"Total margin"** in the owner's example is the two added together: an LO who "wants to make 2.25" produces a **2.50 total margin** = `250` (company) + `2250` (LO). The LO states only HIS number; the company's `250` is always added behind it.

This maps onto the existing engine cleanly: `pricing.priceRung` already computes `price = base − Σadjustments − margin − comp + srp` (cost-positive, milli-points). The **company holdback** flows through the existing `marginMilli` subtraction slot (the "always subtract, never optional" number). The **LO back margin** flows through the existing `compMilli` (LPC) slot when in lender-paid mode. The **LO front margin** is an origination charge that does NOT touch the price at all — it is collected from the borrower as points at closing.

> **Note on the existing two knobs.** `settings.js` today defines BOTH `pricing.margin_milli` (250, resolvable per investor) AND `pricing.holdback_milli` (250, carried but not yet applied to price), plus the legacy `pricing.correspondent_margin_milli` (250, the one `quote.js` actually subtracts). The company holdback in THIS model is the "always-subtracted, non-overridable, company-kept" number. **Open question #5** below asks the owner whether the 0.25 is the SAME number the engine already subtracts, or an ADDITIONAL 0.25 — that decision picks which of these slots the holdback occupies and whether the LO back margin uses the other.

---

## 2. The money stack, in order (a) — with a worked end-to-end example

The stack is applied top to bottom. Every layer is a named, resolvable number.

```
Layer 0  INVESTOR RAW PRICE            investorRawMilli        (from Lender Price / the LT grid rung, post-LLPA)
Layer 1  − COMPANY HOLDBACK            companyHoldbackMilli    (250, non-overridable, company keeps 100%)
Layer 2  LO MARGIN, split:             loMarginMilli           (default 2000, LO-overridable)
             ├─ loBackMilli            (rebate: subtracted from price in lender-paid mode)
             └─ loFrontMilli           (origination: charged to borrower as points, NOT in price)
Layer 3  MIN / MAX CLAMP (dollars)     clamp LO comp to [minDollars, maxDollars] → adjusts loMarginMilli
Layer 4  COMP SPLIT                    loSplitPct on the LO compensation only (NEVER on the holdback)
Layer 5  RESULT                        loNetDollars, companyNetDollars, breakdown "in the back"
```

The displayed price the LO sees on Lender Price is always:

```
displayedPriceMilli = investorRawMilli − companyHoldbackMilli − (loBackMilli if lender-paid, else 0)
```

### Worked example A — Borrower-paid (par + origination), the DEFAULT path

The LO defaults to points (front / borrower-paid). Loan amount **$400,000**.

| Step | Value | Notes |
|---|---|---|
| Investor raw price (Layer 0) | **100.250** (`100250`) | The rung's price after LLPAs. |
| − Company holdback (Layer 1) | − 0.250 (`250`) | Non-overridable. Company keeps 100% of it. |
| **Displayed price on Lender Price** | **100.000** (par) | "it prices at 100 with our holdback — the investor is really 100.25." ✓ |
| LO margin (Layer 2) | 2.000 (`2000`), all FRONT | `loFront=2000`, `loBack=0`. Priced at par → no rebate. |
| Borrower pays (origination) | 2.000 pts = **$8,000** | 2% × $400,000. Charged at closing; does NOT change the 100.000 price. |
| Min / max (Layer 3) | none binding | company min say $2,000 ≤ $8,000 ≤ max $50,000. |
| **Company gross on the file** | holdback $1,000 + origination $8,000 = **$9,000** | 0.250 × $400,000 = $1,000. |
| Comp split (Layer 4), LO split = 60% | LO 60% × $8,000 = **$4,800** | Split is ONLY on the $8,000 origination. |
| Company net | 40% × $8,000 + 100% × $1,000 = **$4,200** | Company keeps its whole $1,000 holdback + 40% of origination. |
| **LO NETS** | **$4,800** | Shown "in the back" on the file. |

### Worked example B — Lender-paid (zero origination, price at 102), the buy-up path

Same loan **$400,000**. The LO wants his entire 2.00 in the BACK. Amount baked into the price = LO 2.00 + company 0.25 = **2.25**.

| Step | Value | Notes |
|---|---|---|
| Investor raw price (Layer 0) | **102.250** (`102250`) | A higher (worse-rate) rung chosen so the rebate funds the comp. |
| − Company holdback (Layer 1) | − 0.250 (`250`) | Always. |
| − LO back margin (Layer 2, loBack) | − 2.000 (`2000`) | Baked in as lender-paid comp (the `compMilli` slot). |
| **Displayed price on Lender Price** | **100.000** | "the investor's 102.25 shows on his price as 100, keeping 2.25 in the back." ✓ |
| Borrower pays origination | **$0** | Zero origination; closes at par. |
| Company holdback | 0.250 = **$1,000** | 100% company. |
| LO back margin | 2.000 = **$8,000** | Earned as rebate. |
| Comp split (Layer 4) | **see Open Question #1** | If split applies to back margin too (sensible reading): LO 60% = **$4,800**. If split is front-only (literal reading): LO keeps 100% = **$8,000**. |

### Worked example C — Minimum binds

Loan **$100,000**. LO standard 2.00 = $2,000. LO's own min = **$3,000**. Since $2,000 < $3,000, bump to $3,000 = **3.000 points**. Borrower-paid → 3 pts origination = $3,000. Holdback 0.250 = $250 (separate). Split 60% → LO nets **$1,800**. "instead of his standard 2 points he makes a minimum of 3 points ($3000)." ✓

### Worked example D — Maximum binds

Loan **$5,000,000**. LO standard 2.00 = $100,000. Max = **$50,000**. Cap to $50,000 = **1.000 point**. 1 pt origination = $50,000. Holdback 0.250 = $12,500 (separate). "$5,000,000 loan with a $50,000 max = only 1 point." ✓

---

## 3. Data model (b) — company defaults + per-LO settings + non-overridable 0.25 + min/max + split

The whole knob set fits the **existing** LT settings architecture (`lt_ppe_setting_definition` / `lt_ppe_setting_value`, resolved by `settings.resolve` with layering tenant → org → product-default). We add new setting DEFINITIONS and one new SCOPE, mirroring how per-investor margin already works under scope `investor:<code>` (`store.investorScope`). No new "knob table" is required.

### 3.1 New setting definitions (product defaults; all pre-filled with OUR chosen values)

| Key (candidate) | Type / unit | Default | Overridable by LO? | Meaning |
|---|---|---|---|---|
| `pricing.company_holdback_milli` | number, milli-points | `250` | **NO — hard block** | The 0.25 company margin holdback. Always subtracted; company keeps 100%. |
| `comp.lo_margin_default_milli` | number, milli-points | `2000` | yes | The LO's own margin (the 2.00 default). |
| `comp.lo_front_milli` | number, milli-points | `2000` | yes | Portion of the LO margin taken as FRONT origination. |
| `comp.lo_back_milli` | number, milli-points | `0` | yes | Portion taken as BACK rebate. (`front + back` should reconcile to the LO margin — see §5.) |
| `comp.lo_min_dollars` | number, cents | `0` (or a company floor) | yes | Per-loan minimum comp, in dollars. |
| `comp.lo_max_dollars` | number, cents, nullable | `null` (no cap) | yes | Per-loan maximum comp, in dollars. |
| `comp.lo_split_pct` | number, 0–100 | company-set (e.g. `60`) | (company-set per LO) | The LO's share of the LO compensation. Company keeps the remainder. |
| `comp.default_search_mode` | enum `borrower_paid` \| `lender_paid` | `borrower_paid` | yes | The comp type Lender Price is searched under. |

### 3.2 New scope for per-LO overrides

Add scope **`officer:<staffId>`** to `lt_ppe_setting_value`, resolved as `tenant` layer OVER the `company`/`org` layer OVER the coded product default — exactly the shape `store.resolveMarginHoldbackForInvestor` already uses for `investor:<code>`. A new resolver, e.g. `store.resolveCompPlanForOfficer(db, staffId, { loanAmount, mode })`, would:

1. `loadSettingOverrides(db, 'officer:<staffId>')` (tenant layer) and `loadSettingOverrides(db, 'company')` (org layer).
2. `settings.resolve` each `comp.*` key with `{ tenant, org }`.
3. **Refuse the holdback at the officer layer:** `pricing.company_holdback_milli` is resolved with `{ org }` ONLY — the `officer:` layer is not passed for that key, so an LO override of it can never take effect (fail-safe, mirroring how `validateValue` silently skips an invalid override).
4. Return `{ companyHoldbackMilli, loMarginMilli, loFrontMilli, loBackMilli, loMinDollars, loMaxDollars, loSplitPct, mode, defaults: {...sources} }` — including WHERE each number resolved from (officer / company / product), the same provenance record `resolveMarginHoldbackForInvestor` already returns.

### 3.3 Per-file computed comp record (the "LO sees in the back")

A new table, e.g. **`lt_ppe_comp_breakdown`**, one row per priced/locked scenario, recording the resolved stack so the LO and admins can always see it:

```
lt_ppe_comp_breakdown
  id
  quote_id / lock_id            (FK to the LT quote/lock the breakdown belongs to)
  officer_id                    (the staff_users id — SHARED identity zone, read-only)
  loan_amount_cents
  mode                          borrower_paid | lender_paid
  investor_raw_milli
  company_holdback_milli        (always 250 unless the company changed the setting)
  lo_margin_milli               (AFTER the min/max clamp)
  lo_front_milli
  lo_back_milli
  min_applied_dollars_cents     (null if the min did not bind)
  max_applied_dollars_cents     (null if the max did not bind)
  lo_split_pct
  lo_net_cents                  (what the LO makes on this file)
  company_net_cents             (holdback + company's share of the comp)
  displayed_price_milli
  computed_at
```

This is the durable answer to "the LO can always see in the back how much he is making on a file." It is a RECONSTRUCTION record (like the existing `pricingBasis` in `quote.js`), never a source of truth for the price itself.

---

## 4. Mapping to the two Lender Price search modes (c)

The LT Lender Price client already always sends `compensationType = 'BorrowerCompPlan'` (`search-model.js` line 683/954, `client.js` line 1023) and knows the sign-inverted `brokerCriteria.compPlan` convention (`compPlanValue(pct) = pct === 0 ? 0 : -pct`, §31.5). `field-registry.js` already maps `BorrowerPaid → BorrowerCompPlan` and `LenderPaid → LenderCompPlan` (`COMP_TYPE`, line 217). So both modes are already expressible; we only need to choose WHICH comp value to send.

### Borrower-paid mode (the default — always searchable this way)

- **`compensationType = 'BorrowerCompPlan'`** (the current default).
- **`brokerCriteria.compPlan = compPlanValue(0.250)` = `-0.25`** — the comp we bake into the price is ONLY the company holdback, so the returned price already nets our 0.25 and nothing else. (Per requirement #8: "the pricing shown = the lender's RAW pricing + our 0.25 margin holdback.")
- The LO's 2.00 is NOT sent to Lender Price. Our system adds it AS AN ORIGINATION CHARGE on top of the returned par price (requirement #8: "then our system puts the ORIGINATION charges on top").
- Result: the price shows par (raw − 0.25), the borrower pays the LO's points at closing.

### Lender-paid mode (buy-up / rebate)

- **`compensationType = 'LenderCompPlan'`** (via a scenario `compensationType: 'LenderPaid'` → `COMP_TYPE`).
- **`brokerCriteria.compPlan = compPlanValue(0.250 + loBack)`** — e.g. `compPlanValue(2.25) = -2.25` — so the FULL 2.25 (holdback + the LO's entire back margin) is baked into the price. (Requirement #4: "his ENTIRE markup in the back... 2.25 total incl. the 0.25... 102.25 shows on his price as 100, keeping 2.25 in the back.")
- The LO charges zero origination; everything is earned in the back.

**Summary of what we send per mode:**

| | Borrower-paid | Lender-paid |
|---|---|---|
| `compensationType` | `BorrowerCompPlan` | `LenderCompPlan` |
| `compPlan` (sign-inverted) | `−(companyHoldback)` = `−0.25` | `−(companyHoldback + loBack)` = e.g. `−2.25` |
| Borrower pays origination | LO front margin as points | $0 |
| Price shown | raw − 0.25 | raw − (0.25 + loBack) |
| LO margin lives in | FRONT (added by us on top) | BACK (baked into price) |

A new scenario field `compensationPercent` (feeding `compPlan` through the existing `field-registry`/`compPlanValue` path) carries whichever value the mode selects. In both modes the holdback component is present and non-removable.

---

## 5. Min "$ per loan" and Max "$ per loan" → points at a given loan size (d)

Min/max are stated in DOLLARS; margin is in POINTS. The conversion is exact and integer-safe:

```
pointsMilli(dollars, loanAmount) = round( dollars / loanAmount × 100000 )     # 100000 milli = 100 points = 100%
```

- **Minimum:** `minMilli = pointsMilli(loMinDollars, loanAmount)`. If `loMarginMilli < minMilli`, bump `loMarginMilli = minMilli`.
  - Owner example: $3,000 on $100,000 → `3000 / 100000 × 100000 = 3000` milli = **3.000 points**. LO's standard 2.000 < 3.000 → bumped to 3.000. ✓
- **Maximum:** `maxMilli = pointsMilli(loMaxDollars, loanAmount)` (skip if `loMaxDollars` is null). If `loMarginMilli > maxMilli`, cap `loMarginMilli = maxMilli`.
  - Owner example: $50,000 on $5,000,000 → `50000 / 5000000 × 100000 = 1000` milli = **1.000 point**. LO's standard 2.000 > 1.000 → capped to 1.000. ✓

Guardrails on the conversion: `loanAmount > 0` (else no clamp — fail closed, never divide by zero); the clamp is applied to the LO margin ONLY, never to the holdback; the result is re-integerized in milli-points. After the clamp, `loFront`/`loBack` are re-derived — **see Open Question #3** for how the delta is distributed between front and back.

Company default min/max vs LO min/max: the company sets defaults; the LO overrides them in his `officer:` scope (requirement #7). **See Open Question #2** on whether the company min/max is ALSO a hard floor/ceiling the LO can never cross.

---

## 6. Invariants / guardrails (e)

1. **The 0.25 is never removable.** `pricing.company_holdback_milli` is resolved without the `officer:` layer, so no LO override reaches it. It is always subtracted from the investor price (Layer 1) before any displayed number. Enforced structurally (the resolver never passes the officer layer for that key), not by a check that could be bypassed.
2. **The holdback is never split.** The comp split (`lo_split_pct`) is applied ONLY to the LO compensation (Layer 2 dollars). The company keeps **100%** of the holdback, always. The split math must read the LO-comp dollar figure, never the holdback dollar figure.
3. **The holdback is never clamped.** The min/max (Layer 3) act on the LO compensation only. The dollar min/max the owner described is the LO's earning floor/ceiling; the holdback sits outside it (Open Question #4 confirms whether the owner agrees).
4. **Front + back reconcile to the LO margin.** `loFrontMilli + loBackMilli === loMarginMilli` after the clamp. A configuration where they disagree is rejected (fail closed), the same discipline `resolveMarginHoldback` uses to ignore a garbage override.
5. **Milli-point integers only.** No floats anywhere in the stack (matches `pricing.js` §3). Dollar figures are integer cents.
6. **Fail-safe resolution.** An unreadable setting or a bad override degrades to the company default, which degrades to the coded product default — never to nothing (mirrors `store.resolveMarginHoldbackForInvestor` and `settings.resolve`). Pricing never resolves to a NaN or a missing margin.
7. **Displayed price is deterministic per mode.** `displayedPrice = raw − holdback − (loBack if lender-paid)`. In borrower-paid mode the LO's front margin is NEVER subtracted from the price — it is a separate origination charge to the borrower.
8. **LT-only, identity read-only.** `officer_id` points at the SHARED `staff_users` record (read-only from LT); no RTL comp code, table, or module is reused (product separation). This design references the RTL per-experience-tier markup pattern (`src/lib/pricing.js`, admin-set defaults + per-file overrides, inert-when-unset) only as a shape to imitate — it copies nothing.

---

## 7. Open questions for the owner (plain language)

1. **The split on the BACK money.** When a loan officer makes his money in the BACK (a rebate, zero origination), do we still split it with the company the same way we split the front origination? Or does the company's cut of the split only ever come off the FRONT origination charges, and the officer keeps 100% of anything he earns in the back? (This is the only thing that changes example B: LO nets $4,800 vs $8,000.)
2. **The company minimum — a floor nobody can cross, or just a starting number?** Is the company's minimum a hard floor that an officer can NEVER go below (so the officer's own minimum can only be HIGHER), or is it just a default the officer replaces with his own? Same question for the maximum.
3. **When the min bumps him up (2 → 3 points) or the max caps him down (2 → 1 point), where does the change land?** Does the extra (or the reduction) come out of the FRONT origination, the BACK rebate, or get spread across both?
4. **Does the 0.25 count toward the officer's minimum/maximum?** When we check "did he make at least $3,000" or "no more than $50,000," is that the officer's own money only, with the company's 0.25 sitting completely separate? (This design assumes: officer money only, 0.25 always separate.)
5. **Is the 0.25 the SAME cut the system already takes, or an EXTRA 0.25?** The engine today already subtracts a 0.25 "correspondent margin." Is the 0.25 company holdback the SAME number (so nothing is added), or is it a NEW 0.25 on top of what's already there?
6. **When the price is below par in borrower-paid mode.** If the investor's raw price is low enough that after our 0.25 holdback the price drops under 100, does the borrower simply pay the difference plus the origination, or do we stop at a floor (the engine already floors at 98)?
7. **Is the split figured on the rounded points or the exact dollars?** After rounding the price to the nearest eighth, do we compute the officer's split on the rounded number, or on the exact dollar amount before rounding?

---

## 8. How this slots into the existing engine (build notes, not built)

- **Layer 1 (holdback)** rides the existing `marginMilli` subtraction in `pricing.priceRung` (or the currently-carried-but-unapplied `holdbackMilli` slot in `quote.js`, once Open Question #5 picks which). `quote.js` already threads `marginHoldback` and carries `holdbackMilli` in `pricingBasis` awaiting exactly this formula.
- **Layer 2 back margin** rides the existing `compMilli` (LPC) slot in `priceRung` when in lender-paid mode.
- **Layer 2 front margin, Layers 3–5** are NEW pure logic (a `comp-plan.js` sibling to `margin-holdback.js`): resolve the officer plan, clamp in dollars, split, and emit the `lt_ppe_comp_breakdown` record. Keep it PURE (no DB/network) like `margin-holdback.js`, fed by a `store.resolveCompPlanForOfficer` DB bridge like `resolveMarginHoldbackForInvestor`.
- **Settings** are new `comp.*` + `pricing.company_holdback_milli` definitions in `settings.js` DEFINITIONS, plus the `officer:<id>` scope in the resolver.
- **Lender Price** needs one new scenario field (`compensationPercent`/mode) routed through the existing `field-registry` `COMP_TYPE` + `compPlanValue` path; the client already sends `compensationType` and the sign-inverted `compPlan`.

Every number above is a SETTING with our value pre-filled, nothing hardcoded — consistent with Rule #1 of the LT PPE (`settings.js` header).
