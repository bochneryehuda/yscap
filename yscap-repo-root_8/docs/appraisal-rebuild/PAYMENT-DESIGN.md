# Appraisal-order PAYMENT design — unified experience, per-vendor backend

**Scope:** design the "Pay this appraisal" experience for the two appraisal vendors — **NAN / AppraisalScope** (`src/amc/*`, CDG JSON API) and **Class Valuation** (`src/class/*`). RTL only. This doc is the build blueprint; it does **not** re-inventory the APIs — the endpoint/field/enum facts live in `docs/appraisal-rebuild/NAN-FEATURE-INVENTORY.md` §3 and `CLASS-FEATURE-INVENTORY.md` §3, and this design cites them.

**What already exists (do not rebuild):** PILOT already collects + validates + stores the borrower's card. `src/lib/appraisal-card.js` is the one chokepoint: `validateCardInput` (Luhn + expiry + CVV + billing ZIP) and `saveApplicationCard` write `application_payment_cards.card_encrypted` = base64 of an AES‑256‑GCM blob of `{number, cvc}` (same helper as SSNs, `src/lib/crypto.js`), plus `last4 / brand / exp_month / exp_year / billing_zip`, and flip the `appraisal_card` condition to `received`. The card-entry UI is `StaffCardEntry`; the order desk already surfaces "is a card on file" via `order-service.cardStatus` (`src/amc/order-service.js:314`) and the AMC route already enters a card through the same chokepoint (`src/routes/amc.js:104`). **We are not missing card capture — only the vendor payment calls, a status model, and the recipient/notification wiring.**

## Guiding principles

1. **Unified front, split back.** ONE "Pay" surface on the order desk; the charge/link logic stays vendor-separate in `src/amc/*` and `src/class/*`. The only shared pieces are **passive**: the status-storage table (§4), the recipient resolver (§3), and the notification chokepoints in `src/lib/notify.js` (§5). No shared *backend logic* module writes to a vendor's API.
2. **NAN can charge directly; Class cannot.** NAN relays the raw card to CDG → Authorize.Net (`PaymentAuthCapture`). Class v1 has **no charge/gateway endpoint** — its only in‑API collection is the **hosted PaymentLink**. So the UX is asymmetric by necessity, not by choice.
3. **Off by default, staged, journaled.** Payment is a WRITE. It rides the existing gates: NAN `AMC_ENABLED` + `AMC_OUTBOUND_ENABLED` + `AMC_DRYRUN` (`src/amc/client.js`), Class `CLASS_ENABLED` + `CLASS_OUTBOUND_ENABLED`. Every call is journaled to `amc_write_log` (masked) / a Class equivalent.
4. **Never guess a business rule.** Two honest gaps are surfaced below (NAN billing address; Class post‑order link) rather than papered over.

---

## 1. NAN / AppraisalScope — charge the stored card OR send an invoice/link

Backend home: **`src/amc/payments.js`** (new) + payment builders in **`src/amc/cdg.js`** (extend the pure builder) + a route in **`src/routes/amc.js`**. Nothing here touches `src/class/*`.

### 1.1 "Pay now" — `PaymentAuthCapture` (charge the card directly)

**Transport.** A payment is an order-update WRITE: `client.write(message, { orderId: order.cdg_order_number, label: 'PaymentAuthCapture' })`. `client.write` posts to `AMC().orderUrl` with `?orderId=<cdg_order_number>` (the CDG `DigitalGatewayOrderNumber`, e.g. `CLGGL100417`) and enforces `AMC_OUTBOUND_ENABLED` fail-closed. The message body still carries `ServiceProviderOrderNumber` (= `amc_orders.sp_order_number` = AppraisalScope `appraisal_id`), the subdomain, and the `ApiKey`.

**Decrypt the stored card at charge time** (never persist plaintext, never log it):
```js
const C = require('../lib/crypto');
const row = /* SELECT card_encrypted,last4,brand,exp_month,exp_year,billing_zip
              FROM application_payment_cards WHERE application_id=$1 */;
const { number, cvc } = JSON.parse(C.decryptSSN(Buffer.from(row.card_encrypted, 'base64')));
```

