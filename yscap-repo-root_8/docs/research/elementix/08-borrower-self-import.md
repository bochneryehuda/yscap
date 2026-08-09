# THE BORROWER FINDS THEIR OWN PROPERTIES
### "Import from public research" — the borrower-INITIATED search, property by property
**Research pass, 2026-08-09. RTL only. Nothing here is built yet.**

The owner, verbatim:

> *"The borrower should also go to the track record, and they should have an option to import from
> public research. They should see a pop-up of all the properties that they found on his name, and
> then they can go property by property, verifying information and importing without a big hassle,
> which would be like never before."*

Companion documents. **This one is about the borrower STARTING the search.**

| Doc | Subject | Boundary with this one |
|---|---|---|
| `02-borrower-confirmation-ux.md` | Blueprint §9.4 — **staff** searched, the borrower **confirms** what we found | Owns the confirmation *card* and its copy. This document owns the *entry point*, the *privacy gate*, the *throttle*, and the *schema*. §7 argues they share ONE screen |
| `01-staff-bulk-workbench-ux.md` | Blueprint §9.5 — the staff bulk workbench | Same staging table. Everything a borrower declines or edits lands in that reviewer's queue; §6 and §9 define what they see |
| `05-budget-and-resilience.md` | The 1,000/hour ceiling, the reservation design | §3 adds a THIRD budget class on top of its interactive/batch split |

---

## 0. THE ONE-SENTENCE ANSWER

Build it — but the borrower searches **under the companies they have already named and claim to
control**, never under their personal name, because a name search is the one version of this feature
that hands a member of the public a list of a stranger's real estate, and it is also the one version
that **is not built today and would have to be written on purpose.**

---

## 1. THE ONE WORD IN THE OWNER'S SENTENCE THAT IS THE WHOLE PROBLEM

> *"all the properties that they found **on his name**"*

Read literally, that is a person-name search: take "MOSES WEIL", ask the public records what MOSES
WEIL owns, and render the answer to the person logged in as Moses Weil. Three things come back that
are not his:

1. **A different Moses Weil.** The staging table exists for exactly this reason and db/496's own
   header says so, quoting the owner: *"a lot of times maybe it can mess up different borrowers with
   the same name."* That is the STAFF-facing statement of the risk. The borrower-facing version is
   strictly worse: a staffer is an employee, trained, inside our audit log, working a queue. A
   borrower is a member of the public holding a phone, and a screenshot leaves the building.
2. **A relative.** Common surnames plus a shared mailing address is precisely how
   `get_entity_associated_people` clusters people. Family members who invest together are the norm in
   this book, not the exception.
3. **A partner.** A four-member LLC's deed list is the *LLC's* portfolio, not any one member's. Show
   it to one member and you have disclosed the other three's business to them.

None of that is hypothetical. §2.2 of the blueprint records a live false positive already caught by
this pipeline: *"a Philadelphia property returned under a York, PA investor who never owned it,
because his LLC appeared as grantor on an unrelated later deed."* That was caught by a filter on the
staff path. On a borrower path there is no reviewer between the vendor and the screen.

**Where I disagree with the owner's framing, plainly:** "all the properties found on his name" is
the wrong search. The right search is *"all the properties found under the companies he told us he
controls."* It answers the same business question — *find my deals so I don't have to type them* —
for the overwhelming majority of this book, because RTL borrowers hold in entities. It costs the
personal-name holder, and §4.6 proposes the nearest safe thing for them.

---

## 2. WHAT ALREADY EXISTS — READ THIS BEFORE DESIGNING ANYTHING

Phase 7 shipped the engine in the commit immediately before HEAD (`b6a9bd0`). There is **no UI for it
at all yet** —
`grep candidate app-v2/src/lib/api.js` returns nothing, and so does the staff workspace screen. The
routes exist and nothing calls them. So this feature is not competing with an installed base; it is
choosing the first surface the engine ever gets.

### 2.1 The engine

| Piece | Where | What it already guarantees |
|---|---|---|
| `runSearch` | `src/lib/track-record/importer.js:181-233` | Reads only. Writes a `track_record_searches` row, loops the borrower's entities, stages what comes back, records EVERY skip with a reason |
| `candidatesFrom` | `importer.js:110-159` | A deed only becomes a candidate when one of the borrower's entities is **grantee or grantor**; anything else is skipped `not_our_party` (`importer.js:120-127`). **This is the filter that caught the York, PA false positive** |
| Deal type | `importer.js:153-157` | **Never guessed.** Left NULL for a human to answer. The comment is explicit about why |
| `stageOne` | `importer.js:242-288` | A prior decision is durable; a re-run cannot re-ask a settled question; every non-staging is reported |
| `decideCandidate` | `importer.js:342-372` | Four verbs: `import_new`, `match_existing`, `decline`, `snooze` |
| `importNew` | `importer.js:390-425` | Runs the entity chokepoint, lands the row, and **reports** `is_verified` rather than assuming it — db/485 decides |
| `matchExisting` | `importer.js:436-491` | Fills blanks only. Never overwrites. Refuses to silently reopen a verification |
| `compareCandidate` | `importer.js:498-541` | The side-by-side, per field, with the policy stated per row |

Routes: `src/routes/staff.js:11235` (search), `:11246` (queue), `:11252` (compare), `:11260`
(decide). All four are staff-only and all four scope on `canSeeBorrower`.

### 2.2 THE ENGINE CANNOT SEARCH A PERSON'S NAME. AT ALL.

This is the single most useful fact in this document, and it should decide the design.

- `runSearch` builds its search set from `SELECT id, llc_name, formation_state FROM llcs WHERE
  borrower_id=$1` (`importer.js:191-193`). Entities only.
- With no entities, the loop body never executes and the search records a skip:
  `no_entities — "This borrower has no companies on their profile, so there is nothing to search
  under."` (`importer.js:202-204`).
- `candidatesFrom` is handed `[ent.llc_name, ...entityNames]` (`importer.js:215`). The borrower's
  personal name is **not in that list**. A deed in their own name is skipped `not_our_party`.
- `researchProperty` takes `borrowerNames` and only passes it through to the checks
  (`lookups.js:365`). It never searches on it.
- `match_person`, `get_person_properties` and `get_person_entities` are in the lookups allowlist
  (`lookups.js:64-79`) but have **no wrapper and no caller**. They are names in a Set.

So the safe feature is the one that already exists. **The dangerous feature is the one that would
have to be written.** Any future session that reaches for `match_person` to satisfy the owner's
sentence is opening the hole this document is about, and should read §4 first.

### 2.3 The seam — and it already exists, which is the good news

The owner has ruled the borrower's tool out of scope (blueprint §12: *"Changing the borrower's
tool"*, and §0: *"The borrower's own tool (`?portal=1`) is not in scope and is not modified."*).

The borrower's track record is **a React shell hosting a static tool in an iframe**:

```
app-v2/src/screens/TrackRecordScreen.jsx        ← THE SHELL. Ours to change.
 ├─ .toolsheet-head        (lines 124-134)      ← back / title / Done
 ├─ .toolsheet-sub         (lines 135-154)      ← the requirement chips
 └─ .toolsheet-body.scroll (lines 155-163)
     └─ <StaticToolFrame src="/tools/track-record.html?portal=1&embed=1" />
          │
          └─ web/v2/tools/track-record.js        ← THE TOOL. Frozen. Do not touch.
             web/v2/tools/track-record-portal.js ← THE BRIDGE. Frozen. Do not touch.
```

**Three attachment points, all in the shell, none in the tool:**

1. **The entry point** — a card between `.toolsheet-sub` (ends line 154) and `.toolsheet-body`
   (line 155). New markup in `TrackRecordScreen.jsx`, rendered by React, above the iframe.
2. **The sheet** — a full-screen overlay rendered as a sibling of `.toolsheet-body`, painted over
   it. The iframe **stays mounted underneath and keeps its state**, so closing the sheet returns the
   borrower to exactly the tool they left.
3. **The refresh** — `reloadTrackRecordFrames()` already exists at `TrackRecordScreen.jsx:10-15`,
   and the tool already listens for it at `track-record-portal.js:251-254`. Call it after an import
   and the tool re-pulls from the server. **Zero lines change in the tool.**

