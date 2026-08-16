# One readable schema for the whole system — the plan

**Status: PHASES 0–3 ALL BUILT — 1, 2, 3, the 3b enrichment, 3c, and both §6c/§8 carry-overs.
PHASE 4 IS CLOSED BY THE OWNER (2026-08-16): _"we are not renaming anything. Please don't do the risky
stuff."_ It is not deferred and not pending a later decision — it is off. Do not reopen it, do not
propose it, and do not rename a table, a column or a relation as part of any other work. The map records
the relationship layer, tells you when it has fallen behind with no database needed to ask, and now has
a browsable picture — `docs/schema/PICTURE.html`. The one thing left in Phase 3 is a decision, not code
(§6d); §8.2's CODEOWNERS was evaluated and rejected on measurement, with a working substitute built in
its place. Phase 4 remains not approved and probably never.**

Owner-directed 2026-08-16, after deciding against the two-repo split: *"Why is our system on the
short-term side so messed up? It doesn't have a nice Prisma schema. The long term was set from the
ground up… Can we restart from the ground up with a Prisma schema to have one big database for
everything, or will this break some stuff in our system that is working already?"*

Supersedes `TWO-REPO-SPLIT-PLAN.md`, which is retained as the record of a decision not taken.

---

## 0. The dry run — Phase 0 has already been performed, on a throwaway database

Owner-directed 2026-08-16: *"make sure that it's zero risk and everything will work perfectly, like it
works now … do research on how Google will do that, and how the military will do that."*

The transferable military practice here is **Test Like You Fly** — an aerospace/DoD mission-assurance
process whose founding observation is that post-mortems of lost missions repeatedly traced the root
cause to *insufficiently realistic testing: the system meeting real conditions for the first time in
flight.* So this procedure was rehearsed end-to-end against a real Postgres 16 built from the real
migrations, before proposing it. Everything below is **measured, not estimated.**

**What was run** (scratch cluster, created and destroyed; production never contacted):

```
initdb → createdb → npm run migrate        # all 549 migrations, exactly as CI does
prisma@6 db pull                            # introspect
prisma@6 migrate diff --from-empty          # what a rebuild-from-schema would produce
prisma@6 migrate diff --exit-code           # the drift check Phase 3 depends on
```

**Result 1 — every migration applies cleanly to an empty database.** All 549, no failures. The real
object counts, read from the catalog rather than grepped from files:

| | |
|---|---|
| Tables | 309 |
| Columns | 5,106 |
| Foreign keys | 662 |
| Indexes | 1,078 (309 of them partial) |
| Functions | 136 |
| Triggers | 33 |
| CHECK constraints | 247 |
| Generated columns | 12 |
| Views | 0 |

**Result 2 — introspection produced a complete, usable schema.** `prisma db pull` generated
**8,271 lines**: **309 models**, **11 enums**, relations wired, indexes named, exactly one field it
could not type (`Unsupported(...)`). This is the deliverable the owner asked for, and it took minutes.

**Result 3 — introspection is provably read-only.** Object counts before and after the pull were
identical (309 tables / 33 triggers / 136 functions). It reads the catalog and writes nothing.

**Result 4 — the drift check works.** `prisma migrate diff --exit-code` between the schema and the
database returned **0** (they agree). That is the CI gate Phase 3 rests on, and it is confirmed
functional against the real schema.

**Result 5 — and the decisive one. A database rebuilt from that schema file would silently lose 736
objects:**

| Object | In the SQL Prisma would generate | In the real database |
|---|---|---|
| Triggers | **0** | 33 |
| Functions | **0** | 136 |
| CHECK constraints | **0** | 247 |
| Generated columns | **0** | 12 |
| Partial indexes | **0** | 308 |

> **CORRECTION, 2026-08-16.** This total was first reported as **737**, with 309 partial indexes. It
> was wrong. That first count matched index definitions with `indexdef ILIKE '%WHERE%'`, which also
> caught `idx_market_obs_where` — an index that merely has "where" in its NAME and is not partial at
> all. The real test is `pg_index.indpred IS NOT NULL`, Postgres's own record of the clause, which
> gives **308** and a total of **736**. `scripts/schema-inventory.js` now asks the catalog rather than
> grepping text, and `test-schema-snapshot-db.js` pins the two counts against each other so the cheap
> version cannot come back. Recorded rather than quietly amended, because a confidently wrong number
> is exactly what the build rule in CLAUDE.md exists to prevent.

