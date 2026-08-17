# Long-Term — what is built but not yet wired

**The set in this file is COMPUTED, not remembered.** `scripts/check-lt-reachability.js` walks
`require()` from what the server actually mounts and boots, and compares the result against the table
below. A module nothing calls that is missing from the table fails the check; a row that has since
become reachable fails it too. Only the REASONS here are authored.

**Why this file exists.** The Lender Price parity workstream has now found the same defect five times:
complete, unit-tested machinery with no caller anywhere in `src/` — the parity screen, the LP scope
writer, the canary schedule, the ≥200-scenario agreement gate, and every rate-sheet writer. Each was
found by hand, one at a time. An absent caller fails no test and breaks no build; its only symptom is
a feature that silently does nothing, which is indistinguishable from a feature that is working and
has nothing to report. This turns "we forgot to wire it" into a thing the build says out loud.

**It is not a ban.** Half of this engine is deliberately written ahead of its wiring — the Deephaven
layers, the pure compilers, the drift chain. A check that failed on all of them would be switched off
within a day. What is banned is doing it *silently*.

The check is **advisory** (prints, exits 0) unless `LT_REACHABILITY_ENFORCE=1`, matching the two
schema-drift checks: making it blocking is the owner's call, not an agent's.

---

## The one that matters most

`src/longterm/audience.js` is the investor-name block — the ONE definition behind the owner's HARD
RULE that a capital provider's name never reaches a borrower or a TPO, built on the registry of 117
recorded spellings precisely because a hand-typed name is spelled 151 ways. **Nothing in `src/` calls
it.** It has a thorough test (`scripts/test-lt-investor-block.js` sweeps every recorded spelling
through five sentence shapes), and three other Long-Term modules cite it in their comments as "the ONE
definition of that", which reads as though it is wired. It is not.

**This is not a live leak today, and saying otherwise would be alarmism:** Long-Term is a
visibility-only side build with no borrowers and no production traffic, and it has no client-facing
surface for a name to leak to. The risk is the day one ships — the guard will be assumed present
because the codebase says it is the one definition. **Wire `maySeeField` / `stripInternalOnly` /
`scrubInvestorNames` into the FIRST Long-Term client payload that exists, before it carries anything a
client reads.**

## The one that blocked the agreement gate — now wired

`ratesheet-agreement.js` MEASURES the ≥200-scenario rule and returns `summary.gateMet`. db/576 keeps
that verdict and `publishRateSheetVersion` refuses an unproven sheet — but for a while **nothing
called the harness**, so no run could be recorded and the only way past the gate was the recorded
override. `POST /api/lt/ppe/rate-sheets/:id/agreement/run` now runs it and records the verdict, so a
sheet can be made publishable by being MEASURED rather than only by somebody deciding to publish it
anyway. It is PULLED, never scheduled — this prices the whole battery against a paid vendor, so a
background loop firing it is the owner's decision, the same line drawn for the canary tick. It still
cannot RUN until the Lender Price login is rotated; it refuses up front (`upstream_not_configured`)
rather than spending a battery on error verdicts that would say nothing about agreement.

The three rows that covered it — `ratesheet-agreement.js`, `agreement-scenarios.js` and
`ratesheet-agreement-diff.js` — are struck off. The check caught them itself the moment the route
landed, which is exactly what it is for.

## The sheet's own dead cells — now wired

`agreement-scenario-generator.js` derives a battery from a rate sheet's OWN compiled rules and reports
every cell it cannot satisfy, with a reason: a transposed band (a minimum above its maximum) is the
likeliest mistake when a human loads a vendor's grid, and it is invisible in every other way — the
sheet publishes, quotes price, and the LLPA simply never applies. Nothing called it.
`GET /api/lt/ppe/rate-sheets/:id/coverage` does now, and it does not take the generator's word for it:
a cell counts as reachable only when the sheet was PRICED at that scenario and the rule's own trace
shows it CONTRIBUTED. The check is FREE — no vendor call, no writes, no ledger row — which is what
makes it the thing to run before spending a paid agreement battery.

That route pulls `agreement-dimensions.js` (the shared dimension classifier the generator uses) and
`coverage.js` (its golden/boundary/pairwise scenario layers) in with it, so all three rows are struck
off. `coverage.js` still has a second, unbuilt caller waiting — the scenario playground (§2.11) — and
that is not a reason to keep a row claiming nothing calls it.

---

## The ledger

