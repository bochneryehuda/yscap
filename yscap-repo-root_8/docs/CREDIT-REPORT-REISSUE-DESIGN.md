# Credit Report Reissue + FICO Verification — Build Design (owner-requested, 2026-07-19)

_Research + design only — **nothing is implemented yet**. This is the "how we build it" companion
to `CREDIT-REPORT-REISSUE-RESEARCH.md` (the vendor/version research) and
`CREDIT-REPORT-REISSUE-FIELD-MAP.md` (the field-by-field map). Produced by a multi-agent research
sweep (field mapping, error handling, industry failure modes, per-user credentials, score-freeze /
underwriting) synthesized and grounded against the existing portal code. **No credentials,
passwords, SSNs, or live PII appear in this document.**_

> Owner directives captured (2026-07-19): more industry research on where these integrations go
> wrong; a full field map (how we read each field, how Xactus reads each field); error handling as
> robust as our other integrations; per-user + per-loan credit login screens; a "which credit
> provider" dropdown built to add more providers later (default = Xactus); import the XML **and**
> the PDF; verify FICO for underwriting; a **fatal** underwriting stop + **re-registration** when the
> imported FICO doesn't match; and once imported, the FICO is **hard-frozen everywhere** (portal,
> term sheet, ClickUp — inbound and outbound) so scores can't be manipulated. Tie it to the internal
> "credit report" condition **and** give it its own dedicated section. Start with **MISMO 2**. Lots
> of testing before we're comfortable. **Do NOT merge yet.**

---

## 0. Confirmed decisions (from the owner, superseding the open questions in the research doc)

1. **FICO cross-borrower rule = HIGHEST middle score.** Confirmed intentional. This already matches
   the portal's existing pricing, which uses `GREATEST(borrower.fico, co_borrower.fico)` — the
   highest score across the file's borrowers (`src/routes/borrower.js`, marked `#99`). Because RTL
   loans are **business-purpose** (not sold to Fannie/Freddie), the GSE "lowest representative score"
   convention does **not** bind — highest-across-borrowers is YS Capital's established credit-box
   rule. Per-borrower selection stays standard: **middle** of three, **lower** of two, the one if
   one, no-score path if zero.
2. **Product = SOFT-PULL pre-qualification only, for now.** Focus on the RTL product's soft pull
   (Pre-Qualification / Pre-App), **not** the full hard-pull Credit ReportX. Brand-new orders may
   come later, but the current build targets the soft pull. (Verify the soft product returns all
   three bureau scores + a PDF and supports reissue — see Open Items.)
3. **Retention: never delete.** The imported credit report stays on the file **permanently** (it
   never disappears). **But** if a file is still open and **unfunded 120 days after the credit
   report's effective date**, the credit-report condition **auto-reopens** (the report is expiring).
   The document itself is never removed. (120 days matches standard mortgage credit validity.)
4. **Start on MISMO 2.3.1**, behind a swappable payload layer (per the research doc §4).
5. **Do not merge** PR #319 or this work — park it for heavy research, auditing, and testing first.
6. **All data comes from the XML, never the PDF** (owner directive, 2026-07-19). See the callout below.

> ### 🔑 The XML is the data. The PDF is just a picture of it.
> Xactus's response is **structured XML** — every value we need (all three bureau FICO scores,
> tradelines, alerts, summary counters) is a machine-readable XML field. The report **PDF is
> embedded *inside* that same XML** (base64) purely as a human-viewable copy. So:
> - **We read every score and data point from the XML fields** — we do **not**, and must **not**,
>   try to extract data by "reading" the PDF (no PDF text-parsing / OCR is used or needed).
> - The PDF is decoded and **stored only so a person can open and view the official report**.
> - The verified FICO used for underwriting comes from the XML `CREDIT_SCORE` elements, full stop.
>
> This is confirmed against Xactus's field schema: the soft-pull (SoftCheck) response carries the
> complete tri-merge scores as XML **and** the embedded PDF. If a response ever arrived with only a
> PDF and no structured scores, that is an **error condition** → fail closed + manual review, never
> "read the PDF instead."

---

## 1. The whole flow, end to end

