# Appraisal DOCUMENT SYNC — Current State, Gap Analysis & Implementation Design

**Scope:** the INBOUND (completed-report) and OUTBOUND (upload-to-vendor) document flows for the
two appraisal vendors, kept technically separate: **AppraisalScope / NAN** (code namespace `amc`,
`src/amc/*`, CDG JSON, **poll — no webhook**) and **Class Valuation** (`src/class/*`, **webhook +
poll backstop**). Builds on the four prior docs in this folder — it does **not** re-inventory ordering,
comments, ROV, payment, or the unified UI; it drills into exactly the seven owner requirements about
where returned documents LAND and how documents are PUSHED to the vendor.

Paths are relative to `/home/user/yscap/yscap-repo-root_8/`. Read-only research doc; no source was changed.

---

## 0. The one condition everything hangs on — `rtl_cond_appraisaldocs`

The real template code the owner asked us to find:

- **`rtl_cond_appraisaldocs`** — label **"Appraisal documents received"** — `db/059_appraisal_docs_internal_condition.sql`. Internal (`audience='staff'`, `item_kind='document'`), phase 3, `is_required=true`.
- **Two NAMED slots** on the template (`db/144_appraisal_condition_slots.sql`):
  ```json
  [{"key":"xml","label":"Appraisal data file (XML)"},{"key":"pdf","label":"Appraisal report (PDF)"}]
  ```
  A document lands in a slot by setting **`documents.slot_label`** (column added `db/031_conditions_slots_track_record.sql`). Both slots are required before the condition can be signed off (enforced in `signOffGate`).
- **The manual upload → auto-import path is the pattern to mirror** (`src/routes/staff.js` L15959-15997): a document uploaded with `slot` matching `/xml/i` **and** whose item's template code is `rtl_cond_appraisaldocs` triggers
  ```
  runAppraisalImport({ appId, xml, xmlDocumentId: <this xml doc>, pdfDocumentId: <current pdf-slot doc> })
  ```
  where the PDF doc id is found by `slot_label LIKE '%pdf%'` on the same item. This is the SAME importer both vendor ingests already call — `src/lib/appraisal/desk.js runAppraisalImport` (L300).
- Category mapping (SharePoint mirror + TPR export, `src/lib/tpr-export.js` L135): `rtl_cond_appraisaldocs → "Appraisal"`.

**The importer does NOT file documents into the slots.** `runAppraisalImport` records `sourceXmlDocumentId`/`pdfDocumentId` on the `appraisals` row (for photo/OCR recovery) but never touches `checklist_items`/`slot_label`. Filing the returned artifacts into the condition slots is the CALLER's job — and neither vendor ingest does it.

---

## 1. CURRENT STATE — INBOUND (completed report comes back)

### 1a. NAN / AppraisalScope — `src/amc/sync.js`

**How the report is retrieved (poll, no webhook):** `sync.start()` (booted `src/server.js` L1181) polls every open order (`pollOpenOrdersOnce → syncOne`, L212). On `product_available` (CDG 1990), `syncOne` calls `ingestDocuments` (L231-234). `ingestDocuments` (L125-207): `RetriveAppraisalDocuments` → GET each `objectURL` → save bytes → insert a `documents` row → hand the MISMO XML to `runAppraisalImport`.

**Where each artifact currently lands** (`ingestDocuments`, the INSERT at L161-169):
```
INSERT INTO documents (application_id, borrower_id, checklist_item_id, filename, ...,
  doc_kind, review_status, ..., source_type, visibility)
VALUES ($1,$2,$3,...,'staff',NULL,NULL,'pending',$9,'system','staff_only')
   -- $3 = order.checklist_item_id || null
```
- `checklist_item_id = order.checklist_item_id || null` (L167).
- **`slot_label` is NOT in the INSERT column list at all** — always NULL.
- `doc_kind = NULL`, `review_status='pending'`, `source_type='system'`, `visibility='staff_only'`.
- The AMC-side row is recorded in `amc_order_documents` (dedupe on `amc_document_id`, L150-154).