**The exact envelope** (build in `cdg.js buildPaymentAuthCapture(spec, ctx)`; fields verbatim from NAN‑INVENTORY §3.2). Card fields live under **`message.products[].payments[]`**:

```json
{ "message": {
  "clientSystem": { "referenceIdentifiers": [
    {"referenceIdentifierType":"ApiKey","referenceIdentifierValue":"<api key>"},
    {"referenceIdentifierType":"ClientOrderNumber","referenceIdentifierValue":"<amc_orders.client_order_number>"}]},
  "products": [{ "payments": [{
    "paymentReferenceIdentifier":"<OUR generated ref — store it, see below>",
    "paymentAccountCardHolderFirstName":"<borrower first>",
    "paymentAccountCardHolderLastName":"<borrower last>",
    "paymentAccountCardHolderAddress1":"<billing street — SEE GAP §1.1a>",
    "paymentAccountCardHolderCity":"<billing city>",
    "paymentAccountCardHolderState":"<billing state>",
    "paymentAccountCardHolderPostalCode":"<application_payment_cards.billing_zip>",
    "paymentAccountCardHolderCountry":"United States",
    "paymentAccountCardHolderPhone":"<borrower cell (optional)>",
    "paymentAccountCardHolderEmail":"<borrower email — required>",
    "paymentAccountIdentifier":"<raw PAN, decrypted>",
    "paymentAccountCardSecurityCode":"<CVV, decrypted>",
    "paymentAccountCardExpirationMonth":"<2-digit, String(exp_month).padStart(2,'0')>",
    "paymentAccountCardExpirationYear":"<4-digit, String(exp_year)>" }]}],
  "serviceProviderSystem": { "referenceIdentifiers": [
    {"referenceIdentifierType":"ServiceProviderSubDomain","referenceIdentifierValue":"<amc_orders.sp_subdomain>"},
    {"referenceIdentifierType":"ServiceProviderOrderNumber","referenceIdentifierValue":"<amc_orders.sp_order_number>"}]},
  "requestActionType": "PaymentAuthCapture" }}
```

