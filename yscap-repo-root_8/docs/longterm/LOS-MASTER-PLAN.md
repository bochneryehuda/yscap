# The Long-Term LOS — the master build plan

**Status: PLAN. Nothing in here is built yet, and §11 lists what still needs the owner's
word before it can be.**

This is the plan for building the long-term (DSCR / investor) side of PILOT into a full
Loan Origination System: its own pipeline, its own loan workspace, a condition centre fed
from Encompass, a pricing-and-lock surface, and the assigned-contact map that tells us who
owns every file.

It rests on research that is already committed and should not be repeated:

| Read this first | For |
|---|---|
| `README.md` (this folder) | the index to every measurement, and the five findings that change what you build |
| `LOS-BUILD-STRUCTURE.md` | the URLA spine, the data model, the phase order this plan extends |
| `LOS-VISION-AIM-PORTAL.md` | the portal the owner wants this to feel like — **direction, not spec** |
| `AUDIENCE-RULES.md` | the hard rule: the investor's name never reaches a client |
| `../LONG-TERM-LOANS-SEPARATION-CHARTER.md` | why RTL and LT are two systems |
| `../LONG-TERM-AUTHORIZED-COPIES.md` | the ledger — what may cross, and what may not |
| `../ENCOMPASS-WRITE-AUTHORIZATIONS.md` | the pad — the one place a write can ever be allowed |

Everything measured here came from the live tenant (BE11397907) on 2026-08-14: all 772
loans, 490 of them long-term.

---

## 1. The shape of the thing

**Two pipelines, one login, one switch.** Owner-directed: every loan officer has an RTL
pipeline and a long-term pipeline, and they are different dashboards, not one list with a
filter.

```
                    ┌─────────────────────────────┐
   one sign-in ───▶ │  PILOT shell (app-v2)       │
                    │  ┌───────────────────────┐  │
                    │  │ Short-Term │ Long-Term│  │ ◀── the switch, top bar
                    │  └───────────────────────┘  │
                    └──────────┬─────────┬────────┘
                               │         │
             everything built  │         │  brand-new build
             before 2026-08-02 │         │  app-v2/src/longterm/**
                  (RTL)        │         │  /api/lt/*   ·   lt_* tables
                               ▼         ▼
                        /internal/*    /internal/lt/*
```

Switching swaps the **whole** left nav, the pipeline and the file screens. It is not a
filter on one list, and there is no SQL join anywhere near it — each product answers for
its own rows.

**Where the switch lives.** The top bar, beside the PILOT lockup, visible on every screen.
The chosen side is remembered per user as a setting, so an officer who works one side lands
there every morning without touching it.

**Why a switch and not two logins.** The identity zone is already shared and already
authorised: *"same login same borrower record, keep it separate everything else"*
(owner, 2026-08-03). A borrower sees all their files in one place and an officer sees all of
theirs. Two logins would break the sentence the whole separation was built around.

---

## 2. Who owns the file — the assigned-contact map

**This is the first thing built, because nothing else is usable without it.** A pipeline
that cannot say whose file it is, is a spreadsheet.

### 2.1 What Encompass actually holds

Every loan carries one array, `loan.contacts[]`, keyed by `contactType`. The fields below
are **live-measured across all 772 loans**, with the fill rate on the long-term book:

| Role | `contactType` | Name | Phone | Email | Login ID | Fill (DSCR) |
|---|---|---|---|---|---|---|
| Loan Officer | `LOAN_OFFICER` | **317** | 1406 | 1407 | `LOID` | 98.4% |
| Processor | `LOAN_PROCESSOR` | **362** | 1408 | 1409 | `LPID` | 80.2% |
| Underwriter | `UNDERWRITER` | **984** | 1410 | 1411 | `UWID` | 31.2% |
| Closer | `LOAN_CLOSER` | **1855** | 1856 | 1857 | `CLID` | 46.3% |
| Funder | — | **1991** (`loan.funding.funderName`) | — | — | — | 45.7% |

> **A TRAP, WRITTEN DOWN SO NOBODY REPEATS IT.** `docs/ENCOMPASS-DATA-MAPPING.md` §3F
> states processor = **320** and underwriter = **321**. Both are **wrong** against the live
> census; the real ids are **362** and **984**. Only its `317` is right. That document is a
> proposal written before the census; where it disagrees with
> `dictionary/field-dictionary.json`, the dictionary wins.

Two more things the census settles:

- **Closer and Funder are a long-term concern.** Both read **0% on Fix & Flip** and ~46% on
  DSCR. They are not a general PILOT feature that happens to land here.
- **The underwriter's `contactType` is inconsistent in the tenant's own paths** —
  `UNDERWRITER` on 984/1410/1411 but `LOAN_UNDERWRITER` on `UWID`. Read both; never assume
  one spelling.

Beyond the loan team, the same `contacts[]` array carries the **outside** parties, and the
plan reads them in the same pass: Title (411/412/413/88), Escrow (610/611/87), Appraisal
(617–623/89), Credit agency (624/626–629), Seller (638/701–703), MI (93/707–711), Flood
insurance (1500). `GET /encompass/v3/loans/{id}?entities=contacts` returns **17 contacts in
one call**, which is the whole outside chain in a single read.

### 2.1.1 What the live probe corrected — read this before building the map

A read-only probe of the live tenant (2026-08-14, full write-up in
`ENCOMPASS-LIVE-API-PROBE.md`) changed three things about this section. Each one would have
produced a wrong map.

**1. This tenant has no role called "Loan Officer." The loan-officer slot is
`Loan Coordinator`, roleId `1`.** Field 317's *label* says "Loan Officer Name", but the
team-member role the tenant actually assigns is Loan Coordinator. `Loan Opener`, `Shipper`
and `Insurer` do not exist here and always read empty. **Never assume a role name — read the
tenant's own list** (`/settings/roles`, 12 live).

**2. The join key is the Encompass login id, not the email.** The best surface is the
field-reader family `LoanTeamMember.{Name|UserId|Email|Phone}.<exact role name>`:

```
LoanTeamMember.UserId.Loan Coordinator  → "sweiss"
LoanTeamMember.UserId.Loan Processor    → "ebochner"
LoanTeamMember.UserId.Closer            → "mkatz"
LoanTeamMember.UserId.Funder            → "mkatz"
LoanTeamMember.UserId.Post Closer       → "mkatz"
```

`UserId` is the Encompass login id and equals `/company/users[].id`. (It is `UserId` — a
`LoanTeamMember.Id.*` read returns 400.) `LOID` is the only staff id that is
**pipeline-queryable**, so filtering a pipeline by loan officer is
`{"canonicalName":"Fields.LOID","matchType":"exact","value":"sweiss"}`.

**3. Email auto-matching cannot be trusted on its own — and this changes the design.**
The roster is 46 users, and **10 of them share the placeholder `change.me@email.com`**.
Names are worse (double and trailing spaces). So the auto-match in §2.4 must:

- match on email **only when that email is unique across the roster and is not a known
  placeholder**;
- leave everything else **unmatched for a human**, rather than suggesting a pair it cannot
  stand behind.

A suggestion an admin is likely to approve without looking is worse than no suggestion. This
is the same reasoning that made a confirmed link — not a suggested one — the thing that
decides whose pipeline a file appears in.

**`/associates` is history only, and carries two traps.** It answers on v1 (v3 403s), and:
it is **not deduplicated** — one row per milestone slot, so a reassigned role appears twice
with two different users; and its **name and email can be a stale snapshot that disagrees
with its own `id`** (a real row read `{"id":"mschwimmer","name":"Malky Katz"}` — two
different people). **Trust the `id`; re-resolve the name from the roster.** Do not build the
current assignment from this endpoint.

