# Long-Term Loans — the separation charter

**Owner-directed, 2026-08-02.** How Long-Term Loans get built next to Residential Transition Loans **without the
two ever touching each other**. This is the research and the concept. No Long-Term feature is built yet, and none
gets built until the open questions at the end are answered.

---

## 1. What the owner asked for, in his words

> *"You should not assume anything that was built from the RTL … anything that we build you should not just think
> OK we're going to build this also in the Long Term loans. Those are two separate things, it's going to be
> separate workflows and totally new… we're not going to build conditions, we're not going to bring in document
> underwriting, we're not going to bring in orders for now. But the point is don't assume anything.*
>
> *Whenever you don't know something in the future, when I'm telling you to build something and you don't know
> which side of the game you should build it — you should ask, you should never assume. The same way if I'm
> telling you to build something and you don't know if you should build this for Amazon or for eBay, you ask.*
>
> *The RTL … is going to be the major part of the software, we're just adding the long term meanwhile just for
> visibility — it's not going to live here in the system, it's going to be a side thing for now… So don't add any
> columns, don't add any mapping unless we specifically ask you to, and for the future keep it totally separate in
> the back end. On the front end we can have both of them with filters and stuff like that; we should see outside
> a stamp if it's a long term loan or a short term loan.*
>
> *Never, if I'm telling you to build something, never assume if you don't know for sure which side to build it.
> And don't take any existing stuff that was built already for one thing to the other thing — everything that you
> want to take over … you need written authorization."*

Reduced to its operating rules, this is the law now recorded in `CLAUDE.md`
("TWO PRODUCTS, TWO SYSTEMS"), `AGENTS.md`, `.github/PRODUCT-SEPARATION.md`, the PR template, and the CI gate
`scripts/check-product-separation.js`.

**The two products, named once and for all:**

| | **RTL** | **LT** |
|---|---|---|
| Name | Residential Transition Loans | Long-Term Loans |
| Covers | Bridge, ground-up construction, fix & flip | Long-term / stabilized lending |
| Status today | The main product. Live. Everything built before 2026-08-02 | Zero code. A side build for visibility. **Not live.** |
| Priority | Stays the major part of the software | An addition that must never disturb RTL |

---

## 2. What is actually here today (measured, not remembered)

Everything below was counted in this repository on 2026-08-02. It is the reason the answer to "can we just add a
loan-type column?" is no.

| Thing | Count |
|---|---|
| Tables in the schema | **218** |
| Numbered migrations replayed on every boot | **405** |
| Migration files that reference `applications` | **193** |
| Columns on `applications` (45 in `schema.sql` + 97 added later, none ever dropped) | **142** |
| Foreign keys pointing at `applications` | **108** |
| Database triggers defined in `db/` | **35** |
| Test scripts in `npm test` | **564** |
| JavaScript files under `src/` | **567** |

Every one of those was designed, tested and hardened for **one** product: a short-term rehab loan on a house.
`applications` alone carries `arv`, `rehab_budget`, `rehab_type`, `sqft_pre`, `sqft_post`, `requested_exp_flips`,
`requested_exp_holds`, `requested_exp_ground` — the vocabulary of fix & flip and ground-up construction.

**The machinery that runs itself.** These are not code paths someone chooses to call; they fire on their own the
moment a row exists or changes in `applications`:

| What fires | Where |
|---|---|
| Reopen pricing & program when any economics field changes | `db/072`, `db/074`, `db/096`, `db/126`, `db/190` |
| Reopen the signed-terms acknowledgement, re-stale the term sheet | `db/280`, `db/288` |
| Ground-up plans condition opens/closes as program or rehab type changes | `db/178` |
| Auto-post conditions (e.g. condo / cash-out) | `db/303` |
| Rebuild the whole document/condition checklist by "track" | `db/095` |
| The document-underwriting spine (extractions + findings on every document) | `db/200` |
| Flood certificate ordered on **every single file, no matter the capital provider** | owner rule 2026-07-30 |
| ClickUp two-way sync, SharePoint mirror, Encompass weekly read, DocuSign, Sitewire draws, Trustpoint | `src/sync/`, `src/encompass/`, `src/lib/esign/`, `src/routes/sitewire.js`, `src/trustpoint/` |
| Investor-guideline (ISG) whole-loan run, appraisal findings enforcement, AI underwriting | `src/lib/underwriting/**` |
| Every notification email enriched with file identity, keyed on `applicationId` | `src/lib/notify.js` |

