# The long-term LOS — how we are going to build it

**Status: the research is finished and the foundation is laid. This document is the
STRUCTURE, written before the next line of code, so it can be compared against the
LOS the owner wants to copy and changed on paper rather than in a rewrite.**

The owner's instruction on 2026-08-14: *"let's start building a mega mega mega LOS
from ground up with the right perspective. Everything ground up from the PRISMA
schema. It should be set up like a standard LOS."*

Read `README.md` in this folder first — it is the index to all the research this plan
rests on. Then `LOS-VISION-AIM-PORTAL.md` — the portal the owner wants this to FEEL
like, saved in his own words. That document is direction, not a specification: **every
section of it needs his confirmation before it is built.**

**And before any screen: `AUDIENCE-RULES.md`.** The investor's name never reaches a
borrower or a broker — a hard rule, with code and a test behind it. It outranks every
layout idea in the vision document.

---

## 1. The one decision everything else follows from

**The spine is the URLA / Form 1003 (MISMO 3.4 ULAD) section numbering.**

Not because a DSCR loan is a 1003 — it is not — but because that shape is what every
LOS, every investor, every closing package and every GSE dataset already speaks. Using
it means our data is portable to an investor the day they ask for it, instead of being
a private structure that has to be translated first.

```
  1a        Personal information ............ lt_parties
  1b–1d     Employment ...................... lt_employments      OFF for DSCR
  1e        Other income .................... lt_other_incomes
  2a/2b     Assets .......................... lt_assets
  2c/2d     Liabilities ..................... lt_liabilities
  3a        Property you own (REO) .......... lt_reo_properties
  4a        Loan and property ............... lt_loans + lt_properties
  4b/4c     Rental income ................... lt_properties.gross_monthly_rent
  5a/5b     Declarations .................... lt_declarations
  6         Acknowledgements ................ (not yet built)
```

**Where we deliberately depart from a standard 1003**, and why:

| Standard LOS | Ours | Why |
|---|---|---|
| Employment is central | **Off by default** | A DSCR loan qualifies on the property's rent, not the borrower's job. `URLA.X199` ("employment does not apply") is true on **98%** of the live long-term book. `lt_loans.employment_applies` decides whether the section exists at all — it is **not** a greyed-out 1003 |
| Borrower + co-borrower are two columns | **A list of pairs** | 737 files have one pair, 31 have two, 4 have three — and the tenant is configured for **six** (`CX.PAIR1..6`). Fixed columns hit a wall the day a fourth arrives |
| The borrower is a person | **A person or an entity** | On a DSCR file title is usually vested in an LLC with a natural person guaranteeing. `party_type` is a first-class field, not an assumption |
| REO is a formality | **Load-bearing** | Investor experience is counted from the REO schedule, and experience decides leverage |
| Income drives the file | **The property does** | Rent ÷ housing expense is the whole product |

---

## 2. What is built and working today

| Piece | Where | State |
|---|---|---|
| Encompass integration, read-only | `src/longterm/encompass/client.js` | **Live.** Structurally cannot write; proven by a CI gate |
| The 3,783-field census | `encompass/field-intelligence.js` + `dictionary/` | **Complete**, PII-scrubbed |
| Loan anatomy, terms, PITI, DSCR | `encompass/loan-anatomy.js`, `terms.js`, `formulas.js` | **Complete**, verified against every live loan |
| Investors + dropdowns | `encompass/investors.js`, `dropdowns.js` | **Complete** — 117 spellings → 33 companies; 1,006 dropdowns |
| Conditions + eFolder knowledge | `encompass/conditions.js` | **Complete** — the model is understood; nothing built on it yet |
| Milestone catalog | `db/547`, `lib/encompass-milestones.js` | **Live** — 19 milestones with their TPO and borrower wording |
| **The loan application data model** | `prisma/schema.prisma`, `db/549` | **Live** — 12 tables, 11 enums, proven against a real Postgres |
| Settings layer | `settings/encompass-settings.js` | **Live** — 44 settings, 10 groups |
| Read-only knowledge API | `routes/encompass-knowledge.js` | **Live** — 17 endpoints |

