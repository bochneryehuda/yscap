# DocuSign — Per-Document Build Specification

_Research + build spec, 2026-07-17. **Nothing here is implemented.** Companion to
`docs/DOCUSIGN-INTEGRATION-BLUEPRINT.md` (the architecture: auth, durable queue, webhook infra,
security/guard model) and `docs/DOCUSIGN-INTEGRATION-RESEARCH.md` (platform fundamentals). This
document is the **document-by-document** spec: exactly which PDFs we generate, how signature slots are
placed, the exact envelope JSON, how each signed copy routes back to a condition and clears it, and
what the owner must provide. Produced by a 6-agent research sweep over the codebase + official DocuSign
docs, cross-checked. No secrets or customer data appear here; all examples are placeholders._

> **Read order:** BLUEPRINT for *how the machine is built* (auth, queue, guards); this doc for *what
> flows through it per document*. Where they overlap, this doc is the document-level detail.

---

## 1. The document set & the three envelopes (owner-confirmed 2026-07-17)

| # | Envelope | Documents signed together | Signers | Notarized? | Clears condition |
|---|---|---|---|---|---|
| **1** | **Terms** | Term sheet **+** application export | Borrower (+ co-borrower if present) | No | `rtl_cond_signedts` ("Signed term sheet"); + an application-signed condition |
| **2** | **Initial disclosures** | Business-purpose **affidavit** **+** business-purpose **disclosure** | Borrower (+ co-borrower; + guarantors if adopted) | **Affidavit: owner decision (§6.3).** Disclosure: no | A new "initial disclosures signed" condition |
| **3** | **Heter Iska** (standalone) | Heter Iska | Per the owner's nusach (borrower ± lender) | No (halachic, not civil notary) | The existing `iska` condition (already tracked, `src/clickup/fields.js:118`) |

Each envelope carries its own webhook and its own correlation IDs; each signed document routes to its
own condition. "Envelope = a set of `doc_kind`s" is a config object so grouping can change per program.

---

## 2. Signer & recipient model

### 2.1 Who can sign (what the data supports today)
- **Borrower** — always present. `applications.borrower_id → borrowers` (`db/schema.sql`). `borrowers.email`
  is `citext UNIQUE NOT NULL` (`schema.sql:54`) — an email is guaranteed.
- **Co-borrower** — optional. `applications.co_borrower_id` is a nullable self-FK into `borrowers`
  (`schema.sql:158`); NULL means no co-borrower. Its email is **also guaranteed**: the link path
  hard-requires it (`src/routes/staff.js:1128`, "co-borrower email is required") and the column is
  `NOT NULL`. So we never null-guard a co-borrower email.
- **No first-class "guarantor" signer exists in the data.** There is no `applications.guarantor_id`;
  the only structured file signer beyond the primary is `co_borrower_id`. A `partners` table
  (`db/019`) is a borrower-profile directory of guarantors/partners/members (with `email`, and
  `partner_borrower_id → borrowers` when they have an account) — but it is **not** wired as a file
  signer, and ClickUp ingest even folds a "guarantor" subtask into the co-borrower slot
  (`src/clickup/ingest.js:885,902`). So today, signers = borrower + optional co-borrower. If guarantors
  must sign the affidavit (industry practice leans yes), routing them is a **new data-model + owner
  decision** (§8/§10) — not something to infer.
- **Entity signatory** — for an LLC borrower, the human who signs in a representative capacity
  ("By: ___, Manager"). The term sheet already models entity-vs-individual signers
  (`termsheet.js:1170-1187`); the new generators must too.
- **Additional file contacts are NOT signers** — `service_contacts`/`general_file_contacts`
  (`db/017`, `db/078`) are title/insurance/attorney/realtor vendors. Never add them as DocuSign signers.

### 2.2 The one query that builds the signer list (borrower + optional co-borrower)
```sql
SELECT a.id, a.ys_loan_number,
       b.first_name  AS b_first,  b.last_name  AS b_last,  b.email  AS b_email,
       cb.first_name AS cb_first, cb.last_name AS cb_last, cb.email AS cb_email,
       a.co_borrower_id
FROM applications a
JOIN      borrowers b  ON b.id  = a.borrower_id
LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
WHERE a.id = $1 AND a.deleted_at IS NULL;
```
This canonical LEFT-JOIN pattern is already used at `staff.js:169-171, 1101-1103, 1398-1400`. The
co-borrower columns are NULL exactly when there is no co-borrower — **that NULL is the on/off switch**
for the second signer. Build `signers = [borrower]`, then push the co-borrower **only if
`co_borrower_id` is set**. `recipientId` is a unique string per envelope (`"1"`, `"2"`); `routingOrder`
`"1"`/`"1"` = both sign in parallel.

### 2.3 Embedded (in-portal) vs remote (email) signing
`clientUserId` on a signer is **load-bearing**: set it → the signer is *embedded* (DocuSign sends **no**
email; we mint a signing URL via `createRecipientView` with matching name/email/clientUserId, ~5-min
single-use). Omit it → DocuSign emails that signer at their turn. We can mix embedded + remote in one
envelope. Recommended default: **embedded** for portal borrowers, **email** for offline co-signers.
Decide per recipient at send time (an owner decision, §12).

---

## 3. Anchor-string convention (how signature slots land automatically)

Signature/date slots are placed by **anchor tagging**: the generator prints an invisible marker string
in the PDF text layer at the exact spot; DocuSign finds it and drops that recipient's tab there. This
is how "the signature slot is placed automatically, and a co-borrower slot only when there's a
co-borrower" works — with the frozen jsPDF PDFs, untouched.

### 3.1 The invisible-anchor helper (jsPDF)
DocuSign reads the text layer regardless of color, so white-on-white tiny text is invisible to humans
but machine-readable. Add this next to the signature-line drawing (`termsheet.js sigBlock` @ `:1152`;
the loan-app signature loop @ `:1764`):
```js
// Invisible DocuSign anchor: white, tiny, placed AT the target x/y. Restore color/size after.
function anchor(doc, tag, x, y) {
  var prevSize = doc.getFontSize();
  doc.setTextColor(255, 255, 255);   // white on white
  doc.setFontSize(4);                // tiny so it never nudges layout
  doc.text(tag, x, y);
  doc.setFontSize(prevSize);
  doc.setTextColor(19, 32, 28);      // restore INK before the next visible draw
}
```

