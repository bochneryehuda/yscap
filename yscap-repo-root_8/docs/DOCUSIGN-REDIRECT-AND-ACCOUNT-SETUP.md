# DocuSign — Post-signing Redirect, Sending Identity & Account Setup

_Build reference produced from a 3-agent research + bug-hunt round (2026-07-19), answering the owner's
questions about (1) landing every signer back in their PILOT loan file after signing, (2) sending from a
single "PILOT by YS Capital" user, and (3) which DocuSign features/app-settings to turn on. Sources are
cited inline. This anchors the Phase-6 redirect build so nothing is guessed. Companion to
`DOCUSIGN-ERROR-HANDLING-AND-HARDENING.md`, `DOCUSIGN-SECURITY-AND-COMPLIANCE.md`, `DOCUSIGN-BUG-REGISTER.md`._

---

## 1. Post-signing redirect — land the signer back in their file (the safe design)

**Requirement:** after signing — whether the borrower clicked **inside the portal** (embedded) or **in the
email** (remote) — they must land back on their PILOT loan file, see "Thank you for signing," with the file
open.

**Two BLOCKER traps the naive approach hits (bug-hunt A + B):**
- **B-A — a redirect parameter is NOT proof of signing.** DocuSign redirects to the *same* returnUrl for
  every outcome (complete, decline, cancel, timeout, exception) and only varies an appended `event=` value.
  A hardcoded `?signed=1` would therefore show "thank you for signing" even to someone who **declined** — and
  anyone can type `?signed=1` into the address bar. Truth comes only from the Connect webhook + `Envelopes:get`.
- **B-B — the HashRouter fragment footgun.** Our portal URLs look like `…/portal/#/app/123`. DocuSign
  appends `event=` by string concatenation, so it lands **inside the `#` fragment**; `window.location.search`
  is empty and the value is unreadable. Fragments are also routinely dropped across 302 redirects and are
  forbidden in OAuth redirect URIs.

**The design (kills both at once): a non-hash server bounce endpoint.**
Mirror the existing `/link/r` bounce-route pattern. DocuSign is pointed at a plain server URL; the server
verifies the truth and only THEN 302s into the hash route.

```
returnUrl / Destination URL handed to DocuSign (NO '#'):
    https://www.yscapgroup.com/api/esign/return?app=<loanId>&env=<envelopeId>

DocuSign appends cleanly:
    …/api/esign/return?app=<loanId>&env=<envelopeId>&event=signing_complete

The /api/esign/return handler then:
  1. reads `event` reliably (real top-level query string),
  2. VERIFIES the envelope/recipient status server-side (Envelopes:get, or our own
     esign_envelopes row updated by the HMAC-verified Connect webhook),
  3. 302-redirects into the hash route, adding signed=1 ONLY when truly complete:
        302 → https://www.yscapgroup.com/portal/#/app/<loanId>?signed=1
     on decline/timeout/not-complete → 302 to an honest state (…?esign=declined / …?esign=pending)
```

The fragment is added by **us**, after DocuSign is out of the loop, so it can never be mangled or dropped;
and `signed=1` is attached only when the backend actually saw completion. The portal still treats `signed=1`
as a *UI hint to refresh + show the thank-you*, never as the source of truth (the condition clears from the
webhook).

**Per-`event` handling** (embedded returnUrl values — bug-hunt Area 1):
| `event` | Meaning | UI on return |
|---------|---------|--------------|
| `signing_complete` | this recipient finished | "Thanks — confirming your signature…", reconcile vs backend |
| `viewing_complete` | opened but did NOT sign | back to file, signing still pending |
| `decline` | declined | neutral "you declined — contact your loan officer"; flag internally |
| `cancel` | backed out | back to file, offer "resume signing" |
| `session_timeout` / `ttl_expired` | the 5-min embedded URL expired | regenerate a fresh recipient view, don't hard-error |
| `exception` | DocuSign-side error | retry + log |
| `fax_pending` | out-of-band pending | treat as not-complete |

