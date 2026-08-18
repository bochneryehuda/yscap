# R8 — Prepayment Penalty as (TYPE × TERM): a build blueprint for the LT DSCR PPE

**Scope:** Long-Term (LT) DSCR only (`src/longterm/**`). READ-ONLY research + design — nothing here is
built. This is the buildable spec for owner directives **D30, D31, D32, D33** (transcribed 2026-08-17).

**The one idea to hold:** a prepay penalty is not one value — it is a **TYPE** (how the penalty is
computed) crossed with a **TERM** (how many years it runs), and **every (type × term) has its own price
on the rate sheet**. Today the engine treats prepay as a single `prepayMonths` number and a loosely
mapped `prepayStructure` token; the sheet (`deephaven-dscr-sheet.js`) explicitly lists prepay-term
differentiation under `UNMEASURED`. This blueprint models the type × term properly, as data.

Grounding read before writing this: `deephaven-ppp-matrix.js` (Layer-3 state prohibition engine),
`margin-holdback.js` + `rules.js` + `rule-store.js` (the overlay vocabulary), `deephaven-dscr-sheet.js`
(Layer-1 sheet + LLPAs), `lenderprice/search-model.js` + `lenderprice/field-registry.js` (how prepay is
sent to LP today), and `COMPENSATION-MARGIN-MODEL.md` (the milli-point money conventions).

---

## 0. Two decisions this rests on (owner's exact intent)

1. **Prepay has a TYPE and a TERM, and every TERM is priced separately** (D30). So the atomic unit is a
   *structure* = (type, term, per-year step schedule). Each structure carries its own rate-sheet price.
2. **Two pricing models, both selectable** (D33): (a) **standard soft-declining** (the D31 library), and
   (b) a **5% Fixed PROMOTION** — less consumer-friendly but it earns a **better LLPA credit** on the rate
   sheet. "All three standard structures OR the 5% fixed."
3. **The Deephaven CUSTOM softer overlay is NOT an LP LLPA** (D32): the friendlier 3/3/3/2/1 (5yr) and
   3/3/2/1 (4yr) cost an extra **+0.375 (37.5 bps)** as an **additional MARGIN HOLDBACK** — a pricing
   hit, not a coupon hit — and it **does NOT and should NOT match LP**.

The critical architectural line, drawn once: **LLPA (on the sheet) matches LP; margin holdback (the
overlay) does not.** A structure LP can express and price is a sheet/LLPA concern (Layer 1–2). A softer
structure LP cannot express is an overlay-only margin-holdback concern (a separate layer that never
reconciles against LP). Getting a structure onto the wrong side is the one expensive mistake here.

---

## 1. DATA MODEL — a prepay structure as (type × term)

A structure is a plain data object. Every structure the owner listed is encoded below; nothing is a
special case in code.

### 1.1 The shape

```js
// A prepay STRUCTURE = (type, term, schedule). Pure data; no logic.
// {
//   key,            // stable internal id, e.g. '54321', '33321', 'int6_5', 'fixed5'
//   label,          // human label, e.g. '5/4/3/2/1'
//   termYears,      // integer 1..5 (the TERM). null = "any term" (a structure offered across all terms)
//   type,           // 'step_down' | 'interest_6mo' | 'flat' | 'fixed_percent'
//   schedule,       // per-year penalty %, e.g. [5,4,3,2,1]. For interest_6mo it is the per-year
//                   //   "6 months' interest" rule, not a % list (see typeParams).
//   typeParams,     // type-specific knobs (below)
//   pricingModel,   // 'standard' | 'fixed5_promo'  — which of the two D33 models this belongs to
//   tierSet,        // 'dh_published' | 'custom_deal' | 'custom_softer' | 'promo' | 'shared'
//   lp: {           // how it maps to Lender Price (null field = NOT expressible in LP)
//     prepayTermMonths,   // -> dynamicPropertiesMap.PrepayTerm  ("<n> Months" | "None")
//     planType,           // -> dynamicPropertiesMap.PrePayment_Plan_Type  (field-registry token) | null
//     smoMonths,          // -> SMO_PPP[months] special-mortgage-option
//   },
//   overlayOnly,    // true = LP cannot send this; it lives ONLY as a margin-holdback overlay
//   marginHoldbackDeltaMilli, // extra holdback for this structure (milli-points). 0 for LP structures.
// }
```

