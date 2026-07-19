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

## 0.1 Confirmed answers → build decisions (2026-07-19, round 2)

The owner answered the open questions and supplied Xactus's full request/response schema. Locked
decisions:

1. **Credentials are per-user; each officer sets their OWN Xactus login.** Surrogate ("on-behalf-of")
   ordering is **NOT** used (owner declined). So we store each user's `LoginAccountIdentifier` +
   password, **encrypted, write-only, verify-on-save** (§2). No shared system account.
2. **Auth transport recommendation: HTTP Basic (Authorization header), not URL-parameter auth.**
   Xactus's Communications page describes credentials as **URL parameters**, and the API also
   declares a `basicAuth` scheme. Prefer **Basic** — it keeps the password in a header instead of the
   URL, so it never lands in access logs / APM / proxy logs (URL-param credentials are the #1 leak
   vector, per the bug-hunt). Confirm in the test environment which the endpoint accepts; if only
   URL-params work, use them **but never log the URL** (redact query strings).
3. **Products & actions — build all, with defaults:**
   - **Default product = Pre-QualificationX (soft pull).** Also build **Credit ReportX (hard pull)**
     as a selectable option (owner added this), and Refresh. Actions per Xactus:
     Pre-Qualification = Submit / ForceNew / Reissue / Upgrade; Credit ReportX adds **Unmerge**;
     Refresh = Submit / Reissue.
   - **Default action = Reissue** (re-pull an existing report). The user can switch to a **brand-new
     order** (Submit/ForceNew) for reports not yet pulled, and can switch the product to the **hard
     pull** when they want. Soft-pull request uses `CreditReportType="Other"` +
     `CreditReportTypeOtherDescription="SoftCheck"`.
4. **Testing = the TEST environment** (`test.ultraamps.com`), using the Xactus **test personas**
   (synthetic names + SSNs) and the **test login**. No billing/compliance concern for tests.
   Certification: Xactus **reviews our incoming test requests** (mapping/format) and then grants
   **go-live** — so the build target is "clean, correctly-mapped requests Xactus can approve."
5. **Egress IP for Xactus allow-list:** the portal runs on the **same Render service**. We fetch the
   static outbound IP at test/go-live time (via a **rotated** Render key set in the environment — the
   one pasted in chat must be rotated first, §7).
