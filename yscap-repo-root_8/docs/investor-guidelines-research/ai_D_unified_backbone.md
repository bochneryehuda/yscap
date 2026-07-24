# AI-D — The Unified Underwriting Backbone: one motion, everything talks to everything

READ-ONLY architecture research. No files were modified. Goal: show how to unify what
ALREADY EXISTS so a change anywhere (a field edit, a document read, a re-price, a note-buyer
guideline) flows to every relevant check and lands in ONE shared picture — without a rewrite.

---

## 0. The single most important finding

**The whole-loan RUN backbone is fully built and unit-tested, but has ZERO production wiring.**

- `src/lib/underwriting/run.js` `runWholeLoan(appId, db, opts)` — the orchestrator — is **called
  from nowhere** in `src/` except its own module and `scripts/test-*`. Confirmed:
  `grep -rn runWholeLoan src/` returns only `run.js` and doc comments.
- `src/lib/underwriting/run-trigger.js` `decideTrigger(...)` — the debounced event→run decision —
  is referenced **only in tests**. No route, no worker, nothing emits `MATERIAL_EVENTS` into it.
- No boot worker starts it. `src/server.js:536-579` boots clickup-sync, sharepoint-backup, esign
  poller, sitewire-sync, encompass-sync, flags, notification-digests, lo-notification-worker,
  integrations/monitor — **but nothing for the underwriting run.**
- `underwriting_runs` rows are therefore never written outside tests, so the read-side cockpit
  (`run-cockpit.loadRunCockpit`, `underwriting.js:1089`), the "why" explainer (`:1103`), the
  findings CSV (`:1127`), and `issuance-gate` all read a table that is **empty in production**.

So today the "ONE decision + ONE finding surface" (`run.js` → `decision.js` → `finding-registry`)
is a beautifully composed engine **with no fuel line**. The live system instead runs on a
DIFFERENT hub — the Condition Center — which nobody wired to the run. **The single highest-leverage
move is to make the run the thing events actually fire, and to attach the live desks to it.**

---

## 1. The canonical shared CONTEXT — three overlapping views that re-derive each other

There is not one shared context today; there are **three**, each loaded by its own SQL, each
resolving the same core facts (program, loan_amount, purchase_price, arv, units, property_type,
fico) a different way. This is the central duplication seam.

| Context builder | File:line | Loads | Resolution method | Read by (today) |
|---|---|---|---|---|
| **`buildWholeLoanContext`** | `whole-loan-context.js:268` | application (+FICO join), current registration, current appraisal, liquidity | **source-priority** with provenance + discrepancy list + reproducible `sourceHash` | **only `run.js:266`** (which nothing calls) |
| **`loadRuleContext`** | `conditions/engine.js:49` | application, borrower, llc, current registration, verified experience, flood zone, custom fields | raw columns + registry normalizers (`normNoteBuyer`, `normState`, …) | `conditions/engine.evaluateApplication` (the LIVE hub) **and** `investor-guidelines/desk.js:344` |
| **`factsForFile`** (the twin) | `twin.js:589` | `loan_facts` canonical rows (from append-only observations) | **source-authority hierarchy** + confidence + consensus, per `fact_key` | `cure.js`, `investor-guidelines/desk.js:410` (numeric signals), decision-certificate |

**Overlap / duplication:** all three independently know program, loan_amount, purchase_price, arv,
units, property_type. `whole-loan-context` resolves them with a provenance-tagged source-priority
engine; `loadRuleContext` reads raw `applications` columns; the twin resolves them from document
observations. `loadRuleContext` is the only one that carries `note_buyer`, borrower FICO, flood
zone, experience, and custom fields; `whole-loan-context` is the only one with a `sourceHash`
(reproducibility) and a machine discrepancy list; the twin is the only one with document-level
provenance and human-confirmed overrides. **No single context has all three properties, so every
consumer picks a different one and re-derives the rest.**

The seam is sharpest in `investor-guidelines/desk.js`: it reads `loadRuleContext` for the note
buyer + triggers (`:344`) AND `twin.factsForFile` for numeric signals (`:410`) AND checklist_items
by template code (`:388`) — three loads, hand-stitched, because no context unifies them.

---

## 2. The ORCHESTRATOR — what `run.js` already folds in, and what it does not