**Roster paths that work:** `/encompass/v1/company/users` (46 users with personas and org),
`/settings/roles` (12), `/settings/personas` (17), `/organizations`. `/company/roles`,
`/company/organizations` and `/company/personas` all **403**.

### 2.2 The tables

Two new tables. Both `lt_*`, both in one new migration.

**`lt_encompass_users`** — the Encompass roster, mirrored.

```
login_id        text PRIMARY KEY     -- Encompass login id; the stable identity
full_name       text
email           citext
phone           text
personas        text[]               -- from /settings/personas (17 live)
role_names      text[]               -- from /settings/roles (12 live)
is_active       boolean NOT NULL DEFAULT true
encompass_synced_at timestamptz
```

**`lt_staff_links`** — Encompass person → PILOT person. Owner-directed: auto-match by
email, an admin confirms.

```
encompass_login_id  text PRIMARY KEY REFERENCES lt_encompass_users(login_id)
staff_id            uuid REFERENCES staff_users(id) ON DELETE SET NULL   -- authorised: sql-ref staff_users
status              lt_link_status NOT NULL DEFAULT 'suggested'  -- suggested | confirmed | rejected
match_method        text            -- 'email_exact' | 'manual'
confirmed_by        uuid REFERENCES staff_users(id)
confirmed_at        timestamptz
```

`status` matters. A **suggested** link is displayed and never acted on; only a **confirmed**
link decides whose pipeline a file appears in. That is the whole point of the owner's
choice — a shared or mistyped Encompass email must not silently hand somebody another
officer's book.

**`lt_loan_contacts`** — who is on this loan.

```
id                  uuid PRIMARY KEY
loan_id             uuid NOT NULL REFERENCES lt_loans(id) ON DELETE CASCADE
role                lt_contact_role NOT NULL   -- see below
encompass_name      text
encompass_email     text
encompass_phone     text
encompass_login_id  text
staff_id            uuid REFERENCES staff_users(id) ON DELETE SET NULL   -- resolved through lt_staff_links
override_staff_id   uuid REFERENCES staff_users(id) ON DELETE SET NULL
override_by         uuid REFERENCES staff_users(id)
override_at         timestamptz
override_reason     text
encompass_synced_at timestamptz
UNIQUE (loan_id, role)
```

`lt_contact_role` is deliberately **not** an enum of YS Capital's org chart. It carries the
roles the *domain* has — `loan_officer, processor, underwriter, closer, funder,
post_closer, loan_coordinator, title, escrow, appraisal, credit, seller, mortgage_insurance,
flood_insurance` — because those are true of every lender. Which of them a given tenant
*uses*, what each is *called on screen*, and which appear in the pipeline are **settings**
(§7).

### 2.3 The override rule

The owner chose *"Encompass fills it, PILOT can override locally."* That is two sources of
truth, and the way this codebase already handles that class is the way it is handled here:

1. **Encompass's value is always stored** in `encompass_*`, and always shown.
2. **An override is stored separately** and is always visibly stamped as an override —
   who set it, when, and why. It never overwrites the Encompass columns.
3. **A sync never clears an override.** It refreshes the Encompass side beside it.
4. **When the two disagree, the screen says so**, with both names visible. Silent
   divergence is the failure mode; naming it is the fix.
5. **Nothing is written back to Encompass.** Ever. The override is a PILOT-side routing and
   visibility decision, not a correction to the system of record.

### 2.4 The screens

- **Admin → Long-Term → People.** The Encompass roster on the left, PILOT staff on the
  right, auto-suggested pairs in the middle with a Confirm button. Unmatched Encompass users
  are listed plainly as unmapped; their files still display the Encompass name, so nothing
  is invisible while the mapping is incomplete.
- **On the loan file — a Contacts section.** Grouped by function, the way the owner's
  reference portal does it ("who do I call for what", not an alphabetical directory): the
  loan team first, then the outside parties. Each row shows the name, role, phone and email,
  and an override control for staff who may set one.

---

## 3. The spine, and what is already standing

The data model is the URLA / Form 1003 (MISMO 3.4 ULAD) section numbering. That decision is
made and built — 12 tables live in `db/549`. This plan does not reopen it.

**Already built and working:** the read-only Encompass client; the 3,783-field census; loan
anatomy, terms, PITI and DSCR arithmetic verified against every live loan; 33 investors and
their 117 spellings; 1,006 dropdowns; 197 condition templates; 230 eFolder document types;
19 milestones with their role assignments; 44 settings in 10 groups; 17 read-only knowledge
endpoints; and the investor-name block with a test that sweeps every recorded spelling.

**What does not exist:** any screen at all, any sync that writes a row into an `lt_*` table,
the condition tables, the settings persistence, and every pipeline surface. That is what
this plan builds.

**Three measured findings that must survive into the code**, because each one produces a
confidently wrong number if forgotten:

1. **Never read `CX.PITIA`.** It is filled on 99.6% of long-term loans and **0 of 452 agree**
   with the real housing expense — its formula sums the purchase price and cash-to-close into
   a monthly payment. Read field **912**.
2. **Read the PITI total; never rebuild it from its parts.** They agree on 91.4% of files;
   on 38 of the 39 that differ the tax line is blank while the total includes taxes.
   Rebuilding understates the expense by ~$1,300/month and **inflates the DSCR**.
3. **Never compare an investor name as a string.** 151 spellings, ~30 companies. Compare
   `investors.resolve(x).key`.

---

## 4. The pipeline and the loan workspace

### 4.1 The pipeline

One flat table. Inactive loans stay in it, distinguished by status — no separate archive
screen. Two independent control rows above it (status chips, scope chips) plus free-text
search, which is the arrangement the owner's reference portal uses and the reason it stays
simple while being exhaustive.

**Columns**, every one of them settings-driven so a buyer can change the set:

Loan number · Borrower / entity · Property · Program · Loan amount · Note rate · DSCR ·
LTV · Milestone · Days in milestone · Loan officer · Processor · Conditions
(Pending / Open + count / Cleared) · Lock status · Expected closing.

The **Conditions column does real work on its own** — a red count of what is outstanding
means a user triages urgency from the list without opening a file.

**Two of those columns cannot be sourced yet, and they say so on the screen rather than
rendering empty.** *Conditions* waits on the Condition Center (phase 5, deferred). *Expected
closing* has no closing date on `lt_loans` at all — it is in the setting's own default, which is
exactly how a column nobody can fill gets configured by accident, so the resolver drops it and
names the reason. Everything else on this list is live, plus a **Stage**, an **At milestone** age
and an **Updated** column the build added. When a closing date is mirrored, the column becomes
one entry in `src/longterm/pipeline-columns.js` and nothing else.

**Saved views** are per-user rows in an `lt_pipeline_views` table, not a code change.

### 4.1.1 Stages — three layers, not one

Owner-directed 2026-08-14: *"we're going to use the Encompass stages, but we're going to map
those Encompass stages to our own stages. We're not going to have, on the consumer side, all
stages from Encompass. You can use the Encompass consumer-visible stages for the consumer
side."*

So a loan carries **one milestone and two stage labels**, and they are never conflated:

```
   Encompass milestone           our stage              what the borrower sees
   (19, mirrored verbatim)  ──▶  (ours, ~9)       ──▶   (Encompass consumer wording)
   e.g. "Waiting for Docs"       "Conditions Out"       "Conditionally Approved -
                                                         Waiting for Docs"
```

1. **The Encompass milestone is mirrored verbatim** and never edited. It is the truth about
   where the file is in Encompass, and it is what an internal user sees when they want the
   real answer. Read it from **`MS.STATUS`** — the pipeline's own `Loan.CurrentMilestone`
   column is blank on every loan in this tenant.
