# R7 — BASIC vs ADVANCED search + the OVERLAY-ON-TOP-OF-LP architecture

**Owner directives D28 + D29 (2026-08-17).** The build blueprint for the DSCR Quick Pricer's
BASIC/ADVANCED split and the independent Layer-2 overlay that can *override* Lender Price — but only
with a stated reason.

> D28: *"BASIC = the fields we already have (built + CSS'd). ADVANCED = a huge, searchable, unlimited
> set of advanced options: vacant, leased, declining market, first-time home buyer, first-time
> investor, short-term rental, rural, etc. Basic must EXCLUDE advanced disqualification."*
>
> D29 (the key insight): *"LP probably does NOT have all these advanced options. Even when LP returns
> ELIGIBLE, LP may not know the property is vacant / rural / STR. Our independent Layer 2 KNOWS and can
> OVERRIDE LP's verdict — but ONLY WITH A STATED REASON ('only if you know WHY I disagree with lender
> price')."*

This builds directly on `TWO-LAYER-ELIGIBILITY-ARCHITECTURE.md`, `RULE-CATALOG-AND-BUILDER.md`, and the
decoded matrix (`LP-DSCR-ELIGIBILITY-MATRIX.md` / `matrices/deephaven-dscr-matrix.json`). It names real
files, real functions, and real fact keys in this repo. It changes no code; it is the plan.

---

## 1. The defensible definition — what is BASIC, what is ADVANCED, and WHY

The split is **not cosmetic** (it is not "the fields we happened to build first"). It falls out of one
mechanical question: **does Lender Price actually receive and price on this fact?**

Three tiers, in order:

| Tier | Definition | LP sees it? | Fires an overlay decline/cut? | Where it lives today |
|---|---|---|---|---|
| **BASIC** | The core deal fields the LP request builder sends AND that appear in LP's live disqualify vocabulary. "LP priced it" is a *trustworthy* verdict here because LP has the fact. | **Yes** — sent by `search-model.buildSearch`, carried into engine facts by `lpScenarioToFacts`. | **Never** (req D28: basic excludes advanced disqualification). | `quick-pricer.html` §1–4; `SUPPORTED_FIELDS` core. |
| **ADVANCED — LP-visible options** | Extra options LP *does* price on (income doc, prepay structure, reserves, credit derogatories, DTI, self-employment…). Searchable, unlimited, but our Layer-2 does **not** override LP on them. | **Yes** — `field-registry.applyRegistry` maps each to an exact upstream path/token. | No (LP is authoritative; a disagreement is a normal shadow finding, not an override). | `REGISTRY_FIELDS` + the extra `SUPPORTED_FIELDS` (`incomeDocType`, `prepayStructure`, `reservesMonths`, `rentalTerm`, `escrowWaive`, `io`, `term`…). |
| **ADVANCED — overlay-only** | Facts LP **cannot see**, or where the published Deephaven matrix carries an overlay LP may **not apply**. Our Layer-2 KNOWS the published rule and, when the fact is supplied, its verdict **overrides** LP's — *with a citation*. | **No, or unconfirmed** | **Yes** — this is the D29 override set. | `deephaven-matrix.evaluateEligibility().unverifiable[]` — flagged, never enforced today. |

**Why this line is the right one.** Our current Layer-2 (`deephaven-matrix.js`) is sourced *only* from
the published matrix, so it can legitimately disagree with LP (see `TWO-LAYER-ELIGIBILITY-ARCHITECTURE.md`).
But `lpScenarioToFacts` (`lp-agreement-legs.js`) only emits **13 facts** —
`fico, ltv, dscr, loan_amount, value, purpose, state, property_type, units, prepay_months,
cashout_amount, interest_only, lock_days` (+`escrow_waiver`). So the matrix can only enforce rules over
*those* facts. Every rule it *knows* but *cannot fire* is parked in `unverifiable[]`:

