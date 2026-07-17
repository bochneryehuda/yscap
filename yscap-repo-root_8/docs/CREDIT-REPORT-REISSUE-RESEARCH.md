# Credit Report Reissue + FICO Verification — Research Blueprint (owner-requested, 2026-07-17)

_Research only — **nothing is implemented and nothing should be built yet**. This document
was produced by recovering the owner's briefing message + the Xactus test-data spreadsheet,
compressing them into a source brief (below), then running a multi-agent research sweep over
MISMO, Xactus, FCRA/GLBA, and FICO/GSE scoring sources, synthesized and grounded against the
existing portal code. **No credentials, passwords, SSNs, or live PII appear in this document** —
those live only in the secret store / owner's onboarding packet (see §7)._

> Scope note from the owner: this is a **test environment**; we are preparing, researching, and
> deciding — not deploying. "Very careful security, very careful guards, very careful manual
> review." Build happens in a later, separate work order once this blueprint is approved.

---

## 0. Source brief (compressed from the owner message + attachment)

**Goal.** Turn the portal's existing *internal condition* "credit report" checkpoint into a real,
automated **credit-report reissue**: pull the credit report **XML + PDF** back from the bureau
vendor for staff review, and **verify the FICO scores** off that report.

**FICO verification rule (as stated by the owner).** Use **all three** bureau FICO scores per
borrower; take the **middle score of each borrower**; then between the two borrowers use the
**highest of the two middle scores** ("highest middle score between the two borrowers"). See
§5 — this is the reverse of the traditional GSE *lowest*-representative-score rule, so it needs
an explicit product decision.

**Vendor.** **Xactus** (Xactus360 platform; product **Credit ReportX**). Contact: Kisha Parker,
API Coordination, `Integrations@xactus.com`. API docs: `https://developer.xactus.com/`.
Test-case files: `https://xactus.com/test-files/`.

**Two API flavors to choose between (§4 decides):**

| | MISMO 2.3.1 ("MISMO 2 XML") | MISMO 3.4 ("MISMO 3 XML") |
|---|---|---|
| Test endpoint | `https://test.ultraamps.com/uaweb/mismo` | `https://test.ultraamps.com/uaweb/mismo3` |
| Prod doc host | `developer.xactus.com` (Credit API — MISMO 2.X) | `developer.xactus.com` (Credit API — MISMO 3.X) |
| XML style | attribute-centric, leading-underscore attrs (`_FirstName`, `_SSN`), `<REQUEST_GROUP MISMOVersionID="2.3.1">` | element-centric, namespaced, `<MESSAGE MISMOReferenceModelIdentifier="3.4"><DEAL_SETS>…` |
| Required submitting-party id | `SUBMITTING_PARTY _Name = "YS Capital Group LOS"` | `PARTY/ROLES/ROLE_DETAIL = "YS Capital Group LOS"` |