`runWholeLoan` (`run.js:262`) → `assembleRun` (`run.js:108`) already composes into ONE deduped
registry + ONE decision:

- **whole-loan context** (`run.js:266`) — the structure facts + discrepancies.
- **program/frozen verdict** — `program-adapter.fromRegistration` (`run.js:278`): engineStatus,
  manualReasons→findings (`:150`), blockingReasons→fatal findings (`:153`), sizing.
- **independent structure ledger** — `structure-underwriter.ledger` (`run.js:117`): cap breaches →
  `structure_*_over_cap` findings (`:126`).
- **assignment re-derivation** — `assignment-analysis.analyze` (`run.js:176`).
- **staleness / priced-input drift** — `pricedDrift` from the context's own discrepancies
  (`run.js:288, 328`) → `registration_input_drift` findings.
- **AVM/independent verification** — `verification-findings.gatherVerificationFindings`
  (`run.js:298`) — the ONE desk it actively loads itself.
- **review manifest** — `run-manifest` (`run.js:200`) — records which components contributed.
- **decision** — `decision.decide` (`decision.js:33`) composes uw-status + `finding-registry`
  → status + termSheet/CTC/funding gates + deduped `registry`, then `persistRun` freezes it.
- It accepts **`extraFindings`** (`run.js:194, 308`) as the designed attach point for
  appraisal / document / system-reconciliation / liquidity findings.

**What is NOT folded in (the islands):**

- **The INVESTOR-GUIDELINE overlay (`investor-guidelines/desk.js`).** `runInvestorGuidelineDesk`
  is called ONLY by its own route (`underwriting.js:1070`) and returns a side-panel result
  (`happy` / `unhappy[]` / `conflicts` / `coverageGaps`). Its `unhappy` items already carry
  `severity: 'fatal'|'warning'` and a `flag` — the exact shape a finding needs — but they never
  enter `extraFindings`, never dedupe against structure/appraisal findings, never touch the
  decision or the three gates. It is a pure island.
- **The doc-understanding cure/verify step (`cure.js`).** `store.js:255-267` runs `cure.analyze`
  when a document is attached, producing a clearance proof + NEW findings, and `document_findings`
  rows are written (`store.js:139`). Those findings live in their own table and their own route;
  **they are never gathered into `extraFindings`.**
- **The appraisal desk (`appraisal/import.js`, `appraisal/desk.js`).** Writes `appraisal_findings`
  (own table, own route `appraisal.js`, own `blocks_ctc`). Never gathered into the run.
- **The Condition Center itself (`conditions/engine.evaluateApplication`).** The live event hub —
  but it produces checklist_items, not run findings, and never invokes the run.
- **system-reconciliation** (`system-reconciliation.js`, `encompass-field-map.js`) — exists as the
  R6.10-12 desk `assembleRun` documents as a source of `extraFindings`, but no caller passes it.

So `assembleRun` has slots (`extraFindings`) for appraisal / document / system / liquidity /
investor-guideline findings, and **all of those slots are empty because `runWholeLoan` is never
invoked and no caller fills them.**

---

## 3. The EVENT triggers — what fans out today vs. the missing links

**The REAL fan-out hub today is `conditions/engine.evaluateApplication`** (not run-trigger). It is
called from ~15 event sites:

- product (re-)register — `borrower.js:979`, `staff.js:1886`
- rehab budget / SOW saved — `borrower.js:1464`, `staff.js:2375, 2451`
- info-condition answered — `borrower.js:1363`
- application created — `borrower.js:3458`
- details / completeness edited — `staff.js:6172, 6476`
- status change — `staff.js:6621, 6721`
- ClickUp inbound ingest — `clickup/ingest.js:1195`
- appraisal flood check — `appraisal/desk.js:149`
- LLC linked — `vesting.js:106`

**Other live event paths:**
- **Document upload → auto-read.** `auto-read.selectAutoReadQueue` + `analyzeOneDocument`
  (`underwriting.js:742, 961`) read+check each on-file doc; `store.js:108` feeds the twin
  (`recordFactsFromExtraction`) and `store.js:255` runs cure. Scheduled sweep in
  `notification-digests.js:709`.