2. **Our stage** is what the internal pipeline groups and sorts by. Nineteen milestones is
   too many to read at a glance and several of them mean the same thing to us.
3. **The borrower's stage is Encompass's own consumer wording**, which is already stored —
   `lt_encompass_milestones.consumer_status`, seeded in `db/547` for all 19 rows. It
   collapses the 19 to about 11 by itself, which is exactly why the owner pointed at it. We
   do not invent borrower wording; we use theirs.

**The proposed mapping** — a starting point, to be confirmed, and a **setting** so it can be
changed without a migration:

| Our stage | Encompass milestones it covers | Borrower sees (Encompass consumer wording) |
|---|---|---|
| New | Started | Collecting Information |
| Setup | LO Prep, Loan Setup | Application Received · Processing |
| Submitted | Submittal | Submitted for Approval |
| In Underwriting | Cond. Approval, Processing, Resubmittal | Submitted for Approval · Conditionally Approved · Condition Review |
| Conditions Out | Waiting for Docs | Conditionally Approved - Waiting for Docs |
| Clear to Close | Clear To Close | Final Approval |
| Closing | Schedule Closing, Ready for Docs, Docs Out, Wire Order | Closing Scheduled · Closing Preparation · Active Closing |
| Funded | Funding | Funded |
| Post-Closing | Investor Delivery, Purchasing Conditions, Final Docs, Closed, Completion | Funded |

**Two rules this arrangement has to keep:**

- **A milestone with no mapping is shown, not hidden.** If Encompass gains a milestone
  tomorrow, an unmapped file must appear in the pipeline under its raw Encompass name rather
  than vanish from every view. Failing closed here means losing a loan off a screen, which
  is the worse error.
- **The borrower's label never comes from our stage.** It comes from the milestone's own
  `consumer_status`. Two hops would let our internal renaming leak into what a borrower
  reads.

### 4.1.2 Who sees which files

Owner-directed 2026-08-14. This is the answer to charter open question 8:

| Role | Long-term pipeline |
|---|---|
| Admin (and super-admin) | **Entire pipeline** |
| Closer | **Entire pipeline** — including files not yet assigned to them |
| Funder | **Entire pipeline** — including files not yet assigned to them |
| Loan officer | **Their own files only** |
| Processor | **Their own files only** |

The closer and funder deliberately get everything *before* assignment, because a closing or a
wire is picked up off the queue rather than handed over — they have to see the file to take it.

**How this is built, and why not the obvious way.** `staff_users.role` has no `funder` value
— its CHECK lists `super_admin, admin, underwriter, loan_officer, loan_coordinator,
draw_coordinator, processor, closer, software_setup, tpo_officer, tpo_processor`. Adding one
would be changing an RTL table to make LT work, which rule 5 forbids.

So LT gets its **own** access model in `src/longterm/access.js`, and it is settings-driven,
which the sellable rule requires anyway:

- A map from **PILOT role → long-term scope** (`all` | `own`), pre-filled with the table
  above. A buyer with a different org chart changes the map, not the code.
- A per-person **long-term role override**, for staff whose RTL role does not describe their
  long-term job — which is exactly the funder's case today. This lives in `lt_settings`, not
  on `staff_users`.
- **A role with no entry resolves to `own`**, never to `all`. An unmapped role must not
  silently inherit the whole book.
- **`own` resolves through the confirmed links** in `lt_staff_links` → `lt_loan_contacts`,
  which is why the people map is phase 1. Until a link is confirmed, an officer's own
  pipeline is empty — so phase 1 and phase 3 ship in that order for a reason.

LT does not import RTL's `permissions.js` or its scope SQL, and does not need to.

**Still to confirm:** the owner named admin, closer, funder, loan officer and processor. The
**underwriter** was not named. The plan assumes **entire pipeline**, matching what the
underwriter already has on the RTL side (`see_all_files`) and matching the closer and funder
— an underwriter reviews across the book rather than a personal queue. Flagged in §11 rather
than left silent.

### 4.2 The loan workspace

Three regions, which is the single most important structural pattern in the reference
portal and the one worth copying exactly:

- **A milestone stepper pinned above the content** — each node a completion date or a
  not-yet-reached mark, so a stalled file reads as stalled without a word of text.
- **A left section menu, rules-driven, not hard-coded.** Employment does not appear on a
  DSCR file — `lt_loans.employment_applies` defaults false and is true on only ~2% of the
  live book. A section that is unavailable is **shown greyed with a tooltip explaining
  why**, never hidden and never a dead end.
- **A persistent Summary rail on the right** that does not re-render as you move between
  sections: loan number, borrower, purpose, occupancy, loan amount, value, LTV, **DSCR,
  gross rent, housing expense**, rate, term, I/O period, prepay, program, milestone, lock
  status, lock expiration.

The rail is fed by **one loan-summary selector mounted once at the workspace level**. The
reference portal's own weakness — re-asking for the address and loan amount on the pricing
screen — is already avoided in our model, because Property and Loan Terms are single
entities.

**What our rail will never carry:** the investor. Theirs can show a counterparty freely
because their user *is* the broker; ours cannot. `AUDIENCE-RULES.md` outranks any layout.

---

## 5. The Condition Center

> ### DEFERRED — owner-directed 2026-08-14
>
> *"put the condition center in side for now that center should say colming soom continie
> building the rest non stop"*
>
> **The Condition Center is set aside.** It keeps its place in the shell — the nav entry and
> the loan-workspace section both exist — and both render a **"Coming soon"** panel. Nothing
> else changes:
>
> - **No `lt_conditions*` tables are created yet.** A migration that ships a table nobody
>   reads is a schema we would have to live with before we know the shape is right; the
>   research below (§5.0–§5.5) stays as the design of record for when it is taken up.
> - **No condition sync runs.** The read-only sweep that settled §5.0 is a research script,
>   not a worker, and it stays that way.
> - **The placeholder is a SETTING, not a hard-coded screen** (`conditions.enabled`,
>   default `false`). Turning it on is what un-hides the real screen when it is built — so
>   the deferral is a switch, exactly like every other customisation in §7. A buyer who
>   never wants it leaves it off.
> - **Nothing downstream may depend on it.** No stage, no access rule, no pipeline column
>   and no settings default may read a condition; if a later phase wants one, it waits.
>
> Everything below is the plan for the build, held in place, not deleted. When the owner
> lifts the deferral, §8's phase order picks it up where it was.

The owner called this a major part of the build, and the reference portal's own condition
screen is the interaction the whole product is judged on.

### 5.0 SETTLED — conditions exist, and they are a POST-PURCHASE artifact

Two of our own measurements disagreed: the census recorded **348 conditions across 12
loans**; the live probe found **`[]` on 200 of 200 loans**. Rather than pick the convenient
answer, a read-only sweep settled it on 2026-08-14.

**Method.** 400 loans off the v3 pipeline (of ~696 in the tenant), 235 of them DSCR;
`GET /encompass/v3/loans/{id}/conditions` on every one. Zero read errors. Script:
`scratchpad/settle-conditions.js` — reads only.

**Result: the census was right, and the probe sampled around them.**

| | Sweep | Census |
|---|---:|---:|
| Loans with conditions | **10** | 12 |
| Conditions found | **337** | 348 |
| Cleared / Fulfilled / Waived / Rejected / Received / Requested | 124 / 12 / 11 / 4 / 1 / 1 | 124 / 12 / 11 / 4 / 1 / 1 |

Six of the seven status buckets match **exactly**; the sweep saw 400 of ~696 loans, so it
missed two loans holding the other 11 conditions. The census is confirmed.

