# DocuSign Integration — Master Blueprint (code-grounded)

_Research + architecture pass, 2026-07-17. **Nothing here is implemented** — this is the "research
before we build" deliverable the owner asked for. Read-only research. **No credentials, secrets, or
real customer data appear in this document.** All borrower/officer/address examples are illustrative
placeholders._

> **Relationship to `docs/DOCUSIGN-INTEGRATION-RESEARCH.md` (2026-07-13).** That earlier document is
> the foundational research sweep over DocuSign's official docs (auth, envelopes/tabs, Connect,
> compliance, risks) and it stays valid — read it first for the DocuSign-platform fundamentals and the
> credential/go-live checklist. **This document does not replace it.** It goes the next level: it maps
> every piece to the **actual YS Capital code** (file:line), designs the **specific workflows** the
> owner described, adds the **security / manual-review / anti-guessing guard model** in the house style,
> reconciles the **schema that already exists** for this, flags the **draw-process scope conflict**, and
> answers **"what resources do I need from you to start building."** Where the two documents differ on a
> detail, this one is newer and code-checked.

---

## 0. TL;DR (for the owner, plain language)

We are going to let the portal **prepare a document, fill it in with the real numbers from the loan
file, send it to the borrower to sign through DocuSign, get the signed copy back automatically, file it
in the loan and in SharePoint, and check off the matching condition — all by itself, with a person
pressing "send" as the safety checkpoint.** The plumbing for this was actually **half-built into the
system from the very beginning**: there is already a place to record each signing job, a "Signed term
sheet" checkbox waiting to be cleared, and a "Term Sheet / Signed" folder in SharePoint reserved for
exactly this. DocuSign's side is a well-understood, boring, reliable system — we know precisely how its
signing works and how its "mailman that tells us when something is signed" (the webhook) works, down to
the security signature on every message. The three biggest questions that only you can answer are
below in **§12 (what I need from you)** and **§13 (decisions)** — most importantly: which real
documents (term sheet, disclosures, wire form, application) we're sending, and whether the **draw /
wire-information** piece belongs in this portal at all (today the code deliberately keeps draws on a
separate system).

Everything below the fold is the technical record.

---

## 1. What already exists in this codebase (the pre-staged scaffolding)

DocuSign was clearly anticipated. Before writing any new code, an implementer must know these already
exist, so we **extend** them rather than reinvent:

| Thing that already exists | Where | State |
|---|---|---|
| **`esign_envelopes` table** — `checklist_item_id`, `envelope_id`, `status` (`not_sent`/`sent`/`delivered`/`completed`/`declined`/`voided`/`error`), `completed_document_id` | `db/037_condition_center.sql:78-92` | **Zero code references.** Greenfield but shaped. |
| **`checklist_templates.esign_doc`** (text descriptor) + **`checklist_items.esign_doc`** | `db/037:36`, `:63-67` | Template-level "this condition is signed via e-sign" marker. |
| **`tool_key = 'esign'`** as a recognized condition tool type | `src/lib/conditions/types.js:9-16`, `field-registry`/tool vocabulary | A condition can already be typed as an e-sign condition. |
| **`rtl_cond_signedts`** — "Signed term sheet" checklist template | referenced in `db/096:68-78`, register side-effects | The intended home for the **signed** term sheet; auto-reopens on economics change (see §6.1). |
| **`doc_kind = 'term_sheet_signed'`** routing → SharePoint **`Term Sheet / Signed`** | `src/lib/sharepoint-backup.js:161-166` (`categoryFor`) | `term_sheet` → `Term Sheet/Unsigned`; `term_sheet_signed` → `Term Sheet/Signed`. The Signed folder comment explicitly says it's reserved for DocuSign. |
| **DocuSign auth + send stub** (JWT Grant on Node `crypto`, no SDK) | `src/lib/integrations/docusign.js` (`accessToken()`, `sendForSignature()`) | Framework only; throws "not configured" until env is set. `configured()` gates it. |
| **DocuSign config block** | `src/config.js:251-260` (`docusign.integrationKey/userId/accountId/privateKey/baseUri/oauthBase`) | Reads `DOCUSIGN_*`. **Missing:** a Connect HMAC secret var (see §7.5). |
| **Integration status surface** | `src/lib/integrations/index.js:12` (`docusign: { configured }`) | Already reports whether DocuSign is wired. |
| **Stub points at a webhook route that was never created** | comment in `docusign.js:9-10` → `src/routes/webhooks.js` | `src/routes/webhooks.js` **does not exist yet**. |

