# Credit Report — Enhancements Design (import everything, detect risk, view in detail)

**Status: RESEARCH + DESIGN (owner-directed 2026-07-19). Not built yet — this doc is the
plan.** Extends the shipped credit-reissue + FICO-verification feature
(`docs/CREDIT-REPORT-REISSUE-DESIGN.md`, field map `docs/CREDIT-REPORT-REISSUE-FIELD-MAP.md`).
Grounded in the live parsers/schema; MISMO + FCRA/GLBA claims are cited in §9.

## 0. What the owner asked for → the five enhancements

> "saving username and password for every officer to have more features … the entire
> system should import more information … create blocks for every single borrower every
> single Bureau FICO score … create your own interface to view more details … import
> high risk details … if there is any fraud alert you should alert … if you see high
> mismatching alerts that should go for the underwriting section to review."

| # | Enhancement | Summary |
|---|---|---|
| E1 | **Import the whole report as per-borrower / per-bureau "blocks"** | Parse tradelines, inquiries, public records, collections, and the bureau-reported identity — not just scores — into new encrypted tables, one block per borrower × bureau. |
| E2 | **Fraud alerts + identity mismatches → underwriting review / file alert** | Parse the alert element + reported identity; generalize the single `underwriting_finding` into a LIST of findings; route each signal to a red file alert and/or a sign-off-blocking review. |
| E3 | **A rich credit-report detail interface** | A new staff "View full report" screen: per-borrower tabs, per-bureau score columns, tradeline/inquiry/public-record/collection sections, and a prominent Alerts/Risk panel. |
| E4 | **Credential enhancements** | Verify-on-save badge, health (last-used/invalid), rotation nudges, usage metering, "test my login", optional admin-managed shared fallback. |
| E5 | **Compliance + data-protection layer** | Because E1 stores far more PII: encrypt-at-rest, mask account numbers, scope to the file's team, audit every view, retention + secure disposal. This is a constraint on E1–E4, not a separate screen. |

## 1. What's imported today (the gap)

The parsers (`src/lib/credit/mismo2-response.js`, `mismo3-response.js`) extract ONLY:
per-bureau **scores + factor codes**, **which bureaus** were included, **borrower names/SSN**,
error/status text, and the **PDF**. The raw response is kept encrypted
(`credit_reports.xml_encrypted`, AES-256-GCM). Tables today: `credit_reports`,
`credit_scores`, `credit_fico_audit`, `credit_order_events`, `credit_providers`,
`user_credit_credentials`, `adverse_action_letters`.

**Everything else in the report — tradelines, inquiries, public records, collections, the
bureau-reported addresses/employers/aliases, and the fraud/security ALERT element — is
present in the XML we already store, but never parsed out.** So these enhancements are
mostly *new parsing + new tables + new UI*, with the raw bytes already on hand.

Two helpers make this cheap to add:
- The parsers already have clean XML-walkers — 2.3.1 `A(node,'X')` (reads `@_X`), 3.4
  `findAll(node,key)` / `findFirstText(node,key)` deep-scans, `asArray()`, `attr()`.
- `import.js` already attributes rows to a borrower **SSN-first, `B1`/`C1` label fallback**
  (`dbIdFor`), and already filters echo/authorized-user parties down to the requested SSNs.
  Every new block reuses that exact resolver — no new attribution logic.
- `src/lib/credit/outcomes.js` already has a risk vocabulary (`conditionFromText()` →
  `fraud` / `ofac` / `deceased` / `mixed_file` / `frozen` / `no_hit`) that is currently
  **only fed error text** because the parsers don't surface alerts. E2 feeds it the alert
  element — a small, high-leverage wire-up.

---

## 2. E1 — Import the full report as "blocks"

### 2.1 New tables (`db/169_credit_report_blocks.sql`, idempotent)

Every table mirrors `credit_scores`: `credit_report_id uuid REFERENCES credit_reports(id) ON
DELETE CASCADE`, `borrower_id uuid REFERENCES borrowers(id)`, `report_borrower_id text`
(`B1`/`C1`), `bureau text`. Indexes on `(credit_report_id)` and `(borrower_id)`. `raw jsonb`
per row for audit/fallback. All `IF NOT EXISTS`.