**Put a long-term loan in that table and all of it turns on.** A 30-year rental loan would get a rehab-budget
condition, a flood certificate order, a ground-up plans condition, an ARV-based appraisal finding, a ClickUp card
in the RTL pipeline folder, and an investor-guideline run against fix & flip rules — none of which anyone asked
for, all of which would have to be suppressed one by one, forever, in 193 migrations and 567 files. **One missed
`WHERE` clause and a long-term loan is inside the RTL machine.**

### 2.1 A trap that is already in the building

The word **DSCR** already exists in this codebase — and it is **RTL**, not Long-Term:

- `applications.dscr_ratio` and `program = 'DSCR'` describe an RTL loan's **exit strategy** (the borrower
  refinances into a rental at the end) — see `src/encompass/reconcile.js`, `src/lib/conditions/field-registry.js`.
- `src/lib/underwriting/dscr-desk.js` is an **advisory desk inside RTL underwriting** (rent vs PITIA), built for
  note-buyer checks on RTL files.
- `src/sync/clickup-sync.js` deliberately **throws long-term deals out of the portal**: when a ClickUp card's
  program is a non-RTL type such as DSCR, `reconcileLinkedProgramsOnce()` descopes it, and the card is kept only
  as a read-only snapshot in `clickup_task_index` with `kind = 'data_only'`. Those snapshots are counted in the
  data audit as `nonRtlPrograms`.
- Sharpest edge of all: **`db/095_reconcile_full_checklists.sql` already computes a "track" of `'dscr'` from the
  words *long-term*, *30-year* and *rental*, and generates the RTL document checklist off it** (the same
  vocabulary in `src/lib/conditions/field-registry.js` maps to `rental_dscr`). RTL machinery is keyed on the exact
  words Long-Term will use every day — which is precisely why the two products may never share a table.

**Nobody may assume that any of this is the Long-Term product.** It is RTL plumbing that happens to use the same
English word. If Long-Term needs a DSCR calculation, that is a new thing built inside `src/longterm/` — or an
explicitly authorized crossing recorded in the ledger. Never a quiet re-use.

The one genuinely useful fact from the above: **long-term deals already exist in ClickUp today**, and PILOT
already knows how to see them and keep them out. So the boundary the owner is asking for is not new — it is
already the system's behaviour. We are formalising it, not inventing it.

---

## 3. Three ways to build this, and the one we recommend

### Option A — one table, a "product" flag

Add `product = 'rtl' | 'lt'` to `applications` and filter everywhere.

- ✅ Cheapest to start; the pipeline is one query.
- ❌ **Rejected.** 35 triggers and 193 migrations already act on that table with no idea a second product exists.
  Every existing query in 567 files silently becomes wrong until it is found and filtered. Protection would depend
  on never forgetting a `WHERE` clause — across every future change, forever. This is precisely the outcome the
  owner ruled out: *"features that we add for one by mistake added to the other."*

### Option B — one repo, one process, one database, **two namespaces** ✅ recommended

Long-Term gets its own tables (`lt_*`), its own folder (`src/longterm/`), its own URLs (`/api/lt/*`), its own
migrations and its own tests. Nothing is shared, and a machine checks that nothing is shared.

- ✅ RTL is untouched — not one column, not one trigger, not one mapping.
- ✅ Zero new infrastructure: same Render service, same Postgres, same deploy, same backups.
- ✅ The separation is **enforced, not promised** — `scripts/check-product-separation.js` fails CI on any crossing.
- ✅ **It can graduate.** Because no `lt_*` table may reference an RTL table, moving Long-Term into its own
  database or its own service later is a lift-and-shift of one folder and one table prefix — not a rewrite.
- ⚠️ The two products still share one process and one database, so a catastrophic infrastructure failure hits
  both. Acceptable while Long-Term is a side build with no live traffic — and reversible via the graduation path.

### Option C — a separate service with a separate database

- ✅ The strongest possible wall.
- ❌ Not now: a second Render service, a second Postgres, a second deploy pipeline, a second backup + weekly
  restore drill, a second auth story, and cross-service calls for the combined pipeline — real cost and real new
  failure modes, for a product with no live traffic. Option B is deliberately built so this stays a cheap
  decision later, not a rebuild.

---

## 4. The structure (Option B, concretely)

