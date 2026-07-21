# Sitewire API v2 — the confirmed reference (never guess a field again)

The **official OpenAPI spec is saved verbatim** at `docs/sitewire/sitewire-api-v2-swagger.json` (owner-provided
2026-07-21). This doc is the plain-language summary + the field map our integration is built on. When adding
ANY Sitewire write, verify the field against the swagger — do not trust a website (portal) HAR, whose routes
and field names differ from the API.

- **Base URL:** `https://app.sitewire.co`
- **Auth:** three headers — `access-token`, `client`, `uid` (from Render env only). Our role is `lender_owner`.
- **Money is integer cents.** Dates are `YYYY-MM-DD` strings.

## The API surface (all paths)
Reads (GET): `/borrowers`, `/borrowers/{id}`, `/lenders`, `/lenders/{id}`, `/capital_partners`,
`/properties`, `/properties/{id}`, `/budgets/{id}`, `/draws`, `/draws/{id}`, `/requests/{id}`,
`/deliverable_updates`, `/deliverable_updates/{id}`, `/deliverable_update_entries/{id}`,
`/quick_notify_statuses`, `/quick_notify_statuses/{id}`.

Writes:
| Method + path | Body | Purpose |
|---|---|---|
| POST `/properties` | `{property:{…}}` | create a property |
| PATCH `/properties/{id}` | `{property:{…}}` | update property fields |
| PATCH `/properties/{id}/borrower` | `{borrower:{contact_email}}` | assign / (re)invite the borrower — **one email per property** |
| PATCH `/budgets/{id}` | `{budget:{job_items:[…], draw_eligible, funding_ratio, funding_threshold_cents}}` | update the budget (loan) incl. draw eligibility |
| PATCH `/requests/{id}` | `{request:{approved_cents, lender_comments}}` | set the approved figure / lender note on a draw line |
| PATCH `/draws/{id}` | `{draw:{coordinator_id, quick_notify_status_id}}` | set coordinator / pipeline status |
| PATCH `/draws/{id}/approve\|amend\|reopen` | (no body) | draw transitions (`reject` is capital-partner-only — never ours) |
| POST `/draws` | `{draw:{property_id, historical:true, requests_attributes:[…]}}` | create a **historical** draw |
| POST/PATCH/DELETE `/quick_notify_statuses[/{id}]` | `{quick_notify_status:{name}}` | manage pipeline labels (POST needs `?lender_id=`) |

## PROPERTY — writable fields (the real ones)
`inactive` (bool), `inspection_method` (`mobile`=virtual / `traditional`=on-site),
**`require_sitewire_inspector`** (bool — Sitewire GC review ↔ in-house), `require_capital_partner_approval`
(bool), `processing_fee_cents` / `money_transfer_fee_cents` / `other_fees_cents` (int cents),
`start_date` / `end_date` (`YYYY-MM-DD`), `total_units` (int), `borrower_entity_name`, `capital_partner_id`,
`loan_number`, `lockbox_code`, `project_id`, `project_description`, `default_draw_coordinator_id`,
`allow_reallocation` (bool), `draw_checklist_template_id`, `development_type`, `construction_type`, `address`.
The property GET also nests `budget:{id, draw_eligible, …}` and read-only `documents:[…]` (src links only).

## BUDGET — writable fields
`draw_eligible` (bool — **this is "draws allowed"**), `funding_ratio`, `funding_threshold_cents`, and
`job_items:[…]`. Each job_item write key: `id` (to update/delete), `name`, `budgeted_cents`,
`required_image_count`, `required_video_count`, `mandatory`, `_destroy:true` (delete). Sitewire MERGES by id —
a partial `job_items` array touches only the listed items. `available_cents` + `required_*_status` are read-only.