**Type flags (exactly the owner's four):**

| `type` | `typeParams` | Meaning |
|---|---|---|
| `step_down` | — | Per-year declining % from `schedule` (e.g. `[5,4,3,2,1]`): year-N penalty = `schedule[N-1]`% of the amount prepaid. |
| `interest_6mo` | `{ basisPct: 80, curtailmentPct: 20 }` | "6 months' interest": penalty = `(rate/2) × (basisPct% of outstanding balance)`, with `curtailmentPct%` of the balance freely prepayable each year without penalty. |
| `flat` | `{ pct }` | Same % every year of the term (e.g. 3% Fixed across the whole term — Deephaven's 2yr `[3,3]` and 1yr `[3]` reduce to this). |
| `fixed_percent` | `{ pct }` | A single fixed % for the whole term regardless of year (the 5% promo; the 2% Fixed 1-yr). Distinct from `flat` only in intent/pricing-model: `fixed_percent` is a promo/terminal fixed, `flat` is the standard 3% offering. |

**The 6-months-interest / 20%-curtailment mechanics, confirmed via industry sources** (so the data model
is faithful): the "California-style" 6-months-interest penalty is `(interest rate ÷ 2) × 80% of the
outstanding balance` — i.e. six months (half a year) of interest, charged on only **80%** of the balance
because **20% of the balance is freely prepayable each year without penalty** (the annual curtailment).
That is exactly `interest_6mo{ basisPct: 80, curtailmentPct: 20 }`. Step-down deltas and the fixed-vs-
declining trade-off are also as the owner described (a no-penalty / fixed option prices ~0.25–0.50%
worse; longer/declining structures price better). Sources at the bottom.

### 1.2 The full library (every structure the owner named)

```js
// src/longterm/ppe/ppp-structures.js  (PROPOSED — pure data + pure helpers, no DB/network)
const PPP_STRUCTURES = [
  // ---- STANDARD MODEL · Step-Down family (D31: "Step-Down 1–5yr") -----------------------------------
  // These are ALSO the "our custom-deal standard pricing tiers": 5/4/3/2/1, 4/3/2/1, 3/2/1, 2/1, 2.
  { key: '54321', label: '5/4/3/2/1', termYears: 5, type: 'step_down', schedule: [5,4,3,2,1],
    pricingModel: 'standard', tierSet: 'custom_deal',
    lp: { prepayTermMonths: 60, planType: '54321', smoMonths: 60 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: '4321', label: '4/3/2/1', termYears: 4, type: 'step_down', schedule: [4,3,2,1],
    pricingModel: 'standard', tierSet: 'custom_deal',
    lp: { prepayTermMonths: 48, planType: '4321', smoMonths: 48 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: '321', label: '3/2/1', termYears: 3, type: 'step_down', schedule: [3,2,1],
    pricingModel: 'standard', tierSet: 'custom_deal',
    lp: { prepayTermMonths: 36, planType: '321', smoMonths: 36 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: '21', label: '2/1', termYears: 2, type: 'step_down', schedule: [2,1],
    pricingModel: 'standard', tierSet: 'custom_deal',
    lp: { prepayTermMonths: 24, planType: '21', smoMonths: 24 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: 'fixed2_1yr', label: '2% Fixed (1yr)', termYears: 1, type: 'fixed_percent', schedule: [2],
    typeParams: { pct: 2 }, pricingModel: 'standard', tierSet: 'custom_deal',
    lp: { prepayTermMonths: 12, planType: 'Fixed2', smoMonths: 12 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },

  // ---- STANDARD MODEL · 6-Months-Interest family (D31: "2–5yr, 80% basis, 20% curtailment") ----------
  { key: 'int6_2', label: '6 Mo Interest (2yr)', termYears: 2, type: 'interest_6mo',
    typeParams: { basisPct: 80, curtailmentPct: 20 }, pricingModel: 'standard', tierSet: 'shared',
    lp: { prepayTermMonths: 24, planType: '6MosInt', smoMonths: 24 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: 'int6_3', label: '6 Mo Interest (3yr)', termYears: 3, type: 'interest_6mo',
    typeParams: { basisPct: 80, curtailmentPct: 20 }, pricingModel: 'standard', tierSet: 'shared',
    lp: { prepayTermMonths: 36, planType: '6MosInt', smoMonths: 36 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: 'int6_4', label: '6 Mo Interest (4yr)', termYears: 4, type: 'interest_6mo',
    typeParams: { basisPct: 80, curtailmentPct: 20 }, pricingModel: 'standard', tierSet: 'shared',
    lp: { prepayTermMonths: 48, planType: '6MosInt', smoMonths: 48 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: 'int6_5', label: '6 Mo Interest (5yr)', termYears: 5, type: 'interest_6mo',
    typeParams: { basisPct: 80, curtailmentPct: 20 }, pricingModel: 'standard', tierSet: 'shared',
    lp: { prepayTermMonths: 60, planType: '6MosInt', smoMonths: 60 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },

  // ---- STANDARD MODEL · Flat 3% (D31: "Flat, all terms: 3% Fixed") ----------------------------------
  // Offered at any term; the LP mapping picks PrepayTerm months from the chosen term. Modeled with
  // termYears:null and a term supplied at pricing time. Deephaven's published 2yr [3,3] and 1yr [3]
  // ARE this structure at terms 2 and 1.
  { key: 'flat3', label: '3% Fixed', termYears: null, type: 'flat', typeParams: { pct: 3 },
    pricingModel: 'standard', tierSet: 'shared',
    lp: { prepayTermMonths: null /* = termYears*12 at pricing time */, planType: 'Fixed3', smoMonths: null },
    overlayOnly: false, marginHoldbackDeltaMilli: 0 },

  // ---- DEEPHAVEN'S OWN PUBLISHED STANDARD TIERS (D31: 5/4/3/2/1, 5/4/3/2, 5/4/3, 3/3, 3) ------------
  // Different step schedules from our custom-deal tiers, at the SAME terms. 5yr = same as 54321 above.
  { key: '5432', label: '5/4/3/2', termYears: 4, type: 'step_down', schedule: [5,4,3,2],
    pricingModel: 'standard', tierSet: 'dh_published',
    lp: { prepayTermMonths: 48, planType: '5432', smoMonths: 48 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: '543', label: '5/4/3', termYears: 3, type: 'step_down', schedule: [5,4,3],
    pricingModel: 'standard', tierSet: 'dh_published',
    lp: { prepayTermMonths: 36, planType: '543', smoMonths: 36 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: 'dh_33', label: '3/3', termYears: 2, type: 'flat', typeParams: { pct: 3 },
    pricingModel: 'standard', tierSet: 'dh_published',
    // [3,3] === flat 3% over 2 years -> LP Fixed3 @ 24 months. There is NO '3,3' token in field-registry.
    lp: { prepayTermMonths: 24, planType: 'Fixed3', smoMonths: 24 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: 'dh_3', label: '3 (flat 1yr)', termYears: 1, type: 'flat', typeParams: { pct: 3 },
    pricingModel: 'standard', tierSet: 'dh_published',
    lp: { prepayTermMonths: 12, planType: 'Fixed3', smoMonths: 12 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },

  // ---- 5% FIXED PROMOTION (D33: better-pricing LLPA credit) -----------------------------------------
  { key: 'fixed5', label: '5% Fixed (promo)', termYears: null, type: 'fixed_percent', typeParams: { pct: 5 },
    pricingModel: 'fixed5_promo', tierSet: 'promo',
    lp: { prepayTermMonths: null /* termYears*12 */, planType: 'Fixed5', smoMonths: null },
    overlayOnly: false, marginHoldbackDeltaMilli: 0 /* NOT a holdback — a SHEET LLPA credit, see §4 */ },

  // ---- DEEPHAVEN CUSTOM SOFTER OVERLAY (D32: overlay-only, +0.375 holdback, 5yr & 4yr ONLY) ----------
  { key: '33321', label: '3/3/3/2/1', termYears: 5, type: 'step_down', schedule: [3,3,3,2,1],
    pricingModel: 'standard', tierSet: 'custom_softer',
    lp: { prepayTermMonths: 60, planType: null /* NOT expressible in LP */, smoMonths: 60 },
    overlayOnly: true, marginHoldbackDeltaMilli: 375 },
  { key: '3321', label: '3/3/2/1', termYears: 4, type: 'step_down', schedule: [3,3,2,1],
    pricingModel: 'standard', tierSet: 'custom_softer',
    lp: { prepayTermMonths: 48, planType: null /* NOT expressible in LP */, smoMonths: 48 },
    overlayOnly: true, marginHoldbackDeltaMilli: 375 },

  // No-PPP (kept for completeness; the state matrix in deephaven-ppp-matrix.js decides where PPP is
  // PROHIBITED, which forces this).
  { key: 'none', label: 'No PPP', termYears: 0, type: 'flat', typeParams: { pct: 0 },
    pricingModel: 'standard', tierSet: 'shared',
    lp: { prepayTermMonths: 0 /* -> PrepayTerm "None" */, planType: null /* -> PrePayment_Plan_Type null */, smoMonths: 0 },
    overlayOnly: false, marginHoldbackDeltaMilli: 0 },
];
```

### 1.3 How TYPE and TERM combine — and how each maps (or does NOT map) to LP

- **TERM → LP `PrepayTerm`** = `"<termYears*12> Months"` (or `"None"` for No-PPP). This is `effMonths`
  in `search-model.js` today (`setDyn('PrepayTerm', effMonths === 0 ? 'None' : \`${effMonths} Months\`)`).
- **TYPE → LP `PrePayment_Plan_Type`** = `lp.planType` — a `field-registry.PREPAY_STRUCTURES` token.
  Already wired: `mapPrepayStructure(sc.prepayStructure)` resolves the token; `search-model.js` sets
  `PrePayment_Plan_Type` from it (falling back to `'Standard'` for a positive term, `null` for No-PPP).
- **TERM → LP special-mortgage-option** = `SMO_PPP[smoMonths]` (e.g. 60 → `5 Yr PPP`), already pushed.
- **`planType: null` = NOT expressible in LP.** The two custom softer structures (33321, 3321) have no
  `field-registry` token and MUST NOT be sent as a made-up token (the standing "never invent a vendor
  token" rule). They ride LP as their *nearest priceable* term only (5yr / 4yr) and their softness is
  applied entirely by the margin-holdback overlay (§3). This is the "does NOT map to LP" case.

**field-registry coverage check (important, honest):** the registry already carries
`54321, 4321, 321, 21, 5432, 543, 5433, 54333, Fixed1..Fixed5, 6MosInt, Standard, StepDown, No Prepay`.
It does **NOT** carry `33321`, `3321`, a bare `3,3`, or a bare `3`/`2` single-year token. The library
above resolves the missing ones deliberately: `33321`/`3321` → `overlayOnly` (never sent), `3/3`/`3` →
`Fixed3` (mathematically identical), `2% Fixed 1yr` → `Fixed2`. **Do not add `33321`/`3321` tokens to
field-registry** — that would tell LP to price a structure it does not have and silently narrow the
lender set (the exact `DSCRRATIO`-token lesson in `search-model.js`).

---

## 2. Connection to the LP request (`search-model.js`)

Today `search-model.js` sends prepay from two scalars: `sc.prepayMonths` (→ `effMonths` → `PrepayTerm` +
`SMO_PPP`) and `sc.prepayStructure` (→ `mapPrepayStructure` → `PrePayment_Plan_Type`). The blueprint
replaces the loose pair with a **structure key + pricing model**, resolved through the library:

```js
// caller passes sc.pppStructureKey (e.g. '54321') and sc.pricingModel ('standard' | 'fixed5_promo').
const s = pppStructures.byKey(sc.pppStructureKey) || pppStructures.default(); // default = 54321, 5yr
const effMonths = s.lp.prepayTermMonths != null ? s.lp.prepayTermMonths : (s.termYears || 0) * 12;
setDyn('PrepayTerm', effMonths === 0 ? 'None' : `${effMonths} Months`);
setDyn('PrePayment_Plan_Type', s.lp.planType);   // null for No-PPP AND for the overlay-only softer ones
// SMO unchanged: SMO_PPP[effMonths] pushed as today.
```

### 2.1 Which structures LP can express (send to LP directly)

Everything with `overlayOnly: false` and a non-null `lp.planType` (or an explicit `null` meaning No-PPP):
`54321, 4321, 321, 21, fixed2_1yr, int6_2..5, flat3, 5432, 543, dh_33, dh_3, fixed5, none`. These are the
**standard soft-declining terms + the 5% promo**; LP prices them, and our sheet LLPA for them **should
match LP** (once the prepay LLPA is measured — see §4 and `UNMEASURED` in `deephaven-dscr-sheet.js`).

### 2.2 Which are OVERLAY-ONLY (LP cannot send them)

- **The custom softer structures `33321` (5yr) and `3321` (4yr)** — no LP token; LP is asked only for the
  5yr/4yr *term*, and the friendliness surcharge is applied as margin holdback (§3). **This is by
  design and MUST NOT match LP.**
- **Anything else LP can't send** (a future investor's bespoke schedule with no `field-registry` token)
  falls in the same bucket: price the nearest LP term, apply the difference as an overlay, never invent a
  token. The library's `overlayOnly` flag is the single switch that routes a structure here.

---

## 3. The CUSTOM margin-holdback rule (D32)

**Intent:** the friendlier 3/3/3/2/1 (5yr) and 3/3/2/1 (4yr) cost an extra **+0.375** as an **additional
margin holdback** (a pricing hit, not a coupon hit), moving the company-default holdback **0.25 → 0.625**.
Only 5yr and 4yr; 3/2/1-yr have no custom. It is a **selectable option** and an **overlay on top of LP**
that does **not** reconcile against LP.

### 3.1 The exact rule object (in `rules.js`/`margin-holdback.js` vocabulary)

`margin-holdback.js` consumes an ordered rule list of rows
`{ code?, when?, marginMilli?, holdbackMilli?, priority? }`, where `when` is a `rules.evalPredicate`
tree and **the first matching row that names a field wins for that field** (it SETS, does not add).

```js
// A per-scenario margin_holdback_rules row (settings pricing.margin_holdback_rules), Deephaven scope.
{
  code: 'dhvn_custom_softer_ppp_holdback',
  priority: 10,
  when: {
    all: [
      { fact: 'ppp_structure_key', op: 'in', value: ['33321', '3321'] },
      { fact: 'ppp_term_years',    op: 'in', value: [5, 4] },   // belt-and-suspenders; 33321⇒5, 3321⇒4
    ],
  },
  // company default 0.25 (250) + 0.375 (375) overlay = 0.625 (625).
  holdbackMilli: 625,
}
```

**Facts the predicate reads** (added to the scenario facts bag): `ppp_structure_key` (the library key)
and `ppp_term_years` (the term). Both are ours — they are NOT LP tokens — which is exactly why this is an
overlay and not a sheet LLPA. `evalPredicate` **fails safe on a missing fact** (an unknown fact never
fires the override), so a scenario that does not carry a softer key can never accidentally get the +0.375.

### 3.2 How `margin-holdback.js` applies it

```js
const out = resolveMarginHoldback({
  marginMilli:   investorDefaultMargin,   // resolved elsewhere (per-investor); untouched here
  holdbackMilli: 250,                      // company default 0.25
  rules:         [/* the rule above, plus any other margin_holdback_rules */],
  facts:         { ppp_structure_key: '33321', ppp_term_years: 5, /* ...other scenario facts */ },
});
// => out.holdbackMilli === 625, out.holdbackSource === 'rule',
//    out.holdbackRule === 'dhvn_custom_softer_ppp_holdback', out.appliedRules includes it.
// margin is untouched (out.marginMilli === investorDefaultMargin, source 'default').
```

### 3.3 SET-vs-ADD — the one build note that must not be skipped

`margin-holdback.js` **sets** `holdbackMilli` to the rule value (first-match-wins); it does **not add** a
delta. The owner's "0.25 → 0.625" is a resolved SUM, so the rule carries `holdbackMilli: 625`. That is
correct **only while the company default is 250**. Two honest options:

- **(A, minimal)** keep `holdbackMilli: 625` literal, and generate the rule from the library so the
  literal is derived (`companyDefault + structure.marginHoldbackDeltaMilli`), never hand-typed. If the
  company default ever changes, regenerate.
- **(B, structural, preferred long-term)** extend `margin-holdback.js` with an additive slot
  `holdbackDeltaMilli` (a rule that ADDS to the resolved default instead of replacing it), so the
  overlay is a true `+375` independent of whatever the investor/company default resolves to. This keeps
  the D32 semantics ("an ADDITIONAL holdback") exact. It is a small, well-scoped change to the pure
  engine and is the "highest-end" shape.

Either way the rule is **generated from `structure.marginHoldbackDeltaMilli`** in the library, never
hand-maintained — one definition, so it can't drift.

### 3.4 Where it does NOT go

It is **not** an entry in `deephaven-dscr-sheet.js` `llpaTables`, and it is **not** sent to LP. A sheet
LLPA would (rightly) be expected to reconcile against LP in the ≥200-scenario agreement gate; this
overlay must not, because LP has no concept of 3/3/3/2/1. Keep it strictly in the margin-holdback layer.

---

## 4. The 5% Fixed model (D33)

**Intent:** two selectable pricing models — standard soft-declining, **OR** the 5% Fixed promotion, which
is *less consumer-friendly but earns a BETTER LLPA CREDIT on the rate sheet*.

**Key distinction from D32:** the 5% Fixed IS an **LP LLPA** (LP can express `Fixed5`), so it lives on the
**sheet** and **SHOULD match LP** — the opposite of the custom softer overlay. It is a credit (a negative
cost = premium-positive improvement) keyed on the prepay structure.

### 4.1 How it reads off the rate-sheet LLPA credit

`deephaven-dscr-sheet.js` currently lists prepay-term differentiation under `UNMEASURED` ("the live run
always priced a 5-yr prepay"). The build adds a **prepay-structure LLPA table** to the sheet, populated by
a targeted measure sweep (send `Fixed5` and each step-down token to LP, capture the itemized adjustment).
Shape mirrors the existing `llpaTables` rows (cost-positive LP values, negated by `cost()` into
premium-positive):

```js
// Added to buildDeephavenGrid().llpaTables — MEASURED, never guessed (UNMEASURED today):
{ dimension: 'prepay', code: 'dhvn_prepay_fixed5', reason: 'Prepay - 5% Fixed (promo)',
  predicate: { fact: 'ppp_plan_type', op: 'eq', value: 'Fixed5' }, adj: cost(/* measured LP credit, e.g. -0.500 */) },
// ...one row per priced structure (54321 baseline 0, 4321/321/21 deltas, 6MosInt, etc.), all measured.
```

`cost(-0.500)` = `+0.500` premium-positive = a price IMPROVEMENT (the "better LLPA credit"). The exact
value comes from the LP capture, not this doc.

### 4.2 Representing "standard structures OR 5% fixed" as a selectable pricing model

Add a scenario field **`pricingModel: 'standard' | 'fixed5_promo'`** (already the `pricingModel` field on
each library structure). It drives two things and nothing else:

1. **The offered structure set** — when `standard`, the borrower may pick any of the three standard types
   (step-down / 6-mo-interest / flat 3%) at the eligible terms; when `fixed5_promo`, the structure is
   forced to `fixed5`.
2. **The sheet LLPA** — the `ppp_plan_type` fact carries the resolved LP token (`Fixed5` vs the standard
   token), so the prepay LLPA table above prices it. LP is sent `PrePayment_Plan_Type: 'Fixed5'`, so LP
   and our sheet agree.

No margin-holdback involvement — the promo's economics are entirely a sheet LLPA credit, which is why it
reconciles against LP while D32 does not.

---

## 5. HARD-RULE onboarding note (D30)

Every new investor is priced from **three dots** (rate sheet + eligibility matrix + PPP matrix). Add a
fourth mandatory intake question: **the PPP type × term set** the investor offers, and the pricing of
each. Drafted checklist entry (drop into the investor-onboarding checklist):

> **[ ] PPP TYPE × TERM SET (required — ask the owner, never guess).** For this investor, capture, per
> product:
> 1. **Which prepay TYPES are offered** — step-down, 6-months-interest (and its basis% + free-curtailment
>    %), flat, fixed-percent — and for each, **which TERMS** (1–5 yr) it is available at.
> 2. **The per-year step schedule** for every step-down structure (e.g. 5/4/3/2/1, 4/3/2/1, 3/2/1, 2/1).
> 3. **The rate-sheet price of every (type × term)** — every TERM is priced separately; capture the LLPA
>    or rate delta for each, verbatim from the investor's sheet (never inferred).
> 4. **Any promotional fixed structure** (e.g. 5% Fixed) and the **LLPA credit** it earns.
> 5. **Any custom softer structures we offer that the investor's LP profile can NOT express** (e.g.
>    3/3/3/2/1, 3/3/2/1) and the **margin-holdback surcharge** each carries (e.g. +0.375, 5yr & 4yr only).
> 6. **The state PPP prohibitions** already live in `deephaven-ppp-matrix.js` — confirm this investor
>    follows the same operational PPP matrix or capture its own.
>
> **Do not onboard the investor's pricing until this set is confirmed in writing.** A structure with no
> confirmed price is left out (honest "missing"), never priced at a guessed value.

---

## 6. Concrete, ordered build plan (`src/longterm/**`, incremental)

Each step is independently shippable and testable; nothing touches RTL; nothing is sent to LP that LP
can't express.

1. **`src/longterm/ppe/ppp-structures.js`** — the pure library from §1 (`PPP_STRUCTURES` + helpers
   `byKey`, `byTerm`, `standardSet`, `default`, `toLpFields(structure, termYears)`,
   `marginHoldbackDeltaFor(key)`). No DB, no network. **Test:** `scripts/test-lt-ppp-structures.js` —
   every structure round-trips to its LP fields; every `overlayOnly` structure has `planType: null`; no
   `overlayOnly` structure has a nonzero LP token; `33321`/`3321` carry `marginHoldbackDeltaMilli: 375`
   and `termYears ∈ {5,4}`; the two Deephaven tier-sets differ at the same terms; `flat`/`fixed_percent`
   pcts are as owner stated.

2. **field-registry alignment (no new tokens).** Assert in the test that every library `lp.planType` that
   is non-null EXISTS in `field-registry.PREPAY_STRUCTURES`, and that `33321`/`3321` are deliberately
   ABSENT (so nobody adds an invented token). This binds the library to the confirmed LP vocabulary.

3. **Overlay rule generation** — a small generator (in `ppp-structures.js` or a sibling
   `ppp-overlay.js`) that emits the D32 `margin_holdback_rules` row from the library
   (`companyDefault + marginHoldbackDeltaMilli`), so the `625` is derived, never literal. **Test:** feed
   the generated rule + a softer-structure facts bag through `resolveMarginHoldback` and assert
   `holdbackMilli === 625`, `holdbackSource === 'rule'`; assert a step-down/standard facts bag gets the
   default 250; assert a missing `ppp_structure_key` fails safe (default). Decide SET-vs-ADD (§3.3) — if
   choosing option B, add `holdbackDeltaMilli` to `margin-holdback.js` here, with its own fail-safe test.

4. **`search-model.js` plumbing** — accept `sc.pppStructureKey` + `sc.pricingModel`, resolve via the
   library, drive `PrepayTerm` / `PrePayment_Plan_Type` / `SMO_PPP` from `structure.lp` (keep the current
   `prepayMonths`/`prepayStructure` inputs working as a fallback for one release, then deprecate). Add
   `validateInputs` rejection for an unknown `pppStructureKey` (mirrors the existing `mapPrepayStructure`
   422). **Test:** structure key → exact `dynamicPropertiesMap` values; `fixed5_promo` sends `Fixed5`;
   `33321`/`3321` send the 5yr/4yr TERM with `PrePayment_Plan_Type: null` (never a fake token).

5. **Sheet prepay LLPA (`deephaven-dscr-sheet.js`)** — add the prepay-structure LLPA table (§4.1) with
   values from a **targeted LP measure sweep** (this is the measurement task that clears the
   `UNMEASURED` "prepay-term differentiation" line). Include the `Fixed5` promo credit. **Test:** the
   ≥200-scenario agreement harness must still tie to LP to the penny for every LP-expressible structure;
   the overlay-only softer structures are excluded from the LP agreement gate by construction (they carry
   no LP LLPA — only a margin holdback).

6. **Pricing-model selector wiring** — surface `pricingModel` end-to-end (standard vs fixed5_promo) so
   "all three standard structures OR the 5% fixed" is a real toggle; the standard model exposes the
   structure picker, the promo forces `fixed5`.

7. **Onboarding checklist (D30)** — land the §5 entry into the investor-onboarding checklist doc; wire a
   per-investor structure set into the rule/settings store (`rule-store.js` scope) so a new investor's
   type × term × price set is data, not code.

8. **Regression + separation** — every test is `scripts/test-lt-*.js`, LT-only; no RTL import; the
   product-separation CI gate stays green.

**Sequencing note:** steps 1–4 are pure/offline and can land first (they make the type × term real and
apply the D32 overlay). Step 5 depends on a live LP measure sweep and is the one step gated on data, not
code — until it lands, the sheet honestly reports "missing" for prepay-LLPA scenarios (as it does today).

---

## Sources (6-mo-interest / curtailment / step-down mechanics)

- [American Heritage Lending — DSCR prepayment penalties explained](https://ahlend.com/dscr-loan-prepayment-penalties-explained/)
- [Newfi — DSCR loan prepayment penalty: how they work](https://newfi.com/dscr-loan-prepayment-penalty/)
- [Harpoon Capital — Complete 2026 guide to DSCR prepayment penalties](https://harpooncapital.com/dscr-loans-guide/complete-guide-to-dscr-loan-prepayment-penalties)
- [Mo Abdel — DSCR prepayment penalty 2026: structures, costs & buydown](https://www.mothebroker.com/blog/dscr-loan-prepayment-penalty-guide-2026)
- [DSCRLens — DSCR prepayment penalty: what lenders don't tell you](https://www.dscrlens.com/guides/dscr-prepayment-penalty)
- Internal grounding: `deephaven-dscr-sheet-raw.txt` R65–R67 (Deephaven's own published Standard = 5yr 5/4/3/2/1, 4yr 5/4/3/2, 3yr 5/4/3, 2yr 3/3, 1yr 3% fixed).
