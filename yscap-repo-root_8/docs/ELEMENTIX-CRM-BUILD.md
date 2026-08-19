# The Elementix CRM plane — what was built, and why each piece is shaped the way it is

**Scope: RTL only.** `leads` (db/008) is an RTL table and everything here sits on it. Nothing
below touches Long-Term. Design that preceded this: `docs/ELEMENTIX-CRM-PLAN.md`; the measured
behaviour of the connector: `docs/ELEMENTIX-RESEARCH.md` and `docs/research/elementix/*`.

Migrations: `db/585_elementix_crm_and_person_profiles.sql`, `db/586_elementix_unlocked_by_email_attribution.sql`.

---

## 1. Two planes, two doors, one transport

There are now **two** ways PILOT talks to Elementix, and they may never become one:

| | UNDERWRITING | CRM |
|---|---|---|
| module | `src/lib/elementix/lookups.js` | `src/lib/elementix/crm-tools.js` |
| question | does this borrower's claimed track record exist in the recorded deeds? | who is this person and what is their telephone number? |
| answer may reach | a lending decision | an officer's telephone |
| paid tool | **absent from the allowlist, permanently** | `submit_contact_enrichment`, gated |
| HTTP door | (internal library) | `/api/elementix` |

`lookups.js` was **not modified** by any of this work. The separation is structural — two closed
tool sets behind two doors — rather than a convention somebody has to remember, which is what
`docs/research/elementix/04-connector-verification.md` requires: *"a contact detail may not appear
in an underwriting decision."*

**What the two planes DO share** is deliberate: the transport (`src/elementix/client.js` — the rate
bucket, the money cap, the call ledger, the never-throws contract) and the request PREFLIGHT
(`lookups._internals.contractProblem`, reading the transcribed schemas in
`src/lib/elementix/request-contracts.json`). A malformed request is answered with a raw `-32602`
**and still spends a slot of the office's shared 1,000/hour**, so both planes must refuse the same
malformed call.

## 2. One connection, not one per officer

The owner's correction, in their own words: *"every user should never need to auth again on their
own — the super admin auth that exists already should lead the integration for everybody."*

So `ELEMENTIX_SEAT_MODEL` defaults to `company`: every call goes out on the one connection an admin
approved. `src/elementix/oauth.js` still supports a per-officer seat (`officer`) because the code
was written for it first, but nothing turns it on.

**The consequence is the single most important thing to remember about this plane:** Elementix
stamps every unlock with the **email of the login that made it**, and under a shared connection
that is ONE email for the whole company. So the vendor's `unlockedBy` identifies a **seat**, not a
**person**. See §5.

## 3. What the catalogue does not say it does

The vendor publishes 40 tools and none is called "list our users" or "list our unlocks". The first
reading of that catalogue concluded the history could not be pulled and the owner would need a CSV
export. The owner pushed back — *"dig in deeper, I'm 100% you can link who discovered the number by
email"* — and was right. Measured live on 2026-08-18:

* `get_contact_status` returns **`unlockedBy` (an email)** and **`unlockedAt`**. Its published
  description says it returns `{isUnlocked, isJobCompleted}`.
* `list_people` accepts `unlockStatus:'unlocked'` and puts that same email on **every row**. The
  entire history came back in two calls: **1,041 contacts, 13 distinct logins, not one row missing
  its email.**

**Lesson, kept in the code:** a tool's published description is a summary, not a schema. *"The
catalogue has no tool for X"* is a claim about the catalogue, not about the API — call the closest
tool and read what actually comes back. The captured envelope is
`scripts/fixtures/elementix-shapes.json → list_people_unlocked` (values redacted; the shape is what
a fixture is for).

## 4. The money, and the four things that guard it

`submit_contact_enrichment` is the **only** paid tool PILOT can reach. In order:

1. **A named officer and a typed reason.** `crm-tools.call` refuses the paid tool without
   `opts.paidActor = {staffId, personId, reason}`; the route additionally refuses a reason under
   four characters, because *"hm"* is not something anybody can read back a month later.