**Does it reach the appraisal-documents condition?** **No.** `amc_orders.checklist_item_id` is set only to whatever `body.checklistItemId` the order route received (`src/routes/amc.js` L77). The appraisal-order builder (`AmcAppraisalPanel.jsx` L82: `amcPlaceOrder(appId, { place, ...overrideParams() })`) sends only `formOverride`/`cdorOverride` — **never** the `rtl_cond_appraisaldocs` item — so `checklist_item_id` is **NULL in practice**. Even if it were set, `slot_label` is never written, so the docs would still not fill the named `xml`/`pdf` slots.

**Does the XML auto-run the findings import?** **Yes** — `ingestDocuments` L190-200 calls `runAppraisalImport({ appId, xml, xmlDocumentId, pdfDocumentId })`. This half is met. On import success it flips the order to `completed` (L202-205). Caveat: only the FIRST xml and FIRST pdf are tracked as `xmlDocId`/`pdfDocId` (L180-181); every OTHER returned PDF is still filed to `documents` but is not tracked as a slot fill.

### 1b. Class Valuation — `src/class/documents.js`

**How the report is retrieved (webhook + poll):** Class PUSHES a `NewAttachments` / `StatusChanged(Completed)` callback carrying only a name → `src/class/callbacks.js` L286-306 calls `documents.ingestForOrder`. Poll backstop: `src/class/poller.js` calls `documents.sweepPendingOnce()` and `ingestForOrder` on completion (L114, L147). `ingestForOrder` (L179; real work in `ingestForOrderLocked` L202-328, under a per-order advisory lock): LIST attachments → FETCH bytes (three undocumented shapes, `resolveAttachmentBytes`) → save → insert a `documents` row → hand the XML to `runAppraisalImport`.

**Where each artifact currently lands** (INSERT at L276-284): **identical shape to NAN** —
```
checklist_item_id = order.checklist_item_id || null,  slot_label NOT SET,
doc_kind NULL, review_status 'pending', source_type 'system', visibility 'staff_only'
```
Records `class_attachments.document_id/fetched_at` (dedupe on `(class_order_row, name)`).

**Does it reach the appraisal-documents condition?** **No — worse than NAN.** `class_orders.checklist_item_id` exists (`db/490` L32) but **nothing ever writes it** (grep found no writer in `src/class/*` or `routes/class.js`), so it is always NULL. `slot_label` is never set either.

**Does the XML auto-run the findings import?** **Yes** — L307-326 calls `runAppraisalImport`, recovering the PDF doc id from an already-fetched attachment when the XML and PDF arrived on different passes (L309-316). This half is met.

### 1c. Is each vendor wired to RECEIVE the completed report? (owner: "make sure the setup is correct")

Both are wired to receive; what differs is the transport and the operational switches.

| | NAN / AppraisalScope | Class Valuation |
|---|---|---|
| Transport in | **POLL only** — CDG never pushes. `sync.start()` ticks every `AMC_POLL_SEC` (min 30, default 300); on `product_available` pulls docs. | **WEBHOOK** (`routes/class-webhook.js` → `callbacks.processEvent` → `ingestForOrder`) **+ POLL backstop** (`poller.js`). |
| Switch to receive | `AMC_ENABLED` (read at call time — flip on, no redeploy). | `CLASS_ENABLED`; callbacks registered via `POST /api/class/callback-setup/register` (`client.registerAllCallbacks`), else the poll backstop still pulls. |
| Retrieval call | `RetriveAppraisalDocuments` (sic) → `getdocument/<id>`. | `GET /orders/{id}/attachments` → per-attachment bytes/URL. |
| **Verdict** | Receiving IS wired. **Operational check:** `AMC_ENABLED` on + valid CDG credentials + the poll worker running; there is no webhook to register (by design). | Receiving IS wired. **Operational check:** `CLASS_ENABLED` on + callbacks registered (or rely on the poll backstop) + valid credentials. |

The real defect is not "can we receive it" — it's **where it lands once received** (§1a/§1b): the returned PDF/XML never fill the `rtl_cond_appraisaldocs` slots and never re-open that condition for sign-off.

---

## 2. CURRENT STATE — OUTBOUND (upload documents TO the vendor)

### 2a. NAN / AppraisalScope — `src/amc/documents.js` (BUILT)

