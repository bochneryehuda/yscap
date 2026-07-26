# Encompass → PILOT — Field, Status & Data Mapping (READ-ONLY, FROZEN)

> **HARD RULE — READ-ONLY, FROZEN (owner-directed 2026-07-22).**
> PILOT ↔ Encompass is a **one-way, read-only** connection. **PILOT NEVER writes to Encompass. PILOT NEVER replaces anything in Encompass. PILOT NEVER PATCHes a loan, advances a milestone, updates a field, uploads to eFolder, creates a loan, or deletes anything.** Every arrow in this doc is `←ENC` (pull-only) or `(not synced)`. There are no `→ENC` or `⇄` rows. The rule is enforced structurally in `src/lib/integrations/encompass.js` (`_fetchGuarded` refuses any non-GET method against `/encompass/*`; the module exports GET helpers only) and is verified on every commit by `scripts/test-encompass-readonly.js`. To reopen this decision the owner has to say so in their own words.

This is the **mapping proposal** — the field-by-field crosswalk between PILOT's `applications` + `borrowers` and the Encompass loan resource. Companion piece to the (future) `ENCOMPASS-INTEGRATION-BLUEPRINT.md`. **Please verify each row.** Nothing is coded until this is signed off.

**Phase 2 built (2026-07-22):** the read-only pull is live behind an `ENCOMPASS_ENABLED` switch — `src/encompass/client.js` (thin GET wrappers + the ONE allowed read-shaped POST for pipeline search) + `src/encompass/reader.js` (`refreshFieldCatalog()` populates `encompass_field_catalog`; `pullLoanForApplication(appId)` stashes the full raw loan JSON in `applications.encompass_extra` + stamps `encompass_last_pulled_at`) + `src/sync/encompass-sync.js` (nightly catalog refresh + one-file-per-tick loan pull, self-gates on `ENCOMPASS_ENABLED=1`) + `src/routes/admin-encompass.js` (staff admin endpoints for on-demand refresh + cached-loan read). Migrations `db/244` (`applications.encompass_extra` + `encompass_loan_guid` + `encompass_last_pulled_at` + `encompass_last_error`) and `db/245` (`encompass_field_catalog`). There is NO mapper writer, NO orchestrator push, NO enqueue helper, NO `sync_queue` producer for `target='encompass'` (the enum value stays reserved but unused). See `docs/CLICKUP-DATA-MAPPING.md` for the sibling doc this one is patterned on — but note ClickUp is bidirectional and Encompass is not.

**Status today:** the OAuth client exists (`src/lib/integrations/encompass.js` — both `client_credentials` and `password` (ROPC) grants; `apiGet()` hook), the config block exists (`src/config.js:392`), the `sync_queue.target` enum already accepts `'encompass'` (`db/schema.sql:306`), the API Health page already lists Encompass at state `framework`, and the pull-only `applications.encompass_status` column already rides across the ClickUp sync (`db/047`). What's missing: the mapping (this doc), the field registry, the mapper, the client wrapper with the guarded pattern, the worker, and the outbound review-queue producer.

**Environment gap (2026-07-21):** the current session environment's outbound-egress policy blocks `api.elliemae.com` at the proxy layer, so the live-instance field metadata refresh has to happen after `api.elliemae.com` (and likely `api.icemortgagetechnology.com`) is added to the environment's allowlist. Until then, everything marked `⚠︎ verify against instance` in Part 3 stays a proposal.

---

## PART 1 — Value transform reference (how each Encompass field type is read & written)

Encompass exposes every field **three ways**. The mapper picks the addressing form per field (whichever survives Encompass version upgrades best is usually the numeric canonical ID, so we default to that for standard fields and `CX.*` for custom fields):

