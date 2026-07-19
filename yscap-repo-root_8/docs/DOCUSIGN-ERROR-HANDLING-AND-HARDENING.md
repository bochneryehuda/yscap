# DocuSign Integration — Error Handling & Hardening Spec

_Research + design, 2026-07-19. **Nothing here is implemented yet.** Companion to
`docs/DOCUSIGN-INTEGRATION-BLUEPRINT.md` (architecture) and `docs/DOCUSIGN-DOCUMENT-BUILD-SPEC.md`
(per-document). This is the "harden it before go-live" pass the owner asked for: every failure mode
DocuSign can throw, mapped to the exact guard our existing integrations already use. Produced by a
3-agent sweep (DocuSign failure-mode research + an audit of our own ClickUp/SharePoint guards +
branding/redirect research), all code claims cited `file:line`. No secrets here._

> **The governing principle (carried from `docs/CLICKUP-DATA-SAFETY.md`):** *nothing stuck is ever
> invisible, and no destructive or duplicate action can happen silently.* Every rule below serves one
> of those two.

---

## 1. Send EXACTLY once — the double-click / retry / crash / multi-instance guard (owner's #1 ask)

**The problem (DocuSign-confirmed):** `POST /envelopes` is **not idempotent**. A double-clicked "Send,"
a client timeout that hides a successful 201, an automatic retry on a network blip, or a second Render
instance each create a **second envelope** — the borrower gets two emails, we get two envelope IDs.

**The model already in our codebase — the draw button.** `src/routes/borrower.js:314-319` does an atomic
"claim once" before the side effect:
```js
const claim = await db.query(
  `UPDATE applications SET draw_setup_requested_at=now(), updated_at=now()
    WHERE id=$1 AND draw_setup_requested_at IS NULL RETURNING draw_setup_requested_at`, [a.id]);
if (!claim.rows[0]) return res.json({ ok:true, already:true });   // a 2nd click sends NOTHING
```
The DB is the arbiter: exactly one click wins and proceeds; every repeat/racing click gets `already:true`
and does nothing.

**The DocuSign version — four layers, use all four:**
1. **Atomic claim on `esign_envelopes` before the API call:**
   ```sql
   UPDATE esign_envelopes SET status='sending', send_claimed_at=now()
    WHERE id=$1 AND status='draft' AND envelope_id IS NULL RETURNING id
   ```
   Only the claim winner calls DocuSign; on success it stamps `envelope_id` + `status='sent'`. The queue
   drainer (§2) checks the same guard, so a reclaimed crashed-mid-send job whose `envelope_id` is already
   set becomes a **no-op**, never a duplicate.
