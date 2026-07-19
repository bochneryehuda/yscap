# DocuSign Integration — Security & Compliance Spec (pre-go-live)

_Threat catalog + compliance guardrails + the out-of-scope legal boundary. Produced by a dedicated
security-research agent and a dedicated compliance-research agent as part of the owner's "more auditors,
make sure the system is not guessing anything, it only follows the instructions" pass. **Nothing here is
implemented yet** — this is the ENFORCE list the portal integration is built against. No secrets in this
doc. Companions: `DOCUSIGN-INTEGRATION-BLUEPRINT.md`, `DOCUSIGN-ERROR-HANDLING-AND-HARDENING.md`,
`DOCUSIGN-DOCUMENT-BUILD-SPEC.md`, `DOCUSIGN-BUG-REGISTER.md`._

> **Governing principle (carried through every doc):** the system never guesses and never acts on
> unverified input. A webhook, a redirect parameter, or a document name is a *claim* until we
> re-verify it against DocuSign's own record. Truth comes from an authenticated read-back, never from
> the thing that arrived at our door.

---

## Part 1 — Security threat catalog (each with the ENFORCE rule)

### 1.1 Inbound webhook is untrusted until proven
- **Threat:** anyone who learns the webhook URL can POST a forged "envelope completed" to auto-clear a
  condition. The URL is not a secret.
- **ENFORCE:** **fail-closed HMAC.** Verify `X-DocuSign-Signature-1..N` (HMAC-SHA256 over the **raw**
  body, base64) against every configured key (multi-key = rotation) **before parsing**. No valid key →
  `401`, drop, audit. Missing config → reject (never "allow because HMAC isn't set up yet"). Mirror
  `clickup-webhook.js`'s raw-body + constant-time compare exactly.

### 1.2 Replay / event forgery
- **Threat:** a captured-and-replayed valid webhook, or an out-of-order/duplicate delivery (Connect is
  at-least-once and can coalesce statuses).
- **ENFORCE:** **idempotent inbox + re-fetch the truth.** Store each event by `sha256(raw body)`
  `ON CONFLICT DO NOTHING` (dedupe). Never trust the event's *payload* for the state transition — on any
  completion event, call `Envelopes:get` / download the signed docs from DocuSign with our own token and
  act on **that**. The webhook is only a "go look" trigger.

### 1.3 The return URL `?event=` is never truth
- **Threat:** after embedded signing, DocuSign bounces the browser back with `?event=signing_complete`.
  A user can edit that query string; it proves nothing.
- **ENFORCE:** the `?event=` value **only** decides which page to show the human. The *condition* is
  cleared solely by the HMAC-verified webhook + read-back (1.1/1.2). UI state and system-of-record state
  are separate.

### 1.4 Open redirect / SSRF via return + webhook URLs
- **Threat:** an attacker-supplied `returnUrl` becomes an open redirect; a configurable webhook/base URL
  becomes an SSRF pivot.
- **ENFORCE:** **allow-list.** `returnUrl` must be built server-side from our own `APP_URL` +
  a known route (never reflected from client input). Any outbound URL DocuSign calls is our fixed
  `https://www.yscapgroup.com/api/webhooks/docusign`. Mirror the `/link/r` bounce-route allow-list
  pattern already in the codebase.

### 1.5 DocuSign-as-phishing-lookalike
- **Threat:** borrowers trained to click "DocuSign" emails are a phishing target; a real DocuSign email
  for an unexpected doc erodes trust.
- **ENFORCE:** **prefer embedded (in-portal) signing** — the borrower signs inside the authenticated
  PILOT portal (a `clientUserId` recipient), so there's no "click this email" step to spoof. Email
  signing stays available but the in-portal path is primary; branding + sender name are consistent PILOT.

### 1.6 IDOR on the embedded signing URL
- **Threat:** the recipient-view URL, if guessable or shared, lets someone sign as another borrower.
- **ENFORCE:** **authorize by session ownership + short TTL.** The recipient-view URL is minted only for
  the logged-in borrower who owns that application (the same ownership check the document routes use), is
  **single-use / ~5-minute** lived, and is never stored or logged. Never mint one from an
  unauthenticated request.

### 1.7 Tamper / integrity of the signed artifact
- **Threat:** the PDF that comes back could differ from what was sent (content-spoofing CVEs
  CVE-2024-52269 / -52276 concern how rich content renders).
- **ENFORCE:** **store the flattened signed PDF + the Certificate of Completion as the source of truth,**
  downloaded immediately (DocuSign purges after retention). Record `sha256` on the `documents` row (the
  integrity column already exists). The stored bytes — not the DocuSign envelope — are what the condition
  and the TPR export reference.

### 1.8 PII exposure surface
- **Threat:** SSNs / DOBs leaking into DocuSign envelope **custom fields**, tab values, email subjects,
  or our own logs.
- **ENFORCE:** **PII stays out of DocuSign metadata and logs.** `envelopeCustomFields` carry only
  correlation keys (applicationId, purpose) — never PII. The SSN lives only *inside* the document bytes
  (owner directive: full SSN on the application). Reuse the existing `redact.js` on anything logged; the
  webhook journal masks like `clickup_write_log`.

### 1.9 Key management
- **Threat:** the RSA private key is the whole ballgame — it lets the app impersonate the DocuSign user.
- **ENFORCE:** key lives **only** in Render env (`src/config.js`), never in source, a doc, a commit, or a
  chat. **A key pasted into chat is compromised and must be rotated before use** (the demo key + Render
  key shared in this project's chat are treated as compromised — rotate). Support key **rotation** (the
  multi-key HMAC verify in 1.1 makes Connect-key rotation zero-downtime).

