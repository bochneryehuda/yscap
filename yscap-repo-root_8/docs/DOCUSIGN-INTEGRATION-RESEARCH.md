# DocuSign Integration — Research Blueprint (owner-requested, 2026-07-13)

> **EXTENDED (2026-07-17) by `docs/DOCUSIGN-INTEGRATION-BLUEPRINT.md`.** This document remains the
> valid DocuSign-platform foundation (auth, envelopes/tabs, Connect, compliance, risks). The newer
> blueprint goes the next level: it maps everything to the **actual YS Capital code** (file:line),
> reconciles the **schema already pre-staged** for this (`esign_envelopes`, `esign_doc`,
> `tool_key='esign'`, `term_sheet_signed` → `Term Sheet/Signed`), designs the **specific workflows**
> (term sheet after product registration, application signing, and the **draw/wire-info scope flag**),
> adds the **security / manual-review / anti-guessing guard model**, and lists **what the owner must
> provide to start building**. Read this doc for fundamentals, the blueprint for the build design.

_Research only — nothing is implemented. Produced by a 7-agent research sweep over official
DocuSign documentation (auth, envelopes/tabs, Connect webhooks, signing experience, lending
compliance, limits/SDK), synthesized and independently re-verified. No credentials appear in
this document._

---

---

## 1. What the integration will do

Borrowers e-sign three portal-generated PDFs — **(a) loan application, (b) initial disclosures, (c) term sheet** — and the executed copies flow back automatically: stored as portal documents (`application_signed`, `disclosures_signed`, `term_sheet_signed`), mirrored to SharePoint (e.g. `Term Sheet/Signed`), and the matching checklist conditions auto-satisfied.

**Recommendation: ONE envelope containing all three documents, in a single signing ceremony.** Reasoning:

- A DocuSign envelope natively holds multiple documents (limit is 130 docs / 200 MB total; each doc < 50 MB — three loan PDFs are trivially within limits). The borrower signs everything in one continuous session — one email/one embedded URL, one ERSD consent capture, one Certificate of Completion covering all three instruments.
- Fewer envelopes = fewer API calls, fewer webhook events, fewer per-envelope polling-limit concerns, and (on envelope-based billing plans) 1/3 the envelope consumption.
- The Connect `envelope-completed` payload identifies each document individually (name + documentId), so per-document routing (application → its folder, term sheet → `Term Sheet/Signed`) works fine from one envelope — combining them does **not** force combined storage.
- Use **separate envelopes only if** the three docs are ready at different pipeline stages (e.g. disclosures must go out days before the term sheet exists), need different signers, or must be voidable independently. If the term sheet is negotiated/re-issued after disclosures, a pragmatic split is: envelope 1 = application + initial disclosures (at intake), envelope 2 = term sheet (at terms). Design the code so an envelope is "a set of doc_kinds," making either grouping a config choice.

Caveat on one-ceremony sequencing: ESIGN consumer-consent capture (see §4) should occur before/at the start of the ceremony — DocuSign's ERSD does this automatically as the signer's first action, so a single combined ceremony remains compliant.

---

## 2. Missing credentials & setup — numbered checklist for the owner

What you already have: **User ID (GUID)**, **API Account ID (GUID)**, **Account Base URI `https://na4.docusign.net`** (na4 = a production shard). What's missing: everything app-side. Do the following:

1. **Create a free developer (demo) account** at https://go.docusign.com/o/sandbox/ — all build/test happens against demo (`https://demo.docusign.net`, auth host `account-d.docusign.com`). Never develop against the na4 production account.
2. **Create an app / Integration Key** in the demo account: log in → Settings (Admin) → **Apps and Keys** → *Add App and Integration Key*. Record the Integration Key GUID (this is the OAuth `client_id` / JWT `iss`). Not a secret, but treat it as config.
3. **Generate the RSA keypair** on that same Apps and Keys screen: in the app's *Authentication* section choose **Add RSA Keypair**. DocuSign shows the private key **once** — copy the full text including the `-----BEGIN RSA PRIVATE KEY-----` / `-----END RSA PRIVATE KEY-----` lines and store it in the portal's secret store (same place as the Graph client secret). The public key stays with DocuSign. (A client secret is only for auth-code grant; **JWT grant needs the RSA key, not a secret**.)
4. **Add a redirect URI** to the app (e.g. `https://portal.yscapgroup.com/api/docusign/consent-callback`). Required even for JWT — it's used by the one-time consent step.
5. **Grant one-time individual consent** for the impersonated user: open in a browser, logged in as that user:
   `https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id={INTEGRATION_KEY}&redirect_uri={REDIRECT_URI}`
   and click Accept. Scopes must be exactly `signature impersonation`. Repeat later on `account.docusign.com` for production. (Alternative: org-level **admin consent** exists but requires DocuSign Admin/Access Management + a claimed `yscapgroup.com` email domain — individual consent is simpler for one system user.)
