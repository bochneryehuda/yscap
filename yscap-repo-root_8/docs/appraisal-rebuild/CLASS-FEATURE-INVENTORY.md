# Class Valuation External Orders API v1 — Feature Inventory & Gap Analysis

**Source:** "Class Orders API Guide" rev 0.17, dated 08‑03‑2026 (the uploaded PDF — 82 pages, not 13; every page read).
**Cross‑referenced against:** our current integration in `src/class/*.js` (client, order‑build, order‑service, callbacks, poller, messages, documents, products, form‑select, revision‑reasons).
**Purpose:** feed a unified appraisal rebuild + a "Pay" button. This document maps EVERY endpoint the guide exposes, marks what we already use, and calls out what is worth adding.

> Base URLs (guide p.3): Production `https://api.classvaluation.com` · UAT `https://api.uat.classvaluation.com` · Test `https://api.test.classvaluation.com`. Identity host for tokens: `ids.<env>.classvaluation.com`.
> **Prefix note:** the guide prints bare paths (`/orders`, `/products`, `/callbacks`). Our live integration inserts an `/intg` prefix on every DATA route (`client.js` `apiBase()`), because the bare paths 404 against the running API. The token call is the exception — it posts to the identity host at `/connect/token` with no prefix. Throughout this document paths are quoted as the guide prints them; add `/intg` mentally for the data host.

---

## 0. The three answers that matter most (read this first)

### PAYMENT — can we charge a card / ACH through the Class v1 API? **NO.**
Class v1 has **no merchant/gateway endpoint** that charges a credit card or debits a bank account. There is no way to take a card number in PILOT and have Class run the charge. What exists instead:
- **`POST /orders/{orderId}/add-creditcard-payment`** — this only **RECORDS a completed card payment**, it does not process one. Its only fields are `nameCardHolder`, `amount`, `cardNumber` (explicitly *"Last 4 digits of the credit card number"*), `authorizationCode`. No full PAN, no CVV, no expiry, no ACH. You would charge the card on **our own processor first**, then post the last‑4 + auth code so Class marks the order paid.
- **`paymentDetails.paymentMethod`** at order creation (`POST /orders`): `Invoice` | `PaymentLink` | `Prepay`. `PaymentLink` (with `paymentDetails.recipientEmail`) makes **Class email the borrower a hosted payment page** — this is the closest thing to a "unified Pay" flow that Class actually operates, but the payment happens on Class's page, not ours.
- **`GET /orders/{orderId}/payment-details`** reads the money picture: `clientFee`, `additionalFees[]`, `totalAmount`, `paidAmount`, `outstandingBalance`.
- **`OrderPaid`** webhook fires when an order is paid; **`ClientFeeChanged`** and **`PaymentLinkSentToBorrower`** webhooks track fee/link events.

**Implication for the unified "Pay" button:** Class orders are normally **billed to the account (Invoice)** or paid by the borrower through Class's **hosted PaymentLink**. For a PILOT "Pay" button you have three realistic options, none of which is "PILOT charges the card and Class processes it": (a) read the balance with `payment-details` and reconcile against our invoice; (b) set `paymentMethod=PaymentLink` at order time and let Class collect from the borrower; (c) charge on **our** gateway and record via `add-creditcard-payment`. We use **none** of these today.

### MESSAGES / portal‑comment visibility — **YES, we can pull every note, but with a thin author model.**
`GET /orders/{orderId}/notes` returns **all notes on the order regardless of how they were created** — including ones our team typed directly in the Class web portal. The only author signal is **`direction`**: `ToClient` (Class Valuation created it — their staff / the appraiser / the AMC) or `FromClient` (our organisation created it, whether via API or portal). Per‑note fields are exactly: **`id`, `direction`, `content`, `created` (DateTime UTC)**. There is **no author name, no role, no internal/external flag, and no attachments array on a note.** New `ToClient` notes also arrive by the **`NewNotes`** webhook (`data[{noteId, content}]`). We already poll (`messages.syncNotes`) *and* receive the webhook (`callbacks.js`), deduped on the Class note id.

### WEBHOOKS — 15 events, HTTP‑Basic or ApiToken, registered per organisation; keep polling as a fallback.
Full event list and payloads in §5. We register callbacks and process them, and we **also poll** (`poller.js`, owner‑directed) because a lost/unregistered webhook would otherwise strand a file.

---

## 1. Complete endpoint / feature inventory

### 1.1 Authentication (identity host `ids.<env>.classvaluation.com`)

