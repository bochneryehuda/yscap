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

## The one that mattered most — and the day it warned about has arrived

**SETTLED 2026-08-18: `audience.js` IS WIRED NOW.** The first Long-Term client-facing surface exists —
`src/longterm/routes/my-loans.js`, the borrower's own long-term files, mounted borrower-authenticated
at `/api/lt/my` — and it runs every free-text field it returns through `audience.scrubInvestorNames`
before it leaves. That is exactly what this section asked for, so its row is off the ledger and the
guard's assertion is INVERTED rather than deleted: if the wiring is ever lost, `test-lt-reachability-gate.js`
turns red instead of the claim quietly becoming untrue again.

**CORRECTED 2026-08-18 (§2.80): BOTH DEFENCES ARE WIRED, and this paragraph used to say otherwise.** It
read *"the second defence is only half present … `maySeeField` / `stripInternalOnly` are still uncalled
anywhere — so the NEXT client surface must not assume they are in the path"*. Measured: both are called
by `src/longterm/client-view.js`, which `my-loans.js` requires, so they are in the boot graph and in the
path of the one client surface that exists. That route does NOT filter a staff payload — `client-view`
builds the client's payload from an ALLOWLIST, asking `maySeeField` about each field's Encompass id and
`internalOnlyColumns` about its column before assembling it, running `stripInternalOnly` over the
finished object as the belt, and refusing the SELECT itself at load time via `assertNoInternalColumns`.
That is the STRONGER defence, the one the hard rule names first, and it is present. The sentence was
already false when it was written and nothing could tell: a generated ledger preserves its authored
prose and never checks it, which makes a hand-written reason inside a generated list a hand-kept list.
`scripts/test-lt-ledger-claims.js` now reads these claims and fails when one stops being true.

**What genuinely remains open here is smaller and is recorded where it lives**: `client-view.js` says
the loan NUMBER is deliberately not scrubbed — it is an identifier the LOS assigns, and scrubbing it
would rewrite a real one the moment it happened to contain a short investor code as a standalone token
— and whether a long-term loan number can ever carry text somebody typed is the owner's question, not
an agent's.

The original finding is kept below, because the reasoning is why the wiring was owed at all.

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
cannot RUN until the Lender Price login is present in this environment's settings (rotation is NOT required — the owner withdrew that on 2026-08-18); it refuses up front (`upstream_not_configured`)
rather than spending a battery on error verdicts that would say nothing about agreement.

The three rows that covered it — `ratesheet-agreement.js`, `agreement-scenarios.js` and
`ratesheet-agreement-diff.js` — are struck off. The check caught them itself the moment the route
landed, which is exactly what it is for.

## Two more struck off — 2026-08-18 (§2.80)

**`ppe/program-audit.js` is wired, and by exactly the route its own row predicted.** The row said its
home was *"the free pre-flight beside `GET …/coverage`, not the paid battery"* — and §2.75 built that
pre-flight: `ppe/agreement-preflight.js` requires `auditProgram` to report a sheet's dead rules before
anybody spends a Lender Price battery, and the PPE router requires the pre-flight. So the prediction
came true and the row came off, which is the ledger working as designed rather than a row being tidied
away.

**`ppe/canary-clock.js` is wired too**, through `ppe/canary-driver.js`, which lazily requires it to
report which of the owner's six Eastern hours a tick fell in. Its row said the clock is *"deliberately
NOT reached from the request path: nothing a person clicks should depend on what hour it is"* — that is
still true of the DECISION; what the driver reads it for is the description it hands back, so the
principle stands and only the reachability claim moved.

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

## The one whose absence made every finding half an answer — now wired

`divergence.js` puts our full price build-up beside Lender Price's single number and points at the ONE
component whose size most closely matches the gap. Nothing called it, so every row in the findings
ledger said only THAT the two disagreed and by how much — never a first place to look. It is wired in
`facade.js`, which is the only place it CAN honestly be wired: the diagnosis needs our reconstruction
record, and that exists while the comparison is being made and nowhere afterwards (`our_payload` is
NULL on every finding either producer has ever written, so a later screen would have to re-price
against whatever the sheet says today and would quietly answer about a different sheet). The
explanation rides onto the recorded row, so it outlives the request that made it.

## The two that told you WHERE and WHY — now wired

`rung-digest.js` and `disqualifier-reconciler.js` were both waiting on "the per-program agreement run
(#49)". That run has existed since `POST /api/lt/ppe/rate-sheets/:id/agreement/run` landed, and it had
in hand exactly what both of them need — our reconstruction record, Lender Price's normalized rungs,
and both sides' declines — and threw all of it away, keeping a verdict and a count. Both are wired in
`ratesheet-agreement.js runOne`, which is the only place they CAN be wired for the same reason
`divergence.js` had to go in `facade.js`: the evidence exists while the comparison is being made and
nowhere afterwards.

**The reconciler did more than explain a verdict — it corrected one.** `parity-detectors` ends its
eligibility axis with *"both decline — agree on the outcome (reason-set comparison is a later
refinement)"*, so a scenario where we declined on FICO and Lender Price declined on a state rule was a
clean agreement, counted under `agreedDeclined`, on a gate whose owner-stated rule is to agree on
"every eligibility AND ineligibility". That is a real gap and this is the fix, so a both-decline now
agrees only when the per-layer reasons reconcile. It is a **behaviour change to a gate**: a scenario
that agreed before can now disagree, or become incomparable when neither side's reasons can be read.