```
Rural · Short-Term Rental · First-Time Investor · First-Time Homebuyer · Foreign National ·
Declining market · Vacant/Unleased · Renovation cash-out (seasoning) · Philadelphia PA ·
HI lava zones / Baltimore City · Loan < $100,000 delegated-only
```

**That list is the exact set of overlay-only ADVANCED facts.** BASIC is "the facts the pricer already
sends and LP prices"; overlay-only ADVANCED is "the facts LP never received, where the matrix has a
published rule we can enforce ourselves." The taxonomy is therefore *derived from the code*, not
invented: BASIC = `SUPPORTED_FIELDS` core ∩ `lpScenarioToFacts` outputs; overlay-only ADVANCED =
`unverifiable[]` + the `RULE-CATALOG-AND-BUILDER.md` "new-fact" gaps (§9, §Job-1 gap priority).

**Grounding BASIC precisely.** The `quick-pricer.html` form (already built + CSS'd) sends exactly:
loan purpose (`purposeSeg`), property value (`propValue`), LTV/loan (`ltv`/`loanAmt`), property type
(`propType`), units (`units`), zip→state/county (`zip`), FICO band (`fico`), borrower/title type
(`borrowerType`), DSCR (`dscr`). Occupancy is *locked* to Investment. Every one of these is a
`SUPPORTED_FIELDS` entry and every one is carried into `lpScenarioToFacts`. That is the BASIC set,
full stop.

**Basic excludes advanced disqualification — the mechanism (D28).** The matrix is already **fail-safe on
a missing fact**: a rule whose fact the scenario does not carry evaluates to *unknown* and never
declines (`deephaven-matrix.js` header; `rules.js` `_evalLeaf`). So a BASIC search — which supplies no
advanced facts — *automatically* fires zero overlay declines. We do **not** need a separate code path
to "turn off" advanced disqualification for basic; not sending the fact is the off switch. The build
adds one explicit guard on top of that (a `mode:'basic'` request never runs the overlay pass at all)
so the guarantee is stated, not merely emergent.

---

## 2. The exact ADVANCED facts to add (overlay-only set)

Each row: the **fact key** the rules/matrix read, the **scenario field** the caller sends, the
**data type / enum**, whether **LP sees it**, the **published overlay** it triggers, and which
**program** restricts it. Every overlay is already documented in `RULE-CATALOG-AND-BUILDER.md` (§9/§10)
and flagged in `deephaven-matrix.js` `unverifiable[]`; the numbers come from
`deephaven-dscr-matrix.json`. All apply to **Deephaven DSCR** today (the one live program); the
`programs` column is written so a second investor with a *different* overlay is a data edit, not a code
edit.

| Fact key (engine) | Scenario field (caller) | Type / enum | LP sees it? | Overlay (published rule) | Programs restricting |
|---|---|---|---|---|---|
| `occupancy` | `occupancy` | enum `leased \| vacant \| unleased` | **No** — not in `lpScenarioToFacts`, no confirmed LP token | Vacant → **ineligible** on R/T & C/O refi; unleased → **−5% LTV** on refi; 2+unit → max 1 vacant (R43/R47/R48) | Deephaven DSCR |
| `declining_market` | `decliningMarket` | boolean | **No** — appraisal-driven, LP has no input | **−5% LTV** (R64) | Deephaven DSCR |
| `first_time_homebuyer` | `fthb` | boolean | **Partial** — `fthb` is a `SUPPORTED_FIELD`, but LP's overlay is unconfirmed | **Ineligible** unless 2+ borrowers with ≥1 non-FTHB (R56) | Deephaven DSCR |
| `first_time_investor` | `firstTimeInvestor` | boolean | **Partial** — LP has the `FirstTimeInvestor:"true"` token, but only the *token*, not the matrix overlay | Min DSCR **1.00**, min FICO **700**, long-term rent only (R55) | Deephaven DSCR |
| `short_term_rental` | `rentalTerm='short'` / `shortTermRental` | boolean | **Partial** — LP has `Short_Term_Rental_Property`, overlay unconfirmed | Min DSCR **1.15**, min FICO **720**, **−5% LTV (75% max)**; no FTI/2+unit/rural; Property Guard (R28) | Deephaven DSCR |
| `rural_property` (+ `acreage`, `ag_use`) | `rural`, `acreage`, `agUse` | bool + number + bool | **Partial** — LP has a `rural` boolean, but not the 65% cut | **Max 65% LTV**, DSCR **>1.0**, long-term rent only, **≤10 acres** no ag/farm (R27) — *highest-value gap* | Deephaven DSCR |
| `foreign_national` / `citizenship` | `citizenship` | enum (7-value tenant set) | **Partial** — LP has the `Citizenship` token; the **FN grid row is absent from our L2 grid** | Own grid row: P/R&T **70%**, C/O **60%**, DSCR<1.00 N/A; min DSCR 1.00; **max loan $1.5M**; 6-mo reserves (R49) | Deephaven DSCR |
| `city` | `city` | string (already a `SUPPORTED_FIELD`, sent to LP for location — but LP prices on county, not city overlay) | **No** (as an overlay driver) | **Philadelphia, PA: −10% LTV** all occupancies (R69) | Deephaven DSCR |
| `geo_ineligible` (derived from `city`/zip) | derived | boolean (computed) | **No** | HI **lava zones 1 & 2**; **Baltimore City, MD** → **ineligible** (R70). *Note: DSCR sheet does NOT list NY ineligible.* | Deephaven DSCR |
| `subordinate_amount` | `subordinateLoanAmount` | number (already `SUPPORTED`; sent to LP) | **Yes to LP, No to Layer-2** — the rule `dhvn_subordinate` exists but the fact is **not emitted by `lpScenarioToFacts`** | Subordinate financing **not allowed** (R40) | Deephaven DSCR |
| `seasoning_months` (+ `renovation`) | `acquisitionDate`/`seasoningMonths`, `renovation` | number + bool | **No** | Renovation cash-out: appraised value under **6-mo ownership** at **max 75% LTV** (R35–R38) | Deephaven DSCR |
| `delivery_channel` | `deliveryChannel` | enum `delegated \| non_delegated` | **No** | Loan **< $100,000** → delegated delivery only (**advisory**, not a decline) | Deephaven DSCR |

Supporting facts the PPP layer (`program-deephaven-dscr.js` dot 3) already wants but that
`lpScenarioToFacts` does not yet emit — add them in the same pass: **`borrower_type`** (LLC/Individual/…,
already a `SUPPORTED_FIELD` `borrowerType`), **`apr`** (IL natural-person PPP rule), **`rural_property`**
(LA PPP rule — same fact as the rural overlay above). See `RULE-CATALOG-AND-BUILDER.md` §11.

Two facts already flow into Layer-2 and need **no** plumbing: `interest_only` and `cashout_amount` (both
emitted today; their overlays `dhvn_io_*` and `dhvn_cashout_*` already fire).

---

## 3. The OVERLAY reconciliation model — "LP says eligible BUT our overlay declines"

### 3.1 The core mechanic, reusing `disqualify-reconcile.js`

`disqualify-reconcile.reconcileScenario(our, lp)` already produces exactly the classification the
overlay needs. Its `lp_prices_we_decline` branch, when our decline dimension is in `OVERLAY_DIMENSIONS`,
returns `classification: 'legitimate_overlay'` — i.e. *"we decline for an overlay LP cannot verify."*
That is the D29 case, verbatim. `OVERLAY_DIMENSIONS` already holds
`declining_market, short_term_rental, first_time_investor, foreign_national, city, geo, rural,
occupancy, vacancy` — the overlay-only set from §2.

**What changes for the overlay architecture:** today the reconciler *records* the disagreement (for
ticketing); the overlay must *act* on it — our verdict WINS on the client-facing answer, **with the
stated reason attached**. The rule (D29, "only if you know WHY"):

> Our Layer-2 verdict overrides LP's **only** when (a) LP priced it, (b) our matrix declines or cuts
> LTV, (c) the decline is driven by an **advanced fact that was actually supplied** (not `unknown`), and
> (d) the decline carries a **citation** (matrix rule + effective date). Absent any of these, LP's
> verdict stands. This is a superset of the existing fail-safe: the matrix already never declines on an
> absent fact, so an unsupplied advanced fact can never trigger an override.

### 3.2 The response shape (per-product overlay block)

The price route (`POST /api/lt/dscr/price`, `dscr-pricer.js`) returns `programs[]`. Each program gains an
`overlay` block, produced by a new pure module `overlay-reconcile.js` that wraps
`reconcileScenario`:

```jsonc
"overlay": {
  "lpVerdict": "priced",                 // what LP said for this product
  "ourVerdict": "ineligible",            // Layer-2 matrix + PPP verdict
  "finalVerdict": "declined",            // what the client sees: "priced" | "declined" | "ltv_capped"
  "overrode": true,                      // did our overlay change LP's answer?
  "classification": "legitimate_overlay",// from disqualify-reconcile.js (agree | legitimate_overlay | lp_bug | our_encoding_bug)
  "source": "eligibility_matrix",        // "eligibility_matrix" | "ppp_matrix"
  "maxLtvMilli": 65000,                  // the overlay's tightened cap, when it is a CUT not a decline
  "reasons": [                           // the STATED reason — never an override without this array populated
    {
      "code": "dhvn_rural_ltv",
      "dimension": "ltv",
      "fact": "rural_property",          // WHICH advanced fact drove the disagreement
      "factValue": true,
      "declineReason": "Rural: Max 65% LTV (requested 75%)",
      "citation": "Deephaven Corr Flow DSCR matrix, eff 08/04/26 — Rural overlay R27"
    }
  ]
}
```

- **`finalVerdict = "ltv_capped"`** is the *bound* case (rural 65%, declining −5%, STR −5%, Philly −10%):
  the overlay does not decline the product outright; it tightens `maxLtvMilli`. If the requested LTV
  exceeds the cap, `finalVerdict` becomes `"declined"` with the reason "Max LTV X% exceeded". This is
  exactly the `rules.js` `bound` → auto-decline mechanic (§1 of `rules.js`).
- **`overrode` is the audit flag.** When `false`, LP's verdict is untouched (agree, or LP declined
  first). When `true`, `reasons[]` is guaranteed non-empty — the invariant the whole feature rests on.
