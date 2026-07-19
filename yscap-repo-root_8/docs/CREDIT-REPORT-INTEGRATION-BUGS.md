# Credit Report Integration — Bug-Hunt & Hardening Checklist (2026-07-19)

_Research only — nothing implemented. The "where it can go wrong, and how we stop it" companion to
`CREDIT-REPORT-REISSUE-DESIGN.md`. Consolidates two multi-agent research rounds (industry failure
modes, XML/MISMO parsing traps, real-world incidents/litigation, FICO score-selection edge cases,
and Node/Postgres implementation traps). Every item is a concrete failure + a mitigation. **No live
PII/credentials here.** Sources are listed per section at the end._

**How to read this:** §1 is the short list of the highest-leverage, most-likely-**silent** bugs —
read it first. §2–§8 are the full hardening checklists by area. §9 is real-world incident lessons.
§10 is the regression-test fixture list that proves we handled all of it.

---

## 1. Top of the risk register (silent, high-impact — build these first)

| # | The bug | Why it's dangerous | The guard |
|---|---|---|---|
| **B1** | Reading `CREDIT_SCORE._Value` and coercing to int **before** checking `_ExclusionReasonType` and asserting the model | A no-score reject code (`9001/9002/9003`) or a `0` becomes a fake 300–850 score → mispriced loan, silently | Check exclusion attr → assert model per bureau → range-guard, **in that order** (§3) |
| **B2** | Wrong FICO model used (consumer FICO 8/9/10T or VantageScore instead of the mortgage classics) | VantageScore 3/4 is **also** 300–850, so a range check won't catch it — only a model assertion will | Assert `_ModelNameType` == the contracted model per bureau; mismatch = hard error (§3) |
| **B3** | `Buffer.from(x,'base64')` silently truncates the PDF at the first bad char | A corrupt/half PDF is stored with **no error** (this already bit our SharePoint mirror) | Reuse `lib/upload-bytes.decodeUploadBase64()`; verify `%PDF`…`%%EOF`; length sanity (§4) |
| **B4** | Retrying the **billable order POST** | Duplicate inquiries + duplicate charges (~$80–100/pull) | DB unique constraint / advisory-lock dedup; never blind-retry a non-idempotent POST (§5) |
| **B5** | XML parser numeric coercion on | `"030"`→`30`, `"0E68"`→`0`, long account ids lose precision — silent corruption | `parseAttributeValue:false, parseTagValue:false`; convert only known-safe fields (§2) |
| **B6** | "Array of one" — one bureau/tradeline parses as an object, not an array | `.map()` throws, or you read one bureau and drop the rest | Force `isArray` for repeatable nodes (§2) |
| **B7** | A locked verified FICO gets overwritten (manual edit, ClickUp round-trip, migration) | The whole anti-manipulation goal defeated | DB `BEFORE UPDATE` trigger + `IS DISTINCT FROM` + locked-field sync allowlist (§6) |
| **B8** | Wrong-person / mixed file decisioned | *Miller v. Equifax* territory; FCRA §1681e(b) exposure | Identity-match returned SSN/name/DOB vs application before use (§3, §9) |
| **B9** | Truncated HTTP body parses as "valid" XML missing a bureau | Underwrite on an incomplete report | Content-Length check + root-close check + required-node assertions (§2) |
| **B10** | Credentials (URL params) / SSN leak into logs | GLBA/PII breach | Centralized logger redaction + query-string scrubbing (§7) |

---

## 2. XML parsing & encoding hardening

MISMO 2.3.1 puts nearly all data in **leading-underscore attributes**, repeats containers per bureau,
and embeds the PDF as base64 in `EMBEDDED_FILE/DOCUMENT/<![CDATA[…]]>`. Treat the response as
**untrusted** (compromised endpoint / MITM / bad fixture).

**Security (pin these):**
- The credit XML never legitimately needs a `<!DOCTYPE>` — **reject any document containing one**
  (`if (/<!DOCTYPE/i.test(raw)) throw`).
- **fast-xml-parser**: XXE-safe by design (no external entity/network fetch), but set
  **`processEntities:false`** and pin **≥ 5.3.5** — CVE-2023-34104 (entity-name ReDoS) and
  **CVE-2026-25896** (entity-shadowing that can substitute attacker content for the built-in
  `&lt;/&gt;/&amp;` escapes) both live in older versions.
