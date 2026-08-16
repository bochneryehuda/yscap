# AGENTS.md — read this before you touch anything

This file is for **every AI agent and every developer** working in this repository. The full project guide is
`yscap-repo-root_8/CLAUDE.md`. Two things must be understood before any work begins.

## 1. The project lives in a subfolder

`package.json`, `src/`, `db/`, `web/`, `app/`, `app-v2/`, `docs/`, `scripts/` are all inside
**`yscap-repo-root_8/`**, not at the git root. Run every `npm` command from inside that folder.

## 1a. Build it the highest-end way, never the cheap way

**Owner-directed 2026-08-16, strict, over every change in both products:** *"everything that they build
should be built how Microsoft, Google, Apple, and the military would build something — which means
highest end, not cheapy. Even if there's a cheaper, easier way to do it, they should go the harder way."*

Not a licence to gold-plate a one-line fix — a ban on the cheap *shape*: the spot-patch, the second
copy, the hand-kept list, the assertion in place of a proof. Prove it against the real thing; make
every test fail on purpose before you trust it; one definition, never two; generate rather than
hand-maintain; fail closed and say so; never remove what something still depends on; pin your tools;
write the acceptance evidence before the step; stage anything that touches production. And report what
was **measured**, not what was hoped.

The full rule, with the ten tests spelled out: `yscap-repo-root_8/CLAUDE.md` → *"How to BUILD"*.

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
10. **The investor name never reaches a client — HARD RULE (owner-directed 2026-08-14):** *"The client should
    not be able to see the investor name. Never ever! Not borrowers, not TPOs, only internal staff."* The
    investor who buys a long-term loan — their name in any spelling, their contact details, their own loan
    number, and the funding channel — is internal knowledge, on every surface. `src/longterm/audience.js` is
    the one definition, built on the investor registry because the name is spelled 151 ways; it fails closed
    (anything not exactly `internal` is a client). Guarded by `scripts/test-lt-investor-block.js`. Never
    re-implement the check. See `docs/longterm/AUDIENCE-RULES.md`.

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

## 4. Migrations: ask for the number, and let the schema map refresh itself

**Never hand-pick a migration number by looking at `db/`.** Run:

```
cd yscap-repo-root_8
npm run migration:new -- "what the migration is for"
```

It writes `db/NNN_what_the_migration_is_for.sql` with the idempotent shape the boot-time runner
requires (every file in `db/` is replayed on EVERY boot, so a statement that throws the second time
breaks every future deploy — quietly, because the runner logs the failure and continues).

**Why the tool and not your own eyes:** the collision this prevents is between two sessions working on
two BRANCHES, and your working tree shows you only one of them. The tool takes the next number after
every one it can see across `db/` *and every git ref this clone knows about* — measured on this repo,
two numbers were claimed on another branch and present in no working tree. It prints what it searched
and states plainly that a branch nobody has pushed is invisible to it. It never re-uses a gap: a gap
exists *because* a number was abandoned, which usually means another branch still holds a file with it.
`scripts/check-migrations.js` is the gate that CATCHES a collision (it has fired three times: 033, 088,
113); this is what stops you creating one.

**Do not regenerate `docs/schema/` by hand.** When your migration changes the database, CI rebuilds the
map from the database your migrations actually build and commits it back to your pull request branch —
so `git pull` before your next commit and expect a commit from `github-actions[bot]`. It commits ONLY
the generated map files, it **never force-pushes** (if you pushed while it was working it does nothing
and leaves the refreshed copy attached to the run as an artifact), and it carries `[skip ci]`.

That job (`schema-push`) holds **the only write permission in the entire workflow**, and it must stay
the smallest job in it — its whole input is a checkout and an artifact. **Never move `contents: write`
onto the job that runs the test suite, and never put it at the workflow level.** The build fails if you
do: `scripts/test-ci-schema-commit-pure.js` counts them. The reasoning, and what Kubernetes, the Azure
SDK and SLSA's source track each do about bots writing to a trunk, is in
`yscap-repo-root_8/docs/SCHEMA-MAP-AUTO-REFRESH-RESEARCH.md`.

**If you must regenerate by hand, it is TWO commands, not one:** `npm run schema:snapshot` (needs a
`DATABASE_URL` built from these migrations) **and then** `npm run schema:restamp` (no database needed).
Stopping after the first leaves the map's header quoting the previous database's numbers and fails the
header test — following the old one-command advice broke a build once.
