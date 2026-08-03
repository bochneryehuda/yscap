# Encompass appraisal XML — where it lives, and how to get it

**Status: the XML was FOUND. It is real, it is per-loan, and it is the exact MISMO 2.6 format
`src/lib/appraisal/xml.js` already parses. One blocker remains (a 15-minute signed-URL window),
and the fix for it is a webhook.**

Live read-only investigation against the tenant, 2026-08-03. Every number below was measured,
not assumed. Nothing was written to Encompass at any point.

---

## 1. The answer in one paragraph

When an AMC returns an appraisal through **Encompass Partner Connect (EPC2)**, the MISMO 2.6
appraisal XML **is** delivered to Encompass and **is** recorded against the loan — but it is
**not** an eFolder attachment. Encompass classifies `.xml` as a *non-viewable* format and files
it as **loan media** (`urn:elli:media:loans`) instead, which is why it is invisible in the
eFolder UI and why a tenant-wide eFolder scan finds zero XML. It is visible through
`GET /encompass/v3/loans/{loanGuid}/serviceOrders/{orderId}?view=complete`, in
`response.resources[]`, tagged
`type: "urn:ice:epc:partner:appraisal:report:version:V2.6"`.

The owner's instinct was exactly right on both halves: *"I don't believe it supports XML"*
(correct — the eFolder does not) *"but I believe there is somewhere that you can find the XML"*
(correct — the service-order response resources).

---

## 2. What is actually in the tenant

| Measure | Count |
|---|---|
| Loans scanned (whole pipeline, all folders) | **746** |
| Loans carrying ≥1 service order | 426 |
| Appraisal-category service orders | **580** |
| eFolder attachments scanned | **29,564** |
| **Attachments whose real content type was checked (EVERY one in the tenant)** | **29,562 → 29,550 `application/pdf`, 6 Word `.docx`, 6 JPEG, ZERO XML** |
| **MISMO 2.6 appraisal XMLs found in service-order resources** | **298, across 136 loans** |

The per-loan index (loan number, address, XML filename, resource id, order id, received date)
is reproducible with the recipe in §6.

---

## 3. There are exactly TWO appraisal paths, and they behave completely differently

### Path A — EPC2 (Encompass Partner Connect) — **the XML path**

| Vendor | Orders | Delivers XML? |
|---|---|---|
| **Class Valuations - Appraisal** | 210 | **YES — 298 MISMO 2.6 XMLs** |
| Clear Capital | 178 | No — CDA review product, PDF only (`CDA Final Report`, `CDA Invoice`) |
| PropertyRate | 2 | No resources returned |

A fulfilled Class Valuations order returns a `response.resources[]` of ~12 files. Document
types seen across the tenant:

| Vendor document type | Count | Format |
|---|---|---|
| UCDP Submission Summary Report | 512 | PDF |
| Borrower Delivery Certificate | 459 | PDF |
| Automated Form - AIC | 285 | PDF |
| Completed Product (Image) | 282 | PDF |
| **`urn:ice:epc:partner:appraisal:report:version:V2.6`** | **275** | **XML** |
| Invoice | 153 | PDF |
| QRR Report | 24 | XLSX |

### Path B — EMN (the legacy Ellie Mae Network integration) — **no XML, at all**

| Vendor | Orders | Status | Resources |
|---|---|---|---|
| **Nationwide Appraisal Network** | 190 | all `requested` | **0** |

The old integration never reports back through this API. Its orders sit permanently at
`requested` with an empty `response`. Its deliverables arrive as **PDFs dropped into the
eFolder** (`nan_*.pdf` — report, compliance certificate, SSR, appraiser licence, E&O, invoice).
One loan even has a human-named bucket `"Apppraisal report,xml,air,ssr,license,eo"` — but every
file in it is a PDF. **There is no API-reachable XML on this path.** If NAN sends an XML at all,
Encompass consumes it for field mapping and retains no addressable copy.

**PROVEN EXHAUSTIVELY, not inferred.** Every attachment in the tenant — all **29,562** of them
across 571 loans — was asked for its real declared content type (not its filename): **29,550
`application/pdf`, 6 Word `.docx`, 6 JPEG. Zero XML of any kind.** So the answer is the same on
BOTH paths, and it is not a question of looking in a different folder: the eFolder holds no XML
because ICE's eFolder cannot hold one. Do not re-run this scan; the result is recorded here.

