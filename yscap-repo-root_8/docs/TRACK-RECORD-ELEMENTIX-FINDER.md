# DRAFT — Research proposal (owner review before build)

**Elementix field-by-field finder for the track record**
Stream A research pass · 2026-08-09 · advisory design only, no code changed.

---

## In one plain paragraph (for the owner)

Today, when we check a past deal, PILOT answers three big questions: was it recent, did
they own it, did the deal really finish (the "three pillars"). Each gets one of three
answers — proved, contradicted, or couldn't-find-it — and a person signs it off. You want
to go one level deeper: for **every single detail on the line** — purchase price, sale
price, rehab, each date, the company name, the address, the deal type — show whether the
public records (Elementix) **confirm** it, say it's **definitely wrong**, or **can't find
it**, with a button to re-check and a way for a person to override after they've looked.
This proposal designs exactly that. The good news: most of the machinery already exists —
the same public-records lookup we already run, and the same field-by-field comparison the
importer already does — so this is mostly a new *view* on top of parts we already built,
plus a few small, careful additions. It never marks anything verified on its own, and it
never spends money on a click.

---

## 1. What exists today (read before designing)

### 1a. The pillar engine — three questions, three verdicts

`src/lib/track-record/checks.js` is a **pure** function (no DB, no network, clock passed
in) that reads a track-record line + whatever the vendor returned + the entity context and
reports **one observation per pillar** (`computeChecks`, checks.js:717-739):

- **`auto_verdict`** is one of `proved | contradicted | no_data | too_recent`
  (checks.js:88-93). The doctrine is written into the file header (checks.js:13-28): absent
  data is **`no_data`, never `contradicted`** — "we could not find it" and "the record says
  otherwise" send a reviewer to two different places, and county coverage is genuinely
  patchy. `too_recent` is a real answer (recording lag), not `no_data`.
- Each pillar carries **evidence**: `auto_source` (`elementix | document | entity | derived`),
  `auto_confidence` (`certain | likely | possible`), `auto_grade` (NIST SP 800-63A ladder:
  `superior | strong | fair | weak | unacceptable`, checks.js:95-101), and an
  `auto_evidence` jsonb bag holding `{why, recordingDate, documentId, exitDate, checkB, …}`.
- Tolerances already defined here: **`DATE_TOLERANCE_DAYS = 120`** (checks.js:80-81) and
  **`RECORDING_LAG_DAYS = 45`** (checks.js:76-77). Address identity goes through
  `samePlace → ADDR.sameAddress` (checks.js:134-136). Party identity goes through
  `whoIsThis` → `promotionMatch` / `namesMatchLoose` (checks.js:149-161).

`pillar-actions.js` turns a stored pillar row into a screen: `evidenceCard`
(pillar-actions.js:215-253) with the four-part card (claim → source+confidence+date →
verbatim snippet → actions), `pillarNextStep` (the one button, :103-169), and
`AUTO_TONE = { proved:'good', contradicted:'bad', no_data:'neutral', too_recent:'neutral' }`
(:80). The `AUTO_MEANING` table (:55-76) already writes three *different* neutral sentences
per pillar so "nothing found" never reads as a failure — this is the wording discipline the
finder inherits.

`workspace.js` assembles the line: `loadLine` (:162-241) builds one `evidenceCard` per
pillar; `decidePillar` (:254-302) writes **only** the `human_*` columns; `bulkConfirm`
(:313-345) is refused server-side by `bulkConfirmRefusal`.

### 1b. The importer already does field-by-field comparison — this is the closest machinery

`src/lib/track-record/importer.js` `compareCandidate` (importer.js:1061-1114) **already
compares a vendor candidate to a stored `track_records` line, field by field**, and emits
per-field rows:

```
rows = FILLABLE.map(f => {
  ours   = show(f, t[f]);
  theirs = show(f, f==='llc_id' ? c.proposed_llc_id : c[f]);   // importer.js:1077-1079
  samePlace = f==='property_address' && sameAddress(t[f], c[f]);  // :1086-1087
  conflict  = ours && theirs && ours !== theirs && !samePlace;    // :1088
  willFill  = !ours && theirs;                                    // :1096
  material  = MATERIAL.includes(f);
})
```

