# TPO PORTAL — build blueprint (owner-approved 2026-08-04)

A **wholesale / third-party-originator (TPO) channel** for the RTL product: a
third front door to PILOT where brokerage **firms** and their users originate
the loans we (the direct lender) fund. This is **RTL** — a TPO loan is an
ordinary `applications` row flagged `is_tpo`, not a third product. It never
touches the Long-Term system.

The owner approved the plan and the six decisions below on 2026-08-04 ("Go
ahead, let's start building this out"). This doc is the canonical reference for
the whole build; keep it current as phases land.

---

## 1. The role mapping (owner's words)

On a **TPO file** the "who's who" shifts:

| Role on the file | Who |
|---|---|
| **Loan officer** | the TPO **broker** (`applications.loan_officer_id` → the external staff_users row) |
| **Account executive** | OUR loan officer (an `application_assignees` row, role `account_executive`) |
| **Account manager** | OUR processor (assignee role `account_manager`) |
| **Firm processors** | the broker's own staff (external `tpo_processor` users) |
| **Borrower** | the borrower (keeps their own login by default — see decision 1) |

A **firm** is the unit of trust: every TPO user belongs to exactly one
`tpo_firms` row and sees ONLY that firm's TPO files and borrowers — never a
retail file, never another firm's.

## 2. Locked decisions (owner, 2026-08-04)

1. **Borrower keeps their own PILOT login by default**, and the broker may turn
   it **off per borrower** (`applications.borrower_portal_enabled`, default
   true) — when off, that borrower has no system access.
2. **Construction draws**: brokers **view / accept / dispute** on funded files
   (like a borrower).
3. **Own-Xactus (bring-your-own-credentials)**: a firm may save **their own
   Xactus username/password** (encrypted) and pull **and reissue** their own
   **credit** on it, OR use our account. **Credit only** on their account;
   **flood always uses ours**. **Not required** — our account is always an
   option. (There is only a parked, AVM-aimed "direct-source" stub today; the
   real per-firm-credential feature is a fresh build — see Phase 5.)
4. **Condition sign-off is always ours.** A broker uploads and requests; we
   clear/waive. Brokers never sign off, waive, or override a condition.
5. **Brokers/borrowers never see our internal company contacts** (no "account
   executive" contact card exposed to the borrower).
6. **AE/AM "view as TPO"**: our account executives & account managers can step
   INTO any of their TPO users' logins and see exactly what the broker sees —
   the same machinery as staff "borrower view" (Phase 6).

Plus: **V2 is the only version we use** — V1 is fully parked (owner-directed
2026-08-04; recorded in CLAUDE.md). All TPO front-end work is `app-v2` only.

## 3. Scope — what a TPO user can / can't do

A TPO user gets **everything a borrower can do** + the borrower's **PII** + a
set of **lender powers**, but is blocked from anything that sends money-grade
paper, reveals our internals, or reaches beyond their firm.

**IN**: their own borrower profiles + PII; enter loans; see all files for their
borrowers; invite their own processors (firm admin); price / register / generate
the term-sheet PDF; upload documents; SOW / track-record / entity tools; the
order-driven conditions; **order title / insurance / flood / credit**;
own-Xactus for credit; appraisal (borrower-safe report); draws
(view/accept/dispute); messaging with our team.

**OUT (blocked)**: **send the official term sheet on DocuSign** (lender-only —
gated by a `send_term_sheet` capability a TPO never holds); **fraud / background
/ criminal** report + findings; capital-partner / note-buyer names; internal
pricing margin; condition sign-off / waive / override; exceptions & overrides;
data tapes; **ClickUp / Encompass ("Compass") / SharePoint** panels; closing /
purchasing / draw-rules desks; team / pricing-admin / audit; any other firm's or
a retail borrower's data.

**Conditions**: reuse the existing `audience` mechanism — a TPO sees
`audience IN ('borrower','both')` PLUS a hand-picked set of `staff`-audience
order-driven conditions (flood cert, credit, insurance/title order, appraisal
received, EMD). Always render the **borrower-safe wording** (`borrower_label`)
for a revealed staff condition, never the internal `label`; treat a missing safe
wording as "hide it". Hide `rtl_cond_fraud`, `appraisal_review_cleared`,
`underwriting_review_cleared`, investor final review / CTC / structure, and every
internal workflow condition.

## 4. Architecture

- **Identity**: a TPO user is a `staff_users` row flagged `is_external=true`
  with `tpo_firm_id` set and role `tpo_officer` / `tpo_processor`. Storing them
  in staff_users (not a parallel table) is deliberate — `loan_officer_id`,
  `application_assignees.staff_id`, the "Your loan officer" card
  (`notify.fileContext`) and every file-scope gate already point at staff_users,
  so the broker-as-loan-officer mapping works with no rewrite.
- **Session kind `tpo`**: the token carries `kind='tpo'` (not `staff`), so
  `requireStaff` / `requireBorrower` structurally refuse it and it routes to the
  third front door. Auth reads/revokes off the same staff tables (a tpo row IS a
  staff_users row).
- **Curated `/api/tpo` router** (NOT holes poked in `/api/staff`): a small,
  deliberate surface that reuses the underlying lib layer (pricing, conditions,
  orders, credit) with the borrower-safe filters applied. Firm isolation lives in
  ONE place — `permissions.tpoFirmScopeSql` / `tpoBorrowerScopeSql`.
- **Third front door** in `app-v2`: a `TpoPrivate` route guard + `TpoLayout` +
  TPO screens, routed by `kind==='tpo'`, PILOT-branded, minus everything in §3's
  OUT list.
- **Frozen engines untouched** — a TPO prices on the exact same math.

## 5. Phased build

1. **Foundation** ✅ (this PR) — firm + TPO identity + firm scoping + the curated
   API seam. `db/472` (tpo_firms + staff_users external flags + role CHECK +
   external-firm invariant), `db/473` (applications `is_tpo`/`tpo_firm_id`/
   `borrower_portal_enabled` + assignee roles `account_executive`/
   `account_manager` + TPO-firm invariant). `permissions.tpoFirmScopeSql`/
   `tpoBorrowerScopeSql`/`isTpoActor`. Auth `kind='tpo'` (login `/auth/tpo/login`,
   `tpoToken`, `requireTpo`, `/me` branch, MFA, sliding refresh; the staff door
   + cross-surface fallback exclude `is_external`). Minimal `/api/tpo` router
   (`/me`, `/applications`). Tests `scripts/test-tpo-foundation-pure.js`,
   `scripts/test-tpo-identity-db.js`.
2. **Front door + firm onboarding** ✅ — internal admin surface (`admin-tpo.js`,
   `/api/admin/tpo`): create a firm, invite the lead broker, list/detail firms,
   suspend/close (atomically revokes broker sessions). The firm admin invites
   their own processors (`/api/tpo/team` + `/team/invite`). Invite machinery reuses
   `invite_tokens` + `/auth/accept` (`db/474` carries the firm + firm-admin flag +
   the `tpo` invite kind); `tpoInvite` email. The `app-v2` third door: `TpoLogin`,
   `TpoAccept`, `TpoLayout`, firm-scoped `TpoPipeline`, `TpoTeam`; `isTpo` in the
   auth context + route guards (`TpoPrivate`; borrower/staff areas bounce a tpo
   actor to `/tpo`). **The internal-roster `is_external` sweep is DONE** (see §6).
   Tests `scripts/test-tpo-identity-db.js` (onboarding → scoping → cross-door
   isolation → roster/notification exclusion → suspend/revoke → invariants).
3. **Files, borrowers & PII** ✅ — the `/api/tpo` surface for entering loans and
   working the firm's book. `POST /applications` (enter a loan — SAFE borrower
   resolution that never adopts a retail/other-firm profile by email; a fresh
   `shares_email=true` row when the email is already owned; TPO-stamped file with
   the broker as loan officer + conditions generated). `GET /borrowers` (the firm
   book), `GET/PATCH /borrowers/:id` (full PII), `GET/POST /borrowers/:id/ssn`
   (reveal/set, audited; a clash is refused GENERICALLY — no cross-profile leak),
   `GET /applications/:id` (borrower-safe file detail — no note buyer / internal
   contacts). The borrower-login toggle: `POST /applications/:id/borrower-portal`,
   enforced borrower-side in the ONE `OWN_FILE_SQL` chokepoint (a portal-disabled
   TPO file is hidden from the borrower; a NO-OP for every retail file, since
   `is_tpo=false`). `app-v2`: `TpoNewLoan`, `TpoBorrowers`, `TpoBorrowerDetail`,
   `TpoFile`. Test `scripts/test-tpo-files-db.js`.
4. **Conditions, documents + the term-sheet-send lock** ✅ (Phase 4a):
   - **The term-sheet-send lock is DONE.** `send_term_sheet` capability
     (`permissions.js`), granted to EVERY internal staff role (so internal
     behavior is byte-identical — verified by `test-esign-send`), and the
     `esign/send` + `esign/:id/resend` routes gate on it. A TPO can NEVER hold it
     — `can()` is false for any non-staff actor — so a broker can never send the
     signable term sheet, on top of the send route being staff-only. Pinned by
     `test-tpo-foundation-pure` (every role has it; a tpo actor never does).
   - **TPO conditions (read):** `GET /applications/:id/checklist` returns the
     BORROWER-SAFE set (audience borrower/both, `borrower_label` wording,
     capital-partner names scrubbed, the internal note never selected) — firm
     scoped. A staff-only condition is never shown.
   - **TPO documents:** `GET /applications/:id/documents` (borrower-VISIBLE only —
     `visibility='borrower'`; a staff_only/internal doc never appears) and
     `POST /documents` (upload against a borrower-facing condition; the broker
     PROVIDES, the lender still signs off — new evidence clears any prior
     sign-off). `app-v2 TpoFile` shows both with an upload control.
   - Test `scripts/test-tpo-files-db.js` (now 40 assertions).
   - **Phase 4b — the TPO Term Sheet Studio ✅ (BUILT).** A broker prices /
     registers a product and the studio generates the term-sheet PDF, exactly as
     the borrower does — the SAME frozen engine, the SAME borrower-safe scrub (no
     internal margin), the SAME override allowlist. `GET/POST /api/tpo/
     applications/:id/pricing` (+ `/quote`, `/register`); the register mirrors the
     borrower guards + condition side effects, firm-scoped, `registered_by` = the
     broker, and returns `termSheetFinal` (a fresh file is INITIAL — WE send the
     official sheet, lender-only). The scrub + allowlist moved to single-definition
     shared modules (`borrower-safe.js` + `pricing-overrides.js`), consumed by both
     `routes/borrower.js` and `routes/tpo.js`. The studio's PDF uploads through the
     term-sheet-only branch of `POST /api/tpo/documents` (born accepted, on the
     pricing condition, supersedes prior). `app-v2 ProductStudioPanel` gained a
     `mode='tpo'`; mounted as a card in `TpoFile`. Test `scripts/test-tpo-pricing-db.js`.
   - **Phase 4c — the lender-progress reveal + the broker info-field writer ✅
     (BUILT).** A broker now (a) SEES a small, curated, READ-ONLY view of the
     staff order conditions the LENDER drives — **credit** (`rtl_cond_credit`) and
     **appraisal received** (`rtl_cond_appraisaldocs`) — with hand-authored
     broker-safe wording, so they can track progress; and (b) ANSWERS an
     information condition for a DEAL field (there is no TPO details-edit door, so
     this is the only way a broker fills a missing deal field). The reveal is a
     TPO-SURFACE-only allowlist (`src/lib/tpo-conditions.js`, single definition) —
     it never changes a condition's `audience`, so the borrower portal + every
     staff surface are byte-identical, and a broker can never act on a revealed
     row. HARD RULE honored: the flood certificate / flood insurance, fraud, the
     PILOT review gates, and investor review/CTC/structure are NEVER on the
     allowlist (title/insurance CONTACT + EMD were already `audience='both'` and
     shown by the ordinary path — deliberately not revealed twice). The info
     writer (`POST /applications/:id/checklist/:itemId/info`) routes through the
     ONE `conditionEngine.writeFieldValue` (freeze + refinance governance, same
     refusal as a borrower/staffer); a PERSON field (fico → borrowers) is
     redirected to the profile door; no ClickUp push; notifies OUR staff, never
     the broker. `app-v2 TpoFile` renders an inline answer + a read-only "Lender
     progress" card. Test `scripts/test-tpo-conditions-db.js` (26 assertions).
   - **KNOWN GAP to decide (flagged for the owner):** a TPO file is created at
     status `file_intake`, which is OUTSIDE the conditions engine's
     `OPEN_STATUSES`, so the engine's `always`/`rules` conditions (flood cert,
     note-buyer conditions like EMD/CorrFirst, condo, cash-out, flood insurance,
     feasibility) do NOT auto-attach while the file is in broker intake — they
     land once OUR team activates the file (moves it to `new`/`in_review`). The
     base checklist (credit, appraisal, ID, contacts, …) DOES attach at creation.
     Whether a broker-submitted intake file should carry flood + rule conditions
     immediately (vs. on our acceptance) is a product decision — not changed here
     (it touches the shared engine / all statuses). The reveal + info writer
     behave correctly either way.
   - **STILL DEFERRED:** none of the condition surface remains — the remaining TPO
     work is the ORDER-INITIATION side (a broker orders title / insurance / flood
     / credit) and own-Xactus, which is Phase 5.
