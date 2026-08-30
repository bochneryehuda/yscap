# THE SHARING SEAM MAP — what gets shared, what gets deleted, what was never a gap

Companion to `SHARE-THE-CODE-DIRECTIVE.md` (the owner's order) and
`SHARED-CONDITION-CENTER-ARCHITECTURE.md` (the decided architecture). Those two say
*what* and *why*. This one says **which file, and in which direction**, so that the
next session does not re-derive it — or worse, rebuild something we already have.

Everything below was established by READING the tree at `6385cf1`, with file:line
anchors kept. Where something is an inference it says so.

---

## 1. The finding that removes work: the off-site backup needs no code at all

The owner's item 6 (*"copy the Cloudflare backup"*) turns out to be **already true**,
and for a structural reason rather than a lucky one.

`src/lib/backup/documents.js:68` `syncDocuments` walks the **object store**, never the
database: `source.list('')` at `:75`, then `planCopy` (`:46-62`) decides by key / etag /
size against `backup_document_state`. It never reads the `documents` table and has no
notion of `application_id` or `lt_loan_id`, **so it cannot miss a Long-Term row.**
Restore is the exact inverse at the original key (`restoreDocuments:126+`), so every
`storage_ref` in a restored database resolves without touching a row.

The database half is equally product-blind: `scripts/backup-run.js` runs `pg_dump` with
no table list, and `src/lib/backup/inventory.js:73-86` counts every ordinary table in
every non-system schema — so every `lt_*` table and its row count is already in the
manifest and already checked by the verifier.

**The one real precondition is that Long-Term bytes go through the shared storage
layer, and they do** (`src/longterm/orders/inbox.js:47` requires `../../lib/storage`,
saves at `:160`; `src/lib/storage.js:213` routes to S3; `render.yaml:314-315` sets
`STORAGE_PROVIDER=s3` on both the web service and the backup cron).

The failure mode worth knowing is symmetric, not Long-Term-specific: if
`STORAGE_PROVIDER` were ever left at its `local` default (`src/config.js:369`),
`syncDocuments` returns immediately with `skippedReason: 'no source bucket'` and
**neither** product's documents are backed up.

> So: do not build an LT backup path. There is nothing to build. Any future session
> that "adds LT to the backup" is adding a second pipeline the owner forbade.

---

## 2. The hazard that is worse than it looks: SharePoint files LT documents in the wrong cabinet

`pendingBatch` (`src/lib/sharepoint-backup.js:608`) selects **every** `documents` row
with a `storage_ref`. db/652 is committed, so the first LT document row written is
picked up immediately. Two outcomes, and the quiet one is the dangerous one:

- **Loud:** `mirrorRow` throws at `:1139`, the row fail-loops to the terminal `DEAD`
  state and trips the SLO watchdog. Rows that die *before* a resolver ships stay dead
  *after* it ships.
- **Quiet, and worse:** an LT document that happens to carry a `borrower_id` does
  **not** throw. `scopeKeyFor:526` falls through to `borrower:<id>` and files it into
  the **RTL borrower-profile tree**. Wrong cabinet, no error, no alarm.

Keep `sp-mirror-queue.js`'s `claimableWhere` in lock-step with `pendingBatch` — the
file says so itself.

---

## 3. `src/longterm/conditions-center/**` — the deletion plan

**Boundary first, because the names are one hyphen apart:**
`src/longterm/conditions/` (no hyphen) is the **Encompass condition mirror**
(`routes/conditions.js:1-8`, mounted `index.js:109`, db/612) and the directive KEEPS
it. Likewise `app-v2/src/longterm/LtConditionCenter.jsx` is the read-only Encompass
mirror screen (its own header, `:6-8`) — **KEEP**. Only `conditions-center/` (with the
hyphen) is in scope below.

### DELETE — reinventions, but port the named improvements first

| File | Duplicates | Port before deleting |
|---|---|---|
| `engine.js` (333) | `src/lib/conditions/engine.js:265-281`, `:320-338`, `:345-446` | the tri-state `apply true\|false\|null` (`:169-187`) — strictly better than RTL's catch→false at `engine.js:381`; the atomic retraction with `NOT EXISTS(files)` **inside** the DELETE (`:297-304`) vs RTL's read-then-write; `loadContext`'s per-read try/catch + `unreadable[]` (`:64-75`) |
| `rules.js` (320) | `src/lib/conditions/rules.js` in full | the tri-state return (`:144-168`) as an opt-in |
| `read.js` (216) | `staff.js:5030-5151` | the three-number summary that never collapses satisfied/waived/n-a (`:16-21`); the "a degraded read is not an empty file" posture (`:23-27`) |
| `write.js` (431) | `staff.js:9986-10594`, `extra-slots.addSlot:110-130` | **`missingSlots` (`:41-51`) — the generic required-slots gate RTL does not have**; `documentsByLine` (`:56-62`); the already-verified-entity short-circuit (`:102-104`) |
| `field-registry.js` (269) | the FRAMEWORK only (`fieldMap`/`catalog`/`read`, `:227-258`) | **KEEP the 30 FIELDS entries (`:66-226`)** as an LT field module the shared registry MERGES IN, exactly as it already merges `custom_fields` (`field-registry.js:605-610`) |

`engine.js`'s header (`:23-27`) claims it marks `not_applicable` and never deletes.
**The code at `:297` DELETEs.** Do not carry that claim forward.

### KEEP — genuinely Long-Term content; deleting these loses the owner's own work

- **`library.js` (735) — the most important file to keep.** 27 conditions in the
  owner's own wording, verbatim (`PRIOR_TO_SUBMISSION :77-377`, `PRIOR_TO_CTC
  :379-558`, buckets `:59-65`). Nothing in RTL duplicates it (RTL's library is SQL
  seeds: db/051, db/056, db/076). Rewrite **only** `seed()` (`:661-689`) to INSERT into
  `checklist_templates` with `scope='lt_loan'` and the vocabulary mapping. **Keep
  `verify()` (`:607-649`)** — it is why a rule naming a non-existent field fails the
  *build* rather than a *file*; extend it to assert every mapped value satisfies the
  live CHECK constraints.
- **`answers.js` (299) — keep in full.** The owner's "one out of three" rule. Pure, no
  db. Nothing in RTL duplicates it.
- **`workspace.js` (230) — keep, retarget** `documentsByLine` to `documents.slot_label`
  when the files move.
- **`entity-prefill.js` (178) — keep in full.** It is **already the sharing done
  right**: a thin reader over `src/lib/llc.js`, and that import is already in the
  ledger (`LONG-TERM-AUTHORIZED-COPIES.md:124`). It is the model for the rest.

---

## 4. Three CHECK constraints reject the Long-Term wording today

The engine seam is reachable, but these stand in the way and are easy to miss:

1. `checklist_templates.audience` is still `('borrower','staff','both')`
   (db/002_backend.sql:13-14, never widened) — the LT library is written in
   `internal`/`external`/`both`.
2. `chk_templates_category` (db/206:29-31) admits
   `prior_to_approval|docs|closing|funding|at_closing|post_closing|draw` — **three of
   the five LT buckets are not in it**.
3. `checklist_items_status_check` (db/schema.sql:242-243) is
   `('outstanding','requested','received','satisfied','issue')` — LT writes
   `in_progress`/`waived`/`not_applicable`.

Also absent: `checklist_templates` has no `config` jsonb and no `is_enabled`;
`checklist_items` has no `answer` jsonb (`tool_payload` is the analogue — *inferred*).

**And `signOffGate` is a no-op for any non-application item**: `staff.js:10000`
returns null when `item.application_id` is falsy, so an LT document condition would
sign off **with nothing uploaded**. This is the single highest-severity item in the
map.

---

## 5. The orders / VOR seam — split, do not delete wholesale

- `orders/inbox.js` — delete the **filing half only** (`fileAttachment :119-177`, the
  only writer of `lt_condition_files`). **Keep the claim-or-pass shell** (`:80-117`,
  `:278-308`), mounted at `server.js:75` in front of the RTL reader, and the
  `NOT_A_DOCUMENT` reason vocabulary (`:65-71`).
- `orders/desk.js` (456) — delete `place`/`sendLetter` as duplicates, but **promote
  into the shared desk** what RTL has no equivalent of: the send-as-user block
  (`:174-186` + the Graph one-shot company fallback at `:200-224` that refuses to retry
  on an ambiguous failure) and `newMessageId`'s traceable local part (`:47-53`).
- `orders/letter.js` — **split.** Delete the title branch (`:258-274`, already just
  calls `orderEmail.buildOrderEmail('title',…)`) and the hand-rolled `dealMeta`.
  **Promote to shared: the token machinery** (`tokenValues`, `merge`, `mergeTemplate`,
  `letterKeyFor`) — *the only settings-editable wording mechanism in the repo*, and the
  answer to the owner's drafts question. RTL's wording is hard constants with no editor
  and no tokens. `DEFAULT_LETTERS` should end up as `config.letter` seeds on the
  `scope='lt_loan'` templates rather than a frozen object in a module.
- `vor/desk.js` (532) — **split.** Delete the envelope duplicates. **Keep as genuine
  Long-Term inventions:** `anchorsPresent` (`:166-181`) and its enforcement
  (`:203-207`) — it renders the PDF, reads the text back out and REFUSES on a missing
  anchor, where the shared client's `anchorIgnoreIfNotPresent:'true'`
  (`docusign.js:236`) would silently drop a required landlord field; the three-method
  send (`:187-231`); and `recordManualReturn` (`:350-390`) — our row first, provider
  second, so an outage cannot lose the fact that a person filled the form in.
- `vor/fields.js` — **keep.** The field map and the load-time duplicate-anchor
  assertion (a duplicate anchor puts two tabs on one line and leaves the other blank —
  caught at LOAD, not by a test somebody might not run).
- `vor/pdf.js` — **CORRECTION to the scout's reading, verified 2026-08-30 by opening
  the file.** The seam scout recorded this as "the owner's exact blank form"; it is
  not. `pdf.js` DRAWS A LOOKALIKE from scratch on `pdf-lib` (`const { PDFDocument,
  StandardFonts, rgb } = require('pdf-lib')`, then `PAGE = { w: 612, h: 792 }` and its
  own margins, inks and rules). **Nothing in the tree references
  `src/longterm/assets/blank-vor.pdf` at all** — only three docs mention it. This is
  the owner's complaint word for word: *"You're not using our blank VOR."* The fix is
  the one `VOR-FORM-MAP.md` already specifies — a TEXT OVERLAY on the owner's flat
  page (no AcroForm fields), never a redrawn document — keeping pdf.js's genuinely
  good properties: render-from-data so the preview IS the document, and the invisible
  white 4pt anchors that make the tabs land.
- `routes/esign-claim.js` — **retire in the same commit** as the envelope switch, never
  before (every LT signature is dropped by `webhook.js:626`) and never after (two
  handlers race the same event).
- **Do not delete** `orders/kinds.js`, `switches.js`, `data.js` — per-product context
  and registries, which the architecture doc already names as *"different tables is a
  fact, not a fork"*.

---

## 6. The gaps still open, ranked by damage

1. **SharePoint delivery for an LT loan** — §2 above. The only gap that pages a human
   on day one.
2. **Profile-linked conditions (owner item 7)** — entirely unscoped. The appraisal card
   is encrypted PII behind a NOT NULL FK and a UNIQUE index (db/032:27, :38). With
   nobody having scoped it, the path of least resistance is a second card table on the
   LT side — **duplicating card numbers into a parallel store is the single worst
   reinvention available in this shipment.**
3. **The proof harness.** The directive's own guarantee is that every sharing change is
   proven byte-identical on the RTL side. 1,364 test scripts exist; none of the hot
   handlers (`uploadAppDocument`, `signOffGate`, the PATCH door, `placeOrder`) has its
   guarding suite identified. Its absence is invisible until an extraction has already
   dropped one of the dated owner rules those handlers encode inline.
4. **The other two audiences.** "The same look of the Condition Center" is a
   three-audience promise. LT's borrower screen has no conditions at all
   (`BorrowerLongTerm.jsx`, zero matches), and the login-free guest flow
   (`GuestConditions.jsx` + `condition_links` + `lib/condition-link.js`) is RTL-only —
   and it is the surface where a missed scrub becomes a disclosure.
5. **The entity/LLC UI and the good-standing slot.** `LlcManager.jsx` is on six RTL
   screens and zero LT ones. This is the item where "share, don't copy" is easiest to
   honour and easiest to skip.

---

## 7. The thing most likely to be reinvented anyway

`src/longterm/routes/documents.js` — the Long-Term condition upload / review / delete
door. Not hypothetical: it was written this session and then parked, precisely because
it was a reinvention.

It gets rebuilt because it is the shortest path to the owner's loudest complaint
(*"You can't really upload stuff"*) — and the complaint is literally true: the LT
Condition Center has 18 routes and **not one accepts a document**. Meanwhile the thing
it would replace, `uploadAppDocument`, is ~350 inline lines at `staff.js:19207` inside
a 22,083-line router, tangled with a dozen RTL-only side effects.

The extraction is the hard, correct path. Take it.