**And the sweep found the thing neither earlier run reported — WHERE they live.** All ten
loans sit in the correspondent post-close folders. Cross-referencing the folder census:

| Folder | Loans (of 400) | DSCR | Loans carrying conditions |
|---|---:|---:|---:|
| **Pipeline** (the active book) | 136 | 70 | **0** |
| Corr Post Purchase | 110 | 103 | 8 |
| Corr Post Closing | 22 | 14 | 2 |
| Corr Clear To Close | 12 | 10 | **0** |
| Broker CLOSED | 56 | 2 | 0 |
| Started / Prospect / Pre-Approval | 31 | 15 | 0 |

**Not one active long-term loan in this tenant carries a single Encompass condition.**
Neither does anything at Clear to Close. Every condition in the system is on a loan that is
already closed and sold, and even there only ~8% of them (10 of 132) have any.

### 5.0.1 What that means for what gets built

These are **investor post-purchase conditions** — the trailing documents and deficiencies the
buyer of the loan raises *after* purchase. That is consistent with everything else measured:
most long-term files are underwritten by the investor rather than by us, and the milestone
list carries `Investor Delivery` → `Purchasing Conditions` → `Final Docs` as its own late
stage.

So a condition centre built **only** on Encompass conditions would be empty on every live
file an officer is working, and would light up only after the loan is sold. That is a real
product, but it is a **post-purchase deficiency tracker**, not the underwriting condition
centre the phrase usually means.

The live day-to-day work happens in the **eFolder** instead — the probe counted 101 documents
on a mature loan, in groups including `Needs List - Initial`.

**The recommendation, on the evidence: build it to read both, and let the file decide which
face it shows.** They are the same shape — a requirement, its documents, its status — and
Encompass already links them (the document carries `conditions[]`, 179 links recorded). One
module, two feeds:

- **Encompass conditions** → populate on post-purchase files. This is also literally what the
  owner asked for: *"linked on the condition for existing files that had conditions, with all
  the documents in there linked."*
- **The eFolder needs list** → populates on live files, which is where the work is.

**This is a recommendation, not a decision.** Confirming that the team really works the
needs-list rather than conditions on a live file is a question for the owner (§11).

### 5.1 What the census recorded

12 loans carry conditions, holding **348 conditions**, 5 to 67 per loan, **213 still open** —
all of them, per §5.0, on already-sold files.

Alongside them: **20,569 eFolder documents across 673 loans, 28,822 attachments, 179
document→condition links, 230 configured document types, 197 condition templates, 19
condition sets.**

### 5.2 The four things the model must get right

1. **Encompass is the source of truth; ours is a mirror.** Every row keyed on Encompass's
   GUID, every row carrying `encompass_synced_at`.
2. **A document is not a file.** The eFolder DOCUMENT is the slot ("Appraisal"); the
   ATTACHMENT is the paper. One document holds many attachments.
3. **The link runs document → condition, and only that way.** The document carries
   `conditions[]`; there is no condition→documents endpoint. "Which documents satisfy this
   condition" is built by **inverting** the mapping — which is why it is its own
   many-to-many table and not a column.
4. **`status_open` is mirrored, never derived.** Encompass computes whether a condition is
   outstanding. Deriving our own from the status word would let our screen disagree with
   theirs.

### 5.3 The tables

`lt_conditions` · `lt_condition_comments` · `lt_documents` · `lt_document_attachments`
(**metadata only — the paper stays in Encompass, we keep the URI**) · `lt_document_conditions`.

A removed condition is **mirrored and then filtered on read**, never deleted — everything in
the eFolder is soft-deleted, and the record of what was once asked for has to survive.

### 5.4 The screen

Conditions grouped into collapsible sections by stage, each showing a count of what is
outstanding even while collapsed. The default filter shows **unapproved first** — the system
should be opinionated about showing you your work before showing you everything.

Clicking a condition opens it in full, with its own upload target. **Each condition is an
individual micro-upload destination**, so somebody clearing twenty-seven conditions attaches
exactly the right document to exactly the right requirement instead of dumping everything
into one folder and hoping underwriting matches it up.

A **submission event log kept separate from condition status**, because
uploaded-but-not-submitted, submitted-but-not-reviewed and reviewed-and-satisfied are three
different states — and Encompass models it the same way.

### 5.5 The read side ships first, and the write side is blocked

Reading conditions is free and covers the larger half. **Uploading a document into the
eFolder is a write**, it is authorised in principle by the owner, and it is **blocked in
code** because the request and response shapes are recorded as UNVERIFIED on the pad. The
four-step path is known by name only:

```
POST /encompass/v3/loans/{loanId}/attachmentUploadUrl   → name only
PUT  <returned cloud-storage URL>                       → name only
PATCH /encompass/v3/loans/{loanId}/documents            → not verified
PATCH /encompass/v3/loans/{loanId}/conditions           → not verified
```

**To unblock it:** confirm each request and response against the live tenant, write the
verified shapes into the pad, then build one guarded writer that the CI gate can name by
path. Not before. A master switch already exists — `efolder.writesEnabled`, default false.

Note also: the v1 attachment endpoints are **sunset in ICE release 26.3**.

> **The `200 []` trap.** Four v1 condition routes answer with an empty array on files that
> plainly have conditions — they answer for a legacy system this tenant does not use. **An
> empty 200 is not proof of absence.** The working call is
> `GET /encompass/v3/loans/{id}/conditions`.

---

## 6. Pricing and the lock desk

The owner called this a major, major part, and it is also where the read-only rule bites
hardest — so the plan splits it deliberately.

### 6.1 Read-only first — and the readable surface is narrower than the docs suggest

**The live probe changed this section.** The earlier research described a rich read surface:
`GET /v1/loans/{id}/ratelockrequests` (full request history), `.../{lockId}?view=detailed`,
`.../{lockId}/snapshot`. Against the live tenant, **every lock-specific endpoint and every
EPPS pricing endpoint answers 403.** So the lock *history* is not readable today.

**What genuinely reads right now:**

- `GET /encompass/v3/loans/{id}?entities=rateLock` — 51 keys, the current lock posture.
- Fields **`761`** and **`762`**. Note that **`2148` is empty on this tenant** — it is quoted
  as the lock date in a lot of general Encompass material, and here it holds nothing.
- The `Loan.Lock*` pipeline canonicals, so lock status can be a pipeline column.
- The Trade buy-side / sell-side canonicals.

So the plan stands but shrinks honestly: we can show **where a loan's lock stands right now**
— status, rate, dates, expiry countdown — on the pipeline and in the workspace. We cannot yet
show the **history** of how it got there. `lt_lock_events` is still the right table, and it
will be thin until the 403s are lifted (§11, item 4 — the same client-registration scope
problem).

Requesting, confirming, extending, re-locking and cancelling are all writes and stay off
until the owner authorises a specific endpoint in writing.

> **HARD RULE, recorded from the API research: trust `lockExpirationDate`. Never recompute
> it from lock date plus days.** Extensions and re-locks move it, and a recomputed date will
> quietly disagree with the investor's.

### 6.2 The tables

`lt_locks` (the current posture per loan: status, rate, price, lock date, expiration, days
remaining, product, commitment type) and `lt_lock_events` (the append-only history —
requested, confirmed, denied, extended, re-locked, cancelled, expired, each with its date
and who did it). A snapshot replace with history appended, never append-only — a lock can be
rolled back, and so can a milestone.

### 6.3 What "beating the lock desk" actually needs

The read-only mirror answers *where does this loan stand*. Running a real lock desk —
pricing scenarios, margin, extensions priced against a rate sheet, worst-case pricing, a
pull-through view — is a separate build with its own product-and-pricing engine, and it is
scoped as its own phase behind this one. The owner has said separate agents will work the
actual lock desk; this plan gives them the mirror, the data model and the surface to build
into.

