<!--
LT-only. THE master plan + live status for the Long-Term Product & Pricing Engine (PPE).
This is the single numbered control document the owner asked for (2026-08-17): "lay out the entire
plan with numbers and start following number by number so we can see the progress and we know that
you are not going off track."

It does NOT replace the architecture spine (PPE-MEGA-PLAN.md, §0–§15) — it maps that architecture to
what is BUILT vs TO-BUILD, and then lays out the ACTIVE workstream the owner named: every scenario runs
on BOTH our engine and Lender Price, Lender Price wins, the difference goes to a HUMAN manual review,
and the review engine SUGGESTS the exact rules/disqualifications to add per investor so our engine
comes to match Lender Price.

Grounded in three research passes (2026-08-17): (A) the full intended architecture from PPE-MEGA-PLAN +
the 8 research digests; (B) a complete inventory of what is already built; (C) a deep read of Lender
Price's real searchRaw response (LENDERPRICE-RESPONSE-SCHEMA.md) + our parse/parity code, with exact
field paths.
-->

# PPE — Master Plan & Live Status (the control document)

**One-sentence goal:** build our own Product & Pricing Engine that prices Long-Term (DSCR) loans, prove
it matches Lender Price scenario-for-scenario, and only then trust it — one investor at a time.

**How the owner wants this run (2026-08-17):** *"I don't want to build without control. Lay out the
entire plan with numbers and start following number by number so we can see the progress and know you
are not going off track."* So: this document numbers every piece, marks each **DONE / PARTIAL /
TO-BUILD**, and Part 3 is the active workstream in execution order. Nothing is built ahead of its number
without the owner's go, and the money/rule decisions in Part 4 wait on the owner's own words.

**Naming:** the owner's *"R-Pricer"* = **our own engine** (the pure trio `rules.js` + `pricing.js` +
`quote.js`, fed by rate sheets we ingest). *"Lender Price" (LP)* = the vendor PPE we shadow against.
*"DPave"* = the **Deephaven** rate sheet — our pilot investor.

---

## Part 1 — The big picture, in plain language

1. **Two engines price every scenario.** Ours runs, and Lender Price runs, on the same loan scenario.
2. **Lender Price wins — always, for now.** What the business sees is Lender Price's answer. Ours runs
   beside it and is recorded, but never overrides Lender Price while an investor is in "shadow."
