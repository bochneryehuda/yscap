<!--
LT-only. The margin & holdback layer of the Product & Pricing Engine — the deep plan.
Grounded in (a) Lender Price's ACTUAL response (`holdBackResult`), (b) the LLPA/rate-sheet industry
research already in docs/longterm/ppe-research/, and (c) the owner's directive of 2026-08-16.
Layer 1 (settings + resolver) is BUILT; Layers 2–6 are the plan. The final-rate money formula is
flagged as NEEDING THE OWNER'S EXACT NUMBERS before any wiring — never guessed.
-->

# PPE — Margin & Holdback: how a real PPE does it, and how ours will

**Status:** Layer 1 BUILT (per-investor margin + holdback settings, the pure resolver, the DB-backed
investor resolver, tests). Layers 2–6 planned. **The step that changes a borrower's final rate is a
MONEY rule and is NOT built — it waits on the owner's exact combine-formula.**

This is the margin/holdback companion to `PPE-MEGA-PLAN.md` §5 (the numeric pipeline) and §5.3 (the
verified 0.25 margin). It exists because the owner asked for something §5 only sketched: margin AND
holdback, **set per investor separately**, **pre-filled 0.250 but changeable**, **reaching every
investor**, and **able to carry a different margin and holdback for different scenarios under different
rules** (owner, 2026-08-16).

---

## 1. What the owner asked for, in their own words

> "the margin holdback should be set up for each and every Investor separately in the setting — it
> should be pre-filled 0.25 but it should be able to be changed, reaching every Investor. And it should
> be able to have different kind of margin and hold back to different kind of scenarios with different
> kind of rules."

Three requirements fall out of that sentence, and all three are things a *real* PPE already does:

1. **Two separate knobs — margin and holdback** — not one number.
2. **Per investor**, pre-filled 0.250, individually editable, and *every* investor is reachable.
3. **Per scenario, rule-driven** — a scenario can carry a different margin and/or holdback because a
   rule said so.

---

## 2. What Lender Price actually does (the real PPE, from its real response)

The captured Lender Price `searchRaw` response carries a dedicated block — this is the ground truth,
not a recording, verbatim from `docs/longterm/LENDERPRICE-RESPONSE-SCHEMA.md` §"Margin / holdback":

```
holdBackResult: {
  broker:   { adjustments: [ { key: "NDC Margin - 0.25%", type: "Margin", valueType: "Points", adj: 0.25 } ],
              qualifications, disqualifications },
  lender:   { adjustments: [ … ], qualifications, disqualifications },
  investor: { adjustments: [ … ], qualifications, disqualifications },
}
```

Read what that tells us — this is the "dive deeper into Lender Price" the owner wanted:

- **The margin the lender keeps IS "the holdback."** Lender Price uses the two words for the same
  retained-spread idea, and it lives in its OWN block, separate from the LLPA stack (`groupAdjustment
  Properties`) and from compensation (`borrowerPaid`/`lenderPaid`). So "margin" and "holdback" are two
  entries of the SAME structure, not two unrelated things — which is why our Layer 1 models them as two
  sibling settings that resolve the same way.