**Not built, on purpose:** any screen, any write to Encompass, any sync that moves a
loan into `lt_loans`, the condition centre, ClickUp mapping.

---

## 3. How the data model reaches the database

Prisma is the **schema tool**, not a runtime dependency:

```
  src/longterm/prisma/schema.prisma      ← the single source of truth for the model
            ↓  prisma migrate diff --from-empty
  db/NNN_lt_*.sql                        ← made idempotent by hand, applied on boot
            ↓
  src/longterm/db.js                     ← the app reads through plain `pg`
```

This keeps one migration system, keeps the separation gate effective over LT schema,
and keeps the off-site backup covering LT with no table list to maintain. **The
generated Prisma client is never committed and never used at runtime.**

**Rule: a model in the schema and a migration for it land in the same commit.** A
model with no migration is a lie about what exists.

---

## 4. The separation rules this must be built inside

Not negotiable, and the CI gate blocks a violation:

- LT back-end code lives only in `src/longterm/**`, front-end only in
  `app-v2/src/longterm/**`, HTTP only under `/api/lt/*`, tables only `lt_*`,
  migrations only `db/NNN_lt_*.sql`, tests only `scripts/test-lt-*.js`.
- **Nothing may be copied, re-used, imported, extended or generalised from RTL**
  without the owner's written authorisation recorded in
  `docs/LONG-TERM-AUTHORIZED-COPIES.md` *before the first line is written*. Wanting to
  re-use something is normal — ask, get it in writing, record it, then build.
- The only crossings authorised today: the shared login, the shared `borrowers`
  person record (**read-only to LT**), the `staff_users` roster, the shared borrower
  editor, `borrower_officers`, and the Encompass integration itself.
- **Encompass stays one-way.** Reading is free; a write needs an entry on
  `docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md` and is blocked by CI until it has one.

---

## 5. The rule that shapes every screen and every default

**The system has to be sellable and re-customisable.** The owner: *"everything that
I'm telling you to build, which is customizable to us, should be in the settings
pre-filled customizable for us, but everything should be able to be changed so we can
sell the system eventually and customize it according to someone else's needs."*

In practice:

- No YS Capital number, threshold, label, program name, investor or document type is
  ever a constant in code or a column default. It is a **setting**, pre-filled with our
  value.
- Enums in the database are kept deliberately few, and only for things that are true
  of the *domain* rather than of *us* — a party is a borrower or a co-borrower
  everywhere in the world. A program name, an investor, a condition category and a
  document type are all **text plus a settings-driven list**, because an enum is a
  migration every time a buyer wants a different word.
- Anything measured from *our* tenant (fill rates, the 12-vs-120 interest-only
  question, the investor spellings) is research about **our** data and must never
  become a rule another lender inherits.

### The other hard rule that shapes every screen

**The investor's name never reaches a client.** Owner-directed 2026-08-14: *"The client
should not be able to see the investor name. Never ever! Not borrowers, not TPOs, only
internal staff."*

That is not a display preference — it decides what a payload may even contain. Three
audiences, one of which may see it (`internal`), and it **fails closed**: anything not
exactly internal is a client. `src/longterm/audience.js` is the one definition, built on
the investor registry because the name is spelled 151 ways;
`scripts/test-lt-investor-block.js` sweeps every recorded spelling and fails if one
survives. Full reasoning: `AUDIENCE-RULES.md`.

**Where this bites first:** the vision document's persistent Summary panel. AIM shows
its user the counterparty context freely, because their user *is* the broker talking to
*them*. Ours is not that shape — our Summary panel shows the investor to internal staff
and never to a client, and the same is true of every condition body, comment, document
name and email we put in front of one.

---

## 6. What comes next, in order

Each phase is independently useful and independently reviewable. Nothing here is
built yet.

