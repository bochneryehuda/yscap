# DocuSign Workforce Build Spec — the working feature (owner-directed 2026-07-19)

_The authoritative spec for the end-to-end DocuSign signing feature the owner asked for. Nobody guesses:
every rule here is owner-directed or verified against the codebase. Built on branch
`claude/docusign-api-research-ubkxcs`, gated (DOCUSIGN_TEST_MODE on, DOCUSIGN_SEND_ENABLED off, only
allow-listed test emails), NOT merged until working + audited. Companions: the DOCUSIGN-* docs already on
the branch (blueprint, hardening, bug-register, security-compliance, redirect-and-account-setup)._

## 0. Status of the foundation (already built + verified)
- `db/132_esign_v2.sql` (envelopes v2: purpose, send-once claim, partial unique index, `esign_envelope_docs`,
  `docusign_event_inbox`), `db/133_esign_send_bookkeeping.sql` (retry columns).
- `src/lib/integrations/docusign.js` — hardened connector. **Live production account VERIFIED** (a real
  test envelope was sent to the owner; sends as "PILOT by YS Capital Group", na4 data center).
- `src/lib/esign/send.js` — send-EXACTLY-once engine (23 DB tests).
- Live credentials saved in Render. Legal pages `/privacy.html` + `/terms.html`.

---

## 1. Two packages

| Package | `purpose` | Documents | Signers | Admin counter-sign? | TPR / SharePoint |
|---------|-----------|-----------|---------|---------------------|------------------|
| **Term-sheet package** | `term_sheet_package` | term sheet + application export + business-purpose disclosure | borrower (+ co-borrower if present) → **admin** | **YES** — admin signs LAST | included |
| **Heter Iska** | `heter_iska` | Heter Iska (שטר היתר עיסקא section only) | borrower/guarantor (+ co-borrower if present) | **NO** (owner-confirmed) | **EXCLUDED from TPR export AND SharePoint** (`heter_iska_signed` denylist) |

Each package has its **own Send button** in the staff DocuSign section. Both share the SAME send-gate (§2).

---

## 2. Send gate — a package may be sent ONLY after all three (owner-directed)

Verified condition codes (`db/051`, `db/052`):
1. **Appraisal is back** — `rtl_cond_appraisaldocs` ("Appraisal documents received") is **satisfied**.
2. **Appraisal review signed off** — `rtl_p3_apprreview` ("Appraisal review cleared (CoreFirst files)") is **satisfied**.
3. **P&P re-signed AFTER the appraisal** — `rtl_p1_product` (product & pricing) is **satisfied** AND its
   `signed_off_at` is **>=** the appraisal-back time (`rtl_cond_appraisaldocs.signed_off_at`). This enforces
   "re-registered on the appraised value" — a P&P sign-off from BEFORE the appraisal does not count.

`esignSendGate(applicationId)` returns `{ ready:boolean, outstanding:[{code,label,reason}] }`. The staff UI
shows each unmet item as a checklist (§4). The Send button is enabled only when `ready`. Re-check server-side
on the actual send (never trust the client).

> The existing reopen family (`db/096`) already reopens `rtl_cond_signedts` when economics change after a
> send — so a term sheet re-priced post-appraisal correctly reopens and must be re-sent.

---

## 3. Signing model

- **Recipients** (per envelope), captured in a new `esign_recipients` table (one row each):
  - **Borrower** — routingOrder 1, role `borrower`, from `borrowers` via `applications`.
  - **Co-borrower** — routingOrder 1 (parallel with borrower), role `co_borrower`, ONLY when
    `applications.co_borrower_id` is set.
  - **Admin (counter-sign)** — routingOrder 2, role `admin`, `yehuda@yscapgroup.com`. **Term-sheet package
    ONLY.** Signs LAST; envelope is `completed`/bindable only after the admin signs.
- **Anchors** (per-recipient, per-document, invisible): `/app_b1_sig/` (borrower), `/app_b2_sig/`
  (co-borrower), `/ts_admin_sig/` (admin, on the term-sheet doc only). `anchorIgnoreIfNotPresent` so a
  missing co-borrower anchor is skipped.
- **Both email AND embedded**: every signer gets the DocuSign email invite AND a "Sign now" button in the
  portal (embedded, `clientUserId`). The admin (yehuda) likewise can sign from the email or the internal
  DocuSign section.
- **Completion → file the signed doc**: on envelope `completed`, download each signed PDF (by numeric
  documentId) + the Certificate of Completion, store them, and auto-clear the mapped condition
  (`rtl_cond_signedts` for the term sheet, `rtl_cond_iska` for the Iska) via `signOffGate(itemId, null)`.
  The **fully-signed term sheet** (post-admin-countersign) is what lands in `rtl_cond_signedts`.

---

## 4. Staff DocuSign section (LO + processor) — full interface on the internal file screen