### 3.2 Naming — unique per document AND per signer
An envelope carries several of our PDFs; if a tab has **no `documentId`**, DocuSign matches the anchor
across **all** documents and drops a tab at every match (the classic accidental duplication). **Two
defenses, use both:** (a) unique per-document prefixes, and (b) set `documentId` on every tab.

Scheme `/<docprefix>_<role>_<field>/` with delimiters, zero-padded indices so one tag is never a
substring of another:

| Document | prefix | borrower sig / date | co-borrower sig / date |
|---|---|---|---|
| Term sheet | `ts` | `/ts_b1_sig/` `/ts_b1_dt/` | `/ts_b2_sig/` `/ts_b2_dt/` |
| Application export | `app` | `/app_b1_sig/` `/app_b1_dt/` | `/app_b2_sig/` `/app_b2_dt/` |
| Business-purpose affidavit | `bpa` | `/bpa_b1_sig/` `/bpa_b1_dt/` … | `/bpa_b2_sig/` … |
| Business-purpose disclosure | `bpd` | `/bpd_b1_sig/` … | `/bpd_b2_sig/` … |
| Heter Iska | `iska` | `/iska_b1_sig/` `/iska_b1_dt/` | (per nusach) |

**Emit the co-borrower anchor only inside the existing `if (coBorrowerName)` branch** (`termsheet.js:1181`)
so a borrower-only PDF contains no co-borrower anchor at all. Belt-and-suspenders: set
`anchorIgnoreIfNotPresent:"true"` on every tab so a missing anchor places no tab instead of failing the
whole envelope (default fails the create with `ANCHOR_TAB_STRING_NOT_FOUND`). A leftover anchor **that
no tab references is inert** — DocuSign only searches for strings a tab asks for.

---

## 4. The generators to build (jsPDF pattern)

Every PDF here is generated **client-side with jsPDF** (CDN, loaded lazily), then the bytes go to the
server via the one upload contract `{ filename, contentType, dataBase64 }`. Reference implementation:
`web/tools/termsheet.js exportPdf(btn, returnBlob)` (`:976-1246`; blob at `:1240`). To add a new
signable PDF, follow the recipe below **in both `web/tools/*` and `web/v2/tools/*`** (the v1/v2-in-sync
rule) and bump the host page `?v=` cache-buster.

### 4.1 The recipe
1. **Pick a `doc_kind` + anchor prefix** — `application_export`/`app`, `bp_affidavit`/`bpa`,
   `bp_disclosure`/`bpd`, `heter_iska`/`iska`. `doc_kind` is a free-text column (`db/012:23`, no enum),
   so **no migration is needed for the value**.
2. **Write the generator** following `termsheet.js exportPdf` — reuse `ensurePDF()` (jsPDF 2.5.1),
   `new jsPDF({unit:"pt",format:"letter"})`, the `header/footer/band/para/rowFull/sigBlock` helpers,
   `pdfSafe()`. Pull values from `YS.collectState()` / `gather()`.
3. **Emit unique invisible anchors** (§3) per signer + date, prefixed per document.
4. **Render to blob & hand to the server** — add a `returnBlob` param returning `doc.output("blob")`
   (like `termsheet.js:1240`); convert with the `blobToB64` FileReader helper (`:1419`); `POST
   /api/staff/applications/:id/documents` (staff) or `/api/documents` (borrower) with
   `{ filename, contentType:'application/pdf', dataBase64, docKind:'<new>' }`.
5. **⚠️ EXTEND THE `docKind` WHITELIST — the critical chokepoint.** Today
   `const docKind = b.docKind === 'term_sheet' ? 'term_sheet' : null;` at **`src/routes/staff.js:5107`
   AND identically `src/routes/borrower.js:1990`** silently coerces any other kind to `null`. New kinds
   **will not store** until both lines accept them. Also update the doc-kind label maps
   (`app-v2/src/screens/Application.jsx:1179`, `StaffApplication.jsx:2765`, `lib/leadCrm.js:26`).
   Optionally replicate the `term_sheet` supersede/auto-attach blocks (`staff.js:5128`, `:5077-5081`)
   if you want one-current-per-file behavior for the new kind.
6. **Persist path (unchanged)** — bytes flow `decodeUploadBase64` (`upload-bytes.js:76`) →
   `storage.save` (`storage.js:91`) → `INSERT documents (... doc_kind, checklist_item_id ...)`; dedup via
   `doc-dedup.js`.

### 4.2 Attended vs unattended generation — an owner/architecture decision
These generators are **browser-only by construction** (`collectState()` reads live DOM, jsPDF loads
into `window`, the Studio capture needs an iframe). So:
- **Attended (recommended Phase 1):** a person is on the portal / Studio — reuse the `capturePdf`
  iframe bridge (`TermSheetStudio.jsx:341-357`) that monkey-patches `jsPDF.API.save` to grab the blob.
  No headless needed. This doubles as the manual-review checkpoint the owner wants.
- **Unattended (Phase 2+):** to auto-issue the moment a product registers, either (a) drive the tool
  with **headless Playwright** (available in this env) and read the blob, or (b) **port the generator
  to a server-side jsPDF** fed from DB fields (cleanest for unattended, but adds a third copy to keep
  in sync — weigh against the strict v1/v2 rule). **Unresolved in the codebase — settle before building
  the four new generators.**

### 4.3 The five documents
- **Term sheet** (`ts`) — exists (`web/tools/termsheet.js`), already stored as `doc_kind='term_sheet'`.
  Only add: the invisible anchors in `sigBlock`, and a `returnBlob` path for the envelope send.
