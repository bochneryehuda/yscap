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
- `web/` — the existing static marketing site + standalone tools in `web/tools/*.html` (rehab budget, track record, loan application, term sheet…). The site's pricing/guideline engines (`window.YSP`/`GSP`/`TitleCost`) are **frozen** and must never be modified except by an explicit owner-directed guideline change (see the frozen-baseline note under Session rules). Officer branding is `?lo=<code>`-driven (`web/brand.js`); the loan-application officer dropdown is now fed live from `GET /api/roster` with the static list as fallback.
- `app/` — the React (Vite + HashRouter) borrower/staff portal, built to `web/portal/` and served at **`/portal/`**. Because it's under `/portal/` with a HashRouter, all portal deep links (and email links) must be `/portal/#/<route>` — see `src/lib/email/catalog.js` `link()` and `cfg.portalPath`.

**Auth** (`src/auth/index.js` + `src/lib/crypto.js`): borrowers self-register; staff are admin-provisioned/invited. Custom HS256 JWT, scrypt password hashing, TOTP MFA, and AES-256-GCM SSN encryption — all on Node's built-in `crypto`, **no native deps** (only `express` + `pg` are installed, so Render builds cleanly). Session revocation via a `token_version` claim checked against the DB. A pending-MFA "challenge" JWT carries `mfa:true` and must never be accepted as an access token.

**Roles & authorization:** staff roles are `super_admin > admin > {loan_officer, processor, underwriter}`. `super_admin` satisfies every `requireRole` gate. `seesAll` (admin/super_admin/underwriter) see every application; loan_officer/processor are scoped to files they're assigned to (enforced by a path-scoped middleware on `/applications/:id` and explicit checks on borrower/SSN/document reads). Only a super_admin may modify another super_admin or grant that role.

**Data model** (`db/schema.sql` + migrations): `borrowers` (PII) is separate from `borrower_auth` (login) to reduce blast radius. A borrower has many `applications` (one per property); `llcs` and `track_records` hang off the borrower. `checklist_templates`/`checklist_items` drive the document/condition workflow (audience borrower/staff, RTL phase workflow in `005`). `documents` reference bytes stored via `src/lib/storage.js`. `staff_users` is the single source of truth for the team roster (`007`). `leads` (`008`) captures public marketing-tool submissions. `notifications` (in-app + email fan-out), `sync_queue` (ClickUp/Encompass, deferred), and `audit_log` (GLBA PII trail) round it out. SSNs are encrypted at rest and stripped from any `raw_intake`/`payload` jsonb via `src/lib/redact.js`.

**Notifications & email:** `src/lib/notify.js` always writes an in-app `notifications` row and best-effort fans out a branded email. Email provider is selected in `src/lib/email/index.js` (`resend`/`graph`/`noop`); messages are built by `src/lib/email/catalog.js` and rendered by `src/lib/email/template.js` (table-based HTML with the real logo from `web/assets/brand/lockup-dark.png` via `APP_URL`). A failed send never breaks the request.

**Storage** (`src/lib/storage.js`): pluggable provider (`local` default, `s3`/`sharepoint` stubs share the interface). `local` persists under `STORAGE_DIR` with path-traversal defense, atomic writes, sharded dirs, and streaming reads. It probes writability and falls back to a temp dir (logging loudly) if `STORAGE_DIR` can't be written, so uploads never hard-fail; `/api/health` reports `storageWritable`/`storagePersistent`/`storageBase`. On Render the default filesystem is ephemeral — `STORAGE_DIR` must point at a mounted persistent disk (currently `/var/data/uploads` on a mounted 5 GB disk). Downloads stream through `src/lib/serve-document.js` after an authorization check.

## Session rules

