# LT DSCR PPE — Engineering Requirements Ledger (official, exhaustive)

Compiled 2026-08-17 from the owner's directives + the LT control docs + the LT code inventory. Read-only research; no code changed.

> ⛔ **THIS LEDGER IS A SNAPSHOT OF 2026-08-17 AND IS STALE. DO NOT USE IT AS THE WORK LIST.**
> It was compiled from the plan documents rather than from the code, and it has since been
> contradicted by a measurement: several items it lists as TODO are built and screened (P8 and P9
> among them). **The current, code-measured outstanding-work list is §2.47 of
> `docs/longterm/LENDER-PRICE-PARITY-STATUS.md`, and everything genuinely waiting on the owner is
> `docs/longterm/OWNER-QUESTIONS-OPEN.md`.** This file is kept for the cross-index of the owner's
> clauses, which is still useful; its STATUS column is not.

**Status key:** DONE = built + tested; PARTIAL = core built, real gap remains; TODO = not built.
**Scope:** LT code lives ONLY in `src/longterm/**`; LT docs in `docs/longterm/**`. Repo root: `/home/user/yscap/yscap-repo-root_8`.

**Naming (owner's words):** R-Pricer = OUR engine (`ppe/rules.js` + `ppe/pricing.js` + `ppe/quote.js`, fed by ingested rate sheets). Lender Price (LP) = the vendor PPE we shadow. DPave/Deephaven = the pilot rate sheet.

**Control document:** `docs/longterm/PPE-MASTER-PLAN-AND-STATUS.md` (Parts 1–6, steps P-DQ…P10, expanded scope E1–E8). This ledger is the flat cross-index of every owner clause against that plan + the code.

---

## THEME A — Shadow / parity engine (own engine runs beside Lender Price; LP wins; disagreements → human)

| # | Requirement (plain) | Status | Where (file / doc) | Gap / next step |
|---|---|---|---|---|
| A1 | Build a PPE for LT DSCR loans that SHADOWS Lender Price (a full commercial PPE) | PARTIAL | `ppe/*` engine (settings/rules/pricing/quote/lock/best-execution) all built + tested; LP connector built | Engine is complete + unit-tested; the depth of the LP comparison + the rule-suggestion loop + admin UI are the open pieces (see A3, C, D, E). |
| A2 | Every scenario runs on BOTH our engine (R-Pricer) AND Lender Price | PARTIAL | `ppe/facade.js` `priceWithShadow` (dual-run, LP is business answer, our failure never breaks it, async best-effort) | The live quote path is the LP pricer route `routes/dscr-pricer.js`; our engine running beside it per-scenario + persisting the comparison is P2 (partial — mine action done, auto-wiring TODO). |
| A3 | Lender Price is AUTHORITATIVE and "survives on top of" our results | DONE | `ppe/facade.js` (SHADOW mode default; LP is the business answer, ours recorded, never overrides in shadow) | — |
| A4 | Disagreements go to human MANUAL REVIEW — never auto-applied | DONE (ledger) / PARTIAL (auto-enqueue) | `ppe/finding.js`, `ppe/finding-store.js`, `ppe/review-queue.js`, `ppe/parity-review.js` | Durable findings ledger + review queue + review composer built. Auto-enqueueing every non-agreement on every scenario (P2's automatic half) is TODO. |
| A5 | The review engine reads LP results deeply and finds what we're MISSING: base rate, final rate, coupons, margin, some rules, missing disqualifications | DONE (detectors) | `ppe/parity-detectors.js` (six categories: base_price, final_price, coupon_missing_ours/_lp, margin, llpa_total, disqualification_missing/_extra); `ppe/lp-normalize-full.js` (rich LP capture: base rate, itemized LLPAs, margin, decline reasons) | Detectors built + tested (P1, P3 DONE). Live wiring into the review pipeline for every scenario is P2 auto-half (TODO). |
| A6 | The manual-review engine SUGGESTS per-investor rules; a human ALWAYS approves | DONE | `ppe/disqualify-analysis.js` (per-investor suggestions), `ppe/rule-store.js` (`saveSuggestions`/`acceptSuggestion` — human accepts, never auto), `db/571` (`lt_ppe_rule` + `lt_ppe_rule_suggestion`) | End-to-end loop proven (mine → save → human accept → rule written → engine declines). "Always human-approved" is the settled owner decision (D3). |

---

## THEME B — Disqualify side + suggestion box (read the ineligible results, per investor + per program)

| # | Requirement (plain) | Status | Where | Gap / next step |
|---|---|---|---|---|
| B1 | Look at real investor rate sheets (Deephaven "Corr Flow" DSCR) and suggest importing the same disqualifications/LLPAs as a rule per investor | PARTIAL | `docs/longterm/RATE-SHEET-KNOWLEDGE.md` (full Deephaven anatomy); `ppe/disqualify-crosswalk.js` (LP disqualify → our predicate); `ppe/disqualify-analysis.js` | Crosswalk correct for the key shapes seen; **needs a LIVE populated disqualify capture** to widen the vocabulary (blocked on LP credential rotation — see BLK1). |
| B2 | Train the system to read the DISQUALIFYING side and find disqualification rules per investor | DONE (analysis) | `ppe/disqualify-crosswalk.js` (adjType = dimension; key text = threshold+direction; refuses/flags an unknown, never guesses); `ppe/disqualify-analysis.js`; `lenderprice/client.js` `parseDisqualified`/`disqualifyRulesOf` (+adjType) | P-DQ DONE. Vocabulary grows from real captures (BLK1). |
| B3 | Disqualify runs ALWAYS right after the eligible results (there are always many declined programs) | TODO | Plan item **E1**; foundation = P2 mine action (`ppe/suggestion-miner.js` + `POST /suggestions/mine`) + the async disqualify flow in `lenderprice/client.js` | The "automatic after eligible" wiring is the new part — run on canary/scheduled batches, not the live quote path (which would hit the upstream twice). Needs live upstream (BLK1). |
| B4 | Disqualify per INVESTOR and per PROGRAM (one investor → many programs; each program can have different disqualifiers) | PARTIAL | Plan item **E2**; `ppe/disqualify-analysis.js` groups per investor with programs[]/occurrences; `lenderprice/disqualify-store.js` (db/559) | Audit whether the parser carries the PROGRAM for EVERY disqualification, or if there's a gap. E2 = "extract every investor name + every program name + each program's disqualifiers exactly." |
| B5 | All disqualifiers from all programs of that investor go into ONE suggestion box | DONE | `ppe/rule-store.js` `listSuggestions`/`saveSuggestions` (deduped per distinct disqualification per investor); `db/571` `lt_ppe_rule_suggestion`; HTTP `GET /suggestions` | Suggestion store built; UI surfacing is P8 (TODO). |

---

## THEME C — Rate-sheet grid / editor (each investor modeled like a rate sheet; every box = a rule) — plan E3/E5

| # | Requirement (plain) | Status | Where | Gap / next step |
|---|---|---|---|---|
| C1 | Investor → several programs → each program its own Excel-like EDITABLE grid | PARTIAL (model only) | Plan **E3**; `ppe/deephaven-grid.js` `gridToRateSheet` (pure converter: coupon rows → base prices; FICO×CLTV grid segmented by DSCR band → LLPA cells; loan-amount/predicate LLPA tables) | Grid MODEL built + tested (22 checks, prices a real scenario end-to-end). **Front-end Excel editor NOT built.** Inverse `rateSheetToGrid` (render a stored sheet as a grid) NOT built. Per-program scoping NOT built. |
| C2 | EVERY BOX = a rule (a number → a pricing adjustment; an N/A box → an INELIGIBILITY, never a priced 0) | DONE (model) | `ppe/deephaven-grid.js` (money-safe rules pinned by test: explicit half-open bands, unit convention, sign rule — a sheet premium = negative points) | Model proven. Not wired to a live surface (gated by C-GATE / HR1). |
| C3 | Ineligible cells (higher LTV / lower FICO) are marked | DONE (model) | `ppe/deephaven-grid.js` (N/A cell → decline) | Rendering the marks in an editor UI is TODO (part of E3 front end). |
| C4 | Purchase / rate-term refi / cash-out each carry their own limits | PARTIAL | `docs/longterm/RATE-SHEET-KNOWLEDGE.md` §2 (Block C: purpose LLPA tables); `lenderprice/search-model.js` (purpose handling) | Modeled in the grid's LLPA tables; per-purpose limit editing in the UI is TODO. |
| C5 | A "rules view" toggle shows the same thing as rules; duplicate a rule + tweak one field | TODO | Plan E3 | Not built (front-end grid↔rules round-trip). |
| C6 | Excel IMPORT button, ONLY pre-configured investor/program sheet types | PARTIAL | Plan **E5**; `ppe/ratesheet-ingest.js` (ingestion normalizer, grid → base-price cells), `ppe/ratesheet-diff.js`, `ppe/ratesheet.js` | Ingestion normalizer built. The per-investor template layout knowledge + the import BUTTON + "only pre-configured sheet types" gate are TODO. Needs the real `.xlsx` (BLK2). |

**C-GATE (HARD RULE / HR1) — see Blockers:** the grid model is BUILT but UNVALIDATED against live Lender Price, so per the owner's hard rule it is INERT — not wired live, not driving suggestions, until the ≥200-scenario agreement passes.

---

## THEME D — Rule hierarchy (across-the-board / per-investor / per-program) — plan E4

| # | Requirement (plain) | Status | Where | Gap / next step |
|---|---|---|---|---|
| D1 | Rules can be across-the-board (all investors + programs) / per-investor / per-program | PARTIAL | Plan **E4**; `db/571` `lt_ppe_rule` (overlay-aware, scoped per investor/program with provenance); `ppe/rules.js` (evaluator: eligibility/bound/pricing, half-open bands, most-restrictive tightening) | `lt_ppe_rule` already supports this scoping. The UI + the field catalog is the build (TODO). |
| D2 | Every field is a filter (state, city, FICO, LTV, DSCR, purpose, …) | PARTIAL | `ppe/rules.js` (predicate grammar all/any/none/not + leaf ops); `lenderprice/field-registry.js` (field→token map) | Rule grammar supports arbitrary-field predicates. A user-facing field catalog/picker (E4 UI) is TODO. |

---

## THEME E — Ops: daily refresh / confidence maturity / troubleshooter — plan E6/E7/E8

| # | Requirement (plain) | Status | Where | Gap / next step |
|---|---|---|---|---|
| E1 | Daily base-rate refresh at 10 / 11 / 12 AM Eastern, per investor (pull the updated base rate) | PARTIAL | Plan **E6**; `ppe/canary-schedule.js` + `ppe/schedule-store.js` (db/570 — the cadence/schedule store); rate-sheet version store `ppe/ratesheet.js` + db/560 | Schedule store exists, and so does the tick that runs the due schedules (`POST /canary/tick`). What is TODO is the scheduled JOB that PULLS that tick at those NY times, per investor, plus the advisory lock that keeps N instances to one battery. (The db/567 housekeeping note that used to sit here was measured and closed 2026-08-17 — no LT file cites db/567.) |
| E2 | Confidence MATURITY (know which scenarios we're more/less confident on) | PARTIAL | Plan **E7**; `ppe/scoreboard.js` + `ppe/run-store.js` (db/565 — agreement over time) | Scoreboard measures agreement over time. The build is SLICING it by scenario type / investor / program. TODO. |
| E3 | Major backend TROUBLESHOOTER: "this is what LP gave, this is what I planned/showed, these are the rules I'm suggesting" | PARTIAL | Plan **E8**; `ppe/parity-review.js` (`reviewScenario`: one record = categorized diffs + suggested per-investor rules, proven end-to-end) + the suggestion store | Composer built (parity-review + suggestion store). The RECORD (persisted troubleshooter row) + the SCREEN is the build. TODO. |

---

## THEME F — Owner decisions (2026-08-17) — recorded as settled

| # | Decision (owner's words) | Status | Where |
|---|---|---|---|
| D-1 | Our markup is PER-INVESTOR (each investor + its programs carries its own markup number) | DONE (foundation) | `ppe/store.js` `resolveMarginHoldbackForInvestor` (investor → company → default); `ppe/margin-holdback.js`; `ppe/settings.js` (`pricing.margin_milli`/`holdback_milli`/`margin_holdback_rules`); `docs/longterm/PPE-MARGIN-HOLDBACK-PLAN.md` Layer 1. Next: expose per-investor markup in admin surface + rate-sheet editor. |
| D-2 | Parity match is EXACT (to the penny) — any difference → human review | DONE | `ppe/settings.js` `validation.price_tolerance_milli` + `base_price_tolerance_milli` defaults = 0 (rate + margin already 0). Admin may loosen per-company. |
| D-3 | Suggested rules are ALWAYS human-approved (nothing turns on by itself) | DONE | `ppe/rule-store.js` `acceptSuggestion` (needs_human / origin='suggested', never auto-applied). Unblocks P4→P5. |
| D-4 | Deephaven is the FIRST rate sheet | DONE (confirmed) | Pilot investor for the grid editor (E3) + parity matrix (P9). `docs/longterm/RATE-SHEET-KNOWLEDGE.md` is the Deephaven reference. |

---

## THEME G — Margin & holdback money mechanics (still-open owner decisions)

| # | Requirement | Status | Where | Gap / next step |
|---|---|---|---|---|
| G1 | Two knobs — margin AND holdback — per investor, pre-filled 0.250, editable, reaching every investor, rule-driven per scenario | DONE (Layer 1 structure) | `docs/longterm/PPE-MARGIN-HOLDBACK-PLAN.md` §4; `ppe/settings.js`, `ppe/margin-holdback.js`, `ppe/store.js` | Structure built + tested; verified 0.25 margin (LP is 0.25 cheaper on price, all 28 coupons — `RATE-SHEET-KNOWLEDGE.md` §4). |
| G2 | Per-investor margin actually applied in the price | DONE (opt-in hook) | Layer 2: `ppe/quote.js` accepts optional `marginHoldback`; byte-identical when unset (`test-lt-ppe-quote.js` §10). The DB-aware caller that resolves per-investor + passes it is the remaining plumbing. |
| G3 | Holdback → final-rate combine formula (⚠️ MONEY RULE) | TODO (BLOCKED on owner) | Plan Part 4.1 + PPE-MARGIN-HOLDBACK-PLAN Layer 3. Holdback number + provenance is computed; **nothing consumes it in the price** — the combine formula must come from the owner (is it a 2nd cost line? does it reach the borrower rate? can it disqualify?). Never guessed. |

---

## THEME H — Foundation research + owner communication

| # | Requirement | Status | Where | Gap / next step |
|---|---|---|---|---|
| H1 | Parallel research for an open-source PPE foundation (only adopt a REAL match) | DONE | `docs/longterm/ppe-research/OPEN-SOURCE-FOUNDATION-SCAN.md` | Decision: **keep building custom** — no OSS mortgage PPE / LLPA / rate-sheet parser exists. Revisit GoRules `zen-engine` LATER, only for its visual editor, only if hand-authoring tables becomes painful (its Rust native binary violates the no-native-deps rule). |
| H2 | Ask the owner questions in beginner language | DONE (in effect) | Answered via the "beginner-question round" 2026-08-17 → Part 4 decisions (D-1…D-4). Ongoing practice per CLAUDE.md plain-language rule. |

---

## THEME I — The parity discipline (200-scenario agreement gate before building any rate sheet)

| # | Requirement (owner's words, HARD RULE) | Status | Where | Gap / next step |
|---|---|---|---|---|
| I1 | Before building ANY rate sheet: get comfortable with ≥200 scenarios from every angle, compared with Lender Price, agreeing on every LLPA, eligibility, ineligibility, max price and min price — FULL agreement BEFORE building | PARTIAL (harness exists; agreement NOT yet run) | Plan **E3 HARD RULE**; harness = `ppe/scenario-matrix.js` `buildMatrix` (≥200 battery, many axes, incl. deliberately-ineligible) + `ppe/parity-review.js` + `ppe/parity-detectors.js` + `ppe/lp-normalize-full.js` (carries max/min price, margin, LLPAs in canonical milli) | The one thin piece to ADD: a per-investor grid-validation report that composes them over the ≥200 battery and emits per-scenario pass/fail + "we agree on N/200, here is every disagreement." **Cannot run until BLK1 + BLK2 land.** Until then the grid model is INERT (not wired live, not driving suggestions). |
| I2 | While building, keep matching continuously (not once at the end) | TODO | Same harness | Continuous re-check wiring is part of the grid-validation report (I1). |
| I3 | Current MEASURED parity is count/eligibility only — NO row compared rate-for-rate yet | (state) | Plan Part 2.9: two HAR anchors match exactly (11/309/8 and 13/470/8; a 17-program/439-row purchase count matched); §32.6 DSCR fix restored the 439 rows | Point-for-point price parity matrix per investor = **P9 (TODO)**. |

---

## THEME J — Numbered execution steps (P-DQ … P10) status roll-up

| Step | What | Status | Where |
|---|---|---|---|
| P-DQ | Read disqualify side per investor, suggest rules to import | DONE (analysis) | `ppe/disqualify-crosswalk.js`, `ppe/disqualify-analysis.js` |
| P1 | Feed the FULL LP capture into the comparator (base rate, itemized LLPAs, margin, decline reasons) | DONE | `ppe/lp-normalize-full.js` |
| P2 | Mine suggestions from a disqualifying scenario, persist to review store | PARTIAL | `ppe/suggestion-miner.js` + `POST /suggestions/mine` (mine action DONE); auto/scheduled wiring TODO |
| P3 | The six difference detectors | DONE | `ppe/parity-detectors.js` |
| P4 | Curated LP-key → rule-predicate crosswalk | DONE (via P-DQ) | `ppe/disqualify-crosswalk.js` (widen from live capture — BLK1) |
| P5 | Rule-suggestion engine + suggestion store | DONE | `ppe/rule-store.js`, `db/571` |
| P6 | The eligibility/bound rule table | DONE | `db/571` `lt_ppe_rule`; `ppe/rule-store.js` `rulesForProgram` |
| P7 | Close the loop: accept → write rule → re-run parity settles | DONE | `ppe/rule-store.js` `acceptSuggestion` (proven end-to-end) |
| P8 | The manual-review + suggested-rules UI (`app-v2/src/longterm/**`) | DONE | `app-v2/src/longterm/RuleBoard.jsx` (suggested rules) + `DisqualifierReview.jsx` (per-scenario review, §2.62) + the findings queue/scoreboard on `LtPpe.jsx`|
| P9 | Point-for-point price parity matrix per investor (sliced dashboard + trend) | DONE | `ppe/parity-matrix.js` + `ppe/parity-cell-store.js` (persisted per-cell trend)|
| P10 | Promote-to-live HTTP route + human promote/rollback | DONE | `GET /cutover` + `POST /cutover/decision` (§2.63), super-admin gated; the quote path reads the ledger mode|

---

## THEME K — The DSCR pricer production bug + the 31 request-shape diffs (owner clause 10)

| # | Requirement | Status | Where | Gap / next step |
|---|---|---|---|---|
| K0 | DSCR omitted sent `dscr:null` → collapsed 439 rows to 28; default to 1.5 (nullish) | DONE | `lenderprice/search-model.js` L649 `const effDscr = dscrVal != null ? dscrVal : 1.5;` (§32.6); restored exact 439-row parity. A real 0 (NoDSCR) is preserved; only null/undefined/blank → 1.5. |

**The request-shape differences on blank/derived fields — ALL CLOSED (2026-08-18); and "31" was itself
mostly a measurement error.** §2.1a measured the captures in the two groups they actually form: `req-01`
and `req-07` are KICKOFFS, `req-02`…`req-06` are POLLS of req-01, and the frontend's own poll differs from
its own kickoff in 14 leaves — so diffing our kickoff against their poll reported 14 of THEIR
re-serialisations as our defects. Like for like: 58 kickoff leaves are blank on one side or the other, 55
already matched, 2 were fixed, and the 3 that remain are fields on which the two captures CONTRADICT EACH
OTHER (`companyId`, `nonWarrantableProject`, `GLOBAL_Section184`) — pinned, not guessed. The fix was a RULE,
not spot-patches: `SCENARIO_OWNED` is the one place a blank form is decided and `test-lt-lp-blank-parity.js`
derives each expected form from the anchors themselves.

⛔ **THE STATUSES BELOW ARE COMPARED TO THE CODE, BOTH WAYS.**
`scripts/test-lt-ppe-requirements-ledger.js` fails when a row claims DONE the code does not show — AND when
a row still reads TODO for work the code has finished. That second direction is why this table is now
accurate: every one of K1–K9, P8, P9 and P10 read TODO on 2026-08-18 while the code had closed all eleven,
which buried the genuinely open items among false ones. Every K row must carry a probe there.

| # | Diff | Status | Note |
|---|---|---|---|
| K1 | `pmiType`: frontend `"BPMI"` vs PILOT `"None"` | DONE | `search-model.js` `c.pmiType = 'BPMI'` — FORCED in the §2.1 block, so a live foundation can never diverge.|
| K2 | Prepay Buyout special-mortgage-option: frontend includes; PILOT omits | DONE | §37.10: we stopped inventing a fourth SMO and carry the FOUNDATION's own through (`preserved`) — on the captured base that is exactly Prepay Buyout. Live SMO registry captured 2026-08-17.|
| K3 | AUS list membership/order differs | DONE | `bc.ausList = callerAus || AUS_ALL` — the full captured list, FORCED.|
| K4 | `showUnmatchCompPlan`: frontend `true` vs PILOT `false` | DONE | `m.showUnmatchCompPlan = true` — FORCED.|
| K5 | Default closing-cost flags: frontend enables; PILOT disables | DONE | `cc.useClosingCost` + `cc.useCompanyDefaultClosingCost` both FORCED true.|
| K6 | Monthly income rounding: frontend `16667` vs PILOT `16666.666…` | DONE | Rounded in `wireDiscipline` (the one-place-last chokepoint) so it survives a live foundation AND a scenario value. Regression: section J of `test-lt-lp-request-foundation.js`.|
| K7 | 15-year selection: frontend keeps `criteria.loanYear:30` + `termsCriteria:[15]`; PILOT sets BOTH to 15 | DONE | `c.loanYear = 30; m.termsCriteria = [effTermYears]` — the amortization stays 30, the note term rides termsCriteria only (§2.2).|
| K8 | Several blank fields: frontend OMITS; PILOT transmits `null` | DONE | Does not reproduce: measured 0 null-vs-omit divergences. The RULE replaced the spot-patches — `SCENARIO_OWNED` is the one place a blank form is decided and `test-lt-lp-blank-parity.js` DERIVES each from the anchors.|
| K9 | Blank address fields + a derived city: frontend includes; PILOT omits some | DONE | §2.1a REVERSED the earlier "deliberately omitted" call as a false choice: all seven captures send `""`, so we do too (`SCENARIO_OWNED` neutral `''`). `city` stays deliberately underived from a ZIP — cosmetic, documented, not a gap.|

Notes recorded (no code change needed): PILOT authenticates independently (username/password + refresh token, not the temporary frontend browser token); the health-probe "pricing unavailable" was only a missing location on the probe; the 15-day 695-vs-256 mismatch was a frontend multi-select artifact (with only 15 selected, parity was exact). **Refinance parity is NOT claimed** (frontend masked numeric controls rejected the automated edits).

---

## BLOCKERS & OWNER ACTION ITEMS

- **BLK1 — Lender Price credentials are COMPROMISED (pasted in chat) and must be ROTATED.** Rotate `LP_PASSWORD` / `LP_CLIENT_SECRET` / `LP_DIAG_TOKEN` in the vendor portal + set new values in Render. **Blocks:** every live capture — the real populated `disqualifiedData` needed to widen the disqualify crosswalk vocabulary (B1/B2/B3/P4); the ≥200-scenario live agreement (I1); the SMO/AUS captures (K2/K3). No live disqualify capture may run until this is done.
- **BLK2 — The real Deephaven Excel (`Corr_Flow_Rate_Sheet__T0__Excel.xlsx`) is not stored here.** Re-attach a fresh copy so the grid (E3) is built from the real cells, not the written breakdown, and the import templates (E5) can be pinned to exact cell values. **Blocks:** exact-cell grid build (C1), the Excel import button config (C6), sharpening the ≥200 agreement (I1).
- **BLK3 — Holdback → final-rate combine formula (⚠️ MONEY RULE) needs the owner's exact numbers.** Three open questions: is holdback a 2nd cost line like margin; does it reach the borrower-facing rate or only our spread; can a holdback rule disqualify? **Blocks:** G3 / Part 4.1 (applying holdback to price — detection proceeds without it).
- **BLK4 — Clean-weeks cutover threshold** (consecutive clean weeks before an investor may go live; default 8). **Blocks:** P9/P10 gate (Part 4.3).
- **BLK5 — Promotion authority + live spot-check** (who may promote shadow→live; does "live" keep an occasional LP canary?). **Blocks:** P10 (Part 4.6).

## OPEN QUESTIONS (owner input needed, beyond the blockers)

1. **Holdback semantics** (BLK3, restated): second cost line vs retained-out-of-spread vs eligibility-gating — the three Layer-3 questions in `PPE-MARGIN-HOLDBACK-PLAN.md`.
2. **Cutover clean-weeks threshold** number (BLK4).
3. **Who promotes an investor to live, and does "live" keep an LP spot-check canary** (BLK5).
4. **Do we normalize the 31 request-shape diffs now** (K1–K9), given the tested eligible results already match — strict parity vs "good enough since rows agree"?
5. **Refinance parity** — not yet claimed (frontend controls blocked automated edits); is a refinance parity pass in scope next?
6. **E5 import — which investor sheet layouts to pre-configure first** beyond Deephaven, and confirm "only pre-configured sheet types" is the intended hard limit.

## HOUSEKEEPING (non-owner, engineering)

- ~~Stale doc-comments in `ppe/schedule-store.js` / `ppe/canary-schedule.js` cite db/567.~~ **CLOSED 2026-08-17, and the item was itself false when measured:** `schedule-store.js` cites db/570 and `canary-schedule.js` names no migration; `db/567` appears nowhere under `src/longterm/**`. Nothing to fix.
- Part 2.11: no admin screen yet consumes the built `createInvestor` / `createProgram` / rate-sheet writers.