```
Loan officer sets their Xactus login (Settings)            ─┐  (per-user credential, §2)
                                                             │
Staff opens a loan file → "Credit report" section          ─┤  (dedicated section + internal condition, §5)
   picks provider (dropdown, default Xactus) → Reissue/Order │
                                                             ▼
Portal builds the MISMO 2.3.1 request  ───────────────►  Xactus (soft pull)   (§3 request, field map)
                                                             │
Response XML (scores + tradelines + embedded PDF)  ◄─────────┘
   • hardened parse (reject non-XML / truncated)             (§4 error handling)
   • extract 3 bureau scores per borrower                    (field map)
   • decode + store the PDF as a portal document
   • compute middle-per-borrower, highest-across-borrowers   (§6 scoring)
                                                             ▼
Verified FICO imported  ──►  HARD-FREEZE everywhere          (§7 freeze)
   • if verified ≠ priced-on FICO → FATAL + re-registration  (§8 underwriting)
   • manual review sign-off before condition satisfied       (§5 review)
```

---

## 2. Per-user / per-loan credentials + multi-provider (owner requirement)

### 2.1 The model

Today `src/config.js` exposes a **single global** `cfg.xactus` (one `XACTUS_USERNAME`/`PASSWORD`).
The owner wants **each user** to use **their own** Xactus login, selectable **per loan**, with a
**provider dropdown** that can grow to more providers. So we move from one system credential to a
**per-operator credential store** plus a **provider registry**.

**Strong recommendation surfaced by the research — the Xactus "surrogate operator" pattern.**
Xactus supports `LoginAccountIdentifier = genericoperator:specificoperator` (e.g. `losmain:john.smith`),
where **only the generic operator's password is sent** and **billing lands under the specific
operator**. This gives full per-officer attribution and billing **without storing every loan
officer's password** — we store each officer's operator ID (not secret) plus one system-level
generic password (in env/secret store). This is materially more secure than collecting individual
passwords and is worth confirming with Xactus before we build. **Design for both:** a provider
adapter declares whether it uses surrogate ordering or full per-user credentials.

### 2.2 Data model (proposed — build later)

```
credit_providers(id, key, display_name, enabled, capabilities jsonb)     -- 'xactus' seeded, enabled, default
user_credit_credentials(id, user_id, provider_id, operator_identifier,
    secret_ciphertext bytea, key_ref, status,                            -- ciphertext only; surrogate mode stores no per-user secret
    last_verified_at, created_at, updated_at)   UNIQUE(user_id, provider_id)
credit_orders(id, application_id, borrower_id, provider_id, credential_id,
    ordering_user_id, action_type, credit_report_identifier,             -- snapshot for audit + reissue
    permissible_purpose_basis, status, ordered_at, ...)
```

Resolution precedence at order time: **per-loan override → assigned officer's default → branch
default → error** ("you haven't set your credit login").

### 2.3 Credential-screen behavior (security — non-negotiable)

- **Write-only.** The API accepts a new value but **never returns it**. The screen shows only
  *configured / not configured*, *last updated*, *last verified OK* — never the password, never the
  full username.
- **Encrypt at rest** through the existing AES-256-GCM chokepoint (`src/lib/crypto.js`), ideally
  with a KMS-held key; never in env-as-plaintext-per-user, never in logs. Xactus passes credentials
  as URL/params — **those must never reach access logs** (redact query strings).
- **Verify-on-save**: a lightweight authenticated test call (not a live billed pull) confirms the
  login and stores pass/fail. Save-but-flag on failure.
- **Revocation**: offboarding nulls the ciphertext / disables the operator immediately; because each
  secret is independent, no mass re-encryption.

### 2.4 Multi-provider abstraction

Provider **registry + one adapter module per provider** (mirrors the existing
`src/lib/integrations/` one-module-per-vendor pattern). Shared core interface:

```js
order(request, creds)      -> CanonicalCreditReport
reissue(reportRef, creds)  -> CanonicalCreditReport
verifyCredentials(creds)   -> { ok, message }
parse(rawResponse)         -> CanonicalCreditReport
capabilities()             -> { reissue, joint, softPull, bureaus:[...] }
```