6. **Score-mismatch = STANDARD CREDIT-SCORE BRACKET based (owner clarified 2026-07-19; see §8.1).**
   On import, **always** set the verified FICO and **freeze** it. The re-registration trigger is the
   **standard 20-point mortgage credit-score brackets** — `<620, 620–639, 640–659, 660–679, 680–699,
   700–719, 720–739, 740–759, 760–779, 780+` (the industry LLPA grid + a 780 line). If the verified
   score is in the **same
   bracket** as the estimate → update + freeze only, **no re-registration**. If it lands in a
   **different bracket** → set the new FICO, freeze, and **reopen the registration/pricing condition
   for a HUMAN to re-register** — **even if YS Capital's own price wouldn't change** ("reset it up the
   right way," owner). This is a **separate reset-trigger** from the pricing engine's own bands and
   **changes no frozen pricing numbers**. (Owner's example fits exactly: 718 & 700 both in `700–719`
   → no reset; 718 → 699 drops to `680–699` → reset.)
7. **Frozen bureau / no score → manual review.** The credit condition **cannot be signed off** until
   a human clears manual review confirming the program guidelines allow it. Leave a **per-program
   config hook** ("how many frozen/no-score bureaus each program allows") for later.
8. **Adverse-action / decline notices are built IN our system** (owner directive) — research the
   FCRA/ECOA-Reg B requirements and implement (compliance basis in `CREDIT-REPORT-INTEGRATION-BUGS.md`
   §8). **Permission to pull is taken verbally** — do **not** add a "capture signed authorization"
   step to the workflow (owner directive; noted as a compliance consideration, not a blocker).
9. **Borrower-facing view:** only **staff** can pull/reissue. Once a report is pulled, the **borrower**
   gets a **read-only section in their loan file** showing **their credit-report PDF** and **all their
   per-bureau credit scores** (Equifax / Experian / TransUnion). Staff-only for ordering; borrower-read
   for viewing.

### 0.1.1 The "bracket" = standard 20-point mortgage credit-score bands (owner clarified 2026-07-19)

The reset trigger uses the **industry-standard 20-point mortgage credit-score brackets** (the LLPA
grid boundaries — 620/640/660/680/700/720/740/760), which is what the owner's example describes:

`<620` · `620–639` · `640–659` · `660–679` · `680–699` · `700–719` · `720–739` · `740–759` · `760–779` · `780+`

- Owner's example fits exactly: estimate **718** and verified **700** are **both in `700–719`** → same
  bracket → no reset. Estimate **718** → verified **699** drops to **`680–699`** → **different bracket
  → reset**.
- This is a **separate reset-trigger** used only to decide whether to reopen re-registration; it is
  **not** a pricing calculation and **changes no frozen pricing numbers**. (FICO's own 5 broad
  categories — Poor/Fair/Good 670–739/Very Good/Exceptional — are too coarse and would put 700 and 699
  in the same "Good" band, contradicting the owner's example, so we do **not** use those.)
- Store the bracket set as **config** (one table/constant), so brackets can be adjusted later without
  touching pricing. Reset fires on a **different bracket even when the price is unchanged** — the owner
  wants the file "reset up the right way" regardless.

Sources: standard mortgage LLPA credit-score bands —
[emetropolitan LLPA tiers](https://www.emetropolitan.com/loan-programs/conventional-loan/credit-score-tiers/),
[719 Lending](https://www.719lending.com/does-your-credit-score-affect-your-mortgage-rate/);
FICO's 5 categories (too coarse, not used) —
[Experian](https://www.experian.com/blogs/ask-experian/credit-education/score-basics/what-is-a-good-credit-score/).

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

**Owner decision (2026-07-19): full per-user credentials, NOT surrogate ordering.** Each loan officer
enrolls with their own Xactus `LoginAccountIdentifier` + password, and **each user sets up their own
login** in the portal. (The research surfaced Xactus's "surrogate operator" pattern —
`generic:specific`, one system password — which would avoid storing individual passwords; the owner
**declined** it, so we store each user's credential, encrypted, per §2.3.) The provider adapter still
declares its auth style so a future provider *could* use surrogate ordering, but Xactus here = full
per-user credentials.

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

## 8. Underwriting stop + re-registration on mismatch (owner requirement)

**On EVERY import: set the verified FICO and freeze it (§7) — always.** Then compare to
`fico_used_for_pricing`:

### 8.1 Standard-bracket reset trigger (owner decision, 2026-07-19)

The re-registration trigger is the **standard 20-point credit-score bracket** the score falls in —
**not** "any difference," and **not** YS Capital's own pricing bands. Brackets (config):
`<620 · 620–639 · 640–659 · 660–679 · 680–699 · 700–719 · 720–739 · 740–759 · 760–779 · 780+`. Implementation:

- Compute the bracket of the **priced-on estimate** and the bracket of the **verified score**.
- **Same bracket** (e.g. estimate 718 → verified 700, both `700–719`): **update + freeze only. No
  re-registration.** Nothing to redo.
- **Different bracket** (e.g. estimate 718 → verified 699 = `680–699`), **even if the price wouldn't
  change**:
  1. Set + freeze the new verified FICO (always), then
  2. Raise a **fatal condition** `FICO_MISMATCH` that blocks sign-off / clearance-to-close, and
  3. **Reopen the registration/pricing condition** exactly like the existing economics-change reopener
     (`db/071`/`db/072` `trg_reopen_on_budget_change` → reopens `product_pricing`), setting the file to
     "re-register required."
  4. A **human re-registers** the loan on the new FICO (the system does **not** auto-re-register —
     owner directive). Only after a human re-registers does `fico_used_for_pricing` re-snapshot and the
     fatal clear.

Model it as a **state machine**, so "priced-on bracket ≠ verified bracket, not yet re-registered" is
**unrepresentable-as-approved**. A **newer** report later is a controlled **re-lock** (a dedicated
`import_verified_fico(report_id)` routine the freeze trigger recognizes), which writes the new value +
lineage, audits old→new, and re-runs this bracket check.

> **Frozen-engine safety:** the bracket set is a **separate config** used only to decide *whether to
> reopen re-registration* — it is **not** a pricing calculation and changes **no** frozen pricing
> numbers (per CLAUDE.md the engine stays frozen). Adjusting brackets later = a config edit, not an
> engine change.

---

## 9. Compliance guardrails specific to business-purpose (RTL) credit

- **Permissible purpose exists only for the personally-liable individual** (principal / guarantor /
  co-signer) — **not** the entity, and not a non-obligated party. Record a permissible-purpose basis
  (the originating application/loan) on every order. **Authorization is taken verbally** (owner
  directive, 2026-07-19) — do **not** add a signed-authorization capture step to the workflow.
  _(Compliance note, not a blocker: documented/written authorization is the industry best practice and
  the strongest audit defense; flagging it so the owner/compliance can revisit later if desired.)_
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

## 10. Risk register (condensed — **full catalog + hardening checklists in `CREDIT-REPORT-INTEGRATION-BUGS.md`**)

Top-priority, most-likely-silent bugs first (the full bug-hunt doc has the parser config, score-
extraction order, freeze-bypass hunt, Node/HTTP traps, incident lessons, and the regression fixtures):

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

## 11. Open items

**Resolved (2026-07-19, see §0.1):** soft-pull returns full tri-merge + PDF ✅ · credentials =
per-user, no surrogate ✅ · products = soft-pull default + hard-pull selectable ✅ · default action =
Reissue ✅ · **reset trigger = standard 20-point credit-score brackets** ✅ (§0.1.1/§8.1) · testing =
test environment with test personas ✅ · retention = never delete + 120-day reopen ✅ · borrower
read-only view ✅ · adverse action built in-system ✅ · permission taken verbally (no capture step) ✅.

**Still open — a few test-time confirmations only:**
1. **Auth transport (recommendation made; confirm at test time):** we'll use **HTTP Basic** (header)
   if the endpoint accepts it — safer than URL-param creds (which leak into logs). Verify against the
   test endpoint; fall back to URL-params with strict no-logging if Basic isn't accepted.
3. **Reissue on the soft product:** owner says yes; confirm once against the live test endpoint.
4. **Egress IP + go-live:** at test/go-live time, fetch the Render service's outbound IP (via a
   **rotated** Render key) and send it to Xactus for allow-listing; Xactus reviews our test traffic →
   grants go-live.

---

## 12. As-built (Phases 1a–1e, implemented 2026-07-19)

Built on branch `claude/credit-report-reissue-research-iwwpfk` (PR #319). Each phase was
independently unit/integration-tested; the DB layer is proven against real Postgres 16.
**Still not merged** — heavy audit + live-endpoint testing pending, per owner.

**1a — scoring engine** (`src/lib/credit/scoring.js`): per-borrower middle (median-of-3 /
lower-of-2 / the-1 / null), loan representative = highest borrower middle, 10 standard brackets
(incl. 760-779 / 780+), fail-closed model gate. 67 tests.

**1b — MISMO 2.3.1** (`mismo2-request.js` / `mismo2-response.js`): soft `Other`+`SoftCheck`
default, hard `Merge`, Reissue default; response parser hardened (DOCTYPE/ENTITY/HTML/truncation
rejected, both error layers, per-bureau scores, embedded PDF). 48 tests.

**1c — DB + FICO freeze** (`db/131`): provider registry, per-user encrypted credentials,
credit_reports/credit_scores, borrowers verified-FICO lineage + BEFORE INSERT/UPDATE freeze
belt (only the sanctioned reverify GUC may change a locked score) + audit. Freeze proven on PG.

**1d — per-user credentials** (`credit/providers.js`, `credit/credentials.js`,
`integrations/xactus.js`, `routes/staff-credit.js`, crypto `encryptSecret`/`decryptSecret`,
`pull_credit` capability): each officer's own write-only Xactus login; real MISMO-over-HTTPS
adapter (Basic auth, hard timeout, **never auto-retries a billable POST**, auth/http/network/
timeout/empty classification, circuit breaker). Staff settings screen + nav. 47 tests.

**1e — order/import + wiring** (`credit/import.js`, `db/132–135`,
`credit/reopen-sweep.js`, `credit/adverse-action.js`, staff panel + borrower card):
- Order journaled before the POST with an idempotency key (one intent bills at most once);
  import parses → scores → stores report/scores/PDF → freezes each borrower's verified FICO
  under the reverify GUC → captures `fico_used_for_pricing`.
- Frozen bureau / no score / vendor error → manual-review queue (stored, not frozen, never deleted).
- Internal credit condition wired (received on import, issue on review); 120-day reopen sweep.
- ClickUp FICO locked in AND out; verified score pushed out on import.
- Borrower read-only view (own PDF + every bureau score). 29 import + 26 reopen assertions.

### 12.1 Reconciliation with main's `db/126` (audit #28) — **important**
While this branch was parked, `main` shipped `db/126` §C: `trg_reopen_pricing_on_fico_change`,
which reopened Products & Pricing + the signed term sheet on **any** FICO change (raw value
compare). That is broader than the owner's rule (reopen only on a **bracket** change) and it
compared an **individual** borrower's score, not the loan representative. `db/132` supersedes the
function body (keeping main's trigger wiring):
- adds `fico_bracket(numeric)` — the SQL twin of `scoring.js` BRACKETS — and a throw-safe
  `fico_bracket_of_inputs(jsonb)`;
- compares `fico_bracket(representative)` where representative = `NULLIF(GREATEST(primary.fico,
  co.fico),0)` (the exact pricing expression) against the bracket the registration was priced on.

Result: a same-bracket drift (718→700) is a no-op; a co-borrower dropping below an unchanged,
higher representative is a no-op; only the **representative crossing a bracket** reopens — for a
human to re-register. This also fixes main's per-borrower over-firing on the manual-edit path.
Proven by `scripts/test-fico-bracket-reopen.sql` (single-borrower + co-borrower cases).

### 12.2 Deferred / needs owner or compliance input
- **Adverse-action** is a data-model + structured-draft scaffold only — every draft is flagged
  "for compliance review, not for delivery"; final notice content/timing/rendering + send is a
  compliance decision, not built autonomously.
- **V1 (`/app`) UI** not rebuilt — the credit UI is V2 (PILOT, the default) only; V1 is legacy.
- **Verify-on-save** is off by default (`XACTUS_VERIFY_ON_SAVE`) — a no-charge probe path must be
  confirmed with Xactus before enabling, so saving a login never accidentally bills.
- **Condition auto-advance** is intentionally conservative (evidence "received", never auto
  sign-off) — confirm the desired automation level with the owner.

---

_Design + Phases 1a–1e are built and pushed to the parked PR for review; the owner has directed
heavy auditing + live-endpoint testing before any implementation is trusted, and **no merge yet.**_