```
yscap-repo-root_8/
├─ src/
│  ├─ server.js                    ← the ONE permitted seam: mounts the LT router
│  └─ longterm/                    ← ALL Long-Term back-end code lives here, and only here
│     ├─ routes/                      HTTP under /api/lt/*
│     ├─ lib/                         Long-Term's own logic
│     └─ db.js                        Long-Term's own pool + data access (lt_* tables only)
├─ db/
│  └─ NNN_lt_*.sql                 ← Long-Term migrations: lt_* tables only, never an RTL table
├─ scripts/
│  ├─ test-lt-*.js                 ← Long-Term tests (the only RTL-side files that may import LT)
│  └─ check-product-separation.js  ← the gate that keeps all of the above true
└─ app-v2/src/
   ├─ longterm/                    ← ALL Long-Term front-end code lives here, and only here
   └─ screens/StaffQueue.jsx       ← the combined pipeline: may show both, read-only, always stamped
```

**The rules the gate enforces**

| Rule | Why |
|---|---|
| Long-Term code (`src/longterm/**`, `app-v2/src/longterm/**`) may not import RTL code | Long-Term starts at zero. An import is a crossing — including a shared UI component, which is still something already built. |
| Nothing else may import Long-Term code — except `src/server.js` mounting the router, and `scripts/test-lt-*.js` | RTL, the live product, must never depend on a side build. |
| Long-Term may not read or write an RTL table **in raw SQL**, and RTL may not touch an `lt_*` table | The crossing that needs no `require()` at all — the easiest one to make and the easiest to miss. |
| RTL back-end code may not call `/api/lt` | The combined view is assembled at the read/view layer, never inside RTL. |
| `lt_*` tables may only reference `lt_*` tables | A foreign key across the line welds the products together and blocks the graduation to Option C. |
| No `lt_`/`long_term` column on an RTL table | *"Don't add any columns … unless we specifically ask you to."* |
| A migration may not touch both sides, and a Long-Term migration may only create `lt_*` tables and `lt_*` functions | Mixed migrations are how two products quietly become one — and a `CREATE OR REPLACE FUNCTION` with an RTL name would silently replace a live RTL trigger. |
| A trigger on an `lt_*` table may only run an `lt_*` function (and the reverse) | RTL triggers reopen RTL pricing and RTL conditions. Long-Term has none of that. |
| The rule documents — **and this gate's own wiring in `package.json` and the CI workflow** — must stay in place | A gate that has been unwired fails nothing, with every document still intact. |

Anything the owner authorizes in writing is recorded in **`docs/LONG-TERM-AUTHORIZED-COPIES.md`**; the gate reads
that ledger and permits exactly what is listed there, and nothing else. That is what makes "written
authorization" a real thing rather than a memory of a chat message.

**What the machine cannot check.** The gate catches *structural* crossings. It cannot see RTL code **copied by
value** into a Long-Term folder (there is no import to find), a plainly-named new column added to an RTL table for
Long-Term's benefit, a new ClickUp mapping, or a new checklist template. Those rest on the person doing the work
and on the PR checklist. Do not read a green build as proof that nothing crossed.

**The first collision, pre-answered.** Long-Term's very first file needs a database connection, and the existing
pool (`src/db.js`) is RTL code — so importing it is a crossing the gate will block. **Until the owner says
otherwise, Long-Term opens its own pool inside `src/longterm/db.js`.** That is the zero-assumption default: it
needs no authorization, and it is what makes the eventual move to a separate database trivial. (See open
question 11 if you would rather authorize sharing the pool.)

### 4.1 Three zones, not two — the shared-identity decision (owner-directed 2026-08-03)

The owner settled the two biggest open questions in one sentence:

> *"Same login, same borrower record — keep it separate everything else. All the borrowers should be able to see
> all their files even if it's long term or short term. And officers should be able to see all of their files even
> if it's long term or short term. The only thing is the back end of the entire thing will be different, the
> workflow will be different, the sets will be different, integrations will be different, it will be a brand new
> build. Don't assume anything that we're building on one thing to build that also on the other thing —
> it's totally separate."*

So the repository has **three zones**, not two:

| Zone | What is in it | Who may touch it |
|---|---|---|
| **Shared identity** | The login (`src/auth/index.js`), the person record (`borrowers`), the staff roster (`staff_users`) | **Both products.** RTL as today; Long-Term **reads** it. |
| **RTL product** | Everything else built before 2026-08-02 — workflow, statuses, conditions, documents, money, integrations | RTL only |
| **Long-Term product** | `lt_*`, `src/longterm/**`, `app-v2/src/longterm/**` — brand new | Long-Term only |

