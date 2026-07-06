# The Condition Center

Admin-authored conditions with a rule engine — no developer needed to add,
reword, retire, or auto-apply conditions anymore.

## The three surfaces

| Surface | Who | Where | What |
|---|---|---|---|
| **Condition studio** | `manage_conditions` capability (admin / software_setup by default) | `/internal/conditions` | Author the global library: every definition (built-in + custom), wording, type, internal/external visibility, category, and *when it applies* (every file / rule-based / manual) with a visual rule builder + live "matches N of M open files" preview. Information conditions can **create a brand-new field** inline (see Custom fields). |
| **Per-file panel** | all staff | Loan file → *Conditions to close* → "Add a condition" | One-off conditions of any type on a single file, attach a library definition, re-run the automatic rules for that file. |
| **Borrower portal** | borrower | Loan file → *Conditions to close* | External conditions render by type: document upload (slots → Documents space → TPR), information field (typed input that writes into the real field), forms/tools, e-sign (visible now, ceremony activates with the DocuSign integration). |

## Custom fields (038)

An information condition can target a built-in writable field **or a brand-new
field created on the spot** (built-in fields can be filled elsewhere; a custom
field is data only that condition collects). `custom_fields` holds the
definition (label, type, dropdown options, borrower wording);
`application_field_values` holds each file's answer as jsonb. The field
registry merges built-in + active custom fields at runtime
(`field-registry.js fieldMap()`), so a custom field is usable in the rule
builder like any other. Deleting a custom field that has values or conditions
deactivates it (kept for existing rules/answers); an unused one hard-deletes.

## Roles & permissions (039)

Seven staff roles — `super_admin`, `admin`, `underwriter`, `loan_officer`,
`loan_coordinator`, `processor`, `software_setup` — plus a per-user
`permissions` jsonb of capability overrides on top of the role's defaults
(`src/lib/permissions.js`). Capabilities: `see_all_files`,
`sign_off_conditions`, `manage_conditions`, `waive_conditions`, `delete_files`,
`manage_vendors`, `manage_team`, `platform_setup`. `super_admin` implicitly has
all. Gates check capabilities (`can(actor, cap)` / `requirePermission(cap)`)
rather than hard-coded role lists, so an admin can grant a coordinator "see all
files" or a specific underwriter "manage the Condition Center" from the Team
screen with no code change. `authenticate` resolves the DB role + overrides
onto `req.actor` every request, so grants take effect immediately (no
re-login); `/auth/me` returns the resolved capability list for the SPA to gate
nav/screens the same way.

## Condition types

`document` · `info_field` (linked to a writable field in the registry; the
borrower's answer is written straight into the real column) · `tool` (rehab
budget / track record / title contact / insurance contact / product pricing /
appraisal card) · `esign` (stub — `esign_envelopes` table + status model ready
for DocuSign Connect) · `internal_task` · `internal_condition`.

Types map onto the existing storage model: `checklist_templates.item_kind` +
`tool_key` (`info_field` and `esign` are new tool_keys), so document conditions
inherit the whole existing machinery — upload slots, review lifecycle, the
Documents space, TPR missing-list and clean-file export — with zero extra code.

## Internal vs external

`audience` on every definition/item: `borrower` (**external** — shows on the
borrower's list, notifies them, uses `borrower_label`/`borrower_hint` wording
only), `staff` (**internal** — never leaves the console), `both`. Internal
wording (which may carry capital-partner context) is never sent to a borrower.

## The rule engine

- **Field registry** — `src/lib/conditions/field-registry.js`. ~45 fields
  across Loan & program / Property / Deal economics / Borrower & experience /
  Entity, each typed (`money | number | percent | text | enum | boolean |
  date`) with canonical enum values. Raw DB free-text is normalized (e.g.
  "Refinance — Cash-Out" and "Refi Cash-Out" → `refinance_cash_out`) so rules
  keep matching however the data was typed. Computed fields (loan/ARV %,
  loan/cost %, verified experience counts, registered program) come from
  `engine.loadRuleContext()`.