- **Application export** (`app`) — NEW. Today `loan-application.html` produces a **download-only**
  applicant copy (`exportPdf` @ `:1717`, `doc.save` @ `:1778`, no upload) and submit only creates a
  `leads` row. To make it signable: add `returnBlob`, emit anchors in the signature loop (`:1764-1776`),
  store as `doc_kind='application_export'`. Goes in **Envelope 1** with the term sheet.
- **Business-purpose affidavit** (`bpa`) — NEW. Content spec in §6.1. Goes in **Envelope 2**.
- **Business-purpose disclosure** (`bpd`) — NEW. Content spec in §6.2. Goes in **Envelope 2**.
- **Heter Iska** (`iska`) — NEW, standalone **Envelope 3**. Content spec + halachic constraints in §7.
  The owner provides the exact nusach; the generator only fills blanks.

---

## 5. Envelope-create JSON + webhook + completion (verified against DocuSign v2.1)

### 5.1 Envelope 1 — term sheet + application, borrower (+ optional co-borrower)
`POST {baseUri}/restapi/v2.1/accounts/{ACCOUNT_ID}/envelopes`
```jsonc
{
  "emailSubject": "Your loan documents are ready to sign — Loan #<ys_loan_number>",
  "emailBlurb": "Please review and sign your term sheet and application.",
  "status": "sent",
  "documents": [
    { "documentBase64": "<TERM_SHEET_PDF>",  "name": "Term Sheet",       "fileExtension": "pdf", "documentId": "1" },
    { "documentBase64": "<APPLICATION_PDF>",  "name": "Loan Application", "fileExtension": "pdf", "documentId": "2" }
  ],
  "recipients": {
    "signers": [
      {
        "email": "<borrower_email>", "name": "<borrower_name>",
        "recipientId": "1", "routingOrder": "1",
        // clientUserId: "<borrowers.id>"  ← set ONLY for embedded/in-portal signing; omit for emailed signing
        "tabs": {
          "signHereTabs": [
            { "anchorString": "/ts_b1_sig/",  "documentId": "1", "anchorUnits": "pixels", "anchorMatchWholeWord": "true", "anchorIgnoreIfNotPresent": "true" },
            { "anchorString": "/app_b1_sig/", "documentId": "2", "anchorUnits": "pixels", "anchorMatchWholeWord": "true", "anchorIgnoreIfNotPresent": "true" }
          ],
          "dateSignedTabs": [
            { "anchorString": "/ts_b1_dt/",  "documentId": "1", "anchorUnits": "pixels" },
            { "anchorString": "/app_b1_dt/", "documentId": "2", "anchorUnits": "pixels" }
          ]
        }
      }
      // ── push this SECOND signer ONLY when co_borrower_id is set ──
      ,{
        "email": "<coborrower_email>", "name": "<coborrower_name>",
        "recipientId": "2", "routingOrder": "1",
        "tabs": {
          "signHereTabs": [
            { "anchorString": "/ts_b2_sig/",  "documentId": "1", "anchorUnits": "pixels", "anchorIgnoreIfNotPresent": "true" },
            { "anchorString": "/app_b2_sig/", "documentId": "2", "anchorUnits": "pixels", "anchorIgnoreIfNotPresent": "true" }
          ],
          "dateSignedTabs": [
            { "anchorString": "/ts_b2_dt/",  "documentId": "1", "anchorUnits": "pixels" },
            { "anchorString": "/app_b2_dt/", "documentId": "2", "anchorUnits": "pixels" }
          ]
        }
      }
    ]
  },
  "customFields": {
    "textCustomFields": [
      { "name": "ys_file_id",    "value": "<application uuid>", "show": "false", "required": "false" },
      { "name": "ys_envelope",   "value": "terms",             "show": "false" },
      { "name": "ys_doc_kinds",  "value": "term_sheet,application_export", "show": "false" }
    ]
  },
  "eventNotification": {
    "url": "https://<portal>/api/webhooks/docusign",
    "loggingEnabled": "true",
    "requireAcknowledgment": "true",
    "includeDocuments": "false",
    "includeCertificateOfCompletion": "false",
    "includeEnvelopeVoidReason": "true",
    "eventData": { "version": "restv2.1", "format": "json", "includeData": ["custom_fields", "recipients", "documents"] },
    "envelopeEvents": [
      { "envelopeEventStatusCode": "completed" },
      { "envelopeEventStatusCode": "declined" },
      { "envelopeEventStatusCode": "voided" }
    ],
    "recipientEvents": [
      { "recipientEventStatusCode": "Completed" },
      { "recipientEventStatusCode": "Declined" }
    ]
  }
}
```

### 5.2 Envelope 2 — initial disclosures (affidavit + disclosure)
Same shape; `documents` = affidavit (`documentId:"1"`, anchors `/bpa_*/`) + disclosure
(`documentId:"2"`, anchors `/bpd_*/`); `customFields.ys_envelope="initial-disclosures"`,
`ys_doc_kinds="bp_affidavit,bp_disclosure"`. **If the affidavit is notarized (§6.3), it is NOT a plain
signer flow** — it needs a notary recipient / Remote Online Notarization and may be split out.

### 5.3 Envelope 3 — Heter Iska (standalone)
One document (`documentId:"1"`, anchors `/iska_*/`), signer(s) per the nusach,
`customFields.ys_envelope="heter-iska"`, `ys_doc_kinds="heter_iska"`. Separate envelope so it has its
own lifecycle and its own condition.

### 5.4 Per-envelope webhook + completion handling
On the Connect `envelope-completed` event (listener mounts before `express.json()`, HMAC-verified
per BLUEPRINT §5.3):
1. Verify HMAC on the raw body (`X-DocuSign-Signature-N`), parse JSON, read `data.envelopeId` and the
   correlation IDs from `data.envelopeSummary.customFields.textCustomFields[]` (present because
   `includeData` has `custom_fields`). **Ack 200 fast**, process async.
2. Enumerate documents authoritatively: `GET .../envelopes/{id}/documents` → each `{documentId, name,
   type}` (content docs are `type:"content"`; the certificate is `type:"summary"` /
   `documentId:"certificate"`). Match `documentId`/`name` to what we assigned at create.