*(Careful with a naive `/xml/i` filter over content types — `application/vnd.openxmlformats-…`
contains the substring "xml". Those six hits are Word documents, not appraisal XML.)*

**Consequence:** the two paths cannot share one implementation. Path A gets the XML; Path B can
only ever give us the PDF plus the parsed field data (§7).

---

## 4. The exact read path (Path A)

All GET. No writes.

```
1. POST /oauth2/v1/token                                  (auth; password grant, scope "lp")
2. POST /encompass/v3/loanPipeline                        (find loans — read-shaped, already allowlisted)
3. GET  /encompass/v3/loans/{loanGuid}/serviceOrders      (list orders on the loan)
      → keep those with serviceSetup.category === "APPRAISAL"
4. GET  /encompass/v3/loans/{loanGuid}/serviceOrders/{orderId}?view=complete
      → response.resources[] — find mimeType "application/xml"
        and type "urn:ice:epc:partner:appraisal:report:version:V2.6"
5. GET  <resource.location>   with header  Authorization: <resource.authorization>
      → raw MISMO 2.6 XML bytes
```

A resource entry looks like this:

```json
{
  "id": "B2.be11397907KS*<loanGuid>KS*<uuid>.xml",
  "name": "16341496.xml",
  "mimeType": "application/xml",
  "type": "urn:ice:epc:partner:appraisal:report:version:V2.6",
  "location": "https://streaming.us-east-1.skydrive.ellieservices.com/v1/clients/<clientId>/<objectId>?validity=<base64 epoch ms>",
  "authorization": "elli-signature <hex>",
  "uploadedEntity": { "entityId": "16341496.xml", "entityType": "urn:elli:media:loans" },
  "receivedDate": "2026-07-23T13:03:17Z",
  "status": { "type": "Success" }
}
```

`view` accepts `DETAILS` (alias `complete`), `DEFAULT`, `CATEGORIZED`. Only `DETAILS`/`complete`
expands `response.resources`, and only on the **single-order** endpoint — the list endpoint
rejects it.

---

## 5. The one blocker: the signed URL is frozen at delivery and lives ~15 minutes

`location` is **not** minted on read. It is stored at delivery time and returned verbatim
forever. Measured on every XML in the tenant:

| XML | receivedDate | URL validity | window |
|---|---|---|---|
| 16341496.xml | 2026-07-23T13:03:17Z | 2026-07-23T13:18:06Z | 14m 49s |
| 16754820.XML | 2026-07-30T23:32:31Z | 2026-07-30T23:47:19Z | 14m 48s |

**All 298 historical URLs are expired** (`SKYDRIVESTREAM-3001 'Url' is expired`). Re-reading the
order returns the identical dead URL. Confirmed not recoverable by: stripping `validity`,
substituting a Bearer token, or re-requesting under any `view`.

### What DOES work

The sibling endpoint **`GET .../serviceOrders/{orderId}/response/resources` mints FRESH signed
URLs** — and a fresh URL downloads perfectly (verified: pulled a 96,416-byte PDF end-to-end with
the `elli-signature` header). **But it returns only resources whose `uploadedEntity.entityType`
is `urn:elli:encompass:attachment`** — i.e. the eFolder PDFs. It never returns the
`urn:elli:media:loans` XML. Checked across 12 orders known to hold XML: every one returned
exactly one PDF and no XML.

So the download *mechanism* is proven; only the *fresh-URL-for-media* half is missing.

**That omission is BY DESIGN, not a permission gate.** ICE's published response schema for
`/response/resources` contains exactly two element shapes — `urn:elli:encompass:attachment` and
`urn:elli:encompass:document` — with the inline note that `name` and `mimeType` are *"Inherited
from eFolder export."* The endpoint is built on the eFolder export pipeline, so an object that
was never in the eFolder has no path through it. The same doc page's `view=complete` example
*does* show a `urn:elli:media:loans` element, so ICE knows both types exist and deliberately
lists only two here. Nothing we configure changes that.

**And there is no documented loan-media API to fall back on.** An enumeration of all ~670
Developer Connect API reference pages across 59 categories finds no Media / Loan Media / Loan
Folder Attachment endpoint of any kind. ICE's own sentence — non-viewable files *"can be accessed
… via the Developer Connect APIs"* — is unbacked by any named endpoint. (Beware a false friend:
`/encompass/v3/settings/loan/folders` is **pipeline** folders — My Pipeline / Archive — and has
nothing to do with a "loan folder attachment".)