- **`credit_tradelines`** — creditor_name, creditor_address, account_type,
  account_ownership_type (Individual / **AuthorizedUser** / Joint), account_status_type,
  **`account_identifier_masked`** (`••••1234`) + **`account_identifier_encrypted bytea`**
  (never plaintext), unpaid_balance, credit_limit, high_credit, monthly_payment,
  past_due_amount, charge_off_amount, date_opened, date_reported, date_closed,
  last_activity_date, months_reviewed_count, current_rating_code/_type, late_30/60/90_count,
  payment_pattern text, derogatory_indicator bool, **is_collection** bool,
  **is_authorized_user** bool.
- **`credit_inquiries`** — inquiry_date, inquiring_party_name, business_type, loan_type.
- **`credit_public_records`** — record_type (bankruptcy/lien/judgment), filed_date,
  reported_date, disposition_type/_date, amount, court_name, docket_identifier,
  plaintiff_name, derogatory_indicator.
- **`credit_collections`** — collection_agency_name, original_creditor_name, amount, status,
  date_reported. (Often *derived* from a tradeline classified as a collection.)
- **`credit_report_identities`** — reported_name, aliases jsonb, dob date, **`ssn_masked`**
  (never raw — the real SSN already lives encrypted on `borrowers`), current_address jsonb,
  former_addresses jsonb, employers jsonb, infile_date, alert_messages jsonb.

Sensitive fields (account numbers, SSN, DOB, full addresses) are **encrypted or masked** — see
§6. The full raw block always remains inside `credit_reports.xml_encrypted`; these tables hold
structured/masked values for display and querying.

### 2.2 Element → field map (abridged; full map in §9 sources + the in-repo field map)

| Block | 2.3.1 (attribute-centric) | 3.4 (element-centric) |
|---|---|---|
| Tradeline | `CREDIT_LIABILITY @_AccountType/_UnpaidBalanceAmount/_CreditLimitAmount/…`, child `_CREDITOR`, `_CURRENT_RATING`, `_LATE_COUNT`, `_PAYMENT_PATTERN`, `CREDIT_REPOSITORY@_SourceType` | `CREDIT_LIABILITY/CREDIT_LIABILITY_DETAIL/CreditLiability*`, containers `CREDIT_LIABILITY_CREDITOR`, `…_CURRENT_RATING`, `…_LATE_COUNT`, `…_PAYMENT_PATTERN`, `CREDIT_REPOSITORIES/CREDIT_REPOSITORY` |
| Inquiry | `CREDIT_INQUIRY @_Date/_Name/@CreditBusinessType` | `CREDIT_INQUIRY` (party) + `CREDIT_INQUIRY_DETAIL/CreditInquiryDate` |
| Public record | **no native element** — `CREDIT_SUMMARY` counters + tradelines flagged `MiscellaneousAndPublicRecord` | `CREDIT_PUBLIC_RECORD/CREDIT_PUBLIC_RECORD_DETAIL/CreditPublicRecord*` (rich) |
| Collection | carried as a `CREDIT_LIABILITY` (classify) | carried as a `CREDIT_LIABILITY` (agency = `CREDIT_LIABILITY_CREDITOR`) |
| Identity | `CREDIT_FILE/_BORROWER @_FirstName/_BirthDate/_SSN`, repeating `_RESIDENCE`/`_ALIAS`, `_UnparsedEmployment`, `_ALERT_MESSAGE` | `PARTY/ROLES/ROLE/BORROWER` → `NAME`, `RESIDENCES/RESIDENCE/ADDRESS`, `EMPLOYERS/EMPLOYER`, `BIRTH/BirthDate` |

### 2.3 Per-borrower / per-bureau grouping (drives the UI)
- **Borrower:** reuse `dbIdFor` (SSN-first, `B1`/`C1` fallback); write both `borrower_id` and
  `report_borrower_id`. 3.4 attributes each liability/inquiry via the same `RELATIONSHIP`
  xlink the scores use (or the per-borrower `CREDIT_RESPONSE` subtree); 2.3.1 reads
  `@BorrowerID` directly.