| Operation | Method + Path | Purpose | Key request | Key response |
|---|---|---|---|---|
| **Password grant** | `POST /connect/token` (form‑urlencoded) | The token every API call needs | `grant_type=password`, `client_id`, `client_secret`, `username`, `password` (all Required) | `access_token`, `expires_in` (3600s), `token_type=Bearer`, `scope` (`offline_access openid ordersexternal.api`) |
| **SSO / user‑identity grant** | `POST /connect/token` | Get an identity token for an existing user, OR create a new user and get its token | `grant_type=cv_user_identity`, `client_id`, `client_secret`, `username`; to create: add `roles` (comma list) | `id_token`, `expires_in` (300s), `token_type` |
| **SSO redirect** | `GET /external/auth?token={id-token}` (or `Authorization: Bearer {id-token}`) | Single‑sign‑on the current user straight into a Class portal page; `&loc=desktop/order/view/{id}/review` deep‑links to a specific order | id token as query or bearer | redirect into portal |
| Expired‑token shape | — | Their 401 body | — | `{success:false, code:"401.1", error:"Invalid Token"}` |

### 1.2 Orders (core lifecycle)

| Operation | Method + Path | Purpose | Key request | Key response |
|---|---|---|---|---|
| **Create order (UAD 2.6)** | `POST /orders` | Place an appraisal order | query `OrgId`,`LenderOrgId`; body `productId`, `referenceNumber`, `property{street,line2,city,state,zip,county,taxId}`, `contacts[]`, `lender{clientName,clientAddress,contactInformation}`, `loanInfo{loanNumber,loanAmount,loanType,fhaNumber,purchaseAmount}`, `dueDate`, `purpose`, `occupancy`, `propertyTypeEnum`, `instructions`, `caseFileId`, `lpaKey`, `freddieMacId`, `amcName`, `contractPrice`, `dateOfContract`, `assignedVendors[]`, `servicesConfiguration{}`, `notificationList[]`, `scanPropertyId`, `scanProjectId`, `rushOrder`, `appraiserQuotedFee`, `estimatedClosingDate`, `borrowerIntentToProceedDate`, `orderBy`, `submittedBy`, `orderedFor{}`, `notesToVendor`, `notesToManager`, `source`(Api/ClientPortal/MeridianLink), `paymentDetails{paymentMethod,recipientEmail}` | `success`, `orderId`, `transactionId`, `message` |
| **Create order (UAD 3.6)** | `POST /v2/orders` (or `POST /orders` + `api-version=2.0`) | UAD 3.6 order; adds `occupancy`(enum PrimaryResidence/SecondHome/Investment/Other), `propertyType`(enum), `duReferenceNumber` (replaces caseFileId), `lpaKeyReferenceIdentifier` (replaces lpaKey), `attachmentType`, `projectLegalStructureType`, `constructionMethodType`, `pudIndicator`, `neighborhoodHousingType`, `landOwnedInCommonIndicator`, `accessoryDwellingUnitTotalCount`, `livingUnitExcludingADUCount` | as v1 body but 3.6 field names/enums | `success`, `orderId`, `transactionId`, `message` |
| **List orders** | `GET /orders` | Search orders | query `ReferenceNumber[]`, `ProductId[]`, `StartCreated`, `EndCreated`, `CompletedSince`, `offset`, `limit` | `data[]` + `totalCount`, `offset`, `limit`; each row: `id`, `productId`, `organizationId`, `referenceNumber`, `property{}`, `statusInfo{status,updated}`, `desktopId`, `invisionURL`, `created`, `assignedVendors[]`, `propertyType`, `servicesConfiguration{}`, `notificationList[]` |
| **Get order by id** | `GET /orders/{orderId}` (v1) / `GET /v2/orders/{orderId}` (v2) | Full order detail | path `orderId` | `id`, `caseFileId`, `assignedVendors[]`, `lpaKey`, `freddieMacId`, `productId`, `referenceNumber`, `property{}`, `contacts[]`, `loanInfo{}`, `statusInfo{status,updated}`, `customFields[{key,value,modifiedDate}]`, `instructions`, `purpose`, `occupancy`, `amcName`, `contractPrice`, `dateOfContract`, `desktopId`, `invisionURL`, `propertyType`, `lender{}`, **`appointmentDate`**, `dueDate`, **`paidDate`**, `created`, `servicesConfiguration{}`, `paymentDetails{paymentMethod,recipientEmail}`, `notesToVendor`, `notesToManager`, **`trackingInfo.acuityOrderId`**, `notificationList[]`; v2 also `isUAD36Order`, `rentalComparableRequested`, and the 3.6 property/project fields |
| **Validate order** | `POST /orders/{orderId}/validate` | Confirm the order exists in Class's repository | path `orderId` | `success` (found?), `message` |
| **Update DU case file id** | `PUT /orders/{orderId}/caseFileId` | Set Fannie DU case number post‑order | body `value` | `success`, `message` |
| **Update LPA key** | `PUT /orders/{orderId}/lpaKey` | Set Freddie LPA key post‑order | body `value` | `success`, `message` |
| **Assign a vendor** | `PUT /orders/{orderId}/assign-vendor` | Assign a specific appraiser/scanner (creates the user if new) | body `userId`/`userEmail`/`firstName`/`lastName`, `assignment`(SCANNER/APPRAISER), `phone`,`address`,`city`,`state`,`zipCode`, `dataCollectorType`, `assignmentDescription`, `companyName` | `success`, `message` |
| **Add a license** | `POST /orders/{orderId}/licenses/{license_name}` | Turn on a managed service on the order | path `license_name` ∈ Managed3DScan, ManagedVirtualInspection, ManagedPDAPISubmission, ManageDbACESubmission | `success`, `message` |
| **Place on hold** | `POST /orders/{orderId}/request-on-hold` | Pause an order | body `comment` (optional) | `success`, `message` |
| **Take off hold** | `POST /orders/{orderId}/request-off-hold` | Resume an order | body `comment` (optional) | `success`, `message` |
| **Propose appointment date** | `POST /orders/{orderId}/appointment-date` | Propose an inspection appointment/completion date | body `appointmentData[{appointmentDate, completionDate}]` | `success`, `message` |

