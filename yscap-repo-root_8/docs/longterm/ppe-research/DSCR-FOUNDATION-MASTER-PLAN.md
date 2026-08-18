# DSCR Foundation — MASTER PLAN (living document)

**This is the single saved plan. HARD RULE (owner 2026-08-17): nothing gets lost — every owner
instruction and every research-engine result is written here, and build progress is tracked here.**
Update this file whenever a directive arrives, a research engine returns, or a build step lands.

---

## 0. The mission + hard rules

Build the **first investor program — Deephaven DSCR — as solid rock**, then a **scalable foundation** to
onboard many investors × many programs fast. Every program is **three connected "dots"/layers keyed by
the investor name**:

1. **Rate sheet** — base pricing + LLPAs (pricing hits).
2. **Eligibility matrix** — the published product matrix (who qualifies / who is declined).
3. **PPP state matrix** — which states/borrower-types may carry a prepayment penalty.

**HARD RULES (owner-directed):**
- **SELLABLE / CONFIG-DRIVEN (top governing rule).** Nothing may be hardcoded or customized to US.
  Every customization is a PRE-FILLED setting that can be switched to any industry-standard option any
  company would want; our choices are seed/default DATA only. Build it like a product other lenders
  could buy. (Full: `02-config-driven-sellable.md`.)
- **NEVER GUESS A VENDOR TOKEN / silent-substitution ban.** A wrong token silently mis-prices (worse than
  a reject). Until a field is truly supported, REJECT it (422) — never silently ignore and price a
  different scenario. Use the vendor's real field dictionary for exact spellings; test independently
  before wiring; don't break what works. Validate locally first (a 422 makes zero upstream calls).
- **DSCR ONLY.** Work only from the DSCR tab of the matrix/rate sheet. Delete everything else
  (owner-occupied programs) so wrong rules never contaminate DSCR. (2026-08-17)