## ⚠️ Website field names ≠ API field names (2026-07-21 correction)
The Sitewire **website** uses `toggle_accepting_draws` and `toggle_sitewire_review` (portal routes, session +
CSRF). **The API v2 has NEITHER field.** The correct API mappings — now used by PILOT — are:
- **Block Draws / Draws Allowed → `budget.draw_eligible`** (PATCH `/budgets/{id}`, NOT the property). `draw_eligible:false` = blocked.
- **Sitewire GC review ↔ In-house → `property.require_sitewire_inspector`** (PATCH `/properties/{id}`). `true` = Sitewire review.

## Documents — NO API upload → PILOT's website workaround
There is **no document-upload endpoint** in the API. Documents can only be READ (property `documents[].src`
are `active_storage` blob-redirect links). Upload on the website is a Rails ActiveStorage direct-upload flow
that requires a browser session + CSRF token — the API token cannot do it.

**PILOT ships the workaround** (`src/sitewire/web-client.js` + `src/sitewire/doc-push.js`): a server-side
"browser robot" that logs into the website and does the confirmed 3-step upload, pushing three documents into
the property's Documents tab — the **appraisal PDF** (`doc_kind='appraisal_pdf'`, never the XML), the
**Scope of Work Excel** (`doc_kind='rehab_budget_export'`, .xlsx — regenerated from the saved SOW if none is
stored) and the **Scope of Work PDF** (`doc_kind='rehab_budget_export'`, .pdf). It runs **automatically on
every property push** and is also a manual **Send / Re-send** on the draw desk (DrawsPanel → "Documents &
borrower invite"). Every upload is journaled, volume-circuit-broken, **read-after-write VERIFIED against the
trusted API** (`property.documents[]` — never trusting the website flow's own response), sha256-deduped
(identical bytes are never re-uploaded unless forced), and **parked on any failure** — never silently dropped.

The confirmed website flow (captured from a real browser session — never guessed):
1. `POST /rails/active_storage/direct_uploads` — body `{"blob":{filename,content_type,byte_size,checksum:<base64 MD5>}}` → `{signed_id, direct_upload:{url, headers}}`
2. `PUT <direct_upload.url>` with `<direct_upload.headers>`, body = the raw bytes (S3)
3. `POST /properties/{id}/property_documents` (multipart): `authenticity_token`, `file-selection`, `property[property_documents_attributes][0][document]=<signed_id>` + header `x-csrf-token`
   - Delete (revoke / clean re-push): `POST /properties/{id}/property_documents/{docId}` body `_method=delete&authenticity_token=<token>`

**Staged like every write** — OFF unless `SITEWIRE_DOCS_ENABLED=1`, and still gated by `SITEWIRE_OUTBOUND_ENABLED`
+ `SITEWIRE_DRYRUN`. **Secrets go in Render env only** (never committed, never pasted in chat):
- `SITEWIRE_WEB_EMAIL` + `SITEWIRE_WEB_PASSWORD` — the preferred, durable path: PILOT logs itself in (a
  `lender_owner` website login) and refreshes its own session.
- `SITEWIRE_WEB_COOKIE` — fallback for when SSO/MFA blocks an automated login: a session cookie copied from a
  logged-in Sitewire browser tab (expires — the login above is preferred).
- Optional overrides: `SITEWIRE_WEB_BASE_URL`, `SITEWIRE_WEB_SIGNIN_PATH` (default `/users/sign_in`), `SITEWIRE_WEB_TIMEOUT_MS`.

The document WRITE uses only the confirmed field names above; a wrong login shape simply fails to authenticate
(fail-closed) and can never corrupt Sitewire property data. Every upload URL is https + host-allowlisted (the
Sitewire host, or an AWS S3 host Sitewire's own response handed us) — no SSRF.

## Note on the job-item `description` write (Feature B)
`pushJobItemDescription` PATCHes `budget.job_items[].description`. `description` is in the job_item GET
response but is NOT listed in the swagger's writable job_item body. It was built from an owner-provided
Sitewire capture. It is protected by read-after-write verify (a value that doesn't persist PARKS — never a
fake "synced"), so it fails closed if the API ignores it. Re-confirm against the live API before relying on it.