- **`classification: 'lp_bug'`** (D-outcome: LP declines a fact the matrix says is fine) is *not* an
  overlay override — it is a ticket, per `TWO-LAYER-ELIGIBILITY-ARCHITECTURE.md`. The overlay block still
  carries it so the two flows share one code path, but the client answer stays LP's.

### 3.3 The batch/ledger side (no new tables)

For the offline agreement harness and the durable record, this rides the existing
`eligibility_discrepancy` finding kind proposed in `TWO-LAYER-ELIGIBILITY-ARCHITECTURE.md` — a
`legitimate_overlay` reconcile is recorded exactly like an `lp_bug`, distinguished by `classification`,
so the PPE scoreboard (`routes/ppe.js` `/findings`) can show an "overlay overrides" lane beside the
"probable LP bug" lane. No schema change.

---

## 4. Keeping ADVANCED searchable + unlimited — a data-driven registry

**Do not hardcode advanced fields into the HTML or the route.** Build one registry that drives the UI,
the request contract, and the fact→rule wiring at once — the same "generate, don't hand-maintain"
discipline the rest of this codebase uses (`SUPPORTED_FIELDS` grows *with* the builder, per its own
comment).

New module **`src/longterm/ppe/advanced-facts.js`** — a pure, exported catalog. One entry per advanced
fact:

