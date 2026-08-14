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
insurance (1500).

`GET /encompass/v1/loans/{id}/associates` also answers (array of 3 live) and gives the
Encompass-side roster with role ids. The **v3** form and `/roles` both 403 on our client
registration — see §11.

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

**Stages.** The pipeline speaks Encompass's own 19 milestones (Started → LO Prep → Loan
Setup → Submittal → Cond. Approval → Processing → Waiting for Docs → Resubmittal → Clear To
Close → Schedule Closing → Ready for Docs → Docs Out → Wire Order → Funding → Investor
Delivery → Purchasing Conditions → Final Docs → Closed → Completion), because they already
carry TPO-facing and borrower-facing wording and need no translation. **The stage list is a
setting**, so a buyer with different milestones changes it without a migration.

Read the current milestone from **`MS.STATUS`** — the pipeline's own `Loan.CurrentMilestone`
column is blank on every loan in this tenant.

**Scope.** Whose files an officer sees resolves through the confirmed links in
`lt_staff_links` → `lt_loan_contacts`. LT gets its own scope function in `src/longterm/` —
it does not import RTL's, and does not need to.

**Saved views** are per-user rows in an `lt_pipeline_views` table, not a code change.

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

The owner called this a major part of the build, and the reference portal's own condition
screen is the interaction the whole product is judged on.

### 5.1 What the live book looks like

12 loans carry conditions — the delegated files we underwrote ourselves — holding **348
conditions**, 5 to 67 per loan, **213 still open**. Most long-term files are underwritten by
the investor rather than in Encompass, which is why the number is small. Those 12 files are
exactly what a condition centre has to handle, and they are enough to build against.

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

### 6.1 Read-only first, and that is not a compromise

Everything about a lock can be **read**: `GET /v1/loans/{id}/ratelockrequests` (the full
request history), `.../{lockId}?view=detailed`, `.../{lockId}/snapshot`, the loan rollup
`rateLock.rateStatus` (`notLocked | locked | expired | cancelled`), and the whole
`LOCKRATE.*` family — 17 fields including `RATESTATUS`, `CURRENTSTATUS` and
`REQUESTPENDING`, which return the entire lock posture in one call.

So the lock desk gets built in full — the data model, the pipeline column, the workspace
section, the expiry countdown, the history, the alerts — and it is **read-only against
Encompass**. Requesting, confirming, extending, re-locking and cancelling are all writes and
all stay off until the owner authorises a specific endpoint in writing.

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

### Phase 1 — The people map
`lt_encompass_users`, `lt_staff_links`, `lt_loan_contacts`; the roster pull; the email
auto-match; the admin confirm screen. **Ends with:** an admin can see every Encompass user,
confirm who they are in PILOT, and the mapping is ready for everything downstream.

### Phase 2 — Bring the loans in
The sync: pipeline discovery, then a full per-loan read for anything a decision depends on.
Writes `lt_loans` and its sections, `lt_loan_contacts`, milestones. Records
`encompass_synced_at` so freshness is always visible. **No writes to Encompass.**
**Ends with:** real long-term loans in our database, refreshing on a cadence.

> **The pipeline is for discovery only.** It reads the Reporting Database, which lags loan
> saves, exposes only the fields an admin provisioned, and returns several computed `CX.*`
> fields as null that the full loan read populates. Never populate a decision-bearing
> snapshot from a pipeline row.

### Phase 3 — The pipeline and the switch
`app-v2/src/longterm/**` comes into existence: the shell, the product switch, the pipeline
table, filters, saved views, scope. **Ends with:** an officer signs in, flips to Long-Term,
and sees their own long-term book.

### Phase 4 — The loan workspace
The three-region layout, the URLA-sectioned read-only file, the Summary rail, the Contacts
section, the milestone stepper. **Ends with:** a real file on our own screen — which is what
surfaces the gaps in the model before anything depends on them.

### Phase 5 — The Condition Center (read)
The five tables, the sync, the grouped screen, per-condition documents, the submission log.
**Ends with:** every condition on every long-term file, with its documents, in one place.

