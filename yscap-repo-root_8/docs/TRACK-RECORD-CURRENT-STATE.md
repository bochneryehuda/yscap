# TRACK RECORD — CURRENT STATE AUDIT
### What exists today, what is broken, and what the rebuild has to keep
**Written 2026-08-09. RTL only.** The Long-Term product has no track record and none of this applies to it.

This document is the evidence base for `TRACK-RECORD-REBUILD-BLUEPRINT.md`. It records what is
actually in the repository on 2026-08-09, with file:line for every claim, so the plan can be argued
against facts rather than impressions. Read this first; the blueprint assumes it.

---

## 0. THE ONE-PARAGRAPH SUMMARY

A track record is one row per past deal, hanging off the **borrower** (not a file), in `track_records`.
Seven writers create those rows. One boolean — `is_verified` — decides whether a row counts toward
experience, and one processor click sets it. The staff看 at the record through **two stacked,
independent applications on one screen**: a React list that owns the back-office verbs, and an
`<iframe>` of the *borrower's own marketing tool* that owns every number and the only verification
control. Neither can do the other's job, and the boundary between them cuts through single workflows.
Underneath, three separate status columns describe the same concept and only one of them gates
anything. Elementix — the public-records provider that could answer most verification questions
automatically — is connected, guarded, and completely unused.

---

## 1. THE DATA MODEL

### 1.1 `track_records`

Created at `db/schema.sql:123-149`, accreted across ten migrations. Reconstructed as it stands:

| Column | Added | Meaning / who writes it |
|---|---|---|
| `id` | schema | uuid PK |
| `borrower_id` | schema | **The owner is the PERSON, not a file.** A deal done by two people on one file is written twice, once per borrower (`track-record-from-file.js:85`). |
| `llc_id` | schema | FK to `llcs`, `ON DELETE SET NULL`. Settable only when the entity is already in the borrower's library. **In practice almost never populated** — see §5. |
| `client_row_id` | db/087 | Autosave idempotency key minted by the browser. Not a property identity. |
| `property_address` | schema | jsonb. **The only field required to save** (`borrower.js:2895-2899`). |
| `address_key` | db/044 | Grouping key = `house|street|zip`, **unit-free**, from the one shared function `track-record-key.trackRecordKey()`. |
| `property_type` | db/031 | Free text, 60 chars. Not normalized through `lib/property-type`, unlike `applications.property_type`. |
| `entity_name` | db/031 | **Free text, 160 chars, no FK.** Read everywhere as `COALESCE(entity_name, llcs.llc_name)`, so a real entity and a typed string are indistinguishable downstream. |
| `owned_personally` | db/093 | When true the server NULLs both `llc_id` and `entity_name`. |
| `deal_type` | schema | Free text, bucketed by **substring** everywhere: `/ground\|construction/` → ground, `/flip/` → flips, **everything else → holds**. A NULL `deal_type` counts as a hold. |
| `purchase_price/date`, `rehab_amount`, `sale_price/date`, `rent_amount/date`, `refi_amount/date`, `current_value` | schema + db/029 | The figures. |
| `notes` | schema | The borrower's own note — **and a load-bearing provenance marker**: Encompass's `PRISTINE_ENRICHMENT_ROW` predicate matches on the exact note string (`enrich.js:509`). |
| `lo_notes` | db/031 | Staff-only. Accepted by `PUT` (`staff.js:10263`), returned by `GET` (`staff.js:10180`), **written by no screen anywhere.** Dead. |
| `is_verified` | schema | **The only flag any count reads.** |
| `verified_at`, `verified_by` | schema | One verifier, one timestamp, for the whole row. |
| `verification_status` | db/031 | `pending\|docs\|verified\|limited`. **No CHECK constraint** — enforced only in app code (`staff.js:10896`). Largely a display mirror. |
| `docs_status` | schema | `outstanding\|requested\|received\|satisfied\|issue`. **`satisfied` and `issue` have no writer.** Read by nothing that gates. |
| `entered_by_kind`, `entered_at` | db/458 | Who last typed the figures, and when. Stamped by the two tool doors only; the three machine writers are backfilled on the *next boot*. |
| `origin`, `source_task_id`, `inferred` | db/044 | Provenance. `inferred` is read by exactly one predicate and appears on no API. |

Indexes: `idx_track_records_borrower`, `idx_track_records_llc`, `idx_track_records_addr_key`,
`uq_track_records_client_row` (partial), `uq_track_records_source_task` (partial, **global not
per-borrower**), `idx_track_records_pending_review` (partial, db/458:86).

