# DRAFT — Research proposal (owner review before build)

**Deal performance + fraud/integrity signals on the track record**
Stream D research pass · 2026-08-09 · PILOT (RTL). Research + design only — no code was changed and nothing was committed. This document is the only artifact.

---

## 0. Plain-language summary (for the owner)

Two new things on a borrower's track record, and **both only ever advise — neither can ever block a closing or a funding.**

1. **Do their deals actually perform?** When we financed a borrower's past project, we underwrote an ARV (the after-repair value the appraisal said), a rehab budget, and a hold length. When the project finished we can now compare what *actually* happened — the real sale price, the real spend, the real hold time — against what we underwrote. A borrower whose finished deals landed close to plan gets a quiet confidence boost; one whose deals kept missing gets a quiet caution. It never changes the loan by itself; it just puts an honest number next to their experience.

2. **The industry fraud red-flags, shown on the record.** The known flip/straw-buyer patterns: a seller who bought the house days before selling it, a "sale" to the borrower's own people, a borrower with no history in the market they're buying in, a loan far bigger than anything they've ever done. Each is a note on the record for a human to look at — never an automatic "no."

We already **built** most of the fraud engine (`counterparty.js`, the "Baltimore control"). It is finished and tested but **not plugged in anywhere.** Half of this proposal is finishing that wiring properly. The other half is the performance comparison, which is mostly reading numbers we already store.

**The hard rule for all of it:** advisory only, never a block; never invents a number (missing data → no signal, not a guess); no phone/contact data drives a decision; note-buyer names never leak to a borrower; the machine points, a human decides.

---

## 1. Scope and the two linked things

Both features hang off the **track record** — the list of a borrower's past deals that prices their experience tier, which in turn drives their leverage. This is RTL only (`applications`/`track_records` are the RTL tables).

- **(1) PERFORMANCE — "do their deals perform?"** For each completed line, where we hold the underwritten baseline: actual sale price ÷ underwritten ARV; actual hold time vs projected term; actual rehab spend vs the rehab budget. A per-line read and a per-borrower roll-up that **strengthens or tempers** confidence in the verified experience count. Never a gate.
- **(2) INTEGRITY — the fraud/flip red-flags on the record.** Rapid re-sale (seller acquired title days before the sale), related-party / straw-buyer patterns (the built counterparty graph), no prior ownership in the subject's market, loan size vs documented capacity. Each an **advisory `track_record_finding`** with a machine-readable reason, wired into the human-click verify run. Never a gate.

Everything here obeys the **AI-findings-are-advisory HARD RULE** in `CLAUDE.md` (owner-directed 2026-07-27). The single owner-directed enforcement exception — the appraisal review — **does not apply here** (§6).

---

## 2. Current state (what exists, cited)

### 2.1 The counterparty / related-party machinery — BUILT, TESTED, NOT WIRED

