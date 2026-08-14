# AGENTS.md — read this before you touch anything

This file is for **every AI agent and every developer** working in this repository. The full project guide is
`yscap-repo-root_8/CLAUDE.md`. Two things must be understood before any work begins.

## 1. The project lives in a subfolder

`package.json`, `src/`, `db/`, `web/`, `app/`, `app-v2/`, `docs/`, `scripts/` are all inside
**`yscap-repo-root_8/`**, not at the git root. Run every `npm` command from inside that folder.

## 2. There are TWO products, and they are TWO systems that never mix

**Owner-directed, 2026-08-02. Strict, hard rule, no exceptions.**

- **RTL — Residential Transition Loans** (bridge + ground-up construction + fix & flip). Everything built in this
  repo before 2026-08-02 is RTL. It is the **main product**.
- **LT — Long-Term Loans.** Brand new, starts at **zero**. A **side build for visibility only — not live**, no
  borrowers, no production traffic. It may become a full system later.

Treat them as two different companies' software that happen to share one repository. The owner's comparison:
*"if I'm telling you to build something you don't know if you should build this for Amazon or for eBay — you ask."*

1. **Never assume which side a request is for.** If it is not stated or not 100% obvious — **stop and ask**. Never
   guess, never do both, never pick the likelier one.
2. **The ONE shared zone is identity, and LT only READS the person record** (owner-directed 2026-08-03: *"same
   login same borrower record, keep it separate everything else"*). Three zones, not two: **shared identity**
   (`src/auth/index.js`, the `borrowers` person record, the `staff_users` roster, the one shared borrower editor
   `app-v2/src/components/BorrowerProfilePanel.jsx`, and the officer↔person link `borrower_officers`), the **RTL
   product**, and the **LT product**. A borrower sees all their files in one place and an officer sees all of
   theirs — both products, each stamped — which is why an LT file points at those shared records. **LT never
   writes `borrowers`**: an officer CAN change a borrower profile from a long-term file, but through that one
   shared editor and the existing `PATCH /api/staff/borrowers/:id`, so the person record keeps a single writer.
   LT DOES write one identity table — `borrower_officers` — because otherwise the visibility rule (which resolves
   an officer's relationship through `applications`, an RTL table) would refuse the very officers this was meant
   for. Everything else is a brand-new LT build: *"the workflow will be different, the sets will be different,
   integrations will be different."* The `authorized` block in
   `yscap-repo-root_8/docs/LONG-TERM-AUTHORIZED-COPIES.md` is the complete crossing list — 8 lines, all identity.
3. **Nothing else crosses without the owner's explicit written authorization, per item** — no copying, re-using,
   importing, extending, generalizing or sharing of code, tables, columns, migrations, conditions, templates,
   endpoints, screens, components, prompts, mappings or integrations, in either direction. Ask → get it in writing →
   record it in `yscap-repo-root_8/docs/LONG-TERM-AUTHORIZED-COPIES.md` → then build.
4. **The back end is separate.** LT lives only in `src/longterm/**` (back end), `app-v2/src/longterm/**` (front
   end), `/api/lt/*`, `lt_*` tables and trigger functions, `db/NNN_lt_*.sql`, `scripts/test-lt-*.js`. No LT table
   references an RTL table, no trigger crosses, no shared writer, service module or database pool — and LT may not
   reach an RTL table by raw SQL either (a crossing does not need a `require()`). The only permitted seams are
   `src/server.js` mounting the LT router and `scripts/test-lt-*.js`, which exist to test it.
5. **Never change RTL to make LT work** — no new column on `applications`, no new ClickUp/Encompass/SharePoint/
   DocuSign/Sitewire/Trustpoint mapping, no new checklist template, unless the owner asked for that exact thing.
6. **LT is explicitly not getting, for now: document underwriting, orders.** **Conditions ARE now in scope** — the
   owner reopened this in writing on 2026-08-14 and asked for a long-term condition center that reads its conditions
   from Encompass. It is a brand-new LT build: rule 3 still applies in full, so nothing may be copied or generalized
   from RTL's conditions / checklists / templates / rules engine without a per-item entry in the ledger. Writing a
   document into the Encompass eFolder is a WRITE and is separately governed by
   `docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md` — nothing writes there until that pad entry is completed.
7. **The front end may show both; the back end may not.** A combined pipeline is allowed, read-only, with a visible
   product stamp on every row and a Both / RTL only / Long-Term only filter. Never a SQL join or a shared write path.
8. **A feature built for one side never automatically applies to the other.**
9. **When in doubt, ask. Silence is never permission.**

Enforced by `yscap-repo-root_8/scripts/check-product-separation.js` (runs in `npm test`, blocks CI and the deploy),
`.github/pull_request_template.md`, and `.github/PRODUCT-SEPARATION.md`. Do not weaken or bypass the gate —
fix the crossing, or get written authorization and record it in the ledger.

**A green build is not proof that nothing crossed.** The gate sees structural crossings (imports, raw SQL,
foreign keys, columns, migrations, triggers, its own wiring). It cannot see RTL code copied by value into an LT
folder, a plainly-named column added to an RTL table for LT, or a new field mapping. Rules 1, 4, 5, 7 and 8 are
on you.

Design and research behind the split: `yscap-repo-root_8/docs/LONG-TERM-LOANS-SEPARATION-CHARTER.md`.

## 3. Encompass is READ-ONLY — the hardest rule, on top of all the rules

**Owner-directed 2026-08-14. Applies to BOTH products and every program.** PILOT ↔ Encompass is **one-way**.
We **READ** — loans, fields, milestones, settings, and inbound **webhooks** — as much as we want. We **NEVER
WRITE** to Encompass: no PATCH/PUT/POST/DELETE that changes a loan, a field, a milestone, an eFolder document, or
anything else.

- **The ONLY writes allowed are the ones the owner authorized IN WRITING for a specific endpoint/field**, recorded
  in `yscap-repo-root_8/docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md` (the pad). Today that is exactly one: flood-
  determination ordering (`src/encompass/flood-order.js`, RTL only).
- **No agent, and no person, may ever GUESS a write.** "It probably needs updating" is never authorization. Only
  the specific thing the owner wrote, super-admin-gated and audited.
- Enforced by `yscap-repo-root_8/scripts/check-encompass-readonly.js` (runs in `npm test`, blocks CI/deploy). Any
  Encompass write not in the pad fails the build. **Do not weaken or bypass this gate** — to add a write, get the
  owner's written authorization and add it to the pad.
- The strongest enforcement is ALSO at the credential level: the Encompass API user's persona should be set
  read-only in ICE, so a write is refused by Encompass itself — see the pad.