**The structural gap the rebuild exists to close:** there is exactly one verification bit for the
whole row. There is nowhere to record *what* was verified, *how*, *from what source*, *with what
confidence*, or *by whom per question*. The owner's three pillars — exit date within three years,
ownership, the exit itself — cannot be represented at all.

### 1.2 The exit date is derived, never stored

`experience.js:13-18`:

```sql
EXIT_DATE_SQL  = CASE WHEN deal_type LIKE '%flip%' THEN sale_date
                      ELSE COALESCE(rent_date, refi_date) END
RECENT_EXIT_SQL = exit IS NOT NULL AND exit <= CURRENT_DATE
                  AND exit >= CURRENT_DATE - INTERVAL '36 months'
```

This is the **frozen 36-month rule**, re-seeded as a guideline row at `db/260:90-95`. Because it is
evaluated at query time, **a verified line silently stops counting as it ages past 36 months.**
`track-record-todo.lineTodo` (`todo.js:127-132`) surfaces that after the fact.

⚠️ **Four implementations of this rule exist.** `experience.js` is the definition; it is copied
literally into `staff.js`, `borrower.js`, `tapes/assemble.js` and `track-record-todo.LINE_SQL`; and
`tpr-export.exitInfo` (`tpr-export.js:257-263`) implements a **fifth, subtly different** version —
`sale_date || refi_date || rent_date`, a 30.44-day month, no `deal_type` branch. That divergence is a
live inconsistency between the investor export's "Recent (3yr)" column and the counts the gate uses.

### 1.3 `track_record_findings` (db/418)

Borrower-scoped problems with the record, which **hold the experience condition** until settled.
Two codes today: `duplicate_line` and `subject_property_on_record`. The design is excellent and the
rebuild extends it rather than replacing it:

- `uq_trk_finding_open ON (borrower_id, dedupe_key) WHERE status='open'` — the partial-unique index
  is what makes the detector safe to re-run on every file view.
- The **options come from the server** (`actionsFor`), never a list retyped in a screen, so a new
  code gets its buttons for free.
- **Detection is by PAIR, never by group** — `sameAddress` is deliberately not transitive, and an
  early group-based implementation would have deleted a real second condo unit.
- **A decided finding stays decided**, and a run only retires codes it actually evaluated.

### 1.4 `db/485` — the always-pending trigger

The most important piece of doctrine in this area. `trg_track_record_verify_guard`:

- **INSERT** → forced `is_verified=false`, `verified_at/by=NULL`, status downgraded to `pending`.
  Nothing can be born verified, from any writer, ever.
- **UPDATE** → if any of **16 material columns** changed, the same forced reset. Material = the deal
  itself: address, `llc_id`, `owned_personally`, `entity_name`, `deal_type`, `property_type`, and
  every figure and date. Deliberately **not** material: `docs_status`, `notes`, `lo_notes`,
  `address_key`, `inferred`, `origin`, `source_task_id`, `client_row_id`, `entered_*`, timestamps.
- Going-forward only. A back-book sweep would un-verify every borrower at once and reopen live
  conditions.

The trigger exists because "seven writers cannot be kept in step by discipline" — a prior
app-layer-only fix silently applied to one door and not the others. **The rebuild adds writers. It
must therefore extend this trigger, not work around it.**

---

## 2. THE TWO STACKED SURFACES

### 2.1 What is actually on the screen

`StaffTrackRecordPanel` (`StaffApplication.jsx:2493-2745`) renders, inside one `<div class="panel">`:

| | What | Lines | Kind |
|---|---|---|---|
| A | `TrackRecordFindings` — merge / keep-both / remove / dismiss | 2597 | React |
| B | Header: "Open full screen", "⤓ Saved copy (HTML)" | 2598-2615 | React |
| C | Person switcher (primary vs co-borrower) | 2616-2631 | React |
| **D** | **THE "TOP"** — per-line row with *Request a document · Raise an issue · Post a condition*, open requests, per-line document accept/reject/delete | **2632-2727** | React |
| **E** | **THE "BOTTOM"** — `<StaticToolFrame src="/tools/track-record.html?internal=1&borrower=<id>&embed=1">` | **2728-2733** | **iframe** |
| F | `TrackRecordTodo` — server-computed "what's left" | 2736 | React |

**The bottom is the borrower's own tool.** `web/v2/tools/track-record.{html,js,css}` is the public
marketing-suite builder; `track-record-portal.js` is a single bridge file with two modes
(`portal.js:17-21`) — `?portal=1` for the borrower, `?internal=1` for staff. `StaticToolFrame`
(`StaticToolFrame.jsx:102-121`) polls `scrollHeight` every 400 ms and rewrites the iframe height, so
the two applications *look* like one page.