- **`uploadToOrder(dbh, order, {staffId, documentIds, action})`** (L73-154) — the exact push: read each document's bytes → stage at `/postdocuments` (multipart) → carry the returned `getdocument` retrieval URLs as `UploadDocument` / `UploadDocumentMulti` (`cdg.buildUploadDocuments`). Records `amc_order_documents` (direction `outbound`), journals to `amc_write_log`. Gated by `AMC_OUTBOUND_ENABLED`.
- **`listUploadable(dbh, appId, orderId)`** (L47-69) — EVERY current `documents` row on the file, each with its `tpr-export` category and an `alreadyUploaded` flag. **This is the "full list of every document" the upload-document button shows today.**
- **`autoUploadForOrder(dbh, order)`** (L160-169) — auto-uploads docs whose category is `CAT_SOW` ("Scope of Work", L30) or `CAT_CONTRACT` ("Contract & Assignment", L31), skipping HTML, deduped on `documents.id`. **Runs from the POLL** (`syncOne` L229), NOT at order placement.
- **Routes:** `GET /api/amc/files/:id/documents` (`amc.js` L243), `POST /api/amc/orders/:orderId/documents` (L251).
- **Frontend:** `AmcAppraisalPanel.jsx` `Documents` (L724-764) — a checkbox list of the full `listUploadable` result, "already sent" greying, "Send N to the order". `api.amcDocuments` / `api.amcUploadDocs`.

### 2b. Class Valuation — **NOTHING BUILT**

- `src/class/client.js` exposes `attachments` / `attachment` / `attachmentBytes` / `fetchUrl` (all **inbound**). There is **no upload method**. The Class API endpoint exists — `POST /{orderId}/attachments/{category}` with `FileData` + `AttachmentType` ∈ HyperLink/PDF/XML/Image, categories `SalesContract`/`PurchaseAgreement`/`PlansAndSpecs`/`ClientEngagementLetter`/`ROVDocument`/`Miscellaneous`/… (`CLASS-FEATURE-INVENTORY.md` §1.5) — but it is **not wired** (marked "NO" in that inventory).
- There is **no `class/documents.js` upload function**, **no outbound document table** (`class_attachments` is an inbound work-list only), and **no route**.
- **Frontend:** `ClassAppraisalPanel.jsx` has **no documents UI at all**.

### 2c. Document families & where they live on the file (for §4/§5/§6)

| Doc | Condition template code(s) | tpr-export category | doc_kind / how filed |
|---|---|---|---|
| Purchase contract | `rtl_p1_contract` (legacy `purchase_contract`) | `Contract & Assignment` (`CODE_CATEGORY` L110) | human upload on the condition |
| Assignment of purchase contract | `rtl_p5_assign` ("Assignment letter (if the contract is assigned)") — present only on an assignment deal | `Contract & Assignment` (L110) | human upload on the condition |
| SOW / construction budget | `rtl_p3_sow1`, `rtl_p1_budget`, `scope_of_work`, `rtl_p1_plans` | `Scope of Work` (L143) | the SOW tool's branded **Excel + PDF** (distinguish by `content_type`/extension; the tool also writes HTML — excluded) |

`amc/documents.js autoUploadForOrder` keys on the **category** ("Scope of Work", "Contract & Assignment"), so today it grabs the right families but (a) on POLL not placement, (b) does not split purchase-contract vs assignment, (c) does not single out the SOW Excel vs PDF.

---

## 3. GAP TABLE (requirement → current → gap → where to fix)