3. **Every difference goes to a HUMAN — not silently.** When our answer differs from Lender Price, that
   difference becomes a **finding** in a manual-review queue. It is never auto-resolved. (Owner: *"it
   should go into a manual review for a human to review, not only into demand."*)
4. **The review engine understands Lender Price deeply and tells us what we're missing.** For each
   difference it says which of these is off: **base rate, final rate, coupons, margin, some rules, or a
   missing disqualification** — and then **suggests the exact rule to add** for that investor so our
   engine will match Lender Price next time. (Owner: e.g. on the Deephaven sheet, take Lender Price's
   disqualifications and suggest importing the same disqualifications as a rule for that investor.)
5. **An investor goes "live" (our engine trusted) only after weeks of zero differences** — one investor
   at a time, promoted by a human reading a scoreboard, instantly reversible.

That is the whole system. Parts 2–5 turn it into numbered, verifiable work.

---

## Part 2 — Status matrix: the whole architecture (built vs to-build)

The architecture is `PPE-MEGA-PLAN.md` §0–§15 (the spine — do not duplicate it). Below is every major
capability, numbered, with its real status from the 2026-08-17 build inventory. **The engine is
remarkably complete and fully unit-tested; the gaps are (a) depth of the Lender-Price comparison, (b)
the rule-suggestion loop, and (c) admin/UI surfaces.**

### 2.1 Governing principles — **DONE** (enforced in code + the separation gate)
Sellable-as-is (every knob a typed setting), LP-wins dual-run, strict LT separation, multi-tenant,
versioned/effective-dated/audited. *(MEGA §1.)*

### 2.2 Data model `lt_ppe_*` — **PARTIAL**
- **DONE:** investor + alias + program anchors (db/558); rate-sheet version + base-price grid + LLPA
  adjustment + price-limit tables (db/560); findings ledger (db/561); shadow-run series (db/565);
  cutover ledger (db/566); canary schedule (db/570); LP disqualify store (db/559).
- **DONE (2026-08-17, db/571):** the first-class **`lt_ppe_rule` / ruleset table** for *eligibility &
  bound* rules, plus `lt_ppe_rule_suggestion` (the proposal queue). Read/written through
  `ppe/rule-store.js`; §2.6 below is its consumer. The paragraph that follows described the gap it
  closed and is kept for the reasoning:
  Today pricing rules come from `lt_ppe_adjustment` rows, but eligibility/bound rules have **no
  persistent home** — `ratesheet.js` itself notes "eligibility/bound rules live in a later rule table"
  that does not exist yet. **This is a prerequisite for the rule-suggestion loop (Part 3, P6).**
- **HOUSEKEEPING:** `schedule-store.js` / `canary-schedule.js` doc-comments still cite db/567; the table
  is really db/570 (renumbered to dodge a collision). Fix the stale comments.

### 2.3 Settings / configuration layer — **DONE (core)**
Typed definitions, tenant→org→product-default resolution, validated writes, per-investor scope
(`investor:<code>`), margin+holdback (Layer 1, 2026-08-16). `settings.js` + `store.js`. *(MEGA §4.)*
- **TO-BUILD (later):** ruleset templates + seed-manifest upgrade/merge (§4.4); sellability CI lints
  (§4.5). Not blocking the active workstream.

### 2.4 Rate-sheet ingestion & daily sync — **PARTIAL**
- **DONE:** ingestion normalizer (`ratesheet-ingest.js`), change-detection/diff with a version-stamped
  canonicalizer (`ratesheet-diff.js`), sheet→engine translation (`ratesheet.js`), the DB store
  (db/560). *(MEGA §7.)*
- **TO-BUILD:** the nightly orchestrator (pull → probe → diff → auto-apply-safe vs route-to-review),
  the as-of delta-chain history, and the rate-sheet console UI. Not blocking the active workstream.

### 2.5 Numeric pricing pipeline — **DONE**
`pricing.js` (integer milli-points, cost-positive, floor/ceiling last, round once, full reconstruction
record) + `quote.js` (compose rules + pricing → priced ladder or structured decline). The 0.25 margin
is a setting. Layer-2 per-investor margin hook is wired (opt-in, byte-identical when unset). *(MEGA §5.)*

### 2.6 Rules engine — **PARTIAL**
- **DONE:** the evaluator (`rules.js`) — three rule shapes (eligibility / bound / pricing), half-open
  `[min,max)` bands, most-restrictive tightening (overlays only tighten), fail-safe on missing facts,
  full trace. Pure, fully tested. *(MEGA §6.)*
- **DONE:** gap/overlap coverage validation (`rule-coverage.js` — `analyzeRuleSet`). It answers two
  questions about a rule set: do two PRICING rules on one dimension both charge the same scenario (a
  DOUBLE CHARGE, the only one of the three rule shapes where a collision is a money defect), and does a
  banded axis have a hole between the rules' own edges. It reads a predicate as a **REGION** — a box of
  numeric bands plus enum value sets — not as a single interval, which is the whole reason it is worth
  having: measured on the real Deephaven sheet, **129 of its 133 pricing rules** are read, and an
  interval-only version read **1**. Advisory: it returns findings and never refuses a rule. What it
  cannot prove it REFUSES and NAMES (`unanalyzable`, today the four `dhvn_condo_*` rules' `neq`
  complement). GAPS are an exact GRID decomposition (parity status §2.20): every axis is cut at the
  rules' own edges, so a region contains an elementary cell wholly or not at all and the answer is
  exact — which is what lets it read a sheet whose rules are grid cells. Measured on the real sheet:
  holes checked on 2 of 10 dimensions (the other 8 abstain, each with its REASON in `gapsSkippedWhy`)
  and **4 found — 3 in cells the eligibility matrix declines, 1 the DSCR par band** — so a gap is
  reported as a QUESTION, never a defect. Suite `scripts/test-lt-ppe-rule-coverage.js` (69 assertions,
  incl. a section pinned to the real sheet and a live eligibility probe proving the three declined
  cells). Detail: parity status §2.19 + §2.20.
- **DONE:** the coverage check is WIRED to the stored rule set. `rule-store.coverageForProgram` hands
  it the set a program actually evaluates — `rulesForProgram`, house rules plus this investor's plus
  this program's, effective-dated — because two rules collide only if they can both fire on ONE loan;
  analyzing the whole table would report a house rule against another investor's as a double charge.
  `acceptSuggestion` returns a `coverage` report on the accept (computed AFTER the commit, so a read
  error can never abort a write a human authorised, and never refusing the accept — coverage is
  advisory and a refused button is a dead end for a finding you can only act on by looking at both
  rules), and `GET /api/lt/ppe/rules/coverage` reads it on demand. An accepted ELIGIBILITY or BOUND
  rule is reported as NOT overlap-checked WITH the reason, rather than as an empty overlap list — most
  mined suggestions are eligibility rules, so a clean-looking `overlaps: []` there would be a check
  that never ran. Suite `scripts/test-lt-ppe-rule-coverage-wiring.js` (27 assertions, stubbed db, 8
  mutations proven).
- Nothing remains TO-BUILD here: the rule table itself landed in db/571 (2.2 above).

### 2.7 Locks & secondary market — **DONE (engine) / TO-BUILD (surface)**
`lock.js` — full lifecycle, frozen price stack, worst-case relock, expiry block; pure, tested. No HTTP
surface or lock-desk UI yet. *(MEGA §8. Later increment.)*

### 2.8 The dual-run "LP wins" model — **DONE** (deepened 2026-08-17)
- **DONE:** `facade.js priceWithShadow` (shadow default, LP is the business answer, our engine's failure
  never breaks it, comparison is best-effort/async). *(MEGA §9.)*
- **DONE (P1 of the active workstream):** the comparison is no longer shallow. `deps.lpDetail` turns the
  one Lender Price answer into the three parsed shapes and the façade now runs **both** halves — the
  ladder (as before) **and** `lp-normalize-full` + `parity-detectors`, the same two modules the ≥200-scenario
  agreement harness has always used, **reused rather than re-implemented**. So the live shadow finally sees
  **margin, itemized LLPAs and Lender Price's own decline reasons**. Additive and optional: with no
  `deps.lpDetail` the façade is byte-identical, and the deep block says in words why it did not run.
- **Two defects it uncovered on the live route, both fixed:** `lp.price()` returns the **raw envelope**
  (`{ok, raw, request, searchKey}`), which the façade was normalizing as if it were the `parse()` shape —
  no `.programs`, so **zero matched programs, so Lender Price read as INELIGIBLE on every single quote**;
  and the route passed the whole program **object** as Lender Price's program-*name* filter, which renders
  `"[object object]"` and matches nothing — the same wrong answer by a second route. Every live quote was
  recording a phantom `eligibility_mismatch`: a wiring fact filling the ledger, which is exactly the failure
  the route's own no-program rule exists to prevent. Reproduced before the fix, guarded after it.
- **Scope is STATED, never inferred.** Lender Price answers one request with every program it sells (17 on
  the live Deephaven capture); our engine prices one. Unscoped, **both halves abstain with the reason** rather
  than compare our ladder against a merge.
- **DONE — the durable scope (db/574, 2026-08-17).** Each PROGRAM carries its own Lender Price scope
  (`lp_investor` / `lp_lender` / `lp_program` / `lp_product` / `lp_program_like`), set through the admin-gated
  `POST /programs/:id/lp-scope` and read by `loadProgram` into `opts.lpFilter`. It lives on the program, not
  the sheet version, because it is a statement about the investor's product family and survives every reprice.
  **NO backfill** — a guessed scope points a comparison confidently at the wrong program, which is worse than
  comparing nothing. `programLike` is a FAMILY pattern because Lender Price splits one Deephaven DSCR sheet
  into three programs by band. It is the **one** source: the transitional request-body filter is REMOVED, so
  two sources can never disagree and no caller can hand `/quote` (not admin-gated) a RegExp to run.
  `lp-scope.safePattern` bounds and grammar-checks every pattern — it refuses the nested-quantifier shape, a
  pattern that matches everything (provably: for an unanchored pattern, matching the empty string IS matching
  every name), look-around and back-references — while still accepting the real Deephaven family pattern.
  `previewScope` answers "which program names does this actually select?" at the moment it is written, because
  the failure of a stored scope is otherwise SILENT: one character wrong matches nothing and looks exactly like
  a feature nobody switched on. Test `scripts/test-lt-ppe-lp-scope.js` (102); 15 mutations proven to fail it.
- Tests `scripts/test-lt-ppe-facade-deep.js` (74) + `scripts/test-lt-ppe-quote-deep-wiring.js` (22); 18
  mutations of the production code were each proven to fail them.

### 2.9 Validation / parity strategy — **PARTIAL** ⭐ active
- **DONE:** `parity.js` (eligibility / rate / price comparison, incomparable never scored as agreement),
  `shadow.js` (matrix runner), `divergence.js` (rank the one component matching a price gap), `finding.js`
  + `finding-store.js` (durable ledger, settled findings never re-open), `review-queue.js` (severity
  ranking), `scenario-matrix.js` + `coverage.js` (Layer A/B/C generators), `canary.js` +
  `canary-schedule.js` + `schedule-store.js`, `scoreboard.js` + `run-store.js`. *(MEGA §10.)*
- **MEASURED:** parity today is **count/eligibility parity** (two real HAR anchors match exactly:
  11 programs / 309 options / 8 lenders, and 13 / 470 / 8; a 17-program / 439-row purchase count matched
  independently). **No row has yet been compared rate-for-rate against LP's actual price.** Closing that
  is the point of the active workstream (P3, P9).
- **TO-BUILD:** the six diff detectors (base rate, margin, rule-level, missing-disqualification), the
  rule-suggestion engine, and the manual-review UI. **This is Part 3.**

### 2.10 Per-investor onboarding & cutover — **PARTIAL**
- **DONE (engine):** `cutover.js` (draft→shadow→live→retired gate), `cutover-ledger.js` + `cutover-store.js`
  (append-only decision history), the scoreboard. *(MEGA §11.)*
- **TO-BUILD:** **no promote-to-live HTTP route exists** — the gate is reachable only in code. Add the
  route + the human promote/rollback action (P10).

### 2.11 Interfaces (admin surface) — **PARTIAL**
- **DONE:** `/api/lt/ppe/*` (health, settings, investors, findings, scoreboard, quote, decide-finding,
  canary) + the `LtPpe.jsx` findings/scoreboard/readiness screen (staff-only, wired).
- **TO-BUILD:** investor/program manager, rule-authoring editor, rate-sheet console, LLPA manager,
  settings center, scenario playground, and the **manual-review + suggested-rules UI** (P8). No admin
  screen consumes the built `createInvestor`/`createProgram`/rate-sheet writers yet. *(MEGA §12.)*

### 2.12 The LP connector — **DONE**
`lenderprice/client.js` (login/token/price/parse/parseFull/parseDisqualified, read-only viewer, fails
closed), `search-model.js` (searchRaw builder off a real captured base), `field-registry.js`
(declarative field→token map; intentionally partial for unverified tokens — a field is implemented or
the route 422s it), `disqualify-store.js`, `zip-county.js`. *(MEGA §9 / the LP bridge.)*

---

## Part 3 — THE ACTIVE WORKSTREAM: the Parity & Rule-Suggestion Engine ⭐

This is what the owner asked for. Every scenario runs on both engines, LP wins, the difference goes to a
human, and the engine suggests the exact rule to add per investor. Built in numbered steps; each ships
with tests and does not touch LP's authoritative answer. **Steps P1–P3 and P9 are detection-only and
safe (they only ADD findings). P4–P7 write rules and need the owner's go + Part 4 decisions.**

Each step lists: **What · Why (grounded in the LP field paths) · Acceptance test · Depends on · Owner
gate (if any).**

### P-DQ — Read the disqualify side, per investor, and suggest the rules to import  ·  **DONE (analysis)** ✅
*Owner-directed first step (2026-08-17): "look at an actual disqualifying scenario and train our system
how to look on the disqualifying side to find disqualification rules per investor so we can suggest them
to implement."* This is the disqualify slice of P3f + P4 + P5, built first because it is where the
owner wants to start.
- **What (built).** Two pure modules + tests:
  - `disqualify-crosswalk.js` — turns ONE Lender Price disqualification (`{ adjType, key text }`) into
    one of our rule predicates, or REFUSES it and flags it for a human. The training insight: the
    **`adjType` is the dimension** (`FicoRateAdjustment`→FICO, `CapAdjustment`→LTV/CLTV ceiling,
    `StatesRateAdjustment`→state, `DscrRateAdjustment`→DSCR, `LoanAmountRateAdjustment`→loan amount);
    the **key text carries the threshold + direction** ("below 660", "> 80.0 %", "Minimum … 680",
    "Max LTV …"). It reads both "failing-condition" wording and "requirement" wording and collapses
    both to the *decline* side. Curated, never guessed — an unknown type or unparseable threshold is
    surfaced, not fabricated (the TOKEN-REGISTRY discipline).
  - `disqualify-analysis.js` — takes `client.parseDisqualified(raw)` and produces, **per investor**, the
    distinct disqualification rules as **suggested overlay eligibility rules** (`{ code, kind:'eligibility',
    source:'overlay', when:<predicate>, declineReason:<LP key verbatim>, adjType, fact, confidence,
    programs[], occurrences }`), plus an `unmapped[]` list of reasons a human must map. Deduped per
    distinct rule, with evidence (how many programs each appears on). A suggestion is a PROPOSAL —
    nothing is written to a program's rules.
  - `client.disqualifyRulesOf` now also carries `adjType` (additive) so the crosswalk has the dimension.
- **Grounding.** Built against the REAL vendor key wording committed in `test-lt-lenderprice.js`'s
  disqualify fixture — `"FICO - below 660"`, `"Max LTV exceeded / CLTV > 80.0 %"`, `"Interest Only not
  available in NY"` — and proven end-to-end: the suggested predicates, run through `evaluateRules`,
  decline exactly the loans Lender Price declined (a 640-FICO loan, an 85% CLTV loan, an IO loan in NY),
  and pass a clean loan.
- **Acceptance tests.** `test-lt-ppe-disqualify-crosswalk.js` + `test-lt-ppe-disqualify-analysis.js`
  (both pure, in the aggregate runner; 36/36 suites green).
- **⚠️ HONEST CONSTRAINT — needs a LIVE disqualify capture to widen the vocabulary.** We do NOT have a
  real populated `disqualifiedData` response committed (the anchors are request bodies; the schema doc
  itself lists "capture a REAL populated disqualifiedData leaf" as an open item). The crosswalk is
  correct for the key shapes we have seen and **refuses the rest** — so it is safe and extends cleanly,
  but the full per-investor rule vocabulary can only be locked in from a live capture. **That capture
  needs the Lender Price credentials, which are currently COMPROMISED (pasted in chat) and must be
  rotated first.** Owner action: rotate `LP_PASSWORD` / `LP_CLIENT_SECRET` / `LP_DIAG_TOKEN`, then a
  read-only disqualify capture (e.g. against the Deephaven sheet) feeds every real `adjType`/key into
  the crosswalk map. Until then the engine is built and safe; the map grows as real keys arrive.


### P1 — Feed the FULL Lender Price capture into the comparator  ·  DETECTION  ·  **DONE** ✅
- **Built.** `lp-normalize-full.js` (pure): `normalizeLpFull(parseFull)` → per-program rungs carrying
  note rate, price, **base rate**, base points, LLPA stack total, the **itemized LLPAs verbatim**
  (reason + adjType + value), and the **margin** (lender+investor holdback tiers, per-tier + total), all
  in canonical integer milli units, plus a `bestLadder` for the simple price axis;
  `normalizeLpDisqualified(parseDisqualified)` → the declined programs + reasons, filtered per
  investor/program. Test `test-lt-ppe-lp-normalize-full.js` round-trips a REAL raw searchRaw-shaped tree
  through the actual `client.parseFull`/`parseDisqualified` (not a hand-built shape) and asserts margin,
  base rate, itemized LLPAs (with adjType), and decline reasons all survive; the broker tier is reported
  but excluded from the correspondent margin total; a missing holdback is null (never 0). 37/37 suites.
- **What (original).** Build an LP-side normalizer that consumes `client.parseFull(raw)` + `client.parseDisqualified(raw)`
  (not just `client.parse()`), so the comparator sees, per rung: base rate, note rate, price, the
  **itemized LLPAs verbatim** (`groupAdjustmentProperties[].adjustments[].key`), the **margin line**
  (`holdBackResult.{broker,lender,investor}[].value`), and the **declined programs + reasons**
  (`disqualifiedData … disqualifyAdjustments[].key`).
- **Why.** Today `lp-normalize.js` consumes only `parse()`, which carries an LLPA *count* and no margin,
  no itemized LLPAs, no decline reasons — so diff categories (d) margin, (e) rules, (f) missing
  disqualification are all invisible. Everything below depends on this.
- **Acceptance test.** A pure test that feeds a captured `parseFull`/`parseDisqualified` fixture through
  the new normalizer and asserts margin, each itemized LLPA key, and each decline reason survive into
  the canonical comparison shape.
- **Depends on:** nothing (parsers already exist). **Owner gate:** none.

### P2 — Mine suggestions from a disqualifying scenario, persist to the review store  ·  **PARTIAL (mine action DONE)** ✅
- **Built.** `suggestion-miner.js` (`mineFromParsed(db, scope, parsedDisq)` — analyze → saveSuggestions,
  best-effort, never throws) + `POST /suggestions/mine` (admin-gated): supply a `searchKey` from a
  disqualify kickoff (we poll + parse it) or an already-parsed `disqualified` result; it writes the
  per-investor suggestions and returns the counts. This is the deliberate "look at an actual
  disqualifying scenario and suggest the rules" action, reusing the existing async disqualify
  orchestration (searchKey poll) so it never slows the live quote path. Tests: pure miner (fake db,
  incl. the db-failure path) + route (400 without input, save-from-parsed, admin-gated). 41/41 suites.
- **Still planned (the automatic half).** Wire the review + mine into the shadow flow so it runs on the
  canary/scheduled batches automatically (the live quote path stays lean — the disqualify tree is a
  separate async call, so per-quote mining would hit the upstream twice). That is the scheduled-canary
  wiring, not a new engine.
- **What (original).** On every price, run both engines (LP authoritative), **persist** the full R-vs-LP comparison,
- **What.** On every price, run both engines (LP authoritative), **persist** the full R-vs-LP comparison,
  and **enqueue every non-agreement into the manual-review queue** — never auto-resolved.
- **Why.** Owner: *"it should go into a manual review for a human to review, not only into demand."* The
  facade already runs shadow best-effort; this makes the comparison durable and human-visible for every
  scenario, not just canary batches.
- **Acceptance test.** DB-backed: a priced scenario with a seeded LP/ours difference writes a finding
  and appears in the review queue; an agreeing scenario writes an agreement record and no finding.
- **Depends on:** P1. **Owner gate:** none (LP still wins; nothing auto-applies).

### P3 — The six difference detectors (the owner's list), each a finding kind + test  ·  DETECTION  ·  **DONE** ✅
- **Built.** `parity-detectors.js` (pure): `detectDifferences({ ours, lp, lpDisqualified }, { settings, …tolerances })`
  compares our quote (quoteProgram) against the rich LP shape (normalizeLpFull / normalizeLpDisqualified)
  and returns categorized differences: **`base_price`**, **`final_price`**, **`coupon_missing_ours`** (high —
  borrower loses an option) / **`coupon_missing_lp`** (low), **`margin`**, **`llpa_total`** (with LP's itemized
  LLPAs attached), **`disqualification_missing`** (high — we'd price a loan LP declines; LP's reasons attached
  so a rule can be suggested) / **`disqualification_extra`**. Tolerances from settings (added
  `validation.margin_tolerance_milli` + `validation.base_price_tolerance_milli`); a within-tolerance gap is
  not reported; an LP value present with ours absent is reported (never silently agreed); an eligibility
  disagreement dominates (price axes moot). Test `test-lt-ppe-parity-detectors.js` covers all six categories,
  agree, both-decline, tolerance suppression, and the margin-present/ours-absent case. 38/38 suites.
- **What (original).** For a scenario priced on both engines, detect and categorize each mismatch. (b)(c) exist; the rest are new.
- **P3a — base rate off.** New. Compare LP `priceBuild.baseRate` vs our `basePriceMilli`/rung rate.
- **P3b — final/note rate off.** DONE in `parity.compareScenario` — verify + surface (tune
  `rateToleranceMilli`; currently 0, so a rate delta shows as a missing rung).
- **P3c — coupons off (rung present/absent).** DONE (`rung_missing_ours`/`rung_missing_theirs`) —
  verify + surface.
- **P3d — MARGIN off.** New, **biggest item.** Compare LP `holdBackResult` margin vs our
  `pricingBasis.marginMilli`. Requires P1 (LP margin never reaches the comparator today). *Detection
  needs no money formula; APPLYING holdback to price is a separate owner decision — Part 4.1.*
- **P3e — rule / LLPA line-item off.** New. Which LLPAs LP applied that we didn't (and vice-versa),
  by comparing LP's itemized `adjustments[].key` to our `trace`/`adjustments[].code`. Needs the
  crosswalk (P4) to line a LP `key` string up with our rule `code`.
- **P3f — missing disqualification.** New. Feed `parseDisqualified` into the comparator so "LP declined
  a program we would have priced" (and the decline *reason* set) is a first-class finding. Today the
  disqualified tree is parsed but never reaches the finding pipeline.
- **Acceptance test.** One pure test per detector with a fixture that isolates that single difference.
- **Depends on:** P1 (all), P4 (P3e). **Owner gate:** none for detection.

### P4 — The curated Lender-Price-key → rule-predicate crosswalk  ·  **DONE** ✅ *(status corrected 2026-08-17)*
- **What.** A **curated** map from LP's free-text LLPA/disqualify `key` strings (e.g. "LTV >75.01% <=
  80.0%", "DSCR - Interest Only") → our rule predicate `{fact, op, value}` (half-open, milli units).
  Start with the **Deephaven ("DPave")** sheet the owner named.
- **Why.** LP names rules by human `key`; we name them by `code`. A rule-level diff (P3e) and a rule
  suggestion (P5) both need this bridge. **Curated, verified against live captures, NEVER free-text
  guessed** — this is the explicit lesson of `TOKEN-REGISTRY-FINDINGS.md` / `VENDOR-CONFIG-GOLDMINE.md`
  (an over-eager guess silently mis-prices).
- **Acceptance test.** A pure test that parses each curated Deephaven key into the expected predicate
  and REFUSES (never guesses) an unrecognized key — surfacing it for a human to add to the crosswalk.
- **Depends on:** P1. **Owner gate:** ⚠️ **owner confirms the curated-crosswalk approach** (curated map,
  human-verified, never auto-guessed) before it drives any suggested rule.

### P5 — The rule-suggestion engine + a suggestion store  ·  WRITES A PROPOSAL  ·  **DONE** ✅ *(status corrected 2026-08-17)*
- **What.** Given a missing disqualification (or a missing LLPA) from P3e/P3f, synthesize a **suggested
  rule** — `{ kind:'eligibility'|'pricing', source:'overlay', when:<predicate from P4>, declineReason:<LP
  key verbatim>, code:<generated> }` scoped to `investor:<code>` — and record it as a **proposal** in a
  new `lt_ppe_rule_suggestion` store. A human ACCEPTS it; it is never auto-applied.
- **Why.** Owner: *"the manual review engine should suggest rules that we should add so our system
  exactly matches Lender Price … take the disqualifications coming from Lender Price and suggest our
  system import the same disqualifications by adding it into a rule for this particular investor."* The
  findings ledger has no `suggestedRule` field today — this adds the proposal record + the "accept"
  action shape.
- **Acceptance test.** DB-backed: an LP decline our engine misses produces a suggestion row scoped to
  that investor, with the LP reason verbatim and a valid predicate; re-running never duplicates it.
- **Depends on:** P1, P3f, P4, P6. **Owner gate:** ⚠️ suggestions are proposals only; a human accepts.

### P6 — The eligibility/bound rule table  ·  **DONE** ✅  (+ P5-store + P7 accept-and-write)
- **Built.** `db/571_lt_ppe_rule_and_suggestion_store.sql` — `lt_ppe_rule` (the persistent home for
  eligibility/bound/pricing rules per investor/program, overlay-aware, with provenance:
  origin=manual|suggested|imported + the verbatim LP decline reason) and `lt_ppe_rule_suggestion` (the
  proposal store, deduped per distinct disqualification per investor). `rule-store.js` (DB bridge):
  `saveSuggestions` (idempotent; refreshes only an OPEN row so a decided suggestion never reopens;
  unmappable reasons stored predicate-NULL + needs_human), `listSuggestions`, **`acceptSuggestion`**
  (one transaction: writes an `lt_ppe_rule` from the suggestion, links it back, marks accepted; REFUSES
  a needs-human or non-open suggestion), `dismissSuggestion`, `listRules`, and **`rulesForProgram`**
  (loads a program's active rules already in the `rules.js` shape — the P7 read that feeds the engine).
  Test `test-lt-ppe-rule-store-db.js` (pure + DB round-trip) proves the full loop end-to-end: mine LP
  declines → save → accept the FICO suggestion → a rule is written + linked → `rulesForProgram` returns
  it → `evaluateRules` declines a 640-FICO loan (our engine now matches Lender Price) while a 720 passes;
  plus idempotency, dismiss, and the needs-human refusal. Nothing auto-applies — a human accepts. 40/40.
- **HTTP surface wired** (`routes/ppe.js`): `GET /suggestions`, `GET /rules` (open to staff — you must
  see a proposal to judge it), `POST /suggestions/:id/accept`, `POST /suggestions/:id/dismiss`
  (admin-gated, exactly like deciding a finding). Accept auto-scopes the rule to the suggestion's
  investor (resolved from its label) unless one is named. Route test covers the gating + id validation.
- **What (original).** `db/NNN_lt_ppe_rule.sql`
- **What.** `db/NNN_lt_ppe_rule.sql` + a store, the persistent home for eligibility/bound rules per
  investor/program (overlay-aware), so an accepted suggestion and a hand-authored rule both persist.
- **Why.** `ratesheet.js` anticipates it ("a later rule table"); it does not exist. Prerequisite for P5's
  accept-and-write loop.
- **Acceptance test.** DB-backed: write an overlay eligibility rule, load it into a program, and prove
  `evaluateRules` declines the scenario it targets — and that an overlay can only tighten.
- **Depends on:** nothing new. **Owner gate:** none (structure only).

### P7 — Close the loop: accept a suggestion → write the rule → re-run parity  ·  **DONE** ✅ *(status corrected 2026-08-17)*
- **What.** Accepting a P5 suggestion writes it into the P6 rule table (overlay, scoped to the investor);
  the next parity run shows the finding **resolved** (our engine now declines exactly what LP declines).
- **Why.** This is the whole point — the review makes our engine converge on Lender Price, investor by
  investor.
- **Acceptance test.** DB-backed end-to-end: seed an LP decline we miss → suggestion appears → accept →
  rule written → re-run → finding settles and does not re-open.
- **Depends on:** P5, P6. **Owner gate:** ⚠️ a human performs the accept.

### P8 — The manual-review + suggested-rules UI  ·  **DONE** ✅ *(built 2026-08-17)*
- **What.** A staff-only screen (`app-v2/src/longterm/**`): per scenario, LP's answer beside ours, the
  categorized diffs (P3a–f), and the suggested rules (P5) with an **Accept** button (P7). Investor names
  stay staff-only.
- **Acceptance test.** Renders the diffs + a suggestion; Accept calls the P7 endpoint; dark-on-white per
  the house rule.
- **Depends on:** P2, P3, P5, P7. **Owner gate:** none.

- **STATUS CORRECTED 2026-08-17, against the code rather than from memory.** P4/P5/P7 were still marked
  TO-BUILD here while P6 two rows down already announced "+ P5-store + P7 accept-and-write" — the
  document contradicted itself, and a plan that reports built work as outstanding sends the next person
  to rebuild it. Verified present: the crosswalk `ppe/disqualify-crosswalk.js` (`keyToPredicate`, which
  REFUSES an unrecognised key rather than guessing), the miner `ppe/suggestion-miner.js`, the store
  `ppe/rule-store.js` (`saveSuggestions` / `listSuggestions` / `acceptSuggestion` / `dismissSuggestion`,
  idempotent on `(scope, investor_label, dedupe_key)`, and a decided suggestion is never reopened), the
  tables `db/571_lt_ppe_rule_and_suggestion_store.sql`, and the routes `GET /ppe/suggestions` +
  `POST /ppe/suggestions/:id/{accept,dismiss,…}` with accept/dismiss admin-gated.
- **P8 was the one that was genuinely missing, and it is now built** — the "Rules Lender Price's
  refusals suggest" section of `app-v2/src/longterm/LtPpe.jsx`. It was the human end of the loop: every
  server piece existed, so the only way to accept a suggestion was to call the endpoint by hand.
  `scripts/test-lt-ppe-suggestion-ui.mjs` (25 assertions, 4 mutation-proven) pins the two traps it is
  built around — the list is deliberately NOT filtered by the screen's investor picker (that carries OUR
  investor CODE while a suggestion carries Lender Price's VERBATIM label, so filtering would return an
  empty list indistinguishable from "nothing to do"), and a failed read is STATED rather than falling
  back to an empty list that reads as all-clear.

### P9 — The point-for-point price parity matrix per investor  ·  **DONE (the measurement)** ✅ *(2026-08-17)*
- **What.** Run the real rate-for-rate comparison across the scenario matrix for the pilot investor
  (Deephaven), producing the sliced parity dashboard (by state / DSCR band / FICO / LTV) and the trend.
- **Why.** Today's parity is count/eligibility; this is the sustained-agreement metric that gates
  cutover. *(MEGA §10.3a / §10.5.)*
- **THE BLOCKER WAS A DATA-LOSS DEFECT, not missing analysis.** `shadow.runOne` reduced each scenario
  to a display STRING and threw the object away — one function before anybody could use it. So the
  findings ledger's `scenario_facts` column (db/561) was NULL on every finding the canary ever recorded,
  and a dashboard "sliced by state / DSCR band / FICO / LTV" had no facts to slice by. The facts now
  ride beside the label (`result.facts`), and the canary hands them to the ledger. The LABEL is
  unchanged — the finding key is built from it and must not move.
- **Built.** `parity-matrix.js` (pure): `buildParityMatrix(results, {program})` slices a run by the
  scenarios' own facts and reports, per cell, agreed / disagreed / errors / incomparable / **overlay**
  (a D29 reasoned override is not a defect and is never hidden inside `disagreed`) plus the price gap —
  `scenarios` vs `samples` kept apart, a SIGNED mean (a sheet uniformly light is a different problem
  from one scattered either side) and `worstAbsMilli` for how bad it gets. `worstCells` ranks without
  inventing a threshold — what counts as bad enough to act on is the owner's tolerance decision.
- **THE BANDS ARE THE SHEET'S OWN EDGES, derived, never invented.** `bandsFromProgram` reads each
  axis's cut points off the program's OWN rules, REUSING `rule-coverage.regionOf` so the two can never
  disagree about where a sheet breaks. Measured on the real Deephaven sheet: seven axes, FICO at
  640/660/680/700/720/740/760/780. A dashboard cutting at "the usual" 660/680/700 would straddle real
  breaks and average a good band with a bad one. Half-open, so a scenario on an edge lands in exactly
  one cell. An axis the sheet does not describe is NOT given invented bands.
- **Nothing is silently bucketed.** Every unplaceable scenario is counted with its own reason, there is
  no catch-all cell masquerading as a band, and every dimension RECONCILES (cells + unsliceable = the
  run's total) with the arithmetic carried on the report. A slice that loses scenarios reports a better
  agreement rate than the run earned — the one direction this must never be wrong in.
- **Reachable:** it rides on `canary.runCanary` and `POST /canary` publishes `matrix` + `worstCells`
  (not the up-to-500 raw results). Test `scripts/test-lt-ppe-parity-matrix.js` (95); 17 mutations
  proven to fail it.
- **DONE — the TREND across runs (db/575, 2026-08-17).** `lt_ppe_parity_cell` stores one row per cell
  per run, so "has THIS band been off for three weeks, or was that one bad afternoon?" — the question a
  cutover decision actually turns on — is answerable. `parity-cell-store.js` writes it from the canary
  (a third durable record beside the findings ledger and the run series, reported separately because
  the three fail independently) and reads it back as `GET /parity-cells`. **A MISSING ROW MEANS "NOT
  MEASURED", NEVER "MEASURED BADLY":** a run with no scenarios in a band writes nothing for it, gaps
  are never zero-filled, and `daysMeasured` vs `windowDays` is reported so a cell measured on two of
  twenty days is not presented like one measured on all twenty. Ranked by PERSISTENCE (days seen
  disagreeing) — a chronic band that has just started recovering outranks one that broke this morning,
  which a latest-rate sort inverts. The direction is `scoreboard.trend`, reused so "improving" means
  one thing here. It RANKS and never thresholds. Test
  `scripts/test-lt-ppe-parity-cell-store.js` (118); 18 mutations proven to fail it.
- **DONE — the SCREEN (2026-08-17).** "Where it disagrees" on `LtPpe.jsx`, reading `GET /parity-cells`:
  the bands that have disagreed on the most days, each with its latest agreement, its worst gap and
  its direction, and a day-by-day view behind each row. It holds no threshold and does no sorting of
  its own. Four ways a parity screen can lie are each closed and each mutation-proven:
  **(a) THE EMPTY-VIEW LIE** — the series is keyed EXACTLY on (investor, program) as the canary wrote
  it, so asking for a key nobody wrote returns an empty list, which drawn as "nothing has ever been
  measured" is indistinguishable from a clean book. So the read now also returns
  `parityCellStore.listSeries` — the series that actually hold rows — the picker is built from THAT,
  the default is named "runs recorded against no investor" rather than "everything", and an empty view
  names the series that do hold measurements instead of reporting silence.
  **(b) THE GAP LIE** — days measured is shown against the window asked about, and days-disagreeing
  against the same denominator, so a band measured on two of thirty days never sits beside one
  measured on all thirty as though they weigh the same.
  **(c) THE ZERO-FILL LIE** — only the days the server returned are drawn, and an unmeasured rate is a
  dash, never 0%.
  **(d) THE UNITS LIE** — parity gaps are canonical integer MILLI-points, so a 1.25-point gap printed
  raw reads as "1250" — a catastrophe on a rate sheet. Converted once, in one helper.
  Guards: `scripts/test-lt-ppe-screen-pure.mjs` (extended) + `test-lt-ppe-parity-cell-store.js` (146).
  Along the way `listCells` turned out to have **no coverage at all** — a mutation removing its window
  clause left the whole suite green, which would have served a whole quarter's measurements under a
  "last 30 days" heading. It has its own section now, and two of the new screen guards came back GREEN
  when first mutated because they matched a NAME the mutation left behind (`parity.series` still
  matched inside `parity.seriesTruncated`); both are pinned to their composed form, and the guards now
  run against comment-stripped source so a test can never be satisfied by the prose explaining it.
- **Depends on:** P1, P3. **Owner gate:** ⚠️ tolerances + clean-weeks threshold — Part 4.2/4.3 — which
  gate the CUTOVER decision, not the measurement; the matrix ranks and never thresholds.

### P10 — The promote-to-live route + human promote/rollback  ·  TO-BUILD (supporting)
- **What.** The missing HTTP endpoint that drives the built cutover gate: a human promotes an investor
  shadow→live (gated on the scoreboard) and can roll back instantly.
- **Depends on:** P9. **Owner gate:** ⚠️ who may promote; whether "live" keeps an LP spot-check canary.

---

## Part 4 — Owner decisions needed (each blocks a specific step)

**ANSWERED 2026-08-17 (owner, via the beginner-question round):**

- **Our markup is PER INVESTOR.** ✅ Each investor (and its programs) carries its OWN markup number
  that we set and control — not one flat company-wide cut. Foundation is already in place:
  `store.resolveMarginHoldbackForInvestor` layers investor → company → default, and
  `pricing.margin_holdback_rules` holds the per-investor entries. *Next: expose the per-investor
  markup in the admin surface + the rate-sheet editor (E3).*
- **Parity match is EXACT, to the penny.** ✅ (was decision 2) Any difference at all → a disagreement
  → human review. Encoded: `validation.price_tolerance_milli` and `base_price_tolerance_milli`
  defaults set to **0** (rate + margin were already 0). An admin may still loosen per-company.
- **Curated crosswalk stays ALWAYS human-approved.** ✅ (was decision 4) Nothing the engine suggests
  turns on by itself — a person accepts every rule. Matches the built `acceptSuggestion` loop
  (`needs_human` / `origin='suggested'`, never auto-applied). *Unblocks: P4 driving P5.*
- **Pilot investor = Deephaven, first.** ✅ (was decision 5) Confirmed as the first rate sheet for
  the Excel-grid editor (E3) and the parity matrix (P9).

**STILL OPEN:**

1. **Holdback → final-rate formula (the finer MONEY mechanic).** Markup being per-investor is settled;
   what remains is HOW a per-investor *holdback* combines into the borrower's quote — a second cost
   line like margin, retained out of our spread invisibly, or eligibility-gating. *Blocks: applying
   holdback to price (not its detection).* Margin (per-investor) and detection proceed without it.
3. **Clean-weeks cutover threshold.** Consecutive clean weeks before an investor may go live
   (default 8). *Blocks: P9/P10 gate.*
6. **Promotion authority + live spot-check.** Who promotes; does "live" keep an occasional LP canary?
   *Blocks: P10.*

**Two action items for the owner (not code):**
- Re-attach the Deephaven Corr Flow Excel if a fresh copy exists — we have the full written
  breakdown, but the .xlsx binary is not stored here; re-verifying exact cell values would sharpen E3.
- The Lender Price login password appeared in an earlier chat and is considered compromised — reset
  it in the vendor portal and set the new value in Render before any live disqualify captures run.

---

## Part 5 — Execution order (number by number)

**DONE so far:** **P-DQ** (disqualify analysis + crosswalk + rule suggestions), **P1** (rich LP capture:
margin, itemized LLPAs, base rate, decline reasons in canonical units), **P3** (the six difference
detectors), and the **review composer** (`parity-review.js` — one call: a priced scenario → its
differences vs Lender Price + the suggested per-investor rules, proven end-to-end through the real
parser + real engine), plus Layer-1/Layer-2 margin/holdback. **The whole detection + suggestion half of
the parity engine is built and pure-tested (39/39 suites).**

Detection-only and safe to build next (LP still wins; nothing auto-applies): **P1 → P2 → P3 (a–f) → P9**.
Rule-writing loop, gated on Part 4.1/4.4 + a human in the loop: **P6 → P5-store → P7 → P8** (P4's
disqualify crosswalk is already built by P-DQ; widen it from a live capture once credentials are
rotated). Supporting: **P10** (after P9). Housekeeping alongside: fix the stale db/567 comments (2.2).

Progress is tracked against these numbers. Each step is one commit (or a tight set) with `[skip ci]`,
its tests green, on branch `claude/lender-price-frontend-agent-7g7tm9`, and reported by its P-number so
you can see exactly where we are and that we are on track.

---

## Part 6 — Expanded scope (owner-directed 2026-08-17, evening) — numbered

The owner extended the vision. These are captured as numbered items so the plan stays the control
document; several are gated on the three research engines now running (open-source foundation; the
fields/Excel-grid→rule design; the disqualify-always workflow + troubleshooter).

- **E1 — Disqualify runs ALWAYS, right after the eligible results.** Every scenario: show the eligible
  (qualified) answer, then IMMEDIATELY run the disqualify side (there are always many declined programs).
  Mine every investor's every program's disqualifiers into the suggestion box. *(Builds on P2's mine
  action + the async disqualify flow; the "automatic after eligible" wiring is the new part.)*
- **E2 — Read the disqualify side per INVESTOR and per PROGRAM.** One investor has many programs; each
  program can have different disqualifiers. The system must extract every investor name + every program
  name + each program's disqualifiers, exactly. *(Research engine C is auditing whether our parser
  already carries the program for every disqualification, or if there's a gap.)*
- **E3 — Each investor is an Excel-like rate sheet, per program.** Investor → several programs → each
  program its own editable grid that LOOKS like the rate-sheet Excel, where **every box = a rule** in the
  back. Ineligible cells (LTV too high / FICO too low) are marked. Purchase / rate-term refi / cash-out
  each carry their own limits. A "rules view" toggle shows the same thing as rules; you can duplicate a
  rule and tweak one field. *(Research engine B is designing the grid↔rule round-trip on our existing
  lt_ppe_adjustment / lt_ppe_rule tables.)*
  - **⛔ HARD RULE — LENDER PRICE AGREEMENT BEFORE BUILDING A RATE SHEET (owner-directed 2026-08-17,
    the owner's own words: "make a hard rule that, before you start continuing to build any kind of rate
    sheet into our system, you first need to get comfortable with at least 200 scenarios from every
    certain angle of the rate sheet, to compare with Lender Price to see that you understand the logic
    and you both agree with every single LLPA, with every single eligibility and every single
    ineligibility. You need to understand max price and min price… You need to have an agreement with
    Lender Price before you start building, because if not, it's going to be the biggest mess ever").**
    This is a GATE, not a suggestion. Building a rate sheet into the system (wiring the grid to a live
    surface, letting it drive a suggestion, promoting an investor) is FORBIDDEN until, for that
    investor's rate sheet, ALL of the following hold and are PROVEN:
    1. **≥ 200 scenarios, from every angle** — FICO bands, CLTV bands, every DSCR band (incl. sub-1.0),
       purpose (purchase / rate-term / cash-out), loan-amount tiers, term, lock. Built by
       `scenario-matrix.buildMatrix`, deliberately including scenarios that SHOULD be ineligible.
    2. **Independent analysis** — build the Deephaven grid → our engine, and state what WE think each
       scenario prices to (and which are ineligible + why), from the grid alone.
    3. **Lender Price backing (exact agreement)** — run the SAME scenarios on Lender Price (Deephaven
       leaves) and confirm, to the penny, agreement on EVERY: base price, **every single LLPA**, final
       price, **max price (cap) and min price (floor)**, margin, **every eligibility**, and **every
       ineligibility** (an ineligible scenario returns a disqualifier that MATCHES the rate sheet's
       disqualifier — same dimension, same reason). Anything that does not agree is a STOP: understand
       WHY before writing one more line, because a rate sheet built on a misunderstanding is "the biggest
       mess ever."
    4. **While building, keep matching** — parity is re-checked continuously as the sheet is built, not
       once at the end.
    The grid model below is **BUILT but UNVALIDATED against live Lender Price**, so per this rule it is
    inert: not trusted, not wired live, not driving suggestions, until the ≥200-scenario agreement passes.
    - **The harness already exists** and needs no new engine: `scenario-matrix.buildMatrix` (the battery,
      deterministic, many axes, truncation-reported) + `parity-review.reviewScenario` +
      `parity-detectors` (base_price / final_price / coupon / margin / **llpa_total** differences AND
      `disqualification_missing`/`_extra`) + `lp-normalize-full` (carries base rates, adjustment points,
      margin, LLPAs in canonical milli units). The one thin piece to add is a per-investor
      grid-validation report that composes them over the ≥200 battery and emits a per-scenario pass/fail
      (eligible price+LLPA+cap/floor match AND disqualify match), plus the summary "we agree on N/200,
      here is every disagreement."
      - **CORRECTED 2026-08-17 (§2.18 of the parity status): `lp-normalize-full` does NOT carry max/min
        price** — the claim above said it did, and it never has. Lender Price's payload publishes a rung
        LADDER; `client.parse` derives a `maxPrice` from it that is the **best observed price on that
        ladder, not a declared ceiling**, and the two must never be read as the same thing. Whether the
        vendor declares a cap/floor field at all is UNMEASURED and needs a live capture. The cap/floor
        axis is therefore checked against **our own** stated limit (frame-free) — `boundsProbe` +
        `runOne` opts.boundsGate + the `summary.bounds` roll-up — never against a vendor number we do
        not have. MEASURED at the same time: the DEFAULT built-in Deephaven grid states no ceiling at
        all and prices to 110.500 against a sheet whose ceiling is 105 (the max-price block is the
        `--with-prepay` grid, where 4,180 of 7,168 rungs clamp at the cap).
    - **BLOCKED on two owner action items (both in Part 4):** (a) the Lender Price login was exposed in
      chat and is compromised — ROTATE it before any live scenario runs; (b) the actual Deephaven Excel
      (`Corr_Flow_Rate_Sheet__T0__Excel.xlsx`) so the grid is built from the real cells, not the written
      breakdown. Until both land the live agreement cannot run, so no rate sheet may be built in.
  - **DONE (grid MODEL, 2026-08-17):** `ppe/deephaven-grid.js` `gridToRateSheet` — the pure converter
    from a human Deephaven-shaped grid (coupon rows → base prices; a FICO × CLTV grid segmented by DSCR
    band → LLPA cells; loan-amount / predicate LLPA tables) into the EXACT stored shape the built
    pipeline already prices (`ratesheet.rateSheetToProgram` → `quote.quoteProgram`). Every box becomes a
    rule: a number → a pricing adjustment, an **N/A box → an INELIGIBILITY** (decline, never a priced 0).
    Three money-safe rules are pinned by test: explicit half-open bands (never inferred from a label);
    the unit convention (FICO raw, CLTV/DSCR milli, loan-amount raw); and **the sign rule** (a sheet
    premium improves price = negative points to the engine — proven end-to-end, 5 assertions go red if
    reverted). Test `scripts/test-lt-ppe-deephaven-grid.js` (22 checks, prices a real scenario to
    103.100 through the real engine). **Next for E3:** the inverse (`rateSheetToGrid`, for the editor to
    render a stored sheet as a grid), the per-program scoping, and the front-end Excel editor itself
    (needs the real .xlsx to pin exact cells — owner action item).
- **E4 — A full rule hierarchy: across-the-board / per-investor / per-program.** Every field can be a
  filter (state, city, FICO, LTV, DSCR, purpose, …). A rule can apply to all investors + all programs,
  or one investor, or one program. *(lt_ppe_rule already supports this scoping; the UI + field catalog
  is the build.)*
- **E5 — Excel IMPORT button, per pre-configured investor/program template.** Go to an investor already
  set up in the back end that knows that investor's sheet layout and which program it is; import (or
  update from) an Excel rate sheet. Only pre-configured sheet types. *(Builds on ratesheet-ingest.js.)*
- **E6 — Daily base-rate refresh at 10 / 11 / 12 AM Eastern.** The base rate changes every day; each
  investor publishes an updated base rate. Run a basic scenario per investor at those times to pull the
  updated base rate into our system. *(A scheduled job; the rate-sheet version store already exists.)*
- **E7 — Confidence maturity.** Over time the system learns which scenarios it's confident about vs where
  it disagrees with Lender Price most (more bumps). *(scoreboard.js / run-store.js already measure
  agreement over time; the build is slicing it by scenario type / investor / program.)*
- **E8 — The major back-end TROUBLESHOOTER.** Per scenario: "Lender Price returned X; our engine returned
  Y (what we showed the user); and here are the rules I'm suggesting to add so next time we agree with
  Lender Price." *(Composes parity-review.js + the suggestion store; the build is the record + the
  screen.)*

- **E9 — The loan-officer MARGIN + COMPENSATION model (owner-directed 2026-08-17).** How the company AND
  each loan officer make money on top of the investor's raw pricing. Full design:
  `docs/longterm/ppe-research/COMPENSATION-MARGIN-MODEL.md`. The owner's rules, captured:
  - **The 0.25 company holdback is NON-OVERRIDABLE.** It is a company margin, kept in the back, shown
    behind the investor pricing. A loan officer can NEVER remove or override it. Company-set on the loan.
  - **Company default margin = 2.00, made two ways** (and the LO chooses the split): price at par (100) +
    a 2-point ORIGINATION charge (front), OR zero origination + price at 102 (back/rebate). Every LO
    defaults to points but sets his OWN front/back split in personal settings.
  - **Totals include the 0.25:** an LO who wants to make 2.25 himself means a 2.5 TOTAL margin (0.25
    company + 2.25 his). Example split: 0.25 in the back + 2 points origination.
  - **Two Lender Price search modes:** we ALWAYS search **borrower-paid**, which prices with ONLY our
    0.25 holdback (investor really 100.25, shown 100) and the LO's origination goes on top; a
    **lender-paid** search carries the LO's ENTIRE markup in the back (e.g. investor 102.25 shows as 100,
    keeping 2.25 in the back). Our holdback can never be removed from either.
  - **Min / Max per loan (dollar), company default + per-LO override:** a $3,000 minimum on a $100k loan
    = 3 points (not the standard 2); a $50,000 maximum on a $5M loan = 1 point.
  - **Compensation SPLIT** (company settings, per LO): only on the ORIGINATION charges, NEVER on the 0.25
    holdback. The LO gets a % of the origination and can always see what he nets on a file.
  - **Guardrails:** 0.25 never removable; split only on origination, never on the holdback; company sets
    defaults, LO overrides everything EXCEPT the 0.25. Builds on `ppe/margin-holdback.js`,
    `store.resolveMarginHoldbackForInvestor`, `settings.js` (add `comp.*` keys + an `officer:<id>`
    scope), `quote.js` (holdbackMilli carried-not-applied), `search-model.js compPlanValue`. **DESIGN
    ONLY — not built; 2 open questions flagged** (does the split touch back-earned margin? is the company
    min/max a hard floor or a replaceable default?).