That is the whole explanation for the owner's complaint. The nicely-laid-out bottom half is polished
because it is a marketing artifact; the top half is a row of buttons bolted on later because the
marketing tool has no concept of a back office.

### 2.2 The feature split, and where it cuts through a workflow

The bottom owns **24 fields**; the top renders **5 of them**. The top **cannot write a single column
of `track_records`.**

| Capability | Top (React) | Bottom (iframe) |
|---|---|---|
| Purchase / sale / rehab / rent / refi figures, hold period, gross spread | ❌ | ✅ |
| Deal kind, property type, flip-vs-hold sectioning | ❌ | ✅ |
| Add / edit / duplicate / delete a line | ❌ | ✅ |
| **Set verification status** | ❌ | ✅ (the only control) |
| Experience ranking band, stat strip, totals | ❌ | ✅ |
| Filter, group by entity | ❌ | ✅ |
| Excel / PDF export, Excel import | ❌ | ✅ |
| **Open / download a document** | ❌ | ✅ |
| Upload a document, drag-and-drop | ❌ | ✅ |
| **Accept / reject a document** | ✅ | ❌ |
| **Request a document from the borrower** | ✅ | ❌ |
| **Raise an issue / post a condition** | ✅ | ❌ |
| Findings, "what's left" to-do | ✅ | ❌ |
| Sorting | ❌ | ❌ |
| Photos | ❌ | ❌ |
| `lo_notes` | ❌ | ❌ |

**The three sharpest breaks:**

1. **You read a document at the bottom and accept it at the top.**
2. **You see a deal's figures at the bottom and verify it at the bottom — but chase it from the top.**
3. **Two different "waiting for review" counts on one screen.** Top: `!is_verified && status!=='limited'`
   (`StaffApplication.jsx:2642`). Bottom: `qual - verified`, where `qual` counts only complete,
   in-window deals (`track-record.js:106,151`). They routinely disagree.

### 2.3 Six surfaces, one dataset

Beyond the file panel: the experience condition row (`StaffApplication.jsx:3674-3702`), the Approvals
→ Track record queue (`StaffTrackRecordReviews.jsx`), the borrower CRM profile tab
(`StaffBorrowerDetail.jsx:446-490`), global search (`StaffLayout.jsx:200-215`), and the frozen V1
portal. The iframe is mounted from **three** places.

### 2.4 The layout worth keeping

The bottom's quality is not an accident and the rebuild must carry it over. Specifically:

- **Two real sections** with icons and counts — *Fix & Flip experience* / *Fix & Hold experience*
  (`track-record.js:204-213`). This is the single biggest reason it reads better than the top's
  undifferentiated stream.
- **Hairline-divided KPI strip** achieved with a 1px grid gap over a line-coloured background
  (`track-record.css:42-45`), 6 → 3 → 2 columns responsive.
- **State-encoding 3px left border** on each card — teal qualifying, amber warning, red error
  (`track-record.css:89-95`).
- **Label-over-value figure micro-grid** (`track-record.css:114-119`) with `min-width:0` +
  `overflow-wrap:anywhere` so a long hold figure cannot make one section wider than the other.
- **Grouped edit form** — uppercase teal legends over a rule, 4-column grid, `$` adornments inside
  the input shell, and a four-state autosave message that is never a blocking red.

### 2.5 Dead code found

| Item | Where | Why dead |
|---|---|---|
| `.tr-status` + its four modifiers | `track-record.css:105-109` | Nothing emits that class; the bridge writes `.tr-portal-status` with inline styles. |
| `.tr-lo`, `.tr-lo-lbl`, `.tr-lo-statuses`, `.tr-status-pick.*`, `.tr-lo-notes` | `track-record.css:128-139` | **An entire designed "LO verification panel" with nothing rendering it.** |
| `.tr-seller` / `seller` | `track-record.css:120`, `track-record.js:34,561` | In the blank prop and the Excel importer; never in a form, card, or payload. |
| `S.loMode` | `track-record.js:30` | Never read. |
| `track_records.lo_notes` | schema → API → bridge | No surface writes it. |
| `docs_status` values `satisfied`, `issue` | schema | No writer. |
| `conditions.linked_entity_type='track_record'` | db/022:18-19 | Declared, never written. |

---

## 3. VERIFIED DEFECTS

These were each confirmed by reading the code, not inferred.

### D1 — THE FINDINGS GATE HAS NEVER BLOCKED ANYTHING ⚠️ **critical**

`signOffGate` loads the application at `staff.js:8444-8446`:

```sql
SELECT rehab_budget, borrower_id, co_borrower_id,
       requested_exp_flips, requested_exp_holds, requested_exp_ground
  FROM applications WHERE id=$1
```