### Phase 1 — Bring a loan in (read-only)
Mirror a long-term file out of Encompass into `lt_loans` and its sections. Encompass
stays the source of truth; our copy records `encompass_synced_at` so its freshness is
always visible. Needs: a sync module, a per-file pull, a sensible refresh cadence.
**No writes.** This is what makes every later phase real rather than theoretical.

### Phase 2 — Show the file
The loan screen, laid out in the URLA sections above, with employment hidden on a
DSCR file. Read-only first: seeing a real file on our own screen is what surfaces the
gaps in the model before anything depends on them.

### Phase 3 — The condition centre
Designed in §7 below. Read side first; the eFolder upload waits on §8.

### Phase 4 — Editing, and the settings screen
Our own fields become editable, with the settings screen that makes the whole thing
re-customisable. This is the point at which the sold-and-recustomised rule stops being
a comment and starts being a feature.

### Phase 5 — ClickUp mapping
Encompass is the source, our system is the bridge and the workflow, ClickUp receives.
The dropdown catalogue and the investor resolver exist precisely so this can be a
mapping rather than a guess. **Rule: map on a canonical key, never on a display
string.**

---

## 7. The condition centre — the structure

**Owner-directed 2026-08-14, which reopened a rule that had put conditions out of
scope.** Recorded in CLAUDE.md rule 6, the charter, and the ledger.

### What the live book actually looks like

**12 loans carry conditions** — the delegated files we underwrote ourselves — holding
**348 conditions** between them, 5 to 67 per loan, **213 still open**. Conditions are
rare here because most long-term files are underwritten by the investor rather than in
Encompass. **Those 12 files are exactly what a condition centre has to handle**, and
they are enough to build against.

| Split | |
|---|---|
| By type | Underwriting 333, Closing 14, Preliminary 1 |
| By status | Added 195, Cleared 124, Fulfilled 12, Waived 11, Rejected 4, Received 1, Requested 1 |
| By category | Miscellaneous 128, Property 91, Credit 84, Legal 15, Assets 13, Income 6 |
| By gate | Docs 207, Funding 102, Approval 34, Submittal 3 |

The eFolder alongside them: **20,569 documents across 673 loans, 28,822 attachments,
179 document→condition links, 230 configured document types.**

### The four things the model has to get right

1. **Encompass is the source of truth; ours is a mirror.** Every row keyed on
   Encompass's own GUID, every row carrying `encompass_synced_at`. Nothing authored
   by us, nothing written back.
2. **A document is not a file.** The eFolder DOCUMENT is the slot ("Appraisal"); the
   ATTACHMENT is the paper. One document holds many attachments.
3. **The link runs document → condition, and only that way.** In Encompass the
   document carries `conditions[]`; there is **no** condition→documents endpoint. So
   "show me the documents that satisfy this condition" must be built by reading the
   documents and **inverting** the mapping — which is why the link is its own
   many-to-many table rather than a column.
4. **`status_open` is mirrored, never derived.** Encompass computes whether a
   condition is still outstanding. Deriving our own answer from the status word would
   let our screen disagree with theirs.

### The planned tables

| Table | Holds |
|---|---|
| `lt_conditions` | One row per condition. Type, title, **both** descriptions (internal for staff, external for the borrower), category, the gate it blocks, status, `status_open`, source, owner, SLA, and Encompass's soft-delete flag |
| `lt_condition_comments` | The back-and-forth about what is still needed. Fetched separately per condition |
| `lt_documents` | The eFolder slot: title, which borrower pair, the milestone it is expected at, status, and who is allowed to see it |
| `lt_document_attachments` | **Metadata only, never the bytes.** The paper stays in Encompass; we keep the URI |
| `lt_document_conditions` | The inversion — many-to-many, so one document can satisfy several conditions and one condition can be satisfied by several documents |

**Two things deliberately absent.** There is no upload queue and no write path,
because the eFolder write shape is unverified (§8) — building a queue before the shape
is confirmed would be guessing at a write. And a removed condition is **mirrored and
then filtered on read**, never deleted, so the record of what was once asked for
survives.