- **xml2js**: pin **≥ 0.5.0** — CVE-2023-0842 (`__proto__` prototype pollution). Prefer
  `Object.create(null)` maps for lookups.
- **libxmljs**: parse with `{ noent:false, dtdload:false, nonet:true }` — never `noent:true`.

**Silent data-corruption (the dangerous class) — required parser config:**

| Setting (fast-xml-parser) | Value | Why |
|---|---|---|
| `ignoreAttributes` | **false** | data is in attributes; default `true` drops every score/name/code |
| `attributeNamePrefix` | explicit (verify combined name vs `_`-prefixed MISMO names) | off-by-one prefix = silent nulls |
| `parseAttributeValue` / `parseTagValue` | **false** | stops `"030"`→30, `"0E68"`→0, big-int precision loss |
| `isArray` | explicit list of repeatable nodes (`CREDIT_SCORE`, `CREDIT_LIABILITY`, `BORROWER`, …) | kills the "array of one" bug |
| `cdataPropName` | set it; don't `trimValues` the CDATA | keep PDF base64 bytes intact |
| `processEntities` | **false** | XXE / ReDoS |

- **Empty-but-required attributes**: distinguish **absent** (`undefined`) from **empty** (`""`) —
  `_MiddleName=""` is valid; `if(!m._MiddleName) reject()` falsely fails good records.
- **Dates**: MISMO dates are date-only (`YYYY-MM-DD`/`YYYY-MM`). `new Date("2024-03-15")` is UTC
  midnight → renders as the **previous day** in US zones. Keep as strings; format with an explicit
  zone (this repo already learned this in the ClickUp DOB incident — reuse `lib/dates`/`fields`
  discipline).
- **Booleans**: map `"Y"/"N"` explicitly (`Boolean("N")` is `true`).
- **Truncation**: compare `Content-Length` to received bytes; confirm the raw text ends with the
  expected closing tag (`</RESPONSE_GROUP>`); assert required nodes (≥1 `CREDIT_SCORE` per requested
  bureau, `_Value` present) before storing. A caught-and-ignored parse error must **fail the request**.
- **Encoding**: honor the declared charset (UTF-8 vs windows-1252) so accented names don't mojibake;
  strip a leading BOM before the `%PDF`/prefix checks.

---

## 3. Score extraction & selection edge cases

**The structural fact:** a `CREDIT_SCORE` node carries `_Value` (a **string**), `_Date`,
`_ModelNameType`, `CreditRepositorySourceType`, `BorrowerID`, `CreditFileID`, a repeating `_FACTOR`
list, **and a separate `_ExclusionReasonType`**. Order of operations is the whole ballgame:

**Extraction, in this exact order (per bureau, per borrower):**
1. **Check `_ExclusionReasonType`** — if present/non-empty, this bureau is **no-score** regardless of
   `_Value`. MISMO enum: `NotScoredSubjectDeceased`, `NotScoredInsufficientCredit`,
   `NotScoredNoQualifyingAccount`, `NotScoredNoRecentAccountInformation`, `NotScoredFileCannotBeScored`,
   `NotScoredFileIsUnderReview`, `NotScoredCreditDataNotAvailable`, … Also detect legacy in-value
   reject codes: **9001 = deceased, 9002 = model exclusion / no recent activity, 9003 = insufficient
   credit** (and text forms "MODEL NOT SCORED: …").
