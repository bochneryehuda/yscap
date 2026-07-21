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

## Documents — NO API upload
There is **no document-upload endpoint** in the API. Documents can only be READ (property `documents[].src`
are `active_storage` blob-redirect links). Upload on the website is a Rails ActiveStorage direct-upload flow
(`/rails/active_storage/direct_uploads` → S3 PUT → `/properties/{id}/property_documents`) that requires a
browser session + CSRF token — the API token cannot do it. Pushing the appraisal/SOW documents into Sitewire
therefore needs a non-API workaround (or Sitewire adding an API endpoint).

## Note on the job-item `description` write (Feature B)
`pushJobItemDescription` PATCHes `budget.job_items[].description`. `description` is in the job_item GET
response but is NOT listed in the swagger's writable job_item body. It was built from an owner-provided
Sitewire capture. It is protected by read-after-write verify (a value that doesn't persist PARKS — never a
fake "synced"), so it fails closed if the API ignores it. Re-confirm against the live API before relying on it.
