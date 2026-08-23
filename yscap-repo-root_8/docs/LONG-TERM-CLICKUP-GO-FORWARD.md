# Long-Term → ClickUp, going forward

**Status:** plan, for the owner's decisions. Nothing here is built yet.
**The goal, in the owner's words (2026-08-23):** *"nobody should create files anymore
in ClickUp. Any existing active files in ClickUp should be linked with Encompass
files… Encompass is going to take control of the milestones… ClickUp will be changed
automatically… This is not going to be bi-directional. It's going to be writing to
ClickUp only."*

---

## 1. Where the book actually stands

Measured on the live workspace, 2026-08-23, after the owner's own ClickUp cleanup and
after PILOT filled 38 missing YS loan numbers.

| | count |
|---|---|
| Long-Term Encompass files | 480 |
| …of which are **working** (folder Pipeline / Started / Prospect / Pre-Approval / Corr CTC / On Hold) | **102** |
| …finished (Corr Post Purchase / Post Closing / Broker CLOSED / CLOSED RECONCILED) | 282 |
| …withdrawn or trashed | 96 |
| Long-Term ClickUp cards | 458 |
| …of which are **open** | 56 |
| Properties (address blocks) covering both sides | 484 |
| …finished on both sides — no review needed | 377 |
| …already fully paired | 46 |
| File-to-card pairs established | 382 |
| **Properties still needing a person** | **48** |

The 48 break down as: 26 files still working whose card was parked or cancelled;
9 files past Started with no card at all; 9 open cards with no Encompass file;
4 with no usable address.

**The one-time link job is nearly done.** That matters because everything below
depends on it: switching creation on before the book is linked is precisely how the
duplicate-ClickUp problem happens.

---

## 2. The shape: one direction only

```
Encompass  ──(read)──►  PILOT  ──(write)──►  ClickUp
   ▲                      │
   │                      └── holds the LINK (lt_loans.clickup_task_id, db/618)
officers type here
```

- **Encompass is the only place anyone types.** Already true in the code:
  Encompass is read-only to us except flood ordering (`CLAUDE.md`).
- **PILOT is the mirror and the memory.** It holds which card belongs to which file,
  and that link is what makes the write idempotent.
- **ClickUp is written, never read as truth.** No inbound field sync, no echo
  suppression needed, no conflict resolution — the whole class of bugs the RTL side
  had to solve twice does not exist here, *because* it is one-way.

This is a real simplification over RTL and it should be kept: the moment anything
reads a ClickUp value back into PILOT as authoritative, the two-way problems return.

---

## 3. What we inherit from the RTL side, and must not re-learn

The RTL ClickUp integration cost two incidents and roughly 7,500 lines. Every guard
below already exists in `src/clickup/*` and each one is there because something went
wrong. The Long-Term writer must carry the same behaviour. Product separation means
LT gets its **own copy under `src/longterm/clickup/`**, with a written entry in
`docs/LONG-TERM-AUTHORIZED-COPIES.md` per item, **before** the code — not an import.

### 3.1 The date rule (`docs/CLICKUP-DATE-INCIDENT.md`)

ClickUp stores dates as epoch ms and renders them in **each viewer's** timezone. Its
own UI pins a date with no time to **4:00 AM in the setter's timezone**. The portal
once wrote UTC midnight — 7–8 PM the previous evening in New York — so **every date
it ever pushed displayed one day early to the whole team.**

- Write through `dateOnlyToClickUpEpoch()` (4 AM `America/New_York`), never a
  hand-rolled epoch.
- Keep the **round-trip assertion**: refuse to emit an epoch our own pull would read
  back as a different calendar day.
- An epoch at exactly 00:00Z is a fingerprint of a machine write — a human cannot
  produce one through ClickUp's UI. Useful for auditing.

### 3.2 The chokepoint guards (`src/clickup/client.js`)

Every call funnels through one function so no future refactor can slip past them:

| guard | what it refuses |
|---|---|
| `guardNoTaskDeletion` | any DELETE on a task path, ever |
| `guardNoFieldClearing` | null / undefined / empty string / empty array, and any nested null, NaN, Infinity or undefined — `JSON.stringify` turns those into field-clearing nulls |
| `guardTaskUpdatePayload` | task updates are a **status-only allowlist** — the sync can never rename a task or touch a description |

The net effect is worth stating plainly: **the sync can change a ClickUp value; it is
physically unable to erase one.** Long-Term needs the same property.

### 3.3 The volume and overwrite guards (`src/clickup/orchestrator.js`)

- **Read before write, suppress no-ops.** Do not write a value that already matches.
- **Scoped pushes never create tasks.** A lost link cannot spawn a near-duplicate on
  the next edit. This is the single most important guard for the owner's stated fear.
