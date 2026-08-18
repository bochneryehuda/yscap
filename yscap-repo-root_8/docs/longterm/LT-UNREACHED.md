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
turns red instead of the claim quietly becoming untrue again. **The second defence is only half
present**: the route builds a payload FOR the borrower rather than filtering a staff one (the stronger
of the two defences, and the one the hard rule names first), but `maySeeField` / `stripInternalOnly`
are still uncalled anywhere — so the NEXT client surface must not assume they are in the path.

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

## The rule-authoring editor now has a service under it — and the service itself is not wired

`rule-builder.js` (the authoring operations over the ONE rule shape) and `ppp-structures.js` (the
reusable prepayment-penalty catalog) both said "waiting on the rule-authoring editor". That editor is a
screen, and a screen needs something to sit on: a layer that takes an authoring intent, validates it,
checks it against the ruleset it would join, and stores it somewhere that prices nothing until somebody
publishes it. `rule-authoring.js` + `rule-authoring-store.js` are that layer, and they are the first
thing in this engine to call either module.

**Both of those rows stay, and it would be dishonest to strike them off.** A caller that is itself
unreachable is not a caller — nothing in `src/` reaches the service, so nothing reaches the two modules
through it, and the check agrees (it still lists all four). What changed is the answer to "what would
wire it", which is now one thing rather than two: a route mounting the service. Their rows say so.

**The service is unreachable for a stated reason, not an oversight.** `src/longterm/routes/ppe.js` is
owned by another workstream right now and was not touched, so the four doors this needs
(`POST /rules/drafts`, `GET /rules/drafts`, `GET /rules/drafts/:id`, `POST /rules/drafts/:id/publish`)
do not exist yet. The publish door in particular is not a mechanical addition: it is the one that
changes what a loan is priced at, so **who may press it is an owner decision** — the rest of this
router splits on `requirePpeAdmin`, and whether publishing a pricing rule belongs to that same group has
not been asked. Until it is, the service refuses to publish without a named human and records who it
was, which is the safe half of the answer.

## The ledger

| Module | Why it is not wired yet | What would wire it |
| --- | --- | --- |
| `src/longterm/ppe/program-audit.js` | The offline our-side half of the same harness (dead-rule / coverage profiler). | NOT the agreement run — that is now wired and does not call this. It profiles OUR sheet alone, with no vendor leg, so its home is the free pre-flight beside `GET …/coverage`, not the paid battery. |
| `src/longterm/ppe/program-audit-command.js` | **Deliberately unwired, and it IS run.** It is the body of the offline operator command `scripts/lt-ppe-program-audit.js`, which starts it as its own process — so nothing the server boots requires it, by design. It lives here rather than in `scripts/` because Long-Term back-end code may live nowhere else, and the launcher imports nothing so no RTL file gains a Long-Term dependency. | Nothing should. If the audit is ever wanted *inside* the product (a scheduled run, an admin screen), that surface would require it — and this row comes off then. |
| `src/longterm/ppe/disqualify-reconcile.js` | The earlier per-layer disqualifier reconciler. | Superseded in practice by `disqualifier-reconciler.js`, which the agreement run now calls. Keep or retire deliberately — nothing should call two of these. |
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
| `src/longterm/ppe/rule-builder.js` | The universal rule / condition authoring layer (#48). `rule-authoring.js` calls it now, but that service is itself unwired, so this is still reached by nothing. | A route mounting `rule-authoring` — the same one thing that wires the two rows below. |
| `src/longterm/ppe/ppp-structures.js` | The reusable prepayment-penalty structure library (D31). Same as above: `rule-authoring.js` offers its structures as the value set for the `ppp_structure_key` dimension, and warns when one already carries a holdback — but nothing reaches that service. | As above. |
| `src/longterm/ppe/rule-authoring.js` | The rule-authoring SERVICE — an authoring intent in, a validated canonical rule plus a screen-ready render out, or a refusal in plain language. Pure. | `POST /api/lt/ppe/rules/drafts` (+ the list/read doors). `src/longterm/routes/ppe.js` belongs to another workstream at the moment and was deliberately not edited. |
| `src/longterm/ppe/rule-authoring-store.js` | Its durable half: `lt_ppe_rule_draft` (db/577), and the one deliberate `publishDraft` act that puts a rule into `lt_ppe_rule` where quotes read it. | The same route, plus an owner decision on WHO may publish — this is the door that changes a priced number, and whether `requirePpeAdmin` is the right gate for it has not been asked. |
| `src/longterm/ppe/ratesheet-ingest.js` | Rate-sheet ingestion normalizer. | A file-upload path for a sheet; the console pastes instead today. |
| `src/longterm/ppe/lp-drift.js` | Daily Lender-Price drift detection + classification (D19). | A scheduled run — deliberately not added, for the same reason the canary has no timer: a background loop calling a paid vendor is the owner's decision. |
| `src/longterm/ppe/lp-daily-run.js` | The IO-injected wrapper tying the drift pieces together. | As above. |
| `src/longterm/ppe/lp-daily-schedule.js` | The per-investor daily schedule for that run. | As above. |
| `src/longterm/ppe/cutover-ledger.js` | The append-only cutover decision history (§11). | The promote-to-live route (P10) — owner-gated on who may promote. |
| `src/longterm/ppe/cutover-store.js` | Its durable bridge. | As above. |
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