- **Don't trust Lender Price blindly on eligibility/ineligibility** — they can make mistakes. The second
  layer must be built INDEPENDENTLY from the published matrix so it can catch an LP mistake; when they
  disagree, flag it and open a ticket with Lender Price. (Our old envelope was reverse-engineered from
  LP's own disqualifiers, so it could never catch an LP bug — that is the whole reason for the rebuild.)
- **Prove it, don't assert it.** Run many qualifying AND disqualifying scenarios; pull LP's actual
  disqualify results and confirm each disqualifier reason matches our rule, per layer.
- **Match to the penny** on eligible pricing.
- **Every pre-filled rule must also be independently buildable by the owner** — build a massive rule /
  condition builder (like LoanPass, Polly, Lender Price, LoanSifter): eligibility, ineligibility, pricing
  hits, leverage cuts, margin/holdbacks with conditions/limitations/advancements, scoped to program /
  LTV / state / FICO / property-type / any dimension. Pre-filled rules seed it; users add their own.
- **Investor name is saved in the program name.**
- Product separation: LT code only in `src/longterm/**`, `lt_*` tables, `/api/lt/*`, tests `test-lt-*`.

---

## 1. Owner directives log (every instruction + status)

| # | Directive (paraphrased) | Status |
|---|---|---|
| D1 | Build the three layers (rate sheet + eligibility matrix + PPP) as REAL rules, not reference. | Layers built (§4) |
| D2 | Second layer independent from the published matrix; catch LP mistakes → tickets. | Built (deephaven-matrix.js) |
| D3 | $75k question: confirm from the matrix ($75k IS allowed for DSCR≥1.00 → LP is right). | Done + proven |
| D4 | PPP state matrix: NJ individual borrower → PPP prohibited; LLC allowed. Encode every state. | Built + proven |
| D5 | Connect the three dots under the investor name ("Deephaven DSCR"). | Built (program-deephaven-dscr.js) |
| D6 | Run many qualifying + disqualifying scenarios; pull LP's disqualify results; match reasons per layer. | **PENDING (task #45)** — needs LP session free |
| D7 | Three "dots" per program; every program needs all three. | Architecture set |
| D8 | Program is 1–4 units + condominiums only (5+ ineligible). | Built |
| D9 | Non-warrantable condos: check DSCR — 80% is the program MAX, not a cut. | Corrected (redundant caps removed) |
| D10 | DSCR-ONLY hard rule: delete owner-occupied sheets from saved data. | Done |
| D11 | Massive rule/condition builder (LoanPass/Polly/LenderPrice/LoanSifter style); pre-fill + user-buildable. | **Design in progress** (research engines) |
| D12 | Dig through the ENTIRE DSCR matrix for all property types + their LLPAs + every rule. | Done (full sheet read; overlays catalogued) |
| D13 | Developer write-up: request-builder fixes (AUS All, closing-cost flags, term loanYear, Prepay Buyout SMO, audit-mode rung digest). | **PENDING build (§5)** |
| D14 | Massive audits through all three layers vs LP; anything not matching → tell owner → open LP tickets. | **PENDING (task #45)** |
| D15 | Connect PPP + rate sheet + eligibility into ONE foundation per investor/program. | Program ties eligibility+PPP; foundation design done |
| D16 | Scalable foundation: onboard many investors × programs × rate sheets fast; run hundreds of scenarios each. | **Design done; build pending** |
| D17 | Maintain THIS saved plan; add every engine result + directive; audit all messages for anything missing. | This file + message-audit engine |
| D18 | **LO margin + compensation model:** 0.25 non-overridable company holdback margin; company default 2.00 origination; two ways to earn (par + front orig points OR zero orig + price-back/rebate at 102); each LO sets own front/back split; borrower-paid vs lender-paid comp search on LP; company AND per-LO MIN/MAX per loan ($3k min / $50k max examples); comp split only on origination charges, not the holdback; margin/holdback configurable per investor (pre-fill 0.25, changeable) with per-scenario overrides via rules. Full: `COMPENSATION-MARGIN-MODEL.md`, `PPE-MARGIN-HOLDBACK-PLAN.md`. | **PENDING** (§5) |
| D19 | **Daily change-detection + review queue:** auto-pull LP base-rate updates daily and apply; daily scenario battery to detect changes in eligibility/ineligibility/LLPAs/prepay/state rules/pricing/base rates; base-rate changes auto-apply, RULE changes go to a human review queue; scheduled 10/11/12 AM Eastern per investor. Full: `04-daily-sync-change-detection.md`. | **PENDING** |
| D20 | **Shadow → per-investor cutover:** our PPE runs alongside LP AND relies on LP in every scenario for now; a reliability tool emits findings on any disagreement; LP always wins for now → manual review to fix our PPE; after several weeks of no difference for an investor, roll THAT investor live without LP. | **PENDING** (partly: findings/scoreboard/cutover exist) |
| D21 | **200-scenario agreement gate BEFORE building a rate sheet in:** must agree with LP on ≥200 scenarios — every LLPA, eligibility, ineligibility, max/min price, to the penny — before a rate sheet is trusted. | **PENDING** (harness built; gate to run) |
| D22 | **White-label / hide the investor name:** client/front-end surfaces must NOT show the real investor name — each investor gets an INTERNAL program name (Diamond/Stone/Brilliant…). NOTE: this is compatible with D5 — the investor identity is stored internally (program name) but HIDDEN on borrower/TPO surfaces (the standing LT investor-block rule). | **PENDING** |
| D23 | **Overlays with front-end checkboxes** (e.g. NY CEMA — which investors do it, toggled by a checkbox); overlays layer on top of base rules. | **PENDING** (fits the rule builder D11) |
| D24 | **Excel-grid rule editor + Excel import:** each program editable as an Excel-like grid where every box is a rule; toggle grid view ↔ rules view; an import button that accepts only pre-configured investor Excel sheet types, to ingest new/updated rate sheets. | **PENDING** (fits D11) |
| D25 | **LP-connector contracts** (developer-confirmed): `dscr` missing/null → default **1.5** (nullish, preserve explicit 0) — a live bug that collapsed 439→28 rows, now fixed; **cash-out amount FAIL-CLOSED** (store internally, do NOT transmit until the vendor assigns a real code — the frontend doesn't send it; business meaning: cash-out = "cash in hand", too large → ineligible); purpose alias contract (Purchase→Purchase, Cash out→CashoutRefinance, Refinance→Refinance); permanent OAuth login (client_id acme2 + Basic client auth, in-memory token, refresh before expiry, re-login once on 401, never copy the browser token). Details in the parity status doc. | **Mostly done; verify** |
| D13a | **Frontend-parity request-builder fixes SHIPPED (2026-08-17, commit on branch):** §2.2 term parity (criteria.loanYear STAYS 30 = amortization; the selected note term rides termsCriteria only — frontend sends {loanYear:30, termsCriteria:[15]}); §2.3 AUS "All" forced to [DU,LP,GUS,MUW,None] unless the caller explicitly chooses AUS; §2.4 closing-cost flags forced true (useClosingCost + useCompanyDefaultClosingCost); §2.5 audit-mode rung digest (`audit:true` → full per-program rate ladder in the price response, counted truncation). Prepay Buyout SMO already carried via §37.10. | **DONE** (part of D13) |
| **D26** | **Reserve requirements + INFORMATIONAL product attributes surfaced per chosen product.** When a borrower/officer chooses a product, the system must know & display that product's reserve requirement AND other informational conditions — e.g. "this project needs a SECOND APPRAISAL", and similar. Informational overlay attached to each priced product (NOT a disqualifier — it's a condition/note the product carries). | **NEW — plan + research + build** |
| **D27** | **Vacant / leased occupancy is a real FACT.** Some programs allow vacant, some do not. Add occupancy-status (vacant / leased / owner-occupied-N/A…) as a first-class field; feed the Layer-2 eligibility overlay so a vacant-disallowing program declines a vacant scenario. | **NEW — plan + research + build** |
| **D28** | **BASIC vs ADVANCED search sections.** Basic = the current fields (CSS already set up; "we have a picture"). Advanced = a MASSIVE, searchable, unlimited set of advanced options: vacant, declining market, first-time home buyer, first-time investor, short-term rental, rural, … Basic must EXCLUDE advanced disqualification. Research (multiple engines) what belongs in basic vs advanced, and how to build a searchable advanced section. | **NEW — plan + research + build** |
| **D29** | **THE OVERLAY-ON-TOP-OF-LENDER-PRICE ARCHITECTURE (key insight).** Advanced eligibility is a LEVEL ON TOP OF LP. LP likely doesn't have all these advanced options; even when LP returns ELIGIBLE, LP may not know the property is vacant/rural/STR/etc. Our independent Layer 2 KNOWS and can OVERRIDE LP's verdict — but ONLY WITH A STATED REASON ("only if you know WHY I disagree with lender price"). This is exactly our Layer-2 matrix + `disqualify-reconcile.js` classifier, now fed the advanced overlay facts. Every disagreement must be explained + surfaced (and where it's an LP gap vs an LP bug, classified). | **NEW — the architecture; extends D2/D14/D29-arch** |
| **D30** | **PPP = TYPE × TERM per investor; HARD RULE to ASK the owner.** HARD RULE: for EVERY investor/program we add, ASK the owner what prepayment-penalty STRUCTURES (both the TYPE and every TERM) they offer. Every prepay term has its OWN pricing, published on the rate sheet (bottom). Research BOTH the prepay TYPE and every prepay TERM off the Deephaven rate sheet and connect to D31/D32. | **NEW — HARD RULE + research + build** |
| **D31** | **Standard PPP STRUCTURE LIBRARY (reusable across programs).** Deephaven STANDARD pricing model (soft declining) — the borrower may choose any of: **Step-Down (1–5yr):** 5/4/3/2/1, 4/3/2/1, 3/2/1, 2/1, and 2% Fixed (1yr); **6 Months Interest (2–5yr):** calculated on 80% of principal, allowing 20% annual curtailment without penalty; **Flat (all terms):** 3% Fixed. Build these as an AVAILABLE, reusable structure library (most will be reused across investors). Deephaven's own published standard tiers the owner named: 5/4/3/2/1, 5/4/3/2, 5/4/3, 3/3, 3. Our custom-deal standard tiers: 5/4/3/2/1, 4/3/2/1, 3/2/1, 2/1, 2. | **NEW — build the structure library** |
| **D32** | **Deephaven CUSTOM softer-PPP overlay = a MARGIN-HOLDBACK RULE (NOT an LP LLPA; does NOT match LP).** Our special unique deal: the softer/friendlier structures **3/3/3/2/1 (5yr)** and **3/3/2/1 (4yr)** cost an additional **+37.5 bps (+0.375)** — a PRICING hit, NOT a coupon hit — structured as an ADDITIONAL MARGIN HOLDBACK (company 0.25 → **0.625**). ONLY for 5-year and 4-year terms; on 3/2/1-year there is NO custom (standard only). The softer PPP is a selectable OPTION. This is an OVERLAY on top of LP (LP won't know it). Wire into the margin-holdback engine as a rule scoped to (structure ∈ {3/3/3/2/1, 3/3/2/1}) × (term ∈ {5,4}). | **NEW — margin-holdback rule** |
| **D33** | **Two Deephaven PRICING MODELS, both available:** (a) STANDARD (soft declining) with the D31 structures; (b) **5% Fixed** promotion — less consumer-friendly but you get a BETTER-pricing LLPA CREDIT on their rate sheet. It's "all three D31 standard structures OR the 5% fixed." Research the exact type × term pricing off the rate sheet LLPA grid. | **NEW — research + encode** |
| **D34** | **Delegate-only "EXCEPTION PRODUCT".** A product only available on the DELEGATE channel must be marked ELIGIBLE but flagged as an EXCEPTION PRODUCT: available ALWAYS (even on non-delegate) yet clearly, visibly noting it's delegate-only and needs a **super-admin EXCEPTION** — prominent enough that it's obviously "not simple." Add a channel/exception attribute to the informational product layer (D26) and surface it loudly on the priced product. ALL Job-1 deferred/new-fact gaps go into the ADVANCED section (D28). | **NEW — build** |
| **D35** | **Reconcile L1↔L2 divergences + targeted LLPA RE-MEASURE battery.** Divergences to fix: the flat **$75k** min should be **$200k for DSCR<1.00**; the flat **80/75/70** envelope vs the REAL 4-axis grid caps. **Loan-amount LLPA + prepay/IO/escrow LLPAs are UNMEASURED** → build a targeted re-measure battery against LP live to capture them (everything is on the rate sheet + matrix). Research engines: (a) loan sizes, (b) prepay / interest-only / escrow LLPAs. | **NEW — research + measure + reconcile (R10 done)** |
| **D36** | **LP LIVE is the SOURCE OF TRUTH for every open question.** For EVERY question/unclear qualifier/LLPA/disqualifier still open, RUN those scenarios on Lender Price live — push each to eligible/ineligible, read the eligibility AND the ineligibility — and let LP's own answer resolve what the matrix doesn't make clear. Open parallel research engines to run these batteries. (This is task #45 + the D35 re-measure, now the owner's explicit standing method for resolving unknowns.) | **NEW — live LP capture** |
| **D37** | **MAX + MIN pricing rule off the rate sheet — for EVERY investor.** Research the rate sheet's maximum and minimum pricing and SET it as a rule; this is needed for every investor we add. The rate-sheet research must find the prepay TERM + TYPE LTV adjustments too. | **NEW — research + rule** |
| **D38** | **"Every bingo thing" sweep.** Open a research engine to sweep the rate sheet + the matrix + the prepayment sections for anything not yet found, and make sure every single item is implemented (nothing left on the sheet/matrix un-encoded). | **NEW — exhaustive sweep** |
| **D32-fix** | **Softer-PPP holdback correction (2026-08-17):** the extra holdback is a SEPARATE **+0.375**, added on top of the 0.25 base — TWO holdbacks (0.25 + 0.375 = 0.625), NOT one merged 0.625. **DONE** (margin-holdback additive delta + generated overlay rules; ppp-structures.marginHoldbackDeltaMilli:375). | **DONE** |

---

## 2. The architecture

- **Layer 1 — Rate sheet** (`deephaven-dscr-sheet.js`): base ladder + LLPA tables (FICO×CLTV grid,
  DSCR band, state, cash-out, condo, 2-4 units). Sign rule: LP cost-positive → our premium-positive
  (`cost(v)=-v`). Proven 148/148 vs LP's own itemized values.
- **Layer 2 — Eligibility matrix** (`deephaven-matrix.js`): independent, from the published DSCR matrix.
  Max-LTV grid (loan tier × FICO floor × purpose × DSCR band; N/A = ineligible), min loan $75k/$200k,
  per-tier FICO floors 640/660/660, max loan $2.5M, min DSCR 0.75, cash-out caps $1M/$500k, small-loan
  75% cap, IO overlay, subordinate-not-allowed, 5+ units + row homes ineligible. Overlays needing new
  facts are FLAGGED unverifiable (rural, STR, FTI, FTHB, FN, declining, vacant, renovation, Philly, geos).
- **Layer 3 — PPP state matrix** (`deephaven-ppp-matrix.js`): a PPP requested where the state × (borrower
  × units × lien × loan × APR) is prohibited is a disqualifier; No-PPP never is. All restriction states.
- **The program** (`program-deephaven-dscr.js`): connects the dots under "Deephaven DSCR"; a scenario
  resolves against both eligibility layers, each decline labelled by layer.

**Facts** (engine vocabulary, `lpScenarioToFacts`): fico raw, ltv milli-%, dscr milli, loan_amount raw,
cashout_amount, purpose, property_type, units, state, interest_only. **Still to wire for full coverage:**
borrower_type, apr, prepay_months→prepay_requested, subordinate_amount, rural/STR/FTI/etc.

---

## 3. Research-engine outputs (summaries; full transcripts in session)

1. **Two-layer eligibility architecture** → `TWO-LAYER-ELIGIBILITY-ARCHITECTURE.md`. The reconciliation
   model (4 outcomes), the discrepancy classifier (agree / LP-bug / our-bug / legitimate-overlay,
   anti-cry-wolf), where it lives (agreement harness + findings ledger + PPE route), the ticket artifact.
2. **LP disqualifier forensics.** LP reports ineligibility by ABSENCE (0 programs), reasons in a separate
   `disqualifiedData` tree via a second poll. **The Deephaven disqualify tree was never captured (202
   timeouts)** — so the old envelope only echoes LP. Catalog of LP reason shapes + the mapping to
   dimensions. 9 live divergences found (our decline vs LP price at FICO 640/660/680 × cltv 80 cells).
3. **Matrix second-layer encoder design.** The full Layer-2 ruleset in our fact vocabulary; Option B
   (grid-cap resolver + derived fact) recommended; gap analysis vs the old flat envelope.
4. **Scalable program factory (foundation).** Layer 1 + overlays + margin/holdback are ALREADY
   data-driven (`lt_ppe_*` tables, `store.js`). The gap: generalize Layers 2 & 3 into DATA + pure
   compilers to the ONE `rules.js` vocabulary, unify under a 3-stream versioned registry, keep the
   hand-built Deephaven modules as the equivalence ORACLE. 9-step build sequence.
5. **Scaled per-program agreement harness.** Auto-generate qualify/disqualify scenarios from a program's
   own axes; the LP disqualify capture is ALREADY FIXED in the client (requestId echo + durable store +
   materialize) — stream/target the Deephaven leaf; per-layer disqualifier reconciler; audit-mode rung
   digest (deterministic hash of every rung → penny-level comparison); two-wave capture; one-command
   `certifyProgram`. 8-step build.
6. **Rule mining + condition builder** → `RULE-CATALOG-AND-BUILDER.md` (FULL detailed output saved).
   Job 1: every eligibility/ineligibility/LLPA rule across all three layers with exact numbers +
   encode-status. Job 2: the ONE unified rule shape (eligibility/bound/pricing/margin) + builder ops,
   mapped onto the existing `rules.js`/`rule-store.js`. **Newly-surfaced gaps:** rural is a REAL 65% cut
   and was NOT flagged; FTHB + vacant/unleased NOT flagged; subordinate rule encoded but its fact not
   emitted; the FN grid row is absent; a `boundOp:'delta'` op is needed for −5%/−10% relative cuts;
   the L1 flat envelope diverges from the L2 4-axis grid (a real reconcile target).
7. **Message audit** → cross-checked all owner messages vs the plan. Added the missing directives
   D18–D25 above (LO compensation, sellable/config-driven, daily change-detection, shadow→live cutover,
   200-scenario gate, white-label, overlays/CEMA, Excel editor, LP-connector contracts). Nothing lost.
8. **Basic vs Advanced + LP OVERLAY** (D28/D29) → `R7-BASIC-ADVANCED-OVERLAY.md`. **DONE.** BASIC = the
   13 facts LP prices on (`lpScenarioToFacts`); ADVANCED = LP-visible registry fields + OVERLAY-ONLY facts
   (already enumerated in `deephaven-matrix.evaluateEligibility().unverifiable[]`: vacant/leased, declining
   market, FTHB, FTI, STR, rural, FN, Philly/geo, subordinate, seasoning, <$100k delegated). Overlay override
   reuses `disqualify-reconcile.reconcileScenario` — hard invariant `overrode ⇒ reasons.length>0` each with a
   matrix citation. Searchable = a data-driven `advanced-facts.js` registry. 6 incremental phases.
9. **PPP TYPE × TERM structures + custom margin-holdback** (D30–D33) → `R8-PPP-TYPE-TERM-STRUCTURES.md`.
   **DONE + BUILT** (`ppp-structures.js`, `margin-holdback` additive delta). Structure = (type × term) data
   object; the two custom softer ones are `overlayOnly` with null LP token + 375 milli holdback delta.
10. **Reserves + informational products + delegate exception** (D26/D34) → `R9-RESERVES-INFORMATIONAL-PRODUCTS.md`.
    **DONE.** A third non-blocking `informational[]` layer: computable reserves (3mo ≤$1M / 6mo >$1M, DSCR<1.00→6),
    second appraisal (loan >$2M OR cash-out & loan >$1.5M), the D34 delegate exception (<$100k delegated → eligible
    but `kind:'exception'` in a separate loud array). 7-step build.
11. **Loan-size / prepay / IO / escrow LLPA re-measure + L1↔L2 reconcile** (D35) → `R10-LOANSIZE-PREPAY-IO-ESCROW-REMEASURE.md`.
    **DONE.** Two OFFLINE-fixable divergences (highest priority): (A) L1 flat $75k min ignores DSCR — must be
    $200k for DSCR<1.00 (`deephaven-dscr-sheet.js:140`); (B) L1 flat 80/75/70 vs the real 4-axis grid (L2 has
    it but is missing the FN row). The prepay/IO/escrow/loan-amount LLPAs need a live re-measure (the raw sheet
    carries no point values). 7-step plan.

### 3a. COMPLETE research-doc INDEX (every saved engine output — so nothing is lost)

Owner hard rule: every research engine's result is written down. This is the exhaustive index of the
saved research artifacts under `docs/longterm/ppe-research/` (full text in each file):

| Doc | What it holds | Feeds |
|-----|---------------|-------|
| `01-schema-architecture.md` | DB/schema architecture for a multi-tenant PPE. | Foundation (D16) |
| `02-config-driven-sellable.md` | Generic, config-driven, sellable multi-tenant PPE design. | Foundation / white-label (D16/D22) |
| `03-lock-secondary-market.md` | Lock & secondary-market workflow design (LLCK). | Lock/secondary (future) |
| `04-daily-sync-change-detection.md` | Daily sync + change-detection pipeline. | D19 |
| `05-ppe-features-industry.md` | Industry PPE feature survey. | D11/D16 |
| `06-llpa-rate-sheet-pricing.md` | How LLPA rate-sheet pricing is built (the LLPA model). | Layer 1 / D35 |
| `07-rules-modeling.md` | Modeling pricing/eligibility/LLPAs for a UI-driven rule engine. | D11/D48 |
| `08-focused-industry-brief.md` | DSCR pricing + rate-sheet knowledge brief. | Layer 1 |
| `COMPENSATION-MARGIN-MODEL.md` | LO margin + compensation model (design). | D18 |
| `LENDER-PRICE-AGREEMENT-HARNESS.md` | The ≥200-scenario LP agreement harness design. | D21/D49 |
| `LP-DEEPHAVEN-DSCR-LIVE-TABLES.md` | Deephaven DSCR rate sheet reconstructed from a live battery. | Layer 1 |
| `LP-DSCR-ELIGIBILITY-MATRIX.md` | The Deephaven DSCR eligibility matrix (Layer-2 source of truth). | Layer 2 |
| `LP-LOGIN-PAD.md` | LP durable-login mechanics. | Connector (D25) |
| `OPEN-SOURCE-FOUNDATION-SCAN.md` | Open-source foundation scan (is there code to build on). | Foundation |
| `PARITY-BASELINE.md` | The measured pricing/parity baseline (2026-08-16). | Parity gate |
| `RATE-SHEET-BACKEND-MECHANICS.md` | Rate-sheet backend "ground truth" mechanics. | Layer 1 / D35 |
| `README-dyn-to-smo.md` | The vendor's dynamic-field → special-mortgage-option table. | Connector |
| `REQUIREMENTS-LEDGER.md` | Exhaustive engineering requirements ledger. | All |
| `RULE-CATALOG-AND-BUILDER.md` | Full rule catalog (Job 1) + unified rule/condition builder (Job 2). | D11/D48 |
| `SEARCHRAW-500-FINDINGS.md` | Why searchRaw returns 500 (measured). | Connector |
| `SEARCHRAW-FIELD-CONTRACT.md` | The measured searchRaw field contract. | Connector |
| `TOKEN-REGISTRY-FINDINGS.md` | Every token we send vs LP's published list. | Connector |
| `TWO-LAYER-ELIGIBILITY-ARCHITECTURE.md` | Two-layer eligibility reconciliation architecture. | Layer 2 / D29 |
| `VENDOR-CONFIG-GOLDMINE.md` | The vendor config document — trust + do/don't. | Connector |
| `matrices/deephaven-dscr-matrix.json` | Decoded DSCR eligibility matrix (canonical). | Layer 2 |
| `matrices/deephaven-ppp-matrix.json` | Decoded PPP state matrix (canonical). | Layer 3 |
| `matrices/deephaven-dscr-sheet-raw.txt` | Raw Deephaven DSCR rate sheet (DSCR-only). | Layer 1 / D35 |
| `R7-…`/`R8-…`/`R9-…`/`R10-…` | The 4 engines RUNNING now (D26–D35). | see rows 8–11 |

---

## 3b. Have we laid the foundation? (owner's question) — YES, HALF-LAID

The scalable foundation is **half-built already**, which is the fast path forward:
- **Layer 1 (rate sheet), overlay rules, and margin/holdback are ALREADY data-driven** — versioned
  `lt_ppe_*` tables + `store.js` + `rule-store.js` + `margin-holdback.js`, with a grid↔sheet compiler
  and the one `rules.js` engine. `buildDeephavenGrid()` is already just a data producer.
- **The unified rule shape** (eligibility/bound/pricing/margin) the rule-mining engine designed maps 1:1
  onto that existing `rules.js` vocabulary and the `lt_ppe_rule` store — so the rule/condition builder is
  an authoring surface over infrastructure that EXISTS, not a rewrite.
- **What's left to make the next investor fast:** generalize Layers 2 & 3 into DATA + pure compilers
  (task #47), build the rule/condition builder on the existing store (#48), the scenario auto-generator +
  per-layer reconciler (#49). After that, **a new investor = encode its 3 matrices as data + run one
  `certifyProgram` command** — no new engine code.

## 4. Build status

**DONE (committed, tested, pushed on `claude/lender-price-frontend-agent-7g7tm9`):**
- Layer 1 add-on LLPAs (cash-out / condo / 2-4 units) — 28 values reproduced; classifier fix.
- Decoded DSCR eligibility matrix + PPP matrix (DSCR-only) as canonical JSON.
- Layer 2 `deephaven-matrix.js` (36 checks) + Layer 3 `deephaven-ppp-matrix.js` (37) + program (10).
- DSCR-only correction (removed redundant 80% caps; subordinate rule; full overlay list).
- Research docs: two-layer architecture, DSCR eligibility matrix, this master plan.

**DONE since (committed on `claude/lender-price-frontend-agent-7g7tm9`, 2026-08-17):**
- **Developer request-builder fixes / DSCR frontend parity (D13/D13a) — SHIPPED.** §2.2 term parity
  (`criteria.loanYear` stays 30 = amortization; the selected term rides `termsCriteria` only), §2.3
  AUS "All" forced to `[DU,LP,GUS,MUW,None]` unless the caller chooses AUS, §2.4 closing-cost flags
  forced true, §2.5 `audit:true` rung digest on the price route. Prepay Buyout SMO already carried via
  §37.10. Tests updated (the old `loanYear==term` assertions corrected). This is the developer's fix.
- **Facts wired (task #50 subset):** `borrower_type` + `subordinate_amount` now emitted by
  `lpScenarioToFacts`, so a LIVE LP scenario trips the subordinate rule (Layer 2) and the borrower-type
  PPP rules (Layer 3) — proven end-to-end (NJ natural-person → PPP decline through the live path).
  `apr` + the advanced overlay facts (rural/STR/FTI/vacant) remain (advanced section, R7/R10).

**PENDING (ordered):**
1. **LP disqualify capture + per-layer cross-check** (D6/D14, task #45): pull LP's Deephaven disqualify
   tree (machinery now fixed), run known-ineligible scenarios, match each disqualifier to our rule per
   layer; classify agree / LP-bug (→ ticket) / our-bug / overlay. Report mismatches to the owner.
3. **Scenario auto-generator** from the program's own axes (qualify + disqualify, each with expected
   layer+reason) — the offline correctness proof + the LP battery source.
4. **Scalable foundation build** (D11/D15/D16): generalize Layers 2 & 3 into data + compilers to
   `rules.js`; 3-stream versioned registry; equivalence-tested vs the hand-built oracles.
5. **The rule/condition builder** (D11): universal rule shape + authoring ops + admin surface.
6. Wire missing facts (borrower_type, apr, prepay_requested, subordinate_amount) into `lpScenarioToFacts`
   so the program evaluates a live scenario end to end.

---

## 4b. MEASURED findings (proven, awaiting build)

- **L1↔L2 min-loan divergence — FIXED (2026-08-17).** L1's flat $75k min ignored DSCR; now DSCR-gated
  ($75k ≥1.00 / $200k <1.00) mirroring L2, with a drift test (0 drift over every loan×dscr cell).
- **L1↔L2 max-LTV/grid divergence — MEASURED, build pending (R10 divergence B).** L1's flat 80/75/70 LTV
  caps + 4 N/A boxes vs L2's full 4-axis grid diverge on **135 of 720** (fico×ltv×dscr×purpose×loan-tier)
  scenarios, ALL one direction — **L1 says ELIGIBLE where L2 (the matrix) says INELIGIBLE** (L1 over-lends).
  Dominated by (a) L1 has only a flat min-FICO 640 and never enforces the **per-tier FICO floors** (T2/T3
  need 660), and (b) L1's flat LTV caps miss the **tier-aware** caps (T2/T3 drop to 65/70/60). The
  AUTHORITATIVE program verdict already uses L2 (`evaluateProgram` → `evaluateEligibility`), so this is the
  rate-sheet layer's OWN eligibility being too loose, not the program answer. FIX = mirror L2's `GRID` into
  L1 as independently-transcribed DATA + a drift test asserting the two agree on every cell (the sanctioned
  two-layer mirror pattern; NOT an import — the layers must stay independent to catch each other). Also in
  the same pass: **L2 is missing the Foreign-National grid row** the matrix JSON carries (R10). Reproduction:
  `node -e` sweep over the two engines (see the 2026-08-17 session); 135/720 divergences, examples all
  FICO-640 at $1.75M/$2.25M and high-LTV cells.

## 5. Open questions / to raise with the owner

- The 9 live divergences (our decline vs LP price at FICO 640/660/680 × cltv 80): once the disqualify
  capture runs, decide per case — LP bug (ticket) or our grid too strict.
- Margin holdback + advancement combine-formula into price is owner-pending (not yet folded into rate).