### 1.3 Notes / comments

| Operation | Method + Path | Purpose | Key request | Key response |
|---|---|---|---|---|
| **List notes** | `GET /orders/{orderId}/notes` | Pull the full comment thread (both directions) | query `direction` (ToClient/FromClient, optional) | `data[{id, direction, content, created}]` |
| **Create note** | `POST /orders/{orderId}/notes` | Post a comment to the order | body `content` | `success`, `noteId`, `orderId`, `transactionId`, `Message` |

### 1.4 Revisions / cancellation

| Operation | Method + Path | Purpose | Key request | Key response |
|---|---|---|---|---|
| **Request revision** | `POST /orders/{orderId}/request-revision` | Ask for a fix to a completed report (also the ROV mechanism — no separate ROV endpoint) | body `reasons[{reasonType, reason}]`; `reasonType` from a ~90‑code closed list (pp.40‑42) | `success`, `message`, `orderId`, `transactionId` |
| **Request GSE data revision** | `POST /orders/{orderId}/request-gse-revision` | Request a fix to a specific GSE data field by path | body `gse`(None/FNMA/FREDDIE), `generalDescription`, `revisions[{name, reason, path}]` | `success`, `orderId`, `transactionId`, `message` |
| **Request cancellation** | `POST /orders/{orderId}/request-cancel` | Cancel the order | body `reasons[{reasonType, reason}]` (same closed list) | `success`, `message` |

### 1.5 Attachments / documents

| Operation | Method + Path | Purpose | Key request | Key response |
|---|---|---|---|---|
| **List attachments** | `GET /{orderId}/attachments` | All docs on an order | query `attachmentId[]`, `category[]`, `direction`(ToClient/FromClient), `urlType`(SignedUrl/UnsignedUrl) | array `{success,message,data[{orderId, attachmentId, referenceNumber, name, contentType, category, direction, url, created}]}` |
| **Get attachment metadata** | `GET /{orderId}/attachments/{attachmentId}` | One doc's metadata + URL | query `urlType` | same fields as a list row |
| **Download the file** | `GET /{orderId}/attachments/{attachmentId}/file` | The actual bytes | query `includeGPS`(bool, default false) | the file |
| **Upload a file to Class** | `POST /{orderId}/attachments/{category}` | Send a doc TO the appraiser/order | path `category`; body `FileData`(file), `AttachmentType`(HyperLink/PDF/XML/Image) | `success`, `message` |
| **Photo metadata** | `GET /{orderId}/attachments/photos-metadata` | Geolocated inspection photos | query `useMetadata`(FNMA/FREDDIE), `offset`, `limit`, `urlType` | `totalCount`, `data[{id, downloadUrl, gse, metadata.phototype, metadata.description, phototags[], geolocalization.latitude/longitude, timespan, photoNotAvailable, AlwaysRequired, jsonPath}]` |
| **Valid attachment types** | `GET /attachments/types` | Which file types each category accepts | — | `[{category, fileTypes[]}]` |

**Attachment `category` values (both directions):** `InvisionLink, PDCReport, PDRReport, PFRReport, QRRReport, AppraisalXml, Appraisal, Invoice, AppraiserLicense, ComplianceCertificate, SalesContract, PurchaseAgreement, Miscellaneous, Other, FannieMaeSsr, FreddieMacSsr, Eadssr, PDAPIData, FreddieData, PCRReport, PropertyPhoto, AltValReport, ConditionReport, PDAReport, ClientEngagementLetter, PlansAndSpecs, Title, ROVDocument, BorrowerIntentToProceed, ARAReport, APPZIP`.

> **Doc inconsistency to know about:** the completion walkthrough (p.7) writes `GET /orders/{orderId}/attachments`; the Attachments reference (p.14) writes `GET /{orderId}/attachments` (no `/orders`). Our `client.js` follows the newer `/orders/...` walkthrough and documents this in a comment. If the first live pull 404s, this — not the credential — is the thing to try.

### 1.6 Payment