```jsonc
{
  key: "rural_property",            // the engine fact key (what rules.js / the matrix read)
  field: "rural",                   // the scenario field the caller sends
  label: "Rural property",
  group: "Property & location",     // UI grouping + search facet
  keywords: ["rural","acreage","farm","agricultural"],  // powers the ADVANCED search box
  type: "boolean",                  // "boolean" | "enum" | "number"
  enum: null,                       // for enums: the option list (label→value)
  lpSees: "partial",                // "yes" | "no" | "partial" — drives the "LP-visible vs overlay-only" badge
  overlay: true,                    // true = Layer-2 may override LP with a reason
  programs: ["deephaven-dscr"],     // which programs restrict on it
  rule: "dhvn_rural_ltv",           // the rules.js rule code this fact drives
  citation: "Deephaven Corr Flow DSCR matrix, eff 08/04/26 — R27"
}
```

- **Searchable:** the ADVANCED panel renders every entry, grouped by `group`, filtered live against
  `label` + `keywords`. "Unlimited" = adding a fact is one registry row; the panel and the search index
  are generated from it. No `<input>` is hand-placed.
- **Contract in lockstep:** `SUPPORTED_FIELDS` (`dscr-pricer.js`) is *derived* by unioning the registry's
  `field`s with the existing core + `REGISTRY_FIELDS` — so a registry entry with no builder support is a
  test failure, never a silent 422. (The `unsupportedFields` guard in `dscr-pricer.js` already rejects an
  unknown field; the registry is what stops the two drifting.)