A dedicated, well-designed section in `app-v2/src/screens/StaffApplication.jsx`. For EACH package
(term-sheet + Iska):

**Before send — readiness checklist** (from `esignSendGate`): each prerequisite as a row with a ✓/✗ —
"Appraisal received", "Appraisal review cleared", "Product & pricing re-registered after appraisal". The
**Send for signature** button is disabled with a tooltip listing what's outstanding until all pass.

**After send — live tracking:**
- Envelope status chip (Sent / Delivered / **Awaiting borrower** / **Awaiting your counter-signature** /
  Completed / Declined / Voided).
- A **recipient timeline/table**: each recipient (borrower, co-borrower, admin) with status + **timestamps**
  (sent, viewed/delivered, signed) and a "waiting on →" indicator for the current routing order.
- The **admin's own view/sign status is visible to everyone** here.
- Actions: **Resend** (to the current pending recipient), **Void**, download the **signed PDF** +
  **Certificate of Completion** once complete.
- Envelope history (multiple sends over the file's life).

Status is driven by our `esign_recipients`/`esign_envelopes` rows (updated by the HMAC-verified Connect
webhook + `Envelopes:get`), never by polling the browser.

---

## 5. Borrower view (external condition)

- After the package is sent, the borrower's e-sign condition shows a **"Sign now"** button (embedded signing,
  returns them into their file via the `/api/esign/return` bounce endpoint → "Thank you for signing").
