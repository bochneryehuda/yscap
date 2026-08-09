# 06 — A document knows what it is and everywhere it belongs

*Research. Nothing here is built. Every file:line is against the working tree on
`claude/track-record-workflow-review-dml475`.*

The owner's worked example, verbatim:

> "if you request an operating agreement for a certain entity, the system should realize by itself
> that the document that is going to be attached to that condition is an operating agreement to that
> entity. That document should also be fed to the entity section, because that LLC will open up an
> LLC on the borrower's profile, so that operating agreement should be added over there. This is how
> deep systems should go, and it should go even deeper, integrated with all the details of the
> system, deeper than ever before."

---

## 0. The verdict up front

**The owner is describing something PILOT already does — three times, in three unconnected places,
for three other reasons — and does not do for the case he actually named.**

This is not a build-from-scratch feature. It is a *wiring* job over parts that already exist, are
already tested, and already encode the hard decisions (bytes copied not shared, nothing
auto-accepted, a verified entity never written into). What is missing is a single chokepoint and
about five call sites.

Three findings that reframe the work:

1. **The ASK already declares everything the router needs, and nothing reads it.**
   `doc-request.js` writes `target`, `slot`, `llcId`, `docType` and `pillar` into
   `checklist_items.origin_detail` and the entity into `raised_entity`
   (`src/lib/track-record/doc-request.js:262-272`). A repo-wide grep finds **no consumer of that
   `slot` anywhere in `src/`** — it is asserted only by the unit test
   (`scripts/test-track-record-doc-request-pure.js:124`). The declaration is written, tested, and
   dead.

2. **The copier the owner is describing already exists and is already shared.**
   `entity-adopt._internals.copyDocumentIntoSlot` (`src/lib/underwriting/entity-adopt.js:266-314`)
   copies a document's bytes onto an entity's `rtl_llc_*` slot, records `source_document_id`
   lineage, dedupes on sha256, bumps the slot to `received` and refuses a verified entity. A second
   feature already reuses it across module boundaries — `src/lib/esign/draw-oa.js:207`.

3. **The Check A cascade the owner wants exists and has exactly one caller.**
   `track-record-ownership.syncEntityToTrackRecords`
   (`src/lib/track-record-ownership.js:132-208`) fans one entity's verification onto every
   track-record line it held. It is called from **one place**: `src/routes/staff.js:10982`, the
   entity-screen "verify ownership" button. Accepting an operating agreement does not call it.

So the honest summary of the gap: **PILOT can recognise the document, can file it in the entity's
slot, and can cascade the result — but the three are not on the same wire, and the one place a
document actually lands (the upload door) knows none of it.**

---

## 1. What already exists — the five implementations

Before proposing anything, name what is here. Each of these is a partial answer to
"a document knows where it belongs", built for a different trigger.

| # | Module | Trigger | What it routes | Auto-accepts? |
|---|---|---|---|---|
| 1 | `underwriting/entity-adopt.js` `adoptEntityToProfile` (`:154`) | a human's **button** on a bank-statement finding | entity created/reused → slots generated → **every** entity document on the file copied onto its matching slot → `rtl_cond_entity_docs` posted | No (`:308-311`) |
| 2 | `esign/draw-oa.js` `onAccepted` (`:169`) | a human's **accept** on the draw-wire OA condition | entity created/reused → slots generated → **that one** OA copied onto `rtl_llc_opagmt` | No (reuses #1's copier, `:207`) |
| 3 | `esign/draw-oa.js` `autofillFromProfile` (`:122`) | the wire capture **raising** the condition | the **reverse** — an accepted OA already on the profile is copied **onto** the new condition | No (`:110`) |
| 4 | `track-record-entity.js` `promoteEntityName` (`:151`) | a typed entity name on a track-record line | free text → a real `llcs` row + `llc_borrowers` link | n/a |
| 5 | `track-record-ownership.js` `syncEntityToTrackRecords` (`:132`) | a human's **verify** on the entity screen | Check A → every track-record line's ownership pillar (`auto_verdict` only) | n/a — writes `auto_*`, never `human_*` |