2. **We do not buy what we already own.** `crm.skipTrace` asks OUR OWN database first
   (`elementix_contacts` with a phone or an email on it) and short-circuits to the free path. This
   is asked before the vendor deliberately: `lookups.isUnlocked` fails CLOSED, which is right for
   showing a phone number and exactly backwards for spending money.
3. **We do not buy it twice at once.** A `pending` charged trace inside `PENDING_HOLD_HOURS` (48)
   answers *"that lookup is already running"* — worded differently for the officer who started it
   and for a colleague.
4. **The monthly cap, counted from the ledger**, and it fails CLOSED when the count cannot be read.
   The "can this call go out at all?" gates (`available` / `enabled` / shared-hour ceiling / dry
   run) sit **above** the paid block in `client.callTool`, so a refused call never records a spend.

A **dry run is a refusal, not an answer** (`{ok:false, reason:'dry_run'}`). Answering `{ok:true,
data:null}` would make `rowsOf` read "nobody by that name" and make `skipTrace` tell an officer
their contact is on its way while nothing was ever sent.

## 5. Attribution: PILOT's own record beats the vendor's seat

`src/lib/elementix/backfill.js` reads the whole unlocked history and hands each contact to the
officer whose login unlocked it. For work done in **Elementix's own screens** that email is the only
answer there is, and mapping it to an officer (`elementix_users`) is exactly right.

For a trace made **inside PILOT** it is exactly wrong: the unlock went out on the shared connection,
so the vendor hands it back wearing the shared login's email. Mapping that to an officer would give
**every** PILOT-originated unlock to one person — a second lead beside the correct one, in somebody
else's pipeline, with a notification telling them a contact is theirs.

So `backfill.pilotOwnerOf(personId)` asks PILOT's own record first (`elementix_contacts.unlocked_by`
where `source='pilot_skip_trace'`, else the `elementix_skip_traces` row) and, when PILOT already
completed the trace, the import **refreshes the detail and leaves the history alone** — it does not
mint a lead and does not rewrite the reason the officer typed or the record that a credit was spent.

`matchUsers` auto-links a login to a staff member only when they are **internal and active**: a
deactivated staffer would file every contact into a pipeline nobody reads.

## 6. Two loops, and only one of them is behind a switch

`src/sync/elementix-crm-sync.js`:

* **LIST + WORK** (the bulk import) are behind `ELEMENTIX_CRM_SYNC_ENABLED`, **off by default**.
  They create leads in people's pipelines out of work done in Elementix's own screens, which is a
  thing an owner switches on deliberately once the roster of logins has been mapped.
* **SETTLE** is **not** behind that switch. `crm.skipTrace` waits about six seconds for the vendor's
  enrichment job; a slower job is recorded `pending` **and the credit is already spent**. Without
  something to come back and finish it, the contact never arrives, no lead is made, nobody is
  notified, and the money is gone. `drainPendingSkipTraces` is that second half, it is FREE (status
  + info reads on a person already unlocked), and it gives up after 48 hours with the row marked
  failed rather than growing a queue forever.

Neither loop can spend a credit: `submit_contact_enrichment` is unreachable from `backfill.js`, and
the two `crm.js` functions the settle pass reaches cannot get to it either. Both facts are asserted
from the source in `scripts/test-elementix-backfill-db.js`.

## 7. The profile

`src/lib/elementix/profile.js` builds the mega profile — Overview, Entities, Properties, Mortgages,
Deeds, Foreclosures, Companies, Lender network — across every state the person appears in, cached
in `elementix_person_sections` and read by `readProfile` without ever calling the vendor.

Things that were measured rather than assumed, and that a rewrite must not undo:

* `get_person` answers `{person:{…}}` — **singular**.
* `get_person_lender_network` puts its rows under **`lenderConnections`**, a key `rowsOf` did not
  know: before that response was captured, seventy lenders read as zero.
* person deed `addresses` are **strings** while entity deed `addresses` are **objects**, and person
  mortgages carry `propertyAddresses` and no `addresses` key at all.
* `get_contact_info` returns the enrichment **job, two levels deep** (`job.result`). Our reader
  found nothing at all before that shape was captured.