Core owns the canonical model, credential resolution, encryption, retry/timeout, audit,
permissible-purpose stamping, error taxonomy. The **adapter** owns vendor auth format, request
serialization (MISMO 2.3.1 XML for Xactus), and response parsing. The dropdown is just the registry's
enabled providers (default Xactus). Capability flags drive the UI (grey out "Reissue" if
unsupported). Adding a provider = one module + one registry row, no core changes.

---

## 3. Request (MISMO 2.3.1) — summary

Full detail in `CREDIT-REPORT-REISSUE-FIELD-MAP.md`. Minimum required elements (verified from
developer.xactus.com): `REQUESTING_PARTY` (the ordering entity), `SUBMITTING_PARTY _Name` ("YS
Capital Group LOS"), `CREDIT_REQUEST_DATA` (`CreditRequestID`, `BorrowerID`,
`CreditReportRequestActionType`, `CreditReportType`, `CreditRequestType`), `BORROWER` (name, SSN,
current residence), `CREDIT_REPOSITORY_INCLUDED` (Equifax/Experian/TransUnion Y/N). Transport is
**HTTPS POST, `Content-Type: text/xml`**. Individual = `Ind_CR_Request`; Joint = `Joint_CR_Request`
with multiple `BORROWER` blocks (distinct `BorrowerID`s). Reissue additionally requires the prior
`CreditReportIdentifier` and is only valid within 30 days (research doc §3).

---

## 4. Error handling — as robust as our other integrations

Xactus returns **two error layers**, and code must check **both**:
- **Envelope `STATUS`** — `_Condition` (`Success`/`Error`), `_Code`, `_Name`, `_Description`. A
  200 with `_Condition="Error"` is a failure.
- **Per-bureau `CREDIT_ERROR_MESSAGE`** — `_Code`, `_SourceType`, `_Text`. One envelope can be
  `Success` overall yet carry a bureau-level error, so parse to the repository level.