**There is no `id` in that select list.** At `staff.js:8490` it then calls:

```js
const trkBlock = await require('../lib/track-record-findings').experienceBlockReason(app.id);
```

`app.id` is `undefined` → node-postgres binds NULL → `borrowerIdsForFile` (`findings.js:260-266`)
returns `[]` → `openForFile` returns `[]` → `experienceBlockReason` returns `null` → **no block.**

The owner's 2026-08-02 direction — *"you can't sign off the experience condition before you sign off
all the findings or dismiss all the findings"* — is enforced in the UI and silently bypassed at the
actual sign-off. A duplicated line, or this file's own subject property sitting on the record as a
finished deal, does not stop clear-to-close today.

**Fix:** `item.application_id`, which is in scope and is what every other line in the branch uses
(e.g. `staff.js:8520`). **Root cause of the survival:** `test-track-record-findings-db.js` exercises
`experienceBlockReason` directly and never through the route. The fix needs a route-level test.

### D2 — EVERY CLICKUP WEBHOOK REVERTS A DEAL-TYPE CORRECTION AND UN-VERIFIES THE LINE

`clickup/ingest.js:676-679`, the existing-row branch of `upsertTrackRecord`:

```js
await db.query(`UPDATE track_records SET deal_type=$2, inferred=$3,
                  property_address=COALESCE($4, property_address), updated_at=now() WHERE id=$1`, ...)
```

`deal_type` is written **unconditionally**, from an inference that defaults to `'fix-and-hold'` and
only yields `'flip'` when `a.program === 'Fix & Flip w/ Construction'` exactly (`ingest.js:663-671`).
Since db/485 makes `deal_type` material, a staffer's correction is reverted **and** the verification
dropped, on every re-ingest of that closed card. This is silent, repeating churn on live files, and
it is the one writer that will keep re-tripping the trigger.

### D3 — THE BOOT ADDRESS-HEAL UN-VERIFIES EVERY LINE IT REPAIRS

`address-heal.js:46` lists `{ table: 'track_records', col: 'property_address' }`, and `:83` issues
`UPDATE ${table} SET ${col} = $2::jsonb${rekey} …`. db/485's header carefully exempts `address_key`
as *"a repair, not a restatement"* — but the same statement writes `property_address`, which **is**
material. Every long-form address the boot pass repairs therefore drops that line's verification and,
through `syncExperienceChecklistForBorrower`, can reopen the experience condition and flag a live
product registration stale.

### D4 — MACHINE WRITERS DO NOT STAMP `entered_by_kind`

`ingest.js:684-690`, `enrich.js:482-485` and `from-file.js:105-114` all omit it; db/458's backfill
catches them only on the **next boot**. Between the write and the next deploy those rows read as
"we don't know who entered this."

### D5 — A MERGE UN-VERIFIES THE KEEPER

`mergeTrackRecordPair` carries blank columns from loser to keeper (`heal.js:157-162`); those are
material, so db/485 resets a verified keeper to pending. Probably desirable — but undocumented and
untested.

### D6 — THE BORROWER CREATE DOOR WRITES NO AUDIT ROW

`staff.js:10239` audits `staff_add_track_record`. `borrower.js:3011-3050` audits nothing. The only
trace of a borrower-created line is the SSE event and `entered_by_kind`.

### D7 — `verification_status` HAS NO CHECK CONSTRAINT

Nothing at the database level ties it to `is_verified`; `'verified'` with `is_verified=false` is
storable today.

---

## 4. THE DOCUMENT-REQUEST HOLE — PRECISELY LOCATED

The owner's report was *"when you request the document over there, it's not adding this document as
an underwriting condition."* The adjudication is more specific than that, and more serious.

### 4.1 The "Request a document" button DOES work

`POST /api/staff/track-records/:id/request-doc` (`staff.js:11013-11035`) → `raiseEntityIssue`
(`raise-issue.js:39-124`) creates a `checklist_items` row with `track_record_id` set,
`audience='both'`, `item_kind='document'`, `is_required=true`, `category='prior_to_docs'`,
`field_key='issue:tr:<id>'`. Verified consequences: it appears on the borrower's cross-file task list
(`borrower.js:644-660`), on the file's condition list, as an amber banner on the property card
(`track-record-portal.js:600-602`), and **it blocks clear-to-close** — it satisfies every predicate in
`advancementBlockers` (`staff.js:11310-11337`).

### 4.2 What is genuinely orphaned