- **Economics-change DB triggers.** `db/071`/`db/072` `trg_reopen_on_budget_change` reopens
  `product_pricing` on any pricing-input change and the SOW condition on a budget change — from
  ANY write path (borrower/staff/ClickUp/re-register). This is the one truly central, all-sides
  fan-out — but it reopens **conditions**, not runs.
- **LOS field writes → twin.** `twin.recordLosFieldFacts` (`twin.js:783`) on application writes.

**The MISSING links (events that do NOT fan out to where they should):**

1. **A document read → investor-guideline verify → condition.** When `store.js` records a new
   appraisal/title/insurance fact, the investor desk's numeric checks (seller concession,
   contingency, liability tier, median value — `desk.js:51-92`) are NOT re-run, and the cure
   findings never reach the run. The chain document→twin→investor-verify→finding→decision is
   broken at every hop after the twin.
2. **A field change → program re-price → conditions → investor guidelines.** `db/071` reopens the
   pricing condition, but nothing re-runs the whole-loan run, so the frozen program verdict, the
   structure ledger, AND the investor overlay are never recomputed against the new number.
3. **No event emits into `run-trigger.decideTrigger`.** The debounce/coalesce brain exists
   (`MATERIAL_EVENTS` at `run-trigger.js:23` lists document_uploaded, condition_changed,
   status_changed, economics_changed, note_buyer_changed, guideline_changed, appraisal_imported…)
   but no producer feeds it and no scheduler consumes its `dueAt`.
4. **`guideline_changed` / `note_buyer_changed` fan out to nothing.** A note-buyer change reopens
   the CorrFirst EMD condition via `evaluateApplication`, but does NOT re-run the investor desk
   into a decision, nor re-price, nor re-run the whole-loan run.

---

## 4. The shared OUTPUT surfaces — and which are islands

- **`finding-registry.consolidate`** (`finding-registry.js:36`) — the ONE deduped registry, keyed
  `(code, subject)`, max-severity, OR-ed block flags. This is the intended single surface. Fed
  ONLY by `decision.decide` inside a run → **empty in production** because runs don't fire.
- **The whole-loan run findings** (`underwriting_run_findings`, persisted `run.js:372`) — read by
  cockpit/why/CSV/issuance-gate. Empty in production.
- **`ai-suggestions`** (`ai-suggestions.record/decide`, routes `underwriting.js:1932+`) — a
  SEPARATE surface with its own table and dedupe (`(source, dedupe_key)`), human convert/dismiss.
  This is where a human posts an investor-guideline suggestion today — but it is not the run
  registry.
- **`fraud-alert` banner** (`fraud-alert.fileBanner`, `underwriting.js:619`) — its own banner
  surface.
- **`document_findings`** (own table), **`appraisal_findings`** (own table), **investor desk
  `unhappy[]`** (computed live, not persisted) — three more islands.

**The investor-guideline overlay is a side-panel island**: `underwriting.js:1065` serves it as its
own endpoint; its `unhappy`/`conflict`/`coverage_gap` verdicts never flow into the finding registry
or the decision gates. By design it is "advisory / only speaks when the note buyer is unhappy"
(`desk.js:273`), but "advisory" should still mean **one finding in the shared registry**, not a
separate screen the underwriter has to open.

---

## The "ONE MOTION" integration design

### (a) The single shared context every engine reads — name it: **`LoanContext`**

Do NOT build a fourth context. **Promote `buildWholeLoanContext` into `LoanContext` by folding the
two other loaders into it as sections**, so there is one loader, one `sourceHash`, one discrepancy
list, and every engine reads the same object:

- Keep `whole-loan-context`'s source-priority core + `sourceHash` (its reproducibility is the
  reason to make IT the base).
- **Fold in `loadRuleContext`'s fields** (`conditions/engine.js:101-160`): `note_buyer`, borrower
  FICO, flood zone, verified + requested experience, custom field values, normalized state/
  property-type/occupancy. Expose them as `ctx.rule` so `evaluateApplication` and the investor desk
  read `LoanContext.rule` instead of re-querying.
- **Attach the twin** as `ctx.facts` (`twin.factsForFile`) so cure + the investor desk's numeric
  signals read canonical facts off the same object (no third query).
- Result: `evaluateApplication`, `runWholeLoan`, `runInvestorGuidelineDesk`, and `cure` all read
  ONE `LoanContext(appId)` — program/loan_amount/arv resolved once, provenance-tagged once,
  hashed once. The `sourceHash` becomes the dedup key the run-trigger already expects
  (`run-trigger.js:137`, `contextHash === lastContextHash → skip`).