| Operation | Method + Path | Purpose | Key request | Key response |
|---|---|---|---|---|
| **Add credit‑card payment (RECORD only)** | `POST /orders/{orderId}/add-creditcard-payment` | Record a card payment already taken elsewhere | body `nameCardHolder`, `amount`(float), `cardNumber`("Last 4 digits"), `authorizationCode` | `success`, `message` |
| **Get payment details** | `GET /orders/{orderId}/payment-details` | Fee + balance | path `orderId` | `orderId`, `referenceNumber`, `clientFee`, `additionalFees[{description,amount,date}]`, `totalAmount`, `paidAmount`, `outstandingBalance` |
| **(Order‑create)** payment method | `POST /orders` body | Choose how it's paid | `paymentDetails.paymentMethod` ∈ Invoice / PaymentLink / Prepay; `paymentDetails.recipientEmail` (required when PaymentLink) | — |

### 1.7 AVM (Automated Valuation Model)

| Operation | Method + Path | Purpose | Key request | Key response |
|---|---|---|---|---|
| **Create AVM order** | `POST /avm` | Property valuation without a full appraisal | body `organizationId`, `createdBy{}`, `productName`(ProcisionPremier / ProcisionPremierLite / ProcisionPower / ProcisionPowerLite / ProcisionDirect), `searchType`(ADDRESS/FullAddress/APN/OWNER/PROPERTY), `fullAddress`, `addressDetail{}`, `apnDetail{}`, `ownerDetail{}`, `propertyId`, `referenceId` | `success`, `message`, `key`(AVM order id) |
| **AVM status** | `GET /avm/status?orderId=` | Current status | query `orderId` | plain string |
| **AVM response** | `GET /avm/response/{orderId}` | The valuation result | path `orderId` | `success`, `message`, `key{orderId, status, statusMessage, successed, data{statusDescription, maxResultsCount, reports[{propertyId, reportName, reportStatus, referenceId, orderItemId, data}], litePropertyList}}` |

### 1.8 GSE results

| Operation | Method + Path | Purpose | Key request | Key response |
|---|---|---|---|---|
| **Get GSE info** | `GET /orders/{orderId}/gseResults` | UCDP/SSR validation + completeness | path `orderId` | `data[{gseName, gseId[], resultMessage, validations[{name,path,reason}], completeness[{code,description}]}]` |
| **Save GSE submission** | `POST /orders/{orderId}/gseResults` | Record a GSE submission result | body `gseName`, `gseId[]`, `resultMessage`, `validations[]`, `completeness[]` | `success`, `message` |

### 1.9 Products (forms)

| Operation | Method + Path | Purpose | Key request | Key response |
|---|---|---|---|---|
| **List products** | `GET /products` | The report catalogue (paginated) | query `title`, `offset`, `limit` | `success`, `message`, `products[{id, title, active, isLicensingEnabled, created, alternativeName}]` |
| **Get product by id** | `GET /products/{productId}` | One product + `requiresLenderAddress` | path `productId` | `success`, `message`, `detail{id, title, active, requiresLenderAddress}` |
| **List products (v2)** | `GET /v2/products` | UAD 3.6 catalogue | query `LenderOrganizationId`, `Title`, `Offset`, `Limit` | same shape as v1 |
| **Get product by id (v2)** | `GET /v2/products/{productId}` | same shape as v1 | — | — |

### 1.10 Organizations

| Operation | Method + Path | Purpose | Key request | Key response |
|---|---|---|---|---|
| **Available organizations** | `GET /Organizations` | Orgs related to ours | — | `success`, `message`, `data[{organizationName, organizationId, relationType}]` |
| **Broker organizations** | `GET /organizations/brokers` | Orgs where **we** are the lender | — | `data[{organizationName, organizationId, relationType(Default/Lender)}]` |

### 1.11 Callbacks (webhooks)

| Operation | Method + Path | Purpose | Key request | Key response |
|---|---|---|---|---|
| **List callbacks** | `GET /callbacks` | Registered webhooks | — | `data[{id, eventName, callbackUrl, userName, password, authMode(BasicAuth/ApiToken), apiToken, tokenHeaderName}]` |
| **Register one** | `POST /callbacks` | Subscribe to one event | body `eventName`, `callbackUrl`, `userName`, `password`, `authMode`, `apiToken`, `tokenHeaderName` | `success`, `id`, `message` |
| **Register all** | `POST /callbacks/addAll` | Subscribe to every event at one URL | body `callbackUrl`, `userName`, `password`, `apiToken`, `tokenHeaderName`, `authMode` | `success`, `callbacksAdded`, `callbacksExisting[]`, `callbacksCouldNotBeAdded[]`, `message` |
| **Delete** | `DELETE /callbacks?id=` | Remove a webhook | query `id` | `success`, `message` |

### 1.12 Users

| Operation | Method + Path | Purpose | Key request | Key response |
|---|---|---|---|---|
| **List roles** | `GET /users/roles` | Available roles | — | `data[{id, name}]` |
| **Create user** | `POST /users` | Provision a user (for SSO) | body `userName`, `email`, `firstName`, `lastName`, `phone`, `address`, `city`, `state`, `zipCode` | `userId`, `success`, `error` |
| **List users** | `GET /users` | Find users | query `UserName`, `Email`, `Offset`, `Limit` | `data[{id, userName, firstName, lastName, email, created, phone, address, city, state, zipCode}]` |
| **Get user** | `GET /users/{id}` | One user + roles | path `id` | `id, userName, firstName, lastName, email, roles[], created, phone, address, city, state, zipCode` |
| **Delete user** | `DELETE /users/{id}` | Remove a user | path `id` | `success`, `error` |
| **Update roles** | `PUT /users/{id}/roles` | Overwrite a user's roles | body `roleIds[]` | `success`, `error` |