**One hazard, checked and clear.** The tool's diff-sync deletes anything in its `knownIds` set that
is no longer in its snapshot (`track-record-portal.js:296-298`). A row created server-side while the
tool is open is not in `knownIds`, so it cannot be swept away — verified by reading the create and
reload paths. And if the reload is deferred because the borrower has a form open in the tool, it
retries for 20 s and then gives up quietly (`:236-250`); the imported row still cannot be deleted,
the borrower simply does not see it until the next reload. Mitigation: fire `ys-tr-reload` when the
sheet CLOSES as well as on each import.

### 2.4 The schema's staff-shaped hole

```sql
-- db/496_track_record_candidates.sql
run_by      uuid REFERENCES staff_users(id),   -- :48   "NULL = the borrower ran it"
decided_by  uuid REFERENCES staff_users(id),   -- :108
claimed_by  uuid REFERENCES staff_users(id),   -- :110
```

Two different problems, and only one of them is the one the brief names:

- **`decided_by` cannot hold a borrower.** A borrower's decision written as NULL is
  indistinguishable from *nobody has decided yet* — which is the meaning every consumer currently
  reads (`loadQueue`, `importer.js:292-336`; the partial index `idx_trc_open`, db/496:122-123).
  Writing a borrower uuid violates the foreign key.
- **`run_by IS NULL` is already ambiguous, today.** Its own comment says NULL means the borrower ran
  it — but NULL is also what a search with no recorded actor produces. That ambiguity is harmless
  while only staff can search. It stops being harmless the moment a borrower can.

§9 sets out the migration.

### 2.5 Three live holes a borrower's hands would open

Each of these is safe today only because the actor is always a staffer.

**(a) A borrower could permanently hide a property from us.** `stageOne` refuses to re-stage
anything with a prior `declined` row: *"Somebody already said this is not their property."*
(`importer.js:249-256`). That durability is correct for a staff decline — it is the whole db/108
property db/496's header cites. Give a borrower the `decline` verb and one tap makes a property
**invisible to every future search, staff-run included, forever.** A borrower declining a property
they actually owned is not a rare mistake; it is a fraud pattern (an unsold flip, a foreclosure, a
partner dispute). **A borrower's "no" must never be durable in the way a staffer's is.**

**(b) A borrower could import-then-delete to the same effect.** `DELETE /track-records/:id` works on
any of their own unverified lines (`borrower.js:3099-3103`), and an imported line lands unverified by
db/485. The candidate stays `imported` while `imported_track_record_id` is set to NULL by the FK's
`ON DELETE SET NULL` (db/496:106) — and `stageOne` then answers `already_handled` forever
(`importer.js:257-259`). Fix: `already_handled` must confirm the imported row still exists.

**(c) Every import is stamped `staff`.** `importNew` hardcodes `'public_records','staff'`
(`importer.js:404`). db/458 allows `'borrower'` (`db/458:60`) and indexes exactly the
self-reported-and-pending case (`db/458:86-88`) — which is the queue a reviewer reads. A borrower's
import landing stamped `staff` is a lie in the audit trail and it hides the row from the one index
built to surface it.

---

## 3. SHOULD THE BORROWER BE ABLE TO TRIGGER A SEARCH AT ALL?

**Yes.** With four gates, a throttle, and a button that tells the truth in every state.

### 3.1 The four gates

The button renders only when all four hold:

| # | Gate | Why | Where it lives |
|---|---|---|---|
| 1 | The feature is on globally | Same staged posture as the Elementix client itself, which defaults OFF (`client.js:43-45`). Flip it on when the office is comfortable | `TRACK_RECORD_BORROWER_SEARCH_ENABLED`, live-switchable from API Health like every other flag |
| 2 | Elementix is on **and the borrower budget class has room** | §3.3 | `client.enabled()` + a new class check |
| 3 | The borrower has **at least one entity that qualifies as a search anchor** (§4.4) | No anchor, no search. There is nothing safe to search under | `llcs` + `llc_borrowers` |
| 4 | Staff have not turned it off for this borrower | A per-borrower veto for the cases a human can see and a rule cannot | new `borrowers.public_search_disabled` (or the equivalent on the file) |

**On by default per borrower once gate 1 is on, with a staff veto — not off by default per
borrower.** I considered requiring a staffer to enable it person by person; it is the strongest
privacy posture and it also kills the feature. The owner's ask is self-service (*"the borrower should
also go to the track record"*), and a feature that needs a phone call first is not self-service. The
compromise is that gate 3 does most of the work: a borrower with no named, controlled entity never
sees the button at all, and that is a large slice of the population that would otherwise be the
riskiest.

### 3.2 The throttle

| Limit | Value | Why |
|---|---|---|
| Cooldown | **1 search per borrower per 24 h** | The public records do not change hourly. A second search the same day cannot return anything new and is pure spend |
| Ceiling | **3 searches per borrower per 30 days**, then staff must re-enable | Stops a determined user from a search a day for a month |
| Entities per search | **at most 5**, ordered verified-first then by claimed ownership | Each entity costs 4–6 calls (`researchProperty`, `lookups.js:312-367`). A borrower with 14 shells is not paying for 84 calls |
| Class budget | **60 calls/hour org-wide for the borrower class** | §3.3 |
| Anything skipped | **named, with a reason**, in `track_record_searches.skips` | db/496's own rule: *"A search that quietly returns 3 of 11 results reads exactly like a borrower who only did 3 deals"* |

### 3.3 The budget class — a third one

`05-budget-and-resilience.md` §2 splits PILOT's 400/hr cap into **150 interactive-reserved / 250
batch**. The borrower class is a carve-out **of the batch share, never of the interactive reserve**:

```
   ORG CEILING                1,000 / hour   (shared with everything the company runs)
   └─ PILOT self-cap            400 / hour   (ELEMENTIX_MAX_PER_HOUR, src/config.js)
      ├─ interactive reserve    150 / hour   staff Verify clicks — a borrower may NEVER touch this
      └─ batch share            250 / hour
         ├─ BORROWER CLASS       60 / hour   ← new. ~4 borrower searches an hour, org-wide
         └─ staff batch         190 / hour
```

At 4–6 calls per entity and ≤5 entities, one borrower search costs **4–30 calls**. Sixty an hour is
roughly four searches. That is enough — this is a once-per-borrower action, not a workflow — and it
means **a borrower pressing a button can never starve the person on the phone.** That is the whole
point of the class.

The borrower class **fails CLOSED**, unlike the staff throughput guard which fails open
(`client.js:90-105`). The asymmetry is deliberate and follows the same rule the money cap does: for
a staffer mid-review, refusing costs a feature outage over a bookkeeping hiccup; for a borrower
browsing their own track record, refusing costs a "try again later" they will not notice, and the
expensive direction is an unattended, unreviewed caller spending an allowance nobody is watching.

### 3.4 What a second press does

**Nothing is spent.** The search is a background job with a durable row from the first instant:

1. Press → insert `track_record_searches` at `status='queued'`, **return its id immediately**, run
   the work in `setImmediate` on its own connection (the pattern
   `POST /api/underwriting/:appId/investor-guidelines/ai-verify` already uses).
2. The screen polls that row.
3. **A second press while one is in flight returns the SAME search id.** No second row, no second
   call. The button reads "Looking…" and is disabled.
4. A second press after it finished, inside the cooldown, does not fire at all — the button is
   disabled and names the time.

This also fixes a real defect in the current row lifecycle: `runSearch` writes the row at the start
(`importer.js:195-197`) and updates it once at the end (`:226-230`). If the process dies between,
the row sits forever looking like a search that found nothing. Tolerable for a staffer who can press
again; not tolerable for a borrower polling a screen. §9 adds `status` and `finished_at`.

### 3.5 What the button says, in every state