| Addressing form | Example | When we use it |
|---|---|---|
| Canonical numeric field ID (as string) | `"1109"` = Borrower Requested Loan Amount, `"4000"` = Borrower First Name, `"136"` = Purchase Price, `"356"` = Appraised Value | Default for STANDARD Encompass fields — stable across Encompass releases |
| Property path (dot-form) | `Loan.LoanAmount`, `applications[0].borrower.firstName` | Only for reads where the canonical ID is awkward (nested collections) |
| `CX.*` custom field | `CX.ARV`, `CX.REHAB_BUDGET` | Every tenant-defined field. `⚠︎ verify against instance` — the CX.* names in this doc are proposals, not confirmed against BE11397907 |

| Encompass type | GET returns | PILOT-side transform (read only) |
|---|---|---|
| **Number / Currency** | JSON number (e.g. `468750`) | strip `$` `,` spaces → `Number`; land in PILOT `numeric` column |
| **Date** | ISO8601 date-only string (`"2026-08-15"`) or full timestamp | routed through `transforms.encompassIsoToDateOnly()` — kept as a `'YYYY-MM-DD'` string end-to-end (per the CLAUDE.md date rule) |
| **String** | string | passthrough |
| **Enum / Picklist** | string label (e.g. `"Purchase"`) | `crosswalk.js` translates Encompass label → PILOT canonical per `enumKey`; unknown labels are recorded in `encompass_extra.unknown_labels[]` (never dropped, never mapped to a default) |
| **Boolean** | JSON boolean | boolean passthrough |
| **Address group** | flat fields (`FR0104`, `FR0106`, `FR0107`, `FR0108`) | reassembled into PILOT's address `jsonb{line1,city,state,zip}` |
| **Custom fields (`CX.*`)** | inside `customFields:[{fieldName,stringValue,numericValue,dateValue,...}]` | typed getter picks `stringValue`/`numericValue`/`dateValue` by the field's declared type |
| **Loan folder** | string (`"Active"`, `"My Pipeline"`) | staff-informational only |
| **Milestone** | string (`"Started"`, `"Approval"`, `"Funding"`) — separate resource `/loans/{guid}/milestones` | maps to `applications.internal_status`/`status` per Part 2. **PILOT never advances a milestone in Encompass** — the LO drives Encompass directly |

> **Why this matters:** since PILOT never writes, the traps that hit the ClickUp side (dropdown index-vs-UUID, PII overwrite storms, DOB 4AM-NY encoding) simply cannot happen here. The only failure modes are read failures (retry) and unknown enum labels (record + surface, never silently coerce).

---

## PART 2 — Loan status / milestone mapping (read only)

