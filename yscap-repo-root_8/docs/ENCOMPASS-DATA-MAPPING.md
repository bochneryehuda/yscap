# Encompass ⇄ PILOT — Field, Status & Data Mapping (proposal for line-by-line verification)

This is the **mapping proposal** — the field-by-field crosswalk between PILOT's `applications` + `borrowers` and the Encompass loan resource. Companion piece to the (future) `ENCOMPASS-INTEGRATION-BLUEPRINT.md`. **Please verify each row.** Nothing is coded until this is signed off.

Once the mapping is approved, implementation mirrors the shape already used for ClickUp and Sitewire: `src/encompass/{fields,crosswalk,transforms,mapper,client,orchestrator,ingest,enqueue}.js` + `src/sync/encompass-sync.js` + `db/2NN_encompass_*.sql`. See `docs/CLICKUP-DATA-MAPPING.md` for the sibling doc this one is patterned on.

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

| Encompass type | GET returns | PATCH expects | PILOT-side transform |
|---|---|---|---|
| **Number / Currency** | JSON number (e.g. `468750`) | JSON number | strip `$` `,` spaces → `Number`; PILOT `numeric` ↔ number |
| **Date** | ISO8601 date-only string (`"2026-08-15"`) or full timestamp | ISO8601 (`"YYYY-MM-DD"` for date-only) | routed through `transforms.dateOnlyToEncompassIso()` — never a JS `Date`, never an epoch (parallel to the `dateOnlyToClickUpEpoch` rule) |
| **String** | string | string | passthrough |
| **Enum / Picklist** | string label (e.g. `"Purchase"`) | string label matching the tenant's picklist | `crosswalk.js` translates PILOT canonical → Encompass label per `enumKey` |
| **Boolean** | JSON boolean | JSON boolean | boolean passthrough |
| **Address group** | flat fields (`FR0104`, `FR0106`, `FR0107`, `FR0108`) | same | PILOT address `jsonb{line1,city,state,zip}` splits into 4 field writes |
| **Custom fields (`CX.*`)** | inside `customFields:[{fieldName,stringValue,numericValue,dateValue,...}]` | same shape in PATCH body | typed getter/setter chooses `stringValue`/`numericValue`/`dateValue` by the field's declared type |
| **Loan folder** | string (`"Active"`, `"My Pipeline"`) | string | write-once at loan create |
| **Milestone** | string (`"Started"`, `"Approval"`, `"Funding"`) — separate resource `/loans/{guid}/milestones` | own resource with its own PATCH shape (not raw fields) | read-only in Phase 1 → maps to `applications.internal_status`/`status`; write later, if ever |

> **Why this matters:** the #1 latent bug on the ClickUp side was treating a dropdown's read value (an index) as its write value (a UUID). On Encompass the equivalent trap is enum LABELS — the label case-and-spacing must match the tenant's picklist exactly on write. Every enum field runs through `crosswalk.js` both ways with a live picklist snapshot; a write against an unknown label parks a `sync_review_queue` row instead of blindly sending.

---

## PART 2 — Loan status / milestone mapping

Encompass tracks lifecycle via **milestones** (`Started`, `Processing`, `Approval`, `Docs Signing`, `Funding`, `Purchased`, `Adverse`) plus a free-text `LOG.Milestone.Current`. PILOT already carries **two** status columns:
- `applications.internal_status` — the 38-status ClickUp mirror (see `CLICKUP-DATA-MAPPING.md` §2A).
- `applications.status` — the borrower-facing derived set (`file_intake / in_review / processing / underwriting / approved / clear_to_close / funded / declined / withdrawn / on_hold`).
- `applications.encompass_status` — a THIRD column (pulled today from ClickUp via `F.PIPELINE.encompassStatus`); PROPOSAL is to keep pulling this from ClickUp AND additionally cross-check it against the live Encompass milestone when this sync goes live (a mismatch parks a review row rather than silently overwriting).

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