- **Composes with `rules.js` vocabulary:** each overlay is expressed as a rule in the *existing* shape
  (`RULE-CATALOG-AND-BUILDER.md` Job 2), `kind: 'eligibility'` (decline) or `kind: 'bound'` (LTV cut),
  `source: 'overlay'`, `origin: 'derived'`, `when: { fact, op, value }` reading the registry's `key`.
  Because tightening is min/max, an overlay **can only ever restrict, never loosen** — the guarantee
  `rules.js` gives for free (§`rules.js` header). The registry's `key` **must** equal the `fact` the rule
  reads; a test asserts every `advanced-facts` entry has a matching rule and vice-versa.

This is the same shape LoanPASS exposes as its no-code "rules-first eligibility / conditions / overlays"
surface (§5), so an owner-facing rule builder later drops straight onto it.

---

## 5. How comparable systems structure basic-vs-advanced + overlay eligibility

Real patterns from the PPE market, and how each maps onto this design:

- **LoanPASS** is explicitly *rules-first*: "eligibility, conditions, exceptions, and pricing logic"
  are modeled in a **no-code interface**, and **lender-specific overlays live inside the platform rather
  than in spreadsheets**. This is exactly our `rules.js` + `advanced-facts.js` registry: overlays as
  data, not code, most-restrictive-wins. ([loanpass.io](https://www.loanpass.io/),
  [tycoonstory](https://www.tycoonstory.com/the-7-best-mortgage-pricing-engines-for-conventional-non-qm-dscr-heloc-and-business-purpose-loans/))
- **Optimal Blue** delivers pricing across **150+ investors** and stresses that **overlays inside the
  platform reduce pricing errors when programs change** (vs spreadsheets). This validates the
  "generate the field list + overlays from one source of truth" discipline — the drift a spreadsheet
  causes is the drift we avoid by deriving `SUPPORTED_FIELDS` from the registry.
  ([optimalblue.com](https://www2.optimalblue.com/product-and-pricing-for-mortgage-lenders))
- **Lender Price** (our vendor) is matrices + a **disqualify tree** returning reason strings — which is
  precisely why our overlay reconciler is keyed on LP's disqualify reasons (`disqualify-crosswalk`,
  `disqualify-reconcile`) and why "LP priced it" is only trustworthy when LP *had* the fact.
  ([leadpops comparison](https://leadpops.com/blog/mortgage-pricing-engines-compared))
- **Polly** is a self-serve PPE where lenders "create loan products, set prices … eligibility criteria"
  themselves — the model behind letting the owner edit overlays via the rule builder.
  ([polly.io](https://polly.io/product-and-pricing-engine/))
- **LoanSifter (Optimal Blue)** is a **best-execution search across 120+ wholesale investors** with
  **advanced search filters** layered on a simple core query — the two-tier BASIC/ADVANCED search UX we
  are building, one narrow common query plus an expandable advanced filter set.
  ([setshape/loansifter](https://setshape.com/partners/loansifter))

The consensus across all five: **a small common query up front, an expandable advanced/overlay layer
behind it, overlays modeled as data inside the engine, and eligibility collected as a *set* of blockers
(not a single bit).** Our design is that pattern, with the extra twist the vendor split forces — our
overlay can *disagree with the pricing engine itself*, so every override must cite its rule.

---

## 6. Concrete, ordered build plan (files under `src/longterm/**`; each phase ships independently)

Every phase is a pure module + an offline test (the LT convention — `scripts/test-lt-*`), so nothing
waits on live LP credentials except the final battery.

**Phase 0 — Fact plumbing (unblocks everything).**
- `src/longterm/ppe/lp-agreement-legs.js` → extend `lpScenarioToFacts` to emit the missing facts:
  `occupancy`, `declining_market`, `first_time_homebuyer`, `first_time_investor`, `short_term_rental`,
  `rural_property`, `acreage`, `ag_use`, `citizenship`/`foreign_national`, `city`, `seasoning_months`,
  `renovation`, `delivery_channel`, `subordinate_amount`, plus the PPP facts `borrower_type` + `apr`.
  Keep every one **nullable** (fail-safe: absent → matrix skips the rule).
- Test: `scripts/test-lt-ppe-facts-pure.js` — each new field maps to the right fact key; an omitted
  field yields `null`; nothing shifts the existing 13 facts.

**Phase 1 — The advanced-facts registry.**
- New `src/longterm/ppe/advanced-facts.js` (§4 shape). Export `ADVANCED_FACTS` + `advancedFieldNames()`.
- `src/longterm/routes/dscr-pricer.js` → derive `SUPPORTED_FIELDS` by unioning `advancedFieldNames()`
  (no hardcoded growth).
- Test: `scripts/test-lt-ppe-advanced-registry-pure.js` — every registry `field` is in
  `SUPPORTED_FIELDS`; every `key` matches a fact emitted by `lpScenarioToFacts`; every `overlay:true`
  entry has a `rule` code and a `citation`.

**Phase 2 — Enforce the overlays in Layer-2.**
- `src/longterm/ppe/deephaven-matrix.js` → turn the `unverifiable[]` overlays into real
  declines (`kind:'eligibility'`) and LTV cuts (`kind:'bound'`), now that the facts exist. Each carries
  `code + dimension + citation`. Keep the fail-safe on an absent fact; a fact still absent stays in
  `unverifiable[]`. The FN grid row (§2) is added to `GRID` as its own FICO-independent row.
- Optionally express these as seeded `rules.js` rules (`source:'overlay'`) so the owner's future rule
  builder edits them as data — the matrix stays the citation source of truth.
- Test: `scripts/test-lt-ppe-overlay-rules-pure.js` — a rural scenario caps at 65k milli; a vacant R/T
  refi declines; declining/STR/Philly cut LTV by the exact deltas; **basic scenario (no advanced facts)
  fires ZERO overlay declines** (the D28 guarantee, proven).

**Phase 3 — The overlay reconciler.**
- New `src/longterm/ppe/overlay-reconcile.js` wrapping `disqualify-reconcile.reconcileScenario`, producing
  the per-product `overlay` block (§3.2) with the `overrode ⇒ reasons.length > 0` invariant and the
  `ltv_capped` / `declined` split.
- Extend `OVERLAY_DIMENSIONS` in `disqualify-reconcile.js` if any new dimension name is introduced.
- Test: `scripts/test-lt-ppe-overlay-reconcile-pure.js` — the four outcomes; override happens only with a
  supplied advanced fact + citation; an unsupplied fact never overrides; `lp_bug` never overrides.

**Phase 4 — Wire into the price answer.**
- `src/longterm/routes/dscr-pricer.js` `price()` (and/or `routes/ppe.js` `quoteRoute`) → after LP
  returns, run `evaluateProgram(facts)` (`program-deephaven-dscr.js`) per product, attach `overlay`,
  and when `finalVerdict !== 'priced'` mark the product declined/capped with `reasons`. Gate the whole
  pass behind `mode:'advanced'` (or "any advanced fact present") so a BASIC request never runs it.
- Test: `scripts/test-lt-dscr-overlay-route-*.js` — a basic body returns no overlay overrides; an
  advanced body (rural at 75% LTV) returns the product `ltv_capped` at 65% with the R27 citation.

**Phase 5 — The UI split.**
- `src/longterm/dscr-pricer/quick-pricer.html` → keep §1–4 as **BASIC** (unchanged, already CSS'd). Add a
  collapsible **ADVANCED** panel rendered from `ADVANCED_FACTS` (search box filtering `label`+`keywords`,
  grouped by `group`, an "LP-visible" vs "overlay-only" badge per field). The results view renders the
  `overlay.reasons[]` as a plain-language banner: *"Lender Price priced this, but we cap it at 65% LTV
  because the property is rural (matrix R27)."* Reuse the existing panel/field CSS.

**Phase 6 — Scenario battery + docs.**
- Extend the agreement scenarios (`ppe/agreement-scenarios.js` / `scenario-matrix.js`) with boundary
  cases per advanced overlay (rural at 66% vs 64%, vacant purchase vs refi, FN grid edges, Philly city,
  <$100k delegated advisory). Add a STATUS section to `TWO-LAYER-ELIGIBILITY-ARCHITECTURE.md` linking
  this doc.

**Sizing:** Phases 0–1 are a day (pure plumbing + registry). Phase 2 is the meat (encoding the overlays;
one rule at a time, each proven to fire). Phases 3–4 are the reconciler + one route wire. Phase 5 is
front-end only. Each phase is mergeable alone and leaves the pricer working (an un-enforced overlay
simply stays in `unverifiable[]`, exactly as today).

---

## 7. Invariants the build must not break

1. **LP stays the pricing authority.** The overlay changes *eligibility* verdicts and *LTV caps*, never
   a rate/price number. Pricing is LP's (shadow model, `facade.priceWithShadow`).
2. **No override without a reason.** `overlay.overrode === true ⇒ overlay.reasons.length > 0`, each with a
   `citation`. This is the D29 contract in one assertion.
3. **Fail-safe on a missing fact.** An absent advanced fact never declines and never overrides — basic is
   safe by construction (D28).
4. **One source of truth.** The advanced field list, the request contract (`SUPPORTED_FIELDS`), and the
   fact→rule wiring all derive from `advanced-facts.js`; a drift is a test failure.
5. **Independence preserved.** Layer-2 is sourced from the published matrix only; it must never import the
   LP-derived `deephaven-dscr-sheet.js` eligibility block (the existing structural guard).
6. **LT-only, pure.** Every new module is pure (no DB/network/clock), LT-only, no RTL imports.

---

*Sources:* [loanpass.io](https://www.loanpass.io/) ·
[Optimal Blue PPE](https://www2.optimalblue.com/product-and-pricing-for-mortgage-lenders) ·
[Optimal Blue vs Polly vs Lender Price (LeadPops)](https://leadpops.com/blog/mortgage-pricing-engines-compared) ·
[polly.io PPE](https://polly.io/product-and-pricing-engine/) ·
[LoanSifter (Shape)](https://setshape.com/partners/loansifter) ·
[Top 7 pricing engines (TycoonStory)](https://www.tycoonstory.com/the-7-best-mortgage-pricing-engines-for-conventional-non-qm-dscr-heloc-and-business-purpose-loans/)