---

## 7. Everything customisable is a setting

The rule, in the owner's words: *"everything that I'm telling you to build, which is
customizable to us, should be in the settings pre-filled customizable for us, but everything
should be able to be changed so we can sell the system eventually and customize it according
to someone else's needs."*

In practice, and this shapes every table in this plan:

- **No YS Capital number, threshold, label, program name, investor, role name, condition
  category, document type or pipeline column is a constant in code or a column default.** It
  is a setting, pre-filled with our value.
- **Enums stay few, and only for what is true of the domain**, not of us. A party is a
  borrower or a co-borrower everywhere in the world; a program name is not. Programs,
  investors, condition categories, document types and stage names are **text plus a
  settings-driven list**, because an enum is a migration every time a buyer wants a
  different word.
- **Anything measured from our tenant is research about *our* data** — fill rates, the
  investor spellings, the 12-vs-120 interest-only question — and must never become a rule
  another lender inherits.

**What is missing today:** `src/longterm/settings/encompass-settings.js` already declares 44
settings in 10 groups with our values as defaults and a `resolve(overrides)` that accepts
overrides — but **there is no table behind it.** This plan adds one.

**`lt_settings`** follows the pattern already proven on the RTL side (a hard whitelist, a
jsonb bag, defaults overlaid on read, an unknown key refused rather than stored):

```
scope       text NOT NULL    -- 'company' today; 'tenant' when it is sold
key         text NOT NULL
value       jsonb NOT NULL
updated_by  uuid REFERENCES staff_users(id)
updated_at  timestamptz NOT NULL DEFAULT now()
PRIMARY KEY (scope, key)
```

Reads start from the declared defaults and overlay the row, so a missing row or a missing
key always resolves to a concrete value and a broken table degrades to our behaviour rather
than to nothing.

**Two settings screens**, as the owner asked: an **admin** one (the roles that exist, the
stage list, the pipeline columns, condition categories, document types, the Encompass
connection) and a **regular** one (per-user: default product side, default pipeline view,
notification choices).

---

## 8. The build order

Each phase is independently useful and independently reviewable. Each ends with something on
a screen.

### Phase 1 — The people map — **BUILT**
`lt_encompass_users`, `lt_staff_links`, `lt_loan_contacts`; the roster pull; the email
auto-match; the admin confirm screen. **Ends with:** an admin can see every Encompass user,
confirm who they are in PILOT, and the mapping is ready for everything downstream.

### Phase 2 — Bring the loans in — **BUILT**
The sync: pipeline discovery, then a full per-loan read for anything a decision depends on.
Writes `lt_loans` and its sections, `lt_loan_contacts`, milestones. Records
`encompass_synced_at` so freshness is always visible. **No writes to Encompass.**
**Ends with:** real long-term loans in our database, refreshing on a cadence.

> **The pipeline is for discovery only.** It reads the Reporting Database, which lags loan
> saves, exposes only the fields an admin provisioned, and returns several computed `CX.*`
> fields as null that the full loan read populates. Never populate a decision-bearing
> snapshot from a pipeline row.

### Phase 3 — The pipeline and the switch — **BUILT**
`app-v2/src/longterm/**` comes into existence: the shell, the product switch, the pipeline
table, filters, saved views, scope. **Ends with:** an officer signs in, flips to Long-Term,
and sees their own long-term book.

**The two control rows this section names shipped in the same pass as the columns.** Status
chips and scope chips, each carrying its own count, because a chip without a number is a guess
about where the work is. **A facet count has to describe what CLICKING it would show**, which is
the whole subtlety: counting the stages under the same WHERE the list uses means that with a
stage selected every other stage answers zero, and a row of zeroes is a row nobody can navigate
out of — the way back is the chip that says there is nothing there. So each facet is counted with
its OWN filter lifted and every other one kept, both halves built by the same function the list
uses. **The scope is never lifted**: it is the authorization rather than a filter, and a chip
counting files the viewer may not open would tell them a book exists that they cannot reach.
"Mine" is `access.onFileSql` — the SAME predicate that decides what a scoped viewer may see at
all, because defining it as "the loan officer is me" hands every processor an empty book of their
own — and it is asked for as a flag resolved from the session, so nobody can read somebody else's
personal queue by editing a URL. The scope row is not drawn for a viewer who only sees their own
files: three chips that all select the same book is not a control.

**Auditing that work back found four more, none of which any test had failed on**, and they
are worth keeping because they are all one shape: a number or a control that looks right and
quietly describes the wrong thing. (1) The **"Every stage" chip read the LIST's own total**,
which is counted WITH the stage filter — so selecting a stage made it show that stage's number
and nobody could see how big the book was, undoing every other count in the row on the one chip
whose job is to clear them. (2) **A scope filter a viewer's own scope makes contradictory was
being obeyed**: a saved view is SHARED, so an admin's "Nobody yet" opened by a loan officer asks
for files nobody is on inside a book defined as the files they ARE on — an empty pipeline, with
no scope row drawn for them to clear it with. It is now dropped and said out loud. (3) **The
loans with NO stage at all were visible and unreachable** — this tenant's pipeline-search
milestone column is blank on every loan, so an unstaged loan is the normal state of the NEWEST
files; they sat in the list, were counted in the header, and no chip could reach them, which
also meant the chips did not sum to the number above them. (4) The front end carried **three
copies of the same formatters**, two of which had lost the calendar-day guard — a DATE column
handed to `new Date` prints the day before in every US timezone, and making the columns
configurable is exactly what would have made that visible for the first time. One shared module,
and a test that fails the build if a long-term screen defines a formatter of its own; that guard
found the third copy immediately, which is the argument for having it.

**The columns took a second pass, and the reason is worth keeping.** `pipeline.columns` was
declared in phase 6 with the fifteen-key default §4.1 names, and **nothing read it** — the screen
hard-coded nine. So a buyer could change the pipeline, save it, reload, and see exactly what they
saw before, with no error to act on. That is worse than offering no control at all: a dead switch
teaches people the system ignores them, and the lesson is expensive to unteach. Seven of the
columns this section names were not shown at all, and two of them (the property address, the LTV)
had no source in the query because `lt_properties` was never joined.

`src/longterm/pipeline-columns.js` is the catalog and the resolver, and it carries two rules.
**A column we cannot source is dropped and REPORTED, never rendered empty** — `expected_closing`
is in the setting's own default and there is no closing date on `lt_loans` to fill it, and a
column of dashes on every row of every loan forever reads as "we failed to fetch this" rather
than "we do not hold it", which is the confident blank this side keeps finding. A key nobody
declared is named on the screen for the same reason: a typo that silently disappears looks
identical to a setting that did not save. **And the setting never becomes SQL** — the query
selects the same fixed expressions every time and the setting decides only what the SCREEN draws,
in what order; building a SELECT list out of a stored value would put what an administrator types
into the query text and hand the planner a different statement per configuration. The test
asserts the statement is byte-identical under two different configurations, and that the query
module does not so much as `require` the catalog.

Each column carries the ROW FIELD it reads, so the screen holds no map of its own — a table
repeated on both sides is one that eventually disagrees with itself, and the disagreement shows
up as an "LTV" heading over a rate. Every sortable column is asserted to name a key `SORTABLE`
actually accepts, so a heading can never ask for an order the query refuses, and the arrow is
drawn from what the server says it DID rather than from what the screen asked for. **The product
stamp rides the FIRST column, whichever column that is** (CLAUDE.md §7): hanging it off the loan
number would let a configuration that drops that column drop the stamp with it, and the stamp is
not configurable.