**(a) The verification dropdown — the control staff actually use.** Inside the embedded tool, the
*only* per-line staff control is the verification `<select>` (`track-record-portal.js:488-517`).
Choosing **"Documentation required"** calls `POST /track-records/:id/verify` with `status:'docs'`.
Trace it through `staff.js:10897-10976`: `counts=false` so the permission and exit-window gates are
skipped; `isRevoke=false` on an already-unverified line; the only write is
`UPDATE track_records SET verification_status='docs'`; and the `else` branch at `:10969-10971` is
**audit only, no notify**. No condition. No borrower task. No email. No gate. The same is true of the
"Documentation required" button in the Approvals queue (`StaffTrackRecordReviews.jsx:202-204`).

`verification_status` is read by **nothing that gates** — every consumer is display or export.

**(b) A rejected track-record document creates no re-request.** `staff.js:15356-15368` un-verifies
the line and emails the borrower, but a line-item upload carries no `application_id`
(`borrower.js:3133`, `staff.js:10353`), so the CTA links to `/profile` and the ask never reaches
`/action-items`.

**(c) `track_records.docs_status` is a third, parallel, ungated status machine** — written in five
places, read by nothing that gates.

**(d) The ask is free text.** `StaffApplication.jsx:2675` is a `window.prompt`. There is no notion of
*which* document is missing, even though a 7-value vocabulary already exists on the **upload** side
(`TRACK_RECORD_DOC_TYPES`, `borrower.js:3091-3096`).

**(e) An ask requires a live file.** Both routes 400 without an `applicationId`, so a property on the
profile of a borrower with no open file cannot be chased at all.

---

## 5. THE LLC GAP

### 5.1 A track-record entity name never becomes an LLC — proven

1. `track-record-portal.js:141-145` — `llcByName(p.entity)` scans only the array already loaded from
   `GET /api/borrower/llcs`. **A name that isn't already an entity resolves to `null`. No create.**
2. `borrower.js:3015-3018` and `staff.js:10213-10216` — both create doors only *validate* an incoming
   `llcId`; neither creates one.
3. `borrower.js:2948` — the typed name is stored as plain text and nowhere else.
4. `clickup/ingest.js:683-689` inserts **no `llc_id`** even though `upsertLlc` ran three lines
   earlier at `:1178`. `encompass/enrich.js:482-486` likewise.
5. The only writer that ever sets `llc_id` is `track-record-from-file.js:111`, copying `app.llc_id`.
6. **The system compensates at read time instead**: `staff.js:2279-2286` re-matches
   `lower(btrim(entity_name)) = lower(btrim(llc_name))` on every verify-LLCs request.

### 5.2 What already exists and is strong

- `llcs` with `uq_llcs_borrower_name ON (borrower_id, lower(btrim(llc_name)))` (db/082:110).
- `llc_members` with `member_kind` and `owner_llc_id` — **layered entity-owns-entity chains**, depth
  5, cycle-guarded (`llc.js:41,113-123`).
- `llc_borrowers` — many-to-many so a co-borrower co-owns (db/061).
- **Document slots**: `rtl_llc_formation`, `rtl_llc_ein`, **`rtl_llc_opagmt`**, `rtl_llc_goodstanding`
  — instantiated by `generateLlcChecklist`, read back by `llc.getSlots` with a 30-day Good-Standing
  expiry that reopens the slot without un-verifying the entity.
- `llc.missingForVerification` (`llc.js:181-213`) — EIN, formation state and date, ownership totalling
  100%, every required slot **accepted**, and **every owning entity already verified** (bottom-up).
- `syncLlcConditions` (`llc.js:287-362`) — fans `is_verified` onto every open application using the
  entity, chain-aware.
- **`ownershipProofLanded`** (`entity-adopt.js:365-370`) — already encodes *only the operating
  agreement proves control*; articles and an EIN letter prove existence.
- **A proven adoption module**: `entity-adopt.adoptEntityToProfile` does findOrCreate → checklist →
  provenance → link borrower → **copy matching documents into slots** → post a condition, in one
  transaction, with `syncLlcConditions` deliberately run *after* commit. `copyDocumentIntoSlot`
  copies bytes rather than sharing a `storage_ref`, records `source_document_id` lineage, and dedupes
  on sha256.

### 5.3 The traps

- **db/485 treats both `llc_id` and `entity_name` as material.** A backfill that populates `llc_id`
  from `entity_name` would un-verify the entire back book.
- **Name matching is split.** `findLlcByName` is **exact** (`lower(btrim)`); the underwriting stack
  has a proper fuzzy `entityMatch` with suffix stripping and re-spacing (`compare.js:108-123`). Left
  alone, "Smith Holdings, L.L.C." mints a second entity beside "Smith Holdings LLC".
- **`llc_borrowers` is written by no track-record path.**
- **`adopted_*` has live liquidity consequences** — an adopted, unverified, document-less entity's
  bank balances are held out of provable liquidity (db/400). Stamping a track-record-promoted entity
  is a decision, not an inheritance.