- The borrower also receives **two invitations**: our portal notification+email ("your term-sheet package is
  ready to sign") AND the DocuSign email.
- After signing, the borrower sees "Your part is done — waiting on the co-borrower / lender counter-signature"
  as appropriate (recipient-complete vs envelope-complete, per the redirect research).

---

## 6. Admin counter-signature (the major flow)

1. Borrower (+ co-borrower) sign first (routingOrder 1).
2. When routingOrder 1 completes, DocuSign routes to the **admin** (`yehuda@yscapgroup.com`, routingOrder 2).
   The admin reviews the whole package and signs — from the DocuSign email OR the internal DocuSign section
   ("Awaiting your counter-signature" with a Sign button for the admin).
3. Only after the admin signs is the envelope **completed/bindable**. The fully-signed term sheet is then
   filed into `rtl_cond_signedts` and the condition auto-cleared.
4. The admin's viewed/signed status is visible on **everyone's** interface (staff section).
5. Guard: if the admin never signs, the envelope sits "Awaiting counter-signature" — surfaced prominently +
   reminders/expiration (§8) so it never silently stalls.

---

## 7. Redirect (per DOCUSIGN-REDIRECT-AND-ACCOUNT-SETUP.md)

`GET /api/esign/return?app=<id>&env=<envelopeId>` (non-hash bounce): reads `event` reliably, verifies
completion server-side, then 302s into `/portal/#/app/<id>?signed=1` (or an honest non-complete state). The
redirect is a UI hint only — the condition clears solely from the HMAC-verified webhook. Email signers land
via a Brand Destination URL → the same bounce endpoint (loan id carried as an envelope custom field).

---

## 8. Lifecycle + smoothness features (refined by the research round)

Reminders + expiration (per envelope), decline handling (→ human review + re-issue), Resend to the pending
recipient, Void, correct a wrong recipient email, download signed + Certificate of Completion, per-recipient
nudge, envelope history. Final list finalized from the two research agents' findings before build.

---

## 9. Schema additions (new migration)

- **`esign_recipients`** — one row per recipient: `envelope_row_id`, `role` (borrower|co_borrower|admin),
  `routing_order`, `name`, `email`, `client_user_id`, `recipient_id_ds`, `status`
  (created|sent|delivered|signed|declined|completed), `sent_at`, `delivered_at`, `signed_at`, `declined_at`,
  `is_countersigner` bool. Powers the staff dashboard's per-recipient timeline.
- `esign_envelopes.purpose` already supports both packages; add a `countersign_required` bool if useful.
- No change to the send-once / idempotency model.

---

## 10. Build order (each phase committed, DB-tested, 2+ audit agents, app-v2 rebuilt)

1. **Schema** — `esign_recipients` + any envelope columns.
2. **Send gate** — `esignSendGate(applicationId)` + the appraisal-timestamp comparison.
3. **DocGen** — assemble the 3 term-sheet-package PDFs (term sheet, application export, business-purpose
   disclosure — build the disclosure generator) + the Iska PDF, with per-recipient invisible anchors.
4. **Send orchestration** — build the envelope (recipients incl. admin counter-signer, anchors, custom
   fields, per-envelope Connect), claim-once, send; wire `esign_recipients`.
5. **Webhook** — `src/routes/webhooks.js` (HMAC, inbox dedupe, re-fetch truth, update envelope + recipients,
   on completed store signed PDFs + CoC + auto-clear condition; dead-letter on failure).
6. **Bounce redirect** — `/api/esign/return`.
7. **Staff DocuSign section** + **borrower Sign-now** UI (app-v2), rebuild bundle.
8. **Guards** — `heter_iska_signed` denylist in tpr-export + sharepoint-backup; reopen-family for the signed
   conditions; docKind whitelist extension.
9. **Audit sweep** + end-to-end demo/gated test, then propose merge.

---

## 11. Research findings (locked — from the 2026-07-19 API + UX research round)

**Routing / counter-sign (DocuSign API):**
- Borrower + co-borrower share `routingOrder:"1"` (parallel); admin is `routingOrder:"2"` (gated). The admin
  sits in recipient status `created` (no email, no signing URL) until ALL order-1 recipients complete.
- **DocuSign has NO native "awaiting counter-signature" status.** The envelope stays `sent`/`delivered` and
  only flips to `completed` when the LAST order signs. We DERIVE the phase ourselves:
  - *awaiting_borrower* = any order-1 recipient not yet completed.
  - *awaiting_countersign* = all order-1 complete AND admin (order 2) not yet complete.
  - *completed/binding* = envelope `completed`.
  Use the envelope's `currentRoutingOrder` (1 → borrowers, 2 → admin) as the primary "who are we waiting on"
  signal, cross-checked against per-recipient status.
- An embedded admin view minted before it's the admin's turn fails `RECIPIENT_NOT_IN_SEQUENCE` — gate the
  admin's recipient-view on `currentRoutingOrder==2` (driven by the Connect `recipient-completed` event).
- If the **borrower declines** (order 1) the envelope goes `declined` and the admin never gets it. If the
  **admin declines**, the whole thing is `declined` (prior signatures void). If the admin never signs, it
  sits `sent`/`delivered` until expiration — so the admin counter-sign is surfaced as its own work-queue
  with reminders + an SLA age so it never silently stalls.

**Signing delivery (both email + in-portal):** each signer uses `clientUserId` **plus**
`embeddedRecipientStartURL:"SIGN_AT_DOCUSIGN"` → they get the DocuSign email AND can sign embedded in our
portal. Trade-off: such hybrid recipients do NOT receive DocuSign's automated reminder/expiration emails, so
we drive reminders ourselves (scheduled `resend_envelope` to the current routing order) + a manual per-recipient
Resend button.

**Per-recipient status (webhook + read-back):** enable Connect **recipient events** explicitly
(`recipient-sent/delivered/completed/declined`) in **SIM** (Send Individual Messages) mode; read-back truth
via `GET /envelopes/{id}?include=recipients` → `signers[]` with `status` + `sentDateTime`/`deliveredDateTime`/
`signedDateTime`/`declinedDateTime`. Key completion on `signedDateTime != null` (the terminal string can be
`signed` or `completed`). Label `delivered` as **"Viewed"** in the UI.

**Anchors:** the anchor search spans ALL documents by default → use **document-unique** anchor strings
(`/ts_admin_sig/` present ONLY in the term-sheet PDF; borrower anchors on their docs), belt-and-suspenders
with `documentId` on the tab. Invisible = 1–2pt white-on-white.

**Lifecycle endpoints:** resend `PUT /envelopes/{id}?resend_envelope=true` (nudges the current order); void
`PUT /envelopes/{id}` `{status:'voided',voidedReason}` (required reason; silently ignored once completed — verify
after); download `GET /envelopes/{id}/documents/combined?certificate=true` (signed + Certificate of Completion),
cert-only `/documents/certificate`. Per-envelope reminders/expiration via the `notification` object
(`useAccountDefaults:false`); default with no notification = expire ~120 days, no reminders.

**Staff dashboard (what to show):** per-package envelope row + status chip (Draft/Sent/In progress/**Awaiting
counter-signature**/Fully executed/Declined/Voided/Expired); a "Waiting on: <name> (<role>)" banner; per-recipient
rows in routing order (borrower → co-borrower → admin) with status + timestamps (sent, **viewed**, signed),
decline reason, resend count; a vertical stepper hero; the pre-send readiness checklist (never a silently-disabled
Send — show the ✗/✓ gates); actions (Send, Resend/nudge per-recipient, Void, Correct, Re-issue-on-decline,
reminders); downloads (signed PDF + Certificate of Completion + audit-trail drill-down); and a cross-file
**admin counter-sign queue** with SLA age. Status fed by Connect webhooks, never browser polling.

**Borrower view:** "Sign now" (embedded, returns to file), dual prompt (portal + DocuSign email), a sanitized
3-step tracker (You → Co-borrower/Guarantor → Lender counter-signs → Done; the **Iska tracker omits the
counter-sign step**), "Your part is done — waiting on <next>", a branded thank-you, and — once fully executed —
"All parties signed, this is now binding" + download signed PDF + Certificate. Never expose the admin's
email/IP or say "binding" before the counter-signature completes.