5. **Orders + own-Xactus** — title / insurance / flood / credit on the TPO
   surface; then per-firm encrypted Xactus credentials for **credit**.
   - **Phase 5a — a broker orders CREDIT ✅ (BUILT).** `POST /api/tpo/
     applications/:id/credit/order` orders a fresh LIVE pull on OUR Xactus account,
     reusing the ONE staff machinery `credit.importCredit` with the SAME
     server-side FCRA consent gate + prerequisite checks (SSN / address). Every
     internal artifact still fires and stays staff-only — the parsed
     `credit_reports` row, the `credit_pdf`/`credit_xml` documents at
     `visibility='staff_only'`, and the FICO→`borrowers.fico`→Products-&-Pricing
     reopen — but the RESULT is BORROWER-SAFE: the broker learns only that credit
     was pulled + (via `GET …/credit`) per-borrower readiness (name / hasSsn /
     canPull / what PII is missing / hasReport), NEVER a score, tradeline, adverse
     item, prior report id, or the PDF/XML. Firm-scoped; consent-gated (no consent
     → 400); a missing SSN is refused; `app-v2 TpoFile` gained a "Credit" card
     (readiness + an Order-credit button with a consent confirm). Test
     `scripts/test-tpo-credit-db.js` (stubs `provider.pull` — no live Xactus).
   - **STILL DEFERRED in Phase 5:**
     · **own-Xactus** (per-firm encrypted Xactus credentials for credit) — the
       single seam is `credit/provider.js:25` (`const cfg = require('../../config')
       .xactusProd`); refactor `pull()`/`buildRequestBody()` to take a credentials
       arg resolved from the file's firm (our account always an option; flood
       always ours). Fix the duplicate `xactus` key in `config.js` (config.js:605
       vs :772 — the second wins; credit uses the separate `xactusProd`, so it is a
       latent bug) as part of that work.
     · **title / insurance ordering** — has a NOTE-BUYER LEAK tension: the order
       email carries the note-buyer-derived mortgagee clause (RCN → the servicer's
       address), and it is "signed by the loan officer" = the broker on a TPO file.
       A broker-facing version must not show/CC the broker the clause, and should
       sign as the AE. Needs owner input on whether a broker triggers a
       YS-Capital-branded vendor email at all.
     · **flood ordering** — conflicts with the flood-cert-staff-only HARD RULE
       (the flood certificate is never broker-facing). A broker "ordering" flood
       whose result they cannot see is contradictory; needs owner clarification.
