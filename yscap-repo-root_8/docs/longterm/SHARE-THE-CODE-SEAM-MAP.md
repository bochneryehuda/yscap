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

### MEASURED 2026-08-31 — the DELETE table below is partly WRONG. Read this first.

The table was written from reading. Running the two sides against each other
changed three of its claims, and the corrections matter more than the table does
— each one is a place somebody would have started a risky refactor on a false
premise.

**1. `rules.js` is NOT a duplicate "in full".** The Long-Term module has three
things the shared one lacks, and only one of them was in the table:

| | Long-Term | Shared | Status |
|---|---|---|---|
| tri-state `true \| false \| null` | yes | no | **PORTED** — `rules.evaluateRuleTri` |
| plain-language refusals (`REFUSAL`, `{ok, problems:[{reason, detail, why}]}`) | yes | no — returns `string[]` | **NOT ported.** This is what tells somebody authoring a rule *why* it was refused. Deleting the module loses it. |
| a null rule is VALID | yes (`{ok:true}`) | no (`['rule must be a group…']`) | **NOT reconciled.** Long-Term seeds `always` templates with a null rule and validates them; the shared validator rejects that. |

**2. `read.js` and `write.js` have NOTHING to be deleted INTO.** The table says
they duplicate `staff.js:5030-5151` and `:9986-10594` — and that is exactly the
problem: the short-term implementation is INLINE IN A ROUTE FILE, not a module.
There is no `src/lib/conditions/read.js` or `write.js`. Deleting the Long-Term
modules therefore means first EXTRACTING the short-term halves out of a
20,000-line live route file. That is a bigger, separate job than the word
"delete" suggests, and it is the reason the Long-Term side wrote its own.

**3. The vocabularies diverged, and two of the three gaps are now closed.**
Measured field by field rather than assumed:

- `pct` (Long-Term) vs `percent` (shared) — the same type, two spellings.
  **CLOSED**: the shared table now carries both. Provably inert — ZERO
  short-term fields are typed `pct`.
- `is_empty` / `not_empty` on a **boolean** — allowed by Long-Term, refused by
  the shared *validator* while its *evaluator* has always handled them, and
  while its own comment advises using `is_empty` on a boolean. That was a latent
  defect, not a rule. **CLOSED**, validation-only and permissive.
- `in` / `not_in` on **text** (Long-Term) vs `ends_with` (shared) — **NOW
  CLOSED** (2026-08-31), and closed in the order the caution above demanded: the
  shared *evaluator*'s text branch gained real `in` / `not_in` cases FIRST, so
  the validator never permits a rule the evaluator answers false to forever.
  Long-Term's `compareText` gained `ends_with` in the same pass, so the shared
  table and the Long-Term evaluator agree about every operator the builder
  offers — pinned by check E7, which lists any that do not.

  **Proven inert for the short-term product before it landed**: the module before
  and after, run over **54,614 comparisons** (validation and evaluation, all 56
  registry fields × every operator × a spread of values and contexts), differed
  on **nothing** the old table already allowed. The baseline is the pre-change
  file, not a git ref, and it is proven to genuinely differ — a git baseline
  proves inertness only until the change is committed, after which it degenerates
  into "the engine equals itself" and passes forever while proving nothing.

