# One readable schema for the whole system — the plan

**Status: RESEARCH COMPLETE, NOTHING BUILT. For owner approval.**

Owner-directed 2026-08-16, after deciding against the two-repo split: *"Why is our system on the
short-term side so messed up? It doesn't have a nice Prisma schema. The long term was set from the
ground up… Can we restart from the ground up with a Prisma schema to have one big database for
everything, or will this break some stuff in our system that is working already?"*

Supersedes `TWO-REPO-SPLIT-PLAN.md`, which is retained as the record of a decision not taken.

---

## 1. Three corrections before the plan

### 1.1 You already have one big database

RTL tables and `lt_*` tables live in the **same Postgres instance today**. `src/longterm/db.js` opens
its own pool but points at the same `DATABASE_URL`. There is nothing to merge, nothing to reroute, and
no second database to point anything at. The owner's stated fear — *"you're not going to realize what
else you need to reroute to the correct database"* — describes a migration that this plan does not
contain and does not need.

### 1.2 The short-term side is not "messed up" — it is undocumented

Measured against the current tree:

| | |
|---|---|
| Tables | **312** |
| Migration files | **549** |
| `ALTER TABLE` statements | **1,186** |
| Triggers | **57** |
| Functions | **95** |
| CHECK constraints | **323** |
| Partial indexes | **68** |
| Generated columns | **12** |

Nothing here is broken. What is missing is a **single readable picture**: to know what `applications`
looks like today you must read `schema.sql` and then replay 549 numbered files in order. That is the
actual complaint, and it is a documentation problem, not a data problem.

Long-Term looks better for one reason: **it is three weeks old and has no rows in it.** Its 1,100-line
Prisma schema is genuinely good practice — but it is good practice that RTL can adopt without being
young. Give LT 549 migrations at RTL's velocity and it will look identical unless the schema stays the
source of truth. The lesson to carry across is the *workflow*, not the youth.

### 1.3 Prisma is not currently a dependency of the RTL side at all

`package.json` `dependencies` is `express`, `heic-convert`, `jpeg-js`, `pdf-lib`, `pg`, `unpdf`. The
"no native deps so Render builds cleanly" rule in CLAUDE.md is why. **Nothing in this plan changes
that** — see §4.

## 2. Can we restart from the ground up? No — and the reason is specific, not generic

The generic reason is well known (Spolsky's *"single worst strategic mistake"*, Netscape shipping
nothing for three years while the market moved). It is true and it is the boring half of the answer.

**The specific reason for THIS system is much sharper: a large part of the business logic lives inside
the database, and the Prisma schema language cannot express any of it.**

Prisma's own documentation is explicit that its schema does not represent **generated columns**
(`@default(dbgenerated())` is a partial workaround), **check constraints**, **triggers** or
**functions**. This database contains 12, 323, 57 and 95 of them respectively — and they are not
decoration. A sample of what a Prisma-only picture would omit:

| Object | What it enforces | Where |
|---|---|---|
| `trg_sow_budget_guard` | refuses any write flipping a budget condition to satisfied unless start total = line-item total = file budget = product budget **to the cent** | db/069 |
| the economics-reopen trigger | reopens Products & Pricing (and the SOW) when any pricing input moves, from **every** write path at once | db/071, db/072 |
| `borrowers.full_name` | a **GENERATED column** — chosen deliberately over a trigger or app code *"so the one big field CANNOT drift from the pieces on any write path"* | db/346 |
| `trg_borrower_auth_one_login_per_email` | one portal login per address, raised as a real constraint violation | db/318 |
| `pilot_term_norm` / `pilot_property_type_norm` / `pilot_state_norm` | compare free text **by meaning**, so a formatting echo never flags a registration stale | db/288, db/322, db/326 |
| `trg_sync_primary_assignee` | keeps the denormalised officer pointer and the assignee rows in lock-step | db/103, db/392 |

Several of these have tests whose entire job is to prove they still bite. **A schema that silently
omits them is more dangerous than no schema at all**, because it looks complete: the failure mode is
someone in 2027 regenerating the database from it and losing 57 triggers without a single error.

So: **do not rebuild the database from a schema file.** The plan below gets the readable schema without
ever putting the database at risk.

## 3. The good news: the beautiful schema is a `db pull` away

`prisma db pull` **introspects an existing database and generates the schema file from it.** It reads
the catalog; it writes nothing. Point it at a restored copy and you have the one big picture in
minutes, with zero production risk.

That is the whole of Phase 0. Everything after it is polish.

## 4. The safe workflow already exists — in this repo, on the Long-Term side

`docs/longterm/LOS-BUILD-STRUCTURE.md` §3 documents it, and it is exactly right:

```
  prisma/schema.prisma          ← the single source of truth for the model
        ↓  prisma migrate diff
  db/NNN_*.sql                  ← made idempotent by hand, applied on boot
        ↓
  src/db.js                     ← the app reads through plain `pg`
```

> *"Prisma is the **schema tool**, not a runtime dependency … The generated Prisma client is never
> committed and never used at runtime."*