---

## 2. GAP MATRIX

Legend for "Do we use it?": file name = wired; **NO** = not built at all; **client‑only** = wrapped in `client.js` but no service/route calls it.

| Feature | Class endpoint | Do we use it? | Value for RTL | Priority |
|---|---|---|---|---|
| Password‑grant token | `POST /connect/token` (password) | `client.js` `getAccessToken` | Required for everything | done |
| SSO / user‑identity token | `POST /connect/token` (cv_user_identity) | **NO** | Seamless staff deep‑link into Class portal for an order (better than the bare `invisionURL`) | P2 |
| SSO portal redirect | `GET /external/auth` | **NO** | Same as above | P2 |
| Create order 2.6 | `POST /orders` | `client.createOrder` + `order-build.js` | Core | done |
| Create order 3.6 | `POST /v2/orders` | `client.createOrder` (path from builder) | Core (industry shift to 3.6) | done |
| List orders | `GET /orders` | `client.orders` (version‑specific) | Reconcile / search | done |
| Get order | `GET /orders/{id}` (+v2) | `client.order` + `callbacks.refreshOrder` + `poller` | Status/detail refresh | done |
| **Validate order** | `POST /orders/{id}/validate` | **NO** | Preflight that an order landed at Class | P2 |
| Update caseFileId | `PUT /orders/{id}/caseFileId` | **NO** | Post‑order DU case number (rare for RTL) | P2 |
| Update lpaKey | `PUT /orders/{id}/lpaKey` | **NO** | Post‑order Freddie key (rare for RTL) | P2 |
| Assign a vendor | `PUT /orders/{id}/assign-vendor` | **NO** | Assign a specific appraiser (we let Class manage) | P2 |
| Add a license | `POST /orders/{id}/licenses/{name}` | **NO** | Turn on 3D scan / virtual inspection / PDAPI post‑order | P2 |
| **Place on hold** | `POST /orders/{id}/request-on-hold` | **NO** | Pause an order (borrower not ready, ITP pending) | **P1** |
| **Take off hold** | `POST /orders/{id}/request-off-hold` | **NO** | Resume | **P1** |
| **Propose appointment date** | `POST /orders/{id}/appointment-date` | **NO** | Feed a borrower‑confirmed inspection date to Class | P1 |
| List notes | `GET /orders/{id}/notes` | `messages.syncNotes` | Comment thread | done |
| Create note | `POST /orders/{id}/notes` | `messages.note` | Comment thread | done |
| Request revision | `POST /orders/{id}/request-revision` | `messages.requestRevision` | Revisions + ROV | done |
| **Request GSE data revision** | `POST /orders/{id}/request-gse-revision` | **client‑only** (`client.requestGseRevision`) | Path‑targeted GSE field fix; wired but no service/route uses it | P2 |
| Request cancel | `POST /orders/{id}/request-cancel` | `messages.requestCancel` | Cancellation | done |
| List attachments | `GET /{id}/attachments` | `client.attachments` + `documents.js` | Pull the report | done |
| Get attachment meta | `GET /{id}/attachments/{aid}` | `client.attachment` / `attachmentBytes` | Pull the report | done |
| Download file | `GET /{id}/attachments/{aid}/file` | **NO** (we read bytes off the metadata endpoint) | Direct bytes + `includeGPS`; minor | P2 |
| **Upload a file to Class** | `POST /{id}/attachments/{category}` | **NO** | Send docs TO the appraiser (engagement letter, contract, plans/specs, ROV doc) | **P1** |
| **Photo metadata** | `GET /{id}/attachments/photos-metadata` | **NO** | Geolocated inspection photos → property/comp research DB | P1 |
| Valid attachment types | `GET /attachments/types` | **NO** | Validate an upload before sending | P2 |
| **Add credit‑card payment (record)** | `POST /orders/{id}/add-creditcard-payment` | **NO** | Record a card charge we took on our own gateway | **P1** (payment) |
| **Get payment details** | `GET /orders/{id}/payment-details` | **NO** | Fee/balance for the "Pay" button + invoice reconciliation | **P0** (payment) |
| Payment method at order time | `paymentDetails.paymentMethod` on `POST /orders` | **NO** (builder omits it) | Invoice / PaymentLink / Prepay — the only in‑API way to trigger borrower collection | **P0** (payment) |
| Create AVM order | `POST /avm` | **NO** | Instant automated value as a cheap pre‑appraisal check | P1 |
| AVM status | `GET /avm/status` | **NO** | AVM polling | P1 |
| AVM response | `GET /avm/response/{id}` | **NO** | AVM result | P1 |
| Get GSE info | `GET /orders/{id}/gseResults` | **NO** | SSR/UCDP validation + completeness codes | P2 |
| Save GSE submission | `POST /orders/{id}/gseResults` | **NO** | Record a GSE submission (rare for RTL) | P2 |
| List products | `GET /products` | `client.products` + `products.js fetchAll` | Product catalogue | done |
| Get product by id | `GET /products/{id}` | **NO** | `requiresLenderAddress` flag | P2 |
| List/get products v2 | `GET /v2/products[/{id}]` | **NO** (v1 list only) | Same shape; v2 has `LenderOrganizationId` filter | P2 |
| Available organizations | `GET /Organizations` | **NO** | Org discovery | P2 |
| **Broker organizations** | `GET /organizations/brokers` | **NO** | Broker orgs where we are the lender → ties into the TPO portal build | **P1** |
| List callbacks | `GET /callbacks` | `client.listCallbacks` | Webhook admin | done |
| Register one callback | `POST /callbacks` | `client.registerCallback` | Webhook setup | done |
| Register all callbacks | `POST /callbacks/addAll` | `client.registerAllCallbacks` | Webhook setup | done |
| Delete callback | `DELETE /callbacks` | `client.deleteCallback` | Webhook admin | done |
| User roles | `GET /users/roles` | **NO** | SSO provisioning | P2 |
| Create/list/get/delete user | `POST/GET/DELETE /users[...]` | **NO** | SSO provisioning | P2 |
| Update user roles | `PUT /users/{id}/roles` | **NO** | SSO provisioning | P2 |