6. **Decide the system sender user.** Best practice: a dedicated service user (e.g. `esign@yscapgroup.com`) with sender permissions in the production account, rather than the owner's personal User ID; its User ID GUID becomes the JWT `sub`. The supplied User ID works but couples the integration to a human account.
7. **Configure Connect (webhook)** — in demo first: Settings → **Connect** → Add Configuration → Custom → URL `https://portal.yscapgroup.com/api/docusign/webhook`; message format **JSON (SIM event model)**; events: at minimum `envelope-completed` (add `envelope-declined`, `envelope-voided`, `recipient-completed` for pipeline state); enable **Include HMAC Signature** and generate up to two HMAC keys under Connect → *Connect Keys* — store the key(s) in the secret store. Optionally enable *Include Documents* + *Include Certificate of Completion* (or fetch docs via API on receipt — recommended, see §3). Note: account-level Connect must be enabled; on some plans it's an add-on — verify na4 account has it.
8. **Go-live (promote the Integration Key to production).** The old "20 successful API calls" requirement was **eliminated (2025)** — in demo Apps and Keys select the app → *Submit for Go-Live* / streamlined flow: pick integration type, enter the production account (the `a59f60b4-…` API Account ID), and built-in validation approves most integrations instantly (or flags for quick review). The Integration Key is then copied to production; the **RSA keypair and consent do NOT carry over** — repeat steps 3–5 against `account.docusign.com`, and recreate the Connect config in the production account.
9. **Verify production plan features**: API access (an API-enabled plan on the na4 account), Connect, and — if you want it — embedded/focused-view signing and ID verification are plan-dependent. Confirm with your DocuSign account rep before build completes.
10. **Config to store per environment** (env vars/secret store; never in code): integration key, RSA private key, impersonated user ID, API account ID, auth host (`account-d.docusign.com` / `account.docusign.com`), base URI (`https://demo.docusign.net/restapi` / `https://na4.docusign.net/restapi`), Connect HMAC key(s).

---

## 3. Recommended architecture for this codebase (raw REST, no SDK)

Matches the existing pattern: raw `fetch` + client-credential style auth, like the Microsoft Graph integration. **Skip the DocuSign Node SDK** — JWT grant is ~40 lines with built-in `node:crypto`, and one fewer dependency tree. (SDK is fine too, but unnecessary here.)

### 3.1 Auth module (`docusignAuth.js`)
- Build a JWT: header `{alg:"RS256", typ:"JWT"}`; claims `iss` = integration key, `sub` = impersonated user ID, `aud` = `account-d.docusign.com` (demo) / `account.docusign.com` (prod) — **hostname only, no scheme**, `iat`/`exp` (≤1h), `scope: "signature impersonation"`. Sign with `crypto.createSign('RSA-SHA256')` over `base64url(header).base64url(claims)`.
- POST to `https://{authHost}/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion={jwt}`. Response: access token, ~1 hour lifetime, **no refresh token** — cache in memory and mint a new one before expiry (same pattern as your Graph token cache).
- On first run (or as a sanity check) call `GET https://{authHost}/oauth/userinfo` to confirm the account's `base_uri` matches `https://na4.docusign.net`; API calls go to `{base_uri}/restapi/v2.1/accounts/{apiAccountId}/…`.
- Error `consent_required` → surface the §2 step-5 consent URL in logs/admin UI.

### 3.2 Envelope creation (`docusignEnvelopes.js`)
- Portal generates the three PDFs as today, embedding invisible **anchor strings** in white/zero-size text: e.g. `/sig_app/`, `/sig_disc/`, `/sig_ts/`, `/date_ts/`, per-document-unique strings (anchor matching is whole-string, case-insensitive; unique strings avoid cross-document duplicate-tab placement).
- `POST /restapi/v2.1/accounts/{accountId}/envelopes` with `documents[]` (`documentBase64`, `name`, `fileExtension:"pdf"`, `documentId: "1"|"2"|"3"`), one signer recipient with `signHereTabs`/`dateSignedTabs` using `anchorString` + `anchorUnits`/`anchorXOffset`/`anchorYOffset`, `status:"sent"`.
- For **embedded** signing set the signer's `clientUserId` (use your internal borrower ID). For email-only signing omit it.
- Store `envelopeId` on the loan record with an `esign_envelopes` table: `(envelope_id, loan_id, doc_kinds json, status, created_at)` and map documentId→doc_kind.