**4. The one genuine semantic conflict is boolean truthiness, and it is
unreachable.** Long-Term accepted `'true'` and `1` as true; the short-term rule
requires a real `true` and is documented and deliberate ("a never-answered
custom boolean is unknown, not false"). The short-term reading wins. Proven safe
BEFORE it was adopted: all ten Long-Term boolean fields were run over a battery
of contexts and emit only real `true`, real `false` and `null` — never a string,
never a number. Likewise all eleven numeric fields emit only `number` and
`null`, which is what let the tri-state's numeric coercion match the shared one
exactly.

**5. THE VALIDATOR AND THE OPERATOR TABLE ARE NOW SHARED (2026-08-31).** The two
things this section previously listed as blocking — the richer refusals and the
null-is-valid reading — turned out not to need a rewrite at either end. They are
a SEAM: `src/longterm/conditions-center/rules.js` `validateRule` now delegates to
the shared validator and adds only the two things that are genuinely Long-Term's
own, each of which is a fact about Long-Term's DATA rather than about rule
grammar (which is why neither belongs in the shared module):

- **a null rule is valid** — every one of the 28 conditions in the shipped
  library carries `ruleLogic: null`, so this is load-bearing, not theoretical;
- **a bare row at the root** validates as the one-row AND group it means. The
  stored rule is untouched and the wrap cannot change the verdict.

The refusal SHAPE stays Long-Term's (`{ok, problems:[{reason, detail, why}]}`),
built from the shared validator's own sentences — so the two can never describe
one refusal two different ways. `OPERATORS_BY_TYPE` is now the shared OBJECT, not
a copy: check E1 asserts identity rather than equality, because two tables with
matching contents is exactly the state this removed.

**It fixed a real latent defect on the way.** The Long-Term validator never
looked at an enum's option list, so a typo'd enum value saved happily and then
silently never matched a file. It is refused now (check E2). Making that work
required Long-Term's registry to declare options in the shared `{v, label}`
shape; nothing consumed the old bare-string shape — it was served by `catalog()`
and read by no screen — which is what made correcting it safe rather than needing
an adapter.

**What that leaves: the EVALUATOR, and it is a real question rather than a
duplication.** The two evaluators genuinely disagree about what "the same string"
means. Long-Term's `norm` is lowercase + strip every non-alphanumeric, so
`"Single Family"` ≡ `"SingleFamily"`; the shared text branch lowercases only, and
its ENUM branch does not even do that (it is case-SENSITIVE, while the text
branch beside it is not — an inconsistency inside the shared module itself).
MEASURED over 3,200 comparisons on Long-Term's own fields: the two disagree on
**1,620** of them, and on **zero** where the two strings are byte-identical. So
they agree exactly on canonical values — which is all either registry actually
produces — and differ only when somebody types a rule value with different casing
or punctuation than the stored value.

That is a business rule ("should a rule match a value spelled differently?"), not
a refactor's to settle, and changing the shared side would move which conditions
attach to LIVE short-term files. **Open with the owner**, alongside the
inconsistency that shared text is case-insensitive while shared enum is not.

**Also recorded, not fixed:** the shared evaluator reads a boolean stored in a
money field as the number 1 (`Number(true)`). Long-Term's refused it. That is a
real question about the short-term product, it moves live files, and it is not a
refactor's to decide — so it is written down here rather than changed quietly.

**Fixed in passing, and worth knowing about:** the shared `evalRow`'s enum
`in` / `not_in` called `.map()` on the rule's value without checking it was an
array, so a stored rule whose `in` value is a scalar **threw** — in a module
documented as total. It is reachable: a rule saved through the builder is refused
by the validator, but `checklist_templates.rule_logic` is a jsonb column a
migration writes directly, and a seeded rule never meets the validator.
`engine.js` wraps the call in a catch that answers `false`, so the fix changes
nothing there — but `routes/admin-conditions.js` does not, so the same rule 500'd
the rule-preview screen. Found by the equivalence battery (384 cases), not by
reading.

---

### DELETE — reinventions, but port the named improvements first

| File | Duplicates | Port before deleting |
|---|---|---|
| `engine.js` (333) | `src/lib/conditions/engine.js:265-281`, `:320-338`, `:345-446` | the tri-state `apply true\|false\|null` (`:169-187`) — strictly better than RTL's catch→false at `engine.js:381`; the atomic retraction with `NOT EXISTS(files)` **inside** the DELETE (`:297-304`) vs RTL's read-then-write; `loadContext`'s per-read try/catch + `unreadable[]` (`:64-75`) |
| `rules.js` | ~~`src/lib/conditions/rules.js` in full~~ — **SUPERSEDED, see §5 above.** The operator table and the validator ARE the shared ones now; what is left is not a duplicate but a genuine disagreement about text comparison, which is an owner question | done — the tri-state shipped as `evaluateRuleTri` |
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