- **Fail closed** when the pre-write read fails; let the queue retry.
- **Overwrite-storm alarm** — more than 10 rewrites of existing values in one push
  raises a loud audit row.
- **Volume circuit breaker** — more than `CLICKUP_MAX_FIELD_WRITES_10MIN` (default
  300) writes in a rolling ten minutes and every further push throws. A runaway loop
  stops hard instead of rewriting the workspace.
- **Journal every write** (`clickup_write_log`: before **and** after, sensitive values
  masked), so any question about "what changed this field" has an answer.

### 3.4 The dropdown asymmetry (`src/clickup/transforms.js`)

**Reads return the option's `orderindex` INTEGER; writes take the option UUID.**
This already bit this project once: the reconciliation read `*Program` as `0` and `3`
instead of labels and silently classified 216 Fix & Flip files as long-term. Resolve
labels through the live option list at runtime — never cache a UUID in code, so an
option added in ClickUp tomorrow is picked up instead of breaking the map.

### 3.5 The switch

Everything behind one runtime switch (RTL: `CLICKUP_SYNC_ENABLED`), off by default,
flippable without a deploy. LT already has `LT_CLICKUP_STAMP_ENABLED` in this shape.

---

## 4. ⚠️ The email automations — needs an answer before anything is switched on

Five live ClickUp statuses carry an automation marker in their own names:

```
active / fill clickup(1-em)     non del imported ba(2-em)
ctc (4-email)                   closed (6-email funded)
```

That numbering pattern almost always means **a ClickUp automation sends an email when
a task enters that status.** If PILOT starts driving statuses from Encompass
milestones, then a routine milestone change in Encompass could fire real email to a
borrower, a broker or an investor — potentially hundreds at once on the first sweep
across 458 cards.

**This is the highest-risk item in the whole plan and it is cheap to defuse:**

1. Owner or ClickUp admin confirms which automations exist on those statuses.
2. Pause those automations for the first run.
3. First status sweep runs in **dry-run** (see §7), producing a list of every status
   that *would* change, with no write.
4. Automations come back on only once that list has been read.

Nothing here should go live until this is answered.

---

## 5. Milestone mapping — proposed, for the owner to correct

Encompass has 19 milestones (verified against the live instance 2026-08-14,
`db/547`). PILOT already folds them into 9 stages (`src/longterm/stages.js`). The
third column is the proposal; it is a **guess about the business and needs the owner's
pen.**

| Encompass milestone | PILOT stage | → proposed ClickUp status |
|---|---|---|
| Started | new | `starting` |
| LO Prep | setup | `starting` |
| Loan Setup | setup | `assigned to processor` |
| Submittal | submitted | `file being worked` |
| Cond. Approval | underwriting | `in underwriting` |
| Processing | underwriting | `in underwriting` |
| Resubmittal | underwriting | `in underwriting` |
| Waiting for Docs | conditions_out | `waiting for docs` |
| Clear To Close | clear_to_close | `ctc (4-email)` ⚠️ |
| Schedule Closing | closing | `scheduling closing` |
| Ready for Docs | closing | `scheduling closing` |
| Docs Out | closing | `active closing` |
| Wire Order | closing | `active closing` |
| Funding | funded | `closed (6-email funded)` ⚠️ |
| Investor Delivery | post_closing | `in purchase review` |
| Purchasing Conditions | post_closing | `in purchase review` |
| Final Docs | post_closing | `waiting for final docs` |
| Closed | post_closing | `closed reconciled` |
| Completion | post_closing | `closed reconciled` |

**Folder overrides beat the milestone**, because a withdrawn file often keeps a late
milestone forever:

| Encompass folder | → ClickUp status |
|---|---|
| Withdrawn files | `cancelled` |
| (Trash) | `trash` |
| On Hold | `inactive / on hold` |

Statuses **not** driven by Encompass, left for humans: `prospect / pricing`,
`self procesing`, `workflow`, `declined`, `cancelled & reconciled`,
`pa issued-post closing.`

An unmapped milestone must be **shown, never silently swallowed** — the same rule
`stages.js` already follows (`UNMAPPED_STAGE`, "shown, never hidden").

---

## 6. Field mapping — the frame, waiting on the owner's list

The owner has said the field list is coming. The frame it should drop into, with the
field ids already verified live:

| ClickUp field | id | type | source in Encompass/PILOT | notes |
|---|---|---|---|---|
| YS Cap Loan Number | `a6da91bc…2858` | short text | `lt_loans.loan_number` | already filled for all 357 linked cards |
| *Program | `50eb857a…1338` | **dropdown** | `lt_loans.program_name` | write the option **UUID**, resolve at runtime |
| Loan Amount | `e393e64a…4f28` | number/money | `lt_loans.loan_amount` | |
| Subject Address | `ef691991…3d61` | location | `lt_properties` | needs finite lat/lng or the write is refused |
| Portal File Id | `6bca11f0…7c8` | short text | `lt_loans.id` | the stamp; already built (`stamp.js`) |
| Portal File Link | `7b369ef5…8917` | url | PILOT file url | |