**Auth.** HTTP **Basic** (Xactus API reference declares `basicAuth`; the Communications page
expresses the same credentials as `LoginAccountIdentifier` / `LoginAccountPassword`, URL-encoding
reserved chars). A **surrogate / on-behalf-of** ordering pattern is supported —
`LoginAccountIdentifier = genericoperator:specificoperator` (e.g. `losmain:john.smith`), billed under
the ordering operator. `SUBMITTING_PARTY _Name` identifies the **software/platform** ("YS Capital
Group LOS"); `REQUESTING_PARTY` identifies the **entity placing the order**. **Credentials are NOT in
this repo** — secret store / env only (§7). Transport is **HTTPS POST, `Content-Type: text/xml`**.
Only **US IP addresses** may reach production; company/operator-level IP allow-listing is supported.

**The reissue action.** In the Credit ReportX request, `CreditReportRequestActionType` accepts
**`Submit`, `ForceNew`, `Reissue`, `Upgrade`, `Unmerge`**. Our feature centers on **`Reissue`**
(re-retrieve an already-ordered report) — see §3 for exact semantics.

**Response shape (from the sample the owner pasted).** `RESPONSE_GROUP` →
`CREDIT_RESPONSE` with, per borrower (`BorrowerID`), one `CREDIT_SCORE` **per bureau**:

```xml
<CREDIT_SCORE BorrowerID="B1" CreditRepositorySourceType="Equifax"    _Value="734" _ModelNameType="EquifaxBeacon5.0"/>
<CREDIT_SCORE BorrowerID="B1" CreditRepositorySourceType="Experian"   _Value="732" _ModelNameType="ExperianFairIsaac"/>
<CREDIT_SCORE BorrowerID="B1" CreditRepositorySourceType="TransUnion" _Value="730" _ModelNameType="FICORiskScoreClassic04"/>
```

(middle of 734/732/730 = **732**). Tradelines arrive as `CREDIT_LIABILITY` elements. The **report
PDF** comes back **base64-encoded** — but note there are **two possible container shapes** and the
parser must handle whichever the live endpoint actually returns (verify empirically in test):
- **Per the owner's pasted sample:** `VIEW` → `VIEW_FILES` → `VIEW_FILE` → `FOREIGN_OBJECT` →
  `<EmbeddedContentXML>…</EmbeddedContentXML>` with `MIMETypeIdentifier=application/pdf`,
  `ObjectEncodingType=Base64`.
- **Per the live Xactus response reference:** an `EMBEDDED_FILE` container with a
  `DOCUMENT __cdata="[base64]"` child plus `_MIMEType`, `__Type`, `__Name`, `__Extension`,
  `__EncodingType`.

Do not hard-code one path — detect both. Errors arrive as a `STATUS` element (`_Condition="Error"`,
`_Code`, `_Description`) + `CREDIT_ERROR_MESSAGE` (`_Code`). Codes seen in the owner's samples:
`E101` "File Is Not Well Formed XML", `E999` "Other Error / RequestData not found"; Xactus also
publishes a downloadable **MISMO Error Code List** to map against.

**Test-data catalog (the attached `.xlsx`).** ~90 Xactus-provided synthetic borrower personas for
scenario testing (test SSNs in the non-issued `9xx-xx-xxxx` range — **not** real people). Columns:
Borrower Info/PII, Credit Data, Alerts, Scores, Mortgage, Revolving, Auto, Education, Other
Installment, Public Records, Collections/Charge-offs, plus per-bureau (TransUnion/Experian/Equifax)
account/past-due/late counts, and scenario notes (FRAUD ALERT, ACTIVE DUTY, bankruptcy chapters,
frozen files, SSN-mismatch, "credit established before age 18"). Directly useful personas:
- **`BANK MIDSCORE`** — purpose-built to exercise the middle-score selection.
- **`FMAC Joint Test Case`** / **`FMAC Joint Test Case (2 Bureaus Frozen)`** — two-borrower cases
  for the cross-borrower representative-score logic and frozen-file handling.
- **`Alice Firstimer` / `FNMA & FMAC Test Case (No Scores)`** — the no-score path.

The catalog is the vendor's; keep the raw file **out of the repo** (it holds full synthetic PII
rows). Reference it from the secret store / shared drive.

---

## 1. What this feature does (in portal terms)

Today the portal's Condition Center has an **`internal_condition`** type — an *"Internal
checkpoint"* (`src/lib/conditions/types.js`: `internal_condition → { itemKind: 'condition' }`).
Staff currently satisfy the "credit report" checkpoint by hand.

This feature automates that checkpoint:

1. Staff (or a rule) triggers a **credit report reissue** for a loan file's borrower(s).
2. The portal calls Xactus **Credit ReportX** with `CreditReportRequestActionType="Reissue"`.
3. The response XML is parsed: per-borrower per-bureau **FICO scores** are extracted, and the
   embedded **PDF** is decoded and stored as a portal document (a new `doc_kind`, e.g.
   `credit_report`), mirrored to SharePoint like every other document.
