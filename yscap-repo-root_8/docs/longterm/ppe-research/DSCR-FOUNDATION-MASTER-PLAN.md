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
6. **Rule mining + condition builder** (running). Mine every eligibility/ineligibility/LLPA rule from the
   three layers to pre-fill; design the universal rule shape + builder ops (create/duplicate/edit/add
   LLPA/add margin-holdback) like the mega systems.
7. **Message audit** (running). Go through every owner message for instructions not yet in this plan.

---

## 4. Build status

**DONE (committed, tested, pushed on `claude/lender-price-frontend-agent-7g7tm9`):**
- Layer 1 add-on LLPAs (cash-out / condo / 2-4 units) — 28 values reproduced; classifier fix.
- Decoded DSCR eligibility matrix + PPP matrix (DSCR-only) as canonical JSON.
- Layer 2 `deephaven-matrix.js` (36 checks) + Layer 3 `deephaven-ppp-matrix.js` (37) + program (10).
- DSCR-only correction (removed redundant 80% caps; subordinate rule; full overlay list).
- Research docs: two-layer architecture, DSCR eligibility matrix, this master plan.

**PENDING (ordered):**
1. **Developer request-builder fixes** (D13): AUS "All" `[DU,LPA,GUS,MUW,None]` preserved from
   foundation; closing-cost flags `true/true`; term keep `loanYear` change only `termsCriteria`; Prepay
   Buyout SMO on Standard; **audit-mode rung digest** on the price route. + regression tests.
2. **LP disqualify capture + per-layer cross-check** (D6/D14, task #45): pull LP's Deephaven disqualify
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

## 5. Open questions / to raise with the owner

- The 9 live divergences (our decline vs LP price at FICO 640/660/680 × cltv 80): once the disqualify
  capture runs, decide per case — LP bug (ticket) or our grid too strict.
- Margin holdback + advancement combine-formula into price is owner-pending (not yet folded into rate).