---

## 5A. PROPERTY IDENTITY — THE COMPARER, AND ITS ONE UNGUARDED HOLE

Everything about matching an externally-sourced property to one of our rows rests on this, so it is
recorded in full.

### 5A.1 Two predicates, deliberately different

`src/lib/track-record-key.js:32-45` states the design in its own words: `trackRecordKey()` is a
**grouping key** — *"a good net and a BAD verdict"* — and `matchTrackRecord()` is the **verdict**.

- **`addressCompareKey`** (`address.js:725-731`) = `house | streetBase || street | zip`.
  **Unit-free, city-free, and state-free.** `''` when there is no house number or no street, stored
  as NULL so unreadable rows never group.
- **`sameAddress`** (`address.js:703-721`) is the verdict. Both sides parse to
  `{house, street, streetBase, unit, city, state, zip}`, then: unreadable on either side → false;
  house numbers must match (a range covers its endpoints, but **two differing hyphenated numbers are
  refused** — in Queens, the Bronx, Philadelphia and Hawaii a hyphen is one number, not a range);
  street or streetBase must match; **state compared only when both sides state one**; **the ZIP is the
  authority and the city is consulted only when a ZIP is missing**; **units conflict only when both
  are present**.
- **`matchTrackRecord`** (`track-record-key.js:71-84`) uses the key as a cheap pre-filter, then
  confirms with `sameAddress`, then falls back to scanning *stored addresses* — so a stale key from a
  retired normalizer never causes a miss.

### 5A.2 `sameAddress` is not transitive, and that is load-bearing

Two independent causes: a bare row matches every unit in a building (one blank unit is not a
conflict), and a house-number range matches every number it spans. So `5 Main St` ≈ `Apt 1` and
≈ `Apt 2`, while `Apt 1` ≉ `Apt 2`; `27-29` ≈ `27` and ≈ `29`, while `27` ≉ `29`. Both are pinned in
`test-track-record-dedupe-pure.js:113-129`.

**The first heal implementation grouped transitively and would have deleted a real second condo unit**
(`track-record-heal.js:19-29`). The corrective rule is absolute: **compare pairwise, act pairwise,
never build a cluster.**

### 5A.3 ⚠️ THE UNGUARDED HOLE — a row with no state and no ZIP matches anything, anywhere

Measured directly:

- `sameAddress('100 Main St', '100 Main St, Trenton, NJ 08608')` → **true**. Rule 4 compares state
  only when both sides state one; rule 5 compares ZIP only when both sides carry one; with neither,
  the city check is also skipped.
- `addressCompareKey('100 Main St, Newark, NJ')` and `addressCompareKey('100 Main St, Newark, DE')`
  are **the identical string `100|main|`** — the key has no state and no city, and without a ZIP it
  collides nationwide.

This has never mattered, because **until now both sides of every comparison were ours**. The moment a
vendor's national index is on the other side, a partially-typed track-record line — which is common,
since address is the only required field — can match a property in another state.

**This must be an explicit precondition of the new matcher, not an afterthought: refuse to
auto-confirm any link where our stored row carries neither a state nor a ZIP.**

### 5A.4 Other traps that must be guarded in the external matcher

| Trap | Behaviour | Guard |
|---|---|---|
| **Units** | The key is unit-free, and `sameAddress` treats one blank unit as agreement. A vendor row with no unit matches **any** unit we hold. Elementix returns `normalized.unit: null`. | Treat `null` as *unknown*, not *none*. Never auto-confirm when exactly one side names a unit. |
| **Ranges** | `27-29` ≈ both endpoints. | Force manual review whenever either house number contains a hyphen. Never chain two range matches. |
| **`Ext` vs `Extension`** | Our own parser reads **`Ext` as a unit** but **`Extension` as part of the street name** (`OPTIONAL_TYPE` deliberately excludes it — "Oak Street" and "Oak Street Extension" are different streets). | Force manual review when either side's street ends in `Ext`/`Extension`. |
| **Directionals** | `N Main` ≠ `Main`. Elementix reports `differs.directional`. | Never accept a link where our side has a directional and theirs does not. |
| **PO boxes / rural routes** | `house` is `''` → `sameAddress` is false **even against itself**; the key is `''`. | Nothing to guard — but never "fix" this by relaxing the house-number requirement. The comparer's conservatism rests on it. |
| **County** | Captured for underwriting, **never displayed and never compared**. | Never put it in the predicate. Display only. |
| **Municipal-line ZIPs** | `1727 S 2nd St` exists in both Piscataway 08854 and Plainfield 07063 — two real buildings ~130 m apart, both rooftop-geocodable. | Differing ZIPs are already refused. **Do not add a "close coordinates" bypass.** |
| **Coordinates as a match signal** | A rooftop-precise match can be a different building; Google coordinates legally expire after 30 days; most warehouse rows are unplaced. | Coordinates are for display and radius search. Never let one *promote* a match. At most, a large distance between two non-Google rooftop points is a disqualifier worth showing a human. |

