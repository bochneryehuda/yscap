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
- **TO-BUILD:** a first-class **`lt_ppe_rule` / ruleset table** for *eligibility & bound* rules.
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
- **TO-BUILD:** the persistent rule *table* (2.2 above) and publish-time gap/overlap coverage validation
  wired to a stored rule set.

### 2.7 Locks & secondary market — **DONE (engine) / TO-BUILD (surface)**
`lock.js` — full lifecycle, frozen price stack, worst-case relock, expiry block; pure, tested. No HTTP
surface or lock-desk UI yet. *(MEGA §8. Later increment.)*

### 2.8 The dual-run "LP wins" model — **PARTIAL** ⭐ active
- **DONE:** `facade.js priceWithShadow` (shadow default, LP is the business answer, our engine's failure
  never breaks it, comparison is best-effort/async). *(MEGA §9.)*
- **TO-BUILD:** the comparison today is **shallow** — it consumes only `client.parse()` (qualified
  rungs + an LLPA *count*), so it cannot see **margin, itemized LLPAs, or disqualification reasons.**
  Deepening this is P1 of the active workstream.

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


### P1 — Feed the FULL Lender Price capture into the comparator  ·  DETECTION  ·  TO-BUILD
- **What.** Build an LP-side normalizer that consumes `client.parseFull(raw)` + `client.parseDisqualified(raw)`
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

### P2 — Dual-run every scenario, persist the comparison, route to MANUAL review  ·  TO-BUILD
- **What.** On every price, run both engines (LP authoritative), **persist** the full R-vs-LP comparison,
  and **enqueue every non-agreement into the manual-review queue** — never auto-resolved.
- **Why.** Owner: *"it should go into a manual review for a human to review, not only into demand."* The
  facade already runs shadow best-effort; this makes the comparison durable and human-visible for every
  scenario, not just canary batches.
- **Acceptance test.** DB-backed: a priced scenario with a seeded LP/ours difference writes a finding
  and appears in the review queue; an agreeing scenario writes an agreement record and no finding.
- **Depends on:** P1. **Owner gate:** none (LP still wins; nothing auto-applies).

### P3 — The six difference detectors (the owner's list), each a finding kind + test  ·  DETECTION  ·  TO-BUILD
For a scenario priced on both engines, detect and categorize each mismatch. (b)(c) exist; the rest are new.
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

### P4 — The curated Lender-Price-key → rule-predicate crosswalk  ·  TO-BUILD
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

### P5 — The rule-suggestion engine + a suggestion store  ·  WRITES A PROPOSAL  ·  TO-BUILD
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

### P6 — The eligibility/bound rule table  ·  TO-BUILD
- **What.** `db/NNN_lt_ppe_rule.sql` + a store, the persistent home for eligibility/bound rules per
  investor/program (overlay-aware), so an accepted suggestion and a hand-authored rule both persist.
- **Why.** `ratesheet.js` anticipates it ("a later rule table"); it does not exist. Prerequisite for P5's
  accept-and-write loop.
- **Acceptance test.** DB-backed: write an overlay eligibility rule, load it into a program, and prove
  `evaluateRules` declines the scenario it targets — and that an overlay can only tighten.
- **Depends on:** nothing new. **Owner gate:** none (structure only).

### P7 — Close the loop: accept a suggestion → write the rule → re-run parity  ·  TO-BUILD
- **What.** Accepting a P5 suggestion writes it into the P6 rule table (overlay, scoped to the investor);
  the next parity run shows the finding **resolved** (our engine now declines exactly what LP declines).
- **Why.** This is the whole point — the review makes our engine converge on Lender Price, investor by
  investor.
- **Acceptance test.** DB-backed end-to-end: seed an LP decline we miss → suggestion appears → accept →
  rule written → re-run → finding settles and does not re-open.
- **Depends on:** P5, P6. **Owner gate:** ⚠️ a human performs the accept.

### P8 — The manual-review + suggested-rules UI  ·  TO-BUILD
- **What.** A staff-only screen (`app-v2/src/longterm/**`): per scenario, LP's answer beside ours, the
  categorized diffs (P3a–f), and the suggested rules (P5) with an **Accept** button (P7). Investor names
  stay staff-only.
- **Acceptance test.** Renders the diffs + a suggestion; Accept calls the P7 endpoint; dark-on-white per
  the house rule.
- **Depends on:** P2, P3, P5, P7. **Owner gate:** none.

### P9 — The point-for-point price parity matrix per investor  ·  TO-BUILD
- **What.** Run the real rate-for-rate comparison across the scenario matrix for the pilot investor
  (Deephaven), producing the sliced parity dashboard (by state / DSCR band / FICO / LTV) and the trend.
- **Why.** Today's parity is count/eligibility; this is the sustained-agreement metric that gates
  cutover. *(MEGA §10.3a / §10.5.)*
- **Acceptance test.** A canary run over the matrix records per-cell price deltas and the scoreboard
  reflects them.
- **Depends on:** P1, P3. **Owner gate:** ⚠️ tolerances + clean-weeks threshold — Part 4.2/4.3.

### P10 — The promote-to-live route + human promote/rollback  ·  TO-BUILD (supporting)
- **What.** The missing HTTP endpoint that drives the built cutover gate: a human promotes an investor
  shadow→live (gated on the scoreboard) and can roll back instantly.
- **Depends on:** P9. **Owner gate:** ⚠️ who may promote; whether "live" keeps an LP spot-check canary.

---

## Part 4 — Owner decisions needed (each blocks a specific step)

1. **Holdback → final-rate formula (a MONEY rule).** How does the per-investor holdback combine into the
   borrower's quote — a second cost line like margin, retained out of our spread invisibly, or
   eligibility-gating? *Blocks: applying holdback to price (not its detection).* Needed before P3d wires
   holdback into the pipeline; margin detection proceeds without it.
2. **Parity tolerances.** Price within ±X (default 0.001 point) and rate exact? *Blocks: P9's verdicts.*
3. **Clean-weeks cutover threshold.** Consecutive clean weeks before an investor may go live (default 8).
   *Blocks: P9/P10 gate.*
4. **Curated-crosswalk approval.** Confirm the LP-key→predicate map is curated + human-verified, never
   auto-guessed. *Blocks: P4 driving P5.*
5. **Pilot investor.** Owner named **Deephaven ("DPave")** — confirmed as first. *Drives P4/P9.*
6. **Promotion authority + live spot-check.** Who promotes; does "live" keep an occasional LP canary?
   *Blocks: P10.*

---

## Part 5 — Execution order (number by number)

**DONE so far:** **P-DQ** (the disqualify-side analysis + crosswalk + rule suggestions — owner's first
step) and Layer-1/Layer-2 margin/holdback (Part 2.3/2.5).

Detection-only and safe to build next (LP still wins; nothing auto-applies): **P1 → P2 → P3 (a–f) → P9**.
Rule-writing loop, gated on Part 4.1/4.4 + a human in the loop: **P6 → P5-store → P7 → P8** (P4's
disqualify crosswalk is already built by P-DQ; widen it from a live capture once credentials are
rotated). Supporting: **P10** (after P9). Housekeeping alongside: fix the stale db/567 comments (2.2).

Progress is tracked against these numbers. Each step is one commit (or a tight set) with `[skip ci]`,
its tests green, on branch `claude/lender-price-frontend-agent-7g7tm9`, and reported by its P-number so
you can see exactly where we are and that we are on track.

---

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