### (b) The event → fan-out map (each trigger → every check it should invoke)

Make **`run-trigger.decideTrigger` the single scheduler** and have every existing event site EMIT a
material event instead of (or in addition to) calling `evaluateApplication` directly. One debounced
run then fans out to every desk in order:

```
ANY material event  ──►  emit {kind, at}  ──►  run-trigger.decideTrigger (debounce/coalesce)
                                                     │ action:'run'
                                                     ▼
                                            runWholeLoan(appId)
        ┌──────────────┬──────────────┬───────────────┬───────────────┬────────────────┐
        ▼              ▼              ▼               ▼               ▼                ▼
  conditions       program        structure       appraisal        cure/doc      investor
  engine           adapter        ledger          findings         findings      desk
  (evaluateApp)    (frozen        (R6.6)          (appraisal_      (document_    (runInvestor
                    verdict)                       findings)        findings)     GuidelineDesk)
        └──────────────┴──────────────┴───────────────┴───────────────┴────────────────┘
                                                     ▼
                                    extraFindings  →  decision.decide
                                                     ▼
                          finding-registry.consolidate  →  ONE registry + ONE decision
                                                     ▼
                          persistRun  →  cockpit / why / CSV / issuance-gate / fraud banner
```

Event → invoked checks (all via the one run):

| Event (source) | Fans out to |
|---|---|
| document_uploaded/read (`store.js`, auto-read) | twin reconcile → cure findings → **appraisal/title/insurance re-check** → investor numeric checks → structure/program (value changed) → registry |
| field/economics change (`db/071` + write paths) | program re-price verdict → structure ledger → conditions reopen → investor overlay → registry |
| condition cleared/reopened (`staff.js`, engine) | decision gates recompute → investor "satisfied/outstanding" verdict → registry |
| status_changed (`staff.js:6621/6721`) | conditions eval → run → gates |
| product_registered (`borrower.js:979`,`staff.js:1886`) | full run (program+structure+investor) |
| note_buyer_changed (`clickup ingest`,`completeFields`) | investor desk (new applicable guidelines) → conditions → registry |
| appraisal_imported (`appraisal/import.js`) | appraisal findings → twin (ARV/as-is) → structure re-check → investor median-value check → registry |
| guideline_changed (guideline version activated) | investor desk for every open file with that note buyer |

### (c) Where the investor overlay + GPT doc-verifier + program/credit/appraisal attach

All attach at the **`extraFindings` seam in `assembleRun`** (`run.js:194`), converted to the common
finding shape, so they compose into ONE decision + ONE registry:

- **Investor-guideline overlay:** map `runInvestorGuidelineDesk().unhappy[]` (`desk.js:286`) →
  findings. It already carries `severity` and `flag` (`conflict`→fatal, `coverage_gap`→fatal on
  construction_feasibility else warning). Emit as `investor_guideline_conflict` /
  `investor_guideline_gap` findings with `source:'investor_guideline'`, `subject` = cond_no. They
  dedupe against structure/appraisal findings and flow into the gates as advisory-but-visible (per
  the never-block rule, keep them non-`blocks_*` unless the owner wants a gate; the fatal severity
  still surfaces them at the top of the registry).
- **GPT doc-verifier / cure:** `store.js` already runs `cure.analyze` and writes `document_findings`.
  Add a gatherer `gatherDocumentFindings(appId)` that reads open `document_findings` (mirroring the
  existing `verification-findings` pattern at `run.js:298`) and pass it in `extraFindings`.
- **Appraisal:** add `gatherAppraisalFindings(appId)` over open `appraisal_findings` (they already
  have `severity`, `blocks_ctc`, `code`, `field`) → `extraFindings`.
- **Program/credit:** already folded (`program-adapter`, FICO via context). Credit/FICO breaches
  become program `manualReasons`/`blockingReasons` today; keep.

### (d) The specific seams to close

1. **No production caller of `runWholeLoan`** — the whole backbone is dark. Wire a worker + emit
   events. (Seam: §0.)