| # | Requirement | Current | Gap | Where to fix |
|---|---|---|---|---|
| **I1** | Report PDF **+ every other returned PDF** land in `rtl_cond_appraisaldocs` **PDF slot** | Filed to `documents` with `checklist_item_id = order.checklist_item_id` (NULL in practice) and **no `slot_label`** | Not attached to the condition; not in the `pdf` slot; only the first PDF is even tracked | NAN `src/amc/sync.js ingestDocuments`; Class `src/class/documents.js ingestForOrderLocked` — resolve the file's `rtl_cond_appraisaldocs` item + set `checklist_item_id` + `slot_label='pdf'` on each PDF |
| **I2** | Returned XML lands in **XML slot** AND triggers the findings import | Import **IS** triggered (both vendors, `runAppraisalImport`). But the XML doc has `checklist_item_id`=NULL, `slot_label`=NULL | XML not in the `xml` slot; not attached to the condition | Same two ingests — file the XML with `slot_label='xml'` on the condition; keep the existing `runAppraisalImport` call (pass the xml-slot doc + a pdf-slot doc) |
| **I3** | The completed order re-opens / clears the appraisal-docs condition | Import flips the ORDER to `completed`; the CONDITION is untouched | Condition sign-off state not re-driven from a vendor return | After filing, call `checklist-evidence.reopenConditionEvidence(db, itemId, 'received')` + `enqueueChecklistStatusPush(itemId)` (mirrors the manual path, `staff.js` L15940-15941) |
| **O1** | Upload a doc TO each vendor | NAN: `amc/documents.uploadToOrder` (built). Class: **nothing** | Class has no `client.uploadAttachment`, no `class/documents.uploadToOrder`, no outbound table, no route | Add `client.uploadAttachment(orderId, category, {fileData, attachmentType})` + `src/class/documents.js` outbound fn + `class_order_documents` table + route (all `src/class/*`, separate from NAN) |
| **O2** | Order-time auto-upload: purchase contract; assignment (assignment deal only); SOW Excel; SOW PDF | NAN `autoUploadForOrder` runs on POLL, category-based, no split, no missing flag. Class: nothing | No push at PLACEMENT; contract/assignment not split; SOW Excel/PDF not singled out; **no "missing documentation" state** anywhere | NAN: call an order-time gather+upload at the end of `order-service.createOrder` (after ACK). Class: at the end of the place route (`routes/class.js`) once accepted. Add a `missing_docs`/`docs_status` column per order table |
| **O3** | Auto-push on condition upload: contract/assignment/SOW later uploaded → push to any active order | NAN reaches it on the next POLL (`autoUploadForOrder`); Class never | No upload-TIME hook; poll-driven and NAN-only | Hook the condition-upload handler (`staff.js` L15918 `if (b.checklistItemId)` block, and the borrower mirror in `routes/borrower.js`): resolve active `amc_orders` + `class_orders` on the file and dispatch the push per vendor |
| **O4** | SOW-change revision button (per vendor, manual): upload new SOW PDF+Excel + message the AMC; if report is back, send a REVISION of a distinct kind `'update SOW into report'`; gate on SOW **accepted** + **matches** construction budget (`checkSowBudget`); mismatch → alert on the CONDITION, no push; SOW change → alert on the ORDER offering the button | NAN has a `sow_change` revision kind (`amc/revisions.js` L21, not report-gated) + can upload SOW. Class has reason-coded `requestRevision` only (report-gated), no upload, no SOW-change | No combined button; no budget gate before push; no distinct `sow_update_report` kind; no order-level "SOW changed" alert; Class can't upload at all | NAN: extend `amc/revisions.js KINDS` + a new endpoint; Class: `class/messages.js` new fn + the O1 upload. Shared pre-check: `rehab-budget.checkSowBudget`. Order alert: derive from a new SOW-sent marker vs current SOW doc |
| **O5** | Upload-document button redesign (both vendors, identical UX): menu of Scope of work · Purchase contract · Assignment · Manual (drag-drop) · Any other (only this expands the full picker) | NAN shows the full `listUploadable` list; Class has no UI | Full list is the default (should be one option); no by-condition shortcuts; no raw drag-drop upload; Class has no button | New shared `<UploadDocMenu>` in `app-v2`; backend: a "resolve latest doc on condition X" helper + a raw-bytes upload path per vendor; reuse `listUploadable` (NAN) / a new Class equivalent behind the "Any other" option |

---

## 4. IMPLEMENTATION DESIGN (keyed to real modules; vendors stay separate)

**Separation rule honored throughout:** each vendor keeps its own transport (`amc/client.js` CDG multipart vs a new `class/client.js` REST multipart), its own order/document tables, its own outbound gate (`AMC_OUTBOUND_ENABLED` vs `CLASS_OUTBOUND_ENABLED`). The only things safe to SHARE are pure, vendor-neutral helpers in `src/lib/appraisal/*` and `src/lib/rehab-budget.js` (which both already call). No shared transport, session, or write path.