### 2.1 Order‑create fields we could send but the builder omits
`order-build.js` builds a solid but partial body. Available‑and‑unused fields worth wiring in the rebuild:
- **`paymentDetails.paymentMethod` / `recipientEmail`** — the payment entry point (P0, see §4).
- **`rushOrder`** (bool) — flag a rush.
- **`notesToVendor` / `notesToManager`** — separate instruction channels beyond `instructions`.
- **`estimatedClosingDate`**, **`borrowerIntentToProceedDate`** (ITP — compliance‑relevant).
- **`appraiserQuotedFee`**, **`orderBy`**, **`submittedBy`**, **`orderedFor{}`**.
- **`assignedVendors[]`** + **`servicesConfiguration{fullManaged, licensing[], useLicensing}`** — managed services / specific vendor at order time.
- **`scanPropertyId` / `scanProjectId`** — for 3D scan orders.
- **`source`** — set `Api` (audit clarity).

---

## 3. Payment — full detail (owner's critical question)

**There is NO API card/ACH charge in Class v1.** Summary of every payment surface:

1. **Order‑time method (`POST /orders`, `paymentDetails`)** — `paymentMethod` ∈ `Invoice` (billed to the account), `PaymentLink` (Class emails the borrower a **hosted** payment page; `recipientEmail` required; the `PaymentLinkSentToBorrower` webhook confirms it went), `Prepay`. **This is the only in‑API way to make a charge happen**, and the charge is collected on Class's page, not ours.
2. **`GET /orders/{orderId}/payment-details`** — the money picture: `clientFee`, `additionalFees[{description,amount,date}]`, `totalAmount`, `paidAmount`, `outstandingBalance`. This is what a "Pay" button reads.
3. **`POST /orders/{orderId}/add-creditcard-payment`** — **records** a completed card payment (`nameCardHolder`, `amount`, `cardNumber`=last 4, `authorizationCode`). No PAN/CVV/expiry, no ACH → **cannot process a charge; only marks the order paid after we charged on our own processor.**
4. **Webhooks** — `OrderPaid` (paid), `ClientFeeChanged` (`OldAmountValue`→`NewAmountValue`), `PaymentLinkSentToBorrower`.

**Recommended pattern for a unified PILOT "Pay" button:** read balance with `payment-details`; for borrower‑paid orders set `paymentMethod=PaymentLink` at order time (Class collects); for lender‑paid orders keep `Invoice` and reconcile against `paidAmount`/`OrderPaid`; if we ever want PILOT to own the charge, run it on our own gateway and post `add-creditcard-payment`. **We currently wire none of this** — `payment-details`, `paymentDetails.*`, and `add-creditcard-payment` are all missing from the integration.

---

## 4. Messages / portal‑comment visibility — full detail

- **Retrieval covers everything:** `GET /orders/{orderId}/notes` returns all notes on the order, whatever channel created them, so notes our team typed **directly in the Class portal** come back too (as `direction=FromClient`), and Class/appraiser notes come back as `direction=ToClient`. Optional `direction` query narrows it.
- **Fields per note:** `id`, `direction`, `content`, `created` (UTC DateTime). **That is the whole shape.** There is **no author name, no role, no attachments, no internal/external visibility flag** on a note — `direction` is the only author signal.
- **How we get them:** BOTH — the `NewNotes` webhook pushes new `ToClient` notes (`data[{noteId, content}]`), and `messages.syncNotes` polls `GET /notes`. Both dedupe on the Class note id (`class_notes.class_note_id`, partial unique index). Our poller (`poller.js`) walks open orders as a webhook fallback.
- **Limitations to design around:** because there's no author/role, we can't attribute a `ToClient` note to a specific appraiser vs. Class ops from the note alone. If author identity matters, the only richer signal is correlating with `AssignedToVendor` (which carries `userEmail`/`firstName`/`lastName`) or the order's `assignedVendors[]`.

