# ONE CONDITION CENTER, TWO PRODUCTS — the sharing architecture
## (implements docs/longterm/SHARE-THE-CODE-DIRECTIVE.md; facts below verified first-hand, file:line)

## The decision: the LT loan becomes a FOURTH SCOPE of the existing machinery

The RTL Condition Center was designed multi-owner from day one:

- `checklist_templates.scope IN ('application','borrower_profile','llc')` (db/schema.sql:224)
- `checklist_items.scope` + `chk_one_owner` — EXACTLY ONE of application_id /
  borrower_id / llc_id (db/schema.sql:236-254)
- `documents` — denormalized nullable owners application_id / borrower_id / llc_id
  (db/schema.sql:263-278)

**The Long-Term loan joins as scope `'lt_loan'`:** a new nullable `lt_loan_id uuid
REFERENCES lt_loans(id) ON DELETE CASCADE` on `checklist_items` and `documents`,
`chk_one_owner` widened to the 4-way sum, and the scope CHECKs widened. That single
move is what makes the owner's sentence structurally true — *"take that exact
Condition Center and make your conditions in that Condition Center follow those
rules"* — because there is then literally ONE templates table, ONE items table, ONE
documents table, ONE upload/review path, ONE SharePoint mirror and ONE backup, and
the LT rows are just another owner.

## Why nothing RTL can touch the LT rows (verified, not hoped)

Every RTL selector is SCOPE-FILTERED already:
- the rules engine takes `scope = 'application'` templates only (src/lib/conditions/engine.js:356);
- `generateChecklist` takes `scope IN ('application','borrower_profile')` + `scope='llc'` (src/routes/borrower.js:4602, 4653);
- every per-file pass joins through `application_id` — an lt_loan row has none.

So an LT template can never attach to an RTL file, and an RTL sweep can never see an
LT condition. (The full trigger/sweep danger audit is the scout inventory; each entry
lands in the implementation with a verdict and, where needed, a guard + test.)

## What each subsystem costs under this architecture

| Subsystem | What it takes | Why it is nearly free |
|---|---|---|
| Document upload (drag-drop, both transports) | Extract the RTL door's handler (staff.js:19207 `uploadAppDocument`) into a lib both products call; an `/api/lt` door passes the lt scope | takeUpload / upload-bytes / storage / dedupe already shared |
| Preview / accept / reject / download / delete | Same extraction pattern; `serve-document` already one definition | the verbs are already lib-shaped or small |
| SharePoint | `pendingBatch` already selects EVERY documents row with a storage_ref (sharepoint-backup.js, no owner filter) — only `scopeKeyFor` / the folder resolution learns the lt_loan scope (officer/borrower/address off `lt_loans`) | one mirror, one policy, zero second pipeline |
| Cloudflare/off-site backup | NOTHING — `backup/documents.js` copies the WHOLE bucket (`source.list('')`, line 74) and pg_dump takes no table list, so `lt_*` tables + LT bytes are already covered | verified; needs only a proving test |
| Conditions engine | Shared rule EVALUATOR + template/instance machinery; a per-product rule CONTEXT builder (RTL reads applications, LT reads lt_loans — different tables is a fact, not a fork) | rules.evaluateRule is pure |
| The front end | The already-componentized UI (ConditionLine, ConditionActions, DocPreview, UploadRows, AddConditionPanel, OrdersPanel, FileContacts, EmailPreview — app-v2/src/components) reads its api from a CONTEXT that defaults to the staff api; the LT screen provides an adapter with the same method names against /api/lt | RTL renders byte-identically (default context = the same object) |
| Orders | The RTL desk (src/lib/orders.js + file_orders + OrdersPanel.jsx) parameterized the same way; the wire layer (order-email, file-address, inbound-mail, send-as, docusign) is ALREADY genuinely shared — src/lib/orders.js itself requires order-email.js | the reinvented lt_file_orders desk is deleted |
| Entity / LLC | `llcs` is the shared identity zone; the llc-scoped templates/slots/documents ALREADY exist and already mirror — the LT vesting condition mounts the SAME LlcManager + llc.js against the same profile | verified once, verified forever, both products |

## The ground rules that survive from the separation law

- LT LOANS stay `lt_loans`; nothing here puts an LT loan into `applications`.
- Every new crossing gets its `import` / `sql-write` line in the crossing ledger in
  the PR that lands it, under the 2026-08-30 share-the-code grant.
- Extraction, never mutation: when a handler moves out of staff.js into a lib, the
  RTL route keeps calling it and a test proves RTL behavior byte-identical —
  *"watch what you're doing not to break the other side of the business."*
- LT keeps its own WORDING (templates seeded with the owner's language and buckets)
  and its own LOOK (header strip, stamp, fonts) — sharing is code, not copy.