6. **Appraisal view, draws, messaging + AE/AM "view as TPO"** — the remaining
   borrower-style surfaces; the impersonation feature mirroring
   `src/lib/borrower-view.js` (a new `tpo-view` with its own `tpo_view_sessions`
   register, dual-identity revocation, blocklist incl. term-sheet-send); a full
   isolation + no-leak security pass.
   - **Phase 6a — the borrower-safe APPRAISAL view ✅ (BUILT).** A broker SEES the
     read-only "property profile report" — the SAME scrubbed appraisal the borrower
     sees. The borrower's inline scrub was extracted to the single shared
     `src/lib/appraisal/borrower-safe-view.js` `buildBorrowerSafeAppraisalView(db, appId)`,
     which BOTH `routes/borrower.js` and the new `GET /api/tpo/applications/:id/appraisal`
     (firm-scoped via `appInFirm`) return, so they can never drift. It drops the
     lender/AMC/owner/contact/`fields`/`warnings` columns, hides the underwriting-scrutiny
     + note-buyer findings, scrubs visible titles, sets `score.arv=null`, and surfaces a
     neutral `appraisal_under_review` placeholder when a hidden finding is a fatal blocker.
     `GET /api/tpo/appraisal-photo/:docId` streams appraisal-photo bytes authorized via the
     `appraisal_photos → appraisals → applications` firm-scope join (never a
     download-any-document hole). Front end: `AppraisalPanel` gained a `source='tpo'`
     channel; `TpoFile` mounts an Appraisal card. Test `scripts/test-tpo-appraisal-db.js`.
   - **Phase 6b — the borrower-safe DRAW view ✅ (BUILT), READ-ONLY.** A broker SEES
     the SAME borrower-safe construction-draw picture the borrower sees — the budget
     vs. what's released, the per-line rollup, each inspection result + its photos, and
     the branded PDF — and takes NO action (accept/dispute starts a wire, a borrower
     money decision, deferred). The borrower's inline draw scrub was extracted to the
     single shared `src/sitewire/borrower-safe-draws.js` (`borrowerSafeRollup` — drops
     `rollup.fees` [our fee income] + per-draw `fee_kind` [our fee schedule] + the staff
     `net_explanation`; `loadDrawFindings` — scrubs line name / inspector comment / media
     note of a partner name, drops media GPS; `loadDrawList`), which BOTH
     `routes/borrower-draws.js` (byte-identical, proven by the borrower draw tests) and
     the new `GET /api/tpo/applications/:id/draws` (firm-scoped via `appInFirm`) use.
     **THE PHOTOS ARE FIRM-SCOPED, NOT THE reply_token** — the borrower's per-finding
     `reply_token` is a public capability that ALSO permits accept/dispute (a wire), so
     it NEVER reaches the broker; `loadDrawFindings` takes a `photoUrl` callback and the
     TPO surface passes `/api/tpo/draw-media/:id` (authorized via `draw_media →
     applications` firm scope, image/video only, `setMediaHeaders`), never the token.
     `…/draws/report` forces `mode='borrower'`. Front end: `TpoDraws.jsx` (slim
     read-only; photos blob-fetched with auth); `TpoFile` mounts a Draws card. Test
     `scripts/test-tpo-draws-db.js`.
   - **Phase 6c — AE/AM "view as TPO" (the impersonation feature) ✅ (BUILT).** An
     internal account executive / account manager / admin steps INTO a broker's
     login and sees exactly what the broker sees — the EXACT mirror of staff
     "borrower view" (src/lib/borrower-view.js), one identity swapped. The token is
     a real `kind:'tpo'` access token + the same impersonation envelope; the
     INTERNAL staffer behind it is re-validated on every request (still active,
     is_external=false, token_version unchanged, session inside its 4h absolute
     cap), so the view dies the moment the staffer logs out / is deactivated, the
     firm is suspended (bumps the broker's tv), or the cap elapses. Firm isolation
     is the #1 risk and is enforced by `ELIGIBLE_TPO_SQL` reusing the SAME
     `permissions.visibleOfficersSql` file scope: a staffer reaches a broker only
     when that broker's FIRM has a file they can already open (the AE/AM match comes
     through the assignee/workflow terms; on a TPO file loan_officer_id is the
     broker, so a staffer never matches through it), OR `see_all_files`. The broker
     must be an active external user at an ACTIVE firm; the impersonator MUST be
     internal (an external broker can never start a view). Blocklist (the tiny
     borrower-view-style set, minus a moot term-sheet-send since a broker can't
     send): **order credit** (a live Xactus pull = an irreversible hard inquiry in
     the broker's name — the TPO analogue of the e-sign block), `/auth/logout`,
     `/auth/mfa/*`, and nesting. Everything else is full parity, audited with the
     real staffer's id (`impersonator_staff_id`; the tpo user audits as
     `actor_kind='staff'`). `src/lib/tpo-view.js` + `src/routes/tpo-view.js`
     (`/api/tpo-view/{eligible,start,session,exit,history}`, mounted outside
     /api/staff so session/exit work with a tpo token) + `tpoView.guard` +
     `db/478_tpo_view_sessions.sql`. Auth: the tpo-view impersonation block in
     `authenticate()`, `req.impersonation.surface` distinguishing the two view
     surfaces so the sliding refresh re-mints a tpo-view token into another tpo-view
     token (never a borrower one). Front end: `StaffTpoView.jsx` picker at
     `/internal/tpo-view` (nav "Broker view"), `TpoViewBanner.jsx` mounted in
     `TpoLayout` (self-fetches from `/api/tpo-view/session`), `startTpoView`/
     `exitTpoView`/`isTpoView` in `auth.jsx`. Tests `scripts/test-tpo-view-pure.js`
     + `scripts/test-tpo-view-db.js`.
   - **Phase 6d — a broker ACCEPTS / DISPUTES a draw inspection result ✅ (BUILT).**
     Owner-locked decision 2: brokers "view / accept / dispute … like a borrower".
     This completes the draw surface Phase 6b left read-only — it is the ONE broker
     draw action that MOVES MONEY. `POST /api/tpo/applications/:id/findings/:findingId/
     {accept,dispute}` (db/479) runs the SAME server-side transitions as the borrower's
     AUTHENTICATED accept/dispute (`routes/borrower-draws.js`) but firm-scoped
     (`appInFirm` + the finding PINNED to the named file — a finding on another file
     404s) and NEVER via the borrower's public `reply_token` (these take a `findingId`,
     not a token). Attributed: db/479 widens `accepted_via`/`disputed_via` to `'tpo'` +
     adds `disputed_by_staff_id`; accept stamps `accepted_via='tpo'` +
     `accepted_by_staff_id`, dispute stamps `disputed_via='tpo'` +
     `disputed_by_staff_id`, and both audit `tpo_accept_draw`/`tpo_dispute_draw`
     (`impersonator_staff_id` set inside a "view as TPO" session). The guarded
     `WHERE status='delivered'` UPDATE makes whoever acts first win (a lost race → 409);
     accept is idempotent. On a portal-DISABLED file the broker's accept is the ONLY
     path (the borrower has no portal) — the owner's exact reason for the lock. The
     dispute-evidence normalizer (byte-sniff the image type / strip GPS / cap size +
     count / only real uploads, never a client ref) is the SINGLE shared definition
     `src/sitewire/dispute-media.js`, used by BOTH the borrower and TPO surfaces (the
     borrower route is byte-identical, proven by its own tests). Front end: `TpoDraws.jsx`
     gained Accept (behind a confirm) + a per-line Dispute editor. Tests
     `scripts/test-dispute-media-pure.js` + the Phase-6d section of
     `scripts/test-tpo-draws-db.js`.
   - **Phase 6e — broker ↔ our-team MESSAGING ✅ (BUILT).** Owner-approved scope:
     "messaging with our team" — the LAST deferred TPO item. A broker gets a
     dedicated "Broker ↔ Team" conversation per file, REUSING the chat v3 infra
     (`conversations`/`messages`/`conversation_members` + the shared React
     `ChatThread`) — no second chat system. A broker IS a `staff_users` row but must
     be DISTINCT from our team in the roster + attribution, so they post/join as a
     NEW kind **`tpo`** (`messages.sender_kind`, `conversation_members.member_kind`,
     `conversations.kind`), never as `staff`. db/480 widens the three CHECKs to admit
     `'tpo'` IN-PLACE under each constraint's OWN name (the db/479 replay-idempotency
     lesson) + a SECURITY DELETE cleanup (below). **THE ONE SECURITY-CRITICAL
     INVARIANT: a staff reply's RAW body must NEVER be emailed to the external
     broker.** The broker gets it LIVE (SSE + unread badge) and always through the
     borrower-safe OUTPUT scrub (a capital-partner name → "Gold Standard program"),
     but the EMAIL path is raw, so it is closed at TWO chokepoints in
     `src/lib/chat.js`: `queueMessageNotifications` `continue`s on a `member_kind='tpo'`
     recipient and `sendChatEmailToMember` returns early for one — the broker is never
     emailed a chat message in v1 (a borrower-safe broker EMAIL is deferred to v1.1);
     our AE/AM (seated `member_kind='staff'`) ARE emailed. `ensureTpoConversation(appId)`
     creates the kind='tpo' 🤝 conversation (NOT `borrower_visible`) for an `is_tpo`
     file, seats the broker (`loan_officer_id` when `is_external`) as `member_kind='tpo'`
     and our AE/AM (`application_assignees` account_executive/account_manager, active,
     `is_external=false`) as `member_kind='staff'`; `tpoCanAccess` = `conv.kind='tpo'`
     AND app in firm via `tpoFirmScopeSql`. **A SECURITY FIX rode with it:**
     `ensureConversationsForApp` no longer seats an external staffer (the broker, who
     IS the `loan_officer_id` on a TPO file) as a `staff` member of the internal/
     borrower/lo_processor chats — that would have emailed our internal messages to
     the broker; db/480's DELETE removes any already-seated. `src/routes/tpo-chat.js`
     is the firm-scoped borrower-safe router (mirrors `borrower-chat.js`, `scrubText`
     on all outbound, actor `{kind:'tpo', roleLabel:'Broker'}`, firm-scoped
     `/chat/attachment/:docId`); `routes/events.js` treats `kind ∈ staff|tpo` as
     `staffLike` for SSE + re-validates a tpo-view impersonation at connect. Front end:
     `ChatThread.jsx` `surface='tpo'` (a clean thread — react/pin/edit/delete/rename/
     mute/search/mentionables all null; download via `tpoDownloadChatAttachment`);
     `TpoMessages.jsx` panel mounted as a "Messages" card in `TpoFile.jsx`. A firm-wide
     nav unread badge is deferred (messaging is a per-file card, not a nav
     destination). Test `scripts/test-tpo-chat-db.js`.
   - **STILL DEFERRED in Phase 6:** none — the TPO roadmap surfaces are complete.