2. **Three contexts re-derive the same facts** — `whole-loan-context` vs `loadRuleContext` vs
   `twin.factsForFile`. Unify into `LoanContext`. (Seam: §1.)
3. **Investor overlay is an island** — `desk.js` output never enters `finding-registry`. (Seam: §4.)
4. **cure / `document_findings` never reach the run** — clearance findings die in their table.
5. **`appraisal_findings` never reach the run** — separate table, separate gate.
6. **`run-trigger` consumes no events** — the debounce brain is unused; the live hub is
   `evaluateApplication` instead, which produces conditions but not runs or decisions.

---

## Top-10 connections to wire (each builds on existing modules)

1. **Boot an underwriting-run worker + emit material events.** Add a `src/sync/uw-run.js`
   `start()` to `server.js:~579` that drains an event queue through
   `run-trigger.decideTrigger` (`run-trigger.js:101`) → `run.runWholeLoan` (`run.js:262`). Have the
   ~15 `evaluateApplication` call sites ALSO emit `{kind, at}`. This turns the dark backbone on.

2. **Attach the investor-guideline overlay to the run.** In `run.js`, load
   `investor-guidelines/desk.runInvestorGuidelineDesk` (`desk.js:332`) like `verification-findings`
   (`run.js:298`), map `.unhappy[]` (`desk.js:286`) → findings, push into `extraFindings`
   (`run.js:308`). One island collapses into the registry.

3. **Feed cure / `document_findings` into the run.** Add `gatherDocumentFindings(appId)` mirroring
   `verification-findings.js`; read open `document_findings` written by `store.js:139` (from
   `cure.analyze`, `store.js:267`) → `extraFindings`. Now a document read reaches the decision.

4. **Feed `appraisal_findings` into the run.** Add `gatherAppraisalFindings(appId)` over open
   `appraisal_findings` (`appraisal/import.js:173`, `appraisal.js:72`) → `extraFindings`; they
   already carry `severity`/`blocks_ctc`.

5. **Unify the three contexts into `LoanContext`.** Extend `buildWholeLoanContext`
   (`whole-loan-context.js:268`) to expose `.rule` (fold `loadRuleContext`,
   `conditions/engine.js:49`) and `.facts` (attach `twin.factsForFile`, `twin.js:589`); repoint
   `evaluateApplication`, the investor desk (`desk.js:344,410`), and `cure` to read it. One load,
   one `sourceHash`.

6. **Emit into `run-trigger` from the economics DB trigger path.** The `db/071`/`db/072`
   `trg_reopen_on_budget_change` is the one all-sides fan-out; have its write paths emit
   `economics_changed`/`rehab_budget_changed` (already in `MATERIAL_EVENTS`, `run-trigger.js:34`)
   so a re-price recomputes the run, not just reopens the condition.

7. **Document read → investor numeric re-verify.** When `store.js` records a new appraisal/title/
   insurance fact (`twin.recordFactsFromExtraction`, `store.js:108`), emit `document_uploaded` so
   the run re-runs the investor desk's numeric checks (seller concession / contingency / liability
   / median value, `desk.js:51-92`) against the fresh twin signals (`desk.js:410`).

8. **note_buyer_changed / guideline_changed → run.** Where the note buyer changes
   (`clickup/ingest.js`, `staff.js completeFields`) and where a `guideline_versions` row goes
   `active` (the query in `desk.js:359`), emit the matching material event so the investor overlay
   re-evaluates and lands in the registry — closing the "guideline change flows everywhere" gap.

9. **Surface the run registry as the ONE panel; make ai-suggestions/fraud a view of it.** The
   cockpit (`run-cockpit.loadRunCockpit`, `underwriting.js:1089`) already reads the persisted run;
   once runs fire, route the fraud banner (`fraud-alert.fileBanner`, `underwriting.js:619`) and
   investor "post this" items into `ai-suggestions.record` (`underwriting.js:836`) as convert
   actions off the SAME registry, so the human acts on one list.

10. **Use `sourceHash` as the idempotency key across the loop.** `assembleRun` already computes
    `sourceHash` (`run.js:217`) and `run-trigger` already skips when `contextHash === lastContextHash`
    (`run-trigger.js:137`). Persist the last run's hash and pass it back into `decideTrigger` so a
    burst of six document pages or ten sync fields coalesces into ONE run — the debounce the module
    was built for but never given data.