4. The portal computes each borrower's **middle score** and the loan's **representative score**
   (per the rule decided in §5), writes it to the borrower `fico` field
   (`field-registry.js` key `fico`, range-guarded 300–850 in `engine.js`), and records the raw
   score set for audit.
5. A **manual-review gate**: a human with `sign_off_conditions` reviews the reissued report/scores
   before the internal condition is marked satisfied. Nothing auto-satisfies silently (§6).

**Why "reissue" and not "order".** The lender (or its LOS) already ordered the underlying report;
reissue re-retrieves that same report as XML+PDF for our review and score verification, rather than
generating a brand-new bureau pull. Exact reissue semantics and required identifiers: §3.

---

## 2. The two integration surfaces & recommended architecture

Matches the existing integration pattern in this codebase (raw `fetch`, credentials from
`src/config.js`, one module per vendor under `src/lib/integrations/`). There is already a
stub: **`src/lib/integrations/xactus.js`** — but it currently assumes a *JSON* `/credit/order`
API with a bearer-token login. **That stub is a placeholder and does not match the real Xactus
credit API**, which is **MISMO XML over HTTP Basic**. The stub's `authHeader()`/`pullCredit()`
JSON shapes must be replaced with the XML request/response mapping below; keep its
`configured()`/`ensure()` guard pattern.

Planned module layout (build later):
- `src/lib/integrations/xactus.js` — auth (Basic), `reissueCredit()`, environment/endpoint
  selection (test vs prod), US-IP note, error mapping.
- `xactusMismo.js` (or inline) — build the request XML and parse the response XML
  (scores, liabilities, embedded PDF, error `STATUS`). Pick **one** MISMO version (§4).
- Wiring at the condition/checklist call site — store PDF as a document, write `fico`, gate on
  manual review.

XML parsing in Node: use a small, well-audited parser (e.g. `fast-xml-parser`) rather than a
regex. Attribute-heavy v2 XML maps cleanly to a parser configured to keep `_`-prefixed attributes;
v3 needs namespace-aware handling. No new heavyweight dependency is warranted.

---

## 3. Reissue semantics (the crux) — ✅ confirmed from developer.xactus.com

**`CreditReportRequestActionType="Reissue"` re-retrieves an EXISTING report — it does NOT re-pull
the bureaus.** Verified from the Xactus build-request docs: Reissue *"permits a reissue of an
existing credit report"* and *"will always return the original credit report, even if that report
has subsequently been upgraded."* **No new hard/soft inquiry is generated.** This is exactly the
behavior our feature wants: re-retrieve the already-ordered report as XML+PDF for staff review and
score verification.

**Required identifier.** To reissue you must reference the existing report via the
**`CreditReportIdentifier`** attribute on the request (Xactus example value `"1102123"`; in the
sample the owner pasted it was `"1202696"`). So the portal must **capture and store the
`CreditReportIdentifier`** from the original order/response to be able to reissue later.

**⚠️ 30-day window.** By default, **reissues are only permitted within 30 days** of the original
merged-report order. After that, a reissue will fail and a *new* order (`Submit`/`ForceNew`) is
required. This is a hard operational constraint — the feature must handle "report too old to
reissue" as a first-class case (surface it to staff; don't silently fall back to a fresh pull,
which costs money and creates a new inquiry).

**The full action-type vocabulary (verified):**

| Action | What it does | New inquiry / cost? | Needs `CreditReportIdentifier`? |
|---|---|---|---|
| **`Reissue`** | Returns the original stored report (even if later upgraded); 30-day window | No | **Yes** |
| `Submit` | Requests a report; **auto-reissues within 30 days if borrower data matches** | Usually no within 30d | No |
| `ForceNew` | Forces fresh data from the repositories regardless of any existing report | **Yes** (true re-pull) | No |
| `Upgrade` | Adds a repository to / removes a borrower from an existing report | Partial | Yes |
| `Unmerge` | Separates merged repositories (Credit ReportX only) | No | Yes |