- **Bureau:** from `CreditRepositorySourceType`. Store `bureau` on every row.
- **Render:** `SELECT … WHERE credit_report_id=$1` grouped by `(borrower_id, bureau)` →
  **one block per borrower × bureau** — exactly "a block for every borrower and every bureau."

### 2.4 Parsing gotchas (must design around — from the parser research)
1. **Tri-merge echoes each account once per bureau** (single-repository each). Do **NOT** dedup
   on import — those three rows *are* the per-bureau blocks. Any cross-bureau rollup dedups by
   (creditor + account_identifier + opened date).
2. **2.3.1 array-of-one bug:** `CREDIT_LIABILITY`, `CREDIT_INQUIRY`, `_LATE_COUNT`, `_RESIDENCE`,
   `_ALIAS`, `CREDIT_COMMENT` must be added to `ARRAY_NODES` or a single occurrence collapses to
   an object. 3.4's `findAll` deep-scan already handles repeats.
3. **AuthorizedUser inflation:** honor `AccountOwnershipType="AuthorizedUser"` → set
   `is_authorized_user`; those aren't the borrower's obligation.
4. **Version asymmetry:** 2.3.1 has no native public-record/collection element — a 2.3.1 report
   fills `credit_public_records` only from summary counters + flagged tradelines; 3.4 fills the
   rich columns. UI degrades gracefully.
5. **Keep values as strings until the DB cast** (both parsers disable numeric coercion to avoid
   the `"030"`→30 bug); cast amounts/dates only at the boundary with `NULLIF(…,'')::numeric/date`
   and `sanitizeDateOnly` (vendor dates are untrusted — see the shipped date-safety fix).
6. **Run block attribution *after* the existing echo/AU party filter** so phantom borrowers
   don't spawn phantom blocks.

---

## 3. E2 — Fraud alerts + identity mismatches → review / alert

### 3.1 Parse the alert element + reported identity (new)
- Add `alerts[]` to each parsed report: 3.4
  `CREDIT_RESPONSE/CREDIT_RESPONSE_ALERT_MESSAGES/CREDIT_RESPONSE_ALERT_MESSAGE`
  (`CreditResponseAlertMessageCategoryType` + text); 2.x `CREDIT_RESPONSE/ALERT_MESSAGE`
  (`@_Type` + `MessageText`, `@BorrowerID`).
- Add **reported DOB + residence** to each borrower (2.3.1 `BORROWER/_BirthDate` + `_RESIDENCE`;
  3.4 `INDIVIDUAL/BIRTH/BirthDate` + `ADDRESS`) so mismatches can be computed.

### 3.2 Signal catalog + routing

**FILE ALERT** = red banner on the file + notify the loan officer (reuse `src/lib/notify.js`),
no sign-off block. **UNDERWRITING REVIEW** = a **fatal finding** that forces the credit
condition to `issue` and hard-blocks sign-off (`signOffGate` + the `db/168` trigger) until
reconciled — the same path as today's `fico_mismatch`.

| Signal | MISMO 3.4 category | Routing | Severity | Reconcilable by |
|---|---|---|---|---|
| Initial / extended / active-duty fraud alert | `FACTAFraudVictim*`, `FACTAActiveDuty` | Review + Alert | fatal | staff (after identity verification) |
| OFAC / SDN hit | `Other`+text / OFAC msg | Review + Alert | fatal | **compliance only** (not officer) |
| Deceased / SSA Death-Master | `DeathClaim` | Review + Alert | fatal | **compliance only** |
| SSN not-issued / issued-before-DOB / SSN mismatch | `DemographicsVerification` | Review + Alert | fatal | staff |
| Address discrepancy (§605(h) / Red Flags) | `FACTAAddressDiscrepancy` | Review | fatal | staff (documented) |
| Name/DOB mismatch, mixed-file | (self-computed / bureau) | Review | fatal (mixed-file) / warning | staff |
| High-risk fraud score (FraudPoint) | `FACTARiskScoreValue` | Alert; Review above threshold | warning→fatal | staff |
| Security freeze | `CreditFileSuppressed` | Alert (already → `frozen` review) | warning | borrower unfreezes |
| Consumer statement, authorized-user alert, high-risk address | `Other` / risk text | Alert | warning | staff |

