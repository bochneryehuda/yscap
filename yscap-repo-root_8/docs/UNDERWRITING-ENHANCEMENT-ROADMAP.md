# Underwriting Enhancement Roadmap — synthesis of the 27-agent analysis (2026-07-23)

This document distills what 27 independent analysis agents found when they combed
the whole PILOT platform and its AI underwriting: 10 domain-analysis agents over
every subsystem, 9 gap-analysis agents over the underwriting we already have,
3 external-research agents over how the industry's best systems (DU/LPA,
Day-1 Certainty, AIVA-class platforms) do it, and 5 error-hunt agents that
reproduced real bugs against the live modules. Findings became official tasks
the moment they were confirmed (tasks #189–#211); this is the map that ties
them together.

## The one headline

**Almost everything the platform needs is already BUILT — and much of it was
dormant.** The dominant discovery across every group was the same: complete,
tested machinery with zero production callers. Activation beats invention.
The build order below is therefore mostly *wiring*, not new construction.

Dormant machinery found (status as of this doc):

| Machinery | Where it lives | State |
|---|---|---|
| Whole-loan run + issuance gate (`runWholeLoan`, `issuance-gate`) | `src/lib/underwriting/run.js`, `issuance-gate.js`, db/266 | Built + tested; **no production caller** → task #202 |
| Evidence ledger (spans + fact/finding links) | `evidence-ledger.js`, db/257 | **ACTIVATED** this cycle (wired into extraction) |
| Condition intelligence (clearance preview, aging, reopen) | `condition-contracts`, `condition-aging`, db/233 | Built; activation = task #191 |
| Guideline knowledge graph + evaluator + citations | db/258–260, `guideline-*` modules | Built; activation = task #192 |
| Verification reconciler + 6 direct-source connector stubs | `verification-reconciler.js`, direct-source hub | Built; wiring = task #193 (AVM first) |
| Shadow decisions / evaluation harness / release gates | db/262, `replay-runner`, `release-gate` | Built; calibration loop = task #194 |
| Outcome learning + postmortems | `outcome-learning`, `postmortem` | Built; feeds #194 |

## What the error hunts proved (and what got fixed)

Five bug-hunt agents reproduced real defects against the live modules. Every
confirmed finding went straight onto the task list and has been fixed with
regression tests and audit rounds (tasks #201, #207–#211):

- **The decision core's gates were silently dead on real files** — caps read
  from a key that only test fixtures carry (`quote.caps` vs the persisted
  `quote.guidelines.caps`), a false-STALE on every registered file (strategy
  text compared against a program key), and `Number(null)===0` coercions that
  fabricated passing $0 ratios. All armed/fixed with the adversarial matrix
  extended to the corrected contracts.
- **Silent plumbing** — queries filtering a status value never written
  (`status='ok'`), attribution columns always NULL (`req.actor.staffId`),
  duplicate super-admin questions, an FK violation that aborted the whole
  file-view detector pass, dead "Re-run AI checks" arms, and 500s from an
  undefined helper. All fixed; every shared-transaction best-effort pass now
  runs under per-step SAVEPOINTs (the "poisoned transaction" class is closed
  structurally).
- **Borrower-safety** — staff-named filenames were a partner-name vector
  (`BlueLake_terms.pdf`) that the word-boundary scrub missed; the chokepoint
  patterns are now separator/camelCase-aware and every remaining filename
  surface (chat shared lists, track-record docs, Content-Disposition) is
  scrubbed.

The recurring root causes worth designing against:
1. **Contract drift between producer and consumer** (the caps key, the status
   vocabulary, the actor shape). Pure tests pinned to REAL persisted shapes —
   not hand-built fixtures — are the antidote; several suites were green while
   the production path was dead because fixtures matched the consumer, not the
   producer.
2. **Best-effort passes inside shared transactions.** A swallowed JS error
   still aborts a Postgres transaction; `COMMIT` then silently acts as
   `ROLLBACK`. Every such pass must use SAVEPOINT/ROLLBACK-TO.
3. **`Number(null)===0`.** Hand-rolled `num()` helpers must null-guard before
   coercion; the class is now covered by `test-num-guards-pure.js`.

## What the external research says the best systems do (adopted targets)

- **Casefile pins versions** (DU/LPA): a decision is reproducible because the
  run snapshots exactly which data + rule versions produced it. Our
  `underwriting_runs` schema already does this — activation (#202) makes it
  the enforced record.
- **Tolerance bands, not exact-match paranoia**: e.g. ~1% income tolerance
  before re-underwriting; ±10% directional AVM variance escalates, smaller
  drift logs. Feeds the AVM reconciler wiring (#193).
- **A validation ledger (Day-1-Certainty style)**: each verified fact carries
  who verified it, from what source, when, and what it relieves. Our evidence
  ledger + verification hub are the raw material.
- **Defect taxonomy + findings certificate**: every finding classed by cause,
  and issuance produces a certificate enumerating what was checked, against
  which guidelines, with what evidence. Certificate v2 = task #205.

## Build order (the official task list, in order)

1. **#191 Condition-stack activation** — clearance preview + aging + reopen into
   the live condition workflow (staff-only surfaces first).
2. **#192 Guideline layer on** — evaluation orchestrator + investor fit +
   citations surfaced on the file view.
3. **#193 Verification wiring** — AVM connector first, then the reconciler into
   the decision loop with the ±10% escalation band.
4. **#194 Calibration loop** — shadow-decision capture + outcome ingestion +
   reliability report.
5. **#195 CI Postgres** — DONE pending soak: the `test-db` job runs every
   DB-gated suite against a real Postgres on each PR; add it to the deploy
   gate once reliably green.
6. **#196 Assignment fee re-derivation** into the whole-loan run.
7. **#197 Cockpit surfacing** — run-diff, next-actions, findings-digest in the
   file view.
8. **#199 Party-collusion + double-pledged-collateral detectors** (advisory).
9. **#200 HITL learning gaps** — severity-adjust capture, admin-question SLA,
   evaluation-gated promotion.
10. **#202 R6.18: wire `runWholeLoan` + issuance-gate into live enforcement**
    (with the capPolicy completion) — the single biggest remaining gap: the
    one whole-loan decision must actually gate term-sheet/CTC/funding.
11. **#203 Context data completeness**, **#204 DSCR desk (advisory)**,
    **#205 AI-call audit record + certificate v2**, **#206 sign-off cure
    proofs + condition manifest**.

Standing rules that bound all of it: AI stays advisory (suggests, never
decides or clears); frozen pricing/guideline numbers untouched; Encompass
read-only; no note-buyer/capital-partner name on any borrower surface; every
change through the two-audit gate.

## Owner summary (plain language)

Twenty-seven independent review agents went through the whole platform. The
big surprise was good news: most of what a top-tier underwriting system needs
is already built here — a full "one decision per loan" engine, an evidence
ledger that ties every number to the exact spot on the page it came from, a
rulebook brain, and a self-checking learning loop. Much of it was sitting
idle, like a finished room with the lights off. The plan is mostly to flip
the switches on, in a safe order, rather than build new rooms.

The review also caught real bugs — the kind that fail silently. The most
important: the automatic "is this loan over its limits?" check was reading
its limits from the wrong place, so it always saw no limits at all. That is
fixed, tested, and double-audited, along with a batch of similar quiet
failures. Every fix keeps the same hard rules: the computer only ever
*suggests* — a person always decides; your pricing numbers are untouched;
and borrowers never see a lender partner's name anywhere.