**Design consequence:** our verification flow is a **`Reissue`** against a stored
`CreditReportIdentifier`. If genuinely refreshed bureau data is ever needed, that is **`ForceNew`**
(new inquiry, new cost, stricter permissible-purpose posture) — keep it a separate, explicitly
gated action, never an automatic fallback.

**Permissible purpose (see §6):** a reissue does **not** create a new permissible purpose — it must
trace to the **same** consumer-initiated transaction as the original order. Log the
permissible-purpose basis (originating application) on every reissue.

---

## 4. MISMO 2.3.1 vs MISMO 3.4 — which to use

**Both flavors satisfy our exact use case** (reissue XML+PDF, extract FICO). The choice is about
longevity vs. today's maturity, and there is a real tension:

**The strategic pull is toward MISMO 3.4.** MISMO has formally **deprecated and frozen 2.3.1**
(*"no longer recommended… no longer supported"*) and directs credit trading partners to v3.4+.
v3.x is the unified, namespaced Reference Model (`MESSAGE > DEAL_SETS > … > SERVICE > CREDIT`), it
is what the rest of the modern LOS stack already speaks (ULDD/URLA/DU/LPA/UAD), and only v3.x
cleanly carries the FHFA-era enhancements (FICO 10T / VantageScore 4.0, trended data).

**The pragmatic pull is toward MISMO 2.3.1 *for credit specifically*.** Credit reporting lagged the
rest of the industry: **most trading partners still transmit the actual credit payload in 2.3.1
today**, Xactus's **MISMO2 credit documentation and reissue flow are the more mature, deeply-built-out
path** (the MISMO3 credit pages exist but are thinner), and 2.3.1 is flatter and cheaper to parse in
Node (attribute-centric, no namespaces). The owner's own pasted samples — request, tri-merge
response with all three FICO scores, and the embedded PDF — are all 2.3.1.

### Recommendation

**Build the first working integration on MISMO 2.3.1, behind a payload-format abstraction that
makes 3.4 a later swap — and get Xactus to confirm mismo3 credit parity before committing to it
long-term.** Rationale, given the owner's "very careful, must run smoothly" bar:

1. **Lowest execution risk now:** 2.3.1 is Xactus's most battle-tested credit path, fully documents
   `Reissue`, and its response shape (scores, liabilities, embedded PDF) is already in hand from the
   owner's samples — so we can build against known-good XML rather than a thinner spec.
2. **Fully covers the use case:** reissue, embedded Base64 PDF, and per-bureau FICO
   `CREDIT_SCORE` are all present in 2.3.1. Nothing in our scope *requires* v3.
3. **Cheaper, safer parsing:** flat attribute XML → `fast-xml-parser` with `ignoreAttributes:false`;
   no namespace traversal through 6–8 container levels.

This is **not** a vote against 3.4 as the eventual target — it is a sequencing call. **Isolate the
request-builder and response-parser behind one interface** (`xactusMismo.js`) so the wire format is a
config choice, and **ask Xactus (Integrations@xactus.com) to confirm the `…/mismo3` credit endpoint
returns the embedded PDF and full FICO score/liability data at parity with mismo2, and that
`Reissue` is fully supported there.** If/when parity is confirmed and the FHFA new-score models
matter, migrate the parser to 3.4 without touching the rest of the feature.

_(The MISMO research agent's standalone strategic recommendation was "3.4 primary, ~70% confidence."
The adjustment to "2.3.1-first, abstracted" reflects this project's specifics: credit is the one
payload that stayed on 2.3.1, Xactus's 2.3.1 credit docs are the mature ones, and we already hold
known-good 2.3.1 samples — so 2.3.1-first is the lower-risk path to a working, well-guarded feature,
with 3.4 kept one abstraction away.)_ **Confirm the version with the owner — Open Question §8.3.**

---

## 5. FICO score selection logic — ⚠️ the owner's cross-borrower rule is the inverse of the GSE standard