### 3.3 Signing experience — embedded in portal, email fallback
- Primary: borrower clicks "Sign" in the portal → server calls `POST …/envelopes/{envelopeId}/views/recipient` (EnvelopeViews:createRecipient) with `userName`, `email`, `clientUserId` **exactly matching** envelope creation, `returnUrl` back to the portal, `authenticationMethod`. Response `url` is **single-use and expires in ~5 minutes** — generate on click, never store/email it; redirect immediately (or iframe with `frameAncestors` including your portal origin + `https://apps.docusign.com`, `https://apps-d.docusign.com` in demo, if using **focused view** for a chrome-less in-portal UX).
- Fallback: recipients created **without** `clientUserId` get DocuSign's standard email invitation automatically. Simple approach: default to embedded; if the borrower doesn't complete, staff can trigger a "resend via email" path (correct the recipient to remove `clientUserId`, or create the envelope in email mode for offline borrowers). Decide per borrower at envelope creation.
- After the redirect `returnUrl` includes an `event` query param (`signing_complete`, `decline`, etc.) — use it only for UX; **the webhook is the source of truth** for completion.

### 3.4 Connect webhook → documents → SharePoint → conditions (`/api/docusign/webhook`)
- **Verify HMAC first, on the raw body**: compute `base64(HMAC-SHA256(hmacKey, rawRequestBody))` and timing-safe-compare (`crypto.timingSafeEqual`) against header `X-DocuSign-Signature-1` (a second key → `X-DocuSign-Signature-2`; DocuSign supports up to 2 keys for rotation). In Express, capture the raw body (`express.raw()` or the `verify` hook of `express.json()`) — HMAC over re-serialized JSON will not match. Reject non-matching requests with 401. Respond 200 quickly; do processing async (DocuSign retries on failure — make handling **idempotent** on `(envelopeId, event)`; duplicates and out-of-order delivery are possible).
- On `envelope-completed`:
  1. Rather than trusting large inlined payloads, **fetch documents via API** (more robust than *Include Documents*): `GET …/envelopes/{id}/documents` to list, then `GET …/envelopes/{id}/documents/{docId}` per PDF, and `GET …/envelopes/{id}/documents/certificate` for the Certificate of Completion.
  2. Save each PDF as a portal document with mapped `doc_kind` (`term_sheet_signed`, etc.) via your existing documents table/storage; save the certificate as e.g. `esign_certificate`.
  3. Reuse the existing **Graph client-credential integration** to upload to SharePoint: `PUT /drives/{driveId}/root:/Term Sheet/Signed/{loanRef} - Term Sheet (Signed).pdf:/content` (and the equivalent folders for application/disclosures) — identical mirroring pattern to whatever the portal does for uploaded docs today.
  4. Auto-satisfy checklist conditions: look up conditions matching the doc_kind for that loan and mark satisfied, recording `satisfied_by: 'docusign'`, envelopeId, and completion timestamp for audit.
- Handle `envelope-declined` / `envelope-voided` → flag the loan, notify staff.

### 3.5 Reliability
- Webhook-driven, **no polling** (per-envelope GET polling is explicitly rate-limited: `Hourly_Envelope_Polling_Limit_Exceeded` / burst variants). Keep a nightly reconciliation job that lists envelopes changed since last run (`GET /envelopes?from_date=…`) to catch any missed webhooks — one cheap call, not per-envelope polling.
- Respect `X-RateLimit-Limit`/`X-RateLimit-Remaining` headers; volumes here (loans/day) are far below account hourly limits.

---

## 4. Compliance notes (US lending)

- **ESIGN Act consumer consent**: before delivering disclosures electronically to a consumer, you must obtain informed, affirmative consent (hardware/software requirements, right to paper copies, withdrawal). DocuSign's **Electronic Record and Signature Disclosure (ERSD)** is on by default and presented to each new signer as the first action — review/customize it in Admin (you can upload your own text) so it reflects YS Cap's actual paper-copy and withdrawal procedures; retain the consent record. Note: for **commercial/business-purpose loans** the ESIGN consumer-consent provision (15 U.S.C. §7001(c)) does not apply, but keeping ERSD on is still best practice.
- **Timing rules**: "initial disclosures" in regulated consumer lending (e.g. TILA/RESPA 3-business-day windows, if applicable to your products) — the envelope **sent** timestamp evidences delivery; the Certificate of Completion evidences receipt/signature times. Store both.
- **Audit trail / evidence**: DocuSign applies a tamper-evident seal and produces a **Certificate of Completion** (signer name, email, IP, timestamps, consent capture, envelope history). Always download and store it next to the signed docs (portal + SharePoint) — it's your litigation evidence package.
- **Retention**: ESIGN requires retained records to remain accurate and accessible; your portal+SharePoint mirroring satisfies this provided the PDFs are the completed (sealed) versions. DocuSign also retains envelopes in the account, but don't rely on it as your system of record.
- **Signer identity**: base is email-link authentication; for higher assurance DocuSign offers access code, SMS, KBA, and IDV recipient auth (extra cost/plan features). For a borrower authenticated into your portal, embedded signing + `clientUserId` ties the signature to your portal identity — document that in your auth policy.
- If any loans are consumer-purpose, confirm state UETA nuances and any investor/warehouse-lender e-sign requirements before switching originals to electronic.