| State | Button | Line under it |
|---|---|---|
| Ready | **Find my properties** | "We'll look up public records for the companies you've listed. Nothing is added until you say so." |
| Running | **Looking…** *(disabled)* | "This takes about a minute. You can leave this page — we'll keep going." |
| Done, results waiting | **Review 6 properties** | "We found 6 that look like yours. Check them one at a time." |
| Done, nothing found | **Find my properties** *(re-enabled after cooldown)* | "We didn't find anything under Ridgeline Holdings LLC. That doesn't mean anything's wrong — a lot of counties aren't online yet. Add your deals below and we'll take it from there." |
| No entities on file | **Add a company first →** | "We search using your company names. Add the company you bought under and this turns on." |
| Entities, none controlled | **Tell us which company you control →** | "We can only search companies you own or manage. Add your ownership percentage on your entities page." |
| Cooldown | **Find my properties** *(disabled)* | "You already searched today. You can search again tomorrow morning." |
| Monthly ceiling | **Find my properties** *(disabled)* | "You've used this month's searches. Message your loan team and they can run another one." |
| Class budget exhausted | **Find my properties** *(disabled)* | "Our records service is busy right now. Try again in a little while." |
| Company name matched several companies | *(the search runs; the result page says it)* | "\"Summit Capital LLC\" matches more than one company in the public records, so we didn't guess. Your loan team can sort this out — message them and we'll do it for you." |
| Feature off globally / Elementix off / staff veto | **nothing renders** | — |

The last row matters. **A door that is not there is better than a door that is broken**, and a staff
veto must never announce itself — "your loan team turned this off for you" reads as an accusation,
which is exactly the D3 failure mode the blueprint spends a paragraph on.

The "nothing found" copy is doctrine, not politeness. **D2: silence is never a negative finding.**
Elementix is live in 421 of 3,226 counties and reports zero document images in Los Angeles County.
A borrower must never read an empty result as *we think you're lying.*

---

## 4. THE PRIVACY DESIGN

### 4.1 What is actually being disclosed

An address is public. A deed is public. **An assembled list of one person's holdings, handed to a
named individual inside a credit transaction, is not the same object as the records it was built
from.** That is the distinction that matters here, and it has three consequences:

1. If the list is wrong about WHO, we have disclosed person B's holdings to person A.
2. We did it in the course of a credit transaction, which is the plane Reg B and GLBA govern.
3. We did it to a party who is not our employee, has no confidentiality obligation, and is holding a
   phone.

### 4.2 The four options, weighed

| Option | Stops the same-name collision? | Stops the co-member leak? | Cost |
|---|---|---|---|
| **(a) Search only entities the borrower already NAMED** | **Mostly.** They supplied the name, so the search set is their own assertion — nothing is revealed they did not already claim. An LLC name plus a formation state is far more identifying than a personal name (D6) | **No.** A 4-member LLC's deed list is the LLC's whole portfolio | Personal-name holders get nothing (§4.6) |
| **(b) Require identity anchors before results render** — confirm formation state, formation year, EIN last-4 | Helps. Turns a name match into a name + state + date match | No | Friction at exactly the wrong moment, and a borrower who cannot remember their own formation year is now locked out of their own data |
| **(c) Show the address without the owner name until they claim it** | **No — and it makes things worse.** The address IS the disclosure. And a borrower asked "is this yours?" with *less* information gives a *less* reliable answer, so it degrades the data too | No | Rejected outright. See §4.5 |
| **(d) Staff pre-screen every list before the borrower sees it** | **Yes** | **Yes** | Kills self-service. This is not a variant of the feature — it IS §9.4, the sibling document's flow |

### 4.3 THE RECOMMENDATION

**(a), plus a bounded slice of (b), plus one structural rule that handles the co-member leak, plus a
non-human pre-screen that gives most of (d)'s protection for free.**

Six rules, in the order they apply:

**R1 — ENTITY-SCOPED, ALWAYS.** The search set is `llcs WHERE borrower_id = <the borrower>`. Never
the person's name, never an alias, never a related person. This is what `runSearch` already does
(`importer.js:191-193`); the change is to make it a **stated rule on the borrower path** rather than
an implementation detail, so nobody "improves" it later.

**R2 — CONTROL, NOT MEMBERSHIP.** An entity qualifies as a search anchor only when the borrower has
claimed control of it: `llcs.ownership_pct >= 50`, **or** the borrower is recorded as managing
member, **or** staff have already verified Check A (`llc_borrowers.ownership_verified`, db/495:49).
A 20% passive member does not get to pull the entity's whole portfolio and read their partners'
deals. **This is the structural answer to the co-member leak**, and it costs almost nothing: the
entity screen already collects `ownership_pct` and the borrower's own create route already validates
it (`borrower.js:2050-2058`).

This is the bounded slice of option (b) — one anchor, the one they already gave us, checked rather
than re-asked.

**R3 — AMBIGUITY REFUSES, VISIBLY.** `researchProperty` already picks one entity or none: *"ONE
candidate or nothing. Several equally good candidates is a human question, and picking the first is
exactly how somebody else's deeds end up on this borrower's record."* (`lookups.js:328-331`). Today
that produces a silent empty result. On the borrower path it must produce a **named** refusal, with
the copy in §3.5, because "we found nothing" and "we found several and won't guess" send the
borrower to two different places. Same for `nameCommonnessScore >= 85`
(`lookups.NAME_COMMONNESS_REFUSE_AT`).

**R4 — GRANTEE OR GRANTOR, OR IT IS NOT A CANDIDATE.** Already enforced (`importer.js:112-127`), and
it is the filter that caught the York, PA false positive. Stated here so a borrower-path change
cannot relax it.

**R5 — THE AUTOMATIC PRE-SCREEN: only `certain` reaches the borrower.** A candidate is shown to the
borrower only when the search that produced it was unambiguous, the entity was the deed's grantee or
grantor, and the address parsed cleanly. **Everything else goes to the staff queue instead and the
borrower never sees it.** This is option (d)'s protection without a human in the loop, and it
degrades in the safe direction: when we are unsure, a trained reviewer looks, not the customer.
Concretely, this is a `visibility` column on the candidate (§9) set at stage time, not a filter a
future query has to remember — the same discipline db/496 chose when it put candidates in a separate
table rather than behind a flag.

**R6 — NEVER A PERSON, NEVER A CONTACT.** No borrower path may call `get_entity_associated_people`,
`match_person`, `get_person_properties`, `get_person_entities`, `get_contact_status`,
`get_contact_info`, and obviously never `submit_contact_enrichment`. The borrower path gets its own
narrower allowlist — the rule that works in this repo is **absence**, per `lookups.js`'s own header:
*"There is no argument any caller can pass to reach it."*

Note that `researchProperty` calls `get_entity_associated_people` today (`lookups.js:340-341`) to
feed the checks. On the borrower path that call must be **skipped**, not merely unrendered: it costs
a call from a 60/hour budget to fetch a list of other people that the borrower must never see.

### 4.4 WHAT WE ARE TRADING AWAY — named, not buried

1. **The borrower who bought in their personal name gets nothing.** `track_records.owned_personally`
   exists because this is common, and the borrower's tool has a dedicated "Personal name" affordance
   (`track-record.js` `entityLabel`). This is the largest cost of the recommendation and I am not
   going to dress it up. §4.6 is the nearest safe thing.
2. **A passive minority member loses self-service.** They can still ask their loan team, who can run
   the staff search — where a reviewer stands between the vendor and the screen, which is the whole
   point.
3. **A brand-new LLC returns nothing** because the vendor has not indexed it. The copy must carry
   D2/D3 or an empty result reads as an accusation.
4. **A borrower with the search off never learns why.** Deliberate. See §3.5.
5. **We will show fewer properties than a name search would.** That is the trade, stated once: fewer
   results, none of them someone else's.

### 4.5 Why "show the address without the owner name" is rejected

It is the most tempting of the four options and it is the worst, for two independent reasons.

- **It does not reduce the disclosure.** If the property is a stranger's, showing "1412 Mercer
  Street, Trenton NJ — bought Mar 2024 $310,000, sold Nov 2025 $498,000" has already disclosed the
  stranger's deal. Withholding their *name* withholds the one field the borrower could have used to
  say "that's not me, that's my cousin."
- **It degrades the answer.** The whole value of the borrower's confirmation is that they know
  things we don't. Ask them with less information and you get a worse claim — and a false "yes" on a
  look-alike address is a fabricated deal on a track record that prices a loan.

### 4.6 The nearest safe thing for the personal-name holder

**"Check an address I already know."** The borrower types an address they assert is theirs; we run
`match_address` + `get_address_transactions` on that one address and show them what the records say
about it. There is no discovery and therefore no disclosure — they told us the address, we told them
what is on file for it. It costs 2 calls. It uses wrappers that already exist (`lookups.js:202-211`).
It is a different button with different copy and it should ship in the same phase, because without
it a large, ordinary class of borrower opens the track record and finds the new feature does not
apply to them with no explanation.

**It is not a search and the copy must never call it one.** "Look up an address" — never "find".