### The endpoints that work

```
GET /encompass/v3/loans/{id}/conditions                        ← the one that works
GET /encompass/v3/loans/{id}/conditions/{cid}/comments
GET /encompass/v3/loans/{id}/documents                          ← carries conditions[]
GET /encompass/v3/loans/{id}/attachments
GET /encompass/v3/settings/loan/conditions/{types,templates,sets}
```

**And the trap, written down so nobody loses a day to it again:** four v1 routes
(`conditions/underwriting`, `conditions/preliminary`, `conditions/postclosing`,
`underwritingConditions`) return **`200 []`** on files that plainly have conditions.
They answer for the legacy condition system this tenant does not use. **An empty 200
is not proof of absence.**

---

## 8. The one blocked thing, and exactly what unblocks it

The owner asked for documents to be uploaded in our system and pushed into the
Encompass eFolder against a condition. That is a **write**, and it is the only write
anyone has asked for on the long-term side.

- It is **authorised in principle** by the owner (2026-08-14) and recorded on
  `docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md`.
- It is **not implemented**, because that entry records the request and response shape
  as **UNVERIFIED**. The read-only CI gate lists no long-term writer, so it is blocked
  in code as well as on paper.

**To unblock it:** confirm the eFolder attachment-upload contract against the live
tenant (the endpoint, the body, the two-step URL-then-bytes flow if there is one, and
how an attachment is bound to a condition), write it into the pad entry, then build a
single guarded writer that the gate can name. Until then the condition centre is
read-only, which loses nothing — the read side is the larger half and everything else
depends on it.

---

## 9. Questions only the owner can answer

Recorded here rather than guessed at.

1. ~~**The 20-year term.**~~ **ANSWERED 2026-08-14: it was a typo, and there is no
   20-year product.** *"When I say 20-year term, it means usually 30-year term, 10-year
   interest-only, and then a 20-year mortgage."* So "20-year" names the **amortising
   tail** of the 30-year / 10-year-I/O structure (`amortizingMonths = 240`). Do not
   build one.
2. **The ten files with a 12- or 24-month interest-only period** on the plain 30-year
   program. Real short-I/O deals, or values left behind from a file that started as a
   bridge?
3. ~~**The investor loan number.**~~ **ANSWERED 2026-08-14: `VEND.X276`, confirmed by
   the owner** — which is what the code already keys on. (`VEND.X267` holds ZIP codes.)
   Measurement and the owner agree; settled.
4. ~~**`CX.PITIA`**~~ **ANSWERED 2026-08-14.** The finding was challenged, re-tested
   four ways and held: its formula adds the purchase price and cash-to-close into a
   monthly payment, so **0 of 451** long-term files land within 2% of the real housing
   expense. **The owner chose the fix: `CX.PITIA = Sum([#912])`** — point it at the
   total that already exists, which is also the DSCR's own denominator, so the two can
   never drift. Right on 100% of files that have a 912; blank rather than wrong on the
   rest. Still to be applied in Encompass; nothing we build reads it either way. Full
   evidence: `ENCOMPASS-TERMS-AND-PITI.md` §6.
5. **The loan doc type** stores `DSCR` on 486 files, which is not a valid code — and
   the tenant's base Milestone Completion rule is conditioned on Doc Type = "No
   Documentation", so those files never switch those requirements on.
6. **ICE entitlement.** Client ID `z1xx73r` needs the `encompass_admin` scope to read
   69 milestone-completion rules, the loan programs and the milestone logs. Today they
   return 403 — this is the **client registration**, not the persona.
7. **Long-term statuses** — do we use the Encompass milestones as they are, or our own?
8. **Who may see the long-term side** — the whole team, or named people?

---

## 10. For whoever compares this against the LOS we want to copy

The useful questions to bring back, in rough order of how much they change:

- **What sections does it have that §1 does not**, and is each one a real section or a
  view of data we already hold?
- **What does its main loan screen show first?** The ordering is the product decision;
  the fields are the easy part.