- **Rules** — `src/lib/conditions/rules.js`. Stored on
  `checklist_templates.rule_logic` (jsonb) as `{combinator: and|or, rules:
  [{field, operator, value} | group]}`, max one nested group level (the
  ALL-of/ANY-of pattern). Typed operator sets (`is / is not / is any of / is
  none of / more than / less than / at least / at most / between / contains /
  starts with / is empty …`). Evaluation is a whitelisted pure walk — field
  keys and operators are validated against the registry on save; nothing is
  eval'd or interpolated into SQL. Missing data never fires a rule (except
  the explicit `is empty` operator).
- **Engine** — `src/lib/conditions/engine.js`. `auto_apply` semantics:
  - `NULL` — legacy: instantiated once at file creation by
    `generateChecklist()` (which now skips engine-managed templates).
  - `always` — kept on every open file.
  - `rules` — attached while `rule_logic` matches; **retracted only if the
    engine added it and nobody touched it** (still outstanding, no docs, no
    notes, no review/sign-off, no payload). Anything touched stays — waive or
    un-require it manually. Industry-standard snapshot semantics: issued items
    copy the template wording + version; editing a definition never rewrites
    conditions already on files.
  - `manual` — library-only; staff attach per file.
  - Duplicate suppression is per `(application, template)` — a satisfied
    condition never reappears because data wobbled.
- **Re-evaluation hooks** — application create/submit, staff details PATCH,
  status change, product registration (both portals), rehab-budget sync (both
  portals), borrower profile save (fico/citizenship/address), LLC link,
  track-record verification, borrower info-condition answers — plus the manual
  "Re-run rules" buttons (per-file and global) and automatic sweep on
  definition create/update (`runNow`).

## API

Admin (`/api/admin/conditions/*`, admin+super_admin):
`GET fields` · `GET/POST definitions` · `PATCH/DELETE definitions/:id`
(delete retires the definition if instances exist) · `POST preview-rule`
(validate + count matching open files) · `POST run-all`.

Staff (`/api/staff/…`, any staff, path-scoped like every file route):
`GET conditions/meta` · `POST applications/:id/conditions/custom` ·
`POST applications/:id/conditions/attach` ·
`POST applications/:id/conditions/reevaluate`.

Borrower: `POST applications/:id/checklist/:itemId/info` — validates and
writes the answer into the mapped column (whitelisted in
`field-registry.js WRITE_TARGETS`), flips the item to `received`, notifies the
loan team, re-runs the engine. The checklist GET decorates info items with
`field_def` (type/options/borrower wording) + `field_value`.

## Schema (`db/037_condition_center.sql`)

`checklist_templates` + `rule_logic jsonb`, `auto_apply`, `field_key`,
`category` (prior_to_approval → post_closing), `esign_doc`, `origin`
(system|admin), `version`, created/updated audit columns.
`checklist_items` + `field_key`, `category`, `esign_doc`, `origin_kind`
(auto | manual_library | manual_custom), `origin_detail jsonb` (rule summary +
template version at issuance). New `esign_envelopes` table (DocuSign-ready:
envelope id, status lifecycle, completed-document link).

## Auditing

Engine passes audit as `conditions_auto_evaluated` (with added/removed labels)
and surface in the file Activity feed; studio writes
`condition_def_created/updated/activated/deactivated/deleted`; per-file adds
write `add_condition_custom` / `attach_condition`.

## Gotchas

- The studio edits **definitions**; issued items are snapshots. "On N files"
  in the studio shows the blast radius before you edit/retire.
- Built-in (origin=system) templates are fully editable and can be switched to
  rule-based; `generateChecklist` and the engine hand off cleanly via
  `auto_apply IS NULL`. LLC-scoped and borrower-profile templates cannot be
  rule-driven (they belong to the entity/profile workflows).
- Deleting a definition with instances only deactivates it — hard delete is
  reserved for never-used definitions.