### 4.1 INBOUND — land the report in the condition slots (I1/I2/I3)

Add ONE pure, vendor-neutral helper (both ingests call it; it contains no vendor logic):

```
// src/lib/appraisal/condition-docs.js  (new)
// Resolve/ensure the file's rtl_cond_appraisaldocs item, then file a returned document
// into a named slot on it (accumulating — never superseding a sibling), and re-open the
// condition's evidence so a vendor return re-drives sign-off.
async function fileReturnedAppraisalDoc(dbh, { appId, documentId, slot /* 'xml' | 'pdf' */ }) {
  // 1. ensure the item exists (desk.ensureAppraisalCondition(appId, 'rtl_cond_appraisaldocs'))
  // 2. UPDATE documents SET checklist_item_id=<item>, slot_label=<slot> WHERE id=documentId
  // 3. reopenConditionEvidence(dbh, item, 'received'); enqueueChecklistStatusPush(item)
}
```

**NAN — `src/amc/sync.js ingestDocuments`:** for each returned doc, after the `documents` INSERT, classify with the existing `looksXml`/`looksPdf` (already present, L111-123) and call `fileReturnedAppraisalDoc(dbh, {appId, documentId: docId, slot: xml?'xml':'pdf'})`. **Every** PDF gets `slot='pdf'` (not just the first — the "every slot keeps every document" rule at `staff.js` L15918-15929 lets a slot accumulate). Keep the existing `runAppraisalImport({ ..., xmlDocumentId, pdfDocumentId })` call — pass the xml-slot doc + any pdf-slot doc. Import already fires; no change to the import half.

**Class — `src/class/documents.js ingestForOrderLocked`:** identical treatment after its `documents` INSERT (it already has `looksXml`/`looksPdf`). This also removes the dependence on `class_orders.checklist_item_id` (which nothing populates).

**Why not just populate `order.checklist_item_id`?** Because (a) even then `slot_label` is unset, and (b) the order isn't reliably linked to `rtl_cond_appraisaldocs`. Resolving the condition from the ingest is robust for both. Optionally ALSO link the order at placement (§4.2) so the "what condition does this order fulfil" schema comment finally holds — but the ingest must not depend on it.

**Acceptance note (unchanged, correct):** returned docs stay `review_status='pending'` / `staff_only`. Per the document-acceptance rule a human still accepts them before the condition signs off and before they ship in TPR — the requirement is only that they LAND in the slot, which this delivers.

### 4.2 OUTBOUND — build Class parity (O1)

New, all in `src/class/*`, mirroring `amc/documents.js` but on the Class REST shape:
- `src/class/client.js`: `uploadAttachment(classOrderId, category, { fileData, contentType, attachmentType })` → `POST /{orderId}/attachments/{category}` multipart, gated by the client's outbound gate (same gate the order place uses).
- `src/class/documents.js`: add `listUploadable(dbh, appId, orderRowId)` and `uploadToOrder(dbh, order, {staffId, documentIds})` — read bytes from `documents`, map each file's tpr category → a Class `category` (`Contract & Assignment`→`SalesContract`, `Scope of Work`→`PlansAndSpecs`/`Miscellaneous`, else `Miscellaneous`) and `AttachmentType` from the extension (PDF/XML/Image/HyperLink), POST, record.
- New table `class_order_documents` (mirror `amc_order_documents`: `class_order_row`, `direction='outbound'`, `document_id`, `category`, `status`, `class_attachment_id`, dedupe on `(class_order_row, document_id)` for `outbound`). New `db/NNN_class_order_documents.sql`.
- Route `POST /api/class/files/:id/orders/:orderRowId/documents` in `routes/class.js`.

### 4.3 OUTBOUND — order-time auto-upload + "missing documentation" (O2)

**Gather set (per file):**
- Purchase contract → latest current doc on `rtl_p1_contract` / `purchase_contract`.
- Assignment → latest current doc on `rtl_p5_assign` **only when the file is an assignment deal** (`applications.is_assignment`); if not an assignment deal it is neither required nor flagged.
- SOW Excel → latest current SOW-category doc whose `content_type`/name is xlsx.
- SOW PDF → latest current SOW-category doc whose `content_type`/name is pdf.