| Module | Why it is not wired yet | What would wire it |
| --- | --- | --- |
| `src/longterm/audience.js` | The investor-name block. No Long-Term client-facing surface exists yet, so there is nothing to scrub. | The first LT borrower/TPO payload — see above. |
| `src/longterm/ppe/disqualifier-reconciler.js` | Reconciles our declines against Lender Price's, per layer. | The per-program agreement run (#49). |
| `src/longterm/ppe/rung-digest.js` | The compact rung-by-rung audit output of that run. | The per-program agreement run (#49). |
| `src/longterm/ppe/program-audit.js` | The offline our-side half of the same harness (dead-rule / coverage profiler). | The per-program agreement run (#49). |
| `src/longterm/ppe/disqualify-reconcile.js` | The earlier per-layer disqualifier reconciler. | Superseded in practice by the two rows above; keep or retire deliberately. |
| `src/longterm/ppe/deephaven-dscr-sheet.js` | Layer 1 — the Deephaven DSCR sheet encoded from the live tables. | The program registry becoming the pricing path (P10 / cutover). |
| `src/longterm/ppe/deephaven-dscr-prepay-maxprice.js` | The same sheet's prepay / max-price / lock block. | As above. |
| `src/longterm/ppe/deephaven-matrix.js` | Layer 2 — the independent eligibility engine. | As above. |
| `src/longterm/ppe/deephaven-ppp-matrix.js` | Layer 3 — the prepayment-penalty state engine. | As above. |
| `src/longterm/ppe/deephaven-overlay-rules.js` | The Advanced-overlay enforcement data (D36). | As above. |
| `src/longterm/ppe/deephaven-grid.js` | The rate-sheet GRID model (E3/E5). | The rate-sheet console's grid editor, or the ingest path. |
| `src/longterm/ppe/program-deephaven-dscr.js` | The investor-named program tying the three layers together. | As above. |
| `src/longterm/ppe/program-engine.js` | The generic engine that program is an instance of. | As above. |
| `src/longterm/ppe/program-registry.js` | The investor program registry. | As above. |
| `src/longterm/ppe/layer-data-registry.js` | The versioned investor-layer data registry + compiled catalog. | As above. |
| `src/longterm/ppe/layer-compile-eligibility.js` | Pure compiler: eligibility data → canonical rules. | As above. |
| `src/longterm/ppe/layer-compile-ppp.js` | Pure compiler: prepayment data → canonical rules. | As above. |
| `src/longterm/ppe/layer-facts.js` | The closed derived-fact vocabulary the two compilers share. | As above. |
| `src/longterm/ppe/overlay-cut-engine.js` | The generic overlay-cut interpreter (D36, the scalable middle). | As above. |
| `src/longterm/ppe/rule-builder.js` | The universal rule / condition authoring layer (#48). | The rule-authoring editor (§2.11 TO-BUILD). |
| `src/longterm/ppe/ppp-structures.js` | The reusable prepayment-penalty structure library (D31). | The rule-authoring editor, or a per-investor PPP screen. |
| `src/longterm/ppe/ratesheet-ingest.js` | Rate-sheet ingestion normalizer. | A file-upload path for a sheet; the console pastes instead today. |
| `src/longterm/ppe/ratesheet-diff.js` | Rate-sheet / ruleset change detection. | The daily drift run below, or a sheet-version comparison screen. |
| `src/longterm/ppe/lp-drift.js` | Daily Lender-Price drift detection + classification (D19). | A scheduled run — deliberately not added, for the same reason the canary has no timer: a background loop calling a paid vendor is the owner's decision. |
| `src/longterm/ppe/lp-daily-run.js` | The IO-injected wrapper tying the drift pieces together. | As above. |
| `src/longterm/ppe/lp-daily-schedule.js` | The per-investor daily schedule for that run. | As above. |
| `src/longterm/ppe/cutover-ledger.js` | The append-only cutover decision history (§11). | The promote-to-live route (P10) — owner-gated on who may promote. |
| `src/longterm/ppe/cutover-store.js` | Its durable bridge. | As above. |
| `src/longterm/ppe/best-execution.js` | Best-execution ranking across investors (§8.3). | A multi-investor search surface; there is one investor today. |
| `src/longterm/ppe/lock.js` | Rate-lock lifecycle + the frozen price stack (§8). | Locks are not in scope for the visibility-only build. |
| `src/longterm/ppe/divergence.js` | Divergence diagnosis — makes one disagreement actionable. | The findings screen showing a per-finding explanation. |
| `src/longterm/ppe/parity-review.js` | The scenario review composer (ties P1 + P3 + P-DQ). | The manual-review UI (P8). |

---

## Reading this honestly

A row here says **nothing in production calls this module**. It does not say the module is wrong,
unfinished, or untested — most of these are pure, thoroughly tested, and were written ahead of their
wiring on purpose. It also does not mean the module is unused: a great many are exercised by the test
suites, and several require each other, which is why "required by another Long-Term module" is not
treated as reachability. Only a path from what the server actually mounts and boots counts.