The digest is attached only to a scenario that already disagrees with rungs on both sides — an
agreeing scenario needs no divergence table — and it is what names a gap that is NOT an LLPA at all: a
base-grid or margin difference itemizes as an empty dimension list, and without it a reader is sent
hunting for a cell that is not wrong.

## What changed between two versions of a sheet — now wired

`ratesheet-diff.js` diffs two rulesets as a KEYED set-difference (a localized per-cell delta, plus
§7.4's split of ordinary numeric refreshes from rule changes) and had nothing to hand it: nothing
turned a STORED sheet into the flat `{ ruleKey → value }` map it consumes.
`src/longterm/ppe/ratesheet-cells.js` is that missing half — the ONE definition of how a cell is
addressed — and `GET /api/lt/ppe/rate-sheets/:id/diff` is the door, defaulting to the previous version
of the same program. It DECIDES nothing: the §7.4 classification is reported for what it tells a
reader, and no cell is applied, published or accepted (auto-apply belongs to the ingest path, which
does not exist yet).

## The rule-authoring service IS wired now — READ and DRAFT only, and the four rows are struck

`rule-builder.js` (the authoring operations over the ONE rule shape) and `ppp-structures.js` (the
reusable prepayment-penalty catalog) both said "waiting on the rule-authoring editor". That editor is a
screen, and a screen needs something to sit on: a layer that takes an authoring intent, validates it,
checks it against the ruleset it would join, and stores it somewhere that prices nothing until somebody
publishes it. `rule-authoring.js` + `rule-authoring-store.js` are that layer.

**All four rows came off together, and that is the only honest way they COULD come off.** A caller that
is not itself called is not a caller: while nothing reached the service, nothing reached the two
libraries through it either, so striking the libraries alone would have overstated what is wired. What
changed is that `src/longterm/routes/ppe.js` now mounts the service — `GET`/`POST /ppe/rule-drafts`,
`GET /ppe/rule-drafts/:id`, `GET /ppe/rule-drafts/:id/render`, `DELETE /ppe/rule-drafts/:id`, all
`requirePpeAdmin` — and `app-v2/src/longterm/RuleBoard.jsx` is the screen that presses them.

**THE PUBLISH DOOR IS STILL NOT BUILT, AND ITS ABSENCE IS NOT AN UNWIRED MODULE.**
`rule-authoring-store.publishDraft` writes into `lt_ppe_rule`, which is the set the engine evaluates, so
publishing CHANGES A PRICED NUMBER. The rest of this router splits on `requirePpeAdmin`, and whether
publishing a pricing rule belongs to that same group **has not been asked of the owner** — wiring it to
that gate because it was the nearest one would answer the question by convenience. The question is
recorded as §2.51 in `LENDER-PRICE-PARITY-STATUS.md` and is not answered there. The module IS reached
(the read and draft doors call it), so it does not belong on this ledger; what is missing is a decision,
not a caller.

## The one the priced probe closed — now wired

**STRUCK OFF 2026-08-19: `agreement-priced-probe.js` IS WIRED NOW.** Its row said what would wire it —
*"the agreement RUN ROUTE adopting it beside the free pre-flight it already calls, since the console has
the same blind spot the CLI had"* — and `GET /rate-sheets/:id/preflight` now does exactly that, returning
a `pricedCensus`: which scenarios our own sheet prices, broken down by the battery's own axes, plus the
scenarios the battery itself labels ineligible that our sheet prices anyway (the finding that surfaced
§2.116). The check caught the row the moment the wiring landed and refused to let it stand — *"a ledger
that overstates what is unwired is one nobody trusts"* — which is the guard working in the direction
that is easy to forget.

Note what was NOT done, because it would have been the wrong shape: the census REPORTS on the paid run's
door, it does not NARROW the battery there. The ≥200-scenario rule is the owner's, and a route that
quietly measured 24 scenarios and recorded a verdict would be answering a different question than the one
the gate asks. Narrowing stays a deliberate flag on the hand-run CLI (`--priced-probe`).

## The ledger

| Module | Why it is not wired yet | What would wire it |
| --- | --- | --- |
| `src/longterm/ppe/program-audit-command.js` | **Deliberately unwired, and it IS run.** It is the body of the offline operator command `scripts/lt-ppe-program-audit.js`, which starts it as its own process — so nothing the server boots requires it, by design. It lives here rather than in `scripts/` because Long-Term back-end code may live nowhere else, and the launcher imports nothing so no RTL file gains a Long-Term dependency. | Nothing should. If the audit is ever wanted *inside* the product (a scheduled run, an admin screen), that surface would require it — and this row comes off then. |
| `src/longterm/ppe/canary-cron-command.js` | **Deliberately unwired, and it IS run — on a schedule.** It is the body of the scheduled daily Lender Price check the owner asked for on 2026-08-18 (7am, 9am, 10am, 11am, 12pm and 4pm Eastern), started as its own process by the Render cron service `ys-capital-lt-canary` through the launcher `scripts/lt-ppe-canary-cron.js`. Nothing the SERVER boots requires it, by design — that is what a scheduled job is. It lives here rather than in `scripts/` because Long-Term back-end code may live nowhere else, and the launcher imports nothing, so no RTL file gains a Long-Term dependency (the `program-audit-command.js` pattern, same reason). | Nothing in `src/` should. If the daily check is ever wanted INSIDE the product — an admin pressing "run it now" from a screen — that surface would require it, and this row comes off then. **Its own suite DOES run it** (`test-lt-ppe-canary-cron-command.js`, spawning it exactly as the launcher does), because "nothing boots it" was being read as "nothing tests it" — and the two defects §2.65 found both lived in this file, unexecuted. |
| `src/longterm/ppe/disqualify-reconcile.js` | The SCENARIO-level reconciler, and the only thing that judges whether a disagreement is worth raising with Lender Price. | **NOT a duplicate of `disqualifier-reconciler.js`, and this row used to say it was.** Measured: `reconcileScenario(our, lp)` classifies one scenario end to end — `both_eligible` / the disagreement outcomes — crosswalks Lender Price's own decline strings to dimensions, and sets **`ticketWorthy`**, which is the owner's own instruction (*"if anything is not matching Lender Price, tell me and we open a ticket"*). `disqualifier-reconciler.reconcileDisqualifiers(ours, authority)` answers a DIFFERENT question at a different granularity — a per-LAYER itemisation of two verdicts it is handed — and it is the one the agreement run calls. Neither covers the other. **Retiring this file would delete the only implementation of the ticket judgement**, so the earlier "keep or retire" framing was wrong and is withdrawn. It is unwired because the live-Lender-Price classification path it belongs to cannot run until the vendor login is present in this environment's settings. |
| `src/longterm/ppe/deephaven-grid.js` | The rate-sheet GRID model (E3/E5). | The rate-sheet console's grid editor, or the ingest path. |
| `src/longterm/ppe/layer-data-registry.js` | The versioned investor-layer data registry + compiled catalog. | As above. |
| `src/longterm/ppe/layer-compile-eligibility.js` | Pure compiler: eligibility data → canonical rules. | As above. |
| `src/longterm/ppe/layer-compile-ppp.js` | Pure compiler: prepayment data → canonical rules. | As above. |
| `src/longterm/ppe/layer-facts.js` | The closed derived-fact vocabulary the two compilers share. | As above. |
| `src/longterm/ppe/ratesheet-ingest.js` | Rate-sheet ingestion normalizer. | A file-upload path for a sheet; the console pastes instead today. |
| `src/longterm/ppe/lp-drift.js` | Daily Lender-Price drift detection + classification (D19). | A scheduled run — deliberately not added, for the same reason the canary has no timer: a background loop calling a paid vendor is the owner's decision. |
| `src/longterm/ppe/lp-daily-run.js` | The IO-injected wrapper tying the drift pieces together. | As above. |
| `src/longterm/ppe/lp-daily-schedule.js` | The per-investor daily schedule for that run. | As above. |
| `src/longterm/ppe/best-execution.js` | Best-execution ranking across investors (§8.3). | A multi-investor search surface; there is one investor today. |
| `src/longterm/ppe/lock.js` | Rate-lock lifecycle + the frozen price stack (§8). | Locks are not in scope for the visibility-only build. |
| `src/longterm/ppe/parity-review.js` | The scenario review composer (ties P1 + P3 + P-DQ). | The manual-review UI (P8). |

---

## Reading this honestly

A row here says **nothing in production calls this module**. It does not say the module is wrong,
unfinished, or untested — most of these are pure, thoroughly tested, and were written ahead of their
wiring on purpose. It also does not mean the module is unused: a great many are exercised by the test
suites, and several require each other, which is why "required by another Long-Term module" is not
treated as reachability. Only a path from what the server actually mounts and boots counts.

## The three-dot program is WIRED now (2026-08-18)

Eight rows came off this ledger in one change, and none of them was a new module: the investor
PROGRAM registry — and with it the Deephaven rate-sheet, eligibility, prepayment-penalty and overlay
layers it composes — reached the production graph the moment the **agreement run** started asking the
investor's own prepayment rules (`routes/ppe.js` → `program-registry.programFor`). Until then all of
it was built, tested, and required by nothing the server boots.

That is worth stating plainly rather than quietly deleting rows: the layers were never wrong, they
were unasked, and one caller was the whole difference. `test-lt-reachability-gate.js` is what refused
the stale rows and forced this note into the same commit.