- `FILLABLE` (importer.js:137-147): `property_address, deal_type, purchase_price,
  purchase_date, sale_price, sale_date, entity_name, rent_amount, rent_date, refi_amount,
  refi_date, llc_id`.
- `MATERIAL` (importer.js:70-74) = the columns db/485 says reset a verification.
- **Key finding — the comparison is currently EXACT for money and dates.** `show()`
  (importer.js:1070-1075) renders money as `String(v)` and dates through `ymd`, then compares
  `ours !== theirs`. Address is the only field with a semantic comparer. So **there is no
  money tolerance and no date tolerance anywhere in the compare path today** — `$312,500`
  vs `312500.00` would read as a conflict, and a deed recorded 40 days after closing would
  read as a date conflict. This matters for §2 below: the finder must ADD tolerance, it
  cannot just reuse `compareCandidate` verbatim.

The candidate's own fields are built by `candidatesFrom(research, entityNames)`
(importer.js:190-352): it walks the vendor's normalized deed / mortgage / MLS rows and
collapses them into ONE candidate per property carrying `purchase_price/date`,
`sale_price/date`, `entity_name`, `rent_*`, `refi_*`, and `raw.counterparty` — the exact
per-field figures the finder needs. **The finder for an existing line is therefore:** run a
fresh lookup → build a candidate for this property via `candidatesFrom` → diff it against
the stored line with `compareCandidate`-style logic *plus tolerance*.

### 1c. The Elementix client, the caps, the meter, the caches, the ledger

- **Client** `src/elementix/client.js` — the only module that talks to Elementix, read-only,
  never throws (`callTool`, :247-267). Two caps:
  - **Hourly throughput: `maxPerHour = 400`** (config.js:546), self-capped under the
    platform's org-wide 1,000/hr shared ceiling. Counted cross-instance from the
    `elementix_calls` ledger (`overBudgetShared`, client.js:90-105) — **fails OPEN** (a
    bookkeeping hiccup must not take the feature down).
  - **Monthly PAID: `paidPerMonth = 1000`** (config.js:542). Only `submit_contact_enrichment`
    spends a credit (`PAID_TOOLS`, client.js:41). It **fails CLOSED** (`paidThisMonth`,
    :443-451) and is refused unless a route passes a `paidActor {staffId, personId, reason}`
    (client.js:278-307). Everything the finder needs is a **FREE** tool.
  - `usage()` (client.js:473-490) → `{callsLastHour, paidThisMonth, hourCap, paidCap}`,
    already surfaced at `GET /api/staff/elementix/usage` (staff.js:11266-11269) and shown on
    the search sheet's budget meter.
- **Allowlist wrapper** `src/lib/elementix/lookups.js` — `TOOLS` is a closed set
  (lookups.js:65-86); the paid tool is **absent by construction** (`FORBIDDEN`, :89);
  `researchProperty` (:488-579) is the entity-first sequence returning the exact shape
  `checks.computeChecks` consumes. `coverage()` (:378-384) reads `get_coverage` — the
  county-completeness signal that distinguishes "no coverage" from "searched, absent."
- **Vendor shape normaliser** `src/lib/elementix/shapes.js` — one normaliser per tool
  (deed :162-181, mortgage :184-222, ownership :246-266). This is where the per-field
  **truth sources** live: a deed's price is `totalConsideration`→`amount`, its date is
  `recordingDate`→`date`; an ownership row's `isCurrent`/`grantees` answer "who holds it
  now"; a mortgage's `isRefinance`/`termMonths` answer the refi. **Absence is `null`, never
  0** (shapes.js:38-43) — a defaulted 0 would read as a real $0 sale.