**Identity mismatch = reported-vs-file:** compare the parsed reported identity against the
file's `borrowers` row (name normalized + token-compare, SSN **last-4** when masked, DOB
date-string compare, address via house-number + suffix-normalized street tokens — reuse the
`norm()` approach in `src/lib/sharepoint-map.js`). **Prefer the bureau's own alert** (its
`FACTAAddressDiscrepancy` *is* the §605(h) notice) over self-computed, with the self-diff as a
backstop.

### 3.3 Generalize one finding → a LIST (back-compat is the trick)

`underwriting.js` `ficoMatchFinding()` already emits `{type, severity, message, …}`. Generalize:
- Add pure builders: `fraudAlertFindings(alerts)`, `idMismatchFindings(reported, file)`,
  `ofacFinding`, `deceasedFinding`, `addressDiscrepancyFinding` — each returns
  `{type, severity, code, message}` or null. Add `collectFindings({verified, claimed,
  perBorrower, alerts, reported, file})` returning an **array**.
- **Storage stays back-compatible:** keep `credit_reports.underwriting_finding` but store a
  **wrapper** `{ severity: <max of all>, types:[…], findings:[ {type, severity, code, message,
  reconciled:false, reconcilableBy} ], message: <joined> }`. Because the wrapper still exposes a
  top-level `severity`, **the existing `db/168` trigger and `signOffGate` keep gating with zero
  schema change**.
- **New migration `db/170_credit_findings_multi.sql`:** change the gate predicate from "top-level
  severity fatal & reconciled null" to "**any** element of `findings[]` is `severity='fatal'`
  AND `reconciled=false`", via `jsonb_array_elements`; recompute the mirrored top-level
  `severity` when a finding is reconciled so the app-layer gate agrees. Per-finding reconcile in
  `staff-credit.js` (an underwriter may clear `fico_mismatch`/`id_mismatch`, but **`ofac`/
  `deceased` are non-reconcilable by an officer** — escalate to compliance/BSA-AML). Idempotent
  backfill mirrors `db/168`.
- `import.js` replaces the single `finding` compute with `collectFindings(...)`; sets
  `effectiveDecision='review'` when any fatal finding exists; the `[auto]` note joins all fatal
  messages. `outcomes.js conditionFromText()` gets fed the alert element (already knows
  `fraud`/`ofac`/`deceased`/`mixed_file`).
- The React `FindingBanner` renders `findings[]` as a list (not one line); `/credit/review-queue`
  already surfaces `status IN ('review','in_doubt')`, so a fatal finding lands there
  automatically.

### 3.4 Compliance duties (required behavior, not advisory)
- **Fraud / active-duty alert (FCRA §605A):** before extending credit, form a reasonable belief
  of identity OR contact the consumer at the alert's phone; an **extended** alert *requires* the
  call. → an identity-verification reconcile step before credit sign-off.
- **Address discrepancy (§605(h) / Red Flags Rule):** maintain reasonable procedures to form a
  reasonable belief the report is the applicant's. → a required, documented reconcile.
- **OFAC/SDN:** verify the flagged match; a true match → OFAC Hotline + block/report, do not fund.
  Non-reconcilable by the officer.
- **Deceased / SSN-not-issued:** possible identity theft — stop and verify (mirrors today's
  `deceased` block in `outcomes.js`).

---

## 4. E3 — The credit-report detail interface

New **`GET /api/staff/credit/reports/:id/detail`** (gated `pull_credit` + `canSeeApp`, audited on
open) feeding a new **`CreditReportDetail`** screen/modal opened from a "View full report" action
on each `ReportRow`. `CreditReportPanel` stays the order/reissue + summary; the detail screen is
the rich reader. Layout (existing PILOT tokens in `app-v2/src/styles.css`):
- **Per-borrower tabs** (primary / co-borrower) — reuse the `.pill`/`.nav` pattern, `--teal`
  active.
- **ALERTS / RISK panel, top and prominent** — reuse the `FindingBanner` treatment (`notice err`
  + `borderLeft:4px solid var(--danger)`): fraud alerts, freezes, active-duty, SSN/address/DOB
  mismatches, and the FICO-mismatch finding. The single most valuable new surface.
