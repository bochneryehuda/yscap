# NAN / AppraisalScope (CoreLogic / Cotality "Digital Gateway", CDG) — Feature Inventory & Gap Map

**Purpose:** map every useful feature of the AppraisalScope appraisal API (delivered through CoreLogic Digital Gateway, "CDG") so we can rebuild our integration and add every valuable capability to PILOT — with **payment** (a "Pay this order" button) as the top priority, and **comment/portal-message sync** and the **status model** close behind.

Sources read in full: the two vendor guides (`AppraisalScope_PropertyValuation_Client_Integration_Guide_v1.1`, `ClientNameHere_AppraisalScope_As_Vendor_B2B_Client_Communication_Guide_v1.1`), the authoritative field/enum/status mapping workbook (`mapping.txt` — sheets Request / Enum Mapping / Response / List Response / NACK Response / Dexma-Status Code Mapping), and ~60 request/response JSON samples under `Client iPackage/Samples/`. Our current code: `src/amc/*.js` and `src/lib/appraisal-card.js`.

---

## 0. How the API works (the frame every feature sits in)

- **Transport:** HTTPS **POST** only, **synchronous** (request → response in the same call, 2–10 s typical). **There is NO webhook / push. "Pull" integration: AppraisalScope never pushes to us — we must POLL for status, comments, revisions, and completed documents.** Timeout budget is **90 seconds**; on a timeout, re-send the SAME `ClientOrderNumber` after ≥90 s (CDG never retries; the client must). Max request/response message size 15 MB (document bytes go by URL, not inline).
- **Two-step auth on every session:**
  1. **GetToken** — OAuth 2.0. `Authorization: Basic` with `clientId`/`clientSecret`, form field `grant_type=client_credentials`, against `https://api-{uat|prod}.corelogic.com/order-gateway-oauth2/token`. Returns an `accessToken` used as the **Bearer** token in the `Authorization` header on every later call.
  2. **DoLogin** — returns an **AppraisalScope API key**. That key rides in the **message body** of every subsequent call at `message.clientSystem.referenceIdentifiers[referenceIdentifierType="ApiKey"].referenceIdentifierValue`.
  - (Lower environments also accept a static header `apikey: fd868dbe-…` in place of OAuth; not available in prod.)
- **Endpoints (path decides the action family):**
  - DoLogin → `…/direct/appraisal_service/request/appraisalscope/client`
  - Lookups (not tied to an order) → `…/order/appraisal_service/request/appraisalscope/client`
  - New order / admin (createappraisal, addform, create_branch, create_client_user, …) → same `…/order/…/client` **with NO `?orderId=`**
  - Order update / order lookup (updateappraisal, addcomment, getappraisalstatus, payments, …) → `…/order/…/client?orderId=<CDG order id>`
  - Documents: upload to `…/postdocuments`, retrieve from `…/getdocument/<id>`
  - UAT host `uat1.globalgateway.corelogic.com`; PROD host `globalgateway.corelogic.com`.
- **Identifiers that thread through everything:**
  - `ServiceProviderSubDomain` — our AppraisalScope tenant subdomain (e.g. `integrations.uat`). Required on nearly every call.
  - `ClientOrderNumber` — OUR order number (`message.clientSystem.referenceIdentifiers[ClientOrderNumber]`).
  - `ServiceProviderOrderNumber` — AppraisalScope's `appraisal_id` (returned by createappraisal/addform; required on every later order call).
  - `DigitalGatewayOrderNumber` — CDG's own order id (e.g. `CLGGL100417`), returned in responses.
- **Envelope shape:** request root is `{ "message": { clientSystem, products / deals, serviceProviderSystem, requestActionType } }`. The **action name is `message.requestActionType`** (e.g. `"PaymentAuthCapture"`).
- **ACK / NACK:** success carries `message.digitalGatewaySystem.statusResponses[0]` = `{statusCode:"0", statusCondition:"Success", statusName:"ACK", statusDescription:"Acknowledgement"}`. Failure is a **NACK** — `statusName:"NACK"`, `statusCondition:"ERROR"` (or `Nack`/`Failure`), a negative `statusCode` (e.g. `-1008`, `-100`, `-996`), a free-text `statusDescription`, and a vendor code in `message.serviceProviderSystem.statusResponses[0].statusCode` (e.g. `"E003"`).

---

## 1. Complete endpoint / feature inventory

`requestActionType` values, grouped. "Key request fields" are the load-bearing ones beyond the standard auth/subdomain/order-number envelope.

### 1a. Session / auth
| Action | Purpose | Key request fields | Key response fields |
|---|---|---|---|
| **DoLogin** | Exchange vendor login for an AppraisalScope API key | `message.clientSystem.credentials[].loginAccountIdentifier` + `loginAccountPassword`; `ServiceProviderSubDomain` | `message.clientSystem.referenceIdentifiers[ApiKey].referenceIdentifierValue` |
| **GetToken** (OAuth, not a `requestActionType`) | Get the Bearer token for CDG | Basic auth clientId/secret; `grant_type=client_credentials` | `accessToken` |