- **It is TIERED** — `broker`, `lender`, `investor` — each an independent set of `adjustments[]`. A
  price build can carry a margin at more than one level. Our owner's "per investor" is Lender Price's
  `investor` tier; our "company default" is the `lender` tier. (The `broker` tier is TPO/wholesale — not
  in scope for LT's correspondent flow today, but the shape leaves room for it.)
- **Each tier carries its own `qualifications` / `disqualifications`.** The margin is not a flat
  constant — it is a rule set. A holdback entry can even DISQUALIFY a program
  (`holdBackResult.*.disqualifications[]` appears in the disqualified tree, §5 of the schema doc). This
  is the industry proof of the owner's "different margin/holdback for different scenarios with different
  rules": Lender Price attaches conditions to each margin line.
- **Each entry is `{ key, type, valueType, adj }`** — a human-readable reason (`"NDC Margin - 0.25%"`),
  a type (`Margin`), a unit (`Points`), and a signed value (`0.25`). That is a `pricing`-shape rule in
  our rules engine, and its `key` is the reconstruction-record reason string.
- **Where it sits in the stack** (schema §4.5, industry §06): `raw investor price → LLPAs → (SRP) →
  margin/holdback → comp → borrower-facing rate/points`. Margin/holdback is applied AFTER the LLPA
  stack and BEFORE compensation. Positive = a cost that lowers price (raises the points/rate the
  borrower pays).

**The takeaway that shaped our build:** Lender Price does not treat margin as a global constant. It is a
tiered, rule-conditioned set of signed point adjustments with reasons and its own qualification logic.
Our per-investor + per-scenario-rules model is not an invention — it is the same shape, expressed in our
settings + rules engine.

---

## 3. The industry stack, and where margin/holdback lands

From `docs/longterm/ppe-research/06-llpa-rate-sheet-pricing.md` and the LOS research, the price build is
a stack of signed point transforms on a base price (par = 100; `points = 100 − price`):

```
Layer 1  base_price(coupon, product, lock_days)      the grid cell (par = 100.000)
Layer 2  + Σ LLPAs (FICO×LTV×DSCR, purpose, prepay,   the itemized adjustment stack (signed points)
           IO, units, property, loan amount, state…)
Layer 3  + SRP                                        servicing-released premium (raises price) — optional
Layer 4  − margin                                     OUR markup — the 0.250 seed (a SETTING)
Layer 4b − holdback                                   OUR retained buffer/spread per investor — 0.250 seed
Layer 5  − comp (if LPC)                              lender-paid comp subtracts; borrower-paid does not
         clamp(price, floor, cap_tier)                floor/ceiling LAST
         points = 100 − price                         positive = borrower pays; negative = credit
```

Everything is **integer milli-points** (250 = 0.250 point) — the one unit the whole PPE speaks
(`pricing.js`, `settings.js`). Margin and holdback are both COSTS on price under the cost-positive
convention: each subtracts from price (raises the points/rate the borrower pays) exactly like a positive
LLPA. `pricing.priceRung` already models a single `marginMilli` input this way; holdback is the second
cost line the owner added.

**Why holdback is DISTINCT from margin (and not just "a second margin"):** margin is our *markup* — the
spread we earn. Holdback is a *buffer/retained spread* held back per investor — a cushion against
reprice/execution risk on that investor's paper, or a retained sliver of the spread. They move
independently: an investor whose paper is volatile might carry a larger holdback at the same margin.
Modeling them as two knobs (rather than one summed number) means the reconstruction record can say WHY a
price moved — the crown-jewel invariant (§5.4 of the MEGA plan) — and an admin can tune one without
disturbing the other.

---

## 4. Layer 1 — BUILT (the settings + the resolver)

What shipped in this pass (all in `src/longterm/ppe/`, LT-only, pure where possible):

### 4.1 Two new typed settings (`settings.js`, group "Pricing")
- **`pricing.margin_milli`** — number, integer, 0–5000 milli-points, **default 250** (= 0.250 point).
  Our margin/markup, per-investor-resolvable.
- **`pricing.holdback_milli`** — number, integer, 0–5000, **default 250**. The retained buffer/spread.
- **`pricing.margin_holdback_rules`** — json array (default `[]`). The per-scenario override list. Each
  row: `{ code?, when?: <predicate>, marginMilli?, holdbackMilli?, priority? }`.

Both scalar settings are pre-filled at 0.250 exactly as the owner specified. `pricing.correspondent_
margin_milli` (the legacy single margin knob the existing pipeline reads) is left untouched and shares
the same 250 default, so **nothing about today's pricing changes** — the new `pricing.margin_milli` is
the knob the new resolver reads.

### 4.2 The pure resolver (`margin-holdback.js`)
`resolveMarginHoldback({ marginMilli, holdbackMilli, rules, facts })` → the EFFECTIVE margin + holdback
plus a full trace (which rule set each, the applied-rule list, and every unknown fact a predicate
touched). Properties, each backed by a test in `test-lt-ppe-margin-holdback.js`:
- No rules → the 0.250 pre-fill for both.
- **Margin and holdback resolve INDEPENDENTLY.** A rule may set one, both, or neither; the FIRST
  matching row that NAMES a field wins for that field, evaluated in `priority` order.
- Predicates use `rules.evalPredicate` (the same `all/any/none/not` + leaf-ops grammar the eligibility/
  LLPA engine uses) — **one rule grammar for the whole PPE**, no second DSL.
- **Fail-safe on a missing fact** — a rule over a fact the scenario lacks never fires, and the fact is
  surfaced in `unknownFacts` (nothing silent). This is the same discipline the LLPA engine uses: a rule
  can never invent a margin off a fact that isn't there.
- **Garbage degrades safely** — a bad rule VALUE (negative, non-integer) is ignored for that field; a
  bad DEFAULT degrades to the 250 product default; a non-object rule row is skipped. Pricing never
  resolves to nothing — only to the pre-fill.

### 4.3 The per-investor DB resolver (`store.js`)
`resolveMarginHoldbackForInvestor(db, investorCode, facts, companyScope='company')` layers, first hit
wins, exactly like every other setting in this PPE:

```
per-investor override (scope  investor:<code>)   →   company default (scope 'company')   →   product default (250)
```

then applies the per-scenario rules on top. It reuses `settings.resolve` for the layering and
`loadSettingOverrides` for the reads, so an unreadable table **degrades to the company scope, then to
the coded 250** — never to nothing. It returns the resolver record PLUS a `defaults` block naming which
layer each number came from (investor / company / product), so an admin can see at a glance whether a
number is this investor's own or inherited. This is the "reaching every investor" requirement: an
investor with no override of its own still resolves — to the company default.

Per-investor overrides are stored in the SAME `lt_ppe_setting_value` table under a distinct scope
`investor:<code>` (via `store.setSetting(db, 'investor:DHVN', 'pricing.margin_milli', 400)`), so the
whole existing validated write path (`setSetting` refuses an out-of-spec value) applies for free.

### 4.4 What Layer 1 deliberately does NOT do
It resolves the two NUMBERS and records how. **It does not touch the price.** No call in `pricing.js`
changed; the resolver is what a caller uses to work out WHICH margin/holdback applies to a scenario
*before* calling the pipeline. Margin already flows into `pricing.priceRung` via its `marginMilli`
input; holdback has no pipeline consumer yet — on purpose (see §5).

---

## 5. Layers 2–6 — the plan (NOT built; the money step needs the owner)

### Layer 2 — wire the resolved margin into the pipeline caller (LOW risk)
The façade that prices a scenario resolves `resolveMarginHoldbackForInvestor(...)` for the scenario's
investor + facts, and passes `marginMilli` into `pricing.priceRung`. This is a pure plumbing change —
`priceRung` already subtracts `marginMilli`. It changes today's behavior only if a per-investor or
per-scenario margin override is actually SET (none are seeded, so the 250 default keeps every price
identical). **This is safe to build without new money rules** because the margin math already exists and
is unchanged; only the SOURCE of the number becomes per-investor.

### Layer 3 — wire holdback into the final rate (⚠️ MONEY RULE — needs the owner)
Holdback has no pipeline consumer today because **how holdback combines into the final borrower rate is
a money rule I do not have and must not guess** (CLAUDE.md HARD RULE). The open questions for the owner,
each with the industry reading as a *starting point for the conversation only*:

1. **Is holdback a second cost line, exactly like margin?** Industry stack order (§3) and Lender Price's
   `holdBackResult` (§2) both put margin AND holdback in the same block, so the natural reading is
   `price = base − ΣLLPA − margin − holdback − comp + srp`. But whether YS's holdback lowers the
   borrower's price (a cost we pass on) or is retained out of OUR spread WITHOUT moving the borrower's
   quote is a business decision. **Confirm before wiring.**
2. **Does holdback reach the borrower-facing rate at all, or only the execution/margin math?** A
   "retained spread" can be invisible to the borrower (it comes out of what we net from the investor)
   or visible (it raises the quote). These price the loan differently. **Confirm.**
3. **Does holdback ever DISQUALIFY?** Lender Price's `holdBackResult.*.disqualifications[]` can make a
   program ineligible. Does a holdback rule ever gate eligibility for us, or is it price-only?

Until those are answered in the owner's own words, Layer 1's resolver stands ready (it computes the
holdback number and its provenance) and NOTHING consumes it in the price. This is the correct posture:
build the structure the owner specified, hold the money formula.

### Layer 4 — the admin surface (per-investor margin/holdback editor)
The PPE admin screen (§12 of the MEGA plan) gains a per-investor margin/holdback panel: for each
investor, the effective margin + holdback (with the layer badge: investor / company / product), an edit
that writes the `investor:<code>` scope override through `setSetting`, and a per-scenario rule editor
(the same rule-authoring UI the LLPA overlays use — one editor for the whole PPE). Pre-fills 0.250,
validates on the server, shows exactly what a scenario would resolve to (a live preview via
`resolveMarginHoldbackForInvestor`).

### Layer 5 — the reconstruction record carries margin AND holdback separately
`pricing.priceRung`'s output already keeps `marginMilli` as a separate component. When holdback is
wired, it becomes a sibling `holdbackMilli` component with its own reason line
(`"YS Holdback - 0.250%"`, mirroring Lender Price's `"NDC Margin - 0.25%"` key), so the crown-jewel
reconstruction record can say precisely how margin and holdback each moved the price — and the §10
parity harness can reconcile our `holdback` against Lender Price's `holdBackResult` line for line.

### Layer 6 — parity: reconcile our margin/holdback against Lender Price's `holdBackResult`
The parity harness (§10) already compares price builds. Add a margin/holdback comparison: our resolved
`{ marginMilli, holdbackMilli }` vs the sum of Lender Price's `holdBackResult.{lender,investor}.
adjustments[]` for that scenario. The verified 0.25 (§5.3) is the first assertion; per-investor
divergences become findings, not silent mis-prices.

---

## 6. How this maps, at a glance

| Owner's words | Lender Price's real structure | Our build |
| --- | --- | --- |
| margin **and** holdback (two knobs) | two entries in `holdBackResult.*.adjustments[]` (`type:"Margin"` …) | `pricing.margin_milli` + `pricing.holdback_milli` |
| **per investor**, reaching every investor | `holdBackResult.investor` tier | scope `investor:<code>` over `company` over product default |
| pre-filled 0.25, changeable | `"NDC Margin - 0.25%"` seed | default 250 milli; editable via `setSetting` |
| **different** margin/holdback per **scenario** with **rules** | each tier's `qualifications`/`disqualifications` | `pricing.margin_holdback_rules` + `resolveMarginHoldback` |
| (stack position) | `LLPAs → (SRP) → margin/holdback → comp` | Layer 4/4b in `pricing.priceRung` (cost-positive on price) |

---

## 7. Files (this pass)

- `src/longterm/ppe/settings.js` — `pricing.margin_milli`, `pricing.holdback_milli`,
  `pricing.margin_holdback_rules` (Pricing group).
- `src/longterm/ppe/margin-holdback.js` — pure `resolveMarginHoldback` (NEW).
- `src/longterm/ppe/store.js` — `investorScope`, `resolveMarginHoldbackForInvestor` (NEW).
- `scripts/test-lt-ppe-margin-holdback.js` — pure resolver test (NEW).
- `scripts/test-lt-ppe-margin-holdback-db.js` — investor-layering test, pure + DB round-trip (NEW).

Both suites are auto-discovered by `scripts/test-lt-ppe-all.js`.

---

## 8. The one thing to remember

**Layer 1 built the STRUCTURE the owner specified — two per-investor, per-scenario, rule-driven knobs,
pre-filled 0.250, reaching every investor, grounded in how Lender Price actually models this. It did not
build the step that changes a borrower's final rate, because that combine-formula is a money rule that
must come from the owner in their own words — never guessed.**