**Xactus error-code taxonomy** (from Xactus's published MISMO error list) and how we treat each:

| Codes | Meaning | Handling |
|---|---|---|
| **E001** | Unable to process, try later | **Retryable** (backoff) |
| E002–E035 | Invalid/missing borrower data fields | Client data error — fix + resubmit, **never auto-retry** |
| **E036/E037/E046/E051** | Bad account id / password / login / account not active | **Auth/entitlement** — stop, alert, never retry (lockout risk) |
| E061 | Reissue demographics don't match original | Business — review |
| **E101/E102** | Malformed / schema-invalid XML | Our bug — fail closed, alert |
| **E999** | Other error | Unknown → manual review |

There is **no distinct permissible-purpose code** — a denial likely surfaces as E051 or E999
(confirm with Xactus).

**200-OK "domain" failures that are NOT success** (must be surfaced to staff, never treated as a
pass): frozen/locked bureau file, no-hit / no-file, no-score / thin file, SSN/identity mismatch,
fraud alert / security freeze / deceased / OFAC, subject-not-found.

**Hardened parsing (before trusting anything):** require HTTP 2xx; `Content-Type` contains `xml`;
non-empty body starting with `<?xml`/`<`; reject `<!DOCTYPE html`/`<html`; parse with DTD/external-
entity resolution **disabled** (XXE), size + depth caps; any parse error = hard failure, never a
partial success. Only then read `STATUS` and scan for `CREDIT_ERROR_MESSAGE`.

**Mapped onto existing patterns** (mirror, don't reinvent):
- **Circuit breaker** like `src/clickup/client.js`'s volume breaker — count transport failures +
  E001/5xx/timeouts per rolling window per endpoint; open on threshold; half-open probe. **Do not**
  count client-data errors (E002–E035) toward it (those are our bugs).
- **Review queue** = reuse the `sync_review_queue` shape (db/108, db/110) — two-sided values +
  **actions**: *Re-order (freeze lifted)*, *Correct data & resubmit*, *Escalate to compliance*
  (fraud/deceased/OFAC), *Abandon*. Notify the file's loan officer like `sync-review.js` does.
- **Journaling** like `clickup_write_log` — one row per order (request/response meta, timing, HTTP
  status, envelope code, retry count) with **SSN/PII masked** and raw XML encrypted/redacted.
- **Idempotency / dedup** — a stable key = hash(SSN+name+product+action+time-bucket); check before
  ordering; suppress no-op re-orders within a TTL; a soft pull has no inquiry cost but duplicate
  orders still cost money and clutter the file.
- **Fail-closed** on any parse/truncation/unknown-condition — journal + queue, never fall through
  as an approval.

**Retry policy:** retry only transient failures (timeouts, TLS resets, 502/503/504, 429 honoring
`Retry-After`, E001) with exponential backoff + jitter, ~3–4 attempts; never retry data/auth codes.

---

## 5. Where it lives in the portal — dedicated section + the internal condition

The owner wants it tied to the **internal "credit report" condition** AND given its **own dedicated
section**. Both, because they serve different jobs:
- **Dedicated "Credit report" section** (staff file screen): the working surface — provider
  dropdown, "Order / Reissue" button, the three bureau scores per borrower, the computed
  middle/representative score, the embedded **PDF viewer**, order history, and error/review status.
- **Internal condition** (`internal_condition` → `item_kind='condition'`,
  `src/lib/conditions/types.js`): the checklist gate. It stays open until a human with
  `sign_off_conditions` reviews the reissued report and the verified score. A reissued score is
  **"proposed," not "verified,"** until sign-off. Nothing auto-satisfies silently.
- **Access**: gate ordering + viewing behind a new capability (e.g. `view_credit`/`pull_credit`),
  MFA-protected, least-privilege — like the existing capability gates in `src/lib/permissions.js`.

---

## 6. Score extraction & selection

The response carries **one `CREDIT_SCORE` per bureau per borrower** (`_Value`, `_ModelNameType`,
`CreditRepositorySourceType`). Extraction rules (grounded in the failure-mode research — these are
the most common silent bugs):

1. **Select by identity, never by position** — match each score by `CreditRepositorySourceType` +
   `_ModelNameType` + `BorrowerID`/SSN, not array order. Assert one score set per borrower.
2. **Validate the model per bureau** — Equifax=`EquifaxBeacon5.0`, Experian=`ExperianFairIsaac`,
   TransUnion=`FICORiskScoreClassic04`. Reject any non-mortgage variant (FICO 8/9/10T, VantageScore)
   before trusting a number.
3. **Per-borrower middle**: 3 scores → median (not average); 2 → lower; 1 → that one; 0 → **no-score
   path** (distinct state, never numeric 0 → review).
4. **Loan representative score = HIGHEST of the borrowers' middles** (owner rule; matches existing
   `GREATEST` #99).
5. **Cross-check XML vs PDF** — flag any score drift between the parsed XML and the rendered PDF.
6. **Base64 PDF decode** — the PDF lives in `EMBEDDED_FILE/DOCUMENT/<![CDATA[…]]>` (the authoritative
   Xactus 2.3.1 shape; the `FOREIGN_OBJECT/EmbeddedContentXML` shape from an owner-pasted sample is
   **not** in Xactus's 2.3.1 model — verify empirically, don't assume it). Strip any `data:` prefix +
   whitespace, validate length%4, decode **strictly** (Node's `Buffer.from(x,'base64')` is lenient
   and silently truncates at the first bad char — this already bit the SharePoint mirror, so reuse
   `lib/upload-bytes.decodeUploadBase64()`), and verify the result starts with `%PDF` / ends with
   `%%EOF`. Remember: the PDF is **stored for viewing only** — never a data source (§0 callout).

---

## 7. Hard-freeze the imported FICO (owner requirement)

Model **provenance as first-class data** rather than trying to protect one editable number. Two
distinct facts in two distinct places:

- `estimated_fico` — an attested estimate, freely editable **pre-import** (this is today's
  `borrowers.fico`, effectively).
- `verified_fico` + lineage: `verified_fico_source` (e.g. `equifax_beacon_5.0`),
  `verified_report_id`, `verified_pulled_at`, `verified_imported_at`, `verified_imported_by`,
  `fico_locked boolean`, `fico_used_for_pricing` (the snapshot the term sheet was built on).

**Enforce immutability at the database, not just the app** — the single most important design choice.
A Postgres `BEFORE UPDATE` trigger is the chokepoint **every** path funnels through (portal, ClickUp
sync worker, admin script, migration, a raw `psql` edit). Once `fico_locked=true`, any statement
changing `verified_fico`/`verified_report_id`/`verified_fico_source` is **rejected** — with one
narrow, audited exception: a **newer verified report** (§8). This mirrors the existing
belt-and-suspenders DB trigger `db/069_sow_budget_guard.sql`. Pair it with an **append-only audit**
(AFTER trigger) recording before/after, actor, timestamp, reason.

**Block the ClickUp sync from overwriting it** — extend the existing write-guards with a
**locked-field allowlist**:
- **Inbound (ClickUp→portal):** in the sync chokepoint, drop `fico` from any patch when
  `fico_locked=true` — do not COALESCE it, do not last-write-wins it. The DB trigger is the backstop.
  Today `src/clickup/mapper.js` maps `fico` as `dir:'both'`; once locked it becomes **read-only
  inbound**.
- **Outbound (portal→ClickUp):** push `verified_fico` + a locked flag so ClickUp shows it read-only
  too — this prevents a **round-trip** (a human hand-editing it in ClickUp and the sync carrying it
  back). If ClickUp can't lock the field, inbound must **reject-and-queue** any changed value as a
  "blocked write on locked field" review row rather than applying it.
- The lock is a **state, not a permanent property**: pre-import `fico` syncs both ways as today; the
  moment of import flips `fico_locked` and the field's ownership flips to portal-owned/read-only.

**UI is the last layer, never the control:** once locked, render read-only, hide the estimate input,
badge "Verified — locked (Equifax, pulled YYYY-MM-DD)". But the DB trigger is what actually stops
tampering.

**Freeze surfaces — ALL must enforce it** (a freeze is only as strong as its most-forgotten path):
the borrower field write (`src/routes/borrower.js`), staff writes (`src/routes/staff.js`), the
ClickUp inbound mapper, any admin override, migrations/bulk scripts (caught by the DB trigger; add a
CI check flagging migrations that touch the locked columns), the term sheet (reads
`fico_used_for_pricing`, not a typed value), and pricing (`src/lib/pricing.js` reads only
`verified_fico` once locked). No free-text override on `verified_fico`; the only sanctioned change is
re-import. If a break-glass override is ever needed, it is capability-gated, justification-required,
logged to the tamper-evident trail, and reviewed by someone who didn't make the change (segregation
of duties).

---

## 8. Underwriting fatal + re-registration on mismatch (owner requirement)

Define the fatal precisely: **`verified_fico` ≠ `fico_used_for_pricing`** (or it crosses a pricing/
eligibility band). On import or re-verify, compute the delta; if nonzero:

1. Raise a **fatal underwriting condition** `FICO_MISMATCH` that blocks any capability-gated sign-off
   and clearance-to-close (same hard-stop semantics as a fatal finding).
2. **Reopen pricing** exactly like the existing economics-change reopener (`db/071`/`db/072`
   `trg_reopen_on_budget_change` → reopens `product_pricing`): invalidate the current term sheet, set
   the file to "re-register / re-price required," rerun the pricing engine against `verified_fico`.
3. Force a **new registration** so priced-on = verified again; only then re-snapshot
   `fico_used_for_pricing` and clear the fatal.

Model it as a **state machine**, so "priced-on ≠ verified" is **unrepresentable-as-approved**. A
**newer** report later is a controlled **re-lock** (a dedicated `import_verified_fico(report_id)`
routine the trigger recognizes via a session variable), which writes the new value + lineage, audits
old→new, and re-fires this mismatch flow if it moved.

---

## 9. Compliance guardrails specific to business-purpose (RTL) credit

- **Permissible purpose exists only for the personally-liable individual** (principal / guarantor /
  co-signer) — **not** the entity, and not a non-obligated party. Gate every pull behind a recorded
  permissible-purpose basis tied to that individual, and get written authorization before pulling.
- **Adverse action is two separate duties**: FCRA §615 (owed to the borrower; a *mere* guarantor
  generally is not owed one) **and** ECOA/Reg B business-credit track (keyed to the $1MM revenue
  threshold). Build an adverse-action workflow that fires on decline/counteroffer and pulls score +
  factors from the report.
- **No re-disclosure of the raw report to note investors** — share only lender-derived attributes;
  the investor pulls their own. (Reinforces "keep the report on the file, don't forward it.")
- **Retention**: keep the report permanently on the file (owner rule), but honor the FTC Disposal
  Rule's secure-destruction expectations for anything that does leave, and log permissible purpose +
  ordering operator + CRA reference on every order (retain the audit ~5 years minimum).
- **Test SSNs stay out of real permissible-purpose paths** — environment-scoped credentials + a
  test-persona denylist in prod (see the testing plan in the research doc / Open Items).

---

## 10. Risk register (condensed — full catalog from the failure-mode sweep)

Top-priority, most-likely-silent bugs first:

| # | Risk | Mitigation |
|---|---|---|
| R1 | Reading the wrong score node / wrong FICO model | Select by model+bureau+borrower; assert mortgage models; unit-test vs sample XML |
| R2 | Lenient base64 truncates the PDF silently | Strict decode + `%PDF`/`%%EOF` check via the existing chokepoint |
| R3 | Wrong "middle" (average vs median; 2/1/0-score cases) | Explicit median; per-cardinality branches; no-score = distinct state |
| R4 | Stale report used to fund / 30-day reissue expiry / 120-day validity | Store pull date; block funding past validity; auto-reopen at 120 days |
| R5 | SSN/identity mismatch, mixed file, wrong borrower | Verify returned SSN/name/DOB vs application; reject on mismatch; surface bureau ID alerts |
| R6 | Frozen/locked bureau file treated as low score | Detect freeze per bureau; count usable repositories; route to review |
| R7 | Manual edit / CRM overwrite of the verified score | DB trigger freeze + locked-field allowlist (§7); log every blocked write |
| R8 | Permissible-purpose / re-disclosure / adverse-action miss | §9 gating + workflows; per-order permissible-purpose basis |
| R9 | PII leak (logs, cleartext, PDF, creds in code) | Redact/mask; encrypt at rest; least-privilege; secrets in vault/env only |
| R10 | Duplicate pulls / double-billing / runaway loop | Idempotency key + dedup + circuit breaker |
| R11 | Truncated/non-XML response parsed as success | Hardened parse + required-node presence check; fail closed |
| R12 | Test-vs-prod mixup, IP allow-list misconfig, date/timezone | Env guards; register egress IP; store UTC timestamps |

---

## 11. Open items to confirm before build

1. **Xactus soft-pull capabilities** — ✅ **RESOLVED by the field-schema research.** The
   Pre-Qualification (`SoftCheck`) response returns the **full tri-merge** scores (Beacon 5.0 /
   Experian-FairIsaac / FICO Classic 04) **as structured XML** plus the embedded PDF — structurally
   identical to a hard `Merge`. Request it with `CreditReportType="Other"` +
   `CreditReportTypeOtherDescription="SoftCheck"`. (Still worth a one-line confirm with Xactus that
   `Reissue` behaves the same on the soft product.)
2. **Credential model**: does our Xactus agreement allow the **surrogate-operator** pattern
   (`generic:specific`, one system password) — or must each officer be enrolled as a separate
   operator with their own password? (Security + build effort hinge on this.) **Confirm with
   Integrations@xactus.com.**
3. **Auth transport**: Xactus API reference says `basicAuth`; the Communications page says
   credentials go as request params (`LoginAccountIdentifier`/`LoginAccountPassword`). Confirm which
   our endpoint expects.
4. **Production-only testing**: how to run the synthetic test personas against production safely
   (no real billing, no permissible-purpose issue), plus IP allow-listing steps and any certification
   checklist. (Being researched; also a question for Xactus.)
5. **Permissible-purpose + adverse-action** workflow scope for RTL — confirm the business rules with
   the owner/compliance before wiring §9.

---

_Nothing here is built. This design goes on the parked PR for review; the owner has directed heavy
auditing + testing before any implementation, and **no merge yet.**_