### 5A.5 A stricter second opinion already exists in SQL

`pilot_address_same_place(a,b)` (`db/415:173-182`) keys on `house|street|state|zip5|unit` — it
**includes state and unit** and **excludes range expansion**, so it deliberately under-matches the JS
comparer. `test-usps-address-stability-db.js:79-90` asserts, as an invariant, that **the SQL key never
calls two addresses the same place when the JS does not.** `js_same AND sql_same` is therefore the
strictest verdict available, and is the right bar for auto-confirmation.

---

## 6. ELEMENTIX — CONNECTED, GUARDED, UNUSED

### 6.1 What shipped

Standard MCP OAuth (RFC 9728 → 8414 → 7591 → 7636 + 8707 resource indicator), all endpoints
discovered at runtime (`elementix/oauth.js:231-321`). Tokens AES-256-GCM encrypted in
`elementix_oauth` (db/489); `store()` **refuses to write a token it cannot encrypt**. Pending
approvals live in the database, not process memory, because Render runs multiple instances.
`SEAT_MODEL='company'` — one company login, owner-directed.

`client.callTool(name, args, opts)` invokes **any** MCP tool; there is no allowlist and no per-tool
wrapper needed. It never throws structurally, retries exactly once on a mid-session 401/403/404, and
parses both JSON and SSE responses.

### 6.2 The cost guard already in place

```js
// client.js:198-201 — checked BEFORE the URL, the switch, the budget and the token
if (PAID_TOOLS.has(toolName) && !opts.allowPaid) {
  return { ok:false, reason:'paid_tool_refused', detail: `${toolName} spends Elementix credits…` };
}
```

`PAID_TOOLS = new Set(['submit_contact_enrichment'])`. The **placement is the safety property**: no
configuration state can be arranged such that a sweep spends credits. `scripts/test-elementix-oauth-pure.js:246-266`
pins it both ways.

### 6.3 What is missing before any paid call is reachable

- **No spend accounting at all.** No table, no counter. The CRM plan says the staff id must be
  recorded at the click *because Elementix only ever sees one account* — not built.
- **No monthly quota.** The token bucket counts requests/hour; enrichment credits are a different
  unit entirely.
- **The `get_contact_status`-first rule is documentation, not code.**
- **`allowPaid` is an unattributed boolean** — no actor, no person id, no reason, no permission check.
- The bucket is **per-process**, so the 400/hr self-cap is per Render instance.
- `listTools()` bypasses `overBudget()` and discards `inputSchema`.
- **No per-lookup audit trail** — nothing will record who looked up whom.
- `oauth.sweepPending()` has **zero callers**; expired approvals accumulate forever.
- **No `ELEMENTIX_*` block in `.env.example`**, unlike every sibling integration.

### 6.4 Zero product wiring

`grep -rn "track_record" src/elementix/` returns nothing. `callTool` has **no production callers**.
The only runtime consumer is the admin "what tools exist?" endpoint. `public-records-crosscheck.js`
is still a structural stub whose header says the public-records integration is "deferred (no key yet)."

---

## 7. WHAT THE EXISTING DOCS ALREADY DECIDED

`docs/ELEMENTIX-RESEARCH.md` and `docs/ELEMENTIX-CRM-PLAN.md` (both 2026-08-07) establish rules the
rebuild inherits and must not contradict:

1. **"No record found" is NEVER evidence that a claimed deal is false.** Entity→people coverage swings
   from 82.9% (Essex NJ) to 39.8% (Passaic NJ), and `entitySosCoveragePct` is **0 across every NJ
   county**. A verification engine that reads silence as a negative finding "will accuse honest
   borrowers, in specific counties, systematically."
2. **`nameCommonnessScore` is the safety valve.** "A design that ignores this field will eventually
   attach a stranger's portfolio to a borrower. Any auto-match must gate on it."
3. **The marketing plane and the underwriting plane must share nothing but a vendor login.**
   Skip-trace contact data is non-FCRA-certified; a business-purpose commercial loan *is* a §1681b
   permissible purpose. Enforced at the query layer — separate tables, separate modules, no join.
4. **Nothing auto-verifies, nothing auto-merges, a common name never auto-matches**, and a
   verification result **is not read-only** — lowering verified experience reopens a signed-off
   condition and can flag a live registration stale.