---

## 5. THE POP-UP, PROPERTY BY PROPERTY

### 5.1 What "verifying information" means for someone who is not an underwriter

It means **reading four facts off a card and saying whether each one matches what they remember.**
It does not mean verification in our sense and the copy must never use that word to a borrower.

The word "verify" belongs to db/485 and to a staffer with `sign_off_conditions`. The borrower's word
is **check**. The card says *"Do these look right?"*, and the screen says what happens next in plain
English, because a borrower who believes their tap verified something will stop chasing the document
we still need.

### 5.2 The order of the questions, and why

| # | Question | Why here | Skippable? |
|---|---|---|---|
| 1 | **Is this yours?** | Everything else is wasted if the answer is no. It is also the only question with a privacy consequence, so it comes before we ask them to invest any effort | No — but "Not sure" is a real answer |
| 2 | **Which of your companies?** | Pre-filled from the entity we searched under, which is right nearly always. One tap to confirm | Pre-answered |
| 3 | **What kind of deal was it?** | **The one thing the records genuinely cannot say** (`importer.js:153-157`). It decides which experience bucket the deal counts in, and the bucket prices the loan | **No.** See §6.3 |
| 4 | **Do these numbers look right?** | Default "yes, as recorded". Only expands if they say something's off | Yes — one tap |
| 5 | **Anything we should know?** | One optional box. This is where the useful stuff comes from — "the sale price includes the lot next door" | Yes |

### 5.3 The card — phone first

```
┌──────────────────────────────────────────┐
│ ▓▓▓▓▓▓▓▓░░░░░░░░░░░░   3 of 8            │   ← denominator always. §9.4: it
│                                          │     materially raises completion
│  62 HIGHLAND STREET                      │   ← the address is the headline.
│  Lakewood, NJ 08701                      │     wraps, never truncates
│                                          │
│  Bought   Aug 2025      $410,000         │   ← 2-col grid; 1 col under 400px
│  Sold     Mar 2026      $612,000         │
│                                          │
│  Under    MW TRADING LLC                 │   ← the company WE searched under
│                                          │
│  ⓘ Ocean County deed, recorded 19 Mar    │   ← provenance, one line, plain
│    2026                                  │     English. No ids, no scores
│                                          │
│  ┌────────────────┐  ┌────────────────┐  │
│  │  Yes, this is  │  │  No, not mine  │  │   ← EQUAL weight. Both 48px tall,
│  │      mine      │  │                │  │     16px text. Not primary+ghost
│  └────────────────┘  └────────────────┘  │
│                                          │
│           I'm not sure  ·  Skip          │   ← both plain links, both real
│                                          │
│  ↩ Undo — you marked 118 Oak Ave as      │   ← always visible after the first
│    yours                                 │     answer
│                                          │
│  Your answers save as you go. You can    │
│  close this and come back any time.      │
└──────────────────────────────────────────┘
```

After **Yes**, the follow-up rises as a bottom sheet over the same card — the phone pattern this
repo already uses (`.cv-modal` becomes a bottom sheet under 720px):

```
┌──────────────────────────────────────────┐
│  62 Highland Street                      │
│  ────────────────────────────────────    │
│                                          │
│  What kind of deal was this?             │   ← the ONE unavoidable question
│                                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │  Fixed   │ │  Fixed   │ │  Built   │  │   ← three cards, the tool's own
│  │  and     │ │  and     │ │  from    │  │     two-card chooser plus ground-up
│  │  SOLD    │ │  KEPT    │ │  the     │  │     (§9.4: "add a third card and
│  │          │ │  it      │ │  ground  │  │      reuse the markup")
│  └──────────┘ └──────────┘ └──────────┘  │
│                                          │
│  Held under                              │
│  ┌────────────────────────────────────┐  │
│  │ MW TRADING LLC                  ▾  │  │   ← pre-filled. Their own entities
│  └────────────────────────────────────┘  │     + "my personal name" + "another
│                                          │      company" (types a name)
│  Do these numbers look right?            │
│  ┌────────────────────────────────────┐  │
│  │ ● Yes, that's what happened        │  │   ← DEFAULT. One tap and done
│  │ ○ Something's different            │  │
│  └────────────────────────────────────┘  │
│                                          │
│  Anything we should know? (optional)     │
│  ┌────────────────────────────────────┐  │
│  │                                    │  │
│  └────────────────────────────────────┘  │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │        Add it and continue  →      │  │
│  └────────────────────────────────────┘  │
│                                          │
│  Your loan team checks this against the  │   ← THE CLAIM BOUNDARY, in the
│  paperwork before it counts toward your  │     borrower's own words. Never
│  experience.                             │     "verified"
└──────────────────────────────────────────┘
```

Only when they tap **Something's different** does the figure editor open:

```
│  Do these numbers look right?            │
│  ○ Yes, that's what happened             │
│  ● Something's different                 │
│                                          │
│    What we found        What's right     │
│    ─────────────────────────────────     │
│    Bought Aug 2025      [Aug 2025    ]   │
│    $410,000             [$410,000    ]   │
│    Sold  Mar 2026       [Mar 2026    ]   │
│    $612,000             [$598,000    ]   │  ← changed → marked for the reviewer
│                                          │
│    We'll keep both — the public record    │
│    and what you told us — and your loan   │
│    team will sort out the difference.     │
```

### 5.4 What is deliberately NOT on the card

| Not shown | Why |
|---|---|
| `match_confidence`, `nameCommonnessScore`, any score | Our internal reading of how sure we are. Showing it invites the borrower to argue with it, and a borrower who sees "possible" will answer differently than one who sees "certain" — which corrupts the claim |
| The counterparty / related-party findings | Internal. This is the Baltimore control (blueprint §2.4/D12) and it is not a conversation to have with the subject |
| The `skips` list with reasons | Staff copy. "Neither side of this deed is the borrower or one of their companies" is a sentence about our matching logic |
| Any other party's name — grantee, grantor, associated person, co-member | R6 |
| Any phone number or contact detail, ever | The owner's hard rule. We do not skip trace; showing a number would imply we did |
| A capital-partner or note-buyer name | Standing rule. `scrubText` (`src/lib/borrower-safe.js:77`) must run over every free-text field that reaches this screen |
| A document id, a book/page, a vendor id | Meaningless to them and it leaks our plumbing. "Ocean County deed, recorded 19 March 2026" is the whole useful content |

---

## 6. "WITHOUT A BIG HASSLE"

### 6.1 Where the friction actually is, honestly

| Friction | Unavoidable? | Verdict |
|---|---|---|
| Reading the address and deciding | **Yes — it IS the work** | Keep. Make it fast (§6.2), never make it optional |
| The deal-type question | **Yes.** Nothing in the records says it | Keep. §6.3 |
| Checking four figures | Partly | **Collapse to one tap by default.** §6.2 |
| Naming the entity | No | **Pre-fill.** We searched under it |
| Getting to the screen | No | **Deep link from the email/notification** straight to the sheet |
| Typing | No | **Nothing is typed** except an optional note and a corrected figure |
| Waiting for the search | No | Background job + poll. They can leave (§3.4) |
| Not knowing how many are left | No | "3 of 8" on every card (§9.4 already says this) |

### 6.2 The four changes that actually remove hassle

1. **The figures default to "as recorded", one tap.** This is the single biggest reduction and it
   costs nothing, because **a borrower agreeing with a recorded figure is worth exactly as much as
   the recorded figure was on its own** — the agreement adds no evidence. Only a DISAGREEMENT is
   information, so only a disagreement should cost a tap.
2. **Order by confidence — easy ones first.** The first three cards should be the cleanest matches,
   so the borrower builds momentum before hitting a hard one.
3. **Never ask about a property already on the record.** `stageOne` already resolves
   `match_track_record_id` (`importer.js:269-271`). Those go to the staff merge queue, not to the
   borrower — asking somebody about a deal they already typed in is the definition of hassle.
4. **Everything saves per answer, and the sheet reopens where they left off.** Which is how the
   tool underneath already behaves; the sheet must match it.

### 6.3 What I would NOT remove, and what breaks if you do

- **The deal-type question.** Removing it means guessing. A guessed "flip" puts a deal in the flip
  bucket; the bucket sets the experience tier; the tier prices the loan. `importer.js:153-157`
  refuses to guess it and the refusal should stand at the borrower layer too.
