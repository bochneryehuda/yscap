# DocuSign Integration — Bug Register (pre-go-live)

_Consolidated findings from the multi-round adversarial bug-hunt the owner asked for ("build this
slower and find a lot of bugs"). Every row is a concrete defect with a file:line, a reproduction, a
severity, and a status. **Nothing here is a blocker to the DOCUMENT work already done — it is the
punch-list that must be clean before the portal integration goes live.** Companions:
`DOCUSIGN-INTEGRATION-BLUEPRINT.md`, `DOCUSIGN-DOCUMENT-BUILD-SPEC.md`,
`DOCUSIGN-ERROR-HANDLING-AND-HARDENING.md`, `DOCUSIGN-SECURITY-AND-COMPLIANCE.md`._

Status legend:
- **FIXED** — corrected + verified in this branch.
- **TO-FIX-IN-BUILD** — the defect is in the *stub* (`src/lib/integrations/docusign.js`) or the schema;
  it gets fixed as part of writing the real integration (the stub is deliberately a framework-only
  placeholder that throws until configured — it is not wired into any live path yet).
- **DESIGN-RESOLVED** — a design contradiction in the spec docs, now reconciled in the doc.

---

## A. Application-export generator (`web/tools/loan-application-export.html`) — ALL FIXED + verified

The jsPDF generator that builds the borrower application PDF (with the invisible DocuSign signature
anchors). Found by an adversarial render-and-inspect pass; each fix re-verified by rendering the PDF
headless (Playwright + the vendored jsPDF engine) and reading the output back.

| ID | Severity | Defect | Fix | Verified |
|----|----------|--------|-----|----------|
| H-1 | High | `save()` was called before `footer()`, so the last page shipped with no footer/branding. | Call `footer()` on the final page *before* `doc.save()` / base64 return. | Re-render: footer present on every page incl. the last. |
| H-2 | High | A row whose value stripped to whitespace (e.g. a Hebrew-only legal name that the Latin-1 core font renders as a space) still drew the label + an empty value, leaving a mislabeled blank line. | `rowFull`/`sigBlock` guard `if(!/\S/.test(sv)) return;` — a value with no non-space glyph omits the whole row. (First attempt `if(!sv) return` failed because a single space is truthy.) | Re-render: "Full legal name" row omitted for a Hebrew name; Latin fields (DOB) still present. |
| M-2 | Med | The "Signatures" band could orphan at the very bottom of a page, splitting the signature block from its anchors. | `brk(140)` before `band("Signatures")` forces a page break if < 140pt remains. | Re-render: signature band + anchors always start with room. |
| M-3 | Med | `fit()` truncation was applied inconsistently, so a long entity/property name overran the column. | Route every long single-line value through `fit()`. | Re-render: long names ellipsize inside the column. |
| M-4 | Med | If the vendored jsPDF `<script>` failed to load, `generate()` threw an opaque `jsPDF is not defined`. | `onerror=` handler + an explicit "engine failed to load" surface. | Forced load failure → clear message, no crash. |
| L-1 | Low | No public "is the engine ready" signal for the portal host to await. | `window.APPEXPORT.ready()` + a jsPDF-loaded guard inside `generate()`. | `ready()` returns true only after the engine parses. |

_Commit: `ecbaf21` (fix(draft): resolve bugs found in the application-export bug-hunt)._

---

## B. Integration stub (`src/lib/integrations/docusign.js`) — TO-FIX-IN-BUILD

The stub is framework-only: `configured()` is false without env, and `ensure()` throws
"DocuSign not configured" so nothing runs by accident. These are the defects the real build must not
inherit when it fleshes the stub out. **None of these can fire today** (no live caller), but each is a
real bug the moment the stub is activated as-is.

| ID | Severity | Location | Defect | Required fix |
|----|----------|----------|--------|--------------|
| H-3 | High | `docusign.js` `accessToken()` + `sendForSignature()` | `const j = await r.json()` runs **before** `if(!r.ok)`. A non-JSON error body (an HTML 5xx from a proxy, an empty 429 body, a gateway timeout page) makes `r.json()` throw `SyntaxError`, which **masks the real HTTP status** and misroutes retry classification (§2 of the hardening spec). | Read `r.text()` first, branch on `r.ok`, then `JSON.parse` in a try/catch. Surface the status code + a body snippet on failure. |
| M-5 | Med | `sendForSignature()` | Anchor string is hardcoded `'/sig1/'`, one signer, one `signHere` tab. Real packages have borrower + optional co-borrower, per-recipient + documentId-scoped anchors (`/app_b1_sig/`, `/app_b2_sig/` …), and `anchorIgnoreIfNotPresent`. | Build recipients + tabs from the envelope spec (`DOCUSIGN-DOCUMENT-BUILD-SPEC.md` §signer-model); never a global `/sig1/`. |
| M-6 | Med | `accessToken()` | Mints a fresh JWT + does the token exchange on **every** call — no cache. Under load this burns the JWT rate limit and adds latency to every send. | Cache the access token (~1 h TTL, refresh at ~55 min, no refresh-token flow) as the hardening spec §10 describes. |
| M-7 | Med | `sendForSignature()` | No `X-DocuSign-Idempotency-Key` header → a retried/duplicated POST creates a **second envelope** (two borrower emails). | Add the deterministic idempotency key (hardening §1 layer 2), persisted on the row for reclaim replay. |
| M-8 | Med | both `fetch()` calls | No timeout / AbortController. A hung DocuSign socket hangs the request (and, if inline, the send queue slot) indefinitely. | Wrap each `fetch` in an AbortController with a bounded timeout; a timeout is the outage retry class. |
| M-9 | Med | `config.js:257` → `accessToken()` | `privateKey` is read raw from env with **no `\n` normalization**. If the PEM is stored with literal `\n` escapes (common in some env UIs), `crypto.createSign().sign()` fails with an opaque decode error. Render's multi-line box preserves real newlines, so it *may* work — but it's fragile. | Normalize in config: `privateKey && privateKey.replace(/\\n/g, '\n')`. Fail-closed with a clear message if the key doesn't parse. |
| M-10 | Med | `sendForSignature()` | The envelope carries **no** per-envelope `eventNotification` (Connect webhook), **no** `envelopeCustomFields` (our application-id correlation), **no** `brandId`. Without these the webhook can't be correlated back to a file and PILOT branding is missing. | Attach `eventNotification` (per-envelope Connect + HMAC), `textCustomFields` (applicationId + purpose), and `brandId` on create (hardening §3, §8). |
| L-2 | Low | `accessToken()` / `sendForSignature()` | (a) No `getUserInfo` call to discover the account's true `base_uri` — a hardcoded `baseUri` breaks if DocuSign routes the account to a different data center. (b) No argument validation on `sendForSignature` (a missing `signer.email` becomes an `INVALID_EMAIL_ADDRESS` round-trip). (c) `iat: now` with no clock-skew backdating — a slightly-fast clock yields `invalid_grant`. | Discover `base_uri` via `/oauth/userinfo` once and cache; validate args before the call; backdate `iat` ~60 s. |

---

## C. Design contradictions in the spec — DESIGN-RESOLVED

These were internal contradictions between the design docs and the *actual* schema/reopen logic. Each
is now corrected in the referenced doc so the build can't be written against a wrong assumption.

| ID | Severity | Where | The contradiction | Resolution (in-doc) |
|----|----------|-------|-------------------|---------------------|
| H-4 | High | hardening §1 layer 3 | A plain `UNIQUE(application_id, purpose)` on `esign_envelopes` would **permanently block re-issuing** a package (appraisal-stale reissue, void-then-resend), because a completed/voided row still occupies the pair. | Replaced with a **partial** unique index `uq_esign_inflight … WHERE status IN ('not_sent','sent','delivered')` — one *in-flight* envelope per package, terminal states free the pair for re-issue. |
| H-5 | High | hardening §1 layer 1 | The send-once claim wrote `status='sending'` / filtered `status='draft'`, but `db/037:86`'s CHECK allows **only** `not_sent\|sent\|delivered\|completed\|declined\|voided\|error` — the claim would violate the CHECK and abort every send. | Claim now rides a new `send_claimed_at` column (`WHERE envelope_id IS NULL AND send_claimed_at IS NULL`); `status` only moves inside the existing enum (`not_sent`→`sent`). |
| M-11 | Med | reopen family (`db/096`) vs. new app-signed condition | `db/096` reopens the signed **term sheet** condition (`rtl_cond_signedts`) on an economics change, but the new **business-purpose / application-signed** condition (created by this build) is **not** in any reopen trigger — so a stale signed application could survive an economics change while the term sheet correctly reopens (**asymmetric reopen**). | Documented in hardening §6 as a build task: the new signed condition(s) must be added to the `db/071/072/074/096` reopen family in the same migration that creates them. |
| M-12 | Med | hardening §1 | A crash **after** the claim but **before** `envelope_id` is written leaves a row "claimed, no envelope" that a `send_claimed_at IS NULL` filter would never re-drive. | §1 layer 1 now specifies a **stale-claim reclaim** (`send_claimed_at < now()-5min AND envelope_id IS NULL`) that **replays the same deterministic idempotency key** — DocuSign returns the original or creates the first, never a duplicate. |
| M-13 | Med | env / go-live reasoning | "It's the demo account, so it's safe" is **false reasoning**: the demo creds are set on the **production** Render service, so a live code path could mail a **real** borrower a watermarked, non-binding demo envelope. | Documented as a build gate: at go-live the send path must be **gated on an allow-listed set of test emails** while on demo creds, and the demo→prod credential swap is an explicit, audited promotion (never "demo is harmless"). Captured in `DOCUSIGN-SECURITY-AND-COMPLIANCE.md`. |
| L-3 | Low | hardening §2 breaker | The send circuit breaker counts `esign_envelopes.created_at` in the window, but a row is created (draft) well before it is *sent* — so the breaker could misjudge the true send rate. | Documented: the breaker must count on a **send-time** column (`send_claimed_at`/`sent_at`), not `created_at`. |

---

## D. Cross-cutting guardrails re-confirmed (not bugs — invariants the build must keep)

These aren't defects; they're the invariants the bug-hunt confirmed the build must preserve. Listed here
so a future change can't quietly regress one.

1. **`heter_iska_signed` must NEVER enter the TPR export or SharePoint** — add the denylist guard to
   `tpr-export.js` and `sharepoint-backup.js` **now**, before any producer exists (hardening §6 item 7).
2. **A completed signature with no stored PDF must dead-letter to review**, never be silent — the
   `docKind` whitelist in **both** `staff.js:5107` and `borrower.js:1990` must be extended for the signed
   kinds *before* any completion handler writes (hardening §6 item 6).
3. **Auto-clear goes through `signOffGate(itemId, null)`** — never the direct `status='satisfied'`
   gate-bypass precedents (`llc.js:325`, `liquidity.js:100`, `experience.js:150`); the null actor keeps
   the doc-present check armed (hardening §6 item 4).
4. **The send circuit breaker must be DB-backed** (multiple Render instances each hold an independent
   in-process counter), checked in the same transaction as the layer-1 claim (hardening §2).
5. **Full SSN on the application PDF** is an explicit owner directive — not a leak to "fix." It stays.

---

## E. Build-phase audit rounds — findings FIXED as the code was written

The stub defects in §B were resolved by the Phase-2 rewrite (`src/lib/integrations/docusign.js`) — H-3,
M-5..M-10, L-2 are all implemented. A dedicated adversarial audit of the Phase-1+2 code then surfaced a
further punch-list (all in not-yet-live code; **all now FIXED + re-tested**):

| ID | Severity | Location | Defect | Fix |
|----|----------|----------|--------|-----|
| H-A | High | `docusign.js` `resendEnvelope` | `PUT /envelopes/{id}/recipients?resend_envelope=true` with an empty `{signers:[]}` body re-notifies **nobody** — the "Resend" button would silently do nothing. | Use `PUT /envelopes/{id}?resend_envelope=true` (the envelope-update endpoint) with `{}` — re-notifies all outstanding recipients. |
| M-A | Med | `docusign.js` HTTP layer | A **401** (stale/raced token) was classified permanent → a send that would succeed on re-mint got dead-lettered. | `authedJson`/`authedBinary` wrappers: on a 401, `invalidateToken()` + re-mint **once**; a persistent 401 still surfaces for a human (real consent/key problem). |
| L-A | Low | `buildEnvelopeDefinition` | `routingOrder` defaulted to `recipientId` → co-signers went **sequential**; an embedded view for signer 2 before signer 1 finishes throws `RECIPIENT_NOT_IN_SEQUENCE`. | Default **parallel** routing (all order `1`); pass an explicit `routingOrder` to force sequential. |
| L-B | Low | `httpJson`/`httpBinary` | The timeout was cleared right after headers, so a stalled **body** read could hang past `httpTimeoutMs` (esp. binary PDF/cert downloads). | Keep the timeout armed through the body read (`clearTimeout` in `finally`); AbortError during the read maps to `DOCUSIGN_TIMEOUT`. |
| L-C | Low | `createRecipientView` | `returnUrl` was only checked for `https?://` — a future caller could introduce an open redirect through DocuSign's post-sign bounce. | Pin `returnUrl` to our own **app origin** (`cfg.appUrl`) as defense-in-depth. |
| L-D | Low | `createEnvelope` | A create that requested `status:'sent'` but came back `created` (a silent draft — no email, no error) was recorded as sent. | Assert: a `sent`-requested envelope returning `created` throws `DOCUSIGN_NOT_SENT` (retryable) instead of a false "sent." |
| L-E | Low | `eventNotification` | Envelope-event status codes were lowercase, recipient-event codes capitalized (Connect is case-insensitive, so not a confirmed bug). | Normalized both to DocuSign's documented capitalization. |

_Verified: `scripts/test-docusign-lib.js` (23 pure-logic assertions incl. L-A parallel routing + L-C
origin pin) and `scripts/test-esign-send.js` (21 DB-backed send-once assertions) — all pass._

---

## F. Signing-redirect + sending-identity research round — designed-out before build

Bug-hunt on the post-signing redirect + the single "PILOT by YS Capital" sender (full design in
`DOCUSIGN-REDIRECT-AND-ACCOUNT-SETUP.md`). These are **designed out** — the Phase-6 build follows the
bounce-endpoint pattern rather than the naive approach, so they never ship.

| ID | Severity | Defect (naive approach) | Design that prevents it |
|----|----------|-------------------------|--------------------------|
| RB-A | **Blocker** | A hardcoded `?signed=1` (or any redirect param) is present on **decline/cancel/timeout** too — DocuSign uses the same returnUrl for every outcome and only varies `event=`. Trusting it marks a declined file as "signed"; anyone can type `?signed=1`. | Redirect is a **UI hint only**; the condition clears solely from the HMAC-verified Connect webhook + `Envelopes:get`. `signed=1` is attached by **our** server only after it confirms completion. |
| RB-B | **Blocker** | HashRouter footgun: DocuSign concatenates `event=` onto `…/#/app/123`, so it lands **inside the `#` fragment** — `window.location.search` is empty, unreadable; fragments also drop across 302s. | A **non-hash server bounce endpoint** `/api/esign/return?app=&env=` reads `event` reliably, verifies status, then 302s into `#/app/<id>?signed=1`. The fragment is added by us, after DocuSign is out of the loop. |
| RB-C | High | Redirect vs Connect webhook **race** (webhook is 20s–min late, not guaranteed) → file shows "awaiting signature" after the borrower just signed, or vice-versa. | Backend is the single source of truth; the bounce endpoint polls `Envelopes:get` with short backoff; whichever of {webhook, poll} arrives first is applied idempotently. |
| RB-D | High | Email signers have **no per-envelope API redirect** — a Brand Destination URL is account/brand-global, so it can't know which file. | Carry the loan id via an **Envelope Custom Field** (`LoanFileId`) merge field in the Brand Destination URL → the same bounce endpoint. |
| RB-E | High | The single dedicated sender is a **SPOF**: deactivation / lost consent / wrong GUID kills ALL sending with an obscure auth error (`consent_required`, `user_not_found`). | Scheduled sender **health check** (`ping()`) with alerting; assert GUID (not email), pin per environment. |
| RB-F | Med | The embedded recipient-view URL is single-use + ~5-min TTL; storing/reusing it 404s or double-fires. | Mint on demand right before launch; regenerate on `session_timeout`/`ttl_expired`; guard against double-generation (React double-render/back button). |
| RB-G | Med | Co-borrower: the first signer's `signing_complete` fires while the envelope is still `sent` → "all done" shown wrongly. | Distinguish **recipient-complete** vs **envelope-complete** in the thank-you copy. |
| RB-H | Med | "via DocuSign" from `dse@docusign.net` is a heavily-impersonated phishing brand; bounces/spam strip an email-only signer of any path to the file. | **Embedded-first** signing (no email); email as fallback with Connect non-delivery monitoring + a "sign in the portal" nudge. |

---

## G. Live production defects — FIXED

Defects found on the LIVE integration (real sends, real files), after go-live.

| ID | Severity | Location | Defect | Fix | Verified |
|----|----------|----------|--------|-----|----------|
| P-1 | **High** | `esign/orchestrate.js` `PACKAGES[*].subject` → `docusign.js` `buildEnvelopeDefinition` | **DocuSign caps `emailSubject` at 100 characters and REJECTS the whole create over it** (400 `INVALID_REQUEST_PARAMETER` — "Length exceeds the maximum of 100 characters for 'emailSubject'"), so the envelope is never sent at all. Nothing in the codebase knew the limit existed. The subject is concatenated from a fixed 24–37-char package wording + `Loan #` + a 14-char YS loan number — ~60 characters spent before the property address is appended (added 2026-07-21 so a counter-signer can tell which property) — leaving barely **37 characters** for the address. Reported on Pinches Lichtman / YSCAP258134736: `Your loan documents are ready to sign — Loan #YSCAP258134736 · 129 Carlisle St, Wilkes-Barre, PA 18702` = **102 chars**. The address was entirely ordinary; ANY address over ~37 characters failed, so this hit a large share of files from 2026-07-21 onward — and it fails identically for the Heter Iska and draw-request packages. | Two layers. **(1) Structural backstop at the chokepoint:** `capEmailSubject()` in `docusign.js` clips to 100 (surrogate-safe) and `buildEnvelopeDefinition` — which EVERY envelope in the system is built by — applies it, so no caller present or future can post an over-long subject. **(2) Smart fit in the composer:** `composeSubject()` keeps the package wording + loan number whole (what signers and the admin counter-signer identify the request by) and shortens only the address via `fitAddress()`, which drops the least-identifying end first (zip → state → city), so the reported case becomes `… · 129 Carlisle St, Wilkes-Barre, PA` (96 chars) instead of a mid-word chop. A subject that already fits is byte-identical to before. | `scripts/test-esign-subject.js` (107 assertions): the reported case as a regression fixture, every package × a battery of real-shaped addresses always ≤100 with the loan number intact, `fitAddress` degradation order, the chokepoint cap, and surrogate-pair safety. |
| P-2 | **High** | `docusign.js` `eventNotification` (the per-envelope Connect subscription) | **Every envelope's own webhook subscription was posted UNSIGNED.** The receiver (`routes/esign-webhook.js`) verifies the Connect HMAC and rejects an unsigned post with 401, fail-closed by design — but `eventNotification` never set `includeHMAC`, so DocuSign posted every event of every envelope we created bare, got 401 ten times, and parked it in the account's Connect failure log (56 envelopes deep on 2026-09-02, all `(401) Unauthorized`). Status only ever reached the file through the poller. The account-level "PILOT portal" Connect configuration had HMAC off as well, for the same net effect. Not a volume problem: the account's hourly API budget stood at 2,890 of 3,000 remaining while this was diagnosed. | `includeHMAC: 'true'` on the per-envelope subscription (DocuSign signs with the account's Connect keys); the account-level configuration switched to Include HMAC with a Connect key equal to `DOCUSIGN_CONNECT_HMAC_SECRET`, verified by DocuSign's own Connect log answering `{"ok":true}`. Envelopes created BEFORE this keep their unsigned subscription for the rest of their life (a sent envelope's subscription cannot be edited) — they are served by the account-level configuration and will keep adding rows to the failure log until they finish; expected, not a regression. | `scripts/test-docusign-lib.js` (`includeHMAC === 'true'`); live: Connect log 2026-09-02 17:07Z |
| P-3 | **High** | `esign/orchestrate.js` `buildDefinition` + `web/v2/tools/termsheet.js` (the studio) | **A term sheet drawn without the co-borrower went out on a two-borrower file** (YSCAP258134773): it printed `Guarantor: <one name>` and one borrower signature block, the co-borrower's `/ts_b2_sig/` anchor was never on the page, and because anchor tabs are `anchorIgnoreIfNotPresent` DocuSign placed the co-borrower on the application and the disclosure and NOT on the term sheet — no error anywhere. The sheet's guaranty wording takes BOTH names from the studio's one co-borrower box, so an empty box also names one guarantor where the file has two. | `esign/term-sheet-signers.js` — the send reads the sheet's text layer (the same layer DocuSign places tabs by) and REFUSES, permanently (`TERM_SHEET_SIGNERS_MISMATCH`), a sheet with no `/ts_<role>_sig/` for any roster signer, or a co-borrower line on a file with none; `tabsFor` and the check share ONE role→anchor map. `tracking.termSheetStampBlock` reads the same rule so the panel blocks FIRST and routes Send through "Finalize & send"; the staff pricing payload carries `parties` read by the server for that response and the studio prefills the co-borrower box from it, over the screen's possibly-stale copy of the file. | `scripts/test-esign-term-sheet-signers-pure.js` (37), `scripts/test-esign-orchestrate.js` (send refusal + panel block, real PDF fixtures) |
| P-4 | Med | `esign/webhook.js` `drainInbox` | One signature arrives as a burst of Connect events (recipient-completed, envelope-delivered, recipient-sent…) and, with both the account-level configuration and the envelope's own subscription posting, each arrives twice — and every inbox row cost its own `Envelopes:get`. | Rows are grouped by envelope per drain: ONE reconcile serves them all (all marked processed together, or all count a failed attempt together). | `scripts/test-esign-orchestrate.js` (drain path) |
| P-5 | Med | `esign/poller.js` `reconcileStale` | An envelope sent in the last 180 minutes was re-read EVERY 60-second tick — 60 `Envelopes:get` an hour per in-flight envelope, DocuSign's published polling violation (at most once per 15 minutes per envelope). It existed only because the webhook was silently rejected (P-2) and the poll was the only way a signature reached the file. | Active envelopes re-read no more often than `DOCUSIGN_ACTIVE_RECONCILE_EVERY_MIN` (default 15, DocuSign's floor) for the `ACTIVE_MIN` window, then the 30-minute stale belt. News travels through the verified webhook; the poll is the belt for a MISSED event. | boot log line names the cadence |
| P-6 | Med | Long-Term `src/longterm/vor/desk.js` `reconcileOpenEnvelopes` | The rent-verification (VOR) desk asked DocuSign about EVERY open envelope on every 5-minute sync tick — the same polling violation as P-5 on the Long-Term side (owner-directed 2026-09-02: "make the LT VOR poll also follow the 15 minute rule"). | Each envelope carries `docusign_checked_at` (db/684); a pass asks only about envelopes not asked about in the last `POLL_EVERY_MIN` minutes (15, a floor — `LT_VOR_DOCUSIGN_POLL_MIN` may only raise it), stamped BEFORE the call so an outage is paced like a success. Written fresh in the LT zone — no RTL code crossed. | `scripts/test-lt-vor-pure.js` + `scripts/test-lt-vor-db.js` (section I; two mutations proven to fail) |
| P-7 | Med | `routes/staff.js` pricing GET `parties.loanOfficer` · `esign/orchestrate.js` `loanOfficerSigner` · `ProductStudioPanel.jsx` / `TermSheetStudio.jsx` | The studio drew the loan officer's signature line from the SCREEN's copy of the file (name only — never the email or NMLS), so an officer assigned after the page loaded got no line; the send then correctly refused the sheet (P-3's guard) and "Finalize & send" redrew the same wrong sheet until a refresh — a dead end nobody was told about. The send decided the officer by a different rule (`loan_officer_id` + staff email). | `orchestrate.loanOfficerSigner` is ONE rule read by the roster AND the pricing read; the studio draws the officer from `parties.loanOfficer` (fresh per response, NMLS included) and re-publishes a changed officer to the tool without a remount. Owner-confirmed 2026-09-02. | `scripts/test-esign-term-sheet-parties-db.js` (real HTTP) + section E of `test-esign-term-sheet-signers-pure.js`; three mutations proven to fail |