### 1b. Lookups (catalog data — no order context)
All return `{ responseData: { responseType, count, responseFields:[{num, fieldlist:[{fieldName, fieldValue}]}] } }`.
| Action | Purpose | Notable request field | Notable response fields |
|---|---|---|---|
| **GetLoanOfficer** | Loan officers for the client | — | id / name |
| **GetProcessor** | Processors for the client | — | id / name |
| **GetClientDisplayedOnReport** (`GetClientDisplayOnReport`) | Clients allowed to display on the report | — | id / name |
| **GetInvestorList** | Investors | — | id / name |
| **Get_Branch_List** | Client branches | — | branch fields (`brachid`[sic], `company_id`, address1/2, city, zip, country, contact_name, is_active, is_default, is_delete, branch_g…) |
| **GetIntendedUse** | Intended-use options | — | name / id (e.g. Refinance=1, Purchase=2) |
| **GetPropertyType** | Property types | — | name / id |
| **GetPropertyViewType** (`GetPropertyTypeView`) | Property view types | — | name / id |
| **GetLoanType** | Loan types | — | name / id |
| **GetJobType** | Job types (appraisal FORMS) | — | form catalog |
| **GetJobTypeAddOns** | Add-on forms for a job type | `products[].productcode` | add-on catalog |
| **ClientDisplayedGetJobType** | Job types for a specified "client displayed on report" | client-displayed id | form catalog |
| **Get_JobTypes_By_LoanType** | Forms filtered by loan type | `deals[].loans[].mortgageType`; `clientSystem.sourceInformation.sourceClientIdentifier` | form catalog |
| **CheckFHA** | Is a job type configured for FHA? | `products[].productcode` | `result` = "Yes"/"No" |
| **GetPaymentOptions** | Payment methods the account allows | — | `paymentFormAvailable` + list of `{id,name}` (see §3) |
| **GetFee** | Fees for a job type | job type | fee rows |
| **GetAppraiserFeesByLocation** | Fees by property location | `deals[].properties[].address.{stateCode, zip}` | rows of `{job_type, user_type, fee, user}` |
| **GetAMCPreference** | Client's preferred AMCs | — | AMC list |
| **GetUsers** | Users for the client | — | rows of `{user_type, internal_id, name, id}` |
| **Get_Additional_Document_Types** | Additional doc types the client defines | — | rows of `{name, id}` (Invoice=10, Appraiser E&O=3, Appraiser License=2, EAD SSR=9, Fannie Mae SSR=7, Freddie Mac SSR=8, …) |
| **GetAppraisals** | Search the client's orders | `deals[].loans[].loanIdentifiers.lenderLoanIdentifier`; `products[].productCode`; `searchCriteria[]` of `{fieldName, fieldValue}` (`create_date_start`, `create_date_end`, `status`) | rows of `{appraisal_id, file_no, borrower_name, address, city, loan_no, date_ordered, ordered_by, status, inspection_date, investor_company, last_update_time, estimated_completion_date}` |
| **GetAMCPreference / getprocessor / getclientdisplayonreport / getfee** | (as above) | | |