10,346 lines of generated SQL that would run **without a single error** and leave a database missing
every rule listed in §2. This is no longer a warning quoted from documentation — it is a measurement of
this system. It is why §7's "do not rebuild the database from the schema" is the load-bearing rule of
this plan.

**Result 6 — an incidental supply-chain finding.** `prisma@latest` (v7) **rejects the schema format
v6 uses**: the `datasource.url` property was removed and moved to a separate config file. An unpinned
Prisma would have broken this workflow the day v7 shipped. **Pin the version** — the hermetic-build
principle Google applies to release engineering (builds depend on *known* versions of tools so the same
input always produces the same output) applies to a schema tool exactly as it does to a compiler.

### 0.1 One Phase 0 test worth adding, which the dry run revealed

The schema above was built by **replaying the 549 migrations onto an empty database.** Production is a
different thing: it is those migrations applied incrementally over a year, plus anything ever changed
by hand. **Those two should be identical — and nobody has ever checked.**

So Phase 0 gains a second step: introspect **both** (the migration-built database and a restore of the
production backup) and diff the two schema files. If they match, that is a strong statement about the
health of the migration chain. If they do not, the difference is something real that nobody knows
about, found at zero risk. Either outcome is worth having.

> **STATUS (2026-08-16): this needs NO NEW CODE, and one deliberate non-decision is recorded here.**
>
> The tool already exists. Pointed at a restored copy, `npm run schema:check` answers exactly this
> question and names every difference:
>
> ```
> DATABASE_URL=<the restored copy>  npm run schema:check
> ```
>
> The weekly restore drill (`scripts/backup-verify.js`) already downloads a real backup and restores it
> into a scratch database, so the comparison could be made to run automatically, every week, with no
> new credential and without ever touching production.
>
> **It was deliberately NOT wired in.** That script is the backup system — the one thing in this
> repository whose failure cannot be recovered from by fixing the code afterwards — and the owner's
> direction on 2026-08-16 was *"Please don't do the risky stuff."* Adding anything to it, even a
> read-only comparison that cannot change its verdict, is not a change to make unasked. It is a small,
> well-understood job whenever the owner wants it; until then the one-line command above is the answer.
>
> One thing the work of 2026-08-16 already fixed in advance: a restored production copy carries
> `schema_migrations`, PILOT's own migration ledger, which a `npm run migrate`-built database does not.
> Before that table was excluded, this comparison would have opened by accusing production of holding
> "something no migration here explains" — every single time.

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

#### Phase 1 — the gate condition, measured at last (2026-08-16)

The gate for Phase 1 (§6b) was *"re-running `db pull` over the cleaned file preserves the hand-written
comments (Prisma merges rather than overwrites — **verify this on a copy before relying on it**)."*
Nobody had. It is now measured, twice over, against this database rather than taken from the
documentation:

| what Phase 1 would add | survives `db pull`? |
|---|---|
| `///` doc comment on a **model** | **KEPT** |
| `///` doc comment on a **field** | **KEPT** — and re-attached to the right field even after that field moved position inside a 152-column model |
| hand-renamed `@relation("…")` | **KEPT**, on both sides of the relation |
| hand ordering of existing models | **KEPT**; newly-found models are appended after |
| `//` plain comment | **LOST** |
| a file-header comment | **LOST** |

**So Phase 1 is viable, with one rule: comment with `///`, never `//`.** The plan's assumption was
half right, and the half it got wrong is the half somebody would have discovered the hard way.

**AND OUR OWN GENERATOR WAS THROWING ALL OF IT AWAY.** `schema-prisma.js` wrote a bare seed over the
file and then pulled, so every regeneration produced a file with no human content in it — defeating a
preservation Prisma was performing for us. Nobody had noticed because the file has never been
commented; the first person to do it would have lost the work on the next `npm run schema:map` and had
no idea why. It now pulls OVER the existing file, falling back to a clean seed only if that fails —
and saying loudly, rather than silently, when it has had to.