**This is the single most important finding in this document. Please confirm before any build.**

### 5.1 Per-borrower middle score — the owner's rule is CORRECT ✅

Fannie Mae Selling Guide **B3-5.1-02** is explicit and matches the owner exactly:
- **3 scores** → use the **middle**. (If two of the three are identical, that value *is* the middle.)
- **2 scores** → use the **lower**.
- **1 score** → use it.
- **0 scores** → no-score path (manual underwrite / flag; see the persona `FNMA & FMAC Test Case (No Scores)`).

Scores are never averaged and the highest is never cherry-picked *at the individual-borrower level*.
So "use the middle score of each borrower" is right.

### 5.2 Cross-borrower (loan) representative score — the owner's rule is BACKWARDS ⚠️

The owner's rule says: take the **highest** of the two borrowers' middle scores.
The GSE standard (Fannie B3-5.1-02) is the **opposite**: the loan's representative score is the
**LOWEST** applicable (middle) score across all borrowers.

Worked example:

| | Bureau scores | Middle |
|---|---|---|
| Borrower A | 700 / 720 / 740 | **720** |
| Borrower B | 640 / 660 / 680 | **660** |

- **GSE representative score = 660** (the *lower* of 720 and 660).
- **Owner's stated rule = 720** (the *higher*).

Using the **higher** middle score **overstates** the loan's qualifying credit. If that number ever
drives GSE eligibility or LLPA pricing, it would misprice the loan and create repurchase /
compliance exposure. Unless YS Capital is intentionally computing a **non-GSE internal metric**
(e.g. a clearly-labeled "best-borrower" indicator that is *never* used for GSE delivery or
pricing), the verification engine should default to the **lowest** middle score across borrowers.

**Design decision: make direction a configurable, audited constant — never hard-coded folklore.**
`CROSS_BORROWER_SCORE_POLICY = 'lowest' | 'highest'`, default `'lowest'` (GSE), with the owner's
`'highest'` selectable but labeled non-GSE, and the chosen policy stamped into the audit record for
every verification. **Recommend confirming with the owner that "highest" was intentional and not a
spec slip.** (See Open Question §8.2.)

### 5.3 FICO models in the tri-merge — validated as the GSE-required "Classic FICO" ✅

Fannie B3-5.1-01 requires exactly these three classic models, one per bureau — and they match the
`_ModelNameType` values in the Xactus sample the owner pasted:

| Bureau | Required model | `_ModelNameType` in Xactus XML |
|---|---|---|
| Equifax | Beacon® 5.0 (FICO Score 5) | `EquifaxBeacon5.0` |
| Experian | Experian/Fair Isaac Risk Model V2 (FICO Score 2) | `ExperianFairIsaac` |
| TransUnion | FICO Risk Score Classic 04 (FICO Score 4) | `FICORiskScoreClassic04` |

The parser should **validate the model identifier per bureau** and flag/reject any
consumer-education or non-mortgage FICO variant before treating a number as a verifiable bureau
score.

### 5.4 2025-2026 model transition — treat methodology as a versioned parameter

The convention is genuinely in flux, which affects what "verified" means:
- **Today (mainstream, safe default):** Classic-FICO tri-merge with Middle/Lower-then-**Lowest**.
- **FHFA transition:** move to **FICO 10T** and **VantageScore 4.0**, with an optional **bi-merge**
  (two bureaus). On **2026-07-01** the GSEs released historical datasets and disclosed an
  **"Average then Average"** loan-level methodology (average each borrower's bureau scores, then
  average across borrowers) for the new models — this replaces "lowest-of-lowest" *for those
  models*. As of mid-2026: VantageScore 4.0 is in limited rollout, FICO 10T approved but not yet
  deliverable, bi-merge date TBD.

**Implication:** the scoring engine should treat the methodology (tri-merge Middle/Lower-then-Lowest
vs. Average-then-Average) as a **versioned parameter tied to the score model**, since they are not
interchangeable. Ship Classic-FICO tri-merge now; leave a seam for the new models.