**Identity is shared; the two product zones never touch each other.** That is the whole crossing list, and it is
written into the `authorized` block of `docs/LONG-TERM-AUTHORIZED-COPIES.md`, which the CI gate reads.

**Long-Term reads identity — it does not rewrite it.** The gate distinguishes reading (`FROM`/`JOIN`) from writing
(`INSERT`/`UPDATE`/`DELETE`), and only reading is authorized. The reason is concrete: the borrower record is
already written by roughly a dozen RTL modules that heal, enrich and de-duplicate it — Encompass enrichment, the
ClickUp sync's rename handling, the credit store, name-heal, the merge/dedup flow. One record with one owner stays
correct; two writers racing on it does not. **Creating and editing a borrower stays in the one existing flow.** If
Long-Term ever needs to change a borrower, that is a new question for the owner (`sql-write borrowers`).

**What this buys, in the owner's terms**

- **A borrower signs in once and sees every file they have** — long-term and short-term together, each stamped.
- **An officer signs in once and sees every file they own** — long-term and short-term together, each stamped.
- Both of those are read-and-display work in the portal, assembled from two independent back ends. Neither
  requires the two products to share a workflow, a status list, a document set, or a single integration.

**What it explicitly does NOT buy.** Sharing the person record does not carry across anything attached to that
person on the RTL side: their RTL conditions, documents, track record, LLCs, credit pulls, pricing scenarios,
ClickUp cards and SharePoint folders stay RTL. Long-Term starts at zero on all of it.

### What Long-Term does NOT get (2026-08-02)

**Conditions. Document underwriting. Orders.** Explicitly out of scope by the owner's instruction. They are not to
be built, stubbed, or "left room for" by copying RTL shapes. Also out: any new ClickUp / Encompass / SharePoint /
DocuSign / Sitewire / Trustpoint mapping, and any new column anywhere, unless specifically requested.

---

## 5. The pipeline view — both products on one screen, without mixing them

The owner wants one place to see everything, **and** the ability to look at each product on its own, **and** a
visible stamp so nobody is ever confused about what they are looking at. That is a front-end job, and it stays a
front-end job.

**How it works**

1. Each product answers only for its own rows. RTL's reader reads `applications`. Long-Term's reader reads
   `lt_*`. Neither knows the other exists.
2. A thin read-only aggregator at the edge asks both, **tags every row with its product**, and hands the combined
   list to the screen. **No SQL join. No shared table. No shared write path.** Nothing can be written through it.
3. The pipeline screen (`app-v2/src/screens/StaffQueue.jsx`) is already driven entirely by URL filters, so the
   product filter is a natural fit: **Both / RTL only / Long-Term only**.
4. **Every row carries a visible stamp**, and so does every file header — so the product is obvious from the
   outside, exactly as asked, without opening anything.

**The same shape serves all three "see everything" views the owner asked for** — one aggregator, three audiences:

| Who | Sees | Scoped by |
|---|---|---|
| **A borrower**, in their portal | *All* their files, long-term and short-term together, each stamped | the shared `borrowers` person record |
| **An officer** | *All* of their files, both products, each stamped | the shared `staff_users` account each file records as its officer |
| **Staff on the pipeline** | Everything they are entitled to, filterable Both / RTL only / Long-Term only | existing role scoping on the RTL side; Long-Term's own on its side |

Each product still answers only for its own rows and applies **its own** access rules — the aggregator concatenates
and stamps, it never decides who may see what. Long-Term's permission rules are part of Long-Term's brand-new
build, not a copy of RTL's.

**Consequences, stated honestly:** sorting, counting and paging happen **after** the merge, so the combined view
asks each side for its slice and then sorts. That is fine at Long-Term's expected size (a handful of files, no
live traffic) and is the price of never joining the two in the database. If Long-Term ever grows large enough
that this hurts, the answer is a paging strategy at the edge — never a shared table.

**Front-end sharing, precisely:** shared *presentation* (a table, a chip, a layout, brand tokens) is the kind of
thing that *may* be shared — but a component built for RTL is still something already built, so re-using one is a
crossing like any other: **ask, get it in writing, add one `import` line to the ledger.** Shared *product logic* —
fields, statuses, workflow steps, money math, anything that knows what a loan is — is not shareable at all. The
gate blocks both until the ledger says otherwise, on purpose. If it is unclear which one you are looking at:
**ask.**

---

## 6. Vocabulary, so nothing is ambiguous