5. **Never built, deliberately:** any bulk "trace this whole list" action, any automatic skip-trace
   spend, any promotion of marketing-plane contact data into an underwriting decision.

---

## 8. WHAT MUST NOT BREAK

### 8.1 The borrower side

The owner is explicit that the borrower experience stays as it is. Concretely:

- `web/v2/tools/track-record.{html,js,css}` and the `?portal=1` half of `track-record-portal.js` are
  **untouchable** except by deliberate borrower-side work. The riskiest single file in this whole area
  is `track-record-portal.js`, because it is **one file serving both audiences**.
- The four `TR_PORTAL_*` hooks (`ONSAVE`, `ONRENDER`, `ONFORM`, plus `TR_PORTAL`) and the postMessage
  names (`ys-tr-sync`, `ys-tr-reload`, `ys-tool-save-close`, `ys-tool-saved`) are a contract consumed
  by `TrackRecordScreen.jsx` and `Application.jsx`.
- `trackRecordErrors / trackRecordCols / trackRecordMissing / trackRecordEnteredCols` live in
  `borrower.js` and are **imported by `staff.js:10202`**. One edit lands on both doors, and db/485's
  material-column list is calibrated against exactly that mapper.
- The verified-line lock is borrower-only and must stay so; the server enforces it independently
  (`borrower.js:3037,3056,3079`).

### 8.2 The snapshot trap ⚠️

The borrower's downloadable **"Saved copy (HTML)"** is generated *by the iframe*
(`track-record-portal.js:359-419`) and PUT to the server, which only files the bytes
(`track-record-snapshot.js:31-76`). **Remove the staff iframe without moving snapshot generation
server-side and every staff-only edit silently leaves the borrower's saved copy stale.** The HTML
builder is already duplicated server-side in `track-record-export.js`, so the move is available.

### 8.3 The V1 portal

`app/src/screens/StaffApplication.jsx:1059` points at the **absolute** `/tools/track-record.html?internal=1`,
which `server.js:601-603` resolves to the **V2** file. Stripping `internal=1` support from the V2
bridge blanks the frozen V1 staff panel.

---

## 9. THE PRECEDENTS THE REBUILD SHOULD COPY

| Need | Precedent | Where |
|---|---|---|
| A staged queue that is invisible downstream, safe to re-run | `sync_review_queue` — partial-unique-open index, reason→copy map, reason→actions map, bulk bar with partial-failure reporting, inline row errors | `db/108`, `SyncReviews.jsx` |
| A per-item problem with server-supplied options that gates a condition | `track_record_findings` | `db/418`, `track-record-findings.js` |
| Field-level "which value wins", master pre-selected, two-step destructive confirm | `CompareMerge` | `StaffBorrowerDetail.jsx:643-753` |
| "Nothing is silently dropped" import manifest, failures first, "already here" is not a failure | `ResearchImportPanel` | `ResearchImportPanel.jsx:293-424` |
| One prominent next step + a hint that tells the truth about server refusals | `nextStep()` — **pure, no React, no api** | `lib/condition-actions.js:76-143` |
| Per-item borrower accept/dispute on a token page | `DrawAccept` | `screens/DrawAccept.jsx` |
| A durable multi-step wizard with a server-persisted cursor | `Apply` | `screens/Apply.jsx:34,72,317-347` |
| Split-pane list ↔ detail | `.ec-split` | `styles.css:2756-2781`, `EmailCenter.jsx` |
| "Absence of a verdict is not a negative verdict" | draw findings | `DrawsPanel.jsx:2410-2412` |
| Mounting a new queue | tabs in the Approvals hub, not a new nav link | `StaffApprovals.jsx:25-40` |

---

## 10. THE SHORT LIST

What the rebuild has to deliver, stated as the gaps this audit found:

1. **One staff surface**, keeping the bottom's layout and absorbing the top's verbs.
2. **Three pillars per property**, each with its own verdict, source, confidence, evidence and actor —
   because `is_verified` cannot express any of it.
3. **A staging area** for imported candidates that is structurally invisible until a human accepts —
   because today every automatic writer writes straight into the live table, and the review queue
   (`entered_by_kind='borrower'`) excludes machine imports entirely.
4. **A real entity link** — resolve `entity_name` to an `llcs` row, carry ownership verification across
   every property held by that entity, and file the operating agreement against the entity.
5. **One status machine**, not three.
6. **Elementix wired into underwriting**, with the paid guard tightened, spend attributed, silence
   never read as a negative, and `nameCommonnessScore` gating every auto-match.
7. **The four defects fixed**, each with a test at the layer that let it survive.
