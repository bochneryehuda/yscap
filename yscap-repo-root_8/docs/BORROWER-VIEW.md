# Borrower View — "see the portal exactly as this borrower sees it"

**Owner-directed 2026-07-26.** A loan officer, processor or admin can step into a
borrower's portal, see precisely the screens that borrower sees, walk them
through a condition live on the phone, and come back to their own console with
one click.

> "They should switch their view like they are this borrower … they can guide
> them live step by step and they can see how the borrower is seeing this screen."

---

## 1. Where it is in the product

| Surface | What it does |
|---|---|
| Left nav → **Borrower view** (`/internal/borrower-view`) | The picker. Search your borrowers, see how many loans each has and how many items are waiting on them, press **View as this borrower**. Also shows the register of recent views. |
| **Loan file header** → *Borrower view* button | Steps in from the file you are already on and lands **on that loan** inside their portal — the common case when a borrower calls about one file. |
| **Borrower profile** (`/internal/borrowers/:id`) → *Borrower view* button | Steps in from the CRM record. |
| The gold bar pinned to the top of every borrower screen | Says whose portal you are in, counts the session down, and holds **← Back to my &lt;loan officer / processor / admin&gt; view**. |

---

## 2. How it works, and why it is built this way

Every borrower endpoint in this codebase is already scoped off **one** value —
`req.actor.id` (`me(req)` / `OWN_FILE_SQL` in `src/routes/borrower.js`).

So the highest-fidelity "see what they see" is **not** a parallel read-only
mirror of the borrower screens. A mirror drifts the moment anyone touches the
borrower portal, and a screen that is "almost" right is worse than useless when
you are talking someone through it. Instead the staffer is handed a **real
borrower access token** for that borrower. The SPA then runs the actual borrower
app, against the actual borrower API, with the actual borrower's data. There is
no second implementation to keep in sync — a screen shipped to borrowers
tomorrow appears in borrower view the same day, for free.

The token is an ordinary `kind:'borrower'` access token **plus an impersonation
envelope**:

```
{ sub: <borrowerId>, kind:'borrower', role:'borrower', tv: <borrower token_version>,
  imp: 1,                          ← the marker every consumer keys on
  impBy:  <staffId>,               ← the REAL human
  impRole:<staffRole>,
  impTv:  <staff token_version>,   ← the staffer's own logout/lockout kills it
  impSid: <borrower_view_sessions.id>,
  impAt:  <epoch seconds> }        ← the absolute-cap anchor
```

`authenticate()` (`src/auth/index.js`) re-validates **both** identities on
**every single request**.

### Files

| File | Role |
|---|---|
| `src/lib/borrower-view.js` | The whole model: token minting, the impersonation envelope, the blocked-action list + guard, the eligibility SQL, the session register. The token/blocklist half is pure (no Postgres) so it unit-tests without a database. |
| `src/routes/borrower-view.js` | The five doors (`/eligible`, `/start`, `/session`, `/exit`, `/history`). Mounted **outside** `/api/staff` because `/session` and `/exit` are called while holding a borrower-kind token. |
| `src/auth/index.js` | Dual-identity validation, the refresh that preserves the envelope, the presence-heartbeat skip, the `impersonation` block on `/auth/me`, `mintStaffSession`. |
| `src/server.js` | Mounts the blocked-action guard **above `/auth`** and the router. |
| `db/318_borrower_view_sessions.sql` | The register + the impersonator stamp on both audit trails. |
| `app-v2/src/lib/auth.jsx` | `startBorrowerView` / `exitBorrowerView` — owns the token swap in both directions. |
| `app-v2/src/components/BorrowerViewBanner.jsx` | The pinned bar. |
| `app-v2/src/components/BorrowerViewButton.jsx` | The reusable launcher (file header, borrower profile). |
| `app-v2/src/screens/StaffBorrowerView.jsx` | The picker + register. |

---

## 3. Who may view whom

- **`see_all_files`** (admin / super_admin / underwriter / loan_coordinator /
  closer / draw_coordinator) → **any** borrower.
- **Everyone else** (loan officers, processors) → only borrowers who are the
  borrower **or co-borrower** on a file they can already open.

The scoped case is resolved by `ELIGIBLE_BORROWER_SQL(p)`, which mirrors the
staff API's own `VISIBLE_OFFICERS_SQL` chokepoint term-for-term: primary
LO/processor, delegated `visible_officer_ids`, active `application_assignees`
row, or an open Workflow hand-off — and never a soft-deleted file.

> **If you add a fifth way a staffer legitimately reaches a file, add it to
> `ELIGIBLE_BORROWER_SQL` too.** `scripts/test-borrower-view-pure.js` asserts the
> parity term-by-term and will fail loudly when the two drift.

`ELIGIBLE_BORROWER_SQL` is a **function of its placeholder**, like every other
scope fragment in this repo. That is not cosmetic: a `see_all_files` caller drops
the clause entirely, and a hardcoded `$1` then becomes an unreferenced parameter —
Postgres `42P18`, which broke borrower view for **every admin** until the DB test
caught it. Never bind a parameter the query might not reference.