- **Per-bureau score columns** — `grid cols-3` (Equifax/Experian/TransUnion), each a `panel` with
  score + model + date + usable/excluded + factor codes (reuse `BureauLine`).
- **Collapsible sections**, account numbers masked to last-4 by default: **Tradelines** (creditor,
  type, `••••1234`, balance, limit, status, past-due, worst delinquency, dates; status colored
  `--ok`/`--warning`/`--danger`; wide tables in `.table-scroll`), **Inquiries**, **Public
  records**, **Collections**, **Reported identity** ("as reported by the bureaus").
- **Footer:** the existing "Open full report PDF" + a capability-gated, audited un-mask toggle for
  account numbers.

**Borrower self-service — do NOT widen.** Keep the current guards: their own scores + factor
codes + representative bracket + (single-borrower) PDF only. **Never** account numbers (not even
last-4), tradelines, inquiries, public records, collections, reported SSN, raw XML, another
borrower's data, or joint PDFs. The new tables live **only** behind the staff route.

---

## 5. E4 — Credential enhancements (on `credentials.js` + the capability model)

1. **Verify-on-save badge** — `xactus.verifyCredential` is a no-charge auth probe returning
   `ok|invalid|unverified`; show the badge (behind `pull_credit`, never a testing oracle, never
   blocks the save).
2. **Health** — add `last_used_at`; `markStatus` already flips `invalid` on a 401/403. Surface
   "Verified / Last used / Invalid → re-enter your login."
3. **Rotation nudge** — optional `password_updated_at` + max-age → "time to rotate" (in-app +
   notify). A rotation always re-supplies the secret (`setForUser` refuses a blank).
4. **Multiple providers** — already supported (`user_credit_credentials` keyed
   `(user_id, provider_id)`); just enable more `credit_providers` as CRAs come online.
5. **Optional admin-managed shared fallback** — when an officer has none, `getUsable()` may fall
   back to an admin-owned shared credential. **Off by default, admin-only, every pull audited
   with the acting officer's id** (permissible purpose attaches to the human). Prefer per-officer;
   shared is a stopgap.
6. **Usage metering** — reuse the spend-breaker query (`count(*) FILTER (WHERE ordered_by=$1)`)
   → "pulls this month" per officer.
7. **"Test my login"** — on-demand verify probe → badge; `pull_credit` gated + rate-limited,
   never returns the secret, audited `credit_credential_verify`.