### Ways to reach the XML that were tried and did NOT work

| Attempt | Result |
|---|---|
| `POST .../attachmentDownloadUrl` with the media object id | `EFOLDER-5050 Attachment not found (EBS.AttachmentFilter)` — it is not an eFolder attachment |
| `GET /efolder/v1/loans/{id}/files` | 20 files, all `urn:elli:encompass:attachment`, all PDF — media not listed |
| `GET /efolder/v1/loans/{id}/files/{mediaObjectId}?includeMetaData=true` | `EFOLDER-5093 Bad Request` |
| `/media`, `/loanMedia`, `/mediaFiles`, `/loanFolderAttachments`, `/files`, `/media/v1/...` | 403 |
| `GET .../serviceOrders/{id}/response/resources/{resourceId}` | 403 |
| `POST /encompass/v3/loans/{id}/mediaDownloadUrl` and variants | 403 |
| `GET /services/v1/partners/{partnerId}/transactions/{transactionId}?generateFileUrls=true` — the legacy path ICE documents as the one that exposes **native** formats — tried against all 44 partner ids in the tenant directory | HTTP 500 (`A null value was returned…`) for every partner id. The transaction is an **EPC2** transaction; the legacy EVP transaction store does not contain it. Class Valuations is not in the legacy partner directory at all (its only appraisal entries are DART and Mercury Network). Avenue closed. |

**Two hypotheses ruled OUT, so nobody re-tries them:**

1. **It is not a persona problem.** ICE documents that native (non-viewable) file formats require
   "loan access **and** an admin/super admin persona". `GET /encompass/v1/users/admin` reports
   `"title": "Super Administrator"`, `"isAdministrator": true`, `"isSuperAdministrator": true`,
   `"accessMode": "ReadWrite"`, `"isTopLevelUser": true`. The user already has the highest persona
   there is, and `/response/resources` *still* omits the media XML. Escalating the user will not
   fix this.
2. **The legacy `generateFileUrls=true` route does not apply**, per the table row above — it is an
   EVP-era mechanism and these are EPC2 transactions.

That leaves the API application's endpoint entitlements (§8) as the remaining lever inside
Encompass, and the AMC as the lever outside it.

**Important caveat on those 403s:** this API application returns `403` with an empty body for
*deliberately nonsense paths too*, so 403 does **not** prove a path is absent. It is the
gateway's generic denial. See §8 — the app has a restricted endpoint allowlist, and several of
these may simply need enabling.

---

## 6. The recommended plan

### 6a. Going forward — webhook, and it works with the permissions we already have

`GET /webhook/v1/resources` confirms the tenant exposes a **`ServiceOrder`** resource with events
`placed, acknowledged, fulfilled, processfailure, eventreceived, deliveryfailed, fulfillmentfailed`.
`GET /webhook/v1/subscriptions` works and the tenant already runs one subscription (a `loan` /
`milestone` hook pointing at an unrelated automations endpoint).

So:

1. Subscribe to `ServiceOrder` → `fulfilled` (and `eventreceived`, which fires per delivered
   resource and is the tighter trigger).
2. On fire, immediately `GET .../serviceOrders/{orderId}?view=complete`.
3. Pull any `application/xml` resource **inside the ~15-minute window** using its `location` +
   `authorization`.
4. Store the bytes on our side and hand them to the existing
   `appraisal.importAppraisal(db, { xml })`.

This is the whole feature. The window is generous for a webhook-driven fetch; a delivery we miss
can be retried only until the URL expires, so the handler must fetch immediately rather than
enqueue for a slow worker.

**Two things to build around, both real:**

- **The webhook payload does NOT carry the file.** ICE documents the ServiceOrder extra payload
  as exactly three fields — `productListingName`, `productId`, `partnerId`. It is a *trigger*
  only; step 2 above (the `?view=complete` call) is what actually yields the URL. Do not design
  as though the hook delivers the resource.
- **`location` and `authorization` are UNDOCUMENTED.** ICE's published `view=complete` resource
  schema is only `{id, name, mimeType, uploadedEntity{id,type}}`, and the same page states
  plainly: *"complete view includes request and response resources — **no resource URL generation
  supported** though."* The two fields we are relying on are undocumented residue that happens to
  be populated. They work today (that is measured, not assumed), but ICE is free to remove them
  in any release without it counting as a breaking change. **Anything built on this needs a loud
  alarm when the fields go missing**, and §6d below is the durable answer.