### 1.10 Injection / output-encoding
- **Threat:** borrower-controlled strings (names, entity names, addresses) flow into the generated PDF,
  the envelope JSON, and email subjects.
- **ENFORCE:** the PDF generator draws text as text (no HTML injection surface); envelope fields are
  JSON-encoded by the client; email subjects are fixed templates with encoded interpolation. Never build
  DocuSign JSON by string concatenation.

### 1.11 "Demo is harmless" is a security bug (see BUG-REGISTER M-13)
- **Threat:** demo creds sit on the **production** Render service; a live path could mail a real borrower
  a watermarked non-binding envelope, or (worse, later) a real path runs on demo and the "signed" doc is
  legally void.
- **ENFORCE:** while on demo creds, the send path is **gated to an allow-listed set of test emails**. The
  demo→prod promotion is explicit and audited (new RSA key + consent + Connect config re-created on prod;
  only the integration-key value carries over). Never reason "demo, therefore safe."

---

## Part 2 — Compliance guardrails (ESIGN / UETA — the ENFORCE list)

Business-purpose e-signature enforceability rests on **ESIGN + UETA**. The four pillars are **intent to
sign, consent to do business electronically, attribution (who signed), and record retention +
association**. DocuSign's Certificate of Completion (the AATL-sealed audit trail: signer identity, IP,
timestamps, consent capture) supplies most of the evidence — but only if we ENFORCE the flow around it.

| # | Guardrail | ENFORCE rule |
|---|-----------|--------------|
| C1 | **Consent before signing** | The E-SIGN consent disclosure must be presented and captured **before** the first signature (DocuSign's consent step, on by default — never disable it). No consent → no valid signature. |
| C2 | **Right version / right bytes** | The envelope must be created from the **exact** flattened PDF we intend, and the *signed* copy we store must be verified (`sha256`) against what came back. An economics change **reopens** the signed condition (the `db/096` reopen family) so a stale-terms signature is never treated as current. |
| C3 | **All signers complete** | A condition auto-clears **only** on `envelope status = completed` (all recipients done) — never on a single recipient's `signed`, never on `delivered`. Co-borrower/guarantor present ⇒ both signatures required before completion. |
| C4 | **Attribution** | Store the Certificate of Completion with the signed PDF; it's the record of *who* signed, *when*, and *from where*. It is downloaded and retained with the document (C5), not left to expire in DocuSign. |
| C5 | **Sealed copy + certificate retention** | Download the completed PDF **and** the CoC immediately on completion (DocuSign purges after the account retention window) and store both as the durable record. A completion with no stored sealed copy **dead-letters to human review** — it is never silently "cleared." |

**No-guessing overlay (owner's core principle):** every auto-clear is rule-gated and, at go-live, a human
still eyeballs the actual signed PDF (tier-3 auto-satisfy stays **OFF** for e-sign conditions). If any
input to the decision is missing or unverifiable, the system **stops and raises a review row** — it never
fills the gap with an assumption.

---

## Part 3 — OUT-OF-SCOPE boundary (what must NOT be plain e-signed)

This is the single most important compliance line, and it is easy to cross by accident. **Plain DocuSign
e-signature is correct for the initial application package and disclosures. It is NOT sufficient for the
closing/security instruments.** The following must **not** be sent through this plain-e-sign flow:

- **The promissory note.** A note intended to be **sold / assigned** on the secondary market (our Gold
  Standard note buyers) generally must be a **wet-ink original** or a true **eNote** (a MERS-registered,
  tamper-sealed transferable record under **UETA §16 / ESIGN §7021**, held in an eVault). A plain PDF
  e-signature does **not** create a transferable, negotiable eNote — a note buyer can reject it, and there
  is no "authoritative copy" to transfer.
- **The mortgage / deed of trust** and anything **recordable**. County recording + notarization
  (acknowledgment) requirements put these outside plain e-sign; many jurisdictions require **RON** (remote
  online notarization) or wet ink.
- **Anything requiring notarization** — including the business-purpose **affidavit at closing** (the
  owner confirmed the *initial* business-purpose disclosure is plain e-signed; **notarization happens at
  closing**, which is out of scope for this build).
- **ESIGN §7003-excluded categories** generally (e.g. certain notices) — not typical here, but the flow
  must not be pointed at them.

**ENFORCE:** the send path operates on a **whitelist of allowed document kinds** (term sheet, application
export, initial business-purpose disclosure, Heter Iska) — mirroring the existing `docKind` whitelist
chokepoint. A note/mortgage/recordable/notarized kind is **not on the list** and cannot be sent. When the
business is ready to e-close saleable notes, that is a **separate** eNote/eVault/MERS project, not an
extension of this one. This boundary is stated plainly to the owner in the go-live summary.

---

## Part 4 — Sources
_Non-authoritative pointers gathered during research; verify against the live DocuSign reference and
counsel before go-live._
- ESIGN Act (15 U.S.C. §7001 et seq.), §7003 exclusions, §7021 transferable records.
- UETA §16 (transferable records / eNotes).
- DocuSign Connect HMAC + Certificate of Completion documentation.
- CVE-2024-52269, CVE-2024-52276 (content-rendering advisories) → store flattened bytes as source of truth.
- MERS eRegistry / eNote requirements for saleable notes.