**Email (remote) signers** have **no per-envelope API redirect** — the ONLY mechanism is a **Brand-level
Destination URL** (Settings → Brands → Signing brand → Advanced → Destination URLs; one URL per outcome:
Signing Completed / Decline / Session Timeout / etc.). Point the **Completed** destination at the SAME
`/api/esign/return` bounce endpoint, and carry the loan id via an **Envelope Custom Field** merge field:
set `LoanFileId=<id>` on the envelope at create time, then the brand URL is
`https://www.yscapgroup.com/api/esign/return?app=[[LoanFileId]]&env=[[EnvelopeID]]`. (`embeddedRecipientStartURL`
does NOT redirect a pure email signer — it's ignored without a `clientUserId`.) Leave account-level
**In-session Landing Pages** blank so they can't override the per-call embedded returnUrl.

**Embedded (in-portal) signers**: pass the per-call `returnUrl` = the bounce endpoint into
`createRecipientView` (already built, origin-pinned). Prefer embedded-first (bug-hunt H): it bypasses email
entirely, sidestepping DocuSign-phishing distrust + bounce/spam.

**Source of truth = the webhook, not the redirect (bug-hunt C).** The redirect fires instantly; the Connect
webhook can arrive 20s–minutes later and isn't guaranteed. So the bounce endpoint may poll `Envelopes:get`
with a short backoff to reconcile, and the condition auto-clear happens only from the HMAC-verified webhook
(`esign_envelopes` row). Redirect-before-webhook and webhook-before-redirect are both handled idempotently.

**Co-borrower / multi-signer (bug-hunt G):** distinguish **recipient-complete** from **envelope-complete** —
the first signer's `signing_complete` fires while the envelope is still `sent`. Show "your part is done —
waiting on the co-borrower" vs "all signatures complete."

_Sources: createRecipientView reference; "From the Trenches: real-time updates" (don't trust the redirect);
community "redirect after email signing" (Brand Destination URLs); "Destination URLs for post-signing
navigation" (Envelope Custom Field merge fields); embedded-signing concepts (5-min single-use URL)._

---

## 2. Sending identity — one "PILOT by YS Capital" user (owner's main question)

The system sends **as the one user we impersonate** (JWT `sub` = that user's API User ID GUID). **That
user's display name is the "From" name** on every notification email. So:

1. **Create or rename ONE user** to exactly **`PILOT by YS Capital`** (Settings → Users). Give it a
   permission profile that **allows sending** — the built-in **DS Sender** profile is the minimum (DS Admin
   is only needed to *create* users / manage brands, not to send).
2. **Grant the one-time JWT consent for THAT user** (individual consent URL, scopes `signature impersonation`,
   granted against the correct host — demo `account-d.docusign.com` vs prod `account.docusign.com`). Consent
   is keyed to **(integration key, user GUID)** — renaming the *display name* does NOT disturb consent, but
   **replacing the user with a different GUID requires re-consent**.
3. **Find the User ID (GUID):** Settings → **Apps and Keys** (for the logged-in user, under "My Account
   Information → User ID"), or Settings → **Users → open the user** (its API user id). Set
   `DOCUSIGN_USER_ID` to that GUID. Our `ping()` self-test reports back the impersonated user's name/email so
   you can confirm it reads "PILOT by YS Capital" before anything real goes out.
4. **The "via DocuSign" text + the `dse@docusign.net` from-address cannot be changed** without DocuSign's paid
   **Custom Email Domain** add-on (enterprise, needs domain verification). The **display name**
   ("PILOT by YS Capital") works out of the box; emails read **"PILOT by YS Capital via DocuSign."**

**Single-sender is a single point of failure (bug-hunt E) — build a health check.** If that user is
deactivated / loses consent / the GUID is wrong, **every** send fails at token time with an auth error
(`consent_required`, `user_not_found`, "no valid membership"), not a per-envelope error. Add a scheduled
health check that mints a JWT + calls a cheap endpoint (our `ping()`), alerting before a borrower is affected.
Assert `DOCUSIGN_USER_ID` is a GUID (not an email) and is pinned per environment (a demo GUID against the prod
host fails).

_Sources: JWT auth 101; OAuth JWT granting consent; obtaining individual consent; system sending email
addresses (Custom Email Domain); permission profile options; "UserID does not have a valid membership."_

---

## 3. DocuSign features — turn on / skip (for term sheet, disclosures, Heter Iska)

**Turn ON:**
- **Reminders** — chase unsigned envelopes automatically (API default is NONE; set e.g. first at ~2 days,
  repeat ~3 days). No cost.
- **Expiration** — give the offer a shelf life (API silently defaults to 120 days; set an explicit window,
  e.g. 30–60 days, + a "warn N days before"). No cost.
- **Allow decline** — a clean formal decline that notifies us. No cost.
- **A PILOT Brand** — logo + colors + signing-page look + the Destination URLs (§1). Enable
  `canSelfBrandSend`/`canSelfBrandSign`, create the brand, attach via `brandId` on the envelope.

**SKIP (for these documents):**
- **KBA / ID Check, IDV (government-ID), SMS/phone auth** — per-use fees + friction; reserve only for a
  specific high-value file if ever needed. Access-code auth is a low-assurance option if you want a light gate.
- **PowerForms, Bulk Send, In-person signing** — not our per-loan API model.
- **CFR 21 Part 11** — FDA life-sciences compliance; not applicable to a lender. Adds friction; skip.
- **CORS on the integration key** — only for browser-side JS calling DocuSign directly; we're server-side. Off.

_The Heter Iska is, to DocuSign, just another PDF with signHere tabs — no special feature. Its religious-law
validity is outside DocuSign's scope (confirm with the rabbinic/legal advisor)._

---

## 4. App-config checklist (what to set in the DocuSign app)

- **RSA keypair** — attached (Apps and Keys). This signs the JWT. ✔ (keypair ID present in the app)
- **Redirect URI** — needed only for the one-time consent click-through (e.g.
  `https://developers.docusign.com/platform/auth/consent` already set, or a `…/ds-consent-callback` on our
  domain). JWT token requests don't use it.
- **Privacy Policy URL** → `https://www.yscapgroup.com/privacy.html` (exists).
- **Terms of Use URL** → `https://www.yscapgroup.com/terms.html` (created this round). Both are shown on the
  OAuth consent screen; optional for a private/JWT integration but recommended, and expected if we ever go
  public. They must be **our** pages, not DocuSign's. Have counsel review both.
- **Authorization Code Grant / secret key** — NOT used by our automated (JWT) sending; the RSA keypair is the
  relevant piece. (Ignore that section for the send flow.)
- **Connect (webhook)** — the real signed-status source of truth. Per-envelope `eventNotification` (built) or
  an account Connect config to `https://www.yscapgroup.com/api/webhooks/docusign`, HMAC enabled
  (`DOCUSIGN_CONNECT_HMAC_SECRET`), events at least Envelope Completed/Declined/Voided + Recipient Completed.
- **ERSD (Electronic Record and Signature Disclosure)** — keep ENABLED (on by default); it carries the ESIGN
  consumer-consent disclosure at signing, so our website pages stay lighter.

**Go-live safety (env):** the send path is double-gated. `DOCUSIGN_SEND_ENABLED` (master, off by default) must
be on for anything to send at all; and `DOCUSIGN_TEST_MODE` (**on by default, on ANY host**) restricts sends
to `DOCUSIGN_TEST_EMAIL_ALLOWLIST` — so even after switching to LIVE production creds, real borrowers cannot
be mailed until `DOCUSIGN_TEST_MODE=0` is set at true go-live. The demo→production switch changes
`DOCUSIGN_USER_ID`, `DOCUSIGN_ACCOUNT_ID`, `DOCUSIGN_OAUTH_BASE=account.docusign.com`, and the production
RSA private key (which must match the RSA keypair added to the production app — Go-Live does NOT copy it).

---

## 5. New build tasks this research adds (folded into Phase 6)

1. **`GET /api/esign/return`** bounce route (server-side, non-hash): read `event`, verify status, 302 into
   `/portal/#/app/<id>?signed=1` (or an honest non-complete state). The ONLY redirect target given to DocuSign.
2. **Envelope Custom Field `LoanFileId`** on every envelope (already carried as a correlation custom field —
   extend so the Brand Destination URL merge field works for email signers).
3. **Recipient-view URL minted on demand** right before launching (never stored/reused); regenerate on
   `session_timeout`/`ttl_expired` (bug-hunt F). Guard against double-generation (React double-render/back).
4. **Portal thank-you state** driven by verified backend status, idempotent to back-button/re-entry
   (bug-hunt A, I); recipient-complete vs envelope-complete messaging (G).
5. **Sender health check** (§2) — scheduled `ping()` with alerting.
6. **Full-window (not iframe) embedded signing on mobile** (bug-hunt: iframe unreliable on mobile Safari/Chrome).