- **The per-property yes/no.** A "these are all mine" button is the shape that produces garbage, and
  the blueprint already forbids its twin on the staff side: §9.5, *"a 'select all → import' that
  skips the per-property read is the one shape this must not become."* The same sentence applies
  here with more force, because there is no reviewer.
- **The "I'm not sure" option.** Remove it and every uncertain borrower is forced into a false yes or
  a false no. "Not sure" is a *useful* answer — it routes the property to staff with a real signal.
- **The claim/verification boundary.** No borrower answer may write `verified`, and no screen may
  imply it did.
- **The address as read-only.** §8.
- **The sentence about what happens next.** It is one line and it is the thing that stops a borrower
  believing they are done.

---

## 7. ONE FLOW OR TWO?

**ONE SCREEN. TWO DOORS.** The confirmation experience is shared; the entry point, the provenance
and the throttle are not.

### 7.1 Why one screen

- **The borrower's job is identical.** *Is this yours → what kind of deal → do the numbers look
  right.* Whether staff or the borrower pressed the button changes nothing about that.
- **Two screens will drift, and this repo has the scar.** db/485's own root-cause section describes
  `trackRecordEnteredCols(kind)` — a "shared" helper that behaved differently per actor and
  therefore silently skipped the staff door for months: *"A helper that takes the actor as an
  argument and then behaves differently per actor is not a shared rule; it is two rules sharing a
  function."* Two confirmation screens is that mistake at component scale.
- **It is the same table.** Both produce `track_record_candidates` rows and both are decided through
  `decideCandidate`.
- **The borrower does not care who searched.** Presenting two lists — "your loan team found these"
  and "you found these" — is our org chart leaking onto their screen. It is also worse: they would
  have to work two queues.

### 7.2 Why two doors

| | Staff-initiated (§9.4) | Borrower-initiated (this doc) |
|---|---|---|
| Who spent the allowance | A staffer, deliberately | A borrower, on a button |
| Throttle | None beyond the staff budget | §3.2, and a class budget |
| Privacy gate | A reviewer stands between the vendor and the screen | R1–R6 do the reviewer's job structurally |
| Pre-screen | Staff already saw everything | Only `certain` reaches the borrower (R5) |
| What the opening line says | "Your loan team found these" | "Here's what we found under your companies" |
| Recorded as | `run_by = <staff uuid>` | `requested_by_kind='borrower'` (§9) |

Everything after the opening line is byte-identical.

### 7.3 What the borrower's screen actually looks like in my answer

**One list.** If staff staged four and the borrower's own search staged three, the borrower sees a
single queue of seven, each card carrying a small provenance line:

```
┌──────────────────────────────────────────┐
│  Properties to check                     │
│  7 waiting · 2 done                      │
│                                          │
│  Some of these came from your loan team's │
│  search, some from yours. Either way,    │
│  nothing is added until you say so.      │
│                                          │
│  ▓▓▓▓░░░░░░░░░░   2 of 9                 │
└──────────────────────────────────────────┘
```

The provenance line lives on the card, small, factual — *"Found by your loan team, 12 Aug"* /
*"From your search, today"* — because a borrower may reasonably wonder how we got it, and because
answering that question in one quiet line is cheaper than a tab bar.

---

## 8. WHAT THE BORROWER MAY EDIT

### 8.1 The table

| Field | Borrower may… | Why |
|---|---|---|
| **Property address** | **NO.** Not editable, at all | Changing the address changes WHICH PROPERTY this is. The candidate's deed, its `documentId`, its `dedupe_key` (`importer.js:95-100`) and its `match_track_record_id` are all about that address. A borrower who says the address is wrong is saying *this is not my property* — route them to **"No, not mine"** with a note box. §8.2 |
| Purchase price | **Correct it** — recorded as a claim | The records are wrong often enough. In the 12 non-disclosure states (including Texas) the price is not public at all |
| Purchase date | Correct it — a claim | Recording date ≠ closing date. Ordinary |
| Sale price / sale date | Correct it — a claim | Same |
| Deal type | **Answer it** — always a claim, never a correction | It is NULL by construction (`importer.js:153-157`) |
| Entity | Correct it, from **their own entities** + "my personal name" + "another company" (types a name) | A typed name goes through `promoteEntityName` (`track-record-entity.js:151`), which refuses junk (`junkEntityName`, `:78`) and refuses on ambiguity |
| Rehab spend, rent, refi | **Add** — the records do not carry them | These are blanks the borrower fills, not corrections |
| Notes | Free text, scrubbed | The most valuable field on the card |
| `raw` (the vendor record) | **NO. Never.** | db/496:77 — *"The vendor record VERBATIM. Never edited, never normalized in place"*. It is evidence |
| `match_confidence`, `skips`, internal notes | **NO.** Not visible, let alone editable | §5.4 |

### 8.2 Why the address is the one refusal

Making the address editable would let a borrower point a candidate — carrying a real Ocean County
deed as its evidence — at a completely different property, and the deed would ride along as proof of
a transaction that never happened at that address. The evidence and the claim would have come apart
silently. Refusing costs one screen ("that's not my property, and here's why") and closes the class.

### 8.3 How the borrower's edit is stored — beside, never over

**The borrower's answer does not overwrite the candidate's parsed columns.** It goes into a separate
`borrower_answer` jsonb (§9):

```
track_record_candidates
  purchase_price   410000        ← what the records said. Never touched.
  sale_price       612000        ← what the records said. Never touched.
  deal_type        NULL          ← the records never say
  borrower_answer  {
    "confirmed": true,
    "dealType": "flip",
    "llcId": "…",
    "figures": { "salePrice": 598000 },     ← ONLY what they changed
    "note": "sale price included the lot next door",
    "answeredAt": "2026-08-14T15:02:11Z"
  }
```

Two reasons this is not negotiable:

1. **It is the same rule `matchExisting` already follows** — fill blanks, never overwrite
   (`importer.js:436-449`), so a disagreement *stays* a disagreement a person can see rather than
   being quietly resolved in somebody's favour.
2. **It is what makes the difference visible forever.** Overwrite the record and nobody can ever
   tell that the borrower moved a number.

On import, the borrower's answer is what lands on `track_records` — it is their claim, and the line
is theirs. The candidate keeps both halves.

### 8.4 How a staff reviewer sees that they changed something

`compareCandidate` already renders ours/theirs per field with a per-row policy note
(`importer.js:498-541`). Add a **third column**:

```
┌── 62 Highland St ─────────────────────────────────────────────────────┐
│ Field          Public record    Our line     What the borrower said   │
│ ─────────────────────────────────────────────────────────────────────  │
│ Address        62 Highland St   — empty —    (not editable)           │
│ Bought         2025-08-02       — empty —    2025-08-02        agrees │
│ Purchase       $410,000         — empty —    $410,000          agrees │
│ Sold           2026-03-14       — empty —    2026-03-14        agrees │
│ Sale price     $612,000         — empty —    $598,000        ⚠ CHANGED│
│ Deal type      (records can't   — empty —    Fix & flip      ⚠ CLAIMED│
│                 say)                                                  │
│ Entity         MW TRADING LLC   — empty —    MW TRADING LLC    agrees │
│                                                                       │
│ ⚠ The borrower changed 1 figure and answered 1 the records can't.     │
│   "sale price included the lot next door"                             │
└───────────────────────────────────────────────────────────────────────┘
```

Two consequences for the staff queue:

- **Changed rows sort first.** A borrower who corrected three figures is a materially different
  review from one who tapped "these look right" seven times.
- **The card carries a one-line summary before it is opened** — "borrower changed 1 figure" — so a
  reviewer working forty rows can triage without opening each one. This is the hook the bulk
  workbench (`01-…`) needs from this feature.

---

## 9. THE SCHEMA

Everything below is `ADD COLUMN … IF NOT EXISTS` or a new index. No drop, no rename, no data loss —
blueprint §3.0's add-only rule.

### 9.1 The problem, precisely

`track_record_candidates.decided_by uuid REFERENCES staff_users(id)` (db/496:108). A borrower's
decision has nowhere to go: NULL is already the encoding for *nobody has decided*, and a borrower
uuid violates the FK. Separately, `track_record_searches.run_by IS NULL` already carries two
meanings (db/496:48).

### 9.2 The migration — db/504