**Sequencing:** E2 (parser audit) and E8 (troubleshooter record) are backend and can proceed as the
research lands; E1 (auto-disqualify wiring) needs the live upstream (credentials rotated); E3/E4/E5 (the
Excel-grid UI + import) are GATED by the ⛔ ≥200-scenario Lender Price agreement (E3 above); E6 is a
scheduled job; E7 extends the scoreboard; E9 (comp model) is design-ready pending 2 owner answers. The
three owner decisions in Part 4 still gate the money math + go-live.

## Part 7 — The official research engine output (owner-directed 2026-08-17: "everything written down")

The owner asked for an engine to collect every piece of information given across the whole initiative,
research each, and record it officially. Four research passes ran and their outputs are committed as
official LT docs (read these; they are the detail behind Parts 1–6):

1. **`ppe-research/REQUIREMENTS-LEDGER.md`** — the exhaustive, numbered ledger: EVERY owner directive →
   DONE / PARTIAL / TODO, where it lives in code/docs, and the gap. Grouped A–G (shadow/parity engine;
   disqualify+suggestions; rate-sheet grid; rule hierarchy; ops E6–E8; owner decisions; margin money).
2. **`ppe-research/RATE-SHEET-BACKEND-MECHANICS.md`** — the ground-truth backend reference: rate-sheet
   vocabulary + stacking, the Deephaven "Corr Flow" DSCR sheet block-by-block, the full Lender Price
   response anatomy (concept → our stored field → LP response path), the disqualify training insight,
   and the exact milli units + the cost-positive sign convention. **This is what we must AGREE with.**