**#1 and #2 are the same four steps written twice.** Compare
`entity-adopt.js:165-218` with `draw-oa.js:181-212`: find-or-create through `llc.findOrCreateLlc`,
`generateLlcChecklist`, stamp `adopted_from_application_id`, `llc-borrowers.linkBorrower`, copy into
the slot, and an `afterCommit` that runs `syncLlcConditions` + `sharepoint-backup.kick()`
(`entity-adopt.js:251-254`, `draw-oa.js:218-222`). They differ only in **where the entity name comes
from** (a finding's `doc_value` vs `draw_wire_instructions.account_name`) and **which documents are
carried** (all matching vs the one just accepted).

That is the shape of the general module. A third caller — the owner's case, where the entity name
comes from `raised_entity` on the request — is a third `nameOf()` and nothing else.

---

## 2. Recognition — how confidently can PILOT know what a document IS and whose it is?

### 2.1 The existing ladder, and where it lives

`auto-read.selectAutoReadQueue` (`src/lib/underwriting/auto-read.js:47-56`) already encodes a
three-rung ladder, and its comments record what each rung is worth. In descending order of
certainty:

```
expectedDocTypeForCode(d.condition_code)          ← the ASK
  || (d.doc_kind && isReadable(d.doc_kind))       ← the KIND
  || expectedDocTypeForCode(d.slot_label)         ← the human's SLOT label
  || null                                         ← ABSTAIN (left for a human)
```

`expectedDocTypeForCode` is the inverse of `condition-map.DOC_CONDITIONS`, built once so the two
directions cannot drift (`src/lib/underwriting/condition-map.js:57-71`).

### 2.2 The full ladder for THIS problem — ranked, with failure modes

**Rung 1 — the ASK. The strongest signal, and by far the cheapest.**

For a typed track-record request the condition row already carries, in `origin_detail`
(`doc-request.js:262-266`):

```json
{ "raisedAgainst":"track_record", "entityId":"<trId>", "docType":"operating_agreement",
  "pillar":"ownership", "target":"entity", "slot":"rtl_llc_opagmt",
  "llcId":"<uuid>", "entityName":"MW Trading LLC" }
```

and in `raised_entity` (`:270-272`): `{kind:'llc', id, name}`.

The `field_key` carries the same three facts in one word — `trdoc:<trId>:<slug>:<pillar>`
(`doc-request.js:118-124`) — and `parseFieldKey` (`:127-133`) is the reader, already used by the
workspace (`src/lib/track-record/workspace.js:188`).

*Confidence:* **near-certain about the TYPE and the ENTITY.** A human picked both from a
server-fed vocabulary (`GET /track-record-doc-types`, `src/routes/staff.js:11335-11339`), and
`buildRequest` refuses an entity document with no `llcId` (`doc-request.js:186-188`).

*Where it fails:* it tells you what was **asked for**, never what was **uploaded**. A borrower who
uploads their driver's licence into the operating-agreement request satisfies rung 1 perfectly.
Rung 1 must therefore never be the *only* rung — it decides ROUTING, and rung 2 decides
CONTRADICTION. See §6.

*The live defect at this rung:* on the borrower's own track-record upload
(`src/routes/borrower.js:3145-3150`) the document is attached to

```sql
WHERE track_record_id=$1 AND item_kind='document' AND audience IN ('borrower','both')
  AND status IN ('outstanding','requested','issue')
ORDER BY created_at LIMIT 1
```

— **the oldest open request for the line, whichever ask that happened to be.** That is verbatim the
bug `doc-request.js:13-14` says the typed ask fixed:

> "The upload landed on the oldest open request for the line, whichever ask that happened to be."

The ASK was fixed; the UPLOAD was not. A borrower asked for a deed (ownership) *and* a closing
statement (exit) on one property who uploads the deed has it filed against whichever condition is
older, and the wrong pillar is credited. This is the single highest-value fix in this whole
document and it is four lines.

**Rung 2 — the extracted CONTENTS.**

`document_extractions.fields` carries `entityLegalName` for all four entity types
(`facts.js:179-182`), read by the analyzer against the registry schema
(`src/lib/underwriting/registry.js:63-79`). `entity-adopt.matchEntityDocs`
(`entity-adopt.js:113-137`) already does exactly the join this needs: doc_type → slot, and
`entityMatch(legal, want)` for the name.

*Confidence:* **high when the read succeeds, and it says so.** `unreadable()` in
`doc-checks.js:130` degrades an OA with no `entityLegalName`/`managingMember`/`members` to a
"verify by hand" finding rather than a claim.

*Where it fails:* extraction is not free (paid OCR + model), it is **asynchronous** (the auto-read
queue runs on the file view, not on upload), and it is **slot-driven** — the document is read under
the schema of whatever slot it landed in, which is the root cause `misfiled-document-advisory.js:6-11`
documents. So rung 2 arrives *after* rung 1 has already routed. That is fine and is the right
order: rung 1 files it, rung 2 challenges it.

**Rung 3 — the filename and the classifier.**

`classify.js` `SIGNALS` + `FILENAME_HINTS` is pure, offline and dependency-free
(`src/lib/underwriting/classify.js:15-90`), with `operating_agreement` anchored on strong phrases
("operating agreement", "managing member", "membership interest") and
`/operating\s*ag|op\s*agmt/i` on the filename.

*Confidence:* **suggestive only.** Its own header says it "never guesses onto the file: a
low/none confidence returns docType null so the underwriter picks."

*Where it fails:* `OA.pdf`, `scan_0001.pdf`, `Document (3).pdf`. The FILENAME_HINTS list has
ordering traps already documented in place — `payoff_statement` must precede `bank_statement`
because "payoff statement" contains "statement" (`classify.js:~110`).

**Rung 4 — `doc_kind`.**

Set by **exactly one caller** at the staff door: `docKind === 'term_sheet'`
(`src/routes/staff.js:15421`, and the comment at `:15450-15453` says so explicitly — "a human
uploading a document never passes docKind"). The borrower door sets `track_record_doc` and
`photo_id`.

*Confidence:* **certain when present, absent almost always.** It is a producer's self-declaration,
not a reading. Useful as a tiebreak, never as a primary.

### 2.3 The abstain rules

These are the rules that must be written down, because each one is a place where a guess costs more
than silence.

| Situation | Verdict | Why |
|---|---|---|
| The condition is not a typed `trdoc:` ask (`parseFieldKey` returns null) | **ABSTAIN** — file normally, route nothing | An untyped free-text ask (`raise-issue.js`) declares no target. Guessing from the label re-invents the `window.prompt` problem the typed ask exists to kill. |
| `target !== 'entity'` | **ABSTAIN from the entity leg** | A deed is a property document. It has a second home (§7) but not this one. |
| `origin_detail.llcId` is null | **ABSTAIN** | `buildRequest` refuses to create such a request (`doc-request.js:186`), so a null here means a legacy row or a hand-edit. Never re-derive the entity from `track_records.entity_name` free text at routing time — that is `promoteEntityName`'s job, and it has its own ambiguity rule (`track-record-entity.js:165-172`). |
| The entity is `is_verified = true` | **ABSTAIN, and say so** | The portal refuses uploads into a verified entity (`src/routes/staff.js:15371`), and `copyDocumentIntoSlot`'s caller already skips with `entity_already_verified` (`entity-adopt.js:203-205`). |
| Extraction says `entityMatch(legal, want) === false` | **ROUTE ANYWAY, RAISE A FINDING** | The ask is the routing authority; a contents mismatch is a *review* problem, not a filing problem. Withholding the copy hides the wrong document instead of surfacing it. See §6. |
| `entityMatch` returns `null` (unreadable) | **ROUTE, no finding** | Never fabricate a mismatch from an absent read — the standing never-fabricate rule. |
| Two of the borrower's entities could be meant | **ABSTAIN** | Not reachable through the ask (it carries an id), but reachable through the reverse direction (§5). `pickEntity` already returns `{ambiguous, names}` (`track-record-entity.js:133-138`). |

---

## 3. The end-to-end wire for the owner's own example

**"Request an operating agreement for MW Trading LLC on a track-record line → borrower uploads."**

Step by step, naming the existing function and the missing glue.

### Step 0 — the entity must be real before the ask can name it

`buildRequest` refuses an entity ask with no `llcId` (`doc-request.js:186-188`). So MW Trading LLC
has to be an `llcs` row already.

- **Exists:** `track-record-entity.promoteEntityName` (`:151-206`) turns the typed
  `track_records.entity_name` into a real entity, links `llc_borrowers`, and stamps
  `first_seen_on='track_record'`. Ambiguity writes nothing (`:165-172`).
- **Exists:** `llc.findOrCreateLlc` (`src/lib/llc.js:513-534`) is the repo's one create chokepoint,
  race-safe on `23505`.
- **Missing glue:** nothing. This half is done.

### Step 1 — the ask

`POST /track-records/:id/request-doc {docType:'operating_agreement', pillar:'ownership', llcId}`
(`src/routes/staff.js:11361-11393`) → `doc-request.requestDocument` (`:222-348`).

Writes one `checklist_items` row, owner = the file (or the borrower with no file), `field_key =
trdoc:<trId>:operating_agreement:ownership`, `track_record_id` set, `raised_entity =
{kind:'llc',...}`, `origin_detail` carrying `target:'entity'` and `slot:'rtl_llc_opagmt'`.

Borrower reads: *"We need the operating agreement for MW Trading LLC to confirm your ownership of
62 Highland Street."* (`borrowerSentence`, `:142-157`).

- **Exists:** all of it, including the `chk_one_owner` discipline (`db/schema.sql:250-254` — exactly
  one of application_id / borrower_id / llc_id, which is why the company rides in `raised_entity`).
- **Missing glue:** nothing.

### Step 2 — the upload lands

Borrower uploads on the condition → `POST /api/borrower/documents`
(`src/routes/borrower.js:3217`), or on the line → `:3140`. Staff mirror →
`POST /applications/:id/documents` (`src/routes/staff.js:15357`).

What the doors do today:
- dedupe (`doc-dedup.recentDuplicateDocId`),
- set `track_record_id` from the item (`staff.js:15406`),
- bump `track_records.docs_status` to `received` (`staff.js:15466`),
- `reopenConditionEvidence` (`staff.js:15495`),
- push the condition status to ClickUp,
- `sharepoint-backup.kick()`.

**Missing glue — this is the hole.** Neither door reads `origin_detail`, `raised_entity`, or
`parseFieldKey(field_key)`. The document is filed against the condition and the property and
**stops there**.

### Step 3 — the entity leg (the owner's actual ask)

What should happen, and what already exists to do it:

| Action | Existing function |
|---|---|
| resolve the entity | `raised_entity.id` — no lookup needed |
| make sure its slots exist | `routes/borrower.generateLlcChecklist(llcId, client)` (`:4353`) |
| copy the bytes onto `rtl_llc_opagmt` | `entity-adopt._internals.copyDocumentIntoSlot` (`:266-314`) |
| link the borrower as an owner | `llc-borrowers.linkBorrower` (`:18-26`) |
| refresh every vesting file's LLC condition | `llc.syncLlcConditions` (`:287-362`) |
| mirror | `sharepoint-backup.kick()` |
| the post-commit ordering rule | `entity-adopt.afterAdoptCommit` (`:251-254`) — and its header explains WHY: `syncLlcConditions` opens its own connection, so calling it inside an open transaction finds nothing and "succeeds" having done nothing |

**Missing glue:** one function that calls those six in order, invoked from both upload doors.

Note what the copy buys and why it must be a copy: **purging a file deletes the bytes of every
document carrying its `application_id`, deliberately sparing entity documents because they are keyed
on `llc_id`** (`entity-adopt.js:259-264`). A shared `storage_ref` would take the profile's copy down
with the loan file — defeating the whole "available for the future on his profile" point.

### Step 4 — the ownership pillar (Check A)

**Nothing happens today.** `track_record_pillars` is written by two things only:
`verify-run.js:132` (which reads **public records**, not documents) and
`track-record-ownership.js:189` (which runs only from the entity-verify button).

So an accepted operating agreement moves no pillar on any property. See §4.

### Step 5 — the SharePoint mirror

The byte-copy produces **two rows**, and the mirror already routes them to two different places:

- the original (carries `track_record_id`) → `scopeKeyFor` returns `borrower:<id>`
  (`sharepoint-backup.js:493-495`) and `categoryPathFor` returns
  `['REO', <address>]` (`:470-472`) → **`…/REO/62 Highland St/`**
- the copy (carries `llc_id`) → `categoryPathFor` returns `[llc_name, llcSubfolder(row)]`
  (`:451`) → **`…/MW TRADING LLC/Operating Agreement/`**

Both are correct and both are wanted. The mirror needs **no change** — it falls out of the copy.
`sharepoint-shelf` then holds each copy on "Waiting for review" until a verdict lands (db/425).

### Step 6 — the TPR export

`tpr-export.categoryFor` (`:176-201`) is the ONE categorizer shared by the investor export and the
mirror. Today:
- the original, on `rtl_p3_reo` → `C.REO` (`:139`)
- the copy, carrying `llc_id` → `C.LLC` at rule 2 (`:189`) — *before* the code lookup, so it lands
  in `LLC/` whatever condition it hangs off

Both correct. Blueprint §4.4a wants a step further — an `Entities/<NAME>/` tree with a
`Properties held.txt` — which is a separate, later piece of work and is **not** required for the
owner's example to work.

Acceptance gates the export either way: `document-acceptance.ACCEPTED_SQL` (db/424), and the copy is
deliberately born pending (`entity-adopt.js:308-311`).

### The wire, drawn

```
  request-doc  ──►  checklist_items
                     field_key    trdoc:<tr>:operating_agreement:ownership
                     raised_entity {kind:'llc', id, name:'MW Trading LLC'}
                     origin_detail {target:'entity', slot:'rtl_llc_opagmt', pillar:'ownership'}
                             │
      borrower uploads ──────┤
                             ▼
                    ┌──── THE UPLOAD DOOR ────┐      ← the missing chokepoint
                    │  parseFieldKey / origin  │
                    └───┬──────────────┬───────┘
        (already works) │              │ (MISSING)
                        ▼              ▼
      documents.track_record_id   copyDocumentIntoSlot → rtl_llc_opagmt
      docs_status → received      generateLlcChecklist / linkBorrower
      condition   → received      syncLlcConditions   (post-commit)
                        │              │
                        ▼              ▼
             REO/62 Highland St   MW TRADING LLC/Operating Agreement
                        │              │
                        └──────┬───────┘
                               ▼  a human ACCEPTS the copy on the entity slot
                               ▼  a human VERIFIES Check A on the entity
                        syncEntityToTrackRecords          (exists; one caller)
                               ▼
                    every line held by MW Trading LLC:
                    ownership pillar auto_verdict = 'proved' / 'no_data'
                               ▼
                    a human confirms the pillar          (human_verdict)
```

---

## 4. Check A is the prize

Blueprint §2.2: *"If we verify ownership of these two LLCs, then all the ownership of all the
properties is verified."* Ten properties across two entities = **two Check A's and ten small Check
B's**.

### What exists

`syncEntityToTrackRecords` (`track-record-ownership.js:132-208`) is complete and correct:

- walks descendants via `llc.getDescendantEntityIds` so a subsidiary's property inherits the
  parent's Check A (`:145`);
- joins `llc_borrowers` for `ownership_verified` and the membership window (`:149-157`);
- writes **`auto_*` only** — `human_verdict` is not in the statement (`:189-196`), enforcing db/494's
  own doctrine that nothing automatic satisfies a pillar;
- on revoke, clears **only what it carried** (`satisfied_by_llc_id IS NOT NULL`, `:175`) and reports
  human-confirmed pillars rather than erasing a person's decision (`:166-169`);
- never throws (`:203-207`).

`ownershipVerdict` (`:83-123`) is the pure decision, with the four outcomes kept distinct, and
`withinMembership` (`:57-77`) has the two rules that matter: **unknown is not a contradiction**
(`:68-69` — "reading that as 'they did not hold it' would contradict essentially the whole back book
on the day this ships") and **a contradiction needs a provable overlap failure** (`:74-75`).

### What is missing

**One caller.** `src/routes/staff.js:10982` is the only invocation. Specifically:

1. **Accepting an operating agreement on an entity slot does not run it.** The document-review route
   (`staff.js:15673`) has an `action === 'accept'` hook for exactly this shape — `draw-oa.onAccepted`
   at `:15818-15827` — and no equivalent for the entity's own slot.

2. **`llc.syncLlcConditions` and `syncEntityToTrackRecords` are siblings that never run together.**
   `syncLlcConditions` fans an entity's state onto **loan files**; `syncEntityToTrackRecords` fans it
   onto **properties**. Every caller of the first (`llc.js:287`, called from the LLC upload path,
   the review path, the verify path, `entity-adopt.afterAdoptCommit:252`, `draw-oa.afterAcceptCommit:220`)
   is a place the second should also run.

3. **Check B has no document-sourced input.** `syncEntityToTrackRecords` takes `opts.checkB` as a
   callback and the one caller passes `(row) => (row.satisfied_by_llc_id || b.assumeCheckB ? … : null)`
   (`staff.js:10983-10984`) — i.e. Check B is currently either already-carried or a caller assertion.
   `track-record/checks.js` computes Check B from public records; a **deed uploaded on a `trdoc:`
   request** is a document-sourced Check B and nothing reads it.

### What stops the cascade — and each stop must be legible

| Stop | Where enforced | What the reviewer must see |
|---|---|---|
| Entity not verified (`llc_borrowers.ownership_verified` false) | `ownershipVerdict:84` returns null | **Nothing is written on the property.** Deliberate: "the entity is not verified" is a fact about the ENTITY (`track-record-ownership.js:39-42`). The message belongs on the entity screen, not stamped on ten properties. |
| Check A holds, Check B unproven | `:113-122` → `no_data` | *"…but we have not yet confirmed that this entity is the one that held this property."* Names **which** check. |
| Holding period outside membership window | `:87-97` → `contradicted` | *"sold before the borrower joined"* / *"bought after they left"*. Loud, and never the same as `no_data`. |
| No membership dates recorded | `withinMembership:68` → `ok` | The common case. Must never read as a contradiction. |
| A human already confirmed, then the entity is revoked | `:166-169` | Left standing, **reported** in `out.humanConfirmed` for the caller to raise `entity_unverified`. |
| The pillar is `auto`, not `human` | db/494 | The sign-off gate reads `human_verdict`. A cascade makes confirming **one click** — it does not confirm. |

**The design point worth stating out loud:** an accepted operating agreement should trigger the
cascade, but the cascade should still produce `auto_verdict='proved'` and stop. `pillar-actions.js`
has the reason (`:14-19`): *"a reviewer working at speed presses the primary button, so the primary
button must never be the one that CREDITS a borrower on evidence nobody has."* Confirm becomes
primary only when the machine already proved it — which is exactly the state the cascade creates.

---

## 5. The reverse direction — a document that finds its home

A document lands somewhere else and turns out to be an operating agreement for an entity we already
know.

### Both directions already exist, in one file

`draw-oa.js` implements **both**:
- **outward** (condition → profile): `onAccepted` (`:169-215`)
- **inward** (profile → condition): `autofillFromProfile` (`:122-157`) — when the wire form names an
  entity the borrower already has *with an accepted OA on its slot*, that agreement is copied **onto
  the new condition** so the coordinator has a head start.

`autofillFromProfile` is the reverse chokepoint, in miniature, and it already encodes the two rules
that matter: it copies **only an ACCEPTED** agreement (`:143`, via `ACCEPT.ACCEPTED_SQL`), and it
**no-ops when the condition already has a document** (`:128-129`).

### The other reverse path

`entity-adopt.adoptEntityToProfile` step 5 (`:188-218`) sweeps the file's **current extractions**
for entity documents matching a name (`matchEntityDocs`, `:113-137`) and carries them all. Its
trigger is a bank statement naming an unknown holder — i.e. *"we discovered an entity; go find every
document on this file that belongs to it."*

### The general chokepoint

There isn't one. There are two half-chokepoints with different scopes:

| | `entity-adopt` | `draw-oa.autofillFromProfile` |
|---|---|---|
| trigger | a finding + a human's button | a condition being raised |
| direction | file's documents → entity slots | entity slot → a file condition |
| matching | `entityMatch` over extractions | `drawWire.entityMatch` over `llcs` names |
| scope | all four entity doc types | operating agreement only |

**What a general one needs, and where the pieces are:**

1. **A name→entity resolver that abstains.** `track-record-entity.pickEntity` (`:133-138`) already
   returns `{llcId} | {ambiguous, names} | {none}`, built on `promotionMatch` (`:103-124`), which
   deliberately **drops `entityMatch`'s substring arm** because "Hudson Properties LLC" and
   "Hudson Properties LLC II" are different companies (`:20-33`). That is the right matcher for
   routing; `entityMatch` is the right matcher for *raising a question*. Do not swap them.
2. **A doc_type→slot map.** `entity-adopt.SLOT_FOR_DOC_TYPE` (`:50-55`) — and
   `doc-request.DOC_TYPES` already carries the same four codes (`doc-request.js:88-91`), which the
   unit test pins as identical (`test-track-record-doc-request-pure.js:42-44`).
3. **A copier.** Two exist and they copy in **two directions**:
   `entity-adopt.copyDocumentIntoSlot` (onto an `(llc, slot)` checklist item) and
   `draw-oa.copyDocumentToItem` (onto an arbitrary checklist item). Both are ~35 lines, both dedupe
   on `source_document_id` OR `sha256`, both land `received`, neither auto-accepts. **They should be
   one function with a target parameter.**
4. **A trigger.** The honest answer: **the extraction pass**. `document_extractions` is written for
   every auto-read document; a row with `doc_type IN (the four)` and a readable `entityLegalName` is
   the moment PILOT *learns* what a document is. That is the natural home for the reverse direction —
   and it is already the trigger `misfiled-document-advisory.syncMisfiledDocumentAdvisory` uses
   (`:83-85`).

**But the reverse direction must SUGGEST, not act.** See §9.

---

## 6. The wrong-document case — this must fail safe

Two shapes, and they are not the same problem.

### 6.1 A driver's licence in the operating-agreement slot

**What catches it today:**

1. `doc-checks.computeOperatingAgreementFindings:139-165` — the `oa_not_the_operating_agreement`
   check. This is already the right shape and its comment is worth reading in full: articles of
   organization read under the OA schema answer *"signed: no"* honestly, and that honest answer
   became "a CTC-blocking FATAL accusation against the borrower's actual agreement." The fix was
   `isTheAgreement` — only an OA carries **members with ownership percentages** and a **management
   type**. Without those markers the finding becomes *"we have not been given the agreement"*, not
   *"your agreement is unsigned"*.
2. `misfiled-document-advisory.assess` (`:49-62`) — the AI's own `docNature` +
   `matchesFiledType === false` + `confidence >= 0.75`, raising an advisory
   *"This document looks like a {X}, not the {slot} it was filed under."* Advisory only, withdraws
   itself, never re-classifies.
3. `unreadable()` (`doc-checks.js:130`) — an OA with none of `entityLegalName` / `managingMember` /
   `members` degrades to a verify-by-hand finding.

**What the reviewer sees:** the finding on the underwriting desk, plus the advisory card. **What
must NOT happen:** the copy must still go onto the entity slot. Withholding it hides the wrong
document on the loan file where nobody looking at the entity will ever see it; and the slot bumping
to `received` with a fatal finding attached is exactly the state a reviewer needs — *there is
something here and it is wrong*. The reviewer rejects it, `reopenConditionEvidence` fires
(`staff.js:15743`), and the slot reopens.

### 6.2 An operating agreement for a DIFFERENT company — and a real defect

**This is the one that is genuinely broken today, and the defect is subtle.**

`registry.operating_agreement` declares `subject: 'entity'`
(`src/lib/underwriting/registry.js:63-66`). `file-view.subjectFor` for `'entity'` returns
`{ entity_name: vestingName, borrower_name }` (`src/lib/underwriting/file-view.js:244`) — the
**FILE's vesting entity**.

But the owner's operating agreement is for **MW Trading LLC, a track-record entity**, which is
almost never the vesting entity on the loan that is buying 62 Highland Street. So:

- `facts.DOC_CLAIMS.operating_agreement` claims `entity_name: f.entityLegalName`
  (`facts.js:179`),
- the `entity_name` fact is **`severity: 'fatal'`** (`facts.js:86`),
- and it is compared against `c.vestingName`.

**Result: a correct operating agreement for the correct track-record entity produces a FATAL
`entity_name` mismatch against an unrelated vesting LLC.** That is a false positive on a
CTC-relevant severity, and it is the same class as the tax-cert-vs-buyer-LLC bug
`facts.js:140-148` already documents ("comparing it to the vesting LLC produced a
guaranteed-nonsense FATAL mismatch pre-close").

**The fix is the same shape as the one already applied there:** an extraction whose document is
filed on a `trdoc:` condition must be judged against **the entity the ASK named**, not the file's
vesting entity. The subject builder needs the condition's `raised_entity` — which it does not
currently receive.

Notice also what `computeOperatingAgreementFindings` does **not** do: it never compares
`entityLegalName` to any expected entity at all (`doc-checks.js:128-201`). It checks percentages,
signature, borrowing authority, layered members, and managing-member-vs-borrower — but not "is this
the right company". That check lives only in the tie-out, which is pointed at the wrong entity.

**So the wrong-company case needs both halves:**
- point the subject at the right entity (kills the false positive), **and**
- add the affirmative check (catches the real positive) — reusing `entityMatch`, which returns
  `true | false | null`, so an unreadable name raises nothing.

### 6.3 Fail-safe rules

| Rule | Rationale |
|---|---|
| A recognition failure **never blocks the upload** | The document is already in the building; refusing to file it loses it. |
| A recognition failure **never blocks the copy** | Hiding the wrong document from the entity screen is worse than showing it. |
| A recognition failure **always produces a finding** | Silence is the failure mode this whole repo is built against. |
| A copy is **never auto-accepted** | `entity-adopt.js:308-311` — a reviewer still confirms the agreement names the borrower as managing member / 25%+ owner. |
| An `entityMatch` of `null` raises **nothing** | Never fabricate a mismatch from an absent read. |
| The entity is **never verified** by any of this | Check A is a human's decision (`staff.js:10940-10945` — "verified with no stated basis is the thing this whole rebuild exists to stop"). |

---

## 7. Generalise it — the full routing table

*"Deeper than ever before."* Which of the 15 `DOC_TYPES` have a second home?

The declaration already exists in `doc-request.js:74-93` as `target: 'property' | 'entity'`. That
binary is **too coarse** — several property documents have a real second home that is neither the
property nor an entity.

### The table

| # | `DOC_TYPES` slug | Primary home (today) | SECOND home | Mechanism | Status |
|---|---|---|---|---|---|
| 1 | `operating_agreement` | track-record line | **entity → `rtl_llc_opagmt`** | `copyDocumentIntoSlot` | declared, **unwired** |
| 2 | `articles_of_organization` | track-record line | **entity → `rtl_llc_formation`** | same | declared, **unwired** |
| 3 | `ein_letter` | track-record line | **entity → `rtl_llc_ein`** | same | declared, **unwired** |
| 4 | `certificate_of_good_standing` | track-record line | **entity → `rtl_llc_goodstanding`** | same, **+ 30-day expiry** (`llc.js:28-29`, `getSlots:153-165`) | declared, **unwired** |
| 5 | `deed` | track-record line | **the ownership pillar's Check B evidence** | `track_record_pillars.auto_evidence` | not declared |
| 6 | `closing_statement` (HUD/ALTA) | track-record line | **whichever pillar the ask named** — ownership on a purchase, exit on a sale | requester picks the pillar (`doc-request.js:70-72`) | not wired |
| 7 | `recorded_mortgage` | track-record line | **exit pillar** (a satisfaction/payoff proves the exit) | pillar evidence | not wired |
| 8 | `payoff_statement` | track-record line | **exit pillar**; and on a LIVE refi, `cond_payoff_external` (`tpr-export.js:128`) | pillar evidence | not wired |
| 9 | `lease` | track-record line | **exit pillar** (a hold exits by lease); and DSCR rent evidence | pillar evidence | not wired |
| 10 | `tenant_estoppel` | track-record line | exit pillar | pillar evidence | not wired |
| 11 | `certificate_of_occupancy` | track-record line | exit pillar (a ground-up completes); **`rtl_p1_plans`** on a live construction file (`condition-map.js:43`) | pillar evidence | not wired |
| 12 | `schedule_e` | track-record line | **the BORROWER profile** — one tax return proves ownership of *several* properties at once | borrower-level document | not wired |
| 13 | `bank_statements` | track-record line | **entity or borrower**, via the holder — `entity-adopt` already routes this class | `adoptEntityToProfile` | wired for the *finding*, not the *request* |
| 14 | `property_profile_report` | track-record line | ownership pillar (weak grade) | pillar evidence | not wired |
| 15 | `other` | track-record line | — (abstain by construction) | — | correct as-is |

### Beyond the 15 — the same class elsewhere in the file

| Document | Primary home | SECOND home | What exists |
|---|---|---|---|
| **photo ID** | `rtl_p1_id` on the file | **the borrower PROFILE** | Already done, and it is the precedent: `sharepoint-backup.scopeKeyFor:488` forces `borrower:<id>`, `categoryPathFor:452` forces `['Photo ID']`, `tpr-export.categoryFor:183` forces `C.ID`. **A photo ID has always been a profile document that a file borrows.** |
| **the vesting entity's OA/articles/EIN** | `rtl_p1_llc` | already `llc_id`-owned | Already done — the LLC slots ARE the primary home; the file's condition is an umbrella fulfilled by the entity's state (`llc.js:10-14`). |
| **draw wire OA** | `draw_cond_operating_agreement` | the entity's slot | Done — `draw-oa.onAccepted` |
| **a bank statement held by an unknown LLC** | `rtl_p3_assets` | that entity's profile + slots | Done — `entity-adopt` |
| **insurance binder / invoice** | `rtl_cond_insurance` | — (property-and-loan specific; **no** second home) | correct as-is |
| **appraisal XML** | `rtl_cond_appraisaldocs` | **the research warehouse** | Done, and it is the other precedent: `research/xml-catch.fireCatch` runs from **every** upload door (`staff.js:15580`), explicitly *"deliberately OUTSIDE the auto-import block… that one is the right gate for deciding a FILE's official appraisal and the wrong one for market data."* |

**That last one is the architectural precedent for this whole feature.** The appraisal XML case
already established: one document, two homes, two different gates, one chokepoint at the upload
door, fire-and-forget, never touches the loan file. Document auto-routing is the same pattern with a
different second home.

### The shape of the declaration

`target: 'property' | 'entity'` should become a **list of destinations**:

```js
{ slug:'operating_agreement', homes:[ {kind:'entity',  slot:'rtl_llc_opagmt'} ] }
{ slug:'deed',                homes:[ {kind:'pillar',  pillar:'ownership'} ] }
{ slug:'closing_statement',   homes:[ {kind:'pillar',  pillar:'<asked>'} ] }
{ slug:'schedule_e',          homes:[ {kind:'borrower'} ] }
{ slug:'bank_statements',     homes:[ {kind:'entity_by_holder'} ] }   // entity-adopt's job
{ slug:'other',               homes:[] }                              // abstain
```

`target` stays as a derived back-compat getter (`homes[0]?.kind === 'entity' ? 'entity' : 'property'`)
so `buildRequest`'s "an entity document needs an llcId" refusal (`:186`) and the existing test
(`test-track-record-doc-request-pure.js:31-35`) keep working unchanged.

---

## 8. What NOT to automate

Blunt, because each of these is a place where an "intelligent" router does damage.

**1. Never open a condition.** The AI-freeze HARD RULE, enforced by
`scripts/test-ai-no-condition-write.js`. `doc-request.js` and `entity-adopt.js` are both on the
ALLOWLIST (`:44-80`) *because they carry out a human's click* — the allowlist comments say so in
both entries. A router that fires on upload and posts `rtl_cond_entity_docs` because it noticed
something has **decided** to open a condition. That is the line.

**2. Never accept a document.** `entity-adopt.js:308-311` states the reason: a reviewer still
confirms the agreement names the borrower as managing member / 25%+ owner. And db/424's whole point
is that `pending` means one honest thing: *a human still has to look at this.* A router that
auto-accepts its own copy would ship an unreviewed document into the TPR export and the closing-prep
email.

**3. Never verify an entity, and never confirm a pillar.** Check A is `llc_borrowers.ownership_verified`,
set only through `POST /llcs/:id/ownership` which **refuses without a stated basis**
(`staff.js:10940-10945`). Pillars: db/494 keeps `auto_*` and `human_*` in separate column groups
precisely so they can never collapse, and the sign-off gate reads `human_verdict`.

**4. Never write into a verified entity.** The portal refuses (`staff.js:15371`); the copier's
caller skips (`entity-adopt.js:203-205`). A router must skip too, and **say** it skipped.

**5. Never create an entity from a document's contents on its own.** `promoteEntityName` creates
from a name a **human typed** on a track record. Creating one from an extracted `entityLegalName`
means an OCR error mints a company on someone's profile permanently — with four document slots
nobody can ever fill. That is what `junkEntityName` (`track-record-entity.js:78-92`) exists to
prevent for typed names, and OCR is a worse source than typing. The reverse direction (§5) must
**suggest** an adoption, not perform one — exactly as `entity-adopt` does today.

**6. Never resolve an ambiguous entity name.** `pickEntity` returns `{ambiguous}` and writes nothing
(`track-record-entity.js:165-172`): *"Writing either one attaches this property to a company that may
not have held it, and Check A would then carry the wrong verification."* On a **cascade** feature
that is the single most expensive wrong guess available.

**7. Never move a document a human filed.** The mis-filed advisory raises a card and lets a person
decide (`misfiled-document-advisory.js:16-20`). Auto-moving means the underwriter's file changes
under them; and SharePoint's own rule is that a human's arrangement wins permanently
(`sharepoint-shelf`, db/425).

**8. Never let the router block the upload.** Every leg is best-effort and post-response. A file
that failed to route is a missing copy; a file that failed to upload is a lost document.

**Where "intelligent" routing does damage, specifically:**
- an over-matched entity name carries one company's Check A onto another company's property — ten
  properties credited on one wrong link;
- an auto-accepted copy makes a never-reviewed operating agreement the basis of a verification;
- an auto-posted condition puts a borrower-facing ask on a file nobody chose to ask on;
- a "helpful" reclassification reads a document under the wrong schema and feeds wrong numbers into
  the tie-out — the exact tax-cert class (`misfiled-document-advisory.js:6-11`).

---

## 9. The design

### 9.1 The module

**`src/lib/document-routing.js`** — the ONE place that answers *"this document just landed; where
else does it belong?"*

Pure half (unit-testable, no DB):

```js
destinationsFor({ fieldKey, originDetail, raisedEntity, docKind, slotLabel, conditionCode })
  → { destinations: [...], abstained: [{reason}] }
```

IO half:

```js
routeUploadedDocument(client, { documentId, checklistItemId, applicationId, borrowerId, actorId })
  → { routed: [...], skipped: [...], afterCommit: [llcIds] }
```

Plus `afterRoutingCommit(llcIds)` — the post-commit leg, mirroring `entity-adopt.afterAdoptCommit`
(`:251-254`) and for the identical reason: `syncLlcConditions` opens its own connection, so calling
it inside an open transaction finds nothing and "succeeds" having done nothing.

**It absorbs, it does not duplicate.** The copier moves into it (one function, a target parameter)
and `entity-adopt` / `draw-oa` call it, so there is one copier, not three.

### 9.2 The chokepoint

**The upload door**, both of them, after the `documents` INSERT and after the response
— exactly where `research/xml-catch.fireCatch` already sits (`staff.js:15580`):

- `src/routes/staff.js:15357` `POST /applications/:id/documents`
- `src/routes/borrower.js:3217` `POST /documents`
- `src/routes/borrower.js:3140` (the track-record line upload) — **and fix the oldest-open-request
  bug here first**

Plus **one accept-time hook** in `POST /documents/:id/review`
(`staff.js:15818` — the block that already calls `draw-oa.onAccepted`), which is where the
**cascade** fires: an accepted entity document is the moment Check A's evidence exists.

Not the extraction pass. That is where the **reverse** direction (§5) belongs, and it must produce
`ai_suggestions`, not writes.

### 9.3 The routing table

§7. Encoded as `homes[]` in `doc-request.DOC_TYPES`, with `target` kept as a derived getter for
back-compat.

### 9.4 The abstain rules

§2.3, plus: **an abstention is always recorded** in the return value with its reason, the way
`entity-adopt` reports `skipped` with a reason (`:201-217`) and `adoptionSummary` (`:382-403`)
turns it into a sentence. A silent no-op is the failure mode that made the current `slot` field dead
for months without anyone noticing.

### 9.5 Allowlist implications

`scripts/test-ai-no-condition-write.js` scans for `INSERT INTO (checklist_items|checklist_templates|conditions)`.

- **`document-routing.js` must NOT be on the allowlist, and must not need to be.** It writes
  `documents` rows and UPDATEs `checklist_items.status` — neither is an INSERT. It must **never**
  post a condition. This is the design constraint that keeps the feature on the right side of the
  AI-freeze rule, and it should be stated in the module header the way `entity-adopt`'s is.
- **`generateLlcChecklist` DOES insert `checklist_items`** — it is inside
  `src/routes/borrower.js` (`:4353`), already allowlisted. Calling it from `document-routing.js` is
  fine: the allowlist is keyed on the file containing the INSERT.
- **If a later phase wants the router to post `rtl_cond_entity_docs`, it needs a human's click** and
  the module goes on the allowlist with an entry explaining which click — the `entity-adopt` /
  `doc-request` precedent. Prefer an `ai_suggestions` row with a button instead.

### 9.6 Migration

**Phase 1 needs none.** Every column exists: `documents.llc_id`, `documents.source_document_id`,
`checklist_items.origin_detail`, `checklist_items.raised_entity`, `llcs.adopted_*` (db/400),
`track_record_pillars` (db/494), `llc_borrowers.ownership_verified` (db/495).

Two later, optional migrations:

- **`llcs.adopted_source`** already exists; add `'track_record_doc_request'` as a value. No schema
  change (it is free text).
- **Back-fill:** documents already sitting on `trdoc:` entity conditions that were never copied to
  their slot. This is a **JavaScript boot pass, not a migration** — the same reasoning as
  `name-heal` / `property-category-heal`: the routing decision reads `entityMatch`, and a PL/pgSQL
  twin would drift. Bounded, self-draining via a stamp, never throws. **And it must be
  going-forward-first**: it copies documents onto entity slots, which bumps those slots to
  `received` and moves `syncLlcConditions` on every vesting file — a large unattended state change.
  Ship phase 1 going-forward, then run the back-fill deliberately.

### 9.7 The build list

**Wire what already exists (phase 1) — no new capability, high value:**

| # | Work | Files | Why first |
|---|---|---|---|
| 1 | **Fix the oldest-open-request attach.** Use `parseFieldKey` + the uploaded doc type to pick the right open request; abstain (current behaviour) when only one is open or nothing resolves | `src/routes/borrower.js:3145-3150` | Four lines. Fixes a live mis-credit of pillars. Pre-requisite for everything else — routing off the wrong condition routes wrongly. |
| 2 | **`document-routing.js`, entity leg only.** `parseFieldKey` + `origin_detail` → `copyDocumentIntoSlot`. Absorb the copier from `entity-adopt._internals` | new; `entity-adopt.js`, `draw-oa.js` call it | This IS the owner's example. ~80 lines over parts that already work. |
| 3 | **Call it from all three upload doors**, post-response, best-effort | `staff.js:15357`, `borrower.js:3217`, `borrower.js:3140` | The chokepoint. |
| 4 | **Fire the Check A cascade on accept.** `syncEntityToTrackRecords` beside the existing `draw-oa.onAccepted` hook | `staff.js:15818` | One line. Makes the existing cascade actually reachable from a document. |
| 5 | **Run `syncEntityToTrackRecords` wherever `syncLlcConditions` runs** | `entity-adopt.js:252`, `draw-oa.js:220` | Siblings. Files and properties should never disagree about an entity. |
| 6 | **Point `subject:'entity'` at the ASK's entity** when the document is on a `trdoc:` condition | `file-view.js:244` + its caller | Kills a **FATAL false positive** on every correctly-filed track-record OA. |

**New capability (phase 2):**

| # | Work | Why later |
|---|---|---|
| 7 | **`homes[]` in `DOC_TYPES`** + pillar-evidence routing for deed / closing statement / lease / CO | Needs a decision on what "a document moved the pillar" means vs. `verify-run`'s records-sourced `auto_verdict`. Real design, not wiring. |
| 8 | **The affirmative wrong-company check** in `computeOperatingAgreementFindings` (`entityLegalName` vs the expected entity, `entityMatch`, null raises nothing) | Depends on #6 landing first, or it compares against the wrong entity too. |
| 9 | **The reverse direction as a suggestion**, fired from the extraction pass: an entity document whose `entityLegalName` resolves unambiguously to a known entity with an empty slot → `ai_suggestions` with a one-click "file it on the entity" | New surface. Must suggest, never act (§8). |
| 10 | **Schedule E → borrower profile**, and the "one document proves several properties" shape | Genuinely new — no existing precedent for a document that satisfies N track-record lines. |
| 11 | **Blueprint §4.4a's `Entities/` tree in the TPR export** | Independent of routing; the byte-copy already puts entity documents in `LLC/` in both the export and the mirror. |
| 12 | **The back-fill boot pass** | Deliberately last; see §9.6. |

---

## 10. The one-paragraph answer

The owner is right that the system should already know. It very nearly does: the ask declares the
document type, the entity and the destination slot; the copier that moves bytes onto an entity slot
exists and is already shared between two features; the cascade that carries one entity verification
onto every property it held exists and is correct. What does not exist is a wire between them — the
upload door reads none of it, the accept hook fires for the draw-wire case and not the track-record
case, and the entity subject builder points at the wrong company. The work is a chokepoint at the
upload door, one hook at accept, and one corrected subject. The temptation to make it "intelligent"
— to open conditions, accept documents, verify entities, resolve ambiguous names, move filed
documents — is exactly the temptation this codebase has already refused five separate times, each
time in writing, and each refusal is load-bearing.