### 6d. The durable fix — have the AMC deliver the XML to us directly

EPC's eFolder-vs-loan-folder routing is automatic by file type and **the lender cannot override
it** — `.xml` will never be an eFolder attachment, no matter how Document Mapping is configured.
So every route through Encompass is fighting the platform.

The AMC (**Class Valuations**) is the origin of every one of these XMLs and already holds them.
Asking them to deliver the MISMO 2.6 XML to us directly — their portal, SFTP, or their own API —
removes Encompass from the path entirely, fixes the historical backfill and the go-forward flow
in one move, and does not depend on an undocumented field continuing to exist. **This is the
recommendation to put to the owner first.** The webhook route in §6a is the right thing to build
if we want it working without waiting on anyone else.

### 6b. The 298 historical XMLs — two options, in preference order

1. **Ask Class Valuations directly.** They are the source of every one of these XMLs, they retain
   them (EPC keeps transaction resources for 7 years), and the index carries the loan number,
   property address, XML filename and order id for each. This is the faster route and does not
   depend on ICE. **Recommended first move.**
2. **Raise it with ICE** (§8). Note this is now the *only* remaining in-Encompass lever, and it
   is a weak one: persona and the legacy transaction API are both ruled out (§5), and no loan-media
   endpoint appears anywhere in ICE's ~670 published API reference pages — so this is an ICE
   support ticket asking for something undocumented, not a configuration change we can look up.
   `POST /efolder/v1/exportjobs` is also ruled out: its documented body is
   `{fileName, annotationSettings, source{entityId,entityType}, entities{entityId,entityType}}`
   with `entityType` limited to `loan`/`attachment`/`document`/`condition` — no media type — and
   its output is a **merged PDF**, so it structurally cannot return raw XML.

Do **not** count on recovering them from Encompass as things stand — the stored links are dead.

### 6e. Once we HAVE the XMLs, the import already exists — do not build a new one

The owner's goal is these reports feeding the **property research database** (`docs/PROPERTY-COMP-DATABASE-RESEARCH.md`),
so the warehouse's comps, sales and appraisers are built off every appraisal Encompass ever
received, not only the ones that came through a PILOT loan file.

**`src/lib/research/xml-import.js` (`importXml` / `importMany`) is exactly that door, and it is
already built and wired.** Route `POST /api/research/imports` (any staff user, up to 100 files a
call; history at `GET /api/research/imports`). It is the right entry point and NOT
`appraisal/import.js`, which requires an `applicationId` — `appraisals.application_id` is
`NOT NULL` by design, and a loan-file appraisal row drives the appraisal desk, its findings and
its conditions, so a row with no file would be picked up by half a dozen sweeps that assume one.

What the XML door does instead: the SAME parser (`appraisal/extract.js`), then
`ingest.writeReport(client, { a, comps, link: { importId } })` — the one shared writer both doors
use — so the XMLs land as `properties` / `property_observations` / `property_sales` / appraiser
registry rows exactly as a loan-file appraisal does. It creates **no** application, appraisal row,
condition, finding or notification. De-duplication is already handled three ways: `research_imports.sha256`
(the same file twice), the report fingerprint (subject property + effective date + appraiser — so a
report we ALREADY hold from a loan file wins and the upload stands down, `existingFileCopy` /
`retireDuplicateImports`), and the row-level upsert pivots. Photos are not linked on this path
(there are no stored bytes) — everything else is identical.

**So the only missing ingredient is the XML bytes.** When they arrive from the AMC: drop them
through `POST /api/research/imports` in batches of 100. No new code.

### 6c. Reproducing the index

The per-loan index of every XML (loan number, address, vendor, filename, resource id, order id,
received date) is produced by walking every loan's `serviceOrders`, expanding each
`APPRAISAL`-category order with `?view=complete`, and collecting `response.resources[]` entries
whose `mimeType` is `application/xml`. 746 loans → 580 appraisal orders → 298 XMLs on 136 loans.

---

## 7. What we can already get today WITHOUT the XML

Encompass parses the incoming appraisal XML into loan fields, and those fields are readable now
on both paths. Confirmed populated on a live loan:

| Where | Fields |
|---|---|
| `underwriterSummary` | `appraisalType` (e.g. `FNMA-1025-v2005`), `originalAppraiser`, `originalAppraisersValue`, `reviewAppraiser`, `reviewValue`, `reviewRequestedDate`, `reviewCompletedDate`, `appraisalExpiredDate` |
| root | `propertyAppraisedValueAmount` |
| `property` | `structureBuiltYear`, `financedNumberOfUnits`, `lotAcres`, `numberOfStories`, `assessorsParcelIdentifier`, `floodCertificationIdentifier`, `propertyRightsType`, `propertyUsageType` |
| `contacts[APPRAISAL_COMPANY]` | appraiser name, company, email, phone, address, `personalLicenseNumber`, `personalLicenseAuthStateCode`, `appraisalMade` |
| `contacts[FLOOD_INSURANCE]` | `insuranceFloodZone`, `insuranceDeterminationDate`, `insuranceDeterminationNumber` |
| `customFields` (YS Capital's own) | `CX.ASISVALUE`, `CX.APPRAISALTYPE`, `CX.PROPERTYTYPE`, `CX.ACTAULARV`, `CX.MAXARV`, `CX.#OFBED/BATHS`, `CX.PRE-REHABSQFT`, `CX.POST-REHABSQFT` |

**What this does NOT give us, and only the XML can:** the **comparable sales grid**, per-comp
adjustments, condition/quality ratings, GLA basis, photographs, and the embedded report PDF.
Those are precisely what `src/lib/appraisal/extract.js` exists to read, so the XML remains worth
chasing — the field data is a useful floor, not a substitute.

---

## 8. Operational finding: the API app has a restricted endpoint allowlist

The Developer Connect application used here authenticates with scope `lp` (the only scope
Encompass offers) but is **denied a number of ordinary endpoints**, which is a per-endpoint
entitlement, not a scope problem:

| Works | Denied (403, empty body) |
|---|---|
| `/loans/{id}`, `/attachments`, `/documents`, `/serviceOrders`, `/serviceOrders/{id}?view=complete`, `/milestones`, `/conversationLogs`, `/loanPipeline`, `/fieldReader`, `/settings/loan/customFields`, `/users`, `/webhook/v1/*`, `/efolder/v1/loans/{id}/files`, `/histories/eFolder`, `/schemas/loan/standardFields` | `/settings/loan/folders`, `/associates`, `/logs/milestoneLogs`, `/auditTrail`, `/loans/{id}/mismo`, `/oauth2/v1/clients` (*"API Entitlement is not present to access API Keys"*), and every loan-media path tried |

Two things worth raising with ICE / the Encompass admin:

1. **Enable the loan-media (non-viewable file) read endpoints** so the 298 historical XMLs — and
   any future delivery whose 15-minute window we miss — become downloadable.
2. `GET /encompass/v3/settings/loan/folders` being denied is why a pipeline search has to filter
   on `Loan.LastModified > 2000-01-01` instead of enumerating folders. Minor, but easy to fix.

---

## 9. Notes for whoever implements this

- **`READ_ONLY` still holds.** Everything in §4 is a GET except the two POSTs already allowlisted
  in `src/lib/integrations/encompass.js` (token + pipeline search). Reading the XML needs **no new
  POST**, so the freeze rule in CLAUDE.md is not touched. Creating the webhook subscription
  (`POST /webhook/v1/subscriptions`) *is* a write to Encompass configuration and needs the owner's
  explicit written sign-off before it is built — it does not modify any loan, but it is not a read.
- **The instance is PROD.** Token introspection reports
  `"encompass_instance_type": "Prod"`, `"encompass_instance_id": "BE11397907"`. The credentials
  supplied for this investigation are production credentials, not a sandbox. Only reads were
  performed.
- **The XML is exactly what our parser wants.** `type: ...appraisal:report:version:V2.6` is MISMO
  2.6 — the format `src/lib/appraisal/xml.js` was built and proven against on 37 real files. It
  also carries the embedded report PDF (`xml.embeddedPdfBase64()`), so one XML yields data, comps
  and photographs together.
- **Filenames vary in case** (`16754820.XML` vs `16731143.xml`) — match on `mimeType` and the
  `type` URN, never on the extension.
- **`resource.id` is an opaque compound string**, not a UUID
  (`B2.<instance>KS*<loanGuid>KS*<uuid>.xml`). Do not parse it.
- **One loan can hold several XMLs** (re-inspections, revised reports). 298 XMLs across 136 loans.
  Order by `receivedDate` and keep the newest as current, superseding the rest — the same rule
  `appraisals.superseded` already applies.