- **`src/lib/track-record/counterparty.js`** — "THE BALTIMORE CONTROL." A **pure** engine (`assessCounterparty(exit, graph)` + `assessPortfolio(exits, graphFor)`) that scores whether the buyer on a claimed exit is connected to the borrower: shared principals (`shared_principal` 60), shared signer (55), vendor-linked co-occurring entity (45), shared mailing address (45, with a registered-agent allowlist so an agent's office never fires it), repeat counterparty (30 + 15/repeat), shared distinctive name token (20, never enough alone), vendor-flagged non-arm's-length (50); `RELATED_AT = 40`. It is **tri-state on purpose** — `unknown` is the default and means "nobody looked," never "unrelated" (`VERDICT`, header lines 25-30). `assessPortfolio` also computes buyer **concentration** (one buyer absorbing ≥50% of a borrower's exits — the Baltimore pattern in miniature).
- **State: built and unit-tested, but dead in production.** Its only consumer is `scripts/test-track-record-engine-pure.js:26`. A repo-wide grep for a production `require('...counterparty')` returns **nothing** — no route, no verify run, no sweep calls it. `src/lib/track-record/checks.js:612` (in `findSale`) even names it in a comment ("selling to a cousin … is what `counterparty.js` is for"), confirming the intended-but-unbuilt seam. Today the exit pillar's `relatedPartyExit` signal (`checks.js:629`, surfaced by `signalsFor` at `:765`) comes **only** from a deed's own `armsLength`/`isNonArmsLengthTransfer` flag — never from the relationship graph.
- **The deed counterparty is now captured but not consumed.** `src/lib/track-record/importer.js` writes the acquisition seller onto `track_records.seller_name` (added by **db/499** — the column previously had *no writer*, "so the related-party control was starving"). db/499's own header says the seller name "is how a RELATED-PARTY exit is spotted … and it cannot be computed without this." So the input now exists; nothing reads it yet.
- **The graph data source exists and is one wrapper short.** `src/lib/elementix/lookups.js` fetches the borrower entity's deeds, mortgages, satisfactions, ownership history and **associated people** (`entityPeople`, `:228`) and exposes `coOccurringEntities` (`:335`, `get_entity_co_occurring_entities`) and `get_entity_related_addresses` (in the allowlist, `:70`). But `researchProperty` (`:488`) **does not currently call** `coOccurringEntities`, does not fetch the **buyer's** people/entity, and does not assemble the graph shape `counterparty.assessCounterparty` expects. That assembly is the missing piece.

**Verdict on the go-forward item:** the "wire the counterparty graph into the verify run" item is real. The engine is done; what's missing is (a) a graph-fetch function in `lookups.js`, (b) the call from `verify-run.js`, and (c) persistence as an advisory finding. §5 designs that.

### 2.2 Chain-of-title primitives (reuse, don't duplicate)

- **`src/lib/underwriting/chain-of-title.js`** — `buildChainOfTitle(ctx, exts)` follows owner-of-record → seller → buyer → assignments → vesting and emits `cot_*` findings that are **already advisory by construction** (`mk` seeds `blocksCtc:false`, `:54`; every finding is `warning`/`info`). It imports the party-matching primitives from seller-chain: `_internals: { sameParty, partyInList, isEntityName }` (`:26`). These are the exact primitives the related-party detector should reuse for name/entity matching, alongside `counterparty.js`'s own `samePerson`/`sameEntity`/`samePlaceAddr` (which delegate to `underwriting/compare` and `address.sameAddress`).

### 2.3 Track-record findings + the gate (the home for a new advisory finding)

- **`src/lib/track-record-findings.js`** + **db/418** `track_record_findings`. Today two codes: `duplicate_line` and `subject_property_on_record`, both `severity:'warning'` (`FINDINGS`, `:51`). The table already carries `code`, `severity` (`'warning'|'info'`), `title`, `detail`, `dedupe_key`, `status` (`open|resolved|dismissed`), `resolution`, and a partial-unique open index.
- **The gate reads severity, and `'info'` never gates.** `experienceBlockReason` (`:322`) filters `f.severity !== 'info'` (`:331`) before deciding whether to hold the experience sign-off — with a comment saying exactly why: "an `info` finding is advisory … Without this filter the first advisory code added would silently become a gate." **This is the clean hook for the new integrity signals — they are `severity:'info'` and therefore structurally incapable of blocking sign-off, CTC or funding.**
- **Durable, dismissable dismissal is already built in.** `syncForBorrower` (`:180`) consults the `decided` set (rows in `status IN ('resolved','dismissed')` keyed by `dedupe_key`, `:191`) before raising, so a dismissed finding never re-appears — "the same discipline `finding_decisions` (db/333) established for the AI desks." `resolveFinding` (`:346`) is the audited close path. This table's own decide-durability is the track-record analog of `finding_decisions`.

### 2.4 Appraisals + ARV, and where the actual sale lands

- **Underwritten ARV / As-Is (our loans):** `db/137` `appraisals` — `appraised_value` (`:34`), `as_is_value` (`:35`), `arv_value` (`:37`), `arv_confidence` (`:38`), `superseded` (`:99`, current = `false`), `imported_at` (`:101`), keyed to `application_id`. Also mirrored onto the file: `applications.as_is_value` / `applications.arv` (`schema.sql:178-179`), the registered figures the loan was sized on.
- **The rehab budget / projected term (our loans):** `applications.rehab_budget` (`:180`), `applications.term` (`:191`, free text e.g. "12 Months"), `applications.loan_amount` (`:187`). db/265's `first_payment_date`/`maturity_date` give a firmer projected window when present.
- **The actual figures (on the track record line):** `track_records` (`schema.sql:123`) — `sale_price`, `purchase_price`, `rehab_amount`, `purchase_date`, `sale_date`, `rent_date`, `refi_date`, `current_value`. **db/499** added the derived exit machinery: `counts_from` (the frozen exit date, GENERATED), **`hold_days`** (exit − purchase, GENERATED, "DISPLAYED AND NEVER GATED"), and `seller_name`.
- **The missing link:** `track_records` has **no `application_id`** (db/418's header confirms it is a borrower-level record). So "was this line one of our loans?" must be resolved by matching `borrower_id` + `property_address` via `ADDR.sameAddress` — the same primitive `subject_property_on_record` already uses (`track-record-findings.js` `subjectPropertyFindings`, `:145`).

### 2.5 The research warehouse + Sitewire (the fallback ARV, and the on-budget/on-time actuals)

- **`db/409` research warehouse.** `properties` roll-up: `last_sale_price` (`:203`), `last_sale_date` (`:204`), `last_sale_type` (`:205`, `ArmsLengthSale|REOSale|Listing|…`), `last_sale_status` (`:206`), `last_list_price` (`:207`), `arv_comp_count`/`asis_comp_count` (`:218-219`). `property_observations` (`:275`): per-report `sale_price` (`:304`), `sale_date` (`:306`), `prior_sale_date` (`:315`). `property_sales` (`:424`): distinct recorded transactions. **db/410** + `src/lib/research/valuation.js` build a comps-based valuation. This is the fallback source of an underwritten/estimated ARV when a line was **not** one of our loans but the warehouse has seen the property (as an appraisal subject or a comp).
- **`src/sitewire/rollup.js`** — for a file we funded **and** managed draws on, the rollup gives `budgeted` / `drawn` (released) / `remaining` per `sow_line_key`, and the whole-project totals. This is the **strong** actual-rehab-spend and on-time source (`src/sitewire/monitor.js` already computes behind-pace/overdue). It exists only for managed-draw files — for everyone else the only actual spend we hold is the self-reported `track_records.rehab_amount`.

### 2.6 The advisory rule + the finding_decisions ledger

- **`CLAUDE.md` HARD RULE (2026-07-27):** AI findings are advisory only — nothing PILOT finds may block a sign-off, CTC, funding, or an issuance; kill-switch `AI_FINDINGS_ENFORCE=1` restores enforcement everywhere. `src/lib/underwriting/advisory-policy.js` owns the switches.
- **db/333 + `src/lib/underwriting/finding-decisions.js`** — the durable, per-file, per-finding ledger (`record`/`reopen`/`suppressedKeys`/`filterSuppressed`), keyed on `finding-claims.claimOf`, best-effort and **fail-open** (an unreadable ledger suppresses nothing). It governs the `document_findings`/`appraisal_findings`/derived-desk findings. `track_record_findings` has its **own** equivalent durability (§2.3); both satisfy the "dismissable + durable + advisory" requirement.
- **The one enforcement carve-out is scoped and does NOT reach here:** `advisory-policy.appraisalReviewEnforced()` enforces the `appraisal_review_cleared` condition against open **`appraisal_findings`** only (a different desk and table). Nothing in this proposal touches that desk.

---

## 3. Performance metrics — exact design

### 3.1 The three comparisons (compute only where the baseline exists)

For a completed `track_records` line, resolve the **baseline source** first:

- **OURS** — the line matches one of the borrower's applications by `borrower_id` + `ADDR.sameAddress(track.property_address, app.property_address)`. Baseline ARV = the file's current appraisal `arv_value` (`appraisals WHERE application_id = app.id AND superseded = false`), else `applications.arv`. Projected term = `applications.term` parsed to months (or `maturity_date − first_payment_date`). Rehab budget = `applications.rehab_budget`. Actual rehab spend = Sitewire `rollup` released total if the file was draw-managed, else `track_records.rehab_amount`.
- **WAREHOUSE** — no matching application, but `db/409` has an appraisal-subject observation for the property with an ARV, or `valuation.js` can produce a comps ARV. Baseline ARV = that. (No budget or projected term available from the warehouse — so only the sale-vs-value metric computes on this path.)
- **NONE** — neither. The line simply has **no performance score.** Never fabricated. This is the governing rule (task §1): "a line with no underwritten ARV simply has no performance score."

Then compute only the metrics whose inputs are present:

| Metric | Formula | Actual (from) | Baseline (from) | Computes when |
|---|---|---|---|---|
| **Value accuracy** | `sale_price ÷ underwritten_ARV` | `track_records.sale_price` (flips); for a hold, the refi appraised value if we hold one | `appraisals.arv_value` / `applications.arv` (OURS) or warehouse ARV | line has a real exit **sale** and a baseline ARV |
| **Hold vs projected** | `hold_days` vs projected term (days) | `track_records.hold_days` (db/499, GENERATED) | `applications.term` → months, or `maturity_date` window | OURS only (need our projected term) |
| **On-budget** | `actual_spend ÷ rehab_budget` | Sitewire released total (managed) else `track_records.rehab_amount` | `applications.rehab_budget` | OURS only (need our budget) |

**Deliberate refusals:**
- **Holds sell nothing**, so value-accuracy on a hold uses the refi/appraised value when we have it, and is otherwise absent — never forced.
- **`hold_days` never becomes a threshold.** db/499 is explicit ("DISPLAYED AND NEVER GATED — 'I don't care about such a short hold period'"). Hold-vs-projected is *context*, never a pass/fail. A short hold that beat plan is a good outcome, not a flag.
- **Self-reported `rehab_amount`** is a **weak** on-budget input and is labelled as such; the Sitewire actual is the strong one.
- The whole feature is **read-only derived** — it never writes back to `applications`, an appraisal, or the frozen registration; it touches **no frozen pricing number.**

### 3.2 The per-borrower roll-up (the confidence signal)

Across the borrower's **verified, in-window** lines that have a score: e.g. "Of 6 completed projects we financed, 5 sold at ≥95% of the ARV we underwrote (median 98%); median hold +1 month vs projected; median spend 99% of budget." Bands (the exact "hit" threshold is an owner question, §9) drive one advisory word — *strengthens* / *neutral* / *tempers* — shown beside the verified count. **It never changes the count or the tier**; it colours the reviewer's read of it.

### 3.3 Where it surfaces

- **The scorecard (Stream C `ExperienceHeader`)** — the per-borrower roll-up sits beside Claimed / Verified / Still-needed as a fourth, clearly-advisory tile ("Do their deals perform?").
- **The LineDetail (`GET /track-records/:id/workspace`, `staff.js:11233`)** — the per-line comparison renders beside the three verification pillars: "Sold $312,000 — 96% of the $325,000 ARV we underwrote · held 8 mo vs 9 projected · spent $58k of $60k budget."
- Staff-only. No note-buyer name, no contact data, ever.

### 3.4 Storage

Prefer a **computed read** (a `track-record-performance.js` module + a SQL view joining `track_records` → matched `applications` → `appraisals` → Sitewire rollup), so there is **no new source-of-truth column** and nothing to keep in sync. Only if the Sitewire/appraisal joins prove too heavy for a live page, add a **derived cache** `track_record_performance(track_record_id PK, baseline_source, value_ratio, hold_ratio, budget_ratio, computed_at)` — recomputed on the `publishTrackRecordUpdate` event (the chokepoint every write path already fires), never authored, never material to the verify guard (same treatment db/499 gives `counts_from`/`hold_days`).

---

## 4. Integrity signals — the red-flag set

Each is an **advisory `track_record_finding`, `severity:'info'`** (so `experienceBlockReason` filters it out and it can **never** gate — §2.3), carrying a **machine-readable reason** (see §5.3). Each **never fabricates**: absent graph/data → no finding (or the counterparty's `unknown`, never `unrelated`).

| Finding code | The pattern (industry name) | Computed from | Scope |
|---|---|---|---|
| `rapid_resale_acquisition` | Seller acquired title days before selling to the borrower — the classic flip / inflated-value setup (FinCEN, Fannie, ALTA) | The property's prior transfer date vs `track_records.purchase_date`, read from Elementix `get_address_ownership` / `get_address_transactions`; the seller from `track_records.seller_name` (db/499) | per line |
| `related_party_exit` | The exit "sale" was to the borrower's own people / a straw buyer / a co-occurring entity (non-arm's-length) | **`counterparty.assessCounterparty`** on the exit buyer + the fetched relationship graph (§5) | per line |
| `related_party_concentration` | A handful of buyers absorb most of the borrower's "exits" — the Baltimore pattern | `counterparty.assessPortfolio` across the borrower's exits | per borrower |
| `no_prior_market_ownership` | The borrower has no prior ownership in the market the subject property is in | The borrower's verified track-record counties/metros vs the subject application's county | per file (application-scoped) |
| `capacity_mismatch` | Loan size vs documented capacity — the deal dwarfs anything on their record / their documented liquidity | The requested loan vs (a) the largest verified completed deal on the record, and/or (b) the file's documented liquidity (`bank-liquidity`) | per file |

**Notes on the four the task named:**
- **`rapid_resale`** is deliberately the **acquisition** side (seller had title only days). The **exit** side (the borrower flipped fast) is *not* flagged — the owner said plainly not to care about short hold periods (db/499). Threshold is an owner question (§9); industry uses 90–180 days.
- **`related_party_exit`** is the counterparty control finished (§5). The engine already exists; this is the wiring + one finding.
- **`no_prior_market_ownership`** and **`capacity_mismatch`** are naturally file/application-scoped, not line-scoped — they compare the borrower's *whole record* to *this loan*. They still record as advisory `track_record_findings` (with `application_id` set) so they live in one place, render in the same LineDetail/scorecard, and dismiss durably. `capacity_mismatch` overlaps with the existing liquidity engine and must **read** it, never re-derive it, and must never surface a consumer-report figure (FCRA — §6).

---

## 5. Wiring the counterparty graph into the verify run — done properly

### 5.1 Fetch the graph (new function in `lookups.js`)

Add `researchCounterparty({ borrowerEntity, exitBuyerName, state, priorExits, staffId, db })` beside `researchProperty`, assembling exactly the shape `counterparty.assessCounterparty` documents:

- **Our side** — the borrower entity's principals (`entityPeople`, already fetched by `researchProperty`), its co-occurring entities (`coOccurringEntities`, `:335` — currently unused), its related mailing addresses (`get_entity_related_addresses`, allowlisted `:70`).
- **The buyer's side** — resolve the exit buyer name → entity/person via `searchEntity`/`searchPerson`, then its principals and addresses. **Gated by name-commonness** (`nameTooCommon`, `NAME_COMMONNESS_REFUSE_AT = 85`, `:122`): a too-common buyer name yields `unknown`, never a false "related."
- **`priorExits`** — the borrower's other track-record lines' exit buyers, read from our own `track_records` (no vendor call), feeding the repeat-counterparty and concentration signals.
- **`agentAddresses`** — a config allowlist of registered-agent / accountant offices so a shared-agent address never fires `shared_mailing_address` (the engine already accepts this input).

**Cost discipline (non-negotiable):** this spends Elementix credits (≈2–4 extra calls per line for the buyer lookup + co-occurring). It runs **only on the human-click verify path** (`POST /track-records/:id/research`, `staff.js:11343`) — never a sweep, never a boot pass — exactly as `verify-run.js`'s header already mandates ("Nothing auto-writes, and that is the point"). It goes through the same closed allowlist + ledger + name-commonness gate as every other lookup, and `submit_contact_enrichment` remains unreachable (no skip-tracing — §6).

### 5.2 Assess + persist (in `verify-run.js`)

Inside `runVerify` (`:67`), after `researchProperty`, for a line that has an exit:
1. Call `researchCounterparty`, then `counterparty.assessCounterparty(exit, graph)`; and `assessPortfolio` across the borrower's exits.
2. Feed the verdict into the exit pillar's evidence (the `relatedPartyExit` signal in `checks.signalsFor`, `:765`) so the scoring ladder's C5 related-party cap (`scoring.js:66`, `-30` + needs-review cap) reflects the **graph**, not just the deed flag. This is a pillar/scoring input — still human-confirmed, still not a gate.
3. Raise the advisory `track_record_finding` `related_party_exit` (`severity:'info'`) via `track-record-findings.syncForBorrower`, carrying the machine-readable reason (§5.3). `unknown` raises **nothing** (tri-state: "we didn't look" is not a flag). `related_party_concentration` raised from `assessPortfolio` when concentrated.

The `rapid_resale_acquisition` finding is computed in the same pass from the ownership history `researchProperty` already fetches (`addressOwnership`, `:356`) vs `track_records.purchase_date` — no extra vendor call.

### 5.3 The machine-readable reason (small additive schema)

`counterparty.assessCounterparty` returns `{ verdict, code, score, signals[], why }`. `track_record_findings` today carries only human `title`/`detail`. Add two **additive, nullable** columns (new numbered idempotent migration):

```
ALTER TABLE track_record_findings
  ADD COLUMN IF NOT EXISTS reason_code text,     -- e.g. 'related_party_exit'
  ADD COLUMN IF NOT EXISTS evidence jsonb;        -- { score, signals:[{key,weight,why,evidence}], verdict }
```

So a future note-buyer program that credits or refuses certain patterns can **select on the reason** (the same forward-looking rationale db/499 gives `seller_name`), and the LineDetail can render the weighted signals. `FINDINGS` in `track-record-findings.js:51` gains the new codes with `severity:'info'` and their `actions` (`['dismiss', ...]`); the detector consults the `decided` set exactly as today, so a dismissed integrity flag stays dismissed.

---

## 6. How each stays advisory (the guarantees)

- **Records a finding, never blocks.** Integrity findings are `severity:'info'`; `experienceBlockReason` (`track-record-findings.js:331`) filters `info` out **before** it can hold the experience sign-off. They do not enter `advancementBlockers`, `signOffGate`, or any issuance gate. Performance metrics raise no finding at all — they are display-only derived numbers.
- **Dismissable + durable.** Every integrity finding closes through the audited `resolveFinding` (`:346`) and is suppressed forever via the `decided` set / `dedupe_key` (`:191`) — the track-record analog of `finding_decisions` (db/333). A reviewer's "these are two unrelated companies with the same name" sticks.
- **Fail-open, never fabricates.** The counterparty verdict defaults to `unknown` (an empty graph is never `unrelated`); a too-common name refuses; a line with no baseline gets no performance score; the finding sync is best-effort and returns a shape rather than throwing (`syncForBorrower`, `:180`).
- **The appraisal-enforcement carve-out does NOT apply here.** That exception is `advisory-policy.appraisalReviewEnforced()` over `appraisal_findings` / `appraisal_review_cleared` only. This proposal touches neither. There is no path by which a performance or integrity signal enforces anything.
- **Kill-switchable** the same way as the rest of the AI stack (`AI_FINDINGS_ENFORCE` stays off; a dedicated env flag can disable the counterparty fetch without a deploy).

---

## 7. Reusable vs new · effort · risk

**Reused (no change, or read-only):** `counterparty.js` (built + tested), chain-of-title primitives `sameParty`/`partyInList`/`isEntityName` (`chain-of-title.js:26`), `ADDR.sameAddress`, `track_record_findings` + `syncForBorrower`/`resolveFinding` + the `info`-never-gates filter, `verify-run.js` + `checks.js` pillars/`signalsFor`, `elementix/lookups.js` (+ its `coOccurringEntities`/related-addresses wrappers), `appraisals`, the `db/409`/`db/410` warehouse + `valuation.js`, `sitewire/rollup.js` + `monitor.js`, `experience.EXIT_DATE_SQL` + db/499 `counts_from`/`hold_days`/`seller_name`, `bank-liquidity` (for capacity).

**New:**
1. `lookups.researchCounterparty` — assemble the graph (≈2–4 Elementix calls/line, credit-metered).
2. `verify-run.js` — call `assessCounterparty`/`assessPortfolio`, feed the pillar, raise the finding.
3. `track-record-findings.js` — 4–5 new `info` codes (`rapid_resale_acquisition`, `related_party_exit`, `related_party_concentration`, `no_prior_market_ownership`, `capacity_mismatch`) + detectors.
4. `track-record-performance.js` — the baseline-resolver (line → application via `sameAddress`; appraisal/warehouse ARV; Sitewire actual) + the three ratios + the roll-up. A view; a small `track_record_performance` derived cache only if needed.
5. Additive columns `track_record_findings.reason_code` + `evidence jsonb` (one idempotent migration).
6. Surfaces: a scorecard tile (Stream C `ExperienceHeader`) + a LineDetail block (workspace route).

**Effort / risk:**
- **Counterparty wiring — MEDIUM effort, MEDIUM risk.** The engine is done and tested; the work is the graph fetch (Elementix response shapes, credit spend) + persistence. Risks: credit cost (mitigated: human-click only, metered, no sweep) and name-ambiguity false positives (mitigated: name-commonness gate + tri-state `unknown` + human-decides + dismissable). Advisory-only means low blast radius.
- **Performance — MEDIUM effort, LOW risk.** Mostly read-side joins. The fiddly part is the line↔application match by address (mitigate with `sameAddress` + borrower scope + a confidence flag; a mislink only mislabels an advisory number, never changes a loan). Sitewire actuals only exist for managed files — handled by falling back to `rehab_amount` (weak) or omitting on-budget.
- **New columns / finding codes — LOW effort, LOW risk** (additive, nullable, idempotent).

---

## 8. NON-NEGOTIABLES (to restate in the build)

1. **Advisory only — never blocks.** No performance or integrity signal may enter a sign-off, CTC, funding, or issuance gate. Integrity findings are `severity:'info'`; performance raises no finding. The appraisal-enforcement carve-out does **not** apply here.
2. **Never fabricates.** No underwritten ARV / budget / term → no performance score. No relationship graph → counterparty verdict `unknown` (not `unrelated`). A too-common name → `unknown`. Missing data is silence, never a guess.
3. **No contact data in an underwriting decision (FCRA).** The integrity signals use **public-record graph only** (deeds, entities, principals, mailing addresses, co-occurring entities). Never a skip-traced phone/email (`submit_contact_enrichment` stays unreachable; `contactFor` gates on already-unlocked), and never the borrower's consumer/credit report — that keeps the signals clear of FCRA's consumer-report provisions and the owner's no-skip-trace cost rule.
4. **Note-buyer / PII rules.** Every performance and integrity surface is **staff-only**; a note-buyer name never appears on a borrower-facing surface; the finding text carries no PII beyond names already on the deed record.
5. **The counterparty graph informs — a human decides.** A related-party or rapid-resale flag *tempers confidence* and prompts a look; it does not remove a deal from the experience count on its own, and it is always dismissable. The tier still counts verified lines; the human makes the call.

---

## 9. Industry research (cited)

The red-flag set and the ARV-accuracy framing map directly onto published lender/title guidance:

- **Seller acquired title recently / rapid re-sale is the #1 flip indicator.** FinCEN's mortgage-fraud materials call out "a seller very recently acquiring title, or acquiring title concurrent with the subject transaction," properties recently in foreclosure/REO re-sold quickly at rising prices with no documented renovation, and fraudulently inflated appraisals (appraisers "frequently using other flips as comparables"). Lenders examine ownership changes within **90–180 days** before closing. → validates `rapid_resale_acquisition` and the 90–180-day threshold question.
- **Straw-buyer / non-arm's-length indicators.** Fannie Mae's fraud guidance lists "seller owned property for short time," "chain of title includes an interested party (realtor/appraiser)," "buyer and seller have similar names (concealed non-arm's length)," and a glaring income-vs-price discrepancy (a straw-buyer / inflated-income tell). → validates `related_party_exit` and `capacity_mismatch`.
- **Related-party / servicing red-flags (private lending).** Note Servicing Center's private-lender guides flag "a sale to a related party," "buyers and sellers sharing similar names," deals at a quick pace with no agent, and payments from an account not in the borrower's name. → validates the counterparty control's design and its "a hit means a human looks, not fraud" posture.
- **Title / chain-of-title (ALTA).** ALTA's real-estate-fraud work highlights transactions "that made little sense" — homes sold far below market and **rapid re-sales between shell companies** — and how a recorded deed becomes part of the chain of title regardless. → validates the concentration/shell-entity signal and reusing chain-of-title primitives.
- **ARV accuracy is the single most consequential number, and "did it hit?" is the real test.** Industry guidance: for flips "ARV is the actual sale price," lender ARV runs 3–5% more conservative than investor ARV, a **15% ARV error** can leave first-position security short at foreclosure, and leverage is tiered on borrower experience (seasoned flippers ~75% ARV vs novices 65–70%). Comps should be recent (3–6 months) closed sales, not listings. → validates comparing **actual sale ÷ underwritten ARV** as the core performance metric, the flip-vs-hold distinction, and using the `db/409` warehouse (closed comps, `last_sale_type = ArmsLengthSale`) as the fallback baseline.

Sources:
- [FinCEN — Mortgage Loan Fraud](https://www.fincen.gov/mortgage-loan-fraud) · [FinCEN — Money Laundering in the Residential Real Estate Industry (SAR review, PDF)](https://www.fincen.gov/system/files/shared/MLR_Real_Estate_Industry_SAR_web.pdf)
- [Fannie Mae — Mortgage Fraud Prevention](https://singlefamily.fanniemae.com/mortgage-fraud-prevention) · [Fannie Mae Selling Guide A3-4-03 — Preventing, Detecting, and Reporting Mortgage Fraud](https://selling-guide.fanniemae.com/sel/a3-4-03/preventing-detecting-and-reporting-mortgage-fraud) · [MGIC — Detecting Mortgage Fraud (PDF)](https://www.mgic.com/-/media/mgic/seminar-materials/detecting-mortgage-fraud_presentation.pdf) · [Certified Credit — 70 Signs of Mortgage Fraud](https://www.certifiedcredit.com/70-signs-of-mortgage-fraud/)
- [Note Servicing Center — Unmasking Straw Buyers: A Private Lender's Guide](https://noteservicingcenter.com/unmasking-straw-buyers-a-private-lenders-guide-to-fraud-prevention/) · [Note Servicing Center — Straw Buyer Fraud: Protection for Private Mortgage Portfolios](https://noteservicingcenter.com/straw-buyer-fraud-essential-protection-for-private-mortgage-portfolios/)
- [ALTA — Real Estate-related Fraud](https://www.alta.org/advocacy/advocacy-issues/real-estate-related-fraud) · [ALTA — Mortgage Fraud Prevention](https://www.alta.org/business-operations/operations/mortgage-fraud-prevention)
- [RCN Capital — ARV Loans Explained](https://rcncapital.com/blog/arv-loans-explained-fix-and-flip-financing-based-on-after-repair-value) · [LBC Capital — ARV: The Most Important Number in Fix-and-Flip Lending](https://lbccapital.com/after-repair-value-arv-the-most-important-number-in-fix-and-flip-lending/) · [LYNK Mortgage — AIV and ARV Explained](https://www.lynkmortgage.com/blog/aiv-and-arv-in-real-estate-lending)

---

## Open questions for the owner

1. **Does a fraud flag ever touch the count, or is it purely a note?** The existing track-record findings that *corrupt* the count (a duplicated deal, the subject property listed as done) **do** hold the experience sign-off. The new integrity flags are softer — a related-party exit or rapid re-sale is a "look at this," not proof. Proposal: keep them purely advisory (`info`, never a gate). Confirm that's what you want, or should a *confirmed* related-party exit drop that one line out of the tier until reviewed?
2. **How fresh is "rapid re-sale"?** When a seller sold to your borrower within how many days of buying it themselves do we raise the flag — 90, 120, or 180 days? (Industry uses 90–180.)
3. **What counts as a deal that "hit"?** For the performance roll-up, is a sale within, say, 95% of the underwritten ARV a "hit"? And should a deal that came in *well under* ARV temper the borrower's confidence score, or just be shown without judgment?
4. **Elementix credit budget.** Finishing the fraud graph adds roughly 2–4 record lookups per property, on the button-click verify only (never a background sweep). Fine to spend that on the human-click path? Any cap per borrower?
5. **"No prior ownership in the market" — how wide is a market?** The county the property is in, or the broader metro? And should this be a real flag, or just context on the scorecard?
6. **"Loan size vs capacity" — capacity meaning what?** Their documented cash/liquidity, the largest completed deal on their record, or both together?
7. **Performance for holds, not just flips.** A flip has a sale price to compare to ARV; a hold does not (it refinances). Do we compare a hold's refinance/appraised value to the underwritten ARV in v1, or start with flips only and add holds later?