---

## 5. Status model + webhooks — full detail

### 5.1 Order statuses
- **v1 (`GET /orders`, `statusInfo.status`):** `Active`, `OnHold`, `Resume`, `Completed`, `Cancelled`.
- **v2 (`GET /v2/orders`, `statusInfo.status`) is richer:** `Active`, `OnHold`, `Resume`, **`UnderRevision`**, `Completed`, `Cancelled`, **`AwaitingCorrections`**, **`AwaitingCorrectionReview`** — i.e. UAD 3.6 exposes explicit revision/correction states that v1 does not. (`Resume` is an event, not a resting state — a resumed order is Active again; our `callbacks.STATUS` maps both `active`/`resume`→`in_process`.)
- **Common progression narrative (p.5):** `Active` (accepted) → `AssignedToVendor` (appraiser assigned) → `SetAppointment` (inspection scheduled) → `Completed` (report ready); `OnHold`/`Resume` interleave.

### 5.2 Webhook mechanism
- **Register** via `POST /callbacks` (one event) or `POST /callbacks/addAll` (all events at one URL). Registration is **per organisation**, not per order or per version — one registration serves both UAD versions, and the event payload does **not** say which version the order was placed on (we store `class_orders.api_version` for that reason).
- **Auth:** HTTP **Basic** (`userName`/`password`) **or** **ApiToken** (`apiToken` + `tokenHeaderName`) — `authMode` ∈ `BasicAuth`/`ApiToken`.
- **Delivery:** POST to your callback URL; **return HTTP 200 within 30 seconds** (p.6). Our receiver is deliberately dumb (authenticate, store, 200) and does the real work off the request path.
- **Common envelope on every event:** `orderId`, `referenceNumber`, `eventName`, `sent` (UTC), `created` (UTC), `data{}`.
- **Polling fallback:** yes, keep it. Owner‑directed and already built (`poller.js` `pollOpenOrdersOnce` — pulls notes + report + status for open orders; every pull is idempotent so it can run alongside webhooks).

### 5.3 The 15 events and their `data` payloads

| Event | Fires when | `data` fields |
|---|---|---|
| **StatusChanged** | Order status changes | `data.StatusName`(Active/OnHold/Resume/Completed/Cancelled), `data.Reason`, `data.InvisionUrl` |
| **AssignedToVendor** | Appraiser/scanner assigned | `data.userEmail`, `data.firstName`, `data.lastName` |
| **SetAppointment** | Inspection scheduled | `data.dueDate`, `data.appointmentDate` |
| **InspectionCompleted** | Inspection finished | `data.InspectedDate`, `data.InspectedLocalDate`, `data.InspectedOrderLocalDate` |
| **NewAttachments** | Class adds a doc/link | `data.orderId`, `data.name` (e.g. PDR.pdf), `data.contentType` |
| **NewNotes** | Class adds a note | `data[{noteId, content}]` |
| **ScannerEvents** | 3D scan progress | `data.scannerEvent` ∈ ScanStarted, ScanFinalized, ScanDataSubmissionStarted, ScanDataSubmissionFinalized, ScanDataProcessFinished, ScanDataSubmissionFinishedDelayed, ScanDataProcessFinishedDelayed; `data.reason` |
| **DesktopEvents** | Order changed in the desktop system | `data.desktopId`, `data.eventName`(Created/Approved/Rejected), `data.created`, `data.invisionUrl`, `gseSubmission[]` |
| **OrderPaid** | Order paid | (envelope only) |
| **CustomFieldsSet** | Extra order data delivered | `data[{Key, Value}]`, `data.ModifiedDate` |
| **ClientFeeChanged** | Client fee changed | `data.OldAmountValue`, `data.NewAmountValue` |
| **PaymentLinkSentToBorrower** | Borrower payment link sent | (envelope only) |
| **ClientDueDateChanged** | Client due date changed | `data.DueDate` |
| **AvmReport** | Report‑formatted AVM result ready | `data.statusDescription`, `data.maxResultsCount`, `data.reports[]`, `data.litePropertyList[]` |
| **AvmData** | JSON‑formatted AVM result ready | same as AvmReport |

**What we act on today (`callbacks.changesFor`):** StatusChanged, SetAppointment, ClientDueDateChanged, InspectionCompleted, AssignedToVendor, OrderPaid, ClientFeeChanged; plus NewNotes → `class_notes` and NewAttachments → `class_attachments`/auto‑download. **Stored but not acted on:** ScannerEvents, DesktopEvents, CustomFieldsSet, PaymentLinkSentToBorrower, AvmReport, AvmData (fine for RTL until 3D scan / AVM / custom fields are used).