**A second finding fell out of the same experiment: `schema_migrations`.** The database had 322 base
tables and the map recorded 321. The difference is PILOT's own migration ledger, which
`src/migrate-boot.js` (the server's BOOT path) creates and `npm run migrate` does not. So its presence
records how a database came to be, not what its schema is:

| how the database was built | ledger present? |
|---|---|
| `npm run migrate` — CI, and how this map is generated | no |
| booted once by the server — production, and any test that boots mid-suite | yes |
| restored from a backup | yes |

Left in, the drift check reaches for its most alarming verdict — *"this database contains something no
migration here explains … check that nobody altered it by hand"* — about a table PILOT creates itself,
and it does so **on production, on every restored backup, and on any CI run where a test boots before
the check**. Reproduced exactly. It is now excluded, from ONE chokepoint in `buildInventory` rather
than from the ten queries that each scope themselves differently (ten edits is ten chances to miss
one, and the one missed is invisible), and from the Prisma map through the SAME shared constant — so
the two documents in that folder can no longer disagree about how many tables there are. The stated
cost: a change to the ledger's own four columns is invisible to the map.

Proven by four mutations of the exclusion, all red, including two near-miss fixtures — a real table
whose name BEGINS with the ledger's, and one that merely CONTAINS it — because a `startsWith` or
`includes` mistake would make a real table silently vanish from the map, which is strictly worse than
the bug being fixed. And end to end: the Prisma map now regenerates BYTE-IDENTICAL from a database
that has the ledger.

#### Phase 1 — what was actually built (2026-08-16)

With the gate answered, the readable half was built — **generated, not hand-typed.** Phase 1 asked to
*"comment every non-obvious column"* by hand. Hand-editing an 8,500-line generated file is the cheap
shape the build rule forbids: it rots, and the first regeneration after somebody stops maintaining it
takes the work with it. So the notes come from ONE source and are re-applied on every run.

**`scripts/schema-glossary.js` is that source**, and both documents in `docs/schema/` now read it: the
browsable picture and the Prisma map. Two copies of a sentence about the same table would drift, and
the drifted one is the one somebody reads. Thirty-six tables — the ones a person needs to orient
themselves — now open with a line of plain English:

```prisma
/// One loan file — one property, one deal. Almost everything in the system hangs off this.
/// This table contains check constraints and requires additional setup for migrations. Visit …
model applications {
```

**Ours leads and Prisma's own note is kept below it**, because the sentence saying what the table IS
should be read first. Nothing is ever written twice: a model already carrying our exact line is left
alone, so the file is byte-identical across regenerations — **verified by generating it three times in
a row.**

**Deliberately NOT done, with reasons rather than silence:**

- **Commenting every non-obvious column.** 5,257 columns. Writing a true sentence for each is a
  research project, and a confident wrong sentence is worse than a bare column name. The thirty-six
  above are where the knowledge is real; the glossary grows only when somebody actually knows another
  answer, and a test refuses an entry naming a table that does not exist.
- **Renaming the 680 relations.** Now proven to survive regeneration, so it is *possible* — but the
  auto-generated names are mechanical and correct, better ones are a matter of taste, and 680 renames
  is churn across a file everybody diffs. Low value, high noise.
- **Re-ordering the models by domain.** The grouping exists and is tested to be a partition
  (`schema-picture.js`), so this could be done from the same source. It was not, because
  `PICTURE.html` already presents exactly that grouped view, navigably, to the person who needs it —
  re-sorting an 8,500-line file to duplicate it would make every future diff noisy for no reader.

Ten mutations of the three text rules (`seedFrom`, `stripLedgerModel`, `injectGlossary`) proven red,
with **two vacuous on the first pass** — both holes in the test rather than the code. The sharper one:
a regex matching `model borrowers` INSIDE `model borrowers_extra` rewrites it in place, and BOTH of the
obvious assertions still passed on a file Prisma could not have parsed. The fix was to assert the
neighbouring model survives byte-for-byte and that the model COUNT is unchanged.

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

#### Phase 3 — what was actually built (2026-08-16)

**The map had already drifted, in days, which is the whole argument for the check.** The snapshot was
generated against 549 migrations; `db/550`–`db/553` landed while this branch was open, and the drift
check caught **29 differences** unprompted and named every one (12 new tables, 11 new partial indexes,
4 CHECK constraints, and two tables whose columns moved). Regenerated: **321 tables, 5,257 columns,
749 objects Prisma cannot express** (was 309 / 5,106 / 736).

**The check is now proven to fail, which was the gate condition.** `scripts/test-schema-drift-db.js`
(29 assertions, in `npm test`) proves it in three layers, because each covers what the others cannot:

- **the database read** genuinely sees an `ALTER TABLE` — one real mutation, applied inside a
  transaction that is **rolled back**, so the scratch schema is byte-identical afterwards whether the
  test passes, fails, or dies half way through;
- **the diff** names every class of change — table added / removed, column changed, trigger, function,
  CHECK, partial index, generated column — applied to copies of the live inventory, because ten real
  `ALTER`s would be ten more chances to leave residue proving something arithmetic;
- **the exit code** — `SCHEMA_SNAPSHOT_ENFORCE=1` really exits 1, proven against a *tampered copy* of
  the snapshot via the new `SCHEMA_SNAPSHOT_FILE` override, so that layer touches no database at all.

**Ten mutations of the production code were each proven to turn it red**, with an unmutated control
green either side — diff-always-silent, each detection arm removed in turn, and the enforce branch
exiting 0. One of those mutations first reported as *surviving*: the harness was grepping the last four
lines of output for "FAILED", and with 12 failures that header had scrolled off. The test was fine and
the harness was lying — re-run on exit code, all ten are red. Worth recording, because it is precisely
the false-confidence failure the build rule warns about.

**The snapshot now records which migrations it was built from** (`generatedFrom.migrations`), and the
drift report leads with the verdict that follows from it. Without this the two causes of drift are
indistinguishable in a list that looks identical, and they could not matter more differently:

| what the watermark says | what it means | what to do |
|---|---|---|
| migrations moved | somebody added a migration and did not regenerate | one command |
| migrations **unchanged**, schema differs | this database holds something **no migration explains** | stop and look |
| no watermark | an older snapshot — it says so rather than guessing | regenerate |

**One latent bug was found and fixed on the way**: `schema-inventory.js` used `fs` and `path` without
requiring either. It worked here only because this container's Node exposes them as globals; on a Node
that does not — which includes any CI runner we do not control — it would have thrown. Both are now
imported explicitly. Nothing else in the schema scripts had the same gap (checked, not assumed).

**Still advisory.** See §6d.

#### Phase 3b — the map gets richer, and keeps itself honest (owner-directed 2026-08-16)

Owner: *"I want the design of the code to be that the database should get expanded and enhanced if
something is being added. Let's enrich this even further."* Read as two things — make it **richer**,
and make it **self-updating** — and both were built.

**Richer: the relationship layer had never been written down, and that was the map's biggest blind
spot.** The map recorded exactly the five things Prisma's schema language cannot express. Prisma *can*
express foreign keys, so they were never recorded here — and the drift check only compares what the map
records. The practical consequence: **a dropped foreign key was invisible.** So were 321 primary keys,
37 unique constraints, 797 ordinary indexes, 12 enum types and 1,373 column defaults.

| now recorded and compared | count |
|---|---|
| Primary keys | 321 |
| Foreign keys (with their full `ON DELETE` behaviour) | 680 |
| Unique constraints | 37 |
| Indexes, all kinds | 1,116 |
| Enum types, with their values | 12 |
| Views | 0 |
| Column defaults | folded into every column signature |

The `ON DELETE` clause is kept verbatim because `CASCADE` silently becoming `SET NULL` is the difference
between losing a document and keeping it — a change no count would show.

**One comparison, walked over both groups.** `diffInventories` reads its section lists from the
inventory rather than repeating them. A second hand-kept list here is *precisely* how the relationship
layer went unguarded: the inventory knew about foreign keys long before anything compared them.

**A richer map makes an older snapshot differ without anything in the database having moved**, and the
migration watermark cannot see that — it would report the alarming *"this database holds something no
migration explains"* on a change that is entirely ours. So a fourth verdict, **THE MAP GOT RICHER**, is
checked *first*. Getting this wrong teaches people that the loudest message is usually nothing, which is
how a real one gets missed.

**Self-updating, in three layers, because no single one covers the moment it matters.**

| layer | needs a database? | what it answers |
|---|---|---|
| `check-schema-behind.js` | **no** | is the map behind the migrations? |
| `check-schema-snapshot.js` | yes | does the map still describe this database, object by object? |
| CI `test-db` refresh | CI has one | here is the corrected map, ready to commit |

The first layer is the one that closes the real hole. The thorough check self-skips without a database,
so it is skipped in most places most of the time — and **the moment the map goes stale is the moment
nobody has a database handy**: somebody adds `db/554_*.sql` and moves on. But the snapshot records which
migrations built it and `db/` says which exist now, so *"is the map behind?"* is answerable from a
directory listing and a JSON file. It runs in the pure job, on every pull request, and in every local
`npm test`, and it is in `ALWAYS_RUN_STEPS` — because a Long-Term migration is *provably*
Long-Term-only, so the reduced plan would otherwise skip it exactly when it matters. It names which
migrations landed, not just how many.

It also distinguishes the map being **ahead** of `db/` from being behind, and refuses to call that
stale: the fix for stale is "regenerate", and regenerating there would quietly rebuild the map from the
*smaller* set. That is a map from another checkout, or a deleted migration — a different problem with a
different answer.

The third layer removes the friction that makes refreshing get skipped. CI's `test-db` job is the one
place a database built from *this checkout's* migrations always exists, for free; it regenerates the map
there and attaches the corrected files to the run, so the fix is a download rather than *"find a
Postgres, apply 550 migrations, point `DATABASE_URL` at it"*. It runs **last** — overwriting
`docs/schema/` before the suite would leave the drift check comparing files just written from the very
database it is checking them against, a guard that passes always and guards nothing.

**CI deliberately does not commit the refresh back**, and that is a decision rather than an omission.
It would race the branch an agent is actively pushing to, and a force-push would silently drop the
refresh while everyone believed it was automatic. *A stale map nobody is watching any more is worse
than one nobody is watching yet.* Turning it on is a real option later; it is not a free one.

**Proof.** `test-schema-drift-db.js` is now 48 assertions and covers a dropped foreign key, a changed
column default and all six new sections; `test-schema-behind-pure.js` adds 33 with no database at all.
Across both, **every mutation was proven to turn them red** with a clean control either side — and
**four mutations came back VACUOUS on the first run**, every one a genuine hole in the tests rather than
in the code:

- *column defaults dropped from the signature* — asserted nowhere;
- *the predates-verdict branch deleted* — asserted nowhere;
- *the migration file list sorted as strings* — the fixture used zero-padded names (`001`, `002`,
  `1000`), which sort identically either way, so it proved nothing. Unpadded names do not: as strings,
  `10` precedes `9`;
- *the snapshot stamping the whole state* — asserted against the committed file, which a code mutation
  does not touch until somebody regenerates. A guard on an artifact, not on the rule.

One mutation reported red with **zero failed assertions**: `SET DEFAULT 'zzz'` is invalid on a
`timestamptz` column, so the test was *crashing* rather than failing — identical in an exit code. It
uses `DROP DEFAULT`, valid for every column type. Both are the same lesson as the harness bug above,
and both cost a full re-run to notice.

**The readable map stopped lying about itself.** `BEYOND-PRISMA.md` carried a hand-typed *"549 numbered
migrations"* while the database was already on 550. It is derived from the same watermark now, and says
so plainly rather than guessing when `db/` cannot be read. The 321 primary keys and 1,116 indexes are
**named as deliberately not listed**, with the reason — a reader who is not told they were left out
reasonably concludes the database has none.

#### Phase 3c — Long-Term already does Phase 3, and nothing was checking it (2026-08-16)

Main's #1178 landed `src/longterm/prisma/schema.prisma` while this branch was open — so the Long-Term
product now has exactly what §1.2 held it up as an example of: a hand-written schema that is the source
of truth, with migrations written from it. **Its own header states the invariant** — *"define/adjust the
model HERE, then write the matching idempotent `db/NNN_lt_*.sql` … The two must always agree."*

**Nothing checked that.** It was an assertion in a comment, which is the shape CLAUDE.md rule 3 exists to
forbid: *where a mirror is unavoidable, a test must fail the moment they disagree.* Two ways to break it,
and both pass every other check in the repository:

| what goes wrong | what happens |
|---|---|
| a model added with **no migration** | the code queries a column that does not exist — it fails at runtime, on the first query, in front of a user |
| a migration added with **no model** | the single source of truth quietly stops describing the database — the exact rot this whole plan exists to stop, arriving on the one product built to be immune to it |

**Measured first: they agree today.** All 20 declared tables exist, all 20 `lt_*` tables in the database
are declared, and every column matches in both directions. So the guard was added to a clean state — it
starts by confirming something true rather than by reporting a backlog.

**`check-lt-schema-drift.js` needs no database either**, because both sides are committed files: the
hand-written schema, and `beyond-prisma.json` read from the real catalogue. It is in `ALWAYS_RUN_STEPS`
for the same reason the freshness check is — **an LT migration is *provably* Long-Term-only, so the
reduced plan is exactly the mode in which this must not be skipped.** Verified: an LT migration now runs
29 of 921 steps and this is one of them.

**It abstains rather than guessing, and that is the part to keep.** The snapshot is a photograph with a
date on it. If a migration has landed since, a table the schema declares and the snapshot lacks is most
likely *brand new and correct* — so a stale map may not accuse in that direction. The opposite direction
(a column that is IN the photograph and undeclared) is still reported, because that one is not in doubt.
Without this it would have fired on every properly-added model, which is the fastest way to get a check
switched off.

**The near-miss worth recording: a Prisma relation is not a column.** The obvious filter — look for
`@relation(` on the line — misses every one-to-many back-reference, because the list side carries no
such marker. Run against the real schema it produced **17 phantom "missing columns" across 6 tables**,
i.e. it would have cried wolf on a correct schema from its very first run. The reliable test is the
field's TYPE. Ten mutations proven red, including one specifically for that filter and one for the
abstention.

**This is shared plumbing, not Long-Term product code.** It imports nothing from either product, queries
nothing, and only ever reads the names of `lt_*` tables; a non-`lt_` table is ignored entirely and a test
pins that. `check-product-separation.js` is clean on it.

**It is advisory, but it is the one in this family most worth flipping.** Unlike its RTL sibling — where
a difference is usually a documentation chore — a difference here is a real defect. It is left advisory
today only because of the standing rule that nothing starts failing that passes now, and the flip is one
variable (`LT_SCHEMA_DRIFT_ENFORCE=1`).

### Phase 4 — CLOSED. Not happening. (owner-directed 2026-08-16)

**The owner's words: _"we are not renaming anything. Please don't do the risky stuff."_** That settles
it. Everything below is retained as the record of why it was never worth doing, not as a proposal.

It was always the part of this plan that carried real risk and bought the least — the analysis below
said so before the decision, and the decision agrees with it. Nothing in Phases 0–3 depends on it.
The genuinely risky part, and the one that buys the least. `llcs` now holds corporations, partnerships
and trusts; CLAUDE.md already records the decision **not** to rename it, because ~200 files, nine
foreign keys, the ClickUp field map and the SharePoint folder resolver all reference it — *"a
mechanical change with a real chance of a silent miss, buying nothing a human can see."*

If any renaming is ever done, do it one column at a time by **Parallel Change** (add the new alongside
the old, migrate every reader, then remove — never remove something until nothing depends on it).
Never as a sweep.

## 6a. The zero-risk practices this plan borrows, and where each comes from

Owner asked how Google / Microsoft / Apple / the military would build this so it cannot go wrong. Five
practices, each mapped to a phase rather than quoted as a slogan.

**1. Test Like You Fly — rehearse on the real thing before proposing it.** Aerospace/DoD mission
assurance, born from post-mortems that traced mission losses to testing that was not realistic enough.
Applied in §0: the whole procedure was run against a real Postgres built from the real 549 migrations,
so every number in this plan is measured. **Every later phase carries the same obligation** — Phase 0
runs against a restored copy, never a mock.

**2. Hermetic, pinned tooling.** Google's builds are insensitive to what happens to be installed on the
machine: same input, same tool version, same result. Result 6 above is exactly why — an unpinned Prisma
would have silently broken this workflow on a major release. **Pin `prisma@6.x` explicitly, in
`devDependencies`**, never `latest`.

**3. Read-only by default.** The dry run used a full-access role because it was a throwaway. Production
introspection should use a **role with `SELECT` only** — then "it cannot write" is a property of the
credential rather than a property of the command, and no mistake at the keyboard can change that.

**4. Staged rollout, and roll back before diagnosing.** Google SRE: canarying is a partial,
time-limited deployment evaluated before full rollout; on unexpected behaviour, revert first and
investigate afterwards to minimise recovery time. Only Phase 3 touches how changes reach production, so
that is where this applies — the first schema-generated migration should be a **trivial, reversible
one** (a comment or an index), not a real change.

**5. Gate reviews — write the acceptance evidence before the phase starts.** Restated from the earlier
research and unchanged. §6b below is that table for this plan.

**And the practice that removes the most risk here costs nothing: none of Phases 0–2 touch production
at all.** They read a copy and produce text files. There is no rollout to stage, because there is
nothing deployed.

## 6b. Gate reviews — what must be true before each phase proceeds

| Phase | Evidence required |
|---|---|
| 0 — generate | Runs against a restored copy with a read-only role; the migration-built and backup-restored schemas are diffed and any difference is explained; production object counts unchanged (they cannot change — nothing writes) |
| 1 — readable | Re-running `db pull` over the cleaned file preserves the hand-written comments (Prisma merges rather than overwrites — verify this on a copy before relying on it) |
| 2 — the gap | The trigger/function/check inventory is complete and reconciles to the catalog counts (33 / 136 / 247 / 12 / 309); the schema file carries an "incomplete picture" header until it does |
| 3 — source of truth | The drift check runs in CI and is **mutation-proven to fail** — add a column by hand to a scratch database and confirm it goes red; the first generated migration is trivial and reversible |
| 4 — renaming | Not approved. Requires its own decision with the finished picture in hand |

## 6d. The one thing left in Phase 3 is the owner's decision, not code

The drift check is built, wired into the test chain, and proven to work. It runs today as a **warning**:
it reports drift in full and does not fail the build. Making it **blocking** is one environment variable
(`SCHEMA_SNAPSHOT_ENFORCE=1` on the `test-db` job) and needs no code change.

It is deliberately not flipped here, because flipping it is not zero-risk in the way everything else in
this plan is. The owner's standing rule is *"you should not break anything that exists already … we
shouldn't have any new errors born from these changes."* Enforcement would create new failures — for
other people's work:

**What it buys:** the map can never silently stop being true. Anyone adding a migration is told, in the
same run, to regenerate — so the picture stays current by construction rather than by memory.

**What it costs:** every pull request that adds a migration and does not regenerate `docs/schema/`
starts failing `test-db`. That is not hypothetical — four migrations landed from other sessions during
the few days this branch was open. Each of those pull requests would have gone red, on a step whose
subject is documentation rather than the change being made.

**The middle option** is what is in place now: it reports loudly, names every difference, and says which
of the two kinds of drift it is. Nothing goes stale silently; nobody is blocked.

Recommendation: **leave it advisory until the regenerate step has been used a few times in anger**, then
flip it. That is the staged-rollout principle this plan borrows from §6a.4 — and the flip is reversible
in one line if it turns out to be noisy.

## 6c. Two zero-risk additions worth taking

**Put the documentation inside the database.** Postgres `COMMENT ON TABLE/COLUMN` attaches
documentation to the object itself. It survives every tool change, is read by Prisma, SchemaSpy and
psql alike, and cannot drift from the schema because it lives in it. Cheapest durable win available.

**Generate a picture, not just a file.** SchemaSpy connects to a database read-only and produces
browsable HTML documentation with entity-relationship diagrams. Zero risk (it only reads), and it gives
the non-developer view of the 309 tables that a `.prisma` file does not.

### 6c — what was actually built (2026-08-16)

**The picture is built. SchemaSpy is not what built it, deliberately.** SchemaSpy is a Java program
wanting a JDBC driver, Graphviz and a live connection — none of which can join a build that must stay
`express` + `pg`. Everything it would draw is already in `beyond-prisma.json`, so
`scripts/schema-picture.js` reads that and writes one self-contained
[`docs/schema/PICTURE.html`](schema/PICTURE.html): 843 KB, no internet, opens in any browser.

**It needs NO DATABASE, and that is worth more than the tool would have been.** The snapshot is
committed, so `npm run schema:picture` regenerates the whole thing on a laptop with no Postgres in
reach. The page says on its face that it describes a copy, with the migration watermark and the count
it was built from.

What is on it: the headline numbers; **the spine** — the twelve most-connected tables, *ranked by
measurement rather than opinion* (`staff_users` 237 connections, `applications` 145, `borrowers` 53);
all 321 tables grouped by what they are for, each expandable to its fields and both directions of every
connection; and the fixed lists of allowed values. **`ON DELETE CASCADE` is rendered as "deleted with
it"** — 298 of the 680 connections delete their children and 344 merely unlink them, and that
distinction is the most consequential thing a connection can say.

**Two things on that page are hand-written, so both are guarded.** The grouping must be a PARTITION —
`test-schema-picture-pure.js` asserts the groups sum to the total with nothing duplicated, so a table
can never quietly vanish from the picture — and every plain-English note must name a table that still
exists. That second guard **failed on its first run** and caught a table I had invented
(`staff_invites`; the real one is `invite_tokens`), which is precisely the rot it is there for.

**Eleven mutations were proven to turn it red**, and the first pass found one **vacuous**: deleting the
catch-all group changed nothing, because every table happens to be placed today. A guard that depends
on the data having a leftover is not a guard, so the partition is now proven against a **synthetic**
inventory containing a deliberately unplaceable table. Rendered and read in a real browser — light,
dark, and at phone width — because a page that builds clean and displays wrong is a class this repo has
already been bitten by.

**`COMMENT ON` is NOT done, and is not recommended as stated.** It is genuinely zero-behaviour-risk —
a comment changes nothing at runtime — but it needs a migration against the live database and there are
**5,257 columns**. Writing a true sentence for each is not a task, it is a research project, and the
failure mode is the one this plan keeps naming: a confident sentence that is wrong is worse than a bare
column name. If it is wanted, the honest shape is to start with the ~30 tables the picture's glossary
already covers — where the knowledge is real — and let it grow only where someone actually knows the
answer. That is a separate, owner-sized decision.

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

### 8.2 — evaluated, and it does not work here (2026-08-16)

**CODEOWNERS was not added, and the reason is structural rather than a matter of taste.**

**It could never fire.** Every pull request in this repository is authored by the owner's own GitHub
account — agents push under it — and **GitHub does not request a review from a pull request's author.**
A `CODEOWNERS` line naming that account is a control that is incapable of acting: it would appear in
the repository, look like governance, and do nothing. That is exactly the "assertion in place of a
proof" the build rule forbids, and it is worse than nothing because it would be believed.

**And the zone the plan named is not rare.** Measured over the last 200 commits:

| file | commits touching it |
|---|---|
| `src/auth/index.js` | 38 |
| `src/lib/permissions.js` | 18 |
| `src/lib/crypto.js` | 8 |
| `app-v2/src/components/BorrowerProfilePanel.jsx` | 7 |
| **any of them** | **60 of 200 — nearly a third** |

A notice on one change in three is not a signal, it is wallpaper. It is the same cry-wolf failure the
schema freshness check is written to avoid, and it would train the reader to scroll past the one that
mattered.

**What was built instead — `scripts/check-guarded-paths.js`, which works with one account.** It names,
in the build output of any pull request, when a change touches something whose failure is expensive AND
which almost never changes. Ten paths, **each measured at 8 or fewer of the last 200 commits**: the
encryption module every stored SSN depends on; the two authorization ledgers, where an entry *is* a
claim that the owner said so in writing; the four separation and Encompass read-only gates and their
proofs; the read-only Encompass client; the workflow that decides what is tested before code reaches a
borrower; and `render.yaml`. Each entry says **why**, because "this file is guarded" is not something a
reader can act on. It is advisory on every path and blocks nothing.

`src/auth/index.js`, `src/lib/permissions.js` and `CLAUDE.md` are **deliberately excluded**, and
`test-guarded-paths-pure.js` asserts they stay excluded — adding them is the obvious improvement that
would quietly turn this back into wallpaper. That test also fails if any guarded path stops existing,
which it did on its first run: `render.yaml` is inside `yscap-repo-root_8/`, not at the git root, and I
had assumed rather than checked. Seven mutations proven red.

**CODEOWNERS becomes worth revisiting the moment there is a second GitHub account** — then it can fire,
and the branch-protection question becomes a real one. That is an owner decision, not a code change.

## 9. ANSWERED — the owner closed Phase 4 (2026-08-16)

_"we are not renaming anything. Please don't do the risky stuff."_ Phases 0–3 are built; Phase 4 is
off. There is no open question left in this plan. What remains is listed in §6d and §0.1 below, and
both are switches the owner may throw whenever they choose — neither is work waiting to be done.

The original question is kept for the record:

**How far do you want Phase 4 to go?** Phases 0–3 give you the readable schema and cost essentially no
risk. Phase 4 — actually renaming tables and columns so the names read nicely — is where the danger
lives and where the benefit is mostly cosmetic. My recommendation is to do 0–3 and stop, then decide
about 4 with the picture in front of you rather than before.
