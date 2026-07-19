# Encompass ↔ Portal Data Mapping — Entities, Fields & Match Keys

_Research pass, 2026-07-17. **Status: research only — nothing implemented.** Read-only doctrine throughout: the integration must be architecturally incapable of writing to Encompass. No credentials, no borrower PII, and no live Encompass calls appear in this document. Repo referenced read-only at `yscap-repo-root_8/`; Encompass references are to the Developer Connect 26.2 collection and official ICE documentation for instance BE11397907._

_Revision note (2026-07-19): post-critique consistency pass applied (decisions D1–D17)._

This is the mapping reference for the planned read-only Encompass integration: which portal tables line up with which Encompass entities and field IDs, how a portal loan file gets matched to an Encompass loan, how conditions/milestones/documents correspond, and — just as deliberately — what we will **not** pull. Companion research (lifecycle design, conditions engine, document pipeline, borrower identity) is summarized here; open questions are consolidated at the end.

---

## 0. Plain-language summary (read this first)

**What this is about.** Encompass is the loan origination system (LOS) where the lending team actually opens, underwrites, and funds loans. The borrower portal (PILOT) is our own system where borrowers upload documents and staff track conditions. Today the two never talk — the portal only knows what Encompass says because a human re-types it into ClickUp. This research maps out how the portal can **read** from Encompass automatically, so the portal can verify things instead of trusting hand-typed labels.

**The three big ideas:**

1. **Match each portal file to exactly one Encompass loan** — like matching two filing cabinets by loan number first, then double-checking with the property address and the borrower's identity. Once matched, we store Encompass's permanent ID for that loan so we never have to guess again.
2. **Verify, don't copy blindly.** The portal already has checklist items that literally say "check this in Encompass" — a person does it by hand today. With the mapping in this document, the portal can check automatically: loan amount matches, conditions cleared, clear-to-close actually issued in Encompass before the portal says clear-to-close.
3. **Never write, never merge, never guess.** The integration only reads. Anything uncertain — a borrower who *might* be the same person, a condition that *might* match — goes to a human review queue, exactly the way the ClickUp sync already works after hard lessons (the family-email merge incident, the DOB corruption incident).