---

## 4. Revocation — the view never outlives its owner

Checked on every request (`authenticate`) and at SSE connect (`routes/events.js`,
the one surface that bypasses the auth middleware):

| Event | Result |
|---|---|
| Staffer signs out of their console anywhere | View ends immediately (`impTv` no longer matches) |
| Staffer's password reset / session revoked | View ends immediately |
| Staffer deactivated by an admin | View ends immediately |
| Borrower signs out everywhere | View ends immediately (`tv` no longer matches) |
| 4 hours elapse (`MAX_SESSION_SEC`) | View ends; it cannot be refreshed past the cap |

The 30-minute token refresh **re-mints with the same envelope and the same
`impAt`**. This matters more than it looks: letting a borrower-view token slide
into a plain borrower token would silently convert a bounded, audited, 4-hour
view into a permanent, unattributed borrower session.

---

## 5. What is deliberately *not* available inside a borrower view

The owner asked for "the same options … same permissions", and that is what this
is: **full parity** across the borrower portal — every screen, upload, tool,
condition, message, draw and pricing action behaves exactly as it does for the
borrower. The blocked list is deliberately tiny, and covers only acts that are
not "seeing what they see" at all:

| Blocked | Why |
|---|---|
| `POST …/esign/sign-view` | Opening the signing ceremony would let a staff member **execute loan documents in the borrower's legal identity**. No e-signature platform permits this, and neither does any impersonation feature in a regulated system. Reading the package is fine. |
| `POST /auth/logout` | It bumps the **borrower's** `token_version` — a staffer "signing out" of a view would knock the real borrower off their own phone mid-upload. |
| `POST/PUT/PATCH/DELETE /auth/mfa/*` | Changes the borrower's second factor. Reading 2FA status is fine. |
| `POST /api/borrower-view/start` | A view cannot open another view. |

Enforced by `borrowerView.guard`, mounted **globally in `server.js`, above
`/auth`**. Position matters — mounted after `/auth` it would not cover the
`/auth` routes at all. Being global means a borrower route added tomorrow
inherits the guard with no per-handler check to forget.

Two further parity carve-outs, both about **not corrupting the borrower's own
state** rather than about permission:

- **Read receipts are not consumed.** Opening a thread in a borrower view does
  not mark the borrower's messages read (`borrower.js /messages`,
  `borrower-chat.js /read`). Otherwise the team would see "the borrower has read
  your reply" when they never opened it. The thread renders identically; only the
  receipt write is skipped.
- **Presence is not faked.** The `last_seen_at` heartbeat is skipped, so a
  staffer looking at a borrower's screen never makes that borrower appear online.

---

## 6. It is never silent

- **`borrower_view_sessions`** — one row per view: who looked, as whom, from
  which file, from which IP, when it started, how many requests it made, when and
  why it ended (`exit` / `expired` / `revoked` / `superseded`). A staffer never
  holds two live views. Browsable at the bottom of the Borrower view screen —
  your own by default, the whole team's with `view_audit_log`.
- **`audit_log.impersonator_staff_id`** — the semantic GLBA trail. Rows stay
  `actor_kind='borrower'` (the identity the action ran under, which is what the
  trail must record) **and** name the real human.
- **`request_audit_log.impersonator_staff_id` / `.impersonator_role`** — the
  request firehose, so every HTTP call made inside someone's portal is
  attributable. Read straight off verified claims, so even a request the auth
  middleware *rejects* is attributed to whoever made it.

---

## 7. Tests

| Test | Covers |
|---|---|
| `scripts/test-borrower-view-pure.js` (83 assertions, no DB) | Token shape + envelope; forged/plain/staff tokens never read as impersonations; the absolute cap; the blocked list matches **exactly** its four routes and nothing else (with an explicit allow-list asserting parity is intact); the guard refuses blocked actions for an impersonated caller and is inert for everyone else; the eligibility fragment's placeholder contract + `VISIBLE_OFFICERS_SQL` parity. |
| `scripts/test-borrower-view-db.js` (40 assertions, DB-gated) | The scope against the **real schema**: officer↔officer isolation both ways, co-borrowers, assistants, soft-deleted files, processor scoping, `see_all_files`; search never widens scope; the session lifecycle (open / heartbeat / supersede / close-once); history self-scoping; and that both audit trails really accept the impersonator stamp. |

Both are in `npm test`. A pure test cannot catch a wrong column name — that is
the `#248` class this repo has been bitten by — so anything touching raw columns
gets a DB test.

---

## 8. When extending this

- Adding a borrower screen or endpoint needs **no borrower-view work**. That is
  the design: parity is inherited, not maintained.
- Adding a way a staffer reaches a file → add it to `ELIGIBLE_BORROWER_SQL`.
- Adding a genuinely identity-bound borrower action (a new signing surface, a new
  credential change) → add it to `BLOCKED` with plain-language copy and a case in
  the pure test's allow/deny tables.
- Never widen `BLOCKED` for ordinary workflow actions. The owner asked for the
  same options and the same permissions; an over-broad blocklist quietly breaks
  the feature's whole reason for existing.