---

## 6. Security, compliance & guardrails

The stored credit XML/PDF is both "customer information" (GLBA) and "consumer report information"
(FCRA), which triggers concrete obligations. Grounded in existing portal safeguards where they
already exist:

**Regulatory obligations**
- **FCRA §604 permissible purpose.** A mortgage application is a qualifying "credit transaction
  involving the consumer." A **reissue does not create a new permissible purpose** — it must trace
  to the **same** consumer-initiated transaction as the original order. Re-disclosing the report to a
  *different* party (investor, another lender) is a separate re-disclosure that needs its own
  permissible purpose and usually Xactus/CRA contractual authorization. **Log the
  permissible-purpose basis (the originating, ideally signed, application) on every reissue.**
- **GLBA Safeguards Rule (16 CFR 314, 2023 update):** designate a Qualified Individual; **encrypt
  customer information at rest and in transit**; access controls reviewed periodically; **MFA** for
  systems holding this data; **log authorized-user activity** and monitor for unauthorized access.
- **FCRA Disposal Rule (16 CFR 682) + Safeguards retention default:** dispose so data can't be
  reconstructed; default retention **no later than two years after last use** unless a documented
  legitimate business need / other law requires longer. **Set retention by policy — do not keep
  indefinitely by default** (Open Question §8.5).

**Technical guardrails (what to actually do in this codebase)**
- **SSN at rest**: reuse the existing AES-256-GCM chokepoint `ssnForStorage()` / `encryptSSN()` in
  `src/lib/crypto.js` (iv‖tag‖ciphertext in `bytea`). SSN sent to Xactus must be **decrypted only
  in-memory at call time, never logged**.
- **Encrypt the report blobs**: the full response XML and the PDF also contain SSN/DOB/account
  numbers — encrypt them (envelope/field-level, keys managed separately from the DB), don't store
  the raw XML in a cleartext jsonb. Store the PDF as an **access-controlled portal document**.
- **PII redaction**: extend the existing `src/lib/redact.js` `redactPII()` discipline (it already
  strips SSN-ish keys from stored jsonb) to credit XML/PDF handling — **never log full report
  bodies**; scrub SSN/DOB/account numbers to placeholders in app and audit logs; mask SSN to last-4
  in the UI; strip PII from error traces.
- **Access control / least privilege**: capability gates already exist
  (`sign_off_conditions`, `see_all_files`, `manage_conditions`; `src/lib/permissions.js`). Add a
  dedicated capability (e.g. `view_credit` / `pull_credit`) so reissuing and *viewing* a report are
  need-to-know, MFA-protected, and revoked on departure.
- **Transport & network**: HTTPS POST, `Content-Type: text/xml`. Production is **US-IP-only** with
  IP allow-listing at company/operator level — our **outbound egress IP(s) must be registered with
  Xactus** (§7). Confirm Render's static outbound IP set.
- **Audit logging**: immutable, timestamped record of who **reissued / viewed / exported** each
  report, plus the permissible-purpose basis and the score-policy version used.

**Mandatory manual-review gate.** A reissued score is **"proposed," not "verified,"** until a human
with `sign_off_conditions` signs off. The system should confirm before offering sign-off: (a) the
three bureau scores parsed from the XML match the PDF, (b) each `_ModelNameType` is the required
Classic-FICO model for that bureau (§5.3), (c) the correct methodology **and the correct
lowest-vs-highest cross-borrower direction** (§5.2) was applied, and (d) frozen-bureau / missing-score
/ fraud-alert conditions are surfaced. Store the verification decision with reviewer identity and the
exact inputs used. **Nothing auto-satisfies the internal condition silently.**

---

## 7. Credentials & setup checklist for the owner (nothing secret stored here)