A shared pure resolver (vendor-neutral) `src/lib/appraisal/order-docs.js gatherOrderUploadSet(dbh, appId)` returns `{ found:[{documentId, kind}], missing:['assignment','sow_pdf',...] }` (assignment omitted from `missing` when not an assignment deal).

**Where it fires:**
- NAN: at the end of `order-service.createOrder` after a successful ACK (L651+), call `documents.uploadToOrder(db, order, {documentIds: found})`. Keep `autoUploadForOrder` on the poll as the catch-up for anything that arrives later.
- Class: at the end of the place route (`routes/class.js` after `client.createOrder` succeeds, L207+) once `class_order_id` is written, call the new `class/documents.uploadToOrder`.

**The order STILL places when docs are missing; the screen flags "missing documentation."** Storage of the missing-docs state — neither `amc_orders` nor `class_orders` has a column for it:
- Add `missing_docs jsonb` (list of the absent kinds) + optionally `docs_status text` to **each** table (separate migrations, `db/NNN_amc_orders_missing_docs.sql` / `db/NNN_class_orders_missing_docs.sql`). Written by the order-time gather; cleared/updated as O3 fills them in.
- Surface: the order card reads it and shows an amber "Missing documentation: assignment letter, SOW PDF" chip (the `.dd-note.warn` pattern from `UNIFIED-UI-SPEC.md` §5). This is the natural home for the unified panel's active-order card.

### 4.4 OUTBOUND — auto-push on condition upload (O3)

**The hook already exists:** `src/routes/staff.js` L15918 `if (b.checklistItemId)` (and the borrower mirror in `routes/borrower.js`), which already runs `reopenConditionEvidence` + `enqueueChecklistStatusPush` after a condition upload. Add, best-effort, right there:

```
if (template_code IN ('rtl_p1_contract','purchase_contract','rtl_p5_assign','rtl_p3_sow1','rtl_p1_budget','scope_of_work','rtl_p1_plans')) {
  for each ACTIVE order on this file:
     amc_orders  -> amc/documents.uploadToOrder(db, order, {documentIds:[thisDoc]})
     class_orders-> class/documents.uploadToOrder(db, order, {documentIds:[thisDoc]})
     // and clear that kind off the order's missing_docs
}
```

Dispatch is vendor-separate (each table, each upload fn); "active order" = a non-terminal status per table. `uploadToOrder`'s existing dedupe (`already_uploaded`) means a doc already sent at order time is skipped. This makes the push happen at UPLOAD time (not only on the next poll) for BOTH vendors.

### 4.5 OUTBOUND — SOW-change revision button (O4) — separate per vendor

A single endpoint per vendor, button-triggered (never automatic). Shared pre-check, per-vendor send.

**Pre-check (shared, `src/lib/rehab-budget.js checkSowBudget`):**
- Load the current SOW payload; run `checkSowBudget(appId, payload)` (returns `{ok, message, required, total, target}`). If `!ok` (e.g. $200k budget vs $90k SOW), **write the alert on the SOW condition** (the same `[auto]` note mechanism `signOffGate` uses) and return `{ok:false, mismatch:true, message}` — **do NOT push to the appraiser.**
- Also require the SOW doc `review_status='accepted'` (`document-acceptance.isAccepted`). Only a matching + accepted SOW is pushed.

**Send (per vendor):**
- **NAN** (`src/amc/*`): (1) `documents.uploadToOrder` the new SOW PDF + Excel; (2) `comments.postComment` a message to the AMC; (3) **if the report is back** (`status ∈ product_available|completed`), also `revisions.postRevision({kind:'sow_update_report', body})` — add `'sow_update_report'` to `revisions.js KINDS` (L21), a DISTINCT kind from `sow_change`, meaning "update the SOW that is already in the report." (`sow_change` stays for the "order still in progress" case; the new kind is the "report already delivered → revise it" case.)
- **Class** (`src/class/*`): (1) the new `documents.uploadToOrder` (needs O1) with the SOW files as `PlansAndSpecs`; (2) `messages.note` the AMC; (3) **if `status='completed'`**, `messages.requestRevision` with a value-neutral reasonType from the closed list (`revision-reasons.js`) recorded as `kind='sow_update_report'` in `class_revisions`.

