# Two-layer eligibility reconciliation — architecture

**Owner directive (2026-08-17):** *"We don't need to trust Lender Price blindly on eligibility and
ineligibility — they can make mistakes … cross-check the matrix against LP; when they disagree, point it
out so we can open a ticket with Lender Price to fix it. Understand what is the first layer and what is
the second layer and how to connect the dots."*

This is the design output of the research engines opened for that directive. It builds on the decoded
matrix (`LP-DSCR-ELIGIBILITY-MATRIX.md`).

## THE LOAD-BEARING INSIGHT

Today's "Layer 2" — the `eligibility:` block in `deephaven-dscr-sheet.js` — was encoded **verbatim from
Lender Price's own disqualify reasons** (its own header says so). An eligibility layer that echoes Lender
Price **cannot, by construction, catch a Lender Price mistake** — it will always agree with LP. So the
owner's request is not "tighten the envelope"; it is: build a Layer 2 that is **independently sourced
from the published Deephaven product matrix**, so that when LP and the published guideline disagree, the
disagreement is real signal — not an artifact of both coming from the same place.

## The two layers

- **Layer 1 — Lender Price (live).** For a scenario, LP either PRICES a product or DISQUALIFIES it with
  reason strings. What we quote today; what our current envelope was reverse-engineered from.
- **Layer 2 — the published matrix (independent).** A NEW engine sourced only from the decoded Deephaven
  DSCR matrix JSON. The arbiter of what *should* be eligible. Must NOT import the LP-derived block.

## The reconciliation model — four outcomes

For one scenario: `{ Layer-1: priced | disqualified(+reasons) }` vs `{ Layer-2: eligible | ineligible(+matrix rule) }`.

| # | Matrix (L2) | LP (L1) | Meaning | Default disposition |
|---|---|---|---|---|
| **A** | eligible | priced | agree-eligible (the owner's $75k case: min loan is $75k, so it IS eligible) | no action |
| **B** | ineligible | disqualified | agree-ineligible — counts as agreement **only when LP's reason maps to the SAME matrix dimension**; a different reason downgrades to a "same verdict, different reason" note | no action |
| **C** | eligible | disqualified | **LP stricter than the published matrix** | → classifier |
| **D** | ineligible | priced | **LP more lenient than published matrix** — the dangerous direction (we could quote/buy a loan the guideline forbids) | → classifier |

**Anti-cry-wolf rules (critical):**
- **Outcome C is NOT automatically an LP bug.** LP legitimately applies overlays the one-page matrix does
  not carry (note-buyer overlays, feature/occupancy/doc rules). C is only a probable LP bug when LP's
  decline reason maps to a matrix dimension that carries a **hard published number** and LP's threshold is
  stricter than that number on the **same** dimension (e.g. LP declines "Minimum Loan Amount $100,000"
  when the matrix min is $75,000). Otherwise C is a `legitimate_overlay` — noted, not ticketed.
- **Outcome D is the primary target** and higher severity, but splits into probable-LP-bug (matrix cell is
  high-confidence + hard-published) vs probable-OUR-encoding-bug (our cell is interpolated, or an overlay
  whose applicability we can't confirm from the scenario facts — declining market, Philadelphia, STR, FN).

## The classifier

Pure module → `{ outcome, classification, severity, confidence, ticketWorthy, evidence }`,
`classification ∈ { agree, lp_bug, our_encoding_bug, legitimate_overlay, human_review }`.

Confidence/severity combine: **direction** (D > C-hard-contradiction > C-overlay), **matrix-rule
confidence** (an assumed/unmeasured cell caps confidence → `human_review` regardless of direction),
**crosswalk cleanliness** (an unmapped LP reason can never drive an `lp_bug`), and **band-edge proximity**
(the matrix uses `.5` guard bands while LP's real edges are at `X.01`; a boundary disagreement is more
likely an encoding artifact than an LP bug). Only `lp_bug && confidence ≥ TICKET_THRESHOLD` auto-opens a
ticket; `our_encoding_bug` → a "fix Layer 2" queue; `human_review` / `legitimate_overlay` → low-severity
review. Thresholds live in the tunable settings store.

## Where it lives (reuse existing surfaces)

- **Batch stage** — extend `ratesheet-agreement.runOne` with an injected `opts.matrix(scenario)` leg
  (mirroring `buildOursLeg`/`buildLpLeg`). ONE LP call per scenario feeds both price-agreement and
  eligibility-reconciliation; a matrix throw degrades to an `engine_error` reconcile, never a lost run.
  `summarize()` gains a discrepancy tally.
- **Durable record** — reuse the `finding.js` ledger with a new non-rate `kind: 'eligibility_discrepancy'`,
  keyed `(investor, program, scenario, kind)`. Inherits recurrence counting, never-reopen-a-settled,
  `regressed` on reappearance, and auto-close when a discrepancy disappears (LP fixed it). No new table.
- **Human surface** — the PPE admin route (`src/longterm/routes/ppe.js`): `kind`/`classification`
  predicates on `listFindings`, a discrepancy lane on the scoreboard, `POST /findings/:key/ticket`.

## The ticket artifact (open with Lender Price)

Scenario facts (human units) · LP's verdict + **verbatim** decline reason(s)/adjType · the matrix rule +
**citation** (e.g. "Deephaven Corr Flow DSCR matrix, eff 08/04/26 — Program Parameters, minLoanDscrGe1 =
$75,000" or "Max-LTV grid, tier ≤$1.5M / FICO 700 / Cash-Out / DSCR≥1.00 = 75%") · why we believe LP is
wrong (direction, dimension, contradicting numbers side by side, confidence, and an explicit
"overlays we ruled out" line) · provenance (source doc + effective date, run id, recurrence count).

## Build plan (ordered, pure/offline-testable)

1. **`deephaven-matrix.js`** — independent matrix engine: `evaluateEligibility(facts) → { eligible,
   reasons:[{code, rule, citation, dimension, confidence}], governingCaps }`. Min/max loan by DSCR band,
   the LTV grid (tier × FICO × purpose × DSCR band; `null` cell = ineligible), cash-out caps, overlays.
   Every rule carries a citation + confidence; overlays needing an unknown fact are flagged. **Structural
   guard: a test that fails if it imports the LP-derived `deephaven-dscr-sheet.js` eligibility block.**
2. **`buildMatrixLeg`** in `lp-agreement-legs.js`, mirroring `buildOursLeg`, reusing `lpScenarioToFacts`.
3. **`eligibility-reconcile.js`** — the outcomes + classifier; reuses `disqualify-crosswalk.keyToPredicate`.
   Truth-table test over all four outcomes + every branch + the anti-cry-wolf cases + the $75k → agree.
4. **Finding kind + records** — `eligibility_discrepancy` in `finding.js` + `recordsFromReconcile`.
5. **Wire the stage** into `runOne`; extend `summarize()`.
6. **`eligibility-ticket.js`** — pure ticket renderer; golden-text test both directions.
7. **Route + scoreboard** wiring in `routes/ppe.js`.
8. **Scenario coverage** — boundary scenarios exercising every matrix hard cap; STATUS-doc section.

Each step is a pure module with an offline test; the whole battery runs the moment real LP credentials are
present, exactly like the existing agreement harness.