What we have (in the owner's onboarding email, kept in the secret store — **not** this repo):
test endpoints (2.3.1 + 3.4), a `LoginAccountIdentifier`/`LoginAccountPassword`, the required
submitting-party name "YS Capital Group LOS", and the test-file catalog.

To stand up the integration (later):
1. Store credentials in the secret store / env only: `XACTUS_USERNAME`, `XACTUS_PASSWORD`,
   `XACTUS_ENDPOINT` (already in `src/config.js` → `cfg.xactus`), plus an env for the chosen MISMO
   version and the test-vs-prod host. Never commit them; never echo them in logs.
2. Register the portal's **outbound egress IP(s)** with Xactus (US-IP-only + operator IP
   allow-listing). On Render, confirm the static outbound IP set.
3. Confirm the exact **production** endpoints and the go-live/certification steps with Kisha /
   Integrations@xactus.com (test uses `test.ultraamps.com`; prod host per the API docs).
4. Confirm the reissue identifier contract (§3) and the required submitting-party naming for the
   chosen version.
5. Decide the FICO cross-borrower policy (§5) in product terms and record it.
6. **Persist the `CreditReportIdentifier`** from every original order/response — without it, a
   reissue is impossible (§3). Plan the schema (a `credit_reports` table keyed by
   application + borrower, holding the identifier, order date, the 30-day reissue-eligibility
   window, and the encrypted blob reference).

> **Security note (per repo policy):** the test password shared in chat is considered
> **compromised** the moment it lands in a transcript. It is fine for throwaway test use, but have
> **Xactus reset/rotate it before production**, and set the real value only in Render's env — never
> in code, a commit, or this doc.

---

## 8. Open questions for the owner

1. **Reissue vs order**: is our source-of-truth report always already ordered elsewhere (so we
   only ever `Reissue`), or does the portal sometimes need to `Submit`/`ForceNew` a brand-new
   pull? This changes cost, permissible-purpose posture, and required identifiers.
2. **FICO cross-borrower rule**: confirm **highest** middle score (owner's stated rule) vs the GSE
   **lowest** convention — or make it configurable and pick a default. (§5)
3. **MISMO version**: accept the §4 recommendation, or is there an LOS/downstream constraint that
   forces one version?
4. **Which product**: Credit ReportX (full) vs Refresh vs Pre-QualificationX (soft) for the
   verification step.
5. **Retention**: how long may we keep the reissued XML/PDF, and where (portal document store +
   SharePoint mirror), given FCRA disposal obligations.

---

## 9. Test strategy (from the Xactus persona catalog)

The attached `.xlsx` is Xactus's own synthetic test catalog (~90 personas; test SSNs in the
non-issued `9xx-xx-xxxx` range — not real people). Build the test matrix from it so every branch of
the reissue + score-verification logic is exercised **before** any production call. Directly-mapped
scenarios:

| Scenario to prove | Persona(s) in the catalog |
|---|---|
| Middle-score selection (3 scores) | **`BANK MIDSCORE`** (purpose-built) |
| Two-borrower representative score (lowest vs highest) | **`FMAC Joint Test Case`** |
| Frozen bureau file(s) | **`FMAC Joint Test Case (2 Bureaus Frozen)`**, `Frozen` |
| No-score / thin-file path | **`Alice Firstimer` / `FNMA & FMAC Test Case (No Scores)`** |
| SSN mismatch handling | *"Input SSN Check: SSN does not match…"* persona |
| Fraud / FACTA alerts | `ART VANDELE` (extended fraud alert), active-duty alert persona |
| Bankruptcy chapters | Chapter 7 / Chapter 13 / dismissed personas |
| Derogatory / repossession | `AUTO REPOS` |

Test flow: (1) run against the **test endpoints** only; (2) parse scores + PDF; (3) assert the
computed middle score and loan representative score match the persona's expected values; (4) confirm
the score-model identifiers are the required Classic-FICO models (§5.3); (5) confirm error personas
produce a graceful, staff-visible failure — never a silent pass. Keep the raw catalog **out of the
repo** (it holds full synthetic PII rows); reference it from the shared drive / secret store.