2. **`X-DocuSign-Idempotency-Key` header on every create** — a **deterministic** key per business action
   (e.g. `sha256(applicationId + ':' + envelopePurpose + ':' + productRegistrationVersion)`), NOT random
   per attempt. Within the honored window DocuSign returns the **original** envelope instead of creating
   a new one. _(Confirm the exact window — widely cited ~24h — and replay semantics against the live
   [createEnvelope reference](https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/envelopes/create/) before relying on it; layer 1 is the primary guard and doesn't depend on it.)_
3. **A `UNIQUE` constraint** on `esign_envelopes(application_id, purpose)` (belt-and-suspenders — even a
   lost claim can't create two *live* envelopes for the same package).
4. **UX:** the button is disabled the instant it's clicked; after send it shows **live envelope status**
   (sent → delivered → completed) pulled from our own `esign_envelopes` row (updated by the webhook,
   §3 — never by polling DocuSign). The button becomes **"Resend"** — which calls
   `PUT /envelopes/{id}/recipients?resend_envelope=true` (**re-notifies the same envelope, never creates
   a new one**), not the create path.

---

## 2. Durable outbound send queue (mirror `pushOutboxOnce`)

Never call DocuSign inline from a request — enqueue and drain, exactly like ClickUp
(`src/sync/clickup-sync.js:49-126`, `src/clickup/enqueue.js`).

- **Widen `sync_queue.target`** (`db/schema.sql:306`, currently `clickup|encompass|graph`) to add
  `docusign`, or add a parallel `docusign_send_queue` with the same columns. The claim/reclaim/backoff
  code is target-generic.
- **Claim with `FOR UPDATE SKIP LOCKED`** + **5-min crash-orphan reclaim** (`clickup-sync.js:56-62`) —
  identical.
- **Retry classification** — map DocuSign errors onto the existing two classes (`clickup-sync.js:101-106`):
  - **Outage class** (patient: fixed **600 s** spacing, dead after **40 attempts ≈ 7 h**): DocuSign
    **429**, **5xx**, network timeouts, `DOCUSIGN_CIRCUIT_OPEN`.
  - **Permanent class** (exponential `2^attempts` capped 3600 s, dead after **8 attempts**): DocuSign
    **4xx validation** errors (`ANCHOR_TAB_STRING_NOT_FOUND`, `INVALID_EMAIL_ADDRESS`,
    `ACCOUNT_LACKS_PERMISSIONS`, duplicate recipients, malformed base64).
  - **Never retry a send whose failure might have created an envelope** (a timeout *after* the POST
    reached DocuSign): the idempotency key + the layer-1 claim make the retry safe; without proof of
    non-creation, re-read status by the idempotency key rather than blind re-POST.
- **Dead-letter → review row** (`clickup-sync.js:111-123`): a send that exhausts retries queues a
  `sync_review_queue` row (§5).
- **DB-backed send circuit breaker** — DocuSign's in-process breaker equivalent (`orchestrator.js:479-507`,
  default 300/10min) **must be DB-backed**, because Render can run multiple instances and each in-process
  counter would independently allow the full budget. A runaway loop mailing real borrowers is far worse
  than ClickUp field writes. Check `COUNT(*) FROM esign_envelopes WHERE created_at > now() - interval
  '10 minutes'` against `DOCUSIGN_MAX_SENDS_10MIN` **inside the same transaction** as the layer-1 claim;
  throw `DOCUSIGN_CIRCUIT_OPEN` (outage class) and audit the opening once/min.

---

## 3. Inbound Connect webhook — idempotent, HMAC-verified, out-of-order safe

Mirror `src/routes/clickup-webhook.js` exactly; the stub already names the (missing) route
(`src/lib/integrations/docusign.js:9-10` → `src/routes/webhooks.js`, which does not exist).

- **Mount on the raw body, before `express.json()`** (`src/server.js:37`) so the HMAC covers exact bytes.
- **HMAC verify (multi-key):** DocuSign Connect sends the signature in header **`X-DocuSign-Signature-1`
  … `-N`** — **one per active HMAC key, up to 100** for zero-downtime rotation. Compute
  `base64(HMAC-SHA256(rawBody))` per configured key and **constant-time** compare (`crypto.timingSafeEqual`)
  against *every* header present; accept if any matches. **Fail-closed in production** if the Connect key
  is unset (`clickup-webhook.js:47-48` returns 503 in prod; 401 on mismatch). Algorithm is advertised in
  `x-authorization-digest` (currently HMACSHA256). Common bugs to avoid: hex-vs-base64, hashing a
  re-serialized body, proxy whitespace changes.
- **Idempotent dedupe:** `event_id = sha256(rawBody)` (or DocuSign's delivery id) →
  `INSERT INTO docusign_event_inbox … ON CONFLICT (event_id) DO NOTHING` (`clickup-webhook.js:56-64`).
  Connect is **at-least-once** — the same event *will* arrive twice.
- **Return 2xx FAST (< 100 s)**, process async (drain worker). Connect's "Require Acknowledgement" times
  out at **100 s**; slow synchronous handling → false-failure retries → duplicate processing. Enable
  "Require Acknowledgement" + logging.
- **Out-of-order safe — state machine that only advances forward.** Connect guarantees delivery, **not
  order or uniqueness**. Never let an out-of-order `sent` arriving after `completed` regress the envelope;
  `completed`/`declined`/`voided` are **terminal** — never regress them.
- **PII redaction before persist** (mirror `clickup-webhook.js:22-36`): strip signer PII from the stored
  inbox payload; keep `"Include Documents"` **OFF** on the Connect config and fetch signed PDFs via API
  over TLS (BLUEPRINT §8) so signer data isn't sitting in a webhook body/log.
- **Replay window:** if using DocuSign's event timestamp, apply a Svix-style ±5-min tolerance
  (`src/lib/resend-webhook.js:25,59-63`).
- **Backstop for a > 7-day outage:** Connect retries a failed delivery with exponential backoff for
  **~45 attempts over ~7 days** (support figure; blogs quote smaller early numbers — same escalating
  curve). Beyond that, events must be recovered. Run a scheduled **reconciliation sweep**
  (`Envelopes:listStatusChanges` with `from_date`, respecting the polling limits) — one cheap batch call,
  never per-envelope polling — to catch anything a prolonged outage dropped. Also expose the manual
  recovery paths: DocuSign **Settings → Connect → Logs / Publish**, and the ConnectEvents API
  (`list_event_failure_logs` / `retry_event_for_envelope`).

---

## 4. The DocuSign error taxonomy → our handling (condensed)

Full research in the sources; the handling column is how we react.

| # | Error / condition | DocuSign signal | Our handling |
|---|---|---|---|
| **Auth** | Consent missing | 400 `consent_required` | Surface the consent URL in the admin UI + audit; the integration is dormant until resolved (`configured()` gate). |
| | Bad JWT | 400 `invalid_grant` — **branch on `error_description`** | `no_valid_keys_or_signatures` = key mismatch/truncation → alert admin; `issuer_not_found` = wrong env/aud; `user_not_found` = wrong `sub`. Never retry a bad assertion. |
| | Token expired | 401 | **Token cache** (§10): mint ~15 min before the 1 h expiry; never per-request. |
| | Token-endpoint throttle | 429 `ErrorCode 103` | Cache per impersonated user; call `userinfo` once per app restart, not per token. |
| **Create** | Anchor missing | `ANCHOR_TAB_STRING_NOT_FOUND` | Our anchors are real text emitted by jsPDF (BUILD-SPEC §3) — verified present; set `anchorIgnoreIfNotPresent:"true"` so a stray miss doesn't fail the whole send. Permanent class if it still errors → review row. |
| | Bad email | `INVALID_EMAIL_ADDRESS` | Validate borrower/co-borrower email before send (our data guarantees non-null, but validate format); no unused template roles. Permanent → review row for the LO to fix the email. |
| | Duplicate recipients | "duplicate recipients" | Distinct `recipientId` per signer (BUILD-SPEC §2 already does `"1"`/`"2"`). |
| | Feature/permission gap | `ACCOUNT_LACKS_PERMISSIONS` | Confirm plan/permission; common demo-works-prod-fails gap → surface clearly at go-live. |
| | Payload too large | 400 / request-too-large | HTTP request cap ≈ **35 MB**; ≤100 docs / ≤100 recipients per envelope; base64 inflates ~33%. Our loan PDFs are ~tens of KB — never near the cap; guard anyway. |
| | Recipient out of sequence | `RECIPIENT_NOT_IN_SEQUENCE` | Parallel `routingOrder` for co-signers (BUILD-SPEC §2), or only mint the embedded view when the recipient is active. |
| **Rate** | Hourly / burst | 429 `HOURLY_APIINVOCATION_LIMIT_EXCEEDED` / `BURST_APIINVOCATION_LIMIT_EXCEEDED` | Read `X-RateLimit-Reset` / `X-BurstLimit-*`; outage-class backoff. Volumes here are tiny vs the 3,000/hr + 500/30s caps. |
| | Polling | `Hourly_Envelope_Polling_Limit_Exceeded` | **We don't poll** — Connect + the nightly reconcile only. |
| **Signing** | Embedded URL dead | expires **5 min**, single-use | Generate fresh on click; never store/email the raw URL (§9). |
| | Access-code fail | 3 attempts then locked | Sender can resend or correct the recipient auth. |
| | Decline | `declined` (terminal) + reason | Capture reason; **cannot void a declined envelope**; a re-solicit is a NEW envelope. → review row for the LO. |
| | Email bounce | recipient `AUTORESPONDED` + reason | Correct the recipient email + resend (`resend_envelope=true`); if valid, borrower's mail server blocks DocuSign → tell LO. → review row. |
| **State** | Void allowed only in-process | error on terminal void | Check status first; **never auto-void** (§6). |
| | Correct vs void | in-process only | Prefer correction over void+recreate when not completed. |
| | Purge | docs removed per retention | **Capture the completed PDF + Certificate of Completion immediately** on `completed`; don't assume perpetual fetchability. |
| **Env** | Consent/keys/Connect not copied to prod | `consent_required` at go-live | Re-grant consent + re-create RSA key / redirect URIs / Connect on prod; env-driven `aud` + `base_uri` from userinfo. |
| **Net** | 5xx / timeout | — | Outage class; a timeout may mean the envelope WAS created → idempotency key makes the retry safe. |
| | 4xx (non-429) | — | Permanent — never retry, surface. |

---

## 5. Dead-letter → human review ("nothing stuck is invisible")

Reuse `sync_review_queue` (`db/108`/`db/110`, `src/lib/sync-review.js`, `src/lib/sync-file-review.js`) —
you inherit LO notification, 3-day/7-day escalation, weekly digest, and auto-close-on-recovery for free.
Add (per `docs/CLICKUP-DATA-SAFETY.md:144-174`: producer + `REASON_ACTIONS` entry + action applier +
`SyncReviews.jsx` copy/buttons + a test):

| Stuck state | `field_key`/reason | Review actions |
|---|---|---|
| Send exhausted retries | `esign_send_dead_lettered` | `retry_send` (re-arm the dead send job, like `retry_push`) |
| Borrower declined | `esign_declined_needs_action` | `resend_envelope` (new envelope) / `void_and_close` |
| Envelope voided | `esign_voided` | `resend_envelope` |
| Email bounced (`AUTORESPONDED`) | `esign_email_bounced` | `correct_recipient_email` + resend |
| Anchor/validation permanent-fail | `esign_send_invalid` | surface the errorCode for the LO/dev to fix |

Every new row notifies the file's loan officer with a deep link to `/internal/sync-reviews`. Auto-closes
when the envelope later reaches a healthy terminal state.

---

## 6. No-guess / no-destructive guards (DocuSign data-safety hard rules)

A `docs/DOCUSIGN-DATA-SAFETY.md` companion should encode these; they mirror the ClickUp write guards
(`src/clickup/client.js:30-99`).

1. **Correlate by ID, never guess.** React to a webhook only via the `esign_envelopes` DB row keyed on
   `envelopeId`, cross-checked with the `envelopeCustomFields` (`ys_file_id`) we stamp at send. **Never**
   match a returned document to a loan by borrower name/address/content.
2. **No auto-void, ever.** Voiding is destructive and human-only — route it to a review row with an
   explicit approval action (mirror `guardNoTaskDeletion`'s single-chokepoint hard-stop,
   `client.js:30-39,174`). A `guardNoAutoVoid()` in the DocuSign client throws unless a human-approval
   flag is present.
3. **Skip-empty.** Refuse to create an envelope with no document bytes or no recipient (mirror
   `guardNoFieldClearing`, `client.js:65-78`).
4. **Terminal never regresses** (§3). A completed/declined/voided envelope's state is final in our DB.
5. **Capture evidence before purge** — the completed PDF + Certificate of Completion are stored on
   `completed` (portal + SharePoint, except the Heter Iska which stays in-system only, BUILD-SPEC A.3/A.9).
6. **Suspicious/unexpected inbound transition → review, not silent apply** (mirror the DOB/PII shield,
   `orchestrator.js:340-389`): e.g. a `completed` event for an envelope we have no record of.

---

## 7. Write journal + audit (PII-free)

- **`docusign_write_log`** (or reuse `clickup_write_log`'s shape, `db/107:15-31`): append-only record of
  every send / void / status transition — **envelope id + status + recipient count only, no signer PII**
  (mirror `journalFieldWrite`, `orchestrator.js:512-532`, best-effort, never blocks the operation).
- **Two audit writers** (mirror `audit()` `staff.js:120` + `logSync()` `orchestrator.js:545-552`):
  request-scoped `audit(req,'send_esign'|'void_esign'|'resend_esign', 'application', appId)` for
  staff-initiated actions; system `logSync`-style for worker/webhook transitions and circuit openings.
  Add these codes to `src/lib/audit-actions.js` under a new **`esign`** category. Detail jsonb stays
  PII-free.

---

## 8. Branding — PILOT + the loan officer

**How DocuSign branding works:** brands are **account-level** objects (needs `canSelfBrandSend` /
`canSelfBrandSign` enabled); set **`envelopeDefinition.brandId`** on each envelope and it inherits the
logo + colors + email/signing-page styling. The **signing brand** styles both the signer emails AND the
signing ceremony page.

**The FROM-name constraint (important):** the sender name a recipient sees is the **DocuSign user we
impersonate** (`sub = DOCUSIGN_USER_ID`) — it is **not** settable per-envelope and **not** `emailSubject`/
`emailBlurb`. So:
- **To make it read "PILOT by YS Capital":** name the impersonated sending user **"PILOT by YS Capital"**
  (one product identity). _Recommended._
- **To identify the loan officer:** put the officer's name / title / phone / email in the per-envelope
  **`emailBlurb`** (and/or per-recipient `emailNotification.emailBody`), and state "reply to <officer
  email>" there (DocuSign replies otherwise go to the sending user). Per-officer DocuSign users are
  possible but heavy — not recommended initially.

**Our assets to feed in (already exist):**
- Officer identity per file: `staff_users` → `officerMeta(meta, officer)` (`src/lib/email/catalog.js:200-207`)
  gives `{name,title,email,phone,nmls}`; `fileContext()` (`src/lib/notify.js:229-256`) assembles loan #,
  address, borrower, program. These populate the `emailBlurb` and the `ys_*` envelope custom fields.
- PILOT logo: the lockup PNG `cfg.emailLogoUrl` → `…/assets/brand/pilot-lockup-email.png`
  (`src/config.js:133-139`) — upload as the brand logo.
- PILOT palette (`src/lib/email/template.js:28-40`): Paper `#F6F3EC`, Gold `#AE8746`, Teal `#2F7F86`
  (button), Ink `#141B22` — map into the brand's header/button colors.
- Lender of record stays **YS Capital Group, NMLS #2609746** (`web/brand.js:17-18`); the officer is the
  point of contact only.

**Composition:** one PILOT sending+signing brand (logo + palette) referenced by `brandId` on every
envelope; sending user named "PILOT by YS Capital"; the file's officer injected into `emailBlurb`.
_(Brand setup is a one-time DocuSign-account task — I'll give the click-steps when we wire it.)_

---

## 9. Redirect after signing — back into the loan file

**Portal route (corrected):** the borrower loan file is **`/app/:id`** (`app-v2/src/App.jsx:105`), not
`/loan/:id`. Public base `https://www.yscapgroup.com`; portal is a HashRouter at `/portal/`. The deep
link is `https://www.yscapgroup.com/portal/#/app/<appId>?signed=1`.

**HashRouter gotcha:** DocuSign appends `?event=…` to the returnUrl; appending it *after* a `#fragment`
parses inconsistently. **Reuse the existing server bounce route** (`/link/r?to=…` → 302 into
`/portal/#<route>`, `src/server.js:191+`, `src/lib/email/catalog.js:52-55`) — never an open redirect.

- **Embedded (in-portal borrowers, default):** `returnUrl = https://www.yscapgroup.com/esign/return?app=<appId>`
  (a small new server route, or reuse `/link/r`). It reads DocuSign's appended `?event=` (`signing_complete`,
  `decline`, `cancel`, `session_timeout`, `ttl_expired`, …) and 302s into `…/portal/#/app/<appId>?signed=1`
  (or a decline variant). The embedded signing URL is 5-min single-use — minted on click, never stored.
- **Email (remote) signers/co-signers:** the per-envelope returnUrl does NOT govern them — configure the
  **signing brand's "Signing Resolution" destination URL** (per outcome) to
  `https://www.yscapgroup.com/esign/landing?envelopeId=[[envelopeId]]`; the server maps `envelopeId →
  appId` (via our DB row / `ys_file_id` custom field) and 302s to `…/portal/#/app/<appId>?signed=1`. An
  email signer may not be logged in — land on a friendly confirm/login page that preserves the deep link.
- **The webhook — not the redirect — flips the condition.** `?signed=1` only shows a "thanks, we're
  finalizing" state; the checklist clears off the Connect `envelope-completed` event (a user can close the
  browser, spoof the URL, or cancel redirection).

---

## 10. Token cache + HTTP client discipline

Wrap every DocuSign REST call (`accessToken`, envelope create, resend, void, get-status,
document-fetch) in the same discipline as `src/clickup/client.js:104-209`:
- **Token cache:** the JWT access token is valid ~1 h with **no refresh token** — cache it in memory,
  mint a new one ~15 min before expiry. Never per-request (the stub currently mints per call,
  `docusign.js:50` — fix when productionizing).
- `AbortController` timeout (~20 s), `MAX_TRIES=3` in-call, **honor `Retry-After`**, exponential backoff
  + jitter, `isRetryableStatus` (429/5xx retryable; 4xx fast-fail), tag thrown errors
  `retryable/status/retryAfter` so the send-queue classifier (§2) works.
- **Always branch on `error_description`**, not just `error`, for JWT failures.
- Keep the in-call retry budget small; the durable queue owns the long game (and never blind-retries a
  possibly-successful create — §1).

---

## 11. Config / secrets / staging

- **Dormant-until-configured** (already correct in the stub): the send route + queue drainer early-return
  when `!docusign.configured()` (`docusign.js:15-18`). Add a master switch **`DOCUSIGN_ENABLED`** (mirror
  `clickupSyncEnabled` `config.js:214`, default off) so the whole integration stages safely.
- **`DOCUSIGN_CONNECT_HMAC_KEY`** (new env) for §3; fail-closed-in-prod on the webhook when unset.
- RSA private key + Connect key are **secrets → env only, never a tracked file**; a chat-pasted secret is
  compromised → rotate (`CLAUDE.md` final rule). `resolveSecret` fail-closed pattern (`config.js:34-50`).

---

## 12. New tables / routes to add (summary)

| Add | Model on | Purpose |
|---|---|---|
| `esign_envelopes` v2 (state machine + `send_claimed_at`, `envelope_id`, `purpose`, UNIQUE `(application_id,purpose)`) | `db/037:79-92` + `applications.sync_state` CHECK | Per-envelope lifecycle + the §1 send-once claim |
| `esign_envelope_docs` (envelope↔doc↔condition map) | new | One envelope → several signed docs → several conditions (BLUEPRINT §7.1) |
| `sync_queue` `target` widened to `docusign` (or `docusign_send_queue`) | `db/schema.sql:302-317` + `db/041:60-63` | Durable outbound (§2) |
| `docusign_event_inbox` | `clickup_webhook_inbox` (`db/042:35-49`) | Idempotent Connect inbox (§3) |
| `docusign_write_log` (or reuse `clickup_write_log`) | `db/107:15-31` | PII-free journal (§7) |
| DB-backed send-breaker counter | `circuitCheck` (`orchestrator.js:479-507`) | Multi-instance-safe volume cap (§2) |
| `src/routes/docusign-webhook.js` | `src/routes/clickup-webhook.js` | The Connect listener (§3) |
| `src/routes/esign-return` (+ `/esign/landing`) | `/link/r` bounce (`server.js:191+`) | Return-to-file redirect (§9) |
| `sync_review_queue` new reasons/actions | `sync-file-review.js:26` | Dead-letter/decline/void/bounce review (§5) |
| `esign` audit category + `DOCUSIGN_*` config | `audit-actions.js`, `config.js:251-260` | Audit + staging (§7/§11) |

---

## 13. Two values to confirm against the live (JS-rendered) reference before shipping
- Exact **`X-DocuSign-Idempotency-Key` window** + replay-response semantics (createEnvelope reference).
- Current **per-file size ceiling** (25 vs 50 MB) + the ~35 MB request cap (file-size-limits article). And
  confirm your account's **Connect retry count/duration** in Settings → Connect → Logs.

---

## 14. Sources
DocuSign failure modes: JWT/consent https://www.docusign.com/blog/developers/oauth-jwt-granting-consent ·
invalid_grant keys https://community.docusign.com/authentication-67/invalid-grant-no-valid-keys-or-signatures-4105 ·
idempotency header https://www.docusign.com/blog/developers/dsdev-from-the-trenches-working-with-headers-in-docusign-sdks ·
rate limits https://www.docusign.com/blog/developers/dsdev-from-the-trenches-api-rate-limits · Connect
failures/retries https://support.docusign.com/s/document-item?bundleId=vob1727899215236&topicId=qmr1583277386549.html ·
Connect HMAC https://developers.docusign.com/platform/webhooks/connect/hmac/ · embedded URL TTL
https://www.docusign.com/blog/developers/long-lived-embedded-signing-urls · bounce/AUTORESPONDED
https://support.docusign.com/s/articles/Why-am-I-getting-the-error-Recipient-email-bounced-after-sending-a-document ·
resend https://www.docusign.com/blog/developers/common-api-tasks-resend-your-envelope-programmatically ·
void/correct FAQs https://support.docusign.com/s/articles/FAQs-related-to-Voiding-Envelopes-in-DocuSign ·
status codes https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/envelopes/status-codes/ ·
go-live consent https://community.docusign.com/esignature-api-63/consent-required-problem-after-go-live-25783
Branding: https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/branding/ · apply brand
https://developers.docusign.com/docs/esign-rest-api/how-to/apply-brand-to-envelope/ · sender name
https://community.docusign.com/esignature-111/is-there-a-way-to-change-the-name-of-the-sender-for-recipients-of-an-envelope-22331 ·
destination URLs https://support.docusign.com/s/document-item?bundleId=pik1583277475390&topicId=tad1583277330037.html ·
embedded returnUrl events https://www.docusign.com/blog/developers/the-trenches-real-time-updates-embedded-signing-workflow
Our guards (file:line): `src/routes/borrower.js:314-319`, `src/sync/clickup-sync.js:49-126`,
`src/clickup/orchestrator.js:479-532`, `src/routes/clickup-webhook.js`, `src/lib/resend-webhook.js`,
`src/lib/sync-review.js`, `src/lib/sync-file-review.js`, `db/107`/`db/108`/`db/110`,
`src/clickup/client.js:104-209`, `src/config.js:34-50`, `src/lib/email/catalog.js:200-207`,
`src/lib/notify.js:229-256`, `app-v2/src/App.jsx:105`, `src/server.js:191+`.