> **Doc inconsistency to know about:** the completion walkthrough (p.7) names an event `"order-completed"`, but the actual registered event list uses **`StatusChanged` with `StatusName=Completed`**. Build against `StatusChanged` (which we do).

---

## 6. Revisions — full detail

- **General revision:** `POST /orders/{orderId}/request-revision`, body `reasons[{reasonType, reason}]`. `reasonType` comes from a **closed ~90‑code list** (pp.40‑42), shared by revision AND cancel. We transcribe it verbatim in `revision-reasons.js`.
- **ROV is not a separate endpoint** — a reconsideration of value is a revision whose `reasonType` is one of the value‑related codes (e.g. `ReconciliationConcernsValueRelatedConcerns`, `ReconciliationConcernsAddAdditionalClosedSaleListing`, `ReconciliationConcernsAlternativeSales`, `AdjustmentsLackOfAdjustments`). We model this with a "ROV lens" over the same list and label a value‑reason revision as an ROV.
- **GSE data revision (separate, path‑targeted):** `POST /orders/{orderId}/request-gse-revision`, body `gse`(None/FNMA/FREDDIE), `generalDescription`, `revisions[{name, reason, path}]` — used to fix a specific GSE field by JSON `path`. **Wired in `client.js` but no service/route calls it** — a genuine gap.
- **Cancellation** uses the same reason vocabulary: `POST /orders/{orderId}/request-cancel`, `reasons[]`.
- **Gate:** Class only accepts a revision/ROV once the report is **Completed** (their error: *"The order … must be in Completed status"*) — we enforce this in `messages.requestRevision`. A cancel does **not** require Completed.
- **Cancellation‑shaped reason codes** (the tail of the list): `AssignedToAnotherProvider`, `BorrowerNotAvailable`, `BorrowerWithdrewLoanApplication`, `ClientRequestedCancellation`, `SubjectPropertyRepairsAreIncomplete`, `UnknownReasonForCancellation`, `UpgradedToAnotherService`.

---

## 7. Valuable things we're not using yet (ranked)

**P0 (payment — the owner's priority):**
1. **`GET /orders/{orderId}/payment-details`** — fee + `outstandingBalance` + `paidAmount`; the read behind any "Pay"/fee surface.
2. **`paymentDetails.paymentMethod` on order create** — the only in‑API way to trigger borrower collection (`PaymentLink`) or set billing (`Invoice`).

**P1:**
3. **`POST /{orderId}/attachments/{category}`** — send documents TO the appraiser (engagement letter, sales contract, plans/specs, ROV support doc). Today we only download.
4. **`POST /orders/{id}/request-on-hold` / `request-off-hold`** — pause/resume an order (borrower not ready, ITP pending).
5. **`POST /orders/{id}/add-creditcard-payment`** — record a card charge we take on our own gateway.
6. **`GET /organizations/brokers`** — broker orgs where we are the lender; direct input to the TPO portal build.
7. **`GET /{orderId}/attachments/photos-metadata`** — geolocated inspection photos → feeds the property/comp research database.
8. **AVM (`POST /avm`, `/avm/status`, `/avm/response`)** — instant automated value as a cheap pre‑appraisal sanity check.
9. **`POST /orders/{id}/appointment-date`** — push a borrower‑confirmed inspection date to Class.

**P2:**
10. **SSO (`cv_user_identity` + `GET /external/auth`)** — seamless staff deep‑link into the Class portal for an order (richer than the bare `invisionURL`).
11. **`POST /orders/{id}/validate`** — preflight that an order actually landed at Class.
12. **`POST /orders/{id}/request-gse-revision`** — wire the already‑built client method to a service/route.
13. **`GET /orders/{id}/gseResults`** — SSR/UCDP validation + completeness codes (mostly for GSE‑delivered loans; rare on RTL).
14. **`GET /attachments/types`**, **`GET /products/{id}` / `/v2/products`**, **`PUT caseFileId`/`lpaKey`**, **`PUT assign-vendor`**, **`POST licenses/{name}`**, **Users endpoints** — situational; wire as the rebuild needs them.

---

## 8. Notes on version handling (context for the rebuild)
- v1 (`/orders`, UAD 2.6) is today's default; v2 (`/v2/orders`, UAD 3.6) is built and selectable per order. The differences are all in `order-build.js PROFILES` (property‑type field name + value list, contact `Type`/`type` casing, `occupancy` free‑string vs closed enum, `caseFileId`→`duReferenceNumber`, `lpaKey`→`lpaKeyReferenceIdentifier`).
- Order **create** and **read** and the **product catalogue** are the only version‑specific calls. Notes, revisions, cancellations, callbacks, attachments, payment, AVM, GSE, organisations and users are **shared** across both UAD versions (no `/v2` variant) — do not thread a version through them.
- v1 `occupancy` is documented as a free string but the **live** API binds it to an undocumented closed enum; our builder cascades a candidate list until Class accepts one. v2 `occupancy` is a documented 4‑value enum. Keep this behaviour in any rebuild.