Remaining appendix work (added once §3/§4 are confirmed and the version is chosen): full
request/response XML skeletons for the chosen MISMO version, field-by-field score-extraction
pseudocode, and the full persona-by-persona expected-result matrix. **No build begins until this
blueprint is approved.**

---

## 10. Sources

**MISMO version**
- MISMO Reference Model — https://www.mismo.org/standards-resources/residential-specifications/reference-model
- MISMO Version 3.4 — https://www.mismo.org/standards-resources/mismo-product/mismo-version-3-4
- MISMO Version 2 Residential Specifications — https://mismo.org/standards-and-resources/residential-specifications/xml-schema/mismo-version-2
- Certified Credit — "New Changes Coming to Credit Scoring Models & Credit Reporting" (2.3.1 no longer recommended/supported) — https://www.certifiedcredit.com/new-changes-coming-to-credit-scoring-models-credit-reporting/
- MISMO XML Implementation Guide: Credit Reporting, Version 2 — https://silo.tips/download/xml-implementation-guide-credit-reporting-version-2

**Xactus API**
- Xactus developer docs (home / catalog) — https://developer.xactus.com/
- Credit API — MISMO 2.X — https://developer.xactus.com/apis/creditapis/creditreport_mismo2
- Order Credit ReportX (action types incl. Reissue) — https://developer.xactus.com/apis/creditapis/creditreport_mismo2/other/create-credit-report
- Build Request / Communications / Response — https://developer.xactus.com/apimd/creditapis/a2_mismo2_cr_build_request , https://developer.xactus.com/apimd/creditapis/a3_mismo2_cr_submit_request , https://developer.xactus.com/apimd/creditapis/a4_mismo2_cr_receive_response
- Credit ReportX Reference Guide (Xactus360) — https://xactus.com/wp-content/uploads/2025/01/Credit-ReportX-Reference-Guide-for-Xactus360-Form-1.pdf

**FICO / GSE scoring**
- Fannie Mae Selling Guide B3-5.1-02 (representative score; multiple-borrower = lowest) — https://selling-guide.fanniemae.com/sel/b3-5.1-02/determining-credit-score-mortgage-loan
- Fannie Mae Selling Guide B3-5.1-01 (required Classic FICO models) — https://selling-guide.fanniemae.com/sel/b3-5.1-01/general-requirements-credit-scores
- FHFA Credit Scores policy — https://www.fhfa.gov/policy/credit-scores
- Fannie Mae Credit Score Models & Reports Initiative — https://singlefamily.fanniemae.com/originating-underwriting/credit-score-models
- MBA Advocacy Update (Jul 2026, FICO 10T / VantageScore 4.0 "Average then Average") — https://newslink.mba.org/mba-newslinks/2026/july/mba-newslink-tuesday-july-7-2026/mba-advocacy-update-gses-release-historical-data-for-vantagescore-4-0-fico-10t-adoption-more/

**FCRA / GLBA / security**
- 15 U.S.C. §1681b — Permissible purposes — https://www.law.cornell.edu/uscode/text/15/1681b
- FTC — Safeguards Rule: What Your Business Needs to Know — https://www.ftc.gov/business-guidance/resources/ftc-safeguards-rule-what-your-business-needs-know
- FTC — Disposing of Consumer Report Information — https://www.ftc.gov/business-guidance/resources/disposing-consumer-report-information-rule-tells-how
- CFPB — Permissible Purposes final rule — https://www.consumerfinance.gov/rules-policy/final-rules/fair-credit-reporting-permissible-purposes-for-furnishing-using-and-obtaining-consumer-reports/

_Research produced 2026-07-17 by recovering the owner's briefing + attachment and running a
multi-agent research sweep (MISMO, Xactus, FCRA/GLBA, FICO/GSE), synthesized and grounded against
the existing portal code. No credentials, passwords, SSNs, or live PII appear in this document._