### Phase 4 — The loan workspace — **BUILT**
The three-region layout, the URLA-sectioned read-only file, the Summary rail, the Contacts
section, the milestone stepper. **Ends with:** a real file on our own screen — which is what
surfaces the gaps in the model before anything depends on them.

**What it surfaced, as promised.** Two gaps, both fixed where they belonged rather than on the
screen: the workspace read `lock_status` and `lock_expiration_date` off the loan row while those
columns live in `lt_locks`, so its "Rate lock" section was greyed with a reason that was not true
on every loan (the single-loan route now joins the lock — phase 7); and the pipeline's rows had
been navigating to a route that did not exist since phase 3, so every click on a long-term file
landed on the fallback. A section that does not apply is greyed **and still clickable**, because a
disabled control that does nothing when pressed teaches people the screen is broken while one that
answers "the Condition Center is coming soon" answers the question they had.

**The sections themselves shipped afterwards, and this line is here because for a while this
phase read as finished while every section still showed a placeholder.** `src/longterm/file.js`
is the one read behind all of them — ten queries returned keyed by SECTION KEY, so the screen
renders `file[active]` and owns no map of its own. Three properties are stated in its header and
each is asserted from BOTH sides, because a rule proven only one way is proven about the wrong
thing: **the Social Security number is never SELECTed** (the pure suite reads the source, the DB
suite puts real encrypted bytes in a row and searches the response for them); **a missing figure
totals to NULL, never 0**; and **the investor is absent by construction** (the DB suite gives the
loan an investor and proves the file still cannot see it).

**And it surfaced two more of the same class it was built to surface — both invisible, both
found only by running against a real database.** The ARM block was gated on the word `arm` while
the column is the enum `('fixed','adjustable')`, so the adjustable-rate terms would never have
appeared on a single adjustable loan; the guard that read the SOURCE passed the whole time,
because the string it was looking for was right there. And `summaryRail` read the appraised
value, LTV, occupancy and rent off the LOAN row while all four live on `lt_properties` — so the
rail said "Property value —" on a file whose Property section showed $400,000 two clicks away.
The rail now takes the SAME sections the Property tab renders, which is why the two can no longer
disagree; and the lesson worth carrying into phase 8 is that **a swallowing catch turns a wrong
name OR a wrong value into a confident empty answer, and only a real row of the real type can
tell the two apart from "there is genuinely nothing here".**

**One more, from the screen rather than the data.** A grid with no declared column gets an
implicit `auto` one that sizes to its content, so a section carrying a table wider than a phone
stretched its whole card to 759px inside a 390px screen — and `html{overflow-x:clip}` then hid
it, so the page reported no sideways scrolling while half of every row was cut off and
unreachable. Measuring `documentElement` is what made it invisible; measure `document.body`.

### Phase 5 — The Condition Center (read) — **DEFERRED (owner-directed 2026-08-14)**
Set aside. The nav entry and the workspace section ship as a **"Coming soon"** placeholder
behind the `conditions.enabled` setting (default off); no tables, no sync, no dependants.
The design is held in §5. **Ends with:** nothing — this phase does not run until the owner
lifts the deferral, and the phases below moved up one to take its slot.

### Phase 6 — Settings — **BUILT**
`lt_settings`, both screens, and the pass that moves every value this plan named as a
setting out of code and into it. **Ends with:** the sellable rule stops being a comment and
starts being a feature.

**The screen is drawn from the server's own description**, so adding a setting server-side makes it
appear with no front-end change. There is no list of settings in the front end and there must never
be one — a copy there is a second source of truth for "what can be configured", and the day the two
disagree the front end is the half people trust. The editor is chosen from the declaration's TYPE,
which is why a `fieldId` edits as text (an Encompass field number is the single most likely thing a
buyer has to change) while a `map` is shown read-only (a generic editor over the milestone ladder
would let one mistyped brace destroy it).

**And one real defect this phase turned up:** `access.adminRoles` decides who may change the
settings, **so it can edit itself out of reach**. Saving `['loan_officer']` locked every
administrator out of the screen that undoes it, leaving a hand-written database row as the only way
back. `super_admin` is now a floor, added to the list whatever the setting says — a gate whose own
remedy nobody at the company can perform is a dead end.

### Phase 7 — Locks and pricing (read) — **BUILT**
`lt_locks`, `lt_lock_events`, the lock section and the pipeline column. **Ends with:** the
lock posture of every loan, visible and current, ready for the lock desk build.

**Built as §6.1 describes it, and no wider.** The posture is read from the loan the sync already
fetched — the `rateLock` entity where it answers, the two numbered fields where it does not — so no
lock endpoint is called and none would answer. The expiration is taken **exactly as stated** and is
never calculated from the lock date plus a day count; a loan carrying "30 days" and no stated
expiration reports none and says why, because a calculated date is wrong in the direction that
costs money. The ONE inference the reader permits itself is ORDER: where both numbered fields parse
as dates the LATER is the expiration, since an expiration cannot precede the lock it expires — that
is arithmetic, not a guess about a business rule, and it is what stops a mis-set field id making
every loan look expired the day it locked.

`lt_lock_events` is filled from what PILOT itself watched change between two reads, every event
type named `observed_*` so it can never pretend to be Encompass's own request history, and the lock
screen says so in words. The posture is replaced wholesale on each read while the history is only
appended — a lock can be rolled back exactly as a milestone can — and a re-read that changed
nothing appends nothing. The pipeline carries the status, the expiration and a SQL-computed
countdown, computed there so the column can be SORTED on: whatever expires soonest, first.

### Phase 8 — Editing, and the eFolder write — **STARTED; the eFolder half still blocked**
Our own fields become editable. The eFolder upload ships **only** once its contract is
verified and the pad entry is completed.

**The first editable field is the one §2.3 designed and nothing could set: the local
reassignment.** `override_staff_id` and its stamp were written by the phase-1 migration,
honoured by the pipeline scope, the file screen and the officer filter — and had **no
writer anywhere in the repository**. `contacts.setOverride` existed with zero callers, so
the two-source assignment model was read-only on the side PILOT was supposed to own: a
file Encompass had wrong stayed wrong. `contacts.reassign` is the guarded orchestration
over it, `POST /api/lt/pipeline/:loanId/contacts/:role/override` the door, and the
Contacts section carries the control.

**It is an ADMIN gate, and that is a security boundary rather than a courtesy.**
`access.onFileSql` matches `override_staff_id`, so SETTING one grants somebody access to a
file and CLEARING one takes it away — a scoped officer able to set their own could read
any file in the book by naming themselves on it. `mayReassignLoan` therefore DELEGATES to
`mayManagePeople` (one rule, not a second copy that drifts when a buyer narrows
`access.adminRoles`) and, like it, reads the person's REAL role and never the long-term
role override: that override is a settings value, so a gate that read it would turn a
settings typo into a route to granting yourself files. The pure suite asserts exactly that
case, because it is the one that looks harmless.

**A reassignment must say why; undoing one must not.** The stamp is "who, when and why"
(§2.3), and the why is what the next person reads when the file does not match Encompass —
so naming somebody requires a reason and a few spaces is not one. Clearing asks for
nothing: demanding an explanation to undo a mistake is how a wrong override survives.
Neither an outside broker (a TPO `staff_users` row — an override would put an outside firm
in the long-term pipeline) nor a deactivated person may be named, and a role that is not on
the file is refused IN WORDS rather than answered with a silent success.