* the page-size parameter is **`perPage`**; `limit` is ignored silently and the default page is 5.
* `nextPage` is emitted on any **full** page — it means "the page was full", never "there is more".
* `topLenders[]._logoDataUri` is 8–12 KB of base64 per lender per row; `stripHeavy` removes it
  before storing or one person's cache runs to megabytes.

**A section we never read, or that failed, is never rendered as a confident zero.** `status` is one
of `ok | partial | error | skipped | not_loaded | unavailable`, and only `ok`/`partial` earn a
number on the tab.

## 8. Compliance refusals built into the door

`FORBIDDEN_ARGS` refuses `gender` and `hasHispanicName` outright — the vendor offers them as
"inferred gender based on first name" and "surname is likely Hispanic/Spanish". Narrowing a
marketing list by an inferred protected characteristic is what ECOA and the Fair Housing Act exist
to prohibit, and PILOT is a lender. It is refused at the DOOR rather than merely not used, because
"we don't use it" is a property of today's callers. It **fails the request** rather than dropping
the argument, because a filter quietly removed makes a screen show results that do not match what it
asked for.

## 9. Who may use it

Any **internal** staff member — the owner's requirement is that every loan officer skip traces from
their own login, so gating this on a capability nobody holds by default would kill the feature for
exactly the people it is for. The controls on the money are the four in §4.

An **external** staff row is refused, first thing, by the router: a TPO broker is a `staff_users`
row with `is_external = true` (they have to be — a broker is the loan officer on their own firm's
files), so `requireStaff` alone would hand an outside company the ability to spend our credits and
read our CRM.

**Per-record scoping is separate from that.** Getting through the door is not permission to reach
into any lead or borrower by typing an id: `/link` and `/for/:kind/:id` route through the SHARED
`permissions.visibleLeadSql` / `visibleBorrowerSql`, so an officer reaches their own leads and
unassigned ones, a borrower they own or have a file with, and `see_all_files` reaches everything.

The whole desk is **throttled per officer** (120 requests a minute, `keyedRateLimit` keyed on
`req.actor.id`, mounted after `requireAuth`), unlike most staff routers, because one "Refresh data"
click walks eight paged sections and can become forty outbound calls out of an allowance the whole
organisation shares. Keyed on the PERSON and not the IP address: the office is behind one address,
so a per-IP bucket would be shared by everybody in it and a busy afternoon would look like abuse.
The limit is deliberately loose — it exists to stop a runaway loop, not to ration anybody's work;
the money cap and the per-hour self cap in `client.js` are what actually protect the allowance.

## 10. Vendor payloads into `jsonb`

Everything stored from Elementix goes through `crmTools.vendorJsonb`. Two things go wrong without
it, and both fail **after** the money is spent:

* a **NUL byte** — Postgres refuses U+0000 in `jsonb` (22P05), and the `nul-strip` middleware never
  sees a vendor answer because it arrives over `fetch`, not through `express.json`. The strip must
  happen on the OBJECT (`fields.jsonbText`), never on the serialized string.
* **size** — capping by slicing serialized JSON produces a truncated document Postgres rejects
  outright (22P02). An over-large payload is REPLACED by a marker that says so in the row.

## 11. Tests

Eight suites, all in `npm test`:

| suite | proves |
|---|---|
| `test-elementix-oauth-pure` | the connection, the token, the callback's own shapes |
| `test-elementix-callback-public` | the approval return leg is reachable and cannot be spoofed |
| `test-elementix-lookups-pure` | the UNDERWRITING plane still cannot reach a skip trace |
| `test-elementix-request-contracts-pure` | every request we send is one the vendor accepts |
| `test-elementix-crm-db` | the skip trace, the money guards, the truthful wording, the jsonb guard |
| `test-elementix-profile-db` | the profile builder, the merge, and that every request preflighted |
| `test-elementix-crm-routes-db` | who gets through the door, per-record scoping, what comes back |
| `test-elementix-backfill-db` | the history import, the shared-seat trap, and that no loop can spend |

Every guard added after the pre-merge audit was **mutation-proven**: the production rule was
reverted on purpose and the suite was confirmed to go red, with the unmutated run green either side.