```sql
-- ── WHO DECIDED, AND OF WHAT KIND ────────────────────────────────────────────
-- Two columns and a kind, NOT one generic uuid. Widening `decided_by` into an
-- untyped id column would mean dropping a real foreign key, which is how a
-- deleted staffer silently orphans a decision and how the queue loses the ability
-- to join at all. Two typed columns keep both joins honest.
ALTER TABLE track_record_candidates
  ADD COLUMN IF NOT EXISTS decided_by_kind      text,
  ADD COLUMN IF NOT EXISTS decided_by_borrower  uuid REFERENCES borrowers(id) ON DELETE SET NULL,

  -- The borrower's own answer, BESIDE the vendor's figures and never over them.
  -- {confirmed, dealType, llcId, figures:{…}, note, answeredAt}
  ADD COLUMN IF NOT EXISTS borrower_answer      jsonb,

  -- Who this row may be shown to. A COLUMN, not a query filter, for the same
  -- reason db/496 put candidates in a separate table rather than behind a flag:
  -- a flag is a thing every future query must remember.
  ADD COLUMN IF NOT EXISTS visibility           text NOT NULL DEFAULT 'staff',

  -- So "we asked and they haven't answered" is distinguishable from "we never
  -- asked" — the same never-fabricate discipline as auto_verdict NULL.
  ADD COLUMN IF NOT EXISTS shown_to_borrower_at timestamptz;

-- ── BACKFILL BEFORE THE CONSTRAINT, OR EVERY EXISTING ROW VIOLATES IT ───────
UPDATE track_record_candidates
   SET decided_by_kind = 'staff'
 WHERE decided_by IS NOT NULL AND decided_by_kind IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='trc_decider_matches_kind') THEN
    ALTER TABLE track_record_candidates ADD CONSTRAINT trc_decider_matches_kind CHECK (
         (decided_by_kind IS NULL     AND decided_by IS NULL AND decided_by_borrower IS NULL)
      OR (decided_by_kind = 'staff'   AND decided_by IS NOT NULL AND decided_by_borrower IS NULL)
      OR (decided_by_kind = 'borrower' AND decided_by_borrower IS NOT NULL AND decided_by IS NULL)
      OR (decided_by_kind = 'system'  AND decided_by IS NULL AND decided_by_borrower IS NULL)
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='trc_visibility_check') THEN
    ALTER TABLE track_record_candidates ADD CONSTRAINT trc_visibility_check
      CHECK (visibility IN ('staff','borrower'));
  END IF;
END $$;

-- ── THE SEARCH: who asked, and did it finish ─────────────────────────────────
ALTER TABLE track_record_searches
  ADD COLUMN IF NOT EXISTS requested_by_kind     text,
  ADD COLUMN IF NOT EXISTS requested_by_borrower uuid REFERENCES borrowers(id) ON DELETE SET NULL,
  -- A background job needs a lifecycle. Today the row is written at the start
  -- (importer.js:195) and updated at the end (importer.js:226); a process that
  -- dies between leaves a row that looks like a search which found nothing.
  ADD COLUMN IF NOT EXISTS status                text NOT NULL DEFAULT 'done',
  ADD COLUMN IF NOT EXISTS finished_at           timestamptz;

UPDATE track_record_searches
   SET requested_by_kind = 'staff'
 WHERE run_by IS NOT NULL AND requested_by_kind IS NULL;

-- ── THE BORROWER'S QUEUE, indexed as its own question ────────────────────────
CREATE INDEX IF NOT EXISTS idx_trc_borrower_queue
  ON track_record_candidates(borrower_id, created_at)
  WHERE status = 'staged' AND visibility = 'borrower';

-- ── THE THROTTLE reads this ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_trs_borrower_requested
  ON track_record_searches(borrower_id, run_at DESC)
  WHERE requested_by_kind = 'borrower';

COMMENT ON COLUMN track_record_candidates.decided_by_kind IS
  'db/504. staff | borrower | system. A borrower decision is a CLAIM and lands the line pending; '
  'a staff decline is durable and a borrower decline is not (see importer.stageOne).';
COMMENT ON COLUMN track_record_candidates.visibility IS
  'db/504. Whether the BORROWER may see this candidate. Only a certain-confidence, '
  'grantee-or-grantor, cleanly-parsed candidate from an unambiguous entity match is set to '
  'borrower. Everything else is staff-only — when we are unsure a reviewer looks, not the customer.';
```

**Ordering note that matters.** `migrate-boot.js` runs the numbered migrations on boot of the
deployed code, so the constraint and the code change that satisfies it must ship in the SAME commit.
There is then no window in which old code writes `decided_by` without a kind against a live
constraint.

### 9.3 The code changes the schema implies

| Change | Where | Why |
|---|---|---|
| `importNew` takes the actor kind and writes `entered_by_kind` accordingly | `importer.js:404` — currently hardcodes `'public_records','staff'` | db/458 allows `'borrower'` and **indexes exactly the self-reported-and-pending case** (`db/458:86-88`). A borrower import stamped `staff` is a lie in the trail and hides the row from the queue built to find it |
| `settle` / `decideCandidate` write `decided_by_kind` + the right column | `importer.js:342-379` | The constraint |
| **`stageOne`'s durability check honours only a STAFF decline** | `importer.js:249-256` | §2.5(a). A borrower must not be able to permanently hide a property from every future search. A borrower "no" sets `visibility='staff'` and keeps the row in the reviewer's queue, flagged *"the borrower says this isn't theirs"* — which is itself a signal worth having |
| `already_handled` confirms the imported line still exists | `importer.js:257-259` | §2.5(b). Import-then-delete must not become a permanent suppression |
| `researchProperty` gets a `skipPeople` option | `lookups.js:340-341` | R6. Do not fetch a list of other people on a borrower's dime and then not show it |
| The borrower path uses its own narrower tool allowlist | new module | R6, enforced by absence |

### 9.4 What deliberately does NOT change

- **db/485.** Untouched. Every promoted line lands `pending` because the trigger says so.
- **`track_record_candidates.raw`.** Never written by a borrower.
- **The four verbs.** A borrower gets three of them — `import_new`, `decline` (with weakened
  durability), and an implicit "leave it staged" for Skip. **No `match_existing`**: merging into an
  existing line is a data-reconciliation decision with a verification-reopening consequence
  (`importer.js:457-462`), and it is not a question to put to a borrower. **No `snooze`**: "Skip for
  now" leaves the row `staged`, which is already the right state.

---

## 10. MOBILE — DESIGNED FIRST

Most borrowers will do this on a phone, in the evening, one-handed. Every decision above was made
for that case; here it is explicitly.

| Rule | Why | Where the repo already says so |
|---|---|---|
| **One card fills the screen.** No table, no grid of properties | A table of 8 properties on a 390px screen is a pinch-zoom experience | — |
| **Both answers are 48px tall and ≥16px text** | Under 16px, iOS Safari zooms the page on focus and throws the sheet off screen | `CLAUDE.md` mobile rule; `styles.css:1024-1026` already forces 16px controls under 720px |
| **"Yes" and "No" are EQUAL weight**, side by side | §9.4 says it: *"'Not mine' is as prominent as 'Yes.'"* A primary+ghost pair is a nudge toward yes, on the one question where a false yes is the expensive answer | Blueprint §9.4 |
| **The follow-up is a bottom sheet**, not a centred modal | Thumb reach, and it is the pattern already in the design system | `CLAUDE.md`: *"centred `.cv-modal` overlays become bottom sheets on phones"* |
| **Progress pinned top, actions pinned bottom with `env(safe-area-inset-bottom)`** | The action must not sit under the home indicator | `CLAUDE.md` fixed-bar rule |
| **Zero horizontal scroll.** Address wraps with `overflow-wrap:anywhere`; the figures grid is 2-col collapsing to 1 | A single phantom overflow widens the layout viewport past 720px and switches OFF every mobile breakpoint — the documented cascade | `CLAUDE.md`, the `overflow-x:clip` rule |
| **Undo is a bottom toast**, not a top banner | On a long card a top banner is off-screen, and a failed action reads as nothing happening | Blueprint §8.3 makes the same point for the staff queue |
| **The sheet renders over the iframe, which stays mounted** | Unmounting it loses the tool's state and re-runs its whole boot | `StaticToolFrame` boots on DOM-ready and polls; remounting is expensive |
| **All dialogs go through `showMessage` / `askConfirm` / `askPrompt`** | Never a browser `alert`/`confirm`/`prompt` — a native dialog stamps `yscap.onrender.com says` on our copy, and three build guards fail otherwise | `app-v2/src/lib/dialog.js:87,92,115`; `CLAUDE.md` |
| **Every text colour is an explicit dark hex** (`#141B22` / `#4B585C`) | `--ink*` tokens are LIGHT in this palette. `color: var(--ink)` renders white on white | `CLAUDE.md` hard rule; it has already shipped as a bug twice |
| **Verify at `window.innerWidth === 390`** on an iPhone-12 render, not `scrollWidth - innerWidth` | The latter reads 0 even when the viewport has blown up to 1292 | `CLAUDE.md` |