- **How does it handle the borrower being an entity** — as a first-class party type,
  or bolted on?
- **What does its condition centre look like** — how a condition is grouped, what a
  document attached to one looks like, and how "what is still outstanding" is
  answered at a glance.
- **What is configurable in it and what is hard-coded?** That tells us where the
  sold-and-recustomised line actually has to fall.
- **What does it do that we have no data for?** That is the list that turns into
  questions for Encompass or new fields of our own.

---

## 18. What I take from the portal the owner loves, and what I would change

`LOS-VISION-AIM-PORTAL.md` is the reference. This is my read of it — **opinion, to be
confirmed section by section**, not a decision already taken.

### Take, without argument

- **One shell, one nested loan workspace.** Depth belongs inside the content area, never
  in more top-level chrome.
- **The three-region loan record**: milestone stepper on top, rules-driven section menu
  on the left, a persistent Summary rail on the right that does not re-render as you
  move between sections.
- **The five habits in §15** — show where you are; show what matters without a click;
  show the full menu and grey out what is not yet possible; **explain** unavailability
  rather than leaving a dead end; default to outstanding work before everything. That
  list is information architecture, not decoration, and it is the whole reason the
  portal feels good.
- **Conditions as individual upload targets.** Each condition is its own micro-upload
  destination, so a user attaches exactly the right document to exactly the right
  requirement instead of dumping everything into one folder. This is the single most
  important interaction in the product and our condition-centre design already assumes
  it.
- **A submission event log distinct from condition status** — uploaded-but-not-submitted,
  submitted-but-not-reviewed, reviewed-and-satisfied are three different states.
  Encompass models it the same way (`Last Submitted` / `Last Reviewed`).
- **Inactive loans stay in the one pipeline table**, distinguished by a status column
  rather than exiled to an archive screen.
- **One date model, two renderers** (list and calendar).
- **Disabled-with-a-required-tooltip as a first-class component variant**, not an
  afterthought.

### Already solved differently, and better, in our data model

| Their pattern | Ours |
|---|---|
| Fields re-asked between Loan Information and Products & Pricing | Property and Loan Terms are single entities (`lt_properties`, `lt_loans`) — the vision document calls their duplication out as a genuine weakness, and we already avoided it |
| Sidebar hides Employment for DSCR | `lt_loans.employment_applies` defaults **false**; the section does not exist rather than being greyed out |
| Multi-borrower via a borrower-type dropdown | `lt_borrower_pairs` is a list, and the tenant is configured for six |
| Assets / Liabilities / REO as three bespoke forms | Three tables of the same shape — one list-and-detail component serves all three |

### Where I would deliberately differ

- **The investor never appears in our Summary panel for a client.** Theirs can be freer
  because their user is the broker; ours cannot. See the hard rule in §5.
- **Gamification (tiers, points, badges) stays out of the loan workspace**, exactly as
  they kept CRM and the learning centre in separate apps. It is a distraction next to a
  file someone is trying to close.
- **"Approved With Conditions" is a real state**, not a flavour of approved — worth
  modelling explicitly if we build the exception queue.
- **Their auto-split of one combined PDF into individual documents** is genuinely clever
  and worth adopting, but it is a document-processing feature and belongs after the
  condition centre reads cleanly.

### The questions the vision document raises for the owner

1. Do we want a **TPO/broker portal at all** on long-term, or is the client a borrower
   only? The whole audience model changes shape depending on the answer, and the
   investor-name rule already assumes both exist.
2. Which of their **top-level sections** do we actually want — Rate Lock, Quick Pricer,
   Concierge, Learning Center — and which are out of scope for a first build?
3. Their sidebar grows for a funded loan (Initial CD Progress, Fees, Disclosures
   Tracking). **Do we need the post-closing half at all**, given Encompass is the system
   of record for it?
4. What belongs in **our** Summary panel? Theirs is ~25 fields. We have every one of
   them, and adding the DSCR and the rent would make ours more useful than theirs — but
   it is a decision, not a default.