- `paymentReferenceIdentifier` is **our** client-supplied reference "for added security" (NOT a card token). Generate a stable value per attempt and store it on the payment row (§4) — e.g. `appraisal_order_payments.id` or a short uuid. `paymentTotalAmount` is **omitted** for full AuthCapture (CDG charges the order's due amount). Exp year: the vendor accepted `"2022"`; send 4-digit.

**Success / failure.**
- **Success** = ACK (`message.digitalGatewaySystem.statusResponses[0].statusName === "ACK"`, `statusCode "0"`) **AND** `message.products[0].payments[0].paymentTransactionId` present (the Authorize.Net transaction id, e.g. `"40064185551"`). Record `paymentTransactionId` → status `paid` (§4).
- **Failure (NACK)** = reuse the existing `cdg.parseError` (it already recognizes negative code / `nack|failure|error`). Surface `statusDescription`; status → `failed` (§4). Do NOT retry a card decline (`client.write` only retries 429/5xx/network; a NACK is a normal 200 body).

**§1.1a — HONEST GAP: billing street/city/state.** NAN marks `paymentAccountCardHolderAddress1 / City / State` **Required**, but `validateCardInput` / `application_payment_cards` capture only `billing_zip`. Two options, pick one before wiring (do not guess a billing address):
   - **(preferred)** extend `StaffCardEntry` + `validateCardInput` + `application_payment_cards` to optionally capture billing `address1 / city / state`, pre‑filled from the borrower's `current_address` (`borrowers.current_address`), editable. One migration adds three text columns; the card chokepoint stays the single writer.
   - **(fallback)** source them at charge time from `borrowers.current_address` and let the desk confirm on the Pay dialog. Refuse the charge with a plain reason if none resolves — a blank Required field is a guaranteed NACK.

### 1.2 "Send payment link / invoice" — `GetPaymentOptions` + `SendInvoice` / `BillInvoice`

For a file with **no card** (or when the borrower should pay), NAN emails the invoice itself.

1. **`GetPaymentOptions`** (lookup, `client.lookup`) → `paymentFormAvailable` (is the card form on) + the allowed method `id`s (`authorize_and_capture`, `send_invoice`, `bill_me`, `bank_account`, `split_payment`, `partial_payment`). Drives which Pay buttons render. Cache per subdomain in `amc_lookup_cache` like the other lookups.
2. **`SendInvoice`** (WRITE) — emails the invoice to chosen recipients. The invoice email is **NAN's own template, sent by NAN** to `message.products[].notifications[].contactEmail`. Because `notifications[]` is an array, **the recipient selector (§3) maps directly to multiple `{contactEmail}` entries in ONE call** — NAN emails every selected party the payable invoice. Response = ACK only (no transaction id). Record status → `link_sent` (§4).
3. **`BillInvoice`** ("Bill me / prepaid check") — payment block at `message.payments[]` (NOT under products), `paymentMethodType` = `InvoiceBorrower` | `InvoiceBank`, plus `products[].requestCommentText`. Response = ACK only. Status → `link_sent` (billed) — reconcile to `paid` later via poll (§4.3).

Add these builders to `cdg.js`: `buildGetPaymentOptions`, `buildPaymentAuthCapture`, `buildSendInvoice`, `buildBillInvoice`, and `parsePayment(resp)` → `{ ok, paymentTransactionId, error }`. **Verbatim vendor spellings** (`PaymentToCaptureLeter`, etc.) if those later options are added.

---

## 2. Class Valuation — PaymentLink flow (no card charging)

Backend home: **`src/class/payments.js`** (new) + `paymentDetails` in **`src/class/order-build.js`** + webhook handling already partly in **`src/class/callbacks.js`** + a route in **`src/routes/class.js`**. Nothing here touches `src/amc/*`.

**Class v1 has no charge API** (CLASS‑INVENTORY §0/§3). The realistic flows:

### 2.1 Order-time: `paymentDetails.paymentMethod = PaymentLink`

The builder (`src/class/order-build.js`) currently **omits** `paymentDetails`. Add it to the `POST /orders` / `POST /v2/orders` body:
```jsonc
"paymentDetails": {
  "paymentMethod": "PaymentLink",          // or "Invoice" (billed to account) | "Prepay"
  "recipientEmail": "<the ONE hosted-page recipient — default borrower, see §3>"
}
```
Class then **emails the borrower a hosted payment page** (their template, their URL). We do not see or control that URL.

### 2.2 Tracking — webhooks + `payment-details` poll

Class **pushes** (callbacks already registered, `src/class/callbacks.js`):
- **`PaymentLinkSentToBorrower`** (envelope only) → status `link_sent`. *(Currently stored-but-not-acted-on — wire it in `changesFor`.)*
- **`OrderPaid`** (envelope only) → status `paid`. *(Already handled: `callbacks.js:188` sets `paid_at`.)*
- **`ClientFeeChanged`** (`OldAmountValue → NewAmountValue`) → the fee moved; may create a `balance`. *(Already captured as `client_fee_cents`.)*

Add **`GET /orders/{orderId}/payment-details`** (`client.paymentDetails`, currently missing) → `{ clientFee, additionalFees[], totalAmount, paidAmount, outstandingBalance }`. This is the authoritative money read behind the desk and the poller fallback (`src/class/poller.js`). Status mapping:
- `paidAmount >= totalAmount` → `paid`
- `0 < paidAmount < totalAmount` (or `outstandingBalance > 0` after a `ClientFeeChanged`) → `balance`
- else → `unpaid` / `link_sent`.

### 2.3 `add-creditcard-payment` — RECORD only

`POST /orders/{orderId}/add-creditcard-payment` **records** a completed card (`nameCardHolder`, `amount`, `cardNumber`=**last 4**, `authorizationCode`) — no PAN/CVV/expiry, it does **not** process. Only wire this if PILOT ever charges on its **own** gateway; then post the last‑4 + auth code so Class marks the order paid. Not in the initial build.

**§2.a — HONEST GAP: post-order link + non-borrower recipients.** Class's PaymentLink recipient is set **at order creation** and is a **single `recipientEmail`**; there is **no documented "re-send link" endpoint** and **no way to retrieve the hosted URL**. Consequences the UX must reflect (do not invent an endpoint):
   - If the borrower is the payer, set `recipientEmail` = borrower at order time.
   - The **other** selected parties (LO / processor) cannot receive Class's clickable link — PILOT sends them a companion **heads-up** via `notify.js` ("a payment link was sent to the borrower for this appraisal"), not the URL.
   - An order already created as `Invoice` cannot be flipped to `PaymentLink` via the API — surface this on the desk ("re-order or collect via the Class portal") rather than a dead button.

---

## 3. The recipient selector (BOTH vendors)

Owner requirement: send to any of **BORROWER / LOAN OFFICER / PROCESSOR**, individually chooseable, plus **send-to-all**, with a **selectable default set**.

**New shared resolver: `src/lib/appraisal-payment-recipients.js`** — modeled 1:1 on `src/lib/draw-recipients.js` (it already resolves borrower/co-borrower, LO emails, and the file's people). It returns the four candidate parties with display name + email:

| Party | Source (all already read in the codebase) |
|---|---|
| **Borrower** (+ co-borrower) | `applications.borrower_id` / `co_borrower_id` → `borrowers.email` (see `drawRecipients`, `draw-recipients.js:15`) |
| **Loan officer** | `fileLoanOfficerEmails(appId)` — `application_assignees` role `loan_officer` UNION the `applications.loan_officer_id` pointer, active + `is_external=false` (`draw-recipients.js:131`) |
| **Processor** | `application_assignees` role `processor` UNION `applications.processor_id` → `staff_users.email` (mirror the LO query; `fileContext` already reads `proc_email`, `notify.js:1470`) |

Return shape `{ borrower, coBorrower, loanOfficer[], processor[] }`, each `{ id, name, email, kind }` — the same passive shape `draw-recipients` uses, so the desk renders checkboxes and the sender maps selections to vendor calls.

**Default recipient set** — a single admin-settable value (a `company_settings` / config row, e.g. `appraisal_payment_default_recipients = ['borrower']`). Default = **borrower** (they pay). The desk pre-checks the default set; the staffer can change it per send.

**How selections map per vendor:**
- **NAN `SendInvoice`** — every checked party becomes a `notifications[].contactEmail` entry; NAN emails all of them the payable invoice in ONE call. "Send to all" = borrower + LO + processor entries.
- **NAN `PaymentAuthCapture`** — no recipient (it charges the stored card); the selector is hidden for "Pay now".
- **Class `PaymentLink`** — the **one** `recipientEmail` = the highest-priority checked *payer* (borrower by default, else the single checked party). Every OTHER checked party gets a `notify.js` heads-up (§5), because Class can't email them the link.

---

## 4. Payment-status model + storage

Owner requirement: track **unpaid / link-sent / paid / balance** on the order, surfaced on the order screen; map each vendor's success signal to it.

**Recommended storage: ONE shared status table `appraisal_order_payments` (vendor-tagged) + a denormalized `payment_status` column on each order table.** The table is *passive storage* — it does not violate "vendor-separate backends" (both vendors are RTL; only `src/amc/payments.js` and `src/class/payments.js` write it, each for its own rows). It gives the desk ONE unified status query and ONE record of who a link was sent to.

```sql
-- db/NNN_appraisal_order_payments.sql  (RTL; additive; idempotent)
CREATE TYPE appraisal_pay_vendor AS ENUM ('nan','class');   -- or a text CHECK
CREATE TABLE IF NOT EXISTS appraisal_order_payments (
  id                   bigserial PRIMARY KEY,
  vendor               text NOT NULL CHECK (vendor IN ('nan','class')),
  application_id       uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  amc_order_id         bigint REFERENCES amc_orders(id)   ON DELETE CASCADE,  -- set for nan
  class_order_id       bigint REFERENCES class_orders(id) ON DELETE CASCADE,  -- set for class
  method               text,          -- 'charge' | 'link' | 'invoice' | 'bill' | 'record'
  status               text NOT NULL DEFAULT 'unpaid',  -- unpaid | link_sent | paid | balance | failed
  amount_total_cents   bigint,
  amount_paid_cents    bigint,
  amount_outstanding_cents bigint,
  -- vendor success tokens (the mapping below)
  nan_payment_reference  text,        -- OUR paymentReferenceIdentifier we sent
  nan_transaction_id     text,        -- Authorize.Net paymentTransactionId (paid proof)
  class_paid_via         text,        -- 'OrderPaid' | 'payment_details'
  recipients_sent        jsonb,       -- who a link/invoice went to (audit of §3 selection)
  last_error             text,
  request_summary        jsonb,       -- MASKED (no PAN/CVV/api key) — mirror amc_write_log
  response_summary       jsonb,       -- MASKED
  created_by             uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aop_amc   ON appraisal_order_payments(amc_order_id)   WHERE amc_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aop_class ON appraisal_order_payments(class_order_id) WHERE class_order_id IS NOT NULL;
-- Denormalized headline status for the desk list (one column per order table):
ALTER TABLE amc_orders   ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unpaid';
ALTER TABLE class_orders ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unpaid';
```

*(If the owner prefers "columns, not a table": drop the shared table and put `payment_status`, `nan_transaction_id`, `paid_amount_cents`, `outstanding_cents`, `payment_recipients` directly on `amc_orders` + `class_orders`. The table is preferred because it keeps a per-attempt audit and the masked request/response, and gives ONE surface for the desk. Either way the backends stay separate.)*

**Success-signal → status mapping (the contract):**

| Status | NAN / AppraisalScope | Class Valuation |
|---|---|---|
| `unpaid` | no card charged, no invoice sent | order created without PaymentLink, or before send |
| `link_sent` | `SendInvoice` / `BillInvoice` ACK | `paymentDetails.PaymentLink` set at order create **or** `PaymentLinkSentToBorrower` webhook |
| `paid` | `PaymentAuthCapture` ACK **AND** `products[0].payments[0].paymentTransactionId` present | `OrderPaid` webhook **OR** `payment-details.paidAmount >= totalAmount` |
| `balance` | `PartialPayment` (partial) — later phase | `0 < paidAmount < totalAmount`, or `outstandingBalance > 0` after `ClientFeeChanged` |
| `failed` | `cdg.parseError` NACK on the charge | (record-only path fails; not in initial build) |

**§4.3 Reconcile poll.** The NAN poll worker (already polls status/comments) and the Class poller (`src/class/poller.js`) additionally read the money picture — NAN has no "get payment status" action, so `paid` is proven by the AuthCapture response (and `BillInvoice` reconciled by the order's fee/paid state on `GetAppraisalDetail`); Class calls `GET /orders/{id}/payment-details` on open orders and updates `status` + amounts. Webhooks are the fast path; the poll is the fallback (owner-directed "keep polling").

---

## 5. Notification wiring (reuse `src/lib/notify.js`)

Reach borrower / LO / processor with the SAME chokepoints the draw + order desks use — no new mailer.

**New notify types** (register in the `CATEGORY_OF` / `KICKER_OF` / `BORROWER_MAJOR_EMAIL` maps in `notify.js`, category e.g. `appraisal` or `orders`):
- `appraisal_payment_link` — borrower-facing "a payment link / invoice for your appraisal" (major → emails the borrower).
- `appraisal_payment_status` — staff-facing status ("link sent" / "paid") — routine → in-app for the team (the 2026‑07‑20 in‑app‑only rule), a real email on `paid`.

**Send paths, per selection (§3):**
- **Borrower selected** → `notifyBorrower(borrowerId, { type:'appraisal_payment_link', applicationId, link, ctaLabel, ... })`.
  - NAN: NAN's `SendInvoice` already emails the payable invoice; PILOT's `notifyBorrower` is a **companion confirmation** (or skip if NAN's email suffices — decide with the owner). Pass `opts.alreadyEmailed` if NAN emailed them, mirroring the one‑event‑one‑copy rule.
  - Class: Class emails the hosted page to `recipientEmail`; PILOT's `notifyBorrower` is the companion heads-up (no URL to forward).
- **LO / processor selected** → `notifyStaff(staffId, { type:'appraisal_payment_status', applicationId, ... })` per chosen staffer (the resolver returns their `staff_users.id`). For NAN they ALSO get the real invoice from NAN (they're a `notifications[].contactEmail`); the `notifyStaff` in-app row is the internal record.
- **On `paid`** (AuthCapture success, or `OrderPaid` / `paidAmount>=total`): fire `notifyAppThread(appId, { type:'appraisal_payment_status', ... })` — ONE email, borrower in To, the team visibly Cc'd (the 2026‑08‑03 one‑email pattern), so "appraisal paid" reaches everyone on the file at once. Keeps the in-app rows for the desk.

**Recipient resolution reuse:** the "send to all" / per-party emails come straight from `appraisal-payment-recipients.js` (§3); the LO/processor loop-in for the `paid` thread can reuse `fileLoanOfficerEmails` + the processor query. No new email plumbing.

---

## 6. PCI + card masking (mandatory)

- **Raw PAN to NAN is inherent** to their API (CDG → Authorize.Net over TLS) — it is the intended flow, but it puts the transmission path in **PCI‑DSS scope**. The card is only ever decrypted **in memory** at charge time and re-serialized into the envelope; it is never written back in plaintext.
- **Card data must NEVER be logged in plaintext; journal masked.** The write journal (`amc_write_log`) already masks the ApiKey via `cdg.maskRequest` (`cdg.js:493`) and the dry-run log via `client.cdgMaskSafe` (`client.js:227`). **Both must be extended** to strip `products[].payments[].paymentAccountIdentifier`, `paymentAccountCardSecurityCode`, and the bank fields (`paymentAccountABARoutingNumber`, `paymentAccountNameOnAccount`) → `***`, and to keep only `last4` in `request_summary`/`response_summary`. Add a `maskPayment(message)` to `cdg.js` and route every payment write through it before journaling (mirror the SSN/card masking already applied elsewhere). The `paymentTransactionId` in the response is safe to store (it is the Authorize.Net txn id, not the card).
- **Class never receives a full card** — `add-creditcard-payment` takes only last‑4 + auth code, and `PaymentLink` collection happens on Class's page. Class's `request_body` is already stored unmasked because it "contains no credential" (db/490) — that stays true; do not add card data to a Class order body.

---

## 7. Build checklist (condensed)

**NAN (`src/amc/*`):** `cdg.js` builders `buildGetPaymentOptions` / `buildPaymentAuthCapture` / `buildSendInvoice` / `buildBillInvoice` + `parsePayment` + `maskPayment`; `src/amc/payments.js` (decrypt card, assemble, `client.write`, map to status, journal masked); route `POST /api/amc/orders/:orderId/pay` (`method: 'charge'|'invoice'|'bill'`, recipients) + `GET /api/amc/orders/:orderId/payment`. Resolve the **billing-address gap §1.1a** first.

**Class (`src/class/*`):** `order-build.js` add `paymentDetails.{paymentMethod,recipientEmail}`; `client.paymentDetails` (`GET /orders/{id}/payment-details`); `callbacks.js` wire `PaymentLinkSentToBorrower` → `link_sent` (OrderPaid already handled); `poller.js` reconcile via `payment-details`; `src/class/payments.js` status mapping. Surface the **post-order/one-recipient limits §2.a** on the desk.

**Shared (passive):** `db/NNN_appraisal_order_payments.sql` (§4); `src/lib/appraisal-payment-recipients.js` (§3); notify types + wiring (§5); the default-recipient-set setting.

**UX (order desk):** NAN order → **[Pay now]** (charge stored card, hidden if no card) *and* **[Send payment link]** (recipient selector). Class order → **[Send payment link]** only (recipient selector, recipientEmail = payer). Both show a `payment_status` chip (unpaid / link-sent / paid / balance) fed by §4.

**Gating/tests:** everything behind the existing `AMC_*` / `CLASS_*` switches; `AMC_DRYRUN` builds + logs the masked body and sends nothing; a pure test for the envelope shape + masking (mirror `test-amc-cdg-pure.js`) and a status-mapping test.