**Consequence:** the build is mostly "fill in the pre-drawn outline," not "design from scratch." The
data model already assumes: *one condition ↔ one e-sign document ↔ one envelope, whose completion
produces a stored signed PDF and clears the condition.* We only have to extend that to **one envelope
carrying several documents** (the owner's "combine the term sheet with a few other documents") — a
small schema addition (§7.1).

---

## 2. How DocuSign works — the mental model

Precise version of the plumbing every later section relies on.

- **Envelope** = the transaction/container. It holds **documents**, **recipients**, and **tabs**, and
  has a lifecycle status (`created` = draft, `sent`, `delivered`, `completed`, `declined`, `voided`).
  You create an envelope with one REST call. Limits are generous (up to 130 documents / ~200 MB total;
  each document < 50 MB) — our 2–4 loan PDFs are trivially inside limits.
- **Documents** = the PDFs (or DOCX for DocuSign-side generation). Supplied as base64 with a `name`,
  `fileExtension`, and a `documentId` (`"1"`, `"2"`, …).
- **Recipients** = who acts on it. For us: one or more **signers** (the borrower, a co-borrower, a
  guarantor, and a YS Capital counter-signer), plus optional **carbon-copy** recipients. Signing order
  is controlled by `routingOrder`. A signer is made **embedded** (signs inside our portal) by giving
  them a `clientUserId`; without it they get DocuSign's email invitation.
- **Tabs** (a.k.a. fields) = everything placed on the page: `signHere`, `initialHere`, `dateSigned`,
  and data tabs (`text`, `number`, `checkbox`, …). Tabs are positioned either by **absolute x/y on a
  page** or — far more robust for generated PDFs — by **anchor strings**: DocuSign finds a piece of
  text in the PDF (e.g. `/sig_borrower/`) and places the tab relative to it.
- **Prefilled / locked tabs** = data **we** stamp into the document before sending (loan number, names,
  amounts). Visible to signers, **not editable** by them. This is how "custom fields from the loan
  file" land on the page.
- **Templates** = reusable envelope definitions stored in the DocuSign account (documents + tab layout
  + recipient roles). **Composite templates** let you merge several documents/templates into **one**
  envelope (§4.3) — this is how "term sheet + other docs, signed together" works.
- **Connect** = DocuSign's webhook service. When an envelope changes state, DocuSign POSTs a signed JSON
  message to our listener. **This is the source of truth for completion** — we never poll.

The whole integration is four verbs: **authenticate** (§3), **build+send an envelope** (§4), **let the
borrower sign** (§4.5), **receive the Connect webhook and react** (§5–6).

---

## 3. Authentication — JWT Grant (server-to-server)

Confirmed correct and already stubbed. Carrying forward `docs/DOCUSIGN-INTEGRATION-RESEARCH.md §2–3`
with code notes.

- **Grant type: JWT Bearer.** No user is in the loop; the backend impersonates one DocuSign "system
  sender" user. This matches the existing stub `src/lib/integrations/docusign.js:22-41`.
- **The JWT assertion** (`docusign.js:25-33`): header `{alg:"RS256",typ:"JWT"}`; claims
  `iss` = Integration Key (the OAuth client id), `sub` = impersonated user's GUID,
  `aud` = **auth hostname only** (`account-d.docusign.com` demo / `account.docusign.com` prod — no
  scheme, not the `na4` API host), `iat`/`exp` (≤ 1 hour), `scope: "signature impersonation"`. Signed
  with the app's **RSA private key** via `crypto.createSign('RSA-SHA256')`.
- **Token exchange:** `POST https://{authHost}/oauth/token` with
  `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion={jwt}`. Returns an access token
  valid ~1 hour, **no refresh token** → cache in memory, mint a fresh one before expiry (same shape as
  the Graph token cache). The stub currently mints per call (`docusign.js:50`); **add a token cache**
  when productionizing.
- **One-time consent (a classic footgun):** JWT impersonation requires the impersonated user to have
  granted consent once. Open (as that user):
  `https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id={IK}&redirect_uri={REDIRECT}`
  → Accept. **Consent does NOT carry demo → prod** — must be granted again on `account.docusign.com`
  after go-live. A missing-consent auth fails with `consent_required`; surface that error + the consent
  URL in the admin UI/logs.
- **Discover the base URI:** after the first token, call `GET https://{authHost}/oauth/userinfo` and
  read `accounts[].base_uri` for the target account. Confirm it matches the known production shard
  `https://na4.docusign.net`. All API calls then go to `{base_uri}/restapi/v2.1/accounts/{accountId}/…`.
  The stub already builds URLs this way (`docusign.js:62`).
- **Demo vs prod (2026 state):** build/test entirely against demo (`https://demo.docusign.net/restapi`,
  auth `account-d.docusign.com`). Promote via the **Developer Console** (open beta — one-button
  promote, no account-switching) **or** the legacy Go-Live flow. The old "20 successful API calls"
  gate was streamlined away; promotion still may route to a short manual review. **Only the Integration
  Key value copies to prod** — RSA keys, redirect URIs, Connect config, and consent must all be
  re-created on the production account. The production account must be **Business Pro or higher** with
  **API access** to hold the key.

**Known account state (from the earlier doc — owner-provided):** User ID (GUID) ✓, API Account ID
(GUID) ✓, base URI `https://na4.docusign.net` (na4 = a prod shard) ✓. **Missing:** the demo account,
Integration Key, RSA keypair, consent, and Connect config — see §12.

---

## 4. Building & sending documents

### 4.1 Three ways to put loan-file data into a document — and the frozen-engine constraint

The owner's core ask is "a document should automatically generate with certain custom fields **from
within the loan file**." There are three real ways to do that, and the choice is governed by a hard
house rule: **the pricing/guideline engines are frozen and their numbers must never be re-implemented
or altered** (CLAUDE.md, `web/tools/*` engines). The term sheet's numbers come from those engines.

| Option | How data gets in | Pros | Cons / risk | Fit |
|---|---|---|---|---|
| **A. Push our own PDF bytes** (the current term sheet path) | Portal renders the final PDF (today client-side via jsPDF from the frozen engines), then we send those exact bytes as `documentBase64`; DocuSign only adds signature/date tabs by **anchor string**. | The signed document is **byte-identical** to what YS already produces; **zero risk to the frozen numbers**; reuses `web/tools/termsheet.js` exactly. | The PDF is generated **in the browser today** (`termsheet.js:976 exportPdf`), so fully-unattended server-side generation needs either a headless render or a staff click. | **Recommended for the term sheet** (see the manual-review synergy below). |
| **B. DocuSign Document Generation for eSignature** (DocGen) | Upload a **DOCX template** with merge fields; supply structured data as `docGenFormFields` at send time; **DocuSign renders** the PDF. | Fully server-side/unattended; layout lives in a DocuSign DOCX the business can edit; clean data→doc separation. | The numbers must be computed **server-side** (`src/lib/pricing.js` already mirrors the frozen engines) and passed as fields — **the DOCX must not do any math**, only display. Re-verify byte-for-byte against the frozen output. | **Recommended for new/simple docs** (wire-info form, disclosures cover, simple application) and the long-term path to unattended term sheets. |
| **C. DocuSign server template + prefilled tabs** | A template stored in DocuSign; we set tab **values** by `tabLabel` at send. | Good for stable forms; no PDF handling on our side. | Data lives as tab overlays, not "in" the prose; awkward for a dense term sheet. | Good for the **wire-info** and **disclosure** forms. |

**Key architectural finding.** Today the term sheet (and the applicant-copy loan application) PDF is
**generated client-side with jsPDF** — `web/tools/termsheet.js:832-1241` (`ensurePDF`/`exportPdf`) and
`web/tools/loan-application.html:1632-1721`. The server never renders a PDF. So "automatically
generate and send the term sheet" has a fork:

- **Phase 1 (recommended):** keep **Option A** but put a person on the trigger. When staff clicks
  **"Register product & send for signature,"** the browser renders the exact frozen jsPDF, uploads the
  bytes (the portal already captures term-sheet bytes this way — `staff.js:5054-5133`,
  `doc_kind='term_sheet'`), and the **server** creates the envelope. This is the *same* human-in-the-loop
  the owner explicitly wants as a "manual review process," and it sidesteps the frozen-engine risk
  entirely. **The document is generated from the loan file, the person just approves the send.**
- **Phase 2 (unattended):** move term-sheet rendering server-side via **Option B (DocGen)** or a
  headless render of the identical layout, so the envelope can be created with no browser. Gate behind a
  byte-diff test against the frozen jsPDF output before trusting it.

This reconciles all three requirements — *auto-generate from the loan file*, *manual review*, and
*never touch the frozen numbers*.

### 4.2 Tabs & anchor strings (how signatures + stamped data land)

- **Anchor strings** are the robust way to place tabs on a generated PDF: emit **invisible, unique**
  anchor text per document (`/sig_borrower/`, `/sig_ts/`, `/date_ts/`, `/init_p3/`) as *real selectable
  text* (never rasterized), then create tabs with `anchorString` + `anchorUnits`/`anchorXOffset`/
  `anchorYOffset`. Matching is whole-string and case-insensitive; **unique per-document strings** avoid
  the tab being duplicated across documents. Missing anchor → `ANCHOR_TAB_STRING_NOT_FOUND`. The
  existing stub already uses one anchor (`docusign.js:58`, `/sig1/`); generalize to per-document anchors.
- **Prefilled / locked data tabs:** to stamp loan-file values the borrower must *see but not change*
  (loan number, entity name, amounts, property address), use **prefilled tabs** (sender-set, visible,
  read-only) or `text` tabs with `locked:"true"` and a `value`. This is the mechanism for "custom
  fields from the loan file."
- **Do NOT use "pre-fill tags" for integration-set values** — per DocuSign's own FAQ, pre-fill tags are
  meant to be filled by the *sender in the web UI*; an integration setting a value should use a standard
  **text tab** (locked) instead. (This is a documented gotcha.)

### 4.3 Composite templates (combining the term sheet with other documents)

To satisfy "the term sheet should get combined with another few documents that we want to sign," use
**composite templates**: one envelope, several composite-template entries, **each contributing one
document**, each able to layer a server template (stored tab layout) + an inline template (recipient +
tab data). This lets us mail the borrower a **single signing ceremony** covering term sheet +
disclosures + (optionally) the application, while still routing each *signed* document to its own place
afterward (the Connect payload identifies each document by `name`/`documentId`). Recommendation from the
earlier doc holds: **one envelope = a set of `doc_kind`s**, made a config choice so we can split into
multiple envelopes when the documents become ready at different pipeline stages.

### 4.4 Correlation — how the webhook finds the loan file WITHOUT guessing

This is the anti-"nobody should guess anything" mechanism. Two independent, explicit links (belt and
suspenders):

1. **Our DB is the primary key.** At send time we write an `esign_envelopes` row keyed by the returned
   `envelopeId`, storing `application_id`, the target `checklist_item_id`(s), and the `doc_kind`s. When
   a webhook arrives we look up by `envelopeId` — an exact key, never a name/date guess.
2. **Envelope custom fields carry the same IDs, inside DocuSign.** On create, set
   `customFields.textCustomFields` = `[{name:"ys_file_id",value:"<uuid>",show:"false"},
   {name:"ys_condition_id",value:"<id>"}, {name:"ys_doc_kinds",value:"term_sheet,disclosures"}]`.
   DocuSign echoes these back in the Connect payload (`envelopeSummary.customFields`) and shows them in
   the DocuSign UI, so correlation survives even if our DB row is somehow missing, and a human can
   eyeball which loan an envelope belongs to. **We never infer the loan from the borrower's name or the
   document contents.**

### 4.5 Signing experience — embedded (in-portal) vs email

- **Embedded (recommended default for a portal borrower):** give the signer a `clientUserId` (use the
  internal borrower id). When they click "Sign," call
  `POST {base}/restapi/v2.1/accounts/{acct}/envelopes/{envelopeId}/views/recipient` with `userName`,
  `email`, `clientUserId` **exactly matching** the envelope, `returnUrl`, and `authenticationMethod`.
  The response `url` is **single-use and expires in ~5 minutes** — generate it on click, never store or
  email it, redirect (or iframe via **Focused View** with `messageOrigins` set to
  `https://apps.docusign.com` / `https://apps-d.docusign.com`). The `returnUrl` gets an `event` query
  param on return — **use it only for UX**; the webhook is the truth.
- **Email fallback:** create the signer **without** `clientUserId` → DocuSign emails the standard
  invitation. Good for offline borrowers / co-signers not in the portal. Make it a per-recipient choice
  at send.

---

## 5. Connect webhooks — the deep dive

### 5.1 Per-envelope `eventNotification` vs account-level Connect

Two ways to register the webhook, **use both**:

- **Per-envelope `eventNotification`** (primary): attach a webhook spec to each envelope at creation
  (`url`, `requireAcknowledgment:"true"`, `includeDocuments:"false"`, `loggingEnabled:"true"`,
  `eventData:{version:"restv2.1"}`, and the `envelopeEvents`/`recipientEvents` we care about). The
  envelope self-declares what to notify — self-contained, easy to reason about per loan.
- **Account-level Connect config** (backstop): one config on the account that fires for all envelopes.
  Catches anything the per-envelope spec missed and is where HMAC is configured. Requires account admin;
  on some plans Connect is an add-on — **confirm the na4 account has Connect** (see §12).

### 5.2 Payload — JSON "SIM" event model (Connect 2.0)

Use the **modern JSON SIM event model**, not legacy XML. Top-level shape:

```
{ "event": "envelope-completed",
  "apiVersion": "v2.1",
  "uri": "/restapi/v2.1/accounts/{acct}/envelopes/{envelopeId}",
  "retryCount": 0,
  "configurationId": 123456,
  "generatedDateTime": "2026-07-17T14:03:00Z",
  "data": {
    "accountId": "…", "userId": "…", "envelopeId": "…",
    "envelopeSummary": { "status": "completed", "recipients": {…},
                         "customFields": { "textCustomFields": [{ "name":"ys_file_id", "value":"…" }] },
                         "documents": [ … only if includeDocuments … ] } } }
```

Events we subscribe to: **envelope-level** `envelope-sent`, `envelope-delivered`,
`envelope-completed`, `envelope-declined`, `envelope-voided` (and `envelope-corrected` if we do
corrections); **recipient-level** `recipient-completed`, `recipient-declined` (for multi-signer
pipeline state). `data.envelopeId` is the correlation key; `data.envelopeSummary.customFields` carries
our IDs from §4.4.

### 5.3 HMAC verification — exact scheme (mirror the existing webhook code)

DocuSign Connect signs each POST with **HMAC-SHA256 over the exact raw request body**, base64-encoded,
delivered in header **`X-DocuSign-Signature-1`** (and `-2`, `-3`, … **one header per active HMAC key**;
DocuSign supports **more than one active key for zero-downtime rotation**, so the verifier MUST check
**every** `X-DocuSign-Signature-N` header present and accept if any matches — do not hardcode `-1`).

This is **the same shape** as the two webhook verifiers already in the repo, so we copy the pattern
exactly:

- ClickUp: `src/clickup/client.js:296-303` — `crypto.createHmac('sha256', secret).update(body).digest('hex')`
  then `crypto.timingSafeEqual`. (DocuSign differs only in `.digest('base64')`.)
- Resend/Svix: `src/lib/resend-webhook.js` — raw-body HMAC, constant-time compare, replay window.

Reference verifier for DocuSign (Node built-ins only, no SDK — matches house style):

```js
function verifyDocusignHmac(rawBody, headers, keys) {          // keys = array of configured HMAC secrets
  const expected = keys.map(k =>
    require('crypto').createHmac('sha256', k).update(rawBody).digest('base64'));
  for (let i = 1; i <= 10; i++) {                              // check every X-DocuSign-Signature-N present
    const got = headers['x-docusign-signature-' + i];
    if (!got) continue;
    for (const exp of expected) {
      const a = Buffer.from(got), b = Buffer.from(exp);
      if (a.length === b.length && require('crypto').timingSafeEqual(a, b)) return true;
    }
  }
  return false;
}
```

**Fail-closed in production if the secret is unset** — exactly like the ClickUp route
(`src/routes/clickup-webhook.js:47-48` returns 503 in prod when the secret is missing; 401 on a bad
signature). Verification MUST run on the **raw bytes** → the route mounts **before `express.json()`**
(§7.3).

### 5.4 Delivery semantics (why the handler must be idempotent + fast)

Connect is **at-least-once**: retries on non-200, possible **duplicates**, possible **out-of-order**
delivery. Therefore:

- **Respond 200 immediately, process asynchronously.** Long inline work → DocuSign times out → retries
  → duplicate SharePoint files / double condition-clears. Store the raw event fast, drain later (mirror
  the ClickUp inbox: `src/routes/clickup-webhook.js` + `processInboxOnce` at `clickup-sync.js:644-672`).
- **Idempotency key** = a hash of the raw body (matches `clickup-webhook.js:56`,
  `sha256(rawBody)`) or DocuSign's own delivery id, inserted `ON CONFLICT DO NOTHING`. Reprocessing the
  same event is a no-op.
- **Make the reaction idempotent too:** clearing an already-cleared condition, or re-storing an
  already-stored signed PDF, must be safe (the `doc-dedup` guard + "already satisfied → skip" checks).

### 5.5 Reliability backstop — reconcile, never poll

Per-envelope status polling is explicitly rate-limited (`Hourly_Envelope_Polling_Limit_Exceeded`; an
app may GET a given envelope's status only **once per 15 minutes**). So: **no polling.** Instead, a
cheap nightly **reconcile** job lists envelopes changed since the last run
(`GET …/envelopes?from_date=…`) and repairs any state a missed webhook left stale — one list call, not
per-envelope polls. This mirrors the ClickUp reconcile-watermark pattern already in the repo.

---

## 6. The three target workflows (designed against the code)

### 6.1 Term sheet (± combined docs) after product registration → sign → auto-clear

**Trigger point (exact code):** product registration side-effects live in
`src/routes/staff.js:1620-1717` (`POST /applications/:id/pricing/register` →
`src/lib/product-registration.js persistProductRegistration`). Registering already: writes priced
economics back to `applications`, **reopens the `product_pricing` condition** (`staff.js:1638-1644`),
notifies the team (`product_registered`), and **emails the borrower** "Your updated loan terms are
ready" (`staff.js:1699-1713`). **This is exactly where an envelope-send is enqueued** — but behind a
manual-review gate (§8), not fire-and-forget.

**Flow:**
1. Staff registers the product and clicks **"Send term sheet for signature"** (the manual-review
   checkpoint + the browser-side frozen jsPDF render → uploaded bytes; see §4.1 Option A / Phase 1).
   Optionally the envelope also includes disclosures / the application (composite templates, §4.3).
2. Server enqueues a **durable send job** (§7.2). The worker: mints a JWT token, builds the envelope
   (documents = the uploaded PDF bytes; anchor-string sign/date tabs; prefilled loan-file tabs;
   `customFields` = ys ids; per-envelope `eventNotification`), POSTs create, and writes an
   `esign_envelopes` row (`envelope_id`, `application_id`, target `checklist_item_id` =
   `rtl_cond_signedts`, `status='sent'`).
3. Borrower signs (embedded in portal or via email, §4.5).
4. Connect fires `envelope-completed` → our listener verifies HMAC, stores the event, acks 200; the
   drain worker: looks up `esign_envelopes` by `envelopeId`; **fetches the signed PDF + Certificate of
   Completion via API** (`GET …/envelopes/{id}/documents/{docId}` and `…/documents/certificate` — more
   robust than trusting an inlined payload); persists each via the standard chokepoint
   (`decodeUploadBase64` → `storage.save` → `INSERT documents` with `doc_kind='term_sheet_signed'`,
   `checklist_item_id` set) — which makes SharePoint mirror it to **`Term Sheet/Signed`**
   (`sharepoint-backup.js:161-166`); stores the certificate as `doc_kind='esign_certificate'`.
5. **Auto-clear the condition** via a new exported helper `satisfyConditionBySystem(itemId, {source:
   'docusign', documentId, envelopeId})` (spec in §7.4). It sets the `rtl_cond_signedts` item to
   `status='satisfied'` with a **system** sign-off attribution, honoring the same document-present check
   `signOffGate` enforces (`staff.js:2400-2540`) — satisfied naturally because step 4 attached the
   signed PDF. It then `enqueueChecklistStatusPush(itemId)` (mirror to the ClickUp dropdown) and writes
   an audit row.
6. **Re-fire on change:** `db/096_product_fatal_on_economics_change.sql:68-78` already **reopens
   `rtl_cond_signedts`** (→ `outstanding`, sign-off cleared, `[auto]` note "generate the new term sheet
   and collect a fresh signature") whenever deal economics change. So a re-registration correctly
   **voids/re-sends**: the webhook flow must, on reopen, **void** the outstanding envelope
   (`PUT …/envelopes/{id}` `status:"voided"`) and enqueue a fresh send. This is the "re-issue after
   renegotiation" path and it is already wired at the DB level.

### 6.2 Loan-application signing (± combined with the term sheet)

- **Where the application PDF comes from today:** client-side jsPDF, `web/tools/loan-application.html`
  — an **applicant copy that is not stored** and not attached to the submission. The actual data lands
  either as a **lead** (static tool → `/api/leads`) or, for a real file, via **`src/routes/intake.js`**
  (creates `borrowers` + `applications`, encrypts SSN, runs conditions). There is **no stored,
  signable application PDF today.**
- **To make it signable:** generate a server-side application PDF (Option B DocGen from a DOCX, or a
  server render) from the `applications`/`borrowers` columns + `application_field_values` (custom
  fields, `db/038`), then either its **own** envelope or **combined with the term sheet** (composite
  templates). Map its signed copy to `doc_kind='application_signed'` and a new/existing checklist
  template (e.g. an `esign_doc`-typed condition). Note the ESIGN/ERSD consent point (§9) applies to the
  application/disclosures.
- **Combining with the term sheet:** natural when both are ready at "terms" stage; keep them separate if
  the application signs at intake and the term sheet only exists after pricing. The "envelope = set of
  `doc_kind`s" abstraction (§4.3) makes this a config toggle.

### 6.3 Draw / wire-information collection — **SCOPE FLAG (owner decision required)**

The owner described: *"a collection for wire information in a secured way with DocuSign… when somebody
requests a draw a document should automatically prepare and be sent to DocuSign and come back."*

**Conflict with an existing house rule.** CLAUDE.md (line ~104): *"Draw management is intentionally
sandboxed — the only live piece is the funded-file 'Request a draw' button, which emails LO + processor
+ borrower + draws@yscapgroup.com. Do not build the full draw workflow here; it lives on a separate
portal."* In code, the entire draw feature is a single once-only timestamp + fan-out email
(`src/routes/borrower.js:300-347`, `db/097_draw_request_once.sql`). There is **no draw table, no
wire-info form, no draw-document generation** in this repo.

So the DocuSign *mechanism* for wire collection is straightforward (a template/DocGen form with data
tabs the borrower fills, signed and returned), but **where it lives is a business/architecture decision
for the owner** (§13). If it lives here, the security bar is the highest in the whole integration:

- **Bank account + routing numbers are wire-fraud targets** — treat them like SSN: **encrypt at rest**
  (reuse the AES-256-GCM pattern in `src/lib/crypto.js`), **redact from every webhook-inbox payload,
  log, and audit `detail`** (mirror the ClickUp inbox SSN redaction, `clickup-webhook.js:22-36`), and
  **never enable Connect "Include Documents"** for these envelopes (fetch over TLS via API instead so
  the numbers aren't sitting in a webhook body).
- **Signed wire authorization** is the point — the returned document is legal evidence of the borrower's
  wire instructions, with the Certificate of Completion (IP, timestamps, identity) as the anti-fraud
  audit trail. Consider stronger recipient auth (access code / SMS / KBA) for this envelope specifically.

**Recommendation:** confirm with the owner whether wire collection belongs in this portal or the
separate draw portal **before** designing it; if here, it gets its own hardened sub-design.

---

## 7. Proposed data model & code architecture (all code-grounded)

### 7.1 Schema — extend `esign_envelopes`, add an envelope↔document map

The existing `esign_envelopes` (`db/037:78-92`) is shaped **one-condition ↔ one-envelope**. For the
owner's multi-document envelopes, add a new idempotent migration (`db/1NN_esign_envelopes_v2.sql`,
never edit `037`):

- On `esign_envelopes`: add `application_id uuid`, `purpose text` (`term_sheet`/`application`/
  `disclosures`/`wire_auth`/…), `sender_user_id`, `void_reason`, `sent_at`/`completed_at`,
  `idempotency_key text UNIQUE`, and keep `checklist_item_id` nullable (single-doc case still works).
- New `esign_envelope_docs(envelope_id, doc_kind, document_id_in_envelope, checklist_item_id,
  signed_document_id)` — one row per document in the envelope, so **one envelope can satisfy several
  conditions** and each signed PDF routes to its own condition + SharePoint folder. `signed_document_id`
  → the stored `documents` row created on completion.
- Widen the `documents.doc_kind` usage to include `application_signed`, `disclosures_signed`,
  `esign_certificate`, `wire_auth_signed` (today only `term_sheet`/`term_sheet_signed` are wired). The
  supersede-on-`doc_kind` pattern (`staff.js:5128-5133`) carries over.

### 7.2 Outbound send — durable queue mirroring the ClickUp outbox

Never call DocuSign inline from a request. Reuse the `sync_queue` machinery:

- `sync_queue` (`db/schema.sql:302-317`, statuses widened in `db/041:60-63` to include `dead`) — a new
  idempotent migration must **widen the `target` CHECK** (currently `clickup|encompass|graph`) to add
  `docusign`, or add a parallel `docusign_send_queue` with the same columns.
- A **`pushDocusignOnce`** worker mirrors `pushOutboxOnce` (`src/sync/clickup-sync.js:49-126`): claim
  with `FOR UPDATE SKIP LOCKED`, crash-orphan reclaim after 5 min, retry/backoff contract (transient/
  outage class: fixed spacing, many attempts; permanent class: exponential, ~8 attempts), and
  **dead-letter → a visible `sync_review_queue` row** with a "Retry send" action (nothing stuck is ever
  invisible — `clickup-sync.js:111-123`).
- **Idempotent create:** each send job carries a deterministic key. Two guards, so we never mint a
  duplicate envelope on a retry: **(a)** an atomic once-only DB claim before send (mirror the draw
  button's `UPDATE … WHERE draw_setup_requested_at IS NULL`, `borrower.js:314-316`) recorded as
  `esign_envelopes.idempotency_key`; **(b)** DocuSign's envelope idempotency header
  (`X-DocuSign-Idempotency-Key`, set to the job key) — *verify the exact header name + window in the
  Envelopes:create reference before relying on it; guard (a) is the primary and does not depend on it.*
- **Volume circuit breaker** on sends, like `CLICKUP_MAX_FIELD_WRITES_10MIN`
  (`orchestrator.js:479-507`) — **but DB-backed, not in-process**: the ClickUp breaker is an in-memory
  rolling window that does not coordinate across instances; a runaway envelope-send loop must be capped
  by a shared DB counter (Render can run >1 instance). Opening the breaker audits + parks jobs for retry.

### 7.3 Inbound — the Connect listener + inbox

- New route `src/routes/docusign-webhook.js`, mounted in `src/server.js` **in the raw-body block before
  `express.json()` (server.js:37)**, e.g. `app.use('/api/webhooks/docusign', require('./routes/docusign-webhook'))`.
  It applies its own `express.raw({type:'*/*', limit:'…'})` so HMAC covers exact bytes (identical to
  `clickup-webhook.js:39`).
- Verify HMAC (§5.3), **fail-closed in prod** if the secret is unset, **redact** any PII before persist,
  insert into a new **`docusign_event_inbox`** (shape = `clickup_webhook_inbox`, `db/042:35-49`:
  `event_id UNIQUE`, `event`, `envelope_id`, `payload`, `status`, `attempts`, …) with
  `event_id = sha256(rawBody)` `ON CONFLICT DO NOTHING`, and **return 200 fast**.
- A **`processDocusignInboxOnce`** drain worker (mirror `processInboxOnce`, `clickup-sync.js:644-672`)
  reacts to `envelope-completed`/`declined`/`voided`: fetch signed docs + certificate, persist, call
  `satisfyConditionBySystem`, or flag+notify staff on decline/void.

### 7.4 `satisfyConditionBySystem()` — the one guarded clear-a-condition helper

Today the **only** path to `status='satisfied'` is the private `signOffGate` + the HTTP
`PATCH /checklist/:itemId` handler (`staff.js:2400-2689`) — not callable from a webhook. Add a small
**exported** helper (in a `src/lib/conditions/` module) so the auto-clear runs through the *same*
guardrails as a human sign-off:

```
satisfyConditionBySystem(itemId, { source, documentId, envelopeId }) →
  1. attach/verify the signed document is a current, non-rejected `documents` row on itemId
     (the check the emergency doc-gate enforces, staff.js:2428-2437);
  2. set status='satisfied', signed_off_at=now(), a SYSTEM attribution (source='docusign');
  3. respect the DB trigger sow_budget_guard (db/069) — an e-sign condition is NOT a budget
     condition, so its COALESCE path passes; never bypass the trigger;
  4. enqueueChecklistStatusPush(itemId)  (mirror to ClickUp, enqueue.js:75);
  5. audit_log row (actor_kind='system', a new 'esign' action code — §7.6);
  6. idempotent: if already satisfied by this envelope, no-op.
```

This keeps "signed → condition clears" behind the exact document-present guarantee, ClickUp mirror, and
audit trail as a manual clear — the auditors' requirement.

### 7.5 Config & secrets

- The `docusign` config block exists (`config.js:251-260`). **Add** `docusign.connectHmacKeys` reading
  a new env `DOCUSIGN_CONNECT_HMAC_KEY` (support a comma list for rotation), mirroring
  `clickupWebhookSecret` (`config.js:213`) and `resendWebhookSecret` (`config.js:153`, dormant-until-set).
- All secrets flow through `resolveSecret` / env only (`config.js:34-50`), **never** source/commits/PRs/
  comments (CLAUDE.md hard rule). A secret pasted in chat is **compromised → rotate** before use. The
  RSA private key + Connect HMAC key live only in Render env / the secret store.
- **Fail-closed in production:** the webhook 503s if the HMAC key is unset in prod; the send path stays
  dormant (`configured()` false) until all `DOCUSIGN_*` are set.

### 7.6 Permissions & audit

- **Permissions:** add a `send_esignature` capability to `src/lib/permissions.js` `CAPABILITIES`
  (`:28-44`) and gate the staff "send for signature" endpoint with
  `requireAuth + requirePermission('send_esignature')` (or reuse `manage_pricing`). The inbound webhook
  is role-unauthenticated **but HMAC-verified + fail-closed** (like the other webhooks).
- **Audit:** add `esign` action codes to `src/lib/audit-actions.js` (`ACTIONS` map + a new `esign`
  category, `:16-151`) — e.g. `esign_envelope_sent`, `esign_envelope_completed`,
  `esign_condition_satisfied`, `esign_envelope_declined`, `esign_envelope_voided`. Use the two existing
  writers: request-context `audit(req,…)` (`staff.js:120-125`) for staff-initiated sends;
  `logSync`/`auditSystem` (system) for webhook-driven state changes. **Detail must stay PII-free.**

### 7.7 Document persistence & download auth (reuse verbatim)

Signed PDFs + certificates flow in through the **existing** chokepoints: `decodeUploadBase64`
(`src/lib/upload-bytes.js:76-86`, the corruption guard) → `storage.save` (`src/lib/storage.js:91`) →
`recentDuplicateDocId` dedup (`src/lib/doc-dedup.js:21-43`) → `INSERT documents`. Downloads stream via
`serve-document.js` behind `canSeeDocument` (`staff.js:5436-5473`, `borrower.js:2169-2187`) — the signed
term sheet is authorized exactly like any other file document (assigned-officer scope / borrower
own-file scope), and `download_document` is audited.

---

## 8. Security, guards & manual-review model (the "$1M, nobody guesses" rules)

Written as hard rules in the house style. Every one mirrors an existing pattern in the codebase.

1. **HMAC is mandatory and fail-closed.** Verify **every** `X-DocuSign-Signature-N` header over the raw
   body; reject on mismatch (401); in production, **503 if the key is unset** (never accept an unsigned
   webhook). Pattern: `clickup-webhook.js:41-51`.
2. **Correlation is explicit, never inferred.** React only via the `esign_envelopes` DB row keyed on
   `envelopeId`, cross-checked against `envelopeCustomFields` (§4.4). **No matching on borrower name,
   address, or document contents** — the anti-guessing rule, the same discipline as the ClickUp
   identity graph.
3. **Idempotent end-to-end.** Inbox `event_id` `ON CONFLICT DO NOTHING`; envelope create carries a
   once-only DB claim; `satisfyConditionBySystem` no-ops if already satisfied. Duplicates/out-of-order
   Connect deliveries are harmless.
4. **A human is the send checkpoint (manual review).** Phase 1: **no envelope leaves without a staff
   click** ("Register & send for signature"). This *is* the owner's manual-review process and it doubles
   as the frozen-engine safety valve (§4.1). Later automation stays gated behind an explicit
   per-program opt-in flag.
5. **Nothing stuck is invisible.** A send that exhausts retries **dead-letters into
   `sync_review_queue`** with a "Retry send" action and notifies the loan officer (mirror
   `clickup-sync.js:111-123`, `sync-review.js`). A declined/voided envelope raises a staff notification.
6. **Volume circuit breaker on sends** — a shared **DB-backed** counter caps envelopes per rolling
   window (the in-process ClickUp breaker won't coordinate across Render instances). A runaway loop
   stops hard and audits, instead of mailing hundreds of borrowers.
7. **Demo can never reach a real borrower.** Demo envelopes are watermarked / not legally binding. Gate
   real sends on `NODE_ENV=production` **and** a production base URI **and** a go-live'd key; a
   misconfigured prod (missing secret) fails closed, never silently falls back to demo.
8. **PII is encrypted, redacted, and never inlined.** SSNs already are (`src/lib/crypto.js`,
   `redact.js`); **wire/bank numbers get the same treatment** (§6.3). Connect **"Include Documents" stays
   OFF** — fetch signed PDFs via API over TLS so PII isn't sitting in a webhook body, log, or audit
   `detail`. Inbox payloads are redacted before persist (mirror `clickup-webhook.js:22-36`).
9. **Evidence is always retained.** The **Certificate of Completion** is downloaded and stored next to
   every signed document (portal + SharePoint) — it is the litigation/anti-fraud record.
10. **No-delete parity.** Signed documents follow the SharePoint one-way, no-delete policy
    (`docs/SHAREPOINT-POLICY.md`) — mirrored, never overwritten, `conflictBehavior:'fail'`.
11. **Least privilege.** A dedicated **service user** (`esign@yscapgroup.com`) as the JWT `sub`, not a
    human's account; the Integration Key + RSA key are config/secret, not shared; consent is re-granted
    per environment.
12. **Two-audit-agent gate applies to the build.** Every change ships through the mandatory pre-merge
    and post-merge audits (CLAUDE.md) — the DocuSign code is held to the same bar as the sync code.

---

## 9. Compliance (US lending) — carry-forward + note

From `DOCUSIGN-INTEGRATION-RESEARCH.md §4`, still accurate:

- **ESIGN / ERSD consent.** DocuSign's Electronic Record & Signature Disclosure is on by default and
  shown to each signer first. YS Capital is a **business-purpose lender** (per the email footer:
  NMLS #2609746, business-purpose disclosure), so the consumer-consent provision of ESIGN
  (15 U.S.C. §7001(c)) generally does **not** apply — but keep ERSD on as best practice and align its
  text with YS's paper-copy/withdrawal procedures.
- **Evidence & retention.** Store the sealed/completed PDFs **and** the Certificate of Completion as the
  system of record (portal + SharePoint); don't rely on DocuSign retention alone.
- **Identity.** Embedded signing + `clientUserId` ties the signature to the portal-authenticated
  borrower; step up to access-code/SMS/KBA/IDV for high-risk envelopes (esp. wire authorization, §6.3).
  These are plan-dependent — confirm on the na4 account.

---

## 10. Rate limits & scale (confirmed from official docs)

- **3,000 requests/hour** per account (`X-RateLimit-Limit` header), **500 calls / 30-second** burst.
- **Per-envelope polling is throttled** (`Hourly_Envelope_Polling_Limit_Exceeded`; ~1 status GET per
  envelope per 15 min per app) → **use Connect, reconcile nightly, never poll** (§5.5).
- Loan volumes here are far under the hourly cap; the send worker's circuit breaker (§7.2) keeps us well
  clear even during a backfill.

## 11. 2026 platform context — IAM / Maestro / Navigator / MCP (what's relevant)

- **Build on the eSignature REST API v2.1 via JWT Grant + Connect.** That is the right, stable
  foundation for a custom LOS backend and it's what the existing stub targets. Everything below is
  optional future layering, **not** required for these workflows.
- **IAM (Intelligent Agreement Management)** — DocuSign's umbrella agreement platform. Not needed for
  send/sign/return; relevant only if YS later wants agreement analytics.
- **Maestro** — no-code workflow builder. Could later orchestrate multi-step signing choreography, but
  our workflows are simple enough to drive from our own durable queue; skip for now.
- **Navigator** — AI agreement repository/search. Not an integration primitive for us.
- **DocuSign MCP server / Claude connector** — lets an AI assistant *query/act on* DocuSign in natural
  language; useful for ad-hoc staff assistance, **not** the backend integration mechanism. Keep the
  production LOS flow on the REST API + Connect; MCP is a separate, optional convenience.

---

## 12. What I need from YOU (resources & access to provide)

Grouped so you can hand these over as they become available. **Do not paste any secret into chat** —
anything pasted is treated as compromised and must be rotated; put secrets straight into Render's
environment settings (or share via the agreed secret channel).

**A. DocuSign account setup (you or your DocuSign admin):**
1. Create a **free developer/demo account** (we build & test only against demo).
2. In demo → **Apps and Keys**: create an app, capture the **Integration Key** (not secret, but config).
3. On that app: **Add RSA Keypair** — DocuSign shows the **private key once**; put it in Render env
   (`DOCUSIGN_PRIVATE_KEY`). (JWT needs the RSA key, **not** a client secret.)
4. Decide + create a **service sender user** (recommend `esign@yscapgroup.com`) and give me its
   **User ID (GUID)** for the JWT `sub`.
5. Confirm the **production (na4) account plan** includes: **API access**, **Connect (webhooks)**, and —
   if we want in-portal signing / ID verification — **embedded/focused view** and **IDV**. (Some are
   add-ons; check with your DocuSign rep.)
6. When we're ready: **promote to production** (Developer Console one-button, or Go-Live), then re-create
   the RSA key, consent, and Connect config on production.

**B. The actual documents (the real business content — the biggest blocker to building):**
7. The **term sheet** — we already generate it, so mainly: confirm the exact PDF layout is the one to
   sign, and where signatures/dates go.
8. The **initial disclosures** package (PDF/DOCX) that should sign with the term sheet, if any.
9. The **loan-application** document you want signed (there is no stored signable application PDF today —
   we'll need its layout/fields).
10. The **wire-information / draw-authorization** form (fields + layout) — **and first, the §13 decision
    on whether it lives in this portal at all.**
11. For any document we should have DocuSign generate (Option B): the **DOCX with merge fields** and the
    exact field list.

**C. Business/branding:**
12. The **ERSD** text (or approval to use DocuSign's default) and the sender **email branding**
    (logo/from-name) for signature requests.
13. Which signers each document needs (borrower only? co-borrower? guarantor? YS counter-signer?) and
    whether signing is **in-portal (embedded)** or **email**.

**Once A + B(7,8) are in hand, the term-sheet workflow (§6.1) can be built end-to-end against demo.**

---

## 13. Open decisions requiring owner sign-off (each with a recommendation)

1. **Draw / wire-information scope.** Build wire collection **in this portal** or on the **separate draw
   portal**? _Recommendation:_ decide before designing; if here, it gets the hardened wire-PII sub-design
   (§6.3). This is the single biggest scope question.
2. **One envelope or several?** Term sheet alone, or term sheet + disclosures + application in one
   ceremony? _Recommendation:_ **one envelope per pipeline stage** — application+disclosures at intake,
   term sheet at terms — with the code treating "envelope = a set of doc kinds" so either grouping is a
   config choice.
3. **Auto-send vs staff-click (Phase 1).** _Recommendation:_ **staff clicks "send"** — it satisfies your
   manual-review requirement and protects the frozen pricing numbers. Full auto-send comes in Phase 2
   once server-side term-sheet rendering is byte-verified.
4. **Embedded vs email signing default.** _Recommendation:_ **embedded** for portal borrowers (seamless,
   ties signature to portal identity), **email** fallback for offline signers/co-signers.
5. **Signed-doc storage kinds & conditions.** Confirm the mapping: `term_sheet_signed` →
   `rtl_cond_signedts`; add `application_signed`, `disclosures_signed`, `esign_certificate`,
   `wire_auth_signed`. _Recommendation:_ as listed.
6. **Recipient auth strength for wire authorization.** _Recommendation:_ step up to access-code/SMS/KBA
   for the wire envelope specifically, given wire-fraud exposure.

---

## 14. Phased build plan

- **Phase 0 — Foundations.** Env + `resolveSecret` for the HMAC key; token cache on the stub; the
  `/api/webhooks/docusign` route + `docusign_event_inbox` + HMAC verify (fail-closed); the
  `esign_envelopes` v2 migration + `esign_envelope_docs`; `satisfyConditionBySystem` helper; `esign`
  audit codes + `send_esignature` capability. All dormant until env is set. _Verify against demo._
- **Phase 1 — Term sheet, staff-triggered (the flagship).** "Register & send for signature" →
  durable send worker → embedded/email signing → Connect completion → signed PDF to
  `Term Sheet/Signed` + `satisfyConditionBySystem(rtl_cond_signedts)` → `db/096` re-issue on change.
  Reconcile job. Dead-letter review rows.
- **Phase 2 — Application + disclosures.** Server-side generation (DocGen) of a signable application;
  combined-or-separate envelope; new signed doc kinds + conditions; ERSD alignment.
- **Phase 3 — Unattended term sheet (optional).** Server-side term-sheet render byte-verified against the
  frozen jsPDF, enabling no-click auto-send per program.
- **Phase 4 — Draw/wire authorization (only if §13.1 = "here").** Hardened wire-PII envelope with
  encryption, redaction, stronger recipient auth, no-inline-documents.

Each phase ships behind the two-audit-agent gate; each is dormant until its env/flags are set, so nothing
half-built can touch a real borrower.

---

## 15. Sources (official DocuSign, verified 2026-07-17)

- JWT Grant: https://developers.docusign.com/platform/auth/jwt/ · https://developers.docusign.com/platform/auth/jwt-get-token/ · best practices https://developers.docusign.com/platform/auth/jwt/jwt-best-practice/
- Scopes / consent: https://developers.docusign.com/platform/auth/reference/scopes/ · https://developers.docusign.com/platform/auth/consent/ · obtain-consent https://developers.docusign.com/platform/auth/reference/obtain-consent/
- Envelopes:create: https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/envelopes/create/
- Envelope custom fields: https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/envelopecustomfields/
- Tabs / prefilled tabs: https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/tabs/prefilled-tabs/ · anchor (AutoPlace) https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/tabs/auto-place/
- Composite templates: https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/templates/composite/
- Document Generation for eSignature: https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/documents/document-generation/ · https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/documentgeneration/
- Embedded signing / createRecipientView: https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/embedding/embedded-signing/ · https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/envelopeviews/createrecipient/ · focused view https://developers.docusign.com/docs/esign-rest-api/how-to/request-signature-focused-view/
- Connect (webhooks): https://developers.docusign.com/platform/webhooks/connect/ · JSON SIM event model https://developers.docusign.com/platform/webhooks/connect/json-sim-event-model/ · event triggers https://developers.docusign.com/platform/webhooks/connect/event-triggers/
- Connect HMAC: https://developers.docusign.com/platform/webhooks/connect/hmac/ · setup https://developers.docusign.com/platform/webhooks/connect/setting-up-hmac/ · validate https://developers.docusign.com/platform/webhooks/connect/validate/
- Rules & limits: https://developers.docusign.com/docs/esign-rest-api/esign101/rules-and-limits/ · API guidelines https://developers.docusign.com/platform/api-guidelines/
- Go-Live / Developer Console: https://developers.docusign.com/platform/go-live/ · Developer Console overview https://developers.docusign.com/extension-apps/developer-console-overview/
- MCP server: https://developers.docusign.com/platform/mcp-server/
- OpenAPI specs (for SDK/codegen + a machine-readable knowledge base): https://github.com/docusign/OpenAPI-Specifications

_See also the foundational `docs/DOCUSIGN-INTEGRATION-RESEARCH.md` (2026-07-13) for the credential
checklist, compliance detail, and the original risk/pitfall list._