## 6. Cross-cutting Phase-2+ TODOs (do NOT forget)

- **Every INTERNAL `staff_users` roster/picker query must exclude
  `is_external=true`** — SWEPT (Phase 2): `GET /api/roster` (public officer
  dropdown), the internal team list + welcome-all (`admin.js`), global-search
  officers / mentionables / team / picker (`staff.js`), `mentions.js`,
  `workflow.js` (candidate + all-active-staff), `clickup-sync.js`, the Dashboards
  officer-filter dropdown (`dashboards.js`), and the public `?lo=` branded-officer
  resolver (`leads.js`). The internal NOTIFICATION fan-out is excluded at the
  chokepoint too — `notify.notifyStaff` returns early for an external user and
  `notifyAppStaff` filters `is_external=false`, so a broker (who IS the loan-officer
  assignee on their firm's files) never receives an internal-format staff email or
  digest. `is_external` is `NOT NULL DEFAULT false`, so `= false` never drops an
  internal row. When adding a NEW internal roster/picker/fan-out, add the filter.
- **Hide the ClickUp + Encompass file tabs** in `StaffApplication.jsx` — but
  those are staff screens; a TPO uses the separate `/api/tpo` surface, so this is
  only relevant if a TPO screen ever embeds a staff component.
- **Term-sheet-send has no capability check today** — adding `send_term_sheet`
  (Phase 4) is what locks it for TPO; grant it to all existing staff roles so
  internal behavior is byte-identical.
- **AE/AM appear on TPO files as assignee roles** (`account_executive` /
  `account_manager`) with no denormalized pointer — set/managed via the assignee
  endpoints, like `draw_coordinator`.

## 7. Guardrails

- **Firm isolation is the #1 risk** — enforced at `tpoFirmScopeSql` (files) AND
  `tpoBorrowerScopeSql` (borrowers), with DB CHECK invariants
  (`staff_users_external_firm_check`, `applications_tpo_firm_check`) so an
  unscoped external identity cannot even be written. Prove it with tests before
  every phase ships.
- **Two-audit gate** on every change (CLAUDE.md).
- **RTL only** — the product-separation gate stays green (TPO is `tpo_*` /
  `is_tpo`, never `lt_`).