**One mobile-specific product decision:** the search itself must survive the app being
backgrounded. A borrower presses "Find my properties", locks their phone, and comes back in ten
minutes. The background-job design (§3.4) makes that work; a request-path search would have died
with the connection.

---

## 11. WHAT NOT TO BUILD

Blunt, as asked. Each of these is a version of this feature that leaks data or produces garbage.

1. **A person-name search that shows the borrower everything found under "MOSES WEIL".** The literal
   reading of the owner's sentence. It is the one version that hands a member of the public a
   stranger's holdings, and — the thing to remember — **it is not built today.** `match_person` and
   `get_person_properties` are names in a Set with no wrapper (`lookups.js:64-79`). Building it is a
   deliberate act.
2. **"Select all → import."** The blueprint forbids its twin on the staff side (§9.5) where there
   IS a reviewer. Here it would mean a borrower's single tap adding eight unread properties, at
   least one of which is probably wrong.
3. **Any contact detail, ever.** Never `submit_contact_enrichment`, never `get_contact_info`, never
   `get_contact_status` on a borrower path. Showing a phone number implies we paid for it.
4. **An unthrottled button.** One borrower with fourteen shell LLCs, tapping repeatedly, is 84 calls
   a press against an org ceiling of 1,000/hour that production traffic shares.
5. **Auto-import on "yes".** The borrower's yes stages a claim; it does not verify. Nothing may
   collapse those.
6. **A borrower-visible confidence score, or our findings, or the skips list.** §5.4.
7. **Rewriting the borrower's tool.** Owner-directed, blueprint §12. The seam in §2.3 exists
   precisely so this is unnecessary.
8. **Anything that shows one member of a shared LLC the other members' deals.** R2 is the structural
   guard; do not relax it to "help" a 10% member.
9. **A person-name fallback when the borrower has no entity.** The empty case routes to "add your
   company" (§3.5) or to the type-an-address lookup (§4.6). It must never quietly widen the search.
10. **A silent search.** Every borrower-initiated search writes a `track_record_searches` row and an
    `audit_log` row through the existing borrower `audit()` helper (`borrower.js:73-95`), which also
    records an impersonating staffer if one is standing in the borrower's portal.
11. **A search that fires because a screen rendered.** Blueprint §9.5: *"A screen that shows forty
    properties must not fire forty paid lookups because it rendered."* Applies verbatim here.
12. **Letting a borrower's decline be durable.** §2.5(a). This is the one that looks like a feature
    and is a fraud vector.

---

## 12. THE CONCRETE FLOW

```
BORROWER opens Track record  (TrackRecordScreen.jsx — the shell)
  │
  ├─ shell renders the entry card between .toolsheet-sub and .toolsheet-body
  │    gates: feature on · Elementix on · ≥1 controlled entity · not vetoed   [§3.1]
  │
  └─ taps  [ Find my properties ]
        │
        ├─ POST /api/borrower/track-record-search
        │    · cooldown + 30-day ceiling + class budget checked FIRST         [§3.2]
        │    · INSERT track_record_searches (status='queued',
        │        requested_by_kind='borrower', requested_by_borrower=<me>)
        │    · returns { searchId } IMMEDIATELY
        │    · work runs in setImmediate on its own connection                [§3.4]
        │
        ├─ background: importer.runSearch, borrower-scoped
        │    · entities = controlled only, max 5, verified first              [R1,R2]
        │    · researchProperty per entity, skipPeople:true                   [R6]
        │    · ambiguous entity  → refuse, named                              [R3]
        │    · grantee/grantor only                                           [R4]
        │    · stageOne per candidate; every skip recorded with a reason
        │    · visibility = 'borrower' ONLY when certain; else 'staff'        [R5]
        │    · status='done', finished_at=now()
        │
        ├─ screen polls → "We found 6 that look like yours"
        │
        └─ opens the SHEET (an overlay in the shell; iframe stays mounted)    [§2.3]
              │
              ├─ card 1 of 6  →  Yes / No / Not sure / Skip                   [§5.3]
              │     Yes  → deal type → entity → figures (1 tap) → note
              │            POST /candidates/:id/answer
              │              · decided_by_kind='borrower'
              │              · decided_by_borrower=<me>
              │              · borrower_answer = {…}
              │              · importNew(actorKind:'borrower')
              │                  → track_records row, entered_by_kind='borrower',
              │                    origin='public_records'
              │                  → db/485 forces pending. NOTHING COUNTS YET.
              │                  → promoteEntityName runs (the entity chokepoint)
              │              · audit('borrower_import_track_record')
              │              · reloadTrackRecordFrames()  ← the tool re-pulls   [§2.3]
              │     No   → status='declined', decided_by_kind='borrower',
              │            visibility='staff'  ← NOT durable against staff      [§2.5a]
              │     Not sure → stays staged, visibility='staff', flagged
              │     Skip → stays staged, still borrower-visible
              │
              ├─ … cards 2..6, "n of N" throughout, Undo always visible
              │
              └─ done → "6 properties added — your loan team is checking them"
                        sheet closes, ys-tr-reload fired again, tool shows them
```

Everything the borrower touched then appears in **the staff queue** — the same queue the bulk
workbench renders — with the borrower's answers in the third compare column (§8.4) and the changed
ones sorted first.

---

## 13. THE COPY — every screen, every state

**The entry card**

> ### Import from public research
> We can look up public property records for the companies you've listed and show you what we find.
> You check each one and decide what belongs on your record.
>
> *We only search companies you've told us you own or manage. Nothing is added until you say so.*
>
> `[ Find my properties ]`
>
> Last searched 12 days ago — 9 found, 6 you've checked.

**Running**

> **Looking through public records…**
> This usually takes about a minute. You can close this and come back — we'll keep going.

**Results ready**

> **We found 6 properties that look like yours.**
> Some may not be yours. Check them one at a time — it takes about 20 seconds each.
> `[ Start checking ]`

**Nothing found**

> **We didn't find anything under Ridgeline Holdings LLC.**
> That doesn't mean anything's wrong. Public records are only online in some counties, and recent
> deals can take a couple of months to show up. Add your deals below and we'll take it from there.

**Several companies match**

> **"Summit Capital LLC" matches more than one company in the public records, so we didn't guess.**
> Message your loan team and we'll sort it out for you.

**The card** — §5.3.

**After "Yes"**

> **What kind of deal was this?**
> `[ Fixed and SOLD ]` `[ Fixed and KEPT it ]` `[ Built from the ground up ]`
>
> **Held under** `[ MW TRADING LLC ▾ ]`
>
> **Do these numbers look right?**
> `( ) Yes, that's what happened` `( ) Something's different`
>
> **Anything we should know?** *(optional)*
>
> `[ Add it and continue → ]`
>
> *Your loan team checks this against the paperwork before it counts toward your experience.*

**After "Something's different"**

> **Tell us what's right.** We'll keep both — what the public record says and what you told us — and
> your loan team will sort out the difference.

**After "No, not mine"**

> **Got it — we won't add it.**
> `[ Undo ]`

**After "I'm not sure"**

> **No problem.** We've flagged it for your loan team to look at. You don't need to do anything else
> with it.

**Done**

> **All done — 6 properties added to your track record.**
> Your loan team is checking them against the paperwork. You'll see them marked "Pending review"
> below until then.
> `[ Back to my track record ]`

**Undo toast** (bottom, persistent until the next action)

> ↩ Undo — you marked **118 Oak Ave** as yours.

**Words that must never appear on this screen:** *verified*, *verify*, *confirmed by public records*,
*we found under your name*, any capital-partner or note-buyer name, any other person's name, any
phone number, any confidence score, any document id.