**This is the property that makes the whole thing safe.** Prisma never enters the request path, never
becomes a production dependency, and never rewrites a query. The 813 files of hand-written `pg` SQL
keep working exactly as they do today, because nothing about how the app talks to the database changes.

Adopt this for RTL and the answer to *"will it break something that is working"* is **structurally no** —
the only artefact produced is a text file plus SQL that a human reviews before it is applied.

## 5. For the 152 objects Prisma cannot hold — Atlas

Prisma's gap is real and is documented above. **Atlas** is a declarative schema tool built for exactly
that gap: it manages **views, triggers, stored procedures, row-level security** and other low-level
Postgres objects declaratively, and it is designed to run *alongside* Prisma rather than replace it —
Prisma even publish a joint guide. Prisma holds the tables and relations (the readable model); Atlas
holds the triggers, functions and constraints. Together the picture is complete and honest.

If only one is adopted, adopt Prisma first (it answers the owner's actual request) and treat the
trigger/function inventory as a known, written-down gap until Atlas lands.

## 6. The plan

### Phase 0 — Generate the schema. One afternoon, zero risk.
Run `prisma db pull` against a **restored copy**, not production. The backup system already restores
into a scratch database every week (`scripts/backup-verify.js`), so the copy and the guard rails
already exist. Output: `prisma/schema.prisma` describing all 312 tables. Nothing in production is
touched, nothing is deployed, and it can be thrown away and redone freely.

**Acceptance:** the generated schema round-trips — `prisma migrate diff` between it and the restored
copy reports **no difference**. If it does report one, that difference is something Prisma cannot see,
and it goes on the Atlas list.

### Phase 1 — Make it readable. Text editing only.
Introspection produces correct but ugly output (auto-named relations, no comments, no grouping). Clean
it up using LT's schema as the model — it is 1,100 lines of well-commented Prisma in this same repo,
written by the same standard. Group by domain, name the relations, and comment every non-obvious
column. Still zero runtime risk: it is a text file that nothing reads yet.

### Phase 2 — Write down what Prisma cannot hold.
Inventory the 57 triggers, 95 functions, 323 checks, 68 partial indexes and 12 generated columns, and
either bring them under Atlas or record them in a companion document. **Until this exists, the Prisma
schema must carry a header saying it is incomplete** — a picture that looks whole and is not is the
single biggest hazard this plan introduces.

### Phase 3 — Make it the source of truth, going forward only.
From here, a schema change is: edit `schema.prisma` → `prisma migrate diff` to generate the SQL → make
it idempotent by hand → new numbered `db/NNN_*.sql` → applied by the existing runner. Exactly LT's
workflow, and exactly the existing migration rules.

Carry LT's rule across verbatim: **a model in the schema and a migration for it land in the same
commit. A model with no migration is a lie about what exists.** Add a CI check that the schema and the
database agree, so the two can never drift — that check is the whole value of Phase 3.

**The 549 existing migrations are not touched.** Not squashed, not deleted, not rewritten. They are the
history and they still run on every boot.

### Phase 4 — Renaming for beauty. Optional, slow, possibly never.
The genuinely risky part, and the one that buys the least. `llcs` now holds corporations, partnerships
and trusts; CLAUDE.md already records the decision **not** to rename it, because ~200 files, nine
foreign keys, the ClickUp field map and the SharePoint folder resolver all reference it — *"a
mechanical change with a real chance of a silent miss, buying nothing a human can see."*

If any renaming is ever done, do it one column at a time by **Parallel Change** (add the new alongside
the old, migrate every reader, then remove — never remove something until nothing depends on it).
Never as a sweep.

## 7. What this plan explicitly does NOT do

- **Does not adopt the Prisma Client at runtime.** That would be the actual rewrite: 813 files of
  hand-written SQL, including 78 writers to `borrowers` alone. Not proposed, now or later, without a
  separate decision.
- **Does not let `prisma migrate` own the database.** It wants to own migration history and can propose
  destructive resets against a database it did not create. Only `migrate diff` is used — it generates
  SQL and applies nothing.
- **Does not rebuild the database from the schema.** See §2.
- **Does not squash or delete the 549 migrations.**
- **Does not move any data, or point any code at a different database.** There is one database and the
  app keeps using the same connection it uses today.

## 8. What carries over from the abandoned split plan

The repo split is not happening. Two items from that research stand on their own merits and are worth
keeping:

1. **Affected-target CI.** `npm test` is 892 chained steps. Running only what a change affects is the
   documented single biggest lever on CI time, and it was never a split/no-split question.
2. **CODEOWNERS on the identity zone.** A named human on any change to `borrowers`, `staff_users`, the
   auth module and the shared editor. Cheap, and it is the two-person rule expressed in a tool the repo
   already has.

## 9. Open question for the owner

**How far do you want Phase 4 to go?** Phases 0–3 give you the readable schema and cost essentially no
risk. Phase 4 — actually renaming tables and columns so the names read nicely — is where the danger
lives and where the benefit is mostly cosmetic. My recommendation is to do 0–3 and stop, then decide
about 4 with the picture in front of you rather than before.