**What we deliberately leave out:** Social Security numbers and dates of birth — at launch we do not pull them from Encompass at all; matching works from the loan number, the property address, and names (Decision D3). Also out: wire instructions, capital-partner names on borrower-facing surfaces, and document *bytes* by default (we index eFolder documents' metadata first; bytes download only when staff actually needs a file).

---

## 1. The portal's data model in one page

The portal DB (`db/schema.sql` + 126 numbered migration files, idempotent and auto-applied on boot — 127 SQL files in `db/` including `schema.sql`) is **borrower-centric**: the person is the base entity, and each mortgage is a new `applications` row hanging off them. Schema header rules at `db/schema.sql:6-12`; notably `db/schema.sql:4` says the DB "syncs bidirectionally to ClickUp (now) and **Encompass (later)** via sync_*" — this integration was anticipated from day one.

| Domain | Tables | What it holds |
|---|---|---|
| People | `borrowers`, `borrower_auth`, `borrower_contacts`, `partners` | PII (names, DOB, encrypted SSN + `ssn_last4` + keyed `ssn_hash`, FICO, addresses jsonb); login split from PII; every email/phone ever seen |
| Entities | `llcs`, `llc_members`, `llc_borrowers` | Borrower-owned vesting entities: name, EIN, formation state/date, ownership %, recursive layered entities (depth 5, cycle-checked) |
| Experience | `track_records` | Per-borrower past deals (entry = purchase; exit = sale or rent/refi), frozen 36-month exit window; verified lines drive `borrowers.tier` and pricing |
| Loan files | `applications` (+ `application_assignees`, `application_status_history`, `product_registrations`) | Natural keys `ys_loan_number` (partial-unique on live rows, `db/048`) and `investor_loan_number`; full economics snapshot (purchase price, as-is/ARV, rehab budget, loan amount, LTV, DSCR, rate, term, appraisal values, taxes/insurance/HOA, liens); 11-value status lifecycle `file_intake→…→funded` |
| Conditions | `checklist_templates`/`checklist_items` (primary), `conditions` (secondary first-class) | Statuses outstanding→satisfied, sign-off/review/waive stamps, rule engine (`db/037`); severity model `standard→post_closing` on first-class rows |
| Documents | `documents` + `src/lib/storage.js` | One table for every surface; review lifecycle (`db/013`); visibility model (`db/014`); SharePoint one-way mirror |
| Sync infra | `sync_queue`, `clickup_task_index`, `sync_review_queue`, `address_canon_cache` | The reusable machinery: outbox queue, per-external-record match index, two-sided human review of suspicious changes |

Three facts that shape everything below:

1. **`sync_queue.target` already admits `'encompass'` with both `push` AND `pull` directions** (`db/schema.sql:306-307`). Phase 1 must be pull-only; the recommendation (per the repo's belt-and-suspenders trigger convention, cf. `db/069`/`071`/`072`) is a new migration adding a DB CHECK/trigger that rejects `target='encompass' AND direction='push'` rows — in addition to shipping no push code at all.
2. **`applications.encompass_status` exists today but is not from Encompass** (`db/047:25`): it mirrors a manually-set ClickUp dropdown (`src/clickup/mapper.js:122`, field defined in `src/clickup/fields.js:74`) and is hidden from borrowers. The real integration supersedes it: the hand-typed column is retired or re-labeled at Stage 4 of the Master roadmap, once its auto-verified equivalent is live (Decision D16, 2026-07-19).
3. **Encompass-named manual conditions already exist** (`db/005:74-84`, relabeled `db/056`): `rtl_p2_enc` "Encompass loan opened as Fix & Flip — loan amount & structure match the file", `rtl_p2_loprep`, `rtl_p3_credit2` (scores entered in Encompass), `rtl_p3_liq` (liquidity vs the "Encompass F&F sheet"). These human attestations are precisely the Phase-1 auto-verification surface — and the five manual "check in Encompass" tasks (`db/005_rtl_workflow.sql:74-84`) are superseded at Stage 4 of the Master roadmap, which retires or re-labels them once their auto-verified equivalents are live (Decision D16, 2026-07-19).

---

## 2. Loan matching — join keys, ranked

The repo already solved this class of problem for ClickUp: `src/clickup/identity.js:14-17` defines 8 identity fields (address, loanNumber, borrowerName, dob, email, ssn, phone, purchasePrice) with the rule **≥2 must agree** before two records are called the same loan/person. Reuse that module wholesale (the ssn/dob signals simply have no Encompass-side input while Tier 3 is disabled).

**Launch posture (Decision D3, 2026-07-19): matching launches WITHOUT SSN/DOB.** Tier 3 (SSN/DOB pull) is disabled by default per Guardrails §5.1, so the primary ladder for launch is non-SSN: (1) `ys_loan_number` ↔ Encompass Loan Number, (2) canonical property address + borrower/entity last name, (3) borrower full name + entity name + amount/date corroboration. `ssn_hash` is demoted to a *future* stronger key that exists only if the owner ever enables Tier 3. Auto-attach thresholds are conservative; anything ambiguous goes to human review, never auto-links.

| Rank | Key | Strength | Caveats |
|---|---|---|---|
| 0 | **`encompass_loan_index.application_id` (the crosswalk row — the durable binding)** | Definitive once set | Binding lives ONLY in the crosswalk table (§2.1); **no new column on `applications` in Phases 1–2** (Decision D4). Analogous in role to `clickup_task_index`. After first successful match, all other keys become verification-only. |
| 1 | **`ys_loan_number` = Encompass Loan Number (field 364 / `Loan.LoanNumber`)** | Strongest natural key — the launch primary | Compare `lower(btrim())`; skip placeholders (`isPlaceholderLoanNumber`, `src/clickup/mapper.js:328`). Nullable on early files; today sourced from ClickUp free text; a soft-deleted file may share a live number. **Open question whether the two number systems are actually identical** (§8 Q3). Lesson from ClickUp (CLAUDE.md rule 5b): a *copied* loan number on a duplicated record is a stale artifact, never an identity claim — handle the same way here. |
| 2 | **Canonical property address + borrower/entity last name** | Strong in practice — the launch workhorse after loan number | `normAddress()` in `identity.js` plus the Google-geocode `address_canon_cache` (`db/124`). Street-suffix variance makes it fuzzy; house-number equality required (the SharePoint matcher's rule); the last-name leg guards against resold/refinanced properties. |
| 3 | **Borrower full name + entity name + amount/date corroboration (multi-field composite, ≥2-of-8 discipline)** | Launch fallback | Name+purchase price, name+entity+funding date, etc. Sub-threshold matches route to a human queue, never auto-link. |
| 4 | **`borrowers.ssn_hash`** (HMAC-SHA256 of SSN keyed by `SSN_MATCH_KEY`, `db/044`) — **FUTURE key: available only if Tier 3 is ever enabled (launches disabled, Decision D3)** | Deterministic borrower-level join, if enabled | If ever enabled: hash the SSN read from Encompass (`taxIdentificationIdentifier`) with the same key, match, **discard the plaintext**. Identifies the person, not the loan — combine with a per-loan key. |
| 5 | `investor_loan_number` | Secondary | Only if the instance carries it consistently. |
| — | **Rejected as sole keys** | — | Email alone (shared spouse emails — see `borrower_profile_links`, `db/114`), phone alone, name alone, `encompass_status` (a label), ClickUp task id (meaningless to Encompass). |

### 2.1 The crosswalk state model — THE canonical Phase-1 schema (Decision D4, 2026-07-19)

**This section is the canonical schema appendix for the entire doc set: every sibling document references these four tables and this state model rather than defining its own.** All are new numbered idempotent migrations:

- **`encompass_loan_index`** — clone of the proven `clickup_task_index` pattern (`db/044:39-51`): one row per Encompass loan GUID ever seen, carrying `match_state`, the matched `application_id` (nullable — **this column is the ONLY portal↔Encompass binding; no new column on `applications` in Phases 1–2**; a convenience column on `applications` is at most a later denormalization), the evidence fields that agreed, and a metadata snapshot/hash for change detection.
- **`encompass_snapshots`** — append-only raw (allowlist-redacted) JSONB snapshot per loan per fetch; diffable, replayable, prunable.
- **`encompass_pull_log`** — the READ journal: one row per outbound Encompass API call (endpoint, verb, loan, status, duration, bytes), including failures and guard-blocked attempts. The earlier `encompass_request_log` working name is **retired** — `encompass_pull_log` everywhere.
- **`encompass_gate_log`** — one row per gate evaluation: rule, application, decision, snapshot id + age, evidence summary, override info.

Optional typed projections of snapshots (e.g. `encompass_conditions`, `encompass_milestones` convenience mirrors) are Phase-1 implementation detail — never separate sources of truth.

`match_state` ENUM — seven states:

| State | Meaning (one line) |
|---|---|
| `unmatched` | Seen in a pipeline sweep; no candidate portal file yet — retried on each sync pass |
| `auto_matched` | The conservative launch ladder (§2) cleared the auto-attach threshold; `application_id` set; verification continues on every pull |
| `manual_confirmed` | A human explicitly confirmed the link (from review or a staff action) — the strongest state |
| `ambiguous` | Multiple or conflicting candidates (e.g. loan number points one way, address another); a human review row exists (`sync_review_queue` pattern) with explicit link/reject options; never auto-linked |
| `conflict` | A previously matched link is disputed by later data (e.g. address or name diverged); gates treat it as unlinked until a human re-confirms |
| `data_only` | Enrichment-only loan (e.g. historical/closed) with no active portal file to bind; never gates anything |
| `ignored` | Deliberately excluded (test loans, dead files, other business lines); sticky — a reviewer's dismiss must not respawn (the `suppressIfRejected` discipline) |

**Gate precondition, everywhere:** match state ∈ {`auto_matched`, `manual_confirmed`} — every other state fails gates closed.

Loan discovery runs through `POST /encompass/v3/loanPipeline` (a read-semantics POST) filtered on loan number / borrower identity fields, including archived loans for history. Every stuck state surfaces as a review row **with options**, per the portal's established "no silent failure" doctrine (`src/lib/sync-file-review.js`).

---

## 3. Field-by-field mapping tables

Conventions: **V3 entity path** = the JSON path in `GET /encompass/v3/loans/{loanId}?view=entity&entities=…`; **field ID** = classic field readable via `POST …/fieldReader` (read-only despite the verb). Field IDs marked ✔ were verified against the Postman collection and/or official references; unmarked mappings are structurally known but the exact ID/path must be confirmed against the instance's schema snapshot (`GET /v3/schemas/loan/standardFields`, `…/virtualFields`, `/v3/settings/loan/customFields`) before build. **Encompass's standard schema is consumer-mortgage-centric: YS concepts (ARV, rehab budget, DSCR, flip experience, the F&F liquidity sheet) are very likely CX.\* custom fields on BE11397907 — enumerating them is a day-1 task, not something to guess** (§8 Q4).

### 3.1 Loan snapshot (portal `applications` ↔ Encompass loan)

| Portal field (location) | Encompass source | Notes |
|---|---|---|
| `ys_loan_number` (schema.sql:164) | Field **364** ✔ / `Loan.LoanNumber` (pipeline) | Primary natural join key (§2) |
| `loan_amount` (schema.sql:187) | Field **1109** ✔ | Machine-checks `rtl_p2_enc` "amount & structure match" |
| `ltv` (schema.sql:188) | Field **353** ✔ | Encompass computes vs lesser of purchase price (136) / appraised value (356) |
| `purchase_price` | Field 136 (cited in the 353 definition) | Verify on instance |
| `actual_appraised_value` (db/041) | Field 356 (cited in the 353 definition) | Verify on instance |
| `rate_pct`, `term`, `loan_type`, `program` | Loan entity / fieldReader; program likely CX.* | IDs unverified — resolve from schema snapshot |
| `arv`, `rehab_budget`, `dscr_ratio`, assignment trio, interest reserve | **Likely CX.\* custom fields — unknown until enumerated** | `GET /v3/settings/loan/customFields` first thing |
| `property_address` jsonb, `property_type`, `units` | V3 `property` entity | Canonicalize via `address_canon_cache` before comparing |
| `submitted_at` | Field **3142** ✔ (application date) | Drives the disclosure clock in consumer land; here a date anchor |
| (file created) | Field **2025** ✔ (file started date) | |
| `status` / `internal_status` | Milestones — see §3.5 | Never a single field; config-driven map |
| `expected_closing` / `actual_closing` | `funding` entity: 1994 ✔ close, 1996 ✔ ordered, 1997 ✔ sent, 1999 ✔ released; core `milestoneFundedDate` | Funding = 1999 set OR core Funded date set |
| `product_registrations.note_rate` / `total_loan` | Loan amount/rate fields (above) | The registered terms Encompass's structure must match |
| `investor_loan_number` | `registrationlogs` `referenceNumber` (staff-only) or instance field | Verify; investor names never reach borrowers |

One `fieldReader` POST per loan per poll can carry the whole status snapshot (364, 1109, 353, 2025, 3142, `CoreMilestone`, `Log.MS.*`, `LOCKRATE.*`, `UWC.*`/`PRECON.*`/`PCC.*` counts) — flat, tiny, pre-computed.

### 3.2 Borrower profile (portal `borrowers` ↔ Encompass borrower pairs)

Encompass calls borrower pairs "applications" *within* a loan; the pair list is still V1 (`GET /v1/loans/{id}/applications`), with V3 sub-collections per applicant. Classic fields address pairs with a `#N` suffix (`4000#2` = pair 2) — V3 fieldReader support for `#N` needs sandbox verification (§8 Q6).

| Portal field | Encompass source | Notes |
|---|---|---|
| `first_name` / middle / `last_name` | `applications[].borrower.firstName/…` · fields **4000/4001/4002** ✔ | Co-borrower = `coborrower` object → portal's second `borrowers` row via `applications.co_borrower_id` |
| `date_of_birth` | `borrower.birthDate` | **Not pulled at launch (Tier 3 disabled, Decision D3).** If ever enabled: in-memory compare + a `dob_match` boolean only; DOB changes are ALWAYS human decisions per the ClickUp incident rules — same doctrine here |
| SSN | `borrower.taxIdentificationIdentifier` | **Not pulled at launch (Tier 3 disabled, Decision D3).** If ever enabled: hash-and-discard into `ssn_hash`; plaintext never stored, never logged |
| `email` / `borrower_contacts` | `emailAddressText` | New addresses append to `borrower_contacts`, never overwrite primary |
| `cell_phone` | `homePhoneNumber` (+ others per schema) | Same append posture |
| `fico` | `middleCreditScore` / `minFicoScore`; virtual `FICO` | Machine-checks `rtl_p3_credit2` |
| `current_address` / `prior_address` | `…/borrower/residences` sub-GET | |
| `employer`, `employment_type` | `…/borrower/employment` | |
| `marital_status`, `citizenship` | `maritalStatusType`, `citizenshipResidencyType` | Normalize through the existing field-registry normalizers |

### 3.3 Entity / vesting

| Portal | Encompass source | Notes |
|---|---|---|
| `llcs.llc_name` + `applications.llc_id` (vesting) | `GET /v3/loans/{id}/closingDocument/vestingEntities` (alias, vestingType, application linkage) | Feed names through `findOrCreateLlc` (`src/lib/llc.js:511`) — normalized reuse, never duplicates; new entities land unverified with `origin='encompass'` |
| `llc_members` / `llc_borrowers` | `borrowerType` ("Entity"), non-borrowing owners, guarantor data | Entity-vested loans are the risky case — see §4.2 |
| Loan team (`loan_officer_id` etc.) | `GET /v1/loans/{id}/associates`, milestone `loanAssociate`, `milestoneFreeRoles` | Cross-check only; display-side |

### 3.4 Conditions (contract detail in §5)

| Portal | Encompass source |
|---|---|
| `checklist_items` (primary engine) / `conditions` (first-class) | Branch on **`ENHANCEDCOND.X1`** / `useEnhancedConditionIndicator`: V3 enhanced (`GET /v3/loans/{id}/conditions`) **or** V1 standard (`GET /v1/loans/{id}/conditions/underwriting|preliminary|postclosing`) — mutually exclusive per loan |
| `conditions.severity` (`standard/prior_to_docs/prior_to_funding/post_closing`) | `priorTo` (Approval/Docs/Funding/Closing/Purchase) — near-1:1 vocabulary |
| `post_closing_items` (`db/023`) | Post-closing condition type/set |
| Cheap roll-up cross-checks | Virtual counts: `UWC.*` (20 fields), `PRECON.*` (19), `PCC.ALL`/`PCC.NOTCLEARED` (string blobs — corroboration only, format unverified) |

### 3.5 Milestones / lifecycle

Encompass ships 13 default milestones but **every instance renames/adds/archives its own** — BE11397907's real list must be discovered via `GET /v3/settings/milestones?includeArchived=True&view=Detail` and mapped by an admin, exactly like the ClickUp `EXTERNAL_FOR` map in `src/clickup/status.js`. Encompass also normalizes any custom list into 7 core buckets (Started / Sent to processing / Submitted / Approved / Doc signed / Funded / Completed) with per-bucket dates. **"Clear to Close" is NOT a core bucket** — CTC detection must be config-driven, never hardcoded.

| Portal | Encompass source | Notes |
|---|---|---|
| `status` (11 buckets) | Admin-curated `encompass_milestone_map`: milestone setting id/name → portal bucket, with `is_ctc_signal`/`is_funded_signal` flags | Suggested defaults may prefill; only humans approve. Unmapped milestone ⇒ review row + **fail closed** |
| `internal_status` twin | Store raw `Log.MS.CurrentMilestone` / `Log.MS.LastCompleted` / `Log.MS.Stage` verbatim + `CoreMilestone` | Same two-layer pattern as ClickUp |
| Timeline dates | Per-loan `GET /v3/loans/{id}/milestones` (`name`, `startDate`, `doneIndicator`, `reviewedIndicator`, `loanAssociate`) + core-milestone date pairs | **Milestones can be UN-finished** — every sync is snapshot-replace with a history append, never append-only |
| Fleet sweep | Pipeline canonical `Loan.CurrentMilestoneName` | One POST sweeps the whole pipeline's position |

### 3.6 Rate locks & funding

The portal has **no rate-lock object** — "locking" is product registration (append-only `product_registrations`, frozen engines, reopen-on-economics-change triggers). Encompass's lock read model (V1 `ratelockrequests` list/detail/snapshot; loan-level `rateLock.rateStatus` enum notLocked/locked/expired/cancelled; the 17 `LOCKRATE.*` virtual fields) maps to a **new staff-facing panel, not an existing portal field**. Whether BE11397907 uses locks at all is an open question (§8 Q5) — feature-flag the panel rather than showing "Not Locked" everywhere. If used: trust `lockExpirationDate` verbatim (extensions change it; never recompute), and alert locally off pulled data. Funding lifecycle dates map per §3.1; wire-detail fields are deliberately excluded (§7).

---

## 4. Borrower enrichment & the auto-built track record

Encompass history is **first-party, lender-verified data** — materially stronger than the ClickUp backfill that already auto-derives unverified track-record lines (`docs/BORROWER-HISTORY-BACKFILL.md`, `src/clickup/ingest.js:476-520`). The design mirrors that proven pipeline rather than inventing a new one.

**Flow (all portal-side writes; zero Encompass writes):**

1. Enumerate funded/closed loans per borrower via `loanPipeline` (+ archived), matching borrowers **without SSN/DOB at launch (Tier 3 disabled, Decision D3)** via the §2 ladder: loan number, then canonical address + last name, then name + entity + amount/date corroboration. **Attach-only in Phase 1**: a strong multi-signal match attaches (an `ssn_hash` key becomes available only if Tier 3 is ever enabled); email match requires corroboration (`emailMatchCorroborated`); weak/none creates nothing (unlike ClickUp, no shadow-profile minting to start). Near-misses queue `borrower_dedup_candidates` (`db/081`) with a new reason code; anything ambiguous goes to review, never auto-attaches.
2. Upsert `track_records` lines per funded loan: `is_verified=false`, new `origin='encompass'`, `inferred` where guessed, `address_key` from the subject property, and a **new `encompass_loan_guid` provenance column** with a partial unique index (mirroring `uq_track_records_source_task`) so re-syncs are idempotent.
3. **Exit semantics — the key subtlety:** the experience engine counts *exits* (sale/lease/refi within the frozen 36-month window, `src/lib/experience.js:13-18`), but an Encompass origination proves an *entry*. What Encompass does prove: a refinance loan on the same address = the exit of a prior hold (sets `refi_date`/`refi_amount`); a paid-off loan is only a *proxy* for a flip's exit — pre-fill as a suggestion, keep `inferred=true` until a human confirms.
4. Deal-type inference from Encompass program/purpose fields maps to the `bucketOf` buckets far more reliably than ClickUp labels.
5. Vesting-entity names feed the LLC library through `findOrCreateLlc` — unverified, provenance-stamped.
6. **Verification stays human.** Never auto-set `is_verified=true`: verified lines drive `borrowers.tier`, experience conditions, and pricing staleness — a bad machine match would flow straight into loan sizing. Keep the processor-only sign-off and exit-date gates; at most offer a one-click "confirm from Encompass" staff action carrying the loan GUID as evidence.

### 4.2 Dedup / false-match risks (ranked)

| # | Risk | Mitigation |
|---|---|---|
| 1 | Same name, different person | Name alone is never sufficient (codified after the 2026-07-15 family-email/surname PII-leak incident, `identity.js:100-141`). Name-only pipeline hits feed a review queue, never auto-attach |
| 2 | Same person, weak identity signals (no SSN key at launch — Tier 3 disabled, Decision D3; and typos or ITIN/EIN in the SSN field on business-purpose files would degrade even a future Tier-3 key) | The multi-signal ladder + email corroboration; a 3-field near-match → `borrower_dedup_candidates` |
| 3 | Entity-vested loans (borrower = the LLC; person = guarantor) | Match via entity name + guarantor name/address (guarantor SSN only if Tier 3 is ever enabled); route co-owned LLCs through `llc_borrowers` — never silently credit only the primary owner |
| 4 | Double-counting one deal from ClickUp AND Encompass | Only cross-source key is `address_key`, whose naive normalization treats "St" vs "Street" as different. Canonicalize both sides via `address_canon_cache` place_id; extend the dedup probe to `(source_task_id OR encompass_loan_guid OR address_key)` |
| 5 | Co-borrower double-count (one loan, two borrowers, two lines) | Breaks the engine's "summing per-borrower counts never double-counts" invariant (`experience.js:62-64`). Policy needed up front (§8 Q9) |
| 6 | Shared family emails | `borrower_profile_links` pairs suppress dedup cards, as ClickUp ingest already does |
| 7 | Stale/withdrawn loans becoming fake experience | Filter to genuinely funded milestones/archived-funded only |
| 8 | Tier-inflation blast radius | Unverified-by-default + human verify is the containment; never weaken it |

---

## 5. Conditions: the agreement gate

### 5.1 The portal side in brief

Two stores feed clear-to-close: `checklist_items` (the workhorse: statuses outstanding/requested/received/satisfied/issue, separate sign-off/review/waive stamps, admin-authored rule engine per `db/037`) and first-class `conditions` (`db/022`: open/borrower_responded/cleared/waived, severity standard→post_closing). The critical chokepoints, all reusable:

- **`signOffGate`** (`src/routes/staff.js:2400`) — 422-blocks sign-off until reality agrees (zero-doc, slot, product, budget-to-the-cent, verified-experience branches). The Encompass agreement check becomes one more branch here.
- **DB trigger belt-and-suspenders** (`db/069` pattern) — SQL-layer refusal independent of app code.
- **Auto-reopen triggers** (`db/071→096` family) — any economics change reopens cleared conditions centrally. Encompass *drift* (a condition reopened in the LOS after portal sign-off) should behave exactly like an economics change: reopen, clear stamps, `[auto]` note, audit row.
- **Two-tier review vs clear** (`db/083`) — an LO's "reviewed" stamp never completes; clearing needs `sign_off_conditions`. This mirrors the Encompass gate's shape: human review vs authoritative completion.

### 5.2 The Encompass side in brief

Encompass has **two mutually exclusive condition systems per loan**, discriminated by `ENHANCEDCOND.X1` / `useEnhancedConditionIndicator` — the sync must branch, or it silently misses conditions on the other kind of loan:

- **V1 "standard"**: fixed status enum (Added, Expected, Requested, Received, Rerequested, Fulfilled, Reviewed, Sent, **Cleared, Waived**, Expired, Rejected); three endpoint families (underwriting/preliminary/postclosing). Only `Cleared`/`Waived` are "done" — `Fulfilled`/`Reviewed`/`Received` are NOT sufficient. No lastModified: hash-diff for change detection.
- **V3 "enhanced"**: tenant-configurable types/statuses/priorTo; read-only derived `status`/`statusDate`/**`statusOpen`** (the cleanest machine-readable done flag) plus a `tracking[]` audit array. Because vocabularies are lender-defined, terminal statuses come from a settings-sync + config table, never constants.

Both carry `priorTo`, category, `isRemoved` (everything eFolder is soft-deleted — always filter, keep tombstones), and document links (`documents[]` / `assignedTo[]`) giving a fully readable **condition → document → attachment → bytes** evidence chain.

### 5.3 The gate, concretely

Add a declarative `encompass_gate` jsonb flag on `checklist_templates` (mirrored to items) — same design shape as the existing `rule_logic`. Three kinds: condition-match (`requiredStatus: ["Cleared","Waived"]` against an explicitly mapped Encompass condition), field-match (portal `loan_amount` vs field 1109 within tolerance), and `ctc`. NULL = today's behavior; a backfill flags `rtl_p2_enc`, the credit-score and liquidity items. Rules:

1. **Clear-time check in `signOffGate`**: read the local snapshot only — never a live call in the request path (Decision D1); block with a plain-language 422 unless the mapped Encompass state agrees AND the snapshot is fresh (for the CTC gate: no older than the 15-minute freshness ceiling; stale ⇒ fail closed and enqueue a high-priority refresh) — **fail closed on stale/unlinked data**, with the gate precondition match state ∈ {`auto_matched`, `manual_confirmed`} (§2.1). Waives stay human — a waive IS the "Encompass disagrees but we accept it" escape hatch, already permission-gated.
2. **Condition mapping is explicit, admin-curated** — by stable Encompass condition ID (stable in V3; GUID in V1), never fuzzy title match. Unmapped/unmatched conditions go to a review queue.
3. **Persist evidence**: raw condition JSON + fetch timestamp in an `encompass_evidence` jsonb column at every gate decision, for audit.

### 5.4 Where CTC is gated — all three doors (Decision D6)

Portal CTC today = empty `advancementBlockers` (`staff.js:3895-3923`: no open standard/prior_to_docs conditions, no unsatisfied required items, no unsatisfied `is_gate` items incl. `rtl_f_ctc` "CTC — Clear to Close received"), see-all role, admin may force (audited `forced` flag). The Encompass rule — **"portal CTC requires Encompass CTC"** — lands as an extra blocker row: mapped CTC milestone `doneIndicator=true` (config-driven, §3.5), all Encompass prior-to-closing conditions terminal, loan not in a dead/adverse state, the local snapshot within the CTC freshness ceiling (15 minutes recommended, configurable; stale ⇒ fail closed and enqueue a high-priority refresh — no live fetch in the request path, Decision D1), evidence bundle stored immutably.

**Known gap to close in the same change:** `POST /applications/:id/internal-status` (`staff.js:4298`) re-derives `clear_to_close` from ClickUp statuses **without running `advancementBlockers`**, and the inbound ClickUp sync moves status too. **Decided (Decision D6, 2026-07-19): the gate covers all THREE doors** — (1) the status PATCH endpoint, (2) the internal-status endpoint, and (3) ClickUp-inbound status application, where "blocking" means the inbound ClickUp CTC change is **not applied locally**: it lands in the sync review queue with reason `encompass_gate_blocked`, exactly like other suspicious inbound changes (we cannot stop ClickUp itself from changing; we refuse to mirror it ungated). Whether admin `force` may still override an Encompass block is a policy decision (§8 Q13) — recommendation: keep force but stamp it distinctly (e.g. `forced_over_encompass`).

---

## 6. eFolder documents: metadata-first

The portal's `documents` table assumes real local bytes end-to-end (`storage_ref`, serving, SharePoint mirroring, TPR export). **Do not insert byteless Encompass rows into it.** Instead:

- **Phase 1a — metadata index.** New `encompass_documents` table: `application_id`, `encompass_loan_guid`, `efolder_document_id`, `attachment_id`, title/type, dates, size, page count, `is_removed`, linked condition IDs, `last_seen_at`, metadata hash. Upsert on the natural key; **never delete — mark removed** (matching both eFolder's soft-delete semantics and the portal's own supersede-never-destroy philosophy). This mirrors how ClickUp state is indexed locally rather than trusted as portal-native rows.
- **Phase 1b — lazy hydration.** Bytes only when staff opens an artifact: `POST …/attachmentDownloadUrl` (a read-semantics POST minting a time-limited URL), fetch server-side, land through the existing chokepoints (`sha256`, `sniffKind`, `safeFilename`, `storage.save()`), then a real `documents` row so serving/dedup/audit work unchanged. sha256 byte-dedup falls out free — and a hash match is itself a useful "portal doc == Encompass doc" agreement signal.
- **Review status:** widen the CHECK with a distinct state (e.g. `'external'`) rather than pretending a human accepted them — keeps `reviewed_by` honest for compliance. Portal review/delete actions must refuse (or clearly re-badge as local-only) on Encompass-sourced rows: nothing may imply the eFolder changed.
- **Visibility: default `staff_only`.** eFolder contents (appraisals in review, title work, credit material, underwriting worksheets) have never passed the portal's borrower-safe sanitization (capital-partner scrubbing, co-borrower privacy). Borrower exposure is a deliberate per-document staff action.
- **Supersede streams stay separate**: Encompass-sourced rows version only from observed Encompass state; a borrower re-upload never supersedes an Encompass artifact or vice versa (separate `doc_kind` streams, copying the existing `track_record_doc` exclusion precedent).
- **SharePoint mirroring of hydrated bytes: default OFF** — Encompass is itself a durable system of record; re-mirroring is likely pure churn (§8 Q14). Batch needs use the async export-job flow (max 10/call, polled); pin annotation settings to exclude private annotations.

---

## 7. What we deliberately do NOT pull

| Excluded | Why |
|---|---|
| **Any write to Encompass** | Structural: HTTP client exposes only read verbs on an **exact-path allowlist** (GET everywhere; POST only for `fieldReader`, `loanPipeline`, `attachmentDownloadUrl`/`…/url`, export jobs — never `fieldWriter`, which shares verb and base path). DB CHECK forbids `encompass`+`push` queue rows. Ask for an Encompass persona without loan-edit rights so read-only is server-enforced too |
| **SSNs and DOBs (Tier 3)** | Not requested from Encompass at all at launch (Tier 3 disabled, Decision D3). If Tier 3 is ever enabled: hash-and-discard through the existing `ssn_hash` HMAC; plaintext never stored, never logged, never in review-queue rows (masked display only, per the sync-review rules) |
| **Wire instructions** (funding wire-to/ABA/account fields 2000–2011, 4660) | Fraud-sensitive; no portal use case |
| **Investor/capital-partner names on borrower surfaces** | Hard repo rule; `registrationlogs` data is staff-only if pulled at all |
| **Attachment bytes by default** | Metadata-first (§6); 5 GB prod disk makes bulk hydration untenable — lazy fetch + re-fetchable metadata |
| **Disclosure Tracking & AUS logs as gates** | Business-purpose lending: TRID disclosures and DU/LP runs are likely absent on this instance. Treat as optional evidence only when present (§8 Q15) |
| **Consumer Engagement / POS APIs** | The portal *is* the POS; these are almost entirely writes |
| **HMDA/declarations detail on borrower pairs** | Consumer-mortgage fields with no portal mapping target; pulling PII without a purpose violates data-minimization |
| **Alert webhooks (Phase 1)** | Compliance-alert webhooks require an ICE support ticket; derive lock-expiry/stall alerts locally from pulled data instead |
| **Auto-merges, auto-verification, auto-clears** | No borrower profile merge, no `is_verified=true`, no condition auto-clear, no auto-CTC — machines gate and suggest; humans decide |

---

## 8. Open questions

Canonical tracker: Master §10 (OQ-xx IDs); this local list is subsumed. (Decision D8, 2026-07-19.)

Every uncertain finding above, consolidated. None are blockers to *designing*; several are blockers to *building*.

| # | Question | Resolves via |
|---|---|---|
| 1 | Enhanced (V3) or standard (V1) conditions on BE11397907? | Read `useEnhancedConditionIndicator` on live loans; if enhanced, export the tracking-status + priorTo vocabularies |
| 2 | Actual milestone template — is there a literal "Clear to Close" milestone, or does CTC live in a custom field/status (the ClickUp "ctc (4-email)" naming suggests a delegated-investor flow)? | `GET /v3/settings/milestones` + admin mapping session |
| 3 | Is `ys_loan_number` identical to Encompass Loan Number (364) — and did ClickUp's number originally come FROM Encompass? | Sample crosswalk on real files |
| 4 | Which CX.* custom fields hold ARV / rehab budget / DSCR / experience / the F&F liquidity sheet? | `GET /v3/settings/loan/customFields` day-1 pull |
| 5 | Are rate locks used at all for these hard-money loans? | Owner/ops; feature-flag the panel |
| 6 | Does V3 fieldReader honor the `#N` borrower-pair suffix (samples say yes; older client docs say no)? | Sandbox test |
| 7 | Exact rendering of `PCC.ALL`/`PCC.NOTCLEARED` (delimiters, cleared-marker)? | Sandbox; corroboration-only until then |
| 8 | Is borrower/guarantor SSN reliably present on entity-vested files? Relevant only if Tier 3 is ever enabled — launch matching is SSN-less (Decision D3) | Sample data review, if/when Tier 3 is considered |
| 9 | Two-borrower Encompass loans: one track-record line or two, with GUID-level file dedup? | Policy decision before ingest ships |
| 10 | Should Phase 1 ever mint shadow profiles for Encompass-only borrowers (ClickUp design does; attach-only is safer)? | Owner decision |
| 11 | Should Encompass-funded YS loans fast-track to `'limited'` verification, or always require processor sign-off? | Owner decision (current code requires human sign-off for any counting status) |
| 12 | Must the Encompass CTC gate also cover the internal-status door and ClickUp-inbound path (both bypass `advancementBlockers` today)? | **RESOLVED (Decision D6, 2026-07-19): yes — all three doors (§5.4); ClickUp-inbound blocking = the change is not applied locally and lands in sync review with reason `encompass_gate_blocked`** |
| 13 | May admin `force` override an Encompass CTC block, and at which role? | Policy; recommend force stays but audited distinctly |
| 14 | Do hydrated Encompass bytes mirror to SharePoint, and do they ever enter TPR/buyer packages? | Recommend no/no by default; owner confirms |
| 15 | Are disclosures/AUS ever run through Encompass here (decides whether those logs are evidence or permanently empty)? | Ops confirmation |
| 16 | Field-level permissions of the integration user: both Get Loan and fieldReader **silently omit** unpermitted fields — a missing field is indistinguishable from empty unless handled deliberately | Persona audit + `invalidFieldBehavior`/`includeEmpty` discipline |
| 17 | Are webhook subscriptions acceptable under "architecturally incapable of writing"? | **RESOLVED (Decision D2, 2026-07-19): Phase 1 is poll-only — zero Encompass writes of any kind, config included. Webhook subscription CRUD becomes the one sanctioned config-write category only if/when webhooks are adopted (Phase 1.5+, owner-gated, out-of-band admin credential); polling remains the source of truth. Standard-conditions loans may have no webhook feed at all** |
| 18 | Freshness/staleness window for fail-closed gate decisions | **RESOLVED for CTC (Decision D1, 2026-07-19): local snapshot only, 15-minute freshness ceiling (configurable); stale ⇒ fail closed + enqueue high-priority refresh; no live fetch in the request path. Lower-severity gates tolerate standard poll-cadence age.** Semantics of a manual "refresh from Encompass" button remain a build-time design detail |

---

## 9. What was NOT done

- No Encompass endpoint was contacted; no credentials exist in this research or this document.
- Nothing in `yscap-repo-root_8/` was modified — no migrations, no code, no docs. Every recommendation above (new columns, tables, gate branches, CHECK constraints) is design-only.
- No borrower PII appears here; all field examples are schema-level.