---

## 14. THE PRIVACY RULE, AS A HARD RULE

> ## A BORROWER MAY ONLY EVER BE SHOWN A PROPERTY THAT A RECORDED DEED CONVEYS TO OR FROM A COMPANY THEY THEMSELVES NAMED AND CLAIM TO CONTROL.
>
> Not a person's name. Not a related person. Not an entity they merely hold a minority interest in.
> Not an entity our matcher was unsure about. Not a deed they merely appear on.
>
> **If any one of those is in doubt, the property goes to the staff queue and the borrower never
> sees it.** When we are unsure, a trained reviewer looks — not the customer.
>
> Enforced in four independent places, none of them trusted alone:
> 1. **The search set** is `llcs WHERE borrower_id = <them>` filtered to claimed control. There is no
>    argument any caller can pass that widens it.
> 2. **`candidatesFrom`** discards any deed where the entity is neither grantee nor grantor
>    (`importer.js:112-127`).
> 3. **`visibility`** is a column set at stage time, not a filter a future query has to remember.
> 4. **The borrower path's tool allowlist** does not contain `match_person`,
>    `get_person_properties`, `get_entity_associated_people`, `get_contact_status`,
>    `get_contact_info` or `submit_contact_enrichment` — the rule is ABSENCE, and a test greps for
>    every one of those names.

And the two standing rules this sits under, restated because they are the ones a "helpful"
refactor breaks:

> **A borrower's "yes" is a CLAIM, not a verification.** It writes `pending` and lands in the staff
> queue. db/485 is the backstop and it is not consulted — it is unavoidable.

> **Nothing the search finds lands on the real track record by itself**, borrower-initiated or not.
> The staging table is a different table, so a staged candidate is invisible to every count, tier,
> export and gate structurally rather than by convention.

---

## 15. THE BUILD LIST

Ordered so each step ships independently and leaves the system working.

| # | Step | Depends on | Why here |
|---|---|---|---|
| **1** | **The three holes in `stageOne` / `importNew`** — staff-only decline durability, `already_handled` checks the line still exists, `importNew` takes an actor kind | — | §2.5. These are live defects in shipped code. They are latent while only staff can act; they become exploitable the day a borrower can. Fix them before, not with |
| **2** | **db/504** — decider kind, borrower decider, `borrower_answer`, `visibility`, search lifecycle, the two indexes | 1 | §9. Nothing visible changes |
| **3** | **The borrower-scoped search** — a narrower tool allowlist, `skipPeople`, control-only entity set, the ≤5 cap, `visibility` at stage time | 2 | §4. The privacy gate, before any surface can reach it |
| **4** | **The throttle + the budget class** — cooldown, 30-day ceiling, 60/hr borrower class failing closed, in-flight idempotency | 3 | §3. Before the button exists, not after |
| **5** | **The background search + poll** — `status`/`finished_at`, `setImmediate`, the poll route | 4 | §3.4 |
| **6** | **The borrower routes** in `src/routes/borrower.js`, beside the existing track-record block (`:2841-3220`), scoped on `me(req)`, audited through the existing `audit()` | 5 | Same scoping and audit shape as every other borrower door |
| **7** | **The confirmation sheet** — shared with `02-borrower-confirmation-ux.md`. Whoever ships first owns the component; the second wires an entry point to it | 6 + the sibling | §7. One screen |
| **8** | **The entry card in `TrackRecordScreen.jsx`** + `reloadTrackRecordFrames()` on import and on close | 7 | §2.3. The seam |
| **9** | **The third compare column + "changed" sort** in the staff queue | 2 | §8.4. Without it a reviewer cannot see that the borrower moved a number, which is the whole point of storing it beside |
| **10** | **"Look up an address I already know"** — the personal-name path | 3 | §4.6. Without it, a large ordinary class of borrower finds the feature does not apply to them, with no explanation |

Tests that must exist before this is called done:

- **Pure:** the gate predicate (which entities qualify as an anchor) across every ownership shape;
  the throttle's whole truth table; the copy for every button state.
- **DB:** a borrower decline does **not** block a later staff search of the same property (proven to
  fail with the fix reverted); import-then-delete does **not** permanently suppress; a borrower
  import lands `entered_by_kind='borrower'` and `is_verified=false`; a non-`certain` candidate is
  never returned by the borrower's queue route; the constraint refuses a borrower decider written
  into `decided_by`.
- **Grep:** no borrower-reachable module names any person or contact tool.
- **Browser:** the sheet at `window.innerWidth === 390` with zero horizontal overflow, both answer
  buttons ≥44px, dark text on an opaque card.

---

## 16. OPEN QUESTIONS FOR THE OWNER

1. **The personal-name case.** The recommendation gives a borrower who bought in their own name
   nothing but the type-an-address lookup (§4.6). Is that acceptable, or is a personal-name search
   wanted badly enough to accept the disclosure risk — and if so, only after a staffer has screened
   the list (which makes it §9.4's flow, not this one)?
2. **On by default, or staff-enabled per borrower?** §3.1 recommends on-by-default once the global
   switch is on, with a staff veto. The stricter alternative kills self-service.
3. **The 24-hour cooldown and the 3-per-30-days ceiling** are judgements, not findings. Too tight?
4. **Should a borrower's "not mine" be shown to the reviewer as a flag, or logged quietly?** §2.5(a)
   recommends a visible flag, because a borrower declining a property they owned is a signal. It is
   also a slightly adversarial reading of a customer's answer.
5. **Does the borrower see properties staff staged but have not worked yet**, or only ones staff
   released to them? §7 assumes one merged list; the alternative is a staff "send to borrower"
   action per property, which is safer and slower.

---

## 17. WHERE THE EVIDENCE IS THIN — stated rather than dressed up

- **Nobody has measured how long a one-borrower search actually takes.** 4–30 calls at ≤3/sec plus
  vendor latency suggests 10–60 seconds; that is arithmetic, not a measurement. The background-job
  design is right either way, but the "about a minute" copy should be checked against a real run.
- **The 60 calls/hour borrower class is a starting value**, chosen to be visibly small against
  PILOT's 400 and the org's 1,000. Nobody can currently see the rest of the organization's usage —
  `05-…` §2 makes that point and it applies here.
- **The vendor's behaviour on an ambiguous entity match has not been probed from a borrower's
  data.** `lookups.js` refuses to pick, which is right; how OFTEN it refuses on real borrower entity
  names is unknown, and if it is common the feature is much less useful than it looks.
- **The co-member leak is mitigated by R2, not eliminated.** A borrower with 50% of a two-member LLC
  still sees that LLC's whole portfolio, including deals their partner sourced. That is defensible —
  they are a controlling member of the entity that owns them — but it is a judgement, not a proof.
- **I have not read `02-borrower-confirmation-ux.md`** — it did not exist when this was written.
  §5.3, §7 and step 7 of the build list are written to compose with it; if that document lands a
  different card, **its card wins** and this document keeps the entry point, the privacy gate, the
  throttle and the schema.

---

## SOURCES — read in the repo, not recalled

`docs/TRACK-RECORD-REBUILD-BLUEPRINT.md` §0, §1 (D2, D3, D5, D6, D13), §2.2, §8.3, §9.1–9.5, §12,
§13 · `src/lib/track-record/importer.js` (whole file) · `db/496_track_record_candidates.sql` ·
`db/485_track_record_always_pending.sql` · `db/458_track_record_entry_review.sql` ·
`db/495_track_record_entity_spine.sql` · `db/503_elementix_call_ledger.sql` ·
`src/lib/elementix/lookups.js` · `src/elementix/client.js` · `src/lib/track-record/checks.js`
(header) · `src/lib/track-record-entity.js` · `src/routes/borrower.js` (:73 audit, :2011-2117 LLCs,
:2841-3220 track records) · `src/routes/staff.js:11217-11290` · `web/v2/tools/track-record.js` ·
`web/v2/tools/track-record-portal.js` · `app-v2/src/screens/TrackRecordScreen.jsx` ·
`app-v2/src/components/StaticToolFrame.jsx` · `app-v2/src/lib/dialog.js` · `app-v2/src/styles.css` ·
`src/lib/rate-limit.js` · `db/482_api_rate_limits.sql` · `src/lib/borrower-safe.js` · `CLAUDE.md` ·
sibling `docs/research/elementix/05-budget-and-resilience.md` §1–2.