- **Verify run** `src/lib/track-record/verify-run.js` `runVerify` (:67-172) — the existing
  "read the public records for ONE property, on a click" pass. It fetches
  `researchProperty`, runs `computeChecks`, and writes **`auto_*` only** to the three pillar
  rows (:139-146). It **caches** the whole research payload in `elementix_lookup_cache`
  (verify-run.js:195-209) keyed by `queryKey(trackRecordId, entityName, address)` (:54-56),
  with `FRESH_DAYS_FOUND = 90` / `FRESH_DAYS_EMPTY = 21` (:49-51). A failed lookup is stored
  `status='error'`, which db/498's GENERATED `cacheable` column turns into "not knowledge."
  **This is the pass the finder hooks into.**

### 1d. Where the verdict + override live in the schema

- **`track_record_pillars`** (db/494) — one row per pillar per line. `auto_*` (machine) and
  `human_*` (person) are **deliberately separate column groups that must never collapse**
  (db/494 header :20-29). `auto_evidence` is jsonb, documented as `{snippet, docId,
  recordingDate, grantor, grantee, url}` (db/494:60). `satisfied_by_llc_id` carries Check A
  across every property one LLC held (:74). `auto_checked_at` is the machine's "last checked"
  stamp (:62).
- **`track_records.pillars_met`** (db/500) — true only when all three pillars carry
  `human_verdict='confirmed'` and none lapsed; reads `human_verdict` ONLY (db/500:37-41).
- **The verify guard** (db/485, extended db/500) — **nothing arrives verified**
  (db/485:80-90); a MATERIAL edit returns the line to pending (db/485:94-120). `pillars_met`
  is material in ONE direction only: `true→false` reopens, `false→true` must not (db/500:24-36,
  the asymmetric clause at db/500:164). **This is the gate the finder must never reach around.**
- **Human override** = `decidePillar` (workspace.js:254-302) writing `human_verdict` +
  `human_by` + `human_at`, plus a note; confirm needs sign-off, reject needs a reason. Route
  `POST /api/staff/track-record-pillars/:id/decide` (staff.js:11359-11376).

---

## 2. Industry research — how the data houses present field-level verification

The pattern the owner is describing (per-field confirmed / wrong / can't-find, with a human
override) is standard practice at the property-data houses, and two ideas from them shape
the design:

- **DataTree (First American) "Verified Record"** — the closest analogue. A transaction is
  marked **Verified** only when **a match is found from at least two independent sources**;
  a single-source fact is shown but not badged verified.
  ([firstam.com](https://www.firstam.com/mortgagesolutions/solutions/data-analytics/datatree.html),
  [dna.firstam.com](https://dna.firstam.com/solutions/property-data/datatree-property-research))
  This is *exactly* PILOT's own "**both comparers must agree** before we bind" rule
  (match.js:17-28, 160-168) — a good sign the doctrine is right, and a reason to keep
  "confirmed" strict.
- **ATTOM confidence score** — every AVM value carries a **0-100 confidence** (= 100 minus
  the Forecast Standard Deviation), calibrated per property.
  ([cloud-help.attomdata.com](https://cloud-help.attomdata.com/article/510-avm))
  **Deliberately NOT adopted here:** a numeric percentage on a borrower's deal reads as a
  statement about the borrower and invites false precision. PILOT already refuses this — the
  importer surfaces "**the reasons a human needs, not a score**" (importer.js:650-655). The
  finder keeps three words (confirmed / wrong / can't-find) plus the *why*, never a percent.
- **Entity-resolution / record-linkage practice** — tiered confidence (deterministic exact
  vs probabilistic), an explicit **manual-review threshold** below which a human decides, and
  **explainability**: "show the attributes that contributed to the decision… not simply a
  confidence score."
  ([dataladder.com](https://dataladder.com/record-linkage-techniques-for-incomplete-data/),
  [winpure.com](https://winpure.com/explainable-entity-resolution/))
  This is the finder's per-field-reason requirement, verbatim.
- **Forecasa** — the private-lending comp for this exact use: it surfaces a property's full
  ownership/transaction history and a borrower's cross-lender lending history specifically to
  **validate collateral and verify borrower experience**.
  ([forecasa.com/solutions/lenders](https://www.forecasa.com/solutions/lenders))
  Confirms the market need; PILOT's differentiator is the per-field human override on top.

**Takeaway for the design:** keep "confirmed" as strict as DataTree's two-source rule, keep
the *reasons* (not a score) as record-linkage best practice demands, and make the human
override first-class — none of the data houses let the underwriter overrule a field verdict
in place, which is the owner's specific ask.

---

## 3. The design

### 3.1 The per-field verdict model

**Every detail on the line gets one of three verdicts**, each with a *reason*, mapped to the
existing three-state tone language:

| verdict | tone (existing `AUTO_TONE`) | meaning |
|---|---|---|
| **`confirmed`** | `good` (green ✓) | Elementix holds a matching instrument and the value agrees (within tolerance). |
| **`contradicted`** | `bad` (red ✗) | Elementix holds the instrument and the value **disagrees beyond tolerance** — an affirmative "definitely wrong." |
| **`unable`** | `neutral` (grey –, gold border) | We could not confirm — with a *reason* (see the three flavors below). Never a failure, never red. |

**The three flavors of `unable`** — this is the heart of the owner's "which was unable to
be verified," and it extends the existing `no_data` doctrine (checks.js:13-19) so the finder
never blames a borrower for a gap in the data:

1. **`not_public`** — the fact is *never* in public records (rehab spend; a private lease
   with no MLS outcome). Structurally unverifiable — settle it with a document, never chase
   the county. (Mirrors exitPillar's lease handling, checks.js:554-567.)
2. **`no_coverage`** — Elementix has no deed coverage for this county (`get_coverage`,
   lookups.js:378-384; `entityCombinedCoveragePct` already feeds the scoring penalty). "A gap
   in the records, not a problem with the borrower" (pillar-actions.js:66-70).
3. **`not_found`** — the county *is* covered but no matching instrument was found. Weakest
   signal; the natural next step is "ask for the document."

**Which Elementix field supplies the truth for each detail** (via the normalised shapes,
§1c) — this is the build table:

| Line field | Elementix source (normalised) | Comparison rule |
|---|---|---|
| `property_address` | `match_address` / the row's `addresses[]` | `ADDR.sameAddress` **+ SQL twin** (both must agree, per match.js:160-168) |
| `entity_name` / `llc_id` (ownership) | acquisition deed `grantees` + `granteeEntityIds`; ownership row `entity_grantees` | `whoIsThis`/`promotionMatch` (checks.js:149-161) + Check A control verdict |
| `owned_personally` | deed grantee is the borrower's own **person** name | `whoIsThis(...).as === 'person'` (checks.js:365-374) |
| `purchase_price` | acquisition deed `amount` (`totalConsideration`); else purchase-money mortgage `deedConsideration` | **money tolerance** (new, §3.2) |
| `purchase_date` | that deed's `date` (`recordingDate`) | **date tolerance** `DATE_TOLERANCE_DAYS=120` (checks.js:81) |
| `sale_price` | exit deed `amount` (deed conveying OUT of our side, near exit) | money tolerance |
| `sale_date` | exit deed `date` | date tolerance |
| `refi_amount` / `refi_date` | mortgage `isRefinance===true` → `amount` / `date` | money + date tolerance |
| `rent_date` | MLS `rentStatus∈{rented,leased}` + removal date (shapes.js:129-143) | if no MLS outcome → `unable:not_public` |
| `deal_type` | derived from the deed pair (bought+sold ⇒ flip) | `dealTypeFromRecords` (importer.js:119-130); no pair ⇒ `unable:not_found` |
| `rehab_amount` | — none — | **always `unable:not_public`** (say so plainly) |
| `current_value` | — none (AVM out of scope) — | `unable:not_public` |

**How the acquisition/exit deeds are picked** is not new logic — `checks.ownershipPillar`
already finds the acquisition deed (`acq`, checks.js:341-350) and `checks.findSale` already
finds the exit deed (:597-627). The finder reads the SAME rows those two already select, so
a field verdict can never disagree with its pillar about which instrument it is looking at.

**`contradicted` requires an affirmative disagreement**, exactly as the pillar rule does
(checks.js:13-19): Elementix must HOLD the instrument (a real deed/mortgage for this
property) AND the value must differ beyond tolerance. Missing coverage or a missing
instrument is `unable`, never `contradicted`. A self-dealing / nominal-consideration deed
($0 / $1 / $10 "love and affection") is **`unable`, not `contradicted`** — see §3.2.

### 3.2 The money tolerance (genuinely new — needs an owner number)

There is **no money tolerance in the codebase today** (§1b), so this must be defined. A
recorded deed's consideration legitimately differs from a claimed purchase price (transfer-tax
rounding; a wholesale where recognized price ≠ contract; a nominal deed). Proposed rule
(all numbers owner-tunable, living in code beside `DATE_TOLERANCE_DAYS`):

```
MONEY_ABS_TOL = $5,000        // or
MONEY_PCT_TOL = 2%            // whichever is LARGER wins → tolerant on big deals
NOMINAL_MAX   = $100          // a $0/$1/$10 deed states no price

matchMoney(ours, theirs):
  if theirs <= NOMINAL_MAX     → 'unable:not_found'   (deed states no real price)
  if |ours-theirs| <= max(MONEY_ABS_TOL, ours*MONEY_PCT_TOL) → 'confirmed'
  else → 'contradicted'
```

Dates reuse `DATE_TOLERANCE_DAYS = 120` (checks.js:81) unchanged; addresses reuse
`sameAddress` + the SQL twin unchanged; entities reuse `promotionMatch` unchanged. **The
only new tolerance is money, and it is the one that most needs the owner to sign off the
numbers** — too tight and a correct borrower is painted "definitely wrong."

### 3.3 How field verdicts roll UP into the three pillars (deepen, don't replace)

**The pillars are unchanged. The finder adds a layer underneath them.** `checks.computeChecks`
still produces the three `auto_verdict`s exactly as today, and `pillars_met` / the sign-off
gate / db/485 still read the pillars' `human_verdict` and nothing else. The finder attaches,
under each pillar's existing `auto_evidence`, a `.fields[]` array:

```
auto_evidence.fields = [
  { field:'purchase_price', verdict:'confirmed',  ours:312500, elx:312500,
    source:'elementix', documentId:'…', why:'The recorded deed states $312,500.' },
  { field:'entity_name',    verdict:'contradicted', ours:'Hudson Holdings LLC',
    elx:'Bergen Equity LLC', why:'The deed names a different company.' },
  …
]
```

**Field → pillar mapping** (so every field lands under exactly one pillar's card):

- **Ownership**: `property_address`, `entity_name`/`llc_id`, `owned_personally`,
  `purchase_price`, `purchase_date` (the acquisition deed is the ownership evidence).
- **Recency**: the exit-date corroboration (`sale_date` / `refi_date` / `rent_date` recency
  vs the 36-month window).
- **Exit**: `sale_price`, `deal_type`, `refi_amount`/`refi_date`, `rent_date` (the exit
  event itself).
- **Not-a-pillar fields** (`rehab_amount`, `current_value`): shown in a small "Not in public
  records" group on the line, flagged `unable:not_public`, belonging to none of the three
  pillars' roll-up. They are document-settled facts and must never gate a pillar.

**The roll-up is advisory, never automatic.** A pillar's field verdicts *inform* the reviewer
but never move its `human_verdict`. Concretely: three green fields under Ownership do **not**
confirm the Ownership pillar — a person still clicks Confirm (which still needs sign-off,
workspace.js:267-270). A red field is the single most useful signal to surface — the
workspace already sorts a contradicted pillar to the top (`urgencyOf` returns 0,
workspace.js:49-51) — but it still routes to a human, never an auto-reject. This preserves
"the finder deepens, not replaces, the existing model."

### 3.4 Caching + the paid ceiling — never burn budget on a click

**The finder produces NO new Elementix calls beyond the verify pass that already runs.** This
is the whole caching story and it falls out of the existing design:

- The per-field diff is computed from the **same `researchProperty` payload** that
  `runVerify` already fetches and already caches in `elementix_lookup_cache`
  (verify-run.js:117-122, 195-209). One lookup yields BOTH the three pillar verdicts AND the
  field finder. So the finder is best computed **inside `runVerify`** (extend it to also
  derive `.fields[]` and write them into each pillar's `auto_evidence`) — zero extra calls.
- **Rendering the finder is FREE — always.** The screen reads the stored
  `auto_evidence.fields` off the pillar rows (already loaded by `workspace.loadLine`). **No
  paid-call-on-render, no lookup-on-render** — it reads what the last verify wrote.
- **"Last checked"** is already on the row: `track_record_pillars.auto_checked_at`
  (db/494:62), plus the cache's `fetched_at`. Surface it on the finder ("checked 3 days ago").
- **Re-verify** = the existing manual button: `POST /api/staff/track-records/:id/research
  {force:true}` (staff.js:11343-11358) → `runVerify(force)`. That is **one lookup, ~6-9 FREE
  tool calls** counted against the 400/hr shared throughput ledger (`elementix_calls`,
  db/503) — it **never touches the 1,000/month paid cap**, because the finder uses only free
  tools (`get_entity_deeds`, `get_address_ownership`, …; the paid `submit_contact_enrichment`
  is absent from `lookups.TOOLS`). A cheaper "re-check from cache" (no `force`) reuses a
  fresh definitive cache entry and spends nothing.
- The search sheet's **budget meter** (`GET /api/staff/elementix/usage`, staff.js:11266) is
  already the place to show "calls this hour / paid this month" before a re-verify.

**Net:** the only spend the finder can cause is a manual re-verify, which is free-tool
throughput, self-throttled at 400/hr, ledgered per staffer. It cannot reach the money cap.

### 3.5 The human override (per-field, audited, never auto-verifies)

The owner: "then manually override after human review." A reviewer looking at a field the
machine called `contradicted` (e.g. the deed states a transfer-tax stamp, our $312k is
right) needs to mark that field settled with a reason.

- **Storage.** Machine field verdicts live in `auto_evidence.fields` (the `auto_*` side).
  Because `auto_*` and `human_*` must never collapse (db/494:20-29), a human field override
  **cannot** be written into `auto_evidence`. Proposed: **one small additive migration** adds
  `human_field_overrides jsonb` to `track_record_pillars` (human side), shaped
  `{ purchase_price:{ verdict:'confirmed', by:<uuid>, at:<ts>, reason:'…' }, … }`. This mirrors
  the existing `human_verdict/human_by/human_at` triple, one level down. (Alternative: a
  dedicated `track_record_field_overrides` table if per-override history is wanted; the jsonb
  column is lighter and matches the auto/human split — recommended.)
- **Route.** `POST /api/staff/track-record-pillars/:id/field-override
  { field, verdict, reason }`, a sibling of `decidePillar` (staff.js:11359-11376), same
  `canSeeBorrowerId` gate. A reason is **required** (mirrors the reject rule,
  workspace.js:273-276). Every override also writes a **note** through the existing notes
  machinery (workspace.js:290-297) so the audit trail is human-readable, and an audit-log row
  (`track_record_field_override`, mirroring staff.js:11371).
- **How it interacts with the pillar override + db/485 — the safety property:**
  - A field override changes **only the displayed field chip** and the reviewer's context.
    It **never writes `human_verdict`** on the pillar, so it can never move `pillars_met`
    (db/500) and can never make the sign-off gate pass. Verifying the line is still the
    separate, sign-off-gated act of confirming all three pillars.
  - It **never writes `track_records.is_verified`** — db/485's "nothing arrives verified"
    stands untouched.
  - Re-running verify (`runVerify`) rewrites `auto_evidence.fields` but **never touches
    `human_field_overrides`** — exactly as `runVerify` today writes `auto_*` and never
    `human_*` (verify-run.js:13-19, 138). If the machine and the human now disagree, that
    disagreement is surfaced (the finder shows "you marked this confirmed; the records now say
    otherwise"), mirroring `runVerify`'s existing `disagreesWithHuman` flag
    (verify-run.js:152-155).
  - A field override does **not** auto-reset when the underlying line figure is edited. If a
    material figure changes, db/485 already reopens the whole line to pending — the reviewer
    re-reads. (Optional refinement: clear a field's override when *that* field's stored value
    changes; flag for owner.)

### 3.6 The UI shape — inside the new inline LineDetail (Part 1)

The finder is a **compact per-field table** rendered inside each pillar's `evidenceCard` in
the new inline `LineDetail` component. One row per field:

```
 field           our value        Elementix value      verdict     override
 ─────────────────────────────────────────────────────────────────────────
 Purchase price  $312,500         $312,500             ✓ confirmed   ⋯
 Sale price      $489,000         $455,000             ✗ wrong       [review]
 Purchase date   2023-04-11       2023-05-20 (rec.)    ✓ confirmed   ⋯
 Entity          Hudson Holdings  Bergen Equity LLC    ✗ wrong       [review]
 Rehab           $84,000          —                    – can't find  [note]
 Address         26 S 10th St…    26 South 10th St…    ✓ confirmed   ⋯
```

- **Three-state colour language = the existing `TONE_STYLE`**
  (StaffTrackRecordWorkspace.jsx:46-51), reused verbatim so the finder matches the pillar
  chips already on screen:
  - `good`  → ✓ `#1F6B3F` (green) — *confirmed*
  - `bad`   → ✗ `#8A2B2B` (red) — *definitely wrong*
  - `neutral` → – `#4B585C` text, `#AE8746` gold border — *can't find / unable*
  - **All text is explicit dark** on the white canvas per the hard rule in CLAUDE.md — the
    verdict word and both values are dark; only the ✓/✗/– mark carries the accent colour.
    Never a `var(--ink*)` token for text (it resolves light).
- The neutral row **says which flavor** in words ("Not in public records" / "This county
  isn't covered" / "Searched, none found") — never a bare grey dash, matching the
  `AUTO_MEANING` discipline (pillar-actions.js:66-70).
- The `contradicted` value shows the recorded instrument's date + a "view deed" affordance
  (the `documentId` is already carried, shapes.js:155) so the reviewer can check the source —
  the "verbatim snippet is mandatory" rule (pillar-actions.js:203-214).
- **Override control** per row: a small "review" action opens a reason box (confirm this
  field / mark wrong / add a note) → the field-override route. It is offered on every row but
  is **secondary** — the primary action on the *pillar* stays "Ask for a document" /
  "Confirm" as today (pillar-actions.js:12-18). A person working at speed must never hit a
  field-confirm as the big button.
- A per-line header line: "Checked against Elementix 3 days ago · Re-check" (the re-verify
  button) with the budget-meter hint.

### 3.7 New vs reusable, effort, risk, migration

**Reused as-is (no change):** `lookups.researchProperty`, the whole Elementix client + caps +
ledger + caches, `candidatesFrom`, `sameAddress` + SQL twin, `whoIsThis`/`promotionMatch`,
`DATE_TOLERANCE_DAYS`, the `TONE_STYLE` colour language, `auto_evidence` jsonb storage, the
`runVerify` pass + its `POST …/research` route, `auto_checked_at`, the cache freshness rule.

**Genuinely new (small):**
1. A pure `deriveFieldFinder(line, research, ctx)` beside `computeChecks` — picks the
   acquisition/exit deeds (reusing `ownershipPillar`/`findSale`'s selection), builds the
   per-field rows, applies tolerances. ~1 file, pure, unit-testable offline like `checks.js`.
2. **The money tolerance** (`matchMoney`, §3.2) — the one new comparison rule; needs owner
   numbers.
3. `runVerify` extended to write `.fields[]` into each pillar's `auto_evidence` (a few lines).
4. `human_field_overrides` — **one small additive migration** (`ALTER TABLE … ADD COLUMN IF
   NOT EXISTS … jsonb`, idempotent) + one route + one note/audit write.
5. UI: the per-field table inside `LineDetail`, reusing `TONE_STYLE`.

**Migration:** machine side needs **zero** — reuse `auto_evidence` jsonb (as the task
prefers). Human side needs **one tiny additive column**, `track_record_pillars.human_field_overrides
jsonb`, going-forward only (no backfill — an unwritten column reads as "no overrides yet,"
which is correct).

**Effort:** ~**Small-to-Medium**. The expensive parts (the lookup, the caches, the caps, the
shape normalisers, the field extraction, the tone language, the storage) already exist. The
new work is one pure derive function, one money-tolerance rule, a jsonb column + route, and a
table view.

**Risk:** **Low**, with two watch-items: (a) the **money tolerance number** — the only place
a wrong constant paints a correct borrower "definitely wrong"; get owner sign-off. (b) Keep
`deriveFieldFinder` reading the *same* deed rows the pillars select, or a field verdict could
contradict its own pillar; a test should pin "field and pillar agree on the instrument."

---

## 4. NON-NEGOTIABLES (stated for the build)

1. **Never auto-verify.** No field verdict, and no field override, ever writes
   `track_records.is_verified` or a pillar's `human_verdict`; the sign-off gate reads
   `pillars_met` ← `human_verdict` only (db/485, db/500). The finder is advisory context under
   the pillars, exactly as the AI-findings desks are advisory (CLAUDE.md 2026-07-27).
2. **No paid-call-on-render, ever.** Rendering the finder reads stored `auto_evidence` — zero
   calls. Only a deliberate manual re-verify makes a lookup, and it uses **free tools only**;
   the paid `submit_contact_enrichment` is absent from `lookups.TOOLS` by construction and can
   never be reached from this path.
3. **Never present a machine verdict as a decision.** `auto_*` and `human_*` stay separate
   column groups (db/494:20-29). A green field is "the records agree," not "verified." The
   wording says whose limitation an `unable` is ("a gap in the records, not a problem with the
   borrower").
4. **Note-buyer / PII rules.** This is a STAFF-only surface (like the pillar workspace);
   nothing here is borrower-facing. Contact details stay behind the owner's skip-trace rule —
   the finder never displays a phone number, never spends a credit (lookups.js:10-31); a
   note-buyer name never appears (it never does on a track-record surface).
5. **Advisory only.** The finder blocks nothing, clears nothing, and touches no frozen number.
   A person confirms each pillar and verifies the line, through the routes that already refuse
   without sign-off.

---

## 5. Open questions for the owner

1. **Money tolerance numbers.** Is "match within 2% or $5,000, whichever is larger" right, or
   do you want it tighter/looser? And should a nominal deed ($0/$1/$10) read as "can't find a
   real price" (proposed) rather than "wrong"?
2. **Rehab / current value.** These are never in public records — is showing them as a
   permanent grey "Not in public records (settle with a document)" the behaviour you want, or
   should they be hidden from the finder entirely?
3. **Field override history.** Do you want just the *current* override per field (lighter
   jsonb column, recommended), or a full history of who changed a field verdict and when (a
   dedicated table)?
4. **Override auto-clear.** When someone edits a stored figure on the line, should that
   field's human override clear automatically (re-review), or persist until a person removes
   it? (db/485 already reopens the whole line to pending on a material edit regardless.)
5. **Deal-type "wrong."** If the deeds show bought-and-sold (a flip) but the line says
   "fix-and-hold," is that a red "definitely wrong," or a neutral "the records read this
   differently — confirm which is right" (which is how the importer treats it today,
   importer.js:908-919)?
6. **Re-verify permission.** Should any staffer be able to press Re-check (it spends free
   throughput, ledgered), or only sign-off roles?

---

*Cross-references: `docs/TRACK-RECORD-REBUILD-BLUEPRINT.md`, `docs/TRACK-RECORD-CURRENT-STATE.md`,
`docs/ELEMENTIX-RESEARCH.md`. This document is research + design only; no code was changed and
nothing was committed.*