**And it surfaced the drift `access.js`'s own header warns about.** Everything that answers
"whose file is this" reads the EFFECTIVE person — `pipeline.officerIsSql`, `UNASSIGNED_SQL`,
the row's own `staffId`, `describeContact.effectiveStaffId`, all
`COALESCE(override_staff_id, staff_id)`. Only the ACCESS scope reads
`staff_id = me OR override_staff_id = me`. So a reassigned file leaves the previous
officer's officer-filter while staying in their own pipeline and openable by them — the
same file answering the same question two ways. That was never decided: until this phase
nothing could set an override, so the case could not arise, and the OR was simply the safe
way to make the new person's access work. **Who keeps access after a reassignment is a
business rule and is item 14 below, not a decision taken here** — the behaviour is pinned
by the DB suite exactly as it is, and the screen says so in words rather than letting an
admin believe they have taken a file away from somebody. If the answer is "the file leaves
them", one assertion flips and `onFileSql` becomes the COALESCE the other four already use.

---

## 9. What crosses, and what does not

LT code lives only in `src/longterm/**` and `app-v2/src/longterm/**`; HTTP only under
`/api/lt/*`; tables only `lt_*`; migrations only `db/NNN_lt_*.sql`; tests only
`scripts/test-lt-*.js`. `scripts/check-product-separation.js` fails the build on a crossing
that is not in the ledger.

**What this plan needs, and already has:**

- `sql-ref staff_users` and `sql-read staff_users` — authorised 2026-08-03. This is what lets
  `lt_staff_links` and `lt_loan_contacts` point at a PILOT person.
- `sql-ref borrowers` / `sql-read borrowers` — authorised. Read-only, as it must stay.
- `import src/auth/index.js` — authorised. One login.

- **The front-end mount seam** — authorised 2026-08-14: *"You were authorized to touch that
  switch of the short-term shell."* Recorded in the ledger as `rtl-import app-v2/src/App.jsx`
  (the router mounts the LT screens) and `rtl-import app-v2/src/components/StaffLayout.jsx`
  (the shell renders the switch). Deliberately as narrow as the back-end seam: those two files
  may reference LT code **only** to mount it and to render the switch. **No RTL screen may
  import an LT component for its own use, and no LT logic may move into a shared file.**

**What this plan needs and does NOT have:**

1. **Nothing from RTL's condition machinery.** Not `checklist_templates`, not
   `checklist_items`, not `src/lib/conditions/**`, not the rules engine, not the document or
   eFolder code. The LT condition centre is a brand-new build. This is stated here so nobody
   later mistakes silence for permission.

2. **Nothing from RTL's permissions or pipeline scope.** `src/lib/permissions.js`,
   `visibleOfficersSql` and the RTL pipeline filter stay where they are. LT's access model
   (§4.1.2) is its own, and it has to be — it is settings-driven and keyed on long-term roles
   that `staff_users.role` does not carry.

**What is free and needs nothing:** the stylesheet. `app-v2/src/styles.css` is one global
sheet, so every LT screen gets the PILOT tokens and component classes with no import and no
crossing. The *components* still have to be written fresh — an LT screen may not import an
RTL React component, and the one authorised exception is `BorrowerProfilePanel.jsx`.

---

## 10. Encompass stays one-way

Reading is unlimited and needs no authorisation — loans, fields, milestones, conditions,
documents, settings, and inbound webhooks. **We never write.**

The only authorised write in the whole repository today is flood-determination ordering, and
it is **RTL-only**. Long-Term has no writer at all, and
`scripts/check-encompass-readonly.js` fails the build if one appears.

Two structural facts to keep true in any new LT Encompass code: `src/longterm/encompass/client.js`
keeps `READ_ONLY = true`, and its POST allowlist stays at exactly the token and pipeline-search
paths (the field reader is matched by its own narrow predicate). Any new LT Encompass HTTP goes
through that client.

**Also owner-directed and not yet done:** set the Encompass API user's ICE persona to
read-only, so a write is refused by Encompass itself and not only by our own gate.

---

## 11. What only the owner can answer

**Answered 2026-08-14** — recorded here so the answers do not scroll away:

1. ~~**Encompass milestones or our own stages?**~~ **Both, in layers.** *"we're going to use
   the Encompass stages, but we're going to map those Encompass stages to our own stages. We're
   not going to have, on the consumer side, all stages from Encompass. You can use the Encompass
   consumer-visible stages for the consumer side."* Designed in §4.1.1. *(Charter open question 7,
   closed.)*
2. ~~**Who may see the long-term side?**~~ **Admin, closer and funder see the entire pipeline;
   loan officers and processors see their own.** Closer and funder get everything even before
   assignment. Designed in §4.1.2. *(Charter open question 8, closed.)* **Still to confirm: the
   underwriter**, who was not named — the plan assumes the entire pipeline, matching their RTL
   access.
3. ~~**Is there a TPO / broker portal on the long-term side?**~~ **Not for now — the client is
   the borrower**, on the login they already have. *"Right now, it's the borrower, which will
   automatically be connected to the borrower login that they already have."* That is the already
   authorised shared identity zone, so it needs nothing new. The investor-name rule still applies
   in full to that borrower.
4. ~~**May the front-end shell be touched to add the switch?**~~ **Yes** — recorded in the ledger.

**Still open:**

5. **§5.0 — do conditions exist in this tenant or not?** Two of our own measurements disagree.
   This is the largest open question in the plan and it blocks phase 5.
6. **ICE entitlement — REVISED 2026-08-16. The owner's objection was right, and the
   likeliest cause is ours, not theirs.** 68 endpoints answer 403, including the loan-folder
   list, milestone logs, the v3 associates roster and **69 of the 91 Milestone Completion
   rules**. Two earlier readings were wrong and are corrected in
   `docs/longterm/ENCOMPASS-ACCESS-AND-PERSONA.md`: **(a)** `encompass_admin` is **not a
   scope ICE documents** (Developer Connect names `lp`; Partner Connect names `pc pcapi`;
   two mature open-source clients name neither), so the recorded ask — "entitle client
   `z1xx73r` to `encompass_admin`" — names something that appears not to exist and should
   not be sent; **(b)** the persona is **not** the gate. ICE's matrix lists these areas under
   "Default Persona Access", footnoted *"minimum persona access level required to interact
   with the functionality out-of-the-box"*, and lists them as **Super Administrator** — which
   the API user already is. Ticking boxes on Personas > Settings tab extends an area to
   OTHER personas and opens nothing for a super admin.
   **The best untested lead is that we ask for too little.** Our token request names
   `scope=lp`; both reference clients send **no scope at all** on this grant, and OAuth
   grants a default — normally everything the caller is entitled to — when none is named.
   The earlier introspection could never have caught it: it reported `lp` because `lp` is
   what we asked for, which made the measurement circular. Free to test.
   Genuinely still ICE's: the licensed add-ons (pricing/EPPS, secondary and the lock desk,
   tasks). **Which cause closed which endpoint remains unknown** — the earlier sweep kept
   status codes and discarded the response bodies, and the wording differs by cause.
   `scripts/test-lt-encompass-access-probe.js` tests the scope question first and then
   captures those bodies. Run it before raising anything with ICE.
7. **Is there a sandbox instance?** Today every read runs against production, which carries
   real borrower PII. This matters before anything writes.
8. **The ten files** carrying a 12- or 24-month interest-only period on the plain 30-year
   program — real short-I/O deals, or values left behind from a file that started as a bridge?
9. **The loan doc type stores `DSCR` on 486 files**, which is not a valid code — and the
   tenant's base Milestone Completion rule is conditioned on Doc Type = "No Documentation",
   so those files never switch those requirements on.
10. **Do long-term files appear in the RTL dashboards and KPIs**, or are the two books counted
    separately?
