# Where the appraisal XML lives in an Encompass loan — and exactly how we read it

_Research pass, 2026-08-03. **Research only — no code was changed and no Encompass endpoint was
called during this pass.** Sources: the ICE/Ellie Mae public developer + Partner Connect
documentation (URLs cited inline), the official Encompass Developer Connect 26.2 Postman collection
already extracted into this repo (`docs/encompass-research/analysis/`), the live custom-field
catalog pulled from instance BE11397907, and the repo's own Encompass modules._

**Task:** we already have a working door that turns raw MISMO 2.6 appraisal XML into warehouse
comparables (`src/lib/research/xml-import.js` → `importXml` / `importMany`). The only missing piece
is getting the XML out of Encompass, for every loan, whatever kind of loan it is.

---

## 0. BOTTOM LINE

### 0.1 The single most likely location

**The appraisal XML is an eFolder / loan attachment on the loan, delivered by the AMC integration
alongside the PDF — it is a *sibling file of the PDF*, not a separate system.** The owner's
observation is precisely right and is the strongest evidence in this whole document: the loan
*fields* update by themselves because Encompass Partner Connect (EPC) delivers the appraisal
transaction response as a set of **resources** — the PDF report, the **XML data file**, the invoice —
and Encompass maps the structured data into loan fields while filing each document into an eFolder
document folder. That mapping is *configurable per lender* and the appraisal XML is an explicitly
named, toggleable item in it ("if the Appraisal XML is unnecessary for the loan file, you can disable
this option" — [Appraisal Firewall / SharperLending EPC
setup](https://sharperlendingllc.freshdesk.com/support/solutions/articles/43000732077-setup-encompass-partner-connect-epc-to-appraisal-firewallx)).

There is one important wrinkle that explains why the owner only *sees* the PDF:

> "When a Partner sends a file attachment with its transaction response, EPC will attach it to the
> loan as an eFolder attachment **if the file type is supported by the eFolder**. The eFolder
> supports a limited number of human readable file formats, including .pdf, .jpg, .docx, and .txt.
> **File formats that are not supported by the eFolder can be attached to the loan as a Loan Folder
> attachment** — examples include .json and .xml documents. These files are **not viewable in
> Encompass** (web and desktop versions) — but Lenders can easily access these attachments either via
> the partner application's user interface … **or via the Developer Connect APIs.**"
> — [ICE Partner Connect, *Transaction Response
> Attachments*](https://docs.partnerconnect.elliemae.com/partnerconnect/docs/transaction-response-attachments)

So: **the XML is very likely already on every loan, and is invisible in the Encompass UI by design.**
"The eFolder only has the PDF" is exactly what a lender sees when the XML is there but not
viewable. The API is the *only* way to see it — which is our situation exactly.

### 0.2 The exact endpoints

Two hops, in this order, per loan:

| # | Method | Path | What it gives | Allowed by our client **today**? |
|---|---|---|---|---|
| 1 | **GET** | `/encompass/v3/loans/{loanGuid}/attachments?includeRemoved=false` | Attachment **metadata** for the whole loan — id, title, file name, type, dates. This is where we find the XML and decide it's an appraisal. | **YES — no policy change needed.** `encompass.apiGet()` already permits any GET outside the OAuth namespace. |
| 1b | GET | `/encompass/v3/loans/{loanGuid}/documents?view=Detail` | The eFolder **documents** (the folders/slots — "Appraisal", "SSR or CDA"), each listing the attachment ids assigned to it. Use it to confirm the XML sits under the Appraisal document. | **YES — no policy change needed.** |
| 2 | **POST** | `/encompass/v3/loans/{loanGuid}/attachmentDownloadUrl` | Mints a **time-limited download URL** for the attachment **bytes**. Body `{"attachments":["<id>"],"type":"Cloud"}`. Response `{"attachments":[{"id":…,"originalUrls":["https://…"],"contentType":"…"}]}`. | **NO — this is a FOURTH read-shaped POST and needs the owner's explicit sign-off.** |
| 3 | GET | the opaque `originalUrls[0]` returned above | the actual XML bytes | It is a **different host** (cloud storage / media server), so it never touches `_fetchGuarded` — it needs its own SSRF-guarded, token-free fetcher (the `flood-order.downloadResultFile` pattern). |

Then: `xmlText` → `require('src/lib/research/xml-import').importXml(db, { xml, filename })`. Nothing
else in PILOT changes.

### 0.3 Does this need a new POST allowlist entry? — **YES, one.**

`src/lib/integrations/encompass.js` structurally refuses every non-GET except three hard-coded
read-shaped POSTs (`/oauth2/v1/token`, `/encompass/v3/loanPipeline`, and the
`_isFieldReaderPath`-matched `/encompass/v3/loans/{guid}/fieldReader`). Getting attachment **bytes**
requires a fourth:

> **`POST /encompass/v3/loans/{loanGuid}/attachmentDownloadUrl`**
>
> **Why it is read-shaped:** it returns a set of time-limited download URLs for files that already
> exist. It creates nothing, changes no loan field, moves no milestone, adds no document, and writes
> no attachment. It is a POST only because the list of attachment ids travels in the JSON body —
> exactly the same reason `loanPipeline` and `fieldReader` are POSTs. ICE's own catalog classifies
> it as a read (`READ_VIA_POST`; see `docs/encompass-research/findings/C7.md` row 256 and the Atlas
> §10.1 G5 entry, which already pre-approved it as an *optional* runtime allowlist item).
>
> **The look-alikes that must stay denied:** `attachmentUploadUrl`, `attachments/url`,
> `attachmentUrl` — those are **upload** generators. The predicate must be an exact-path match on
> `/encompass/v3/loans/{guid}/attachmentDownloadUrl` (a `_isAttachmentDownloadPath` mirroring
> `_isFieldReaderPath`: one GUID segment, exact suffix, no query), never a prefix on
> `/attachments`.

**There is one way to avoid the fourth entry entirely, and one way to reduce its blast radius:**

- **Avoid it (conditional):** if the AMC orders run through **EPC Service Orders**, the response
  files are reachable **GET-only** via
  `GET /encompass/v3/loans/{guid}/serviceOrders/{orderId}/response/resources` — "get downloadable
  URLs for the response attachments" — which is *already on the allowlist of our flood client* and
  is a plain GET on the read-only client too. **But** this only works if (a) the AMC uses EPC Service
  Orders rather than the legacy partner-transaction framework, and (b) we can discover the
  `orderId`. I could **not** confirm from public docs that a *list* endpoint
  (`GET .../loans/{guid}/serviceOrders`) exists. This is a real possibility, not a plan — see §7.3.
- **Reduce blast radius:** build the reader as a **separate module with its own narrow allowlist**
  (`src/encompass/appraisal-xml.js`), exactly the way `src/encompass/flood-order.js` isolates the
  flood write, and leave `src/lib/integrations/encompass.js` **byte-for-byte untouched** so
  `scripts/test-encompass-readonly.js` (which asserts the POST allowlist has exactly two entries plus
  the fieldReader predicate) stays green and the frozen module keeps its guarantee. **This is an
  architecture choice, not a way around sign-off** — CLAUDE.md's rule is about adding a fourth
  non-GET call to Encompass at all, wherever the code lives.

### 0.4 The top three things the owner must confirm

1. **Open ONE recent funded loan in Encompass and look for the XML.**
   Open the loan → **eFolder** → the **Appraisal** document folder. Tell me: how many attachments are
   under it, and what are their exact file names? Specifically — is there anything that is **not** a
   PDF (a `.xml`, or a file with no visible preview / a blank thumbnail)? If the eFolder shows only
   the PDF, that is the expected answer and does **not** mean the XML isn't there — it means it is a
   *loan folder attachment*, invisible in the UI, and only the API can see it. Either answer is
   useful; I need to know which one it is.
2. **Confirm the AMC integration is actually delivering the XML — and that nobody turned it off.**
   In Encompass (web version) → **Settings → Services Management** → find **Class Valuation /
   Appraisal Nation** and **Nationwide Appraisal Network** → open **Document Mapping** (and the
   partner's own settings screen). Tell me: is there a row for the **appraisal XML / UAD XML / data
   file**, and is it **enabled**? This is the exact switch ICE's partners describe as "if the
   Appraisal XML is unnecessary for the loan file, you can disable this option." If it is off, the
   XML is not on any loan and no API can produce it — the fix is a settings change, not code.
3. **Confirm the eFolder is keeping the ORIGINAL file, not just a converted image.**
   Encompass eFolder → **Setup / Conversion Preferences** → is **"Keep a copy of the document in its
   original format"** checked? With document conversion on and that box off, Encompass keeps only a
   converted (PDF/PNG) rendering and the `originalUrls` we need come back empty — this is a
   documented, real-world failure ([EncompassRest
   #371](https://github.com/EncompassRest/EncompassRest/issues/371),
   [#413](https://github.com/EncompassRest/EncompassRest/issues/413)). An XML has no image rendering,
   so the likely outcome is that it lives untouched as a loan-folder attachment — but this must be
   confirmed, because it decides whether we get bytes at all.

Plus one nice-to-have, cheap and decisive: **give me one appraisal XML file the AMC produced this
month** (drag it out of the AMC's own portal — Class Valuation / NAN both let you download the XML).
I can run it through the existing parser in seconds and tell you definitively whether it is UAD 2.6
(we can read it today) or UAD 3.6 (we cannot — see §6).

---

## 1. What PILOT does with Encompass today (side A)

### 1.1 The guarded client — `src/lib/integrations/encompass.js`

Auth is the resource-owner password grant (lenders may not use `client_credentials`), scope `lp`,
username `<user>@encompass:<instanceId>`, token cached with a 60s safety margin.

Exports **only** `{ name, configured, ping, apiGet, pipelineSearch, fieldReader, READ_ONLY }`. There
is no `apiPost` / `apiPut` / `apiPatch` / `apiDelete` and no `updateLoan` / `createLoan`.

The structural gate is `_fetchGuarded(url, init)`:

- Any method other than `GET` throws **before the request is built**, unless the URL matches the
  allowlist.
- `POST_ALLOWLIST` is a `Set` of exactly two exact paths: `/oauth2/v1/token`,
  `/encompass/v3/loanPipeline`.
- Plus `_isFieldReaderPath(url)` — a deliberately narrow predicate: must start
  `<base>/encompass/v3/loans/`, and the tail must match `^[A-Za-z0-9-]{8,64}/fieldReader$` (one GUID
  segment, exact suffix, **no query string**).
- An allowlisted path called with a non-POST method also throws.
- `assertReadOnlyPath(path)` additionally forbids `apiGet` from reaching into `/oauth2/*`.

**The consequence that matters most for this task: every GET is already permitted.** `apiGet` takes
an arbitrary path. `GET /encompass/v3/loans/{guid}/attachments`,
`GET /encompass/v3/loans/{guid}/documents`, `GET /efolder/v1/exportjobs/{id}` — all of them work
today with **zero** change to the freeze. Only *bytes* are blocked, and only because ICE put the id
list in a POST body.

### 1.2 The convenience layer — `src/encompass/client.js`

Thin wrappers, every one landing on `apiGet` or `pipelineSearch`:
`getLoan(guid, {entities})`, `readFields(guid, ids)` (the fieldReader, with a per-id split-retry on
an invalid-field 400 and normalization of both the object-map and array wire shapes),
`findLoanByLoanNumber`, `getMilestones`, `getMilestoneLog`, and the six `settings/loan/*` catalog
reads. There is **no** attachment or document helper here at all — this is greenfield.

### 1.3 What is pulled per loan — `src/encompass/reader.js`

`pullLoanForApplication(appId)`:

1. Read `applications.{ys_loan_number, encompass_loan_guid}`.
2. No GUID → `findLoanByLoanNumber` (pipeline search, simple single-term `Loan.LoanNumber` /
   `matchType:'Exact'` filter). Zero hits or >1 hit → stamp `encompass_last_error`, stop. One hit →
   cache the GUID.
3. `client.getLoan(guid)` — the full loan entity JSON.
4. `client.readFields(guid, allFieldIds() ∪ identityFieldIds())` — every mapped field **by number**,
   stashed as `loan._fieldValues` (authoritative; the JSON paths are only a fallback because the same
   field number sits at different paths on different loans).
5. **Same-loan guard**: field `364` (or `loan.loanNumber`) must equal our `ys_loan_number`,
   case/space-insensitive. Mismatch → store nothing, clear the cached GUID, stamp a plain-language
   error.
6. `_scrubForStorage` — SSNs (`taxIdentificationIdentifier`, and field ids `65`/`97` in
   `_fieldValues`) are replaced with a keyed HMAC hash + last-4 and the plaintext deleted. Nothing
   else is redacted.
7. `UPDATE applications SET encompass_extra=<jsonb>, encompass_last_pulled_at=now(),
   encompass_last_error=NULL`.

**Nothing about eFolder documents, attachments, or service orders is fetched or stored today.** The
loan entity JSON does not carry attachment bytes or an attachment inventory.

### 1.4 The bulk pass — `reader.bulkPullAllLoans()`

This is the existing tenant-wide sweep and the natural place a per-loan attachment read would hook
in:

- Scope: `_fetchAllFolderNames()` (`GET /settings/loan/folders`) if the token permits, else
  `MATCH_ALL_FILTER` = `{canonicalName:'Loan.LastModified', value:'1900-01-01',
  matchType:'GreaterThan', precision:'Day'}` — a genuine "every loan ever" clause that works with any
  pipeline-capable token. **This is what makes "no matter what kind of file it is" achievable.**
- Paging: offset-based `?limit=200&start=N`, advancing by `page.length`, stopping on a short page.
  Row shape is tolerated both ways (`loanId` vs `loanGuid`; values flat or nested under `fields`).
- Per loan: `getLoan(guid)` → `_scrubForStorage` → upsert `encompass_loan_snapshot`
  (PK `encompass_loan_guid`), then `UPDATE applications … WHERE ys_loan_number = <loanNumber>` to
  attach it to a PILOT file if one exists, else counted as `unmatched`.
- Pace: `perRequestDelayMs = 350` **sequential** (≈170 requests/minute, concurrency 1).
- Progress: `encompass_bulk_pull_runs` (`pulled / matched / unmatched / failed`, updated every 25).

The mirror table (`db/247_encompass_loan_snapshot.sql`) is PII-scrubbed raw loan JSON keyed on the
Encompass GUID, with `application_id` set when matched and `last_error` per loan.

### 1.5 Where a new per-loan read would hook in

Three call sites, in increasing order of effort:

1. **`bulkPullAllLoans` inner loop** — right after the `getLoan` + snapshot upsert, we already hold
   the GUID and are already paced. Add "list attachments → pick the appraisal XML → fetch bytes →
   `importXml`". This is the *tenant-wide, every-file* answer the owner asked for. It should be
   **behind its own switch** and should record its own per-loan ledger so it is resumable and
   idempotent (nothing about the existing snapshot upsert should change).
2. **`pullLoanForApplication`** — the 15-minute staleness poll (`ENCOMPASS_POLL_MIN`, one file per
   tick, oldest-pulled first, skipping `declined`/`withdrawn`). This keeps *active* files fresh
   going forward.
3. **`enrichPassOnce`** (`src/sync/encompass-sync.js`) — the weekly pass that already refreshes the
   full-tenant snapshot then walks it. `src/encompass/enrich.js` is the precedent for "read the
   mirror, write only PILOT tables, never call Encompass" — but note it reads `encompass_loan_snapshot.raw`,
   and attachments are *not* in that raw JSON, so an attachment sweep genuinely needs new HTTP calls.

`src/encompass/reconcile.js` is not a hook point — it is a pure live comparison of
`applications.encompass_extra` against our own columns and never fetches (except one narrowly-gated
self-heal of `_fieldValues`).

### 1.6 What we can parse — `src/lib/appraisal/extract.js` + `docs/appraisal-xml/`

- Input: **MISMO 2.6 `VALUATION_RESPONSE` / `REPORT`**, GSE Extended, Schema Errata 1 — the format
  UCDP calls "MISMO 2.6 Errata 1 GSE Extended". Proven against **33 real files** (20× FNM1004,
  13× FNM1025, plus 1073 condo notes).
- Design contract: **never store a guess.** Every value passes a validation rule; failures are left
  null and recorded in `warnings`.
- **There is already a hard version guard** (`extract.js` ~L796–820). A `MESSAGE`-rooted MISMO 3.x /
  UAD 3.6 file is *recognised by name* and refused with a plain-language error:
  > "This appraisal is in the UAD 3.6 / MISMO 3.x format… PILOT currently reads UAD 2.6 (MISMO 2.6)
  > appraisals — a 3.6 reader is required, so this file was not imported. Please provide the UAD 2.6
  > export, or import the PDF."
  Anything else unrecognised → `not a MISMO VALUATION_RESPONSE / REPORT`. It also cross-checks
  `VALUATION_RESPONSE/@MISMOVersionID`.
- **This is good news for a bulk sweep:** a 3.6 file will be *counted and named*, never silently
  half-parsed. We will know exactly how much of the book we could not read.

### 1.7 The door we are feeding

`src/lib/research/xml-import.js`:

```js
importXml(db, { xml, filename = null, uploadedBy = null })   // one file
importMany(db, files /* [{xml, filename}] */, { uploadedBy, onProgress })
```

It parses with the *same* `extract()` the loan desk uses, keys on the sha256 of the XML bytes (same
file again = refresh, not a duplicate), stands down if a loan file already contributed that exact
report, never creates an application / appraisal row / condition / finding / notification, never
throws, and caps input at 80 MB (a real MISMO file carries the whole report PDF inside itself,
base64 — tens of megabytes is normal). **Feeding it Encompass-sourced XML requires no change to it.**

---

## 2. Every plausible home for appraisal XML in an Encompass loan (side B)

Ranked by likelihood. Each row states the endpoint, the method, the scope, the response shape, and
the **GET-only vs new-POST** verdict.

### 2.1 eFolder / loan **attachments** — ★ most likely

**What it is.** The actual files. Each attachment has an id (`Attachment-<guid>.<ext>`), a title, a
type (`Native` / converted), and is assigned to at most one *document*.

| Purpose | Method + path | Verdict |
|---|---|---|
| List all attachments on a loan | `GET /encompass/v3/loans/{loanGuid}/attachments` (optional `?includeRemoved=true`) | **GET — allowed today** |
| One attachment's metadata | `GET /encompass/v3/loans/{loanGuid}/attachments/{attachmentId}` | **GET — allowed today** |
| **Bytes** | `POST /encompass/v3/loans/{loanGuid}/attachmentDownloadUrl` → then GET the returned URL | **NEEDS the 4th allowlist entry** |

Request body for the download URL (confirmed from the official Postman collection —
`docs/encompass-research/analysis/conditions-efolder-extract.md`, "V3 Manage Attachments / 04 -
Download Original Attachment" — and from real production code in the wild):

```json
{ "attachments": ["Attachment-d7725480-ee95-410a-8e64-aed6fae2c6b2.xml"], "type": "Cloud" }
```

Response (field names confirmed by [production
usage](https://github.com/seth-lyons/legacy.shared-resources/blob/main/EncompassAPI/EncompassClient.cs)
and the ICE 24.2 changelog):

```jsonc
{ "attachments": [ {
    "id": "Attachment-…xml",
    "originalUrls": [ "https://…time-limited…" ],   // ← the ORIGINAL bytes
    "contentType": "application/xml"                 // ← only when the request body sets "type":"Cloud"
} ] }
```

**Three hazards, all real:**

- **`originalUrls` may be empty.** With eFolder document conversion enabled and *"Keep a copy of the
  document in its original format"* **un**checked, Encompass keeps only a converted rendering and
  the native file is gone. Two separate developers hit exactly this
  ([#371](https://github.com/EncompassRest/EncompassRest/issues/371),
  [#413](https://github.com/EncompassRest/EncompassRest/issues/413) — the latter notes attachments
  carry a `NativeKey` when the original is retained). XML has no image rendering so it is *probably*
  stored untouched, but this is confirm-in-tenant territory (owner check #3).
- **The download URL is on a different host** (cloud storage / the Encompass media server). Our
  OAuth bearer must **never** be sent there. Reuse the `flood-order.downloadResultFile` shape:
  GET-only, https-only, `assertPublicHttps` + private-IP refusal on **every** redirect hop, and the
  bearer attached only on an ICE host.
- **V1 is dying.** The V1 eFolder attachment APIs (`GET .../attachments`, `POST
  .../attachments/{id}/url`, page/thumbnail URL generators) are **deprecated in the 26.3 release**
  per the ICE 25.3 release notes, as part of a data-centre migration. Build on **V3 only**.

### 2.2 eFolder **documents** — the folder the XML sits in (and how we prove it's the appraisal's)

**Documents and attachments are different resources, and the distinction matters here.**

- A **document** is the *slot / folder / placeholder* — "Appraisal", "SSR or CDA", "Title
  Commitment". It carries the workflow lifecycle (`isReceived`, `isReviewed`, `isReadyForUw`,
  `isRemoved`, dates, comments) and a list of the **attachment ids assigned to it**. A document can
  exist with zero attachments (that is how Encompass models "we're waiting on this").
- An **attachment** is the *file*. It can be assigned to at most one document — or to **none**,
  which is exactly the state a loan-folder attachment is in.

| Purpose | Method + path | Verdict |
|---|---|---|
| All documents | `GET /encompass/v3/loans/{loanGuid}/documents?view=Summary\|Detail\|Full` (also `?requireActiveAttachments=false`) | **GET — allowed today** |
| One document | `GET /encompass/v3/loans/{loanGuid}/documents/{docId}` | **GET — allowed today** |
| A document's attachments | `GET /encompass/v3/loans/{loanGuid}/documents/{docId}/attachments` (V1 equivalent confirmed in the collection) | **GET — allowed today** |
| eFolder history | `GET /encompass/v3/loans/{loanGuid}/histories/efolder` | **GET — allowed today** |

**Why we want this even though the attachment list alone would do:** the document tells us *the
appraisal's* XML rather than *an* XML. Per ICE's partners, "By default, the appraisal report will
automatically be routed to the **Appraisal** folder and does not need to be configured for document
mapping" ([SharperLending, *Customize Document Folders in
EPC*](https://sharperlendingllc.freshdesk.com/support/solutions/articles/43000732079-how-to-customize-document-folders-in-encompass-partner-connect-epc-)).
**But** — and this is the catch that decides the design — if the XML was filed as a *loan folder*
attachment because .xml is unsupported, it may be assigned to **no document at all**, in which case
the document join finds nothing and we must fall back to identifying it from the attachment metadata
(§5). Plan for both.

Note also: everything in the eFolder is **soft-deleted** (`isRemoved`). Disappearance is never
deletion — do not treat a missing row as "the file was withdrawn".

### 2.3 Loan **Services** / order transactions — the AMC round-trip

This is where the appraisal *order* lives, and it is the second-best candidate for the XML —
importantly, on a path that may be **GET-only**.

**Framework A — EPC Service Orders (the modern default; what `src/encompass/flood-order.js`
targets):**

| Purpose | Method + path | Verdict |
|---|---|---|
| Place an order | `POST /encompass/v3/loans/{guid}/serviceOrders` | **irrelevant + forbidden** (a real write) |
| Order status | `GET /encompass/v3/loans/{guid}/serviceOrders/{orderId}` | **GET — allowed today** |
| **The returned files** | `GET /encompass/v3/loans/{guid}/serviceOrders/{orderId}/response/resources` — "downloadable URLs for the response attachments" | **GET — allowed today** |
| List a loan's orders | `GET /encompass/v3/loans/{guid}/serviceOrders` (**unconfirmed — see §7.3**) | would be GET |

Response shape (from `flood-order.js`, which already parses it defensively): an array under
`resources` / `files`, each entry carrying some of `{url, href, downloadUrl, uri, mimeType,
contentType, name}`.

**If a list endpoint exists, this is a complete GET-only answer and no fourth POST is needed at
all.** That is the single highest-value open question in this document.

**Framework B — legacy Partner Services transactions:**

| Purpose | Method + path | Verdict |
|---|---|---|
| Status **with file URLs** | `GET /services/v1/partners/{partnerId}/transactions/{transactionId}?generateFileUrls=true` | **GET — allowed today** |
| Download a report file | `GET <the returned URL>` | GET, foreign host — SSRF-guarded fetcher |

Confirmed in the official collection ("02b - Get Transaction Status Response with Report URLs",
"03 - Download Report file using URL"). Same problem: we need the `transactionId`, and I found no
documented per-loan transaction *list*.

**Reality check on both:** the Services surface is 51 requests of which ICE's own classification
counts 38 READ + 5 READ_VIA_POST — it is a read-rich area. But a service-order record is only present
for orders **placed through Encompass**. If an appraisal was ordered directly in the AMC's portal and
the result pushed into the loan, there may be no order record while the attachment still exists.
**The attachment path (§2.1) is the one that works regardless of how the order was placed** — which
is why it is the recommendation and this is the optimisation.

### 2.4 UCDP / SSR — **almost certainly a dead end for us, and that is fine**

The appraisal is submitted to Fannie/Freddie through the **Uniform Collateral Data Portal (UCDP)** as
MISMO 2.6 XML, and UCDP returns a **Submission Summary Report (SSR)** carrying the Collateral
Underwriter score. Two reasons this is not our door:

1. **There is no UCDP API in Encompass.** Zero UCDP/SSR endpoints appear anywhere in the 800-request
   Developer Connect collection. UCDP inside Encompass is a *screen* (`UCDP.pdf` in ICE's own
   documentation library), not a REST resource. Where an SSR exists at all, it exists as an **eFolder
   document/attachment** — i.e. §2.1/§2.2 again, no new mechanism.
2. **These loans do not go to the GSEs.** YS Capital writes business-purpose RTL/DSCR loans. They are
   not delivered to Fannie or Freddie, so they are not submitted to UCDP and there is no SSR to
   fetch. The tenant's own custom field `CX.SSRORCDA` ("SSR or CDA") is a *condition/tracking* field
   — and on private-lending files the realistic value is **CDA** (Collateral Desktop Analysis, a
   review product), not an SSR.

Worth knowing but not worth building. If an SSR or CDA *is* on a file, it arrives as an ordinary
eFolder attachment and the §2.1 sweep picks it up for free.

### 2.5 A raw MISMO / loan-format export endpoint — **wrong format, do not chase it**

Encompass does expose loan-format exports:

- `GET /encompass/v3/loans/{loanGuid}/mismo34` (documented as *Export Loan to MISMO 3.4*) — and the
  V1 `Import Loan from File` counterpart.

This is **MISMO 3.4 ULAD/iLAD — the LOAN APPLICATION**, the URLA data. It is not an appraisal and
contains no comparable sales. It is the wrong artefact entirely; there is no "export the appraisal"
endpoint. Ruled out.

### 2.6 Loan FIELDS populated by the AMC integration — the clue, not the answer

The owner's "the files are actually updating by themselves by some data from the appraisal XML" is
**correct and is the diagnostic that points at everything above.** The mechanism:

- EPC delivers the appraisal transaction response as **structured data + resources**. Encompass maps
  the structured data into loan fields and files each resource into an eFolder document folder. ICE's
  partners describe both halves explicitly: "**Encompass automatically imports data from appraisal
  services so that it automatically populates within your loan file**", and "on the Appraisal Order
  Status window, click **Import** … select check boxes for **data and files** you want to import"
  ([Appraisal Firewall
  help](https://appraisalfirewall.freshdesk.com/support/solutions/articles/69000652100-ordering-an-appraisal-from-encompass-)).
- **The XML is one of those checkboxes.** "By default, all data fields and documents listed in the
  Encompass Settings window will be retrieved back into Encompass, but you can adjust these — for
  instance, if the **Appraisal XML** is unnecessary for the loan file, you can disable this option."
- **The tenant has its own custom field for exactly this.** The live BE11397907 catalog contains
  **`CX.IMPORTAPPRAISALXMLWHEN` — "Import Appraisal XML when saving appraisal"**
  (`docs/encompass-research/analysis/encompass-live-customfield-catalog.md`). Somebody at YS Capital
  deliberately built an appraisal-XML import trigger into this instance. That is close to proof that
  the XML reaches the loan. (The same catalog carries a family of `CX.KM.*` fields — a KensieMae
  plugin, including "Auto Assign Unassigned Atts" — so there is also plugin machinery moving
  attachments around, which may be *why* the XML ends up where it does.)

**What this does NOT give us.** Field values are the *conclusions* — appraised value, effective date,
property type. **The comparable sales are not loan fields.** Encompass has no per-comp field family,
so `fieldReader` (which we already have) can never produce comparables. The warehouse needs the file
itself. Reading the fields is worth doing for cross-checks — it is free, already allowlisted — but it
is not the deliverable.

### 2.7 The batch export job — a genuine alternative worth knowing about

| Purpose | Method + path | Verdict |
|---|---|---|
| Create an export job (up to 10 attachments) | `POST /efolder/v1/loans/{loanId}/exportJobsCreator` | **also a new POST** |
| Poll the job | `GET /efolder/v1/exportjobs/{jobId}` | GET |

Classified `READ_VIA_POST` by ICE's own catalog (it creates a *job* resource; it mutates no loan
data). **Not recommended** over `attachmentDownloadUrl`: it is asynchronous (job + poll), capped at
10 attachments per call, and its collection variant carries a `skipPersonaChecks` query parameter
that must be explicitly refused (persona checks stay on). It would cost the same one new POST for a
worse ergonomic. Listed for completeness only.

---

## 3. The POST allowlist question, stated plainly for the owner

**What is allowed today (three read-shaped POSTs, hard-coded):**

1. `POST /oauth2/v1/token` — log in.
2. `POST /encompass/v3/loanPipeline` — search the loan list.
3. `POST /encompass/v3/loans/{guid}/fieldReader` — read fields by number.

**What each proposed read path needs:**

| Read path | GET-only? | New POST needed? |
|---|---|---|
| List every attachment on a loan (metadata: names, ids, types, dates) | **YES** | none |
| List eFolder documents + which attachments are assigned to each | **YES** | none |
| eFolder history | **YES** | none |
| Service-order status + `response/resources` download URLs | **YES** | none (but see §7.3 — we may not be able to find the order id) |
| Partner-transaction status with `generateFileUrls=true` | **YES** | none (same order-id problem) |
| **Download an attachment's bytes** | **NO** | **`POST /encompass/v3/loans/{guid}/attachmentDownloadUrl` — ONE new entry** |
| Batch export attachments | NO | `POST /efolder/v1/loans/{loanId}/exportJobsCreator` — worse; not recommended |
| Fetch the bytes from the returned time-limited URL | YES, but on a **foreign host** | not an allowlist question — needs its own SSRF-guarded, bearer-free fetcher |

**The sign-off ask, in one sentence:** *may we add one more read-only Encompass call —
`attachmentDownloadUrl` — which hands back a temporary download link for a file that is already
sitting on the loan, and changes nothing in Encompass?*

**Why the answer should be judged safe:**

- ICE classifies it as a read (`READ_VIA_POST`). This repo's own Atlas already pre-approved it as
  optional runtime-allowlist item **G5** (`docs/ENCOMPASS-API-ATLAS.md` §10.1), and the Atlas's
  own deny-tripwire list (§10.3) names the dangerous look-alikes it must never be confused with.
- It is the *same category* as the fieldReader the owner already signed off on: a read that ICE made
  a POST purely so the id list could travel in the body.
- The predicate can be made as narrow as `_isFieldReaderPath`: exact suffix
  `/attachmentDownloadUrl`, exactly one GUID segment, no query string. Nothing else on
  `/attachments*` becomes reachable.

**The three things that must be true of the implementation, whatever the owner decides:**

1. `attachmentUploadUrl`, `attachmentUrl`, and `attachments/url` stay **denied and alarmed** — they
   are upload generators one character apart from the read we want.
2. `scripts/test-encompass-readonly.js` must be extended, not weakened: it currently asserts the
   allowlist has exactly two entries; whatever the shape, the test must keep asserting the **exact**
   permitted set and that every other non-GET throws.
3. Prefer an **isolated module** (`src/encompass/appraisal-xml.js`) with its own narrow allowlist —
   the `flood-order.js` pattern — so the frozen `src/lib/integrations/encompass.js` is not touched
   at all. Blast radius, not a loophole.

---

## 4. Doing this across EVERY loan — the volume and rate story

**Can attachments be queried in bulk? No.** The pipeline search is bulk (it is how we page the
tenant), but it projects *loan fields* only — `Loan.Guid`, `Loan.LoanNumber`, `Loan.LoanFolder`,
`Loan.LastModified`, etc. There is no canonical pipeline field for "does this loan have an XML
attachment", and no cross-loan attachment query anywhere in the 800-request catalog. **Attachments
are strictly one call per loan.**

**The call budget, per loan:**

| Step | Calls |
|---|---|
| Discover the loan (already done by the existing pipeline paging) | ~1 per 200 loans |
| `GET .../attachments` | 1 |
| `GET .../documents` (optional; only needed if the attachment metadata is ambiguous) | 0–1 |
| `POST .../attachmentDownloadUrl` (only when we found an XML) | 0–1 |
| `GET <download url>` (foreign host — does **not** consume the Encompass concurrency budget) | 0–1 |

For **3,000 loans** with roughly one appraisal each: ~3,000 + ~3,000 + ~3,000 ≈ **9,000 Encompass
calls**, plus ~3,000 foreign-host downloads.

**The limit that binds is CONCURRENCY, not a per-minute quota.** Encompass enforces a default **30
concurrent API calls per lender environment**, shared instance-wide; exceed it and you get `429`.
Every response carries `X-Concurrency-Limit-Limit` and `X-Concurrency-Limit-Remaining`
([ICE, *Concurrency
Limits*](https://developer.icemortgagetechnology.com/developer-connect/docs/concurrency-limits)).
That budget is shared with **every other consumer of the instance** — the Encompass desktop clients,
the AMC integrations, any other vendor. A runaway sweep does not just slow us down; it throttles the
whole company.

**Realistic pacing.** Keep the existing `bulkPullAllLoans` posture — sequential, `perRequestDelayMs
= 350` (≈170 req/min, concurrency 1). At that pace 9,000 calls is **≈ 53 minutes** of wall time.
Even at a cautious concurrency of 3 it is under 20 minutes. This is a comfortably small job. Add:
honour `Retry-After`, exponential backoff with jitter on 429, read
`X-Concurrency-Limit-Remaining` and back off before hitting zero, and give the sweep a lower priority
lane than anything a human is waiting on.

**Storage is the real constraint, and the answer is: don't store it.** A MISMO 2.6 appraisal carries
the entire report PDF inside itself as base64 — real files run **5–30 MB** (hence `xml-import.js`'s
80 MB ceiling). 3,000 × ~15 MB ≈ **45 GB**, which would not fit a Render disk and does not belong
there anyway. `importXml` takes the XML **as a string**, extracts what it needs, and keys on the
sha256 — so the sweep should **parse and discard**, persisting only the warehouse rows plus the hash
in `property_ingest_log` so a re-run is idempotent and resumable. (If the owner later wants the
original file kept for a specific loan, that is a per-file decision through the normal document
chokepoints, not a bulk policy.)

**Make it incremental after the first pass.** The pipeline already sorts by `Loan.LastModified`;
after the initial sweep, only loans modified since the last run need re-checking, and a loan whose
appraisal XML hash we have already ingested needs no download at all. Steady state is a handful of
calls a day.

---

## 5. Telling an appraisal XML from any other XML

Four signals, applied in this order. **Never rely on the filename alone** — AMC naming is not
standardised and Encompass may rewrite it.

1. **File extension / contentType.** From the attachment metadata: the id itself carries the
   extension (`Attachment-<guid>.xml`), and `contentType` comes back on the download-URL response
   when the request sets `"type":"Cloud"` (`application/xml` / `text/xml`). This is the cheap first
   filter — on most loans it will already leave you with one candidate.
2. **The document it is assigned to.** If the attachment sits under an eFolder document whose title
   is Appraisal-ish (`Appraisal`, `Appraisal Report`, `UAD`, `Appraisal XML`, `SSR or CDA`), that is
   strong. **But this can legitimately be empty** — a loan-folder attachment is assigned to no
   document at all. Treat this as a booster, never a gate.
3. **Filename patterns** — useful for ranking, never for deciding. Observed conventions in this
   space: `<orderNumber>_UAD.xml`, `<address>_1004.xml`, `appraisal.xml`, `<loanNumber>.xml`,
   `*_MISMO*.xml`, `*_UCDP*.xml`. Class Valuation / Appraisal Nation and NAN each have their own
   house style — **the owner's sample file (§0.4) settles this in one look** and I would rather read
   two real names than guess at ten.
4. **The root element — the only signal that actually proves it, and it is free.** Once we have the
   bytes, `extract.js` already decides authoritatively:
   - `VALUATION_RESPONSE` / `REPORT` root, `MISMOVersionID` 2.6 → **our format, parse it.**
   - `MESSAGE` root (MISMO 3.x) → **UAD 3.6 — recognised by name and refused with a clear reason.**
   - anything else → `not a MISMO VALUATION_RESPONSE / REPORT`.

**The right design falls straight out of that:** filter to XML attachments (step 1), rank by
document + filename (steps 2–3), fetch bytes for the best candidate, and let the parser be the judge
(step 4). If the parser says no, try the next candidate. Because `extract()` is pure, cheap, and
never guesses, "download it and ask the parser" is both the most accurate strategy and an entirely
safe one. The only cost of a wrong guess is one wasted download.

**One thing to watch:** a loan can carry *more than one* appraisal XML — an original plus a
1004D/completion report, or a re-inspection, or two appraisals on a disputed value. Do not stop at
the first hit; ingest all of them. `importXml`'s sha256 keying and its "a loan file already
contributed this exact report" stand-down make that safe.

---

## 6. UAD 2.6 vs 3.6 — where the industry actually is, and what it means for us

**Today (3 August 2026) we are between "open production" and "mandatory".** The dates, from the GSEs
and the appraisal industry:

| Date | Milestone |
|---|---|
| **8 September 2025** | Limited Production Period — approved lenders may submit UAD 3.6 |
| **26 January 2026** | Broad/open production — **all** lenders may submit UAD 3.6 alongside legacy UAD 2.6 |
| **2 November 2026** | **UAD 3.6 becomes mandatory for new GSE appraisal submissions** (≈3 months from now) |
| **3 May 2027** | The UAD 2.6 pipeline is **fully retired** |

Sources: [Freddie Mac UAD & Forms Redesign FAQ](https://sf.freddiemac.com/faqs/uad-and-forms-redesign),
[Clear Capital's lender guide](https://www.clearcapital.com/what-is-uad-3-6-how-the-new-appraisal-standard-will-impact-lenders/),
[McKissock's timeline summary](https://www.mckissock.com/blog/appraisal/the-future-is-now-fannie-mae-and-freddie-mac-announce-uad-3-6-implementation-timeline-and-policy-changes/).

**Our honest read of what this means for YS Capital's book:**

- **Everything already in Encompass is UAD 2.6.** Every one of the 33 files the parser was proven
  against is 2.6, the format has been the only game in town for the whole history of this book, and
  3.6 only reached broad production six months ago. **A historical sweep should hit a very high 2.6
  rate.** That is the entire value of doing this now.
- **New files are the uncertainty, and it is a genuine one.** The mandate is for **GSE submissions**.
  These are business-purpose loans that are never delivered to the GSEs, so nothing *forces* a 3.6
  report onto a YS Capital file. But AMCs do not run two production lines forever — once 3.6 is
  mandatory for their agency volume (November), the commercial pressure is to standardise, and
  private-lending clients get whatever the platform emits. **Class Valuation and NAN are both
  publicly deep into 3.6 readiness.** So "we can read every file we get" is true today and is
  **not** a safe assumption for 2027.
- **We fail loudly, not silently.** `extract.js`'s version guard names the format and refuses. A
  bulk sweep will therefore produce a *countable* "N files were UAD 3.6" number rather than a pile of
  half-empty rows. That number is the trigger for deciding whether to build a 3.6 reader.
- **UAD 3.6 is not a patch — it is a different parser.** MISMO 3.x is a `MESSAGE`-rooted, hierarchical
  element model; MISMO 2.6 is an attribute-heavy `VALUATION_RESPONSE`. **None** of our XPaths survive.
  It also changes packaging, splits condition/quality into interior + exterior ratings that reconcile
  to an overall, and replaces the 1004/1025/1073 forms with one dynamic URAR.
  `docs/appraisal-xml/mismo-uad-spec-reference.md` §"UAD 3.6 / MISMO 3.6" already says this in terms.
- **Recommendation:** ship the 2.6 sweep now — it harvests the entire history, which is where the
  comparable-sales value is concentrated and which will never get any easier to collect. Treat the
  3.6 reader as a separate, scheduled project sized off the real refusal count, and make the sweep
  **record every refusal with its reason** so that count exists.

---

## 7. What I could not confirm from documentation — and exactly how to settle it

These are the honest gaps. None of them block starting; all of them are cheap to close.

### 7.1 Is the XML actually on the loans? (highest stakes, easiest to check)

**Unconfirmed.** Everything above says it should be, and `CX.IMPORTAPPRAISALXMLWHEN` says somebody
built for it — but a lender-side toggle can be off, and the AMC may deliver only a PDF on
private-lending orders.

**Settle it — owner, ~5 minutes:**
> Log into Encompass, open a recent **funded** loan you know had an appraisal (give me the loan
> number too). Go to **eFolder → the Appraisal folder**. Tell me: (a) how many files are attached,
> (b) their exact file names, (c) whether any of them is **not** a PDF or shows no preview. Then go
> to **Settings → Services Management → Class Valuation (Appraisal Nation) → Document Mapping**, and
> the same for **Nationwide Appraisal Network**, and tell me whether there is a row for the
> **appraisal XML / UAD XML / data file** and whether it is **on**.

**Settle it — engineering, ~1 minute of API time, no new permissions:** `GET
/encompass/v3/loans/{guid}/attachments` and `GET /encompass/v3/loans/{guid}/documents` on three real
loans, and print the file names and types. **Both are plain GETs and are already permitted by the
frozen client** — this diagnostic can be run today, and it answers the question definitively without
any sign-off. **This is the first thing to do.**

### 7.2 Will `originalUrls` return the native XML?

**Unconfirmed.** Depends on the tenant's eFolder conversion settings.

**Settle it — owner:** eFolder → **Setup → Conversion Preferences** → is *"Keep a copy of the
document in its original format"* checked?
**Settle it — engineering:** one `attachmentDownloadUrl` call on a known XML attachment id, once
sign-off exists; if `originalUrls` is empty the answer is a settings change, not code.

### 7.3 Can we list a loan's service orders? (would remove the need for the new POST)

**Unconfirmed.** `GET .../serviceOrders/{orderId}` and `GET .../serviceOrders/{orderId}/response/resources`
are documented; a per-loan **list** is not, in any source I could reach. The 800-request Postman
collection extracted in this repo contains **no** `serviceOrders` entries at all (the resource
post-dates it), so the local corpus cannot answer it either.

**Settle it — engineering, no sign-off needed:** try `GET /encompass/v3/loans/{guid}/serviceOrders`
on a loan with a known appraisal order. It is a GET; the frozen client permits it; the worst case is
a 404/405 and we know. **Do this before asking for the POST sign-off** — if it works and the AMC uses
EPC Service Orders, the whole feature is GET-only and the sign-off question disappears.

### 7.4 Which framework do Class Valuation and NAN actually use?

**Unconfirmed.** EPC Service Orders vs. the legacy partner-transaction framework changes §2.3
entirely. §7.3's probe answers it implicitly.

**Settle it — owner:** in **Settings → Services Management**, are Class Valuation / Appraisal Nation
and NAN listed there (that is EPC), or do they appear only under the older **Services** tab in the
desktop client?

### 7.5 Are XML loan-folder attachments returned by `GET /attachments` at all?

**Unconfirmed, and it is the one thing that could genuinely break the plan.** ICE says loan-folder
attachments are reachable "via the Developer Connect APIs" but does not say *which* endpoint. If they
are **not** in `GET /v3/loans/{guid}/attachments`, we need to find the resource that lists them
before anything else is worth building.

**Settle it:** the §7.1 engineering probe answers this at the same time — if the loan has an XML and
it appears in that GET, the question is closed.

### 7.6 Persona / access rights

**Partially confirmed.** Scope is `lp` (what we already use), but eFolder access is **persona-driven**
per document folder — a read-only service user can be configured such that it cannot see the
Appraisal folder. We have already been bitten by this exact class: a normal-user token 403s on
`GET /settings/loan/folders` in this tenant (see the comment in `reader._fetchAllFolderNames`).

**Settle it:** the §7.1 probe surfaces it as a 403 or an empty list. If it 403s, the fix is an
Encompass admin granting the service user's persona read access to the Appraisal document folder —
still no write rights anywhere.

### 7.7 Two smaller ones

- **How many loans are in the tenant?** Not recorded anywhere in the repo. The bulk-pull run table
  will report it on the next run; the §4 math scales linearly.
- **Do old/archived loans still carry their attachments?** Archived loans are reachable via the
  pipeline (`includeArchivedLoans`), and eFolder deletion is soft — but attachment retention on very
  old files is undocumented. The sweep will simply report what it finds.

---

## 8. Recommended sequence

Deliberately ordered so that **the first two steps need no sign-off and no new permissions**, and so
that we do not ask the owner for a POST we may not need.

1. **Probe, read-only, today.** On 3–5 real loans (mix of recent + old, RTL + DSCR), run
   `GET .../attachments`, `GET .../documents`, and `GET .../serviceOrders`. Print names, ids, types,
   assignments. This answers §7.1, §7.3, §7.4, §7.5 and §7.6 at once. **Every one of these calls is
   already permitted by the frozen client** — nothing changes, nothing is written, nothing is stored.
2. **Owner check, in parallel** — the three items in §0.4, plus one sample XML file from the AMC
   portal so the format question is settled from real bytes rather than industry timelines.
3. **Decide the door.** If step 1 shows a GET-only route via service orders → build it, no sign-off
   needed. Otherwise → put the §3 sign-off ask to the owner in one sentence, for the one endpoint.
4. **Build the reader isolated** — `src/encompass/appraisal-xml.js` with its own narrow
   method+path allowlist (the `flood-order.js` shape), its own switch (default **off**), its own
   dry-run mode, and a separate SSRF-guarded, bearer-free downloader for the foreign-host URL.
   `src/lib/integrations/encompass.js` is **not touched**.
5. **Sweep incrementally, parse and discard.** Hook the per-loan read into `bulkPullAllLoans`'s
   existing paced loop behind its own switch; bounded per run, resumable from a durable cursor,
   idempotent on the XML sha256, honouring `Retry-After` and `X-Concurrency-Limit-Remaining`. Feed
   `importMany`. Store warehouse rows, not files.
6. **Count what we could not read** — every refusal, with the parser's own reason ("UAD 3.6 / MISMO
   3.x", "not a MISMO VALUATION_RESPONSE"), per loan. That number is the business case for a 3.6
   reader, and it is worthless if we do not collect it from day one.

**Non-negotiable throughout:** every call is a read; nothing is ever written to Encompass; the
existing three-POST allowlist is not widened without the owner's sign-off in their own words; and
`scripts/test-encompass-readonly.js` keeps asserting the exact permitted set.

---

## 9. Sources

**ICE / Ellie Mae official**
- [Transaction Response Attachments (Partner Connect)](https://docs.partnerconnect.elliemae.com/partnerconnect/docs/transaction-response-attachments) — eFolder-supported formats; **XML/JSON become loan folder attachments**; accessible via Developer Connect APIs
- [Inbound Document Mapping (Partner Connect)](https://docs.partnerconnect.elliemae.com/partnerconnect/docs/inbound-document-mapping) — partners send a document `type`; lenders map types → eFolder document folders in Services Management
- [Service Ordering via Encompass Developer Connect](https://docs.partnerconnect.elliemae.com/partnerconnect/docs/service-ordering-via-encompass-developer-connect) — `GET /encompass/v3/loans/:id/serviceOrders/:id/response/resources`
- [Manage Attachments (Developer Connect)](https://developer.icemortgagetechnology.com/developer-connect/reference/efolder-attachment-1)
- [Manage Documents (Developer Connect)](https://developer.icemortgagetechnology.com/developer-connect/reference/efolder-document-1)
- [V3 APIs for Loan Attachments](https://developer.icemortgagetechnology.com/developer-connect/docs/using-cloud-storage-apis-for-loan-attachments)
- [Concurrency Limits](https://developer.icemortgagetechnology.com/developer-connect/docs/concurrency-limits) — 30 concurrent per environment, shared; `X-Concurrency-Limit-*`; 429
- [24.2 Major Release](https://developer.icemortgagetechnology.com/developer-connect/changelog/242-major-release) — `contentType` added to the download-URL response when the body sets `"type":"Cloud"`
- [25.3 Major Release](https://developer.icemortgagetechnology.com/developer-connect/changelog/253-major-release) — **V1 eFolder attachment APIs deprecated in 26.3**
- [Export Loan to MISMO 3.4](https://developer.icemortgagetechnology.com/developer-connect/reference/export-loan-to-mismo-34) — loan application data, not appraisal
- [UCDP in Encompass (ICE documentation library)](https://help.icemortgagetechnology.com/DocumentationLibrary/360/UCDP.pdf) — a screen, not an API

**AMC / integration partners (behaviour in the field)**
- [Ordering an Appraisal from Encompass — Appraisal Firewall help](https://appraisalfirewall.freshdesk.com/support/solutions/articles/69000652100-ordering-an-appraisal-from-encompass-) — the Import step; data + files; the **Appraisal XML toggle**
- [Setup EPC to Appraisal FirewallX — SharperLending](https://sharperlendingllc.freshdesk.com/support/solutions/articles/43000732077-setup-encompass-partner-connect-epc-to-appraisal-firewallx)
- [Customize Document Folders in EPC — SharperLending](https://sharperlendingllc.freshdesk.com/support/solutions/articles/43000732079-how-to-customize-document-folders-in-encompass-partner-connect-epc-) — the appraisal report routes to the **Appraisal** folder by default
- [ValueLink — appraisal platform integrations / how data flows across LOS](https://www.valuelinksoftware.com/appraisal-platform-integrations-how-data-should-flow-across-los-ordering-platforms) — the delivered packet: PDF, **UAD XML**, invoice, compliance cert, SSRs, EAD outputs; filed into eFolder categories with key values mapped into fields
- [Class Valuation — Appraisal Nation (private lending)](https://www.classvaluation.com/appraisal-nation/)
- [Nationwide Appraisal Network — UAD 3.6](https://nan-amc.com/uad_3_6/)

**Real-world API behaviour**
- [EncompassRest #371 — attachment id/content with document conversion enabled](https://github.com/EncompassRest/EncompassRest/issues/371) — conversion splits files to png/jpg; `originalUrls` needs "save original file"
- [EncompassRest #413 — getting native attachments with conversion on](https://github.com/EncompassRest/EncompassRest/issues/413) — the `NativeKey` marker
- [Production client using `attachmentDownloadUrl` + `originalUrls`](https://github.com/seth-lyons/legacy.shared-resources/blob/main/EncompassAPI/EncompassClient.cs) — the confirmed request body and response field names

**UAD 3.6 timeline**
- [Freddie Mac — UAD and Forms Redesign FAQ](https://sf.freddiemac.com/faqs/uad-and-forms-redesign)
- [Clear Capital — UAD 3.6 guide for lenders](https://www.clearcapital.com/what-is-uad-3-6-how-the-new-appraisal-standard-will-impact-lenders/)
- [McKissock — GSE UAD 3.6 implementation timeline](https://www.mckissock.com/blog/appraisal/the-future-is-now-fannie-mae-and-freddie-mac-announce-uad-3-6-implementation-timeline-and-policy-changes/)

**This repo (read-only)**
- `src/lib/integrations/encompass.js` — the frozen client, the three-POST allowlist, `_isFieldReaderPath`
- `src/encompass/client.js`, `reader.js`, `reconcile.js`, `enrich.js`, `flood-order.js`
- `src/sync/encompass-sync.js`, `db/247_encompass_loan_snapshot.sql`
- `src/lib/appraisal/extract.js` (the MISMO 2.6 contract + the UAD 3.6 version guard), `docs/appraisal-xml/*`
- `src/lib/research/xml-import.js` (`importXml` / `importMany`)
- `docs/ENCOMPASS-API-ATLAS.md` §7 (conditions/eFolder), §9 (classification), §10 (allowlist — G5 pre-approves `attachmentDownloadUrl` as optional)
- `docs/encompass-research/analysis/conditions-efolder-extract.md` (the official Postman collection's eFolder requests, verbatim)
- `docs/encompass-research/analysis/encompass-live-customfield-catalog.md` — **`CX.IMPORTAPPRAISALXMLWHEN`**, `CX.SSRORCDA`, the `CX.KM.*` plugin family