Encompass tracks lifecycle via **milestones** (`Started`, `Processing`, `Approval`, `Docs Signing`, `Funding`, `Purchased`, `Adverse`) plus a free-text `LOG.Milestone.Current`. PILOT already carries **two** status columns:
- `applications.internal_status` — the 38-status ClickUp mirror (see `CLICKUP-DATA-MAPPING.md` §2A).
- `applications.status` — the borrower-facing derived set (`file_intake / in_review / processing / underwriting / approved / clear_to_close / funded / declined / withdrawn / on_hold`).
- `applications.encompass_status` — a THIRD column (pulled today from ClickUp via `F.PIPELINE.encompassStatus`); PROPOSAL is to keep pulling this from ClickUp AND additionally cross-check it against the live Encompass milestone when this sync goes live (a mismatch surfaces on the file's staff view — PILOT still never overwrites Encompass, and does not overwrite the ClickUp-sourced value silently either).

**Proposed Encompass milestone → PILOT `internal_status` map** (`enumKey: 'encompass_milestone'`):

| Encompass milestone (current) | PILOT `internal_status` | PILOT `status` (derived) | Reasoning |
|---|---|---|---|
| `Started` / `File Started` | `starting` | `file_intake` | Loan created in Encompass; not yet processed |
| `Processing` | `self procesing` (sic) or `assigned to processor` | `processing` | Depends on whether a processor is assigned |
| `Submittal` | `delegated initial` | `underwriting` | Submitted to lender |
| `Approval` / `Conditional Approval` | `delegated conditional` | `underwriting` | Cond. approval issued |
| `Resubmittal` | `resubmitted (4-em)` | `underwriting` | Re-sub after conditions |
| `Cleared to Close` | `ctc (4-email)` | `clear_to_close` | Docs cleared |
| `Docs Signing` / `Closing` | `active closing` | `clear_to_close` | At closing table |
| `Funding` / `Funded` | `closed (6-email funded)` | `funded` | Funded (`funded_date` also lands from field `1401`) |
| `Purchased` | `closed reconciled` | `funded` | Investor purchase settled |
| `Adverse` / `Withdrawn` / `Cancelled` | `declined` / `cancelled` | `declined` / `withdrawn` | End-of-life exits |

Direction: **`←ENC`** (Encompass is the LOS source-of-record for milestones; PILOT reads only). The PILOT-side status column and any borrower notification triggered from an inbound Encompass status change use the `status_notified_external_encompass` watermark (new column, GO-FORWARD ONLY, mirroring the Sitewire / ClickUp watermark pattern — so previously-drifted old files don't blast the borrower on first reconcile). **Nothing is ever pushed back to Encompass.**

---

## PART 3 — Field crosswalk (all rows are `←ENC` — pull only)

**How to read direction:** every row is `←ENC` — Encompass is the source, PILOT reads. There are no `→ENC` and no `⇄` rows. If a PILOT column already has a value from another source (application intake, ClickUp sync, staff edit), the read-only Encompass pull writes ONLY when the PILOT value is null OR into a companion column (e.g. Encompass's authoritative rate lands in `actual_rate`, PILOT's `desired_rate` is never touched). Every non-null-would-be-overwritten value goes into the `encompass_extra` jsonb column as forensics; nothing is silently coerced.

**Every row is a reader `FIELD_MAP` entry of shape** `{en: <ID>, t: 'a'|'b'|'l', col: '<snake_case>', type, enumKey?}` — same shape as `src/clickup/mapper.js` `FIELD_MAP`, minus the `dir` (implicit pull) and minus any writer-side transform.

Every `⚠︎ verify against instance` note means: the canonical ID or custom-field name in that row needs live confirmation against BE11397907 before it goes to code.

### 3A. Borrower identity — `borrowers` table (READ FOR CROSS-CHECK ONLY)

PILOT is the source of borrower identity — Encompass is never written to. The pulled values feed the STAFF SANITY-CHECK view only (`app-v2` staff panel: "Encompass vs PILOT"), never a silent overwrite of a PILOT borrower row. A disagreement surfaces on the staff panel; the LO fixes whichever side is wrong (probably by hand-editing in Encompass, since PILOT is authoritative for borrower PII).

| PILOT `borrowers` col | Encompass field | Type | Notes |
|---|---|---|---|
| `first_name` | `4000` Borrower First Name | text | Displayed side-by-side; no write |
| `last_name` | `4002` Borrower Last Name | text | |
| `email` | `1240` Borrower Email | text | ⚠︎ verify (some tenants use `URLA.X79`) |
| `cell_phone` | `1490` Borrower Home Phone | text | |
| `date_of_birth` | `1402` Borrower Date of Birth | date | Read via `transforms.encompassIsoToDateOnly` — displayed only |
| `ssn_encrypted` | `65` Borrower SSN | text (masked in display) | Compared last-4 only; no PILOT write |
| `fico` | ⚠︎ tenant-specific (`VASUMM.X23`, `CX.FICO`, or `1420`) | number | ⚠︎ verify against instance |
| `current_address` | `FR0104`/`FR0106`/`FR0107`/`FR0108` | text | Assembled into `{line1,city,state,zip}` for display |
| `marital_status` | `52` Borrower Marital Status | enum | Display only |
| `citizenship` | `2` Borrower Citizenship | enum | ⚠︎ verify |
| `employment_type` + `employer` | `FE0116` Current Employer Name | text | First employment entry only |

### 3B. Co-borrower — mirror block (READ FOR CROSS-CHECK ONLY)

Every 3A row has a co-borrower twin (`4004`/`4006`/`1244`/`66`/`1416`/`FR0204`–`FR0208`). Same posture: display side-by-side, no PILOT write, no Encompass write.

### 3C. Property (subject) — `applications` table

| PILOT `applications` col | Encompass field | Type | Notes |
|---|---|---|---|
| `property_address` | `11`/`12`/`14`/`15` | text | Read for cross-check; PILOT-authoritative |
| `property_type` | `1041` Subject Property Type | enum | `enumKey: 'property_type'` |
| `units` | `16` Number of Units | number | |
| `purchase_price` | `136` Purchase Price | currency | Cross-check only — PILOT-frozen |
| `as_is_value` | `356` Appraised Value | currency | Never overwrites PILOT `as_is_value` (intake) |
| `actual_appraised_value` | `356` Appraised Value | currency | Lands here only when PILOT column is null; otherwise recorded in `encompass_extra.appraised_value` for staff review |
| `arv` | `CX.ARV` | currency | Cross-check only — ⚠︎ verify |
| `rehab_budget` | `CX.REHAB_BUDGET` | currency | Cross-check only — ⚠︎ verify |
| `rehab_type` | `CX.REHAB_TYPE` | enum | ⚠︎ verify |
| `sqft_pre` / `sqft_post` | `CX.SQFT_PRE` / `CX.SQFT_POST` | number | ⚠︎ verify |

### 3D. Loan economics — `applications` table

| PILOT `applications` col | Encompass field | Type | Notes |
|---|---|---|---|
| `loan_amount` | `1109` Borrower Requested Loan Amount | currency | Cross-check only — PILOT-frozen |
| `actual_rate` | `3` Note Rate | text | Lands here from Encompass (PILOT already has this column, db/047, for the LOS's authoritative rate) |
| `term` | `4` Loan Term (Months) | number | Cross-check |
| `dscr_ratio` | `CX.DSCR` | number | ⚠︎ verify |
| `program` | `1811` Loan Program | enum | Cross-check — a mismatch surfaces on the staff panel so the LO decides whether to re-register PILOT or fix Encompass |
| `loan_type` | `19` Loan Purpose | enum | Cross-check |
| `channel` | `1030` Channel (or `CX.CHANNEL`) | enum | ⚠︎ verify |
| `occupancy` | `1811_occ` Occupancy | enum | ⚠︎ verify |
| `lender` (note buyer) | `CX.INVESTOR_NAME` (or `1465`) | text/enum | Cross-check — never a borrower-facing surface |
| `ys_loan_number` | `364` Loan Number | text | The natural key |
| `investor_loan_number` | `CX.INVESTOR_LOAN_NO` | text | ⚠︎ verify |
| `first_lien` / `second_lien` | `CX.FIRST_LIEN` / `CX.SECOND_LIEN` | currency | Cross-check |
| `property_taxes` / `property_insurance` / `property_hoa` / `rental_income` | `1405` / `230` / `237` / `1395` | currency | Cross-check |
| `prepayment_penalty` | `675` Prepayment Penalty | text | Cross-check |

### 3E. Assignment / wholesale — `applications` (RTL)

Assignment fields (`is_assignment`, `underlying_contract_price`, `assignment_fee`) live in PILOT only. Encompass reads its own `CX.*` if the LO chose to enter them there; if not, no cross-check row exists. Never a PILOT write.

### 3F. Team — LO / Processor / Underwriter

Read the Encompass roles for display parity ONLY. PILOT's assignee model (`db/103`) is authoritative — an Encompass disagreement surfaces on the staff panel but never rewrites PILOT.

| PILOT col | Encompass field | Type | Notes |
|---|---|---|---|
| `loan_officer_id` / `loan_officer_name` | `317` Loan Officer Name + `Contacts.LoanOfficer.Email` | text + email | Matched by email against `staff_users` for display; no write |
| `processor_id` | `320` Loan Processor Name + `Contacts.LoanProcessor.Email` | text + email | Same |
| `underwriter_id` | `321` Underwriter Name + `Contacts.Underwriter.Email` | text + email | Same |

### 3G. Dates & lifecycle — Encompass-authoritative (still pull-only)

| PILOT col | Encompass field | Type | Notes |
|---|---|---|---|
| `submitted_at` | `LOG.MS.Date.File Started` (or `748`) | date | Landed when PILOT column is null; otherwise `encompass_extra.file_started_at` |
| `expected_closing` | `763` Estimated Closing Date | date | Landed when PILOT column is null; otherwise `encompass_extra.estimated_closing` |
| `actual_closing` | `1400` Closing Date | date | ⚠︎ verify — quality-excellence docs list `1400`/`1401` |
| `funded_date` (new column) | `1401` Funded Date | date | Adds `applications.funded_date` in a new migration |
| `encompass_status` | `LOG.Milestone.Current` | text | Reconciled against the ClickUp-sourced value; a mismatch shows on the staff panel |
| `encompass_loan_guid` (new column) | `Loan.Guid` (top-level `guid`) | text | Adds `applications.encompass_loan_guid` — the immutable join key (analog of `applications.clickup_pipeline_task_id`) |

### 3H. Fields deliberately NOT synced

Documenting these explicitly so scope is unambiguous:
- eFolder documents — never uploaded to Encompass; PILOT already mirrors to SharePoint
- Conditions — never written to Encompass; PILOT's Condition Center is authoritative
- Fee sheet / GFE / LE / CD line items — closing cost disclosures live entirely in Encompass; not pulled
- HMDA / URLA — Encompass owns compliance disclosures
- Product & pricing — the frozen PILOT engines are authoritative; we do not consume Encompass rate sheets
- Milestones as WRITES — **never**; PILOT never advances a milestone in Encompass, period. Frozen.
- MI / title / hazard providers — separate service-orderable resources
- eSign — DocuSign integration handles this
- Every PILOT column referenced in §3A–§3G — **the Encompass read never REPLACES a value already set from another source**; PILOT-authoritative columns get the Encompass value in `encompass_extra` for staff review only

---

## PART 4 — Direction posture summary (read only, in one sentence)

Every field flows **`←ENC`** — Encompass to PILOT, no exceptions. Some rows land in a PILOT column when it is null, others display side-by-side only, and every value pulled is additionally recorded in `applications.encompass_extra` jsonb for forensics.

---

## PART 5 — What still needs live confirmation against BE11397907

Once `api.elliemae.com` is on the environment's allowlist (and the credentials are rotated per the "never wire a chat-shared secret" rule), a one-shot **read-only** admin endpoint can pull the tenant's field metadata and confirm:

1. Every `⚠︎ verify against instance` line above — mostly the `CX.*` custom-field names (case-sensitive) and the actual FICO field ID.
2. The exact PICKLIST labels for `program`, `loan_type`, `property_type`, `occupancy`, `channel`, `rehab_type` — populates `crosswalk.js`.
3. The tenant's actual MILESTONE list (may differ from the canonical 7-milestone set above).
4. Whether the tenant carries a `LO2` / secondary-loan-officer slot.

The admin endpoint is a `GET` (`/api/admin/encompass/field-metadata`) — the READ-ONLY guard in the client enforces this at the module level.

---

## PART 6 — Next steps (for owner sign-off)

Please respond with:
1. **Approve / amend Parts 3A–3G row by row.** Any row you strike, we drop.
2. **Confirm the READ-ONLY freeze is what you meant** (locked in code + tests as of 2026-07-22). If you ever want two-way in the future you'll say so in your own words.
3. **Confirm milestone→status map (Part 2 table).** The 38-status ClickUp mirror is unusually detailed — a simpler map is fine if you'd rather.
4. **Rotate the ICE Developer Connect client secret** and re-set the new value directly in Render env (`ENCOMPASS_CLIENT_ID`/`_SECRET`/`_INSTANCE_ID`) — I never touch it in code / commits / config files.
5. **Ask Anthropic / whoever administers this Claude Code environment to add `api.elliemae.com` (and probably `api.icemortgagetechnology.com`) to the outbound-allowlist** so a session can complete Part 5.

Once (1)–(3) are signed off, we can start on the fields.js + crosswalk.js + mapper.js scaffold WITHOUT (4) and (5); those two only gate the live-instance probe + the eventual switch-on.