3. **`ppe-research/LENDER-PRICE-AGREEMENT-HARNESS.md`** — the design of the ⛔ ≥200-scenario agreement
   harness (the E3 gate): the scenario battery (every angle, incl. deliberately-ineligible + cap/floor
   edges), the per-scenario eligible + disqualify + max/min comparison, the per-LLPA reconciliation, and
   the one thin new module `ratesheet-agreement.js` composing existing parity modules. Fixture-testable
   offline; live agreement blocked on the two items below.
4. **`ppe-research/COMPENSATION-MARGIN-MODEL.md`** — E9 above, in full, with four worked numeric examples.

**THE TWO BLOCKERS THAT GATE EVERYTHING LIVE (owner action items):**
- **Rotate the Lender Price login** — it was exposed in chat and is compromised; no live scenario can run
  until it is reset and the new value is in Render.
- **The Deephaven Excel is now RECEIVED** (`Corr_Flow_Rate_Sheet__T0__Excel.xlsx`, DSCR tab) — so the
  grid can be built from the real cells; the live agreement still waits on the login reset.

## Appendix — key Lender Price field paths (the ground truth for Part 3)

From `LENDERPRICE-RESPONSE-SCHEMA.md` + `lenderprice/client.js`:
- **Price build (per leaf):** base rate `baseRates`/`rawRates`; note rate `rate`/`adjustedRates`; base
  points `basePoints`; LLPA total `adjustmentPoints`; final points `adjustedPoints`; price = `100 −
  adjustedPoints`; APR `apr`; APOR `apor`.
- **Itemized LLPAs:** `leaf.groupAdjustmentProperties[].adjustments[]` — each `{ key:"<reason>",
  type:"LLPA", valueType:"Points", adj }`. RATE analogue: `groupRateAdjustmentProperties[]`.
- **Margin / holdback:** `leaf.holdBackResult.{broker,lender,investor}.adjustments[]` — each
  `{ key:"NDC Margin - 0.25%", type:"Margin", valueType:"Points", adj }` + `qualifications` /
  `disqualifications`.
- **Disqualified tree:** `results.disqualifiedData` (same Program→Rate→Lender shape); each declined leaf
  `disqualified:true` + `groupAdjustmentProperties[].disqualifyAdjustments[].key` + `conditionActions[]`
  + `holdBackResult.*.disqualifications[]`.
- **Our side:** `quote.quoteProgram` → `{ eligible, ladder[<reconstruction record>], declines[],
  pricingBasis{ marginMilli, holdbackMilli } }`; `rules.evaluateRules` → `{ declines[], bounds, trace[],
  adjustments[] }`.