- **Never expose a note buyer / capital partner name** (BlueLake, Temple View, RCN, Churchill, Fidelis, etc.) on any borrower-facing surface — UI text, checklist template hints/labels, emails, PDFs. Borrower-facing copy calls it the **"Gold Standard program."** Staff-only surfaces may keep real names. Checklist items carry `borrower_label`/`borrower_hint` (borrower portal shows those) vs. the internal `label`/`hint` (staff).
- The pricing/guideline engines under `web/tools` (`window.YSP`/`GSP`/`TitleCost`, `termsheet.js` math) are the frozen source of truth. Reuse/wrap/port them into React — **never change their numbers or logic** except by an explicit owner-directed guideline change (then update this note and re-freeze).
  - **Frozen baseline — Gold Standard interest reserve (owner-directed, 2026-07-06):** the Gold Standard program does **not** finance an interest reserve on **renovation** (Light/Heavy Reno). Any requested reserve — from the structuring / products & pricing / term-sheet studio screens or the loan application — always resolves to **zero**: never financed, never in the cost basis. Gold **ground-up** keeps its full-term (75%-of-term) reserve; **bridge** never carried one; the **Standard Program** is unaffected. Enforced in `gold-standard.js` (all 3 copies), `termsheet.js` `calcGold`, `src/lib/pricing.js`, and the register routes. Treat this as frozen going forward.
  - **Frozen baseline — Loan-amount rounding / breakdown reconciliation (owner-directed, 2026-07-09):** the financed loan is reported in **whole dollars, floored DOWN** — never report (or lend) more than the engine sized. The reported breakdown must **reconcile to the penny**: the **initial advance** and **rehab holdback** are floored down too, and the **financed interest reserve absorbs the reconciling residual** (`reserve = flooredTotal − flooredInitial − flooredHoldback`); on a **no-reserve** deal the **initial advance absorbs the residual** instead (`initial = flooredTotal − flooredHoldback`), so no phantom reserve appears. This mirrors the LOS, which floors both the loan amount AND the initial — previously the total floored while the initial rounded to nearest, so the breakdown could sum to $1 over the total. The engine sizing math (`standard-program.js` / `gold-standard.js`) is **unchanged**; only the **reported figures** are floored/reconciled, in `web/tools/termsheet.js` (`calc` + `calcGold`) and `src/lib/pricing.js` (`normalize`). Treat this as frozen going forward.
  - **Frozen baseline — Track-record experience window (owner-directed, 2026-07-07):** only a **completed exit dated within the last 3 years** counts toward the borrower's experience tier / brackets. An exit **more than 3 years ago** counts toward **nothing** — not the tier, not experience, not through anything; a **future-dated** exit likewise does not count until it closes. This applies to the sale date (flips) and the lease/refi date (holds). Enforced in `web/tools/track-record.js` `qualifies()` (`0 <= monthsAgo(exitDate) <= EXIT_WINDOW_MO=36`). Treat this as frozen going forward.
- After ANY change under `app/src/`, run `cd app && npm run build` and **commit the regenerated `web/portal/` bundle**, or the change won't deploy. Render does NOT build the frontend (`buildCommand: npm install`).
- Every schema change is a **new numbered idempotent `db/0NN_*.sql`** file. Never edit old migrations. `migrate-boot.js` applies them in order on boot.
- **Verify every write endpoint**: after a 200, re-fetch and confirm the value persisted. "Returned 200 but didn't save" (camelCase/snake mismatch, `COALESCE`-swallows-updates) is the #1 recurring bug class here.
- When a bug is reported in one place, grep the repo for the same pattern and fix every instance in the same commit.
- **Previous AND future (owner-directed, 2026-07-09):** every change here must apply to **EXISTING files too**, never only new ones. When you add or alter a condition, checklist item, field, gate, or any data shape, ship a **deterministic, idempotent backfill migration** (mirror `db/041`/`db/066`: `INSERT … SELECT … WHERE NOT EXISTS`, scoped to active/closed files) so previous files get it on the next boot — do **not** rely solely on the ClickUp sync/reconcile pass to reach old files (it only touches files the sync happens to re-ingest). "It should populate for previous and future."
- **Uploads** use one contract: `{ filename, contentType, dataBase64 }` (raw base64, not a `data:` URL). `api.js` `normalizeUpload()` strips a `dataUrl` if one slips through.
- **Deploys**: GitHub→Render auto-deploy is currently unreliable; after merging to `main`, trigger a deploy via the Render API (service `srv-d94sqalckfvc73ahlqh0`) and confirm the new bundle hash + `storageWritable` via `/api/health`.
- **Draw management is intentionally sandboxed** — the only live piece is the funded-file "Request a draw" button, which emails LO + processor + borrower + draws@yscapgroup.com. Do not build the full draw workflow here; it lives on a separate portal.