2. **Assert the model** per bureau: Equifax=`EquifaxBeacon5.0`, Experian=`ExperianFairIsaac`,
   TransUnion=`FICORiskScoreClassic04`. Mismatch = **hard error** (catches FICO 8/9/10T & VantageScore,
   which a range check can't — VantageScore 3/4 is also 300–850). Bind by `CreditRepositorySourceType`,
   never positional order.
3. **Range-guard `_Value`** using the model's band **read from the response KEY dictionary**, not a
   hard-coded 300–850 (industry-option FICO is 250–900; VantageScore 1/2 is 501–990). This catches
   `0`, blanks, and 4-digit reject codes. Use a **nullable** score type (`Optional<int>`), never a
   sentinel `0`.

**Selection:**
- Per borrower by **count of usable scores**: 3 → middle (sorted **multiset** index 1 — do **not**
  `set()`/de-dup, or `{680,680,720}` wrongly returns 720); 2 → **lower**; 1 → that one; **0 → manual
  review / no-decision**, never 0 or "lowest."
- Loan representative = **highest** middle across borrowers (owner rule; matches existing `GREATEST`
  `#99`). A borrower with **zero** usable scores must not slip through the `GREATEST` max as a hidden
  low/0.
- Don't round; scores are integers. Any float/average path (`719.5→720`) fabricates a qualifying score.
- **Boundary bands**: verify inclusive/exclusive (`>=` vs `>`) at each LLPA/eligibility edge against
  the rate sheet.

**Joint pulls:** bind each score to its borrower by `BorrowerID` + cross-check that party's SSN/name;
positional parsing scrambles 2 borrowers × 3 bureaus = 6 nodes.

**Factor/reason codes:** keep **zero-padded strings**, key lookups by **(model, code)** not code alone
(2-digit FICO Classic vs 3-digit TransUnion; same number ≠ same meaning), and suppress `000`/`00`
("No Adverse Factor") from any adverse-action text.

**Identity match (mixed-file guard):** compare returned `CREDIT_FILE/_BORROWER` SSN/name/DOB/address
to the application-of-record; reject/hold on mismatch beyond tolerance; surface bureau ID/fraud alerts.

---

## 4. Base64 PDF decode (stored for viewing only — never a data source)

- Strip any `data:…;base64,` prefix + whitespace; validate length%4.
- Decode **strictly** — Node's `Buffer.from(str,'base64')` ignores invalid chars and stops at the
  first bad byte, so corruption/truncation yields a shorter buffer with **no error**. Reuse the
  existing chokepoint `lib/upload-bytes.decodeUploadBase64()`.
- Verify `buf.slice(0,5) === '%PDF-'` **and** a trailing `%%EOF`; length sanity vs any declared size.
- Cap accepted size / stream to blob storage (a base64 PDF is ~1.33× the binary plus the Buffer —
  memory blowup under concurrency).
- The PDF is **decoded and stored so a human can view it**. All underwriting data comes from the XML
  (DESIGN §0 callout). A response with a PDF but no structured scores is an **error → fail closed**.

---

## 5. HTTP client, idempotency & concurrency (Node/undici)

- **Timeouts**: global `fetch`/undici has **none** — a silent server hangs the promise and leaks a
  socket. Use a dedicated `undici.Agent` with `headersTimeout`/`bodyTimeout`/`connectTimeout` (these
  destroy the socket; `AbortSignal.timeout` alone can leave zombie sockets) and drain/cancel the body
  in `finally`.
- **Never blind-retry the billable order POST** (B4). Retry only transient failures (timeouts, TLS
  resets, 502/503/504, 429) with exponential backoff **+ jitter**, a retry budget, and **honor
  `Retry-After`**. Never retry E002–E035 (data) / E036–E051 (auth) / E101/E102 (malformed).
- **Idempotency/dedup**: a DB **unique constraint** on a natural key (or `request_idempotency_key`)
  with `INSERT … ON CONFLICT DO NOTHING RETURNING`, or `pg_advisory_xact_lock(hashtext(key))` — an
  app-level "SELECT then INSERT" is a TOCTOU race that double-orders. Serve a cached report inside the
  freshness window instead of re-pulling.
- **Concurrency**: store scores with `SELECT … FOR NO KEY UPDATE` or a single atomic `UPDATE` (default
  READ COMMITTED loses updates on read-modify-write). Make webhook/queue handlers idempotent on an
  event id.
- **Redirects/SSRF**: `redirect:'manual'` / `maxRedirections:0`, host allowlist, validate the final URL.
- **Circuit breaker** (mirror `src/clickup/client.js`): count transport failures + E001/5xx/timeouts;
  do **not** count client-data errors toward it.

---

## 6. FICO hard-freeze — Postgres trigger & bypass hunting

The freeze only protects what routes **through** the DB trigger, so enumerate every path:
- **`BEFORE UPDATE` trigger** (can `RAISE EXCEPTION` before the write). Compare with
  **`IS DISTINCT FROM`**, never `<>` (`<>` is NULL when either side is NULL, so a change to/from NULL
  slips through). This mirrors the existing `db/069_sow_budget_guard.sql` belt-and-suspenders trigger.
- **Upsert**: `ON CONFLICT DO UPDATE` fires `BEFORE UPDATE`, but the `BEFORE INSERT` trigger also
  always fires on `ON CONFLICT` — enforce the freeze on **both** INSERT and UPDATE, and make sure an
  INSERT-then-UPDATE can't launder a new value via `EXCLUDED`.
- **Shadow field**: audit that pricing/term-sheet read the **same** frozen `verified_fico` column, not
  a second/estimate field.
- **`COALESCE` re-enable**: `SET fico = COALESCE(NEW.fico, OLD.fico)` can silently reopen a value —
  source-priority must beat timestamp; COALESCE-can't-clear a locked value.
- **Forgeable "reason" exceptions**: a session GUC (`current_setting('app.reason')`) is settable by
  anyone with a connection — it is **not** authorization. The only sanctioned change is a re-import via
  the audited `import_verified_fico(report_id)` routine; any break-glass is capability-gated,
  justification-required, logged to the tamper-evident trail, and reviewed by someone else (segregation
  of duties).
- **Sync round-trip**: enforce the locked-field allowlist on the **inbound** ClickUp path (today
  `mapper.js` maps `fico` `dir:'both'`), not just the UI. Outbound pushes `verified_fico` + a locked
  flag so ClickUp shows it read-only; if it can't be locked there, inbound **rejects-and-queues** a
  changed value.
- **Migrations / bulk scripts** bypass app guards but not the trigger; add a CI check flagging any
  migration touching the locked columns. Restrict who can `ALTER TABLE … DISABLE TRIGGER` /
  `session_replication_role=replica`. Pin `search_path` on any `SECURITY DEFINER` function.
- **Partial unique indexes** (`WHERE deleted_at IS NULL`) only dedup matching rows — don't let a
  soft-deleted duplicate defeat the ordering-dedup constraint.

---

## 7. Secret & PII leakage

- Xactus passes **credentials as request params** and the payload carries **SSN** — the default
  failure mode leaks. Centralize redaction at the **logger** (e.g. Pino `redact` paths) so
  `password`/`authorization`/`ssn`/`token` are stripped at serialization — never rely on each call
  site. Scrub URLs to path-only (query-string creds otherwise land in access logs/APM).
- Don't dump `error.config`/`error.request` (they embed headers/body), don't serialize exceptions to
  the client, store the audit copy of the XML with SSN/creds **masked**, encrypt raw XML+PDF at rest.
- CI regex test that fails the build on SSN-shaped strings in logs.

---

## 8. Permissible purpose & adverse action (business-purpose RTL specifics)

- **Permissible purpose exists only for the personally-liable individual** (principal/guarantor/
  co-signer) — not the entity, not a non-obligated party. Gate every pull behind a recorded
  permissible-purpose basis + captured, timestamped authorization tied to a specific application id.
  A report pulled for underwriting loan #123 must be technically incapable of reuse for a different
  applicant/purpose (the *Monster Loans* trap).
- **Adverse action / risk-based pricing** (FCRA §615 / §615(h), Dodd-Frank §1100F, model forms
  H-3/H-4/H-5): when a score drives a decline or worse-than-best pricing, the notice must carry the
  **score, the model's range (read from the KEY dict, not hard-coded), the date, up to 4 key factors,
  and the CRA source** — for the correct borrower on a joint file. **No score → the H-5 "no credit
  score available" notice**, never a blank/zero. Suppress `000`/`00` factors.
- **ECOA / Reg B (§1002.9)**: reasons must be **specific** and reflect factors actually scored
  ("failed to achieve a qualifying score" is non-compliant; "complex algorithm" is **not** an
  exemption — CFPB Circular 2022-03). Business-credit track splits on the $1M-revenue threshold.
- **No re-disclosure of the raw report to note investors** — share only lender-derived attributes.
- Make the adverse-action notice a **non-skippable step** in decisioning, with proof-of-send persisted.

---

## 9. Real-world incident lessons (cited)

| Incident | What happened | Build directive |
|---|---|---|
| **Miller v. Equifax** ($18.4M punitive, reduced) | Mixed file — another person's derogatory data | Identity-match every report vs application-of-record; never auto-decision a mismatch |
| **CFPB v. Monster Loans / Chou** (2020, prescreen ban) | A mortgage lender reused reports for a non-mortgage purpose | Purpose-bind pulls to an application; make cross-use technically impossible; log who/why |
| **CFPB v. Clarity/Ranney** ($8M) | Pulled reports with no permissible purpose | Record permissible purpose + authorization artifact per pull |
| **Equifax 2022 scoring defect** (~300k off 25+ pts; NY AG $725k) | A server-migration coding bug shipped wrong scores | Sanity-check scores vs prior pull; quarantine implausible swings; store model+bureau |
| **Equifax 2017 breach** ($575–700M) | Unpatched CVE exposed 147M SSNs | Encrypt at rest, least privilege, patch-CVE SLA, retention/purge |
| **US Mortgage Corp** (2026 class action) | Borrower data unencrypted, no MFA, late notice | Encrypt + MFA + monitoring + 30-day breach notice (GLBA Safeguards) |
| **TransUnion** ($23M, 2023) | Falsely confirmed freezes that were actually backlogged | Reconcile "we told the user X" vs "system did X"; never let status silently diverge |
| **CFPB 2024 Supervisory Highlights** | Furnishing known-inaccurate data, dropped dispute flags | If we ever furnish: written accuracy procedures, auto dispute flags, SLA alerting |

---

## 10. Regression-test fixtures (prove we handled all of it)

Build a fixture suite (no live PII — use Xactus's synthetic personas / crafted XML) covering:
- **Parsing**: one-bureau AND three-bureau responses (array-of-one); a `"030"` zero-padded factor
  code; an empty `_MiddleName=""`; a long account id; a date-only field; an accented name
  (encoding); a base64 PDF with a `data:` prefix **and** a deliberately truncated variant; a
  `<!DOCTYPE>` payload that must be **rejected**; a truncated body missing a bureau.
- **Scores**: exclusion `_ExclusionReasonType` present; `_Value` = `9002`/`0`/blank; a VantageScore/
  FICO 8 model that must be **rejected**; tied scores `{680,680,720}` (→680); 3/2/1/0-usable
  cardinality; a joint 2-borrower×3-bureau file (BorrowerID binding); an industry-option 250–900 band.
- **Freeze**: attempt a manual edit, a ClickUp inbound overwrite, an upsert, a `COALESCE` clear, and a
  migration-style bulk update against a locked row — **all must be rejected and audited**; a
  legitimate re-import must succeed and re-fire the mismatch flow.
- **Idempotency**: two concurrent orders for the same borrower → exactly one Xactus call.
- **Errors**: each Xactus code class (E001 retry, E037 auth stop, E101 malformed, E999 review) and
  each 200-OK domain failure (frozen, no-hit, fraud/deceased) → correct routing, never a false pass.
- **Adverse action**: a decline populates score/range/date/factors for the right borrower; a no-score
  file uses the H-5 notice.

---

## Sources (by section)

**XML parsing / security:** CVE-2023-34104 & CVE-2026-25896 (fast-xml-parser), CVE-2023-0842 (xml2js) —
GitHub Advisories / Snyk / NVD; OWASP XXE Prevention Cheat Sheet; fast-xml-parser docs & issues #273/#466/#490;
Node Buffer/base64 issues #11987/#6107; Node http Content-Length issue #6300.
**Node/Postgres implementation:** undici GettingStarted & issues #1926/#5450; node-postgres pool; PostgreSQL
CREATE TRIGGER docs; "SELECT FOR UPDATE considered harmful" (Cybertec); Pino redaction; Adyen idempotency.
**Scores / adverse action:** Essent MISMO 2.3.1 CREDIT_SCORE schema; MISMO CreditScoreExclusionReasonType
model viewer; Xactus FICO Classic Reason Codes PDF; TransUnion/Equifax adverse-action sheets; myFICO score
versions & reason codes; Fannie B3-5.1-02; FCRA risk-based-pricing rule (Federal Register); CFPB Circular
2022-03; Reg B §1002.9.
**Incidents:** ABA Business Law (2020 FCRA decisions); CFPB press (Clarity/Ranney, Monster Loans); NY AG
Equifax 2025 settlement; classaction.org Equifax 2022; FTC Equifax 2019 settlement; MPA (US Mortgage Corp);
CFPB 2024 Supervisory Highlights; Washington Post (TransUnion 2023).

_(Full URLs are in the per-round agent reports; each claim above traces to a cited source there.)_
