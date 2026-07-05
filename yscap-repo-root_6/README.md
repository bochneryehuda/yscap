# YS Capital Borrower Portal — Backend

Node/Express + PostgreSQL. Serves the existing static site (`web/`) **untouched**
and adds the portal API: auth, borrower profiles, multi-application files,
LLCs + documents, track records, checklists/conditions, document uploads, and
notifications. Pricing/guideline engines are never imported or modified.

## Zero native dependencies
Auth (password hashing, JWT, MFA) and SSN encryption run on Node's built-in
`crypto` — no `argon2`/`otplib`/`jsonwebtoken`. `npm install` pulls only
`express` + `pg`, so Render builds cleanly every time.

## Run locally
```bash
npm install
cp .env.example .env          # fill DATABASE_URL etc.
npm run migrate               # applies db/*.sql in order (idempotent)
npm start                     # http://localhost:3000  (GET /api/health)
```

## Deploy on Render
package.json is at the **repo root** — Render finds it automatically.
- If you saw `Couldn't find a package.json file in /opt/render/project/src`,
  your repo had the project nested in a subfolder. Fix either way:
  1. Push the **contents** of this project to the repo root (so package.json is
     at the top), **or**
  2. In the Render service → Settings → **Root Directory**, set the subfolder
     that contains package.json.
- `render.yaml` provisions the web service + Postgres and auto-generates
  `JWT_SECRET`, `SSN_ENCRYPTION_KEY`, `INTAKE_API_KEY`. Run `npm run migrate`
  once after the DB is up (Render Shell, or a one-off job).

## Notifications — which tokens you need
- **In-app notifications** (bell/inbox): **no token.** Stored in Postgres,
  routed to the loan officer on a new application, or to all admins (Lead
  Capture) when no officer is selected.
- **Email fan-out** — set `EMAIL_PROVIDER` and one credential set:
  - `graph` (Outlook / Microsoft 365): Azure AD app registration with the
    **application** permission **Mail.Send** (admin-consented) →
    `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `NOTIFY_FROM`.
  - `resend` (fastest to stand up): `RESEND_API_KEY`, `NOTIFY_FROM`.
  - `none` (default): logs only; in-app notifications still work.
  - Optional `NOTIFY_ADMINS` = comma list for the unassigned-app inbox copy.

## API surface
- `POST /auth/borrower/register|login`, `/auth/borrower/mfa/verify`,
  `/auth/mfa/setup|enable`, `/auth/staff/login`, `/auth/staff/mfa/verify`,
  `/auth/staff` (admin), `/auth/invite` (admin), `/auth/accept`,
  `/auth/logout`, `GET /auth/me`
- `POST /api/intake` (x-intake-key) — site submits an application here
- `/api/borrower/*` — profile, applications, llcs, track-records, checklist,
  documents, notifications, messages (all scoped to the logged-in borrower)
- `/api/staff/*` — pipeline, lead-capture, conditions, checklist status,
  assign, verify llc/track-record, borrower + SSN reveal (audited), notifications
- `/api/admin/*` — staff + borrower management

## Data model (db/schema.sql + db/002_backend.sql)
staff_users · borrowers (+ borrower_auth) · llcs · track_records · applications
· checklist_templates · checklist_items (audience borrower/staff, kind
document/condition) · documents · messages · notifications · invite_tokens ·
sync_queue (ClickUp/Encompass, later) · audit_log (GLBA PII trail).