### Phase 6 — Settings
`lt_settings`, both screens, and the pass that moves every value this plan named as a
setting out of code and into it. **Ends with:** the sellable rule stops being a comment and
starts being a feature.

### Phase 7 — Locks and pricing (read)
`lt_locks`, `lt_lock_events`, the lock section and the pipeline column. **Ends with:** the
lock posture of every loan, visible and current, ready for the lock desk build.

### Phase 8 — Editing, and the eFolder write **(blocked)**
Our own fields become editable. The eFolder upload ships **only** once its contract is
verified and the pad entry is completed.

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

**What this plan needs and does NOT have — the owner's word is required before the code:**

1. **The front-end mount seam.** The back end has a sanctioned seam (`src/server.js` mounts
   the LT router). The front end has no equivalent: something has to route to
   `app-v2/src/longterm/**` and render the switch, and that means touching `App.jsx` and the
   shell — RTL files. The separation gate does not scan front-end files for this, but rule 5
   ("do not touch RTL to build LT") is a judgement rule, and the honest thing is to record it.
   The owner asked for the switch by name, so this is recording an existing instruction, not
   seeking a new one.

2. **Nothing from RTL's condition machinery.** Not `checklist_templates`, not
   `checklist_items`, not `src/lib/conditions/**`, not the rules engine, not the document or
   eFolder code. The LT condition centre is a brand-new build. This is stated here so nobody
   later mistakes silence for permission.

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

Recorded rather than guessed at. The first three block work in this plan.

1. **Do long-term files use the Encompass milestones as their pipeline stages, or our own
   status set?** This plan assumes **the Encompass 19 as-is**, because they already carry
   TPO-facing and borrower-facing wording, and it makes the stage list a setting so the
   answer can change without a migration. *(Charter open question 7.)*
2. **Who may see the long-term side** — the whole team, or named people? *(Charter open
   question 8.)*
3. **Is there a TPO / broker portal on the long-term side at all**, or is the client a
   borrower only? The audience model already assumes both exist, and the investor-name rule
   is stricter for brokers than the RTL equivalent.
4. **ICE entitlement.** Client id `z1xx73r` lacks the `encompass_admin` scope — the token
   endpoint refuses it. That is why 68 endpoints answer 403, including the loan-folder list,
   milestone logs, the v3 associates roster and **69 of the 91 Milestone Completion rules**.
   Asking ICE to add the scope to the client registration unblocks all of it. This is the
   **client registration**, not the persona.
5. **Is there a sandbox instance?** Today every read runs against production, which carries
   real borrower PII. This matters before anything writes.
6. **The ten files** carrying a 12- or 24-month interest-only period on the plain 30-year
   program — real short-I/O deals, or values left behind from a file that started as a bridge?
7. **The loan doc type stores `DSCR` on 486 files**, which is not a valid code — and the
   tenant's base Milestone Completion rule is conditioned on Doc Type = "No Documentation",
   so those files never switch those requirements on.
8. **Do long-term files appear in the RTL dashboards and KPIs**, or are the two books counted
   separately?

---

## 12. The honest risks

- **The eFolder write may not be confirmable from the outside.** If the request shapes cannot
  be verified against the live tenant, uploading documents into Encompass stays blocked and
  the condition centre stays read-only. That is a real limit on the owner's stated ask, and it
  is better named now than discovered in phase 5.
- **The 403s are a real ceiling.** Until the client registration gains `encompass_admin`, we
  cannot read the loan-folder list, the milestone logs, or most of the completion rules — and
  custom dropdown option sets are inferred floors, not the real lists.
- **Conditions are thin on this book.** 12 of 490 long-term loans carry them, because the
  investor underwrites most files. A condition centre built only against Encompass conditions
  will be quiet on most files. Whether PILOT should also carry *its own* long-term conditions
  is a product question the owner has not been asked.
- **The appraisal XML is unrecoverable for historical files.** The download URLs are minted at
  delivery with a ~15-minute life; all 298 historical ones are expired. The durable fix is to
  have the vendor deliver the XML to us directly.
- **Two sources of truth for assignments** is a cost the override rule accepts deliberately.
  It is manageable only because divergence is displayed rather than hidden.
