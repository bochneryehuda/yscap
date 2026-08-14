# PILOT has TWO products. They are TWO systems. They never mix.

**Owner-directed, 2026-08-02. Strict, hard rule, no exceptions.** This file is the GitHub-side copy of the law
that also lives in `yscap-repo-root_8/CLAUDE.md` ("TWO PRODUCTS, TWO SYSTEMS") and in `AGENTS.md` at the git root.
If the three ever disagree, `CLAUDE.md` wins and the others must be corrected to match.

| | **RTL** | **LT** |
|---|---|---|
| Full name | Residential Transition Loans | Long-Term Loans |
| What it covers | Bridge, ground-up construction, fix & flip | Long-term / stabilized lending |
| Status | **The main product.** Everything built before 2026-08-02 | **Brand new, starts at zero.** Side build, **not live**, no borrowers, no production traffic |
| Where it lives | Everywhere else in the repo | `src/longterm/**` (back end), `app-v2/src/longterm/**` (front end), `/api/lt/*`, `lt_*` tables + trigger functions, `db/NNN_lt_*.sql`, `scripts/test-lt-*.js` |

Think of them as **two different companies' software that happen to share one repository** — the owner's own
comparison: *"if I'm telling you to build something you don't know if you should build this for Amazon or for
eBay — you ask."*

## The nine rules

1. **Never assume which side a request is for.** Not stated, or not 100% obvious? **Stop and ask.** Never guess,
   never "do both to be safe," never pick the likelier one.
2. **The one shared zone is identity, and LT only reads the person record** (owner-directed 2026-08-03: *"same
   login same borrower record, keep it separate everything else"*). Three zones, not two: **shared identity**
   (`src/auth/index.js`, the `borrowers` person record, the `staff_users` roster, the one shared borrower editor
   `app-v2/src/components/BorrowerProfilePanel.jsx`, and the officer↔person link `borrower_officers`), the **RTL
   product**, and the **LT product**. A borrower sees all their files in one place, an officer sees all of theirs —
   both products, each stamped. **LT never writes `borrowers`**: an officer CAN change a borrower profile from a
   long-term file, but through that one shared editor and the existing `PATCH /api/staff/borrowers/:id`, so the
   person record keeps a single writer. LT DOES write one identity table — `borrower_officers` — because otherwise
   the visibility rule (which resolves an officer's relationship through `applications`, an RTL table) would refuse
   the very officers this was meant for. Everything else is a brand-new LT build. The `authorized` block in
   `yscap-repo-root_8/docs/LONG-TERM-AUTHORIZED-COPIES.md` is the complete crossing list — 8 lines, all identity.
3. **Nothing else crosses without the owner's explicit written authorization, per item.** No copying, moving, re-using,
   importing, extending, generalizing or "sharing" of code, tables, columns, migrations, conditions, templates,
   endpoints, screens, components, prompts, mappings or integrations — in either direction. Wanting to re-use
   something is fine and expected: **ask, get it in writing, record it in
   `yscap-repo-root_8/docs/LONG-TERM-AUTHORIZED-COPIES.md`, then build.** Authorization is per item, never blanket.
4. **The back end is separate, always.** LT code only in `src/longterm/**` (back end) and `app-v2/src/longterm/**`
   (front end); LT HTTP only under `/api/lt/*`; LT tables and trigger functions only named `lt_*`; LT schema only in
   its own `db/NNN_lt_*.sql` files; LT tests only `scripts/test-lt-*.js`. No LT table may reference an RTL table, and
   LT may not reach an RTL table by raw SQL either — a crossing does not need a `require()`. No trigger crosses. No
   shared writer, service module, database pool, queue row, or condition/checklist template. The **only** permitted
   seams are `src/server.js` mounting the LT router and `scripts/test-lt-*.js`.
5. **Do not touch RTL in order to build LT.** No new column on `applications` or any RTL table, no new ClickUp
   mapping, no new Encompass / SharePoint / DocuSign / Sitewire / Trustpoint wiring, no new checklist template,
   no new enum value — unless the owner asked for **that exact thing**.
6. **LT is explicitly NOT getting, for now: document underwriting, orders.** Don't build them, don't
   stub them, don't "leave room" for them by copying RTL shapes.
   **CONDITIONS ARE NOW IN SCOPE (owner-directed 2026-08-14)** — the owner asked in writing for a long-term
   condition center that pulls its conditions from Encompass and links their documents. It is a brand-new build in
   `src/longterm/**` / `lt_*` / `/api/lt/*`; **rule 3 is unchanged**, so nothing may be copied, re-used or
   generalized from RTL's conditions, checklists, `checklist_templates`/`checklist_items`, the Condition Center
   rules engine or the document/eFolder code without a per-item entry in the ledger. Reading Encompass conditions is
   a read; writing a document into the Encompass eFolder is a WRITE, governed by
   `docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md`, and is not permitted until that pad entry is completed.
7. **The front end may show both; the back end may not.** One pipeline may list both, with filters
   (Both / RTL only / Long-Term only) and a **visible product stamp** on every row and every file header. The merge
   happens in the read/view layer only — never a SQL join, a shared table, or a shared write path.
8. **A feature built for one side never automatically applies to the other.** "Every fix is all-sides" means every
   surface of *that* product. It never reaches across.
9. **When in doubt, ask. Silence is never permission.**

## How this is enforced

| Where | What |
|---|---|
| CI (`npm test` → `scripts/check-product-separation.js`) | Blocks a PR and the auto-deploy on any crossing: an LT module importing RTL code (or the reverse), LT reaching an RTL table in raw SQL (or the reverse), RTL back-end code calling `/api/lt`, an `lt_*` table with a foreign key to an RTL table, an LT-named column added to an RTL table, a migration touching both sides, a trigger or function carrying one product's logic onto the other's table, an LT table or function not named `lt_*` — and any attempt to delete these rules or unwire the gate. `scripts/test-product-separation-gate.js` proves it still catches all of that. |
| Pull requests | `.github/pull_request_template.md` — the "which product" answer and the separation checklist are mandatory. |
| AI agents | `AGENTS.md` (git root) and `yscap-repo-root_8/CLAUDE.md`. |
| Written authorization | `yscap-repo-root_8/docs/LONG-TERM-AUTHORIZED-COPIES.md` — the ledger. The CI gate reads it; an entry there is the only thing that makes a crossing legal. |
| Design / research | `yscap-repo-root_8/docs/LONG-TERM-LOANS-SEPARATION-CHARTER.md`. |

**Do not weaken, bypass, baseline, or "temporarily" disable the gate.** If it blocks you, the answer is either to fix
the crossing or to get written authorization and record it in the ledger — never to edit the gate.

**A green build is not proof that nothing crossed.** CI sees *structural* crossings. It cannot see RTL code copied
by value into an LT folder, a plainly-named new column added to an RTL table for LT's benefit, a new ClickUp or
Encompass mapping, or a new checklist template. Rules 1, 4, 5, 7 and 8 rest on the person doing the work — which
is what the PR checklist is for.
