# Long-Term Loans (LT) — back end

This folder is the **entire Long-Term product back end**. LT is a brand-new build,
separate from RTL in every way except the shared identity zone. Read
`docs/LONG-TERM-LOANS-SEPARATION-CHARTER.md` and the crossing ledger
`docs/LONG-TERM-AUTHORIZED-COPIES.md` before touching anything here.

**The hard rule:** nothing crosses between RTL and LT without the owner's written
authorization in the ledger. The CI gate `scripts/check-product-separation.js`
enforces it on every `npm test` and in CI.

## Layout

```
src/longterm/
├─ prisma/schema.prisma   ← the SINGLE SOURCE OF TRUTH for the LT data model
├─ config.js              ← LT's own env config (reads process.env; no RTL import)
├─ db.js                  ← LT's own pg pool (its own connection to the shared DB)
├─ lib/                   ← LT data access + logic (touches only lt_* tables)
├─ routes/                ← HTTP handlers under /api/lt/*
└─ index.js               ← builds + exports the LT router (the one mount seam)
```

- **Tables:** only `lt_*`. **HTTP:** only `/api/lt/*`. **Migrations:**
  `db/NNN_lt_*.sql`. **Tests:** `scripts/test-lt-*.js`.
- The single back-end seam is `src/server.js` mounting `require('./longterm').router`,
  staff-authenticated at the mount.

## How Prisma is used here (important)

Prisma is the **schema tool** for LT — it defines the data model beautifully in
`prisma/schema.prisma`, and we generate the DDL from it. Prisma is **not** a runtime
or build dependency of the app:

- The app reads LT tables through LT's own `pg` pool (`db.js`), the same pattern
  every other backend module in this repo uses. This keeps the shared Render build
  exactly as clean as it is today (no native engine, no new dependency).
- The DDL reaches Postgres through the repo's **one** migration path
  (`db/NNN_lt_*.sql`, applied by `src/migrate-boot.js` on boot). That keeps a single
  migration system, keeps the separation gate effective over LT schema, and keeps
  the off-site backup covering LT automatically.
- The generated Prisma **client** is deliberately NOT committed and NOT used at
  runtime: Prisma's own runtime files contain example SQL that the separation gate
  reads as a crossing. The schema's `generator` outputs only into `node_modules`.

### Regenerating / verifying the DDL from the schema

Prisma is not installed in the repo (on purpose). Use it ad-hoc from the `prisma/`
folder, e.g.:

```bash
cd src/longterm/prisma

# 1) Emit the DDL for the whole schema (to sanity-check a new/changed model):
npx --yes prisma@7 migrate diff --from-empty --to-schema schema.prisma --script

# 2) After adding/changing a model here, write the matching idempotent
#    db/NNN_lt_*.sql by hand (CREATE TABLE IF NOT EXISTS / seeds ON CONFLICT), then
#    confirm the columns/types match what step 1 printed.
```

When you add a model to `schema.prisma`, add the matching `db/NNN_lt_*.sql` in the
same commit — the schema and the migration must always agree.

## What is built today

- **`lt_encompass_milestones`** — the Encompass milestone / status catalog (the
  "memory of the long-term side of Encompass"), seeded by `db/547`. Read-only via
  `GET /api/lt/encompass/milestones[/:id]`.
- **`encompass/`** — Long-Term's full Encompass integration + knowledge (owner-
  authorized 2026-08-14). A self-contained **read-only** API client, plus the
  "memory": the Milestone Completion rules, a unified field catalog (every known
  Encompass field, with when/why it's needed and any RTL usage), the request/auth
  catalog, and the RTL reconciliation map (labeled). All reference-only — nothing is
  enforced. See **`docs/longterm/ENCOMPASS-INTEGRATION.md`** and `encompass/README.md`.
  Served read-only at `/api/lt/encompass/{summary,fields,completion-rules,requests,
  reconciliation-map,status}`.

## What is NOT built (future / owner-directed)

Attaching a milestone to an actual long-term file, changing / rolling back a file's
status, and syncing with Encompass are future work. Conditions, document
underwriting, and orders are explicitly out of scope (see the charter and ledger).