3. Fetch each signed PDF: `GET .../envelopes/{id}/documents/{documentId}` with `Accept: application/pdf`.
   Fetch the Certificate of Completion: `GET .../envelopes/{id}/documents/certificate`.
4. Persist each via the standard chokepoint → `documents` rows with the SIGNED kind
   (`term_sheet_signed`, `application_signed`, `bp_affidavit_signed`, `bp_disclosure_signed`,
   `heter_iska_signed`, `esign_certificate`) and `checklist_item_id` set → SharePoint mirrors
   `term_sheet_signed` to `Term Sheet/Signed`.
5. Call `satisfyConditionBySystem(itemId, {source:'docusign', documentId, envelopeId})` per §8.

---

## 6. Business-purpose documents — content spec

_Informational drafting guidance, **not legal advice.** Final wording, the notary decision, the statute
list, and the signer set must be confirmed by counsel licensed in each lending state. Regulatory basis:
business-purpose loans are exempt from TILA/Regulation Z under **12 CFR 1026.3(a)(1)** — "credit
primarily for a business, commercial, or agricultural purpose," i.e. **not** personal/family/household.
The signed borrower statement is documented **evidence of intent, not a waiver** — it supports the
exemption, it does not by itself establish it._

### 6.1 Business-purpose affidavit (sworn)
**Identifying fields (generator fills from the loan file):** document title; loan number; borrower(s)
entity + individual name(s); guarantor(s); property address; loan amount; closing/maturity date
(optional); affiant name + representative title; notary venue "State of __, County of __" (if notarized);
lender name + NMLS #2609746.

**Attestation recitals (fixed body text, paraphrased — counsel to finalize):**
1. **Business purpose only** — the loan is for business/commercial/investment purposes only, not
   personal/family/household.
2. **Use of proceeds** — proceeds used to purchase/improve/operate the property as an income-producing
   investment; lease efforts if unleased at closing.
3. **Non-owner-occupancy** — no borrower, guarantor, common-control entity, member/manager/officer, or
   immediate family occupies or will occupy the property as a residence while the loan is outstanding.