**Every field needs its type recorded before it is written**, because the type decides
the write shape: dropdown → option UUID; date → 4 AM NY epoch; money → number;
location → object with finite coordinates; text → string. This is the "every field has
a data type, our system should know it" requirement, and the RTL mapper
(`src/clickup/mapper.js` `writeValue`) is the shape to copy.

---

## 7. The cutover — and a better idea than a date

The owner proposed: *"Going forward from today's date, any new file in Encompass…"*
and asked for a better idea if there is one. **There is, and the difference matters.**

**A date cutover breaks on the cases we already found.** Take the 26 files that are
working in Encompass right now but whose ClickUp card is parked. If the rule is "new
after today gets a card", then the moment somebody touches one of those in Encompass
it looks new, and PILOT opens a **second** card — the exact duplicate the whole
exercise exists to prevent. A date is a proxy for "we have not seen this before", and
it is a bad one.

**Cut over on the link, not the calendar.** PILOT creates a ClickUp card only when
**all** of these hold:

1. the Encompass GUID has no `clickup_task_id` in `lt_loans`; **and**
2. no open ClickUp card exists at that property address (`sameAddress`, the same
   check that built this reconciliation); **and**
3. the file is past `Started`; **and**
4. the master switch is on.

Rule 2 is the safety net that makes the whole thing durable: even if a link is lost,
mis-stamped, or a file is re-opened years later, PILOT looks at the address first and
finds the existing card instead of making a new one. A date rule has no such backstop.

### Order of operations

| # | step | why this order |
|---|---|---|
| 1 | Owner closes out the 48 open properties | the link table must be complete first |
| 2 | Stamp the 382 links into `lt_loans` **and** onto the cards | after this, PILOT knows every existing card |
| 3 | Answer the email-automation question (§4) | before any status is written |
| 4 | Turn on **status writing only**, in dry-run | see what would change, write nothing |
| 5 | Read the dry-run, then let status writing go live | |
| 6 | Turn on **field writing**, dry-run then live | fields are lower risk than statuses |
| 7 | Turn on **card creation** last | nothing creates until everything links |

**Creation goes last, deliberately.** Steps 1–6 are reversible; step 7 makes objects
in someone else's workspace.

### Where a new card gets created

`src/clickup/routing.js` already holds the officer → folder map with live folder ids
(Yehuda Bochner, Solomon Katz, Yosef Cohen, Moshe Mermelstein, Shia Kaff, Mendel
Schwimmer, Abraham Eisen, Joshua Freidlander, Esther Bochner…), plus a
`LEAD_CAPTURE` folder for "no officer yet". LT needs the same table — keyed on
`lt_loans.loan_officer_id → staff_users`, which is already linked by email.

### Refresh cadence

The Encompass pull already exists and logs each run (`db/616`). Suggest **every 15
minutes** for working files and hourly for the rest: often enough that ClickUp is
never meaningfully stale, rare enough to stay far under the circuit breaker.
Push on change, not on a full sweep — the RTL lesson is **scoped enqueue-on-write,
never a dirty sweep** (`src/clickup/enqueue.js`).

---

## 8. Open questions for the owner

1. **"DAT tasks."** Searched the whole workspace — there is no list, folder, tag,
   status or task type called DAT. What are they? They are meant to get a
   "pre-existing, do not link" stamp.
2. **The email automations (§4).** Which statuses actually send mail?
3. **The milestone mapping (§5).** Corrections to the third column.
4. **The field list (§6).** Which fields keep updating, and which are set once at
   creation.
5. **The 26 parked-card files.** Withdraw them in Encompass, or re-open the cards?
6. Any ClickUp status PILOT should **never** set, beyond the ones already excluded.

---

## 9. What exists today, and what does not

**Built and merged:** `db/618` link columns and log · `src/longterm/clickup/stamp.js`
(the one write, path-asserted to two field ids, off by default) ·
`src/longterm/clickup/client.js` (read-only) · `book-diag.js` (read-only,
token-gated) · the reconciliation engine, off-PILOT.

**Not built:** anything that calls `stamp.js` · any route or screen that writes a link
into `lt_loans` · the status writer · the field writer · the card creator · the LT
copy of the RTL guards · the officer routing table for LT.

**The immediate gap:** the 382 pairs are computed and confirmed but live only in a
spreadsheet. Until a staff-authenticated screen in PILOT can apply them, the link
exists on paper and not in the system. That screen is the next thing to build.