| Say this | Not this | Why |
|---|---|---|
| **RTL** / Residential Transition Loans | "the loan system", "short term" (in code) | `rtl_` already appears in the schema and workflow codes |
| **LT** / Long-Term Loans | "DSCR", "rental", "30-year" | Those words already mean an RTL **exit strategy** in this codebase (§2.1) |
| `lt_*` (tables + trigger functions), `src/longterm/` and `app-v2/src/longterm/` (code), `/api/lt/*` (URLs), `db/NNN_lt_*.sql` (migrations), `scripts/test-lt-*.js` (tests) | anything else | The gate keys off these names — a Long-Term table called `longterm_loans` would slip straight through |

The exact words shown to staff on the stamp and the filter are the owner's call — see the open questions.

---

## 7. Where the rules live

| Place | File |
|---|---|
| The master copy | `CLAUDE.md` → "TWO PRODUCTS, TWO SYSTEMS" (+ the first bullet under Session rules) |
| Every AI agent, before any work | `AGENTS.md` (git root) |
| GitHub | `.github/PRODUCT-SEPARATION.md` |
| Every pull request | `.github/pull_request_template.md` — "Which product is this for?" plus the separation checklist |
| CI, blocking merges and deploys | `scripts/check-product-separation.js`, at the head of `npm test` (step 2, right after the migration gate), plus `scripts/test-product-separation-gate.js` which proves it still catches what it claims |
| Written authorizations | `docs/LONG-TERM-AUTHORIZED-COPIES.md` |
| This design | `docs/LONG-TERM-LOANS-SEPARATION-CHARTER.md` |

---

## 8. Open questions — to answer before any Long-Term code is written

These are the places where a guess would be an assumption, so they are questions instead. Nothing about
Long-Term gets built until they are answered.

**Answered 2026-08-03 — see §4.1:**

1. ~~**Who logs in to the Long-Term side?**~~ → **The same login.** Recorded as `import src/auth/index.js`.
2. ~~**Is a long-term borrower the same person record?**~~ → **Yes, the same record**, and Long-Term **reads** it
   (`sql-ref` + `sql-read borrowers`). A borrower sees all their files in one place, both products. Officers do
   too, so a Long-Term file records its officer (`sql-ref` + `sql-read staff_users`). Everything else stays a
   brand-new build — *"the workflow will be different, the sets will be different, integrations will be
   different."*

**Still open:**

3. **Where do Long-Term deals come from?** Typed in by hand, or read from ClickUp (they are in ClickUp today,
   already excluded from PILOT)? Any sync at all is a mapping, which you said not to build unless asked.
4. **What does a Long-Term file actually need to hold** — property, borrower, loan amount, rate, term, and what
   else? Long-Term starts at zero, so the field list should come from you, not from RTL's list.
5. **What are the Long-Term stages?** RTL's statuses (new → underwriting → clear to close → funded) are RTL's.
   Long-Term needs its own, from you.
6. **What should the stamp say on screen** — "Long-Term" and "RTL"? "Long Term" and "Short Term"? Something else?
7. **What does the pipeline show by default** — both products together, or RTL only until you switch it on?
8. **Who is allowed to see the Long-Term side** — the whole team, or only certain people?
9. **Does a Long-Term file need documents at all right now** (just uploading and storing files), given that
   conditions, document underwriting and orders are all out of scope?
10. **Anything Long-Term must NOT show** — e.g. does the note-buyer / capital-partner name rule apply there too?
11. **May Long-Term share the database connection (`src/db.js`) with RTL?** Until you say yes, Long-Term opens its
    own — which costs nothing and keeps the door open to moving Long-Term to its own database later. Say the word
    and it becomes one ledger entry. *(Recommendation: leave it separate.)*
12. **May Long-Term ever CHANGE a borrower** (not just read one)? Today it may only read: creating and editing a
    borrower stays in the one existing flow, so the person record keeps a single owner. If a long-term file should
    be able to update a phone number or an address, that is one more ledger line — but it needs your yes.
    *(Recommendation: keep it read-only; send edits through the existing borrower screen.)*
13. **Do long-term files count in the RTL numbers?** The pipeline's KPI tiles, counts and dashboards are RTL's
    today. When the filter is set to "Both", should the tiles count both products, or stay RTL-only?

---

## 9. Change log

| Date | Change |
|---|---|
| 2026-08-02 | Charter written. Rules recorded in CLAUDE.md, AGENTS.md, `.github/`, the PR template and the CI gate. Ledger opened, empty. No Long-Term code built. |