## 5. Risks & pitfalls

1. **RSA private key shown once** — if lost, generate a new keypair (old tokens keep working until keys are removed). Store in secret manager, never in the repo.
2. **`consent_required` in production** — consent granted in demo does not carry over; grant again on `account.docusign.com` after go-live (a top cause of "works in demo, fails in prod").
3. **`aud` claim mistakes** — must be the bare auth hostname (`account.docusign.com`), not the na4 base URI and not `https://…`. Also don't call the token endpoint on `na4.docusign.net`.
4. **Anchor string not found → `ANCHOR_TAB_STRING_NOT_FOUND`** or missing tabs: PDF generation must emit the anchor text as real text (not rasterized); use unique per-document anchors; matches are whole-string, case-insensitive, punctuation included.
5. **Embedded URL semantics** — single-use, ~300 s expiry; generate per click. If the signer abandons mid-session, generate a fresh recipient view. Never email a recipient-view URL.
6. **HMAC over raw bytes** — Express JSON middleware re-parsing breaks verification; keep the raw buffer. Also plan HMAC key rotation using the two-key/two-header mechanism.
7. **Webhook duplicates/out-of-order + Connect queue retries** — idempotent processing keyed on envelopeId+event; return 200 fast (long handlers → timeouts → retries → duplicate SharePoint files).
8. **Polling limits** — never poll envelope status per-envelope on a timer; DocuSign enforces hourly/burst envelope polling limits.
9. **Plan/feature gaps on the production account** — API access, Connect, focused view, IDV are plan-dependent; confirm before build ends, not at launch.
10. **Go-live validation** — streamlined (no 20-call requirement since 2025) but can still route to manual review; allow a few days of buffer. RSA keys, Connect configs, templates, brands do not migrate demo→prod; script or document their re-creation.
11. **Demo watermarks** — demo-environment envelopes are watermarked/not legally binding; never send real borrowers demo envelopes.
12. **Changed borrower email after send** — correct the envelope (recipients update) rather than voiding, where possible; build a void+recreate path for term-sheet renegotiations.

## 6. Sources

- JWT grant overview: https://developers.docusign.com/platform/auth/jwt/
- JWT token steps/claims: https://developers.docusign.com/platform/auth/jwt-get-token/
- JWT best practices: https://developers.docusign.com/platform/auth/jwt/jwt-best-practice/
- Consent endpoint: https://developers.docusign.com/platform/auth/reference/obtain-consent/
- Auth scopes: https://developers.docusign.com/platform/auth/reference/scopes/
- Granting JWT consent (incl. admin consent/claimed domain): https://www.docusign.com/blog/developers/oauth-jwt-granting-consent
- Connect overview: https://developers.docusign.com/platform/webhooks/connect/
- Connect HMAC: https://developers.docusign.com/platform/webhooks/connect/hmac/ ; setup: https://developers.docusign.com/platform/webhooks/connect/setting-up-hmac/ ; validation: https://developers.docusign.com/platform/webhooks/connect/validate/
- JSON SIM event model: https://developers.docusign.com/platform/webhooks/connect/json-sim-event-model/
- Connect event triggers: https://developers.docusign.com/platform/webhooks/connect/event-triggers/
- Embedded signing concepts: https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/embedding/embedded-signing/
- EnvelopeViews:createRecipient: https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/envelopeviews/createrecipient/
- Focused view how-to: https://developers.docusign.com/docs/esign-rest-api/how-to/request-signature-focused-view/
- Anchor (AutoPlace) tabs: https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/tabs/auto-place/
- API rules and limits: https://developers.docusign.com/docs/esign-rest-api/esign101/rules-and-limits/
- Envelope/document size limits: https://support.docusign.com/s/articles/DocuSign-Document-and-Envelope-File-Size-Limitations?language=en_US
- Go-live: https://developers.docusign.com/platform/go-live/ and https://developers.docusign.com/docs/esign-rest-api/go-live/
- Streamlined go-live (20-call requirement removed): https://community.docusign.com/go-live-70/no-more-20-api-calls-introducing-the-streamlined-integration-go-live-experience-in-apps-keys-25623
- Customer compliance / ERSD: https://www.docusign.com/trust/compliance/customer-compliance
- ESIGN whitepaper: https://www.docusign.com/sites/default/files/esignatures_and_transactions_in_the_u.s._whitepaper_.pdf
- Fed Consumer Compliance Outlook on E-Sign: https://www.consumercomplianceoutlook.org/2009/fourth-quarter/q4_02/