Direction: **`←ENC`** (Encompass is the LOS source-of-record for milestones; PILOT reads only). PILOT writes only on the borrower-visible `applications.status` transitions via the existing `notifyInboundStatusChange` chokepoint, using the `status_notified_external_encompass` watermark (new column, GO-FORWARD ONLY, mirroring the Sitewire / ClickUp watermark pattern — so previously-drifted old files don't blast the borrower on first reconcile).

---

## PART 3 — Field crosswalk

**How to read direction:**
- `⇄` two-way (PILOT is authoritative on identity, Encompass on LOS lifecycle; disagreement → `sync_review_queue`)
- `←ENC` Encompass is source of truth (pull only)
- `→ENC` PILOT is source (push only)

**Every row is a mapper `FIELD_MAP` entry of shape** `{en: <ID>, t: 'a'|'b'|'l', col: '<snake_case>', type, enumKey?, dir}` — same shape as `src/clickup/mapper.js` `FIELD_MAP`.

Every `⚠︎ verify against instance` note means: the canonical ID or custom-field name in that row needs live confirmation against BE11397907 before it goes to code.

### 3A. Borrower identity — `borrowers` table (PILOT-authoritative; blanks-fill-only into Encompass)

Push-only in Phase 1 (never re-pull identity — PILOT's borrower row is the master; the `pii_overwrite_blocked` shield is inherited from the ClickUp code path). Move to `⇄` in Phase 2 once the two-sided review flow is live for Encompass.

| PILOT `borrowers` col | Encompass field | Type | Direction | Notes |
|---|---|---|---|---|
| `first_name` | `4000` Borrower First Name | text | →ENC | |
| `last_name` | `4002` Borrower Last Name | text | →ENC | |
| `email` | `1240` Borrower Email | text | →ENC | ⚠︎ verify (some tenants use `URLA.X79`) |
| `cell_phone` | `1490` Borrower Home Phone | text | →ENC | Encompass has home/work/cell separately — PILOT `cell_phone` writes to the borrower's primary phone. If your tenant carries a distinct Cell field, we point at that instead |
| `date_of_birth` | `1402` Borrower Date of Birth | date | →ENC | routed through `transforms.dateOnlyToEncompassIso`; runs through `decideDob()` if a disagreement ever surfaces on a pull |
| `ssn_encrypted` (decrypted digits) | `65` Borrower SSN | text (9 digits, no dashes) | →ENC | Format-controlled by `fields.formatSsn` on push (dashed for display, digits for storage — matches CLAUDE.md SSN rule). Never pulled. Journal masks. |
| `fico` | ⚠︎ tenant-specific (`VASUMM.X23`, `CX.FICO`, or `1420` depending on tenant) | number | →ENC | ⚠︎ verify against instance |
| `current_address.line1` | `FR0104` Borrower Street | text | →ENC | |
| `current_address.city` | `FR0106` Borrower City | text | →ENC | |
| `current_address.state` | `FR0107` Borrower State | text | →ENC | 2-letter |
| `current_address.zip` | `FR0108` Borrower Zip | text | →ENC | |
| `marital_status` | `52` Borrower Marital Status | enum (`Married`/`Unmarried`/`Separated`) | →ENC | `enumKey: 'marital_status'` |
| `citizenship` | `2` Borrower Citizenship (or `URLA.X17`) | enum | →ENC | ⚠︎ verify |
| `employment_type` + `employer` | `FE0116` Current Employer Name | text | →ENC | Encompass Employment is a repeatable collection — first entry only |

### 3B. Co-borrower — mirror block

Every 3A row has a co-borrower twin (`4004` = Co-Borrower First Name, `4006` = Co-Borrower Last Name, `1244` = Co-Borrower Email, `66` = Co-Borrower SSN, `1416` = Co-Borrower DOB, `FR0204`–`FR0208` for address). Only pushed when `applications.co_borrower_id IS NOT NULL`. Direction: →ENC.

### 3C. Property (subject) — `applications` table

| PILOT `applications` col | Encompass field | Type | Direction | Notes |
|---|---|---|---|---|
| `property_address.line1` | `11` Subject Property Street | text | →ENC | |
| `property_address.city` | `12` Subject Property City | text | →ENC | |
| `property_address.state` | `14` Subject Property State | text | →ENC | 2-letter |
| `property_address.zip` | `15` Subject Property Zip | text | →ENC | |
| `property_type` | `1041` Subject Property Type | enum | →ENC | `enumKey: 'property_type'` — crosswalk from PILOT (`SFR`/`Multi 2-4`/`Multi 5+`/`Mixed Use`) to Encompass label set |
| `units` | `16` Number of Units | number | →ENC | |
| `purchase_price` | `136` Purchase Price | currency | →ENC | Frozen at register — never re-derived |
| `as_is_value` | `356` Appraised Value | currency | ⇄ | PILOT writes intake value; Encompass may later overwrite from UCDP appraisal → this is the ONE property field where Encompass can win. Handled by two-sided review. |
| `actual_appraised_value` | `356` Appraised Value | currency | ⇄ | Same field; PILOT already stores staff-adjusted value separately (db/041) — proposed rule: read Encompass into `actual_appraised_value`, keep `as_is_value` as the intake snapshot |
| `approx_appraised_value` | `CX.APPROX_APPRAISED_VALUE` | currency | →ENC | ⚠︎ verify — most tenants add this as CX |
| `cda_value` | `CX.CDA_VALUE` | currency | →ENC | Collateral Desktop Analysis — RTL-specific, custom |
| `arv` | `CX.ARV` | currency | →ENC | RTL-specific, custom — ⚠︎ verify |
| `rehab_budget` | `CX.REHAB_BUDGET` | currency | →ENC | RTL — ⚠︎ verify |
| `rehab_type` | `CX.REHAB_TYPE` | enum | →ENC | Cosmetic / Moderate / Heavy / Adding SF / Ground-up — ⚠︎ verify |
| `sqft_pre` | `CX.SQFT_PRE` | number | →ENC | ⚠︎ verify |
| `sqft_post` | `CX.SQFT_POST` | number | →ENC | ⚠︎ verify |

### 3D. Loan economics — `applications` table

| PILOT `applications` col | Encompass field | Type | Direction | Notes |
|---|---|---|---|---|
| `loan_amount` | `1109` Borrower Requested Loan Amount | currency | →ENC | Floored to whole dollars per PILOT rule (frozen 2026-07-09). Encompass typically derives `2` (Loan Amount) from `1109` at pricing time |
| `ltv` | `353` LTV | number (percent) | (skip) | Encompass DERIVES from `1109/356`; safer to leave to Encompass. Not in FIELD_MAP. |
| `rate_pct` | `3` Note Rate | number | ⇄ | PILOT reports on register; the lender's actual rate ends up in Encompass. On disagreement → review |
| `actual_rate` | `3` Note Rate | text (Encompass returns as string) | ←ENC | PILOT already has `actual_rate` column (db/047) — this is where Encompass's authoritative rate lands |
| `desired_rate` | `CX.DESIRED_RATE` | text | →ENC | Borrower-requested rate (already a PILOT column, db/047) |
| `term` | `4` Loan Term (Months) | number | →ENC | Parse `"12 mo"` → integer 12; write as integer |
| `ppp` | `CX.PPP_TERM` | text | →ENC | PILOT stores as text (`"3-2-1"` etc); custom |
| `dscr_ratio` | `CX.DSCR` | number | →ENC | DSCR program — custom |
| `program` | `1811` Loan Program | enum | ⇄ | `enumKey: 'program'` — Gold Standard / Fix & Flip / Bridge / DSCR / Ground-up. Two-way because LO may switch program in Encompass; PILOT re-registers off it. ⚠︎ verify picklist labels against instance |
| `loan_type` | `19` Loan Purpose | enum | ⇄ | Purchase / Refinance / Cash-Out / Construction. `enumKey: 'loan_type'` |
| `channel` | `1030` Channel (or `CX.CHANNEL`) | enum | →ENC | Wholesale / Delegated Corr / Non-Del Corr / Table Funding — ⚠︎ verify |
| `occupancy` | `1811_occ` Occupancy (or `URLA.X79`) | enum | →ENC | Investment default for RTL — ⚠︎ verify |
| `lender` (note buyer) | `CX.INVESTOR_NAME` (or `1465` Investor Name) | text/enum | →ENC | Staff-only. Continues to be scrubbed from every borrower-facing surface per CLAUDE.md rule |
| `ys_loan_number` | `364` Loan Number | text | ⇄ | The natural key. On CREATE we push; on inbound we compare — a disagreement is the "copied loan number" signature (existing CLAUDE.md rule §5b for ClickUp) → parks review |
| `investor_loan_number` | `CX.INVESTOR_LOAN_NO` (or `4553`) | text | ⇄ | ⚠︎ verify |
| `first_lien` | `CX.FIRST_LIEN` | currency | →ENC | RTL refi context — custom |
| `second_lien` | `CX.SECOND_LIEN` | currency | →ENC | Same |
| `property_taxes` | `1405` Annual Property Taxes | currency | ⇄ | Existing PILOT column (db/047) |
| `property_insurance` | `230` Annual Homeowners Insurance | currency | ⇄ | Existing PILOT column |
| `property_hoa` | `237` HOA Dues (annual) | currency | ⇄ | Existing PILOT column |
| `rental_income` | `1395` Gross Monthly Rental Income | currency | ⇄ | Existing PILOT column |
| `prepayment_penalty` | `675` Prepayment Penalty | text | →ENC | Existing PILOT column |

### 3E. Assignment / wholesale — `applications` (RTL)

| PILOT col | Encompass field | Type | Direction | Notes |
|---|---|---|---|---|
| `is_assignment` | `CX.IS_ASSIGNMENT` | boolean | →ENC | Custom flag |
| `underlying_contract_price` | `CX.UNDERLYING_CONTRACT_PRICE` | currency | →ENC | Seller's original contract price (frozen 2026-07-17). Financeable-fee cap enforced in PILOT — pushed to Encompass as-recorded |
| `assignment_fee` | `CX.ASSIGNMENT_FEE` | currency | →ENC | Full requested fee (per 2026-07-17 display rule) |

### 3F. Team — LO / Processor / Underwriter

Encompass carries loan-officer identity in two places (like ClickUp): the standard `LO1` role slot in `loan.contacts` AND named text fields. The mapper reads BOTH and adopts only when they agree (mirrors the ClickUp `decideInboundProcessor` chokepoint):

| PILOT col | Encompass field | Type | Direction | Notes |
|---|---|---|---|---|
| `loan_officer_id` (resolved) → `loan_officer_name` | `317` Loan Officer Name + `Contacts.LoanOfficer.Email` | text + email | ⇄ | Matched by email against `staff_users`. Both-agree rule required for inbound adopt |
| `processor_id` (resolved) → `processor_name` | `320` Loan Processor Name + `Contacts.LoanProcessor.Email` | text + email | ⇄ | Same both-agree rule |
| `underwriter_id` (resolved) | `321` Underwriter Name + `Contacts.Underwriter.Email` | text + email | ⇄ | Same |

### 3G. Dates & lifecycle — mostly Encompass-authoritative

| PILOT col | Encompass field | Type | Direction | Notes |
|---|---|---|---|---|
| `submitted_at` | `LOG.MS.Date.File Started` (or `748` File Started) | date | ←ENC | Set on loan create in Encompass |
| `expected_closing` | `763` Estimated Closing Date | date | ⇄ | Ownership is fuzzy — LO edits in both places. Two-sided review on disagreement |
| `actual_closing` | `1400` Closing Date | date | ←ENC | ⚠︎ verify — quality-excellence docs list `1400`/`1401` for closing vs funded |
| `funded_date` (new column) | `1401` Funded Date | date | ←ENC | Adds `applications.funded_date` (new migration `db/2NN_encompass_applications.sql`) |
| `status_changed_at` | (derived from milestone timestamp) | timestamp | ←ENC | Not a direct field write — mapper computes from `LOG.Milestone.Current` change |
| `encompass_status` | `LOG.Milestone.Current` | text | ⇄ (advisory) | Continues to be pulled from ClickUp today; ADDITIONALLY cross-checked against Encompass live when this sync goes live. Discrepancy → review row (never silent overwrite) |
| `encompass_loan_guid` (new column) | `Loan.Guid` (top-level `guid`) | text | ←ENC | Adds `applications.encompass_loan_guid` — the immutable join key (analog of `applications.clickup_pipeline_task_id`) |

### 3H. Fields deliberately NOT synced (out of scope for Phase 1)

Documenting these explicitly so scope is unambiguous:
- eFolder documents — PILOT already mirrors documents to SharePoint; a second mirror into Encompass eFolder is a separate integration
- Conditions — Encompass Enhanced Conditions is the industry reference (per `docs/appraisal-xml/research/underwriting-findings-platforms.md`) but PILOT's Condition Center is authoritative; we do not push PILOT conditions into Encompass or pull Encompass conditions into PILOT
- Fee sheet / GFE / LE / CD line items — closing cost disclosures live entirely in Encompass
- HMDA / URLA — Encompass owns compliance disclosures
- Product & pricing — the frozen PILOT engines are authoritative; we do not consume Encompass rate sheets
- Milestones as WRITES — Phase 1 reads Encompass milestones; PILOT never advances a milestone. Milestone writes come later (or never — LO typically drives milestones in Encompass directly)
- MI / title / hazard providers — separate service-orderable resources
- eSign — DocuSign integration handles this (see `docs/DOCUSIGN-INTEGRATION-BLUEPRINT.md`)

---

## PART 4 — Direction posture summary

- **PILOT-authoritative** (`→ENC`; blanks-fill only in Encompass; PII shield on disagreement): all of Borrower identity (§3A) + Co-borrower (§3B), Property inputs (§3C except `as_is_value`/`actual_appraised_value`), Loan economics inputs (`loan_amount`, `desired_rate`, `term`, `ppp`, `dscr_ratio`, `channel`, `occupancy`, `lender`), Assignment block (§3E), the initial `expected_closing`.
- **Encompass-authoritative** (`←ENC`; PILOT reads only): milestone → `internal_status`/`status`, `actual_closing`, `funded_date`, `submitted_at`, `actual_rate`, `encompass_loan_guid`.
- **Two-way with review** (`⇄`): `program`, `loan_type`, `ys_loan_number`, `investor_loan_number`, `actual_appraised_value`, `property_taxes`/`insurance`/`hoa`, `rental_income`, `LO`/`processor`/`underwriter` identity (both-agree rule).

---

## PART 5 — What still needs live confirmation against BE11397907

Once `api.elliemae.com` is on the environment's allowlist (and the credentials are rotated per the "never wire a chat-shared secret" rule), a one-shot admin endpoint can pull the tenant's field metadata and confirm:

1. Every `⚠︎ verify against instance` line above — mostly the `CX.*` custom-field names (case-sensitive) and the actual FICO field ID.
2. The exact PICKLIST labels for `program`, `loan_type`, `property_type`, `occupancy`, `channel`, `rehab_type` — populates `crosswalk.js`.
3. The tenant's actual MILESTONE list (may differ from the canonical 7-milestone set above; see `docs/appraisal-xml/research/underwriting-findings-platforms.md` §A11 Encompass Enhanced Conditions for the reference model).
4. Whether the tenant carries a `LO2` / secondary-loan-officer slot (some do) — decides whether the Multi-LO assignees model (`db/103`) needs a mirror on the Encompass side.

The proposal in Parts 1–4 is what the code lands as; Part 5 is the delta the live probe applies before merge.

---

## PART 6 — Next steps (for owner sign-off)

Please respond with:
1. **Approve / amend Parts 3A–3G row by row.** Any row you strike, we drop.
2. **Confirm PILOT-authoritative posture on identity (§3A).** The proposal is push-only-with-blanks-fill in Phase 1; a stricter "review every disagreement" posture is also on the table.
3. **Confirm milestone→status map (Part 2 table).** The 38-status ClickUp mirror is unusually detailed — a simpler map is fine if you'd rather.
4. **Rotate the ICE Developer Connect client secret** and re-set the new value directly in Render env (`ENCOMPASS_CLIENT_ID`/`_SECRET`/`_INSTANCE_ID`) — I never touch it in code / commits / config files.
5. **Ask Anthropic / whoever administers this Claude Code environment to add `api.elliemae.com` (and probably `api.icemortgagetechnology.com`) to the outbound-allowlist** so a session can complete Part 5.

Once (1)–(3) are signed off, we can start on the fields.js + crosswalk.js + mapper.js scaffold WITHOUT (4) and (5); those two only gate the live-instance probe + the eventual switch-on.