4. **Reliance & indemnification** — the lender relies on this affidavit; borrower indemnifies for any
   misrepresentation (incl. attorneys' fees).
5. **Default remedy** — misrepresentation is an Event of Default (acceleration/foreclosure/eviction).
6. **Exemption acknowledgment** — borrower understands the loan may be outside certain consumer
   protections, expressly TILA (15 U.S.C. §1601 et seq.) and Regulation Z (12 CFR Part 1026); optionally
   RESPA, GLBA, SAFE Act, HPA.
7. **Penalties / survival** — false statements may carry penalties; covenants survive closing.

**Optional:** an occupancy-initials checkbox (per-signer initials anchor); a use-of-proceeds free-text
blank (`loan.useOfProceeds`).

**Signature block:** one group per borrower + per guarantor (signature, printed name, title, date) —
anchors `/bpa_b1_sig/`, `/bpa_b1_dt/`, … **Notary jurat block** (venue, "subscribed and sworn before
me…", notary signature, commission expiry, seal) — only if notarized (§6.3).

### 6.2 Business-purpose disclosure (acknowledgment — not sworn)
Differs from the affidavit: no oath, **no notary**, shorter. **Fields:** date; borrower name(s)/entity;
borrower mailing address; loan number; property address. **Body (paraphrased):** the loan is for
business/commercial purposes, not consumer/household; property is/will be non-owner-occupied investment;
because it is business-purpose, consumer-transaction laws don't apply (TILA; RESPA; GLBA; SAFE Act; HPA);
borrower has read and understands, and affirms accuracy. Optional use-of-proceeds blank. Signature + date
per signer (`/bpd_b1_sig/`…). **No notary block.**

### 6.3 The notary decision (owner) — and its DocuSign impact
An **affidavit is sworn** and is often **notarized** (jurat); a **disclosure is not**. Notarization
can't be done by plain DocuSign e-signature — it needs a notary, in person or via **Remote Online
Notarization (RON)** / **DocuSign Notary**, and RON availability/acceptance **varies by state**.
- **Option A — e-signed attestation (no notary):** the affidavit is a plain e-signed representation;
  simplest, fits the normal envelope flow. Common among private lenders.
- **Option B — notarized affidavit (RON/DocuSign Notary):** adds a notary recipient/step and per-state
  RON rules; the affidavit likely splits out of the plain disclosures envelope.
The **disclosure stays e-signed either way.** Both are valid under ESIGN (15 U.S.C. §7001) + state UETA
once the signer consents (DocuSign's ERSD handles consent). **Owner + counsel must choose A or B.**

---

## 7. Heter Iska — spec & halachic constraints

_Factual summary for document setup, **not halachic advice.** The controlling text and its
acceptability must be confirmed by YS Capital's own Rav/posek._

**What it is:** a halachic instrument that permits the lender to earn a profit on money advanced to a
Jewish borrower without violating the Torah prohibition of *ribbis* (interest between Jews), by
re-characterizing the transaction as a **joint business venture (iska)** — investment capital placed
with the borrower as managing partner, whose return is the investor's *profit share*, not interest.

**Standard structure (two common formats):** *chatzi milveh / chatzi pikadon* ("half loan / half
investment") or *kulo pikadon* ("entirely investment"). Core clauses: investment characterization;
profit-and-loss sharing per the chosen split; a **proof-of-loss clause** (loss only via two kosher
witnesses before a Bais Din); a **proof-of-profit clause** (reduced profit only via a solemn oath); and
the **fixed-payment/oath-waiver clause** — paying the pre-agreed amount waives witnesses/oath, so the
fixed payment stands as the investor's profit. Often references a recognized *nusach*/Rav and a named
Bais Din for disputes.

**Who signs / formalities:** at minimum the **borrower (recipient/managing partner)**; the **lender's
signature is common/advisable**; witnesses (*eidim*) are **not required for validity** but sometimes
used. Executed **once per loan** as boilerplate alongside the loan documents.

**Generator fields:** investor (lender) entity; managing partner (borrower) entity + signatory;
execution date; principal/investment amount; term; the fixed "profit"/payment figures; property (if
referenced); structure selector (chatzi vs kulo, if the template offers it). Governing Bais Din /
*nusach* are usually fixed in the template.

**⚠️ Hard constraints (owner must resolve — §12):**
1. The **exact approved nusach + layout** comes from the owner's Rav/posek. The generator **only fills
   blanks** — it must never generate, paraphrase, or alter halachic wording.
2. **E-signature acceptability is a שאלה for the Rav.** E-signatures generally bind via *situmta*
   (accepted commercial practice), so an e-signed heter is widely defensible — **but** some authorities
   distinguish a binding e-signature from a formal *shtar* with witnesses and question its evidentiary
   weight for later loss/profit disputes. **Get the Rav's explicit sign-off** on executing the Heter
   Iska specifically via DocuSign, including whether a wet-ink original or witnesses are additionally
   required.
3. Confirm structure (chatzi vs kulo), who signs (borrower only vs borrower + lender vs + witness lines),
   and the named Bais Din.

---

## 8. Conditions, doc_kinds & auto-clear (the "sign → clear the condition if rules pass")

### 8.1 What already exists (tracking side is pre-staged)
- **Checklist template `rtl_cond_signedts`** ("Signed term sheet") already exists (seed `db/051:48-53`)
  and auto-reopens on economics change (`db/096:68-78`).
- **A checklist template `rtl_cond_iska` ("ISKA") already exists too** (seed `db/051:59-64`; phase 5,
  `prior_to_closing`, `tpr_exclude`). **Open question (§10):** is this existing "ISKA" condition the
  Heter Iska (→ reuse it) or a different document (→ create `rtl_cond_heter_iska`)?
- **ClickUp condition fields already exist** for both **`signedTermSheet`** (`src/clickup/fields.js:114`)
  and **`iska`** (`fields.js:118`) — the tracking slots are already wired.
- **`esign_envelopes` table** exists (`db/037:79-92`) with `checklist_item_id` + `completed_document_id`.

### 8.2 What must be created (idempotent `db/NNN` migration + backfill)
| Envelope doc | signed `doc_kind` | Checklist condition |
|---|---|---|
| Term sheet | `term_sheet_signed` | `rtl_cond_signedts` (EXISTS, `db/051:48-53`) |
| Application export | `application_signed` | **CREATE** `rtl_cond_signed_app` |
| Biz-purpose affidavit + disclosure | `bp_affidavit_signed`, `bp_disclosure_signed` | **CREATE** `rtl_cond_disclosures` (one, or one each) |
| Heter Iska | `heter_iska_signed` | **reuse `rtl_cond_iska` if it IS the Heter Iska**, else **CREATE** `rtl_cond_heter_iska` (§10) |

New checklist templates follow the house rules: idempotent `db/NNN` migration with the seed +
deterministic backfill patterns already in `db/051` (`INSERT … SELECT … WHERE NOT EXISTS` at `:24-53`;
open-file backfill at `:96-115`) so **previous AND future** files get them (CLAUDE.md). Mark each as an
e-sign condition by setting the template's `esign_doc` descriptor (`db/037:36`) — the engine then treats
it as rendering its own borrower label (`engine.js:225`). Each new signed `doc_kind` also needs a
**SharePoint routing entry** alongside `term_sheet_signed` (`sharepoint-backup.js:164-209`,
`folderPathFor`/`scopeKeyFor`/`KIND_STREAM`) — note `term_sheet_signed` is mapped there but *never
produced by any code today*, so the completion handler is its first producer. **EXCEPTION:
`heter_iska_signed` must NEVER be added to SharePoint routing** (and `rtl_cond_iska` is already
`tpr_exclude=true`) — the Heter Iska package is kept only in-system + on DocuSign; see **Addendum A.3**
for this hard rule and the finalized packaging/trigger logic that supersedes §1.

### 8.3 Bind the envelope to its condition AT SEND TIME (no guessing on the way back)
`esign_envelopes` already carries `checklist_item_id` and `completed_document_id` (`db/037:82,87`). So
at **send** time, resolve the target condition once (by template code — the exact
`checklist_items JOIN checklist_templates ON code=…` pattern in `co-borrower.js:30-38`) and store
`checklist_item_id` on the envelope row. The completion webhook then uses that stored id directly — no
re-resolution, no ambiguity if two conditions ever share a `doc_kind`. A `DOC_KIND_TO_TEMPLATE` map
(`term_sheet_signed→rtl_cond_signedts`, `application_signed→rtl_cond_signed_app`,
`disclosures_signed→rtl_cond_disclosures`, `heter_iska_signed→rtl_cond_iska`/`rtl_cond_heter_iska`) is
only the fallback for a *manual* signed-doc upload not tied to an envelope. **Because one envelope
(term sheet + application) satisfies two conditions, the envelope↔condition link must be one-to-many** —
use the `esign_envelope_docs` map proposed in BLUEPRINT §7.1 (one row per document → its `doc_kind` +
`checklist_item_id`).

### 8.4 The clear itself — conservative by default, rule-gated auto-clear opt-in
Today `rule_logic` drives only whether a template is **attached/retracted** (`auto_apply='rules'`,
`engine.js:206-247`); it **never** flips an item to `satisfied`. Satisfaction is a deliberate human act
(sign-off/waive through `signOffGate`, `staff.js:2400-2634`). There are, however, **system auto-satisfy
precedents** that bypass the human click with a system stamp + `[auto]` note — LLC-verified
(`llc.js:325-339`), liquidity-accept (`liquidity.js:100`), experience (`experience.js:150,190`). The
DocuSign clear copies that precedent, in three tiers:

1. **Default (conservative, codebase-consistent):** the completed PDF uploads into the condition and the
   item goes to **`status='received'`** (exactly like a human upload, `staff.js:5153`) — "signed and
   provided, awaiting the back office." A **processor signs off** as usual. This needs **no rule engine
   at all** and is the safe default for every condition unless explicitly opted in.
2. **Update tracking:** set `esign_envelopes.status='completed'` + `completed_document_id`, and
   `enqueueChecklistStatusPush(itemId)` so the ClickUp dropdown (e.g. the signed-term-sheet field)
   reflects it.
3. **Opt-in, rule-gated auto-clear → `satisfied`** (the owner's "clear it if all the rules are
   figured"): only when the template is explicitly marked auto-clearable **and** its clear-rule passes.
   Implementation detail that matters: **do NOT overload `rule_logic`** (it already governs attachment) —
   add a **distinct `esign_clear_rule jsonb`** column (new idempotent migration). The webhook then:
   no clear-rule → stay `received`; clear-rule present → evaluate it via
   `rules.evaluateRule(clearRule, ctx, fieldMap)` (`engine.js:49,188`); **false → stay `received` +
   notify staff (never silently cleared)**; **true → also run `signOffGate(itemId, null)`** (the same
   guard the human path uses) and, only if it returns null, set `status='satisfied'` with a **system
   stamp** (`signed_off_by=NULL, signed_off_at=now()`, `[auto] Signed via DocuSign — envelope <id>`),
   copying `llc.js:328-331`.

This is the literal reading of the owner's intent: a completed signature is **necessary but not
sufficient** — the system auto-clears only when the signed doc is present, the condition's clear-rule
evaluates true against live file data, and `signOffGate` passes; everything else stays a processor
sign-off. It composes with the existing reopen triggers — `db/096:66-76` already reopens
`rtl_cond_signedts` on an economics change, so a system-cleared signed-term-sheet condition correctly
reopens and re-requests a fresh signature when the deal changes.

---

## 9. Version-sensitive "do NOT get it wrong" list (baked-in guards)

1. **Event status-code casing** — `envelopeEventStatusCode` values are **lowercase** (`completed`,
   `declined`, `voided`); `recipientEventStatusCode` values are **Capitalized** (`Completed`, `Declined`).
   Mixing casing **silently drops events**. (Verify against the current EventNotification reference.)
2. **`eventData.version` must be `"restv2.1"`** and **`format:"json"`** — omit `format` and Connect sends
   legacy XML.
3. **`anchorMatchWholeWord`** default is version/SDK-inconsistent — **always set it explicitly**.
4. **Tab `documentId` scoping** — a tab without `documentId` matches its anchor across **all** documents
   → duplicate tabs. Always set unique per-doc anchors **and** `documentId`.
5. **`anchorIgnoreIfNotPresent:"true"`** on every tab so a missing anchor doesn't 400 the whole send.
6. **Per-envelope Connect requires an account setting** (envelope-level Connect enabled). If webhooks
   silently never fire, that's the usual cause — else use one account-level Connect config.
7. **`clientUserId` is load-bearing** — present = embedded (no email; must call `createRecipientView`);
   absent = DocuSign emails the signer.
8. **`includeDocuments:false`** on the webhook — fetch signed PDFs via API over TLS (payloads with
   embedded base64 get large/droppable, and keep PII out of the webhook body).
9. **Boolean fields are JSON strings** (`"true"`/`"false"`) — DocuSign convention.
10. **`{accountId}`** is the API account id from `oauth/userinfo`, **not** the GUID in the console URL.
11. **The `docKind` whitelist** (`staff.js:5107`, `borrower.js:1990`) silently drops unknown kinds —
    extend both before any new document can store.
12. **`aud`** in the JWT is the bare auth host (`account-d.docusign.com`/`account.docusign.com`), no
    scheme, not the `na4` base URI.

---

## 10. Consolidated owner decisions & what to provide

**Documents/layouts to provide (the biggest blocker):**
1. **Application export** — confirm the layout/fields to sign (the signable version doesn't exist yet).
2. **Business-purpose affidavit** — attorney-approved wording + the **notary decision** (§6.3) + which
   statutes to cite + whether guarantors sign.
3. **Business-purpose disclosure** — attorney-approved wording.
4. **Heter Iska** — the **exact approved nusach + layout** from your Rav, the structure (chatzi vs kulo),
   who signs, and your **Rav's sign-off that DocuSign e-signature is acceptable** for it (§7). Also:
   **is your existing "ISKA" condition** (already in the system, `rtl_cond_iska`) **the Heter Iska**
   (reuse it) **or a separate document** (create a new one)?

**Decisions:**
5. **Embedded (in-portal) vs email** signing default, per document/recipient.
6. **Attended vs unattended** generation (Phase 1 = staff-triggered/attended; §4.2).
7. **Guarantors** — do they sign the affidavit? (No first-class guarantor signer exists today — only
   borrower + co-borrower; adding guarantor routing is new work, §2.1.)
8. **Auto-clear philosophy** — the default is conservative (signed → `received`, a processor signs off);
   confirm which conditions, if any, should **auto-clear to `satisfied`** when their clear-rule passes
   (adds the `esign_clear_rule` column, §8.4).
9. **Notary/RON** provider + accepted states, only if the affidavit is notarized.

**DocuSign account setup** (see BLUEPRINT §12): demo account, Integration Key, RSA keypair, a service
sender user (`esign@yscapgroup.com`), consent, Connect + HMAC key, and confirm the na4 production plan
includes API + Connect (+ embedded/RON if used).

---

## 11. Sources

Codebase: `src/routes/staff.js` (docKind whitelist :5107, signer query :169-171, signOffGate
:2400-2689, /documents :5054-5174), `src/routes/borrower.js:1990`, `web/tools/termsheet.js` (:832,
:976-1246, :1152-1157, :1419), `web/tools/loan-application.html` (:1717-1782), `src/clickup/fields.js`
(:114 signedTermSheet, :118 iska), `db/037_condition_center.sql:79-92` (esign_envelopes),
`db/096_product_fatal_on_economics_change.sql:68-78`, `db/schema.sql:54,158`, `src/lib/upload-bytes.js`,
`src/lib/storage.js`, `src/lib/conditions/rules.js`, `src/lib/conditions/engine.js`.

DocuSign (verified 2026-07-17): Envelopes:create
https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/envelopes/create/ · Auto-Place
anchors https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/tabs/auto-place/ ·
EnvelopeRecipientTabs
https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/enveloperecipienttabs/ ·
Embedded signing / createRecipientView
https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/embedding/embedded-signing/ ·
Connect + eventNotification https://developers.docusign.com/platform/webhooks/connect/ · Event
Notifications JSON SIM + HMAC
https://www.docusign.com/blog/developers/event-notifications-using-json-sim-and-hmac · EnvelopeCustomFields
https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/envelopecustomfields/ ·
Download documents
https://developers.docusign.com/docs/esign-rest-api/how-to/download-envelope-documents/.

Business-purpose exemption: CFPB Reg Z §1026.3 https://www.consumerfinance.gov/rules-policy/regulations/1026/3/
· eCFR 12 CFR 1026.3 https://www.ecfr.gov/current/title-12/chapter-X/part-1026/subpart-A/section-1026.3.

Heter Iska: RabbiKaganoff https://rabbikaganoff.com/how-does-a-heter-iska-work-2/ · Halachipedia
https://halachipedia.com/index.php?title=Heter_Iska · Bais HaVaad (e-signatures)
https://baishavaad.org/are-electronic-signatures-valid-according-to-halacha/.

---

## Addendum A — Owner inputs & finalized logic (2026-07-17)

_Supersedes the earlier assumptions in §1/§6 where they differ. The owner provided the two source
documents and the appraisal-gated workflow. No document content, merge values, or secrets are stored
here — only field names and structure._

### A.1 Documents received
- **`BORROWER_BUSINESS_PURPOSE_DISCLOSURE_AND_CERTIFICATION.docx`** — a **single combined Disclosure +
  Certification** (not a separate affidavit). 6 numbered certifications (business/commercial purpose
  only; proceeds for business only; non-owner-occupancy incl. guarantors; the consumer-law
  non-applicability incl. TILA/RESPA/GLBA/SAFE/HPA; acknowledgment of receipt). Borrower + Co-Borrower
  signature blocks. **E-signed, NOT notarized** for the initial application (owner: the notarized
  version happens only at closing — out of scope now). This one document is the "business purpose"
  piece — there is no separate initial affidavit.
- **`YS_HETIR_ISKA.docx`** — the Heter Iska shtar (**Hebrew, right-to-left**), from a named
  דומ"ץ/beis din, referencing YS Capital Group + NMLS; reads as a *kulo-pikadon* iska tied to the note
  ("הנאו"ט"), with the standard witnesses/oath + fixed-payment-as-profit mechanism. Borrower + Co-Borrower
  signature lines ("נאום"). **Open question:** the file also contains an unrelated "Processor
  Certification – Title Seasoning Exception" block (appears to be template scaffolding/a stray text box)
  — confirm only the שטר היתר עיסקא section is the document to generate.

### A.2 CRITICAL generation finding — the provided docs are DOCX + merge fields → use DocuSign Document Generation (DocGen), NOT jsPDF
Both provided documents are **Word DOCX templates with `«MERGEFIELD»` placeholders**. Rebuilding them in
jsPDF would be wrong — the Heter Iska is **Hebrew RTL with exact rabbinic nusach that must never be
altered**, and both are ready-made Word templates. Path per document:
- **Business purpose + Heter Iska → DocuSign Document Generation (DocGen)** (BLUEPRINT §4.1 Option B):
  upload each DOCX as a DocGen template, map its merge fields to loan-file data, DocuSign renders the
  PDF at send. Preserves exact wording/RTL; the business can edit the Word doc without code. (Convert
  the `«MERGEFIELD»` placeholders to DocGen's merge syntax once, in the DocuSign template.)
- **Term sheet → keep jsPDF** (existing, frozen numbers, push our bytes).
- **Application export → build it** (§A.4) — jsPDF following `termsheet.js` (recommended, keeps SSN
  rendering on our side and matches the frozen term sheet), or DocGen.
- **Build detail to confirm:** whether DocGen documents can ride in the *same* envelope as
  pushed-bytes documents, or whether Package 1 uses DocGen for all its docs. Both are supported by
  DocuSign; the exact composition is a wiring choice.

**Merge-field → loan-file mapping (both provided docs, shared field names):**
| Merge field | Loan-file source |
|---|---|
| `Loan_Number_364` | `applications.ys_loan_number` |
| `Loan_Amount_1109` | `applications.loan_amount` |
| `M_745` (application date) | `applications.submitted_at` |
| `Subject_Property_Address_11` / `City_12` / `State_14` / `Zip_15` | `applications.property_address` (jsonb) |
| `Borrower_First_And_Middle_Name_36` / `Borrower_Last_Name_4002` | `borrowers` (primary) |
| `Co_Borrower_First_Name_4004` / `Co_Borrower_Last_Name_4006` | `borrowers` via `applications.co_borrower_id` |
| `M_1859` / `M_1872` (signed dates) | leave to the DocuSign `dateSigned` tab |

### A.3 Finalized packaging & trigger logic (SUPERSEDES §1)
**Two packages, sent only after the appraisal is in and the structure is re-confirmed:**

- **Package 1 — "Loan documents"** (synced + TPR as normal): **Term sheet + Application export +
  Business-purpose disclosure/certification**, signed together. Signers: borrower + co-borrower
  (= guarantor) if present. Signed copies → `term_sheet_signed` / `application_signed` /
  `bp_disclosure_signed`, mirrored to SharePoint, clear their conditions.
- **Package 2 — "Heter Iska"** (SEPARATE): Heter Iska only. **HARD RULE — NEVER exported in the TPR
  export, NEVER synced to SharePoint.** Kept only in our system + on DocuSign. Enforcement:
  `rtl_cond_iska` is already `tpr_exclude=true` (verified `db/051:83`); **`heter_iska_signed` must be
  excluded from SharePoint routing** — do NOT add it to `sharepoint-backup.js` `KIND_STREAM` /
  `folderPathFor`, and add an explicit denylist guard so it can never mirror.

**TRIGGER for both packages — send only after ALL of:**
1. Product **registered** (initial), AND
2. **Appraisal condition uploaded + signed off** — `rtl_cond_appraisaldocs` ("Appraisal documents
   received", `db/059`), AND
3. Product **re-registered / structure re-confirmed on the appraised value** — P&P reverified after the
   appraisal, when final numbers lock. (`db/096` already reopens `product_pricing` **and**
   `rtl_cond_signedts` on any economics change, so an appraisal-driven value change forces the
   re-register automatically.)

Then a staff **"send for signature"** action (the manual-review checkpoint) sends Package 1 and
Package 2. **Rationale (owner):** the signed term sheet must reflect the FINAL confirmed value, which
only exists after the appraisal — so signing is deliberately gated to post-appraisal re-registration.
_(Build item: an explicit send-gate that refuses to send until (1)+(2)+(3) hold, surfaced to staff.)_

### A.4 Application export — the document I build (owner-directed)
A full **business-purpose loan application** PDF I generate from the file (jsPDF, v1+v2, following
`termsheet.js`), containing at minimum: borrower name(s); **DOB**; **SSN**; primary/mailing address;
subject property; **loan amount applied for**; full loan-structure detail (program, loan type, purchase
price, as-is/ARV, rehab budget, rate, term, LTC/LTV, IR, assignment fields); **LLC/entity name** +
vesting; co-borrower details; and **signature slots at the bottom for one or more borrowers** (borrower
+ co-borrower, invisible anchors `/app_b1_sig/`, `/app_b2_sig/` per §3). New `doc_kind='application_export'`
(unsigned) / `application_signed` (signed); extend the `docKind` whitelist (§4.1 step 5).

### A.5 Signers — co-borrower = guarantor (CONFIRMED)
A co-borrower is added **only when they are also a guarantor**; non-guarantor third parties are not
added at all. So signers = **borrower + optional co-borrower(-guarantor)**. The existing `co_borrower_id`
model is exactly right — **no new guarantor signer model is needed** (resolves §2.1's open item and
§10 item 7).

### A.6 Signing experience — email AND in-portal (both, owner-directed)
The borrower should get an **email** and be able to **sign in the portal**. Recommended:
**embedded signing (`clientUserId`) + our own PILOT-branded email** (via the existing `notify` fan-out)
that deep-links to the portal "Sign" page → embedded DocuSign view. (A recipient with `clientUserId` is
embedded and does **not** receive DocuSign's own email, so we send ours — consistent with PILOT branding
and the existing email system; a recipient can't be both embedded and DocuSign-emailed.) Confirm this vs.
DocuSign-hosted email signing.

### A.7 SSN / PII on the application export (guard)
The application export carries **SSN + DOB**. Guards: render + store via the existing chokepoints; the
stored PDF is a `documents` row behind `canSeeDocument`; **Connect "Include Documents" stays OFF** (fetch
signed PDFs via API over TLS); redact from any inbox payload/log/audit `detail`. **Owner/counsel
decision:** full SSN vs last-4 on the signed application. The business-purpose doc and Heter Iska do not
carry SSN.

### A.8 Auth / key status — answer to "am I missing any keys before building the login?"
**Provided (demo, non-secret identifiers — will be read from env, never hardcoded):** Integration Key
(app "PILOT"), User ID, API Account ID, base URI (`https://demo.docusign.net`), auth host
(`account-d.docusign.com`). These are enough on the identifier side.

**STILL NEEDED before the JWT login/auth can run — three items, all owner-side, all set in the
environment (never pasted to chat):**
1. **A freshly generated RSA private key** → env `DOCUSIGN_PRIVATE_KEY`. **The key pasted in chat is
   treated as compromised (house rule) and must be regenerated** in the DocuSign demo app (Apps & Keys →
   the app → generate a new RSA keypair; copy the new private key straight into the environment). The
   public key stays with DocuSign.
2. **One-time consent** for the impersonated user (open the consent URL as that user; scopes
   `signature impersonation`; Accept).
3. **Connect webhook + HMAC key** configured in the demo account → HMAC secret to env
   `DOCUSIGN_CONNECT_HMAC_KEY`.

Once 1–3 are set in the environment, JWT auth + envelope send can be built and tested against demo. The
Integration Key / User ID / Account ID / base URI go into env as `DOCUSIGN_INTEGRATION_KEY` /
`DOCUSIGN_USER_ID` / `DOCUSIGN_ACCOUNT_ID` / `DOCUSIGN_BASE_URI` / `DOCUSIGN_OAUTH_BASE` (the config
block `src/config.js:251-260` already reads these).

**Status (2026-07-19):** the six demo `DOCUSIGN_*` env vars are set on the Render service
(`srv-d94sqalckfvc73ahlqh0`), pinned to demo (`DOCUSIGN_BASE_URI=https://demo.docusign.net/restapi`,
`DOCUSIGN_OAUTH_BASE=account-d.docusign.com`). Auth + a first envelope send were **verified live** on
demo (a signed test application). Production switch is a later, deliberate step (fresh key + Go-Live).

### A.9 Signed-document distribution — TPR export + SharePoint (owner-directed 2026-07-19)
When a signed document comes back from DocuSign into its condition, it is saved and distributed like any
other file document — **stored in the condition, mirrored to the SharePoint folder, and INCLUDED in the
TPR export — everywhere, always** — with **ONE hard exception**:

- **The Heter Iska is NEVER included in the TPR export and is NEVER synced to SharePoint.** It is kept
  only in our system and on DocuSign. Enforcement: `rtl_cond_iska` is already `tpr_exclude=true`
  (verified `db/051:83`); the `heter_iska_signed` `doc_kind` must be **denylisted** from both the TPR
  export builder (`src/lib/tpr-export.js`) and SharePoint routing (`src/lib/sharepoint-backup.js`
  `KIND_STREAM`/`folderPathFor`). Add an explicit guard so it can never leak into either, present or
  future.
- **Every other signed doc_kind** (`term_sheet_signed`, `application_signed`, `bp_disclosure_signed`,
  `esign_certificate`) is `tpr_exclude=false` and mirrors to SharePoint normally — the signed copies must
  appear in the TPR/clean-file export and in the borrower's SharePoint tree.