### 1c. Create / update an order
| Action | Purpose | Key request fields | Key response fields |
|---|---|---|---|
| **CreateAppraisal** | Create a new appraisal order | `products[].productCode` (form) + fees + `serviceNeedByDate` + `notifications[].contactEmail`; `deals[].{borrowers, parties, loans, properties, appraisers}`; optional `products[].objectURL` (document) | ACK; `ServiceProviderOrderNumber` (=`appraisal_id`); `deals[].properties[].appraisalIdentifier` (AppraisalScope File #) |
| **AddForm** | Create a new order attached to a PARENT order (multiple appraisals on one loan) | same as CreateAppraisal + parent `ServiceProviderOrderNumber`; `subproducts[].identifier`; `clientSystem.sourceInformation.{sourceType, sourceClientIdentifier}` | ACK + child `ServiceProviderOrderNumber` |
| **UpdateAppraisal** | Update details on an existing order | order id + changed fields | ACK |
| **AddComment** | Add a comment/message to an order | `products.requestCommentText` | `products[].commentId` |
| **AddRevision** | Add a revision request | `products.revisedRequestCommentText` | `products[].revisionId` |
| **UploadDocument** | Attach ONE document | `products[].embeddedFiles[].{documentType, objectDescription, objectName, objectURL}` | `products[].documentId` |
| **UploadDocumentMulti** | Attach MULTIPLE documents | `products[].embeddedFiles[]` (array) | doc ids |
| **UploadContract** | Attach a contract document | `products[].embeddedFiles[].{objectName, objectURL}` | ACK |

### 1d. Order lookups / reads (POLL these — no webhook)
| Action | Purpose | Key response fields |
|---|---|---|
| **GetAppraisalStatus** | Current status of one order | `products[].statusResponses[0]` = `{statusCode, statusCondition:"Status", statusDescription, statusName}` |
| **GetAppraisalDetail** | Full order detail | large `products[0]` (fees, all milestone datetimes, embeddedFiles, productData, subproducts) + `deals[0]` (appraisers, borrowers, parties, loans, properties) — see §5 |
| **GetAddFormDetail** | Basic detail for an (add-form) order | trimmed detail (productCode, serviceNeedByDate, fees, borrowers, parties, appraisers) |
| **GetComments** | ALL comments on an order | `products[]` of `{commentId, requestCommentText, requestCommentContactFullName, requestCommentTextDatetime}` — see §4 |
| **GetRevisions** | ALL revisions on an order | `products[]` of `{revisionId, revisedRequestCommentText, revisedCommentContactFullName, revisedCommentTextDatetime}` |
| **RetriveAppraisalDocuments** (sic) | All documents + additional documents for an order | `deals[].embeddedFiles[]` of `{documentId, documentType, objectName, objectDescription, objectSize, objectURL, createdDatetime, isAdditionalDocument, includeXMLIndicator, objectXMLFileName, ucdp*}` |
| **RetriveDocumentContent** (sic) | One specific document | request `products[].documentId`; response `deals[].embeddedFiles[].objectURL` |

### 1e. Payments & invoicing (see §3 for full detail)
| Action | Purpose |
|---|---|
| **PaymentAuthCapture** | Authorize AND charge a credit card for the full amount (one shot) |
| **PaymentAuthOnly** | Authorize only; charge later with PaymentCapture |
| **PaymentCapture** | Charge a previously authorized transaction |
| **PartialPayment** | Authorize + charge a specified partial amount |
| **SplitPayment** | Authorize + charge TWO cards, each a partial amount |
| **PaymentToCaptureLeter** (sic — "Later") | Save card on the Authorize.Net PCI vault; charge later with PaymentCapture |
| **eCheckPayment** | Authorize a bank account (ACH) and, if approved, capture for settlement |
| **BillInvoice** | Bill the order ("Bill me / prepaid check") |
| **SendInvoice** | Email an order invoice to an address |
| **GetPaymentOptions** | (lookup) which of the above the account allows |

### 1f. Admin / provisioning
| Action | Purpose | Key request fields | Key response |
|---|---|---|---|
| **Create_Client_User** | Create a client user | `deals[].parties[].{partyRoleType, partyRoleIdentifier, identifier, partyContacts[].{contactFirstName, contactLastName, loginAccountIdentifier, loginAccountPassword, contacts[].{contactEmail, contactPhone}}}}` + a `LenderBranch` party | `serviceProviderSystem.responseMessage`; `deals[].parties[].{loginAccountIdentifier, serviceProviderInternalIdentifier}` |
| **Update_Client_User** | Update a client user (user id in URL, `…/update_client_user/442`) | same + `serviceProviderInternalIdentifier`, `partyContacts[].address` | ACK |
| **UpdatePassword** | Change a user's password | `deals[].parties[].partyContacts[].{loginAccountIdentifier, loginAccountPassword, newLoginAccountPassword}` | ACK |
| **Create_Branch** | Create a client branch | `deals[].parties[].{partyRoleType:"LenderBranch", companyName, partyRoleIdentifier, identifier, estimatedMonthlyVolume, address, partyContacts}` | ACK |
| **Edit_Branch** | Update a branch | same + `serviceProviderInternalIdentifier` | ACK |

---

## 2. GAP MATRIX — what we use today vs. what exists

Legend: **P0** = build now (owner-driven / high value), **P1** = high value soon, **P2** = nice to have.

| Feature | CDG action | Do we use it? (file) | Value for our RTL flow | Priority |
|---|---|---|---|---|
| Session token | GetToken (OAuth) | **Yes** — `session.js`, `client.js` | Required | — |
| API key login | DoLogin | **Yes** — `cdg.buildDoLogin`, `session.js` | Required | — |
| Create order | CreateAppraisal | **Yes** — `cdg.buildCreateAppraisal`, `order-service.js`, `order-build.js` | Core | — |
| Second form on same loan | AddForm | **Yes** — `order-service.js` (`requestAction==='AddForm'`) | Multi-product loans | — |
| Update order | UpdateAppraisal | **NO** | Push a changed due-date / party without re-ordering | P2 |
| Add comment | AddComment | **Yes** — `comments.js`, `cdg.buildAddComment` | Two-way messaging | — |
| Read comments | GetComments | **Yes** — `comments.js`, `cdg.buildGetComments/parseComments` | **See every message incl. portal-typed (§4)** | — |
| Add revision | AddRevision | **Yes** — `revisions.js`, `rov.js` | Revision requests | — |
| Read revisions | GetRevisions | **Yes** — `revisions.js` | Revision history | — |
| Upload 1 doc | UploadDocument | **Yes** — `documents.js` | Send contract/docs | — |
| Upload N docs | UploadDocumentMulti | **Yes** — `documents.js` (chooses multi when >1) | — | — |
| Upload contract | UploadContract | **Partial** — `documents.js` routes through `buildUploadDocuments`; no dedicated contract action | Contract-specific slot | P2 |
| Pull all docs | RetriveAppraisalDocuments | **Yes** — `cdg.buildRetrieveDocuments`, `sync.js` (imports XML+PDF) | Get the finished report | — |
| Pull one doc | RetriveDocumentContent | **NO** (we bulk-pull) | Fetch a single doc by id | P2 |
| Get additional doc types | Get_Additional_Document_Types | **Cached** — `lookups.js` LOOKUP_TYPES | Label uploads | — |
| Add a form to an order | AddForm / getaddformdetail | AddForm yes; **GetAddFormDetail NO** | Read an add-form order's basics | P2 |
| Get add-ons | GetJobTypeAddOns | **Cached** — `lookups.js` | Add-on forms | — |
| Forms by loan type | Get_JobTypes_By_LoanType | **Cached** — `lookups.js` (form catalog) | Form selection | — |
| Forms by client-on-report | ClientDisplayedGetJobType | **NO** (we cache `GetClientDisplayOnReport` only) | Alternate form list | P2 |
| Payment options | GetPaymentOptions | **NO** | Show which pay methods are allowed | **P0** |
| Auth+capture a card | PaymentAuthCapture | **NO** | **The "Pay" button (§3)** | **P0** |
| Auth only | PaymentAuthOnly | **NO** | Hold now, charge on completion | P1 |
| Capture prior auth | PaymentCapture | **NO** | Complete a held auth | P1 |
| Partial payment | PartialPayment | **NO** | Pay part now | P2 |
| Split payment | SplitPayment | **NO** | Two cards | P2 |
| Save-card-then-capture | PaymentToCaptureLeter | **NO** | Vault a card, charge later | P2 |
| eCheck / ACH | eCheckPayment | **NO** | Pay by bank account | P1 |
| Bill invoice | BillInvoice | **NO** | "Bill me / prepaid check" | P1 |
| Send invoice | SendInvoice | **NO** | Email invoice to borrower | P1 |
| Status | GetAppraisalStatus | **Yes** — `sync.js`, `cdg.buildGetStatus/parseStatus/mapStatusToLifecycle` | Milestone tracking (§5) | — |
| Full detail | GetAppraisalDetail | **Yes** — `cdg.buildGetDetail` | Milestone dates, parties, fees | — |
| Order search | GetAppraisals | **NO** | Reconcile / find orders by loan # | P1 |
| FHA check | CheckFHA | **NO** | FHA-configured form check | P2 |
| Fee for job type | GetFee | **NO** | Show/verify fee before ordering | P1 |
| Fees by location | GetAppraiserFeesByLocation | **NO** | Quote appraisal fee by state/zip | P1 |
| Property type | GetPropertyType | **Cached** — `lookups.js` | Order-form dropdown | — |
| Property view type | GetPropertyViewType | **Cached** — `lookups.js` | Order-form dropdown | — |
| Intended use | GetIntendedUse | **Cached** — `lookups.js` | Order-form dropdown | — |
| Loan type | GetLoanType | **Cached** — `lookups.js` | Form selection | — |
| Loan officer | GetLoanOfficer | **Cached** — `lookups.js` | Party mapping | — |
| Processor | GetProcessor | **Cached** — `lookups.js` | Party mapping | — |
| Investors | GetInvestorList | **Cached** — `lookups.js` | Party mapping | — |
| AMC preference | GetAMCPreference | **Cached** — `lookups.js` | AMC routing | — |
| Users | GetUsers | **Cached** — `lookups.js` | Party mapping | — |
| Branches (read) | Get_Branch_List | **Cached** — `lookups.js` | Party mapping | — |
| Create/edit branch | Create_Branch / Edit_Branch | **NO** | Provision branches from PILOT | P2 |
| Create/update user | Create_Client_User / Update_Client_User | **NO** | Provision AppraisalScope users | P2 |
| Change password | UpdatePassword | **NO** | Rotate a user password | P2 |
| Cancel order | (custom `CancelOrder`) | **Yes** — `cancel.js`, `cdg.buildCancelOrder` | Cancellation | — |

**Honest partial-coverage notes:** we cover ordering, documents, comments, revisions, status, detail, and the lookup catalog well. The whole **payment / invoicing family is 0% covered** — the single biggest gap, and the top priority. We also don't use fee quoting (GetFee / GetAppraiserFeesByLocation), order search (GetAppraisals), FHA check, or admin provisioning.

---

## 3. PAYMENT FLOW — DETAILED (top priority)

### 3.1 What "pay an order" means on this API
CDG relays card/bank data to **Authorize.Net** as the gateway (confirmed by the `PaymentToCaptureLeter` description: *"Saves payment details on the authorize.net PCI compliance server"*). Every payment action is an **order-update** call: `…/order/…/client?orderId=<CDG order id>`, carrying the `ApiKey`, `ServiceProviderSubDomain`, `ServiceProviderOrderNumber` (the AppraisalScope `appraisal_id`), and `ClientOrderNumber`, plus a `products[].payments[]` block. The action is chosen by `requestActionType`.

### 3.2 The exact credit-card fields (quote the JSON verbatim)
All card fields live under **`message.products[].payments[]`** (mapping notes the container as `message.products[1..n].payments[0..n]`; the samples use `products[0].payments[0]`).

| JSON field | Meaning | Required for CC pay? |
|---|---|---|
| `paymentReferenceIdentifier` | **"Payment Token" — a value the CLIENT supplies "for added security" (our own reference, NOT a card token).** | **Required on ALL payment types** |
| `paymentAccountCardHolderFirstName` | Cardholder first name | Required |
| `paymentAccountCardHolderLastName` | Cardholder last name | Required |
| `paymentAccountCardHolderAddress1` | Billing street line 1 | Required |
| `paymentAccountCardHolderAddress2` | Billing street line 2 | Optional |
| `paymentAccountCardHolderCity` | Billing city | Required |
| `paymentAccountCardHolderState` | Billing state | Required |
| `paymentAccountCardHolderPostalCode` | Billing ZIP | Required |
| `paymentAccountCardHolderCountry` | Billing country ("United States" / "US") | Optional |
| `paymentAccountCardHolderPhone` | Cardholder phone | Optional |
| `paymentAccountCardHolderEmail` | Cardholder email | Required (also the only extra field PaymentCapture needs) |
| `paymentAccountIdentifier` | **The raw card number (PAN), e.g. `4012888888881881`.** Also doubles as the bank account number for eCheck. | Required |
| `paymentAccountCardSecurityCode` | **CVV (3–4 digits)** | Required |
| `paymentAccountCardExpirationMonth` | 2-digit month (e.g. `"01"`) | Required |
| `paymentAccountCardExpirationYear` | 4-digit year (`"2022"`; one sample used `"22"`) | Required |
| `paymentTotalAmount` | Amount to charge (`"50"` or `"300.22"`) | Required for PartialPayment / SplitPayment / eCheck (full AuthCapture omits it — charges the order's due amount) |
| `paymentProfileUpdate` | `"0"`/`"1"` — save the payment profile | Optional |
| `billingProfileUpdate` | `"0"`/`"1"` — save the billing profile | Optional |

**Full AuthCapture request body (verbatim shape):**
```json
{ "message": {
  "clientSystem": { "referenceIdentifiers": [
    {"referenceIdentifierType":"ApiKey","referenceIdentifierValue":"…"},
    {"referenceIdentifierType":"ClientOrderNumber","referenceIdentifierValue":"1234AB"}]},
  "products": [{ "payments": [{
    "paymentReferenceIdentifier":"38298",
    "paymentAccountCardHolderFirstName":"API","paymentAccountCardHolderLastName":"Testing",
    "paymentAccountCardHolderAddress1":"501 NE 122nd St","paymentAccountCardHolderAddress2":"Apt B",
    "paymentAccountCardHolderCity":"OKLAHOMA CITY","paymentAccountCardHolderState":"OK",
    "paymentAccountCardHolderPostalCode":"73114","paymentAccountCardHolderCountry":"United States",
    "paymentAccountCardHolderPhone":"555-222-5555","paymentAccountCardHolderEmail":"…@corelogic.com",
    "paymentAccountIdentifier":"4012888888881881","paymentAccountCardSecurityCode":"111",
    "paymentAccountCardExpirationMonth":"01","paymentAccountCardExpirationYear":"2022" }]}],
  "serviceProviderSystem": { "referenceIdentifiers": [
    {"referenceIdentifierType":"ServiceProviderSubDomain","referenceIdentifierValue":"integrations.uat"},
    {"referenceIdentifierType":"ServiceProviderOrderNumber","referenceIdentifierValue":"SP345"}]},
  "requestActionType": "PaymentAuthCapture" }}
```

### 3.3 Auth-only vs. capture vs. auth+capture (when each is used)
- **PaymentAuthCapture** — one-shot: authorize AND charge the **full** order amount. **This is the "Pay now" button.** Request carries all card fields. → **Use this for our Pay button.**
- **PaymentAuthOnly** — places a hold, no charge. Card fields identical to AuthCapture. Use when we want to guarantee funds at order time but only charge when the report is delivered.
- **PaymentCapture** — charges a previously authorized transaction. **Request needs only `paymentReferenceIdentifier` + `paymentAccountCardHolderEmail`** (no card re-sent). Pairs with AuthOnly or PaymentToCaptureLeter.
- **PartialPayment** — AuthCapture of a specified `paymentTotalAmount` (e.g. `"300.22"`), rest still owed.
- **SplitPayment** — `products[].payments[]` is an **array of TWO** full card blocks, each with its own `paymentTotalAmount` (e.g. `"1.00"` + `"98.00"`) and `paymentProfileUpdate`/`billingProfileUpdate`. Response echoes each payment with its own `paymentTransactionId` + `paymentStatusResponse`.
- **PaymentToCaptureLeter** (sic — "Later") — vaults the card on Authorize.Net's PCI server, **no charge**; capture later with PaymentCapture. Response is an **ACK only** (no `paymentTransactionId` yet).

### 3.4 eCheck (ACH) fields — `eCheckPayment`
Bank fields (under the same `products[].payments[]`):
- `paymentAccountBankName` (e.g. `"Fifth Third"`)
- `paymentAccountIdentifier` (**bank account number**, e.g. `"000999999991"`)
- `paymentAccountABARoutingNumber` (routing #, **must include the check digit**, e.g. `"063100277"`)
- `paymentAccountNameOnAccount` (e.g. `"Demo"`)
- `paymentMethodType` — **`checking` / `businessChecking` / `savings`**
- `paymentTotalAmount` (e.g. `"50"`)
- plus cardholder name / address / email as above.
Response: ACK + `products[].payments[].paymentTransactionId`.

### 3.5 Invoicing — `BillInvoice` and `SendInvoice`
- **BillInvoice** ("Bill me / prepaid check"): payment block is at **`message.payments[]`** (not under products), `paymentMethodType` = **`InvoiceBorrower`** or **`InvoiceBank`**; plus `products[].requestCommentText` (e.g. `"Bill me now"`). Response: **ACK only.**
- **SendInvoice**: emails the invoice — `products[].notifications[].contactEmail`. Response: **ACK only.**

### 3.6 GetPaymentOptions — what the account allows
Request is just auth + subdomain. Response:
```json
{ "responseData": { "responseType":"Payment Options", "count":6, "paymentFormAvailable":"1",
  "responseFields": [
    {"num":1,"fieldlist":[{"fieldName":"name","fieldValue":"Authorize and Capture"},{"fieldName":"id","fieldValue":"authorize_and_capture"}]},
    {"num":2,"fieldlist":[{"fieldName":"name","fieldValue":"Bank Account"},{"fieldName":"id","fieldValue":"bank_account"}]},
    {"num":3,"fieldlist":[{"fieldName":"name","fieldValue":"Send Payment Request To Your Customer"},{"fieldName":"id","fieldValue":"send_invoice"}]},
    {"num":4,"fieldlist":[{"fieldName":"name","fieldValue":"Bill Me/Prepaid Check"},{"fieldName":"id","fieldValue":"bill_me"}]},
    {"num":5,"fieldlist":[{"fieldName":"name","fieldValue":"Split Payment"},{"fieldName":"id","fieldValue":"split_payment"}]},
    {"num":6,"fieldlist":[{"fieldName":"name","fieldValue":"Partial Payment"},{"fieldName":"id","fieldValue":"partial_payment"}]}]}}
```
`paymentFormAvailable:"1"` says whether a card form is enabled; the `id`s map to actions: `authorize_and_capture`→PaymentAuthCapture, `bank_account`→eCheckPayment, `send_invoice`→SendInvoice, `bill_me`→BillInvoice, `split_payment`→SplitPayment, `partial_payment`→PartialPayment.

### 3.7 How the response signals success / failure
- **Success:** `message.digitalGatewaySystem.statusResponses[0]` = `{statusCode:"0", statusCondition:"Success", statusName:"ACK", statusDescription:"Acknowledgement"}`, and — for actual charges (AuthCapture, AuthOnly, Capture, Partial, eCheck) — **`message.products[0].payments[0].paymentTransactionId`** (the Authorize.Net transaction id, e.g. `"40064185551"`). SplitPayment additionally returns per-payment `paymentStatusResponse:"Success"`. PaymentToCaptureLeter / BillInvoice / SendInvoice return **ACK only, no transaction id.**
- **Failure (NACK):** `statusName:"NACK"`, `statusCondition:"ERROR"` (or `Nack`/`Failure`), negative `statusCode` (e.g. `-1008` "Service Provider Processing Error", `-100` NOT_AUTHENTICATED, `-996` "Missing required field", `-998` "Process Failed, Retry"), free-text `statusDescription`, plus a vendor code in `serviceProviderSystem.statusResponses[0].statusCode` (e.g. `"E003"`). Our existing `cdg.parseError` already recognizes exactly this shape (negative code OR condition nack/failure/error).

### 3.8 Tokenization / PCI
- **The card is sent RAW.** `paymentAccountIdentifier` is the full PAN and `paymentAccountCardSecurityCode` is the CVV, transmitted to CDG over TLS. There is **no client-side tokenization** — CDG forwards to Authorize.Net. `paymentReferenceIdentifier` is a **client-supplied reference "for added security," NOT a card token** — we choose its value (the samples use `"38298"`).
- **PCI implication:** because we transmit the PAN + CVV, our system is in PCI-DSS scope for the transmission path. **Good news for the rebuild:** PILOT already collects, validates (Luhn + expiry + CVV length + billing ZIP), and stores the card **encrypted at rest** (AES-256-GCM, same helper as SSNs) in `application_payment_cards.card_encrypted` (PAN+CVV) with `last4`/`brand`/`exp_month`/`exp_year`/`billing_zip`, and an opt-in reusable copy on the borrower profile (`src/lib/appraisal-card.js`, table `application_payment_cards`). We already surface "is a card on file" on the order desk (`order-service.cardStatus`). **We are NOT missing the card capture — we are only missing the CDG payment call.**

### 3.9 What the "Pay" button needs (build plan)
1. On demand, call **GetPaymentOptions** to learn allowed methods (and whether the card form is enabled).
2. Decrypt the stored card (`application_payment_cards.card_encrypted` → `{number, cvc}`, plus `exp_month`/`exp_year`/`billing_zip`).
3. Assemble the `products[].payments[]` block. **Fields we already hold:** PAN, CVV, exp month, exp year, billing ZIP. **Fields we must source** (from the borrower profile / property): `paymentAccountCardHolderFirstName`/`LastName`, `Address1`/`City`/`State` (billing address), `paymentAccountCardHolderEmail`. Generate our own `paymentReferenceIdentifier` (any stable per-payment reference; store it).
4. POST **PaymentAuthCapture** to `…/order/…/client?orderId=<CDG order id>` with the `ApiKey` + `ServiceProviderOrderNumber`.
5. On ACK, record `paymentTransactionId`; on NACK, surface `statusDescription`. (Reuse `cdg.parseError`.)
6. Optional later: AuthOnly at order time + PaymentCapture on report delivery; eCheck; SendInvoice/BillInvoice paths.

---

## 4. COMMENTS / portal-message sync

### 4.1 Does GetComments return EVERYTHING, including messages typed in the NAN web portal?
**Yes.** GetComments returns **all comments on the order regardless of how they were created.** The proof is in the sample response itself: the author `requestCommentContactFullName` is **`"API Testing(Manager)"`** — a role-tagged human (Manager), not an API-only actor. AppraisalScope stores one comment thread per order; GetComments reads the whole thread. So a comment our staff types directly in the AppraisalScope portal appears in GetComments exactly like an API-posted one. This directly satisfies the owner's need: *see, in PILOT, every message on the order — even ones staff posted from NAN's own portal.*

### 4.2 GetComments shape (verbatim)
Request: auth + `ServiceProviderSubDomain` + `ServiceProviderOrderNumber` + `ClientOrderNumber`, `requestActionType:"GetComments"`.
Response:
```json
"products": [
  {"commentId":"15007","requestCommentText":"This is a test comment…",
   "requestCommentContactFullName":"API Testing(Manager)","requestCommentTextDatetime":"2021-05-17 13:57:06"},
  {"commentId":"15006","requestCommentText":"…","requestCommentContactFullName":"API Testing(Manager)","requestCommentTextDatetime":"2021-05-17 13:57:00"}]
```
**Fields available:** `commentId` (stable id — dedupe on this), `requestCommentText` (body), `requestCommentContactFullName` (author + role in parentheses, e.g. "(Manager)"), `requestCommentTextDatetime` (`YYYY-MM-DD HH:MM:SS`).
**Fields NOT available:** there is **no explicit author role/email field** beyond the parenthetical in the name, **no internal/external visibility flag, and no attachment reference** on a comment. (Documents are a separate channel — UploadDocument / RetriveAppraisalDocuments.) Ordering in the sample is newest-first.

### 4.3 AddComment
Request: `products.requestCommentText`, `requestActionType:"AddComment"`. Response: `products[].commentId` (+ ACK). Our staff replies post here.

### 4.4 How to poll (no webhook)
Poll **GetComments** per active order on our sync cadence, upsert by `commentId` (never re-file a `commentId` we've seen), and store `{commentId, body, author=requestCommentContactFullName, at=requestCommentTextDatetime}`. New `commentId`s = new inbound messages, including portal-typed ones. Our `comments.js`/`cdg.parseComments` already build/parse this — the gap is presenting the full thread (author + timestamp) to owners as a unified message feed and polling it regularly.

---

## 5. STATUS MODEL

### 5.1 There is no webhook — confirm we POLL
The Integration Guide states the integration is **"Pull … Appraisal Scope will not push any data to the Client."** So order status, comments, revisions, and completed documents are all obtained by **polling**: GetAppraisalStatus (+ GetAppraisalDetail for dates), GetComments, GetRevisions, RetriveAppraisalDocuments. **We must poll — there is no callback.**

### 5.2 GetAppraisalStatus shape
`message.products[0].statusResponses[0]` = `{statusCode, statusCondition:"Status", statusDescription, statusName}`. Example: `{statusCode:1001, statusCondition:"Status", statusDescription:"Vendor has placed the order on hold. [On Hold]", statusName:"Vendor-SetHold"}`. (The **product-level** status is the true order status; the top-level `digitalGatewaySystem` status is just the ACK — our `cdg.parseStatus` already prefers the product one.)

### 5.3 The status codes → plain milestones (from the Dexma / CCC "Status Code Mapping" sheet)
| Code | statusName | Plain milestone |
|---|---|---|
| `0` | ACK / Success | (transport ack, not an order status) |
| `1010` | Vendor-OrderReceived | **New — order received** |
| `1050` | Vendor-OrderAccepted | **Accepted by vendor** |
| `1102` | Vendor-OrderInProcess | **Activated / in process** |
| `1150` | Vendor-OrderSentToSubProvider | Assigned to a sub-provider/AMC |
| `1200` | Vendor-OrderAssignedToAppraiser | **Assigned to appraiser** |
| `1201` | Vendor-OrderDeclined | Declined by the assigned appraiser |
| `1202` | Vendor-OrderDelayed | Delayed by the appraiser |
| `1006` | Vendor-AppointmentTimeSet | **Inspection scheduled (appointment set)** |
| `1054` | Vendor-Inspected | **Inspection completed** |
| `1056` | Vendor-AppraisalSubmittedToAMC | Appraiser submitted report to AMC (received) |
| `1105` | Vendor-OrderInReview | **In review** (`1402`/VA-WithReviewer is a variant) |
| `1103` | Vendor-AdditionalDataRequired | Additional data required |
| `1092` | Vendor-Correction | Correction made to the report |
| `1001` | Vendor-SetHold | **On hold** |
| `1002` | Vendor-SetOffHold | **Off hold** (back in process) |
| `1990` | Vendor-ProductAvailable | **Report available (PDF released)** |
| `1999` | Vendor-Complete | **Complete** |
| `1051` | Vendor-Cancellation | **Cancelled** |
| `-1007` | Vendor-OrderRejected | **Rejected** |
| `1067` | Vendor-Update | Order modified |
| `1000` | Vendor-NoteToClient | Note / other (used for many free-text events) |
| `-1008 / -100 / -996 / -998 / -999` | ERROR / NACK | Processing / auth / validation errors |

### 5.4 Milestone signals we care about → where to read them
| Milestone | Status signal | Detail-level date (`GetAppraisalDetail.products[0]`) |
|---|---|---|
| Ordered | 1010 / 1050 | `orderDatetime`, `assignedDatetime`, `acceptedDatetime` |
| Assigned to appraiser | 1200 | `assignedDatetime` |
| **Inspection scheduled** | **1006 Vendor-AppointmentTimeSet** | `inspectionScheduledDatetime` |
| **Inspection completed** | **1054 Vendor-Inspected** | `inspectionCompleteDatetime`, `inspectionDate` |
| Report received (from appraiser) | 1056 | — |
| In review | 1105 / 1402 | — |
| **Report completed / delivered** | **1990 Vendor-ProductAvailable → 1999 Vendor-Complete** | `completedDate`, `appraisalUploadDatetime`, `orderDates.documentSentToBorrowerDate`, `appraisalViewedByBorrowerDatetime` |
| Revision states | AddRevision/GetRevisions + 1092 (correction), 1103 (more data), 1105 (review) | — |
| **On hold / off hold** | **1001 / 1002** | — |
| **Cancelled / rejected / declined** | **1051 / -1007 / 1201** | — |

`GetAppraisals` (list search) also returns a plain-text `status` per order ("New", "Accepted", "On Hold", …) plus `inspection_date`, `estimated_completion_date`, `last_update_time` — useful for a portfolio/reconcile sweep.

**Our code already maps most of this:** `cdg.mapStatusToLifecycle` handles 1990→`product_available`, 1999→`completed`, 1051→`cancelled`, -1007/1201→`rejected`, 1001→`on_hold`, 1002→`in_process`, 1105→`in_review`, 1056/1054→`inspected`, 1200→`assigned`, 1010/1102→`in_process`. **Gaps to add:** `1006` (inspection scheduled — currently unmapped) and `1050` (accepted); and pulling the milestone **dates** from GetAppraisalDetail (`inspectionScheduledDatetime`, `inspectionCompleteDatetime`, `completedDate`, `documentSentToBorrowerDate`) for a real timeline.

---

## 6. OCCUPANCY enum

From the Request sheet and the Enum Mapping sheet, the field is **`propertyCurrentOccupancyType`**, sent on the request at **`message.deals[0..n].properties[0..n].propertyCurrentOccupancyType`** (create/update). The **exact accepted out-of-the-box values are:**

- **`Owner`**
- **`Tenant`**
- **`Vacant`**
- **`Realtor`**

*(the sheet: "Out of the box values for Occupancy are: • Owner • Tenant • Vacant • Realtor. Additional values can be configured.")*

**For the owner's request, the exact string to send is `"Vacant"`** (capital V, no other words). Note the values are **not** the Fannie/MISMO enums ("PrimaryResidence"/"Investment") — AppraisalScope uses its own short list, and it is case-sensitive. (Our current code does not set `propertyCurrentOccupancyType` at all — grep found no occupancy usage in `src/amc/*`; today it defaults, so adding the field to `order-build.js` with value `"Vacant"` is a clean addition.)

---

## 7. Other valuable capabilities we're NOT using

| Capability | Action(s) | Why it's worth adding |
|---|---|---|
| **Fee quoting before ordering** | `GetFee`, `GetAppraiserFeesByLocation` | Quote the appraisal fee by job type and by state/zip (`deals[].properties[].address.{stateCode, zip}` → rows of `{job_type, user_type, fee, user}`) so we can show/charge the right amount and reconcile the invoice. **P1.** |
| **FHA-configured form check** | `CheckFHA` | Confirm a chosen job type is FHA-configured (`products[].productcode` → `result` Yes/No) before ordering an FHA appraisal. **P2.** |
| **Order search / reconcile** | `GetAppraisals` | Find/reconcile orders by loan number, date range, or status without knowing the AppraisalScope id — good for a nightly reconcile sweep and for recovery. **P1.** |
| **Property view type** | `GetPropertyViewType` | Already cached; feed the order-form dropdown. |
| **Additional document types** | `Get_Additional_Document_Types` | Already cached; label uploads correctly (Invoice, Appraiser E&O, Appraiser License, EAD SSR, Fannie/Freddie SSR, …). |
| **Single-document fetch** | `RetriveDocumentContent` | Pull one document by `documentId` (vs. our bulk pull) — cheaper targeted retrieval. **P2.** |
| **Branch provisioning** | `Create_Branch`, `Edit_Branch` | Create/update AppraisalScope branches from PILOT (name, `estimatedMonthlyVolume`, address, contact). **P2.** |
| **User provisioning** | `Create_Client_User`, `Update_Client_User`, `UpdatePassword` | Create AppraisalScope logins for our staff/branches and rotate passwords, without logging into their portal. Response returns `serviceProviderInternalIdentifier` to store. **P2.** |
| **Invoice delivery** | `SendInvoice`, `BillInvoice` | Email the borrower an invoice, or "bill me / prepaid check," instead of charging a card. **P1** — pairs naturally with the Pay button. |

---

## 8. Rebuild checklist (condensed)

1. **Payment (P0):** wire `GetPaymentOptions` + `PaymentAuthCapture` (Pay button) using the already-stored encrypted card; add cardholder name/billing address/email sourcing; store `paymentReferenceIdentifier` + `paymentTransactionId`. Then `PaymentAuthOnly`+`PaymentCapture`, `eCheckPayment`, `SendInvoice`/`BillInvoice`.
2. **Comments feed (P0-ish):** poll `GetComments` per active order, upsert by `commentId`, present author + timestamp so owners see **every** message including portal-typed ones.
3. **Status/milestones:** add `1006`/`1050` to `mapStatusToLifecycle`; pull milestone **dates** from `GetAppraisalDetail`; keep polling (no webhook).
4. **Occupancy:** set `propertyCurrentOccupancyType` in `order-build.js` (owner wants `"Vacant"`).
5. **Fee quoting (P1):** `GetFee` / `GetAppraiserFeesByLocation`.
6. **Reconcile (P1):** `GetAppraisals` search.
7. **Admin (P2):** branch/user provisioning.

*Note on spellings:* the vendor's own action names contain typos we must send verbatim — **`RetriveAppraisalDocuments`**, **`RetriveDocumentContent`**, **`PaymentToCaptureLeter`** (and the response sheet header `PaymentToCaptureLeter` / `RetriveAppraisalDocuments`). Do not "correct" them.