11. **The underwriter's long-term access** (see item 2) — entire pipeline, or their own files?
12. **A webhook subscription already exists on this tenant** pointing at
    `automations.drivekosher.com` for `milestone` and `milestoneupdate` events. It is not ours.
    Long-Term would need its own subscription — which is a **write** to Encompass configuration
    and would need its own pad entry. Worth knowing who owns the existing one before anything
    is added beside it.
13. **Which loan folders mean the deal is over?** §4.1 says inactive loans stay in the one table,
    "distinguished by status — no separate archive screen", and today nothing distinguishes them:
    the sweep discovers every folder Encompass returns for a loan amount over zero, so a file
    somebody moved to Adverse or Trash sits in an officer's live book looking exactly like a
    live one. Folder names are the TENANT'S OWN, and we **must not guess** which of them mean the
    deal is over: treating a folder called "Archive" as dead would silently empty part of somebody's
    pipeline on a hunch.

    **CORRECTED 2026-08-17 — "we cannot read them" was FALSE, and it had been written down three
    times.** This item, the setting's own evidence note and §4.1 all said the names were unreadable
    because the folder-LIST endpoint is one of the 68 the entitlement question refuses (item 6).
    True of that endpoint, and **false of the fact**: the folder is a FIELD ON EVERY LOAN
    (`CX.LOAN.FOLDER.CURRENT` → `lt_loans.loan_folder`), which the sync has been mirroring since
    phase 2 — so the names, and the number of files in each, were already sitting in our own
    database the whole time. `src/longterm/observed.js` counts them straight off the book and the
    settings screen now offers them as chips with a file count each, so the answer is a few clicks
    rather than somebody going and transcribing a list from Encompass.

    **The lesson is worth more than the feature.** A blocker recorded once gets read as settled
    forever, and this one survived three re-readings because every reader checked the same
    endpoint. A "we cannot read X" note is only as good as the LAST place somebody looked — before
    trusting one, ask whether the fact rides on something we already mirror.

    **What has NOT changed is the half that matters.** Reading a fact is ours; judging what it
    means is the owner's. Which of those folders mean the deal is over is a business rule nobody
    here may guess, so the default is still empty, nothing is hidden from anybody until a human
    picks, and the screen OFFERS rather than pre-selects.

    **The mechanism is now BUILT — only the folder names are outstanding.** (An earlier draft of
    this item said it was already built; it was not. `pipeline.inactiveFolders` existed nowhere.
    It does now.) `src/longterm/pipeline-book.js` is the one definition of the split: the setting
    `pipeline.inactiveFolders` on the Long-Term settings screen, an unlisted folder ALWAYS counting
    as live (fail toward showing, like an unmapped milestone), a loan carrying NO folder counting
    as live too, and the pipeline defaulting to the live book with **Live / Finished / Both** one
    click away. Matching is forgiving about casing and spacing on both sides and nothing else — a
    prefix match would let "Adverse" swallow "Adverse Action Withdrawn — Reinstated", which we
    cannot check against a list we are not allowed to read.

    **It ships INERT.** The setting's default is an empty list, and with it empty the query is
    byte-identical to the one that ran before the split existed, every book selects the same rows,
    and the control row is not drawn — three chips selecting identical rows is not a control. A
    tenant that never answers this question cannot tell the feature shipped. Asking for the closed
    book on a tenant that has named no folders is reported back on screen rather than silently
    ignored, because a SHARED saved view could otherwise hand a desk an empty pipeline with no
    control row to clear it with.

    Guarded by `scripts/test-lt-pipeline-book-pure.js` and `-db.js`; six deliberate breakages of
    the rule (an unlisted folder counted as finished, the folderless loan dropped out of both
    books, the book filter applied to its own chip counts instead of lifted, the spacing collapse
    dropped, the split turned on with nothing configured, a guessed folder name shipped as the
    default) were each confirmed to turn both suites red. The observed-name half is guarded by
    `scripts/test-lt-screens-db.js` — the folders are counted off a real book including the
    no-folder bucket, the resolver answers EMPTY rather than throwing (an unreadable list must
    leave the setting exactly as usable as the plain box it was), and the default is still `[]`.

    **What is still needed is one answer: which of those names mean the deal is over.** The screen
    now shows the owner their own folders with a count each; picking them is a few clicks and no
    code change.

    **What is still needed is the list of folder names and which of them mean the deal is over** —
    one answer from the owner, typed into one setting, no code change.

14. **When a file is reassigned by hand, does the person Encompass names keep it?** Raised
    by phase 8's local reassignment (see above), and it is one question with one answer.
    Today they KEEP it: the access scope admits both the Encompass-resolved person and the
    locally-assigned one, while every other reading of "whose file is this" already treats
    the file as the new person's alone. So reassigning ADDS somebody rather than moving the
    file, and an officer who leaves the team keeps every file they were ever named on.

    Two defensible answers, and this is the owner's to pick. **"It moves"** makes a
    reassignment mean what it says and is what the other four predicates already assume;
    the cost is that a handover is abrupt — the previous officer loses the file the moment
    the button is pressed. **"They keep it"** is what happens now and is gentler mid-
    handover; the cost is that nothing can ever take a long-term file away from anybody,
    which is a real gap when somebody leaves or should not be seeing a file.

    Nothing is hidden while it is open: the behaviour is asserted in
    `scripts/test-lt-contact-override-db.js` and stated on the reassign control itself, so
    nobody presses the button believing it does the other thing. One answer, one predicate,
    no migration.

---

## 12. The honest risks

- **The eFolder write may not be confirmable from the outside.** If the request shapes cannot
  be verified against the live tenant, uploading documents into Encompass stays blocked and
  the condition centre stays read-only. That is a real limit on the owner's stated ask, and it
  is better named now than discovered in phase 5.
- **The 403s are a real ceiling.** Until the client registration gains `encompass_admin`, we
  cannot read the loan-folder list, the milestone logs, or most of the completion rules — and
  custom dropdown option sets are inferred floors, not the real lists.
- **The condition centre may be built on sand — see §5.0.** Our own two measurements disagree
  about whether this tenant holds any conditions at all. Even on the optimistic reading, 12 of
  490 long-term loans carry them, because the investor underwrites most files — so a centre
  built only against Encompass conditions is quiet on 97% of the book. On the pessimistic
  reading the live workflow is the eFolder needs-list instead, and the module is a different
  product. **This is the single biggest scoping risk in the plan**, and it is a question for
  the owner rather than a decision for us.
- **The URLA arrays are not where a modern reader would look.** In this tenant the loan
  carries its data in `vols[]` / `vods[]` / `otherAssets[]`, while the modern `assets[]` and
  `liabilities[]` arrays are **empty**. A 1003 screen built against the modern arrays would
  render blank on every real file. The whole application is readable in one GET via 18 accepted
  sub-entity names.
- **The token has no stated lifetime, and the client already survives it.** It lasts 30 minutes
  and `expires_in` is **not returned** by this tenant — so a client caching on `expires_in - 60`
  would be caching on `undefined`. Checked: `src/longterm/encompass/client.js:138` reads
  `(j.expires_in || 1800) - 60`, and 1800s is exactly the measured lifetime. Correct by
  accident or by design, it holds — **do not remove that fallback.**
- **The API budget is 500,000 calls a day with a ceiling of 30 concurrent** — shared across
  every integration touching this tenant, not just ours.
- **The appraisal XML is unrecoverable for historical files.** The download URLs are minted at
  delivery with a ~15-minute life; all 298 historical ones are expired. The durable fix is to
  have the vendor deliver the XML to us directly.
- **Two sources of truth for assignments** is a cost the override rule accepts deliberately.
  It is manageable only because divergence is displayed rather than hidden.
