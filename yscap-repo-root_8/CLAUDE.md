# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout gotcha

The entire project lives in the **`yscap-repo-root_8/`** subfolder of the git root — `package.json`, `src/`, `db/`, `web/`, `app/` are all there, not at the git top level. Run all `npm` commands from inside `yscap-repo-root_8/`. Render auto-detects this nested `package.json`; deploys run from that folder.

## Commands

Backend (run from `yscap-repo-root_8/`):
- `npm start` — run the server (`node src/server.js`). Serves the API + the static site in `web/`.
- `npm run dev` — same, but with `RUN_SYNC=1` so the ClickUp/Encompass sync worker also starts.
- `npm run migrate` — apply `db/*.sql` manually. **Usually unnecessary**: the server auto-migrates on boot (see below).
- `npm run create-admin -- <email> <password> [role] [full name]` — seed/reset a staff super-admin (also driven by `ADMIN_EMAIL`/`ADMIN_PASSWORD` env on boot).

Frontend SPA (run from `yscap-repo-root_8/app/`):
- `npm install && npm run build` — builds the React portal **into `../web/portal/`**. Render does NOT build the frontend, so **after any change under `app/src/`, rebuild and commit the regenerated `web/portal/` bundle** or the change won't deploy.
- `npm run dev` — Vite dev server for local portal work.

There is **no test runner configured**. Verification in this repo is done by running the server against a local Postgres and exercising endpoints (e.g. ad-hoc Node scripts using `fetch` against `app.listen(...)`, or `require('./src/server')` which does not auto-listen). A real Postgres is required — the code has no in-memory/mocked DB.

## Environment / config

All config comes from env vars, centralized in `src/config.js` (which also loads a bundled `.env` at the project root if present, never overriding real env). Key ones: `DATABASE_URL` (required — unset makes pg fall back to localhost and every request fails with `ECONNREFUSED`), `JWT_SECRET`, `SSN_ENCRYPTION_KEY` (both refuse the dev default in production and generate an ephemeral value + warn), `EMAIL_PROVIDER` (`auto` infers from `RESEND_API_KEY`/`MS_*`), `NOTIFY_FROM`, `APP_URL`, `STORAGE_DIR` (point at a Render persistent disk in prod), `INTAKE_API_KEY`. `render.yaml` is the source of truth for the production service + Postgres + persistent disk.

## Architecture

**One Express process serves everything** (`src/server.js`): the JSON API under `/auth` and `/api/*`, plus the static marketing site and prebuilt SPA out of `web/`. On boot it runs `src/migrate-boot.js` → `ensureSchema()` (waits for the DB, applies `db/schema.sql` only if the base tables are missing, then the idempotent numbered migrations every time) and `bootstrapAdmin()`. `/api/health` probes the DB (200/503).

**Migrations** (`db/`): `schema.sql` defines base tables and is NOT idempotent (bare `CREATE TABLE`) — it runs only on an empty DB. `002_`…`NNN_*.sql` are all `IF NOT EXISTS` / `ON CONFLICT` and safe to re-run on every boot. Adding schema = a new numbered file that is idempotent.

**Two front-ends, one origin:**
- `web/` — the existing static marketing site + standalone tools in `web/tools/*.html` (rehab budget, track record, loan application, term sheet…). The site's pricing/guideline engines (`window.YSP`/`GSP`/`TitleCost`) are **frozen** and must never be modified. Officer branding is `?lo=<code>`-driven (`web/brand.js`); the loan-application officer dropdown is now fed live from `GET /api/roster` with the static list as fallback.
- `app/` — the React (Vite + HashRouter) borrower/staff portal, built to `web/portal/` and served at **`/portal/`**. Because it's under `/portal/` with a HashRouter, all portal deep links (and email links) must be `/portal/#/<route>` — see `src/lib/email/catalog.js` `link()` and `cfg.portalPath`.

**Auth** (`src/auth/index.js` + `src/lib/crypto.js`): borrowers self-register; staff are admin-provisioned/invited. Custom HS256 JWT, scrypt password hashing, TOTP MFA, and AES-256-GCM SSN encryption — all on Node's built-in `crypto`, **no native deps** (only `express` + `pg` are installed, so Render builds cleanly). Session revocation via a `token_version` claim checked against the DB. A pending-MFA "challenge" JWT carries `mfa:true` and must never be accepted as an access token.

**Roles & authorization:** staff roles are `super_admin > admin > {loan_officer, processor, underwriter}`. `super_admin` satisfies every `requireRole` gate. `seesAll` (admin/super_admin/underwriter) see every application; loan_officer/processor are scoped to files they're assigned to (enforced by a path-scoped middleware on `/applications/:id` and explicit checks on borrower/SSN/document reads). Only a super_admin may modify another super_admin or grant that role.

**Data model** (`db/schema.sql` + migrations): `borrowers` (PII) is separate from `borrower_auth` (login) to reduce blast radius. A borrower has many `applications` (one per property); `llcs` and `track_records` hang off the borrower. `checklist_templates`/`checklist_items` drive the document/condition workflow (audience borrower/staff, RTL phase workflow in `005`). `documents` reference bytes stored via `src/lib/storage.js`. `staff_users` is the single source of truth for the team roster (`007`). `leads` (`008`) captures public marketing-tool submissions. `notifications` (in-app + email fan-out), `sync_queue` (ClickUp/Encompass, deferred), and `audit_log` (GLBA PII trail) round it out. SSNs are encrypted at rest and stripped from any `raw_intake`/`payload` jsonb via `src/lib/redact.js`.

**Notifications & email:** `src/lib/notify.js` always writes an in-app `notifications` row and best-effort fans out a branded email. Email provider is selected in `src/lib/email/index.js` (`resend`/`graph`/`noop`); messages are built by `src/lib/email/catalog.js` and rendered by `src/lib/email/template.js` (table-based HTML with the real logo from `web/assets/brand/lockup-dark.png` via `APP_URL`). A failed send never breaks the request.

**Storage** (`src/lib/storage.js`): pluggable provider (`local` default, `s3`/`sharepoint` stubs share the interface). `local` persists under `STORAGE_DIR` with path-traversal defense, atomic writes, sharded dirs, and streaming reads. On Render the default filesystem is ephemeral — `STORAGE_DIR` must point at a mounted persistent disk. Downloads stream through `src/lib/serve-document.js` after an authorization check.