**Order-level alert offering the button:** when a NEW SOW doc supersedes one that was already sent to a vendor, the order card shows "SOW changed — send updated SOW." Derive it (no new column strictly needed) by comparing the current SOW doc's `created_at` against the newest `direction='outbound'` SOW row in `amc_order_documents` / `class_order_documents`; or store a small `sow_sent_document_id` on the order for a cheaper check. Set alongside the O2 order-time upload. This is per vendor (each order table).

### 4.6 OUTBOUND — upload-document button redesign (O5) — identical UX, per-vendor backend

Replace `AmcAppraisalPanel.Documents` (L724-764) and add the equivalent to the Class panel with ONE shared `<UploadDocMenu vendor=… order=…>` (fits the unified panel's Documents sub-surface, `UNIFIED-UI-SPEC.md` §5b). The menu:

| Menu item | Source | Backend |
|---|---|---|
| Upload scope of work | latest SOW Excel + PDF from SOW conditions | `gatherOrderUploadSet` resolver → `uploadToOrder(documentIds)` |
| Upload purchase contract | latest doc on `rtl_p1_contract` | same resolver, contract kind |
| Upload assignment | latest doc on `rtl_p5_assign` | same resolver; hide when not an assignment deal |
| Upload manual document | browse / drag-drop a fresh file | **new raw-bytes upload path**: for Class the API takes `FileData` directly; for NAN, stage the raw bytes at `/postdocuments` (today `uploadToOrder` only takes `documentIds`, so add a `{files:[{filename,contentType,bytes}]}` branch, or first save to `documents` then upload) |
| Upload any other document from the file | **ONLY this expands the full picker** — the current `listUploadable` checkbox list | `GET .../documents` (`listUploadable`) — NAN exists; Class needs the new `listUploadable` |

The vendor difference is confined to which upload fn/route the menu calls (`amc/documents` vs `class/documents`); the JSX shell is shared, matching the unification principle in `UNIFIED-UI-SPEC.md`.

---

## 5. What must stay vendor-separate (and what may be shared)

- **Separate (never merge):** transport/session (`amc/client.js`+`amc/session.js`+`amc/cdg.js` vs `class/client.js`), the outbound gate flags, the order tables + the new `class_order_documents`, the per-vendor upload/revision send code, the missing-docs columns (one per table), the SOW-sent markers. NAN pushes via CDG `/postdocuments`+`UploadDocument(Multi)`; Class via REST `POST /{orderId}/attachments/{category}` — do not fold one into the other.
- **Safe to share (pure, vendor-neutral, both already call the importer):** `src/lib/appraisal/condition-docs.js` (I1/I2/I3 slot filing), `src/lib/appraisal/order-docs.js` (O2/O5 gather resolver), `rehab-budget.checkSowBudget` (O4 gate), `document-acceptance.isAccepted`, `checklist-evidence.reopenConditionEvidence`, `tpr-export.categoryFor`. These carry no vendor transport.

---

## 6. Operational "is the setup correct with both vendors" checklist

- **NAN:** `AMC_ENABLED=1` (receive/poll) + `AMC_OUTBOUND_ENABLED=1` (upload) + valid CDG OAuth + DoLogin credentials; the poll worker is booted (`server.js` L1181). No webhook exists to register. Confirm an order reaches `product_available` so `ingestDocuments` fires.
- **Class:** `CLASS_ENABLED=1` + `CLASS_OUTBOUND_ENABLED=1` + valid credentials; callbacks registered (`POST /api/class/callback-setup/register`) OR rely on the poll backstop (`poller.js`); the webhook receiver is mounted before the JSON parser (`server.js` L59). Confirm `StatusChanged(Completed)`/`NewAttachments` reaches `callbacks.processEvent`.
- **Both:** the returned artifacts currently land in the Document Center **unattached** — after §4.1 they land in the `rtl_cond_appraisaldocs` xml/pdf slots and re-open that condition, which is the actual "correct setup" the owner is after.