Cross-cutting (already the code's posture — keep): never return the secret/ciphertext; a decrypt
failure fails loudly (never order with a blank password); rotate on compromise; audit set/remove/
verify with non-secret facts only.

---

## 6. E5 — Compliance + data-protection layer (constrains E1–E4)

- **Encrypt at rest (GLBA Safeguards Rule, 16 CFR 314.4(c)(3), mandatory):** every new PII/account
  field is encrypted via the existing GCM chokepoint (`crypto.encryptSecret`) — never a plaintext
  jsonb. Encrypt account numbers, full tradeline/inquiry/public-record/collection detail, and
  reported identity. Consider separating a credit master key from `SSN_ENCRYPTION_KEY` (the code
  already anticipates this).
- **Mask account numbers to last-4** everywhere by default; full un-mask is a separate,
  capability-gated, individually-audited action (NIST 800-122 high-sensitivity; GLBA
  access-limitation).
- **Access = the file's team** — every detail route gated `pull_credit` + `canSeeApp`
  (`VISIBLE_OFFICERS_SQL`/assignees). No company-wide read. One pull = one permissible purpose;
  never reuse a stored report for a new file/decision.
- **Audit every view** — full-report open, tradeline expand, account un-mask each write an
  `audit_log` row (actor, report, application) via `audit()`, non-secret facts only.
- **Retention + secure disposal** — Reg B record retention (12 CFR 1002.12): **12 months** for
  business-purpose credit (these RTL loans are business-purpose), longer if under investigation;
  keep the adverse-action packet at least that long. FACTA Disposal Rule (16 CFR 682): set a
  defined window, then destroy (cryptographic erasure — drop/rotate the record's key — or hard
  delete, logged). Keep the derived scores (`credit_scores`) as the durable record; **age out the
  full raw report**. Data-minimization: don't keep everything forever.
- **Never expose to the borrower** — the detail data must not widen the borrower endpoint.

---

## 7. Phased build plan (each phase = its own PR, two-audit gate, DB-gated tests)

- **P1 — Parse + store the blocks (E1).** Extend both parsers (`alerts[]`, reported DOB/residence,
  tradelines/inquiries/public-records/collections/identity), add `ARRAY_NODES` entries (2.3.1),
  `db/169_credit_report_blocks.sql`, persist in `import.js` reusing `dbIdFor`. Tests: parser unit
  tests over fixture XML (2.3.1 + 3.4, single + joint, AU account, tri-merge echo), a DB import
  test asserting block rows + masking + encryption.
- **P2 — Findings engine (E2).** Generalize `underwriting.js` to `collectFindings()` + the wrapper
  shape; `db/170_credit_findings_multi.sql` (gate iterates `findings[]`, per-finding reconcile,
  non-reconcilable OFAC/deceased, idempotent backfill); feed `outcomes.js` the alerts; LO notify
  on new fatal findings. Tests: builder unit tests per signal; SQL trigger test (any-fatal blocks,
  per-finding reconcile clears, OFAC not officer-clearable); e2e HTTP (alert import → banner →
  review-queue → reconcile).
- **P3 — Detail interface (E3).** `/reports/:id/detail` route + `CreditReportDetail` screen; render
  smoke across personas (clean / tradelines / alerts / joint); API-matrix additions (access +
  mask + audit). Rebuild the V2 bundle.
- **P4 — Credential features (E4).** Health/rotation/metering/test-login/shared-fallback;
  settings-screen updates; credential + audit tests.
- **P5 — Compliance hardening (E5).** Retention/disposal job + un-mask audit + key-separation;
  disposal/retention tests. (E5 rules apply from P1 — this phase adds the automated disposal +
  key separation.)

Sequence P1 → P2 → P3, then P4/P5. Ship behind the existing config gates; keep the borrower
endpoint untouched until explicitly asked.

## 8. Open questions for the owner (decide before/along the build)
1. **Retention window** for the full raw report + block detail (default proposal: business-purpose
   Reg-B floor of 12 months + a buffer, then cryptographic erasure; scores kept indefinitely).
2. **Shared fallback credential** — do we want it at all, or per-officer only? (Recommendation:
   per-officer only; shared blurs "who pulled" for FCRA.)
3. **Which mismatches block sign-off vs. just alert** — the §3.2 table is the proposed default;
   confirm the fatal-vs-warning split (esp. name/DOB self-computed mismatches, which are noisier
   than the bureau's own alert).
4. **OFAC handling** — confirm OFAC/deceased are compliance-escalations, not officer-clearable.
5. **Borrower visibility** — keep the detail staff-only (recommended), or later expose an
   own-data-only minimized tradeline view to the borrower?

## 9. Sources
- MISMO 3.4 model (Pilotfish viewer): CREDIT_LIABILITY(_DETAIL), CREDIT_INQUIRY(_DETAIL),
  CREDIT_PUBLIC_RECORD(_DETAIL), CREDIT_RESPONSE_ALERT_MESSAGE / `CreditResponseAlertMessageCategoryType`.
- Xactus OpenAPI `CreditReport_MISMO2.yaml` (basis of the in-repo `CREDIT-REPORT-REISSUE-FIELD-MAP.md`);
  Xactus Credit ReportX Reference Guide (alerts / Hawk Alert / IDVision).
- MISMO Credit Reporting Implementation Guide (v2 XML guide: `ALERT_MESSAGE _Type`/`MessageText`; v3.5 guide).
- FCRA §605A (fraud/active-duty alerts), §605(h) address discrepancy + SR 08-7, §604 permissible purpose.
- OFAC FAQ 70 (screening/blocking). FACTA Disposal Rule 16 CFR 682. GLBA Safeguards Rule 16 CFR 314
  (encryption at rest/in transit). Reg B record retention 12 CFR 1002.12. NIST SP 800-122 (PII).

*(Full URLs are in the three research-agent transcripts for this session; cite them inline when
implementing each phase.)*
