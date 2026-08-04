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
   API seam. `db/464` (tpo_firms + staff_users external flags + role CHECK +
   external-firm invariant), `db/465` (applications `is_tpo`/`tpo_firm_id`/
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
   `invite_tokens` + `/auth/accept` (`db/466` carries the firm + firm-admin flag +
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
   - **DEFERRED to Phase 4b:** the TPO Term Sheet Studio (price / register /
     generate the term-sheet PDF), the info-field condition writer, and the
     staff-condition REVEAL (flood cert / credit / appraisal received / EMD).
     The order-driven borrower-facing conditions (EMD, insurance/title contact)
     are already `audience IN ('borrower','both')` and thus shown; the staff-only
     order conditions carry NO `borrower_label` today, so the "no safe wording →
     hide" rule keeps them out — revealing them needs a deliberate migration that
     adds borrower-safe wording, done with the pricing slice.
5. **Orders + own-Xactus** — title / insurance / flood / credit on the TPO
   surface; then per-firm encrypted Xactus credentials for **credit** (refactor
   `credit/provider.js pull()` to take a credentials arg resolved from the file's
   firm; flood stays on our account). Fix the duplicate `xactus` key in
   `config.js` while here.
6. **Appraisal view, draws, messaging + AE/AM "view as TPO"** — the remaining
   borrower-style surfaces; the impersonation feature mirroring
   `src/lib/borrower-view.js` (a new `tpo-view` with its own `tpo_view_sessions`
   register, dual-identity revocation, blocklist incl. term-sheet-send); a full
   isolation + no-leak security pass.

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
